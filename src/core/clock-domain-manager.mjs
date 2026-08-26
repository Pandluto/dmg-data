import { LocalClock } from './local-clock.mjs';

/**
 * The common validation helpers intentionally live in this module instead of
 * relying on coercion in LocalClock.  A clock-domain boundary is an input
 * boundary for the rest of the runtime, so accepting NaN/Infinity here makes a
 * later trace impossible to audit.
 */
function nonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return number;
}

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
    return number;
}

function identifier(value, label, { allowNull = false } = {}) {
    if (allowNull && (value === null || value === undefined)) return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function objectInput(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function clone(value) {
    if (value === undefined) return undefined;
    // structuredClone is available in the supported Node versions.  The
    // fallback keeps this small utility usable in older embedded runners.
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function normalizeDomainDefinition(definition) {
    const input = typeof definition === 'string' ? { id: definition } : objectInput(definition, 'domain definition');
    return {
        id: identifier(input.id, 'domain id'),
        kind: identifier(input.kind ?? 'Local', 'domain kind'),
        ownerId: identifier(input.ownerId, 'domain ownerId', { allowNull: true })
    };
}

function normalizePauseDefinition(definition) {
    const input = objectInput(definition, 'pause definition');
    const frame = nonNegativeInteger(input.frame, 'pause frame');
    const hasDuration = input.durationTicks !== undefined;
    const hasExcluded = input.excludedTicks !== undefined;
    if (!hasDuration && !hasExcluded) {
        // A non-discrete time scale is only metadata in this implementation.
        // Requiring excludedTicks prevents silently inventing a curve sample.
        if (input.requestedScale !== undefined
            && finiteNumber(input.requestedScale, 'requestedScale') !== 1) {
            throw new Error('Time dilation requires caller-supplied excludedTicks.');
        }
        throw new TypeError('pause definition requires durationTicks or excludedTicks.');
    }
    const durationTicks = nonNegativeInteger(
        hasExcluded ? input.excludedTicks : input.durationTicks,
        hasExcluded ? 'pause excludedTicks' : 'pause durationTicks'
    );
    if (hasDuration && hasExcluded
        && nonNegativeInteger(input.durationTicks, 'pause durationTicks') !== durationTicks) {
        throw new Error('durationTicks and excludedTicks must agree.');
    }

    let requestedScale = null;
    if (input.requestedScale !== undefined) {
        requestedScale = finiteNumber(input.requestedScale, 'requestedScale');
        if (requestedScale < 0) throw new RangeError('requestedScale must be non-negative.');
        if (requestedScale !== 1 && !hasExcluded) {
            throw new Error('Time dilation requires caller-supplied excludedTicks.');
        }
    }

    return {
        frame,
        durationTicks,
        excludedTicks: hasExcluded ? durationTicks : undefined,
        requestedScale,
        duration: input.duration,
        reason: input.reason ?? 'Unspecified',
        sourceId: identifier(input.sourceId, 'pause sourceId', { allowNull: true }),
        ownerId: identifier(input.ownerId, 'pause ownerId', { allowNull: true }),
        targetId: identifier(input.targetId, 'pause targetId', { allowNull: true }),
        sourceSkillId: identifier(input.sourceSkillId, 'pause sourceSkillId', { allowNull: true }),
        rootSkillId: identifier(input.rootSkillId, 'pause rootSkillId', { allowNull: true }),
        ruleId: identifier(input.ruleId ?? input.evidenceRuleId, 'pause ruleId', { allowNull: true })
    };
}

function normalizeTimerDefinition(definition) {
    const input = objectInput(definition, 'timer definition');
    const frame = nonNegativeInteger(input.frame, 'timer start frame');
    const durationTicks = nonNegativeInteger(input.durationTicks, 'timer duration');
    const priority = input.priority === undefined
        ? 80
        : finiteNumber(input.priority, 'timer priority');
    if (input.id !== undefined && input.timerId !== undefined && input.id !== input.timerId) {
        throw new Error('timer id and timerId must agree.');
    }
    const publicId = input.timerId ?? input.id ?? null;
    if (publicId !== null && typeof publicId !== 'string'
        && (typeof publicId !== 'number' || !Number.isFinite(publicId))) {
        throw new TypeError('timer id must be a string or finite number.');
    }
    if (typeof publicId === 'string' && publicId.trim() === '') {
        throw new TypeError('timer id must be a non-empty string.');
    }
    if (input.onComplete !== undefined && typeof input.onComplete !== 'function') {
        throw new TypeError('timer onComplete must be a function.');
    }
    return {
        frame,
        durationTicks,
        priority,
        label: input.label === undefined ? '' : String(input.label),
        publicId,
        sourceId: identifier(input.sourceId, 'timer sourceId', { allowNull: true }),
        ownerId: identifier(input.ownerId, 'timer ownerId', { allowNull: true }),
        targetId: identifier(input.targetId, 'timer targetId', { allowNull: true }),
        skillId: identifier(input.skillId, 'timer skillId', { allowNull: true }),
        rootSkillId: identifier(input.rootSkillId, 'timer rootSkillId', { allowNull: true }),
        reason: input.reason ?? 'Timer',
        ruleId: identifier(input.ruleId, 'timer ruleId', { allowNull: true }),
        onComplete: input.onComplete ?? (() => {})
    };
}

/**
 * Routes LocalClock instances by domain while keeping one auditable trace.
 * LocalClock remains the source of timer scheduling semantics; this class only
 * adds domain ownership, explicit routing, and trace context.
 */
export class ClockDomainManager {
    constructor({ schedule, tickRate = 30, clockFactory = null, domains = [] } = {}) {
        if (schedule !== undefined && typeof schedule !== 'function') {
            throw new TypeError('ClockDomainManager schedule must be a function.');
        }
        const normalizedTickRate = finiteNumber(tickRate, 'tickRate');
        if (normalizedTickRate <= 0) throw new RangeError('tickRate must be positive.');

        this.tickRate = normalizedTickRate;
        this.schedule = schedule ?? (() => {});
        if (clockFactory !== null && typeof clockFactory !== 'function') {
            throw new TypeError('clockFactory must be a function.');
        }
        this.clockFactory = clockFactory;
        this.domains = new Map();
        this.trace = [];
        this.#registerDomain({ id: 'global', kind: 'Global', ownerId: null });
        if (!Array.isArray(domains)) throw new TypeError('domains must be an array.');
        for (const definition of domains) this.registerDomain(definition);
    }

    #registerDomain(definition) {
        const normalized = normalizeDomainDefinition(definition);
        if (this.domains.has(normalized.id)) {
            throw new Error(`Clock domain already exists: ${normalized.id}`);
        }
        const clock = this.clockFactory
            ? this.clockFactory({
                schedule: this.schedule,
                name: normalized.id,
                tickRate: this.tickRate,
                definition: { ...normalized }
            })
            : new LocalClock({ schedule: this.schedule, name: normalized.id });
        if (!clock || typeof clock.localFrameAt !== 'function'
            || typeof clock.startTimer !== 'function' || typeof clock.pause !== 'function'
            || typeof clock.timer !== 'function' || typeof clock.snapshot !== 'function') {
            throw new TypeError('clockFactory must return a LocalClock-compatible object.');
        }
        const domain = {
            ...normalized,
            clock,
            timerIds: new Map(),
            timerDefinitions: new Map()
        };
        this.domains.set(normalized.id, domain);
        this.#record({
            frame: 0,
            stage: 'ClockDomainRegistered',
            domainId: normalized.id,
            sourceId: null,
            ownerId: normalized.ownerId,
            targetId: null,
            reason: 'RegisterDomain',
            ruleId: null,
            kind: normalized.kind
        });
        return domain;
    }

    registerDomain(definition) {
        const domain = this.#registerDomain(definition);
        return {
            id: domain.id,
            kind: domain.kind,
            ownerId: domain.ownerId
        };
    }

    hasDomain(domainId) {
        if (typeof domainId !== 'string'
            && (typeof domainId !== 'number' || !Number.isFinite(domainId))) return false;
        if (typeof domainId === 'string' && domainId.trim() === '') return false;
        return this.domains.has(domainId);
    }

    listDomains({ includeGlobal = true } = {}) {
        return [...this.domains.values()]
            .filter(domain => includeGlobal || domain.id !== 'global')
            .map(domain => ({
                id: domain.id,
                kind: domain.kind,
                ownerId: domain.ownerId
            }));
    }

    #domain(domainId) {
        const id = identifier(domainId, 'domain id');
        const domain = this.domains.get(id);
        if (!domain) throw new Error(`Unknown clock domain: ${id}`);
        return domain;
    }

    #record(record) {
        const frame = record.frame === undefined ? 0 : nonNegativeInteger(record.frame, 'trace frame');
        const stage = record.stage ?? record.type ?? 'ClockEvent';
        const {
            frame: ignoredFrame,
            stage: ignoredStage,
            type: ignoredType,
            sourceId: ignoredSourceId,
            ownerId: ignoredOwnerId,
            targetId: ignoredTargetId,
            reason: ignoredReason,
            ruleId: ignoredRuleId,
            ...extra
        } = record;
        const normalized = {
            frame,
            stage,
            type: record.type ?? stage,
            sourceId: record.sourceId ?? null,
            ownerId: record.ownerId ?? null,
            targetId: record.targetId ?? null,
            reason: record.reason ?? null,
            ruleId: record.ruleId ?? null,
            ...extra
        };
        this.trace.push(normalized);
        return normalized;
    }

    localFrameAt(domainId, globalFrame) {
        const domain = this.#domain(domainId);
        const frame = nonNegativeInteger(globalFrame, 'global frame');
        const localFrame = domain.clock.localFrameAt(frame);
        if (!Number.isFinite(localFrame)) throw new Error('Clock returned a non-finite local frame.');
        this.#record({
            frame,
            stage: 'LocalFrameRead',
            domainId: domain.id,
            localFrame,
            sourceId: null,
            ownerId: domain.ownerId,
            targetId: null,
            reason: 'LocalFrameAt',
            ruleId: null
        });
        return localFrame;
    }

    startTimer(domainId, definition) {
        const domain = this.#domain(domainId);
        const input = normalizeTimerDefinition(definition);
        if (input.publicId !== null && domain.timerIds.has(input.publicId)) {
            throw new Error(`Timer already exists in ${domain.id}: ${input.publicId}`);
        }

        let publicId = input.publicId;
        const localTimerId = domain.clock.startTimer({
            frame: input.frame,
            durationTicks: input.durationTicks,
            priority: input.priority,
            label: input.label,
            onComplete: (completionFrame, completedLocalId) => {
                const resolvedPublicId = publicId ?? completedLocalId;
                this.#record({
                    frame: completionFrame,
                    stage: 'TimerCompleted',
                    domainId: domain.id,
                    timerId: resolvedPublicId,
                    localTimerId: completedLocalId,
                    label: input.label,
                    sourceId: input.sourceId,
                    ownerId: input.ownerId ?? domain.ownerId,
                    targetId: input.targetId,
                    skillId: input.skillId,
                    rootSkillId: input.rootSkillId,
                    reason: input.reason,
                    ruleId: input.ruleId
                });
                input.onComplete(completionFrame, resolvedPublicId);
            }
        });
        publicId = input.publicId ?? localTimerId;
        domain.timerIds.set(publicId, localTimerId);
        domain.timerDefinitions.set(publicId, {
            ...input,
            publicId,
            localTimerId,
            domainId: domain.id
        });
        this.#record({
            frame: input.frame,
            stage: 'TimerStarted',
            domainId: domain.id,
            timerId: publicId,
            localTimerId,
            label: input.label,
            durationTicks: input.durationTicks,
            priority: input.priority,
            sourceId: input.sourceId,
            ownerId: input.ownerId ?? domain.ownerId,
            targetId: input.targetId,
            skillId: input.skillId,
            rootSkillId: input.rootSkillId,
            reason: input.reason,
            ruleId: input.ruleId,
            startLocalFrame: domain.clock.timer(localTimerId)?.startLocalFrame,
            deadlineFrame: domain.clock.timer(localTimerId)?.deadlineFrame
        });
        return publicId;
    }

    pause(domainId, definition) {
        const domain = this.#domain(domainId);
        const input = normalizePauseDefinition(definition);
        if (input.durationTicks === 0) {
            return null;
        }
        const result = domain.clock.pause({
            frame: input.frame,
            durationTicks: input.durationTicks,
            reason: input.reason,
            sourceSkillId: input.sourceSkillId,
            rootSkillId: input.rootSkillId,
            evidenceRuleId: input.ruleId
        });
        if (!result) return null;
        const delayedTimers = (result.delayedTimers ?? []).map(timer => ({
            ...timer,
            timerId: [...domain.timerIds.entries()]
                .find(([, localTimerId]) => localTimerId === timer.timerId)?.[0] ?? timer.timerId
        }));
        return this.#record({
            frame: input.frame,
            stage: 'ClockPaused',
            domainId: domain.id,
            localFrameBeforePause: result.localFrameBeforePause,
            localFrameAfterPause: result.localFrameAfterPause,
            durationTicks: input.durationTicks,
            excludedTicks: input.excludedTicks,
            requestedScale: input.requestedScale,
            duration: input.duration,
            delayedTimers,
            sourceId: input.sourceId,
            ownerId: input.ownerId ?? domain.ownerId,
            targetId: input.targetId,
            sourceSkillId: input.sourceSkillId,
            rootSkillId: input.rootSkillId,
            reason: input.reason,
            ruleId: input.ruleId
        });
    }

    pauseMany(domainIds, definition) {
        if (!Array.isArray(domainIds) || domainIds.length === 0) {
            throw new TypeError('pauseMany domainIds must be a non-empty array.');
        }
        const ids = domainIds.map(id => identifier(id, 'domain id'));
        if (new Set(ids).size !== ids.length) throw new Error('pauseMany domainIds must be unique.');
        // Resolve all domains and normalize the definition before mutating any
        // of them so a typo cannot produce a partial multi-domain pause.
        ids.forEach(id => this.#domain(id));
        const input = normalizePauseDefinition(definition);
        const records = ids.map(id => this.pause(id, input));
        this.#record({
            frame: input.frame,
            stage: 'ClockPausedMany',
            domainIds: [...ids],
            durationTicks: input.durationTicks,
            excludedTicks: input.excludedTicks,
            requestedScale: input.requestedScale,
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: input.targetId,
            reason: input.reason,
            ruleId: input.ruleId
        });
        return records;
    }

    timer(domainId, timerId) {
        const domain = this.#domain(domainId);
        if (typeof timerId !== 'string'
            && (typeof timerId !== 'number' || !Number.isFinite(timerId))) {
            throw new TypeError('timer id must be a string or finite number.');
        }
        const localTimerId = domain.timerIds.get(timerId) ?? timerId;
        const timer = domain.clock.timer(localTimerId);
        if (!timer) return null;
        const publicDefinition = domain.timerDefinitions.get(timerId)
            ?? domain.timerDefinitions.get([...domain.timerIds.entries()]
                .find(([, localId]) => localId === localTimerId)?.[0]);
        return {
            ...timer,
            timerId,
            localTimerId,
            domainId: domain.id,
            sourceId: publicDefinition?.sourceId ?? null,
            ownerId: publicDefinition?.ownerId ?? domain.ownerId,
            targetId: publicDefinition?.targetId ?? null,
            skillId: publicDefinition?.skillId ?? null,
            rootSkillId: publicDefinition?.rootSkillId ?? null,
            reason: publicDefinition?.reason ?? null,
            ruleId: publicDefinition?.ruleId ?? null
        };
    }

    cancelTimer(domainId, timerId, frame = 0, reason = 'Cancelled') {
        const domain = this.#domain(domainId);
        const atFrame = nonNegativeInteger(frame, 'timer cancel frame');
        const localTimerId = domain.timerIds.get(timerId) ?? timerId;
        if (typeof domain.clock.cancelTimer !== 'function') return false;
        const cancelled = domain.clock.cancelTimer(localTimerId, atFrame, reason);
        if (cancelled) {
            this.#record({
                frame: atFrame,
                stage: 'TimerCancelled',
                domainId: domain.id,
                timerId,
                localTimerId,
                sourceId: null,
                ownerId: domain.ownerId,
                targetId: null,
                reason,
                ruleId: null
            });
        }
        return cancelled;
    }

    snapshot() {
        const domainSnapshots = [...this.domains.values()].map(domain => {
            const clockSnapshot = domain.clock.snapshot();
            return {
                id: domain.id,
                kind: domain.kind,
                ownerId: domain.ownerId,
                totalPausedTicks: clockSnapshot.totalPausedTicks,
                clock: clone(clockSnapshot),
                activeTimers: clockSnapshot.activeTimers.map(timer => ({
                    ...timer,
                    timerId: [...domain.timerIds.entries()]
                        .find(([, localTimerId]) => localTimerId === timer.id)?.[0] ?? timer.id,
                    localTimerId: timer.id,
                    domainId: domain.id
                }))
            };
        });
        const domains = domainSnapshots;
        const byDomainId = Object.fromEntries(domainSnapshots.map(domain => [String(domain.id), domain]));
        for (const [id, domain] of Object.entries(byDomainId)) domains[id] = domain;
        return {
            tickRate: this.tickRate,
            domains,
            byDomainId,
            trace: this.trace.map(record => clone(record))
        };
    }
}

export default ClockDomainManager;
