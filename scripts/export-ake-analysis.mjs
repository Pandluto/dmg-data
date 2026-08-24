#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const dataRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata');
const outputRoot = path.join(projectRoot, 'derived', 'ake-analysis');

const buffParserRelative = 'reference/third-party/akedatabase/plugin/js/v3-buff-data.js';
const skillParserRelative = 'reference/third-party/akedatabase/plugin/js/v3-skill-data.js';
const patchTableRelative = 'reference/public-data/akedata/TableCfg/SkillPatchTable.json';
const potentialTableRelative = 'reference/public-data/akedata/TableCfg/PotentialTalentEffectTable.json';

function safePath(root, ...parts) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, ...parts);
    const prefix = `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
        throw new Error(`Refusing path outside ${resolvedRoot}: ${resolved}`);
    }
    return resolved;
}

function projectPath(relativePath) {
    return safePath(projectRoot, relativePath);
}

function portablePath(absolutePath) {
    return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

function readJson(absolutePath) {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function sha256File(absolutePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function writeJson(absolutePath, value) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(absolutePath, serialized, 'utf8');
}

function listJsonFiles(absoluteDirectory) {
    if (!fs.existsSync(absoluteDirectory)) return [];
    return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => safePath(absoluteDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right, 'en'));
}

function loadAnalyzer(relativePath, globalName, methodName) {
    const absolutePath = projectPath(relativePath);
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(absolutePath, 'utf8'), context, { filename: absolutePath });
    const api = context.window[globalName];
    if (!api || typeof api[methodName] !== 'function') {
        throw new Error(`${globalName}.${methodName} is unavailable in ${relativePath}`);
    }
    return { api, absolutePath, sha256: sha256File(absolutePath) };
}

function inputRecord(role, absolutePath) {
    return {
        role,
        path: portablePath(absolutePath),
        sha256: sha256File(absolutePath)
    };
}

function summarize(kind, analysis) {
    if (kind === 'BuffData') {
        return {
            eventCount: analysis.stats?.eventCount ?? analysis.events?.length ?? 0,
            linkCount: analysis.stats?.linkCount ?? analysis.links?.length ?? 0,
            blackboardDependencyCount: analysis.stats?.blackboardDependencyCount
                ?? analysis.blackboard?.dependencies?.length
                ?? 0,
            warningCount: analysis.warnings?.length ?? 0,
            traversalStopped: analysis.stats?.traversalStopped ?? false
        };
    }
    return {
        eventCount: analysis.events?.length ?? 0,
        linkCount: analysis.links?.length ?? 0,
        hitCount: analysis.hits?.length ?? 0,
        windowCount: analysis.windows?.length ?? 0,
        warningCount: analysis.warnings?.length ?? 0,
        pendingSpatialReferenceCount: analysis.spatial?.pendingReferences?.length ?? 0
    };
}

const lockPath = projectPath('sources.lock.json');
const lock = readJson(lockPath);
const wrapperSha256 = sha256File(scriptPath);
const buffAnalyzer = loadAnalyzer(buffParserRelative, 'AKEV3BuffData', 'analyzeBuff');
const skillAnalyzer = loadAnalyzer(skillParserRelative, 'AKEV3SkillData', 'analyzeSkill');

const patchTablePath = projectPath(patchTableRelative);
const potentialTablePath = projectPath(potentialTableRelative);
const patchTable = readJson(patchTablePath);
const potentialTable = readJson(potentialTablePath);
const localSkillDirectory = safePath(dataRoot, 'Json', 'SkillData');

async function loadLocalSkillData(skillId) {
    const normalizedId = String(skillId ?? '');
    if (!/^[A-Za-z0-9_.-]+$/.test(normalizedId)) {
        throw new Error(`Unsafe child SkillData id: ${normalizedId}`);
    }
    const childPath = safePath(localSkillDirectory, `${normalizedId}.json`);
    if (!fs.existsSync(childPath)) {
        throw new Error(`Child SkillData is not present in the local snapshot: ${normalizedId}`);
    }
    return readJson(childPath);
}

const records = [];

for (const rawPath of listJsonFiles(safePath(dataRoot, 'Json', 'BuffData'))) {
    const raw = readJson(rawPath);
    const id = String(raw.id || path.basename(rawPath, '.json'));
    const analysis = buffAnalyzer.api.analyzeBuff(raw, {});
    const outputPath = safePath(outputRoot, 'BuffData', `${id}.analyzed.json`);
    const document = {
        _meta: {
            schemaVersion: 1,
            kind: 'BuffData',
            id,
            generator: 'AKEV3BuffData.analyzeBuff',
            generatorWrapper: 'scripts/export-ake-analysis.mjs',
            generatorWrapperSha256: wrapperSha256,
            akeDatabaseCommit: lock.pins.akeDatabaseCommit,
            akedataJsonRevision: lock.pins.akedataJsonRevision,
            inputs: [
                inputRecord('raw', rawPath),
                inputRecord('analyzer', buffAnalyzer.absolutePath)
            ],
            semantics: 'research-view-model-not-runtime-state'
        },
        analysis
    };
    writeJson(outputPath, document);
    records.push({
        kind: 'BuffData',
        id,
        rawPath: portablePath(rawPath),
        rawSha256: sha256File(rawPath),
        analyzerPath: portablePath(buffAnalyzer.absolutePath),
        analyzerSha256: buffAnalyzer.sha256,
        outputPath: portablePath(outputPath),
        outputSha256: sha256File(outputPath),
        summary: summarize('BuffData', analysis)
    });
}

for (const rawPath of listJsonFiles(localSkillDirectory)) {
    const raw = readJson(rawPath);
    const id = String(raw.skillId || path.basename(rawPath, '.json'));
    const patchBundle = patchTable[id] ?? null;
    const analysis = await skillAnalyzer.api.analyzeSkill(raw, patchBundle, {
        level: raw.level,
        tables: {
            patches: patchTable,
            PotentialTalentEffectTable: potentialTable
        },
        loadSkillData: loadLocalSkillData
    });
    const outputPath = safePath(outputRoot, 'SkillData', `${id}.analyzed.json`);
    const document = {
        _meta: {
            schemaVersion: 1,
            kind: 'SkillData',
            id,
            level: raw.level ?? null,
            generator: 'AKEV3SkillData.analyzeSkill',
            generatorWrapper: 'scripts/export-ake-analysis.mjs',
            generatorWrapperSha256: wrapperSha256,
            akeDatabaseCommit: lock.pins.akeDatabaseCommit,
            akedataTableVersion: lock.pins.akedataTableVersion,
            akedataJsonRevision: lock.pins.akedataJsonRevision,
            inputs: [
                inputRecord('raw', rawPath),
                inputRecord('analyzer', skillAnalyzer.absolutePath),
                inputRecord('skill-patch-table', patchTablePath),
                inputRecord('potential-talent-effect-table', potentialTablePath)
            ],
            semantics: 'research-view-model-not-runtime-state'
        },
        analysis
    };
    writeJson(outputPath, document);
    records.push({
        kind: 'SkillData',
        id,
        rawPath: portablePath(rawPath),
        rawSha256: sha256File(rawPath),
        analyzerPath: portablePath(skillAnalyzer.absolutePath),
        analyzerSha256: skillAnalyzer.sha256,
        outputPath: portablePath(outputPath),
        outputSha256: sha256File(outputPath),
        summary: summarize('SkillData', analysis)
    });
}

records.sort((left, right) => `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`, 'en'));

const manifestPath = safePath(outputRoot, 'manifest.json');
writeJson(manifestPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatorWrapper: 'scripts/export-ake-analysis.mjs',
    generatorWrapperSha256: wrapperSha256,
    pins: lock.pins,
    recordCount: records.length,
    records
});

const buffCount = records.filter(record => record.kind === 'BuffData').length;
const skillCount = records.filter(record => record.kind === 'SkillData').length;
process.stdout.write(`Exported ${buffCount} BuffData and ${skillCount} SkillData analysis documents.\n`);
process.stdout.write(`Manifest: ${portablePath(manifestPath)}\n`);
