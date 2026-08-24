import CombatContext, { cloneValue } from './combat-context.mjs';
import EffectRuntime from './effect-runtime.mjs';
import { ClockDomainManager } from './clock-domain-manager.mjs';
import { ResourceSystem } from './resource-system.mjs';
import { VitalMachine } from './vital-machine.mjs';
import { AuraMachine } from './aura-machine.mjs';
import { ReactionMachine } from './reaction-machine.mjs';
import { ResilienceMachine } from './resilience-machine.mjs';
import { StatusEffectSystem } from './status-effect-system.mjs';
import { EffectSourceRegistry } from './effect-source-registry.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
    return number;
}

function nonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return number;
}

function identifier(value, label, { allowNull = false } = {}) {
    if (allowNull && (value === null || value === undefined)) return null;
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function definitionsArray(value, idKey = 'id') {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map(item => cloneValue(item));
    if (value instanceof Map) {
        return [...value.entries()].map(([id, definition]) => ({
            ...cloneValue(definition),
            [idKey]: definition?.[idKey] ?? id
        }));
    }
    if (!isRecord(value)) throw new TypeError('Definitions must be an array, Map or object.');
    return Object.entries(value).map(([id, definition]) => ({
        ...cloneValue(definition),
        [idKey]: definition?.[idKey] ?? id
    }));
}

function readPath(root, path, fallback = undefined) {
    if (path === undefined || path === null || path === '') return root;
    let current = root;
    for (const key of String(path).split('.')) {
        if (current === null || current === undefined
            || !Object.prototype.hasOwnProperty.call(Object(current), key)) return fallback;
        current = current[key];
    }
    return current;
}

function compare(left, operator, right) {
    switch (String(operator ?? 'EQ').toUpperCase()) {
        case 'GT': case '>': return left > right;
        case 'GE': case '>=': return left >= right;
        case 'LT': case '<': return left < right;
        case 'LE': case '<=': return left <= right;
        case 'NE': case '!=': case '!==': return left !== right;
        case 'EQ': case 'EQUALS': case '=': case '===': return left === right;
        default: return false;
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

/**
 * General, data-driven combat facade. The exact Pelica simulator remains
 * separate; this runtime composes the reusable state machines needed by
 * equipment, talents, contracts, auras, healing and elemental reactions.
 */
export class CombatRuntime {
    constructor({
        schedule = null,
        tickRate = 30,
        definitions = {},
        damageResolver = null,
        skillProgramResolver = null,
        timeDilationResolver = null,
        maxDerivedDepth = 16,
        maxEventsPerRun = 10000
    } = {}) {
        if (schedule !== null && typeof schedule !== 'function') {
            throw new TypeError('schedule must be a function or null.');
        }
        if (!isRecord(definitions)) throw new TypeError('definitions must be an object.');
        if (damageResolver !== null && typeof damageResolver !== 'function') {
            throw new TypeError('damageResolver must be a function or null.');
        }
        if (skillProgramResolver !== null && typeof skillProgramResolver !== 'function') {
            throw new TypeError('skillProgramResolver must be a function or null.');
        }
        if (timeDilationResolver !== null && typeof timeDilationResolver !== 'function') {
            throw new TypeError('timeDilationResolver must be a function or null.');
        }
        this.damageResolver = damageResolver;
        this.skillProgramResolver = skillProgramResolver;
        this.timeDilationResolver = timeDilationResolver;
        this.tickRate = finite(tickRate, 'tickRate');
        if (this.tickRate <= 0) throw new RangeError('tickRate must be positive.');
        this.maxDerivedDepth = nonNegativeInteger(maxDerivedDepth, 'maxDerivedDepth');
        if (this.maxDerivedDepth < 1) throw new RangeError('maxDerivedDepth must be positive.');
        this.maxEventsPerRun = nonNegativeInteger(maxEventsPerRun, 'maxEventsPerRun');
        if (this.maxEventsPerRun < 1) throw new RangeError('maxEventsPerRun must be positive.');
        this.trace = [];
        this.rules = new Map();
        this.nextRuleSequence = 1;
        this.dispatchDepth = 0;
        this.abilityNotifyDepth = 0;
        this.pendingEvents = [];
        this.nextEventSequence = 1;
        this.nextProgramSequence = 1;
        this.programExecutions = new Map();
        this.currentFrame = 0;
        this.ownsScheduler = schedule === null;
        this.schedule = schedule ?? ((frame, priority, run, label = '') => {
            this.pendingEvents.push({
                frame: nonNegativeInteger(frame, 'scheduled frame'),
                priority: finite(priority, 'scheduled priority'),
                run,
                label,
                sequence: this.nextEventSequence++
            });
        });

        const clockDefinitions = definitionsArray(
            definitions.clockDomains ?? definitions.clocks,
            'id'
        ).filter(domain => domain.id !== 'global');
        this.context = new CombatContext();
        this.effectSources = new EffectSourceRegistry({
            context: this.context,
            resolveValue: (descriptor, eventContext) => this.#value(
                descriptor,
                this.context.createEventContext(eventContext)
            )
        });
        this.clockDomains = new ClockDomainManager({
            schedule: this.schedule,
            tickRate: this.tickRate,
            domains: clockDefinitions
        });
        this.resources = new ResourceSystem({
            schedule: this.schedule,
            clockDomainManager: this.clockDomains,
            tickRate: this.tickRate,
            strictSpend: definitions.strictResourceSpend ?? false
        });
        this.vitals = new VitalMachine({
            shieldStackingPolicy: definitions.shieldStackingPolicy ?? 'Replace'
        });
        this.reactions = new ReactionMachine({
            definitions: definitions.reactions ?? definitions.reactionDefinitions ?? {},
            clockDomains: this.clockDomains,
            targetValidator: targetId => this.context.hasEntity(targetId),
            onReaction: payload => this.#onReaction(payload)
        });
        this.resilience = new ResilienceMachine({
            profiles: definitions.resilienceProfiles ?? {},
            targetValidator: targetId => this.context.hasEntity(targetId)
        });
        this.statusEffects = new StatusEffectSystem({
            definitions: definitions.buffs ?? definitions.statusEffects ?? new Map(),
            schedule: this.schedule,
            clockDomains: this.clockDomains,
            tickRate: this.tickRate,
            executeActions: (actions, eventContext) =>
                this.effects.executeTransaction(actions, eventContext)
        });
        this.auras = new AuraMachine({
            definitions: definitions.auras ?? {},
            schedule: this.schedule,
            targetValidator: targetId => this.context.hasEntity(targetId),
            onApplyTarget: (eventContext, instance) => this.#onAuraTargetEntered(eventContext, instance),
            onRemoveTarget: (eventContext, instance) => this.#onAuraTargetLeft(eventContext, instance),
            onFinish: (eventContext, instance) => this.#onAuraFinished(eventContext, instance)
        });
        this.effects = new EffectRuntime({
            context: this.context,
            handlers: this.#defaultHandlers()
        });

        for (const entity of definitionsArray(definitions.entities, 'id')) {
            this.registerEntity(entity);
        }
        for (const vital of definitionsArray(definitions.vitals, 'id')) {
            if (!this.context.hasEntity(vital.id)) {
                throw new Error(`Vital definition references unknown entity: ${vital.id}`);
            }
            if (!this.vitals.hasEntity(vital.id)) this.vitals.registerEntity(vital);
        }
        for (const entry of definitionsArray(definitions.resilience, 'targetId')) {
            if (!this.context.hasEntity(entry.targetId)) {
                throw new Error(`Resilience definition references unknown entity: ${entry.targetId}`);
            }
            this.#registerResilience(entry);
        }
        for (const pool of definitionsArray(definitions.resources, 'id')) {
            this.resources.registerPool(pool);
        }
        for (const rule of definitionsArray(definitions.rules, 'id')) this.registerRule(rule);
    }

    registerEntity(definition) {
        if (!isRecord(definition)) throw new TypeError('entity definition must be an object.');
        const entity = this.context.registerEntity(definition);
        const clockDefinition = definition.clockDomain ?? (definition.clockDomainId
            ? { id: definition.clockDomainId, kind: definition.kind, ownerId: entity.id }
            : null);
        if (clockDefinition && !this.clockDomains.hasDomain(clockDefinition.id)) {
            this.clockDomains.registerDomain(clockDefinition);
        }
        const vitalDefinition = definition.vital ?? (definition.maxHp !== undefined
            ? {
                maxHp: definition.maxHp,
                currentHp: definition.currentHp,
                healingCap: definition.healingCap,
                allowRevive: definition.allowRevive,
                shieldStackingPolicy: definition.shieldStackingPolicy
            }
            : null);
        if (vitalDefinition) this.vitals.registerEntity({ id: entity.id, ...vitalDefinition });
        if (definition.reactionTarget !== false) {
            this.reactions.registerTarget({
                targetId: entity.id,
                metadata: definition.reactionMetadata ?? {}
            });
        }
        if (definition.resilience) {
            this.#registerResilience({ targetId: entity.id, ...definition.resilience });
        }
        this.#record('RuntimeEntityRegistered', {
            frame: 0,
            sourceId: null,
            ownerId: entity.ownerId,
            targetId: entity.id,
            reason: 'RegisterEntity'
        }, { kind: entity.kind });
        return entity;
    }

    registerRule(rule) {
        if (!isRecord(rule)) throw new TypeError('rule must be an object.');
        const id = identifier(rule.id ?? `rule:${this.nextRuleSequence}`, 'rule.id');
        if (this.rules.has(id)) throw new Error(`Duplicate rule id: ${id}`);
        const eventTypes = rule.eventTypes ?? (rule.eventType === undefined ? ['*'] : [rule.eventType]);
        if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
            throw new TypeError('rule.eventTypes must be a non-empty array.');
        }
        const normalized = {
            ...cloneValue(rule),
            id,
            eventTypes: eventTypes.map(type => identifier(type, 'rule event type')),
            priority: finite(rule.priority ?? 100, 'rule priority'),
            sequence: this.nextRuleSequence++,
            actions: cloneValue(rule.actions ?? rule.effects ?? [])
        };
        this.rules.set(id, normalized);
        return cloneValue(normalized);
    }

    dispatch(eventInput = {}) {
        if (!isRecord(eventInput)) throw new TypeError('dispatch requires an event context object.');
        if (this.dispatchDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum derived event depth ${this.maxDerivedDepth} exceeded.`);
        }
        const eventContext = deepFreeze(this.context.createEventContext(eventInput));
        this.dispatchDepth += 1;
        try {
            this.#record('EventDispatched', eventContext, { depth: this.dispatchDepth });
            const candidates = [...this.rules.values()]
                .filter(rule => rule.eventTypes.includes('*') || rule.eventTypes.includes(eventContext.eventType))
                .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
            const matchedRules = [];
            const results = [];
            for (const rule of candidates) {
                const passed = rule.condition === undefined
                    || this.effects.evaluate(rule.condition, eventContext);
                this.#record('RuleEvaluated', eventContext, {
                    ruleId: rule.id,
                    passed,
                    reason: passed ? 'RuleMatched' : 'RuleConditionFailed'
                });
                if (!passed) continue;
                matchedRules.push(rule.id);
                results.push({ ruleId: rule.id, result: this.effects.execute(rule.actions, eventContext) });
            }
            this.#record('EventCompleted', eventContext, {
                depth: this.dispatchDepth,
                matchedRules: cloneValue(matchedRules)
            });
            return {
                eventContext: cloneValue(eventContext),
                matchedRules,
                results
            };
        } finally {
            this.dispatchDepth -= 1;
        }
    }

    execute(actions, eventContext = {}) {
        const context = this.context.createEventContext(eventContext);
        return this.effects.execute(actions, context);
    }

    executeTransaction(actions, eventContext = {}) {
        const context = this.context.createEventContext(eventContext);
        return this.effects.executeTransaction(actions, context);
    }

    scheduleProgram(program, eventContext = {}) {
        if (!isRecord(program) || !Array.isArray(program.timeline)) {
            throw new TypeError('scheduleProgram requires a compiled program with a timeline array.');
        }
        const onTimelineSeek = eventContext.onTimelineSeek;
        const onInterruptible = eventContext.onInterruptible;
        if (onTimelineSeek !== undefined && typeof onTimelineSeek !== 'function') {
            throw new TypeError('onTimelineSeek must be a function when provided.');
        }
        if (onInterruptible !== undefined && typeof onInterruptible !== 'function') {
            throw new TypeError('onInterruptible must be a function when provided.');
        }
        const contextInput = { ...eventContext };
        delete contextInput.onTimelineSeek;
        delete contextInput.onInterruptible;
        const frame = nonNegativeInteger(contextInput.frame ?? this.currentFrame, 'program frame');
        const sequence = this.nextProgramSequence++;
        const skillId = contextInput.skillId ?? program.skillId ?? `program:${sequence}`;
        const castId = contextInput.castId ?? `cast:${skillId}:${sequence}`;
        const executionId = `program-execution:${sequence}`;
        const context = this.context.createEventContext({
            ...cloneValue(contextInput),
            frame,
            eventType: contextInput.eventType ?? 'SkillProgramStarted',
            skillId,
            rootSkillId: contextInput.rootSkillId ?? skillId,
            castId,
            blackboard: {
                ...cloneValue(program.blackboard ?? {}),
                ...cloneValue(contextInput.blackboard ?? {})
            }
        });
        const domainId = context.clockDomainId ?? 'global';
        const execution = {
            executionId,
            sequence,
            castId,
            skillId,
            clockDomainId: domainId,
            program: cloneValue(program),
            context,
            blackboard: cloneValue(context.blackboard),
            scheduled: [],
            generation: 0,
            active: true,
            interruptible: false,
            timelineAnchorFrame: 0,
            timelineAnchorGlobalFrame: frame,
            onTimelineSeek: onTimelineSeek ?? null,
            onInterruptible: onInterruptible ?? null,
            scheduleFrom: null
        };
        this.programExecutions.set(executionId, execution);
        const schedulePhase = (group, phase, offset, priority, sourceActions,
            originFrame, timelineOrigin, generation) => {
            if (!Array.isArray(sourceActions) || sourceActions.length === 0) return;
            const actions = cloneValue(sourceActions).map(action => {
                if (typeof action.sourceKey !== 'string'
                    || !action.sourceKey.startsWith('ake-skill:')) return action;
                return { ...action, sourceKey: `${action.sourceKey}:${castId}` };
            });
            const timerId = `program:${sequence}:generation:${generation}:group:${group.groupIndex}:${phase}`;
            const scheduledPhase = {
                timerId,
                groupIndex: group.groupIndex,
                phase,
                offset,
                actionCount: actions.length,
                generation
            };
            this.clockDomains.startTimer(domainId, {
                id: timerId,
                frame: originFrame,
                durationTicks: nonNegativeInteger(
                    offset - timelineOrigin,
                    `${phase} frame offset`
                ),
                priority,
                sourceId: context.sourceId,
                ownerId: context.ownerId,
                targetId: context.targetId,
                skillId,
                rootSkillId: context.rootSkillId,
                ruleId: context.ruleId,
                reason: `SkillProgram:${phase}`,
                label: `${skillId}:${group.groupIndex}:${phase}`,
                onComplete: completionFrame => {
                    if (!execution.active || scheduledPhase.generation !== execution.generation) {
                        return null;
                    }
                    const transaction = this.executeTransaction(actions, {
                        ...cloneValue(context),
                        frame: completionFrame,
                        programExecutionId: executionId,
                        timelineFrame: offset,
                        blackboard: cloneValue(
                            this.programExecutions.get(executionId)?.blackboard ?? context.blackboard
                        ),
                        eventType: phase === 'start'
                            ? 'SkillTimelineGroupStarted'
                            : 'SkillTimelineGroupEnded'
                    });
                    const activeExecution = this.programExecutions.get(executionId);
                    if (activeExecution) {
                        activeExecution.blackboard = cloneValue(transaction.eventContext.blackboard);
                    }
                    this.#record('SkillProgramPhaseExecuted', {
                        ...context,
                        frame: completionFrame
                    }, {
                        groupIndex: group.groupIndex,
                        phase,
                        actionCount: actions.length,
                        castId
                    });
                    return transaction;
                }
            });
            execution.scheduled.push(scheduledPhase);
        };
        execution.scheduleFrom = (originFrame, timelineOrigin, generation) => {
            for (const group of execution.program.timeline) {
                // Skill timeline effects precede the frame's passive resource
                // tick and input commands.
                const startOffset = Number(group.startFrame ?? 0);
                if (startOffset >= timelineOrigin) {
                    schedulePhase(group, 'start', startOffset, 1, group.actions,
                        originFrame, timelineOrigin, generation);
                }
                const cleanupOffset = Number(group.endFrame ?? group.startFrame ?? 0);
                if (cleanupOffset >= timelineOrigin) {
                    schedulePhase(group, 'cleanup', cleanupOffset, 60,
                        group.cleanupActions, originFrame, timelineOrigin, generation);
                }
            }
        };
        execution.scheduleFrom(frame, 0, execution.generation);
        this.#record('SkillProgramScheduled', context, {
            executionId,
            castId,
            skillId,
            clockDomainId: domainId,
            groupCount: program.timeline.length,
            phaseCount: execution.scheduled.length
        });
        return {
            executionId,
            castId,
            skillId,
            clockDomainId: domainId,
            scheduled: execution.scheduled
        };
    }

    seekProgram(executionId, input = {}) {
        const execution = this.programExecutions.get(executionId);
        if (!execution?.active) {
            return { status: 'Ignored', reason: 'ProgramExecutionInactive', executionId };
        }
        const frame = nonNegativeInteger(input.frame ?? this.currentFrame, 'seek frame');
        const sourceTimelineFrame = nonNegativeInteger(
            input.sourceTimelineFrame ?? input.timelineFrame ?? execution.timelineAnchorFrame,
            'source timeline frame'
        );
        const destFrame = nonNegativeInteger(input.destFrame, 'destination timeline frame');
        const previousGeneration = execution.generation;
        for (const phase of execution.scheduled) {
            if (phase.generation !== previousGeneration || phase.offset <= sourceTimelineFrame) {
                continue;
            }
            this.clockDomains.cancelTimer(
                execution.clockDomainId,
                phase.timerId,
                frame,
                `TimelineSeek:${sourceTimelineFrame}->${destFrame}`
            );
        }
        execution.generation += 1;
        execution.timelineAnchorFrame = destFrame;
        execution.timelineAnchorGlobalFrame = frame;
        execution.scheduleFrom(frame, destFrame, execution.generation);
        const result = {
            status: 'Seeked',
            executionId,
            castId: execution.castId,
            skillId: execution.skillId,
            frame,
            sourceTimelineFrame,
            destFrame,
            generation: execution.generation
        };
        this.#record('SkillProgramSeeked', {
            ...execution.context,
            frame
        }, result);
        execution.onTimelineSeek?.(cloneValue(result));
        return result;
    }

    markProgramInterruptible(executionId, input = {}) {
        const execution = this.programExecutions.get(executionId);
        if (!execution?.active) {
            return { status: 'Ignored', reason: 'ProgramExecutionInactive', executionId };
        }
        const frame = nonNegativeInteger(input.frame ?? this.currentFrame, 'interrupt mark frame');
        execution.interruptible = true;
        const result = {
            status: 'MarkedInterruptible',
            executionId,
            castId: execution.castId,
            skillId: execution.skillId,
            frame,
            timelineFrame: nonNegativeInteger(
                input.timelineFrame ?? execution.timelineAnchorFrame,
                'interrupt timeline frame'
            )
        };
        this.#record('SkillProgramMarkedInterruptible', {
            ...execution.context,
            frame
        }, result);
        execution.onInterruptible?.(cloneValue(result));
        return result;
    }

    cancelProgramExecution(executionId, frame = this.currentFrame, reason = 'Cancelled') {
        const execution = this.programExecutions.get(executionId);
        if (!execution?.active) return false;
        const cancelFrame = nonNegativeInteger(frame, 'program cancellation frame');
        execution.active = false;
        for (const phase of execution.scheduled) {
            this.clockDomains.cancelTimer(
                execution.clockDomainId,
                phase.timerId,
                cancelFrame,
                reason
            );
        }
        this.#record('SkillProgramCancelled', {
            ...execution.context,
            frame: cancelFrame
        }, { executionId, castId: execution.castId, reason });
        return true;
    }

    cancelCastPrograms(castId, frame = this.currentFrame, reason = 'Cancelled') {
        const matches = [...this.programExecutions.values()]
            .filter(execution => execution.active && execution.castId === castId);
        for (const execution of matches) {
            this.cancelProgramExecution(execution.executionId, frame, reason);
        }
        return matches.length;
    }

    createAura(input) {
        return this.auras.createAura(input);
    }

    refreshAuraTargets(input) {
        return this.auras.refreshTargets(input);
    }

    removeAura(input) {
        return this.auras.removeAura(input);
    }

    runUntil(frame) {
        if (!this.ownsScheduler) {
            throw new Error('runUntil is only available when CombatRuntime owns its scheduler.');
        }
        const targetFrame = nonNegativeInteger(frame, 'runUntil frame');
        let processed = 0;
        while (true) {
            this.pendingEvents.sort((left, right) => left.frame - right.frame
                || left.priority - right.priority || left.sequence - right.sequence);
            const event = this.pendingEvents[0];
            if (!event || event.frame > targetFrame) break;
            this.pendingEvents.shift();
            this.currentFrame = event.frame;
            event.run();
            processed += 1;
            if (processed > this.maxEventsPerRun) {
                throw new Error(`Scheduled event limit ${this.maxEventsPerRun} exceeded.`);
            }
        }
        this.currentFrame = Math.max(this.currentFrame, targetFrame);
        return { frame: targetFrame, processed, pending: this.pendingEvents.length };
    }

    snapshot() {
        return {
            frame: this.currentFrame,
            context: this.context.snapshot(),
            clocks: this.clockDomains.snapshot(),
            resources: this.resources.snapshot(),
            vitals: this.vitals.snapshot(),
            statusEffects: this.statusEffects.snapshot(),
            effectSources: this.effectSources.snapshot(),
            auras: this.auras.snapshot(),
            reactions: this.reactions.snapshot(),
            resilience: this.resilience.snapshot(),
            effectTrace: cloneValue(this.effects.trace),
            trace: cloneValue(this.trace),
            pendingEvents: this.pendingEvents.map(event => ({
                frame: event.frame,
                priority: event.priority,
                label: event.label,
                sequence: event.sequence
            }))
        };
    }

    #registerResilience(definition) {
        return this.resilience.registerEntity({
            ...definition,
            targetId: definition.targetId ?? definition.id
        });
    }

    #record(stage, eventContext = {}, extra = {}) {
        const record = {
            frame: eventContext.frame ?? 0,
            stage,
            type: stage,
            sourceId: eventContext.sourceId ?? null,
            ownerId: eventContext.ownerId ?? null,
            targetId: eventContext.targetId ?? null,
            skillId: eventContext.skillId ?? null,
            rootSkillId: eventContext.rootSkillId ?? null,
            castId: eventContext.castId ?? null,
            buffInstanceId: eventContext.buffInstanceId ?? null,
            clockDomainId: eventContext.clockDomainId ?? null,
            reason: extra.reason ?? eventContext.reason ?? stage,
            ruleId: extra.ruleId ?? eventContext.ruleId ?? null,
            ...cloneValue(extra)
        };
        this.trace.push(record);
        return cloneValue(record);
    }

    #entityId(ref, eventContext, fallback = 'Target') {
        return this.context.resolveEntityRef(ref ?? fallback, eventContext).id;
    }

    #optionalEntityId(ref, eventContext, fallback = null) {
        if (ref === undefined) return fallback;
        if (ref === null) return null;
        return this.#entityId(ref, eventContext);
    }

    #value(descriptor, eventContext, fallback = 0) {
        if (descriptor === undefined || descriptor === null) return fallback;
        if (typeof descriptor === 'number') return descriptor;
        if (typeof descriptor === 'string') {
            if (descriptor.startsWith('$')) {
                return readPath(eventContext.blackboard, descriptor.slice(1), fallback);
            }
            if (descriptor.startsWith('Blackboard.')) {
                return readPath(eventContext.blackboard, descriptor.slice(12), fallback);
            }
            if (descriptor.startsWith('Payload.')) {
                return readPath(eventContext.payload, descriptor.slice(8), fallback);
            }
            const numeric = Number(descriptor);
            return Number.isFinite(numeric) ? numeric : descriptor;
        }
        if (!isRecord(descriptor)) return descriptor;
        if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
            return eventContext.blackboard?.[descriptor.blackboardKey] ?? descriptor.value ?? fallback;
        }
        const type = String(descriptor.type ?? descriptor.kind ?? '').toLowerCase();
        if (type === 'blackboard') {
            return readPath(eventContext.blackboard, descriptor.key ?? descriptor.path, descriptor.default ?? fallback);
        }
        if (type === 'payload') {
            return readPath(eventContext.payload, descriptor.key ?? descriptor.path, descriptor.default ?? fallback);
        }
        if (type === 'attribute') {
            const entityId = this.#entityId(
                descriptor.entity ?? descriptor.entityRef ?? descriptor.target ?? 'Target',
                eventContext
            );
            return this.context.getAttribute(
                entityId,
                descriptor.key ?? descriptor.attribute ?? descriptor.name
            ) ?? descriptor.default ?? fallback;
        }
        if (['add', 'multiply', 'subtract', 'divide', 'min', 'max'].includes(type)) {
            const values = descriptor.values ?? descriptor.operands
                ?? [descriptor.left, descriptor.right];
            if (!Array.isArray(values) || values.length === 0) {
                throw new TypeError(`${descriptor.type} value expression requires operands.`);
            }
            const resolved = values.map((value, index) => finite(
                this.#value(value, eventContext, 0),
                `${descriptor.type} operand ${index}`
            ));
            switch (type) {
                case 'add': return resolved.reduce((sum, value) => sum + value, 0);
                case 'multiply': return resolved.reduce((product, value) => product * value, 1);
                case 'subtract': return resolved.slice(1).reduce((value, operand) => value - operand, resolved[0]);
                case 'divide':
                    return resolved.slice(1).reduce((value, operand) => {
                        if (operand === 0) throw new RangeError('Divide expression divisor must not be zero.');
                        return value / operand;
                    }, resolved[0]);
                case 'min': return Math.min(...resolved);
                case 'max': return Math.max(...resolved);
                default: break;
            }
        }
        if (type === 'float32') {
            return Math.fround(this.#value(descriptor.input ?? descriptor.value, eventContext, fallback));
        }
        if (type === 'percentagefloat32') {
            const value = finite(
                this.#value(descriptor.input ?? descriptor.value, eventContext, fallback),
                'PercentageFloat32 value'
            );
            return Math.fround(value / 100) * 100;
        }
        return descriptor.value ?? fallback;
    }

    #number(descriptor, eventContext, label, fallback = undefined) {
        return finite(this.#value(descriptor, eventContext, fallback), label);
    }

    #assignedBlackboard(assignments, eventContext) {
        if (!Array.isArray(assignments)) return {};
        return Object.fromEntries(assignments.map(assignment => {
            const key = identifier(assignment.targetKey, 'buff assignment targetKey');
            const value = assignment.direct
                ? assignment.directValue
                : eventContext.blackboard?.[assignment.sourceKey];
            return [key, cloneValue(value)];
        }));
    }

    #actionAuraId(action, eventContext) {
        const auraId = identifier(action.auraId, 'auraId');
        if (!action.scopeAuraId) return auraId;
        const scopeId = eventContext.buffInstanceId
            ?? eventContext.castId
            ?? eventContext.ruleId
            ?? `source:${String(eventContext.sourceId)}`;
        return `${String(auraId)}:${String(scopeId)}`;
    }

    #auraTargetIds(action, eventContext) {
        if (Array.isArray(action.targetIds)) {
            return action.targetIds.map(ref => this.#entityId(ref, eventContext));
        }
        const selector = action.targetSelector;
        if (!isRecord(selector) || selector.mode !== 'Global') return [];
        const source = eventContext.sourceId === null
            ? null
            : this.context.getEntity(eventContext.sourceId);
        const queryTags = (selector.tagIds ?? []).map(tagId => `ake-tag:${String(tagId)}`);
        return this.context.listEntities(entity => {
            if (selector.excludeOwner
                && (entity.id === eventContext.sourceId || entity.id === eventContext.ownerId)) {
                return false;
            }
            if (selector.faction === 'Ally' && source && entity.team !== source.team) return false;
            if (selector.faction === 'Anti' && source
                && (entity.team === source.team || entity.team === null || source.team === null)) {
                return false;
            }
            if (selector.objectType === 'Character'
                && !['Character', 'Enemy', 'Summon'].includes(entity.kind)) return false;
            if (queryTags.length > 0) {
                const matches = queryTags.map(tag => entity.tags.includes(tag));
                if (selector.tagQueryType === 'HasAll' && !matches.every(Boolean)) return false;
                if ((selector.tagQueryType ?? 'HasAny') === 'HasAny' && !matches.some(Boolean)) {
                    return false;
                }
            }
            return true;
        }).map(entity => entity.id);
    }

    #materializeAuraDefinition(definition, eventContext) {
        if (definition === undefined || definition === null) return undefined;
        const materialized = cloneValue(definition ?? {});
        materialized.sourceMetadata = {
            ...cloneValue(eventContext.payload?.statusMetadata ?? {}),
            ...cloneValue(materialized.sourceMetadata ?? {})
        };
        if (Array.isArray(materialized.targetBuffs)) {
            materialized.targetBuffs = materialized.targetBuffs.map(buff => ({
                ...buff,
                blackboard: {
                    ...(buff.assignBlackboard
                        ? this.#assignedBlackboard(buff.assignments, eventContext)
                        : {}),
                    ...cloneValue(buff.blackboard ?? {})
                }
            }));
        }
        return materialized;
    }

    #poolRef(action, eventContext) {
        const explicit = action.poolRef ?? action.poolId ?? action.resourcePoolId;
        if (explicit !== undefined) return explicit;
        const resourceType = action.resourceType ?? action.costType;
        if (resourceType === undefined) throw new TypeError('Resource action requires poolId or resourceType.');
        const rawOwner = action.resourceOwner ?? action.poolOwnerId ?? action.ownerRef;
        const ownerId = rawOwner === undefined
            ? (action.scope === 'Entity' ? eventContext.sourceId : null)
            : this.#optionalEntityId(rawOwner, eventContext);
        return {
            resourceType,
            scope: action.scope,
            ownerId
        };
    }

    #attribution(action, eventContext, { target = true } = {}) {
        const sourceRef = action.sourceRef ?? action.sourceEntity ?? action.sourceId;
        const ownerRef = action.ownerRef ?? action.ownerEntity ?? action.ownerId;
        const targetRef = action.targetRef ?? action.targetSource ?? action.target ?? action.targetId;
        return {
            frame: nonNegativeInteger(action.frame ?? eventContext.frame ?? 0, 'action frame'),
            sourceId: this.#optionalEntityId(sourceRef, eventContext, eventContext.sourceId),
            ownerId: this.#optionalEntityId(ownerRef, eventContext, eventContext.ownerId),
            targetId: target
                ? this.#entityId(targetRef, eventContext, 'Target')
                : undefined,
            skillId: action.skillId ?? eventContext.skillId ?? null,
            rootSkillId: action.rootSkillId ?? eventContext.rootSkillId ?? null,
            castId: action.castId ?? eventContext.castId ?? null,
            buffInstanceId: action.buffInstanceId ?? eventContext.buffInstanceId ?? null,
            clockDomainId: action.clockDomainId ?? eventContext.clockDomainId ?? 'global',
            reason: action.reason,
            ruleId: action.ruleId ?? eventContext.ruleId ?? null
        };
    }

    #entityClockDomainId(entityId, fallback = 'global') {
        const candidate = `${String(entityId)}:clock`;
        return this.clockDomains.hasDomain(candidate) ? candidate : fallback;
    }

    #defaultHandlers() {
        return {
            HasBuff: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.entityRef ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                return this.statusEffects.has({
                    targetId,
                    buffId: condition.buffId ?? null,
                    stackingKey: condition.stackingKey ?? null,
                    sourceId: condition.sourceId === undefined
                        ? undefined
                        : this.#optionalEntityId(condition.sourceId, eventContext),
                    ownerId: condition.ownerId === undefined
                        ? undefined
                        : this.#optionalEntityId(condition.ownerId, eventContext)
                });
            },
            BuffStackCompare: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const stackCount = this.statusEffects.list({
                    active: true,
                    targetId,
                    buffId: condition.buffId
                }).reduce((sum, instance) => sum + instance.stackCount, 0);
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount,
                    eventContext,
                    'Buff stack comparison value'
                );
                return compare(stackCount, condition.operator, expected);
            },
            ResourceCompare: (condition, eventContext) => {
                const value = this.resources.get(this.#poolRef(condition, eventContext), eventContext.frame);
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount,
                    eventContext,
                    'resource comparison value'
                );
                return compare(value, condition.operator, expected);
            },
            ResolveResource: (descriptor, eventContext) => ({
                value: this.resources.get(this.#poolRef(descriptor, eventContext), eventContext.frame)
            }),
            HpRatioCompare: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const ratio = this.vitals.hpRatio(targetId, eventContext.frame);
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.ratio,
                    eventContext,
                    'HP ratio comparison value'
                );
                return compare(ratio, condition.operator, expected);
            },
            HpCompare: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const currentHp = this.vitals.get(targetId, eventContext.frame).currentHp;
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount,
                    eventContext,
                    'HP comparison value'
                );
                return compare(currentHp, condition.operator, expected);
            },
            EntityIsMainCharacter: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Source'
                );
                const entity = this.context.getEntity(targetId);
                return entity.metadata?.isMainCharacter === true;
            },
            EntityCountCompare: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                let count = this.context.hasEntity(targetId) ? 1 : 0;
                if (count > 0 && condition.excludeDeadEntity
                    && this.vitals.hasEntity(targetId)
                    && !this.vitals.get(targetId, eventContext.frame).alive) {
                    count = 0;
                }
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount ?? 1,
                    eventContext,
                    'entity-count comparison value'
                );
                return compare(count, condition.operator ?? 'GE', expected);
            },
            StoreBuffCount: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                const buffId = action.useCurrentBuff
                    ? eventContext.payload?.buffId
                    : action.buffId;
                if (buffId === undefined || buffId === null || buffId === '') {
                    throw new TypeError('StoreBuffCount requires buffId or current Buff context.');
                }
                const key = identifier(action.key ?? action.blackboardKey, 'StoreBuffCount key');
                const before = cloneValue(eventContext.blackboard[key]);
                const count = this.statusEffects.list({
                    active: true,
                    targetId,
                    buffId
                }).reduce((sum, instance) => sum + instance.stackCount, 0);
                eventContext.blackboard[key] = count;
                return { before, requested: count, actual: count, discarded: 0, after: count };
            },
            ResourceChange: (action, eventContext) => {
                const attribution = this.#attribution(action, eventContext, { target: false });
                if (action.fromPoolId !== undefined || action.from !== undefined) {
                    return this.resources.transfer({
                        ...attribution,
                        fromPoolId: action.fromPoolId ?? action.from,
                        toPoolId: action.toPoolId ?? action.to,
                        amount: this.#number(action.amount ?? action.value, eventContext, 'transfer amount')
                    });
                }
                const baseAmount = this.#number(action.amount ?? action.value ?? action.delta,
                    eventContext, 'resource amount');
                const coefficient = this.#number(action.coefficient ?? 1,
                    eventContext, 'resource coefficient', 1);
                const rawAmount = baseAmount * coefficient;
                const operation = String(action.operation ?? action.changeType ?? action.mode ?? '').toLowerCase();
                const spend = rawAmount < 0
                    || ['spend', 'consume', 'cost', 'subtract', 'decrease'].includes(operation);
                const method = spend ? 'spend' : 'gain';
                return this.resources[method]({
                    ...attribution,
                    poolRef: this.#poolRef(action, eventContext),
                    amount: Math.abs(rawAmount),
                    strict: action.strict
                });
            },
            Heal: (action, eventContext) => this.vitals.heal({
                ...this.#attribution(action, eventContext),
                baseAmount: this.#number(action.baseAmount ?? action.amount ?? action.value,
                    eventContext, 'heal amount'),
                healingDoneScalar: this.#number(action.healingDoneScalar ?? 1,
                    eventContext, 'healingDoneScalar', 1),
                healingTakenScalar: this.#number(action.healingTakenScalar ?? 1,
                    eventContext, 'healingTakenScalar', 1),
                buffId: action.buffId ?? eventContext.payload?.buffId ?? null,
                revive: action.revive
            }),
            AddShield: (action, eventContext) => this.vitals.addShield({
                ...this.#attribution(action, eventContext),
                amount: this.#number(action.amount ?? action.value, eventContext, 'shield amount'),
                priority: this.#number(action.priority ?? 0, eventContext, 'shield priority'),
                stackingKey: action.stackingKey ?? null,
                stackingPolicy: action.stackingPolicy,
                buffId: action.buffId ?? eventContext.payload?.buffId ?? null
            }),
            Damage: (action, eventContext) => this.vitals.damage({
                ...this.#attribution(action, eventContext),
                amount: this.#number(action.amount ?? action.value ?? action.resolvedAmount,
                    eventContext, 'damage amount'),
                damageType: action.damageType ?? 'Generic',
                bypassShield: action.bypassShield ?? false
            }),
            ApplyBuff: (action, eventContext) => {
                const candidates = Array.isArray(action.buffs)
                    ? action.buffs
                    : [{
                        buffId: action.buffId,
                        blackboard: action.blackboard,
                        assignments: action.assignments,
                        assignBlackboard: action.assignBlackboard
                    }];
                const count = nonNegativeInteger(
                    this.#number(action.count ?? 1, eventContext, 'buff count', 1),
                    'buff count'
                );
                const results = [];
                for (let index = 0; index < count; index += 1) {
                    for (const candidate of candidates) {
                        const attribution = this.#attribution(action, eventContext);
                        const applied = this.statusEffects.apply({
                            ...attribution,
                            // Buff lifetimes belong to the affected entity. An
                            // explicit action clock still wins; otherwise a
                            // hostile debuff must not inherit the caster clock.
                            clockDomainId: action.clockDomainId
                                ?? this.#entityClockDomainId(
                                    attribution.targetId,
                                    attribution.clockDomainId
                                ),
                            buffId: candidate.buffId,
                            sourceSkillId: action.sourceSkillId ?? eventContext.skillId,
                            durationTicks: action.durationTicks,
                            durationSeconds: action.durationSeconds,
                            stackingKey: action.stackingKey,
                            stackingPolicy: action.stackingPolicy,
                            stackingScope: action.stackingScope,
                            maxStacks: action.maxStacks,
                            stackCount: action.stackCount,
                            inheritEventBlackboard: action.inheritEventBlackboard,
                            triggerEnhancementEvent: action.triggerEnhancementEvent,
                            blackboard: {
                                ...(candidate.assignBlackboard
                                    ? this.#assignedBlackboard(candidate.assignments, eventContext)
                                    : {}),
                                ...cloneValue(candidate.blackboard ?? {})
                            },
                            metadata: {
                                ...cloneValue(eventContext.payload?.statusMetadata ?? {}),
                                ...cloneValue(action.metadata ?? {})
                            }
                        }, eventContext);
                        results.push(applied);
                        this.#notifyOutputBuff(applied, eventContext);
                    }
                }
                return Array.isArray(action.buffs) || count !== 1 ? results : results[0];
            },
            FinishBuff: (action, eventContext) => {
                if (action.instanceId === undefined && action.buffInstanceId === undefined
                    && action.buffId === undefined && action.stackingKey === undefined
                    && (!Array.isArray(action.tagIds) || action.tagIds.length === 0)) {
                    throw new TypeError(
                        'FinishBuff requires instanceId, buffId, stackingKey or tagIds.'
                    );
                }
                const targetRef = action.targetRef ?? action.target ?? action.targetId;
                return this.statusEffects.finish({
                    frame: action.frame ?? eventContext.frame,
                    instanceId: action.instanceId ?? action.buffInstanceId,
                    buffId: action.buffId,
                    tagIds: cloneValue(action.tagIds),
                    tagQueryType: action.tagQueryType,
                    stackingKey: action.stackingKey,
                    targetId: targetRef === undefined
                        ? eventContext.targetId
                        : this.#entityId(targetRef, eventContext),
                    sourceId: (action.sourceRef ?? action.sourceId) === undefined
                        ? undefined
                        : this.#optionalEntityId(
                            action.sourceRef ?? action.sourceId,
                            eventContext
                        ),
                    ownerId: action.ownerId === undefined
                        ? undefined
                        : this.#optionalEntityId(action.ownerId, eventContext),
                    finishAll: action.finishAll !== false,
                    stackCount: action.stackCount === undefined
                        ? undefined
                        : this.#number(action.stackCount, eventContext, 'finished buff stack count'),
                    reason: action.reason ?? 'FinishBuff'
                }, eventContext);
            },
            ApplyInfliction: (action, eventContext) => this.reactions.applyInfliction({
                ...this.#attribution(action, eventContext),
                element: action.element ?? action.inflictionType,
                amount: this.#number(action.amount ?? action.inflictionAmount ?? action.value,
                    eventContext, 'infliction amount'),
                definition: action.definition
            }),
            ApplyImpact: (action, eventContext) => this.resilience.applyImpact({
                ...this.#attribution(action, eventContext),
                amount: this.#number(action.amount ?? action.value, eventContext, 'impact amount'),
                controlType: action.controlType,
                controlLevel: action.controlLevel
            }),
            SetResilienceModifier: (action, eventContext) => this.resilience.setModifier({
                ...this.#attribution(action, eventContext),
                modifierId: action.modifierId,
                sourceKey: action.sourceKey ?? eventContext.buffInstanceId,
                superArmorLevel: action.superArmorLevel === undefined
                    ? undefined
                    : this.#number(action.superArmorLevel, eventContext, 'super armor level'),
                impactResistance: action.impactResistance === undefined
                    ? undefined
                    : this.#number(action.impactResistance, eventContext, 'impact resistance'),
                impactScalar: action.impactScalar === undefined
                    ? undefined
                    : this.#number(action.impactScalar, eventContext, 'impact scalar'),
                rawResilienceDecreaseFactor: action.rawResilienceDecreaseFactor === undefined
                    ? undefined
                    : this.#value(action.rawResilienceDecreaseFactor, eventContext),
                metadata: action.metadata
            }),
            RemoveResilienceModifier: (action, eventContext) => this.resilience.removeModifier({
                ...this.#attribution(action, eventContext),
                modifierId: action.modifierId,
                sourceKey: action.sourceKey,
                buffInstanceId: action.buffInstanceId ?? eventContext.buffInstanceId,
                sourceId: action.sourceId
            }),
            SeekSkillTimeline: (action, eventContext) => this.seekProgram(
                identifier(eventContext.programExecutionId, 'programExecutionId'),
                {
                    frame: eventContext.frame,
                    sourceTimelineFrame: eventContext.timelineFrame,
                    destFrame: action.destFrame
                }
            ),
            MarkSkillInterruptible: (action, eventContext) => this.markProgramInterruptible(
                identifier(eventContext.programExecutionId, 'programExecutionId'),
                {
                    frame: eventContext.frame,
                    timelineFrame: eventContext.timelineFrame
                }
            ),
            TriggerStatusEvent: (action, eventContext) => this.statusEffects.notifyAbilityEvent({
                ...cloneValue(eventContext),
                eventType: action.eventType,
                listenerTargetId: eventContext.targetId
            }),
            LaunchSkillProgram: (action, eventContext) => {
                if (!this.skillProgramResolver) {
                    return {
                        status: 'Unresolved',
                        reason: 'MissingSkillProgramResolver',
                        childSkillId: action.childSkillId
                    };
                }
                if (action.childSkillId === eventContext.skillId) {
                    return {
                        status: 'Ignored',
                        reason: 'SelfReferentialSkillProgram',
                        childSkillId: action.childSkillId
                    };
                }
                const resolution = this.skillProgramResolver({
                    skillId: action.childSkillId,
                    action: cloneValue(action),
                    eventContext: cloneValue(eventContext),
                    runtime: this
                });
                const program = isRecord(resolution?.program)
                    ? resolution.program
                    : resolution;
                if (!isRecord(program) || !Array.isArray(program.timeline)) {
                    return {
                        status: 'Unresolved',
                        reason: 'SkillProgramNotFound',
                        childSkillId: action.childSkillId
                    };
                }
                const assigned = this.#assignedBlackboard(
                    action.assignments ?? [],
                    eventContext
                );
                const launchDelayTicks = nonNegativeInteger(
                    action.launchDelayTicks ?? 0,
                    'launchDelayTicks'
                );
                const launchFrame = eventContext.frame + launchDelayTicks;
                const scheduled = this.scheduleProgram(program, {
                    ...cloneValue(eventContext),
                    frame: launchFrame,
                    eventType: 'ChildSkillProgramStarted',
                    skillId: action.childSkillId,
                    rootSkillId: eventContext.rootSkillId
                        ?? eventContext.skillId
                        ?? action.childSkillId,
                    castId: eventContext.castId,
                    blackboard: {
                        ...(action.inheritBlackboard === false
                            ? {}
                            : cloneValue(eventContext.blackboard ?? {})),
                        ...assigned
                    }
                });
                return {
                    status: 'Scheduled',
                    childSkillId: action.childSkillId,
                    projectileId: action.projectileId ?? null,
                    launchFrame,
                    launchDelayTicks,
                    scheduled
                };
            },
            ResolveTimeDilation: (action, eventContext) => {
                if (!this.timeDilationResolver) {
                    return {
                        status: 'Unresolved',
                        reason: 'MissingTimeDilationResolver',
                        raw: cloneValue(action.raw)
                    };
                }
                const resolution = this.timeDilationResolver({
                    action: cloneValue(action),
                    eventContext: cloneValue(eventContext),
                    runtime: this,
                    tickRate: this.tickRate
                });
                if (!isRecord(resolution)) {
                    throw new TypeError('timeDilationResolver must return an object.');
                }
                const pauses = resolution.pauses ?? [];
                if (!Array.isArray(pauses)) {
                    throw new TypeError('timeDilationResolver pauses must be an array.');
                }
                const applied = pauses.map(pause => {
                    const frameOffsetTicks = nonNegativeInteger(
                        pause.frameOffsetTicks ?? 0,
                        'time-dilation frameOffsetTicks'
                    );
                    const pauseFrame = eventContext.frame + frameOffsetTicks;
                    const applyPause = () => this.clockDomains.pause(
                        pause.domainId ?? eventContext.clockDomainId ?? 'global',
                        {
                            ...this.#attribution(action, eventContext, { target: false }),
                            frame: pauseFrame,
                            durationTicks: pause.durationTicks,
                            excludedTicks: pause.excludedTicks,
                            requestedScale: pause.requestedScale,
                            sourceSkillId: eventContext.skillId,
                            reason: pause.reason ?? action.sourceType ?? 'TimeDilation'
                        }
                    );
                    if (frameOffsetTicks === 0) return applyPause();
                    const priority = finite(
                        pause.priority ?? 50,
                        'time-dilation scheduled priority'
                    );
                    this.schedule(
                        pauseFrame,
                        priority,
                        applyPause,
                        `time-dilation:${pause.reason ?? action.sourceType ?? 'curve'}`
                    );
                    return {
                        status: 'Scheduled',
                        frame: pauseFrame,
                        priority,
                        domainId: pause.domainId
                            ?? eventContext.clockDomainId
                            ?? 'global'
                    };
                });
                return { ...cloneValue(resolution), applied };
            },
            ResolveDamagePacket: (action, eventContext) => {
                if (!this.damageResolver) {
                    return {
                        status: 'Unresolved',
                        reason: 'MissingDamageResolver',
                        damageUnits: cloneValue(action.damageUnits ?? [])
                    };
                }
                const resolution = this.damageResolver({
                    action: cloneValue(action),
                    eventContext: cloneValue(eventContext),
                    runtime: this,
                    resolveValue: descriptor => this.#value(descriptor, eventContext)
                });
                if (!isRecord(resolution)) {
                    throw new TypeError('damageResolver must return an object.');
                }
                if (resolution.status === 'Unresolved') return cloneValue(resolution);
                const hits = resolution.hits ?? [];
                if (!Array.isArray(hits)) throw new TypeError('damageResolver hits must be an array.');
                const appliedHits = hits.map(hit => {
                    const amount = finite(
                        hit.amount ?? hit.finalDamage,
                        'resolved damage amount'
                    );
                    if (['Poise', 'Resilience'].includes(hit.damageAttributeType)) {
                        return {
                            damageAttributeType: hit.damageAttributeType,
                            result: this.resilience.applyImpact({
                                ...this.#attribution({ ...action, ...hit }, eventContext),
                                amount,
                                controlType: hit.controlType,
                                controlLevel: hit.controlLevel
                            })
                        };
                    }
                    return {
                        damageAttributeType: hit.damageAttributeType ?? 'Hp',
                        result: this.vitals.damage({
                            ...this.#attribution({ ...action, ...hit }, eventContext),
                            amount,
                            damageType: hit.damageType ?? action.damageType ?? 'Generic',
                            bypassShield: hit.bypassShield ?? action.bypassShield ?? false
                        })
                    };
                });
                return {
                    status: resolution.status ?? 'Applied',
                    resolution: cloneValue(resolution),
                    hits: appliedHits
                };
            },
            ApplyEffectSource: (action, eventContext) => this.effectSources.apply({
                ...this.#attribution(action, eventContext),
                sourceKey: action.sourceKey ?? eventContext.buffInstanceId,
                sourceType: action.sourceType ?? 'Effect',
                modifiers: action.modifiers ?? [],
                damageModifiers: action.damageModifiers ?? [],
                tags: action.tags ?? [],
                metadata: action.metadata
            }, eventContext),
            RemoveEffectSource: (action, eventContext) => this.effectSources.remove({
                frame: action.frame ?? eventContext.frame,
                sourceKey: action.sourceKey,
                sourceType: action.sourceType,
                sourceId: action.sourceId,
                ownerId: action.ownerId,
                targetId: action.targetId,
                buffInstanceId: action.buffInstanceId ?? eventContext.buffInstanceId,
                ruleId: action.ruleId ?? eventContext.ruleId
            }, eventContext),
            ApplyControl: (action, eventContext) => this.resilience.applyControl({
                ...this.#attribution(action, eventContext),
                controlType: action.controlType,
                controlLevel: this.#number(action.controlLevel ?? 0, eventContext, 'control level')
            }),
            RecoverResilience: (action, eventContext) => this.resilience.recover({
                ...this.#attribution(action, eventContext),
                amount: this.#number(action.amount ?? action.value, eventContext, 'resilience recovery')
            }),
            ApplyExecutionGauge: (action, eventContext) => this.resilience.applyExecutionGauge({
                ...this.#attribution(action, eventContext),
                amount: this.#number(action.amount ?? action.value, eventContext, 'execution gauge amount')
            }),
            ConsumeExecutionGate: (action, eventContext) => this.resilience.consumeExecutionGate({
                ...this.#attribution(action, eventContext)
            }),
            CreateAura: (action, eventContext) => this.auras.createAura({
                ...this.#attribution(action, eventContext, { target: false }),
                auraId: this.#actionAuraId(action, eventContext),
                durationTicks: action.durationTicks,
                targetIds: this.#auraTargetIds(action, eventContext),
                definition: this.#materializeAuraDefinition(action.definition, eventContext)
            }),
            RefreshAuraTargets: (action, eventContext) => this.auras.refreshTargets({
                ...this.#attribution(action, eventContext, { target: false }),
                auraInstanceId: action.auraInstanceId,
                targetIds: (action.targetIds ?? []).map(ref => this.#entityId(ref, eventContext))
            }),
            RemoveAura: (action, eventContext) => this.auras.removeAura({
                ...this.#attribution(action, eventContext, { target: false }),
                auraInstanceId: action.auraInstanceId,
                auraId: action.auraId === undefined
                    ? undefined
                    : this.#actionAuraId(action, eventContext)
            }),
            PauseClock: (action, eventContext) => this.clockDomains.pause(
                action.domainId ?? action.clockDomainId ?? eventContext.clockDomainId ?? 'global',
                {
                    ...this.#attribution(action, eventContext, { target: false }),
                    durationTicks: action.durationTicks,
                    excludedTicks: action.excludedTicks,
                    requestedScale: action.requestedScale,
                    sourceSkillId: action.sourceSkillId ?? eventContext.skillId
                }
            ),
            EmitEvent: (action, eventContext) => {
                const targetRef = action.targetRef ?? action.target ?? action.targetId;
                const sourceRef = action.sourceRef ?? action.source ?? action.sourceId;
                const ownerRef = action.ownerRef ?? action.owner ?? action.ownerId;
                return this.dispatch(this.context.createEventContext(eventContext, {
                    frame: action.frame ?? eventContext.frame,
                    eventType: action.eventType ?? action.name
                        ?? (action.spellBurstType ? 'SpellBurstTriggered' : null),
                    sourceId: sourceRef === undefined
                        ? eventContext.sourceId
                        : this.#optionalEntityId(sourceRef, eventContext),
                    ownerId: ownerRef === undefined
                        ? eventContext.ownerId
                        : this.#optionalEntityId(ownerRef, eventContext),
                    targetId: targetRef === undefined
                        ? eventContext.targetId
                        : this.#optionalEntityId(targetRef, eventContext),
                    skillId: action.skillId ?? eventContext.skillId,
                    rootSkillId: action.rootSkillId ?? eventContext.rootSkillId,
                    castId: action.castId ?? eventContext.castId,
                    clockDomainId: action.clockDomainId ?? eventContext.clockDomainId,
                    blackboard: action.blackboard ?? {},
                    payload: {
                        ...(action.payload ?? {}),
                        ...(action.spellBurstType ? { spellBurstType: action.spellBurstType } : {})
                    }
                }));
            }
        };
    }

    #onReaction(payload) {
        const context = this.context.createEventContext(payload.context ?? payload, {
            frame: payload.frame,
            eventType: 'ReactionTriggered',
            targetId: payload.targetId,
            clockDomainId: payload.clockDomainId,
            payload: {
                reactionId: payload.reactionId,
                element: payload.element,
                igniteType: payload.igniteType ?? null,
                consumed: payload.consumed,
                buildupBefore: payload.before,
                buildupAfter: payload.after
            }
        });
        const dispatched = this.dispatch(context);
        const listenerEventTypes = [...new Set([
            'ReactionTriggered',
            payload.igniteType,
            ...(payload.reactionEventTypes ?? [])
        ].filter(Boolean))];
        const listenerResults = listenerEventTypes.flatMap(eventType =>
            this.statusEffects.notifyAbilityEvent({
                ...context,
                eventType,
                listenerTargetId: payload.targetId,
                payload: {
                    ...cloneValue(context.payload),
                    reactionEventType: eventType
                }
            })
        );
        const actions = payload.derivedActions ?? payload.onTriggerActions ?? [];
        const actionResults = actions.length === 0 ? [] : this.execute(actions, context);
        return { dispatched, listenerResults, actionResults };
    }

    #notifyOutputBuff(instance, eventContext) {
        if (this.abilityNotifyDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum ability-event depth ${this.maxDerivedDepth} exceeded.`);
        }
        const definition = this.statusEffects.getDefinition(instance.buffId);
        const listenerTargetId = instance.sourceId
            ?? eventContext.sourceId
            ?? eventContext.ownerId;
        this.abilityNotifyDepth += 1;
        try {
            const context = this.context.createEventContext(eventContext, {
                frame: instance.startFrame,
                eventType: 'OnOutputBuff',
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId: instance.targetId,
                buffInstanceId: instance.instanceId,
                blackboard: instance.blackboard,
                payload: {
                    buffId: instance.buffId,
                    buffTagIds: definition.tagIds ?? [],
                    outputBuffTargetId: instance.targetId,
                    listenerTargetId
                }
            });
            const results = this.statusEffects.notifyAbilityEvent({
                ...context,
                listenerTargetId
            });
            this.#record('AbilityEventNotified', context, {
                eventType: 'OnOutputBuff',
                listenerTargetId,
                handled: results.length
            });
            return results;
        } finally {
            this.abilityNotifyDepth -= 1;
        }
    }

    #onAuraTargetEntered(eventContext, instance) {
        const definition = instance.definition ?? {};
        const results = [];
        const targetBuffs = Array.isArray(definition.targetBuffs)
            ? definition.targetBuffs
            : [{
                buffId: definition.targetBuffId ?? definition.buffId,
                blackboard: definition.targetBuffBlackboard ?? {}
            }];
        for (const buff of targetBuffs.filter(entry => entry?.buffId !== undefined
            && entry.buffId !== null)) {
            const applied = this.statusEffects.apply({
                ...eventContext,
                buffId: buff.buffId,
                stackingKey: `aura:${instance.instanceId}:${String(buff.buffId)}`,
                stackingPolicy: 'Refresh',
                stackingScope: 'Source',
                durationTicks: null,
                blackboard: cloneValue(buff.blackboard ?? {}),
                metadata: {
                    ...cloneValue(definition.sourceMetadata ?? {}),
                    auraId: instance.auraId,
                    auraInstanceId: instance.instanceId
                }
            }, eventContext);
            results.push(applied);
            this.#notifyOutputBuff(applied, eventContext);
        }
        if (Array.isArray(definition.onApplyTargetActions)) {
            results.push(this.execute(definition.onApplyTargetActions, eventContext));
        }
        return results;
    }

    #onAuraTargetLeft(eventContext, instance) {
        const definition = instance.definition ?? {};
        const results = [];
        const targetBuffs = Array.isArray(definition.targetBuffs)
            ? definition.targetBuffs
            : [{ buffId: definition.targetBuffId ?? definition.buffId }];
        for (const buff of targetBuffs.filter(entry => entry?.buffId !== undefined
            && entry.buffId !== null)) {
            results.push(this.statusEffects.finish({
                frame: eventContext.frame,
                buffId: buff.buffId,
                targetId: eventContext.targetId,
                sourceId: instance.sourceId,
                stackingKey: `aura:${instance.instanceId}:${String(buff.buffId)}`,
                reason: eventContext.reason ?? 'AuraTargetLeft'
            }, eventContext));
        }
        if (Array.isArray(definition.onRemoveTargetActions)) {
            results.push(this.execute(definition.onRemoveTargetActions, eventContext));
        }
        return results;
    }

    #onAuraFinished(eventContext, instance) {
        const definition = instance.definition ?? {};
        if (!Array.isArray(definition.onFinishActions)) return [];
        const context = this.context.createEventContext(eventContext, {
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            targetId: null
        });
        return this.execute(definition.onFinishActions, context);
    }
}

export default CombatRuntime;
