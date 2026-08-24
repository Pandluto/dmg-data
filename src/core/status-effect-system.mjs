function requireId(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function frameNumber(value, label = 'frame') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return number;
}

function finiteNonNegative(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`${label} must be a finite non-negative number.`);
    }
    return number;
}

function definitionFrom(definitions, buffId) {
    if (definitions instanceof Map) return definitions.get(buffId) ?? {};
    return definitions?.[buffId] ?? {};
}

function plainClone(value) {
    if (value === undefined) return undefined;
    return structuredClone(value);
}

function resolveDescriptor(descriptor, blackboard, fallback = 0) {
    if (descriptor === undefined || descriptor === null) return fallback;
    if (typeof descriptor === 'number' || typeof descriptor === 'string') return descriptor;
    if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
        return blackboard?.[descriptor.blackboardKey] ?? descriptor.value ?? fallback;
    }
    return descriptor.value ?? fallback;
}

function normalizedStacking(definition, input) {
    const raw = input.stacking ?? definition.stacking ?? {};
    const policy = input.stackingPolicy
        ?? definition.stackingPolicy
        ?? raw.stackingType
        ?? raw.type
        ?? 'Refresh';
    const aliases = {
        EnhanceAndRefresh: 'AddStack',
        EnhanceAndOverwriteDuration: 'AddStack',
        StackAndRefresh: 'AddStack',
        Stack: 'AddStack',
        Enhance: 'AddStack',
        HighPriorityWithMaxStack: 'AddStack',
        HighPriority: 'Replace',
        OverwriteDuration: 'Refresh',
        Extend: 'Refresh',
        Modify: 'Refresh',
        Unique: 'Unique',
        Replace: 'Replace',
        Independent: 'Independent',
        Unlimited: 'Independent',
        Refresh: 'Refresh',
        AddStack: 'AddStack'
    };
    if (!aliases[policy]) throw new Error(`Unsupported status-effect stacking policy: ${policy}`);
    const requestedMaxStacks = Number(input.maxStacks
        ?? definition.maxStacks
        ?? raw.maxStackCount
        ?? 1);
    const maxStacks = aliases[policy] === 'Independent' && requestedMaxStacks === 0
        ? 1
        : requestedMaxStacks;
    if (!Number.isInteger(maxStacks) || maxStacks < 1) {
        throw new Error('maxStacks must be a positive integer.');
    }
    const scope = input.stackingScope ?? definition.stackingScope ?? 'Target';
    if (!['Target', 'Source', 'Owner'].includes(scope)) {
        throw new Error(`Unsupported status-effect stacking scope: ${scope}`);
    }
    const configuredKey = input.stackingKey
        ?? definition.stackingKey
        ?? raw.stackingKey;
    const identifierType = input.stackingIdentifierType
        ?? definition.stackingIdentifierType
        ?? raw.identifierType
        ?? 'Id';
    if (!['Id', 'StackingKey'].includes(identifierType)) {
        throw new Error(`Unsupported status-effect stacking identifier: ${identifierType}`);
    }
    return {
        policy: aliases[policy],
        key: configuredKey === undefined || configuredKey === null || configuredKey === ''
            ? input.buffId
            : configuredKey,
        identifierType,
        scope,
        maxStacks
    };
}

/**
 * Entity-aware status-effect store used by the general combat runtime.
 *
 * It intentionally does not replace BuffMachine: the latter remains the exact
 * Pelica implementation while this class provides explicit source ownership,
 * configurable stacking and lifecycle routing for generic effects.
 */
export class StatusEffectSystem {
    constructor({
        definitions = new Map(),
        schedule = null,
        clockDomains = null,
        tickRate = 30,
        executeActions = () => []
    } = {}) {
        if (schedule !== null && typeof schedule !== 'function') {
            throw new Error('schedule must be a function when provided.');
        }
        if (typeof executeActions !== 'function') {
            throw new Error('executeActions must be a function.');
        }
        this.definitions = definitions;
        this.schedule = schedule;
        this.clockDomains = clockDomains;
        this.tickRate = finiteNonNegative(tickRate, 'tickRate');
        if (this.tickRate === 0) throw new Error('tickRate must be greater than zero.');
        this.executeActions = executeActions;
        this.instances = new Map();
        this.trace = [];
        this.nextInstanceId = 1;
    }

    apply(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.apply requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const buffId = requireId(input.buffId, 'buffId');
        const targetId = requireId(input.targetId ?? eventContext.targetId, 'targetId');
        const definition = definitionFrom(this.definitions, buffId);
        const stacking = normalizedStacking(definition, input);
        const attribution = {
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            // Owner and source are deliberately independent. Summons, auras
            // and derived effects must explicitly choose either identity.
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            targetId,
            sourceSkillId: input.sourceSkillId ?? eventContext.skillId ?? null,
            rootSkillId: input.rootSkillId ?? eventContext.rootSkillId ?? null,
            castId: input.castId ?? eventContext.castId ?? null,
            clockDomainId: input.clockDomainId ?? eventContext.clockDomainId ?? 'global',
            ruleId: input.ruleId ?? eventContext.ruleId ?? null
        };
        const nextBlackboard = {
            ...plainClone(definition.blackboard ?? {}),
            ...(input.inheritEventBlackboard === false
                ? {}
                : plainClone(eventContext.blackboard ?? {})),
            ...plainClone(input.blackboard ?? {})
        };
        const durationTicks = this.#durationTicks(input, definition, nextBlackboard);
        const existing = this.#matchingInstance(targetId, buffId, stacking, attribution);

        if (existing && stacking.policy === 'Unique') {
            this.trace.push(this.#record(existing, frame, 'StatusEffectIgnored', {
                reason: 'UniqueAlreadyActive'
            }));
            return this.#publicInstance(existing);
        }
        if (existing && stacking.policy === 'Replace') {
            this.finish({ frame, instanceId: existing.instanceId, reason: 'Replaced' }, eventContext);
        }
        if (existing && ['Refresh', 'AddStack'].includes(stacking.policy)) {
            const before = existing.stackCount;
            this.#cancelTimer(existing, frame, 'Refreshed');
            if (stacking.policy === 'AddStack') {
                existing.stackCount = Math.min(existing.maxStacks, existing.stackCount + 1);
            }
            existing.blackboard = { ...existing.blackboard, ...nextBlackboard };
            existing.generation += 1;
            existing.startFrame = frame;
            existing.durationTicks = durationTicks;
            existing.expireFrame = durationTicks === null ? null : frame + durationTicks;
            Object.assign(existing, attribution);
            this.#scheduleExpiry(existing);
            this.#schedulePeriodicTrigger(existing, frame);
            this.trace.push(this.#record(existing, frame, 'StatusEffectRefreshed', {
                before,
                requested: before + (stacking.policy === 'AddStack' ? 1 : 0),
                actual: existing.stackCount - before,
                discarded: stacking.policy === 'AddStack'
                    ? Math.max(0, before + 1 - existing.stackCount)
                    : 0,
                after: existing.stackCount
            }));
            if (input.triggerEnhancementEvent === true
                && !existing.processingEnhancement) {
                existing.processingEnhancement = true;
                try {
                    this.#executeLifecycle(
                        this.#eventActions(definition, 'OnBuffAfterTryEnhanced'),
                        existing,
                        frame,
                        'OnBuffAfterTryEnhanced',
                        eventContext
                    );
                } finally {
                    existing.processingEnhancement = false;
                }
            }
            this.#executeLifecycle(definition.onRefreshActions ?? [], existing, frame, 'OnBuffRefresh');
            this.#executeLifecycle(
                definition.duringEnableActions ?? this.#eventActions(definition, 'DuringBuffEnable'),
                existing,
                frame,
                'DuringBuffEnable'
            );
            return this.#publicInstance(existing);
        }

        const requestedStackCount = Number(input.stackCount ?? 1);
        if (!Number.isInteger(requestedStackCount) || requestedStackCount < 1) {
            throw new Error('stackCount must be a positive integer.');
        }
        const instance = {
            instanceId: `status:${this.nextInstanceId++}`,
            buffId,
            definition,
            stackingKey: stacking.key,
            stackingIdentifierType: stacking.identifierType,
            stackingPolicy: stacking.policy,
            stackingScope: stacking.scope,
            stackCount: Math.min(requestedStackCount, stacking.maxStacks),
            maxStacks: stacking.maxStacks,
            ...attribution,
            blackboard: nextBlackboard,
            metadata: plainClone(input.metadata ?? {}),
            startFrame: frame,
            durationTicks,
            expireFrame: durationTicks === null ? null : frame + durationTicks,
            generation: 1,
            active: true,
            timerId: null,
            triggerTimerId: null,
            timelineTimerIds: [],
            triggerCount: 0,
            processingEnhancement: false
        };
        this.instances.set(instance.instanceId, instance);
        this.#scheduleExpiry(instance);
        this.trace.push(this.#record(instance, frame, 'StatusEffectApplied', {
            before: 0,
            requested: instance.stackCount,
            actual: instance.stackCount,
            discarded: 0,
            after: instance.stackCount
        }));
        this.#executeLifecycle(
            definition.onApplyActions ?? definition.startActions ?? [],
            instance,
            frame,
            'OnBuffStart'
        );
        this.#executeLifecycle(
            definition.onEnableActions ?? this.#eventActions(definition, 'OnBuffEnable'),
            instance,
            frame,
            'OnBuffEnable'
        );
        this.#executeLifecycle(
            definition.duringEnableActions ?? this.#eventActions(definition, 'DuringBuffEnable'),
            instance,
            frame,
            'DuringBuffEnable'
        );
        this.#scheduleTimeline(instance, frame);
        this.#schedulePeriodicTrigger(instance, frame);
        return this.#publicInstance(instance);
    }

    trigger(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.trigger requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const eventType = input.eventType ?? eventContext.eventType ?? 'OnBuffTrigger';
        const matches = this.#select(input).filter(instance => instance.active);
        const results = [];
        for (const instance of matches) {
            const actions = input.actions
                ?? this.#eventActions(instance.definition, eventType);
            const result = this.#executeLifecycle(actions, instance, frame, eventType);
            if (eventType === 'OnBuffTrigger') instance.triggerCount += 1;
            this.trace.push(this.#record(instance, frame, 'StatusEffectTriggered', {
                eventType,
                triggerCount: instance.triggerCount,
                actionCount: Array.isArray(actions) ? actions.length : 0
            }));
            results.push({ instance: this.#publicInstance(instance), result });
        }
        return results;
    }

    notifyAbilityEvent(eventContext = {}) {
        if (!eventContext || typeof eventContext !== 'object') {
            throw new Error('notifyAbilityEvent requires an event context object.');
        }
        const frame = frameNumber(eventContext.frame ?? 0);
        const eventType = eventContext.eventType;
        if (typeof eventType !== 'string' || eventType.length === 0) {
            throw new Error('notifyAbilityEvent requires eventType.');
        }
        const listenerTargetId = eventContext.listenerTargetId
            ?? eventContext.sourceId
            ?? eventContext.ownerId;
        const matches = [...this.instances.values()].filter(instance => instance.active
            && (listenerTargetId === null || listenerTargetId === undefined
                || instance.targetId === listenerTargetId));
        const results = [];
        for (const instance of matches) {
            const groups = [
                ...(instance.definition.abilityEventActions ?? []),
                ...(instance.definition.igniteEventActions ?? [])
            ]
                .filter(group => group.eventType === eventType || group.eventName === eventType);
            for (const group of groups) {
                if (!instance.active) break;
                const result = this.#executeLifecycle(
                    group.actions ?? [],
                    instance,
                    frame,
                    eventType,
                    eventContext
                );
                this.trace.push(this.#record(instance, frame, 'AbilityEventHandled', {
                    eventType,
                    actionCount: group.actions?.length ?? 0
                }));
                const finished = group.finishAfterIgnited && instance.active
                    ? this.finish({
                        frame,
                        instanceId: instance.instanceId,
                        reason: `IgniteEvent:${eventType}`
                    }, eventContext)
                    : [];
                results.push({
                    instanceId: instance.instanceId,
                    buffId: instance.buffId,
                    eventType,
                    result,
                    finished
                });
            }
        }
        return results;
    }

    finish(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.finish requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const matches = this.#select(input).filter(instance => instance.active);
        for (const instance of matches) {
            const requestedLayers = input.finishAll === false
                ? Math.max(1, Math.trunc(Number(input.stackCount ?? 1)))
                : instance.stackCount;
            if (input.finishAll === false && requestedLayers < instance.stackCount) {
                const before = instance.stackCount;
                instance.stackCount -= requestedLayers;
                this.trace.push(this.#record(instance, frame, 'StatusEffectStackRemoved', {
                    reason: input.reason ?? 'Finished',
                    before,
                    requested: requestedLayers,
                    actual: requestedLayers,
                    discarded: 0,
                    after: instance.stackCount
                }));
                this.#executeLifecycle(
                    instance.definition.duringEnableActions
                        ?? this.#eventActions(instance.definition, 'DuringBuffEnable'),
                    instance,
                    frame,
                    'DuringBuffEnable'
                );
                continue;
            }
            instance.active = false;
            instance.generation += 1;
            this.#cancelTimer(instance, frame, input.reason ?? 'Finished');
            this.trace.push(this.#record(instance, frame, 'StatusEffectFinished', {
                reason: input.reason ?? 'Finished',
                before: instance.stackCount,
                requested: instance.stackCount,
                actual: instance.stackCount,
                discarded: 0,
                after: 0
            }));
            this.#executeLifecycle(
                instance.definition.onRemoveActions
                    ?? instance.definition.endActions
                    ?? this.#eventActions(instance.definition, 'OnBuffFinish'),
                instance,
                frame,
                'OnBuffFinish'
            );
        }
        return matches.map(instance => this.#publicInstance(instance));
    }

    removeBySource(sourceId, frame = 0, reason = 'SourceRemoved') {
        return this.finish({ sourceId, frame, reason });
    }

    removeByOwner(ownerId, frame = 0, reason = 'OwnerRemoved') {
        return this.finish({ ownerId, frame, reason });
    }

    removeByTarget(targetId, frame = 0, reason = 'TargetRemoved') {
        return this.finish({ targetId, frame, reason });
    }

    has({ targetId, buffId = null, stackingKey = null, sourceId = undefined, ownerId = undefined }) {
        return [...this.instances.values()].some(instance => instance.active
            && instance.targetId === targetId
            && (buffId === null || instance.buffId === buffId)
            && (stackingKey === null || instance.stackingKey === stackingKey)
            && (sourceId === undefined || instance.sourceId === sourceId)
            && (ownerId === undefined || instance.ownerId === ownerId));
    }

    get(instanceId) {
        const instance = this.instances.get(instanceId);
        return instance ? this.#publicInstance(instance) : null;
    }

    getDefinition(buffId) {
        return plainClone(definitionFrom(this.definitions, buffId));
    }

    list(filter = {}) {
        return [...this.instances.values()]
            .filter(instance => filter.active === undefined || instance.active === filter.active)
            .filter(instance => filter.buffId === undefined || instance.buffId === filter.buffId)
            .filter(instance => filter.targetId === undefined || instance.targetId === filter.targetId)
            .filter(instance => filter.sourceId === undefined || instance.sourceId === filter.sourceId)
            .filter(instance => filter.ownerId === undefined || instance.ownerId === filter.ownerId)
            .map(instance => this.#publicInstance(instance));
    }

    snapshot() {
        return {
            instances: this.list(),
            activeCount: this.list({ active: true }).length,
            trace: plainClone(this.trace)
        };
    }

    #durationTicks(input, definition, blackboard = {}) {
        if (input.durationTicks !== undefined) {
            return input.durationTicks === null
                ? null
                : frameNumber(input.durationTicks, 'durationTicks');
        }
        if (input.durationSeconds !== undefined) {
            return input.durationSeconds === null
                ? null
                : Math.round(finiteNonNegative(input.durationSeconds, 'durationSeconds') * this.tickRate);
        }
        if (String(definition.lifeType ?? '').toLowerCase() === 'infinity') return null;
        if (definition.duration !== undefined && definition.duration !== null) {
            return Math.round(finiteNonNegative(
                resolveDescriptor(definition.duration, blackboard),
                'duration'
            ) * this.tickRate);
        }
        if (definition.durationTicks !== undefined && definition.durationTicks !== null) {
            return frameNumber(definition.durationTicks, 'durationTicks');
        }
        if (definition.durationSeconds !== undefined && definition.durationSeconds !== null) {
            return Math.round(finiteNonNegative(
                resolveDescriptor(definition.durationSeconds, blackboard),
                'durationSeconds'
            ) * this.tickRate);
        }
        return null;
    }

    #matchingInstance(targetId, buffId, stacking, attribution) {
        if (stacking.policy === 'Independent') return null;
        return [...this.instances.values()].find(instance => instance.active
            && instance.targetId === targetId
            && instance.stackingKey === stacking.key
            // AKE explicitly chooses identity-by-Id or identity-by-StackingKey.
            // The conduct trigger uses Id while its child uses StackingKey; the
            // shared text key must not merge those two identity domains.
            && (stacking.identifierType === 'StackingKey'
                ? instance.stackingIdentifierType === 'StackingKey'
                : instance.buffId === buffId)
            && (stacking.scope !== 'Source' || instance.sourceId === attribution.sourceId)
            && (stacking.scope !== 'Owner' || instance.ownerId === attribution.ownerId));
    }

    #select(selector) {
        if (selector.instanceId !== undefined) {
            const instance = this.instances.get(selector.instanceId);
            return instance ? [instance] : [];
        }
        return [...this.instances.values()]
            .filter(instance => selector.buffId === undefined || instance.buffId === selector.buffId)
            .filter(instance => {
                if (!Array.isArray(selector.tagIds) || selector.tagIds.length === 0) return true;
                const activeTags = new Set(instance.definition.tagIds ?? []);
                const matches = selector.tagIds.map(tagId => activeTags.has(tagId));
                switch (selector.tagQueryType ?? 'HasAny') {
                    case 'HasAll': return matches.every(Boolean);
                    case 'HasNone': return matches.every(match => !match);
                    case 'HasAny': return matches.some(Boolean);
                    default: throw new Error(
                        `Unsupported status-effect tag query: ${selector.tagQueryType}.`
                    );
                }
            })
            .filter(instance => selector.targetId === undefined || instance.targetId === selector.targetId)
            .filter(instance => selector.sourceId === undefined || instance.sourceId === selector.sourceId)
            .filter(instance => selector.ownerId === undefined || instance.ownerId === selector.ownerId)
            .filter(instance => selector.metadata === undefined
                || Object.entries(selector.metadata).every(([key, value]) =>
                    instance.metadata?.[key] === value))
            .filter(instance => selector.stackingKey === undefined
                || instance.stackingKey === selector.stackingKey);
    }

    #scheduleExpiry(instance) {
        if (instance.durationTicks === null) return;
        const generation = instance.generation;
        const onComplete = frame => {
            if (!instance.active || instance.generation !== generation) return;
            this.finish({ frame, instanceId: instance.instanceId, reason: 'Expired' });
        };
        if (this.clockDomains) {
            instance.timerId = this.clockDomains.startTimer(instance.clockDomainId, {
                frame: instance.startFrame,
                durationTicks: instance.durationTicks,
                priority: 90,
                label: `status-effect:${instance.buffId}:${instance.instanceId}`,
                onComplete
            });
            return;
        }
        if (!this.schedule) {
            throw new Error(`Cannot schedule finite status effect ${instance.buffId} without a scheduler.`);
        }
        const deadline = instance.expireFrame;
        this.schedule(deadline, 90, () => onComplete(deadline),
            `status-effect:${instance.buffId}:${instance.instanceId}`);
    }

    #triggerIntervalTicks(instance) {
        const definition = instance.definition;
        if (definition.triggerInterval !== undefined && definition.triggerInterval !== null) {
            const seconds = Number(resolveDescriptor(definition.triggerInterval, instance.blackboard, -1));
            if (!Number.isFinite(seconds)) throw new Error('trigger interval must be finite.');
            if (seconds <= 0) return null;
            return Math.max(1, Math.round(seconds * this.tickRate));
        }
        if (definition.triggerIntervalTicks !== undefined
            && definition.triggerIntervalTicks !== null) {
            return frameNumber(definition.triggerIntervalTicks, 'triggerIntervalTicks');
        }
        const descriptor = definition.triggerIntervalSeconds;
        if (descriptor === undefined || descriptor === null) return null;
        const seconds = Number(resolveDescriptor(descriptor, instance.blackboard, -1));
        if (!Number.isFinite(seconds)) throw new Error('trigger interval must be finite.');
        if (seconds <= 0) return null;
        return Math.max(1, Math.round(seconds * this.tickRate));
    }

    #maxTriggerCount(instance) {
        const descriptor = instance.definition.maxTriggerCnt
            ?? instance.definition.maxTriggerCount;
        if (descriptor === undefined || descriptor === null) return null;
        const value = Number(resolveDescriptor(descriptor, instance.blackboard, -1));
        if (!Number.isInteger(value)) throw new Error('max trigger count must be an integer.');
        return value < 0 ? null : value;
    }

    #schedulePeriodicTrigger(instance, frame) {
        if (!instance.active) return;
        if (instance.triggerTimerId !== null && this.clockDomains
            && typeof this.clockDomains.cancelTimer === 'function') {
            this.clockDomains.cancelTimer(
                instance.clockDomainId,
                instance.triggerTimerId,
                frame,
                'TriggerRescheduled'
            );
            instance.triggerTimerId = null;
        }
        const intervalTicks = this.#triggerIntervalTicks(instance);
        if (intervalTicks === null) return;
        const maxTriggerCount = this.#maxTriggerCount(instance);
        if (maxTriggerCount !== null && instance.triggerCount >= maxTriggerCount) return;
        const generation = instance.generation;
        const run = completionFrame => {
            if (!instance.active || instance.generation !== generation) return;
            instance.triggerTimerId = null;
            this.trigger({
                frame: completionFrame,
                instanceId: instance.instanceId,
                eventType: 'OnBuffTrigger'
            });
            this.#schedulePeriodicTrigger(instance, completionFrame);
        };
        const firstTriggerImmediate = instance.triggerCount === 0
            && instance.definition.waitFirstTriggerInterval === false;
        if (firstTriggerImmediate) {
            this.trigger({ frame, instanceId: instance.instanceId, eventType: 'OnBuffTrigger' });
            if (maxTriggerCount !== null && instance.triggerCount >= maxTriggerCount) return;
        }
        const delayTicks = instance.triggerCount === 0
            && instance.definition.firstTriggerDelayTicks !== undefined
            && instance.definition.firstTriggerDelayTicks !== null
            ? frameNumber(
                instance.definition.firstTriggerDelayTicks,
                'firstTriggerDelayTicks'
            )
            : intervalTicks;
        if (this.clockDomains) {
            instance.triggerTimerId = this.clockDomains.startTimer(instance.clockDomainId, {
                frame,
                durationTicks: delayTicks,
                priority: 80,
                label: `status-trigger:${instance.buffId}:${instance.instanceId}`,
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId: instance.targetId,
                skillId: instance.sourceSkillId,
                rootSkillId: instance.rootSkillId,
                reason: 'StatusEffectTrigger',
                ruleId: instance.ruleId,
                onComplete: run
            });
            return;
        }
        if (!this.schedule) {
            throw new Error(`Cannot schedule status trigger ${instance.buffId} without a scheduler.`);
        }
        const deadline = frame + delayTicks;
        this.schedule(deadline, 80, () => run(deadline),
            `status-trigger:${instance.buffId}:${instance.instanceId}`);
    }

    #scheduleTimeline(instance, frame) {
        const timeline = instance.definition.timeline ?? [];
        if (!Array.isArray(timeline) || timeline.length === 0) return;
        const generation = instance.generation;
        const schedulePhase = (group, phase, offset, priority, actions) => {
            if (!Array.isArray(actions) || actions.length === 0) return;
            const run = completionFrame => {
                if (!instance.active || instance.generation !== generation) return;
                this.#executeLifecycle(
                    actions,
                    instance,
                    completionFrame,
                    phase === 'start' ? 'BuffTimelineGroupStarted' : 'BuffTimelineGroupEnded'
                );
                this.trace.push(this.#record(
                    instance,
                    completionFrame,
                    'StatusEffectTimelineExecuted',
                    { groupIndex: group.groupIndex, phase, actionCount: actions.length }
                ));
            };
            const label = `status-timeline:${instance.instanceId}:${group.groupIndex}:${phase}`;
            if (this.clockDomains) {
                const timerId = this.clockDomains.startTimer(instance.clockDomainId, {
                    id: label,
                    frame,
                    durationTicks: frameNumber(offset, 'timeline frame offset'),
                    priority,
                    label,
                    sourceId: instance.sourceId,
                    ownerId: instance.ownerId,
                    targetId: instance.targetId,
                    skillId: instance.sourceSkillId,
                    rootSkillId: instance.rootSkillId,
                    ruleId: instance.ruleId,
                    reason: `StatusTimeline:${phase}`,
                    onComplete: run
                });
                instance.timelineTimerIds.push(timerId);
                return;
            }
            if (!this.schedule) {
                throw new Error(`Cannot schedule Buff timeline ${instance.buffId} without a scheduler.`);
            }
            const deadline = frame + frameNumber(offset, 'timeline frame offset');
            this.schedule(deadline, priority, () => run(deadline), label);
        };
        for (const group of timeline) {
            schedulePhase(group, 'start', Number(group.startFrame ?? 0), 50, group.actions);
            schedulePhase(
                group,
                'cleanup',
                Number(group.endFrame ?? group.startFrame ?? 0),
                60,
                group.cleanupActions
            );
        }
    }

    #cancelTimer(instance, frame, reason) {
        if (!this.clockDomains) return;
        if (typeof this.clockDomains.cancelTimer === 'function') {
            for (const timerId of [
                instance.timerId,
                instance.triggerTimerId,
                ...(instance.timelineTimerIds ?? [])
            ]) {
                if (timerId !== null) {
                    this.clockDomains.cancelTimer(instance.clockDomainId, timerId, frame, reason);
                }
            }
        }
        instance.timerId = null;
        instance.triggerTimerId = null;
        instance.timelineTimerIds = [];
    }

    #executeLifecycle(actions, instance, frame, eventType, incomingContext = {}) {
        if (!Array.isArray(actions) || actions.length === 0) return [];
        const execution = this.executeActions(actions, {
            frame,
            eventType,
            sourceId: instance.sourceId,
            // In serialized Buff actions, ActionOwner is the entity carrying
            // the Buff. The attribution owner remains stored on the instance
            // and is exposed separately in payload for cleanup/audit.
            ownerId: instance.targetId,
            targetId: instance.targetId,
            skillId: incomingContext.skillId ?? instance.sourceSkillId,
            rootSkillId: incomingContext.rootSkillId ?? instance.rootSkillId,
            castId: incomingContext.castId ?? instance.castId,
            buffInstanceId: instance.instanceId,
            clockDomainId: instance.clockDomainId,
            ruleId: instance.ruleId,
            blackboard: {
                ...plainClone(instance.blackboard),
                ...plainClone(incomingContext.blackboard ?? {})
            },
            payload: {
                buffId: instance.buffId,
                stackCount: instance.stackCount,
                statusMetadata: plainClone(instance.metadata),
                statusOwnerId: instance.ownerId,
                eventSourceId: incomingContext.sourceId ?? null,
                eventOwnerId: incomingContext.ownerId ?? null,
                eventTargetId: incomingContext.targetId ?? null,
                ...plainClone(incomingContext.payload ?? {})
            }
        });
        if (execution && typeof execution === 'object'
            && execution.eventContext?.blackboard
            && typeof execution.eventContext.blackboard === 'object') {
            instance.blackboard = plainClone(execution.eventContext.blackboard);
        }
        return execution?.result ?? execution;
    }

    #eventActions(definition, eventType) {
        return (definition.eventActions ?? [])
            .filter(group => group.eventType === eventType || group.eventName === eventType)
            .flatMap(group => group.actions ?? []);
    }

    #record(instance, frame, stage, extra = {}) {
        return {
            frame,
            stage,
            instanceId: instance.instanceId,
            buffId: instance.buffId,
            stackingKey: instance.stackingKey,
            stackingIdentifierType: instance.stackingIdentifierType,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            targetId: instance.targetId,
            sourceSkillId: instance.sourceSkillId,
            rootSkillId: instance.rootSkillId,
            castId: instance.castId,
            clockDomainId: instance.clockDomainId,
            ruleId: instance.ruleId,
            stackCount: instance.stackCount,
            durationTicks: instance.durationTicks,
            expireFrame: instance.expireFrame,
            ...extra
        };
    }

    #publicInstance(instance) {
        const { definition: _definition, generation: _generation, ...publicInstance } = instance;
        return plainClone(publicInstance);
    }
}
