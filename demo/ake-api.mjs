import { DemoInputError, getDemoCatalog, simulateDemo, simulateSquadDemo } from './demo-service.mjs';
import { RiaArchive } from '../src/ria/archive.mjs';
import { hashJson, newRiaId, RiaError, RiaInputError } from '../src/ria/common.mjs';
import { createFixtureWorkerExecutor, startFixtureRunExecution } from '../src/ria/execute.mjs';
import { createRiaServer } from '../src/ria/server.mjs';
import { LIVE_DEBUG_CAPABILITIES, RiaLiveDebug } from '../src/ria/live-debug.mjs';
import path from 'node:path';
import { serveAkeImageAsset } from './ake-image-assets.mjs';

function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
}
async function readJson(request, maximum = 1_000_000) {
    const chunks = []; let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > maximum) throw new RiaError('Request body too large.', 'RIA_REQUEST_TOO_LARGE', 413);
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new RiaInputError('Invalid JSON.'); }
}
function requireLocal(request) {
    const host = request.headers.host;
    const hostname = new URL(`http://${host}`).hostname;
    const remote = request.socket.remoteAddress;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
        || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
        || request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.origin && new URL(request.headers.origin).host !== host)) {
        throw new RiaError('Debug API only accepts local, same-origin requests.', 'RIA_ORIGIN_DENIED', 403);
    }
}

/** One API implementation for Vite and the built demo, including RIA reads and live observation. */
export function createAkeDemoApi({ projectRoot, publicRoot = path.join(projectRoot, 'demo/lts-ui/public'), archiveRoot = process.env.RIA_ARCHIVE_ROOT || null, logger = console } = {}) {
    const executeWorker = createFixtureWorkerExecutor({ projectRoot });
    let servicesPromise;
    const services = () => servicesPromise ??= (async () => {
        const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
        return { archive, live: new RiaLiveDebug(archive), rest: createRiaServer({ archive }) };
    })();
    const runs = new Map();
    const keyFor = (caseId, runId) => `${caseId}\0${runId}`;
    const seal = async key => {
        const run = runs.get(key);
        if (!run) return null;
        clearTimeout(run.timeout);
        try { return await run.controller.seal(); }
        catch (error) { if (error.riaRun) return error.riaRun; throw error; }
        finally { runs.delete(key); }
    };
    return {
        async close() { await Promise.allSettled([...runs.keys()].map(seal)); await executeWorker.close(); },
        async handle(request, response) {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (url.pathname.startsWith('/assets/ake-icons/')) {
                return serveAkeImageAsset(request, response, publicRoot, url.pathname);
            }
            if (!url.pathname.startsWith('/api/')) return false;
            try {
                if (url.pathname.startsWith('/api/ria') || url.pathname.startsWith('/api/ake/ria')
                    || request.headers['x-ria-run-id']) requireLocal(request);
                if (url.pathname.startsWith('/api/ria/live/')) {
                    const { live } = await services();
                    const route = url.pathname.slice('/api/ria/live/'.length).split('/').map(decodeURIComponent);
                    if (route[0] === 'capabilities' && request.method === 'GET') { sendJson(response, 200, LIVE_DEBUG_CAPABILITIES); return true; }
                    if (route[0] === 'connect' && request.method === 'POST') { sendJson(response, 201, await live.connect(await readJson(request))); return true; }
                    if (route[0] === 'sessions' && route.length === 1 && request.method === 'GET') { sendJson(response, 200, { items: await live.list() }); return true; }
                    if (route[0] === 'sessions' && route.length >= 3) {
                        const id = route[1]; const action = route[2];
                        if (action === 'ingest' && request.method === 'POST') { sendJson(response, 202, await live.ingest(id, await readJson(request, 4_194_304))); return true; }
                        if (action === 'snapshot' && request.method === 'GET') {
                            const snapshot = await live.snapshot(id);
                            const section = url.searchParams.get('section');
                            sendJson(response, 200, section ? { ...snapshot, sections: { [section]: snapshot.sections[section] ?? null } } : snapshot); return true;
                        }
                        if (action === 'events' && request.method === 'GET') { sendJson(response, 200, await live.events(id, Object.fromEntries(url.searchParams))); return true; }
                        if (action === 'commands') {
                            if (route.length === 3 && request.method === 'POST') { sendJson(response, 202, await live.enqueue(id, await readJson(request))); return true; }
                            if (route.length === 4 && request.method === 'POST') { sendJson(response, 200, await live.complete(id, route[3], await readJson(request, 4_194_304))); return true; }
                            if (request.method === 'GET') {
                                const session = await live.get(id);
                                const items = session.commands.filter(item => (!route[3] || item.id === route[3])
                                    && (!url.searchParams.has('status') || item.status === url.searchParams.get('status')));
                                sendJson(response, 200, { items }); return true;
                            }
                        }
                    }
                    throw new RiaError('Live debug route not found.', 'RIA_ROUTE_NOT_FOUND', 404);
                }
                if (request.method === 'POST' && url.pathname === '/api/ake/ria/start') {
                    const body = await readJson(request);
                    const runId = body.runId ?? newRiaId('run');
                    const key = keyFor(body.caseId, runId);
                    if (runs.has(key)) throw new RiaError('Run already exists.', 'RIA_RUN_EXISTS', 409);
                    const { archive } = await services();
                    const controller = await startFixtureRunExecution({ archive, executeWorker, caseId: body.caseId, sessionId: body.sessionId, runId,
                        fixture: { adapter: 'ake-squad-demo', input: body.input },
                        config: { explicitRecording: true, uiCalculation: true, integration: 'lts-ui-ake-provider', executionDigest: body.executionDigest ?? null },
                        findings: 'Exact LTS UI calculation input and output. Browser observations are in the linked Session.\n' });
                    // A closed/aborted tab must not leave a writer open indefinitely.
                    const timeout = setTimeout(() => { void seal(key).catch(error => logger.error(error)); }, 60_000);
                    timeout.unref?.();
                    runs.set(key, { controller, inputHash: hashJson(body.input), timeout });
                    sendJson(response, 202, { accepted: true, caseId: body.caseId, sessionId: body.sessionId, runId }); return true;
                }
                if (request.method === 'POST' && url.pathname === '/api/ake/ria/seal') {
                    const body = await readJson(request);
                    const sealed = await seal(keyFor(body.caseId, body.runId));
                    if (!sealed) {
                        const { archive } = await services();
                        const reference = await archive.locateRun(body.runId, body.caseId);
                        if (!reference.manifest.sealed) throw new RiaError('Run is not owned by this server.', 'RIA_RUN_NOT_ACTIVE', 409);
                        sendJson(response, 200, { sealed: true, runId: body.runId, status: reference.manifest.status });
                    } else sendJson(response, 200, { sealed: true, runId: body.runId, status: sealed.manifest.status });
                    return true;
                }
                const uiAction = /^\/api\/ria\/runs\/([^/]+)\/ui-actions$/.exec(url.pathname);
                if (uiAction && request.method === 'POST') {
                    sendJson(response, 202, await (await services()).archive.appendRunUiAction(
                        decodeURIComponent(uiAction[1]), await readJson(request), url.searchParams.get('caseId')));
                    return true;
                }
                if (url.pathname.startsWith('/api/ria/')) { await (await services()).rest.handleRequest(request, response); return true; }
                if (request.method === 'GET' && url.pathname === '/api/health') { sendJson(response, 200, { ok: true, frontend: 'lts-reuse', engine: 'ake', debug: '/api/ria/live/capabilities' }); return true; }
                if (request.method === 'GET' && ['/api/catalog', '/api/ake/catalog'].includes(url.pathname)) { executeWorker.warm(); sendJson(response, 200, getDemoCatalog({ projectRoot })); return true; }
                if (request.method === 'POST' && url.pathname === '/api/ake/squad/simulate') {
                    const input = await readJson(request);
                    const runId = request.headers['x-ria-run-id'];
                    if (runId) {
                        const run = runs.get(keyFor(request.headers['x-ria-case-id'], runId));
                        if (!run || run.inputHash !== hashJson(input)) throw new RiaInputError('RIA Run is absent or its fixture differs from this request.');
                        if (process.env.RIA_UI_E2E_FAIL_DELIVERY_RUN_ID === runId) { sendJson(response, 502, { error: 'Injected browser delivery failure.' }); return true; }
                        const result = await run.controller.resultReady;
                        sendJson(response, 200, result);
                    } else sendJson(response, 200, simulateSquadDemo(input, { projectRoot }));
                    return true;
                }
                if (request.method === 'POST' && ['/api/simulate', '/api/ake/simulate'].includes(url.pathname)) { sendJson(response, 200, simulateDemo(await readJson(request), { projectRoot })); return true; }
                return false;
            } catch (error) {
                if (response.headersSent) { response.destroy(error); return true; }
                const status = error.statusCode ?? (error instanceof DemoInputError ? 400 : 500);
                logger.error(error);
                sendJson(response, status, { error: url.pathname.includes('/ria/')
                    ? { code: error.code ?? 'AKE_API_ERROR', message: error.message } : error.message });
                return true;
            }
        },
    };
}
