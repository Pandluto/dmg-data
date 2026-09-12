import { combatTriggerAttribution } from './combat-trigger-attribution.mjs';
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

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return number;
}

function definitionFrom(definitions, buffId) {
    if (definitions instanceof Map) return definitions.get(buffId) ?? null;
    return definitions?.[buffId] ?? null;
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

function actionAppliesBuff(actions, buffId) {
    for (const action of actions ?? []) {
        if (!action || typeof action !== 'object') continue;
        if (action.type === 'ApplyBuff') {
            if (action.buffId === buffId) return true;
            if ((action.buffs ?? []).some(candidate => candidate?.buffId === buffId)) return true;
        }
        for (const nested of [
            action.actions,
            action.success,
            action.failure,
            action.then,
            action.else
        ]) {
            if (Array.isArray(nested) && actionAppliesBuff(nested, buffId)) return true;
        }
    }
    return false;
}

function enhancementIsManagedByAbilityEvent(definition, buffId) {
    const enhancement = (definition.eventActions ?? []).find(group =>
        group.eventType === 'OnBuffAfterTryEnhanced');
    const eventTypes = new Set((enhancement?.actions ?? [])
        .filter(action => action?.type === 'TriggerStatusEvent')
        .map(action => action.eventType)
        .filter(Boolean));
    if (eventTypes.size === 0) return false;
    return (definition.igniteEventActions ?? []).some(group =>
        eventTypes.has(group.eventType) && actionAppliesBuff(group.actions, buffId));
}

function normalizedStacking(definition, input, blackboard = {}) {
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
        AddStack: 'AddStack',
        TimedGrowingEnhance: 'TimedGrowingEnhance'
    };
    if (!aliases[policy]) throw new Error(`Unsupported status-effect stacking policy: ${policy}`);
    const keyedMaxStacks = raw.maxStackCountKey
        ? blackboard?.[raw.maxStackCountKey]
        : undefined;
    const requestedMaxStacks = Number(input.maxStacks
        ?? keyedMaxStacks
        ?? definition.maxStacks
        ?? raw.maxStackCount
        ?? 1);
    // Zero and negative values are AKE sentinels (Unlimited and unresolved
    // keyed limits), never usable shared-stack caps. Independent instances do
    // not share this value, so one is also the correct public per-instance cap.
    const maxStacks = Number.isInteger(requestedMaxStacks) && requestedMaxStacks > 0
        ? requestedMaxStacks
        : 1;
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
    const lifetimePolicy = raw.lifetimePolicy ?? 'Shared';
    if (!['Shared', 'Independent'].includes(lifetimePolicy)
        || (lifetimePolicy === 'Independent' && aliases[policy] !== 'AddStack')) {
        throw new Error('Independent stack lifetime requires an AddStack policy.');
    }
    return {
        lifetimePolicy,
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
        executeActions = () => [],
        onTransition = () => {},
        onBlackboardChange = () => {},
        canConsumeBuff = () => ({ allowed: true })
    } = {}) {
        if (schedule !== null && typeof schedule !== 'function') {
            throw new Error('schedule must be a function when provided.');
        }
        if (typeof executeActions !== 'function') {
            throw new Error('executeActions must be a function.');
        }
        if (typeof onTransition !== 'function') {
            throw new Error('onTransition must be a function.');
        }
        if (typeof onBlackboardChange !== 'function') {
            throw new Error('onBlackboardChange must be a function.');
        }
        if (typeof canConsumeBuff !== 'function') {
            throw new Error('canConsumeBuff must be a function.');
        }
        this.definitions = definitions;
        this.schedule = schedule;
        this.clockDomains = clockDomains;
        this.tickRate = finiteNonNegative(tickRate, 'tickRate');
        if (this.tickRate === 0) throw new Error('tickRate must be greater than zero.');
        this.executeActions = executeActions;
        this.onTransition = onTransition;
        this.onBlackboardChange = onBlackboardChange;
        this.canConsumeBuff = canConsumeBuff;
        this.instances = new Map();
        this.trace = [];
        this.nextInstanceId = 1;
        this.nextEventSequence = 1;
    }

    apply(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.apply requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const buffId = requireId(input.buffId, 'buffId');
        const targetId = requireId(input.targetId ?? eventContext.targetId, 'targetId');
        const definition = definitionFrom(this.definitions, buffId);
        if (definition === null) {
            const unresolved = {
                eventId: `status-event:${this.nextEventSequence}`,
                sequence: this.nextEventSequence++,
                frame,
                stage: 'StatusEffectUnresolved',
                status: 'Unresolved',
                code: 'STATUS_DEFINITION_MISSING',
                reason: 'MissingStatusDefinition',
                instanceId: null,
                buffId,
                sourceId: input.sourceId ?? eventContext.sourceId ?? null,
                ownerId: input.ownerId ?? eventContext.ownerId ?? null,
                carrierId: targetId,
                targetId,
                damageSourceId: input.damageSourceId
                    ?? eventContext.damageSourceId
                    ?? input.sourceId
                    ?? eventContext.sourceId
                    ?? null,
                sourceSkillId: input.sourceSkillId ?? eventContext.skillId ?? null,
                rootSkillId: input.rootSkillId ?? eventContext.rootSkillId ?? null,
                castId: input.castId ?? eventContext.castId ?? null,
                rootCastId: input.rootCastId
                    ?? eventContext.rootCastId
                    ?? input.castId
                    ?? eventContext.castId
                    ?? null,
                parentCastId: input.parentCastId ?? eventContext.parentCastId ?? null,
                inputSkillId: input.inputSkillId
                    ?? eventContext.inputSkillId
                    ?? eventContext.rootSkillId
                    ?? null,
                inputCommandType: input.inputCommandType
                    ?? eventContext.inputCommandType
                    ?? eventContext.commandType
                    ?? null,
                effectiveSkillType: input.effectiveSkillType
                    ?? eventContext.effectiveSkillType
                    ?? eventContext.skillType
                    ?? null,
                transactionId: input.transactionId ?? eventContext.transactionId ?? null,
                parentEventId: input.parentEventId ?? eventContext.parentEventId ?? null,
                parentHitId: input.parentHitId ?? eventContext.parentHitId ?? null,
                hitEventPhase: input.hitEventPhase ?? eventContext.hitEventPhase ?? null,
                sourceMetadata: plainClone(input.metadata ?? {}),
                before: 0,
                requested: Number(input.stackCount ?? 1),
                actual: 0,
                discarded: Number(input.stackCount ?? 1),
                after: 0
            };
            this.trace.push(unresolved);
            this.onTransition(plainClone(unresolved));
            return plainClone(unresolved);
        }
        const attribution = {
            ...combatTriggerAttribution(eventContext),
            ...combatTriggerAttribution(input),
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            // Owner and source are deliberately independent. Summons, auras
            // and derived effects must explicitly choose either identity.
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            targetId,
            sourceSkillId: input.sourceSkillId ?? eventContext.skillId ?? null,
            rootSkillId: input.rootSkillId ?? eventContext.rootSkillId ?? null,
            castId: input.castId ?? eventContext.castId ?? null,
            rootCastId: input.rootCastId
                ?? eventContext.rootCastId
                ?? input.castId
                ?? eventContext.castId
                ?? null,
            parentCastId: input.parentCastId ?? eventContext.parentCastId ?? null,
            inputSkillId: input.inputSkillId
                ?? eventContext.inputSkillId
                ?? eventContext.rootSkillId
                ?? null,
            inputCommandType: input.inputCommandType
                ?? eventContext.inputCommandType
                ?? eventContext.commandType
                ?? null,
            effectiveSkillType: input.effectiveSkillType
                ?? eventContext.effectiveSkillType
                ?? eventContext.skillType
                ?? null,
            commandType: input.commandType ?? eventContext.commandType
                ?? eventContext.payload?.commandType ?? null,
            skillType: input.skillType ?? eventContext.skillType
                ?? eventContext.payload?.skillType ?? null,
            clockDomainId: input.clockDomainId ?? eventContext.clockDomainId ?? 'global',
            ruleId: input.ruleId ?? eventContext.ruleId ?? null,
            carrierId: targetId,
            damageSourceId: input.damageSourceId
                ?? eventContext.damageSourceId
                ?? input.sourceId
                ?? eventContext.sourceId
                ?? null,
            transactionId: input.transactionId ?? eventContext.transactionId ?? null,
            parentEventId: input.parentEventId ?? eventContext.parentEventId ?? null,
            parentHitId: input.parentHitId ?? eventContext.parentHitId ?? null,
            hitEventPhase: input.hitEventPhase ?? eventContext.hitEventPhase ?? null
        };
        // A Buff can measure its lifetime on one clock while the actions fired
        // by that Buff still belong to the carrier's combat clock. AKE uses
        // this for HitStop Buffs whose timeline is global-time, but whose
        // ResolveTimeDilation action must pause the affected character.
        const actionClockDomainId = input.actionClockDomainId
            ?? eventContext.actionClockDomainId
            ?? eventContext.clockDomainId
            ?? attribution.clockDomainId;
        const nextBlackboard = {
            ...plainClone(definition.blackboard ?? {}),
            ...(input.inheritEventBlackboard === false
                ? {}
                : plainClone(eventContext.blackboard ?? {})),
            ...plainClone(input.blackboard ?? {})
        };
        const stacking = normalizedStacking(definition, input, nextBlackboard);
        const durationTicks = this.#durationTicks(input, definition, nextBlackboard);
        let existing = this.#matchingInstance(targetId, buffId, stacking, attribution);

        // A stacking key is a mutually-exclusive runtime slot, not permission
        // to mutate one Buff definition into another. Physical control Buffs
        // such as airborne and crushed intentionally share `physical`; the new
        // identity must replace the old instance so its own lifecycle and
        // damage actions execute.
        if (existing && stacking.identifierType === 'StackingKey'
            && existing.buffId !== buffId) {
            this.finish({
                frame,
                instanceId: existing.instanceId,
                reason: `StackingKeyReplaced:${String(stacking.key)}`
            }, eventContext);
            existing = null;
        }

        if (existing && stacking.policy === 'Unique') {
            this.trace.push(this.#record(existing, frame, 'StatusEffectIgnored', {
                reason: 'UniqueAlreadyActive'
            }));
            return this.#publicInstance(existing);
        }
        if (existing && stacking.policy === 'Replace') {
            this.finish({ frame, instanceId: existing.instanceId, reason: 'Replaced' }, eventContext);
        }
        if (existing && ['Refresh', 'AddStack', 'TimedGrowingEnhance'].includes(stacking.policy)) {
            const before = existing.stackCount;
            const independent = existing.stackLifetimePolicy === 'Independent';
            if (!independent) this.#cancelTimer(existing, frame, 'Refreshed');
            const addsStack = ['AddStack', 'TimedGrowingEnhance'].includes(stacking.policy);
            const eventManagedEnhancement = addsStack
                && input.triggerEnhancementEvent === true
                && !existing.processingEnhancement
                && enhancementIsManagedByAbilityEvent(definition, buffId);
            if (addsStack && !eventManagedEnhancement) {
                existing.stackCount = Math.min(existing.maxStacks, existing.stackCount + 1);
            }
            existing.blackboard = { ...existing.blackboard, ...nextBlackboard };
            existing.generation += 1;
            existing.startFrame = frame;
            existing.durationTicks = durationTicks;
            existing.expireFrame = durationTicks === null ? null : frame + durationTicks;
            Object.assign(existing, attribution);
            existing.actionClockDomainId = actionClockDomainId;
            if (independent) {
                if (existing.stackCount > before) this.#addStackLayer(existing, frame, attribution);
            } else this.#scheduleExpiry(existing);
            this.#schedulePeriodicTrigger(existing, frame);
            this.#scheduleTimedGrowth(existing, frame);
            this.#restoreTimerPauseState(existing, frame, 'StatusEffectRefreshedWhileHeld');
            const transition = this.#record(existing, frame, 'StatusEffectRefreshed', {
                before,
                requested: before + (addsStack
                    && !eventManagedEnhancement ? 1 : 0),
                actual: existing.stackCount - before,
                discarded: addsStack
                    && !eventManagedEnhancement
                    ? Math.max(0, before + 1 - existing.stackCount)
                    : 0,
                after: existing.stackCount
            });
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            const addedStacks = Math.max(0, existing.stackCount - before);
            if (addedStacks > 0) {
                existing.stackSources.push({
                    sourceId: attribution.sourceId,
                    ownerId: attribution.ownerId,
                    count: addedStacks
                });
            }
            if (input.triggerEnhancementEvent === true
                && !existing.processingEnhancement) {
                existing.processingEnhancement = true;
                try {
                    this.#executeLifecycle(
                        this.#eventActions(definition, 'OnBuffAfterTryEnhanced'),
                        existing,
                        frame,
                        'OnBuffAfterTryEnhanced',
                        {
                            ...plainClone(eventContext),
                            transactionId: transition.transactionId,
                            parentEventId: transition.eventId
                        }
                    );
                } finally {
                    existing.processingEnhancement = false;
                }
            }
            this.#executeLifecycle(
                definition.onRefreshActions ?? [],
                existing,
                frame,
                'OnBuffRefresh',
                {
                    ...plainClone(eventContext),
                    transactionId: transition.transactionId,
                    parentEventId: transition.eventId
                }
            );
            this.#executeLifecycle(
                definition.duringEnableActions ?? this.#eventActions(definition, 'DuringBuffEnable'),
                existing,
                frame,
                'DuringBuffEnable',
                {
                    ...plainClone(eventContext),
                    transactionId: transition.transactionId,
                    parentEventId: transition.eventId
                }
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
            stackLifetimePolicy: stacking.lifetimePolicy,
            stackLayers: [],
            nextStackLayerId: 0,
            stackingScope: stacking.scope,
            stackCount: Math.min(requestedStackCount, stacking.maxStacks),
            maxStacks: stacking.maxStacks,
            ...attribution,
            actionClockDomainId,
            blackboard: nextBlackboard,
            metadata: plainClone(input.metadata ?? {}),
            startFrame: frame,
            durationTicks,
            expireFrame: durationTicks === null ? null : frame + durationTicks,
            generation: 1,
            active: true,
            timerId: null,
            triggerTimerId: null,
            triggerTimerDomainId: null,
            growthTimerId: null,
            growthTimerDomainId: null,
            nextGrowthFrame: null,
            growthGeneration: 0,
            timelineTimerIds: [],
            triggerCount: 0,
            processingEnhancement: false,
            timePaused: false,
            timePausedAtFrame: null,
            remainingDurationTicks: null,
            expiryHoldLeaseIds: [],
            expiryHeldAtFrame: null,
            extensionTriggered: false,
            actionLifetime: null
        };
        instance.stackSources = [{
            sourceId: attribution.sourceId,
            ownerId: attribution.ownerId,
            count: instance.stackCount
        }];
        this.instances.set(instance.instanceId, instance);
        if (instance.stackLifetimePolicy === 'Independent') {
            for (let i = 0; i < instance.stackCount; i += 1) {
                this.#addStackLayer(instance, frame, attribution);
            }
        } else this.#scheduleExpiry(instance);
        const transition = this.#record(instance, frame, 'StatusEffectApplied', {
            before: 0,
            requested: instance.stackCount,
            actual: instance.stackCount,
            discarded: 0,
            after: instance.stackCount
        });
        this.trace.push(transition);
        this.onTransition(plainClone(transition));
        this.#executeLifecycle(
            definition.onApplyActions ?? definition.startActions ?? [],
            instance,
            frame,
            'OnBuffStart',
            {
                ...plainClone(eventContext),
                transactionId: transition.transactionId,
                parentEventId: transition.eventId
            }
        );
        this.#executeLifecycle(
            definition.onEnableActions ?? this.#eventActions(definition, 'OnBuffEnable'),
            instance,
            frame,
            'OnBuffEnable',
            {
                ...plainClone(eventContext),
                transactionId: transition.transactionId,
                parentEventId: transition.eventId
            }
        );
        this.#executeLifecycle(
            definition.duringEnableActions ?? this.#eventActions(definition, 'DuringBuffEnable'),
            instance,
            frame,
            'DuringBuffEnable',
            {
                ...plainClone(eventContext),
                transactionId: transition.transactionId,
                parentEventId: transition.eventId
            }
        );
        this.#scheduleTimeline(instance, frame);
        this.#schedulePeriodicTrigger(instance, frame);
        this.#scheduleTimedGrowth(instance, frame);
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

    setTimePaused(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.setTimePaused requires an input object.');
        }
        if (typeof input.isPaused !== 'boolean') {
            throw new TypeError('StatusEffectSystem.setTimePaused requires boolean isPaused.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const matches = this.#select(input).filter(instance => instance.active);
        const transitions = [];
        for (const instance of matches) {
            const beforePaused = instance.timePaused === true;
            if (beforePaused === input.isPaused) {
                const ignored = this.#record(
                    instance,
                    frame,
                    'StatusEffectTimePauseIgnored',
                    {
                        reason: input.reason ?? 'PauseStateUnchanged',
                        beforePaused,
                        requestedPaused: input.isPaused,
                        afterPaused: beforePaused,
                        remainingDurationTicks: instance.remainingDurationTicks ?? null
                    }
                );
                this.trace.push(ignored);
                transitions.push(plainClone(ignored));
                continue;
            }
            const previousExpireFrame = instance.expireFrame;
            const timerTransitions = [];
            for (const reference of this.#timerReferences(instance)) {
                if (!this.clockDomains) {
                    throw new Error(
                        `Cannot ${input.isPaused ? 'pause' : 'resume'} status-effect time without clock domains.`
                    );
                }
                // Releasing a full Buff-time pause must not release an active
                // ExtendBuffAction expiry lease. Periodic and timeline timers
                // resume, while the lifetime timer stays held.
                if (!input.isPaused && reference.kind === 'expiry'
                    && (instance.expiryHoldLeaseIds?.length ?? 0) > 0) {
                    continue;
                }
                const changed = input.isPaused
                    ? this.clockDomains.pauseTimer(
                        reference.domainId,
                        reference.timerId,
                        frame,
                        input.reason ?? 'StatusEffectTimePaused'
                    )
                    : this.clockDomains.resumeTimer(
                        reference.domainId,
                        reference.timerId,
                        frame,
                        input.reason ?? 'StatusEffectTimeResumed'
                    );
                if (changed) timerTransitions.push(changed);
            }
            instance.timePaused = input.isPaused;
            instance.timePausedAtFrame = input.isPaused ? frame : null;
            const expiryTimer = instance.timerId === null || !this.clockDomains
                ? null
                : this.clockDomains.timer(instance.clockDomainId, instance.timerId);
            instance.remainingDurationTicks = expiryTimer?.paused
                ? expiryTimer.remainingTicks ?? null
                : null;
            instance.expireFrame = expiryTimer?.paused
                ? null
                : expiryTimer?.deadlineFrame ?? previousExpireFrame;
            const transition = this.#record(
                instance,
                frame,
                input.isPaused ? 'StatusEffectTimePaused' : 'StatusEffectTimeResumed',
                {
                    reason: input.reason
                        ?? (input.isPaused ? 'PauseBuffTime' : 'ResumeBuffTime'),
                    beforePaused,
                    requestedPaused: input.isPaused,
                    afterPaused: input.isPaused,
                    previousExpireFrame,
                    remainingDurationTicks: instance.remainingDurationTicks,
                    timerTransitions
                }
            );
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            transitions.push(plainClone(transition));
        }
        return transitions;
    }

    setExpiryHeld(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.setExpiryHeld requires an input object.');
        }
        if (typeof input.isHeld !== 'boolean') {
            throw new TypeError('StatusEffectSystem.setExpiryHeld requires boolean isHeld.');
        }
        if (typeof input.leaseId !== 'string' || input.leaseId.length === 0) {
            throw new TypeError('StatusEffectSystem.setExpiryHeld requires a leaseId.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const matches = this.#select(input).filter(instance => instance.active);
        const transitions = [];
        for (const instance of matches) {
            const beforeLeases = [...(instance.expiryHoldLeaseIds ?? [])];
            const leases = new Set(beforeLeases);
            if (input.isHeld) leases.add(input.leaseId);
            else leases.delete(input.leaseId);
            const afterLeases = [...leases].sort();
            const beforeHeld = beforeLeases.length > 0;
            const afterHeld = afterLeases.length > 0;
            instance.expiryHoldLeaseIds = afterLeases;
            instance.expiryHeldAtFrame = afterHeld
                ? (instance.expiryHeldAtFrame ?? frame)
                : null;

            let timerTransition = null;
            if (beforeHeld !== afterHeld) {
                for (const reference of this.#timerReferences(instance).filter(ref => ref.kind === 'expiry')) {
                    if (!this.clockDomains) throw new Error('Cannot hold expiry without clock domains.');
                    if (afterHeld) timerTransition = this.clockDomains.pauseTimer(
                        reference.domainId, reference.timerId, frame, input.reason ?? 'ExtendBuffAction');
                    else if (!instance.timePaused) timerTransition = this.clockDomains.resumeTimer(
                        reference.domainId, reference.timerId, frame, input.reason ?? 'ExtendBuffActionReleased');
                }
            }

            const expiryTimer = instance.timerId === null || !this.clockDomains
                ? null
                : this.clockDomains.timer(instance.clockDomainId, instance.timerId);
            instance.remainingDurationTicks = expiryTimer?.paused
                ? expiryTimer.remainingTicks ?? instance.remainingDurationTicks
                : null;
            instance.expireFrame = expiryTimer?.paused
                ? null
                : expiryTimer?.deadlineFrame ?? instance.expireFrame;

            const firstExtension = input.isHeld && !instance.extensionTriggered;
            if (firstExtension) {
                instance.extensionTriggered = true;
                this.#executeLifecycle(
                    [{
                        type: 'RefreshCurrentBuffEffectSource',
                        reason: 'ExtendBuffAction:activate-after-extend-tags'
                    }],
                    instance,
                    frame,
                    'OnBuffExtended',
                    eventContext
                );
            }

            const transition = this.#record(
                instance,
                frame,
                afterHeld ? 'StatusEffectExpiryHeld' : 'StatusEffectExpiryReleased',
                {
                    reason: input.reason ?? 'ExtendBuffAction',
                    leaseId: input.leaseId,
                    requestedHeld: input.isHeld,
                    beforeHeld,
                    afterHeld,
                    beforeLeaseIds: beforeLeases,
                    afterLeaseIds: afterLeases,
                    remainingDurationTicks: instance.remainingDurationTicks,
                    timerTransition,
                    extensionTriggered: instance.extensionTriggered
                }
            );
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            transitions.push(plainClone(transition));
        }
        return transitions;
    }

    claimActionLifetime(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.claimActionLifetime requires an input object.');
        }
        if (typeof input.leaseId !== 'string' || input.leaseId.length === 0) {
            throw new TypeError('StatusEffectSystem.claimActionLifetime requires a leaseId.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const inheritSkillIds = [...new Set((input.inheritSkillIds ?? [])
            .filter(skillId => typeof skillId === 'string' && skillId.length > 0))];
        const matches = this.#select(input).filter(instance => instance.active);
        const transitions = [];
        for (const instance of matches) {
            const previousLifetime = plainClone(instance.actionLifetime);
            instance.actionLifetime = {
                leaseId: input.leaseId,
                actorId: input.actorId ?? eventContext.sourceId ?? null,
                ownerSkillId: input.ownerSkillId ?? eventContext.skillId ?? null,
                ownerCastId: input.ownerCastId ?? eventContext.castId ?? null,
                ownerProgramExecutionId: input.ownerProgramExecutionId
                    ?? eventContext.programExecutionId
                    ?? null,
                inheritSkillIds,
                finishByAction: input.finishByAction !== false,
                finishWithNextSkillIfNotInherited:
                    input.finishWithNextSkillIfNotInherited !== false,
                awaitingInheritance: false,
                candidateSkillId: null,
                candidateCastId: null,
                candidateProgramExecutionId: null,
                claimedFrame: frame,
                releasedFrame: null
            };
            const transition = this.#record(
                instance,
                frame,
                previousLifetime === null || previousLifetime === undefined
                    ? 'StatusEffectActionLifetimeClaimed'
                    : 'StatusEffectActionLifetimeTransferred',
                {
                    reason: input.reason ?? 'ActionLifetimeClaimed',
                    previousLifetime,
                    actionLifetime: plainClone(instance.actionLifetime)
                }
            );
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            transitions.push(plainClone(transition));
        }
        return transitions;
    }

    inheritActionLifetime(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.inheritActionLifetime requires an input object.');
        }
        if (typeof input.leaseId !== 'string' || input.leaseId.length === 0) {
            throw new TypeError('StatusEffectSystem.inheritActionLifetime requires a leaseId.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const skillId = input.ownerSkillId ?? eventContext.skillId;
        const castId = input.ownerCastId ?? eventContext.castId ?? null;
        const matches = this.#select(input).filter(instance => instance.active);
        const transitions = [];
        for (const instance of matches) {
            const lifetime = instance.actionLifetime;
            const eligible = lifetime !== null
                && lifetime !== undefined
                && typeof skillId === 'string'
                && lifetime.inheritSkillIds.includes(skillId)
                && (lifetime.candidateSkillId === null
                    || lifetime.candidateSkillId === skillId)
                && (lifetime.candidateCastId === null
                    || lifetime.candidateCastId === castId);
            if (!eligible) {
                const ignored = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeInheritanceRejected',
                    {
                        reason: input.reason ?? 'InheritBuffActionNotEligible',
                        requestedSkillId: skillId ?? null,
                        requestedCastId: castId,
                        actionLifetime: plainClone(lifetime)
                    }
                );
                this.trace.push(ignored);
                transitions.push(plainClone(ignored));
                continue;
            }
            transitions.push(...this.claimActionLifetime({
                ...input,
                frame,
                instanceId: instance.instanceId,
                ownerSkillId: skillId,
                ownerCastId: castId,
                reason: input.reason ?? 'InheritBuffAction'
            }, eventContext));
        }
        return transitions;
    }

    releaseActionLifetime(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.releaseActionLifetime requires an input object.');
        }
        if (typeof input.leaseId !== 'string' || input.leaseId.length === 0) {
            throw new TypeError('StatusEffectSystem.releaseActionLifetime requires a leaseId.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const matches = this.#select(input).filter(instance => instance.active);
        const results = [];
        for (const instance of matches) {
            const lifetime = instance.actionLifetime;
            if (!lifetime || lifetime.leaseId !== input.leaseId) {
                const ignored = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeReleaseIgnored',
                    {
                        reason: input.reason ?? 'ActionLifetimeLeaseMismatch',
                        requestedLeaseId: input.leaseId,
                        activeLeaseId: lifetime?.leaseId ?? null
                    }
                );
                this.trace.push(ignored);
                results.push(plainClone(ignored));
                continue;
            }
            if (!lifetime.finishByAction) {
                const ignored = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeReleaseIgnored',
                    {
                        reason: input.reason ?? 'ActionLifetimeDoesNotFinishBuff',
                        requestedLeaseId: input.leaseId,
                        activeLeaseId: lifetime.leaseId
                    }
                );
                this.trace.push(ignored);
                results.push(plainClone(ignored));
                continue;
            }
            if (lifetime.inheritSkillIds.length > 0) {
                lifetime.awaitingInheritance = true;
                lifetime.releasedFrame = frame;
                const transition = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeAwaitingInheritance',
                    {
                        reason: input.reason ?? 'ActionLifetimeReleased',
                        actionLifetime: plainClone(lifetime)
                    }
                );
                this.trace.push(transition);
                this.onTransition(plainClone(transition));
                results.push(plainClone(transition));
                continue;
            }
            results.push(...this.finish({
                frame,
                instanceId: instance.instanceId,
                reason: input.reason ?? 'ActionLifetimeReleased'
            }, eventContext));
        }
        return results;
    }

    beginSkillTransition(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.beginSkillTransition requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const actorId = requireId(input.actorId ?? eventContext.sourceId, 'actorId');
        const skillId = requireId(input.skillId ?? eventContext.skillId, 'skillId');
        const castId = requireId(input.castId ?? eventContext.castId, 'castId');
        const programExecutionId = input.programExecutionId
            ?? eventContext.programExecutionId
            ?? null;
        const matches = [...this.instances.values()].filter(instance => instance.active
            && instance.actionLifetime?.actorId === actorId
            && instance.actionLifetime.ownerCastId !== castId);
        const results = [];
        for (const instance of matches) {
            const lifetime = instance.actionLifetime;
            if (lifetime.inheritSkillIds.includes(skillId)) {
                lifetime.candidateSkillId = skillId;
                lifetime.candidateCastId = castId;
                lifetime.candidateProgramExecutionId = programExecutionId;
                const transition = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeInheritanceOffered',
                    {
                        reason: input.reason ?? 'NextSkillCanInheritBuff',
                        requestedSkillId: skillId,
                        requestedCastId: castId,
                        actionLifetime: plainClone(lifetime)
                    }
                );
                this.trace.push(transition);
                this.onTransition(plainClone(transition));
                results.push(plainClone(transition));
                continue;
            }
            if (!lifetime.finishWithNextSkillIfNotInherited) {
                const retained = this.#record(
                    instance,
                    frame,
                    'StatusEffectActionLifetimeRetained',
                    {
                        reason: input.reason ?? 'NextSkillDoesNotForceFinish',
                        requestedSkillId: skillId,
                        requestedCastId: castId,
                        actionLifetime: plainClone(lifetime)
                    }
                );
                this.trace.push(retained);
                results.push(plainClone(retained));
                continue;
            }
            results.push(...this.finish({
                frame,
                instanceId: instance.instanceId,
                reason: `NextSkillNotInherited:${String(skillId)}`
            }, {
                ...plainClone(eventContext),
                frame,
                sourceId: actorId,
                skillId,
                castId
            }));
        }
        return results;
    }

    endSkillTransition(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.endSkillTransition requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const castId = requireId(input.castId ?? eventContext.castId, 'castId');
        const matches = [...this.instances.values()].filter(instance => instance.active
            && (instance.actionLifetime?.ownerCastId === castId
                || instance.actionLifetime?.candidateCastId === castId));
        const results = [];
        for (const instance of matches) {
            if (!instance.active || !instance.actionLifetime) continue;
            const lifetime = instance.actionLifetime;
            if (lifetime.candidateCastId === castId && lifetime.ownerCastId !== castId) {
                results.push(...this.finish({
                    frame,
                    instanceId: instance.instanceId,
                    reason: `SkillDidNotClaimInheritedBuff:${String(input.skillId
                        ?? eventContext.skillId
                        ?? '')}`
                }, eventContext));
                continue;
            }
            if (lifetime.ownerCastId !== castId || lifetime.awaitingInheritance) continue;
            results.push(...this.releaseActionLifetime({
                frame,
                instanceId: instance.instanceId,
                leaseId: lifetime.leaseId,
                reason: input.reason ?? 'SkillActionLifetimeEnded'
            }, eventContext));
        }
        return results;
    }

    finish(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('StatusEffectSystem.finish requires an input object.');
        }
        const frame = frameNumber(input.frame ?? eventContext.frame ?? 0);
        const triggerAttribution = {
            triggerSourceId: eventContext.sourceId ?? null,
            triggerOwnerId: eventContext.ownerId ?? null,
            triggerTargetId: eventContext.targetId ?? null,
            triggerSkillId: eventContext.skillId ?? null,
            triggerRootSkillId: eventContext.rootSkillId ?? null,
            triggerInputSkillId: eventContext.inputSkillId
                ?? eventContext.rootSkillId
                ?? eventContext.skillId
                ?? null,
            triggerCastId: eventContext.castId ?? null,
            triggerRootCastId: eventContext.rootCastId ?? eventContext.castId ?? null,
            triggerParentCastId: eventContext.parentCastId ?? null,
            triggerInputCommandType: eventContext.inputCommandType
                ?? eventContext.commandType
                ?? eventContext.payload?.commandType
                ?? null,
            triggerEffectiveSkillType: eventContext.effectiveSkillType
                ?? eventContext.skillType
                ?? eventContext.payload?.skillType
                ?? null,
            triggerCommandType: eventContext.commandType
                ?? eventContext.payload?.commandType
                ?? null,
            triggerSkillType: eventContext.skillType
                ?? eventContext.payload?.skillType
                ?? null,
            triggerTransactionId: eventContext.transactionId ?? null,
            triggerParentEventId: eventContext.parentEventId ?? null,
            triggerParentHitId: eventContext.parentHitId ?? null,
            triggerHitEventPhase: eventContext.hitEventPhase ?? null,
            // A finish/consume transition belongs to the event that caused it,
            // not to the historical transaction that created the instance.
            ...(eventContext.transactionId === undefined
                ? {}
                : { transactionId: eventContext.transactionId }),
            ...(eventContext.parentEventId === undefined
                ? {}
                : { parentEventId: eventContext.parentEventId }),
            ...(eventContext.parentHitId === undefined
                ? {}
                : { parentHitId: eventContext.parentHitId }),
            ...(eventContext.hitEventPhase === undefined
                ? {}
                : { hitEventPhase: eventContext.hitEventPhase })
        };
        const consumption = input.consumption === true;
        const consumptionAttribution = consumption ? {
            consumption: true,
            consumerId: input.consumerId
                ?? eventContext.consumerId
                ?? eventContext.sourceId
                ?? eventContext.ownerId
                ?? null,
            consumeKind: input.consumeKind
                ?? (input.isAbsorbed === true ? 'Absorb' : 'Consume'),
            isAbsorbed: input.isAbsorbed === true,
            consumedBuffBlackboard: null
        } : {
            consumption: false
        };
        const matches = this.#select(input).filter(instance => instance.active);
        for (const instance of matches) {
            const consumedBuffBlackboard = consumption
                ? plainClone(instance.blackboard ?? {})
                : undefined;
            const requestedLayers = input.finishAll === false
                ? Math.max(1, Math.trunc(Number(input.stackCount ?? 1)))
                : instance.stackCount;
            if (consumption) {
                const guard = this.canConsumeBuff({
                    frame,
                    instance: this.#publicInstance(instance),
                    input: plainClone(input),
                    eventContext: plainClone(eventContext)
                });
                const allowed = typeof guard === 'boolean'
                    ? guard
                    : guard?.allowed !== false;
                if (!allowed) {
                    const blockedLayers = Math.min(requestedLayers, instance.stackCount);
                    const transition = this.#record(
                        instance,
                        frame,
                        'StatusEffectConsumptionPrevented',
                        {
                            reason: input.reason ?? 'ConsumptionPrevented',
                            ...triggerAttribution,
                            before: instance.stackCount,
                            requested: blockedLayers,
                            actual: 0,
                            consumedStacks: 0,
                            bySource: [],
                            ...consumptionAttribution,
                            consumedBuffBlackboard,
                            consumptionGuards: plainClone(guard?.guards ?? []),
                            discarded: blockedLayers,
                            after: instance.stackCount
                        }
                    );
                    this.trace.push(transition);
                    this.onTransition(plainClone(transition));
                    continue;
                }
            }
            if (input.finishAll === false && (
                requestedLayers < instance.stackCount
                || instance.stackingPolicy === 'TimedGrowingEnhance'
            )) {
                const before = instance.stackCount;
                const removedLayers = Math.min(requestedLayers, instance.stackCount);
                instance.stackCount -= removedLayers;
                const bySource = this.#consumeStackSources(instance, removedLayers, frame, input.layerId);
                const transition = this.#record(instance, frame, 'StatusEffectStackRemoved', {
                    reason: input.reason ?? 'Finished',
                    ...triggerAttribution,
                    before,
                    requested: requestedLayers,
                    actual: removedLayers,
                    consumedStacks: removedLayers,
                    bySource,
                    ...consumptionAttribution,
                    ...(consumption
                        ? { consumedBuffBlackboard }
                        : {}),
                    discarded: Math.max(0, requestedLayers - removedLayers),
                    after: instance.stackCount
                });
                this.trace.push(transition);
                this.onTransition(plainClone(transition));
                this.#executeLifecycle(
                    instance.definition.duringEnableActions
                        ?? this.#eventActions(instance.definition, 'DuringBuffEnable'),
                    instance,
                    frame,
                    'DuringBuffEnable',
                    {
                        ...plainClone(eventContext),
                        transactionId: transition.transactionId,
                        parentEventId: transition.eventId
                    }
                );
                this.#scheduleTimedGrowth(instance, frame);
                continue;
            }
            instance.active = false;
            instance.generation += 1;
            this.#cancelTimer(instance, frame, input.reason ?? 'Finished');
            const bySource = this.#consumeStackSources(instance, instance.stackCount, frame, input.layerId);
            const transition = this.#record(instance, frame, 'StatusEffectFinished', {
                reason: input.reason ?? 'Finished',
                ...triggerAttribution,
                before: instance.stackCount,
                requested: instance.stackCount,
                actual: instance.stackCount,
                consumedStacks: instance.stackCount,
                bySource,
                ...consumptionAttribution,
                ...(consumption
                    ? { consumedBuffBlackboard }
                    : {}),
                discarded: 0,
                after: 0
            });
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            this.#executeLifecycle(
                instance.definition.onRemoveActions
                    ?? instance.definition.endActions
                    ?? this.#eventActions(instance.definition, 'OnBuffFinish'),
                instance,
                frame,
                'OnBuffFinish',
                {
                    ...plainClone(eventContext),
                    transactionId: transition.transactionId,
                    parentEventId: transition.eventId
                }
            );
            // AKE's asChildBuff is an ownership edge, not a display hint.
            // End only children created by this exact parent instance; using
            // Buff id or source identity would also remove concurrent siblings.
            this.finish({
                frame,
                metadata: { parentBuffInstanceId: instance.instanceId },
                reason: `ParentBuffFinished:${String(instance.buffId)}`
            }, {
                ...plainClone(eventContext),
                transactionId: transition.transactionId,
                parentEventId: transition.eventId
            });
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

    replaceBlackboard(input, eventContext = {}) {
        if (!input || typeof input !== 'object') {
            throw new Error('replaceBlackboard requires an input object.');
        }
        const instanceId = requireId(input.instanceId, 'instanceId');
        const instance = this.instances.get(instanceId);
        if (!instance) return null;
        if (!input.blackboard || typeof input.blackboard !== 'object'
            || Array.isArray(input.blackboard)) {
            throw new TypeError('replaceBlackboard requires an object blackboard.');
        }
        const before = plainClone(instance.blackboard);
        instance.blackboard = plainClone(input.blackboard);
        this.onBlackboardChange(this.#publicInstance(instance), {
            before,
            after: plainClone(instance.blackboard),
            eventContext: plainClone(eventContext)
        });
        const transition = this.#record(
            instance,
            frameNumber(input.frame ?? eventContext.frame ?? 0),
            'StatusEffectBlackboardReplaced',
            {
                reason: input.reason ?? 'AbilityEventListenerBlackboard',
                before,
                after: plainClone(instance.blackboard)
            }
        );
        this.trace.push(transition);
        return this.#publicInstance(instance);
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
            const duration = finiteNumber(
                resolveDescriptor(definition.duration, blackboard),
                'duration'
            );
            // AKE uses a resolved -1 duration as an infinity sentinel even on
            // a few dynamically configured Buffs whose lifeType is Limited.
            if (duration < 0) return null;
            return Math.round(duration * this.tickRate);
        }
        if (definition.durationTicks !== undefined && definition.durationTicks !== null) {
            return frameNumber(definition.durationTicks, 'durationTicks');
        }
        if (definition.durationSeconds !== undefined && definition.durationSeconds !== null) {
            const durationSeconds = finiteNumber(
                resolveDescriptor(definition.durationSeconds, blackboard),
                'durationSeconds'
            );
            if (durationSeconds < 0) return null;
            return Math.round(durationSeconds * this.tickRate);
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
                const activeTags = new Set([
                    ...(instance.definition.tagIds ?? []),
                    ...(instance.extensionTriggered
                        ? instance.definition.extendTagIds ?? []
                        : [])
                ]);
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

    #timerReferences(instance) {
        const references = [];
        const add = (domainId, timerId, kind) => {
            if (timerId === null || timerId === undefined) return;
            const key = `${String(domainId)}\u0000${String(timerId)}`;
            if (references.some(reference => reference.key === key)) return;
            references.push({ key, domainId, timerId, kind });
        };
        add(instance.clockDomainId, instance.timerId, 'expiry');
        for (const layer of instance.stackLayers ?? []) {
            add(instance.clockDomainId, layer.timerId, 'expiry');
        }
        for (const timerId of instance.timelineTimerIds ?? []) {
            add(instance.clockDomainId, timerId, 'timeline');
        }
        add(
            instance.triggerTimerDomainId
                ?? instance.actionClockDomainId
                ?? instance.clockDomainId,
            instance.triggerTimerId,
            'trigger'
        );
        add(
            instance.growthTimerDomainId ?? instance.clockDomainId,
            instance.growthTimerId,
            'growth'
        );
        return references.map(({ key: _key, ...reference }) => reference);
    }

    #restoreTimerPauseState(instance, frame, reason) {
        if (!this.clockDomains) return;
        for (const reference of this.#timerReferences(instance)) {
            const shouldPause = instance.timePaused === true
                || (reference.kind === 'expiry'
                    && (instance.expiryHoldLeaseIds?.length ?? 0) > 0);
            if (shouldPause) {
                this.clockDomains.pauseTimer(
                    reference.domainId,
                    reference.timerId,
                    frame,
                    reason
                );
            }
        }
        const expiryTimer = instance.timerId === null
            ? null
            : this.clockDomains.timer(instance.clockDomainId, instance.timerId);
        instance.remainingDurationTicks = expiryTimer?.paused
            ? expiryTimer.remainingTicks ?? null
            : null;
        instance.expireFrame = expiryTimer?.paused
            ? null
            : expiryTimer?.deadlineFrame ?? instance.expireFrame;
    }

    // Independent layer clocks survive later applications and instance generations.
    #addStackLayer(instance, frame, attribution) {
        const layer = { id: ++instance.nextStackLayerId, sourceId: attribution.sourceId,
            ownerId: attribution.ownerId, appliedFrame: frame, timerId: null,
            expireFrame: instance.durationTicks === null ? null : frame + instance.durationTicks };
        instance.stackLayers.push(layer);
        if (instance.durationTicks === null) return;
        const onComplete = expiryFrame => {
            if (!instance.active || !instance.stackLayers.includes(layer)) return;
            const before = instance.stackCount;
            this.finish({ frame: expiryFrame, instanceId: instance.instanceId,
                finishAll: false, stackCount: 1, layerId: layer.id, reason: 'IndependentLayerExpired' });
            const transition = this.#record(instance, expiryFrame, 'StatusEffectStackExpired', {
                layerId: layer.id, before, after: before - 1, stackCount: before - 1, actual: 1,
                reason: 'IndependentLayerExpired' });
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
        };
        if (this.clockDomains) {
            layer.timerId = this.clockDomains.startTimer(instance.clockDomainId, {
                frame, durationTicks: instance.durationTicks, priority: 90,
                label: `status-layer:${instance.instanceId}:${layer.id}`, onComplete });
        } else if (this.schedule) {
            this.schedule(layer.expireFrame, 90, () => onComplete(layer.expireFrame),
                `status-layer:${instance.instanceId}:${layer.id}`);
        } else throw new Error('Independent finite stacks require a scheduler.');
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

    #timedGrowthIntervalTicks(instance) {
        if (instance.stackingPolicy !== 'TimedGrowingEnhance') return null;
        const explicit = instance.definition.timedGrowthIntervalTicks;
        if (explicit !== undefined && explicit !== null) {
            return Math.max(1, frameNumber(explicit, 'timedGrowthIntervalTicks'));
        }
        const seconds = Number(resolveDescriptor(
            instance.definition.duration,
            instance.blackboard,
            -1
        ));
        if (!Number.isFinite(seconds)) throw new Error('timed growth interval must be finite.');
        if (seconds <= 0) return null;
        return Math.max(1, Math.round(seconds * this.tickRate));
    }

    #scheduleTimedGrowth(instance, frame) {
        if (!instance.active || instance.stackingPolicy !== 'TimedGrowingEnhance') return;
        if (instance.growthTimerId !== null && this.clockDomains
            && typeof this.clockDomains.cancelTimer === 'function') {
            this.clockDomains.cancelTimer(
                instance.growthTimerDomainId ?? instance.clockDomainId,
                instance.growthTimerId,
                frame,
                'TimedGrowthRescheduled'
            );
            instance.growthTimerId = null;
            instance.growthTimerDomainId = null;
            instance.nextGrowthFrame = null;
        }
        if (instance.stackCount >= instance.maxStacks) return;
        const intervalTicks = this.#timedGrowthIntervalTicks(instance);
        if (intervalTicks === null) return;
        const generation = instance.generation;
        const growthGeneration = (instance.growthGeneration ?? 0) + 1;
        instance.growthGeneration = growthGeneration;
        const grow = completionFrame => {
            if (!instance.active
                || instance.generation !== generation
                || instance.growthGeneration !== growthGeneration) return;
            instance.growthTimerId = null;
            instance.growthTimerDomainId = null;
            instance.nextGrowthFrame = null;
            const before = instance.stackCount;
            instance.stackCount = Math.min(instance.maxStacks, before + 1);
            const actual = instance.stackCount - before;
            if (actual > 0) {
                instance.stackSources.push({
                    sourceId: instance.sourceId,
                    ownerId: instance.ownerId,
                    count: actual
                });
            }
            const transition = this.#record(
                instance,
                completionFrame,
                'StatusEffectStackGrown',
                {
                    reason: 'TimedGrowingEnhance',
                    before,
                    requested: before + 1,
                    actual,
                    discarded: Math.max(0, before + 1 - instance.stackCount),
                    after: instance.stackCount
                }
            );
            this.trace.push(transition);
            this.onTransition(plainClone(transition));
            if (actual > 0) {
                this.#executeLifecycle(
                    instance.definition.duringEnableActions
                        ?? this.#eventActions(instance.definition, 'DuringBuffEnable'),
                    instance,
                    completionFrame,
                    'DuringBuffEnable',
                    {
                        transactionId: transition.transactionId,
                        parentEventId: transition.eventId
                    }
                );
            }
            this.#scheduleTimedGrowth(instance, completionFrame);
        };
        instance.nextGrowthFrame = frame + intervalTicks;
        if (this.clockDomains) {
            instance.growthTimerDomainId = instance.clockDomainId;
            instance.growthTimerId = this.clockDomains.startTimer(instance.clockDomainId, {
                frame,
                durationTicks: intervalTicks,
                priority: 80,
                label: `status-growth:${instance.buffId}:${instance.instanceId}`,
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId: instance.targetId,
                skillId: instance.sourceSkillId,
                rootSkillId: instance.rootSkillId,
                reason: 'TimedGrowingEnhance',
                ruleId: instance.ruleId,
                onComplete: grow
            });
            return;
        }
        if (!this.schedule) {
            throw new Error(`Cannot schedule timed growth ${instance.buffId} without a scheduler.`);
        }
        const deadline = instance.nextGrowthFrame;
        this.schedule(
            deadline,
            80,
            () => grow(deadline),
            `status-growth:${instance.buffId}:${instance.instanceId}`
        );
    }

    #schedulePeriodicTrigger(instance, frame) {
        if (!instance.active) return;
        if (instance.triggerTimerId !== null && this.clockDomains
            && typeof this.clockDomains.cancelTimer === 'function') {
            this.clockDomains.cancelTimer(
                instance.triggerTimerDomainId
                    ?? instance.actionClockDomainId
                    ?? instance.clockDomainId,
                instance.triggerTimerId,
                frame,
                'TriggerRescheduled'
            );
            instance.triggerTimerId = null;
            instance.triggerTimerDomainId = null;
        }
        const intervalTicks = this.#triggerIntervalTicks(instance);
        if (intervalTicks === null) return;
        const maxTriggerCount = this.#maxTriggerCount(instance);
        if (maxTriggerCount !== null && instance.triggerCount >= maxTriggerCount) return;
        const generation = instance.generation;
        const run = completionFrame => {
            if (!instance.active || instance.generation !== generation) return;
            instance.triggerTimerId = null;
            instance.triggerTimerDomainId = null;
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
            const triggerTimerDomainId = instance.actionClockDomainId
                ?? instance.clockDomainId;
            instance.triggerTimerDomainId = triggerTimerDomainId;
            instance.triggerTimerId = this.clockDomains.startTimer(triggerTimerDomainId, {
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
        instance.growthGeneration = (instance.growthGeneration ?? 0) + 1;
        if (!this.clockDomains) return;
        if (typeof this.clockDomains.cancelTimer === 'function') {
            for (const timerId of [instance.timerId, ...(instance.stackLayers ?? []).map(layer => layer.timerId), ...(instance.timelineTimerIds ?? [])]) {
                if (timerId !== null) {
                    this.clockDomains.cancelTimer(instance.clockDomainId, timerId, frame, reason);
                }
            }
            if (instance.triggerTimerId !== null) {
                this.clockDomains.cancelTimer(
                    instance.triggerTimerDomainId
                        ?? instance.actionClockDomainId
                        ?? instance.clockDomainId,
                    instance.triggerTimerId,
                    frame,
                    reason
                );
            }
            if (instance.growthTimerId !== null) {
                this.clockDomains.cancelTimer(
                    instance.growthTimerDomainId ?? instance.clockDomainId,
                    instance.growthTimerId,
                    frame,
                    reason
                );
            }
        }
        instance.timerId = null;
        instance.triggerTimerId = null;
        instance.triggerTimerDomainId = null;
        instance.growthTimerId = null;
        instance.growthTimerDomainId = null;
        instance.nextGrowthFrame = null;
        instance.timelineTimerIds = [];
    }

    #executeLifecycle(actions, instance, frame, eventType, incomingContext = {}) {
        if (!Array.isArray(actions) || actions.length === 0) return [];
        const beforeBlackboard = plainClone(instance.blackboard);
        const actionSourceId = incomingContext.useEventSourceAsActionSource === true
            ? incomingContext.sourceId ?? instance.sourceId
            : instance.sourceId;
        const execution = this.executeActions(actions, {
            frame,
            eventType,
            ...combatTriggerAttribution(instance),
            ...combatTriggerAttribution(incomingContext),
            sourceId: actionSourceId,
            // In serialized Buff actions, ActionOwner is the entity carrying
            // the Buff. The attribution owner remains stored on the instance
            // and is exposed separately in payload for cleanup/audit.
            ownerId: instance.targetId,
            targetId: instance.targetId,
            skillId: incomingContext.skillId ?? instance.sourceSkillId,
            rootSkillId: incomingContext.rootSkillId ?? instance.rootSkillId,
            castId: incomingContext.castId ?? instance.castId,
            rootCastId: incomingContext.rootCastId
                ?? instance.rootCastId
                ?? incomingContext.castId
                ?? instance.castId,
            parentCastId: incomingContext.parentCastId ?? instance.parentCastId ?? null,
            inputSkillId: incomingContext.inputSkillId
                ?? instance.inputSkillId
                ?? incomingContext.rootSkillId
                ?? instance.rootSkillId,
            inputCommandType: incomingContext.inputCommandType
                ?? instance.inputCommandType
                ?? incomingContext.commandType
                ?? instance.commandType,
            effectiveSkillType: incomingContext.effectiveSkillType
                ?? instance.effectiveSkillType
                ?? incomingContext.skillType
                ?? instance.skillType,
            commandType: incomingContext.commandType
                ?? incomingContext.payload?.commandType
                ?? instance.commandType,
            skillType: incomingContext.skillType
                ?? incomingContext.payload?.skillType
                ?? instance.skillType,
            buffInstanceId: instance.instanceId,
            clockDomainId: instance.actionClockDomainId ?? instance.clockDomainId,
            ruleId: instance.ruleId,
            sourceMetadata: plainClone(instance.metadata ?? {}),
            carrierId: instance.carrierId,
            damageSourceId: incomingContext.damageSourceId ?? instance.damageSourceId,
            transactionId: incomingContext.transactionId ?? instance.transactionId,
            parentEventId: incomingContext.parentEventId ?? instance.parentEventId,
            parentHitId: incomingContext.parentHitId ?? instance.parentHitId,
            hitEventPhase: incomingContext.hitEventPhase ?? instance.hitEventPhase,
            blackboard: {
                // Event-local scratch values remain available, but a listener's
                // configured/dynamic Blackboard owns colliding keys. Otherwise
                // receiving an unrelated Buff with `duration = 4` can silently
                // replace a weapon passive's own `duration = 20`.
                ...plainClone(incomingContext.blackboard ?? {}),
                ...plainClone(instance.blackboard)
            },
            payload: {
                buffId: instance.buffId,
                stackCount: instance.stackCount,
                statusMetadata: plainClone(instance.metadata),
                statusOwnerId: instance.ownerId,
                eventSourceId: incomingContext.sourceId ?? null,
                statusSourceId: instance.sourceId,
                eventOwnerId: incomingContext.ownerId ?? null,
                eventTargetId: incomingContext.targetId ?? null,
                ...plainClone(incomingContext.payload ?? {})
            }
        });
        if (execution && typeof execution === 'object'
            && execution.eventContext?.blackboard
            && typeof execution.eventContext.blackboard === 'object') {
            instance.blackboard = plainClone(execution.eventContext.blackboard);
            this.onBlackboardChange(this.#publicInstance(instance), {
                before: beforeBlackboard,
                after: plainClone(instance.blackboard),
                eventContext: plainClone(incomingContext),
                eventType,
                frame
            });
        }
        return execution?.result ?? execution;
    }

    #eventActions(definition, eventType) {
        return (definition.eventActions ?? [])
            .filter(group => group.eventType === eventType || group.eventName === eventType)
            .flatMap(group => group.actions ?? []);
    }

    #record(instance, frame, stage, extra = {}) {
        this.#syncStackDeadlines(instance);
        const sequence = this.nextEventSequence++;
        return {
            eventId: `status-event:${sequence}`,
            sequence,
            frame,
            stage,
            ...combatTriggerAttribution(instance),
            instanceId: instance.instanceId,
            buffId: instance.buffId,
            stackingKey: instance.stackingKey,
            stackingIdentifierType: instance.stackingIdentifierType,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            carrierId: instance.carrierId ?? instance.targetId,
            targetId: instance.targetId,
            damageSourceId: instance.damageSourceId ?? instance.sourceId,
            sourceSkillId: instance.sourceSkillId,
            rootSkillId: instance.rootSkillId,
            commandType: instance.commandType,
            skillType: instance.skillType,
            castId: instance.castId,
            rootCastId: instance.rootCastId ?? instance.castId,
            parentCastId: instance.parentCastId ?? null,
            inputSkillId: instance.inputSkillId ?? instance.rootSkillId,
            inputCommandType: instance.inputCommandType ?? instance.commandType,
            effectiveSkillType: instance.effectiveSkillType ?? instance.skillType,
            clockDomainId: instance.clockDomainId,
            actionClockDomainId: instance.actionClockDomainId ?? instance.clockDomainId,
            ruleId: instance.ruleId,
            stackCount: instance.stackCount,
            durationTicks: instance.durationTicks,
            expireFrame: instance.expireFrame,
            sourceMetadata: plainClone(instance.metadata ?? {}),
            ...extra,
            // Keep causal identity canonical even when an optional field in
            // `extra` is undefined. This prevents an old instance identity or
            // an undefined spread from erasing the active transaction.
            transactionId: extra.transactionId
                ?? instance.transactionId
                ?? null,
            parentEventId: extra.parentEventId
                ?? instance.parentEventId
                ?? null,
            parentHitId: extra.parentHitId
                ?? instance.parentHitId
                ?? null,
            hitEventPhase: extra.hitEventPhase
                ?? instance.hitEventPhase
                ?? null
        };
    }

    #consumeStackSources(instance, requestedCount, frame, layerId) {
        if (instance.stackLifetimePolicy === 'Independent') {
            const selected = layerId === undefined
                ? instance.stackLayers.slice(-requestedCount)
                : instance.stackLayers.filter(layer => layer.id === layerId);
            for (const layer of selected) {
                if (this.clockDomains && layer.timerId !== null) {
                    this.clockDomains.cancelTimer(instance.clockDomainId, layer.timerId, frame, 'StackRemoved');
                }
            }
            instance.stackLayers = instance.stackLayers.filter(layer => !selected.includes(layer));
            instance.stackSources = instance.stackLayers.map(layer => ({ sourceId: layer.sourceId, ownerId: layer.ownerId, count: 1 }));
            return selected.map(layer => ({ sourceId: layer.sourceId, ownerId: layer.ownerId, count: 1 }));
        }
        let remaining = Math.max(0, Number(requestedCount) || 0);
        const consumed = new Map();
        for (let index = instance.stackSources.length - 1;
            index >= 0 && remaining > 0;
            index -= 1) {
            const source = instance.stackSources[index];
            const amount = Math.min(remaining, source.count);
            if (amount <= 0) continue;
            const key = `${String(source.sourceId)}\u0000${String(source.ownerId)}`;
            const current = consumed.get(key) ?? {
                sourceId: source.sourceId,
                ownerId: source.ownerId,
                count: 0
            };
            current.count += amount;
            consumed.set(key, current);
            source.count -= amount;
            remaining -= amount;
            if (source.count <= 0) instance.stackSources.splice(index, 1);
        }
        return [...consumed.values()];
    }

    #syncStackDeadlines(instance) {
        if (instance.stackLifetimePolicy !== 'Independent') return;
        for (const layer of instance.stackLayers) {
            const timer = this.clockDomains && layer.timerId !== null
                ? this.clockDomains.timer(instance.clockDomainId, layer.timerId) : null;
            if (timer) {
                layer.expireFrame = timer.paused ? null : timer.deadlineFrame;
                layer.remainingDurationTicks = timer.paused ? timer.remainingTicks : null;
            }
        }
        const deadlines = instance.stackLayers.map(layer => layer.expireFrame);
        instance.expireFrame = deadlines.length && deadlines.every(Number.isFinite)
            ? Math.max(...deadlines) : null;
        instance.remainingDurationTicks = instance.stackLayers.some(layer => layer.remainingDurationTicks != null)
            ? Math.max(...instance.stackLayers.map(layer => layer.remainingDurationTicks ?? 0)) : null;
    }

    #publicInstance(instance) {
        this.#syncStackDeadlines(instance);
        const { definition: _definition, generation: _generation, ...publicInstance } = instance;
        return plainClone(publicInstance);
    }
}
