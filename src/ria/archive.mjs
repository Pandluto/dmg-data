import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import {
    appendJsonLine,
    assertJsonSize,
    assertRiaId,
    atomicWriteFile,
    atomicWriteJson,
    ensureExistingPathInside,
    hashFile,
    hashJson,
    newRiaId,
    readJson,
    recoverJsonLines,
    resolveInside,
    RIA_SCHEMA_VERSION,
    RiaConflictError,
    RiaError,
    RiaInputError,
    RiaNotFoundError,
    sanitizeForArchive,
    sha256
} from './common.mjs';
import {
    decodeJsonlCursor,
    encodeJsonlCursor,
    ensureSparseJsonlIndex,
    eventFilterHash,
    readGzipJsonlStreaming,
    readJsonlStreaming,
    scanGzipJsonlFile,
    scanJsonlFile,
    sparseSeek
} from './jsonl-index.mjs';
import { buildStateSnapshots, firstDivergence, normalizeForDiff } from './normalize.mjs';
import {
    validateCase,
    validateCaseCloseRequest,
    validateCaseCreateRequest,
    validateEvent,
    validateRunManifest,
    validateSession,
    validateSessionCreateRequest,
    validateSessionEntry,
    validateSessionEntryAppendRequest,
    validateSchema,
    validateSnapshot
} from './schemas.mjs';

const JSONL_ARTIFACTS = Object.freeze({
    commands: 'commands.jsonl',
    events: 'events.jsonl',
    snapshots: 'state-snapshots.jsonl',
    uiActions: 'ui-actions.jsonl'
});

const SINGLE_ARTIFACTS = Object.freeze({
    manifest: 'manifest.json',
    fixture: 'fixture.json',
    assertions: 'assertions.json',
    result: 'result.json',
    findings: 'findings.md'
});

const SESSION_ENTRIES_FILE = 'entries.jsonl';
const EVENT_INDEX_STRIDE = 128;

export const RUN_ARTIFACTS = Object.freeze({ ...JSONL_ARTIFACTS, ...SINGLE_ARTIFACTS });

function safeGit(projectRoot, args, fallback = null, {
    maxBuffer = 32 * 1024 * 1024,
    trim = true
} = {}) {
    try {
        const output = execFileSync('git', args, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer
        });
        return trim ? output.trim() : output.replace(/\n$/, '');
    } catch {
        return fallback;
    }
}

async function regularFiles(root, predicate) {
    const files = [];
    const visit = async directory => {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(absolute);
            else if (entry.isFile() && predicate(absolute)) files.push(absolute);
        }
    };
    await visit(root);
    return files;
}

async function existingRegularFiles(files) {
    const existing = [];
    for (const file of files) {
        try {
            if ((await fs.stat(file)).isFile()) existing.push(file);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return existing;
}

async function hashFiles(projectRoot, files) {
    const rows = [];
    for (const file of [...new Set(await existingRegularFiles(files))]
        .sort((left, right) => left.localeCompare(right))) {
        rows.push([path.relative(projectRoot, file), await hashFile(file)]);
    }
    return sha256(rows.map(([name, digest]) => `${name}\0${digest}\n`).join(''));
}

async function versionFileGroups(projectRoot) {
    const ruleFiles = [
        ...(await regularFiles(path.join(projectRoot, 'src', 'core'), file => file.endsWith('.mjs'))),
        ...(await regularFiles(path.join(projectRoot, 'spec'), file => file.endsWith('.json'))),
        path.join(projectRoot, 'package.json')
    ];
    const executableFiles = [
        ...(await regularFiles(path.join(projectRoot, 'src'), file => file.endsWith('.mjs'))),
        path.join(projectRoot, 'demo', 'demo-service.mjs'),
        path.join(projectRoot, 'package.json'),
        path.join(projectRoot, 'package-lock.json'),
        path.join(projectRoot, 'sources.lock.json')
    ];
    const recorderFiles = [
        ...(await regularFiles(path.join(projectRoot, 'src', 'ria'), file => file.endsWith('.mjs'))),
        ...(await regularFiles(path.join(projectRoot, 'schemas', 'ria'), file => file.endsWith('.json'))),
        path.join(projectRoot, 'openapi', 'ria.openapi.json'),
        path.join(projectRoot, 'package.json'),
        path.join(projectRoot, 'package-lock.json')
    ];
    const dataFiles = [
        path.join(projectRoot, 'sources.lock.json')
    ];
    return {
        ruleFiles: await existingRegularFiles(ruleFiles),
        executableFiles: await existingRegularFiles(executableFiles),
        recorderFiles: await existingRegularFiles(recorderFiles),
        dataFiles: await existingRegularFiles(dataFiles)
    };
}

export async function captureVersions(projectRoot, { fileGroups = null } = {}) {
    const groups = fileGroups ?? await versionFileGroups(projectRoot);
    let engineVersion = 'unknown';
    try {
        engineVersion = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
    } catch {
        // The hashes still identify the exact files if package metadata is unavailable.
    }
    return {
        archiveSchemaVersion: RIA_SCHEMA_VERSION,
        engineVersion,
        rulesHash: await hashFiles(projectRoot, groups.ruleFiles),
        dataHash: groups.dataFiles.length > 0
            ? await hashFiles(projectRoot, groups.dataFiles)
            : sha256('no-sources-lock'),
        executableHash: await hashFiles(projectRoot, groups.executableFiles),
        recorderHash: await hashFiles(projectRoot, groups.recorderFiles)
    };
}

export async function captureEnvironment(projectRoot, { executionFiles = null } = {}) {
    const porcelain = safeGit(
        projectRoot,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        '',
        { trim: false }
    ) ?? '';
    const rows = porcelain.length === 0 ? [] : porcelain.split('\n');
    const diff = safeGit(projectRoot, ['diff', 'HEAD', '--binary', '--no-ext-diff'], '', {
        maxBuffer: 128 * 1024 * 1024,
        trim: false
    }) ?? '';
    const executionRelative = new Set((executionFiles ?? [])
        .map(file => path.relative(projectRoot, file)));
    const untrackedExecutionFiles = [];
    for (const row of rows) {
        if (!row.startsWith('?? ')) continue;
        const relative = row.slice(3);
        if (!executionRelative.has(relative)) continue;
        const absolute = path.join(projectRoot, relative);
        try {
            untrackedExecutionFiles.push({ path: relative, sha256: await hashFile(absolute) });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    untrackedExecutionFiles.sort((left, right) => left.path.localeCompare(right.path));
    return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        git: {
            commit: safeGit(projectRoot, ['rev-parse', 'HEAD'], 'unknown'),
            branch: safeGit(projectRoot, ['branch', '--show-current'], '') || '(detached)',
            dirty: rows.length > 0,
            changedPathCount: rows.length,
            changedPaths: rows.slice(0, 500).map(row => ({
                status: row.slice(0, 2),
                path: row.slice(3)
            })),
            statusHash: sha256(porcelain),
            trackedDiffHash: sha256(diff),
            truncatedChangedPaths: rows.length > 500,
            untrackedExecutionFiles,
            untrackedExecutionHash: hashJson(untrackedExecutionFiles)
        }
    };
}

function errorRecord(error) {
    if (!error) return null;
    return {
        name: String(error.name ?? 'Error'),
        code: error.code ?? null,
        message: String(error.message ?? error).slice(0, 4000),
        stackHash: error.stack ? sha256(error.stack) : null
    };
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readMaybeCompressedJsonLines(runPath, baseName) {
    const plain = path.join(runPath, baseName);
    if (await pathExists(plain)) return readJsonlStreaming(plain);
    const compressed = `${plain}.gz`;
    if (!await pathExists(compressed)) return [];
    return readGzipJsonlStreaming(compressed);
}

async function compressJsonLines(runPath) {
    for (const baseName of Object.values(JSONL_ARTIFACTS)) {
        const plain = path.join(runPath, baseName);
        if (!await pathExists(plain)) continue;
        const compressed = `${plain}.gz`;
        const temporary = `${compressed}.${newRiaId('tmp')}`;
        try {
            await pipeline(
                createReadStream(plain),
                createGzip({ level: 9 }),
                createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
            );
            const temporaryHandle = await fs.open(temporary, 'r+');
            try {
                await temporaryHandle.sync();
            } finally {
                await temporaryHandle.close();
            }
            await fs.rename(temporary, compressed);
            const directory = await fs.open(runPath, 'r');
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
            await fs.rm(plain);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
    }
}

async function artifactMetadata(runPath) {
    const files = {};
    const entries = await fs.readdir(runPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || entry.name === 'manifest.json' || entry.name === '.active') continue;
        const absolute = path.join(runPath, entry.name);
        const stat = await fs.stat(absolute);
        files[entry.name] = {
            path: entry.name,
            bytes: stat.size,
            sha256: await hashFile(absolute),
            encoding: entry.name.endsWith('.gz') ? 'gzip' : 'identity'
        };
    }
    return files;
}

async function syncRunStreams(runPath) {
    for (const file of Object.values(JSONL_ARTIFACTS)) {
        const absolute = path.join(runPath, file);
        if (!await pathExists(absolute)) continue;
        const handle = await fs.open(absolute, 'r+');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
}

function contentHashFor(files) {
    return hashJson(Object.fromEntries(Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))));
}

function validateArchivedSnapshot(snapshot, previousSequence, manifest) {
    try {
        validateSnapshot(snapshot, previousSequence);
        return null;
    } catch (error) {
        // The first local RIA prototype accidentally persisted its absolute
        // runPath in snapshots while still declaring schemaVersion 1. Those
        // Runs are already sealed and content-addressed, so verification must
        // not rewrite them. Compatibility is deliberately limited to sealed
        // manifests predating recorderHash and to exactly that one discarded
        // field; all current writer/API validation remains the strict exported
        // Snapshot schema.
        const allowedKeys = new Set([
            'schemaVersion', 'caseId', 'sessionId', 'runId', 'sequence',
            'frame', 'state', 'evidence'
        ]);
        const extraKeys = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
            ? Object.keys(snapshot).filter(key => !allowedKeys.has(key))
            : [];
        const legacyRunPathOnly = manifest.sealed
            && manifest.versions?.recorderHash === undefined
            && extraKeys.length === 1
            && extraKeys[0] === 'runPath'
            && typeof snapshot.runPath === 'string';
        if (!legacyRunPathOnly) throw error;
        const { runPath: _discardedLegacyPath, ...portableSnapshot } = snapshot;
        validateSnapshot(portableSnapshot, previousSequence);
        return {
            code: 'RIA_LEGACY_SNAPSHOT_RUN_PATH',
            message: 'Verified a sealed pre-recorderHash snapshot after ignoring its legacy runPath field.'
        };
    }
}

async function withExclusiveFileLock(lockPath, operation) {
    let handle;
    try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw new RiaConflictError('Session journal is busy.', 'RIA_SESSION_BUSY');
        }
        throw error;
    }
    try {
        return await operation();
    } finally {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true });
    }
}

function jsonLineBytes(value) {
    return Buffer.byteLength(`${JSON.stringify(value)}\n`);
}

export class RiaRunWriter {
    constructor(archive, reference, manifest) {
        this.archive = archive;
        this.reference = reference;
        this.runPath = reference.runPath;
        this.currentManifest = manifest;
        this.writeChain = Promise.resolve();
        this.pendingOperations = 0;
        this.failures = [];
        this.droppedFacts = 0;
        this.closed = false;
        this.acceptingRecords = true;
        this.capacityExceeded = false;
    }

    #enqueue(operation) {
        if (this.closed) {
            return Promise.reject(new RiaConflictError(
                `Run ${this.reference.runId} is sealed and immutable.`,
                'RIA_RUN_SEALED'
            ));
        }
        this.pendingOperations += 1;
        const pending = this.writeChain.then(operation);
        this.writeChain = pending.catch(error => {
            this.failures.push(errorRecord(error));
        }).finally(() => {
            this.pendingOperations -= 1;
        });
        return pending;
    }

    recordFailure(error) {
        const record = errorRecord(error);
        if (!this.failures.some(existing => existing?.code === record?.code
            && existing?.message === record?.message)) this.failures.push(record);
    }

    #reserveRecord(bytes) {
        if (!this.acceptingRecords || this.capacityExceeded) {
            throw new RiaError(
                `Run ${this.reference.runId} no longer accepts records after reaching its byte limit.`,
                'RIA_RUN_TOO_LARGE'
            );
        }
        const projected = this.currentManifest.recording.bytesWritten + bytes;
        if (projected > this.archive.maxRunBytes) {
            this.capacityExceeded = true;
            this.acceptingRecords = false;
            throw new RiaError(
                `Run would exceed ${this.archive.maxRunBytes} bytes; record was not written.`,
                'RIA_RUN_TOO_LARGE'
            );
        }
    }

    traceSink({ maxPending = 50_000, normalize }) {
        if (typeof normalize !== 'function') throw new TypeError('trace sink normalize must be a function.');
        return packet => {
            if (this.closed || !this.acceptingRecords) return false;
            if (this.pendingOperations >= maxPending) {
                this.droppedFacts += 1;
                if (this.droppedFacts === 1) {
                    this.recordFailure(new RiaError(
                        `Trace queue exceeded ${maxPending} pending writes.`,
                        'RIA_TRACE_BACKPRESSURE'
                    ));
                }
                return false;
            }
            let events;
            try {
                events = normalize(packet);
            } catch (error) {
                this.recordFailure(error);
                return false;
            }
            for (const event of events) this.appendEvent(event).catch(() => {});
            return true;
        };
    }

    appendCommand(command) {
        return this.#append('commands', command);
    }

    appendEvent(event) {
        return this.#enqueue(async () => {
            const expected = this.currentManifest.counts.events + 1;
            validateEvent(event, expected - 1);
            if (event.sequence !== expected) {
                throw new RiaConflictError(
                    `Event sequence ${event.sequence} does not follow ${expected - 1}.`,
                    'RIA_SEQUENCE_GAP'
                );
            }
            const reservedBytes = jsonLineBytes(event);
            this.#reserveRecord(reservedBytes);
            const startOffset = this.currentManifest.recording.streamBytes.events;
            const bytes = await appendJsonLine(
                path.join(this.runPath, JSONL_ARTIFACTS.events),
                event,
                {
                    maxLineBytes: this.archive.maxJsonlLineBytes,
                    sync: expected % this.archive.syncEveryRecords === 0
                }
            );
            this.currentManifest.counts.events += 1;
            this.currentManifest.recording.bytesWritten += bytes;
            this.currentManifest.recording.streamBytes.events += bytes;
            this.archive.emit({
                type: 'event',
                ...this.reference,
                event,
                startOffset,
                endOffset: startOffset + bytes
            });
        });
    }

    appendSnapshot(snapshot) {
        return this.#enqueue(async () => {
            const expected = this.currentManifest.counts.snapshots + 1;
            validateSnapshot(snapshot, expected - 1);
            if (snapshot.sequence !== expected) {
                throw new RiaConflictError(
                    `Snapshot sequence ${snapshot.sequence} does not follow ${expected - 1}.`,
                    'RIA_SEQUENCE_GAP'
                );
            }
            this.#reserveRecord(jsonLineBytes(snapshot));
            const bytes = await appendJsonLine(
                path.join(this.runPath, JSONL_ARTIFACTS.snapshots),
                snapshot,
                {
                    maxLineBytes: this.archive.maxJsonlLineBytes,
                    sync: expected % this.archive.syncEveryRecords === 0
                }
            );
            this.currentManifest.counts.snapshots += 1;
            this.currentManifest.recording.bytesWritten += bytes;
            this.currentManifest.recording.streamBytes.snapshots += bytes;
        });
    }

    appendUiAction(action) {
        return this.#append('uiActions', action);
    }

    #append(kind, value) {
        return this.#enqueue(async () => {
            const sanitized = sanitizeForArchive(value, { projectRoot: this.archive.projectRoot });
            const record = {
                ...sanitized,
                schemaVersion: RIA_SCHEMA_VERSION,
                caseId: this.reference.caseId,
                sessionId: this.reference.sessionId,
                runId: this.reference.runId,
                sequence: this.currentManifest.counts[kind] + 1
            };
            this.#reserveRecord(jsonLineBytes(record));
            const bytes = await appendJsonLine(
                path.join(this.runPath, JSONL_ARTIFACTS[kind]),
                record,
                {
                    maxLineBytes: this.archive.maxJsonlLineBytes,
                    sync: record.sequence % this.archive.syncEveryRecords === 0
                }
            );
            this.currentManifest.counts[kind] += 1;
            this.currentManifest.recording.bytesWritten += bytes;
            this.currentManifest.recording.streamBytes[kind] += bytes;
        });
    }

    async drain() {
        await this.writeChain;
        return {
            failures: structuredClone(this.failures),
            droppedFacts: this.droppedFacts,
            pendingOperations: this.pendingOperations
        };
    }

    async seal({
        status = 'completed',
        result = {},
        assertions = { passed: true, checks: [] },
        findings = '',
        error = null
    } = {}) {
        if (!['completed', 'interrupted', 'partial'].includes(status)) {
            throw new RiaInputError(`Invalid final run status: ${status}`);
        }
        if (this.closed) {
            throw new RiaConflictError(
                `Run ${this.reference.runId} is already sealed.`,
                'RIA_RUN_SEALED'
            );
        }
        await this.drain();
        await syncRunStreams(this.runPath);
        const events = await readMaybeCompressedJsonLines(this.runPath, JSONL_ARTIFACTS.events);
        if (this.currentManifest.counts.snapshots === 0 && events.length > 0
            && !this.capacityExceeded) {
            for (const snapshot of buildStateSnapshots(events, {
                caseId: this.reference.caseId,
                sessionId: this.reference.sessionId,
                runId: this.reference.runId
            })) {
                await this.appendSnapshot(snapshot);
            }
            await this.drain();
            await syncRunStreams(this.runPath);
        }
        const sanitizedResult = sanitizeForArchive(result, { projectRoot: this.archive.projectRoot });
        const sanitizedAssertions = sanitizeForArchive(assertions, {
            projectRoot: this.archive.projectRoot
        });
        assertJsonSize(sanitizedResult, this.archive.maxResultBytes, 'run result');
        assertJsonSize(sanitizedAssertions, this.archive.maxResultBytes, 'run assertions');
        await atomicWriteJson(path.join(this.runPath, SINGLE_ARTIFACTS.result), sanitizedResult);
        await atomicWriteJson(
            path.join(this.runPath, SINGLE_ARTIFACTS.assertions),
            sanitizedAssertions
        );
        await atomicWriteFile(
            path.join(this.runPath, SINGLE_ARTIFACTS.findings),
            String(findings ?? '').slice(0, 1_000_000)
        );
        if (this.currentManifest.config.compression === 'gzip') {
            await compressJsonLines(this.runPath);
        }
        const files = await artifactMetadata(this.runPath);
        const endedAt = new Date().toISOString();
        const finalStatus = this.failures.length > 0 || this.droppedFacts > 0
            ? 'partial'
            : status;
        const manifest = {
            ...this.currentManifest,
            status: finalStatus,
            sealed: true,
            endedAt,
            counts: { ...this.currentManifest.counts },
            files,
            contentHash: contentHashFor(files),
            recording: {
                ...this.currentManifest.recording,
                failures: structuredClone(this.failures),
                droppedFacts: this.droppedFacts,
                capacityExceeded: this.capacityExceeded,
                completedWrites: Object.values(this.currentManifest.counts)
                    .reduce((sum, value) => sum + value, 0)
            },
            error: errorRecord(error)
        };
        validateRunManifest(manifest);
        await atomicWriteJson(path.join(this.runPath, SINGLE_ARTIFACTS.manifest), manifest);
        await fs.rm(path.join(this.runPath, '.active'), { force: true });
        this.currentManifest = manifest;
        this.closed = true;
        this.acceptingRecords = false;
        this.archive.activeWriters.delete(this.reference.runId);
        this.archive.emit({ type: 'sealed', ...this.reference, manifest });
        await this.archive.appendSessionEntry(this.reference.caseId, this.reference.sessionId, {
            type: 'run-link',
            actor: 'ria',
            content: `Run ${this.reference.runId} sealed as ${manifest.status}.`,
            runId: this.reference.runId,
            relation: 'sealed',
            metadata: { status: manifest.status, contentHash: manifest.contentHash }
        });
        await this.archive.rebuildIndex();
        return structuredClone(manifest);
    }
}

export class RiaArchive {
    constructor({
        projectRoot,
        archiveRoot = null,
        maxRunBytes = 256 * 1024 * 1024,
        maxResultBytes = 64 * 1024 * 1024,
        maxJsonlLineBytes = 4 * 1024 * 1024,
        syncEveryRecords = 64
    } = {}) {
        if (!projectRoot) throw new TypeError('RiaArchive requires projectRoot.');
        this.projectRoot = path.resolve(projectRoot);
        this.root = path.resolve(archiveRoot ?? path.join(this.projectRoot, 'artifacts'));
        this.casesRoot = path.join(this.root, 'cases');
        this.indexPath = path.join(this.root, 'index.json');
        this.maxRunBytes = maxRunBytes;
        this.maxResultBytes = maxResultBytes;
        this.maxJsonlLineBytes = maxJsonlLineBytes;
        if (!Number.isInteger(syncEveryRecords) || syncEveryRecords < 1) {
            throw new TypeError('syncEveryRecords must be a positive integer.');
        }
        this.syncEveryRecords = syncEveryRecords;
        this.listeners = new Set();
        this.activeWriters = new Map();
        this.indexBuilds = new Map();
    }

    async initialize() {
        await fs.mkdir(this.casesRoot, { recursive: true });
        return this;
    }

    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(message) {
        for (const listener of this.listeners) {
            try {
                listener(message);
            } catch {
                // Observers must never change archive or calculation results.
            }
        }
    }

    casePath(caseId) {
        return resolveInside(this.casesRoot, assertRiaId(caseId, 'caseId'));
    }

    sessionPath(caseId, sessionId) {
        return resolveInside(
            this.casePath(caseId),
            'sessions',
            assertRiaId(sessionId, 'sessionId')
        );
    }

    runPath(caseId, runId) {
        return resolveInside(this.casePath(caseId), 'runs', assertRiaId(runId, 'runId'));
    }

    eventIndexPath(caseId, runId) {
        return resolveInside(
            this.root,
            'indexes',
            assertRiaId(caseId, 'caseId'),
            assertRiaId(runId, 'runId'),
            'events.sparse.json'
        );
    }

    async ensureEventIndex(reference) {
        const key = `${reference.caseId}/${reference.runId}`;
        if (this.indexBuilds.has(key)) return this.indexBuilds.get(key);
        const promise = ensureSparseJsonlIndex({
            filePath: path.join(reference.runPath, JSONL_ARTIFACTS.events),
            indexPath: this.eventIndexPath(reference.caseId, reference.runId),
            runId: reference.runId,
            stride: EVENT_INDEX_STRIDE,
            maxLineBytes: this.maxJsonlLineBytes
        }).finally(() => this.indexBuilds.delete(key));
        this.indexBuilds.set(key, promise);
        return promise;
    }

    async rebuildEventIndex(reference) {
        const indexPath = this.eventIndexPath(reference.caseId, reference.runId);
        await fs.rm(indexPath, { force: true });
        return this.ensureEventIndex(reference);
    }

    async createCase(input = {}) {
        validateCaseCreateRequest(input);
        const {
            caseId = newRiaId('case'),
            title,
            description = '',
            tags = [],
            policy = {}
        } = input;
        assertRiaId(caseId, 'caseId');
        if (typeof title !== 'string' || title.trim() === '') {
            throw new RiaInputError('Case title is required.');
        }
        if (!Array.isArray(tags)) throw new RiaInputError('Case tags must be an array.');
        const casePath = this.casePath(caseId);
        try {
            await fs.mkdir(casePath, { recursive: false });
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new RiaConflictError(`Case already exists: ${caseId}`, 'RIA_CASE_EXISTS');
            }
            if (error.code === 'ENOENT') {
                await this.initialize();
                return this.createCase({ caseId, title, description, tags, policy });
            }
            throw error;
        }
        await Promise.all([
            fs.mkdir(path.join(casePath, 'sessions')),
            fs.mkdir(path.join(casePath, 'runs'))
        ]);
        const now = new Date().toISOString();
        const document = sanitizeForArchive({
            schemaVersion: RIA_SCHEMA_VERSION,
            caseId,
            title: title.trim(),
            description,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            closedAt: null,
            tags: tags.map(String),
            policy: {
                retentionDays: policy.retentionDays ?? null,
                maxRuns: policy.maxRuns ?? null,
                compression: policy.compression ?? 'none'
            }
        }, { projectRoot: this.projectRoot });
        validateCase(document);
        await atomicWriteJson(path.join(casePath, 'case.json'), document);
        await this.rebuildIndex();
        return document;
    }

    async createSession(input = {}) {
        validateSessionCreateRequest(input);
        const {
            caseId,
            sessionId = newRiaId('session'),
            summary = '',
            actor = 'codex',
            metadata = {}
        } = input;
        const caseDocument = await this.getCase(caseId);
        if (caseDocument.status !== 'open') {
            throw new RiaConflictError(`Case ${caseId} is closed.`, 'RIA_CASE_CLOSED');
        }
        assertRiaId(sessionId, 'sessionId');
        const sessionPath = this.sessionPath(caseId, sessionId);
        await ensureExistingPathInside(
            this.root,
            path.join(this.casePath(caseId), 'sessions')
        );
        try {
            await fs.mkdir(sessionPath, { recursive: false });
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new RiaConflictError(
                    `Session already exists: ${sessionId}`,
                    'RIA_SESSION_EXISTS'
                );
            }
            throw error;
        }
        const manifest = sanitizeForArchive({
            schemaVersion: RIA_SCHEMA_VERSION,
            caseId,
            sessionId,
            createdAt: new Date().toISOString(),
            summary,
            actor,
            metadata
        }, { projectRoot: this.projectRoot });
        validateSession(manifest);
        await Promise.all([
            atomicWriteJson(path.join(sessionPath, 'manifest.json'), manifest),
            atomicWriteFile(path.join(sessionPath, SESSION_ENTRIES_FILE), '')
        ]);
        await this.rebuildIndex();
        return manifest;
    }

    async appendSessionEntry(caseId, sessionId, input = {}) {
        validateSessionEntryAppendRequest(input);
        const caseDocument = await this.getCase(caseId);
        if (caseDocument.status !== 'open') {
            throw new RiaConflictError(`Case ${caseId} is closed.`, 'RIA_CASE_CLOSED');
        }
        await this.getSession(caseId, sessionId);
        const sessionPath = this.sessionPath(caseId, sessionId);
        const entriesPath = path.join(sessionPath, SESSION_ENTRIES_FILE);
        const lockPath = path.join(sessionPath, '.entries.lock');
        return withExclusiveFileLock(lockPath, async () => {
            let previousSequence = 0;
            await scanJsonlFile(entriesPath, {
                tolerateTrailingPartial: false,
                maxLineBytes: this.maxJsonlLineBytes,
                onRecord: ({ value }) => {
                    validateSessionEntry(value, previousSequence);
                    previousSequence = value.sequence;
                    return true;
                }
            });
            const sanitized = sanitizeForArchive(input, { projectRoot: this.projectRoot });
            const entry = {
                schemaVersion: RIA_SCHEMA_VERSION,
                caseId,
                sessionId,
                sequence: previousSequence + 1,
                createdAt: new Date().toISOString(),
                type: sanitized.type,
                actor: sanitized.actor ?? 'codex',
                content: sanitized.content,
                ...(sanitized.runId ? { runId: sanitized.runId } : {}),
                ...(sanitized.relatedRunId ? { relatedRunId: sanitized.relatedRunId } : {}),
                ...(sanitized.relation ? { relation: sanitized.relation } : {}),
                ...(sanitized.commit ? { commit: sanitized.commit } : {}),
                ...(sanitized.threadId ? { threadId: sanitized.threadId } : {}),
                ...(sanitized.threadSource ? { threadSource: sanitized.threadSource } : {}),
                metadata: sanitized.metadata ?? {}
            };
            entry.contentHash = hashJson(entry);
            validateSessionEntry(entry, previousSequence);
            await appendJsonLine(entriesPath, entry, {
                maxLineBytes: this.maxJsonlLineBytes,
                sync: true
            });
            this.emit({ type: 'session-entry', caseId, sessionId, entry });
            return entry;
        });
    }

    async listSessionEntries(caseId, sessionId, filters = {}) {
        await this.getSession(caseId, sessionId);
        const afterSequence = Number(filters.afterSequence ?? 0);
        const limit = Math.min(1000, Number(filters.limit ?? 100));
        if (!Number.isInteger(afterSequence) || afterSequence < 0
            || !Number.isInteger(limit) || limit < 1) {
            throw new RiaInputError('Invalid session entry pagination.');
        }
        const types = filters.type === undefined
            ? null
            : new Set((Array.isArray(filters.type)
                ? filters.type
                : String(filters.type).split(',')).filter(Boolean));
        const items = [];
        let hasMore = false;
        let previousSequence = 0;
        await scanJsonlFile(path.join(this.sessionPath(caseId, sessionId), SESSION_ENTRIES_FILE), {
            tolerateTrailingPartial: false,
            maxLineBytes: this.maxJsonlLineBytes,
            onRecord: ({ value }) => {
                validateSessionEntry(value, previousSequence);
                previousSequence = value.sequence;
                if (value.sequence <= afterSequence || (types && !types.has(value.type))) return true;
                if (items.length < limit) items.push(value);
                else {
                    hasMore = true;
                    return false;
                }
                return true;
            }
        });
        return {
            items,
            page: {
                afterSequence,
                limit,
                nextAfterSequence: items.at(-1)?.sequence ?? afterSequence,
                hasMore
            }
        };
    }

    async closeCase(caseId, input = {}) {
        validateCaseCloseRequest(input);
        const { resolution = '' } = input;
        const current = await this.getCase(caseId);
        if (current.status === 'closed') return current;
        const activeRuns = (await this.listRuns({ caseId })).filter(run => !run.sealed);
        if (activeRuns.length > 0) {
            throw new RiaConflictError(
                `Case ${caseId} has ${activeRuns.length} unsealed run(s).`,
                'RIA_CASE_HAS_ACTIVE_RUNS'
            );
        }
        const now = new Date().toISOString();
        const document = sanitizeForArchive({
            ...current,
            status: 'closed',
            updatedAt: now,
            closedAt: now,
            resolution: String(resolution ?? '').slice(0, 20_000)
        }, { projectRoot: this.projectRoot });
        validateCase(document);
        await atomicWriteJson(path.join(this.casePath(caseId), 'case.json'), document);
        await this.rebuildIndex();
        return document;
    }

    async startRun(input = {}) {
        validateSchema('startRunRequest', input, 'start run request');
        const {
            caseId,
            sessionId,
            runId = newRiaId('run'),
            fixture,
            config = {},
            seed = null,
            uiActions = []
        } = input;
        const openCase = await this.getCase(caseId);
        if (openCase.status !== 'open') {
            throw new RiaConflictError(`Case ${caseId} is closed.`, 'RIA_CASE_CLOSED');
        }
        await this.getSession(caseId, sessionId);
        assertRiaId(runId, 'runId');
        const runPath = this.runPath(caseId, runId);
        await ensureExistingPathInside(
            this.root,
            path.join(this.casePath(caseId), 'runs')
        );
        const sanitizedFixture = sanitizeForArchive(fixture, { projectRoot: this.projectRoot });
        assertJsonSize(sanitizedFixture, this.maxResultBytes, 'fixture');
        const caseDocument = openCase;
        const compression = config.compression ?? caseDocument.policy?.compression ?? 'none';
        if (!['none', 'gzip'].includes(compression)) {
            throw new RiaInputError('compression must be none or gzip.');
        }
        const reference = { caseId, sessionId, runId, runPath };
        const fileGroups = await versionFileGroups(this.projectRoot);
        const manifest = {
            schemaVersion: RIA_SCHEMA_VERSION,
            caseId,
            sessionId,
            runId,
            status: 'recording',
            sealed: false,
            startedAt: new Date().toISOString(),
            endedAt: null,
            fixtureHash: hashJson(sanitizedFixture),
            versions: await captureVersions(this.projectRoot, { fileGroups }),
            environment: await captureEnvironment(this.projectRoot, {
                executionFiles: [...fileGroups.executableFiles, ...fileGroups.recorderFiles]
            }),
            config: sanitizeForArchive({
                ...config,
                compression,
                explicitRecording: config.explicitRecording ?? true,
                adapter: sanitizedFixture?.adapter ?? null,
                maxRunBytes: this.maxRunBytes
            }, { projectRoot: this.projectRoot }),
            seed,
            counts: { commands: 0, events: 0, snapshots: 0, uiActions: 0 },
            files: {},
            contentHash: null,
            recording: {
                writerPid: process.pid,
                bytesWritten: 0,
                completedWrites: 0,
                failures: [],
                droppedFacts: 0,
                capacityExceeded: false,
                streamBytes: { commands: 0, events: 0, snapshots: 0, uiActions: 0 }
            },
            error: null,
            recovery: null
        };
        validateRunManifest(manifest);
        try {
            await fs.mkdir(runPath, { recursive: false });
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new RiaConflictError(`Run already exists: ${runId}`, 'RIA_RUN_EXISTS');
            }
            throw error;
        }
        await Promise.all([
            atomicWriteJson(path.join(runPath, 'fixture.json'), sanitizedFixture),
            atomicWriteJson(path.join(runPath, 'manifest.json'), manifest),
            atomicWriteJson(path.join(runPath, 'assertions.json'), {
                schemaVersion: RIA_SCHEMA_VERSION,
                passed: null,
                checks: []
            }),
            atomicWriteJson(path.join(runPath, 'result.json'), {
                schemaVersion: RIA_SCHEMA_VERSION,
                status: 'recording'
            }),
            atomicWriteFile(path.join(runPath, 'findings.md'), ''),
            ...Object.values(JSONL_ARTIFACTS).map(file => atomicWriteFile(path.join(runPath, file), '')),
            atomicWriteJson(path.join(runPath, '.active'), {
                schemaVersion: RIA_SCHEMA_VERSION,
                pid: process.pid,
                startedAt: manifest.startedAt
            })
        ]);
        const writer = new RiaRunWriter(this, reference, manifest);
        for (const command of sanitizedFixture?.input?.commands ?? sanitizedFixture?.commands ?? []) {
            await writer.appendCommand(command);
        }
        for (const action of uiActions) await writer.appendUiAction(action);
        await writer.drain();
        this.activeWriters.set(runId, writer);
        await this.appendSessionEntry(caseId, sessionId, {
            type: 'run-link',
            actor: 'ria',
            content: `Run ${runId} created.`,
            runId,
            relation: 'created',
            metadata: { fixtureHash: manifest.fixtureHash, adapter: manifest.config.adapter }
        });
        this.emit({ type: 'started', ...reference, manifest });
        return writer;
    }

    async getCase(caseId) {
        const file = path.join(this.casePath(caseId), 'case.json');
        try {
            await ensureExistingPathInside(this.root, file);
            return validateCase(await readJson(file));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new RiaNotFoundError(`Case not found: ${caseId}`, 'RIA_CASE_NOT_FOUND');
            }
            throw error;
        }
    }

    async getSession(caseId, sessionId) {
        const file = path.join(this.sessionPath(caseId, sessionId), 'manifest.json');
        try {
            await ensureExistingPathInside(this.root, file);
            return validateSession(await readJson(file));
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new RiaNotFoundError(
                    `Session not found: ${caseId}/${sessionId}`,
                    'RIA_SESSION_NOT_FOUND'
                );
            }
            throw error;
        }
    }

    async locateRun(runId, requestedCaseId = null) {
        assertRiaId(runId, 'runId');
        if (requestedCaseId !== null) {
            const caseId = assertRiaId(requestedCaseId, 'caseId');
            const runPath = this.runPath(caseId, runId);
            if (!await pathExists(path.join(runPath, 'manifest.json'))) {
                throw new RiaNotFoundError(`Run not found: ${runId}`, 'RIA_RUN_NOT_FOUND');
            }
            await ensureExistingPathInside(this.root, runPath);
            const manifest = validateRunManifest(await readJson(path.join(runPath, 'manifest.json')));
            return { caseId, sessionId: manifest.sessionId, runId, runPath, manifest };
        }
        const cases = await this.listCases();
        const matches = [];
        for (const caseDocument of cases) {
            const candidate = this.runPath(caseDocument.caseId, runId);
            if (await pathExists(path.join(candidate, 'manifest.json'))) {
                await ensureExistingPathInside(this.root, candidate);
                const manifest = validateRunManifest(await readJson(path.join(candidate, 'manifest.json')));
                matches.push({
                    caseId: caseDocument.caseId,
                    sessionId: manifest.sessionId,
                    runId,
                    runPath: candidate,
                    manifest
                });
            }
        }
        if (matches.length === 0) {
            throw new RiaNotFoundError(`Run not found: ${runId}`, 'RIA_RUN_NOT_FOUND');
        }
        if (matches.length > 1) {
            throw new RiaConflictError(
                `Run id ${runId} exists in multiple cases; provide caseId.`,
                'RIA_RUN_ID_AMBIGUOUS'
            );
        }
        return matches[0];
    }

    async getRun(runId, caseId = null) {
        const reference = await this.locateRun(runId, caseId);
        return { ...reference.manifest };
    }

    async appendRunUiAction(runId, action, caseId = null) {
        validateSchema('uiActionAppendRequest', action, 'UI action append request');
        const reference = await this.locateRun(runId, caseId);
        const caseDocument = await this.getCase(reference.caseId);
        if (caseDocument.status !== 'open') {
            throw new RiaConflictError(`Case ${reference.caseId} is closed.`, 'RIA_CASE_CLOSED');
        }
        if (reference.manifest.sealed) {
            throw new RiaConflictError(`Run ${runId} is sealed.`, 'RIA_RUN_SEALED');
        }
        const writer = this.activeWriters.get(runId);
        if (!writer || writer.reference.caseId !== reference.caseId) {
            throw new RiaConflictError(
                `Run ${runId} is not owned by this RIA server process.`,
                'RIA_RUN_NOT_ACTIVE'
            );
        }
        await writer.appendUiAction(action);
        await writer.drain();
        return {
            accepted: true,
            runId,
            sequence: writer.currentManifest.counts.uiActions
        };
    }

    async readRunArtifact(runId, artifact, caseId = null) {
        if (!Object.prototype.hasOwnProperty.call(RUN_ARTIFACTS, artifact)) {
            throw new RiaInputError(`Unknown run artifact: ${artifact}`);
        }
        const reference = await this.locateRun(runId, caseId);
        const file = RUN_ARTIFACTS[artifact];
        if (Object.prototype.hasOwnProperty.call(JSONL_ARTIFACTS, artifact)) {
            return readMaybeCompressedJsonLines(reference.runPath, file);
        }
        const absolute = path.join(reference.runPath, file);
        try {
            return artifact === 'findings'
                ? await fs.readFile(absolute, 'utf8')
                : await readJson(absolute);
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new RiaNotFoundError(
                    `Artifact ${artifact} not found for run ${runId}.`,
                    'RIA_ARTIFACT_NOT_FOUND'
                );
            }
            throw error;
        }
    }

    async queryEvents(runId, filters = {}, caseId = null) {
        const reference = await this.locateRun(runId, caseId);
        const afterSequence = Number(filters.afterSequence ?? 0);
        const fromFrame = filters.fromFrame === undefined ? null : Number(filters.fromFrame);
        const toFrame = filters.toFrame === undefined ? null : Number(filters.toFrame);
        const requestedLimit = Number(filters.limit ?? 100);
        const limit = Math.min(1000, requestedLimit);
        if (!Number.isInteger(afterSequence) || afterSequence < 0
            || (fromFrame !== null && (!Number.isFinite(fromFrame) || fromFrame < 0))
            || (toFrame !== null && (!Number.isFinite(toFrame) || toFrame < 0))
            || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000) {
            throw new RiaInputError('Invalid event pagination or frame filter.');
        }
        if (fromFrame !== null && toFrame !== null && fromFrame > toFrame) {
            throw new RiaInputError('fromFrame cannot exceed toFrame.');
        }
        const eventTypes = filters.eventType === undefined
            ? null
            : new Set((Array.isArray(filters.eventType)
                ? filters.eventType
                : String(filters.eventType).split(',')).filter(Boolean));
        const normalizedFilters = {
            fromFrame,
            toFrame,
            eventType: eventTypes,
            actorId: filters.actorId,
            targetId: filters.targetId,
            rootCastId: filters.rootCastId,
            childCastId: filters.childCastId
        };
        const filterHash = eventFilterHash(normalizedFilters);
        const matches = event => (
            (fromFrame === null || event.frame >= fromFrame)
            && (toFrame === null || event.frame <= toFrame)
            && (eventTypes === null || eventTypes.has(event.eventType))
            && (filters.actorId === undefined || String(event.actorId) === String(filters.actorId))
            && (filters.targetId === undefined || String(event.targetId) === String(filters.targetId))
            && (filters.rootCastId === undefined
                || String(event.rootCastId) === String(filters.rootCastId))
            && (filters.childCastId === undefined
                || String(event.childCastId) === String(filters.childCastId))
        );
        const plainPath = path.join(reference.runPath, JSONL_ARTIFACTS.events);
        const gzipPath = `${plainPath}.gz`;
        const isGzip = !await pathExists(plainPath) && await pathExists(gzipPath);
        const encoding = isGzip ? 'gzip' : 'identity';
        let cursor = null;
        if (filters.cursor !== undefined) {
            cursor = decodeJsonlCursor(filters.cursor, { runId, filterHash, encoding });
        }
        const effectiveAfterSequence = Math.max(afterSequence, cursor?.sequence ?? 0);
        const itemsWithOffsets = [];
        let hasMore = false;
        let lastDecodedSequence = effectiveAfterSequence;
        let lastReturnedEndOffset = cursor?.offset ?? 0;
        let indexEvidence = { rebuilt: false, extended: false, index: null };
        let seek = { sequence: 1, offset: 0 };
        let scanned;
        const onRecord = ({ value, endOffset }) => {
            lastDecodedSequence = Math.max(lastDecodedSequence, Number(value.sequence) || 0);
            if (value.sequence <= effectiveAfterSequence || !matches(value)) return true;
            if (itemsWithOffsets.length < limit) {
                itemsWithOffsets.push({ event: value, endOffset });
                lastReturnedEndOffset = endOffset;
                return true;
            }
            hasMore = true;
            return false;
        };
        if (isGzip) {
            scanned = await scanGzipJsonlFile(gzipPath, {
                maxLineBytes: this.maxJsonlLineBytes,
                tolerateTrailingPartial: false,
                onRecord
            });
        } else {
            indexEvidence = await this.ensureEventIndex(reference);
            seek = cursor ?? sparseSeek(indexEvidence.index, effectiveAfterSequence);
            scanned = await scanJsonlFile(plainPath, {
                startOffset: seek.offset,
                maxLineBytes: this.maxJsonlLineBytes,
                tolerateTrailingPartial: !reference.manifest.sealed,
                onRecord
            });
        }
        const items = itemsWithOffsets.map(entry => entry.event);
        const nextAfterSequence = items.at(-1)?.sequence ?? effectiveAfterSequence;
        const nextOffset = items.length > 0 ? lastReturnedEndOffset : scanned.endOffset;
        const nextCursor = encodeJsonlCursor({
            runId,
            sequence: nextAfterSequence,
            offset: isGzip ? 0 : nextOffset,
            filterHash,
            encoding
        });
        const readCursor = encodeJsonlCursor({
            runId,
            sequence: hasMore ? nextAfterSequence : lastDecodedSequence,
            offset: isGzip ? 0 : (hasMore ? nextOffset : scanned.endOffset),
            filterHash,
            encoding
        });
        return {
            items,
            page: {
                afterSequence,
                limit,
                nextAfterSequence,
                nextCursor,
                readCursor,
                hasMore,
                diagnostics: {
                    strategy: isGzip
                        ? 'gzip-sequential-decompression'
                        : 'sparse-sequence-byte-offset',
                    indexStride: isGzip ? null : EVENT_INDEX_STRIDE,
                    indexRebuilt: indexEvidence.rebuilt,
                    indexExtended: indexEvidence.extended,
                    seekSequence: isGzip ? 1 : seek.sequence,
                    startOffset: isGzip ? 0 : seek.offset,
                    endOffset: scanned.endOffset,
                    fileBytes: scanned.fileBytes,
                    bytesScanned: scanned.endOffset - (isGzip ? 0 : seek.offset),
                    recordsDecoded: scanned.recordsDecoded,
                    trailingBytes: scanned.trailingBytes
                }
            }
        };
    }

    async stateAtFrame(runId, frame, caseId = null) {
        const requestedFrame = Number(frame);
        if (!Number.isFinite(requestedFrame) || requestedFrame < 0) {
            throw new RiaInputError('frame must be a non-negative number.');
        }
        const snapshots = await this.readRunArtifact(runId, 'snapshots', caseId);
        const snapshot = [...snapshots].reverse().find(entry => entry.frame <= requestedFrame) ?? null;
        if (!snapshot) {
            return {
                frame: requestedFrame,
                state: {},
                proof: {
                    exact: false,
                    reason: 'NO_SNAPSHOT_AT_OR_BEFORE_FRAME',
                    snapshotSequence: null,
                    snapshotFrame: null,
                    eventSequenceFrom: null,
                    eventSequenceTo: null
                }
            };
        }
        return {
            frame: requestedFrame,
            state: snapshot.state,
            proof: {
                exact: snapshot.frame === requestedFrame,
                reason: snapshot.frame === requestedFrame
                    ? 'EXACT_FACT_FRAME'
                    : 'LAST_PROVABLE_STATE_BEFORE_FRAME',
                snapshotSequence: snapshot.sequence,
                snapshotFrame: snapshot.frame,
                eventSequenceFrom: snapshot.evidence.fromEventSequence,
                eventSequenceTo: snapshot.evidence.toEventSequence
            }
        };
    }

    async listCases() {
        await this.initialize();
        const entries = await fs.readdir(this.casesRoot, { withFileTypes: true });
        const cases = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory()) continue;
            try {
                cases.push(await this.getCase(entry.name));
            } catch (error) {
                if (error.code !== 'RIA_INVALID_ID' && error.code !== 'RIA_CASE_NOT_FOUND') throw error;
            }
        }
        return cases;
    }

    async listSessions(caseId) {
        await this.getCase(caseId);
        const root = path.join(this.casePath(caseId), 'sessions');
        const entries = await fs.readdir(root, { withFileTypes: true });
        const sessions = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isDirectory()) continue;
            sessions.push(await this.getSession(caseId, entry.name));
        }
        return sessions;
    }

    async listRuns({ caseId = null, sessionId = null, status = null } = {}) {
        if (caseId !== null) assertRiaId(caseId, 'caseId');
        if (sessionId !== null) assertRiaId(sessionId, 'sessionId');
        const cases = caseId === null ? await this.listCases() : [await this.getCase(caseId)];
        const runs = [];
        for (const caseDocument of cases) {
            const root = path.join(this.casePath(caseDocument.caseId), 'runs');
            let entries = [];
            try {
                entries = await fs.readdir(root, { withFileTypes: true });
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                try {
                    const manifest = validateRunManifest(await readJson(path.join(root, entry.name, 'manifest.json')));
                    if (sessionId !== null && manifest.sessionId !== sessionId) continue;
                    if (status !== null && manifest.status !== status) continue;
                    runs.push(manifest);
                } catch (error) {
                    if (error.code === 'ENOENT') continue;
                    throw error;
                }
            }
        }
        return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }

    async rebuildIndex() {
        await this.initialize();
        const cases = await this.listCases();
        const sessions = [];
        const runs = [];
        for (const caseDocument of cases) {
            sessions.push(...await this.listSessions(caseDocument.caseId));
            const caseRuns = await this.listRuns({ caseId: caseDocument.caseId });
            runs.push(...caseRuns);
            for (const manifest of caseRuns) {
                const reference = await this.locateRun(manifest.runId, manifest.caseId);
                const eventsPath = path.join(reference.runPath, JSONL_ARTIFACTS.events);
                if (await pathExists(eventsPath)) await this.ensureEventIndex(reference);
            }
        }
        const index = {
            schemaVersion: RIA_SCHEMA_VERSION,
            generatedAt: new Date().toISOString(),
            authority: 'derived-rebuildable-index',
            cases,
            sessions,
            runs
        };
        await atomicWriteJson(this.indexPath, index);
        return index;
    }

    async recoverRun(runId, { caseId = null, force = false } = {}) {
        const reference = await this.locateRun(runId, caseId);
        if (reference.manifest.sealed) {
            await fs.rm(path.join(reference.runPath, '.active'), { force: true });
            return { recovered: false, reason: 'ALREADY_SEALED', manifest: reference.manifest };
        }
        let lease = null;
        try {
            lease = await readJson(path.join(reference.runPath, '.active'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (!force && lease?.pid !== process.pid && isProcessAlive(Number(lease?.pid))) {
            throw new RiaConflictError(
                `Run ${runId} is still owned by live process ${lease.pid}.`,
                'RIA_RUN_ACTIVE'
            );
        }
        const recovery = {};
        for (const [kind, file] of Object.entries(JSONL_ARTIFACTS)) {
            recovery[kind] = await recoverJsonLines(path.join(reference.runPath, file), {
                maxLineBytes: this.maxJsonlLineBytes
            });
        }
        const counts = Object.fromEntries(Object.entries(recovery).map(([kind, value]) => [
            kind,
            value.records
        ]));
        const files = await artifactMetadata(reference.runPath);
        const manifest = {
            ...reference.manifest,
            status: 'partial',
            sealed: true,
            endedAt: new Date().toISOString(),
            counts,
            files,
            contentHash: contentHashFor(files),
            recording: {
                ...reference.manifest.recording,
                failures: [
                    ...(reference.manifest.recording?.failures ?? []),
                    {
                        name: 'InterruptedRun',
                        code: 'RIA_CRASH_RECOVERED',
                        message: 'Unsealed run recovered after interruption.',
                        stackHash: null
                    }
                ]
            },
            recovery: {
                recoveredAt: new Date().toISOString(),
                previousWriterPid: lease?.pid ?? null,
                streams: recovery
            },
            error: reference.manifest.error ?? {
                name: 'InterruptedRun',
                code: 'RIA_CRASH_RECOVERED',
                message: 'Writer exited before sealing.',
                stackHash: null
            }
        };
        validateRunManifest(manifest);
        await atomicWriteJson(path.join(reference.runPath, 'manifest.json'), manifest);
        await fs.rm(path.join(reference.runPath, '.active'), { force: true });
        this.activeWriters.delete(reference.runId);
        this.emit({ type: 'sealed', ...reference, manifest });
        await this.rebuildIndex();
        return { recovered: true, manifest, recovery: manifest.recovery };
    }

    async verifyRun(runId, caseId = null) {
        const reference = await this.locateRun(runId, caseId);
        const errors = [];
        const warnings = [];
        const manifest = reference.manifest;
        try {
            validateRunManifest(manifest);
        } catch (error) {
            errors.push({ code: error.code, message: error.message });
        }
        const fixture = await this.readRunArtifact(runId, 'fixture', reference.caseId);
        if (hashJson(fixture) !== manifest.fixtureHash) {
            errors.push({ code: 'RIA_FIXTURE_HASH_MISMATCH', message: 'fixture.json hash mismatch.' });
        }
        const events = await this.readRunArtifact(runId, 'events', reference.caseId);
        let previousEventSequence = 0;
        for (const event of events) {
            try {
                validateEvent(event, previousEventSequence);
                if (event.caseId !== manifest.caseId || event.sessionId !== manifest.sessionId
                    || event.runId !== manifest.runId) {
                    throw new RiaError('Event identity differs from manifest.', 'RIA_EVENT_IDENTITY_MISMATCH');
                }
                if (event.eventHash !== hashJson({ ...event, eventHash: undefined })) {
                    throw new RiaError('Event content hash mismatch.', 'RIA_EVENT_HASH_MISMATCH');
                }
                previousEventSequence = event.sequence;
            } catch (error) {
                errors.push({ code: error.code ?? 'RIA_EVENT_INVALID', message: error.message });
                break;
            }
        }
        const snapshots = await this.readRunArtifact(runId, 'snapshots', reference.caseId);
        let previousSnapshotSequence = 0;
        for (const snapshot of snapshots) {
            try {
                const compatibilityWarning = validateArchivedSnapshot(
                    snapshot,
                    previousSnapshotSequence,
                    manifest
                );
                if (compatibilityWarning && !warnings.some(item => (
                    item.code === compatibilityWarning.code
                ))) warnings.push(compatibilityWarning);
                if (snapshot.caseId !== manifest.caseId || snapshot.sessionId !== manifest.sessionId
                    || snapshot.runId !== manifest.runId) {
                    throw new RiaError(
                        'Snapshot identity differs from manifest.',
                        'RIA_SNAPSHOT_IDENTITY_MISMATCH'
                    );
                }
                previousSnapshotSequence = snapshot.sequence;
            } catch (error) {
                errors.push({ code: error.code ?? 'RIA_SNAPSHOT_INVALID', message: error.message });
                break;
            }
        }
        if (manifest.counts.events !== events.length) {
            errors.push({
                code: 'RIA_EVENT_COUNT_MISMATCH',
                message: `Manifest says ${manifest.counts.events}; events file has ${events.length}.`
            });
        }
        if (manifest.counts.snapshots !== snapshots.length) {
            errors.push({
                code: 'RIA_SNAPSHOT_COUNT_MISMATCH',
                message: `Manifest says ${manifest.counts.snapshots}; snapshot file has ${snapshots.length}.`
            });
        }
        if (manifest.sealed) {
            const actualFiles = await artifactMetadata(reference.runPath);
            for (const [name, expected] of Object.entries(manifest.files ?? {})) {
                if (!actualFiles[name] || actualFiles[name].sha256 !== expected.sha256
                    || actualFiles[name].bytes !== expected.bytes) {
                    errors.push({
                        code: 'RIA_CONTENT_HASH_MISMATCH',
                        message: `Sealed artifact changed: ${name}`
                    });
                }
            }
            if (contentHashFor(manifest.files ?? {}) !== manifest.contentHash) {
                errors.push({ code: 'RIA_MANIFEST_HASH_MISMATCH', message: 'Manifest contentHash is invalid.' });
            }
        } else {
            warnings.push({ code: 'RIA_RUN_UNSEALED', message: 'Run is recording or needs recovery.' });
        }
        return {
            ok: errors.length === 0,
            runId,
            status: manifest.status,
            sealed: manifest.sealed,
            errors,
            warnings,
            counts: { events: events.length, snapshots: snapshots.length }
        };
    }

    async doctor() {
        const index = await this.rebuildIndex();
        const runs = [];
        for (const manifest of index.runs) runs.push(await this.verifyRun(manifest.runId, manifest.caseId));
        return {
            ok: runs.every(run => run.ok),
            schemaVersion: RIA_SCHEMA_VERSION,
            archiveRoot: this.root,
            indexRebuilt: true,
            caseCount: index.cases.length,
            sessionCount: index.sessions.length,
            runCount: index.runs.length,
            runs
        };
    }

    async retentionCandidates(caseId, { now = new Date() } = {}) {
        const caseDocument = await this.getCase(caseId);
        const runs = (await this.listRuns({ caseId })).filter(run => run.sealed);
        const reasons = new Map();
        const retentionDays = caseDocument.policy?.retentionDays ?? null;
        if (retentionDays !== null) {
            const cutoff = now.getTime() - Number(retentionDays) * 86_400_000;
            for (const run of runs) {
                if (run.endedAt && Date.parse(run.endedAt) < cutoff) {
                    reasons.set(run.runId, ['retentionDays']);
                }
            }
        }
        const maxRuns = caseDocument.policy?.maxRuns ?? null;
        if (maxRuns !== null) {
            for (const run of runs.slice(Number(maxRuns))) {
                reasons.set(run.runId, [
                    ...(reasons.get(run.runId) ?? []),
                    'maxRuns'
                ]);
            }
        }
        return runs.filter(run => reasons.has(run.runId)).map(run => ({
            caseId,
            runId: run.runId,
            endedAt: run.endedAt,
            status: run.status,
            reasons: reasons.get(run.runId)
        }));
    }

    async prune({ caseId, apply = false, now = new Date() } = {}) {
        const candidates = await this.retentionCandidates(caseId, { now });
        if (!apply || candidates.length === 0) {
            return {
                applied: false,
                recoverable: true,
                candidates,
                moved: []
            };
        }
        const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'z');
        const trashRoot = resolveInside(this.root, 'trash', stamp, assertRiaId(caseId, 'caseId'));
        await fs.mkdir(trashRoot, { recursive: true });
        const moved = [];
        for (const candidate of candidates) {
            const source = this.runPath(caseId, candidate.runId);
            const destination = resolveInside(trashRoot, candidate.runId);
            await fs.rename(source, destination);
            moved.push({
                ...candidate,
                recoveryPath: path.relative(this.root, destination)
            });
        }
        await this.rebuildIndex();
        return { applied: true, recoverable: true, candidates, moved };
    }

    async diffRuns(leftRunId, rightRunId, { leftCaseId = null, rightCaseId = null } = {}) {
        const [leftReference, rightReference] = await Promise.all([
            this.locateRun(leftRunId, leftCaseId),
            this.locateRun(rightRunId, rightCaseId)
        ]);
        const [leftEvents, rightEvents, leftResult, rightResult] = await Promise.all([
            this.readRunArtifact(leftRunId, 'events', leftReference.caseId),
            this.readRunArtifact(rightRunId, 'events', rightReference.caseId),
            this.readRunArtifact(leftRunId, 'result', leftReference.caseId),
            this.readRunArtifact(rightRunId, 'result', rightReference.caseId)
        ]);
        const eventDivergence = firstDivergence(leftEvents, rightEvents);
        const normalizedResultsEqual = hashJson(normalizeForDiff(leftResult))
            === hashJson(normalizeForDiff(rightResult));
        const environmentChecks = {
            executableIdentical: Boolean(leftReference.manifest.versions.executableHash)
                && leftReference.manifest.versions.executableHash
                    === rightReference.manifest.versions.executableHash,
            recorderIdentical: Boolean(leftReference.manifest.versions.recorderHash)
                && leftReference.manifest.versions.recorderHash
                    === rightReference.manifest.versions.recorderHash,
            rulesIdentical: leftReference.manifest.versions.rulesHash
                === rightReference.manifest.versions.rulesHash,
            dataIdentical: leftReference.manifest.versions.dataHash
                === rightReference.manifest.versions.dataHash,
            nodeIdentical: leftReference.manifest.environment.node
                === rightReference.manifest.environment.node,
            platformIdentical: leftReference.manifest.environment.platform
                === rightReference.manifest.environment.platform,
            archIdentical: leftReference.manifest.environment.arch
                === rightReference.manifest.environment.arch,
            gitCommitIdentical: leftReference.manifest.environment.git?.commit
                === rightReference.manifest.environment.git?.commit,
            trackedDiffIdentical: leftReference.manifest.environment.git?.trackedDiffHash
                === rightReference.manifest.environment.git?.trackedDiffHash,
            gitStatusIdentical: leftReference.manifest.environment.git?.statusHash
                === rightReference.manifest.environment.git?.statusHash,
            untrackedExecutionIdentical: Boolean(
                leftReference.manifest.environment.git?.untrackedExecutionHash
            ) && leftReference.manifest.environment.git?.untrackedExecutionHash
                === rightReference.manifest.environment.git?.untrackedExecutionHash
        };
        const environmentReasons = Object.entries(environmentChecks)
            .filter(([, identical]) => !identical)
            .map(([field]) => field.replace(/Identical$/, ''));
        const result = {
            schemaVersion: RIA_SCHEMA_VERSION,
            leftRunId,
            rightRunId,
            fixture: {
                identical: leftReference.manifest.fixtureHash === rightReference.manifest.fixtureHash,
                leftHash: leftReference.manifest.fixtureHash,
                rightHash: rightReference.manifest.fixtureHash
            },
            environment: {
                identical: environmentReasons.length === 0,
                ...environmentChecks,
                reasons: environmentReasons,
                left: leftReference.manifest.environment,
                right: rightReference.manifest.environment,
                leftVersions: leftReference.manifest.versions,
                rightVersions: rightReference.manifest.versions
            },
            eventsIdentical: eventDivergence.identical,
            resultsIdentical: normalizedResultsEqual,
            firstDivergence: eventDivergence.identical && !normalizedResultsEqual
                ? {
                    identical: false,
                    index: null,
                    kind: 'result',
                    left: normalizeForDiff(leftResult),
                    right: normalizeForDiff(rightResult),
                    context: null
                }
                : { ...eventDivergence, kind: eventDivergence.identical ? null : 'event' }
        };
        const diffRoot = path.join(this.root, 'diffs');
        await fs.mkdir(diffRoot, { recursive: true });
        const diffId = `${leftRunId}--${rightRunId}`.slice(0, 190);
        await atomicWriteJson(path.join(diffRoot, `${diffId}.json`), result);
        return result;
    }
}

export default RiaArchive;
