import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createAkeDemoApi } from '../demo/ake-api.mjs';
import { LIVE_DEBUG_CAPABILITIES, validateLiveCommand } from '../src/ria/live-debug.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

test('timeline drag accepts only bounded existing-button gesture parameters', () => {
    const drag = { op: 'timeline-drag', timelineId: 'fixture.timeline', buttonId: 'fixture.button',
        steps: [{ clientX: 400.5, clientY: 240, holdMs: 180 }], finish: 'release' };
    assert.ok(LIVE_DEBUG_CAPABILITIES.commands.includes('timeline-drag'));
    assert.equal(LIVE_DEBUG_CAPABILITIES.commandSchemas['timeline-drag'].additionalProperties, false);
    assert.equal(validateLiveCommand(drag), drag);
    assert.equal(validateLiveCommand({ ...drag, finish: 'cancel', steps: [{ clientX: 0, clientY: 0 }] }).finish, 'cancel');
    assert.equal(validateLiveCommand({ ...drag, steps: Array.from({ length: 12 }, () => ({ clientX: 1, clientY: 2, holdMs: 0 })) }).steps.length, 12);
    assert.ok(validateLiveCommand({ ...drag, steps: [1000, 1000, 1000, 1000, 780].map(holdMs => ({ clientX: 1, clientY: 2, holdMs })) }));
    for (const patch of [{ timelineId: undefined }, { buttonId: undefined }, { buttonId: '../outside' },
        { finish: 'click' }, { script: '1+1' }, { selector: 'body' }, { edit: { kind: 'remove', buttonId: 'x' } },
        { steps: [] }, { steps: Array.from({ length: 13 }, () => ({ clientX: 1, clientY: 2 })) },
        { steps: Array.from({ length: 5 }, () => ({ clientX: 1, clientY: 2, holdMs: 1000 })) }]) {
        assert.throws(() => validateLiveCommand({ ...drag, ...patch }));
    }
    for (const patch of [{ clientX: NaN }, { clientY: Infinity }, { clientX: -1 }, { clientY: 100_001 },
        { clientX: '1' }, { clientY: undefined }, { holdMs: -1 }, { holdMs: 1001 }, { holdMs: 0.5 },
        { holdMs: null }, { holdMs: '180' }, { button: 2 }, { js: '1+1' }]) {
        assert.throws(() => validateLiveCommand({ ...drag, steps: [{ ...drag.steps[0], ...patch }] }));
    }
});

test('live browser observations survive retries and restart; commands stay scoped to one browser', async t => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ria-live-debug-'));
    let api = createAkeDemoApi({ projectRoot, archiveRoot, logger: { error() {} } });
    const server = http.createServer((req, res) => { void api.handle(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => { await api.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(archiveRoot, { recursive: true, force: true }); });
    const request = async (route, body, headers = {}) => {
        const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, value: await response.json() };
    };
    const a = (await request('/api/ria/live/connect', { title: 'Chrome A' })).value;
    const b = (await request('/api/ria/live/connect', { title: 'Chrome B' })).value;
    const route = `/api/ria/live/sessions/${a.sessionId}`;
    const batch = { events: [{ clientSequence: 1, kind: 'interaction', type: 'click', commandId: 'skill-a', payload: { password: 'do-not-save', button: 'skill-a' } }],
        sections: { inspection: { selectedCommandId: 'skill-a' },
            releaseLens: { active: true, sourceButtonId: 'skill-a', frame: 47, offsetFrames: 3,
                candidates: [{ kind: 'damage-hit', label: '第2击后', frame: 44 }] } } };
    assert.equal((await request(`${route}/ingest`, batch)).status, 202);
    assert.equal((await request(`${route}/ingest`, batch)).status, 202);
    let events = (await request(`${route}/events`)).value;
    assert.equal(events.items.filter(event => event.kind === 'interaction').length, 1);
    assert.equal(events.items[0].payload.password, '[REDACTED]');
    const command = (await request(`${route}/commands`, { op: 'inspect-command', commandId: 'skill-a' })).value;
    assert.equal((await request(`/api/ria/live/sessions/${b.sessionId}/commands`)).value.items.length, 0);
    assert.equal((await request(`${route}/commands`, { op: 'evaluate', script: '1+1' })).status, 400);
    const drag = { op: 'timeline-drag', timelineId: 'fixture.timeline', buttonId: 'skill-a',
        steps: [{ clientX: 400, clientY: 240, holdMs: 200 }], finish: 'cancel' };
    const queuedDrag = await request(`${route}/commands`, drag);
    assert.equal(queuedDrag.status, 202);
    assert.deepEqual(queuedDrag.value.command, drag);
    assert.equal((await request(`/api/ria/live/sessions/${b.sessionId}/commands`)).value.items.length, 0);
    const dragResult = { releaseLensOpened: true, finish: 'cancel', stepsExecuted: 1 };
    await request(`${route}/commands/${queuedDrag.value.id}`, { status: 'done', result: dragResult });
    assert.deepEqual((await request(`${route}/commands`)).value.items.find(item => item.id === queuedDrag.value.id).result, dragResult);
    const edit = { op: 'edit-timeline', timelineId: 'fixture.timeline', edit: {
        kind: 'add', characterId: 'chr_0027_tangtang',
        runtimeSkillId: 'chr_0027_tangtang_normal_skill', nodeIndex: 2, staffIndex: 1,
        releaseAnchor: { schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'fixture.attack',
            sourceHitId: 'fixture.attack:preview-hit:1', sourceHitOffsetFrames: 44, debounceFrames: 1 }
    } };
    assert.equal((await request(`${route}/commands`, { ...edit, timelineId: undefined })).status, 400);
    assert.equal((await request(`${route}/commands`, { ...edit, edit: { ...edit.edit, nodeIndex: -1 } })).status, 400);
    assert.equal((await request(`${route}/commands`, { ...edit, edit: { ...edit.edit, script: '1+1' } })).status, 400);
    assert.equal((await request(`${route}/commands`, { ...edit, edit: { ...edit.edit,
        releaseAnchor: { schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'fixture.attack',
            sourceHitId: 'fixture.hit', sourceHitOffsetFrames: -1, debounceFrames: 0 }
    } })).status, 400);
    assert.equal((await request(`${route}/commands`, { ...edit, edit: { ...edit.edit,
        releaseAnchor: { schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'fixture.attack',
            sourceHitOffsetFrames: 44, debounceFrames: 1 }
    } })).status, 400);
    const queuedEdit = await request(`${route}/commands`, edit);
    assert.equal(queuedEdit.status, 202);
    assert.deepEqual(queuedEdit.value.command, edit);
    assert.equal((await request(`/api/ria/live/sessions/${b.sessionId}/commands`)).value.items.length, 0);
    await request(`${route}/commands/${queuedEdit.value.id}`, { status: 'done', result: { buttonId: 'fixture.button' } });
    const timedEdit = { ...edit, edit: { ...edit.edit, releaseAnchor: { schemaVersion: 1,
        kind: 'timed-input', sourceButtonId: 'fixture.source', sourceTimedInputId: 'window:1',
        sourceTimedInputOffsetFrames: 57, debounceFrames: 0, sourceTimedInputKind: 'precision',
        sourceTimedInputSkillId: 'chr_0028_wulfa_combo_2_skill',
        sourceTimedInputStartOffsetFrames: 52, sourceTimedInputEndOffsetFramesExclusive: 64 } } };
    const timedCommand = await request(`${route}/commands`, timedEdit);
    assert.equal(timedCommand.status, 202);
    assert.deepEqual(timedCommand.value.command.edit.releaseAnchor, timedEdit.edit.releaseAnchor);
    await request(`${route}/commands/${timedCommand.value.id}`, { status: 'done', result: { buttonId: 'fixture.precise' } });
    for (const invalid of [{ sourceTimedInputOffsetFrames: -1 }, { sourceTimedInputKind: 'guess' },
        { sourceTimedInputStartOffsetFrames: 64 }, { sourceTimedInputEndOffsetFramesExclusive: 52 },
        { sourceTimedInputId: '' }, { sourceTimedInputSkillId: '' }]) {
        assert.equal((await request(`${route}/commands`, { ...timedEdit, edit: { ...timedEdit.edit,
            releaseAnchor: { ...timedEdit.edit.releaseAnchor, ...invalid } } })).status, 400);
    }
    assert.equal((await request(`${route}/commands`, { op: 'snapshot' }, { Origin: 'https://untrusted.example' })).status, 403);
    await request(`${route}/commands/${command.id}`, { status: 'done', result: { selectedCommandId: 'skill-a' } });
    assert.equal((await request(`${route}/commands?status=pending`)).value.items.length, 0);
    await api.close(); api = createAkeDemoApi({ projectRoot, archiveRoot, logger: { error() {} } });
    assert.equal((await request(`${route}/snapshot`)).value.sections.inspection.selectedCommandId, 'skill-a');
    assert.deepEqual((await request(`${route}/snapshot`)).value.sections.releaseLens, batch.sections.releaseLens);
    assert.equal((await request(`${route}/snapshot`)).value.connected, false);
    await request(`${route}/ingest`, batch);
    events = (await request(`${route}/events?kind=interaction&afterSequence=0&limit=1`)).value;
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0].commandId, 'skill-a');
    assert.equal((await request(`${route}/events?afterSequence=-1`)).status, 400);

    // The shared Vite/build API must execute and archive the identical input twice with independent run IDs.
    const fixture = JSON.parse(await fs.readFile(path.join(projectRoot, 'fixtures/ria/pelica-normal-skill.json'), 'utf8'));
    const runIds = [];
    for (let index = 0; index < 2; index += 1) {
        const start = await request('/api/ake/ria/start', { ...a, input: fixture.input });
        assert.equal(start.status, 202); const runId = start.value.runId; runIds.push(runId);
        const uiRoute = `/api/ria/runs/${runId}/ui-actions?caseId=${a.caseId}`;
        assert.equal((await request(uiRoute, { actionType: 'Requested', payload: {} }, { Origin: base })).status, 202);
        const simulation = await request('/api/ake/squad/simulate', fixture.input, { 'X-RIA-Case-ID': a.caseId, 'X-RIA-Run-ID': runId });
        assert.equal(simulation.status, 200);
        await request(uiRoute, { actionType: 'Completed', payload: { totalDamage: simulation.value.summary.totalDamage } });
        assert.equal((await request('/api/ake/ria/seal', { caseId: a.caseId, runId })).status, 200);
        const result = await request(`/api/ria/runs/${runId}/result?caseId=${a.caseId}`);
        assert.equal(result.value.summary.totalDamage, simulation.value.summary.totalDamage);
        assert.equal((await request(uiRoute, { actionType: 'TooLate', payload: {} })).status, 409);
    }
    assert.notEqual(runIds[0], runIds[1]);
});
