import CombatContext, { cloneValue } from './combat-context.mjs';

const UNSUPPORTED = Symbol('unsupported-effect-value');

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    return value;
}

function readPath(value, path, fallback = undefined) {
    if (path === undefined || path === null || path === '') return value;
    const parts = Array.isArray(path) ? path : String(path).split('.');
    let current = value;
    for (const part of parts) {
        if (current === null || current === undefined
            || !Object.prototype.hasOwnProperty.call(Object(current), part)) {
            return fallback;
        }
        current = current[part];
    }
    return current;
}

function canonicalType(type) {
    if (typeof type !== 'string') return '';
    const value = type.trim();
    const lower = value.toLowerCase();
    const aliases = {
        all: 'All',
        any: 'Any',
        not: 'Not',
        compare: 'Compare',
        comparefloat: 'Compare',
        hastag: 'HasTag',
        hasbuff: 'HasBuff',
        resourcecompare: 'ResourceCompare',
        hpratiocompare: 'HpRatioCompare',
        eventtypeis: 'EventTypeIs',
        skilltypeis: 'SkillTypeIs',
        sequence: 'Sequence',
        ifelse: 'IfElseAction',
        ifelseaction: 'IfElseAction',
        modifyblackboard: 'ModifyBlackboard',
        modifyblackboardaction: 'ModifyBlackboard',
        modifydynamicblackboard: 'ModifyBlackboard',
        modifyentityblackboard: 'ModifyEntityBlackboard',
        calculateblackboard: 'CalculateBlackboard',
        simplecalcbbaction: 'CalculateBlackboard',
        assignblackboardvalues: 'AssignBlackboardValues',
        readskillsetting: 'AssignBlackboardValues',
        readskillsettingdata: 'AssignBlackboardValues',
        storeattributevalue: 'StoreAttributeValue',
        storebuffcount: 'StoreBuffCount',
        launchskillprogram: 'LaunchSkillProgram',
        scheduleintervalactions: 'ScheduleIntervalActions',
        findtargets: 'FindTargets',
        picktarget: 'PickTarget',
        foreachtarget: 'ForEachTarget',
        deactivateentity: 'DeactivateEntity',
        resolvetimedilation: 'ResolveTimeDilation',
        modifyattribute: 'ModifyAttribute',
        modifyattributeaction: 'ModifyAttribute',
        applytag: 'ApplyTag',
        applytagaction: 'ApplyTag',
        removetag: 'RemoveTag',
        removetagaction: 'RemoveTag',
        resourcechange: 'ResourceChange',
        resourcechangeaction: 'ResourceChange',
        obtaincostaction: 'ResourceChange',
        suppressresourcegain: 'SuppressResourceGain',
        resumeresourcegain: 'ResumeResourceGain',
        clearresource: 'ClearResource',
        suspendresourcerecovery: 'SuspendResourceRecovery',
        resumeresourcerecovery: 'ResumeResourceRecovery',
        heal: 'Heal',
        healaction: 'Heal',
        addshield: 'AddShield',
        addshieldaction: 'AddShield',
        damage: 'Damage',
        damageaction: 'Damage',
        applybuff: 'ApplyBuff',
        applybuffaction: 'ApplyBuff',
        createbuff: 'ApplyBuff',
        createbuffaction: 'ApplyBuff',
        finishbuff: 'FinishBuff',
        finishbuffaction: 'FinishBuff',
        applycombatstatus: 'ApplyCombatStatus',
        applyenemyinfliction: 'ApplyEnemyInfliction',
        applyinfliction: 'ApplyInfliction',
        applyinflictionaction: 'ApplyInfliction',
        spellinfliction: 'ApplyInfliction',
        applyimpact: 'ApplyImpact',
        applyimpactaction: 'ApplyImpact',
        setresiliencemodifier: 'SetResilienceModifier',
        removeresiliencemodifier: 'RemoveResilienceModifier',
        resolvedamagepacket: 'ResolveDamagePacket',
        applyeffectsource: 'ApplyEffectSource',
        removeeffectsource: 'RemoveEffectSource',
        applycontrol: 'ApplyControl',
        applycontrolaction: 'ApplyControl',
        recoverresilience: 'RecoverResilience',
        applyexecutiongauge: 'ApplyExecutionGauge',
        consumeexecutiongate: 'ConsumeExecutionGate',
        createaura: 'CreateAura',
        createauraaction: 'CreateAura',
        refreshauratargets: 'RefreshAuraTargets',
        removeaura: 'RemoveAura',
        createtimedmarker: 'CreateTimedMarker',
        timedmarkerexists: 'TimedMarkerExists',
        pauseclock: 'PauseClock',
        emitevent: 'EmitEvent',
        emiteventaction: 'EmitEvent',
        triggerspellbursteventaction: 'EmitEvent',
        constant: 'Constant',
        context: 'Context',
        blackboard: 'Blackboard',
        attribute: 'Attribute',
        resource: 'Resource',
        payload: 'Payload'
    };
    return aliases[lower] ?? value;
}

export function canonicalEffectType(type) {
    return canonicalType(type);
}

export const DEFAULT_EFFECT_ACTION_TYPES = Object.freeze([
    'Sequence', 'IfElseAction', 'ModifyBlackboard', 'CalculateBlackboard',
    'ModifyEntityBlackboard', 'FindTargets', 'PickTarget', 'ForEachTarget',
    'DeactivateEntity',
    'AssignBlackboardValues', 'StoreAttributeValue', 'StoreBuffCount', 'ModifyAttribute',
    'ApplyTag', 'RemoveTag',
    'ResourceChange', 'SuppressResourceGain', 'ResumeResourceGain', 'ClearResource',
    'SuspendResourceRecovery', 'ResumeResourceRecovery',
    'Heal', 'AddShield', 'Damage', 'ApplyBuff', 'FinishBuff', 'ApplyCombatStatus',
    'ApplyEnemyInfliction',
    'ApplyInfliction', 'ApplyImpact', 'ApplyControl', 'RecoverResilience',
    'LaunchSkillProgram', 'ScheduleIntervalActions', 'ResolveTimeDilation',
    'SetResilienceModifier', 'RemoveResilienceModifier', 'ResolveDamagePacket',
    'ApplyEffectSource', 'RemoveEffectSource',
    'ApplyExecutionGauge', 'ConsumeExecutionGate', 'CreateAura',
    'RefreshAuraTargets', 'RemoveAura', 'CreateTimedMarker',
    'PauseClock', 'EmitEvent'
]);

function compare(left, operator, right) {
    const op = String(operator ?? 'Equals').trim().toUpperCase();
    switch (op) {
        case 'GT':
        case '>':
            return left > right;
        case 'GE':
        case '>=':
            return left >= right;
        case 'LT':
        case '<':
            return left < right;
        case 'LE':
        case '<=':
            return left <= right;
        case 'EQUALS':
        case 'EQ':
        case '===':
        case '=':
            return left === right;
        case 'NE':
        case 'NOTEQUALS':
        case '!==':
        case '!=':
            return left !== right;
        case 'IN':
            return Array.isArray(right) && right.includes(left);
        case 'NOTIN':
            return Array.isArray(right) && !right.includes(left);
        case 'CONTAINS':
            return typeof right === 'string' || Array.isArray(right)
                ? right.includes(left)
                : false;
        default:
            return false;
    }
}

function handlerResultValue(result, defaultValue = false) {
    if (typeof result === 'boolean') return result;
    if (result === undefined || result === null) return defaultValue;
    if (isRecord(result)) {
        if (typeof result.passed === 'boolean') return result.passed;
        if (typeof result.result === 'boolean') return result.result;
        if (typeof result.value === 'boolean') return result.value;
    }
    return Boolean(result);
}

function applyHandlerBlackboardWrites(result, eventContext) {
    if (!isRecord(result?.blackboardWrites)) return;
    Object.assign(eventContext.blackboard, cloneValue(result.blackboardWrites));
}

/**
 * Data-driven condition and action interpreter.
 *
 * The runtime owns no resource, vitality, buff, reaction or resilience
 * implementation.  Those systems are connected by handlers, which keeps
 * this layer reusable for characters, enemies, summons and objects alike.
 */
export class EffectRuntime {
    constructor(options = {}, maybeHandlers = undefined) {
        // Accepting a context directly is convenient for small callers while
        // the documented form remains `new EffectRuntime({ context, handlers })`.
        const config = options && typeof options.createEventContext === 'function'
            ? { context: options, handlers: maybeHandlers }
            : options;
        if (!isRecord(config)) throw new TypeError('EffectRuntime options must be an object.');
        this.context = config.context ?? new CombatContext();
        for (const method of ['createEventContext', 'resolveEntityRef', 'hasTag', 'getAttribute']) {
            if (typeof this.context[method] !== 'function') {
                throw new TypeError(`EffectRuntime context must implement ${method}().`);
            }
        }
        if (config.trace !== undefined && !Array.isArray(config.trace)) {
            throw new TypeError('trace must be an array.');
        }
        this.trace = config.trace ?? [];
        this.nextTraceSequence = 1;
        this.nextTransactionSequence = 1;
        this.handlers = new Map();
        this.conditionHandlers = new Map();
        this.actionHandlers = new Map();
        const configuredHandlers = config.handlers;
        if (isRecord(configuredHandlers)
            && (configuredHandlers.actions !== undefined || configuredHandlers.conditions !== undefined)) {
            this.#loadHandlers(this.handlers, configuredHandlers.common ?? configuredHandlers.shared);
            this.#loadHandlers(this.actionHandlers, configuredHandlers.actions);
            this.#loadHandlers(this.conditionHandlers, configuredHandlers.conditions);
        } else {
            this.#loadHandlers(this.handlers, configuredHandlers);
        }
        this.#loadHandlers(this.conditionHandlers, config.conditionHandlers);
        this.#loadHandlers(this.actionHandlers, config.actionHandlers);
        // A single handler map is intentionally shared as a fallback so a
        // caller can register a delegate once for both a condition and action.
        for (const [type, handler] of this.handlers) {
            if (!this.conditionHandlers.has(type)) this.conditionHandlers.set(type, handler);
            if (!this.actionHandlers.has(type)) this.actionHandlers.set(type, handler);
        }
    }

    #loadHandlers(target, handlers) {
        if (handlers === undefined || handlers === null) return;
        if (!isRecord(handlers) && !(handlers instanceof Map)) {
            throw new TypeError('handlers must be an object or Map.');
        }
        const entries = handlers instanceof Map ? handlers.entries() : Object.entries(handlers);
        for (const [type, handler] of entries) {
            nonEmptyString(type, 'handler type');
            if (typeof handler !== 'function') throw new TypeError(`Handler for ${type} must be a function.`);
            target.set(canonicalType(type), handler);
        }
    }

    registerHandler(actionType, handler) {
        nonEmptyString(actionType, 'actionType');
        if (typeof handler !== 'function') throw new TypeError('handler must be a function.');
        const type = canonicalType(actionType);
        this.handlers.set(type, handler);
        this.actionHandlers.set(type, handler);
        // Conditions that use the same name (HasBuff, ResourceCompare, etc.)
        // can also use a handler registered through the public API.
        this.conditionHandlers.set(type, handler);
        return this;
    }

    registerConditionHandler(conditionType, handler) {
        nonEmptyString(conditionType, 'conditionType');
        if (typeof handler !== 'function') throw new TypeError('handler must be a function.');
        this.conditionHandlers.set(canonicalType(conditionType), handler);
        return this;
    }

    #findHandler(type, condition = false) {
        const key = canonicalType(type);
        const primary = condition ? this.conditionHandlers : this.actionHandlers;
        return primary.get(key) ?? this.handlers.get(key) ?? null;
    }

    #event(eventContext) {
        if (eventContext === undefined || eventContext === null) {
            return this.context.createEventContext({});
        }
        if (!isRecord(eventContext)) throw new TypeError('eventContext must be an object.');
        return this.context.createEventContext(eventContext);
    }

    #traceRecord(stage, type, eventContext, details = {}) {
        const sequence = this.nextTraceSequence++;
        const record = {
            eventId: `effect-event:${sequence}`,
            sequence,
            frame: eventContext?.frame ?? null,
            stage,
            type,
            sourceId: eventContext?.sourceId ?? null,
            ownerId: eventContext?.ownerId ?? null,
            targetId: eventContext?.targetId ?? null,
            skillId: eventContext?.skillId ?? null,
            rootSkillId: eventContext?.rootSkillId ?? null,
            castId: eventContext?.castId ?? null,
            buffInstanceId: eventContext?.buffInstanceId ?? null,
            clockDomainId: eventContext?.clockDomainId ?? null,
            transactionId: eventContext?.transactionId ?? null,
            parentEventId: eventContext?.parentEventId ?? null,
            carrierId: eventContext?.carrierId ?? eventContext?.targetId ?? null,
            damageSourceId: eventContext?.damageSourceId ?? eventContext?.sourceId ?? null,
            reason: details.reason ?? eventContext?.reason ?? stage,
            ruleId: details.ruleId ?? eventContext?.ruleId ?? null,
            ...cloneValue(details)
        };
        // Do not allow arbitrary handler output to hide the common envelope.
        record.frame = eventContext?.frame ?? null;
        record.sourceId = eventContext?.sourceId ?? null;
        record.ownerId = eventContext?.ownerId ?? null;
        record.targetId = eventContext?.targetId ?? null;
        record.skillId = eventContext?.skillId ?? null;
        record.rootSkillId = eventContext?.rootSkillId ?? null;
        record.castId = eventContext?.castId ?? null;
        record.buffInstanceId = eventContext?.buffInstanceId ?? null;
        record.clockDomainId = eventContext?.clockDomainId ?? null;
        record.transactionId = eventContext?.transactionId ?? null;
        record.parentEventId = eventContext?.parentEventId ?? null;
        record.carrierId = eventContext?.carrierId ?? eventContext?.targetId ?? null;
        record.damageSourceId = eventContext?.damageSourceId ?? eventContext?.sourceId ?? null;
        if (record.reason === undefined || record.reason === null) record.reason = stage;
        this.trace.push(record);
        return cloneValue(record);
    }

    evaluate(condition, eventContext) {
        if (!isRecord(condition)) throw new TypeError('condition must be an object.');
        const context = this.#event(eventContext);
        return this.#evaluateNode(condition, context);
    }

    #evaluateNode(condition, eventContext) {
        if (!isRecord(condition)) throw new TypeError('condition node must be an object.');
        const type = canonicalType(condition.type);
        if (!type) throw new TypeError('condition.type must be a non-empty string.');
        let passed = false;
        let reason = condition.reason ?? `Condition:${type}`;
        try {
            switch (type) {
                case 'All': {
                    const children = condition.conditions ?? condition.children ?? condition.items;
                    if (!Array.isArray(children)) throw new TypeError('All.conditions must be an array.');
                    const results = children.map(child => this.#evaluateNode(child, eventContext));
                    passed = results.every(Boolean);
                    break;
                }
                case 'Any': {
                    const children = condition.conditions ?? condition.children ?? condition.items;
                    if (!Array.isArray(children)) throw new TypeError('Any.conditions must be an array.');
                    const results = children.map(child => this.#evaluateNode(child, eventContext));
                    passed = results.some(Boolean);
                    break;
                }
                case 'Not': {
                    const child = condition.condition ?? condition.child ?? condition.operand;
                    if (!isRecord(child)) throw new TypeError('Not.condition must be an object.');
                    passed = !this.#evaluateNode(child, eventContext);
                    break;
                }
                case 'Compare': {
                    const left = this.#resolveValue(condition.left, eventContext);
                    const right = this.#resolveValue(condition.right, eventContext);
                    if (left === UNSUPPORTED || right === UNSUPPORTED) {
                        reason = 'UnsupportedCompareValue';
                        passed = false;
                    } else {
                        passed = compare(left, condition.operator, right);
                        if (!['GT', 'GE', 'LT', 'LE', 'EQ', 'NE', 'EQUALS', 'NOTEQUALS',
                            '>', '>=', '<', '<=', '=', '===', '!==', '!=', 'IN', 'NOTIN',
                            'CONTAINS'].includes(String(condition.operator ?? 'Equals').toUpperCase())) {
                            reason = 'UnsupportedCompareOperator';
                            passed = false;
                        }
                    }
                    break;
                }
                case 'HasTag': {
                    const ref = condition.entity ?? condition.entityRef ?? condition.target ?? 'Target';
                    const tag = condition.tag ?? condition.value;
                    nonEmptyString(tag, 'HasTag.tag');
                    const entity = this.#resolveEntityRef(ref, eventContext, true);
                    passed = entity !== null && this.context.hasTag(entity.id, tag);
                    break;
                }
                case 'HasBuff':
                case 'ResourceCompare':
                case 'HpRatioCompare': {
                    const handler = this.#findHandler(type, true);
                    if (!handler) {
                        reason = 'UnsupportedCondition';
                        passed = false;
                    } else {
                        const result = handler(cloneValue(condition), cloneValue(eventContext), this);
                        applyHandlerBlackboardWrites(result, eventContext);
                        passed = handlerResultValue(result, false);
                    }
                    break;
                }
                case 'EventTypeIs': {
                    const expected = condition.eventType ?? condition.value ?? condition.types;
                    const actual = eventContext.eventType;
                    passed = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
                    break;
                }
                case 'SkillTypeIs': {
                    const expected = condition.skillType ?? condition.value ?? condition.types;
                    const actual = eventContext.skillType
                        ?? readPath(eventContext.payload, 'skillType', undefined)
                        ?? readPath(eventContext.payload, 'skill.type', undefined);
                    passed = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
                    break;
                }
                default: {
                    const handler = this.#findHandler(type, true);
                    if (!handler) {
                        reason = 'UnsupportedCondition';
                        passed = false;
                    } else {
                        const result = handler(
                            cloneValue(condition),
                            cloneValue(eventContext),
                            this
                        );
                        applyHandlerBlackboardWrites(result, eventContext);
                        passed = handlerResultValue(result, false);
                    }
                }
            }
        } catch (error) {
            this.#traceRecord('ConditionError', type, eventContext, {
                condition: cloneValue(condition),
                passed: false,
                reason: error.message,
                ruleId: condition.ruleId ?? null
            });
            throw error;
        }
        this.#traceRecord('ConditionEvaluated', type, eventContext, {
            condition: cloneValue(condition),
            passed,
            reason,
            ruleId: condition.ruleId ?? null
        });
        return passed;
    }

    #resolveEntityRef(ref, eventContext, allowMissing = false) {
        if (!isRecord(ref) || ref.type !== 'TargetGroup') {
            return this.context.resolveEntityRef(ref, eventContext);
        }
        const groups = eventContext.blackboard?.__akeTargetGroups ?? {};
        if (!Object.prototype.hasOwnProperty.call(groups, ref.key)) {
            if (ref.fallback !== undefined && ref.fallback !== null) {
                return this.context.resolveEntityRef(ref.fallback, eventContext);
            }
            if (allowMissing) return null;
            throw new Error(`Target group ${String(ref.key)} is not available.`);
        }
        const candidates = Array.isArray(groups[ref.key]) ? groups[ref.key] : [];
        const index = Math.max(0, Math.trunc(Number(ref.index ?? 0)));
        const entityId = candidates[index];
        if (entityId === undefined || entityId === null) {
            if (!allowMissing && ref.fallback !== undefined && ref.fallback !== null) {
                return this.context.resolveEntityRef(ref.fallback, eventContext);
            }
            if (allowMissing) return null;
            throw new Error(`Target group ${String(ref.key)} has no entity at index ${index}.`);
        }
        return this.context.resolveEntityRef(entityId, eventContext);
    }

    #resolveValue(value, eventContext) {
        if (value === null || value === undefined
            || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            if (value.startsWith('$')) return readPath(eventContext.blackboard, value.slice(1));
            if (value.startsWith('Blackboard.')) return readPath(eventContext.blackboard, value.slice(12));
            if (value.startsWith('Payload.')) return readPath(eventContext.payload, value.slice(8));
            return value;
        }
        if (typeof value === 'function') return value(cloneValue(eventContext), this);
        if (!isRecord(value)) return cloneValue(value);
        if (value.useBlackboardKey && value.blackboardKey) {
            return readPath(eventContext.blackboard, value.blackboardKey, value.value);
        }
        const type = canonicalType(value.type ?? value.kind ?? value.sourceType);
        if (type === 'Constant') return cloneValue(value.value);
        if (type === 'Blackboard') {
            const key = value.key ?? value.path ?? value.name;
            return readPath(eventContext.blackboard, key, value.default);
        }
        if (type === 'Payload') {
            const key = value.key ?? value.path ?? value.name;
            return readPath(eventContext.payload, key, value.default);
        }
        if (type === 'Context') {
            const key = value.key ?? value.path ?? value.name;
            return readPath(eventContext, key, value.default);
        }
        if (type === 'Attribute') {
            const ref = value.entity ?? value.entityRef ?? value.target ?? value.entityId ?? 'Target';
            const entity = this.#resolveEntityRef(ref, eventContext, true);
            if (entity === null) return UNSUPPORTED;
            const key = value.key ?? value.attribute ?? value.name;
            nonEmptyString(key, 'Attribute value key');
            return this.context.getAttribute(entity.id, key);
        }
        const expressionType = String(type).toLowerCase();
        if (['add', 'multiply', 'subtract', 'divide', 'min', 'max'].includes(expressionType)) {
            const operands = value.values ?? value.operands ?? [value.left, value.right];
            if (!Array.isArray(operands) || operands.length === 0) return UNSUPPORTED;
            const resolved = operands.map(operand => this.#resolveValue(operand, eventContext));
            if (resolved.some(operand => operand === UNSUPPORTED)) return UNSUPPORTED;
            const numbers = resolved.map((operand, index) => {
                const number = Number(operand);
                finiteNumber(number, `${type} operand ${index}`);
                return number;
            });
            switch (expressionType) {
                case 'add': return numbers.reduce((sum, number) => sum + number, 0);
                case 'multiply': return numbers.reduce((product, number) => product * number, 1);
                case 'subtract':
                    return numbers.slice(1).reduce((result, number) => result - number, numbers[0]);
                case 'divide':
                    return numbers.slice(1).reduce((result, number) => {
                        if (number === 0) throw new RangeError('Divide expression divisor must not be zero.');
                        return result / number;
                    }, numbers[0]);
                case 'min': return Math.min(...numbers);
                case 'max': return Math.max(...numbers);
                default: return UNSUPPORTED;
            }
        }
        if (type === 'Resource') {
            const handler = this.#findHandler('ResolveResource', true)
                ?? this.#findHandler('ResourceValue', true)
                ?? this.#findHandler('GetResource', true);
            if (!handler) return UNSUPPORTED;
            const result = handler(cloneValue(value), cloneValue(eventContext), this);
            if (isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
            return result;
        }
        // Shorthand descriptors are useful in hand-authored definitions and
        // remain unambiguous because they carry a source/key field.
        if (value.blackboard !== undefined) {
            return readPath(eventContext.blackboard, value.blackboard, value.default);
        }
        if (value.payload !== undefined) {
            return readPath(eventContext.payload, value.payload, value.default);
        }
        if (value.attribute !== undefined) {
            const ref = value.entity ?? value.target ?? 'Target';
            const entity = this.#resolveEntityRef(ref, eventContext, true);
            if (entity === null) return UNSUPPORTED;
            return this.context.getAttribute(entity.id, value.attribute);
        }
        if (Object.prototype.hasOwnProperty.call(value, 'value')) return cloneValue(value.value);
        return cloneValue(value);
    }

    execute(actionOrArray, eventContext) {
        return this.executeTransaction(actionOrArray, eventContext).result;
    }

    /**
     * Execute one isolated action transaction and expose its final context.
     * Blackboard writes are visible to later actions in the same transaction,
     * while the caller's input object remains untouched.
     */
    executeTransaction(actionOrArray, eventContext) {
        const context = this.#event(eventContext);
        if (context.transactionId === undefined || context.transactionId === null) {
            context.transactionId = `effect-tx:${this.nextTransactionSequence++}`;
        }
        const isArray = Array.isArray(actionOrArray);
        const actions = isArray ? actionOrArray : [actionOrArray];
        if (actions.length === 0) {
            return {
                result: isArray ? [] : undefined,
                eventContext: cloneValue(context)
            };
        }
        const results = actions.map(action => this.#executeAction(action, context));
        return {
            result: isArray ? results : results[0],
            eventContext: cloneValue(context)
        };
    }

    #executeAction(action, eventContext) {
        if (!isRecord(action)) throw new TypeError('action must be an object.');
        const type = canonicalType(action.type);
        if (!type) throw new TypeError('action.type must be a non-empty string.');
        const reason = action.reason ?? `Effect:${type}`;
        const actionContext = {
            ...cloneValue(eventContext),
            reason,
            ruleId: action.ruleId ?? eventContext.ruleId ?? null
        };
        switch (type) {
            case 'Sequence': {
                const children = action.actions ?? action.effects ?? action.children ?? action.steps;
                if (!Array.isArray(children)) throw new TypeError('Sequence.actions must be an array.');
                const results = children.map(child => this.#executeAction(child, eventContext));
                this.#traceRecord('ActionExecuted', type, eventContext, {
                    action: cloneValue(action),
                    count: children.length,
                    result: 'Sequence',
                    reason,
                    ruleId: action.ruleId ?? null
                });
                return results;
            }
            case 'IfElseAction': {
                const conditions = action.conditions
                    ?? (action.condition ? [action.condition] : []);
                if (!Array.isArray(conditions)) throw new TypeError('IfElseAction.conditions must be an array.');
                const passed = conditions.every(condition => this.#evaluateNode(condition, eventContext));
                const branch = passed
                    ? (action.success ?? action.then ?? action.ifTrue ?? [])
                    : (action.failure ?? action.else ?? action.ifFalse ?? []);
                const branchResults = this.#executeBranch(branch, eventContext);
                this.#traceRecord('ActionBranch', type, eventContext, {
                    action: cloneValue(action),
                    passed,
                    branch: passed ? 'success' : 'failure',
                    reason,
                    ruleId: action.ruleId ?? null
                });
                return branchResults;
            }
            case 'ModifyBlackboard': {
                const key = action.key ?? action.blackboardKey ?? action.targetKey;
                nonEmptyString(key, 'ModifyBlackboard.key');
                const operation = String(action.operation ?? action.mode ?? 'Assign').toLowerCase();
                const value = this.#resolveValue(action.value ?? action.amount ?? action.delta ?? 0, eventContext);
                if (value === UNSUPPORTED) {
                    return this.#unsupportedAction(type, action, eventContext, 'Unsupported value.');
                }
                const before = cloneValue(eventContext.blackboard[key]);
                let after;
                if (operation === 'assign' || operation === 'set') {
                    after = cloneValue(value);
                } else {
                    const left = Number(before ?? 0);
                    const right = Number(value);
                    finiteNumber(left, `Blackboard.${key}`);
                    finiteNumber(right, 'ModifyBlackboard value');
                    switch (operation) {
                        case 'add': case 'increase': after = left + right; break;
                        case 'subtract': case 'decrease': after = left - right; break;
                        case 'multiply': case 'mul': after = left * right; break;
                        case 'divide': case 'div':
                            if (right === 0) throw new RangeError('ModifyBlackboard divide value must not be zero.');
                            after = left / right;
                            break;
                        case 'min': after = Math.min(left, right); break;
                        case 'max': after = Math.max(left, right); break;
                        default:
                            return this.#unsupportedAction(
                                type,
                                action,
                                eventContext,
                                `Unsupported operation: ${operation}`
                            );
                    }
                }
                eventContext.blackboard[key] = after;
                return this.#actionResult(type, action, eventContext, {
                    before,
                    requested: cloneValue(value),
                    actual: cloneValue(after),
                    discarded: 0,
                    after: cloneValue(after),
                    key,
                    operation
                }, reason);
            }
            case 'CalculateBlackboard': {
                const key = action.key ?? action.blackboardKey ?? action.targetKey;
                nonEmptyString(key, 'CalculateBlackboard.key');
                const left = Number(this.#resolveValue(action.left ?? action.value1 ?? 0, eventContext));
                const right = Number(this.#resolveValue(action.right ?? action.value2 ?? 0, eventContext));
                finiteNumber(left, 'CalculateBlackboard left');
                finiteNumber(right, 'CalculateBlackboard right');
                const operation = String(action.operation ?? 'Add').toLowerCase();
                let after;
                switch (operation) {
                    case 'add': after = left + right; break;
                    case 'subtract': after = left - right; break;
                    case 'multiply': case 'mul': after = left * right; break;
                    case 'divide': case 'div':
                        if (right === 0) throw new RangeError('CalculateBlackboard divisor must not be zero.');
                        after = left / right;
                        break;
                    case 'min': after = Math.min(left, right); break;
                    case 'max': after = Math.max(left, right); break;
                    default:
                        return this.#unsupportedAction(
                            type,
                            action,
                            eventContext,
                            `Unsupported operation: ${operation}`
                        );
                }
                const before = cloneValue(eventContext.blackboard[key]);
                eventContext.blackboard[key] = after;
                return this.#actionResult(type, action, eventContext, {
                    before,
                    requested: { left, operation, right },
                    actual: after,
                    discarded: 0,
                    after,
                    key,
                    operation
                }, reason);
            }
            case 'AssignBlackboardValues': {
                const entries = action.entries ?? action.values ?? action.assignments ?? [];
                if (!Array.isArray(entries)) {
                    throw new TypeError('AssignBlackboardValues.entries must be an array.');
                }
                const changes = [];
                for (const entry of entries) {
                    const key = entry.key ?? entry.storeKey ?? entry.targetKey;
                    nonEmptyString(key, 'AssignBlackboardValues entry key');
                    const value = this.#resolveValue(entry.value, eventContext);
                    const before = cloneValue(eventContext.blackboard[key]);
                    eventContext.blackboard[key] = cloneValue(value);
                    changes.push({ key, before, after: cloneValue(value) });
                }
                return this.#actionResult(type, action, eventContext, {
                    before: Object.fromEntries(changes.map(change => [change.key, change.before])),
                    requested: Object.fromEntries(changes.map(change => [change.key, change.after])),
                    actual: changes.length,
                    discarded: 0,
                    after: Object.fromEntries(changes.map(change => [change.key, change.after])),
                    changes
                }, reason);
            }
            case 'StoreAttributeValue': {
                const ref = action.entity ?? action.entityRef ?? action.target ?? action.targetRef ?? 'Target';
                const entity = this.#resolveEntityRef(ref, eventContext);
                const attribute = action.attribute ?? action.attributeType;
                nonEmptyString(attribute, 'StoreAttributeValue.attribute');
                const key = action.key ?? action.storeKey;
                nonEmptyString(key, 'StoreAttributeValue.key');
                const attributeValue = Number(this.context.getAttribute(entity.id, attribute) ?? 0);
                const divisor = Number(this.#resolveValue(action.divisor ?? action.divisorValue ?? 1, eventContext));
                const multiplier = Number(this.#resolveValue(action.multiplier ?? action.multiplierValue ?? 1, eventContext));
                const base = Number(this.#resolveValue(action.baseValue ?? 0, eventContext));
                finiteNumber(attributeValue, `attribute ${attribute}`);
                finiteNumber(divisor, 'StoreAttributeValue divisor');
                finiteNumber(multiplier, 'StoreAttributeValue multiplier');
                finiteNumber(base, 'StoreAttributeValue baseValue');
                if (divisor === 0) throw new RangeError('StoreAttributeValue divisor must not be zero.');
                const calculated = base + attributeValue / divisor * multiplier;
                const after = action.useFloor ? Math.floor(calculated) : calculated;
                const before = cloneValue(eventContext.blackboard[key]);
                eventContext.blackboard[key] = after;
                return this.#actionResult(type, action, eventContext, {
                    before,
                    requested: calculated,
                    actual: after,
                    discarded: calculated - after,
                    after,
                    key,
                    attribute,
                    entityId: entity.id
                }, reason);
            }
            case 'ModifyAttribute': {
                const entityId = this.#resolveActionEntity(action, eventContext);
                const key = action.attribute ?? action.attributeKey ?? action.key;
                nonEmptyString(key, 'ModifyAttribute.attribute');
                const operation = String(action.operation ?? action.mode ?? 'Add').toLowerCase();
                const rawValue = action.value ?? action.amount ?? action.delta ?? 0;
                const value = this.#resolveValue(rawValue, eventContext);
                if (value === UNSUPPORTED) return this.#unsupportedAction(type, action, eventContext, 'Unsupported value.');
                const numericValue = finiteNumber(Number(value), 'ModifyAttribute value');
                let record;
                if (operation === 'assign' || operation === 'set') {
                    record = this.context.setAttribute(entityId, key, numericValue, actionContext);
                } else {
                    const before = this.context.getAttribute(entityId, key);
                    finiteNumber(before ?? 0, `attribute ${key}`);
                    let delta = numericValue;
                    if (operation === 'subtract') delta = -numericValue;
                    if (operation === 'multiply' || operation === 'mul') delta = (before ?? 0) * numericValue - (before ?? 0);
                    if (operation === 'divide' || operation === 'div') {
                        if (numericValue === 0) throw new RangeError('ModifyAttribute divide value must not be zero.');
                        delta = (before ?? 0) / numericValue - (before ?? 0);
                    }
                    if (!['add', 'increase', 'subtract', 'decrease', 'multiply', 'mul', 'divide', 'div'].includes(operation)) {
                        return this.#unsupportedAction(type, action, eventContext, `Unsupported operation: ${operation}`);
                    }
                    record = this.context.modifyAttribute(entityId, key, delta, actionContext);
                }
                return this.#actionResult(type, action, eventContext, record, reason);
            }
            case 'ApplyTag':
            case 'RemoveTag': {
                const entityId = this.#resolveActionEntity(action, eventContext);
                const rawTag = action.tag ?? action.value;
                const tag = this.#resolveValue(rawTag, eventContext);
                nonEmptyString(tag, `${type}.tag`);
                const record = type === 'ApplyTag'
                    ? this.context.addTag(entityId, tag, actionContext)
                    : this.context.removeTag(entityId, tag, actionContext);
                return this.#actionResult(type, action, eventContext, record, reason);
            }
            case 'ResourceChange':
            case 'Heal':
            case 'AddShield':
            case 'Damage':
            case 'ApplyBuff':
            case 'FinishBuff':
            case 'ApplyCombatStatus':
            case 'ApplyEnemyInfliction':
            case 'ApplyInfliction':
            case 'ApplyImpact':
            case 'SetResilienceModifier':
            case 'RemoveResilienceModifier':
            case 'ResolveDamagePacket':
            case 'ApplyEffectSource':
            case 'RemoveEffectSource':
            case 'ApplyControl':
            case 'RecoverResilience':
            case 'ApplyExecutionGauge':
            case 'ConsumeExecutionGate':
            case 'CreateAura':
            case 'RefreshAuraTargets':
            case 'RemoveAura':
            case 'PauseClock':
            case 'EmitEvent': {
                return this.#executeDelegated(type, action, eventContext, reason);
            }
            default:
                return this.#findHandler(type, false)
                    ? this.#executeDelegated(type, action, eventContext, reason)
                    : this.#unsupportedAction(type, action, eventContext, 'Unsupported action type.');
        }
    }

    #executeBranch(branch, eventContext) {
        if (branch === undefined || branch === null) return [];
        if (Array.isArray(branch)) return branch.map(action => this.#executeAction(action, eventContext));
        return [this.#executeAction(branch, eventContext)];
    }

    #resolveActionEntity(action, eventContext) {
        const ref = action.entity
            ?? action.entityRef
            ?? action.target
            ?? action.targetRef
            ?? action.targetId
            ?? 'Target';
        return this.#resolveEntityRef(ref, eventContext).id;
    }

    #executeDelegated(type, action, eventContext, reason) {
        const handler = this.#findHandler(type, false);
        if (!handler) return this.#unsupportedAction(type, action, eventContext, 'No handler registered.');
        // The transaction context is already detached from the caller.  Action
        // handlers receive that live copy so intentional Blackboard writes are
        // visible to later actions in the same sequence.
        const result = handler(cloneValue(action), eventContext, this);
        const normalized = result === undefined ? { status: 'Applied', type } : result;
        const details = {
            action: cloneValue(action),
            result: cloneValue(normalized),
            reason,
            ruleId: action.ruleId ?? null
        };
        if (isRecord(normalized)) {
            for (const key of ['before', 'requested', 'actual', 'discarded', 'after']) {
                if (Object.prototype.hasOwnProperty.call(normalized, key)) details[key] = cloneValue(normalized[key]);
            }
        }
        this.#traceRecord('ActionDelegated', type, eventContext, details);
        return normalized;
    }

    #actionResult(type, action, eventContext, result, reason) {
        this.#traceRecord('ActionExecuted', type, eventContext, {
            action: cloneValue(action),
            result: cloneValue(result),
            reason,
            ruleId: action.ruleId ?? null,
            ...(isRecord(result)
                ? Object.fromEntries(['before', 'requested', 'actual', 'discarded', 'after']
                    .filter(key => Object.prototype.hasOwnProperty.call(result, key))
                    .map(key => [key, cloneValue(result[key])]))
                : {})
        });
        return result;
    }

    #unsupportedAction(type, action, eventContext, reason) {
        const result = { status: 'Unsupported', type, reason };
        this.#traceRecord('ActionUnsupported', type, eventContext, {
            action: cloneValue(action),
            result: cloneValue(result),
            reason,
            ruleId: action.ruleId ?? null
        });
        return result;
    }

    snapshot() {
        return {
            trace: cloneValue(this.trace),
            context: typeof this.context.snapshot === 'function' ? this.context.snapshot() : null
        };
    }
}

export { UNSUPPORTED };

export default EffectRuntime;
