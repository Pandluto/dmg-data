import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { RiaArchive } from '../src/ria/archive.mjs';
import { createRiaServer } from '../src/ria/server.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cliPath = path.join(projectRoot, 'src', 'ria', 'cli.mjs');

async function cli(archiveRoot, ...args) {
    const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        ...args,
        '--project-root', projectRoot,
        '--archive-root', archiveRoot,
        '--json'
    ], {
        cwd: projectRoot,
        maxBuffer: 16 * 1024 * 1024
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function curlJson(...args) {
    const { stdout } = await execFileAsync('curl', [
        '--silent', '--show-error', '--fail-with-body', ...args
    ], { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
}

test('documented CLI workflow records, queries, replays, diffs, verifies and closes a Case', async t => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-doc-cli-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));

    const caseDocument = await cli(
        archiveRoot,
        'case', 'create',
        '--case-id', 'combo-investigation',
        '--title', '共享连击消费调查'
    );
    assert.equal(caseDocument.caseId, 'combo-investigation');
    const session = await cli(
        archiveRoot,
        'session', 'create',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--summary', '冻结修复前行为'
    );
    assert.equal(session.sessionId, 'session-before-fix');
    await cli(
        archiveRoot,
        'session', 'append',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--type', 'thread-link',
        '--content', 'Codex task decision trail',
        '--thread-id', '01a04795-18d4-7a30-88f6-130f036e4082',
        '--thread-source', 'codex-desktop'
    );
    await cli(
        archiveRoot,
        'session', 'append',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--type', 'decision',
        '--content', 'Record before changing runtime behavior'
    );
    const recorded = await cli(
        archiveRoot,
        'record',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--run-id', 'run-before-fix',
        '--fixture', 'fixtures/ria/pelica-normal-skill.json'
    );
    assert.equal(recorded.status, 'completed');
    assert.ok(recorded.eventCount > 100);

    const eventPage = await cli(
        archiveRoot,
        'show', 'events',
        '--case-id', 'combo-investigation',
        '--run-id', 'run-before-fix',
        '--event-type', 'DamageHit',
        '--limit', '10'
    );
    assert.ok(eventPage.items.length > 0);
    assert.ok(eventPage.items.every(event => event.eventType === 'DamageHit'));

    const replay = await cli(
        archiveRoot,
        'replay',
        '--case-id', 'combo-investigation',
        '--run-id', 'run-before-fix',
        '--replay-run-id', 'run-before-fix-replay'
    );
    assert.equal(replay.deterministic, true);
    const diff = await cli(
        archiveRoot,
        'diff',
        '--left-case-id', 'combo-investigation',
        '--right-case-id', 'combo-investigation',
        '--left-run-id', 'run-before-fix',
        '--right-run-id', 'run-before-fix-replay'
    );
    assert.equal(diff.firstDivergence.identical, true);

    const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    const service = createRiaServer({ archive, port: 0 });
    const address = await service.listen();
    try {
        const apiRoot = `${address.url}/api/ria`;
        const health = await curlJson(`${apiRoot}/health`);
        assert.equal(health.ok, true);
        const damageHits = await curlJson(
            `${apiRoot}/runs/run-before-fix/events?caseId=combo-investigation&eventType=DamageHit&afterSequence=0&limit=2`
        );
        assert.ok(damageHits.items.length > 0);
        assert.ok(damageHits.items.every(event => event.eventType === 'DamageHit'));
        const proof = await curlJson(
            `${apiRoot}/runs/run-before-fix/state?caseId=combo-investigation&frame=0`
        );
        assert.equal(proof.proof.exact, true);
        const entries = await curlJson(
            `${apiRoot}/cases/combo-investigation/sessions/session-before-fix/entries?afterSequence=0&limit=100`
        );
        assert.ok(entries.items.some(entry => entry.type === 'thread-link'));

        const { stdout: sse } = await execFileAsync('curl', [
            '--silent', '--show-error', '--no-buffer',
            '-H', 'Last-Event-ID: 1',
            `${apiRoot}/runs/run-before-fix/stream?caseId=combo-investigation`
        ], { maxBuffer: 32 * 1024 * 1024 });
        assert.doesNotMatch(sse, /id: 1\nevent: ria-event/);
        assert.match(sse, /event: run-complete/);

        const accepted = await curlJson(
            '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '--data', JSON.stringify({ replayRunId: 'run-before-fix-api-replay' }),
            `${apiRoot}/runs/run-before-fix/replay?caseId=combo-investigation`
        );
        assert.equal(accepted.replayRunId, 'run-before-fix-api-replay');
        let job;
        for (let attempt = 0; attempt < 800; attempt += 1) {
            job = await curlJson(`${address.url}${accepted.statusUrl}`);
            if (job.status !== 'running') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(job.status, 'completed');
        const apiDiff = await curlJson(
            `${apiRoot}/diff?leftRunId=run-before-fix&rightRunId=run-before-fix-api-replay&leftCaseId=combo-investigation&rightCaseId=combo-investigation`
        );
        assert.equal(apiDiff.firstDivergence.identical, true);
    } finally {
        await service.close();
    }

    const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
    await cli(
        archiveRoot,
        'session', 'append',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--type', 'finding',
        '--content', 'Replay retained normalized evidence',
        '--run-id', 'run-before-fix-api-replay',
        '--related-run-id', 'run-before-fix',
        '--relation', 'after'
    );
    await cli(
        archiveRoot,
        'session', 'append',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--type', 'commit-link',
        '--content', 'Implementation baseline',
        '--commit', commit
    );
    await cli(
        archiveRoot,
        'session', 'append',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--type', 'note',
        '--content', 'Ready to close'
    );
    const journal = await cli(
        archiveRoot,
        'session', 'entries',
        '--case-id', 'combo-investigation',
        '--session-id', 'session-before-fix',
        '--limit', '100'
    );
    assert.ok(journal.items.some(entry => entry.type === 'thread-link'));
    assert.ok(journal.items.some(entry => entry.type === 'decision'));
    assert.ok(journal.items.some(entry => entry.type === 'finding'));
    assert.ok(journal.items.some(entry => entry.type === 'commit-link'));
    assert.ok(journal.items.some(entry => entry.type === 'note'));
    const verified = await cli(
        archiveRoot,
        'verify',
        '--case-id', 'combo-investigation',
        '--run-id', 'run-before-fix'
    );
    assert.equal(verified.ok, true);
    const rebuilt = await cli(archiveRoot, 'rebuild-index');
    assert.equal(rebuilt.runs.length, 3);
    const closed = await cli(
        archiveRoot,
        'case', 'close',
        '--case-id', 'combo-investigation',
        '--resolution', 'before and deterministic replay retained'
    );
    assert.equal(closed.status, 'closed');
});

test('quickstart curl routes stay represented by the tested OpenAPI contract', async () => {
    const guide = await fs.readFile(
        path.join(projectRoot, 'docs', 'guides', 'ria-quickstart.md'),
        'utf8'
    );
    const openapi = JSON.parse(await fs.readFile(
        path.join(projectRoot, 'openapi', 'ria.openapi.json'),
        'utf8'
    ));
    for (const route of [
        '/api/ria/health',
        '/api/ria/capabilities',
        '/api/ria/runs/{runId}/events',
        '/api/ria/runs/{runId}/state',
        '/api/ria/runs/{runId}/stream',
        '/api/ria/runs/{runId}/replay',
        '/api/ria/diff'
    ]) {
        assert.ok(openapi.paths[route], route);
    }
    for (const literal of [
        'afterSequence', 'Last-Event-ID', 'eventType', 'rootCastId',
        'childCastId', 'firstDivergence'
    ]) assert.match(guide, new RegExp(literal));
});
