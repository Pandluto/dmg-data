/*
 * Control resilience is intentionally independent from PoiseMachine.  It has
 * its own values, transitions, gate and trace so a caller can run both
 * systems side by side without one silently changing the other's state.
 */

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return result;
}

function nonNegative(value, label) {
    const result = finite(value, label);
    if (result < 0) throw new RangeError(`${label} must be non-negative.`);
    return result;
}

function clone(value) {
    if (value === undefined || value === null) return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall through for definitions containing callbacks.
        }
    }
    if (Array.isArray(value)) return value.map(item => clone(item));
    if (isObject(value)) {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (typeof item !== 'function') result[key] = clone(item);
        }
        return result;
    }
    return value;
}

function targetKey(value) {
    return `${typeof value}\u0000${String(value)}`;
}

function mergeContext(input = {}, fallback = {}) {
    const nested = isObject(input.eventContext) ? input.eventContext : {};
    return { ...fallback, ...nested, ...input };
}

function mapDefinitions(definitions) {
    if (!definitions) return new Map();
    if (definitions instanceof Map) return new Map(definitions);
    if (Array.isArray(definitions)) {
        return new Map(definitions.map(definition => {
            if (!isObject(definition)) throw new TypeError('Resilience definitions in an array must be objects.');
            const id = definition.targetId ?? definition.entityId ?? definition.id;
            identifier(id, 'resilience targetId');
            return [id, definition];
        }));
    }
    if (!isObject(definitions)) throw new TypeError('Resilience definitions must be a Map, array or object.');
    return new Map(Object.entries(definitions));
}

function mapProfiles(profiles) {
    if (!profiles) return new Map();
    if (profiles instanceof Map) return new Map(profiles);
    if (!isObject(profiles)) throw new TypeError('Resilience profiles must be a Map or object.');
    return new Map(Object.entries(profiles));
}

function normalizeControlTypes(value) {
    const values = value ?? ['Downed', 'Down', 'Knockdown', 'Execution'];
    if (!Array.isArray(values)) throw new TypeError('downedControlTypes must be an array.');
    return values.map((item, index) => {
        if (typeof item !== 'string' && typeof item !== 'number') {
            throw new TypeError(`downedControlTypes[${index}] must be a string or number.`);
        }
        return item;
    });
}

function normalizeDefinition(targetId, inputDefinition, profiles) {
    if (!isObject(inputDefinition)) throw new TypeError(`Resilience definition for ${String(targetId)} must be an object.`);
    const profileId = inputDefinition.profileId ?? null;
    let profile = {};
    if (profileId !== null) {
        profile = profiles.get(profileId);
        if (!profile) throw new Error(`Missing resilience profile: ${String(profileId)}.`);
        if (!isObject(profile)) throw new TypeError(`Resilience profile ${String(profileId)} must be an object.`);
    }
    if (inputDefinition.profile !== undefined) {
        if (!isObject(inputDefinition.profile)) throw new TypeError('definition.profile must be an object.');
        profile = { ...profile, ...inputDefinition.profile };
    }
    const definition = { ...profile, ...inputDefinition };
    const maxResilience = nonNegative(definition.maxResilience, `${String(targetId)}.maxResilience`);
    const recoveryPerTick = nonNegative(definition.recoveryPerTick ?? 0, `${String(targetId)}.recoveryPerTick`);
    const superArmorLevel = nonNegative(definition.superArmorLevel ?? 0, `${String(targetId)}.superArmorLevel`);
    const controlImmunityLevel = nonNegative(
        definition.controlImmunityLevel ?? 0,
        `${String(targetId)}.controlImmunityLevel`
    );
    const executionGaugeMax = nonNegative(
        definition.executionGaugeMax ?? 0,
        `${String(targetId)}.executionGaugeMax`
    );
    const initialResilience = nonNegative(
        definition.initialResilience ?? maxResilience,
        `${String(targetId)}.initialResilience`
    );
    if (initialResilience > maxResilience) {
        throw new RangeError(`${String(targetId)}.initialResilience cannot exceed maxResilience.`);
    }
    const initialExecutionGauge = nonNegative(
        definition.initialExecutionGauge ?? 0,
        `${String(targetId)}.initialExecutionGauge`
    );
    if (initialExecutionGauge > executionGaugeMax) {
        throw new RangeError(`${String(targetId)}.initialExecutionGauge cannot exceed executionGaugeMax.`);
    }
    const downedDurationTicks = definition.downedDurationTicks === undefined
        ? null
        : nonNegative(definition.downedDurationTicks, `${String(targetId)}.downedDurationTicks`);
    const downedControlLevel = definition.downedControlLevel === undefined
        ? null
        : nonNegative(definition.downedControlLevel, `${String(targetId)}.downedControlLevel`);
    return {
        ...definition,
        targetId,
        profileId,
        maxResilience,
        recoveryPerTick,
        superArmorLevel,
        controlImmunityLevel,
        executionGaugeMax,
        initialResilience,
        initialExecutionGauge,
        downedDurationTicks,
        downedControlLevel,
        downedControlTypes: normalizeControlTypes(definition.downedControlTypes),
        reviveOnRecovery: definition.reviveOnRecovery !== false,
        ruleId: definition.ruleId ?? null
    };
}

export class ResilienceMachine {
    constructor(options = {}) {
        if (!isObject(options)) throw new TypeError('ResilienceMachine options must be an object.');
        const {
            definitions = null,
            entities = null,
            definition = null,
            profiles = null,
            targetId: configuredTargetId = null,
            entityId = null,
            onControl = null,
            targetValidator = null,
            trace = []
        } = options;
        if (!Array.isArray(trace)) throw new TypeError('trace must be an array.');
        if (onControl !== null && typeof onControl !== 'function') {
            throw new TypeError('onControl must be a function or null.');
        }
        if (targetValidator !== null && typeof targetValidator !== 'function') {
            throw new TypeError('targetValidator must be a function or null.');
        }
        this.profiles = mapProfiles(profiles);
        this.trace = trace;
        this.onControl = onControl;
        this.targetValidator = targetValidator;
        this.entities = new Map();
        this.nextModifierId = 1;
        this.defaultTargetId = configuredTargetId ?? entityId ?? null;
        if (this.defaultTargetId !== null) identifier(this.defaultTargetId, 'targetId');

        const definitionKeys = new Map();
        if (definitions !== null) {
            for (const [id, entityDefinition] of mapDefinitions(definitions)) {
                definitionKeys.set(id, entityDefinition);
            }
        }
        if (entities !== null) {
            for (const [id, entityDefinition] of mapDefinitions(entities)) {
                definitionKeys.set(id, entityDefinition);
            }
        }
        if (definition !== null) {
            const id = this.defaultTargetId ?? definition.targetId ?? definition.entityId ?? definition.id ?? 'default';
            this.defaultTargetId = id;
            definitionKeys.set(id, definition);
        } else if (definitionKeys.size === 0) {
            const directKeys = ['maxResilience', 'recoveryPerTick', 'superArmorLevel',
                'controlImmunityLevel', 'executionGaugeMax'];
            if (directKeys.some(key => Object.prototype.hasOwnProperty.call(options, key))) {
                const id = this.defaultTargetId ?? 'default';
                this.defaultTargetId = id;
                definitionKeys.set(id, options);
            }
        }
        for (const [id, entityDefinition] of definitionKeys) {
            this.registerEntity({ targetId: id, definition: entityDefinition });
        }
    }

    #resolveTargetId(value) {
        if (value !== undefined && value !== null) return identifier(value, 'targetId');
        if (this.defaultTargetId !== null && this.defaultTargetId !== undefined) return this.defaultTargetId;
        if (this.entities.size === 1) return this.entities.keys().next().value;
        throw new TypeError('targetId is required when multiple resilience entities exist.');
    }

    #entity(targetId) {
        const id = this.#resolveTargetId(targetId);
        const entity = this.entities.get(targetKey(id));
        if (!entity) throw new Error(`Unknown resilience entity: ${String(id)}.`);
        return entity;
    }

    #record(stage, context = {}, overrides = {}) {
        const record = {
            frame: finite(context.frame ?? 0, 'frame'),
            stage,
            type: stage,
            sourceId: context.sourceId ?? null,
            ownerId: context.ownerId ?? null,
            targetId: context.targetId ?? null,
            skillId: context.skillId ?? null,
            rootSkillId: context.rootSkillId ?? null,
            castId: context.castId ?? null,
            buffInstanceId: context.buffInstanceId ?? null,
            clockDomainId: context.clockDomainId ?? null,
            reason: context.reason ?? stage,
            ruleId: context.ruleId ?? null,
            ...overrides
        };
        this.trace.push(record);
        return record;
    }

    #publicEntity(entity) {
        const definition = entity.definition;
        const effective = this.#effectiveModifiers(entity);
        return {
            targetId: entity.targetId,
            profileId: definition.profileId,
            maxResilience: definition.maxResilience,
            resilience: entity.resilience,
            currentResilience: entity.resilience,
            remainingResilience: entity.resilience,
            recoveryPerTick: definition.recoveryPerTick,
            superArmorLevel: effective.superArmorLevel,
            baseSuperArmorLevel: definition.superArmorLevel,
            impactResistance: effective.impactResistance,
            impactScalar: effective.impactScalar,
            modifiers: effective.modifiers,
            controlImmunityLevel: definition.controlImmunityLevel,
            executionGaugeMax: definition.executionGaugeMax,
            executionGauge: entity.executionGauge,
            executionReady: definition.executionGaugeMax > 0
                && entity.executionGauge >= definition.executionGaugeMax,
            state: entity.state,
            downedUntilFrame: entity.downedUntilFrame,
            staggerCount: entity.staggerCount,
            downedCount: entity.downedCount,
            lastControl: clone(entity.lastControl),
            lastImpactFrame: entity.lastImpactFrame,
            lastRecoveryFrame: entity.lastRecoveryFrame,
            cycle: entity.cycle
        };
    }

    #transition(entity, nextState, context, reason) {
        const previousState = entity.state;
        if (previousState === nextState) return null;
        entity.state = nextState;
        if (nextState === 'Staggered') entity.staggerCount += 1;
        if (nextState === 'Downed') entity.downedCount += 1;
        return this.#record('StateChanged', context, {
            previousState,
            state: nextState,
            reason: reason ?? context.reason ?? 'StateChanged'
        });
    }

    #isDownControl(definition, controlType, controlLevel) {
        const typeMatch = definition.downedControlTypes.some(type => type === controlType
            || String(type).toLowerCase() === String(controlType).toLowerCase());
        const levelMatch = definition.downedControlLevel !== null
            && controlLevel >= definition.downedControlLevel;
        return typeMatch || levelMatch;
    }

    hasEntity(targetId) {
        if ((typeof targetId !== 'string' || targetId.trim() === '')
            && (typeof targetId !== 'number' || !Number.isFinite(targetId))) return false;
        return this.entities.has(targetKey(targetId));
    }

    #controlOutcome(definition, controlLevel) {
        if (controlLevel <= definition.controlImmunityLevel) return 'Immune';
        if (controlLevel <= definition.superArmorLevel) return 'Reduced';
        return 'Applied';
    }

    #effectiveModifiers(entity) {
        const modifiers = [...entity.modifiers.values()];
        const superArmorLevel = modifiers.reduce(
            (value, modifier) => modifier.superArmorLevel === null
                ? value
                : Math.max(value, modifier.superArmorLevel),
            entity.definition.superArmorLevel
        );
        const impactResistance = modifiers.reduce(
            (value, modifier) => modifier.impactResistance === null
                ? value
                : Math.max(value, modifier.impactResistance),
            0
        );
        const impactScalar = modifiers.reduce(
            (value, modifier) => modifier.impactScalar === null
                ? value
                : value * modifier.impactScalar,
            1
        );
        return {
            superArmorLevel,
            impactResistance,
            impactScalar,
            modifiers: modifiers.map(modifier => clone(modifier))
        };
    }

    registerEntity(input = {}) {
        if (!isObject(input)) throw new TypeError('registerEntity requires an object.');
        const targetId = identifier(input.targetId ?? input.id ?? input.entityId, 'targetId');
        if (this.entities.has(targetKey(targetId))) throw new Error(`Duplicate resilience entity: ${String(targetId)}.`);
        if (this.targetValidator && !this.targetValidator(targetId, input)) {
            throw new Error(`Unknown or invalid resilience entity: ${String(targetId)}.`);
        }
        const rawDefinition = input.definition ?? input;
        const definition = normalizeDefinition(targetId, rawDefinition, this.profiles);
        const entity = {
            targetId,
            definition,
            resilience: definition.initialResilience,
            executionGauge: definition.initialExecutionGauge,
            state: definition.initialResilience > 0 ? 'Stable' : 'Staggered',
            downedUntilFrame: null,
            staggerCount: definition.initialResilience > 0 ? 0 : 1,
            downedCount: 0,
            lastControl: null,
            lastImpactFrame: null,
            lastRecoveryFrame: null,
            cycle: 1,
            modifiers: new Map()
        };
        this.entities.set(targetKey(targetId), entity);
        if (this.defaultTargetId === null || this.defaultTargetId === undefined) this.defaultTargetId = targetId;
        this.#record('EntityRegistered', {
            ...input,
            targetId,
            ruleId: definition.ruleId
        }, {
            maxResilience: definition.maxResilience,
            initialResilience: definition.initialResilience,
            initialExecutionGauge: definition.initialExecutionGauge,
            profileId: definition.profileId
        });
        return this.#publicEntity(entity);
    }

    /** Apply a control packet, independently of resilience damage. */
    applyControl(input = {}) {
        if (!isObject(input)) throw new TypeError('applyControl requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const definition = entity.definition;
        if (context.controlType === undefined || context.controlType === null
            || String(context.controlType).length === 0) {
            throw new TypeError('controlType is required.');
        }
        const controlLevel = nonNegative(context.controlLevel ?? 0, 'controlLevel');
        const effective = this.#effectiveModifiers(entity);
        const outcome = this.#controlOutcome({
            ...definition,
            superArmorLevel: effective.superArmorLevel
        }, controlLevel);
        const applied = outcome !== 'Immune';
        const downControl = this.#isDownControl(definition, context.controlType, controlLevel);
        let stateChange = null;
        if (outcome === 'Applied' && downControl) {
            const frame = finite(context.frame ?? 0, 'frame');
            entity.downedUntilFrame = definition.downedDurationTicks === null
                ? null
                : frame + definition.downedDurationTicks;
            stateChange = this.#transition(entity, 'Downed', {
                ...context,
                frame,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, 'ControlApplied');
        } else if (entity.state !== 'Downed' && entity.resilience <= 0 && outcome !== 'Immune') {
            stateChange = this.#transition(entity, 'Staggered', {
                ...context,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, 'ControlApplied');
        }
        const result = {
            frame: finite(context.frame ?? 0, 'frame'),
            targetId,
            controlType: context.controlType,
            controlLevel,
            outcome,
            status: outcome,
            applied,
            reduced: outcome === 'Reduced',
            immune: outcome === 'Immune',
            downed: outcome === 'Applied' && downControl,
            state: entity.state,
            superArmorLevel: effective.superArmorLevel,
            stateChange
        };
        entity.lastControl = result;
        const record = this.#record('ControlEvaluated', {
            ...context,
            frame: result.frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, result);
        result.record = record;
        if (this.onControl) result.callbackResult = this.onControl(clone(result));
        return result;
    }

    /** Applies an impact to the resilience bar and optionally a control packet. */
    applyImpact(input = {}) {
        if (!isObject(input)) throw new TypeError('applyImpact requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const definition = entity.definition;
        const amount = nonNegative(context.amount, 'impact amount');
        const effective = this.#effectiveModifiers(entity);
        const effectiveAmount = amount * effective.impactScalar;
        const frame = finite(context.frame ?? 0, 'frame');
        const before = entity.resilience;
        const after = Math.max(0, before - effectiveAmount);
        const actual = before - after;
        const discarded = effectiveAmount - actual;
        entity.resilience = after;
        entity.lastImpactFrame = frame;
        let stateChange = null;
        if (entity.state !== 'Downed' && after <= 0) {
            stateChange = this.#transition(entity, 'Staggered', {
                ...context,
                frame,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, 'ResilienceDepleted');
        }
        const record = this.#record('ImpactApplied', {
            ...context,
            frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, {
            controlType: context.controlType ?? null,
            controlLevel: context.controlLevel ?? null,
            before,
            requested: amount,
            effectiveRequested: effectiveAmount,
            impactScalar: effective.impactScalar,
            actual,
            discarded,
            after,
            maxResilience: definition.maxResilience,
            state: entity.state
        });
        let control = null;
        if (context.controlType !== undefined && context.controlType !== null) {
            control = this.applyControl({
                ...context,
                frame,
                targetId,
                reason: context.reason ?? 'ImpactControl',
                ruleId: context.ruleId ?? definition.ruleId
            });
        }
        return {
            frame,
            targetId,
            before,
            requested: amount,
            effectiveRequested: effectiveAmount,
            impactScalar: effective.impactScalar,
            actual,
            discarded,
            after: entity.resilience,
            state: entity.state,
            stateChange,
            control,
            record
        };
    }

    setModifier(input = {}) {
        if (!isObject(input)) throw new TypeError('setModifier requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const modifierId = context.modifierId ?? `resilience-modifier:${this.nextModifierId++}`;
        identifier(modifierId, 'modifierId');
        const sourceKey = context.sourceKey ?? context.buffInstanceId ?? modifierId;
        identifier(sourceKey, 'sourceKey');
        const modifier = {
            modifierId,
            sourceKey,
            sourceId: context.sourceId ?? null,
            ownerId: context.ownerId ?? null,
            buffInstanceId: context.buffInstanceId ?? null,
            ruleId: context.ruleId ?? null,
            superArmorLevel: context.superArmorLevel === undefined
                ? null
                : nonNegative(context.superArmorLevel, 'modifier superArmorLevel'),
            impactResistance: context.impactResistance === undefined
                ? null
                : nonNegative(context.impactResistance, 'modifier impactResistance'),
            impactScalar: context.impactScalar === undefined
                ? null
                : nonNegative(context.impactScalar, 'modifier impactScalar'),
            rawResilienceDecreaseFactor: context.rawResilienceDecreaseFactor ?? null,
            metadata: clone(context.metadata ?? {})
        };
        const existing = [...entity.modifiers.values()]
            .find(candidate => candidate.sourceKey === sourceKey);
        const before = existing ? clone(existing) : null;
        if (existing) entity.modifiers.delete(existing.modifierId);
        entity.modifiers.set(modifierId, modifier);
        const effective = this.#effectiveModifiers(entity);
        const record = this.#record('ResilienceModifierSet', {
            ...context,
            targetId
        }, {
            modifierId,
            sourceKey,
            before,
            requested: clone(modifier),
            actual: clone(modifier),
            discarded: 0,
            after: clone(modifier),
            effectiveSuperArmorLevel: effective.superArmorLevel,
            effectiveImpactScalar: effective.impactScalar
        });
        return { ...clone(modifier), effective, record };
    }

    removeModifier(input = {}) {
        if (!isObject(input)) throw new TypeError('removeModifier requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        if (context.modifierId === undefined && context.sourceKey === undefined
            && context.buffInstanceId === undefined && context.sourceId === undefined) {
            throw new TypeError('removeModifier requires modifierId, sourceKey, buffInstanceId or sourceId.');
        }
        const removed = [];
        for (const modifier of [...entity.modifiers.values()]) {
            if (context.modifierId !== undefined && modifier.modifierId !== context.modifierId) continue;
            if (context.sourceKey !== undefined && modifier.sourceKey !== context.sourceKey) continue;
            if (context.buffInstanceId !== undefined
                && modifier.buffInstanceId !== context.buffInstanceId) continue;
            if (context.sourceId !== undefined && modifier.sourceId !== context.sourceId) continue;
            entity.modifiers.delete(modifier.modifierId);
            removed.push(clone(modifier));
        }
        const effective = this.#effectiveModifiers(entity);
        const record = this.#record('ResilienceModifierRemoved', {
            ...context,
            targetId
        }, {
            before: removed,
            requested: clone(input),
            actual: removed.length,
            discarded: removed.length === 0 ? 1 : 0,
            after: [],
            effectiveSuperArmorLevel: effective.superArmorLevel,
            effectiveImpactScalar: effective.impactScalar
        });
        return { targetId, removed, effective, record };
    }

    /** Recovers the resilience bar by an explicit amount or one tick's rate. */
    recover(input = {}) {
        if (!isObject(input)) throw new TypeError('recover requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const definition = entity.definition;
        const amount = nonNegative(context.amount ?? definition.recoveryPerTick, 'recovery amount');
        const frame = finite(context.frame ?? 0, 'frame');
        const before = entity.resilience;
        const after = Math.min(definition.maxResilience, before + amount);
        const actual = after - before;
        const discarded = amount - actual;
        entity.resilience = after;
        entity.lastRecoveryFrame = frame;
        let stateChange = null;
        const expiryAllowsRevive = entity.downedUntilFrame !== null && frame >= entity.downedUntilFrame;
        const canRevive = context.revive === true
            || expiryAllowsRevive
            || definition.reviveOnRecovery;
        if (entity.state === 'Downed' && canRevive) {
            entity.downedUntilFrame = null;
            entity.cycle += 1;
            stateChange = this.#transition(entity, after > 0 ? 'Stable' : 'Staggered', {
                ...context,
                frame,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, 'RecoveredFromDowned');
        } else if (entity.state === 'Staggered' && after > 0) {
            entity.cycle += 1;
            stateChange = this.#transition(entity, 'Stable', {
                ...context,
                frame,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, 'ResilienceRecovered');
        }
        const record = this.#record('ResilienceRecovered', {
            ...context,
            frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, {
            before,
            requested: amount,
            actual,
            discarded,
            after,
            maxResilience: definition.maxResilience,
            state: entity.state
        });
        return {
            frame,
            targetId,
            before,
            requested: amount,
            actual,
            discarded,
            after,
            state: entity.state,
            stateChange,
            record
        };
    }

    /** Advances one or more discrete recovery ticks for one/all entities. */
    tick(input = {}) {
        const context = typeof input === 'number' ? { frame: input } : (isObject(input) ? input : {});
        const ticks = context.ticks === undefined ? 1 : finite(context.ticks, 'ticks');
        if (!Number.isInteger(ticks) || ticks < 1) throw new RangeError('ticks must be a positive integer.');
        const targetIds = context.targetIds !== undefined
            ? (Array.isArray(context.targetIds) ? context.targetIds : (() => { throw new TypeError('targetIds must be an array.'); })())
            : context.targetId !== undefined
                ? [context.targetId]
                : [...this.entities.values()].map(entity => entity.targetId);
        const baseFrame = finite(context.frame ?? 0, 'frame');
        const results = [];
        for (const targetIdValue of targetIds) {
            const targetId = this.#resolveTargetId(targetIdValue);
            const entity = this.#entity(targetId);
            for (let tickIndex = 0; tickIndex < ticks; tickIndex += 1) {
                const frame = baseFrame + tickIndex;
                results.push(this.recover({
                    ...context,
                    frame,
                    targetId,
                    amount: context.amount ?? entity.definition.recoveryPerTick,
                    reason: context.reason ?? 'RecoveryTick',
                    ruleId: context.ruleId ?? entity.definition.ruleId
                }));
            }
        }
        return { ticks, results, snapshots: targetIds.map(targetId => this.#publicEntity(this.#entity(targetId))) };
    }

    applyExecutionGauge(input = {}) {
        if (!isObject(input)) throw new TypeError('applyExecutionGauge requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const definition = entity.definition;
        const amount = nonNegative(context.amount, 'execution gauge amount');
        const before = entity.executionGauge;
        const after = Math.min(definition.executionGaugeMax, before + amount);
        const actual = after - before;
        const discarded = amount - actual;
        entity.executionGauge = after;
        const result = {
            frame: finite(context.frame ?? 0, 'frame'),
            targetId,
            before,
            requested: amount,
            actual,
            discarded,
            after,
            max: definition.executionGaugeMax,
            ready: definition.executionGaugeMax > 0 && after >= definition.executionGaugeMax
        };
        result.record = this.#record('ExecutionGaugeApplied', {
            ...context,
            frame: result.frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, result);
        return result;
    }

    consumeExecutionGate(input = {}) {
        if (!isObject(input)) throw new TypeError('consumeExecutionGate requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const entity = this.#entity(targetId);
        const definition = entity.definition;
        const frame = finite(context.frame ?? 0, 'frame');
        const ready = definition.executionGaugeMax > 0
            && entity.executionGauge >= definition.executionGaugeMax;
        if (!ready) {
            const record = this.#record('ExecutionGateRejected', {
                ...context,
                frame,
                targetId,
                ruleId: context.ruleId ?? definition.ruleId
            }, {
                consumed: false,
                before: entity.executionGauge,
                after: entity.executionGauge,
                max: definition.executionGaugeMax,
                state: entity.state
            });
            return {
                frame,
                targetId,
                consumed: false,
                before: entity.executionGauge,
                after: entity.executionGauge,
                max: definition.executionGaugeMax,
                state: entity.state,
                record
            };
        }
        const before = entity.executionGauge;
        entity.executionGauge = 0;
        entity.downedUntilFrame = definition.downedDurationTicks === null
            ? null
            : frame + definition.downedDurationTicks;
        const stateChange = this.#transition(entity, 'Downed', {
            ...context,
            frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, 'ExecutionGateConsumed');
        const result = {
            frame,
            targetId,
            consumed: true,
            before,
            after: entity.executionGauge,
            max: definition.executionGaugeMax,
            state: entity.state,
            stateChange
        };
        result.record = this.#record('ExecutionGateConsumed', {
            ...context,
            frame,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, result);
        return result;
    }

    snapshot(targetId = undefined) {
        if (targetId !== undefined && targetId !== null) return this.#publicEntity(this.#entity(targetId));
        const entities = [...this.entities.values()].map(entity => this.#publicEntity(entity));
        const result = {
            entities,
            byTargetId: Object.fromEntries(entities.map(entity => [String(entity.targetId), entity])),
            trace: this.trace.map(entry => clone(entry))
        };
        if (entities.length === 1) Object.assign(result, entities[0]);
        return result;
    }
}
