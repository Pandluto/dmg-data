import { parentPort, workerData } from 'node:worker_threads';

import { getDemoCatalog, simulateSquadDemo } from '../../demo/demo-service.mjs';

const EXECUTORS = Object.freeze({
    'ake-squad-demo': ({ input, projectRoot, traceSink }) => simulateSquadDemo(input, {
        projectRoot,
        traceSink
    })
});

const TRACE_CHECKPOINT_INTERVAL = 64;

function serializedError(error) {
    return {
        name: String(error?.name ?? 'Error'),
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 4000)
    };
}

async function main(data) {
    const checkpointState = data?.traceCheckpointBuffer ? new Int32Array(data.traceCheckpointBuffer) : null;
    function checkpoint(ordinal) {
        if (!checkpointState || ordinal === 0) return;
        Atomics.store(checkpointState, 0, 0);
        parentPort.postMessage({ type: 'trace-checkpoint', ordinal });
        Atomics.wait(checkpointState, 0, 0);
    }
    if (data?.testCrashBeforeExecution === true) {
        throw new Error('Injected RIA worker crash before execution.');
    }
    const execute = EXECUTORS[data.adapter];
    if (!execute) throw new Error(`Worker adapter is not allowed: ${String(data.adapter)}`);
    let traceOrdinal = 0;
    // Browser calculations publish their result before archive backpressure.
    // Buffer actual trace packets (never rerun the engine), with a bounded
    // window that falls back to the normal durable streaming path if full.
    const deferredTrace = data.deferTraceUntilResult ? [] : null;
    const emitTrace = (packet, durable = true) => {
        parentPort.postMessage({ type: 'trace', packet });
        traceOrdinal += 1;
        if (durable && traceOrdinal % TRACE_CHECKPOINT_INTERVAL === 0) checkpoint(traceOrdinal);
    };
    const flushTrace = (durable = true) => {
        for (const packet of deferredTrace ?? []) emitTrace(packet, durable);
        if (deferredTrace) deferredTrace.length = 0;
    };
    try {
        const result = await execute({
            input: data.input,
            projectRoot: data.projectRoot,
            seed: data.seed,
            traceSink: packet => {
                if (deferredTrace) {
                    deferredTrace.push(packet);
                    if (deferredTrace.length >= 32_768) flushTrace();
                } else emitTrace(packet);
                return true;
            }
        });
        if (deferredTrace) parentPort.postMessage({ type: 'result-ready', result });
        flushTrace(!deferredTrace);
        if (!deferredTrace && traceOrdinal % TRACE_CHECKPOINT_INTERVAL !== 0) checkpoint(traceOrdinal);
        parentPort.postMessage(deferredTrace ? { type: 'trace-complete' } : { type: 'result', result });
    } catch (error) {
        flushTrace();
        if (traceOrdinal % TRACE_CHECKPOINT_INTERVAL !== 0) checkpoint(traceOrdinal);
        parentPort.postMessage({ type: 'execution-error', error: serializedError(error) });
    }
}

const run = data => main(data).catch(error => {
    queueMicrotask(() => { throw error; });
});
if (workerData.reusable) {
    // Cache immutable data/compiled bundles, while every job creates its own runtime.
    getDemoCatalog({ projectRoot: workerData.projectRoot });
    parentPort.on('message', run);
} else run(workerData);
