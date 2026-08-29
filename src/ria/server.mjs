import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import {
    assertRiaId,
    newRiaId,
    RIA_SCHEMA_VERSION,
    RiaError,
    RiaInputError
} from './common.mjs';
import { RIA_EXECUTOR_IDS, replayArchivedRun } from './execute.mjs';
import { validateOpenApiDocument } from './openapi.mjs';
import {
    schemaDocument,
    validateCaseCloseRequest,
    validateCaseCreateRequest,
    validateSchema,
    validateSessionEntryAppendRequest
} from './schemas.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_UI_ORIGINS = Object.freeze([
    'http://127.0.0.1:43821',
    'http://localhost:43821',
    'http://[::1]:43821'
]);
const RUN_ARTIFACT_ROUTE = Object.freeze({
    manifest: 'manifest',
    fixture: 'fixture',
    commands: 'commands',
    events: 'events',
    snapshots: 'snapshots',
    'state-snapshots': 'snapshots',
    assertions: 'assertions',
    result: 'result',
    'ui-actions': 'uiActions',
    findings: 'findings'
});

function jsonBody(value) {
    return `${JSON.stringify(value)}\n`;
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
    const body = jsonBody(value);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
    });
    response.end(body);
}

async function readBody(request, maxBytes) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
            throw new RiaError(
                `Request body exceeds ${maxBytes} bytes.`,
                'RIA_REQUEST_TOO_LARGE',
                413
            );
        }
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new RiaInputError('Request body is not valid JSON.', 'RIA_INVALID_JSON');
    }
}

function routeSegments(pathname) {
    try {
        return pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    } catch {
        throw new RiaInputError('URL path contains invalid escaping.', 'RIA_INVALID_PATH');
    }
}

function parseEventFilters(url) {
    const eventTypes = url.searchParams.getAll('eventType').flatMap(value => value.split(','));
    const filters = {};
    for (const key of [
        'afterSequence', 'fromFrame', 'toFrame', 'actorId', 'targetId',
        'rootCastId', 'childCastId', 'limit', 'cursor'
    ]) {
        if (url.searchParams.has(key)) filters[key] = url.searchParams.get(key);
    }
    if (eventTypes.length > 0) filters.eventType = eventTypes;
    return filters;
}

function sseFrame({ id = null, event = null, data }) {
    return `${id === null ? '' : `id: ${id}\n`}${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function sseErrorPayload(error) {
    return {
        error: {
            code: String(error?.code ?? 'RIA_STREAM_ERROR').slice(0, 160),
            message: String(error?.message ?? error ?? 'RIA stream failed.').slice(0, 4000),
            details: error?.details ?? null
        }
    };
}

export async function writeSseWithBackpressure(response, frame, {
    drainTimeoutMs = 5_000,
    onSlowConsumer = () => {}
} = {}) {
    const accepted = response.write(frame);
    if (accepted) return true;
    const drained = drainTimeoutMs > 0 && typeof response.once === 'function'
        ? await new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                response.off('drain', onDrain);
                response.off('close', onClose);
                response.off('error', onClose);
                resolve(value);
            };
            const onDrain = () => finish(true);
            const onClose = () => finish(false);
            const timeout = setTimeout(() => finish(false), drainTimeoutMs);
            timeout.unref?.();
            response.once('drain', onDrain);
            response.once('close', onClose);
            response.once('error', onClose);
        })
        : false;
    if (drained) return true;
    onSlowConsumer();
    response.end();
    return false;
}

async function serveEventStream({
    archive,
    reference,
    request,
    response,
    url,
    sseDrainTimeoutMs
}) {
    const headerSequence = request.headers['last-event-id'];
    const querySequence = url.searchParams.get('afterSequence');
    const afterSequence = Number(querySequence ?? headerSequence ?? 0);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
        throw new RiaInputError('Last-Event-ID/afterSequence must be a non-negative integer.');
    }
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff'
    });
    response.flushHeaders?.();
    let lastSequence = afterSequence;
    let closed = false;
    let runWatcher = null;
    let parentWatcher = null;
    let unsubscribe = () => {};
    let reading = Promise.resolve();
    let readPending = false;
    let readAgain = false;
    let readCursor = null;
    let bootstrapping = true;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        runWatcher?.close();
        parentWatcher?.close();
        unsubscribe();
    };
    request.once('close', cleanup);
    response.once('close', cleanup);

    const write = async frame => {
        if (closed) return false;
        return writeSseWithBackpressure(response, frame, {
            drainTimeoutMs: sseDrainTimeoutMs,
            onSlowConsumer: cleanup
        });
    };
    const writeEvent = async event => {
        if (event.sequence <= lastSequence) return true;
        const accepted = await write(sseFrame({
            id: event.sequence,
            event: 'ria-event',
            data: event
        }));
        if (accepted) lastSequence = event.sequence;
        return accepted;
    };
    const finishIfSealed = async () => {
        let manifest;
        try {
            manifest = await archive.getRun(reference.runId, reference.caseId);
        } catch (error) {
            if (error.code === 'RIA_RUN_NOT_FOUND') return false;
            throw error;
        }
        if (!manifest.sealed || closed) return false;
        await write(sseFrame({
            event: ['interrupted', 'failed'].includes(manifest.status)
                ? 'run-interrupted'
                : 'run-complete',
            data: {
                runId: reference.runId,
                status: manifest.status,
                lastSequence
            }
        }));
        cleanup();
        response.end();
        return true;
    };
    const replayAvailable = async () => {
        while (!closed) {
            let page;
            try {
                page = await archive.queryEvents(reference.runId, {
                    afterSequence: lastSequence,
                    limit: 1000,
                    ...(readCursor ? { cursor: readCursor } : {})
                }, reference.caseId);
            } catch (error) {
                if (error.code === 'RIA_RUN_NOT_FOUND') return false;
                throw error;
            }
            for (const event of page.items) {
                if (!await writeEvent(event)) return false;
            }
            readCursor = page.page.hasMore ? page.page.nextCursor : page.page.readCursor;
            if (!page.page.hasMore) return true;
        }
        return false;
    };

    const scheduleRead = () => {
        if (closed) return;
        if (readPending) {
            readAgain = true;
            return;
        }
        readPending = true;
        reading = reading.then(async () => {
            do {
                readAgain = false;
                await replayAvailable();
                await finishIfSealed();
            } while (readAgain && !closed);
        }).catch(error => {
            return write(sseFrame({
                event: 'stream-error',
                data: sseErrorPayload(error)
            })).finally(() => {
                cleanup();
                response.end();
            });
        }).finally(() => {
            readPending = false;
            if (readAgain && !closed) scheduleRead();
        });
    };

    const attachRunWatcher = () => {
        if (closed || runWatcher) return;
        try {
            runWatcher = fsSync.watch(reference.runPath, { persistent: false }, requestRead);
            parentWatcher?.close();
            parentWatcher = null;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    };

    const attachParentWatcher = () => {
        if (closed || parentWatcher || runWatcher) return;
        const parentPath = path.dirname(reference.runPath);
        parentWatcher = fsSync.watch(parentPath, { persistent: false }, () => {
            attachRunWatcher();
            requestRead();
        });
    };

    const requestRead = () => {
        if (closed) return;
        if (bootstrapping) {
            readAgain = true;
            return;
        }
        scheduleRead();
    };

    // Establish both the in-process notification boundary and the filesystem
    // observation boundary before the first read. Notifications received while
    // bootstrapping are coalesced into the unconditional reconciliation below.
    unsubscribe = archive.subscribe(message => {
        if (message.runId !== reference.runId || closed) return;
        if (message.type === 'started') attachRunWatcher();
        if (message.type === 'event') requestRead();
        if (message.type === 'sealed') requestRead();
    });
    attachRunWatcher();
    attachParentWatcher();

    await replayAvailable();
    if (await finishIfSealed()) {
        bootstrapping = false;
        return;
    }
    await write(sseFrame({
        event: 'stream-ready',
        data: {
            runId: reference.runId,
            afterSequence: lastSequence,
            waitingForRun: reference.manifest === null
        }
    }));
    bootstrapping = false;
    readAgain = false;
    // This read is unconditional: it closes the read -> subscribe/watch window
    // even on filesystems that coalesce or do not deliver the boundary change.
    scheduleRead();
}

export function createRiaServer({
    archive,
    host = '127.0.0.1',
    port = 0,
    allowRemote = false,
    maxBodyBytes = 1_048_576,
    sseDrainTimeoutMs = 5_000,
    allowedUiOrigins = DEFAULT_UI_ORIGINS
} = {}) {
    if (!archive) throw new TypeError('createRiaServer requires an archive.');
    if (!allowRemote && !LOOPBACK_HOSTS.has(host)) {
        throw new RiaInputError(
            `RIA binds to loopback by default; refusing host ${host}.`,
            'RIA_REMOTE_BIND_DENIED'
        );
    }
    const trustedUiOrigins = new Set(allowedUiOrigins);
    const jobs = new Map();
    const server = http.createServer(async (request, response) => {
        let responseCorsHeaders = {};
        try {
            const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);
            const segments = routeSegments(url.pathname);
            if (segments[0] !== 'api' || segments[1] !== 'ria') {
                sendJson(response, 404, {
                    error: { code: 'RIA_ROUTE_NOT_FOUND', message: 'Not found.', details: null }
                });
                return;
            }
            const route = segments.slice(2);
            const isUiActionRoute = route[0] === 'runs'
                && route.length === 3
                && route[2] === 'ui-actions';
            const requestOrigin = request.headers.origin;
            if (isUiActionRoute && requestOrigin !== undefined) {
                if (!trustedUiOrigins.has(requestOrigin)) {
                    sendJson(response, 403, {
                        error: {
                            code: 'RIA_UI_ORIGIN_DENIED',
                            message: 'UI action origin is not trusted.',
                            details: null
                        }
                    });
                    return;
                }
                responseCorsHeaders = {
                    'Access-Control-Allow-Origin': requestOrigin,
                    Vary: 'Origin'
                };
            }
            if (isUiActionRoute && request.method === 'OPTIONS') {
                if (requestOrigin === undefined) {
                    sendJson(response, 403, {
                        error: {
                            code: 'RIA_UI_PREFLIGHT_DENIED',
                            message: 'UI action preflight requires an explicit trusted Origin.',
                            details: null
                        }
                    });
                    return;
                }
                const requestedMethod = request.headers['access-control-request-method'];
                const requestedHeaders = String(
                    request.headers['access-control-request-headers'] ?? ''
                ).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
                if (requestedMethod !== 'POST'
                    || requestedHeaders.some(value => value !== 'content-type')) {
                    sendJson(response, 403, {
                        error: {
                            code: 'RIA_UI_PREFLIGHT_DENIED',
                            message: 'UI action preflight is not allowed.',
                            details: null
                        }
                    }, responseCorsHeaders);
                    return;
                }
                response.writeHead(204, {
                    ...responseCorsHeaders,
                    'Access-Control-Allow-Methods': 'POST',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '600',
                    'Content-Length': '0',
                    'Cache-Control': 'no-store'
                });
                response.end();
                return;
            }
            if (request.method === 'GET' && route.length === 1 && route[0] === 'health') {
                sendJson(response, 200, {
                    ok: true,
                    service: 'replayable-investigation-archive',
                    schemaVersion: RIA_SCHEMA_VERSION,
                    bind: host,
                    activeReplayJobs: [...jobs.values()].filter(job => job.status === 'running').length
                });
                return;
            }
            if (request.method === 'GET' && route.length === 1 && route[0] === 'schema') {
                sendJson(response, 200, schemaDocument());
                return;
            }
            if (request.method === 'GET' && route.length === 1 && route[0] === 'capabilities') {
                sendJson(response, 200, {
                    schemaVersion: RIA_SCHEMA_VERSION,
                    archiveAuthority: 'append-only-sealed-runs',
                    replayAdapters: RIA_EXECUTOR_IDS,
                    eventFilters: [
                        'afterSequence', 'fromFrame', 'toFrame', 'eventType', 'actorId',
                        'targetId', 'rootCastId', 'childCastId', 'limit', 'cursor'
                    ],
                    realtime: {
                        transport: 'sse',
                        resume: ['Last-Event-ID', 'afterSequence'],
                        slowConsumer: 'connection-closed; reconnect with Last-Event-ID',
                        terminalEvents: ['run-complete', 'run-interrupted']
                    },
                    pagination: {
                        liveAndPlain: 'sparse sequence-to-byte-offset index; incremental tail cursor',
                        sparseIndexStride: 128,
                        authoritativeSource: 'events.jsonl',
                        rebuildable: true,
                        gzipSealed: 'sequential decompression from stream start; no random byte seek'
                    },
                    limits: { maxBodyBytes, maxEventPageSize: 1000 },
                    security: { defaultBind: '127.0.0.1', arbitraryShellReplay: false }
                });
                return;
            }
            if (request.method === 'GET' && route.length === 1 && route[0] === 'openapi.json') {
                const document = JSON.parse(await fs.readFile(
                    path.join(archive.projectRoot, 'openapi', 'ria.openapi.json'),
                    'utf8'
                ));
                await validateOpenApiDocument(document);
                sendJson(response, 200, document);
                return;
            }
            if (route[0] === 'cases' && route.length === 1) {
                if (request.method === 'GET') {
                    sendJson(response, 200, { items: await archive.listCases() });
                    return;
                }
                if (request.method === 'POST') {
                    const body = await readBody(request, maxBodyBytes);
                    validateCaseCreateRequest(body);
                    sendJson(response, 201, await archive.createCase(body));
                    return;
                }
            }
            if (route[0] === 'cases' && route.length >= 2) {
                const caseId = assertRiaId(route[1], 'caseId');
                if (route.length === 2 && request.method === 'GET') {
                    sendJson(response, 200, await archive.getCase(caseId));
                    return;
                }
                if (route.length === 3 && route[2] === 'close' && request.method === 'POST') {
                    const body = await readBody(request, maxBodyBytes);
                    validateCaseCloseRequest(body);
                    sendJson(response, 200, await archive.closeCase(caseId, body));
                    return;
                }
                if (route[2] === 'sessions' && route.length === 3) {
                    if (request.method === 'GET') {
                        sendJson(response, 200, { items: await archive.listSessions(caseId) });
                        return;
                    }
                    if (request.method === 'POST') {
                        const body = await readBody(request, maxBodyBytes);
                        validateSchema('sessionCreateBody', body, 'session create body');
                        sendJson(response, 201, await archive.createSession({ caseId, ...body }));
                        return;
                    }
                }
                if (route[2] === 'sessions' && route.length === 4 && request.method === 'GET') {
                    sendJson(response, 200, await archive.getSession(
                        caseId,
                        assertRiaId(route[3], 'sessionId')
                    ));
                    return;
                }
                if (route[2] === 'sessions' && route.length === 5
                    && route[4] === 'entries') {
                    const sessionId = assertRiaId(route[3], 'sessionId');
                    if (request.method === 'GET') {
                        const entryTypes = url.searchParams.getAll('type')
                            .flatMap(value => value.split(','))
                            .filter(Boolean);
                        sendJson(response, 200, await archive.listSessionEntries(
                            caseId,
                            sessionId,
                            {
                                afterSequence: url.searchParams.get('afterSequence') ?? undefined,
                                limit: url.searchParams.get('limit') ?? undefined,
                                ...(entryTypes.length > 0 ? { type: entryTypes } : {})
                            }
                        ));
                        return;
                    }
                    if (request.method === 'POST') {
                        const body = await readBody(request, maxBodyBytes);
                        validateSessionEntryAppendRequest(body);
                        sendJson(response, 201, await archive.appendSessionEntry(
                            caseId,
                            sessionId,
                            body
                        ));
                        return;
                    }
                }
            }
            if (route[0] === 'runs' && route.length === 1 && request.method === 'GET') {
                sendJson(response, 200, { items: await archive.listRuns({
                    caseId: url.searchParams.get('caseId'),
                    sessionId: url.searchParams.get('sessionId'),
                    status: url.searchParams.get('status')
                }) });
                return;
            }
            if (route[0] === 'runs' && route.length >= 2) {
                const runId = assertRiaId(route[1], 'runId');
                const caseId = url.searchParams.get('caseId');
                if (route.length === 2 && request.method === 'GET') {
                    sendJson(response, 200, await archive.getRun(runId, caseId));
                    return;
                }
                if (route.length === 3 && route[2] === 'stream' && request.method === 'GET') {
                    let reference;
                    try {
                        reference = await archive.locateRun(runId, caseId);
                    } catch (error) {
                        if (error.code !== 'RIA_RUN_NOT_FOUND' || caseId === null) throw error;
                        const validatedCaseId = assertRiaId(caseId, 'caseId');
                        await archive.getCase(validatedCaseId);
                        reference = {
                            caseId: validatedCaseId,
                            sessionId: null,
                            runId,
                            runPath: archive.runPath(validatedCaseId, runId),
                            manifest: null
                        };
                    }
                    await serveEventStream({
                        archive,
                        reference,
                        request,
                        response,
                        url,
                        sseDrainTimeoutMs
                    });
                    return;
                }
                if (route.length === 3 && route[2] === 'state' && request.method === 'GET') {
                    sendJson(response, 200, await archive.stateAtFrame(
                        runId,
                        url.searchParams.get('frame'),
                        caseId
                    ));
                    return;
                }
                if (route.length === 3 && route[2] === 'events' && request.method === 'GET') {
                    sendJson(response, 200, await archive.queryEvents(
                        runId,
                        parseEventFilters(url),
                        caseId
                    ));
                    return;
                }
                if (route.length === 3 && route[2] === 'replay' && request.method === 'POST') {
                    const body = await readBody(request, maxBodyBytes);
                    validateSchema('replayRequest', body, 'replay request');
                    const source = await archive.locateRun(runId, caseId);
                    const sourceCase = await archive.getCase(source.caseId);
                    if (sourceCase.status !== 'open') {
                        throw new RiaError(`Case ${source.caseId} is closed.`, 'RIA_CASE_CLOSED', 409);
                    }
                    const replayRunId = body.replayRunId === undefined
                        ? newRiaId('run')
                        : assertRiaId(body.replayRunId, 'replayRunId');
                    const job = {
                        replayRunId,
                        sourceRunId: runId,
                        status: 'running',
                        startedAt: new Date().toISOString(),
                        result: null,
                        error: null
                    };
                    jobs.set(replayRunId, job);
                    sendJson(response, 202, {
                        accepted: true,
                        sourceRunId: runId,
                        replayRunId,
                        statusUrl: `/api/ria/jobs/${replayRunId}`,
                        streamUrl: `/api/ria/runs/${replayRunId}/stream?caseId=${source.caseId}`
                    });
                    setTimeout(() => {
                        replayArchivedRun({
                            archive,
                            runId,
                            caseId: source.caseId,
                            sessionId: body.sessionId ?? source.sessionId,
                            replayRunId
                        }).then(result => {
                            job.status = 'completed';
                            job.result = result;
                            job.endedAt = new Date().toISOString();
                        }).catch(error => {
                            job.status = 'failed';
                            job.error = {
                                code: error.code ?? 'RIA_REPLAY_FAILED',
                                message: error.message,
                                runId: error.riaRun?.runId ?? replayRunId
                            };
                            job.endedAt = new Date().toISOString();
                        });
                    }, 25);
                    return;
                }
                if (route.length === 3 && route[2] === 'ui-actions' && request.method === 'POST') {
                    const body = await readBody(request, maxBodyBytes);
                    validateSchema('uiActionAppendRequest', body, 'UI action append request');
                    sendJson(
                        response,
                        202,
                        await archive.appendRunUiAction(runId, body, caseId),
                        responseCorsHeaders
                    );
                    return;
                }
                if (route.length === 3 && request.method === 'GET'
                    && Object.prototype.hasOwnProperty.call(RUN_ARTIFACT_ROUTE, route[2])) {
                    const artifact = RUN_ARTIFACT_ROUTE[route[2]];
                    if (artifact === 'events') {
                        sendJson(response, 200, await archive.queryEvents(
                            runId,
                            parseEventFilters(url),
                            caseId
                        ));
                    } else {
                        sendJson(response, 200, await archive.readRunArtifact(
                            runId,
                            artifact,
                            caseId
                        ));
                    }
                    return;
                }
            }
            if (route[0] === 'jobs' && route.length === 2 && request.method === 'GET') {
                const jobId = assertRiaId(route[1], 'jobId');
                const job = jobs.get(jobId);
                if (!job) throw new RiaError(`Replay job not found: ${jobId}`, 'RIA_JOB_NOT_FOUND', 404);
                sendJson(response, 200, job);
                return;
            }
            if (route.length === 1 && route[0] === 'diff' && request.method === 'GET') {
                const leftRunId = assertRiaId(url.searchParams.get('leftRunId'), 'leftRunId');
                const rightRunId = assertRiaId(url.searchParams.get('rightRunId'), 'rightRunId');
                sendJson(response, 200, await archive.diffRuns(leftRunId, rightRunId, {
                    leftCaseId: url.searchParams.get('leftCaseId'),
                    rightCaseId: url.searchParams.get('rightCaseId')
                }));
                return;
            }
            sendJson(response, 404, {
                error: { code: 'RIA_ROUTE_NOT_FOUND', message: 'RIA route not found.', details: null }
            });
        } catch (error) {
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            const statusCode = error.statusCode ?? (error.code === 'ENOENT' ? 404 : 500);
            sendJson(response, statusCode, {
                error: {
                    code: error.code ?? 'RIA_INTERNAL_ERROR',
                    message: statusCode >= 500 ? 'RIA request failed.' : error.message,
                    details: statusCode >= 500 ? null : error.details ?? null
                }
            }, responseCorsHeaders);
        }
    });
    return {
        server,
        host,
        requestedPort: port,
        jobs,
        async listen() {
            await archive.initialize();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve();
                });
            });
            const address = server.address();
            return {
                host,
                port: typeof address === 'object' && address ? address.port : port,
                url: `http://${host}:${typeof address === 'object' && address ? address.port : port}`
            };
        },
        async close() {
            if (!server.listening) return;
            const closing = new Promise((resolve, reject) => server.close(error => (
                error ? reject(error) : resolve()
            )));
            server.closeAllConnections?.();
            await closing;
        }
    };
}

export default createRiaServer;
