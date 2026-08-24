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
const manifestPath = path.join(
    projectRoot,
    'reference', 'public-data', 'akedata', 'runtime-corpus.manifest.json'
);
const baseUrl = 'https://data.akedata.wiki/public/Json';
const concurrency = 12;
const requestedScopes = process.argv.slice(2).filter(argument => argument.startsWith('--scope='))
    .map(argument => argument.slice('--scope='.length));
const scopes = requestedScopes.length > 0 ? requestedScopes : [
    'BuffData/',
    'SkillData/chr_',
    'SkillData/passive_equip',
    'SkillData/passive_rpg_equip',
    'SkillData/rpg_equip'
];

function md5(buffer) {
    return createHash('md5').update(buffer).digest('hex');
}

function safeTarget(relativePath) {
    const target = path.resolve(jsonRoot, relativePath);
    const prefix = `${jsonRoot}${path.sep}`;
    if (!target.startsWith(prefix)) throw new Error(`Refusing corpus path outside Json root: ${relativePath}`);
    return target;
}

async function existingMatches(target, metadata) {
    try {
        const info = await stat(target);
        if (info.size !== Number(metadata.size)) return false;
        const data = await readFile(target);
        return md5(data) === metadata.md5;
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
            await writeFile(temporary, data);
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

const index = JSON.parse(await readFile(indexPath, 'utf8'));
const entries = Object.entries(index.datasets?.json?.files ?? {})
    .filter(([relativePath]) => scopes.some(scope => relativePath.startsWith(scope)))
    .sort(([left], [right]) => left.localeCompare(right));
if (entries.length === 0) throw new Error(`No corpus files matched scopes: ${scopes.join(', ')}`);

const summary = {
    schemaVersion: 1,
    indexRevision: index.revision,
    indexUpdatedAt: index.updatedAt,
    sourceIndex: 'reference/public-data/akedata/asset-sync-index.json',
    baseUrl,
    scopes,
    files: entries.length,
    expectedBytes: entries.reduce((sum, [, metadata]) => sum + Number(metadata.size), 0),
    verified: 0,
    downloaded: 0,
    processedBytes: 0
};
let cursor = 0;
let completed = 0;
let lastReported = 0;

async function worker() {
    while (cursor < entries.length) {
        const index = cursor++;
        const [relativePath, metadata] = entries[index];
        const result = await download(relativePath, metadata);
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
await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
    manifest: path.relative(projectRoot, manifestPath).replaceAll('\\', '/'),
    ...summary
}, null, 2));
