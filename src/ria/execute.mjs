import { simulateSquadDemo } from '../../demo/demo-service.mjs';
import { Worker } from 'node:worker_threads';
import { hashJson, RiaConflictError, RiaInputError } from './common.mjs';
import { RiaEventNormalizer, normalizeForDiff, reportProjectionFacts } from './normalize.mjs';

const EXECUTORS = Object.freeze({
    'ake-squad-demo': ({ input, projectRoot, traceSink }) => simulateSquadDemo(input, {
        projectRoot,
        traceSink
    })
});

export const RIA_EXECUTOR_IDS = Object.freeze(Object.keys(EXECUTORS));

/** A serialized, warm browser worker. Recording/replay retain isolated workers. */
export function createFixtureWorkerExecutor({ projectRoot }) {
    let worker = null;
    let tail = Promise.resolve();
    const warm = () => {
        if (!worker) {
            worker = new Worker(new URL('./fixture-worker.mjs', import.meta.url), {
                execArgv: [], workerData: { reusable: true, projectRoot },
            });
            const current = worker;
            current.on('error', () => { if (worker === current) worker = null; });
            current.on('exit', () => { if (worker === current) worker = null; });
            current.unref();
        }
        return worker;
    };
    const execute = options => {
        const pending = tail.then(async () => {
            const current = warm();
            current.ref();
            try { return await executeFixtureWorker({ ...options, reusableWorker: current }); }
            catch (error) {
                if (worker === current) worker = null;
                await current.terminate();
                throw error;
            } finally { current.unref(); }
        });
        tail = pending.catch(() => {});
        return pending;
    };
    execute.warm = warm;
    execute.close = async () => { await tail; if (worker) await worker.terminate(); worker = null; };
    return execute;
}

export function executeFixtureWorker({
    fixture,
    projectRoot,
    seed = null,
    traceSink,
    traceCheckpoint = async () => {},
    onResultReady = () => {},
    reusableWorker = null,
    workerUrl = new URL('./fixture-worker.mjs', import.meta.url),
    workerDataExtras = {}
} = {}) {
    validateReplayFixture(fixture);
    if (typeof traceSink !== 'function') throw new TypeError('traceSink must be a function.');
    if (typeof traceCheckpoint !== 'function') {
        throw new TypeError('traceCheckpoint must be a function.');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let receivedResult = false;
        let readyResult;
        const checkpointBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
        const checkpointState = new Int32Array(checkpointBuffer);
        const data = { adapter: fixture.adapter, input: structuredClone(fixture.input), projectRoot, seed,
            traceCheckpointBuffer: checkpointBuffer, ...workerDataExtras };
        const worker = reusableWorker ?? new Worker(workerUrl, {
            // Do not inherit the parent test runner/debugger flags. Node exposes
            // several valid process flags in execArgv which Worker deliberately
            // rejects, and the replay adapter does not require any of them.
            execArgv: [],
            workerData: data
        });
        const cleanup = () => {
            worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onMessage = message => {
            if (message?.type === 'trace') {
                try {
                    traceSink(message.packet);
                } catch {
                    // The writer owns trace failure/backpressure diagnostics.
                }
                return;
            }
            if (message?.type === 'trace-checkpoint') {
                Promise.resolve()
                    .then(() => traceCheckpoint(message.ordinal))
                    .catch(fail)
                    .finally(() => {
                        Atomics.store(checkpointState, 0, 1);
                        Atomics.notify(checkpointState, 0, 1);
                    });
                return;
            }
            if (message?.type === 'result-ready') {
                readyResult = message.result;
                onResultReady(readyResult);
                return;
            }
            if (message?.type === 'result' || message?.type === 'trace-complete') {
                receivedResult = true;
                if (!settled) {
                    settled = true;
                    cleanup();
                    const result = message.type === 'result' ? message.result : readyResult;
                    if (message.type === 'result') onResultReady(result);
                    resolve(result);
                }
                return;
            }
            if (message?.type === 'execution-error') {
                const error = new Error(message.error?.message ?? 'RIA worker execution failed.');
                error.name = message.error?.name ?? 'Error';
                error.code = message.error?.code ?? 'RIA_WORKER_EXECUTION_FAILED';
                fail(error);
            }
        };
        const onError = error => {
            error.code = error.code ?? 'RIA_WORKER_CRASH';
            fail(error);
        };
        const onExit = code => {
            if (!settled && (!receivedResult || code !== 0)) {
                const error = new Error(`RIA fixture worker exited with code ${code}.`);
                error.code = 'RIA_WORKER_EXIT';
                fail(error);
            }
        };
        worker.on('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
        if (reusableWorker) worker.postMessage(data);
    });
}

export function validateReplayFixture(fixture) {
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
        throw new RiaInputError('RIA fixture must be an object.');
    }
    if (!Object.prototype.hasOwnProperty.call(EXECUTORS, fixture.adapter)) {
        throw new RiaInputError(
            `Unsupported fixture adapter '${String(fixture.adapter)}'. Allowed: ${RIA_EXECUTOR_IDS.join(', ')}.`,
            'RIA_ADAPTER_NOT_ALLOWED'
        );
    }
    if (!fixture.input || typeof fixture.input !== 'object' || Array.isArray(fixture.input)) {
        throw new RiaInputError('RIA fixture.input must be an object.');
    }
    return fixture;
}

function deterministicAssertion(result, expectedResult) {
    const actualHash = hashJson(normalizeForDiff(result));
    if (expectedResult === null || expectedResult === undefined) {
        return {
            passed: true,
            checks: [{
                assertionId: 'result-normalized-hash-recorded',
                passed: true,
                actualHash,
                expectedHash: null,
                detail: 'Initial recording establishes the normalized result hash.'
            }]
        };
    }
    const expectedHash = hashJson(normalizeForDiff(expectedResult));
    return {
        passed: actualHash === expectedHash,
        checks: [{
            assertionId: 'replay-normalized-result-equality',
            passed: actualHash === expectedHash,
            actualHash,
            expectedHash,
            detail: actualHash === expectedHash
                ? 'Replay result matches the recorded normalized result.'
                : 'Replay result diverges from the recorded normalized result.'
        }]
    };
}

export async function startFixtureRunExecution({
    archive,
    caseId,
    sessionId,
    runId = undefined,
    fixture,
    config = {},
    seed = null,
    uiActions = [],
    expectedResult = null,
    findings = '',
    executeWorker = executeFixtureWorker,
    workerUrl = undefined,
    workerDataExtras = {}
} = {}) {
    validateReplayFixture(fixture);
    const writer = await archive.startRun({
        caseId,
        sessionId,
        ...(runId === undefined ? {} : { runId }),
        fixture,
        config,
        seed,
        uiActions
    });
    const normalizer = new RiaEventNormalizer({
        caseId,
        sessionId,
        runId: writer.reference.runId,
        projectRoot: archive.projectRoot
    });
    const traceSink = writer.traceSink({
        maxPending: Number(config.maxPendingTraceWrites ?? 100_000),
        normalize: packet => normalizer.normalize(packet.source, packet.fact)
    });
    let resolveResult;
    let rejectResult;
    const resultReady = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    resultReady.catch(() => {});
    const execution = (async () => {
        try {
            const result = await executeWorker({
                fixture,
                projectRoot: archive.projectRoot,
                traceSink,
                // The worker pauses at bounded trace windows until every preceding
                // fact has reached the append-only file. This is backpressure, and
                // also guarantees the HTTP/SSE loop can expose persisted facts
                // while the worker is still executing.
                traceCheckpoint: () => writer.drain(),
                onResultReady: resolveResult,
                seed,
                ...(workerUrl ? { workerUrl } : {}),
                workerDataExtras: { deferTraceUntilResult: config.uiCalculation === true, ...workerDataExtras }
            });
            for (const projection of reportProjectionFacts(result)) {
                for (const event of normalizer.normalize(projection.source, projection.fact)) {
                    writer.appendEvent(event).catch(() => {});
                }
            }
            await writer.drain();
            const assertions = deterministicAssertion(result, expectedResult);
            return { result, assertions };
        } catch (error) {
            rejectResult(error);
            await writer.drain();
            for (const event of normalizer.normalize('archive.recording', {
                frame: 0,
                stage: 'RunInterrupted',
                type: 'RunInterrupted',
                reason: error.code ?? error.name ?? 'ExecutionError',
                message: String(error.message ?? error).slice(0, 4000)
            })) {
                await writer.appendEvent(event).catch(() => {});
            }
            await writer.drain();
            throw error;
        }
    })();
    // A UI-controlled calculation may not attach its response waiter until the
    // HTTP start acknowledgement has been delivered. Keep that deliberate gap
    // from becoming an unhandled rejection while retaining the original promise.
    execution.catch(() => {});

    let sealPromise = null;
    const seal = () => {
        if (sealPromise) return sealPromise;
        sealPromise = (async () => {
            let completed;
            try {
                completed = await execution;
            } catch (error) {
                const manifest = await writer.seal({
                    status: 'interrupted',
                    result: {
                        schemaVersion: 1,
                        status: 'interrupted',
                        error: {
                            name: error.name ?? 'Error',
                            code: error.code ?? null,
                            message: String(error.message ?? error).slice(0, 4000)
                        }
                    },
                    assertions: {
                        passed: false,
                        checks: [{
                            assertionId: 'run-completed',
                            passed: false,
                            detail: String(error.message ?? error).slice(0, 4000)
                        }]
                    },
                    findings,
                    error
                });
                error.riaRun = {
                    caseId,
                    sessionId,
                    runId: writer.reference.runId,
                    manifest
                };
                throw error;
            }
            const manifest = await writer.seal({
                status: completed.assertions.passed ? 'completed' : 'partial',
                result: completed.result,
                assertions: completed.assertions,
                findings
            });
            return {
                caseId,
                sessionId,
                runId: writer.reference.runId,
                manifest,
                result: completed.result,
                assertions: completed.assertions
            };
        })();
        return sealPromise;
    };

    return {
        caseId,
        sessionId,
        runId: writer.reference.runId,
        writer,
        resultReady,
        execution,
        seal
    };
}

export async function recordFixtureRun(options = {}) {
    const execution = await startFixtureRunExecution(options);
    return execution.seal();
}

export async function replayArchivedRun({
    archive,
    runId,
    caseId = null,
    sessionId = null,
    replayRunId = undefined,
    config = {}
} = {}) {
    const reference = await archive.locateRun(runId, caseId);
    const caseDocument = await archive.getCase(reference.caseId);
    if (caseDocument.status !== 'open') {
        throw new RiaConflictError(
            `Case ${reference.caseId} is closed.`,
            'RIA_CASE_CLOSED'
        );
    }
    if (!reference.manifest.sealed) {
        throw new RiaInputError('Only sealed runs can be replayed.', 'RIA_REPLAY_UNSEALED');
    }
    const [fixture, expectedResult] = await Promise.all([
        archive.readRunArtifact(runId, 'fixture', reference.caseId),
        archive.readRunArtifact(runId, 'result', reference.caseId)
    ]);
    validateReplayFixture(fixture);
    const targetSessionId = sessionId ?? reference.sessionId;
    await archive.getSession(reference.caseId, targetSessionId);
    const replay = await recordFixtureRun({
        archive,
        caseId: reference.caseId,
        sessionId: targetSessionId,
        runId: replayRunId,
        fixture,
        expectedResult,
        seed: reference.manifest.seed,
        config: {
            ...config,
            replayOfRunId: runId,
            explicitRecording: true
        },
        findings: `Replay of ${runId}.\n`
    });
    const diff = await archive.diffRuns(runId, replay.runId, {
        leftCaseId: reference.caseId,
        rightCaseId: reference.caseId
    });
    return {
        sourceRunId: runId,
        replayRunId: replay.runId,
        deterministic: replay.assertions.passed
            && diff.eventsIdentical
            && diff.resultsIdentical,
        assertions: replay.assertions,
        diff,
        manifest: replay.manifest
    };
}
