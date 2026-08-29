import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RIA_SCHEMA_VERSION = 1;
export const RIA_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/;
export const DEFAULT_MAX_JSON_BYTES = 1_048_576;
export const DEFAULT_MAX_JSONL_LINE_BYTES = 4_194_304;

const SENSITIVE_KEY = /authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|private[-_]?key/i;
const ABSOLUTE_PATH_KEY = /(?:^|[_-])(?:path|directory|cwd|root)(?:$|[_-])/i;

export function assertRiaId(value, label = 'id') {
    if (typeof value !== 'string' || !RIA_ID_PATTERN.test(value)
        || value === '.' || value === '..' || value.includes('..')) {
        throw new RiaInputError(
            `${label} must be 1-96 characters using letters, numbers, dot, underscore or hyphen, without '..'.`,
            'RIA_INVALID_ID'
        );
    }
    return value;
}

export function newRiaId(prefix, now = new Date()) {
    assertRiaId(prefix, 'id prefix');
    const timestamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'z');
    return `${prefix}-${timestamp}-${randomBytes(4).toString('hex')}`;
}

export class RiaError extends Error {
    constructor(message, code = 'RIA_ERROR', statusCode = 500, details = null) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

export class RiaInputError extends RiaError {
    constructor(message, code = 'RIA_INVALID_INPUT', details = null) {
        super(message, code, 400, details);
    }
}

export class RiaNotFoundError extends RiaError {
    constructor(message, code = 'RIA_NOT_FOUND', details = null) {
        super(message, code, 404, details);
    }
}

export class RiaConflictError extends RiaError {
    constructor(message, code = 'RIA_CONFLICT', details = null) {
        super(message, code, 409, details);
    }
}

function normalizeCanonical(value, seen) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return String(value);
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.from(value).toString('base64');
    }
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) throw new TypeError('Cannot canonicalize a cyclic value.');
    seen.add(value);
    let normalized;
    if (Array.isArray(value)) {
        normalized = value.map(entry => normalizeCanonical(entry, seen));
    } else if (value instanceof Map) {
        normalized = Object.fromEntries([...value.entries()]
            .map(([key, entry]) => [String(key), normalizeCanonical(entry, seen)])
            .sort(([left], [right]) => left.localeCompare(right)));
    } else if (value instanceof Set) {
        normalized = [...value].map(entry => normalizeCanonical(entry, seen));
    } else {
        normalized = Object.fromEntries(Object.keys(value).sort().map(key => [
            key,
            normalizeCanonical(value[key], seen)
        ]));
    }
    seen.delete(value);
    return normalized;
}

export function canonicalize(value) {
    return normalizeCanonical(value, new Set());
}

export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    return createHash('sha256').update(bytes).digest('hex');
}

export function hashJson(value) {
    return sha256(canonicalJson(value));
}

export async function hashFile(filePath) {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

export function sanitizeForArchive(value, {
    projectRoot = null,
    maxDepth = 32,
    maxArrayLength = 20_000,
    redactPaths = true
} = {}) {
    const root = projectRoot ? path.resolve(projectRoot) : null;
    const seen = new WeakSet();
    const visit = (entry, key, depth) => {
        if (SENSITIVE_KEY.test(String(key ?? ''))) return '[REDACTED]';
        if (depth > maxDepth) return '[TRUNCATED:MAX_DEPTH]';
        if (entry === null || ['boolean', 'number', 'string'].includes(typeof entry)) {
            if (typeof entry === 'number' && !Number.isFinite(entry)) return String(entry);
            if (redactPaths && typeof entry === 'string' && path.isAbsolute(entry)
                && ABSOLUTE_PATH_KEY.test(String(key ?? ''))) {
                if (root && (entry === root || entry.startsWith(`${root}${path.sep}`))) {
                    return `<project>/${path.relative(root, entry) || '.'}`;
                }
                return '[REDACTED:ABSOLUTE_PATH]';
            }
            return entry;
        }
        if (entry === undefined) return null;
        if (typeof entry === 'bigint') return entry.toString();
        if (typeof entry !== 'object') return String(entry);
        if (seen.has(entry)) return '[REDACTED:CYCLE]';
        seen.add(entry);
        let result;
        if (Array.isArray(entry)) {
            result = entry.slice(0, maxArrayLength).map((item, index) => visit(
                item,
                String(index),
                depth + 1
            ));
            if (entry.length > maxArrayLength) {
                result.push(`[TRUNCATED:${entry.length - maxArrayLength}_ITEMS]`);
            }
        } else if (entry instanceof Date) {
            result = entry.toISOString();
        } else if (entry instanceof Map) {
            result = Object.fromEntries([...entry.entries()].map(([mapKey, item]) => [
                String(mapKey),
                visit(item, String(mapKey), depth + 1)
            ]));
        } else if (entry instanceof Set) {
            result = [...entry].map((item, index) => visit(item, String(index), depth + 1));
        } else {
            result = Object.fromEntries(Object.entries(entry).map(([childKey, item]) => [
                childKey,
                visit(item, childKey, depth + 1)
            ]));
        }
        seen.delete(entry);
        return result;
    };
    return visit(value, '', 0);
}

export function assertJsonSize(value, maxBytes = DEFAULT_MAX_JSON_BYTES, label = 'JSON value') {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxBytes) {
        throw new RiaInputError(
            `${label} is ${bytes} bytes; maximum is ${maxBytes}.`,
            'RIA_INPUT_TOO_LARGE',
            { bytes, maxBytes }
        );
    }
    return bytes;
}

export function resolveInside(rootPath, ...segments) {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(root, ...segments);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        throw new RiaInputError('Resolved path escapes the archive root.', 'RIA_PATH_TRAVERSAL');
    }
    return candidate;
}

export async function ensureExistingPathInside(rootPath, candidatePath) {
    const [rootReal, candidateReal] = await Promise.all([
        fsp.realpath(rootPath),
        fsp.realpath(candidatePath)
    ]);
    if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new RiaInputError('Archive symlink escapes the archive root.', 'RIA_SYMLINK_ESCAPE');
    }
    return candidateReal;
}

export async function atomicWriteFile(filePath, contents, { mode = 0o600 } = {}) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    let handle = null;
    try {
        handle = await fsp.open(temporary, 'wx', mode);
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        handle = null;
        await fsp.rename(temporary, filePath);
        const directory = await fsp.open(path.dirname(filePath), 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

export async function atomicWriteJson(filePath, value, options = {}) {
    const spacing = options.pretty === false ? 0 : 2;
    await atomicWriteFile(filePath, `${JSON.stringify(value, null, spacing)}\n`, options);
}

export async function readJson(filePath) {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

export async function appendJsonLine(filePath, value, {
    maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES,
    sync = true
} = {}) {
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > maxLineBytes) {
        throw new RiaInputError(
            `JSONL record is ${bytes} bytes; maximum is ${maxLineBytes}.`,
            'RIA_EVENT_TOO_LARGE',
            { bytes, maxLineBytes }
        );
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fsp.open(filePath, 'a', 0o600);
    try {
        await handle.write(line);
        if (sync) await handle.sync();
    } finally {
        await handle.close();
    }
    return bytes;
}

export async function readJsonLines(filePath, {
    tolerateTrailingPartial = false,
    maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES
} = {}) {
    let text;
    try {
        text = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const endedWithNewline = text.length === 0 || text.endsWith('\n');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const result = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (Buffer.byteLength(line) > maxLineBytes) {
            throw new RiaError(
                `JSONL line ${index + 1} exceeds ${maxLineBytes} bytes.`,
                'RIA_CORRUPT_JSONL'
            );
        }
        try {
            result.push(JSON.parse(line));
        } catch (error) {
            if (tolerateTrailingPartial && index === lines.length - 1 && !endedWithNewline) break;
            throw new RiaError(
                `Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`,
                'RIA_CORRUPT_JSONL'
            );
        }
    }
    return result;
}

export async function recoverJsonLines(filePath, options = {}) {
    let buffer;
    try {
        buffer = await fsp.readFile(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return { records: 0, discardedBytes: 0, changed: false };
        throw error;
    }
    let offset = 0;
    let validEnd = 0;
    let records = 0;
    while (offset < buffer.length) {
        const newline = buffer.indexOf(0x0a, offset);
        if (newline === -1) break;
        const slice = buffer.subarray(offset, newline);
        if (slice.length > (options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES)) break;
        try {
            JSON.parse(slice.toString('utf8'));
        } catch {
            break;
        }
        records += 1;
        validEnd = newline + 1;
        offset = newline + 1;
    }
    const discardedBytes = buffer.length - validEnd;
    if (discardedBytes > 0) {
        await atomicWriteFile(filePath, buffer.subarray(0, validEnd));
    }
    return { records, discardedBytes, changed: discardedBytes > 0 };
}

export function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
    throw new RiaInputError(`Invalid boolean value: ${String(value)}`);
}
