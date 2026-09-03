import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RiaArchive } from '../src/ria/archive.mjs';
import { recordFixtureRun } from '../src/ria/execute.mjs';
import { RiaEventNormalizer } from '../src/ria/normalize.mjs';
import {
    createOpenApiSchemaValidator,
    validateOpenApiDocument
} from '../src/ria/openapi.mjs';
import { createRiaServer, writeSseWithBackpressure } from '../src/ria/server.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function setup(t, { maxBodyBytes = 1024 } = {}) {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-server-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const archive = await new RiaArchive({
        projectRoot,
        archiveRoot,
        syncEveryRecords: 4
    }).initialize();
    await archive.createCase({ caseId: 'case-api', title: 'API contract' });
    await archive.createSession({
        caseId: 'case-api',
        sessionId: 'session-api',
        summary: 'SSE and REST'
    });
    const service = createRiaServer({ archive, port: 0, maxBodyBytes });
    const address = await service.listen();
    t.after(() => service.close());
    return { archive, service, baseUrl: `${address.url}/api/ria` };
}

async function newWriter(archive, runId) {
    const writer = await archive.startRun({
        caseId: 'case-api',
        sessionId: 'session-api',
        runId,
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-api', sessionId: 'session-api', runId
    });
    return { writer, normalizer };
}

async function append(writer, normalizer, source, fact) {
    for (const event of normalizer.normalize(source, fact)) await writer.appendEvent(event);
}

async function* sseMessages(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            while (pending.includes('\n\n')) {
                const boundary = pending.indexOf('\n\n');
                const block = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const message = { id: null, event: 'message', data: null };
                const data = [];
                for (const line of block.split('\n')) {
                    if (line.startsWith('id: ')) message.id = Number(line.slice(4));
                    else if (line.startsWith('event: ')) message.event = line.slice(7);
                    else if (line.startsWith('data: ')) data.push(line.slice(6));
                }
                if (data.length > 0) message.data = JSON.parse(data.join('\n'));
                yield message;
            }
            if (done) return;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

function parseSseDocument(text) {
    return text.trim().split('\n\n').filter(Boolean).map(block => {
        const message = { id: null, event: 'message', data: null };
        for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) message.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) message.event = line.slice(7);
            else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6));
        }
        return message;
    });
}

async function nextSse(iterator, timeoutMs = 10_000) {
    let timeout;
    try {
        return await Promise.race([
            iterator.next(),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`SSE timed out after ${timeoutMs} ms.`)),
                    timeoutMs
                );
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Condition timed out after ${timeoutMs} ms.`);
}

test('REST exposes health/schema/OpenAPI, archive resources, filters and provable state', async t => {
    const { archive, baseUrl } = await setup(t);
    const { writer, normalizer } = await newWriter(archive, 'run-api');
    await append(writer, normalizer, 'resource', {
        frame: 4,
        stage: 'ResourceChanged',
        sourceId: 'actor-api',
        targetId: 'actor-api',
        resourceType: 'Atb',
        before: 2,
        after: 1,
        rootCastId: 'root:api',
        castId: 'root:api'
    });
    const uiAcceptedResponse = await fetch(`${baseUrl}/runs/run-api/ui-actions?caseId=case-api`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1:43821'
        },
        body: JSON.stringify({
            actionType: 'AkeCalculationRequested',
            actor: 'lts-ui',
            frame: 4,
            payload: { commandCount: 1 }
        })
    });
    assert.equal(
        uiAcceptedResponse.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:43821'
    );
    const uiAccepted = await uiAcceptedResponse.json();
    assert.equal(uiAccepted.accepted, true);
    const decision = await fetch(`${baseUrl}/cases/case-api/sessions/session-api/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: 'decision',
            actor: 'codex',
            content: 'Use runtime facts as the only combat evidence.'
        })
    }).then(response => response.json());
    assert.equal(decision.type, 'decision');
    await writer.seal({ result: { ok: true } });

    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.bind, '127.0.0.1');
    const schema = await fetch(`${baseUrl}/schema`).then(response => response.json());
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.schemas.event.required.includes('rootCastId'));
    const openapi = await fetch(`${baseUrl}/openapi.json`).then(response => response.json());
    assert.equal(openapi.openapi, '3.1.0');
    assert.deepEqual(await validateOpenApiDocument(openapi), {
        ok: true,
        version: '3.1.0',
        pathCount: 20,
        operationCount: 24
    });
    for (const requiredPath of [
        '/api/ria/runs/{runId}/events',
        '/api/ria/runs/{runId}/state',
        '/api/ria/runs/{runId}/stream',
        '/api/ria/runs/{runId}/replay',
        '/api/ria/diff'
    ]) assert.ok(openapi.paths[requiredPath], requiredPath);
    const validateComponent = createOpenApiSchemaValidator(openapi);
    for (const [route, pathItem] of Object.entries(openapi.paths)) {
        for (const [method, operation] of Object.entries(pathItem)) {
            if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
            for (const status of ['400', '404', '409', '413', '500']) {
                const declaredResponse = operation.responses[status];
                assert.ok(declaredResponse, `${method.toUpperCase()} ${route} ${status}`);
                const responseContract = declaredResponse.$ref
                    ? openapi.components.responses[declaredResponse.$ref.split('/').at(-1)]
                    : declaredResponse;
                assert.deepEqual(
                    responseContract.content['application/json'].schema,
                    { $ref: '#/components/schemas/Error' }
                );
            }
        }
    }
    assert.equal(validateComponent('CaseCreateRequest', {
        title: 'contract request', policy: { retentionDays: 1 }
    }).valid, true);
    assert.equal(validateComponent('CaseCreateRequest', {
        title: 'x'.repeat(241)
    }).valid, false);
    assert.equal(validateComponent('ReplayRequest', { command: 'rm -rf /' }).valid, false);
    const sseContract = openapi.paths['/api/ria/runs/{runId}/stream'].get.responses['200'];
    assert.deepEqual(sseContract['x-sse-events'].map(item => item.event), [
        'stream-ready', 'ria-event', 'run-complete', 'run-interrupted', 'stream-error'
    ]);
    assert.deepEqual(
        sseContract['x-sse-events'].find(item => item.event === 'ria-event').payload,
        { $ref: '#/components/schemas/Event' }
    );
    assert.deepEqual(
        sseContract['x-sse-events'].map(item => [item.event, item.payload.$ref]),
        [
            ['stream-ready', '#/components/schemas/SseReady'],
            ['ria-event', '#/components/schemas/Event'],
            ['run-complete', '#/components/schemas/SseTerminal'],
            ['run-interrupted', '#/components/schemas/SseTerminal'],
            ['stream-error', '#/components/schemas/SseError']
        ]
    );

    const caseDocument = await fetch(`${baseUrl}/cases/case-api`).then(response => response.json());
    assert.equal(caseDocument.caseId, 'case-api');
    assert.equal(validateComponent('Case', caseDocument).valid, true);
    const sessions = await fetch(`${baseUrl}/cases/case-api/sessions`).then(response => response.json());
    assert.deepEqual(sessions.items.map(item => item.sessionId), ['session-api']);
    const runs = await fetch(`${baseUrl}/runs?caseId=case-api`).then(response => response.json());
    assert.deepEqual(runs.items.map(item => item.runId), ['run-api']);
    const manifest = await fetch(`${baseUrl}/runs/run-api/manifest?caseId=case-api`)
        .then(response => response.json());
    assert.equal(manifest.sealed, true);
    assert.equal(manifest.counts.uiActions, 1);
    assert.equal(validateComponent('RunManifest', manifest).valid, true);
    const uiActions = await fetch(`${baseUrl}/runs/run-api/ui-actions?caseId=case-api`)
        .then(response => response.json());
    assert.equal(uiActions[0].actionType, 'AkeCalculationRequested');
    const sessionEntries = await fetch(
        `${baseUrl}/cases/case-api/sessions/session-api/entries?afterSequence=0&limit=20`
    ).then(response => response.json());
    assert.ok(sessionEntries.items.some(entry => entry.type === 'decision'));
    assert.ok(sessionEntries.items.some(entry => entry.type === 'run-link'));
    assert.equal(validateComponent('SessionEntryPage', sessionEntries).valid, true);

    const events = await fetch(
        `${baseUrl}/runs/run-api/events?caseId=case-api&afterSequence=0&fromFrame=4&toFrame=4&eventType=ResourceChanged&actorId=actor-api&rootCastId=root%3Aapi&limit=1`
    ).then(response => response.json());
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0].transition.after, 1);
    assert.equal(validateComponent('EventPage', events).valid, true);
    const state = await fetch(`${baseUrl}/runs/run-api/state?caseId=case-api&frame=4`)
        .then(response => response.json());
    assert.equal(state.state.resources.Atb.value, 1);
    assert.equal(state.proof.exact, true);
    assert.equal(validateComponent('StateResponse', state).valid, true);
    assert.equal(validateComponent('UiActionAccepted', uiAccepted).valid, true);
    assert.equal(validateComponent('SessionEntry', decision).valid, true);
});

test('SSE streams appended events, emits completion/interruption and resumes with Last-Event-ID', async t => {
    const { archive, baseUrl } = await setup(t);
    const live = await newWriter(archive, 'run-live');
    const liveResponse = await fetch(`${baseUrl}/runs/run-live/stream?caseId=case-api`);
    assert.equal(liveResponse.status, 200);
    assert.match(liveResponse.headers.get('content-type'), /text\/event-stream/);
    await append(live.writer, live.normalizer, 'runtime', {
        frame: 1, stage: 'FirstFact', sourceId: 'actor-a'
    });
    await append(live.writer, live.normalizer, 'runtime', {
        frame: 2, stage: 'SecondFact', sourceId: 'actor-b'
    });
    await live.writer.seal({ result: { ok: true } });
    const liveText = await liveResponse.text();
    assert.match(liveText, /event: stream-ready/);
    assert.match(liveText, /id: 1\nevent: ria-event/);
    assert.match(liveText, /id: 2\nevent: ria-event/);
    assert.match(liveText, /event: run-complete/);
    const openapi = await fetch(`${baseUrl}/openapi.json`).then(response => response.json());
    const validateComponent = createOpenApiSchemaValidator(openapi);
    const liveMessages = parseSseDocument(liveText);
    const readyMessage = liveMessages.find(message => message.event === 'stream-ready');
    const eventMessages = liveMessages.filter(message => message.event === 'ria-event');
    const terminalMessage = liveMessages.find(message => message.event === 'run-complete');
    assert.equal(validateComponent('SseReady', readyMessage.data).valid, true);
    assert.ok(eventMessages.every(message => validateComponent('Event', message.data).valid));
    assert.equal(validateComponent('SseTerminal', terminalMessage.data).valid, true);

    const resumed = await fetch(`${baseUrl}/runs/run-live/stream?caseId=case-api`, {
        headers: { 'Last-Event-ID': '1' }
    }).then(response => response.text());
    assert.doesNotMatch(resumed, /id: 1\nevent: ria-event/);
    assert.match(resumed, /id: 2\nevent: ria-event/);
    assert.match(resumed, /event: run-complete/);

    const interrupted = await newWriter(archive, 'run-interrupted');
    await append(interrupted.writer, interrupted.normalizer, 'runtime', {
        frame: 0, stage: 'RunStarted'
    });
    await interrupted.writer.seal({ status: 'interrupted', result: { ok: false } });
    const interruptedText = await fetch(
        `${baseUrl}/runs/run-interrupted/stream?caseId=case-api&afterSequence=0`
    ).then(response => response.text());
    assert.match(interruptedText, /event: run-interrupted/);
});

test('SSE closes the deterministic read-to-subscribe gap without losing the tail or terminal', async t => {
    const { archive, baseUrl } = await setup(t);
    const { writer, normalizer } = await newWriter(archive, 'run-subscribe-gap');
    const getRun = archive.getRun.bind(archive);
    let finishQueries = 0;
    archive.getRun = async (...arguments_) => {
        const staleManifest = await getRun(...arguments_);
        finishQueries += 1;
        if (finishQueries === 1) {
            await append(writer, normalizer, 'runtime', {
                frame: 1,
                stage: 'TailWrittenInsideOldSubscriptionGap',
                sourceId: 'actor-gap'
            });
            await writer.seal({ result: { ok: true } });
        }
        return staleManifest;
    };

    const response = await fetch(
        `${baseUrl}/runs/run-subscribe-gap/stream?caseId=case-api`
    );
    const iterator = sseMessages(response);
    const ready = await nextSse(iterator, 1_000);
    const event = await nextSse(iterator, 1_000);
    const terminal = await nextSse(iterator, 1_000);
    assert.deepEqual({
        finishQueries,
        ready: ready.value.event,
        event: event.value.event,
        eventId: event.value.id,
        terminal: terminal.value.event
    }, {
        finishQueries: 2,
        ready: 'stream-ready',
        event: 'ria-event',
        eventId: 1,
        terminal: 'run-complete'
    });
    assert.equal((await nextSse(iterator, 1_000)).done, true);
});

test('cross-process SSE reconciliation closes the deterministic initial file-watch gap', async t => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-watch-gap-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const writerArchive = await new RiaArchive({
        projectRoot, archiveRoot, syncEveryRecords: 1
    }).initialize();
    await writerArchive.createCase({ caseId: 'case-watch-gap', title: 'Watch gap' });
    await writerArchive.createSession({
        caseId: 'case-watch-gap', sessionId: 'session-watch-gap'
    });
    const writer = await writerArchive.startRun({
        caseId: 'case-watch-gap', sessionId: 'session-watch-gap', runId: 'run-watch-gap',
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-watch-gap', sessionId: 'session-watch-gap', runId: 'run-watch-gap'
    });

    const readerArchive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    const getRun = readerArchive.getRun.bind(readerArchive);
    let finishQueries = 0;
    readerArchive.getRun = async (...arguments_) => {
        const staleManifest = await getRun(...arguments_);
        finishQueries += 1;
        if (finishQueries === 1) {
            await append(writer, normalizer, 'runtime', {
                frame: 1,
                stage: 'CrossProcessTailInsideOldWatchGap',
                sourceId: 'actor-watch-gap'
            });
            await writer.seal({ result: { ok: true } });
        }
        return staleManifest;
    };
    const service = createRiaServer({ archive: readerArchive, port: 0 });
    const address = await service.listen();
    t.after(() => service.close());

    const response = await fetch(
        `${address.url}/api/ria/runs/run-watch-gap/stream?caseId=case-watch-gap`
    );
    const messages = [];
    for await (const message of sseMessages(response)) messages.push(message);
    assert.deepEqual({
        finishQueries,
        events: messages.filter(message => message.event === 'ria-event').map(message => message.id),
        terminal: messages.at(-1)?.event
    }, {
        finishQueries: 2,
        events: [1],
        terminal: 'run-complete'
    });
});

test('RIA accepts JSON UI-action preflight only from an explicit loopback UI origin', async t => {
    const { baseUrl } = await setup(t);
    const response = await fetch(`${baseUrl}/runs/run-cors/ui-actions?caseId=case-api`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://127.0.0.1:43821',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    assert.deepEqual({
        status: response.status,
        origin: response.headers.get('access-control-allow-origin'),
        methods: response.headers.get('access-control-allow-methods'),
        headers: response.headers.get('access-control-allow-headers')
    }, {
        status: 204,
        origin: 'http://127.0.0.1:43821',
        methods: 'POST',
        headers: 'Content-Type'
    });

    const denied = await fetch(`${baseUrl}/runs/run-cors/ui-actions?caseId=case-api`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://attacker.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('a real stream-error payload validates against its declared OpenAPI component', async t => {
    const { archive, baseUrl } = await setup(t);
    await newWriter(archive, 'run-stream-error');
    const response = await fetch(
        `${baseUrl}/runs/run-stream-error/stream?caseId=case-api`
    );
    const iterator = sseMessages(response);
    assert.equal((await nextSse(iterator)).value.event, 'stream-ready');

    archive.queryEvents = async () => {
        const error = new Error('deterministic stream query failure');
        error.code = 'RIA_TEST_STREAM_FAILURE';
        throw error;
    };
    archive.emit({ type: 'event', runId: 'run-stream-error' });
    const streamError = await nextSse(iterator);
    assert.equal(streamError.value.event, 'stream-error');

    const openapi = await fetch(`${baseUrl}/openapi.json`).then(item => item.json());
    const declaration = openapi.paths['/api/ria/runs/{runId}/stream']
        .get.responses['200']['x-sse-events']
        .find(item => item.event === 'stream-error');
    const schemaName = declaration.payload.$ref.split('/').at(-1);
    const validation = createOpenApiSchemaValidator(openapi)(schemaName, streamError.value.data);
    assert.deepEqual({
        schemaName,
        payload: streamError.value.data,
        contractValid: validation.valid
    }, {
        schemaName: 'SseError',
        payload: {
            error: {
                code: 'RIA_TEST_STREAM_FAILURE',
                message: 'deterministic stream query failure',
                details: null
            }
        },
        contractValid: true
    });
});

test('HTTP boundary rejects traversal, unknown replay fields, oversized bodies and remote binds', async t => {
    const { archive, baseUrl } = await setup(t, { maxBodyBytes: 256 });
    assert.throws(() => createRiaServer({
        archive,
        host: '0.0.0.0',
        port: 0
    }), error => error.code === 'RIA_REMOTE_BIND_DENIED');

    const traversal = await fetch(`${baseUrl}/runs/%2e%2e%2fescape?caseId=case-api`);
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).error.code, 'RIA_INVALID_ID');

    const { writer } = await newWriter(archive, 'run-security');
    await writer.seal({ result: { ok: true } });
    const replayInjection = await fetch(
        `${baseUrl}/runs/run-security/replay?caseId=case-api`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'rm -rf /' })
        }
    );
    assert.equal(replayInjection.status, 400);
    const replayError = await replayInjection.json();
    assert.equal(replayError.error.code, 'RIA_SCHEMA_INVALID');

    const oversized = await fetch(`${baseUrl}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(1000) })
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'RIA_REQUEST_TOO_LARGE');
});

test('a real replay streams persisted runtime events before its job completes and resumes exactly', async t => {
    const { archive, baseUrl } = await setup(t, { maxBodyBytes: 16 * 1024 });
    const fixture = JSON.parse(await fs.readFile(
        path.join(projectRoot, 'fixtures', 'ria', 'pelica-normal-skill.json'),
        'utf8'
    ));
    await recordFixtureRun({
        archive,
        caseId: 'case-api',
        sessionId: 'session-api',
        runId: 'run-real-source',
        fixture
    });

    const liveAbort = new AbortController();
    t.after(() => liveAbort.abort());
    const liveResponse = await fetch(
        `${baseUrl}/runs/run-real-replay/stream?caseId=case-api`,
        { signal: liveAbort.signal }
    );
    const iterator = sseMessages(liveResponse);
    const ready = await nextSse(iterator);
    assert.equal(ready.value.event, 'stream-ready');
    assert.equal(ready.value.data.waitingForRun, true);

    const accepted = await fetch(
        `${baseUrl}/runs/run-real-source/replay?caseId=case-api`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replayRunId: 'run-real-replay' })
        }
    ).then(response => response.json());
    const received = [];
    while (received.length < 5) {
        // The full root suite runs CPU-heavy AKE audits in parallel. Keep the
        // assertion bounded, but allow the real worker checkpoint enough time
        // to reach the event loop under that documented load.
        const message = await nextSse(iterator, 30_000);
        if (message.value.event === 'ria-event') received.push(message.value);
    }
    assert.deepEqual(received.map(message => message.id), [1, 2, 3, 4, 5]);
    assert.ok(received.every(message => message.data.source.authority === 'runtime-fact'));
    const jobUrl = `${new URL(baseUrl).origin}${accepted.statusUrl}`;
    const running = await fetch(jobUrl).then(response => response.json());
    assert.equal(running.status, 'running', 'the Worker checkpoint must keep replay active');
    const lastEventId = received.at(-1).id;
    liveAbort.abort();
    await iterator.return().catch(() => {});

    const resumedText = await fetch(
        `${baseUrl}/runs/run-real-replay/stream?caseId=case-api`,
        { headers: { 'Last-Event-ID': String(lastEventId) } }
    ).then(response => response.text());
    const resumedIds = [...resumedText.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    assert.ok(resumedIds.length > 5);
    assert.equal(resumedIds[0], lastEventId + 1);
    assert.ok(resumedIds.every(sequence => sequence > lastEventId));
    assert.match(resumedText, /event: run-complete/);
    const completed = await waitUntil(async () => {
        const job = await fetch(jobUrl).then(response => response.json());
        return job.status === 'completed' ? job : null;
    }, 15_000);
    assert.equal(completed.result.deterministic, true);
});

test('cross-process-style file watching tails from the last byte offset', async t => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-cross-process-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const writerArchive = await new RiaArchive({
        projectRoot, archiveRoot, syncEveryRecords: 1
    }).initialize();
    await writerArchive.createCase({ caseId: 'case-tail', title: 'Incremental tail' });
    await writerArchive.createSession({ caseId: 'case-tail', sessionId: 'session-tail' });
    const writer = await writerArchive.startRun({
        caseId: 'case-tail', sessionId: 'session-tail', runId: 'run-tail',
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-tail', sessionId: 'session-tail', runId: 'run-tail'
    });

    const readerArchive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    const diagnostics = [];
    const queryEvents = readerArchive.queryEvents.bind(readerArchive);
    readerArchive.queryEvents = async (...arguments_) => {
        const page = await queryEvents(...arguments_);
        diagnostics.push(page.page.diagnostics);
        return page;
    };
    const service = createRiaServer({ archive: readerArchive, port: 0 });
    const address = await service.listen();
    t.after(() => service.close());
    const response = await fetch(
        `${address.url}/api/ria/runs/run-tail/stream?caseId=case-tail`
    );
    const responseText = response.text();

    await append(writer, normalizer, 'runtime', {
        frame: 1, stage: 'FirstCrossProcessFact', sourceId: 'actor-tail'
    });
    await waitUntil(() => diagnostics.some(item => item.recordsDecoded >= 1));
    await append(writer, normalizer, 'runtime', {
        frame: 2, stage: 'SecondCrossProcessFact', sourceId: 'actor-tail'
    });
    await waitUntil(() => diagnostics.some(item => (
        item.startOffset > 0 && item.recordsDecoded >= 1
    )));
    await writer.seal({ result: { ok: true } });
    const text = await responseText;
    assert.match(text, /id: 1\nevent: ria-event/);
    assert.match(text, /id: 2\nevent: ria-event/);
    assert.match(text, /event: run-complete/);
    const incremental = diagnostics.find(item => item.startOffset > 0 && item.recordsDecoded >= 1);
    assert.ok(incremental.bytesScanned < incremental.fileBytes);
    assert.ok(incremental.recordsDecoded <= 2);
});

test('SSE closes a slow consumer immediately and a Worker crash emits interruption', async t => {
    let cleanupCalls = 0;
    let endCalls = 0;
    const accepted = await writeSseWithBackpressure({
        write: () => false,
        end: () => { endCalls += 1; }
    }, 'event: ria-event\n\n', {
        drainTimeoutMs: 0,
        onSlowConsumer: () => { cleanupCalls += 1; }
    });
    assert.equal(accepted, false);
    assert.equal(cleanupCalls, 1);
    assert.equal(endCalls, 1);

    const { archive, baseUrl } = await setup(t, { maxBodyBytes: 16 * 1024 });
    const fixture = JSON.parse(await fs.readFile(
        path.join(projectRoot, 'fixtures', 'ria', 'pelica-normal-skill.json'),
        'utf8'
    ));
    const stream = await fetch(`${baseUrl}/runs/run-crashed-worker/stream?caseId=case-api`);
    const streamText = stream.text();
    await assert.rejects(recordFixtureRun({
        archive,
        caseId: 'case-api',
        sessionId: 'session-api',
        runId: 'run-crashed-worker',
        fixture,
        workerDataExtras: { testCrashBeforeExecution: true }
    }), error => error.code === 'RIA_WORKER_CRASH');
    const interrupted = await streamText;
    assert.match(interrupted, /event: ria-event/);
    assert.match(interrupted, /"eventType":"RunInterrupted"/);
    assert.match(interrupted, /event: run-interrupted/);
});
