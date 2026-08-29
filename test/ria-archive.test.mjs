import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RiaArchive } from '../src/ria/archive.mjs';
import { atomicWriteJson, hashJson, readJsonLines, sha256 } from '../src/ria/common.mjs';
import { RiaEventNormalizer } from '../src/ria/normalize.mjs';
import { RIA_SCHEMAS, validateEvent, validateSnapshot } from '../src/ria/schemas.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function temporaryArchive(t, options = {}) {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-archive-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const archive = await new RiaArchive({
        projectRoot,
        archiveRoot,
        syncEveryRecords: 8,
        ...options
    }).initialize();
    await archive.createCase({
        caseId: 'case-test',
        title: 'RIA archive test',
        policy: { compression: options.compression ?? 'none' }
    });
    await archive.createSession({
        caseId: 'case-test',
        sessionId: 'session-test',
        summary: 'deterministic archive test'
    });
    return { archive, archiveRoot };
}

async function syntheticRun(archive, runId, facts, {
    fixture = { adapter: 'test-facts', input: { commands: [] } },
    compression = 'none',
    result = { ok: true },
    uiActions = []
} = {}) {
    const writer = await archive.startRun({
        caseId: 'case-test',
        sessionId: 'session-test',
        runId,
        fixture,
        config: { compression },
        uiActions
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-test',
        sessionId: 'session-test',
        runId,
        projectRoot
    });
    for (const { source, fact } of facts) {
        for (const event of normalizer.normalize(source, fact)) await writer.appendEvent(event);
    }
    const manifest = await writer.seal({ result });
    return { writer, manifest };
}

test('committed golden trace is schema-valid, monotonic and content-addressed', async () => {
    const events = await readJsonLines(path.join(
        projectRoot,
        'fixtures/ria/golden/team-combo-process.events.jsonl'
    ));
    let previousSequence = 0;
    for (const event of events) {
        validateEvent(event, previousSequence);
        assert.equal(event.eventHash, hashJson({ ...event, eventHash: undefined }));
        previousSequence = event.sequence;
    }
    assert.deepEqual(events.map(event => [
        event.transition.before,
        event.transition.after
    ]), [[1, 0], [0, 1]]);
});

test('exported machine-readable JSON Schemas match the executable validators', async () => {
    const filenames = {
        case: 'case.schema.json',
        session: 'session.schema.json',
        runManifest: 'run-manifest.schema.json',
        event: 'event.schema.json',
        snapshot: 'snapshot.schema.json'
    };
    for (const [name, filename] of Object.entries(filenames)) {
        const exported = JSON.parse(await fs.readFile(
            path.join(projectRoot, 'schemas', 'ria', filename),
            'utf8'
        ));
        assert.deepEqual(exported, RIA_SCHEMAS[name]);
    }
});

test('RIA validates a complete round trip, seals immutably and retains 1→0→1 causality', async t => {
    const { archive } = await temporaryArchive(t);
    const facts = [{
        source: 'ledger.team-combo',
        fact: {
            frame: 10,
            sequence: 1,
            type: 'consume',
            beforeStacks: 1,
            deltaStacks: -1,
            afterStacks: 0,
            rootCastId: 'root:consume',
            castId: 'child:consume',
            parentCastId: 'root:consume',
            inputCommandType: 'NormalSkill',
            effectiveSkillType: 'NormalSkill'
        }
    }, {
        source: 'ledger.team-combo',
        fact: {
            frame: 10,
            sequence: 2,
            type: 'grant',
            beforeStacks: 0,
            deltaStacks: 1,
            afterStacks: 1,
            rootCastId: 'root:grant',
            castId: 'root:grant'
        }
    }];
    const { writer, manifest } = await syntheticRun(archive, 'run-roundtrip', facts, {
        fixture: {
            adapter: 'test-facts',
            input: { commands: [{ commandId: 'command-1', commandType: 'NormalSkill' }] }
        },
        uiActions: [{ frame: 0, actionType: 'TimelineCommandPlaced', commandId: 'command-1' }]
    });

    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.sealed, true);
    assert.equal(manifest.counts.events, 2);
    assert.equal(manifest.counts.commands, 1);
    assert.equal(manifest.counts.uiActions, 1);
    assert.equal((await archive.readRunArtifact('run-roundtrip', 'commands'))[0].commandId, 'command-1');
    assert.equal((await archive.readRunArtifact('run-roundtrip', 'uiActions'))[0].actionType, 'TimelineCommandPlaced');
    const events = await archive.readRunArtifact('run-roundtrip', 'events');
    assert.deepEqual(events.map(event => [
        event.eventType,
        event.transition.before,
        event.transition.after,
        event.rootCastId,
        event.childCastId
    ]), [
        ['TeamComboConsume', 1, 0, 'root:consume', 'child:consume'],
        ['TeamComboGrant', 0, 1, 'root:grant', null]
    ]);
    const state = await archive.stateAtFrame('run-roundtrip', 10);
    assert.equal(state.state.teamCombo.stacks, 1);
    assert.equal(state.proof.exact, true);
    assert.equal((await archive.verifyRun('run-roundtrip')).ok, true);
    assert.equal((await fs.readdir(archive.runPath('case-test', 'run-roundtrip')))
        .some(name => name.includes('.tmp-')), false);
    await assert.rejects(
        writer.appendEvent(events[0]),
        error => error.code === 'RIA_RUN_SEALED'
    );
});

test('doctor preserves sealed prototype snapshots without weakening current Snapshot validation', async t => {
    const { archive } = await temporaryArchive(t);
    const { manifest } = await syntheticRun(archive, 'run-legacy-snapshot', [{
        source: 'resource',
        fact: {
            frame: 1,
            stage: 'ResourceChanged',
            sourceId: 'actor-legacy',
            targetId: 'actor-legacy',
            resourceType: 'Atb',
            before: 2,
            after: 1
        }
    }]);
    const runPath = archive.runPath('case-test', 'run-legacy-snapshot');
    const snapshotPath = path.join(runPath, 'state-snapshots.jsonl');
    const snapshots = await readJsonLines(snapshotPath);
    const legacySnapshots = snapshots.map(snapshot => ({
        ...snapshot,
        runPath: '/legacy/non-portable/archive/path'
    }));
    assert.throws(
        () => validateSnapshot(legacySnapshots[0], 0),
        error => error.code === 'RIA_SCHEMA_INVALID'
    );

    const legacyContents = `${legacySnapshots.map(JSON.stringify).join('\n')}\n`;
    await fs.writeFile(snapshotPath, legacyContents);
    delete manifest.versions.recorderHash;
    manifest.files['state-snapshots.jsonl'] = {
        ...manifest.files['state-snapshots.jsonl'],
        bytes: Buffer.byteLength(legacyContents),
        sha256: sha256(legacyContents)
    };
    manifest.contentHash = hashJson(Object.fromEntries(Object.entries(manifest.files)
        .sort(([left], [right]) => left.localeCompare(right))));
    await atomicWriteJson(path.join(runPath, 'manifest.json'), manifest);

    const verification = await archive.verifyRun('run-legacy-snapshot', 'case-test');
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.warnings.map(item => item.code), [
        'RIA_LEGACY_SNAPSHOT_RUN_PATH'
    ]);
});

test('RIA recovers a crash-truncated JSONL stream as a sealed partial run', async t => {
    const { archive } = await temporaryArchive(t);
    const writer = await archive.startRun({
        caseId: 'case-test',
        sessionId: 'session-test',
        runId: 'run-crashed',
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-test', sessionId: 'session-test', runId: 'run-crashed'
    });
    await writer.appendEvent(normalizer.normalize('resource', {
        frame: 1,
        stage: 'ResourceChanged',
        resourceType: 'Atb',
        before: 2,
        after: 1
    })[0]);
    await writer.drain();
    const runPath = archive.runPath('case-test', 'run-crashed');
    await fs.appendFile(path.join(runPath, 'events.jsonl'), '{"truncated":');
    await atomicWriteJson(path.join(runPath, '.active'), {
        schemaVersion: 1,
        pid: 99999999,
        startedAt: new Date(0).toISOString()
    });

    const recovery = await archive.recoverRun('run-crashed', { force: true });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.manifest.status, 'partial');
    assert.equal(recovery.manifest.counts.events, 1);
    assert.ok(recovery.recovery.streams.events.discardedBytes > 0);
    assert.equal((await archive.verifyRun('run-crashed')).ok, true);
});

test('fixture/rules/data/environment hashes are stable and normalized diff finds the first event', async t => {
    const { archive } = await temporaryArchive(t);
    const baseFixture = { adapter: 'test-facts', input: { commands: [{ commandType: 'Attack' }] } };
    await syntheticRun(archive, 'run-left', [{
        source: 'resource',
        fact: { frame: 1, stage: 'ResourceChanged', resourceType: 'Atb', before: 3, after: 2 }
    }, {
        source: 'resource',
        fact: { frame: 2, stage: 'ResourceChanged', resourceType: 'Atb', before: 2, after: 1 }
    }], { fixture: baseFixture });
    await syntheticRun(archive, 'run-right', [{
        source: 'resource',
        fact: { frame: 1, stage: 'ResourceChanged', resourceType: 'Atb', before: 3, after: 2 }
    }, {
        source: 'resource',
        fact: { frame: 2, stage: 'ResourceChanged', resourceType: 'Atb', before: 2, after: 0 }
    }], { fixture: baseFixture });
    const [left, right] = await Promise.all([
        archive.getRun('run-left'),
        archive.getRun('run-right')
    ]);
    assert.equal(left.fixtureHash, right.fixtureHash);
    assert.equal(left.versions.rulesHash, right.versions.rulesHash);
    assert.equal(left.versions.dataHash, right.versions.dataHash);
    assert.equal(left.environment.git.commit, right.environment.git.commit);
    assert.equal(Object.prototype.hasOwnProperty.call(left.environment, 'env'), false);

    const diff = await archive.diffRuns('run-left', 'run-right');
    assert.equal(diff.fixture.identical, true);
    assert.equal(diff.environment.rulesIdentical, true);
    assert.equal(diff.firstDivergence.kind, 'event');
    assert.equal(diff.firstDivergence.index, 1);
    assert.equal(diff.firstDivergence.left.transition.after, 1);
    assert.equal(diff.firstDivergence.right.transition.after, 0);
});

test('event pagination composes frame/type/actor/cast filters at inclusive boundaries', async t => {
    const { archive } = await temporaryArchive(t);
    await syntheticRun(archive, 'run-filter', [
        { source: 'runner.command', fact: {
            frame: 5, stage: 'CommandExecuted', sourceId: 'actor-a', targetId: 'enemy',
            rootCastId: 'root:a', castId: 'root:a'
        } },
        { source: 'effect', fact: {
            frame: 6, stage: 'DamageHit', sourceId: 'actor-a', targetId: 'enemy',
            rootCastId: 'root:a', castId: 'child:a', parentCastId: 'root:a'
        } },
        { source: 'effect', fact: {
            frame: 7, stage: 'DamageHit', sourceId: 'actor-b', targetId: 'enemy',
            rootCastId: 'root:b', castId: 'root:b'
        } }
    ]);
    const page = await archive.queryEvents('run-filter', {
        afterSequence: 1,
        fromFrame: 6,
        toFrame: 6,
        eventType: 'DamageHit',
        actorId: 'actor-a',
        targetId: 'enemy',
        rootCastId: 'root:a',
        childCastId: 'child:a',
        limit: 1
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].sequence, 2);
    assert.equal(page.page.nextAfterSequence, 2);
    assert.equal(page.page.hasMore, false);
    await assert.rejects(
        archive.queryEvents('run-filter', { fromFrame: 7, toFrame: 6 }),
        /fromFrame cannot exceed/
    );
});

test('archive rejects traversal/oversize input, redacts secrets, supports gzip and rebuilds a deleted index', async t => {
    const { archive, archiveRoot } = await temporaryArchive(t, { maxResultBytes: 4096 });
    const fixture = {
        adapter: 'test-facts',
        apiToken: 'must-not-survive',
        nested: { clientSecret: 'also-secret' },
        input: { commands: [] }
    };
    await syntheticRun(archive, 'run-secure', [{
        source: 'runtime', fact: { frame: 0, stage: 'SafeFact' }
    }], { fixture, compression: 'gzip' });
    const storedFixture = await archive.readRunArtifact('run-secure', 'fixture');
    assert.equal(storedFixture.apiToken, '[REDACTED]');
    assert.equal(storedFixture.nested.clientSecret, '[REDACTED]');
    assert.equal((await archive.readRunArtifact('run-secure', 'events')).length, 1);
    assert.equal(await fs.stat(path.join(
        archive.runPath('case-test', 'run-secure'),
        'events.jsonl.gz'
    )).then(stat => stat.isFile()), true);

    await assert.rejects(archive.getCase('../escape'), error => (
        ['RIA_INVALID_ID', 'RIA_PATH_TRAVERSAL'].includes(error.code)
    ));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'case.json'), '{}');
    await fs.symlink(outside, path.join(archive.casesRoot, 'case-link'), 'dir');
    await assert.rejects(
        archive.getCase('case-link'),
        error => error.code === 'RIA_SYMLINK_ESCAPE'
    );
    await assert.rejects(archive.startRun({
        caseId: 'case-test',
        sessionId: 'session-test',
        runId: 'run-too-large',
        fixture: { payload: 'x'.repeat(10_000) }
    }), error => error.code === 'RIA_INPUT_TOO_LARGE');
    await assert.rejects(
        fs.access(archive.runPath('case-test', 'run-too-large')),
        error => error.code === 'ENOENT'
    );

    await fs.rm(path.join(archiveRoot, 'index.json'));
    const rebuilt = await archive.rebuildIndex();
    assert.deepEqual(rebuilt.runs.map(run => run.runId), ['run-secure']);
    assert.equal((await archive.doctor()).ok, true);
});

test('retention is dry-run by default and applied cleanup moves sealed runs to recoverable trash', async t => {
    const { archive, archiveRoot } = await temporaryArchive(t);
    await archive.createCase({
        caseId: 'case-retention',
        title: 'Retention policy',
        policy: { maxRuns: 1 }
    });
    await archive.createSession({
        caseId: 'case-retention',
        sessionId: 'session-retention'
    });
    for (const runId of ['run-old', 'run-new']) {
        const writer = await archive.startRun({
            caseId: 'case-retention',
            sessionId: 'session-retention',
            runId,
            fixture: { adapter: 'test-facts', input: { commands: [] } }
        });
        await writer.seal({ result: { runId } });
    }
    const dryRun = await archive.prune({ caseId: 'case-retention' });
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.candidates.map(candidate => candidate.runId), ['run-old']);
    assert.equal((await archive.listRuns({ caseId: 'case-retention' })).length, 2);

    const applied = await archive.prune({ caseId: 'case-retention', apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.moved[0].runId, 'run-old');
    assert.equal((await archive.listRuns({ caseId: 'case-retention' })).length, 1);
    assert.equal((await fs.stat(path.join(
        archiveRoot,
        applied.moved[0].recoveryPath
    ))).isDirectory(), true);
});
