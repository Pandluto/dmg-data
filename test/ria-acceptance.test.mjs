import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
    captureEnvironment,
    RiaArchive
} from '../src/ria/archive.mjs';
import { hashJson, sha256 } from '../src/ria/common.mjs';
import { recordFixtureRun, replayArchivedRun } from '../src/ria/execute.mjs';
import { RiaEventNormalizer } from '../src/ria/normalize.mjs';
import { RIA_SCHEMAS, validateSchema } from '../src/ria/schemas.mjs';
import { createRiaServer } from '../src/ria/server.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cliPath = path.join(projectRoot, 'src', 'ria', 'cli.mjs');

async function makeArchive(t, options = {}) {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-acceptance-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const archive = await new RiaArchive({
        projectRoot,
        archiveRoot,
        syncEveryRecords: 10_000,
        ...options
    }).initialize();
    await archive.createCase({ caseId: 'case-acceptance', title: 'RIA acceptance' });
    await archive.createSession({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        summary: 'acceptance evidence'
    });
    return { archive, archiveRoot };
}

async function oneEventRun(archive, runId, project = projectRoot) {
    const writer = await archive.startRun({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId,
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId,
        projectRoot: project
    });
    await writer.appendEvent(normalizer.normalize('runtime', {
        frame: 1,
        stage: 'AcceptanceFact',
        sourceId: 'actor-acceptance',
        rootCastId: 'cast-acceptance',
        castId: 'cast-acceptance'
    })[0]);
    return writer.seal({ result: { ok: true } });
}

function deepClone(value) {
    return structuredClone(value);
}

function directSchemaResult(schema, value) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(ajv);
    return Boolean(ajv.compile(schema)(value));
}

async function cliClosedFailure(archiveRoot, ...arguments_) {
    try {
        await execFileAsync(process.execPath, [
            cliPath,
            ...arguments_,
            '--project-root', projectRoot,
            '--archive-root', archiveRoot,
            '--json'
        ], { cwd: projectRoot, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
        return JSON.parse(error.stderr.trim().split('\n').at(-1));
    }
    throw new Error(`CLI unexpectedly accepted closed Case command: ${arguments_.join(' ')}`);
}

test('Ajv executes the exported schemas for boundary and nested mutation cases', async t => {
    const { archive } = await makeArchive(t);
    await oneEventRun(archive, 'run-schema');
    const [caseDocument, session, entries, manifest, events, snapshots] = await Promise.all([
        archive.getCase('case-acceptance'),
        archive.getSession('case-acceptance', 'session-acceptance'),
        archive.listSessionEntries('case-acceptance', 'session-acceptance'),
        archive.getRun('run-schema'),
        archive.readRunArtifact('run-schema', 'events'),
        archive.readRunArtifact('run-schema', 'snapshots')
    ]);
    const validSamples = {
        case: caseDocument,
        caseCreateRequest: {
            caseId: 'case-valid',
            title: 'valid',
            policy: { retentionDays: 1, maxRuns: 1, compression: 'none' }
        },
        session,
        sessionCreateRequest: {
            caseId: 'case-acceptance',
            sessionId: 'session-valid',
            metadata: { source: 'test' }
        },
        sessionEntry: entries.items[0],
        runManifest: manifest,
        event: events[0],
        snapshot: snapshots[0],
        uiActionAppendRequest: {
            actionType: 'TimelineCommandPlaced',
            payload: { commandCount: 1 }
        },
        replayRequest: { replayRunId: 'run-next' },
        errorResponse: {
            error: { code: 'RIA_TEST', message: 'test error', details: null }
        }
    };
    for (const [name, value] of Object.entries(validSamples)) {
        assert.equal(directSchemaResult(RIA_SCHEMAS[name], value), true, `${name} direct valid`);
        assert.doesNotThrow(() => validateSchema(name, value), `${name} runtime valid`);
    }

    const mutations = [
        ['caseCreateRequest', validSamples.caseCreateRequest, value => { value.title = 'x'.repeat(241); }, 'title maxLength'],
        ['caseCreateRequest', validSamples.caseCreateRequest, value => { value.policy.retentionDays = -5; }, 'negative retentionDays'],
        ['caseCreateRequest', validSamples.caseCreateRequest, value => { value.policy.maxRuns = 0; }, 'zero maxRuns'],
        ['caseCreateRequest', validSamples.caseCreateRequest, value => { value.extra = true; }, 'request extra field'],
        ['case', validSamples.case, value => { value.policy = []; }, 'wrong nested policy type'],
        ['session', validSamples.session, value => { value.metadata = []; }, 'wrong session metadata type'],
        ['sessionEntry', validSamples.sessionEntry, value => {
            value.type = 'thread-link';
            value.threadId = 'thread-only';
            delete value.threadSource;
        }, 'thread-link missing source'],
        ['runManifest', validSamples.runManifest, value => { value.counts.events = -1; }, 'negative run count'],
        ['runManifest', validSamples.runManifest, value => { value.recording.extra = 1; }, 'manifest nested extra field'],
        ['event', validSamples.event, value => { value.source.authority = 'chat'; }, 'invalid event authority'],
        ['event', validSamples.event, value => { value.source.extra = true; }, 'event nested extra field'],
        ['snapshot', validSamples.snapshot, value => { value.evidence.toEventSequence = 0; }, 'invalid evidence range'],
        ['uiActionAppendRequest', validSamples.uiActionAppendRequest, value => { value.payload = []; }, 'wrong UI payload type'],
        ['replayRequest', validSamples.replayRequest, value => { value.command = 'echo unsafe'; }, 'replay shell injection field'],
        ['errorResponse', validSamples.errorResponse, value => { delete value.error.details; }, 'response missing details']
    ];
    for (const [name, base, mutate, label] of mutations) {
        const value = deepClone(base);
        mutate(value);
        assert.equal(directSchemaResult(RIA_SCHEMAS[name], value), false, `${label}: direct`);
        assert.throws(
            () => validateSchema(name, value),
            error => error.code === 'RIA_SCHEMA_INVALID',
            `${label}: runtime`
        );
    }

    for (const input of [
        { caseId: 'case-too-long', title: 'x'.repeat(241) },
        { caseId: 'case-negative-retention', title: 'bad', policy: { retentionDays: -5 } },
        { caseId: 'case-zero-runs', title: 'bad', policy: { maxRuns: 0 } },
        { caseId: 'case-extra', title: 'bad', unexpected: true }
    ]) {
        await assert.rejects(
            archive.createCase(input),
            error => error.code === 'RIA_SCHEMA_INVALID'
        );
    }
});

test('maxRunBytes reserves before append and covers commands, events, snapshots and UI actions', async t => {
    const { archive } = await makeArchive(t, { maxRunBytes: 12_000 });
    const writer = await archive.startRun({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId: 'run-capacity',
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    await writer.appendCommand({
        commandId: 'capacity-command',
        commandType: 'NormalSkill',
        payload: 'c'.repeat(900)
    });
    await writer.appendUiAction({
        actionType: 'TimelineCommandPlaced',
        payload: { value: 'u'.repeat(900) }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId: 'run-capacity'
    });
    await writer.appendEvent(normalizer.normalize('runtime', {
        frame: 1,
        stage: 'CapacityFact',
        sourceId: 'actor-capacity',
        payload: 'e'.repeat(900)
    })[0]);
    await writer.appendSnapshot({
        schemaVersion: 1,
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId: 'run-capacity',
        sequence: 1,
        frame: 1,
        state: { marker: 's'.repeat(900) },
        evidence: {
            source: 'normalized-fact-projection',
            fromEventSequence: 1,
            toEventSequence: 1
        }
    });
    const before = structuredClone(writer.currentManifest.recording);
    await assert.rejects(
        writer.appendCommand({ commandId: 'too-large', payload: 'x'.repeat(20_000) }),
        error => error.code === 'RIA_RUN_TOO_LARGE'
    );
    await assert.rejects(
        writer.appendUiAction({ actionType: 'MustNotBeWritten' }),
        error => error.code === 'RIA_RUN_TOO_LARGE'
    );
    assert.deepEqual(writer.currentManifest.counts, {
        commands: 1, events: 1, snapshots: 1, uiActions: 1
    });
    assert.equal(writer.currentManifest.recording.bytesWritten, before.bytesWritten);
    assert.equal(
        Object.values(writer.currentManifest.recording.streamBytes).reduce((sum, value) => sum + value, 0),
        writer.currentManifest.recording.bytesWritten
    );
    assert.ok(Object.values(writer.currentManifest.recording.streamBytes).every(value => value > 0));
    assert.ok(writer.currentManifest.recording.bytesWritten <= archive.maxRunBytes);
    const manifest = await writer.seal({ result: { capacityStopped: true } });
    assert.equal(manifest.status, 'partial');
    assert.equal(manifest.recording.capacityExceeded, true);
    assert.equal(manifest.recording.bytesWritten, before.bytesWritten);
});

test('a large event log seeks by sparse byte index and rebuilds from authoritative JSONL', async t => {
    const { archive } = await makeArchive(t, { maxRunBytes: 128 * 1024 * 1024 });
    const runId = 'run-large-log';
    const writer = await archive.startRun({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId,
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    });
    const normalizer = new RiaEventNormalizer({
        caseId: 'case-acceptance', sessionId: 'session-acceptance', runId
    });
    const writes = [];
    for (let ordinal = 1; ordinal <= 4_096; ordinal += 1) {
        const event = normalizer.normalize('runtime', {
            frame: 1,
            stage: 'BulkFact',
            sourceId: `actor-${ordinal % 4}`,
            ordinal
        })[0];
        writes.push(writer.appendEvent(event));
    }
    await Promise.all(writes);
    await writer.seal({ result: { eventCount: 4_096 } });

    const page = await archive.queryEvents(runId, { afterSequence: 3_900, limit: 25 });
    assert.deepEqual(page.items.map(event => event.sequence),
        Array.from({ length: 25 }, (_, index) => 3_901 + index));
    assert.equal(page.page.diagnostics.strategy, 'sparse-sequence-byte-offset');
    assert.ok(page.page.diagnostics.startOffset > 0);
    assert.ok(page.page.diagnostics.seekSequence >= 3_841);
    assert.ok(page.page.diagnostics.recordsDecoded <= 160);
    assert.ok(page.page.diagnostics.bytesScanned < page.page.diagnostics.fileBytes / 10);

    const next = await archive.queryEvents(runId, {
        cursor: page.page.nextCursor,
        limit: 25
    });
    assert.equal(next.items[0].sequence, 3_926);
    assert.ok(next.page.diagnostics.startOffset > page.page.diagnostics.startOffset);
    assert.ok(next.page.diagnostics.recordsDecoded <= 26);

    const indexPath = archive.eventIndexPath('case-acceptance', runId);
    await fs.rm(indexPath);
    await archive.rebuildIndex();
    const rebuilt = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    assert.equal(rebuilt.authority, 'derived-rebuildable-sparse-jsonl-index');
    assert.equal(rebuilt.recordCount, 4_096);
    assert.equal(rebuilt.lastSequence, 4_096);
    const afterRebuild = await archive.queryEvents(runId, {
        afterSequence: 4_000,
        limit: 10
    });
    assert.equal(afterRebuild.page.diagnostics.indexRebuilt, false);
    assert.ok(afterRebuild.page.diagnostics.recordsDecoded <= 140);
});

test('Session journal traces Codex decisions through before/after Runs and closed Case rejects every writer', async t => {
    const { archive, archiveRoot } = await makeArchive(t);
    const threadId = '01a04795-18d4-7a30-88f6-130f036e4082';
    const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
    await archive.appendSessionEntry('case-acceptance', 'session-acceptance', {
        type: 'thread-link',
        actor: 'codex',
        content: 'Codex task records decisions but not calculation truth.',
        threadId,
        threadSource: 'codex-desktop'
    });
    await archive.appendSessionEntry('case-acceptance', 'session-acceptance', {
        type: 'decision',
        actor: 'codex',
        content: 'Freeze the before Run before changing runtime behavior.'
    });
    await oneEventRun(archive, 'run-before');
    await oneEventRun(archive, 'run-after');
    await archive.appendSessionEntry('case-acceptance', 'session-acceptance', {
        type: 'finding',
        actor: 'codex',
        content: 'The after Run no longer mixes cross-source identities.',
        runId: 'run-after',
        relatedRunId: 'run-before',
        relation: 'fix-verification'
    });
    await archive.appendSessionEntry('case-acceptance', 'session-acceptance', {
        type: 'commit-link',
        actor: 'codex',
        content: 'Execution baseline commit.',
        commit
    });
    await archive.appendSessionEntry('case-acceptance', 'session-acceptance', {
        type: 'note',
        actor: 'codex',
        content: 'All required evidence is linked; close the Case.'
    });
    const journal = await archive.listSessionEntries(
        'case-acceptance',
        'session-acceptance',
        { limit: 100 }
    );
    assert.deepEqual(journal.items.map(entry => entry.sequence),
        Array.from({ length: journal.items.length }, (_, index) => index + 1));
    assert.deepEqual(new Set(journal.items.map(entry => entry.type)), new Set([
        'thread-link', 'decision', 'run-link', 'finding', 'commit-link', 'note'
    ]));
    assert.equal(journal.items.find(entry => entry.type === 'thread-link').threadId, threadId);
    assert.equal(journal.items.find(entry => entry.type === 'commit-link').commit, commit);
    assert.ok(journal.items.filter(entry => entry.type === 'run-link' && entry.runId === 'run-before').length >= 2);
    assert.ok(journal.items.filter(entry => entry.type === 'run-link' && entry.runId === 'run-after').length >= 2);
    for (const entry of journal.items) {
        const { contentHash, ...content } = entry;
        assert.equal(contentHash, hashJson(content));
    }

    const closed = await archive.closeCase('case-acceptance', {
        resolution: 'before/after evidence and commit retained'
    });
    assert.equal(closed.status, 'closed');
    const expectClosed = operation => assert.rejects(
        operation,
        error => error.code === 'RIA_CASE_CLOSED' && error.statusCode === 409
    );
    await expectClosed(archive.createSession({
        caseId: 'case-acceptance', sessionId: 'session-after-close'
    }));
    await expectClosed(archive.appendSessionEntry(
        'case-acceptance', 'session-acceptance', { type: 'note', content: 'forbidden' }
    ));
    await expectClosed(archive.startRun({
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId: 'run-after-close',
        fixture: { adapter: 'test-facts', input: { commands: [] } }
    }));
    const replayableFixture = JSON.parse(await fs.readFile(
        path.join(projectRoot, 'fixtures', 'ria', 'pelica-normal-skill.json'),
        'utf8'
    ));
    await expectClosed(recordFixtureRun({
        archive,
        caseId: 'case-acceptance',
        sessionId: 'session-acceptance',
        runId: 'run-record-after-close',
        fixture: replayableFixture
    }));
    await expectClosed(replayArchivedRun({
        archive,
        runId: 'run-before',
        caseId: 'case-acceptance',
        replayRunId: 'run-replay-after-close'
    }));
    await expectClosed(archive.appendRunUiAction(
        'run-before', { actionType: 'ForbiddenAfterClose' }, 'case-acceptance'
    ));

    const service = createRiaServer({ archive, port: 0 });
    const address = await service.listen();
    t.after(() => service.close());
    const requests = [
        fetch(`${address.url}/api/ria/cases/case-acceptance/sessions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'session-rest-closed' })
        }),
        fetch(`${address.url}/api/ria/cases/case-acceptance/sessions/session-acceptance/entries`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'note', content: 'forbidden' })
        }),
        fetch(`${address.url}/api/ria/runs/run-before/replay?caseId=case-acceptance`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replayRunId: 'run-rest-closed' })
        }),
        fetch(`${address.url}/api/ria/runs/run-before/ui-actions?caseId=case-acceptance`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionType: 'ForbiddenAfterClose' })
        })
    ];
    for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'RIA_CASE_CLOSED');
    }

    for (const arguments_ of [
        ['session', 'create', '--case-id', 'case-acceptance', '--session-id', 'session-cli-closed'],
        ['record', '--case-id', 'case-acceptance', '--session-id', 'session-acceptance', '--fixture', 'fixtures/ria/pelica-normal-skill.json'],
        ['run', '--case-id', 'case-acceptance', '--session-id', 'session-acceptance', '--fixture', 'fixtures/ria/pelica-normal-skill.json'],
        ['replay', '--case-id', 'case-acceptance', '--run-id', 'run-before', '--replay-run-id', 'run-cli-closed']
    ]) {
        const failure = await cliClosedFailure(archiveRoot, ...arguments_);
        assert.equal(failure.error.code, 'RIA_CASE_CLOSED');
    }
});

test('environment equality covers adapter, recorder and untracked execution content', async t => {
    const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-version-project-'));
    const tempArchive = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-version-archive-'));
    t.after(() => Promise.all([
        fs.rm(tempProject, { recursive: true, force: true }),
        fs.rm(tempArchive, { recursive: true, force: true })
    ]));
    await Promise.all([
        fs.mkdir(path.join(tempProject, 'src', 'core'), { recursive: true }),
        fs.mkdir(path.join(tempProject, 'src', 'ria'), { recursive: true }),
        fs.mkdir(path.join(tempProject, 'demo'), { recursive: true }),
        fs.mkdir(path.join(tempProject, 'spec'), { recursive: true })
    ]);
    await Promise.all([
        fs.writeFile(path.join(tempProject, 'package.json'), '{"name":"version-test","version":"1.0.0"}\n'),
        fs.writeFile(path.join(tempProject, 'package-lock.json'), '{"lockfileVersion":3}\n'),
        fs.writeFile(path.join(tempProject, 'sources.lock.json'), '{"sources":[]}\n'),
        fs.writeFile(path.join(tempProject, 'src', 'core', 'rules.mjs'), 'export const rule = 1;\n'),
        fs.writeFile(path.join(tempProject, 'src', 'ria', 'normalize.mjs'), 'export const normalize = 1;\n'),
        fs.writeFile(path.join(tempProject, 'demo', 'demo-service.mjs'), 'export const adapter = 1;\n')
    ]);
    const archive = await new RiaArchive({
        projectRoot: tempProject,
        archiveRoot: tempArchive
    }).initialize();
    await archive.createCase({ caseId: 'case-acceptance', title: 'Version closure' });
    await archive.createSession({ caseId: 'case-acceptance', sessionId: 'session-acceptance' });
    await oneEventRun(archive, 'run-version-1', tempProject);
    await fs.writeFile(
        path.join(tempProject, 'demo', 'demo-service.mjs'),
        'export const adapter = 2;\n'
    );
    await oneEventRun(archive, 'run-version-2', tempProject);
    const adapterDiff = await archive.diffRuns('run-version-1', 'run-version-2');
    assert.equal(adapterDiff.environment.identical, false);
    assert.equal(adapterDiff.environment.executableIdentical, false);
    assert.ok(adapterDiff.environment.reasons.includes('executable'));
    assert.equal(adapterDiff.environment.rulesIdentical, true);

    await fs.writeFile(
        path.join(tempProject, 'src', 'ria', 'normalize.mjs'),
        'export const normalize = 2;\n'
    );
    await oneEventRun(archive, 'run-version-3', tempProject);
    const recorderDiff = await archive.diffRuns('run-version-2', 'run-version-3');
    assert.equal(recorderDiff.environment.identical, false);
    assert.equal(recorderDiff.environment.executableIdentical, false);
    assert.equal(recorderDiff.environment.recorderIdentical, false);
    assert.ok(recorderDiff.environment.reasons.includes('recorder'));

    const gitProject = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-untracked-project-'));
    t.after(() => fs.rm(gitProject, { recursive: true, force: true }));
    await execFileAsync('git', ['init', '-q'], { cwd: gitProject });
    const untracked = path.join(gitProject, 'src', 'ria', 'untracked-executor.mjs');
    await fs.mkdir(path.dirname(untracked), { recursive: true });
    const untrackedContent = 'export const untrackedExecutor = 42;\n';
    await fs.writeFile(untracked, untrackedContent);
    const environment = await captureEnvironment(gitProject, { executionFiles: [untracked] });
    assert.deepEqual(environment.git.untrackedExecutionFiles, [{
        path: 'src/ria/untracked-executor.mjs',
        sha256: sha256(untrackedContent)
    }]);
    assert.equal(
        environment.git.untrackedExecutionHash,
        hashJson(environment.git.untrackedExecutionFiles)
    );
});
