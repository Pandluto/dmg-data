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
import { SkillFormStateRegistry } from './skill-form-state-registry.mjs';
import { EnemyMechanicResolver } from './combat-status-resolver.mjs';

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

function applyLoadoutPatch(currentValue, patchValue, operationCode) {
    const current = Number(currentValue);
    const value = Number(patchValue);
    if (!Number.isFinite(value)) return cloneValue(patchValue);
    if (Number(operationCode) === 1) {
        return (Number.isFinite(current) ? current : 0) + value;
    }
    if (Number(operationCode) === 2) {
        return (Number.isFinite(current) ? current : 0) * value;
    }
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
        skillInterruptResolver = null,
        onStatusTransition = null,
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
        if (skillInterruptResolver !== null && typeof skillInterruptResolver !== 'function') {
            throw new TypeError('skillInterruptResolver must be a function or null.');
        }
        if (onStatusTransition !== null && typeof onStatusTransition !== 'function') {
            throw new TypeError('onStatusTransition must be a function or null.');
        }
        this.damageResolver = damageResolver;
        this.skillProgramResolver = skillProgramResolver;
        this.timeDilationResolver = timeDilationResolver;
        this.skillInterruptResolver = skillInterruptResolver;
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
        this.nextIntervalSequence = 1;
        this.nextAbilityEntitySequence = 1;
        this.nextDamageHitSequence = 1;
        this.programExecutions = new Map();
        this.entityBlackboards = new Map();
        this.skillLoadoutPatchSources = new Map();
        this.skillLoadoutPatchRevision = 0;
        this.timedMarkers = new Map();
        this.timeDilationSampleGenerations = new Map();
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
            ),
            // EffectRuntime is initialized later in the constructor, but this
            // callback is only invoked when a hit is resolved.
            evaluateCondition: (condition, eventContext) =>
                this.effects?.evaluate(condition, eventContext) ?? false
        });
        this.skillForms = new SkillFormStateRegistry({
            targetValidator: targetId => this.context.hasEntity(targetId)
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
            onTransition: transition => onStatusTransition?.(transition),
            executeActions: (actions, eventContext) => this.effects.executeTransaction(
                actions,
                {
                    ...cloneValue(eventContext),
                    blackboard: this.#runtimeBlackboard(
                        eventContext.sourceId,
                        eventContext.blackboard
                    )
                }
            )
        });
        this.enemyMechanics = new EnemyMechanicResolver({
            statusEffects: this.statusEffects,
            executeTransaction: (actions, eventContext) =>
                this.effects.executeTransaction(actions, eventContext),
            getEffectTrace: () => this.effects?.trace ?? []
        });
        // Backward-compatible alias for callers that still inspect the older
        // physical-only service name.
        this.combatStatuses = this.enemyMechanics;
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
        if (definition.attributeComponents !== undefined) {
            this.effectSources.registerAttributeComponents(
                entity.id,
                definition.attributeComponents
            );
        }
        this.entityBlackboards.set(entity.id, cloneValue(definition.blackboard ?? {}));
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

    installSkillLoadoutPatches({
        sourceKey,
        ownerId,
        blackboardPatches = [],
        parameterPatches = []
    } = {}) {
        identifier(sourceKey, 'skill loadout patch sourceKey');
        identifier(ownerId, 'skill loadout patch ownerId');
        if (!Array.isArray(blackboardPatches) || !Array.isArray(parameterPatches)) {
            throw new TypeError('Skill loadout patches must be arrays.');
        }
        if (this.skillLoadoutPatchSources.has(sourceKey)) {
            throw new Error(`Skill loadout patches are already installed: ${sourceKey}.`);
        }
        const source = {
            sourceKey,
            ownerId,
            blackboardPatches: cloneValue(blackboardPatches),
            parameterPatches: cloneValue(parameterPatches)
        };
        this.skillLoadoutPatchSources.set(sourceKey, source);
        this.skillLoadoutPatchRevision += 1;
        return cloneValue(source);
    }

    removeSkillLoadoutPatches(sourceKey) {
        identifier(sourceKey, 'skill loadout patch sourceKey');
        const source = this.skillLoadoutPatchSources.get(sourceKey);
        if (!source) return null;
        this.skillLoadoutPatchSources.delete(sourceKey);
        this.skillLoadoutPatchRevision += 1;
        return cloneValue(source);
    }

    resolveSkillProgram(program, { ownerId, skillId = program?.skillId } = {}) {
        if (!isRecord(program)) throw new TypeError('resolveSkillProgram requires a program.');
        identifier(skillId, 'skill loadout patch skillId');
        if (ownerId === undefined || ownerId === null) {
            return {
                ...cloneValue(program),
                loadoutPatches: [],
                loadoutPatchResolution: null
            };
        }
        identifier(ownerId, 'skill loadout patch ownerId');
        if (program.loadoutPatchResolution?.ownerId === ownerId
            && program.loadoutPatchResolution?.skillId === skillId
            && program.loadoutPatchResolution?.revision === this.skillLoadoutPatchRevision) {
            return cloneValue(program);
        }
        const resolved = cloneValue(program);
        resolved.blackboard = cloneValue(resolved.blackboard ?? {});
        const applied = [];
        for (const source of this.skillLoadoutPatchSources.values()) {
            if (source.ownerId !== ownerId) continue;
            for (const patch of source.blackboardPatches) {
                if (patch.skillId !== skillId) continue;
                const before = cloneValue(resolved.blackboard[patch.key]);
                resolved.blackboard[patch.key] = applyLoadoutPatch(
                    before,
                    patch.value,
                    patch.operationCode
                );
                applied.push({
                    sourceKey: source.sourceKey,
                    kind: 'Blackboard',
                    skillId,
                    key: patch.key,
                    before,
                    after: cloneValue(resolved.blackboard[patch.key]),
                    operationCode: patch.operationCode
                });
            }
            for (const patch of source.parameterPatches) {
                if (patch.skillId !== skillId) continue;
                const parameterTypeCode = Number(patch.parameterTypeCode);
                const field = parameterTypeCode === 1
                    ? 'costValue'
                    : parameterTypeCode === 2
                        ? 'cooldownSeconds'
                        : null;
                if (!field) continue;
                const before = cloneValue(resolved[field]);
                resolved[field] = applyLoadoutPatch(
                    before,
                    patch.value,
                    patch.operationCode
                );
                if (field === 'cooldownSeconds') {
                    resolved.cooldownTicks = Math.max(
                        0,
                        Math.round(Number(resolved.cooldownSeconds) * this.tickRate)
                    );
                }
                applied.push({
                    sourceKey: source.sourceKey,
                    kind: 'Parameter',
                    skillId,
                    parameterTypeCode,
                    field,
                    before,
                    after: cloneValue(resolved[field]),
                    operationCode: patch.operationCode
                });
            }
        }
        resolved.loadoutPatches = applied;
        resolved.loadoutPatchResolution = {
            ownerId,
            skillId,
            revision: this.skillLoadoutPatchRevision
        };
        return resolved;
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

    beginSkillActionLifetimes(input, eventContext = {}) {
        if (!isRecord(input)) {
            throw new TypeError('beginSkillActionLifetimes requires an input object.');
        }
        return this.statusEffects.beginSkillTransition({
            frame: input.frame ?? eventContext.frame ?? this.currentFrame,
            actorId: input.actorId ?? eventContext.sourceId,
            skillId: input.skillId ?? eventContext.skillId,
            castId: input.castId ?? eventContext.castId,
            programExecutionId: input.programExecutionId
                ?? eventContext.programExecutionId,
            reason: input.reason ?? 'SkillStarted'
        }, eventContext);
    }

    finishSkillActionLifetimes(input, eventContext = {}) {
        if (!isRecord(input)) {
            throw new TypeError('finishSkillActionLifetimes requires an input object.');
        }
        return this.statusEffects.endSkillTransition({
            frame: input.frame ?? eventContext.frame ?? this.currentFrame,
            actorId: input.actorId ?? eventContext.sourceId,
            skillId: input.skillId ?? eventContext.skillId,
            castId: input.castId ?? eventContext.castId,
            reason: input.reason ?? 'SkillEnded'
        }, eventContext);
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
        const resolveSkillActionLifetimes =
            contextInput.resolveSkillActionLifetimes !== false
            && contextInput.skillActionLifetimesResolved !== true;
        delete contextInput.resolveSkillActionLifetimes;
        delete contextInput.skillActionLifetimesResolved;
        const frame = nonNegativeInteger(contextInput.frame ?? this.currentFrame, 'program frame');
        const sequence = this.nextProgramSequence++;
        const skillId = contextInput.skillId ?? program.skillId ?? `program:${sequence}`;
        const castId = contextInput.castId ?? `cast:${skillId}:${sequence}`;
        const executionId = `program-execution:${sequence}`;
        const resolvedProgram = this.resolveSkillProgram(program, {
            ownerId: contextInput.ownerId ?? contextInput.sourceId,
            skillId
        });
        const context = this.context.createEventContext({
            ...cloneValue(contextInput),
            frame,
            eventType: contextInput.eventType ?? 'SkillProgramStarted',
            skillId,
            rootSkillId: contextInput.rootSkillId ?? skillId,
            castId,
            blackboard: {
                ...cloneValue(resolvedProgram.blackboard ?? {}),
                ...this.#entityBlackboardValues(contextInput.sourceId),
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
            program: cloneValue(resolvedProgram),
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
        if (resolveSkillActionLifetimes && context.sourceId !== null) {
            this.beginSkillActionLifetimes({
                frame,
                actorId: context.sourceId,
                skillId,
                castId,
                programExecutionId: executionId,
                reason: 'SkillProgramStarted'
            }, context);
        }
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
                        blackboard: this.#runtimeBlackboard(
                            context.sourceId,
                            this.programExecutions.get(executionId)?.blackboard
                                ?? context.blackboard
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
                    // UltimateTimeAction's recovery lock is end-exclusive in
                    // Calc: the ATB tick on the cleanup frame is already
                    // allowed. Resume that specific shared-resource lock just
                    // before passive recovery (priority 2); ordinary Buff and
                    // status cleanup keeps the later cleanup priority.
                    const cleanupPriority = (group.cleanupActions ?? []).some(action =>
                        action.type === 'ResumeResourceRecovery') ? 1 : 60;
                    schedulePhase(group, 'cleanup', cleanupOffset, cleanupPriority,
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

    scheduleIntervalActions(action, eventContext = {}) {
        if (!isRecord(action) || !Array.isArray(action.actions)) {
            throw new TypeError('scheduleIntervalActions requires an action with an actions array.');
        }
        const context = eventContext;
        const durationTicks = nonNegativeInteger(
            action.durationTicks ?? 0,
            'interval durationTicks'
        );
        const resolvedIntervalTicks = action.intervalTicks === null
            || action.intervalTicks === undefined
            ? Math.round(this.#number(
                action.intervalSeconds,
                context,
                'interval seconds'
            ) * this.tickRate)
            : nonNegativeInteger(action.intervalTicks, 'interval ticks');
        if (resolvedIntervalTicks < 1) {
            throw new RangeError('Interval actions require at least one tick between executions.');
        }
        const includeStart = action.includeStart !== false;
        const firstOffset = includeStart ? 0 : resolvedIntervalTicks;
        const maxExecutions = action.maxExecutions === null
            || action.maxExecutions === undefined
            ? Number.POSITIVE_INFINITY
            : nonNegativeInteger(action.maxExecutions, 'interval maxExecutions');
        const offsets = [];
        for (let offset = firstOffset;
            durationTicks === 0 ? offset === 0 : offset < durationTicks;
            offset += resolvedIntervalTicks) {
            if (offsets.length >= maxExecutions) break;
            offsets.push(offset);
            if (durationTicks === 0) break;
        }
        const execution = context.programExecutionId === undefined
            ? null
            : this.programExecutions.get(context.programExecutionId) ?? null;
        const generation = execution?.generation ?? 0;
        const intervalSequence = this.nextIntervalSequence++;
        const domainId = context.clockDomainId ?? execution?.clockDomainId ?? 'global';
        let detachedBlackboard = cloneValue(context.blackboard ?? {});
        const executeTick = (completionFrame, tickIndex, timelineFrame) => {
            if (execution && (!execution.active || execution.generation !== generation)) {
                return null;
            }
            const blackboard = this.#runtimeBlackboard(
                context.sourceId,
                execution ? execution.blackboard : detachedBlackboard
            );
            const transaction = this.effects.executeTransaction(action.actions, {
                ...cloneValue(context),
                frame: completionFrame,
                eventType: 'SkillTimelineIntervalTick',
                timelineFrame,
                intervalTickIndex: tickIndex,
                blackboard
            });
            if (execution) execution.blackboard = cloneValue(transaction.eventContext.blackboard);
            else detachedBlackboard = cloneValue(transaction.eventContext.blackboard);
            // The first tick runs inside the timeline group's live transaction;
            // keep its Blackboard writes visible to following group actions.
            if (completionFrame === context.frame && tickIndex === 0) {
                context.blackboard = cloneValue(transaction.eventContext.blackboard);
            }
            this.#record('SkillProgramIntervalTickExecuted', {
                ...cloneValue(context),
                frame: completionFrame
            }, {
                programExecutionId: context.programExecutionId ?? null,
                tickIndex,
                timelineFrame,
                actionCount: action.actions.length
            });
            return transaction;
        };

        offsets.forEach((offset, tickIndex) => {
            const timelineFrame = Number(action.timelineStartFrame ?? context.timelineFrame ?? 0)
                + offset;
            if (offset === 0) {
                executeTick(context.frame ?? this.currentFrame, tickIndex, timelineFrame);
                return;
            }
            const timerId = `interval:${intervalSequence}:generation:${generation}:tick:${tickIndex}`;
            const scheduledPhase = {
                timerId,
                groupIndex: null,
                phase: 'interval',
                offset: timelineFrame,
                actionCount: action.actions.length,
                generation
            };
            this.clockDomains.startTimer(domainId, {
                id: timerId,
                frame: nonNegativeInteger(context.frame ?? this.currentFrame, 'interval start frame'),
                durationTicks: offset,
                priority: 1,
                sourceId: context.sourceId,
                ownerId: context.ownerId,
                targetId: context.targetId,
                skillId: context.skillId,
                rootSkillId: context.rootSkillId,
                ruleId: context.ruleId,
                reason: action.reason ?? 'ScheduleIntervalActions',
                label: `${String(context.skillId ?? 'interval')}:${timelineFrame}`,
                onComplete: completionFrame => executeTick(
                    completionFrame,
                    tickIndex,
                    timelineFrame
                )
            });
            execution?.scheduled.push(scheduledPhase);
        });

        return {
            status: 'Scheduled',
            intervalTicks: resolvedIntervalTicks,
            durationTicks,
            includeStart,
            maxExecutions: Number.isFinite(maxExecutions) ? maxExecutions : null,
            tickCount: offsets.length,
            tickOffsets: offsets
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
        this.resources.resumeRecoveryByCastId(
            execution.castId,
            cancelFrame,
            `ProgramCancelled:${reason}`
        );
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
            skillForms: this.skillForms.snapshot(),
            auras: this.auras.snapshot(),
            reactions: this.reactions.snapshot(),
            resilience: this.resilience.snapshot(),
            entityBlackboards: Object.fromEntries([...this.entityBlackboards.entries()]
                .map(([entityId, blackboard]) => [entityId, cloneValue(blackboard)])),
            skillLoadoutPatchSources: [...this.skillLoadoutPatchSources.values()]
                .map(source => cloneValue(source)),
            timedMarkers: [...this.timedMarkers.values()].map(marker => ({
                ...cloneValue(marker),
                active: this.#timedMarkerActive(marker, this.currentFrame)
            })),
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
        if (isRecord(ref) && ref.type === 'TargetGroup') {
            const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
            if (!Object.prototype.hasOwnProperty.call(groups, ref.key) && ref.fallback) {
                return this.context.resolveEntityRef(ref.fallback, eventContext).id;
            }
            const candidates = Array.isArray(groups[ref.key]) ? groups[ref.key] : [];
            const active = candidates.filter(entityId => this.context.hasEntity(entityId)
                && !this.context.hasTag(entityId, 'ake-ability-entity-inactive'));
            const index = Math.max(0, Math.trunc(Number(ref.index ?? 0)));
            const entityId = active[index];
            if (entityId === undefined) {
                if (ref.fallback) {
                    return this.context.resolveEntityRef(ref.fallback, eventContext).id;
                }
                throw new Error(`Target group ${String(ref.key)} has no entity at index ${index}.`);
            }
            return entityId;
        }
        return this.context.resolveEntityRef(ref ?? fallback, eventContext).id;
    }

    #entityBlackboardValues(entityId) {
        if (entityId === null || entityId === undefined) return {};
        return cloneValue(this.entityBlackboards.get(entityId) ?? {});
    }

    #runtimeBlackboard(entityId, blackboard = {}) {
        const current = cloneValue(blackboard ?? {});
        for (const [key, value] of Object.entries(this.#entityBlackboardValues(entityId))) {
            if (key.startsWith('EntityBB_')) current[key] = cloneValue(value);
        }
        return current;
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
            const eventValue = eventContext.blackboard?.[descriptor.blackboardKey];
            if (eventValue !== undefined) return eventValue;
            const entityValue = this.entityBlackboards.get(eventContext.sourceId)
                ?.[descriptor.blackboardKey];
            return entityValue ?? descriptor.value ?? fallback;
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
            const value = Object.prototype.hasOwnProperty.call(assignment, 'value')
                ? this.#value(assignment.value, eventContext)
                : assignment.direct
                    ? assignment.directValue
                    : eventContext.blackboard?.[assignment.sourceKey]
                        ?? this.entityBlackboards.get(eventContext.sourceId)
                            ?.[assignment.sourceKey];
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
        if (!isRecord(selector)) return [];
        const source = eventContext.sourceId === null
            ? null
            : this.context.getEntity(eventContext.sourceId);
        const queryTags = (selector.tagIds ?? []).map(tagId => `ake-tag:${String(tagId)}`);
        const matches = entity => {
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
        };
        if (selector.mode === 'Global') {
            return this.context.listEntities(matches).map(entity => entity.id);
        }
        if (selector.mode === 'ContextTarget') {
            if (eventContext.targetId === null || eventContext.targetId === undefined
                || !this.context.hasEntity(eventContext.targetId)) return [];
            const target = this.context.getEntity(eventContext.targetId);
            return matches(target) ? [target.id] : [];
        }
        return [];
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

    #resourceRecipientOwnerIds(action, eventContext) {
        if (action.resourceRecipients !== 'AlliedCharacters') return null;
        const sourceId = eventContext.sourceId;
        if (sourceId === null || sourceId === undefined) return [];
        const source = this.context.getEntity(sourceId);
        return this.context.listEntities(entity => entity.kind === 'Character'
            && entity.team === source.team)
            .map(entity => entity.id)
            .filter(ownerId => {
                try {
                    this.resources.describePool({
                        resourceType: action.resourceType ?? action.costType,
                        scope: 'Entity',
                        ownerId
                    });
                    return true;
                } catch {
                    return false;
                }
            });
    }

    #sourceIsMainCharacter(eventContext) {
        const sourceId = eventContext.sourceId;
        if (sourceId === null || sourceId === undefined) return false;
        if (eventContext.mainCharacterId !== undefined
            && eventContext.mainCharacterId !== null) {
            return eventContext.mainCharacterId === sourceId;
        }
        return Boolean(this.context.getEntity(sourceId).metadata?.isMainCharacter);
    }

    #resourceGainScalar(resourceType, ownerId, ignoreGainScalar) {
        if (resourceType !== 'UltimateSp' || ignoreGainScalar) return 1;
        const value = Number(this.context.getAttribute(ownerId, 'UltimateSpGainScalar'));
        return Number.isFinite(value) ? value : 1;
    }

    #resourceActionToken(action, eventContext) {
        const base = action.sourceKey ?? action.token ?? eventContext.castId;
        if (action.sourceKey === undefined) return base;
        const scope = eventContext.buffInstanceId
            ?? eventContext.castId
            ?? eventContext.ruleId
            ?? eventContext.sourceId;
        return scope === null || scope === undefined
            ? base
            : `${String(base)}@${String(scope)}`;
    }

    #actionLifetimeLeaseId(lifetime, eventContext) {
        if (!isRecord(lifetime)
            || typeof lifetime.leaseKey !== 'string'
            || lifetime.leaseKey.length === 0) return null;
        const owner = eventContext.programExecutionId
            ?? eventContext.castId
            ?? eventContext.buffInstanceId
            ?? eventContext.ruleId;
        if (owner === null || owner === undefined) return null;
        return `${lifetime.leaseKey}@${String(owner)}`;
    }

    #skillFormSourceKey(action, eventContext) {
        const base = action.sourceKey
            ?? eventContext.buffInstanceId
            ?? eventContext.castId
            ?? eventContext.ruleId
            ?? eventContext.sourceId;
        if (action.sourceKey === undefined) return base;
        const scope = eventContext.buffInstanceId
            ?? eventContext.castId
            ?? eventContext.ruleId
            ?? eventContext.sourceId;
        return scope === null || scope === undefined
            ? base
            : `${String(base)}@${String(scope)}`;
    }

    #scheduleSkillFormExpiry(kind, action, eventContext, entry) {
        if (String(action.lifeTimeType ?? '') !== 'SpecificTime') return null;
        const seconds = this.#number(
            action.duration ?? action.durationSeconds ?? 0,
            eventContext,
            'skill-form duration'
        );
        const durationTicks = Math.max(0, Math.round(seconds * this.tickRate));
        const domainId = eventContext.clockDomainId ?? 'global';
        const remove = frame => {
            const selector = {
                frame,
                sourceKey: entry.sourceKey,
                targetId: entry.targetId,
                sequence: entry.sequence,
                reason: `${kind}SpecificTimeExpired`
            };
            return kind === 'SkillOverride'
                ? this.skillForms.removeOverride(selector, eventContext)
                : this.skillForms.removeMode(selector, eventContext);
        };
        if (durationTicks === 0) return remove(eventContext.frame ?? 0);
        return this.clockDomains.startTimer(domainId, {
            id: `skill-form:${kind}:${entry.sequence}`,
            frame: eventContext.frame ?? 0,
            durationTicks,
            priority: 89,
            sourceId: eventContext.sourceId,
            ownerId: eventContext.ownerId,
            targetId: entry.targetId,
            skillId: eventContext.skillId,
            rootSkillId: eventContext.rootSkillId,
            reason: `${kind}SpecificTime`,
            label: `${kind}:${String(entry.sourceKey)}`,
            onComplete: remove
        });
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

    #timedMarkerKey(entityId, markerId) {
        return JSON.stringify([entityId, markerId]);
    }

    #timedMarkerActive(marker, frame) {
        if (!marker) return false;
        if (marker.useTimeDilationDt) {
            return this.clockDomains.localFrameAt(marker.clockDomainId, frame)
                < marker.expiresLocalFrame;
        }
        return frame < marker.expiresFrame;
    }

    #defaultHandlers() {
        return {
            BitMaskCompare: (condition, eventContext) => {
                const value = Math.trunc(Number(this.#value(
                    condition.value ?? condition.left ?? 0,
                    eventContext,
                    0
                ))) >>> 0;
                const mask = Math.trunc(Number(this.#value(
                    condition.mask ?? condition.right ?? 0,
                    eventContext,
                    0
                ))) >>> 0;
                const overlap = (value & mask) >>> 0;
                switch (String(condition.checkType ?? 'HasAll')) {
                    case 'HasAll': return overlap === mask;
                    case 'HasAny': return overlap !== 0;
                    case 'ExceptAny': return overlap === 0;
                    default: return false;
                }
            },
            TargetsEqual: (condition, eventContext) => {
                const eventTargetId = eventContext.payload?.eventTargetId;
                const resolve = (ref, useEventTarget) => useEventTarget
                    && eventTargetId !== null && eventTargetId !== undefined
                    ? eventTargetId
                    : this.#entityId(ref, eventContext);
                return resolve(condition.first, condition.firstUsesEventTarget)
                    === resolve(condition.second, condition.secondUsesEventTarget);
            },
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
            TimedMarkerExists: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Owner'
                );
                const markerId = identifier(
                    this.#value(condition.markerId ?? condition.id, eventContext),
                    'timed marker id'
                );
                const key = this.#timedMarkerKey(targetId, markerId);
                const marker = this.timedMarkers.get(key);
                const exists = this.#timedMarkerActive(marker, eventContext.frame);
                if (marker && !exists) this.timedMarkers.delete(key);
                return condition.returnTrueIfNotExists ? !exists : exists;
            },
            EntityAlive: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const alive = !this.vitals.hasEntity(targetId)
                    || this.vitals.get(targetId, eventContext.frame).alive;
                return alive === (condition.expected !== false);
            },
            BuffStackCompare: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.entity ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const buffIds = Array.isArray(condition.buffIds)
                    ? condition.buffIds
                    : condition.buffId === undefined
                        ? []
                        : [condition.buffId];
                const requestedTagIds = Array.isArray(condition.tagIds)
                    ? condition.tagIds
                    : [];
                const tagQueryType = condition.tagQueryType ?? 'HasAny';
                const instances = this.statusEffects.list({
                    active: true,
                    targetId
                }).filter(instance => buffIds.length === 0 || buffIds.includes(instance.buffId))
                    .filter(instance => {
                        if (requestedTagIds.length === 0) return true;
                        const definitionTags = new Set(
                            this.statusEffects.getDefinition(instance.buffId)?.tagIds ?? []
                        );
                        const matches = requestedTagIds.map(tagId => definitionTags.has(tagId));
                        if (tagQueryType === 'HasAll') return matches.every(Boolean);
                        if (tagQueryType === 'HasNone') return matches.every(match => !match);
                        return matches.some(Boolean);
                    });
                const stackCount = condition.countType === 'BuffIdCount'
                    ? new Set(instances.map(instance => instance.buffId)).size
                    : instances.reduce((sum, instance) => sum + instance.stackCount, 0);
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount,
                    eventContext,
                    'Buff stack comparison value'
                );
                return compare(stackCount, condition.operator, expected);
            },
            ResourceCompare: (condition, eventContext) => {
                const pool = this.resources.describePool(this.#poolRef(condition, eventContext));
                const value = condition.ratio
                    ? (pool.max === 0 ? 0 : pool.current / pool.max)
                    : pool.current;
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
                if (eventContext.mainCharacterId !== undefined
                    && eventContext.mainCharacterId !== null) {
                    return targetId === eventContext.mainCharacterId;
                }
                const entity = this.context.getEntity(targetId);
                return entity.metadata?.isMainCharacter === true;
            },
            SquadInFight: (_condition, eventContext) => {
                const sourceId = eventContext.sourceId ?? eventContext.ownerId;
                if (sourceId === null || sourceId === undefined
                    || !this.context.hasEntity(sourceId)) return false;
                const source = this.context.getEntity(sourceId);
                if (source.kind !== 'Character') return false;
                return this.context.listEntities(entity =>
                    entity.team !== null
                    && source.team !== null
                    && entity.team !== source.team
                    && (!this.vitals.hasEntity(entity.id)
                        || this.vitals.get(entity.id, eventContext.frame).alive)
                ).length > 0;
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
                const passed = compare(count, condition.operator ?? 'GE', expected);
                return condition.storeKey
                    ? { passed, blackboardWrites: { [condition.storeKey]: count } }
                    : passed;
            },
            TargetGroupCountCompare: (condition, eventContext) => {
                const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
                const candidates = Object.prototype.hasOwnProperty.call(
                    groups,
                    condition.targetGroupKey
                )
                    ? (Array.isArray(groups[condition.targetGroupKey])
                        ? groups[condition.targetGroupKey]
                        : [])
                    : (eventContext.targetId === null || eventContext.targetId === undefined
                        ? []
                        : [eventContext.targetId]);
                const active = candidates.filter(entityId => {
                    if (!this.context.hasEntity(entityId)
                        || this.context.hasTag(entityId, 'ake-ability-entity-inactive')) {
                        return false;
                    }
                    return !(condition.excludeDeadEntity
                        && this.vitals.hasEntity(entityId)
                        && !this.vitals.get(entityId, eventContext.frame).alive);
                });
                const expected = this.#number(
                    condition.right ?? condition.value ?? condition.amount ?? 1,
                    eventContext,
                    'target-group count comparison value'
                );
                const passed = compare(active.length, condition.operator ?? 'GE', expected);
                return {
                    passed,
                    ...(condition.storeKey
                        ? { blackboardWrites: { [condition.storeKey]: active.length } }
                        : {})
                };
            },
            CreateTimedMarker: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.entity ?? action.target ?? action.targetId,
                    eventContext,
                    'Owner'
                );
                const markerId = identifier(
                    this.#value(action.markerId ?? action.id, eventContext),
                    'timed marker id'
                );
                const durationSeconds = Math.max(0, this.#number(
                    action.durationSeconds ?? action.duration ?? 0,
                    eventContext,
                    'timed marker duration'
                ));
                const durationTicks = Math.max(0, Math.round(durationSeconds * this.tickRate));
                const clockDomainId = action.clockDomainId
                    ?? eventContext.clockDomainId
                    ?? this.#entityClockDomainId(targetId);
                const useTimeDilationDt = Boolean(action.useTimeDilationDt);
                const createdLocalFrame = useTimeDilationDt
                    ? this.clockDomains.localFrameAt(clockDomainId, eventContext.frame)
                    : null;
                const marker = {
                    key: this.#timedMarkerKey(targetId, markerId),
                    targetId,
                    markerId,
                    sourceId: eventContext.sourceId,
                    ownerId: eventContext.ownerId,
                    createdFrame: eventContext.frame,
                    expiresFrame: useTimeDilationDt
                        ? null
                        : eventContext.frame + durationTicks,
                    createdLocalFrame,
                    expiresLocalFrame: useTimeDilationDt
                        ? createdLocalFrame + durationTicks
                        : null,
                    durationSeconds,
                    durationTicks,
                    useTimeDilationDt,
                    clockDomainId
                };
                const before = cloneValue(this.timedMarkers.get(marker.key) ?? null);
                this.timedMarkers.set(marker.key, marker);
                return {
                    status: before ? 'Refreshed' : 'Created',
                    before,
                    requested: durationTicks,
                    actual: cloneValue(marker),
                    discarded: 0,
                    after: cloneValue(marker)
                };
            },
            ReadBuffBlackboardCondition: (condition, eventContext) => {
                const targetId = this.#entityId(
                    condition.targetRef ?? condition.target ?? condition.targetId,
                    eventContext,
                    'Target'
                );
                const buffIds = Array.isArray(condition.buffIds) ? condition.buffIds : [];
                const requestedTagIds = Array.isArray(condition.tagIds)
                    ? condition.tagIds
                    : [];
                const matches = this.statusEffects.list({ active: true, targetId })
                    .filter(instance => buffIds.length === 0
                        || buffIds.includes(instance.buffId))
                    .filter(instance => {
                        if (requestedTagIds.length === 0) return true;
                        const definitionTags = new Set(
                            this.statusEffects.getDefinition(instance.buffId)?.tagIds ?? []
                        );
                        const flags = requestedTagIds.map(tagId => definitionTags.has(tagId));
                        if (condition.tagQueryType === 'HasAll') return flags.every(Boolean);
                        if (condition.tagQueryType === 'HasNone') {
                            return flags.every(flag => !flag);
                        }
                        return flags.some(Boolean);
                    });
                const selected = matches.at(-1) ?? null;
                if (!selected) return { passed: false, targetId };
                return {
                    passed: true,
                    targetId,
                    instanceId: selected.instanceId,
                    buffId: selected.buffId,
                    blackboardWrites: {
                        [condition.blackboardKey]: cloneValue(
                            selected.blackboard?.[condition.desiredKey]
                                ?? condition.defaultValue
                                ?? 0
                        )
                    }
                };
            },
            DistanceCompare: (condition, eventContext) => {
                const sourceId = this.#entityId(
                    condition.source ?? condition.sourceRef,
                    eventContext,
                    'Source'
                );
                const targetId = this.#entityId(
                    condition.target ?? condition.targetRef,
                    eventContext,
                    'Target'
                );
                const source = this.context.getEntity(sourceId);
                const target = this.context.getEntity(targetId);
                const position = entity => {
                    const candidate = entity.metadata?.position;
                    if (!candidate || !['x', 'y', 'z'].every(axis =>
                        Number.isFinite(Number(candidate[axis] ?? 0)))) return null;
                    return {
                        x: Number(candidate.x ?? 0),
                        y: Number(candidate.y ?? 0),
                        z: Number(candidate.z ?? 0)
                    };
                };
                const sourcePosition = position(source);
                const targetPosition = position(target);
                let distance = Number(condition.fallbackDistance ?? 0);
                let usedFallback = true;
                if (sourcePosition && targetPosition) {
                    distance = Math.hypot(
                        sourcePosition.x - targetPosition.x,
                        sourcePosition.y - targetPosition.y,
                        sourcePosition.z - targetPosition.z
                    );
                    usedFallback = false;
                }
                if (condition.includeTargetRadius) {
                    distance = Math.max(0, distance - Number(target.metadata?.radius ?? 0));
                }
                return {
                    passed: compare(
                        distance,
                        condition.operator ?? 'LT',
                        Number(condition.distance ?? 0)
                    ),
                    distance,
                    usedFallback,
                    sourceId,
                    targetId
                };
            },
            FindTargets: (action, eventContext) => {
                const sourceId = eventContext.sourceId ?? eventContext.ownerId;
                const source = sourceId !== null && sourceId !== undefined
                    ? this.context.getEntity(sourceId)
                    : null;
                const ownerId = this.#entityId(
                    action.ownerRef ?? 'Source',
                    eventContext,
                    'Source'
                );
                const active = entity => !entity.tags.includes('ake-ability-entity-inactive')
                    && (!this.vitals.hasEntity(entity.id)
                        || this.vitals.get(entity.id, eventContext.frame).alive);
                let candidates;
                switch (action.finderMode) {
                    case 'OwnerSpawnedEntities':
                        candidates = this.context.listEntities(entity =>
                            ['Object', 'Summon'].includes(entity.kind)
                            && entity.ownerId === ownerId
                            && active(entity));
                        break;
                    case 'HostileEntities':
                        candidates = this.context.listEntities(entity =>
                            entity.id !== sourceId
                            && active(entity)
                            && (source?.team === null || source?.team === undefined
                                ? entity.kind === 'Enemy'
                                : entity.team !== null && entity.team !== source.team));
                        break;
                    case 'AlliedCharacters':
                        candidates = this.context.listEntities(entity =>
                            entity.kind === 'Character'
                            && active(entity)
                            && (source?.team === null || source?.team === undefined
                                || entity.team === source.team));
                        break;
                    case 'ReferencePoint':
                        candidates = eventContext.targetId !== null
                            && eventContext.targetId !== undefined
                            ? [this.context.getEntity(eventContext.targetId)]
                            : [];
                        break;
                    default:
                        candidates = [];
                }
                if (action.excludeOwner === true) {
                    candidates = candidates.filter(entity => entity.id !== ownerId);
                }
                const requestedTagIds = action.tagIds ?? [];
                if (requestedTagIds.length > 0) {
                    candidates = candidates.filter(entity => {
                        const knownTags = entity.metadata?.akeTagIds;
                        return !Array.isArray(knownTags)
                            || requestedTagIds.some(tagId => knownTags.includes(tagId));
                    });
                }
                if (!isRecord(eventContext.blackboard.__akeTargetGroups)) {
                    eventContext.blackboard.__akeTargetGroups = {};
                }
                eventContext.blackboard.__akeTargetGroups[action.targetGroupKey] =
                    candidates.map(entity => entity.id);
                return {
                    status: 'Resolved',
                    targetGroupKey: action.targetGroupKey,
                    finderMode: action.finderMode,
                    targetIds: candidates.map(entity => entity.id),
                    requestedTagIds: cloneValue(requestedTagIds),
                    tagResolution: requestedTagIds.length === 0
                        ? 'NotRequested'
                        : 'KnownPrefabTagsWhenAvailable'
                };
            },
            PickTarget: (action, eventContext) => {
                const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
                const candidates = (groups[action.sourceGroupKey] ?? []).filter(entityId =>
                    this.context.hasEntity(entityId)
                    && !this.context.hasTag(entityId, 'ake-ability-entity-inactive'));
                const index = Math.max(0, Math.trunc(this.#number(
                    action.index ?? 0,
                    eventContext,
                    'picked target index'
                )));
                const selected = candidates[index] === undefined ? [] : [candidates[index]];
                if (!isRecord(eventContext.blackboard.__akeTargetGroups)) {
                    eventContext.blackboard.__akeTargetGroups = {};
                }
                eventContext.blackboard.__akeTargetGroups[action.targetGroupKey] = selected;
                return {
                    status: selected.length > 0 ? 'Resolved' : 'Empty',
                    sourceGroupKey: action.sourceGroupKey,
                    targetGroupKey: action.targetGroupKey,
                    index,
                    targetIds: cloneValue(selected)
                };
            },
            ForEachTarget: (action, eventContext) => {
                const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
                const candidates = Object.prototype.hasOwnProperty.call(
                    groups,
                    action.targetGroupKey
                )
                    ? (groups[action.targetGroupKey] ?? [])
                    : (eventContext.targetId === null || eventContext.targetId === undefined
                        ? []
                        : [eventContext.targetId]);
                const results = [];
                for (const targetId of candidates) {
                    if (!this.context.hasEntity(targetId)
                        || this.context.hasTag(targetId, 'ake-ability-entity-inactive')) continue;
                    const transaction = this.effects.executeTransaction(action.actions ?? [], {
                        ...cloneValue(eventContext),
                        targetId,
                        blackboard: cloneValue(eventContext.blackboard)
                    });
                    eventContext.blackboard = cloneValue(transaction.eventContext.blackboard);
                    results.push({ targetId, result: transaction.result });
                }
                return { status: 'Resolved', count: results.length, results };
            },
            ModifyEntityBlackboard: (action, eventContext) => {
                const entityId = this.#entityId(
                    action.target ?? action.targetRef ?? 'Owner',
                    eventContext,
                    'Owner'
                );
                const blackboard = this.entityBlackboards.get(entityId) ?? {};
                const key = identifier(action.key ?? action.blackboardKey, 'entity Blackboard key');
                const before = cloneValue(blackboard[key]);
                const value = this.#value(action.value ?? action.amount ?? 0, eventContext);
                const operation = String(action.operation ?? 'Assign').toLowerCase();
                let after;
                if (['assign', 'set'].includes(operation)) {
                    after = cloneValue(value);
                } else {
                    const left = finite(Number(before ?? 0), `EntityBlackboard.${String(key)}`);
                    const right = finite(Number(value), 'entity Blackboard value');
                    switch (operation) {
                        case 'add': case 'increase': after = left + right; break;
                        case 'subtract': case 'decrease': after = left - right; break;
                        case 'multiply': case 'mul': after = left * right; break;
                        case 'divide': case 'div':
                            if (right === 0) throw new RangeError(
                                'Entity Blackboard divide value must not be zero.'
                            );
                            after = left / right;
                            break;
                        case 'min': after = Math.min(left, right); break;
                        case 'max': after = Math.max(left, right); break;
                        default: throw new Error(
                            `Unsupported entity Blackboard operation: ${operation}`
                        );
                    }
                }
                blackboard[key] = cloneValue(after);
                this.entityBlackboards.set(entityId, blackboard);
                return { entityId, key, operation, before, actual: after, after };
            },
            DeactivateEntity: (action, eventContext) => {
                const targetRef = action.target ?? action.targetRef;
                let entityIds;
                if (isRecord(targetRef) && targetRef.type === 'TargetGroup') {
                    const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
                    const candidates = Array.isArray(groups[targetRef.key])
                        ? groups[targetRef.key]
                        : [];
                    const active = candidates.filter(entityId =>
                        this.context.hasEntity(entityId)
                        && !this.context.hasTag(entityId, 'ake-ability-entity-inactive')
                    );
                    if (targetRef.all === true) entityIds = active;
                    else {
                        const index = Math.max(0, Math.trunc(Number(targetRef.index ?? 0)));
                        entityIds = active[index] === undefined ? [] : [active[index]];
                    }
                    if (entityIds.length === 0 && targetRef.fallback) {
                        entityIds = [this.#entityId(targetRef.fallback, eventContext, 'Target')];
                    }
                } else {
                    entityIds = [this.#entityId(targetRef, eventContext, 'Target')];
                }
                const records = entityIds.map(entityId => {
                    const before = this.context.hasTag(
                        entityId,
                        'ake-ability-entity-inactive'
                    );
                    if (!before) {
                        this.context.addTag(entityId, 'ake-ability-entity-inactive', {
                            ...cloneValue(eventContext),
                            targetId: entityId,
                            reason: action.reason ?? 'DeactivateEntity'
                        });
                    }
                    return { entityId, before, actual: before ? 0 : 1, after: true };
                });
                return {
                    status: 'Resolved',
                    count: records.length,
                    records,
                    ...(records.length === 1 ? records[0] : {})
                };
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
                const buffIds = Array.isArray(action.buffIds)
                    ? action.buffIds
                    : buffId === undefined || buffId === null || buffId === ''
                        ? []
                        : [buffId];
                const requestedTagIds = Array.isArray(action.tagIds) ? action.tagIds : [];
                if (buffIds.length === 0 && requestedTagIds.length === 0) {
                    throw new TypeError(
                        'StoreBuffCount requires buffId, buffIds, tagIds or current Buff context.'
                    );
                }
                const key = identifier(action.key ?? action.blackboardKey, 'StoreBuffCount key');
                const before = cloneValue(eventContext.blackboard[key]);
                const instances = this.statusEffects.list({
                    active: true,
                    targetId
                }).filter(instance => buffIds.length === 0 || buffIds.includes(instance.buffId))
                    .filter(instance => {
                        if (requestedTagIds.length === 0) return true;
                        const definitionTags = new Set(
                            this.statusEffects.getDefinition(instance.buffId)?.tagIds ?? []
                        );
                        const matches = requestedTagIds.map(tagId => definitionTags.has(tagId));
                        if (action.tagQueryType === 'HasAll') return matches.every(Boolean);
                        if (action.tagQueryType === 'HasNone') {
                            return matches.every(match => !match);
                        }
                        return matches.some(Boolean);
                    });
                const count = action.countType === 'BuffIdCount'
                    ? new Set(instances.map(instance => instance.buffId)).size
                    : instances.reduce((sum, instance) => sum + instance.stackCount, 0);
                eventContext.blackboard[key] = count;
                return { before, requested: count, actual: count, discarded: 0, after: count };
            },
            ReadSkillSettingValues: (action, eventContext) => {
                const changes = [];
                for (const entry of action.entries ?? []) {
                    const key = identifier(entry.key, 'SkillSetting destination key');
                    const column = Math.trunc(this.#number(
                        entry.column ?? 1,
                        eventContext,
                        `SkillSetting ${String(entry.lookupKey)} column`,
                        1
                    ));
                    const values = entry.values ?? {};
                    const available = Object.keys(values)
                        .map(Number)
                        .filter(Number.isFinite)
                        .sort((left, right) => left - right);
                    let selectedColumn = column;
                    if (!Object.prototype.hasOwnProperty.call(values, String(selectedColumn))) {
                        if (entry.clamp === false || available.length === 0) {
                            throw new Error(
                                `SkillSetting ${String(entry.lookupKey)} has no column ${column}.`
                            );
                        }
                        selectedColumn = Math.min(
                            available.at(-1),
                            Math.max(available[0], column)
                        );
                    }
                    const before = cloneValue(eventContext.blackboard[key]);
                    const baseValue = cloneValue(values[String(selectedColumn)]);
                    const sourceId = eventContext.sourceId ?? eventContext.ownerId;
                    const level = Math.max(1, Number(
                        sourceId === null || sourceId === undefined
                            ? 1
                            : this.context.getAttribute(sourceId, 'Level') ?? 1
                    ));
                    const skillStrength = Math.max(0, Number(
                        sourceId === null || sourceId === undefined
                            ? 0
                            : this.context.getAttribute(
                                sourceId,
                                'PhysicalAndSpellInflictionEnhance'
                            ) ?? 0
                    ));
                    let after = baseValue;
                    if (Number.isFinite(Number(baseValue))) {
                        const numericBase = Number(baseValue);
                        switch (entry.enhancementMode) {
                            case 'PhysicalAnomalyDamage':
                                after = numericBase
                                    * (1 + (level - 1) / 392)
                                    * (1 + skillStrength / 100);
                                break;
                            case 'SpellAnomalyDamage':
                                after = numericBase
                                    * (1 + (level - 1) / 196)
                                    * (1 + skillStrength / 100);
                                break;
                            case 'PhysicalAnomalyState':
                                after = numericBase * (1 + (
                                    skillStrength > 0
                                        ? 2 * skillStrength / (skillStrength + 300)
                                        : 0
                                ));
                                break;
                            case 'PhysicalAnomalyPoise':
                                after = numericBase * (1 + skillStrength / 200);
                                break;
                            default:
                                after = numericBase;
                        }
                    }
                    eventContext.blackboard[key] = after;
                    changes.push({
                        key,
                        lookupKey: entry.lookupKey,
                        column,
                        selectedColumn,
                        enhancementMode: entry.enhancementMode ?? null,
                        level,
                        skillStrength,
                        baseValue,
                        before,
                        after
                    });
                }
                return {
                    before: Object.fromEntries(changes.map(change => [change.key, change.before])),
                    requested: Object.fromEntries(changes.map(change => [change.key, change.column])),
                    actual: changes.length,
                    discarded: 0,
                    after: Object.fromEntries(changes.map(change => [change.key, change.after])),
                    changes
                };
            },
            ReadBuffBlackboard: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                const buffIds = Array.isArray(action.buffIds) ? action.buffIds : [];
                const requestedTagIds = Array.isArray(action.tagIds) ? action.tagIds : [];
                const matches = this.statusEffects.list({
                    active: true,
                    targetId
                }).filter(instance => buffIds.length === 0 || buffIds.includes(instance.buffId))
                    .filter(instance => {
                        if (requestedTagIds.length === 0) return true;
                        const definitionTags = new Set(
                            this.statusEffects.getDefinition(instance.buffId)?.tagIds ?? []
                        );
                        const flags = requestedTagIds.map(tagId => definitionTags.has(tagId));
                        if (action.tagQueryType === 'HasAll') return flags.every(Boolean);
                        if (action.tagQueryType === 'HasNone') return flags.every(flag => !flag);
                        return flags.some(Boolean);
                    });
                const selected = matches.at(-1) ?? null;
                const key = identifier(action.blackboardKey, 'Buff Blackboard destination key');
                const before = cloneValue(eventContext.blackboard[key]);
                const after = cloneValue(
                    selected?.blackboard?.[action.desiredKey]
                        ?? action.defaultValue
                        ?? 0
                );
                eventContext.blackboard[key] = after;
                return {
                    targetId,
                    instanceId: selected?.instanceId ?? null,
                    buffId: selected?.buffId ?? null,
                    desiredKey: action.desiredKey,
                    key,
                    before,
                    requested: action.desiredKey,
                    actual: after,
                    discarded: selected ? 0 : 1,
                    after
                };
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
                if (action.requireSourceMainCharacter
                    && !this.#sourceIsMainCharacter(eventContext)) {
                    return {
                        stage: 'ResourceChangeSuppressed',
                        success: false,
                        reason: 'SOURCE_IS_NOT_MAIN_CHARACTER',
                        sourceId: eventContext.sourceId,
                        resourceType: action.resourceType ?? action.costType
                    };
                }
                const baseAmount = this.#number(action.amount ?? action.value ?? action.delta,
                    eventContext, 'resource amount');
                const coefficient = this.#number(action.coefficient ?? 1,
                    eventContext, 'resource coefficient', 1);
                const operation = String(action.operation ?? action.changeType ?? action.mode ?? '').toLowerCase();
                const spend = baseAmount * coefficient < 0
                    || ['spend', 'consume', 'cost', 'subtract', 'decrease'].includes(operation);
                const method = spend ? 'spend' : 'gain';
                const resourceType = action.resourceType ?? action.costType;
                const recipients = this.#resourceRecipientOwnerIds(action, eventContext);
                const poolRefs = recipients === null
                    ? [this.#poolRef(action, eventContext)]
                    : recipients.map(ownerId => ({
                        resourceType,
                        scope: 'Entity',
                        ownerId
                    }));
                const results = poolRefs.map(poolRef => {
                    const pool = this.resources.describePool(poolRef);
                    const percentScale = action.percentOfMax ? pool.max : 1;
                    const gainScalar = method === 'gain'
                        ? this.#resourceGainScalar(
                            resourceType,
                            pool.ownerId ?? eventContext.sourceId,
                            action.ignoreGainScalar
                        )
                        : 1;
                    const spendEligibility = action.scaleByAtbSpendEligibility
                        ? this.resources.spendEligibility({
                            castId: action.castId ?? eventContext.castId ?? null,
                            commandId: action.commandId ?? eventContext.commandId ?? null
                        })
                        : null;
                    const amount = Math.abs(baseAmount * coefficient)
                        * percentScale * gainScalar
                        * (spendEligibility?.ratio ?? 1);
                    const resourceChange = this.resources[method]({
                        ...attribution,
                        poolRef,
                        targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                        amount,
                        strict: action.strict,
                        commandId: action.commandId ?? eventContext.commandId ?? null,
                        resourceSourceType: action.resourceSourceType ?? null,
                        resourceGainMethod: action.resourceGainMethod ?? action.operation ?? null,
                        resourceGainTags: action.resourceGainTags ?? []
                    });
                    const abilityEvents = this.#notifyResourceEvent(
                        resourceChange,
                        eventContext
                    );
                    return abilityEvents.length === 0
                        ? resourceChange
                        : { ...resourceChange, abilityEvents };
                });
                return recipients === null ? results[0] : {
                    stage: 'ResourceFanout',
                    resourceType,
                    recipientIds: recipients,
                    results
                };
            },
            SuspendResourceRecovery: (action, eventContext) => this.resources.suspendRecovery({
                ...this.#attribution(action, eventContext, { target: false }),
                poolRef: this.#poolRef(action, eventContext),
                token: this.#resourceActionToken(action, eventContext),
                delayTicks: action.delayTicks ?? 0
            }),
            ResumeResourceRecovery: (action, eventContext) => this.resources.resumeRecovery({
                ...this.#attribution(action, eventContext, { target: false }),
                poolRef: this.#poolRef(action, eventContext),
                token: this.#resourceActionToken(action, eventContext)
            }),
            SuppressResourceGain: (action, eventContext) => this.resources.suppressGain({
                ...this.#attribution(action, eventContext, { target: false }),
                poolRef: this.#poolRef(action, eventContext),
                token: this.#resourceActionToken(action, eventContext),
                tags: action.resourceGainTags ?? action.tags ?? []
            }),
            ResumeResourceGain: (action, eventContext) => this.resources.resumeGain({
                ...this.#attribution(action, eventContext, { target: false }),
                poolRef: this.#poolRef(action, eventContext),
                token: this.#resourceActionToken(action, eventContext)
            }),
            ClearResource: (action, eventContext) => {
                const poolRef = this.#poolRef(action, eventContext);
                const pool = this.resources.describePool(poolRef);
                const record = this.resources.spend({
                    ...this.#attribution(action, eventContext, { target: false }),
                    poolRef,
                    targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                    amount: pool.current,
                    strict: false,
                    resourceSourceType: action.resourceSourceType ?? null,
                    resourceGainMethod: action.resourceGainMethod ?? 'Clear'
                });
                const abilityEvents = this.#notifyResourceEvent(record, eventContext);
                return abilityEvents.length === 0 ? record : { ...record, abilityEvents };
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
                        const buffId = candidate.buffIdBlackboardKey
                            ? eventContext.blackboard?.[candidate.buffIdBlackboardKey]
                                ?? this.entityBlackboards.get(eventContext.sourceId)
                                    ?.[candidate.buffIdBlackboardKey]
                                ?? candidate.buffId
                            : candidate.buffId;
                        if ((typeof buffId !== 'string' && typeof buffId !== 'number')
                            || buffId === '') {
                            results.push({
                                status: 'Unresolved',
                                code: 'DYNAMIC_BUFF_ID_MISSING',
                                buffId: null,
                                blackboardKey: candidate.buffIdBlackboardKey ?? null,
                                targetId: attribution.targetId
                            });
                            continue;
                        }
                        const definition = this.statusEffects.getDefinition(buffId);
                        const candidateBlackboard = {
                            ...(candidate.assignBlackboard
                                ? this.#assignedBlackboard(candidate.assignments, eventContext)
                                : {}),
                            ...cloneValue(candidate.blackboard ?? {})
                        };
                        const reenterStatusBuffIds = new Set(
                            Array.isArray(eventContext.payload?.reenterStatusBuffIds)
                                ? eventContext.payload.reenterStatusBuffIds
                                : []
                        );
                        if (definition !== null) {
                            this.#notifyBeforeOutputBuff(
                                candidate,
                                attribution,
                                candidateBlackboard,
                                eventContext
                            );
                        }
                        let applied = this.statusEffects.apply({
                            ...attribution,
                            // Buff lifetime/timeline scheduling and the domain
                            // used by its child combat actions are independent.
                            actionClockDomainId: action.actionClockDomainId
                                ?? action.clockDomainId
                                ?? this.#entityClockDomainId(
                                    attribution.targetId,
                                    attribution.clockDomainId
                                ),
                            // An explicit action clock wins. AKE BuffData uses
                            // global time unless it explicitly opts into the
                            // affected entity's time-dilated delta time.
                            clockDomainId: action.clockDomainId
                                ?? (definition?.useTimeDilationDt === false
                                    ? 'global'
                                    : this.#entityClockDomainId(
                                        attribution.targetId,
                                        attribution.clockDomainId
                                    )),
                            buffId,
                            sourceSkillId: action.sourceSkillId ?? eventContext.skillId,
                            durationTicks: action.durationTicks,
                            durationSeconds: action.durationSeconds,
                            stackingKey: action.stackingKey,
                            stackingPolicy: action.stackingPolicy
                                ?? (reenterStatusBuffIds.has(candidate.buffId)
                                    ? 'Replace'
                                    : undefined),
                            stackingScope: action.stackingScope,
                            maxStacks: action.maxStacks,
                            stackCount: action.stackCount,
                            inheritEventBlackboard: action.inheritEventBlackboard,
                            triggerEnhancementEvent: action.triggerEnhancementEvent,
                            blackboard: candidateBlackboard,
                            metadata: {
                                ...cloneValue(eventContext.payload?.statusMetadata ?? {}),
                                ...cloneValue(action.metadata ?? {}),
                                ...(action.asChildBuff && eventContext.buffInstanceId
                                    ? { parentBuffInstanceId: eventContext.buffInstanceId }
                                    : {}),
                                ...(action.attachToCurrentSkill && eventContext.castId
                                    ? { attachedToCastId: eventContext.castId }
                                    : {})
                            }
                        }, eventContext);
                        if (applied?.status !== 'Unresolved' && action.actionLifetime) {
                            const leaseId = this.#actionLifetimeLeaseId(
                                action.actionLifetime,
                                eventContext
                            );
                            if (leaseId !== null) {
                                this.statusEffects.claimActionLifetime({
                                    frame: eventContext.frame,
                                    instanceId: applied.instanceId,
                                    leaseId,
                                    actorId: eventContext.sourceId,
                                    ownerSkillId: eventContext.skillId,
                                    ownerCastId: eventContext.castId,
                                    ownerProgramExecutionId:
                                        eventContext.programExecutionId,
                                    inheritSkillIds:
                                        action.actionLifetime.inheritSkillIds,
                                    finishByAction:
                                        action.actionLifetime.finishByAction,
                                    finishWithNextSkillIfNotInherited:
                                        action.actionLifetime
                                            .finishWithNextSkillIfNotInherited,
                                    reason: action.reason ?? 'CreateBuffAction'
                                }, eventContext);
                                applied = this.statusEffects.get(applied.instanceId);
                            }
                        }
                        results.push(applied);
                        if (applied?.status !== 'Unresolved') {
                            this.#notifyAddedBuff(applied, eventContext);
                            this.#notifyOutputBuff(applied, eventContext);
                        }
                    }
                }
                return Array.isArray(action.buffs) || count !== 1 ? results : results[0];
            },
            InheritBuffActionLifetime: (action, eventContext) => {
                const leaseId = this.#actionLifetimeLeaseId(action, eventContext);
                if (leaseId === null) {
                    return {
                        status: 'Unresolved',
                        reason: 'BuffActionLifetimeLeaseOwnerMissing',
                        buffId: action.buffId ?? null
                    };
                }
                return this.statusEffects.inheritActionLifetime({
                    frame: action.frame ?? eventContext.frame,
                    targetId: this.#entityId(
                        action.targetRef ?? action.target ?? action.targetId,
                        eventContext,
                        'Target'
                    ),
                    buffId: action.buffId,
                    leaseId,
                    actorId: eventContext.sourceId,
                    ownerSkillId: eventContext.skillId,
                    ownerCastId: eventContext.castId,
                    ownerProgramExecutionId: eventContext.programExecutionId,
                    inheritSkillIds: cloneValue(action.inheritSkillIds ?? []),
                    finishByAction: action.finishByAction !== false,
                    finishWithNextSkillIfNotInherited:
                        action.finishWithNextSkillIfNotInherited !== false,
                    reason: action.reason ?? 'InheritBuffAction'
                }, eventContext);
            },
            ReleaseBuffActionLifetime: (action, eventContext) => {
                const leaseId = this.#actionLifetimeLeaseId(action, eventContext);
                if (leaseId === null) {
                    return {
                        status: 'Unresolved',
                        reason: 'BuffActionLifetimeLeaseOwnerMissing',
                        buffId: action.buffId ?? null
                    };
                }
                const dynamicBuffId = action.buffIdBlackboardKey
                    ? eventContext.blackboard?.[action.buffIdBlackboardKey]
                        ?? this.entityBlackboards.get(eventContext.sourceId)
                            ?.[action.buffIdBlackboardKey]
                        ?? action.buffId
                    : action.buffId;
                return this.statusEffects.releaseActionLifetime({
                    frame: action.frame ?? eventContext.frame,
                    targetId: this.#entityId(
                        action.targetRef ?? action.target ?? action.targetId,
                        eventContext,
                        'Target'
                    ),
                    buffId: dynamicBuffId,
                    leaseId,
                    reason: action.reason ?? 'ActionLifetimeReleased'
                }, eventContext);
            },
            FinishBuff: (action, eventContext) => {
                if (action.currentBuffInstance === true
                    && (eventContext.buffInstanceId === undefined
                        || eventContext.buffInstanceId === null)) {
                    return {
                        status: 'Unresolved',
                        reason: 'CurrentBuffInstanceMissing'
                    };
                }
                const dynamicBuffId = action.buffIdBlackboardKey
                    ? eventContext.blackboard?.[action.buffIdBlackboardKey]
                        ?? this.entityBlackboards.get(eventContext.sourceId)
                            ?.[action.buffIdBlackboardKey]
                        ?? action.buffId
                    : action.buffId;
                if (action.instanceId === undefined && action.buffInstanceId === undefined
                    && action.currentBuffInstance !== true
                    && dynamicBuffId === undefined && action.stackingKey === undefined
                    && (!Array.isArray(action.tagIds) || action.tagIds.length === 0)) {
                    throw new TypeError(
                        'FinishBuff requires instanceId, buffId, stackingKey or tagIds.'
                    );
                }
                const targetRef = action.targetRef ?? action.target ?? action.targetId;
                const preserveBuffIds = new Set(
                    Array.isArray(eventContext.payload?.preserveBuffIds)
                        ? eventContext.payload.preserveBuffIds
                        : []
                );
                const selectedInstanceId = action.instanceId
                    ?? action.buffInstanceId
                    ?? (action.currentBuffInstance === true
                        ? eventContext.buffInstanceId
                        : undefined);
                const selectedInstance = selectedInstanceId === undefined
                    ? null
                    : this.statusEffects.list({ active: true })
                        .find(instance => instance.instanceId === selectedInstanceId) ?? null;
                const requestedBuffIds = [
                    dynamicBuffId,
                    ...(Array.isArray(action.buffIds) ? action.buffIds : []),
                    selectedInstance?.buffId
                ].filter(Boolean);
                if (requestedBuffIds.length > 0
                    && requestedBuffIds.every(buffId => preserveBuffIds.has(buffId))) {
                    return {
                        status: 'Preserved',
                        reason: 'EnemyMechanicPreservesVulnerability',
                        buffIds: requestedBuffIds,
                        targetId: targetRef === undefined
                            ? eventContext.targetId
                            : this.#entityId(targetRef, eventContext)
                    };
                }
                return this.statusEffects.finish({
                    frame: action.frame ?? eventContext.frame,
                    instanceId: selectedInstanceId,
                    buffId: dynamicBuffId,
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
                    metadata: action.childOfCurrentBuff && eventContext.buffInstanceId
                        ? { parentBuffInstanceId: eventContext.buffInstanceId }
                        : cloneValue(action.metadata),
                    finishAll: action.finishAll !== false,
                    stackCount: action.stackCount === undefined
                        ? undefined
                        : this.#number(action.stackCount, eventContext, 'finished buff stack count'),
                    reason: action.reason ?? 'FinishBuff'
                }, eventContext);
            },
            SetCurrentBuffTimePaused: (action, eventContext) => {
                const instanceId = action.instanceId
                    ?? action.buffInstanceId
                    ?? eventContext.buffInstanceId;
                if (instanceId === undefined || instanceId === null) {
                    return {
                        status: 'Unresolved',
                        reason: 'CurrentBuffInstanceMissing',
                        requestedPaused: action.isPaused
                    };
                }
                return this.statusEffects.setTimePaused({
                    frame: action.frame ?? eventContext.frame,
                    instanceId,
                    isPaused: action.isPaused,
                    reason: action.reason ?? 'PauseBuffTime'
                }, eventContext);
            },
            SetBuffExpiryHeld: (action, eventContext) => {
                const leaseOwner = eventContext.buffInstanceId
                    ?? eventContext.castId
                    ?? eventContext.programExecutionId;
                if (leaseOwner === undefined || leaseOwner === null) {
                    return {
                        status: 'Unresolved',
                        reason: 'BuffExpiryLeaseOwnerMissing',
                        leaseKey: action.leaseKey ?? null
                    };
                }
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                const leaseId = `${String(action.leaseKey ?? 'extend-buff')}:${String(leaseOwner)}`;
                const common = {
                    frame: action.frame ?? eventContext.frame,
                    targetId,
                    leaseId,
                    isHeld: action.isHeld === true,
                    reason: action.reason ?? 'ExtendBuffAction'
                };
                const buffIds = Array.isArray(action.buffIds)
                    ? action.buffIds.filter(Boolean)
                    : [];
                if (buffIds.length > 0) {
                    return buffIds.map(buffId => this.statusEffects.setExpiryHeld({
                        ...common,
                        buffId
                    }, eventContext));
                }
                return this.statusEffects.setExpiryHeld({
                    ...common,
                    tagIds: cloneValue(action.tagIds),
                    tagQueryType: action.tagQueryType
                }, eventContext);
            },
            ApplyCombatStatus: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                return this.enemyMechanics.resolve(action, eventContext, targetId);
            },
            ApplyEnemyInfliction: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                return this.enemyMechanics.resolveInfliction(action, eventContext, targetId);
            },
            ForceEnemySpellStatus: (action, eventContext) => {
                const targetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                const sourceId = this.#optionalEntityId(
                    action.sourceRef ?? action.sourceId,
                    eventContext,
                    eventContext.sourceId
                );
                const ownerId = this.#optionalEntityId(
                    action.ownerRef ?? action.ownerId,
                    eventContext,
                    eventContext.ownerId
                );
                return this.enemyMechanics.resolveForcedSpellStatus({
                    ...action,
                    count: this.#number(
                        action.count,
                        eventContext,
                        'forced spell status count'
                    ),
                    consumedLayer: this.#number(
                        action.consumedLayer,
                        eventContext,
                        'forced spell status consumed layer'
                    ),
                    consumedType: this.#number(
                        action.consumedType,
                        eventContext,
                        'forced spell status consumed type'
                    )
                }, {
                    ...eventContext,
                    sourceId,
                    ownerId,
                    targetId,
                    damageSourceId: sourceId ?? eventContext.damageSourceId ?? null
                }, targetId);
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
            InterruptCurrentSkill: (action, eventContext) => {
                if (!this.skillInterruptResolver) {
                    return {
                        status: 'Unresolved',
                        reason: 'MissingSkillInterruptResolver'
                    };
                }
                return this.skillInterruptResolver({
                    action: cloneValue(action),
                    eventContext: cloneValue(eventContext),
                    runtime: this
                });
            },
            TriggerStatusEvent: (action, eventContext) => {
                const listenerTargetId = this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Target'
                );
                const sourceId = action.sourceRef === undefined
                    ? eventContext.sourceId
                    : this.#optionalEntityId(action.sourceRef, eventContext);
                return this.statusEffects.notifyAbilityEvent({
                    ...cloneValue(eventContext),
                    sourceId,
                    eventType: action.eventType,
                    listenerTargetId,
                    useEventSourceAsActionSource: action.eventSourceAsActionSource === true
                });
            },
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
                let spawnedAbilityEntityId = null;
                if (action.abilityEntityId) {
                    const ownerId = eventContext.ownerId ?? eventContext.sourceId;
                    const owner = this.context.getEntity(ownerId);
                    spawnedAbilityEntityId = [
                        'ability-entity',
                        action.abilityEntityId,
                        this.nextAbilityEntitySequence++
                    ].join(':');
                    this.registerEntity({
                        id: spawnedAbilityEntityId,
                        kind: 'Object',
                        team: owner.team,
                        ownerId,
                        reactionTarget: false,
                        blackboard: assigned,
                        metadata: {
                            abilityEntityId: action.abilityEntityId,
                            akeTagIds: cloneValue(action.akeTagIds ?? []),
                            spawnedObjectType: 'AbilityEntity',
                            sourceSkillId: eventContext.skillId,
                            rootSkillId: eventContext.rootSkillId,
                            spawnedFrame: eventContext.frame
                        }
                    });
                }
                const launchDelayTicks = nonNegativeInteger(
                    action.launchDelayTicks ?? 0,
                    'launchDelayTicks'
                );
                const launchFrame = eventContext.frame + launchDelayTicks;
                const scheduled = this.scheduleProgram(program, {
                    ...cloneValue(eventContext),
                    frame: launchFrame,
                    eventType: 'ChildSkillProgramStarted',
                    resolveSkillActionLifetimes: false,
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
                    abilityEntityId: action.abilityEntityId ?? null,
                    projectileTerminalEvent: action.projectileTerminalEvent ?? null,
                    spawnedAbilityEntityId,
                    launchFrame,
                    launchDelayTicks,
                    scheduled
                };
            },
            ScheduleIntervalActions: (action, eventContext) => (
                this.scheduleIntervalActions(action, eventContext)
            ),
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
                const sampleGroupId = typeof resolution.sampleGroupId === 'string'
                    && resolution.sampleGroupId.length > 0
                    ? resolution.sampleGroupId
                    : null;
                const sampleGeneration = sampleGroupId === null
                    ? null
                    : (this.timeDilationSampleGenerations.get(sampleGroupId) ?? 0) + 1;
                if (sampleGroupId !== null) {
                    this.timeDilationSampleGenerations.set(sampleGroupId, sampleGeneration);
                }
                const applied = pauses.map(pause => {
                    const frameOffsetTicks = nonNegativeInteger(
                        pause.frameOffsetTicks ?? 0,
                        'time-dilation frameOffsetTicks'
                    );
                    const pauseFrame = eventContext.frame + frameOffsetTicks;
                    const applyPause = () => {
                        if (sampleGroupId !== null
                            && this.timeDilationSampleGenerations.get(sampleGroupId)
                                !== sampleGeneration) {
                            return {
                                status: 'Superseded',
                                sampleGroupId,
                                sampleGeneration,
                                frame: pauseFrame,
                                domainId: pause.domainId
                                    ?? eventContext.clockDomainId
                                    ?? 'global'
                            };
                        }
                        return this.clockDomains.pause(
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
                    };
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
                const damageEventContext = action.targetRef === undefined
                    && action.target === undefined
                    && action.targetId === undefined
                    ? eventContext
                    : this.context.createEventContext(eventContext, {
                        targetId: this.#entityId(
                            action.targetRef ?? action.target ?? action.targetId,
                            eventContext,
                            'Target'
                        )
                    });
                const sourceListenerId = damageEventContext.sourceId
                    ?? damageEventContext.ownerId;
                const targetListenerId = damageEventContext.targetId;
                const hitIdentityByUnit = new Map((action.damageUnits ?? []).map(
                    (_unit, damageUnitIndex) => {
                        const sequence = this.nextDamageHitSequence++;
                        return [damageUnitIndex, {
                            hitId: `runtime-hit:${sequence}`,
                            sequence
                        }];
                    }
                ));
                const beforeAbilityEvents = (action.damageUnits ?? []).map(
                    (unit, damageUnitIndex) => {
                        const pendingHit = {
                            ...cloneValue(unit),
                            ...hitIdentityByUnit.get(damageUnitIndex),
                            damageUnitIndex,
                            damageAttributeType: unit.damageAttributeType ?? 'Hp',
                            damageDecorateMask: Number(unit.damageDecorateMask ?? 0)
                        };
                        return {
                            damageUnitIndex,
                            output: this.#notifyDamageEvent(
                                'OnBeforeOutputDamage',
                                pendingHit,
                                null,
                                damageEventContext,
                                sourceListenerId
                            ),
                            take: this.#notifyDamageEvent(
                                'OnBeforeTakeDamage',
                                pendingHit,
                                null,
                                damageEventContext,
                                targetListenerId
                            )
                        };
                    }
                );
                const resolution = this.damageResolver({
                    action: cloneValue(action),
                    eventContext: cloneValue(damageEventContext),
                    runtime: this,
                    resolveValue: descriptor => this.#value(descriptor, damageEventContext)
                });
                if (!isRecord(resolution)) {
                    throw new TypeError('damageResolver must return an object.');
                }
                if (resolution.status === 'Unresolved') return cloneValue(resolution);
                const hits = resolution.hits ?? [];
                if (!Array.isArray(hits)) throw new TypeError('damageResolver hits must be an array.');
                const identifiedHits = hits.map(hit => {
                    const existingIdentity = hitIdentityByUnit.get(hit.damageUnitIndex);
                    const fallbackSequence = existingIdentity
                        ? existingIdentity.sequence
                        : this.nextDamageHitSequence++;
                    const sourceBuffId = damageEventContext.buffInstanceId
                        ? this.statusEffects.get(damageEventContext.buffInstanceId)?.buffId
                            ?? eventContext.payload?.buffId
                            ?? null
                        : eventContext.payload?.buffId ?? null;
                    const semanticHitType = hit.semanticHitType
                        ?? action.semanticHitType
                        ?? eventContext.payload?.statusMetadata?.akeCombatStatus
                        ?? eventContext.payload?.statusKey
                        ?? (sourceBuffId ? 'buff-derived' : 'skill');
                    return {
                        ...cloneValue(hit),
                        hitId: hit.hitId
                            ?? existingIdentity?.hitId
                            ?? `runtime-hit:${fallbackSequence}`,
                        sequence: hit.sequence ?? fallbackSequence,
                        parentTransactionId: damageEventContext.transactionId ?? null,
                        parentEventId: damageEventContext.parentEventId ?? null,
                        sourceBuffInstanceId: damageEventContext.buffInstanceId ?? null,
                        sourceBuffId,
                        semanticHitType,
                        displayName: hit.displayName
                            ?? action.displayName
                            ?? action.metadata?.displayName
                            ?? null,
                        sourceId: damageEventContext.sourceId,
                        ownerId: damageEventContext.ownerId,
                        carrierId: damageEventContext.carrierId
                            ?? damageEventContext.sourceId,
                        targetId: damageEventContext.targetId,
                        damageSourceId: damageEventContext.damageSourceId
                            ?? damageEventContext.sourceId
                    };
                });
                const appliedHits = identifiedHits.map(hit => {
                    const amount = finite(
                        hit.amount ?? hit.finalDamage,
                        'resolved damage amount'
                    );
                    if (['Poise', 'Resilience'].includes(hit.damageAttributeType)) {
                        return {
                            ...cloneValue(hit),
                            damageAttributeType: hit.damageAttributeType,
                            result: this.resilience.applyImpact({
                                ...this.#attribution({ ...action, ...hit }, damageEventContext),
                                amount,
                                controlType: hit.controlType,
                                controlLevel: hit.controlLevel
                            })
                        };
                    }
                    return {
                        ...cloneValue(hit),
                        damageAttributeType: hit.damageAttributeType ?? 'Hp',
                        result: this.vitals.damage({
                            ...this.#attribution({ ...action, ...hit }, damageEventContext),
                            amount,
                            damageType: hit.damageType ?? action.damageType ?? 'Generic',
                            bypassShield: hit.bypassShield ?? action.bypassShield ?? false
                        })
                    };
                });
                const afterAbilityEvents = appliedHits.map(applied => {
                    const outputEvents = [];
                    const takeEvents = [];
                    if (['Poise', 'Resilience'].includes(applied.damageAttributeType)) {
                        takeEvents.push(...this.#notifyDamageEvent(
                            'OnTakePoiseDamage',
                            applied,
                            applied.result,
                            damageEventContext,
                            targetListenerId
                        ));
                    } else {
                        outputEvents.push(...this.#notifyDamageEvent(
                            'OnOutputDamage',
                            applied,
                            applied.result,
                            damageEventContext,
                            sourceListenerId
                        ));
                        takeEvents.push(...this.#notifyDamageEvent(
                            'OnTakeDamage',
                            applied,
                            applied.result,
                            damageEventContext,
                            targetListenerId
                        ));
                        if (applied.isCritical === true) {
                            outputEvents.push(...this.#notifyDamageEvent(
                                'OnOutputCriticalDamage',
                                applied,
                                applied.result,
                                damageEventContext,
                                sourceListenerId
                            ));
                            takeEvents.push(...this.#notifyDamageEvent(
                                'OnTakeCriticalDamage',
                                applied,
                                applied.result,
                                damageEventContext,
                                targetListenerId
                            ));
                        }
                    }
                    return {
                        damageUnitIndex: applied.damageUnitIndex,
                        output: outputEvents,
                        take: takeEvents
                    };
                });
                return {
                    status: resolution.status ?? 'Applied',
                    resolution: cloneValue({ ...resolution, hits: identifiedHits }),
                    hits: appliedHits,
                    abilityEvents: {
                        before: beforeAbilityEvents,
                        after: afterAbilityEvents
                    }
                };
            },
            RefreshCurrentBuffEffectSource: (_action, eventContext) => {
                const buffId = eventContext.payload?.buffId;
                const currentBuff = eventContext.buffInstanceId
                    ? this.statusEffects.get(eventContext.buffInstanceId)
                    : null;
                const definition = buffId
                    ? this.statusEffects.getDefinition(buffId)
                    : null;
                if (!definition || !eventContext.buffInstanceId) {
                    return {
                        status: 'Ignored',
                        reason: 'CurrentBuffDefinitionMissing',
                        buffId: buffId ?? null
                    };
                }
                const modifiers = definition.persistentModifiers ?? [];
                const damageModifiers = definition.persistentDamageModifiers ?? [];
                const tags = [
                    ...(definition.persistentTags ?? []),
                    ...(currentBuff?.extensionTriggered
                        ? definition.persistentExtendTags ?? []
                        : [])
                ];
                if (modifiers.length === 0 && damageModifiers.length === 0
                    && tags.length === 0) {
                    return {
                        status: 'Ignored',
                        reason: 'CurrentBuffHasNoPersistentSource',
                        buffId
                    };
                }
                return this.effectSources.apply({
                    ...this.#attribution({}, eventContext),
                    sourceKey: eventContext.buffInstanceId,
                    sourceType: 'StatusEffect',
                    sourceCategory: eventContext.payload?.statusMetadata?.sourceType,
                    modifiers,
                    damageModifiers,
                    tags,
                    metadata: {
                        ...cloneValue(currentBuff?.metadata ?? {}),
                        buffId,
                        appliedFrame: currentBuff?.startFrame ?? eventContext.frame,
                        expireFrame: currentBuff?.expireFrame ?? null,
                        refreshedDuringStart: true
                    }
                }, eventContext);
            },
            ApplyEffectSource: (action, eventContext) => {
                const currentBuff = eventContext.buffInstanceId
                    ? this.statusEffects.list({ active: true }).find(instance =>
                        instance.instanceId === eventContext.buffInstanceId
                    )
                    : null;
                const sourceContext = currentBuff
                    ? this.context.createEventContext(eventContext, {
                        payload: {
                            buffId: currentBuff.buffId,
                            stackCount: currentBuff.stackCount
                        }
                    })
                    : eventContext;
                return this.effectSources.apply({
                    ...this.#attribution(action, sourceContext),
                    sourceKey: action.sourceKey ?? sourceContext.buffInstanceId,
                    sourceType: action.sourceType ?? 'Effect',
                    sourceCategory: action.sourceCategory
                        ?? currentBuff?.metadata?.sourceType,
                    modifiers: action.modifiers ?? [],
                    damageModifiers: action.damageModifiers ?? [],
                    tags: action.tags ?? [],
                    metadata: {
                        ...cloneValue(currentBuff?.metadata ?? {}),
                        ...cloneValue(action.metadata ?? {}),
                        buffId: currentBuff?.buffId ?? sourceContext.payload?.buffId ?? null,
                        appliedFrame: currentBuff?.startFrame ?? sourceContext.frame,
                        expireFrame: currentBuff?.expireFrame ?? null
                    }
                }, sourceContext);
            },
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
            ApplySkillOverride: (action, eventContext) => {
                const entry = this.skillForms.applyOverride({
                    ...this.#attribution(action, eventContext),
                    targetId: this.#entityId(
                        action.targetRef ?? action.target ?? action.targetId,
                        eventContext,
                        'Source'
                    ),
                    sourceKey: this.#skillFormSourceKey(action, eventContext),
                    skillSlot: action.skillSlot,
                    targetSkillId: action.targetSkillId ?? action.skillId,
                    revertedSkillId: action.revertedSkillId,
                    priorityLevel: action.priorityLevel,
                    priorityOffset: action.priorityOffset,
                    inheritOriginSkillCdProgress: action.inheritOriginSkillCdProgress,
                    overrideCacheTime: action.overrideCacheTime,
                    cacheTime: action.cacheTime,
                    lifeTimeType: action.lifeTimeType,
                    metadata: action.metadata
                }, eventContext);
                this.#scheduleSkillFormExpiry('SkillOverride', action, eventContext, entry);
                return entry;
            },
            RemoveSkillOverride: (action, eventContext) => this.skillForms.removeOverride({
                frame: action.frame ?? eventContext.frame,
                sourceKey: this.#skillFormSourceKey(action, eventContext),
                targetId: this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Source'
                ),
                skillSlot: action.skillSlot,
                buffInstanceId: action.buffInstanceId ?? eventContext.buffInstanceId
            }, eventContext),
            ApplySkillMode: (action, eventContext) => {
                const entry = this.skillForms.applyMode({
                    ...this.#attribution(action, eventContext),
                    targetId: this.#entityId(
                        action.targetRef ?? action.target ?? action.targetId,
                        eventContext,
                        'Source'
                    ),
                    sourceKey: this.#skillFormSourceKey(action, eventContext),
                    modeId: action.modeId,
                    resetOnEnd: action.resetOnEnd,
                    priorityLevel: action.priorityLevel,
                    priorityOffset: action.priorityOffset,
                    metadata: action.metadata
                }, eventContext);
                this.#scheduleSkillFormExpiry('SkillMode', action, eventContext, entry);
                return entry;
            },
            RemoveSkillMode: (action, eventContext) => this.skillForms.removeMode({
                frame: action.frame ?? eventContext.frame,
                sourceKey: this.#skillFormSourceKey(action, eventContext),
                targetId: this.#entityId(
                    action.targetRef ?? action.target ?? action.targetId,
                    eventContext,
                    'Source'
                ),
                modeId: action.modeId,
                buffInstanceId: action.buffInstanceId ?? eventContext.buffInstanceId
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
            PauseOtherClockDomains: (action, eventContext) => {
                const excludedDomainId = action.excludedDomainId === 'SourceClock'
                    ? eventContext.clockDomainId
                    : action.excludedDomainId ?? eventContext.clockDomainId;
                const domainIds = this.clockDomains.listDomains({ includeGlobal: false })
                    .filter(domain => domain.id !== excludedDomainId)
                    .filter(domain => action.includeEnemyDomains !== false
                        || domain.kind !== 'Enemy')
                    .map(domain => domain.id);
                if (domainIds.length === 0) {
                    return {
                        status: 'Applied',
                        excludedDomainId,
                        domainIds: [],
                        durationTicks: action.durationTicks ?? 0
                    };
                }
                const records = this.clockDomains.pauseMany(domainIds, {
                    ...this.#attribution(action, eventContext, { target: false }),
                    durationTicks: action.durationTicks,
                    excludedTicks: action.excludedTicks ?? action.durationTicks,
                    requestedScale: action.requestedScale ?? 0,
                    sourceSkillId: action.sourceSkillId ?? eventContext.skillId
                });
                return {
                    status: 'Applied',
                    excludedDomainId,
                    domainIds,
                    durationTicks: action.durationTicks ?? 0,
                    records
                };
            },
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

    #notifyDamageEvent(eventType, hit, appliedResult, eventContext, listenerTargetId) {
        if (listenerTargetId === null || listenerTargetId === undefined) return [];
        if (this.abilityNotifyDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum ability-event depth ${this.maxDerivedDepth} exceeded.`);
        }
        this.abilityNotifyDepth += 1;
        try {
            const context = this.context.createEventContext(eventContext, {
                eventType,
                parentHitId: hit.hitId ?? null,
                hitEventPhase: eventType.startsWith('OnBefore') ? 'before' : 'after',
                payload: {
                    damageUnitIndex: hit.damageUnitIndex ?? null,
                    hitId: hit.hitId ?? null,
                    parentTransactionId: hit.parentTransactionId
                        ?? eventContext.transactionId
                        ?? null,
                    damageType: hit.damageType ?? null,
                    damageTypeMask: hit.damageTypeMask ?? null,
                    damageAttributeType: hit.damageAttributeType ?? 'Hp',
                    damageDecorateMask: Number(hit.damageDecorateMask ?? 0),
                    atkScale: hit.operands?.atkScale ?? hit.atkScale ?? null,
                    rawDamage: hit.rawDamage ?? null,
                    finalDamage: hit.finalDamage ?? hit.amount ?? null,
                    actualDamage: appliedResult?.actualDamage
                        ?? appliedResult?.actual
                        ?? null,
                    isCritical: hit.isCritical === true,
                    eventTargetId: eventContext.targetId,
                    listenerTargetId
                }
            });
            const results = this.statusEffects.notifyAbilityEvent({
                ...context,
                listenerTargetId
            });
            this.#record('AbilityEventNotified', context, {
                eventType,
                listenerTargetId,
                handled: results.length,
                damageUnitIndex: hit.damageUnitIndex ?? null,
                hitId: hit.hitId ?? null,
                damageDecorateMask: Number(hit.damageDecorateMask ?? 0)
            });
            return results;
        } finally {
            this.abilityNotifyDepth -= 1;
        }
    }

    #notifyAddedBuff(instance, eventContext) {
        if (this.abilityNotifyDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum ability-event depth ${this.maxDerivedDepth} exceeded.`);
        }
        const definition = this.statusEffects.getDefinition(instance.buffId);
        const listenerTargetId = instance.targetId;
        this.abilityNotifyDepth += 1;
        try {
            const context = this.context.createEventContext(eventContext, {
                frame: instance.startFrame,
                eventType: 'OnAddedBuff',
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId: instance.targetId,
                buffInstanceId: instance.instanceId,
                blackboard: instance.blackboard,
                payload: {
                    buffId: instance.buffId,
                    buffTagIds: definition?.tagIds ?? [],
                    outputBuffTargetId: instance.targetId,
                    eventTargetId: instance.targetId,
                    listenerTargetId
                }
            });
            const results = this.statusEffects.notifyAbilityEvent({
                ...context,
                listenerTargetId
            });
            this.#record('AbilityEventNotified', context, {
                eventType: 'OnAddedBuff',
                listenerTargetId,
                handled: results.length
            });
            return results;
        } finally {
            this.abilityNotifyDepth -= 1;
        }
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
                    buffTagIds: definition?.tagIds ?? [],
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

    #notifyBeforeOutputBuff(candidate, attribution, blackboard, eventContext) {
        if (!candidate?.buffId) return [];
        if (this.abilityNotifyDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum ability-event depth ${this.maxDerivedDepth} exceeded.`);
        }
        const definition = this.statusEffects.getDefinition(candidate.buffId);
        if (definition === null) return [];
        const listenerTargetId = attribution.sourceId
            ?? eventContext.sourceId
            ?? eventContext.ownerId;
        this.abilityNotifyDepth += 1;
        try {
            const context = this.context.createEventContext(eventContext, {
                frame: eventContext.frame,
                eventType: 'OnBeforeOutputBuff',
                sourceId: attribution.sourceId,
                ownerId: attribution.ownerId,
                targetId: attribution.targetId,
                blackboard: cloneValue(blackboard ?? {}),
                payload: {
                    ...cloneValue(eventContext.payload ?? {}),
                    buffId: candidate.buffId,
                    buffTagIds: definition.tagIds ?? [],
                    outputBuffTargetId: attribution.targetId,
                    listenerTargetId
                }
            });
            const results = this.statusEffects.notifyAbilityEvent({
                ...context,
                listenerTargetId
            });
            this.#record('AbilityEventNotified', context, {
                eventType: 'OnBeforeOutputBuff',
                listenerTargetId,
                handled: results.length
            });
            return results;
        } finally {
            this.abilityNotifyDepth -= 1;
        }
    }

    #notifyResourceEvent(record, eventContext) {
        if (!isRecord(record) || record.success === false
            || Number(record.actualAmount ?? record.actual ?? 0) === 0) return [];
        const eventTypes = [];
        const method = String(record.resourceGainMethod ?? '').toLowerCase();
        if (record.stage === 'ResourceGained' && record.resourceType === 'Atb'
            && method !== 'return') {
            eventTypes.push('OnObtainAtb');
            if (record.before < record.cap && record.after >= record.cap) {
                eventTypes.push('OnAtbMax');
            }
        }
        if (record.stage === 'ResourceSpent'
            && (record.reason === 'CastCost' || record.resourceSourceType === 'Skill')) {
            eventTypes.push('OnAfterSkillApplyCost');
        }
        if (record.resourceType === 'UltimateSp') eventTypes.push('OnSquadUspChange');
        if (eventTypes.length === 0) return [];
        if (this.abilityNotifyDepth >= this.maxDerivedDepth) {
            throw new Error(`Maximum ability-event depth ${this.maxDerivedDepth} exceeded.`);
        }
        const listenerTargetId = record.sourceId
            ?? eventContext.sourceId
            ?? eventContext.ownerId;
        this.abilityNotifyDepth += 1;
        try {
            return eventTypes.flatMap(eventType => {
                const context = this.context.createEventContext(eventContext, {
                    frame: record.frame,
                    eventType,
                    sourceId: record.sourceId ?? eventContext.sourceId,
                    ownerId: record.ownerId ?? eventContext.ownerId,
                    targetId: record.targetId ?? eventContext.targetId,
                    skillId: record.skillId ?? eventContext.skillId,
                    castId: record.castId ?? eventContext.castId,
                    payload: {
                        ...cloneValue(eventContext.payload ?? {}),
                        resourceType: record.resourceType,
                        resourceSourceType: record.resourceSourceType,
                        resourceGainMethod: record.resourceGainMethod,
                        requestedAmount: record.requestedAmount ?? record.requested,
                        requestedDelta: record.requestedDelta,
                        actualAmount: record.actualAmount ?? record.actual,
                        actualDelta: record.actualDelta,
                        before: record.before,
                        after: record.after,
                        cap: record.cap,
                        returnedBefore: record.returnedBefore,
                        returnedAfter: record.returnedAfter,
                        returnedSpent: record.returnedSpent,
                        eligibleSpend: record.eligibleSpend,
                        skillType: eventContext.skillType ?? eventContext.commandType ?? null
                    }
                });
                const results = this.statusEffects.notifyAbilityEvent({
                    ...context,
                    listenerTargetId
                });
                this.#record('AbilityEventNotified', context, {
                    eventType,
                    listenerTargetId,
                    handled: results.length,
                    resourceType: record.resourceType
                });
                return results;
            });
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
            const buffDefinition = this.statusEffects.getDefinition(buff.buffId);
            const applied = this.statusEffects.apply({
                ...eventContext,
                buffId: buff.buffId,
                actionClockDomainId: this.#entityClockDomainId(
                    eventContext.targetId,
                    eventContext.clockDomainId
                ),
                clockDomainId: buffDefinition?.useTimeDilationDt === false
                    ? 'global'
                    : this.#entityClockDomainId(
                        eventContext.targetId,
                        eventContext.clockDomainId
                    ),
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
            this.#notifyAddedBuff(applied, eventContext);
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
