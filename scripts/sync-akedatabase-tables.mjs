import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'reference', 'public-data', 'akedata', 'TableCfg');
const localManifestPath = path.join(projectRoot, 'reference', 'public-data', 'akedata', 'manifest.json');
const corpusManifestPath = path.join(
    projectRoot,
    'reference', 'public-data', 'akedata', 'table-corpus.manifest.json'
);
const baseUrl = 'https://data.akedata.wiki';
const manifestUrl = `${baseUrl}/manifest.json`;
const defaultTables = [
    'CharacterTable',
    'CharGrowthTable',
    'CharacterPotentialTable',
    'PotentialTalentEffectTable',
    'CharProfessionTable',
    'SkillPatchTable',
    'WeaponBasicTable',
    'WeaponBreakThroughTemplateTable',
    'WeaponUpgradeTemplateTable',
    'WeaponUpgradeTemplateSumTable',
    'WeaponTalentTemplateTable',
    'ItemTable',
    'EquipSuitTable',
    'EquipTable',
    'UseItemTable',
    'CcTagTable',
    'EnemyTable',
    'EnemyAttributeTemplateTable',
    'EnemyTemplateDisplayInfoTable',
    'DisplayEnemyTypeTable',
    'I18nTextTable_CN'
];

function argumentValue(name) {
    const prefix = `--${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? '';
}

function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}

function hashRecords(records) {
    return sha256(Buffer.from([...records]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        .map(record => `${record.path}\0${record.sha256}\n`)
        .join('')));
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

async function writeAtomic(target, data) {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.download`;
    await rm(temporary, { force: true });
    await writeFile(temporary, data);
    await rename(temporary, target);
}

const remoteManifestBytes = await fetchBytes(`${manifestUrl}?_=${Date.now()}`);
const remoteManifest = JSON.parse(remoteManifestBytes.toString('utf8'));
const requestedVersion = argumentValue('version');
const versionId = requestedVersion || remoteManifest.latest;
const selectedVersion = remoteManifest.versions?.find(version => version.id === versionId);
if (!selectedVersion) throw new Error(`AKEDatabase manifest does not contain version ${versionId}`);

const requestedTables = process.argv
    .filter(argument => argument.startsWith('--table='))
    .map(argument => argument.slice('--table='.length));
const tables = [...new Set(requestedTables.length > 0 ? requestedTables : defaultTables)]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
const tableBaseUrl = `${baseUrl}/${selectedVersion.tableCfgPath}`;
const previousManifest = await readFile(corpusManifestPath, 'utf8')
    .then(JSON.parse)
    .catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));

const files = {};
for (const [index, table] of tables.entries()) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
    const url = `${tableBaseUrl}/${table}.json`;
    const data = await fetchBytes(url);
    JSON.parse(data.toString('utf8'));
    const target = path.join(outputRoot, `${table}.json`);
    const digest = sha256(data);
    const previous = previousManifest?.files?.[`${table}.json`];
    const existing = await readFile(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const unchanged = previous?.sha256 === digest && existing && sha256(existing) === digest;
    if (!unchanged) await writeAtomic(target, data);
    files[`${table}.json`] = { bytes: data.length, sha256: digest, source: url };
    console.log(`tables ${index + 1}/${tables.length} ${table} ${unchanged ? 'verified' : 'downloaded'}`);
}

const corpusManifest = {
    schemaVersion: 1,
    sourceManifest: manifestUrl,
    sourceVersion: selectedVersion,
    sharedRevision: remoteManifest.sharedRevision,
    sourceUpdatedAt: remoteManifest.updatedAt,
    tableBaseUrl,
    contentHash: hashRecords(Object.entries(files).map(([fileName, metadata]) => ({
        path: fileName,
        sha256: metadata.sha256
    }))),
    files
};
await writeAtomic(localManifestPath, Buffer.from(`${JSON.stringify(remoteManifest, null, 2)}\n`));
await writeAtomic(corpusManifestPath, Buffer.from(`${JSON.stringify(corpusManifest, null, 2)}\n`));
console.log(JSON.stringify({
    manifest: path.relative(projectRoot, corpusManifestPath).replaceAll('\\', '/'),
    version: selectedVersion.id,
    files: Object.keys(files).length,
    bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0)
}, null, 2));
