import { parentPort, workerData } from 'node:worker_threads';

import { simulateSquadDemo } from '../../demo/demo-service.mjs';

const EXECUTORS = Object.freeze({
    'ake-squad-demo': ({ input, projectRoot, traceSink }) => simulateSquadDemo(input, {
        projectRoot,
        traceSink
    })
});

const TRACE_CHECKPOINT_INTERVAL = 64;
const checkpointState = workerData?.traceCheckpointBuffer
    ? new Int32Array(workerData.traceCheckpointBuffer)
    : null;

function checkpoint(ordinal) {
    if (!checkpointState || ordinal === 0) return;
    Atomics.store(checkpointState, 0, 0);
    parentPort.postMessage({ type: 'trace-checkpoint', ordinal });
    Atomics.wait(checkpointState, 0, 0);
}

function serializedError(error) {
    return {
        name: String(error?.name ?? 'Error'),
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 4000)
    };
}

async function main() {
    if (workerData?.testCrashBeforeExecution === true) {
        throw new Error('Injected RIA worker crash before execution.');
    }
    const execute = EXECUTORS[workerData.adapter];
    if (!execute) throw new Error(`Worker adapter is not allowed: ${String(workerData.adapter)}`);
    try {
        let traceOrdinal = 0;
        const result = await execute({
            input: workerData.input,
            projectRoot: workerData.projectRoot,
            seed: workerData.seed,
            traceSink: packet => {
                parentPort.postMessage({ type: 'trace', packet });
                traceOrdinal += 1;
                if (traceOrdinal % TRACE_CHECKPOINT_INTERVAL === 0) checkpoint(traceOrdinal);
                return true;
            }
        });
        if (traceOrdinal % TRACE_CHECKPOINT_INTERVAL !== 0) checkpoint(traceOrdinal);
        parentPort.postMessage({ type: 'result', result });
    } catch (error) {
        parentPort.postMessage({ type: 'execution-error', error: serializedError(error) });
    }
}

main().catch(error => {
    queueMicrotask(() => { throw error; });
});
