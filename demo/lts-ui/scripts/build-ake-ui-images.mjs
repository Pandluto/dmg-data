import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getDemoCatalog } from '../../demo-service.mjs';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(uiRoot, '../..');
const outputRoot = path.join(uiRoot, 'public/assets/ake-icons');
const manifestPath = path.join(uiRoot, 'scripts/ake-image-manifest.json');
const runtimeManifestPath = path.join(uiRoot, 'src/platform/resources/akeImageManifest.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const catalog = getDemoCatalog({ projectRoot });
const urls = [...new Set([
    ...catalog.weapons.map(item => item.iconUrl),
    ...catalog.equipment.map(item => item.iconUrl),
    ...catalog.characters.flatMap(item => [item.iconUrl, ...item.skills.map(skill => skill.iconUrl)])
].filter(Boolean))].sort();
const previous = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({ images: {} }));
const images = {};
const unavailable = [];
await fs.mkdir(outputRoot, { recursive: true });
let next = 0;
let generated = 0;
async function withThumbnail(entry, data, stem) {
    if (Math.max(entry.width, entry.height) <= 128) return entry;
    if (entry.thumbnail) {
        const saved = await fs.readFile(path.join(uiRoot, 'public', entry.thumbnail.path)).catch(() => null);
        if (saved && hash(saved) === entry.thumbnail.sha256) return entry;
    }
    const thumbnail = await sharp(data).resize({ width: 128, height: 128, fit: 'inside', withoutEnlargement: true })
        .webp({ lossless: true, effort: 6 }).toBuffer({ resolveWithObject: true });
    const digest = hash(thumbnail.data);
    const filename = `${stem}-128.${digest.slice(0, 12)}.webp`;
    await fs.writeFile(path.join(outputRoot, filename), thumbnail.data);
    return { ...entry, thumbnail: { path: `assets/ake-icons/${filename}`, width: thumbnail.info.width,
        height: thumbnail.info.height, bytes: thumbnail.data.length, sha256: digest } };
}
async function build(url) {
    const source = new URL(url);
    if (source.origin !== 'https://data.akedata.wiki' || !source.pathname.startsWith('/public/images/')) {
        throw new Error(`Unexpected image source: ${url}`);
    }
    const stem = path.basename(source.pathname, '.png');
    const existing = previous.images[url];
    if (!process.argv.includes('--refresh') && existing && previous.dataVersion === catalog.source.version) {
        const bytes = await fs.readFile(path.join(uiRoot, 'public', existing.path)).catch(() => null);
        if (bytes && hash(bytes) === existing.sha256) { images[url] = await withThumbnail(existing, bytes, stem); return; }
    }
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
        if (response?.ok || response?.status === 404) break;
    }
    if (response?.status === 404) { unavailable.push(url); console.warn(`Source image absent: ${url}`); return; }
    if (!response?.ok) throw new Error(`Image download failed (${response?.status}): ${url}`);
    const original = Buffer.from(await response.arrayBuffer());
    // Preserve visible source pixels and alpha. The upstream PNGs are often
    // uncompressed RGBA; lossless WebP removes that transfer cost without blur.
    const { data, info } = await sharp(original).webp({ lossless: true, effort: 6 }).toBuffer({ resolveWithObject: true });
    const digest = hash(data);
    const filename = `${stem}.${digest.slice(0, 12)}.webp`;
    await fs.writeFile(path.join(outputRoot, filename), data);
    images[url] = await withThumbnail({ path: `assets/ake-icons/${filename}`, width: info.width, height: info.height,
        bytes: data.length, sha256: digest, sourceBytes: original.length, sourceSha256: hash(original) }, data, stem);
    generated += 1;
    if (generated % 50 === 0) console.log(`Prepared ${generated} / ${urls.length} images`);
}
await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < urls.length) await build(urls[next++]);
}));
const ordered = Object.fromEntries(urls.filter(url => images[url]).map(url => [url, images[url]]));
const manifest = { schemaVersion: 1, dataVersion: catalog.source.version,
    encoding: `sharp-${sharp.versions.sharp}/webp-${sharp.versions.webp}/lossless-effort-6`, images: ordered,
    unavailable: unavailable.sort() };
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
// Keep download checksums/source metadata out of the browser's JavaScript bundle.
const variant = ({ path, width, height }) => ({ path, width, height });
const runtimeImages = Object.fromEntries(Object.entries(ordered).map(([url, entry]) => [url,
    { ...variant(entry), ...(entry.thumbnail ? { thumbnail: variant(entry.thumbnail) } : {}) }]));
await fs.writeFile(runtimeManifestPath, `${JSON.stringify({ images: runtimeImages, unavailable: manifest.unavailable }, null, 2)}\n`);
const entries = Object.values(images);
console.log(JSON.stringify({ count: entries.length, generated,
    sourceBytes: entries.reduce((sum, item) => sum + item.sourceBytes, 0),
    optimizedBytes: entries.reduce((sum, item) => sum + item.bytes, 0),
    thumbnailBytes: entries.reduce((sum, item) => sum + (item.thumbnail?.bytes ?? 0), 0),
    maximumBytes: Math.max(...entries.map(item => item.bytes)) }, null, 2));
