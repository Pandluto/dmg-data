#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AkeDataRepository } from '../src/core/ake-data-repository.mjs';
import { classifyAkeMechanismGap } from '../src/core/ake-mechanism-impact.mjs';
import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');
const DEFAULT_ENEMY_ID = 'eny_0007_mimicw';
const ABSTRACT_CHARACTER_IDS = new Set(['chr_9000_endmin']);

function countBy(items, keySelector) {
    const counts = {};
    for (const item of items) {
        const key = keySelector(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right)
    ));
}

function operatorAliases(characterId) {
    const aliases = [characterId];
    if (/^chr_000[23]_endmin/.test(characterId)) {
        aliases.push('chr_9000_endmin', 'endmin');
    }
    return aliases;
}

function stableFinding(left, right) {
    return left.priority.localeCompare(right.priority)
        || left.impact.localeCompare(right.impact)
        || left.entityKind.localeCompare(right.entityKind)
        || left.entityId.localeCompare(right.entityId)
        || left.sourceType.localeCompare(right.sourceType)
        || left.jsonPath.localeCompare(right.jsonPath);
}

function findingKey(finding) {
    return [
        finding.entityKind,
        finding.entityId,
        finding.code,
        finding.sourceType,
        finding.jsonPath
    ].join('\u0000');
}

function collectCompiledFindings(bundle, character) {
    const aliases = operatorAliases(character.id);
    const findings = [];
    const visit = (entityKind, entries, sourcePaths) => {
        for (const [entityId, compiled] of entries) {
            const scope = aliases.some(alias => entityId.includes(alias))
                ? 'operator'
                : 'shared-dependency';
            for (const unresolved of compiled.compiler?.unresolved ?? []) {
                const classification = classifyAkeMechanismGap(unresolved);
                findings.push({
                    characterId: character.id,
                    characterName: character.name,
                    scope,
                    entityKind,
                    entityId,
                    sourcePath: sourcePaths[entityId] ?? null,
                    jsonPath: unresolved.path ?? '$',
                    code: unresolved.code ?? 'AKE_UNRESOLVED',
                    sourceType: unresolved.sourceType ?? 'Unknown',
                    compilerCategory: unresolved.category ?? null,
                    message: unresolved.message ?? '',
                    ...classification
                });
            }
        }
    };
    visit('SkillData', bundle.programs, bundle.sourcePaths.skills);
    visit('BuffData', bundle.buffs, bundle.sourcePaths.buffs);
    for (const diagnostic of bundle.diagnostics ?? []) {
        if (!['AKE_SKILL_DATA_MISSING', 'AKE_BUFF_DATA_MISSING'].includes(diagnostic.code)) continue;
        const classification = classifyAkeMechanismGap(diagnostic);
        const entityKind = diagnostic.code === 'AKE_SKILL_DATA_MISSING' ? 'SkillData' : 'BuffData';
        const entityId = diagnostic.skillId ?? diagnostic.buffId ?? 'Unknown';
        findings.push({
            characterId: character.id,
            characterName: character.name,
            scope: 'operator',
            entityKind,
            entityId,
            sourcePath: diagnostic.path ?? null,
            jsonPath: '$',
            code: diagnostic.code,
            sourceType: 'MissingDependency',
            compilerCategory: null,
            message: `Missing ${entityKind} dependency ${entityId}.`,
            ...classification
        });
    }
    return [...new Map(findings.map(finding => [findingKey(finding), finding])).values()]
        .sort(stableFinding);
}

function summarize(findings) {
    const combatRiskFindings = findings.filter(finding =>
        ['combat-blocking', 'combat-partial', 'evidence-missing'].includes(finding.impact)
    );
    return {
        findingCount: findings.length,
        combatRiskCount: combatRiskFindings.length,
        isCombatClosed: combatRiskFindings.length === 0,
        byImpact: countBy(findings, finding => finding.impact),
        byPriority: countBy(findings, finding => finding.priority),
        byCapability: countBy(findings, finding => finding.capability),
        bySourceType: countBy(findings, finding => finding.sourceType)
    };
}

function aggregateSharedFindings(sharedByCharacter) {
    const aggregate = new Map();
    for (const finding of sharedByCharacter.flat()) {
        const key = findingKey(finding);
        if (!aggregate.has(key)) {
            aggregate.set(key, {
                ...finding,
                characterId: undefined,
                characterName: undefined,
                characters: []
            });
        }
        aggregate.get(key).characters.push(finding.characterId);
    }
    return [...aggregate.values()].map(finding => ({
        ...finding,
        characters: [...new Set(finding.characters)].sort()
    })).sort(stableFinding);
}

export function buildAkeOperatorMechanismAudit({
    projectRoot = defaultProjectRoot,
    characterIds = null,
    enemyId = DEFAULT_ENEMY_ID
} = {}) {
    const resolvedRoot = path.resolve(projectRoot);
    const repository = new AkeDataRepository({ projectRoot: resolvedRoot });
    const catalog = repository.catalog();
    const requestedIds = characterIds === null ? null : new Set(characterIds);
    const characters = catalog.characters.filter(character =>
        !ABSTRACT_CHARACTER_IDS.has(character.id)
        && (requestedIds === null || requestedIds.has(character.id))
    );
    if (requestedIds !== null) {
        const knownIds = new Set(characters.map(character => character.id));
        const unknownIds = [...requestedIds].filter(characterId => !knownIds.has(characterId));
        if (unknownIds.length > 0) {
            throw new Error(`Unknown or abstract character ids: ${unknownIds.join(', ')}`);
        }
    }

    const assembler = new AkeScenarioAssembler({ projectRoot: resolvedRoot });
    const operatorReports = [];
    const sharedByCharacter = [];
    for (const character of characters) {
        const bundle = assembler.assemble({
            characterId: character.id,
            enemyId,
            level: 90,
            skillLevel: 12,
            weaponLevel: 90,
            potentialLevel: 5,
            talentRank: 2
        });
        const allFindings = collectCompiledFindings(bundle, character);
        const findings = allFindings.filter(finding => finding.scope === 'operator');
        const sharedFindings = allFindings.filter(finding => finding.scope === 'shared-dependency');
        sharedByCharacter.push(sharedFindings);
        operatorReports.push({
            characterId: character.id,
            characterName: character.name,
            englishName: character.englishName,
            defaultWeaponId: character.defaultWeaponId,
            dependencies: {
                initialSkillCount: bundle.dependencySummary.initialSkillIds.length,
                discoveredSkillCount: bundle.dependencySummary.discoveredSkillIds.length,
                programCount: bundle.dependencySummary.programCount,
                buffCount: bundle.dependencySummary.buffCount,
                loadoutEffectCount: bundle.dependencySummary.loadoutEffectCount,
                intrinsicPassiveCount: bundle.dependencySummary.intrinsicPassiveCount,
                missingSkillCount: bundle.dependencySummary.missingSkillCount,
                missingBuffCount: bundle.dependencySummary.missingBuffCount
            },
            summary: summarize(findings),
            findings
        });
    }

    const sharedFindings = aggregateSharedFindings(sharedByCharacter);
    const operatorFindings = operatorReports.flatMap(operator => operator.findings);
    return {
        schemaVersion: 1,
        source: {
            provider: catalog.source.provider,
            version: catalog.source.version,
            enemyId,
            characterCatalogEntries: catalog.characters.length,
            excludedAbstractCharacters: [...ABSTRACT_CHARACTER_IDS]
        },
        auditedCharacterCount: operatorReports.length,
        summary: summarize(operatorFindings),
        characters: operatorReports,
        sharedDependencies: {
            summary: summarize(sharedFindings),
            findings: sharedFindings
        }
    };
}

export async function writeAkeOperatorMechanismAudit({
    projectRoot = defaultProjectRoot,
    outputPath = path.join('derived', 'cleanroom', 'ake-operator-mechanism-audit.json'),
    ...options
} = {}) {
    const resolvedRoot = path.resolve(projectRoot);
    const report = buildAkeOperatorMechanismAudit({ projectRoot: resolvedRoot, ...options });
    const absoluteOutput = path.resolve(resolvedRoot, outputPath);
    const rootPrefix = `${resolvedRoot}${path.sep}`;
    if (!absoluteOutput.startsWith(rootPrefix)) {
        throw new Error(`Refusing to write audit outside project root: ${absoluteOutput}`);
    }
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { report, outputPath: path.relative(resolvedRoot, absoluteOutput).replaceAll('\\', '/') };
}

function printSummary(report, outputPath) {
    const rows = report.characters.map(character => ({
        character: `${character.characterName} (${character.characterId})`,
        blockers: character.summary.byImpact['combat-blocking'] ?? 0,
        partial: character.summary.byImpact['combat-partial'] ?? 0,
        evidence: character.summary.byImpact['evidence-missing'] ?? 0,
        spatial: character.summary.byImpact['spatial-assumption'] ?? 0,
        presentation: character.summary.byImpact['presentation-only'] ?? 0
    }));
    console.table(rows);
    console.log(`Wrote ${outputPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
    const { report, outputPath } = await writeAkeOperatorMechanismAudit();
    printSummary(report, outputPath);
}

