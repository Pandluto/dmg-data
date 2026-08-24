/*
 * Generic elemental infliction/reaction state.
 *
 * The machine deliberately knows nothing about a character or an enemy.  A
 * target is only an id and every reaction rule comes from a definition.  The
 * caller owns execution of onTriggerActions; onReaction is an observation /
 * integration hook and receives the complete source context.
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
            // Functions are not cloneable; the fallback below retains data.
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

function elementKey(element) {
    return `${typeof element}\u0000${String(element)}`;
}

function mergeContext(input = {}, fallback = {}) {
    const nested = isObject(input.eventContext) ? input.eventContext : {};
    return { ...fallback, ...nested, ...input };
}

function definitionsMap(definitions) {
    if (!definitions) return new Map();
    if (definitions instanceof Map) return new Map(definitions);
    if (Array.isArray(definitions)) {
        return new Map(definitions.map(definition => {
            if (!isObject(definition) || definition.element === undefined) {
                throw new TypeError('Reaction definitions in an array require element.');
            }
            return [definition.element, definition];
        }));
    }
    if (!isObject(definitions)) throw new TypeError('Reaction definitions must be a Map, array or object.');
    return new Map(Object.entries(definitions).map(([key, definition]) => {
        if (!isObject(definition)) throw new TypeError(`Reaction definition for ${key} must be an object.`);
        return [definition.element ?? key, { ...definition, element: definition.element ?? key }];
    }));
}

function normalizeConsumePolicy(policy, definition) {
    let mode = 'threshold';
    let amount = null;
    let maxTriggersPerInput = definition.maxTriggersPerInput;
    let triggerPolicy = definition.triggerPolicy ?? null;

    if (typeof policy === 'string') {
        mode = policy;
    } else if (typeof policy === 'number') {
        mode = 'fixed';
        amount = policy;
    } else if (isObject(policy)) {
        mode = policy.mode ?? policy.type ?? policy.policy ?? mode;
        amount = policy.amount ?? policy.value ?? null;
        maxTriggersPerInput = policy.maxTriggersPerInput ?? policy.maxTriggers ?? maxTriggersPerInput;
        triggerPolicy = policy.triggerPolicy ?? policy.trigger ?? triggerPolicy;
    } else if (policy !== undefined && policy !== null) {
        throw new TypeError('consumePolicy must be a string, number or object.');
    }

    let normalizedMode = String(mode).toLowerCase().replace(/[ _-]/g, '');
    if (normalizedMode === 'consumeall' || normalizedMode === 'consume') normalizedMode = 'all';
    if (normalizedMode === 'noconsume' || normalizedMode === 'keep' || normalizedMode === 'retain') {
        normalizedMode = 'none';
    }
    if (!['threshold', 'consumethreshold', 'fixed', 'amount', 'all', 'reset', 'none', 'preserve', 'nochange']
        .includes(normalizedMode)) {
        throw new Error(`Unsupported reaction consumePolicy: ${String(mode)}.`);
    }
    if (amount !== null) amount = nonNegative(amount, 'consumePolicy.amount');
    if (maxTriggersPerInput !== undefined && maxTriggersPerInput !== null) {
        maxTriggersPerInput = finite(maxTriggersPerInput, 'maxTriggersPerInput');
        if (maxTriggersPerInput < 1 || !Number.isInteger(maxTriggersPerInput)) {
            throw new RangeError('maxTriggersPerInput must be a positive integer.');
        }
    }
    const policyName = triggerPolicy === null || triggerPolicy === undefined
        ? ''
        : String(triggerPolicy).toLowerCase().replace(/[ _-]/g, '');
    if (['single', 'one', 'once', 'oneperinput'].includes(policyName)) maxTriggersPerInput = 1;
    if (['all', 'multiple', 'repeat', 'allthresholds'].includes(policyName)) {
        maxTriggersPerInput = null;
    }
    if (maxTriggersPerInput === null && ['none', 'preserve', 'nochange'].includes(normalizedMode)) {
        // Without consumption, repeating a threshold in one call would be an
        // infinite loop.  One trigger is the safe, explicit interpretation.
        maxTriggersPerInput = 1;
    }
    return {
        mode: normalizedMode,
        amount,
        maxTriggersPerInput,
        triggerPolicy: triggerPolicy ?? null
    };
}

function normalizeDefinition(element, definition) {
    if (!isObject(definition)) throw new TypeError(`Reaction definition for ${String(element)} must be an object.`);
    const normalizedElement = definition.element ?? element;
    identifier(normalizedElement, 'reaction element');
    const threshold = nonNegative(definition.threshold, `${String(normalizedElement)}.threshold`);
    if (threshold <= 0) throw new RangeError(`${String(normalizedElement)}.threshold must be greater than zero.`);
    const maxBuildup = nonNegative(
        definition.maxBuildup ?? threshold,
        `${String(normalizedElement)}.maxBuildup`
    );
    if (maxBuildup < threshold) {
        throw new RangeError(`${String(normalizedElement)}.maxBuildup must be at least threshold.`);
    }
    const cooldownTicks = nonNegative(
        definition.cooldownTicks ?? 0,
        `${String(normalizedElement)}.cooldownTicks`
    );
    const reactionId = definition.reactionId ?? `${String(normalizedElement)}:reaction`;
    identifier(reactionId, 'reactionId');
    const consumePolicy = normalizeConsumePolicy(definition.consumePolicy, definition);
    return {
        ...definition,
        element: normalizedElement,
        threshold,
        maxBuildup,
        cooldownTicks,
        reactionId,
        consumePolicy,
        initialBuildup: nonNegative(definition.initialBuildup ?? 0, `${String(normalizedElement)}.initialBuildup`),
        ruleId: definition.ruleId ?? null
    };
}

/**
 * Stores independent buildup and cooldown state for every target/element
 * pair.  Reactions are definitions, not hard-coded elemental branches.
 */
export class ReactionMachine {
    constructor({
        definitions = {},
        onReaction = null,
        clockDomainResolver = null,
        clockDomains = null,
        targetValidator = null,
        trace = [],
        defaultTargetId = null,
        targetId = null,
        entityId = null
    } = {}) {
        if (!Array.isArray(trace)) throw new TypeError('trace must be an array.');
        if (onReaction !== null && typeof onReaction !== 'function') {
            throw new TypeError('onReaction must be a function or null.');
        }
        if (clockDomainResolver !== null && typeof clockDomainResolver !== 'function') {
            throw new TypeError('clockDomainResolver must be a function or null.');
        }
        if (targetValidator !== null && typeof targetValidator !== 'function') {
            throw new TypeError('targetValidator must be a function or null.');
        }
        this.definitions = new Map();
        for (const [element, definition] of definitionsMap(definitions)) {
            const normalized = normalizeDefinition(element, definition);
            this.definitions.set(normalized.element, normalized);
        }
        this.onReaction = onReaction;
        this.clockDomainResolver = clockDomainResolver;
        this.clockDomains = clockDomains;
        this.targetValidator = targetValidator;
        this.trace = trace;
        this.targets = new Map();
        this.defaultTargetId = defaultTargetId ?? targetId ?? entityId;
        if (defaultTargetId !== null && defaultTargetId !== undefined) identifier(defaultTargetId, 'defaultTargetId');
    }

    #targetKey(targetId) {
        return elementKey(targetId);
    }

    #resolveTargetId(value) {
        if (value !== undefined && value !== null) return identifier(value, 'targetId');
        if (this.defaultTargetId !== null && this.defaultTargetId !== undefined) return this.defaultTargetId;
        if (this.targets.size === 1) return this.targets.keys().next().value;
        throw new TypeError('targetId is required when multiple reaction targets exist.');
    }

    #target(targetId) {
        const id = this.#resolveTargetId(targetId);
        const target = this.targets.get(this.#targetKey(id));
        if (!target) throw new Error(`Unknown reaction target: ${String(id)}.`);
        return target;
    }

    #definition(element, inlineDefinition = undefined) {
        const normalizedElement = identifier(element, 'element');
        if (inlineDefinition !== undefined) return normalizeDefinition(normalizedElement, inlineDefinition);
        const definition = this.definitions.get(normalizedElement)
            ?? this.definitions.get(String(normalizedElement));
        if (!definition) throw new Error(`Missing reaction definition for element ${String(normalizedElement)}.`);
        return definition;
    }

    #validateTarget(targetId, context) {
        if (!this.targetValidator) return;
        if (!this.targetValidator(targetId, context)) {
            throw new Error(`Unknown or invalid reaction target: ${String(targetId)}.`);
        }
    }

    #record(stage, context = {}, overrides = {}) {
        const frame = finite(context.frame ?? 0, 'frame');
        const record = {
            frame,
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

    #state(target, definition) {
        const key = elementKey(definition.element);
        let state = target.elements.get(key);
        if (!state) {
            state = {
                element: definition.element,
                buildup: Math.min(definition.maxBuildup, definition.initialBuildup),
                attached: false,
                attachedState: null,
                cooldownUntil: null,
                cooldownDomainId: null,
                lastReactionFrame: null,
                triggerCount: 0
            };
            target.elements.set(key, state);
        }
        return state;
    }

    #publicState(state, definition) {
        return {
            element: state.element,
            buildup: state.buildup,
            maxBuildup: definition.maxBuildup,
            threshold: definition.threshold,
            attached: state.attached,
            attachedState: clone(state.attachedState),
            cooldownUntil: state.cooldownUntil,
            cooldownDomainId: state.cooldownDomainId,
            lastReactionFrame: state.lastReactionFrame,
            triggerCount: state.triggerCount,
            reactionId: definition.reactionId
        };
    }

    #domainEntry(domainId) {
        if (!this.clockDomains || domainId === null || domainId === undefined) return null;
        // ClockDomainManager exposes routed localFrameAt(domainId, frame)
        // instead of publishing its internal LocalClock instances.
        if (typeof this.clockDomains.localFrameAt === 'function') {
            return {
                localFrameAt: frame => this.clockDomains.localFrameAt(domainId, frame)
            };
        }
        if (this.clockDomains instanceof Map) return this.clockDomains.get(domainId) ?? null;
        if (isObject(this.clockDomains)) return this.clockDomains[domainId] ?? null;
        return null;
    }

    #clock(definition, context, targetId) {
        const frame = finite(context.frame ?? 0, 'frame');
        const resolver = definition.clockDomainResolver ?? this.clockDomainResolver;
        let resolved = definition.clockDomainId ?? context.clockDomainId ?? null;
        if (resolver) {
            resolved = resolver(clone({ ...context, targetId, element: definition.element }), {
                targetId,
                element: definition.element,
                definition: clone(definition)
            });
        }
        if (typeof resolved === 'number') {
            return { localFrame: finite(resolved, 'resolved local frame'), domainId: null };
        }
        if (isObject(resolved)) {
            const domainId = resolved.domainId ?? resolved.id ?? null;
            const localFrame = resolved.localFrame ?? resolved.frame;
            if (localFrame !== undefined) {
                return { localFrame: finite(localFrame, 'resolved local frame'), domainId };
            }
            resolved = domainId;
        }
        const domainId = resolved ?? null;
        const domain = this.#domainEntry(domainId);
        if (domain && typeof domain.localFrameAt === 'function') {
            return {
                localFrame: finite(domain.localFrameAt(frame), 'domain local frame'),
                domainId
            };
        }
        if (typeof domain === 'function') {
            return { localFrame: finite(domain(frame), 'domain local frame'), domainId };
        }
        return { localFrame: frame, domainId };
    }

    #cooldownReady(definition, state, context, targetId) {
        if (state.cooldownUntil === null) return true;
        const now = this.#clock(definition, context, targetId);
        return now.localFrame >= state.cooldownUntil;
    }

    /** Register a target; state for definitions is created lazily. */
    registerTarget(input = {}) {
        const options = isObject(input) ? input : { targetId: input };
        const targetId = this.#resolveTargetId(options.targetId ?? options.id);
        if (this.targets.has(this.#targetKey(targetId))) {
            throw new Error(`Duplicate reaction target: ${String(targetId)}.`);
        }
        this.#validateTarget(targetId, options);
        const target = {
            targetId,
            metadata: clone(options.metadata ?? {}),
            elements: new Map()
        };
        this.targets.set(this.#targetKey(targetId), target);
        if (this.defaultTargetId === null || this.defaultTargetId === undefined) {
            this.defaultTargetId = targetId;
        }
        const initial = options.initialBuildup ?? {};
        if (!isObject(initial)) throw new TypeError('initialBuildup must be an object.');
        for (const [element, value] of Object.entries(initial)) {
            const definition = this.#definition(element);
            const state = this.#state(target, definition);
            state.buildup = Math.min(definition.maxBuildup, nonNegative(value, `${element}.initialBuildup`));
        }
        this.#record('TargetRegistered', { ...options, targetId }, {
            metadata: clone(target.metadata)
        });
        return this.snapshot(targetId);
    }

    /**
     * Sets the attached marker independently from buildup.  This is useful
     * for an externally applied aura or a persistent elemental state.
     */
    setAttachedState(input = {}) {
        if (!isObject(input)) throw new TypeError('setAttachedState requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const target = this.#target(targetId);
        const definition = this.#definition(context.element, context.definition);
        const state = this.#state(target, definition);
        const attachedState = context.attachedState
            ?? context.state
            ?? { sourceId: context.sourceId ?? null, ownerId: context.ownerId ?? null };
        state.attached = context.attached !== false;
        state.attachedState = state.attached ? clone(attachedState) : null;
        if (context.buildup !== undefined) {
            state.buildup = Math.min(definition.maxBuildup, nonNegative(context.buildup, 'buildup'));
        }
        const record = this.#record('AttachedStateSet', {
            ...context,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, {
            element: definition.element,
            attached: state.attached,
            attachedState: clone(state.attachedState),
            buildup: state.buildup
        });
        return { record, state: this.#publicState(state, definition) };
    }

    clearAttachedState(input = {}) {
        if (!isObject(input)) throw new TypeError('clearAttachedState requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const target = this.#target(targetId);
        const definition = this.#definition(context.element, context.definition);
        const state = this.#state(target, definition);
        const previous = clone(state.attachedState);
        state.attached = false;
        state.attachedState = null;
        const record = this.#record('AttachedStateCleared', {
            ...context,
            targetId,
            ruleId: context.ruleId ?? definition.ruleId
        }, { element: definition.element, previous });
        return { record, previous, state: this.#publicState(state, definition) };
    }

    /** Returns whether a threshold is ready and its local cooldown has ended. */
    canTrigger(input = {}, elementArg = undefined, frameArg = undefined) {
        const context = isObject(input)
            ? mergeContext(input)
            : { targetId: input, element: elementArg, frame: frameArg };
        const targetId = this.#resolveTargetId(context.targetId);
        const target = this.#target(targetId);
        const definition = this.#definition(context.element, context.definition);
        const state = this.#state(target, definition);
        return state.buildup >= definition.threshold
            && this.#cooldownReady(definition, state, { ...context, targetId }, targetId);
    }

    #consumeAmount(definition, state) {
        const policy = definition.consumePolicy;
        switch (policy.mode) {
            case 'all':
            case 'reset':
                return state.buildup;
            case 'fixed':
            case 'amount':
                return policy.amount ?? definition.threshold;
            case 'none':
            case 'preserve':
            case 'nochange':
                return 0;
            case 'threshold':
            case 'consumethreshold':
            default:
                return definition.threshold;
        }
    }

    #maxTriggers(definition) {
        if (definition.consumePolicy.maxTriggersPerInput !== null
            && definition.consumePolicy.maxTriggersPerInput !== undefined) {
            return definition.consumePolicy.maxTriggersPerInput;
        }
        return Number.POSITIVE_INFINITY;
    }

    #triggerActions(definition, triggerContext, state) {
        if (typeof definition.onTriggerActions === 'function') {
            return definition.onTriggerActions(clone(triggerContext), clone(state));
        }
        return clone(definition.onTriggerActions ?? []);
    }

    #reactionCallbacks(definition, payload) {
        const callbacks = [];
        if (typeof definition.onReaction === 'function') callbacks.push(definition.onReaction);
        if (this.onReaction && this.onReaction !== definition.onReaction) callbacks.push(this.onReaction);
        const results = [];
        for (const callback of callbacks) results.push(callback(clone(payload)));
        return results;
    }

    /**
     * Adds one infliction packet.  A packet may cross several thresholds; the
     * definition's consumePolicy/triggerPolicy controls how many triggers are
     * emitted.  Cooldown is evaluated in the definition's clock domain.
     */
    applyInfliction(input = {}) {
        if (!isObject(input)) throw new TypeError('applyInfliction requires an object.');
        const context = mergeContext(input);
        const targetId = this.#resolveTargetId(context.targetId);
        const target = this.#target(targetId);
        const definition = this.#definition(context.element, context.definition);
        // Inline definitions are still promoted into the registry so later
        // snapshot/cooldown calls can resolve the same rule by element.
        if (context.definition !== undefined) this.definitions.set(definition.element, definition);
        const state = this.#state(target, definition);
        const amount = nonNegative(context.amount ?? context.inflictionAmount, 'infliction amount');
        const frame = finite(context.frame ?? 0, 'frame');
        const before = state.buildup;
        const uncapped = before + amount;
        const after = Math.min(definition.maxBuildup, uncapped);
        const actual = after - before;
        const discarded = amount - actual;
        state.buildup = after;
        if (actual > 0) state.attached = true;
        const baseContext = {
            ...context,
            frame,
            targetId,
            element: definition.element,
            ruleId: context.ruleId ?? definition.ruleId
        };
        const inflictionRecord = this.#record('InflictionApplied', baseContext, {
            element: definition.element,
            before,
            requested: amount,
            actual,
            discarded,
            after,
            maxBuildup: definition.maxBuildup,
            threshold: definition.threshold,
            reactionId: definition.reactionId
        });

        const triggered = [];
        const suppressed = [];
        const maxTriggers = this.#maxTriggers(definition);
        while (state.buildup >= definition.threshold && triggered.length < maxTriggers) {
            if (!this.#cooldownReady(definition, state, baseContext, targetId)) {
                const cooldownRecord = this.#record('ReactionOnCooldown', baseContext, {
                    element: definition.element,
                    buildup: state.buildup,
                    cooldownUntil: state.cooldownUntil,
                    cooldownDomainId: state.cooldownDomainId,
                    reactionId: definition.reactionId
                });
                suppressed.push(cooldownRecord);
                break;
            }
            const clock = this.#clock(definition, baseContext, targetId);
            const beforeConsume = state.buildup;
            const consume = Math.min(beforeConsume, this.#consumeAmount(definition, state));
            const afterConsume = Math.max(0, beforeConsume - consume);
            state.buildup = afterConsume;
            const cooldownUntil = definition.cooldownTicks > 0
                ? clock.localFrame + definition.cooldownTicks
                : null;
            state.cooldownUntil = cooldownUntil;
            state.cooldownDomainId = clock.domainId;
            state.lastReactionFrame = frame;
            state.triggerCount += 1;
            const triggerContext = {
                ...baseContext,
                clockDomainId: clock.domainId,
                reactionId: definition.reactionId,
                consumed: consume,
                buildupBefore: beforeConsume,
                buildupAfter: afterConsume
            };
            const actions = this.#triggerActions(definition, triggerContext, state);
            const payload = {
                ...clone(triggerContext),
                stage: 'ReactionTriggered',
                type: 'ReactionTriggered',
                targetId,
                element: definition.element,
                reactionId: definition.reactionId,
                threshold: definition.threshold,
                consumed: consume,
                before: beforeConsume,
                after: afterConsume,
                cooldownUntil,
                cooldownDomainId: clock.domainId,
                igniteType: definition.igniteType ?? null,
                reactionEventTypes: clone(definition.reactionEventTypes ?? []),
                onTriggerActions: actions
            };
            const reactionRecord = this.#record('ReactionTriggered', triggerContext, payload);
            const callbackResults = this.#reactionCallbacks(definition, {
                ...payload,
                record: reactionRecord,
                context: clone(triggerContext),
                derivedActions: clone(actions)
            });
            const reaction = {
                ...payload,
                record: reactionRecord,
                callbackResults,
                derivedActions: clone(actions)
            };
            triggered.push(reaction);
            // A positive cooldown necessarily prevents a second trigger in
            // this packet; zero cooldown can drain every configured threshold.
            if (definition.cooldownTicks > 0) break;
            if (consume <= 0) break;
        }
        const result = {
            frame,
            targetId,
            element: definition.element,
            reactionId: definition.reactionId,
            before,
            requested: amount,
            actual,
            discarded,
            after: state.buildup,
            maxBuildup: definition.maxBuildup,
            threshold: definition.threshold,
            inflictionRecord,
            triggered,
            reactions: triggered,
            suppressed,
            state: this.#publicState(state, definition)
        };
        return result;
    }

    snapshot(targetId = undefined) {
        if (targetId !== undefined && targetId !== null) {
            const target = this.#target(targetId);
            const elements = [...target.elements.values()].map(state => {
                const definition = this.#definition(state.element);
                return this.#publicState(state, definition);
            });
            return {
                targetId: target.targetId,
                metadata: clone(target.metadata),
                elements,
                elementStates: elements,
                attached: elements.filter(state => state.attached).map(state => state.element)
            };
        }
        const targets = [...this.targets.values()].map(target => this.snapshot(target.targetId));
        const result = {
            targets,
            byTargetId: Object.fromEntries(targets.map(target => [String(target.targetId), target])),
            trace: this.trace.map(entry => clone(entry))
        };
        if (targets.length === 1) Object.assign(result, targets[0]);
        return result;
    }
}
