import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

import {
    atomicWriteJson,
    DEFAULT_MAX_JSONL_LINE_BYTES,
    hashJson,
    readJson,
    RIA_SCHEMA_VERSION,
    RiaError,
    RiaInputError
} from './common.mjs';

export const DEFAULT_SPARSE_INDEX_STRIDE = 128;

function cursorPayload(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function encodeJsonlCursor({ runId, sequence, offset, filterHash, encoding = 'identity' }) {
    return `ria1.${cursorPayload({
        runId,
        sequence,
        offset,
        filterHash,
        encoding
    })}`;
}

export function decodeJsonlCursor(cursor, { runId, filterHash, encoding = 'identity' } = {}) {
    if (typeof cursor !== 'string' || cursor.length > 2048 || !cursor.startsWith('ria1.')) {
        throw new RiaInputError('cursor is not a valid RIA JSONL cursor.', 'RIA_CURSOR_INVALID');
    }
    let value;
    try {
        value = JSON.parse(Buffer.from(cursor.slice(5), 'base64url').toString('utf8'));
    } catch {
        throw new RiaInputError('cursor is not valid base64url JSON.', 'RIA_CURSOR_INVALID');
    }
    if (!value || typeof value !== 'object'
        || value.runId !== runId
        || value.filterHash !== filterHash
        || value.encoding !== encoding
        || !Number.isInteger(value.sequence) || value.sequence < 0
        || !Number.isInteger(value.offset) || value.offset < 0) {
        throw new RiaInputError(
            'cursor does not match this run, filter, or encoding.',
            'RIA_CURSOR_MISMATCH'
        );
    }
    return value;
}

export function eventFilterHash(filters) {
    return hashJson({
        fromFrame: filters.fromFrame ?? null,
        toFrame: filters.toFrame ?? null,
        eventType: filters.eventType === null ? null : [...filters.eventType].sort(),
        actorId: filters.actorId ?? null,
        targetId: filters.targetId ?? null,
        rootCastId: filters.rootCastId ?? null,
        childCastId: filters.childCastId ?? null
    });
}

async function scanReadable(readable, {
    startOffset = 0,
    maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES,
    tolerateTrailingPartial = true,
    onRecord
} = {}) {
    let pending = Buffer.alloc(0);
    let lineStart = startOffset;
    let recordsDecoded = 0;
    let stopped = false;
    for await (const chunk of readable) {
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        while (true) {
            const newline = pending.indexOf(0x0a);
            if (newline === -1) break;
            const line = pending.subarray(0, newline);
            const endOffset = lineStart + newline + 1;
            pending = pending.subarray(newline + 1);
            if (line.length > maxLineBytes) {
                throw new RiaError(
                    `JSONL line at byte ${lineStart} exceeds ${maxLineBytes} bytes.`,
                    'RIA_CORRUPT_JSONL'
                );
            }
            let value;
            try {
                value = JSON.parse(line.toString('utf8'));
            } catch (error) {
                throw new RiaError(
                    `Invalid JSONL at byte ${lineStart}: ${error.message}`,
                    'RIA_CORRUPT_JSONL'
                );
            }
            recordsDecoded += 1;
            const keepReading = await onRecord({ value, startOffset: lineStart, endOffset });
            lineStart = endOffset;
            if (keepReading === false) {
                stopped = true;
                readable.destroy?.();
                break;
            }
        }
        if (stopped) break;
        if (pending.length > maxLineBytes) {
            throw new RiaError(
                `JSONL partial line at byte ${lineStart} exceeds ${maxLineBytes} bytes.`,
                'RIA_CORRUPT_JSONL'
            );
        }
    }
    if (!stopped && pending.length > 0 && !tolerateTrailingPartial) {
        throw new RiaError(
            `JSONL has an unterminated record at byte ${lineStart}.`,
            'RIA_CORRUPT_JSONL'
        );
    }
    return {
        recordsDecoded,
        startOffset,
        endOffset: lineStart,
        trailingBytes: pending.length,
        stopped
    };
}

export async function scanJsonlFile(filePath, options = {}) {
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                recordsDecoded: 0,
                startOffset: options.startOffset ?? 0,
                endOffset: options.startOffset ?? 0,
                trailingBytes: 0,
                stopped: false,
                fileBytes: 0
            };
        }
        throw error;
    }
    const startOffset = options.startOffset ?? 0;
    if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > stat.size) {
        throw new RiaInputError('JSONL start offset is outside the file.', 'RIA_CURSOR_INVALID');
    }
    if (startOffset === stat.size) {
        return {
            recordsDecoded: 0,
            startOffset,
            endOffset: startOffset,
            trailingBytes: 0,
            stopped: false,
            fileBytes: stat.size
        };
    }
    const readable = fsSync.createReadStream(filePath, { start: startOffset });
    const scanned = await scanReadable(readable, { ...options, startOffset });
    return { ...scanned, fileBytes: stat.size };
}

export async function scanGzipJsonlFile(filePath, options = {}) {
    const stat = await fs.stat(filePath);
    const readable = fsSync.createReadStream(filePath).pipe(createGunzip());
    const scanned = await scanReadable(readable, { ...options, startOffset: 0 });
    return { ...scanned, fileBytes: stat.size };
}

export async function readJsonlStreaming(filePath, options = {}) {
    const values = [];
    await scanJsonlFile(filePath, {
        ...options,
        onRecord: ({ value }) => {
            values.push(value);
            return true;
        }
    });
    return values;
}

export async function readGzipJsonlStreaming(filePath, options = {}) {
    const values = [];
    await scanGzipJsonlFile(filePath, {
        ...options,
        onRecord: ({ value }) => {
            values.push(value);
            return true;
        }
    });
    return values;
}

function validSparseIndex(index, { runId, stride }) {
    return index?.schemaVersion === RIA_SCHEMA_VERSION
        && index?.authority === 'derived-rebuildable-sparse-jsonl-index'
        && index?.runId === runId
        && index?.stride === stride
        && Number.isInteger(index?.sourceBytes)
        && Number.isInteger(index?.indexedThroughOffset)
        && Number.isInteger(index?.lastSequence)
        && Array.isArray(index?.entries);
}

export async function buildSparseJsonlIndex({
    filePath,
    indexPath,
    runId,
    stride = DEFAULT_SPARSE_INDEX_STRIDE,
    maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES,
    existing = null
} = {}) {
    if (!Number.isInteger(stride) || stride < 1) throw new TypeError('stride must be positive.');
    const entries = existing ? [...existing.entries] : [];
    let recordCount = existing?.recordCount ?? 0;
    let lastSequence = existing?.lastSequence ?? 0;
    const startOffset = existing?.indexedThroughOffset ?? 0;
    const scanned = await scanJsonlFile(filePath, {
        startOffset,
        maxLineBytes,
        tolerateTrailingPartial: true,
        onRecord: ({ value, startOffset: lineOffset }) => {
            const sequence = Number(value?.sequence);
            if (!Number.isInteger(sequence) || sequence <= lastSequence) {
                throw new RiaError(
                    `Sparse index found non-monotonic sequence ${String(value?.sequence)}.`,
                    'RIA_CORRUPT_JSONL'
                );
            }
            recordCount += 1;
            lastSequence = sequence;
            if (entries.length === 0 || (sequence - 1) % stride === 0) {
                entries.push({ sequence, offset: lineOffset });
            }
            return true;
        }
    });
    const index = {
        schemaVersion: RIA_SCHEMA_VERSION,
        authority: 'derived-rebuildable-sparse-jsonl-index',
        runId,
        sourceFile: path.basename(filePath),
        stride,
        sourceBytes: scanned.fileBytes,
        indexedThroughOffset: scanned.endOffset,
        trailingBytes: scanned.trailingBytes,
        recordCount,
        lastSequence,
        entries,
        generatedAt: new Date().toISOString()
    };
    await atomicWriteJson(indexPath, index);
    return index;
}

export async function ensureSparseJsonlIndex({
    filePath,
    indexPath,
    runId,
    stride = DEFAULT_SPARSE_INDEX_STRIDE,
    maxLineBytes = DEFAULT_MAX_JSONL_LINE_BYTES
} = {}) {
    const stat = await fs.stat(filePath);
    let index = null;
    try {
        index = await readJson(indexPath);
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    let rebuilt = false;
    let extended = false;
    if (!validSparseIndex(index, { runId, stride })
        || index.indexedThroughOffset > stat.size
        || index.sourceBytes > stat.size) {
        index = await buildSparseJsonlIndex({ filePath, indexPath, runId, stride, maxLineBytes });
        rebuilt = true;
    } else if (index.indexedThroughOffset < stat.size) {
        index = await buildSparseJsonlIndex({
            filePath,
            indexPath,
            runId,
            stride,
            maxLineBytes,
            existing: index
        });
        extended = true;
    }
    return { index, rebuilt, extended };
}

export function sparseSeek(index, afterSequence) {
    let selected = { sequence: 1, offset: 0 };
    const target = afterSequence + 1;
    for (const entry of index.entries) {
        if (entry.sequence > target) break;
        selected = entry;
    }
    return selected;
}
