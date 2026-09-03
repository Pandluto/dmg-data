import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const akedataRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata');
const jsonRoot = path.join(akedataRoot, 'Json');
const tableRoot = path.join(akedataRoot, 'TableCfg');
const paths = {
    lock: path.join(projectRoot, 'sources.lock.json'),
    publicManifest: path.join(akedataRoot, 'manifest.json'),
    assetIndex: path.join(akedataRoot, 'asset-sync-index.json'),
    tableManifest: path.join(akedataRoot, 'table-corpus.manifest.json'),
    runtimeManifest: path.join(akedataRoot, 'runtime-corpus.manifest.json'),
    analysisManifest: path.join(projectRoot, 'derived', 'ake-analysis', 'manifest.json'),
    analysisGenerator: path.join(projectRoot, 'scripts', 'export-ake-analysis.mjs'),
    calcMetadata: path.join(projectRoot, 'reference', 'public-data', 'calc', 'api', 'metadata.json')
};

function digest(algorithm, data) {
    return createHash(algorithm).update(data).digest('hex');
}

function sha256(data) {
    return digest('sha256', data);
}

function md5(data) {
    return digest('md5', data);
}

function asCrlf(data) {
    return Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n'));
}

function comparePaths(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function recordsHash(records) {
    return sha256(Buffer.from([...records]
        .sort((left, right) => comparePaths(left.path, right.path))
        .map(record => `${record.path}\0${record.sha256}\n`)
        .join('')));
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function safeRepositoryPath(relativePath) {
    const target = path.resolve(projectRoot, relativePath);
    if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Path escapes repository: ${relativePath}`);
    }
    return target;
}

function safeRuntimePath(relativePath) {
    const target = path.resolve(jsonRoot, relativePath);
    if (!target.startsWith(`${jsonRoot}${path.sep}`)) {
        throw new Error(`Path escapes runtime corpus: ${relativePath}`);
    }
    return target;
}

const errors = [];
function expect(actual, expected, label) {
    if (actual !== expected) errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectArray(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function readRuntimeFile(relativePath, cache) {
    if (cache.has(relativePath)) return cache.get(relativePath);
    try {
        const data = await readFile(safeRuntimePath(relativePath));
        cache.set(relativePath, data);
        return data;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function runtimeReferenceType(key) {
    if (/buffId(?:List)?$/i.test(key)) return 'BuffData';
    if (/skillId(?:List)?$/i.test(key)) return 'SkillData';
    return null;
}

function addRuntimeReference(references, type, value) {
    if (Array.isArray(value)) {
        for (const item of value) addRuntimeReference(references, type, item);
        return;
    }
    if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_]+$/.test(value)) return;
    references.push({ type, id: value });
}

function collectRuntimeReferences(value, references = []) {
    if (Array.isArray(value)) {
        for (const item of value) collectRuntimeReferences(item, references);
        return references;
    }
    if (!value || typeof value !== 'object') return references;
    for (const [key, child] of Object.entries(value)) {
        const type = runtimeReferenceType(key);
        if (type) addRuntimeReference(references, type, child);
        collectRuntimeReferences(child, references);
    }
    return references;
}

async function runtimeRoots() {
    const [characters, weapons, talentEffects, equipmentSuits, equipment] = await Promise.all([
        readJson(path.join(tableRoot, 'CharGrowthTable.json')),
        readJson(path.join(tableRoot, 'WeaponBasicTable.json')),
        readJson(path.join(tableRoot, 'PotentialTalentEffectTable.json')),
        readJson(path.join(tableRoot, 'EquipSuitTable.json')),
        readJson(path.join(tableRoot, 'EquipTable.json'))
    ]);
    const roots = [];
    for (const character of Object.values(characters)) {
        for (const skillGroup of Object.values(character.skillGroupMap ?? {})) {
            addRuntimeReference(roots, 'SkillData', skillGroup.skillIdList ?? []);
        }
    }
    for (const weapon of Object.values(weapons)) {
        addRuntimeReference(roots, 'SkillData', weapon.weaponSkillList ?? []);
        addRuntimeReference(roots, 'SkillData', weapon.weaponPotentialSkill ?? '');
    }
    collectRuntimeReferences(talentEffects, roots);
    collectRuntimeReferences(equipmentSuits, roots);
    collectRuntimeReferences(equipment, roots);
    return roots;
}

async function verifyDiscovery({ indexedPaths, runtimeManifest, runtimeCache }) {
    const roots = await runtimeRoots();
    const queue = [...roots];
    const seen = new Set();
    const missing = [];
    const supplemental = [];
    const records = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const { type, id } = queue[cursor];
        const key = `${type}/${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const relativePath = `${key}.json`;
        const data = await readRuntimeFile(relativePath, runtimeCache);
        if (data === null) {
            missing.push(relativePath);
            continue;
        }
        records.push({ path: relativePath, sha256: sha256(data) });
        if (!indexedPaths.has(relativePath)) supplemental.push(relativePath);
        try {
            queue.push(...collectRuntimeReferences(JSON.parse(data.toString('utf8'))));
        } catch (error) {
            errors.push(`Invalid runtime JSON ${relativePath}: ${error.message}`);
        }
    }
    missing.sort(comparePaths);
    supplemental.sort(comparePaths);
    expect(runtimeManifest.discovery.roots, roots.length, 'runtime discovery root references');
    expect(runtimeManifest.discovery.resolved, records.length, 'runtime discovery resolved files');
    expectArray(runtimeManifest.discovery.missing, missing, 'runtime discovery missing files');
    expectArray(runtimeManifest.discovery.supplementalFiles, supplemental, 'runtime discovery supplemental files');
    expect(runtimeManifest.discovery.contentHash, recordsHash(records), 'runtime discovery aggregate hash');
    return { roots: roots.length, resolved: records.length, supplemental: supplemental.length, missing: missing.length };
}

const [lock, publicManifest, assetIndex, tableManifest, runtimeManifest, analysisManifest, calcMetadata] = await Promise.all([
    readJson(paths.lock),
    readJson(paths.publicManifest),
    readJson(paths.assetIndex),
    readJson(paths.tableManifest),
    readJson(paths.runtimeManifest),
    readJson(paths.analysisManifest),
    readJson(paths.calcMetadata)
]);

expect(lock.schemaVersion, 2, 'source lock schema');
expect(lock.pins.akedataTableVersion, tableManifest.sourceVersion.id, 'pinned table version');
expect(lock.pins.akedataJsonRevision, assetIndex.revision, 'pinned runtime revision');
expect(lock.pins.calcDataVersion, calcMetadata.data.version, 'pinned Calc version');
if (!publicManifest.versions?.some(version => version.id === tableManifest.sourceVersion.id)) {
    errors.push(`Pinned table version ${tableManifest.sourceVersion.id} is absent from manifest.json`);
}
expect(tableManifest.sharedRevision, publicManifest.sharedRevision, 'table shared revision');
expect(runtimeManifest.indexRevision, assetIndex.revision, 'runtime manifest index revision');
expect(runtimeManifest.indexUpdatedAt, assetIndex.updatedAt, 'runtime manifest index timestamp');

const sourceIds = new Set();
const sourcePaths = new Set();
for (const source of lock.sources ?? []) {
    if (sourceIds.has(source.id)) errors.push(`Duplicate source id: ${source.id}`);
    if (sourcePaths.has(source.path)) errors.push(`Duplicate source path: ${source.path}`);
    sourceIds.add(source.id);
    sourcePaths.add(source.path);
    try {
        const data = await readFile(safeRepositoryPath(source.path));
        expect(source.bytes, data.length, `source bytes ${source.path}`);
        expect(source.sha256, sha256(data), `source hash ${source.path}`);
    } catch (error) {
        errors.push(`Cannot read source ${source.path}: ${error.message}`);
    }
}

expectArray(analysisManifest.pins, lock.pins, 'reference analysis pins');
expect(analysisManifest.generatorWrapper, 'scripts/export-ake-analysis.mjs', 'reference analysis generator');
expect(
    analysisManifest.generatorWrapperSha256,
    sha256(await readFile(paths.analysisGenerator)),
    'reference analysis generator hash'
);
expect(analysisManifest.recordCount, analysisManifest.records?.length ?? 0, 'reference analysis record count');
const lockedAnalysisPaths = [...sourcePaths]
    .filter(relativePath => /^reference\/public-data\/akedata\/Json\/(?:BuffData|SkillData)\/[^/]+\.json$/u.test(relativePath))
    .sort(comparePaths);
const recordedAnalysisInputs = (analysisManifest.records ?? [])
    .map(record => record.rawPath)
    .sort(comparePaths);
expectArray(recordedAnalysisInputs, lockedAnalysisPaths, 'reference analysis input selection');
const recordedAnalysisOutputs = [];
const analysisRecordIds = new Set();
for (const record of analysisManifest.records ?? []) {
    const recordKey = `${record.kind}/${record.id}`;
    if (analysisRecordIds.has(recordKey)) errors.push(`Duplicate reference analysis record: ${recordKey}`);
    analysisRecordIds.add(recordKey);
    recordedAnalysisOutputs.push(record.outputPath);
    try {
        const [rawData, analyzerData, outputData] = await Promise.all([
            readFile(safeRepositoryPath(record.rawPath)),
            readFile(safeRepositoryPath(record.analyzerPath)),
            readFile(safeRepositoryPath(record.outputPath))
        ]);
        expect(record.rawSha256, sha256(rawData), `reference analysis raw hash ${recordKey}`);
        expect(record.analyzerSha256, sha256(analyzerData), `reference analysis analyzer hash ${recordKey}`);
        expect(record.outputSha256, sha256(outputData), `reference analysis output hash ${recordKey}`);
    } catch (error) {
        errors.push(`Cannot verify reference analysis ${recordKey}: ${error.message}`);
    }
}
const actualAnalysisOutputs = [];
for (const kind of ['BuffData', 'SkillData']) {
    const directory = path.join(projectRoot, 'derived', 'ake-analysis', kind);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.analyzed.json')) {
            actualAnalysisOutputs.push(path.relative(projectRoot, path.join(directory, entry.name)).replaceAll('\\', '/'));
        }
    }
}
expectArray(actualAnalysisOutputs.sort(comparePaths), recordedAnalysisOutputs.sort(comparePaths), 'reference analysis outputs');

const tableRecords = [];
for (const [fileName, metadata] of Object.entries(tableManifest.files ?? {})
    .sort(([left], [right]) => comparePaths(left, right))) {
    const relativePath = `reference/public-data/akedata/TableCfg/${fileName}`;
    const data = await readFile(safeRepositoryPath(relativePath));
    expect(metadata.bytes, data.length, `table bytes ${fileName}`);
    expect(metadata.sha256, sha256(data), `table hash ${fileName}`);
    if (!sourcePaths.has(relativePath)) errors.push(`Table absent from sources.lock.json: ${relativePath}`);
    tableRecords.push({ path: fileName, sha256: sha256(data) });
}
expect(tableManifest.contentHash, recordsHash(tableRecords), 'table corpus aggregate hash');
expect(lock.corpora.tables.files, tableRecords.length, 'locked table file count');
expect(lock.corpora.tables.version, tableManifest.sourceVersion.id, 'locked table corpus version');
expect(lock.corpora.tables.sharedRevision, tableManifest.sharedRevision, 'locked table shared revision');
expect(lock.corpora.tables.contentHash, tableManifest.contentHash, 'locked table aggregate hash');
expect(lock.corpora.tables.manifestSha256, sha256(await readFile(paths.tableManifest)), 'locked table manifest hash');

const indexBytes = await readFile(paths.assetIndex);
expect(runtimeManifest.indexSha256, sha256(indexBytes), 'runtime asset index hash');
const indexedEntries = Object.entries(assetIndex.datasets?.json?.files ?? {})
    .filter(([relativePath]) => runtimeManifest.scopes.some(scope => relativePath.startsWith(scope)))
    .sort(([left], [right]) => comparePaths(left, right));
const indexedPaths = new Set(indexedEntries.map(([relativePath]) => relativePath));
const runtimeCache = new Map();
const indexedRecords = [];
let expectedBytes = 0;
for (const [relativePath, metadata] of indexedEntries) {
    const data = await readRuntimeFile(relativePath, runtimeCache);
    expectedBytes += Number(metadata.size);
    if (data === null) {
        errors.push(`Missing indexed runtime file: ${relativePath}`);
        continue;
    }
    if (md5(data) !== metadata.md5 && md5(asCrlf(data)) !== metadata.md5) {
        errors.push(`Runtime index MD5 mismatch: ${relativePath}`);
    }
    indexedRecords.push({ path: relativePath, sha256: sha256(data) });
}
expect(runtimeManifest.files, indexedEntries.length, 'runtime indexed file count');
expect(runtimeManifest.expectedBytes, expectedBytes, 'runtime expected bytes');
expect(runtimeManifest.processedBytes, expectedBytes, 'runtime processed bytes');
expect(runtimeManifest.verified + runtimeManifest.downloaded, indexedEntries.length, 'runtime processed file count');
expect(runtimeManifest.contentHash, recordsHash(indexedRecords), 'runtime indexed aggregate hash');

const manifestResolvedRecords = runtimeManifest.discovery?.resolvedRecords ?? [];
expect(manifestResolvedRecords.length, runtimeManifest.discovery.resolved, 'runtime resolved record count');
for (const record of manifestResolvedRecords) {
    const data = await readRuntimeFile(record.path, runtimeCache);
    if (data === null) {
        errors.push(`Missing discovered runtime file: ${record.path}`);
        continue;
    }
    expect(record.bytes, data.length, `discovered bytes ${record.path}`);
    expect(record.sha256, sha256(data), `discovered hash ${record.path}`);
}
expect(runtimeManifest.discovery.contentHash, recordsHash(manifestResolvedRecords), 'runtime manifest discovery hash');
const discoverySummary = await verifyDiscovery({ indexedPaths, runtimeManifest, runtimeCache });

expect(lock.corpora.runtime.manifestSha256, sha256(await readFile(paths.runtimeManifest)), 'locked runtime manifest hash');
expect(lock.corpora.runtime.indexSha256, runtimeManifest.indexSha256, 'locked runtime index hash');
expect(lock.corpora.runtime.indexRevision, runtimeManifest.indexRevision, 'locked runtime index revision');
expect(lock.corpora.runtime.indexedFiles, runtimeManifest.files, 'locked runtime indexed count');
expect(lock.corpora.runtime.indexedContentHash, runtimeManifest.contentHash, 'locked runtime indexed hash');
expect(lock.corpora.runtime.discoveredFiles, runtimeManifest.discovery.resolved, 'locked runtime discovery count');
expect(lock.corpora.runtime.discoveredContentHash, runtimeManifest.discovery.contentHash, 'locked runtime discovery hash');
expect(lock.corpora.runtime.supplementalFiles, runtimeManifest.discovery.supplementalFiles.length, 'locked supplemental count');
expect(lock.corpora.runtime.missingFiles, runtimeManifest.discovery.missing.length, 'locked missing count');

if (errors.length > 0) {
    console.error(errors.map(error => `CONSISTENCY_ERROR ${error}`).join('\n'));
    process.exitCode = 1;
} else {
    console.log(JSON.stringify({
        status: 'CONSISTENCY_OK',
        tableVersion: lock.pins.akedataTableVersion,
        runtimeRevision: lock.pins.akedataJsonRevision,
        sources: lock.sources.length,
        referenceAnalyses: analysisManifest.recordCount,
        tables: tableRecords.length,
        indexedRuntimeFiles: indexedRecords.length,
        discovery: discoverySummary
    }, null, 2));
}
