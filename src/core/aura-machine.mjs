/*
 * Definition driven aura ownership and target binding.
 *
 * An aura is intentionally kept separate from BuffMachine.  BuffMachine
 * models a buff's lifecycle on a target; this machine models the thing that
 * owns the target set and is responsible for removing that buff when the
 * source (or its owner) disappears.
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

function frameValue(value, label = 'frame') {
    const frame = Number(value ?? 0);
    if (!Number.isFinite(frame)) throw new TypeError(`${label} must be finite.`);
    return frame;
}

function clone(value) {
    if (value === undefined || value === null) return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Functions and other host values are intentionally retained below.
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

function mapDefinitions(definitions) {
    if (!definitions) return new Map();
    if (definitions instanceof Map) return new Map(definitions);
    if (Array.isArray(definitions)) {
        return new Map(definitions.map(definition => {
            if (!isObject(definition) || definition.auraId === undefined) {
                throw new TypeError('Aura definitions in an array require auraId.');
            }
            return [definition.auraId, definition];
        }));
    }
    if (!isObject(definitions)) throw new TypeError('Aura definitions must be a Map, array or object.');
    return new Map(Object.entries(definitions));
}

function mergeContext(input = {}, fallback = {}) {
    const nested = isObject(input.eventContext) ? input.eventContext : {};
    return { ...fallback, ...nested, ...input };
}

/**
 * Tracks an aura source and the targets currently inside its externally
 * supplied target set.  No spatial assumptions are made here: callers can
 * replace the target provider without changing this machine.
 */
export class AuraMachine {
    constructor({
        definitions = {},
        schedule = null,
        targetValidator = null,
        onApplyTarget = null,
        onRemoveTarget = null,
        onFinish = null,
        trace = []
    } = {}) {
        if (!Array.isArray(trace)) throw new TypeError('trace must be an array.');
        if (schedule !== null && typeof schedule !== 'function') {
            throw new TypeError('schedule must be a function or null.');
        }
        if (targetValidator !== null && typeof targetValidator !== 'function') {
            throw new TypeError('targetValidator must be a function or null.');
        }
        for (const callback of [onApplyTarget, onRemoveTarget, onFinish]) {
            if (callback !== null && typeof callback !== 'function') {
                throw new TypeError('Aura lifecycle callbacks must be functions or null.');
            }
        }
        this.definitions = mapDefinitions(definitions);
        this.schedule = schedule;
        this.targetValidator = targetValidator;
        this.onApplyTarget = onApplyTarget;
        this.onRemoveTarget = onRemoveTarget;
        this.onFinish = onFinish;
        this.trace = trace;
        this.instances = new Map();
        this.keyToInstance = new Map();
        this.nextInstanceNumber = 1;
    }

    #instanceKey(auraId, sourceId, ownerId) {
        // JSON is not used here so a string id containing JSON punctuation is
        // still unambiguous.  Symbols are not valid combat ids by design.
        return [typeof auraId, auraId, typeof sourceId, sourceId, typeof ownerId, ownerId]
            .map(value => String(value))
            .join('\u0000');
    }

    #definition(auraId, inputDefinition) {
        const definition = inputDefinition ?? this.definitions.get(auraId);
        if (definition === undefined) {
            throw new Error(`Missing aura definition for ${String(auraId)}.`);
        }
        if (!isObject(definition)) throw new TypeError(`Aura definition for ${String(auraId)} must be an object.`);
        return definition;
    }

    #validateTarget(targetId, context) {
        identifier(targetId, 'targetId');
        if (!this.targetValidator) return;
        const valid = this.targetValidator(targetId, context);
        if (!valid) throw new Error(`Unknown or invalid aura target: ${String(targetId)}.`);
    }

    #record(stage, input, instance, targetId = null, overrides = {}) {
        const context = mergeContext(input);
        const record = {
            frame: frameValue(context.frame ?? instance?.createdFrame ?? 0),
            stage,
            type: stage,
            auraId: instance?.auraId ?? context.auraId ?? null,
            auraInstanceId: instance?.instanceId ?? context.auraInstanceId ?? null,
            sourceId: instance?.sourceId ?? context.sourceId ?? null,
            ownerId: instance?.ownerId ?? context.ownerId ?? null,
            targetId: targetId ?? context.targetId ?? null,
            skillId: instance?.skillId ?? context.skillId ?? null,
            rootSkillId: instance?.rootSkillId ?? context.rootSkillId ?? null,
            castId: instance?.castId ?? context.castId ?? null,
            clockDomainId: instance?.clockDomainId ?? context.clockDomainId ?? null,
            reason: context.reason ?? stage,
            ruleId: context.ruleId ?? instance?.definition?.ruleId ?? null,
            ...overrides
        };
        this.trace.push(record);
        return record;
    }

    #callback(instance, targetId, stage, input, callback) {
        if (!callback) return undefined;
        const context = mergeContext(input, {
            frame: instance.createdFrame,
            eventType: stage,
            auraId: instance.auraId,
            auraInstanceId: instance.instanceId,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            targetId,
            skillId: instance.skillId,
            rootSkillId: instance.rootSkillId,
            castId: instance.castId,
            clockDomainId: instance.clockDomainId,
            ruleId: instance.definition.ruleId ?? null
        });
        // The callback receives a detached context.  A lifecycle action must
        // never be able to mutate the event context held by its parent.
        return callback(clone(context), clone(instance));
    }

    #callbackFor(instance, stage) {
        const definitionCallback = stage === 'TargetEntered'
            ? instance.definition.onApplyTarget
            : stage === 'TargetLeft'
                ? instance.definition.onRemoveTarget
                : instance.definition.onFinish;
        if (definitionCallback !== undefined && definitionCallback !== null
            && typeof definitionCallback !== 'function') {
            throw new TypeError(`${stage} callback for ${String(instance.auraId)} must be a function.`);
        }
        if (definitionCallback) return definitionCallback;
        if (stage === 'TargetEntered') return this.onApplyTarget;
        if (stage === 'TargetLeft') return this.onRemoveTarget;
        return this.onFinish;
    }

    #scheduleExpiry(instance) {
        if (!this.schedule || instance.expireFrame === null) return;
        const generation = instance.generation;
        this.schedule(instance.expireFrame, instance.definition.expiryPriority ?? 90, () => {
            const active = this.instances.get(instance.instanceId);
            if (!active || !active.active || active.generation !== generation) return;
            this.removeAura({
                frame: instance.expireFrame,
                auraInstanceId: instance.instanceId,
                reason: 'DurationExpired',
                ruleId: instance.definition.ruleId ?? null
            });
        }, `aura-expiry:${String(instance.instanceId)}`);
    }

    /**
     * Creates an aura.  The tuple (auraId, sourceId, ownerId) is unique while
     * active; use refreshTargets to update its target set.
     */
    createAura(input = {}) {
        if (!isObject(input)) throw new TypeError('createAura requires an object.');
        const context = mergeContext(input);
        const auraId = identifier(context.auraId, 'auraId');
        const sourceId = identifier(context.sourceId, 'sourceId');
        const ownerId = identifier(context.ownerId, 'ownerId');
        const frame = frameValue(context.frame ?? 0);
        const definition = this.#definition(auraId, context.definition);
        const key = this.#instanceKey(auraId, sourceId, ownerId);
        const existingId = this.keyToInstance.get(key);
        if (existingId !== undefined && this.instances.get(existingId)?.active) {
            throw new Error(`Aura tuple already exists: ${String(auraId)} / ${String(sourceId)} / ${String(ownerId)}.`);
        }

        const instanceId = context.auraInstanceId ?? `aura:${this.nextInstanceNumber++}`;
        identifier(instanceId, 'auraInstanceId');
        if (this.instances.has(instanceId)) throw new Error(`Duplicate auraInstanceId: ${String(instanceId)}.`);

        let durationTicks = null;
        if (definition.durationTicks !== undefined || context.durationTicks !== undefined) {
            durationTicks = Number(context.durationTicks ?? definition.durationTicks);
            if (!Number.isFinite(durationTicks) || durationTicks < 0) {
                throw new TypeError('Aura durationTicks must be a non-negative finite number.');
            }
        }
        const instance = {
            instanceId,
            auraId,
            sourceId,
            ownerId,
            skillId: context.skillId ?? null,
            rootSkillId: context.rootSkillId ?? null,
            castId: context.castId ?? null,
            clockDomainId: context.clockDomainId ?? null,
            // Keep lifecycle functions in the live definition.  Public
            // snapshots use clone(), which intentionally omits functions.
            definition: { ...definition },
            createdFrame: frame,
            durationTicks,
            expireFrame: durationTicks === null ? null : frame + durationTicks,
            generation: 1,
            active: true,
            targetIds: new Set()
        };
        this.instances.set(instanceId, instance);
        this.keyToInstance.set(key, instanceId);
        this.#record('AuraCreated', { ...context, frame }, instance, null, {
            durationTicks,
            expireFrame: instance.expireFrame
        });
        this.#scheduleExpiry(instance);

        if (context.targetIds !== undefined) {
            this.refreshTargets({
                frame,
                auraInstanceId: instanceId,
                targetIds: context.targetIds,
                sourceId,
                ownerId,
                skillId: instance.skillId,
                rootSkillId: instance.rootSkillId,
                castId: instance.castId,
                clockDomainId: instance.clockDomainId,
                reason: context.reason ?? 'InitialTargets',
                ruleId: context.ruleId ?? definition.ruleId ?? null
            });
        }
        return this.#publicInstance(instance);
    }

    #publicInstance(instance) {
        return {
            instanceId: instance.instanceId,
            auraId: instance.auraId,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            skillId: instance.skillId,
            rootSkillId: instance.rootSkillId,
            castId: instance.castId,
            clockDomainId: instance.clockDomainId,
            definition: clone(instance.definition),
            createdFrame: instance.createdFrame,
            durationTicks: instance.durationTicks,
            expireFrame: instance.expireFrame,
            generation: instance.generation,
            active: instance.active,
            targetIds: [...instance.targetIds]
        };
    }

    #getActiveInstance(auraInstanceId) {
        identifier(auraInstanceId, 'auraInstanceId');
        const instance = this.instances.get(auraInstanceId);
        if (!instance || !instance.active) throw new Error(`Unknown or inactive aura: ${String(auraInstanceId)}.`);
        return instance;
    }

    /**
     * Reconciles an externally calculated target list.  Enter and leave are
     * emitted in deterministic input order (leaves use the prior set order).
     */
    refreshTargets(input = {}) {
        if (!isObject(input)) throw new TypeError('refreshTargets requires an object.');
        const context = mergeContext(input);
        const instance = this.#getActiveInstance(context.auraInstanceId);
        if (!Array.isArray(context.targetIds)) throw new TypeError('targetIds must be an array.');
        const nextTargetIds = [];
        const seen = new Set();
        for (const targetId of context.targetIds) {
            this.#validateTarget(targetId, context);
            const key = `${typeof targetId}\u0000${String(targetId)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            nextTargetIds.push(targetId);
        }
        const next = new Set(nextTargetIds);
        const entered = nextTargetIds.filter(targetId => !instance.targetIds.has(targetId));
        const left = [...instance.targetIds].filter(targetId => !next.has(targetId));
        const callbackResults = [];
        for (const targetId of entered) {
            const event = this.#record('TargetEntered', context, instance, targetId, {
                previousTargetIds: [...instance.targetIds],
                currentTargetIds: [...next]
            });
            const callback = this.#callbackFor(instance, 'TargetEntered');
            const result = this.#callback(instance, targetId, 'TargetEntered', {
                ...context,
                frame: context.frame ?? instance.createdFrame,
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId,
                event
            }, callback);
            if (result !== undefined) callbackResults.push(result);
        }
        for (const targetId of left) {
            const event = this.#record('TargetLeft', context, instance, targetId, {
                previousTargetIds: [...instance.targetIds],
                currentTargetIds: [...next]
            });
            const callback = this.#callbackFor(instance, 'TargetLeft');
            const result = this.#callback(instance, targetId, 'TargetLeft', {
                ...context,
                frame: context.frame ?? instance.createdFrame,
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId,
                event
            }, callback);
            if (result !== undefined) callbackResults.push(result);
        }
        instance.targetIds = next;
        return {
            auraInstanceId: instance.instanceId,
            auraId: instance.auraId,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            entered,
            left,
            targetIds: [...next],
            callbackResults,
            instance: this.#publicInstance(instance)
        };
    }

    /** Finishes one aura and removes every bound target first. */
    removeAura(input = {}) {
        const context = isObject(input) ? mergeContext(input) : { auraInstanceId: input };
        let auraInstanceId = context.auraInstanceId;
        if (auraInstanceId === undefined || auraInstanceId === null) {
            const auraId = identifier(context.auraId, 'auraId');
            const sourceId = identifier(context.sourceId, 'sourceId');
            const ownerId = identifier(context.ownerId, 'ownerId');
            auraInstanceId = this.keyToInstance.get(this.#instanceKey(auraId, sourceId, ownerId));
            if (auraInstanceId === undefined
                || !this.instances.get(auraInstanceId)?.active) {
                return {
                    removed: false,
                    auraId,
                    sourceId,
                    ownerId,
                    left: [],
                    callbackResults: []
                };
            }
        }
        const instance = this.#getActiveInstance(auraInstanceId);
        const frame = frameValue(context.frame ?? instance.createdFrame);
        const left = [...instance.targetIds];
        const callbackResults = [];
        for (const targetId of left) {
            const event = this.#record('TargetLeft', { ...context, frame }, instance, targetId, {
                reason: context.reason ?? 'AuraFinished',
                previousTargetIds: [...instance.targetIds],
                currentTargetIds: []
            });
            const callback = this.#callbackFor(instance, 'TargetLeft');
            const result = this.#callback(instance, targetId, 'TargetLeft', {
                ...context,
                frame,
                event,
                sourceId: instance.sourceId,
                ownerId: instance.ownerId,
                targetId
            }, callback);
            if (result !== undefined) callbackResults.push(result);
        }
        instance.targetIds.clear();
        instance.active = false;
        instance.generation += 1;
        const finishEvent = this.#record('AuraFinished', { ...context, frame }, instance, null, {
            reason: context.reason ?? 'AuraFinished',
            targetIds: left
        });
        const finishCallback = this.#callbackFor(instance, 'AuraFinished');
        const finishResult = this.#callback(instance, null, 'AuraFinished', {
            ...context,
            frame,
            event: finishEvent,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            targetId: null
        }, finishCallback);
        if (finishResult !== undefined) callbackResults.push(finishResult);
        return {
            auraInstanceId: instance.instanceId,
            auraId: instance.auraId,
            sourceId: instance.sourceId,
            ownerId: instance.ownerId,
            left,
            callbackResults,
            instance: this.#publicInstance(instance)
        };
    }

    removeBySource(input = {}) {
        const context = isObject(input) ? mergeContext(input) : { sourceId: input };
        const sourceId = identifier(context.sourceId, 'sourceId');
        const instances = [...this.instances.values()].filter(instance => instance.active
            && instance.sourceId === sourceId);
        const removed = instances.map(instance => this.removeAura({
            ...context,
            frame: context.frame ?? instance.createdFrame,
            auraInstanceId: instance.instanceId,
            reason: context.reason ?? 'SourceRemoved'
        }));
        return { sourceId, removed, removedCount: removed.length };
    }

    removeByOwner(input = {}) {
        const context = isObject(input) ? mergeContext(input) : { ownerId: input };
        const ownerId = identifier(context.ownerId, 'ownerId');
        const instances = [...this.instances.values()].filter(instance => instance.active
            && instance.ownerId === ownerId);
        const removed = instances.map(instance => this.removeAura({
            ...context,
            frame: context.frame ?? instance.createdFrame,
            auraInstanceId: instance.instanceId,
            reason: context.reason ?? 'OwnerRemoved'
        }));
        return { ownerId, removed, removedCount: removed.length };
    }

    getAura(auraInstanceId) {
        const instance = this.#getActiveInstance(auraInstanceId);
        return this.#publicInstance(instance);
    }

    snapshot() {
        const instances = [...this.instances.values()].map(instance => this.#publicInstance(instance));
        return {
            instances,
            auras: instances,
            activeInstances: instances.filter(instance => instance.active),
            trace: this.trace.map(entry => clone(entry))
        };
    }
}
