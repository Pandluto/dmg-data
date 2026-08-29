import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RiaArchive } from '../src/ria/archive.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const wrapper = path.join(projectRoot, 'scripts', 'ria-node-test.mjs');

function run(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            ...options,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}

test('opt-in Node test wrapper preserves failure evidence without changing exit semantics', async t => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-test-reporter-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.NODE_TEST_CONTEXT;
    const result = await run(process.execPath, [
        wrapper,
        '--ria-project-root', projectRoot,
        '--ria-archive-root', archiveRoot,
        '--ria-case-id', 'case-node-test-failure',
        '--ria-session-id', 'session-node-test-failure',
        '--ria-run-id', 'run-node-test-failure',
        '--ria-thread-id', '01a04795-18d4-7a30-88f6-130f036e4082',
        '--ria-thread-source', 'codex-desktop',
        '--',
        'test/fixtures/ria-intentional-node-test-failure.mjs'
    ], { cwd: projectRoot, env: cleanEnvironment });
    assert.equal(result.code, 1, 'wrapper must preserve the test runner exit status');
    assert.equal(result.signal, null);
    assert.match(result.stderr, /RIA_TEST_FAILURE_RUN case-node-test-failure\/session-node-test-failure\/run-node-test-failure/);

    const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    const [manifest, fixture, events, assertions, testResult, entries] = await Promise.all([
        archive.getRun('run-node-test-failure', 'case-node-test-failure'),
        archive.readRunArtifact('run-node-test-failure', 'fixture', 'case-node-test-failure'),
        archive.readRunArtifact('run-node-test-failure', 'events', 'case-node-test-failure'),
        archive.readRunArtifact('run-node-test-failure', 'assertions', 'case-node-test-failure'),
        archive.readRunArtifact('run-node-test-failure', 'result', 'case-node-test-failure'),
        archive.listSessionEntries('case-node-test-failure', 'session-node-test-failure')
    ]);
    assert.equal(manifest.status, 'interrupted');
    assert.equal(manifest.sealed, true);
    assert.equal(manifest.config.failureArtifact, true);
    assert.equal(manifest.config.replayable, false);
    assert.equal(fixture.artifactType, 'node-test-failure');
    assert.equal(fixture.replayable, false);
    assert.equal(fixture.input.commands[0].executable, 'node');
    assert.equal(fixture.input.commands[0].exitCode, 1);
    assert.equal(events[0].eventType, 'NodeTestFailed');
    assert.equal(assertions.passed, false);
    assert.equal(testResult.exitCode, 1);
    assert.ok(testResult.testNames.some(name => name.includes('intentional RIA wrapper failure')));
    assert.ok(entries.items.some(entry => (
        entry.type === 'thread-link'
        && entry.threadId === '01a04795-18d4-7a30-88f6-130f036e4082'
    )));
    assert.ok(entries.items.some(entry => (
        entry.type === 'run-link' && entry.runId === 'run-node-test-failure'
    )));
    assert.equal((await archive.verifyRun('run-node-test-failure', 'case-node-test-failure')).ok, true);
});
