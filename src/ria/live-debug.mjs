import fs from 'node:fs/promises';
import path from 'node:path';
import { assertRiaId, newRiaId, RiaInputError, RiaError, sanitizeForArchive, atomicWriteJson, appendJsonLine, hashJson } from './common.mjs';
import { scanJsonlFile } from './jsonl-index.mjs';

export const LIVE_DEBUG_CAPABILITIES = Object.freeze({
    schemaVersion: 1,
    authority: 'browser-observations; engine facts remain in sealed RIA runs',
    sections: ['workbench', 'timeline', 'planner', 'calculation', 'inspection', 'report', 'ui', 'releaseLens'],
    events: ['interaction', 'app-action', 'console', 'error', 'network', 'state', 'calculation', 'command'],
    commands: ['inspect-command', 'open-details', 'set-panel', 'recalculate', 'snapshot', 'workspace-snapshot', 'edit-timeline', 'timeline-drag'],
    commandSchemas: {
        'timeline-drag': {
            type: 'object', additionalProperties: false,
            required: ['op', 'timelineId', 'buttonId', 'steps', 'finish'],
            properties: {
                op: { const: 'timeline-drag' },
                timelineId: { type: 'string', minLength: 1, maxLength: 96, pattern: '^(?!.*\\.\\.)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$', description: 'Must match the visible browser workspace.' },
                buttonId: { type: 'string', minLength: 1, maxLength: 96, pattern: '^(?!.*\\.\\.)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$', description: 'Existing visible timeline button ID or data-drag-source-id of a visible palette skill; placed queue buttons reject dragging.' },
                steps: { type: 'array', minItems: 1, maxItems: 12, items: {
                    type: 'object', additionalProperties: false, required: ['clientX', 'clientY'],
                    properties: { clientX: { type: 'number', minimum: 0, maximum: 100_000 },
                        clientY: { type: 'number', minimum: 0, maximum: 100_000 },
                        holdMs: { type: 'integer', minimum: 0, maximum: 1000, default: 0 } },
                } },
                finish: { enum: ['release', 'cancel'] },
            },
            description: 'DOM mouse-event replay in the connected visible development browser. Holds the existing button for 220 ms, then moves and holds at each viewport point. Total requested duration including the initial hold must be <= 5000 ms. Non-reentrant. Selection and final input remain observable in releaseLens and workbench/timeline sections; no engine execution or arbitrary JavaScript.',
        },
    },
    eventFilters: ['afterSequence', 'kind', 'runId', 'commandId', 'limit'],
    limits: { maxBodyBytes: 4_194_304, maxBatchEvents: 200, maxEventPageSize: 500 },
    routes: {
        sessions: '/api/ria/live/sessions',
        connect: '/api/ria/live/connect',
        snapshot: '/api/ria/live/sessions/SESSION_ID/snapshot',
        events: '/api/ria/live/sessions/SESSION_ID/events',
        commands: '/api/ria/live/sessions/SESSION_ID/commands',
        runs: '/api/ria/runs?sessionId=SESSION_ID',
    },
});

export function validateLiveCommand(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !LIVE_DEBUG_CAPABILITIES.commands.includes(input.op)) throw new RiaInputError('Unsupported live debug command.');
    if (input.op === 'timeline-drag') {
        if (Object.keys(input).some(key => !['op', 'timelineId', 'buttonId', 'steps', 'finish'].includes(key))) {
            throw new RiaInputError('Unknown timeline drag field.');
        }
        assertRiaId(input.timelineId, 'timelineId');
        assertRiaId(input.buttonId, 'buttonId');
        if (!['release', 'cancel'].includes(input.finish)) throw new RiaInputError('finish must be release or cancel.');
        if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 12) throw new RiaInputError('Expected 1 to 12 drag steps.');
        let duration = 220;
        for (const step of input.steps) {
            if (!step || typeof step !== 'object' || Array.isArray(step)
                || Object.keys(step).some(key => !['clientX', 'clientY', 'holdMs'].includes(key))) throw new RiaInputError('Invalid drag step.');
            for (const field of ['clientX', 'clientY']) if (!Number.isFinite(step[field]) || step[field] < 0 || step[field] > 100_000) {
                throw new RiaInputError(`${field} must be a finite viewport coordinate.`);
            }
            const holdMs = step.holdMs === undefined ? 0 : step.holdMs;
            if (!Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > 1000) throw new RiaInputError('holdMs must be an integer between 0 and 1000.');
            duration += holdMs;
        }
        if (duration > 5000) throw new RiaInputError('Timeline drag must finish within 5000 ms, including its 220 ms initial hold.');
        return input;
    }
    const allowed = new Set(['op', 'commandId', 'panel', 'timelineId', 'edit']);
    if (Object.keys(input).some(key => !allowed.has(key))) throw new RiaInputError('Unknown command field.');
    if (['inspect-command', 'open-details'].includes(input.op)) assertRiaId(input.commandId, 'commandId');
    if (input.timelineId !== undefined) assertRiaId(input.timelineId, 'timelineId');
    if (input.op === 'set-panel' && !['tools', 'combat'].includes(input.panel)) throw new RiaInputError('panel must be tools or combat.');
    if (input.op === 'edit-timeline') {
        assertRiaId(input.timelineId, 'timelineId');
        const edit = input.edit;
        if (!edit || !['add', 'remove'].includes(edit.kind)) throw new RiaInputError('edit.kind must be add or remove.');
        const fields = edit.kind === 'add' ? ['kind', 'characterId', 'runtimeSkillId', 'nodeIndex', 'staffIndex', 'releaseAnchor'] : ['kind', 'buttonId'];
        if (Object.keys(edit).some(key => !fields.includes(key))) throw new RiaInputError('Unknown timeline edit field.');
        if (edit.kind === 'add') {
            for (const field of ['characterId', 'runtimeSkillId']) assertRiaId(edit[field], field);
            for (const field of ['nodeIndex', 'staffIndex']) if (edit[field] !== undefined
                && (!Number.isSafeInteger(edit[field]) || edit[field] < 0)) throw new RiaInputError(`${field} must be a non-negative integer.`);
            if (edit.releaseAnchor !== undefined) {
                const anchor = edit.releaseAnchor;
                if (!anchor || anchor.schemaVersion !== 1
                    || !['group-start', 'action-start', 'action-end', 'damage-hit', 'timed-input'].includes(anchor.kind)
                    || !Number.isSafeInteger(anchor.debounceFrames) || anchor.debounceFrames < 0
                    || anchor.debounceFrames > 108_000) throw new RiaInputError('Invalid release anchor.');
                if (Object.keys(anchor).some(key => !['schemaVersion', 'kind', 'sourceButtonId', 'sourceHitId', 'sourceHitOffsetFrames', 'debounceFrames',
                    'sourceTimedInputId', 'sourceTimedInputOffsetFrames', 'sourceTimedInputKind', 'sourceTimedInputSkillId',
                    'sourceTimedInputStartOffsetFrames', 'sourceTimedInputEndOffsetFramesExclusive'].includes(key))) throw new RiaInputError('Unknown release anchor field.');
                if (anchor.kind !== 'group-start') assertRiaId(anchor.sourceButtonId, 'sourceButtonId');
                if ((anchor.kind === 'damage-hit' || anchor.sourceHitId !== undefined)
                    && (typeof anchor.sourceHitId !== 'string'
                        || !/^[A-Za-z0-9._:-]{1,256}$/.test(anchor.sourceHitId))) throw new RiaInputError('Invalid source hit ID.');
                if (anchor.kind === 'damage-hit' && (!Number.isSafeInteger(anchor.sourceHitOffsetFrames)
                    || anchor.sourceHitOffsetFrames < 0 || anchor.sourceHitOffsetFrames > 108_000)) throw new RiaInputError('Invalid hit anchor offset.');
                if (anchor.kind === 'timed-input') {
                    if (typeof anchor.sourceTimedInputId !== 'string'
                        || !/^[A-Za-z0-9._:-]{1,256}$/.test(anchor.sourceTimedInputId)
                        || !Number.isSafeInteger(anchor.sourceTimedInputOffsetFrames)
                        || anchor.sourceTimedInputOffsetFrames < 0
                        || anchor.sourceTimedInputOffsetFrames > 108_000) throw new RiaInputError('Invalid timed input anchor.');
                    if (anchor.sourceTimedInputKind !== undefined) {
                        if (!['broad', 'precision'].includes(anchor.sourceTimedInputKind)
                            || !Number.isSafeInteger(anchor.sourceTimedInputStartOffsetFrames)
                            || anchor.sourceTimedInputStartOffsetFrames < 0
                            || !Number.isSafeInteger(anchor.sourceTimedInputEndOffsetFramesExclusive)
                            || anchor.sourceTimedInputEndOffsetFramesExclusive <= anchor.sourceTimedInputStartOffsetFrames
                            || anchor.sourceTimedInputEndOffsetFramesExclusive > 108_000) throw new RiaInputError('Invalid timed input window.');
                    }
                    if (anchor.sourceTimedInputSkillId !== undefined) assertRiaId(anchor.sourceTimedInputSkillId, 'sourceTimedInputSkillId');
                }
            }
        } else assertRiaId(edit.buttonId, 'buttonId');
    } else if (input.edit !== undefined) throw new RiaInputError('edit requires edit-timeline.');
    return input;
}

/** Live observations are stored beside Sessions, never appended to an already sealed Run. */
export class RiaLiveDebug {
    constructor(archive) { this.archive = archive; this.sessions = new Map(); this.chains = new Map(); }
    directory(id) { return path.join(this.archive.root, 'live', assertRiaId(id, 'sessionId')); }
    async get(id) {
        assertRiaId(id, 'sessionId');
        if (!this.sessions.has(id)) {
            try {
                const session = JSON.parse(await fs.readFile(path.join(this.directory(id), 'session.json'), 'utf8'));
                const snapshotPath = path.join(this.directory(id), 'snapshot.json');
                const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
                let recovered = false;
                await scanJsonlFile(path.join(this.directory(id), 'events.jsonl'), {
                    onRecord: ({ value }) => {
                        session.sequence = Math.max(session.sequence, value.sequence);
                        session.lastClientSequence = Math.max(session.lastClientSequence, value.clientSequence ?? 0);
                        if (value.kind === 'state' && value.revision > snapshot.revision) {
                            Object.assign(snapshot.sections, value.sections);
                            snapshot.revision = value.revision; recovered = true;
                        }
                        return true;
                    },
                });
                session.revision = Math.max(session.revision, snapshot.revision);
                if (recovered) await atomicWriteJson(snapshotPath, snapshot);
                // A restarted server cannot claim its old browser connection is still live.
                session.connected = false;
                this.sessions.set(id, session);
            } catch (error) {
                if (error.code === 'ENOENT') throw new RiaError('Live session not found.', 'RIA_LIVE_NOT_FOUND', 404);
                throw error;
            }
        }
        return this.sessions.get(id);
    }
    async list() {
        await fs.mkdir(path.join(this.archive.root, 'live'), { recursive: true });
        for (const id of await fs.readdir(path.join(this.archive.root, 'live'))) await this.get(id);
        return [...this.sessions.values()].map(({ commands, ...session }) => ({
            ...session, connected: session.connected && Date.now() - Date.parse(session.lastSeenAt) < 15_000,
        })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    }
    async connect(input) {
        const caseId = newRiaId('browser-case');
        const sessionId = newRiaId('browser');
        await this.archive.createCase({ caseId, title: 'LTS browser investigation', tags: ['live-ui'] });
        await this.archive.createSession({ caseId, sessionId, actor: 'lts-ui', summary: 'Continuous browser interactions and exact calculation runs.' });
        const now = new Date().toISOString();
        const session = { schemaVersion: 1, caseId, sessionId, createdAt: now, lastSeenAt: now,
            connected: true, sequence: 0, revision: 0, lastClientSequence: 0,
            browser: sanitizeForArchive(input, { projectRoot: this.archive.projectRoot }), commands: [] };
        await fs.mkdir(this.directory(sessionId), { recursive: true });
        await atomicWriteJson(path.join(this.directory(sessionId), 'snapshot.json'), { revision: 0, sections: {} });
        await this.persist(session);
        this.sessions.set(sessionId, session);
        return { caseId, sessionId, capabilities: LIVE_DEBUG_CAPABILITIES };
    }
    async persist(session) { await atomicWriteJson(path.join(this.directory(session.sessionId), 'session.json'), session); }
    async serialized(id, action) {
        const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
        this.chains.set(id, next);
        try { return await next; } finally { if (this.chains.get(id) === next) this.chains.delete(id); }
    }
    async append(session, event) {
        const entry = sanitizeForArchive({ ...event, sequence: session.sequence + 1,
            receivedAt: new Date().toISOString(), sessionId: session.sessionId }, { projectRoot: this.archive.projectRoot });
        await appendJsonLine(path.join(this.directory(session.sessionId), 'events.jsonl'), entry);
        session.sequence = entry.sequence;
        return entry;
    }
    async ingest(id, input) {
        if (!input || !Array.isArray(input.events) || input.events.length > 200
            || !input.sections || typeof input.sections !== 'object' || Array.isArray(input.sections)) throw new RiaInputError('Expected events and sections.');
        if (Object.keys(input.sections).some(key => !LIVE_DEBUG_CAPABILITIES.sections.includes(key))) throw new RiaInputError('Unknown snapshot section.');
        let previousClientSequence = 0;
        for (const event of input.events) {
            if (!event || !Number.isSafeInteger(event.clientSequence) || event.clientSequence < 1
                || event.clientSequence <= previousClientSequence
                || !LIVE_DEBUG_CAPABILITIES.events.includes(event.kind)) throw new RiaInputError('Invalid browser event.');
            previousClientSequence = event.clientSequence;
        }
        return this.serialized(id, async () => {
            const session = await this.get(id);
            if ((await this.archive.getCase(session.caseId)).status !== 'open') throw new RiaError('Case is closed.', 'RIA_CASE_CLOSED', 409);
            const document = await this.snapshot(id);
            for (const event of input.events) {
                // A retried HTTP batch must not duplicate interactions.
                if (event.clientSequence <= session.lastClientSequence) continue;
                await this.append(session, event);
                session.lastClientSequence = event.clientSequence;
            }
            const changed = {};
            for (const [name, value] of Object.entries(input.sections)) {
                const sanitized = sanitizeForArchive(value, { projectRoot: this.archive.projectRoot });
                if (hashJson(document.sections[name]) !== hashJson(sanitized)) changed[name] = sanitized;
            }
            if (Object.keys(changed).length) {
                session.revision += 1;
                // Store changed values, so a drag can be reconstructed from before/after snapshots.
                await this.append(session, { kind: 'state', type: 'SnapshotChanged', revision: session.revision,
                    sections: changed, runId: input.runId ?? null });
                await atomicWriteJson(path.join(this.directory(id), 'snapshot.json'), {
                    revision: session.revision, capturedAt: new Date().toISOString(),
                    sections: { ...document.sections, ...changed },
                });
            }
            session.connected = true;
            session.lastSeenAt = new Date().toISOString();
            await this.persist(session);
            return { accepted: true, sequence: session.sequence, revision: session.revision, lastClientSequence: session.lastClientSequence };
        });
    }
    async snapshot(id) {
        const session = await this.get(id);
        const value = JSON.parse(await fs.readFile(path.join(this.directory(id), 'snapshot.json'), 'utf8'));
        return { ...value, sessionId: id, caseId: session.caseId, lastSeenAt: session.lastSeenAt,
            connected: session.connected && Date.now() - Date.parse(session.lastSeenAt) < 15_000 };
    }
    async events(id, filters = {}) {
        await this.get(id);
        const after = Number(filters.afterSequence ?? 0);
        const limit = Number(filters.limit ?? 100);
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RiaInputError('Invalid event cursor or limit.');
        const items = [];
        let hasMore = false;
        await scanJsonlFile(path.join(this.directory(id), 'events.jsonl'), {
            onRecord: ({ value }) => {
                if (value.sequence <= after || ['kind', 'runId', 'commandId'].some(key => filters[key] && value[key] !== filters[key])) return true;
                if (items.length === limit) { hasMore = true; return false; }
                items.push(value); return true;
            },
        });
        return { items, hasMore, nextAfterSequence: items.at(-1)?.sequence ?? after };
    }
    async enqueue(id, command) {
        validateLiveCommand(command);
        return this.serialized(id, async () => {
            const session = await this.get(id);
            if (!session.connected || Date.now() - Date.parse(session.lastSeenAt) > 15_000) throw new RiaError('Browser is disconnected.', 'RIA_BROWSER_OFFLINE', 409);
            if (session.commands.filter(item => item.status === 'pending').length >= 20) throw new RiaError('Command queue is full.', 'RIA_QUEUE_FULL', 429);
            const entry = { id: newRiaId('command'), command, status: 'pending', createdAt: new Date().toISOString() };
            session.commands = [...session.commands.slice(-199), entry];
            await this.append(session, { kind: 'command', type: 'CommandRequested', ...entry });
            await this.persist(session);
            return entry;
        });
    }
    async complete(id, commandId, result) {
        if (!['done', 'error'].includes(result?.status)) throw new RiaInputError('Invalid command result status.');
        return this.serialized(id, async () => {
            const session = await this.get(id);
            const entry = session.commands.find(item => item.id === commandId);
            if (!entry) throw new RiaError('Command not found.', 'RIA_COMMAND_NOT_FOUND', 404);
            if (entry.status !== 'pending') return entry;
            Object.assign(entry, sanitizeForArchive({ status: result.status, result: result.result ?? null, error: result.error ?? null }), { completedAt: new Date().toISOString() });
            await this.append(session, { kind: 'command', type: 'CommandCompleted', ...entry });
            await this.persist(session);
            return entry;
        });
    }
}
