import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(
    projectRoot,
    'reference', 'public-data', 'akedata', 'asset-sync-index.json'
);
const jsonRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata', 'Json');
const tableRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata', 'TableCfg');
const manifestPath = path.join(
    projectRoot,
    'reference', 'public-data', 'akedata', 'runtime-corpus.manifest.json'
);
const indexUrl = 'https://data.akedata.wiki/asset-sync-index.json';
const baseUrl = 'https://data.akedata.wiki/public/Json';
const concurrency = 12;
const refreshIndexRequested = process.argv.includes('--refresh-index');
const requestedScopes = process.argv.slice(2).filter(argument => argument.startsWith('--scope='))
    .map(argument => argument.slice('--scope='.length));
const scopes = requestedScopes.length > 0 ? requestedScopes : [
    'BuffData/',
    'SkillData/chr_',
    'SkillData/sk_wpn_',
    'SkillData/wpn_',
    'SkillData/passive_equip',
    'SkillData/passive_rpg_equip',
    'SkillData/rpg_equip'
];

function md5(buffer) {
    return createHash('md5').update(buffer).digest('hex');
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function hashRecords(records) {
    return sha256(Buffer.from([...records]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        .map(record => `${record.path}\0${record.sha256}\n`)
        .join('')));
}

function normalizeJsonNewlines(buffer) {
    return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'));
}

function asCrlf(buffer) {
    return Buffer.from(buffer.toString('utf8').replace(/\r?\n/g, '\r\n'));
}

function safeTarget(relativePath) {
    const target = path.resolve(jsonRoot, relativePath);
    const prefix = `${jsonRoot}${path.sep}`;
    if (!target.startsWith(prefix)) throw new Error(`Refusing corpus path outside Json root: ${relativePath}`);
    return target;
}

async function fetchBytes(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            lastError = error;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
    }
    throw lastError;
}

async function fetchOptionalBytes(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            lastError = error;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
    }
    throw lastError;
}

async function loadIndex() {
    const data = refreshIndexRequested
        ? await fetchBytes(`${indexUrl}?_=${Date.now()}`)
        : await readFile(indexPath);
    const parsed = JSON.parse(data.toString('utf8'));
    if (!parsed?.datasets?.json?.files || typeof parsed.datasets.json.files !== 'object') {
        throw new Error('AKEDatabase asset index does not contain datasets.json.files.');
    }
    if (refreshIndexRequested) {
        const temporary = `${indexPath}.download`;
        await rm(temporary, { force: true });
        await writeFile(temporary, normalizeJsonNewlines(data));
        await rename(temporary, indexPath);
    }
    return parsed;
}

async function existingMatches(target, metadata) {
    try {
        await stat(target);
        const data = await readFile(target);
        // AKEDatabase's CDN stores these pretty-printed JSON files with CRLF,
        // while the repository deliberately keeps LF. Verify either the raw
        // wire form or the reproducible CRLF form without dirtying every file.
        return md5(data) === metadata.md5 || md5(asCrlf(data)) === metadata.md5;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function download(relativePath, metadata) {
    const target = safeTarget(relativePath);
    if (await existingMatches(target, metadata)) return { status: 'verified', bytes: metadata.size };
    const url = `${baseUrl}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const temporary = `${target}.download`;
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            const data = Buffer.from(await response.arrayBuffer());
            if (data.length !== Number(metadata.size)) {
                throw new Error(`Size mismatch for ${relativePath}: ${data.length} != ${metadata.size}`);
            }
            const actualMd5 = md5(data);
            if (actualMd5 !== metadata.md5) {
                throw new Error(`MD5 mismatch for ${relativePath}: ${actualMd5} != ${metadata.md5}`);
            }
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(temporary, normalizeJsonNewlines(data));
            await rename(temporary, target);
            return { status: 'downloaded', bytes: data.length };
        } catch (error) {
            lastError = error;
            await rm(temporary, { force: true });
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
        }
    }
    throw lastError;
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
    if (typeof value !== 'string' || value.length === 0) return;
    if (!/^[A-Za-z0-9_]+$/.test(value)) return;
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

async function readTable(name) {
    return JSON.parse(await readFile(path.join(tableRoot, `${name}.json`), 'utf8'));
}

async function discoverRuntimeRoots() {
    const [characters, weapons, talentEffects, equipmentSuits, equipment] = await Promise.all([
        readTable('CharGrowthTable'),
        readTable('WeaponBasicTable'),
        readTable('PotentialTalentEffectTable'),
        readTable('EquipSuitTable'),
        readTable('EquipTable')
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

async function readOrDownloadDiscovered(type, id) {
    const relativePath = `${type}/${id}.json`;
    const target = safeTarget(relativePath);
    try {
        return { data: await readFile(target), status: 'verified', relativePath };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
    const data = await fetchOptionalBytes(`${baseUrl}/${encodedPath}?_=${Date.now()}`);
    if (data === null) return { data: null, status: 'missing', relativePath };
    const normalized = normalizeJsonNewlines(data);
    const temporary = `${target}.download`;
    await mkdir(path.dirname(target), { recursive: true });
    await rm(temporary, { force: true });
    await writeFile(temporary, normalized);
    await rename(temporary, target);
    return { data: normalized, status: 'downloaded', relativePath };
}

async function discoverRuntimeClosure(indexedPaths) {
    const queue = await discoverRuntimeRoots();
    const seen = new Set();
    const result = {
        roots: queue.length,
        resolved: 0,
        verified: 0,
        downloaded: 0,
        supplementalFiles: [],
        supplementalRecords: [],
        missing: []
    };
    const contentRecords = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const reference = queue[cursor];
        const key = `${reference.type}/${reference.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const resolved = await readOrDownloadDiscovered(reference.type, reference.id);
        if (resolved.status === 'missing') {
            result.missing.push(resolved.relativePath);
            continue;
        }
        result[resolved.status] += 1;
        result.resolved += 1;
        const record = {
            path: resolved.relativePath,
            bytes: resolved.data.length,
            sha256: sha256(resolved.data),
            source: `${baseUrl}/${resolved.relativePath.split('/').map(encodeURIComponent).join('/')}`
        };
        contentRecords.push(record);
        if (!indexedPaths.has(resolved.relativePath)) {
            result.supplementalFiles.push(resolved.relativePath);
            result.supplementalRecords.push(record);
        }
        let parsed;
        try {
            parsed = JSON.parse(resolved.data.toString('utf8'));
        } catch (error) {
            throw new Error(`Invalid discovered runtime JSON ${resolved.relativePath}: ${error.message}`);
        }
        queue.push(...collectRuntimeReferences(parsed));
    }
    result.supplementalFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    result.supplementalRecords.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    result.missing.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    contentRecords.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    result.contentHash = hashRecords(contentRecords);
    result.resolvedRecords = contentRecords;
    return result;
}

const index = await loadIndex();
const entries = Object.entries(index.datasets?.json?.files ?? {})
    .filter(([relativePath]) => scopes.some(scope => relativePath.startsWith(scope)))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
if (entries.length === 0) throw new Error(`No corpus files matched scopes: ${scopes.join(', ')}`);

const summary = {
    schemaVersion: 1,
    indexRevision: index.revision,
    indexUpdatedAt: index.updatedAt,
    sourceIndex: indexUrl,
    baseUrl,
    scopes,
    files: entries.length,
    expectedBytes: entries.reduce((sum, [, metadata]) => sum + Number(metadata.size), 0),
    verified: 0,
    downloaded: 0,
    processedBytes: 0,
    indexSha256: sha256(await readFile(indexPath)),
    contentHash: null
};
const contentRecords = new Array(entries.length);
let cursor = 0;
let completed = 0;
let lastReported = 0;

async function worker() {
    while (cursor < entries.length) {
        const index = cursor++;
        const [relativePath, metadata] = entries[index];
        const result = await download(relativePath, metadata);
        const localData = await readFile(safeTarget(relativePath));
        contentRecords[index] = {
            path: relativePath,
            sha256: sha256(localData)
        };
        summary[result.status] += 1;
        summary.processedBytes += Number(result.bytes);
        completed += 1;
        if (completed === entries.length || completed - lastReported >= 100) {
            lastReported = completed;
            console.log(`corpus ${completed}/${entries.length} verified=${summary.verified} downloaded=${summary.downloaded}`);
        }
    }
}

await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
summary.contentHash = hashRecords(contentRecords);
summary.discovery = await discoverRuntimeClosure(new Set(entries.map(([relativePath]) => relativePath)));
await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
    manifest: path.relative(projectRoot, manifestPath).replaceAll('\\', '/'),
    schemaVersion: summary.schemaVersion,
    indexRevision: summary.indexRevision,
    files: summary.files,
    expectedBytes: summary.expectedBytes,
    verified: summary.verified,
    downloaded: summary.downloaded,
    indexSha256: summary.indexSha256,
    contentHash: summary.contentHash,
    discovery: {
        roots: summary.discovery.roots,
        resolved: summary.discovery.resolved,
        verified: summary.discovery.verified,
        downloaded: summary.discovery.downloaded,
        supplementalFiles: summary.discovery.supplementalFiles.length,
        missing: summary.discovery.missing,
        contentHash: summary.discovery.contentHash
    }
}, null, 2));
