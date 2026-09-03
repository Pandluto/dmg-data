import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(projectRoot, 'sources.lock.json');
const akedataRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata');
const publicManifestPath = path.join(akedataRoot, 'manifest.json');
const assetIndexPath = path.join(akedataRoot, 'asset-sync-index.json');
const tableManifestPath = path.join(akedataRoot, 'table-corpus.manifest.json');
const runtimeManifestPath = path.join(akedataRoot, 'runtime-corpus.manifest.json');
const calcMetadataPath = path.join(projectRoot, 'reference', 'public-data', 'calc', 'api', 'metadata.json');

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

function recordsHash(records) {
    return sha256(Buffer.from([...records]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        .map(record => `${record.path}\0${record.sha256}\n`)
        .join('')));
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function repositoryPath(absolutePath) {
    return path.relative(projectRoot, absolutePath).replaceAll('\\', '/');
}

function safeRepositoryTarget(relativePath) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (absolutePath !== projectRoot && !absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Source path escapes repository: ${relativePath}`);
    }
    return absolutePath;
}

async function refreshRecord(record, overrides = {}) {
    const next = { ...record, ...overrides };
    const data = await readFile(safeRepositoryTarget(next.path));
    return {
        ...next,
        bytes: data.length,
        sha256: sha256(data)
    };
}

function tableId(fileName) {
    const stem = fileName.replace(/\.json$/u, '');
    return `table.${stem
        .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
        .replaceAll('_', '-')
        .toLowerCase()}`;
}

function sourceRecord({ id, url, sourcePath, previous = null }) {
    return {
        id,
        url,
        method: previous?.method ?? 'GET',
        requestBody: previous?.requestBody ?? null,
        path: sourcePath,
        bytes: 0,
        sha256: '',
        downloadedAt: previous?.downloadedAt ?? null,
        etag: previous?.etag ?? null,
        lastModified: previous?.lastModified ?? null
    };
}

const [previousLock, publicManifest, assetIndex, tableManifest, runtimeManifest, calcMetadata] = await Promise.all([
    readJson(lockPath),
    readJson(publicManifestPath),
    readJson(assetIndexPath),
    readJson(tableManifestPath),
    readJson(runtimeManifestPath),
    readJson(calcMetadataPath)
]);

const selectedVersion = tableManifest.sourceVersion;
if (!selectedVersion?.id || !publicManifest.versions?.some(version => version.id === selectedVersion.id)) {
    throw new Error('Table corpus sourceVersion is absent from the pinned AKEDatabase manifest.');
}
if (!assetIndex.revision || runtimeManifest.indexRevision !== assetIndex.revision) {
    throw new Error('Runtime corpus and asset index revisions do not match.');
}

const previousByPath = new Map(previousLock.sources.map(source => [source.path, source]));
const sourceRecords = [];
const fixedSources = [
    {
        id: 'akedata.manifest',
        url: tableManifest.sourceManifest,
        sourcePath: repositoryPath(publicManifestPath)
    },
    {
        id: 'akedata.asset-index',
        url: runtimeManifest.sourceIndex,
        sourcePath: repositoryPath(assetIndexPath)
    }
];
for (const fixed of fixedSources) {
    const previous = previousByPath.get(fixed.sourcePath);
    sourceRecords.push(await refreshRecord(sourceRecord({ ...fixed, previous })));
}

const tableRecords = [];
for (const [fileName, metadata] of Object.entries(tableManifest.files ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const sourcePath = `reference/public-data/akedata/TableCfg/${fileName}`;
    const previous = previousByPath.get(sourcePath);
    const record = await refreshRecord(sourceRecord({
        id: previous?.id ?? tableId(fileName),
        url: metadata.source,
        sourcePath,
        previous
    }));
    if (record.bytes !== metadata.bytes || record.sha256 !== metadata.sha256) {
        throw new Error(`Table corpus metadata does not match ${sourcePath}`);
    }
    tableRecords.push(record);
}
sourceRecords.push(...tableRecords);

const managedPaths = new Set(sourceRecords.map(source => source.path));
const tablePrefix = 'reference/public-data/akedata/TableCfg/';
for (const previous of previousLock.sources) {
    if (managedPaths.has(previous.path) || previous.path.startsWith(tablePrefix)) continue;
    sourceRecords.push(await refreshRecord(previous));
}

const tableContentRecords = tableRecords.map(record => ({
    path: path.posix.basename(record.path),
    sha256: record.sha256
}));
const tableContentHash = tableManifest.contentHash ?? recordsHash(tableContentRecords);
if (tableContentHash !== recordsHash(tableContentRecords)) {
    throw new Error('Table corpus aggregate hash does not match its files.');
}

const tableManifestBytes = await readFile(tableManifestPath);
const runtimeManifestBytes = await readFile(runtimeManifestPath);
const runtimeDiscovery = runtimeManifest.discovery ?? {};
const nextWithoutTimestamp = {
    schemaVersion: 2,
    pins: {
        akedataTableVersion: selectedVersion.id,
        akedataJsonRevision: assetIndex.revision,
        akeDatabaseCommit: previousLock.pins.akeDatabaseCommit,
        calcDataVersion: calcMetadata.data.version,
        calcBundle: previousLock.pins.calcBundle
    },
    corpora: {
        tables: {
            manifestPath: repositoryPath(tableManifestPath),
            manifestSha256: sha256(tableManifestBytes),
            version: selectedVersion.id,
            sharedRevision: tableManifest.sharedRevision,
            files: tableRecords.length,
            contentHash: tableContentHash
        },
        runtime: {
            manifestPath: repositoryPath(runtimeManifestPath),
            manifestSha256: sha256(runtimeManifestBytes),
            indexPath: repositoryPath(assetIndexPath),
            indexSha256: runtimeManifest.indexSha256,
            indexRevision: runtimeManifest.indexRevision,
            indexedFiles: runtimeManifest.files,
            indexedContentHash: runtimeManifest.contentHash,
            discoveredFiles: runtimeDiscovery.resolved,
            discoveredContentHash: runtimeDiscovery.contentHash,
            supplementalFiles: runtimeDiscovery.supplementalRecords?.length
                ?? runtimeDiscovery.supplementalFiles?.length
                ?? 0,
            missingFiles: runtimeDiscovery.missing?.length ?? 0
        }
    },
    sources: sourceRecords
};

const previousComparable = { ...previousLock };
delete previousComparable.generatedAt;
const generatedAt = JSON.stringify(previousComparable) === JSON.stringify(nextWithoutTimestamp)
    ? previousLock.generatedAt
    : new Date().toISOString();
const nextLock = {
    schemaVersion: nextWithoutTimestamp.schemaVersion,
    generatedAt,
    pins: nextWithoutTimestamp.pins,
    corpora: nextWithoutTimestamp.corpora,
    sources: nextWithoutTimestamp.sources
};

await writeFile(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`);
console.log(JSON.stringify({
    lock: repositoryPath(lockPath),
    generatedAt,
    pins: nextLock.pins,
    sourceRecords: nextLock.sources.length,
    corpora: nextLock.corpora
}, null, 2));
