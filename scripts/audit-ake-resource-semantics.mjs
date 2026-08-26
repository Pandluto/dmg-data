#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const akeRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata');
const outputPath = path.join(projectRoot, 'derived', 'cleanroom', 'ake-resource-semantics-audit.json');
const sourceDirectories = ['BuffData', 'SkillData'];
const resourceTypePattern = /(Atb|Usp|Cost|Resource)/i;

function shortType(rawType) {
    return String(rawType).split(',')[0].split('+')[0].split('.').at(-1);
}

function pathPart(key) {
    return /^\d+$/.test(String(key)) ? `[${key}]` : `.${key}`;
}

function descriptor(value) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return {
        useBlackboardKey: Boolean(value.useBlackboardKey),
        blackboardKey: value.blackboardKey ?? '',
        value: value.value ?? value.valueDouble ?? null,
        useCustomValue: Boolean(value.useCustomValue)
    };
}

function selector(value) {
    if (typeof value === 'string') return {
        targetSource: value,
        selectorOwner: null,
        ownerContextKey: '',
        centerType: null,
        centerContextKey: '',
        target: null,
        targetContextKey: ''
    };
    if (!value || typeof value !== 'object') return null;
    return {
        targetSource: value.targetSource ?? null,
        selectorOwner: value.selectorOwner ?? null,
        ownerContextKey: value.ownerContextKey ?? '',
        centerType: value.centerType ?? null,
        centerContextKey: value.centerContextKey ?? '',
        target: value.target ?? null,
        targetContextKey: value.targetContextKey ?? ''
    };
}

function blackboardMap(document) {
    const entries = Array.isArray(document.blackboard) ? document.blackboard : [];
    return Object.fromEntries(entries.map(entry => [
        entry.key,
        entry.valueDouble ?? entry.value ?? entry.valueStr ?? null
    ]));
}

function resourceOccurrence(node, location, document) {
    const type = shortType(node.$type);
    return {
        dataset: location.dataset,
        file: location.file,
        rootId: document.id ?? document.skillId ?? null,
        path: location.path || '$',
        type,
        enabled: node.isEnable !== false,
        costType: node.costType ?? node.costData?.costType ?? null,
        operation: node.gainMethod ?? node.atbGainMethod ?? null,
        sourceType: node.atbSourceType ?? node.sourceType ?? null,
        targetType: node.targetType ?? null,
        isPercentValue: Boolean(node.isPercentValue),
        atbOnlyMainChar: Boolean(node.atbOnlyMainChar),
        ignoreUspGainScalar: Boolean(node.ignoreUspGainScalar),
        useUspRecoverTag: Boolean(node.useUspRecoverTag),
        uspRecoverTagIds: node.useUspRecoverTag
            ? [node.uspRecoverTag?.tagId].filter(value => value !== undefined && value !== 0)
            : [],
        refrainObtainUspTagIds: (node.refrainObtainUspTags?.predefinedTag ?? [])
            .map(tag => tag.tagId)
            .filter(value => value !== undefined && value !== 0),
        clearUspOnEnd: Boolean(node.clearUspOnEnd),
        valueKey: node.valueKey ?? null,
        realDeltaKey: node.realDeltaKey ?? null,
        costValue: descriptor(node.costValue ?? node.costData?.costValue),
        coefficient: descriptor(node.coefficient),
        factor: descriptor(node.factor),
        atbValueThreshold: node.costData?.atbValueThreshold ?? null,
        source: selector(node.source ?? node.sourceType),
        target: selector(node.targetSettings ?? node.target ?? node.targetType),
        rootBlackboard: blackboardMap(document)
    };
}

function visit(value, location, document, occurrences) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, {
            ...location,
            path: `${location.path}[${index}]`
        }, document, occurrences));
        return;
    }
    if (value.$type && resourceTypePattern.test(shortType(value.$type))) {
        occurrences.push(resourceOccurrence(value, location, document));
    }
    for (const [key, child] of Object.entries(value)) {
        visit(child, {
            ...location,
            path: `${location.path}${pathPart(key)}`
        }, document, occurrences);
    }
}

function countBy(values, select) {
    const counts = new Map();
    for (const value of values) {
        const selected = select(value);
        const key = selected === null || selected === undefined ? '(null)' : String(selected);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0])
    ));
}

function summarizeType(type, values) {
    return {
        type,
        occurrences: values.length,
        enabled: values.filter(value => value.enabled).length,
        costTypes: countBy(values, value => value.costType),
        operations: countBy(values, value => value.operation),
        sourceTypes: countBy(values, value => value.sourceType),
        percentValues: values.filter(value => value.isPercentValue).length,
        mainCharacterOnly: values.filter(value => value.atbOnlyMainChar).length,
        ignoresUspGainScalar: values.filter(value => value.ignoreUspGainScalar).length,
        usesUspRecoverTag: values.filter(value => value.useUspRecoverTag).length,
        datasets: countBy(values, value => value.dataset)
    };
}

const occurrences = [];
for (const dataset of sourceDirectories) {
    const directory = path.join(akeRoot, 'Json', dataset);
    const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
        const absolutePath = path.join(directory, file);
        const document = JSON.parse(await readFile(absolutePath, 'utf8'));
        visit(document, {
            dataset,
            file: path.relative(projectRoot, absolutePath).replaceAll('\\', '/'),
            path: '$'
        }, document, occurrences);
    }
}

const skillPatchTable = JSON.parse(await readFile(
    path.join(akeRoot, 'TableCfg', 'SkillPatchTable.json'),
    'utf8'
));
const patchCosts = Object.entries(skillPatchTable).map(([skillId, bundle]) => {
    const patch = bundle.SkillPatchDataBundle?.find(entry => Number(entry.level) === 1)
        ?? bundle.SkillPatchDataBundle?.[0]
        ?? null;
    return {
        skillId,
        level: patch?.level ?? null,
        costTypeCode: patch?.costType ?? null,
        costType: Number(patch?.costType) === 0 ? 'UltimateSp'
            : Number(patch?.costType) === 1 ? 'Atb'
                : String(patch?.costType),
        costValue: Number(patch?.costValue ?? 0),
        cooldownSeconds: Number(patch?.coolDown ?? 0)
    };
});

const byType = new Map();
for (const occurrence of occurrences) {
    if (!byType.has(occurrence.type)) byType.set(occurrence.type, []);
    byType.get(occurrence.type).push(occurrence);
}

const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sources: [
        'reference/public-data/akedata/Json/BuffData',
        'reference/public-data/akedata/Json/SkillData',
        'reference/public-data/akedata/TableCfg/SkillPatchTable.json'
    ],
    totals: {
        serializedResourceOccurrences: occurrences.length,
        uniqueSerializedTypes: byType.size,
        skillPatchEntries: patchCosts.length,
        paidSkillPatchEntries: patchCosts.filter(entry => entry.costValue > 0).length
    },
    actionTypes: [...byType.entries()]
        .map(([type, values]) => summarizeType(type, values))
        .sort((left, right) => right.occurrences - left.occurrences
            || left.type.localeCompare(right.type)),
    knownCompilerGaps: {
        unresolvedSerializedTypes: [
            'CostAtbRefreshLongestSkillCd'
        ],
        implementedFromPublicData: [
            'ObtainCostAction including percentage/main-character/scalar/recovery-tag routing',
            'ObtainUspInNormalSkill including team fan-out and returned-ATB eligibility',
            'GainCostAction literal resource gain',
            'GainBreakingAttackAtb',
            'CheckUsp',
            'CheckObtainAtbType',
            'SaveAtbObtainValue',
            'RefrainObtainUsp including tagged/global windows and clearUspOnEnd',
            'UltimateTimeAction shared-ATB recovery suspension'
        ],
        implementedResourceEventBridge: [
            'OnObtainAtb',
            'OnAtbMax',
            'OnAfterSkillApplyCost',
            'OnSquadUspChange'
        ],
        openSemanticQuestions: [
            'CostAtbRefreshLongestSkillCd requires the shared cooldown scheduler before execution can be exact.'
        ],
        teamwideNormalSkillUsp: 'ObtainUspInNormalSkill must fan out usp_everyone to every ally USP pool and apply usp_self only to the source.'
    },
    paidSkillPatches: patchCosts
        .filter(entry => entry.costValue > 0)
        .sort((left, right) => left.skillId.localeCompare(right.skillId)),
    occurrences
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${path.relative(projectRoot, outputPath)}\n`);
process.stdout.write(`${JSON.stringify(report.totals)}\n`);
