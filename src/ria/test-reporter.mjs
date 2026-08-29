import { RiaEventNormalizer } from './normalize.mjs';

export async function recordNodeTestFailure({
    archive,
    caseId,
    sessionId,
    runId,
    argv,
    exitCode,
    signal = null,
    testNames = [],
    stdoutTail = '',
    stderrTail = ''
} = {}) {
    const fixture = {
        schemaVersion: 1,
        artifactType: 'node-test-failure',
        replayable: false,
        input: {
            commands: [{
                commandId: 'node-test-command',
                commandType: 'NodeTest',
                executable: 'node',
                argv,
                exitCode,
                signal
            }],
            testNames
        }
    };
    const writer = await archive.startRun({
        caseId,
        sessionId,
        runId,
        fixture,
        config: {
            explicitRecording: true,
            failureArtifact: true,
            replayable: false,
            adapter: 'node-test-failure'
        }
    });
    const normalizer = new RiaEventNormalizer({ caseId, sessionId, runId });
    const [event] = normalizer.normalize('test.runner', {
        frame: 0,
        stage: 'NodeTestFailed',
        sourceId: 'node-test-runner',
        commandId: 'node-test-command',
        exitCode,
        signal,
        testNames
    });
    await writer.appendEvent(event);
    const manifest = await writer.seal({
        status: 'interrupted',
        result: {
            schemaVersion: 1,
            status: 'failed',
            exitCode,
            signal,
            testNames,
            stdoutTail,
            stderrTail
        },
        assertions: {
            passed: false,
            checks: [{
                assertionId: 'node-test-exit-status',
                passed: false,
                expected: 0,
                actual: exitCode,
                testNames
            }]
        },
        findings: `Opt-in Node test wrapper preserved a failing invocation.\n\nTests: ${testNames.join(', ') || '(unparsed)'}\n`
    });
    return { runId, manifest };
}

export default recordNodeTestFailure;
