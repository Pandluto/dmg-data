import { evaluateAttributeComponent } from './attribute.mjs';
import { cloneValue } from './combat-context.mjs';

const SUPPORTED_ZONES = new Set([
    'BaseAddition', 'BaseMultiplier', 'BaseFinalAddition', 'BaseFinalMultiplier',
    'Addition', 'Multiplier', 'FinalAddition', 'FinalMultiplier'
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(label + ' must be a non-empty string or finite number.');
    }
    return value;
}

function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(label + ' must be finite.');
    return number;
}

function typedKey(value) {
    return typeof value + '\u0000' + String(value);
}

function statKey(targetId, attribute) {
    return typedKey(targetId) + '\u0000' + attribute;
}

function emptyAttributeComponent(rawValue = 0) {
    return {
        rawValue,
        baseAddition: 0,
        baseMultiplier: 1,
        baseFinalAddition: 0,
        baseFinalMultiplier: 1,
        addition: 0,
        multiplier: 1,
        finalAddition: 0,
        finalMultiplier: 1
    };
}

function sourceCategory(sourceType) {
    const normalized = String(sourceType ?? 'Effect').toLowerCase();
    if (normalized.includes('talent')) return 'Talent';
    if (normalized.includes('potential')) return 'Potential';
    if (normalized.includes('weapon')) return 'Weapon';
    if (normalized.includes('set')) return 'EquipmentSet';
    if (normalized.includes('equipment')) return 'Equipment';
    if (normalized.includes('enemy')) return 'EnemyStatus';
    if (normalized.includes('reaction')) return 'Reaction';
    if (normalized.includes('skill')) return 'Skill';
    if (normalized.includes('status')) return 'StatusEffect';
    if (normalized.includes('global')) return 'Global';
    return 'System';
}

function resolveModifierOperand(rawValue, modifier) {
    return modifier.metadata?.operandSemantics === 'rate-to-factor'
        ? 1 + rawValue
        : rawValue;
}

function normalizeAttributeModifiers(rawModifiers = []) {
    if (!Array.isArray(rawModifiers)) {
        throw new TypeError('modifiers must be an array.');
    }
    return rawModifiers.map((modifier, index) => {
        if (!isRecord(modifier)) {
            throw new TypeError('modifiers[' + index + '] must be an object.');
        }
        const attribute = modifier.attribute ?? modifier.attributeType;
        if (typeof attribute !== 'string' || attribute.length === 0) {
            throw new TypeError('modifiers[' + index + '].attribute is required.');
        }
        const zone = modifier.zone ?? modifier.formulaItem ?? 'Addition';
        if (!SUPPORTED_ZONES.has(zone)) {
            throw new Error('Unsupported attribute modifier zone: ' + zone + '.');
        }
        return {
            modifierIndex: index,
            attribute,
            zone,
            value: cloneValue(modifier.value ?? modifier.param ?? 0),
            metadata: cloneValue(modifier.metadata ?? {})
        };
    });
}

/**
 * Reversible source registry for equipment, talents, potentials, contracts
 * and status effects.
 */
export class EffectSourceRegistry {
    constructor({
        context,
        resolveValue = value => value,
        evaluateCondition = null
    } = {}) {
        if (!context || typeof context.getAttribute !== 'function'
            || typeof context.setAttribute !== 'function') {
            throw new TypeError('EffectSourceRegistry requires a CombatContext-compatible context.');
        }
        if (typeof resolveValue !== 'function') throw new TypeError('resolveValue must be a function.');
        if (evaluateCondition !== null && typeof evaluateCondition !== 'function') {
            throw new TypeError('evaluateCondition must be a function or null.');
        }
        this.context = context;
        this.resolveValue = resolveValue;
        this.evaluateCondition = evaluateCondition;
        this.sources = new Map();
        // Static AKE layers are already folded into the entity's attribute
        // components at assembly time. Keep their provenance in a separate
        // collection so snapshots can explain the value without applying the
        // same modifier a second time.
        this.baselineSources = new Map();
        this.baseAttributes = new Map();
        this.attributeComponents = new Map();
        this.tagReferences = new Map();
        this.trace = [];
    }

    registerAttributeComponents(targetId, components = {}) {
        identifier(targetId, 'attribute-component targetId');
        if (!isRecord(components)) {
            throw new TypeError('attribute components must be an object.');
        }
        for (const [attribute, input] of Object.entries(components)) {
            if (!isRecord(input)) {
                throw new TypeError(`attribute component ${attribute} must be an object.`);
            }
            const evaluation = evaluateAttributeComponent(input);
            const component = {
                rawValue: evaluation.rawValue,
                baseAddition: evaluation.baseAddition,
                baseMultiplier: evaluation.baseMultiplier,
                baseFinalAddition: evaluation.baseFinalAddition,
                baseFinalMultiplier: evaluation.baseFinalMultiplier,
                addition: evaluation.addition,
                multiplier: evaluation.multiplier,
                finalAddition: evaluation.finalAddition,
                finalMultiplier: evaluation.finalMultiplier
            };
            this.attributeComponents.set(statKey(targetId, attribute), {
                targetId,
                attribute,
                component
            });
        }
        return this.attributeComponentsFor(targetId);
    }

    attributeComponentsFor(targetId) {
        return [...this.attributeComponents.values()]
            .filter(entry => entry.targetId === targetId)
            .map(cloneValue);
    }

    registerBaselineSources(targetId, inputs = []) {
        identifier(targetId, 'baseline source targetId');
        if (!Array.isArray(inputs)) {
            throw new TypeError('baseline sources must be an array.');
        }
        const registered = [];
        for (const [index, input] of inputs.entries()) {
            if (!isRecord(input)) {
                throw new TypeError(`baselineSources[${index}] must be an object.`);
            }
            const key = identifier(
                input.sourceKey ?? `ake-baseline:${String(targetId)}:${index}`,
                `baselineSources[${index}].sourceKey`
            );
            const sourceTargetId = identifier(
                input.targetId ?? targetId,
                `baselineSources[${index}].targetId`
            );
            const source = {
                sourceKey: key,
                sourceType: input.sourceType ?? 'ConfiguredAttribute',
                sourceCategory: sourceCategory(
                    input.sourceCategory ?? input.sourceType ?? 'ConfiguredAttribute'
                ),
                sourceId: input.sourceId ?? null,
                ownerId: input.ownerId ?? null,
                carrierId: input.carrierId ?? sourceTargetId,
                targetId: sourceTargetId,
                damageSourceId: input.damageSourceId ?? input.sourceId ?? null,
                buffInstanceId: input.buffInstanceId ?? null,
                buffId: input.buffId ?? null,
                sourceSkillId: input.sourceSkillId ?? null,
                castId: input.castId ?? null,
                transactionId: input.transactionId ?? null,
                ruleId: input.ruleId ?? null,
                blackboard: cloneValue(input.blackboard ?? {}),
                payload: cloneValue(input.payload ?? {}),
                modifiers: normalizeAttributeModifiers(input.modifiers ?? []),
                damageModifiers: [],
                tags: [],
                metadata: {
                    ...cloneValue(input.metadata ?? {}),
                    baseline: true,
                    preApplied: true
                },
                appliedFrame: Number(input.frame ?? 0),
                baseline: true,
                preApplied: true
            };
            this.baselineSources.set(typedKey(key), source);
            registered.push(cloneValue(source));
        }
        return registered;
    }

    apply(input = {}, eventContext = {}) {
        if (!isRecord(input)) throw new TypeError('EffectSourceRegistry.apply requires an object.');
        const key = identifier(
            input.sourceKey ?? input.buffInstanceId ?? eventContext.buffInstanceId,
            'sourceKey'
        );
        const targetId = identifier(input.targetId ?? eventContext.targetId, 'targetId');
        if (this.sources.has(typedKey(key))) {
            this.remove({ sourceKey: key, frame: input.frame }, eventContext);
        }
        const modifiers = normalizeAttributeModifiers(input.modifiers ?? []);
        const tags = [...new Set((input.tags ?? []).map(tag => String(tag)))];
        const damageModifiers = (input.damageModifiers ?? []).map((modifier, index) => {
            if (!isRecord(modifier)) {
                throw new TypeError('damageModifiers[' + index + '] must be an object.');
            }
            return {
                modifierIndex: index,
                side: modifier.side ?? null,
                damageTypes: cloneValue(modifier.damageTypes ?? []),
                conditions: cloneValue(modifier.conditions ?? []),
                conditionsExecutable: modifier.conditionsExecutable !== false,
                processors: (modifier.processors ?? []).map((processor, processorIndex) => ({
                    processorIndex,
                    side: processor.side ?? modifier.side ?? null,
                    zoneName: processor.zoneName ?? 'NormalCalcZone',
                    addition: cloneValue(processor.addition ?? 0)
                }))
            };
        });
        const source = {
            sourceKey: key,
            sourceType: input.sourceType ?? 'Effect',
            sourceCategory: sourceCategory(
                input.sourceCategory ?? input.sourceType ?? 'Effect'
            ),
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            carrierId: input.carrierId ?? targetId,
            targetId,
            damageSourceId: input.damageSourceId
                ?? eventContext.damageSourceId
                ?? input.sourceId
                ?? eventContext.sourceId
                ?? null,
            buffInstanceId: input.buffInstanceId ?? eventContext.buffInstanceId ?? null,
            buffId: input.buffId ?? eventContext.payload?.buffId ?? null,
            sourceSkillId: input.sourceSkillId ?? eventContext.skillId ?? null,
            castId: input.castId ?? eventContext.castId ?? null,
            transactionId: input.transactionId ?? eventContext.transactionId ?? null,
            ruleId: input.ruleId ?? eventContext.ruleId ?? null,
            blackboard: cloneValue(eventContext.blackboard ?? {}),
            payload: cloneValue(eventContext.payload ?? {}),
            modifiers,
            damageModifiers,
            tags,
            metadata: cloneValue(input.metadata ?? {}),
            appliedFrame: Number(input.frame ?? eventContext.frame ?? 0)
        };
        for (const modifier of modifiers) {
            const keyForAttribute = statKey(targetId, modifier.attribute);
            if (!this.baseAttributes.has(keyForAttribute)) {
                const registered = this.attributeComponents.get(keyForAttribute);
                this.baseAttributes.set(keyForAttribute, {
                    targetId,
                    attribute: modifier.attribute,
                    value: finite(
                        this.context.getAttribute(targetId, modifier.attribute) ?? 0,
                        'base attribute ' + modifier.attribute
                    ),
                    component: registered
                        ? cloneValue(registered.component)
                        : emptyAttributeComponent(finite(
                            this.context.getAttribute(targetId, modifier.attribute) ?? 0,
                            'base attribute ' + modifier.attribute
                        ))
                });
            }
        }
        this.sources.set(typedKey(key), source);
        for (const tag of tags) this.#addTagReference(targetId, tag, eventContext);
        const attributes = [...new Set(modifiers.map(modifier => modifier.attribute))];
        const recomputed = attributes.map(attribute =>
            this.#recompute(targetId, attribute, eventContext)
        );
        const record = this.#record('EffectSourceApplied', source, eventContext, {
            before: null,
            requested: cloneValue(input),
            actual: {
                modifiers: modifiers.length,
                damageModifiers: damageModifiers.length,
                tags: tags.length
            },
            discarded: 0,
            after: { recomputed, tags }
        });
        return { source: cloneValue(source), recomputed, record };
    }

    remove(selector = {}, eventContext = {}) {
        if (!isRecord(selector)) throw new TypeError('EffectSourceRegistry.remove requires an object.');
        const matches = [...this.sources.values()].filter(source =>
            (selector.sourceKey === undefined || source.sourceKey === selector.sourceKey)
            && (selector.sourceId === undefined || source.sourceId === selector.sourceId)
            && (selector.ownerId === undefined || source.ownerId === selector.ownerId)
            && (selector.targetId === undefined || source.targetId === selector.targetId)
            && (selector.buffInstanceId === undefined
                || source.buffInstanceId === selector.buffInstanceId)
            && (selector.castId === undefined || source.castId === selector.castId)
            && (selector.sourceType === undefined || source.sourceType === selector.sourceType)
        );
        const affected = new Map();
        for (const source of matches) {
            this.sources.delete(typedKey(source.sourceKey));
            for (const tag of source.tags) {
                this.#removeTagReference(source.targetId, tag, eventContext);
            }
            for (const modifier of source.modifiers) {
                affected.set(statKey(source.targetId, modifier.attribute), {
                    targetId: source.targetId,
                    attribute: modifier.attribute
                });
            }
        }
        const recomputed = [...affected.values()].map(({ targetId, attribute }) =>
            this.#recompute(targetId, attribute, eventContext)
        );
        const record = this.#record('EffectSourceRemoved', {
            sourceKey: selector.sourceKey ?? null,
            sourceType: selector.sourceType ?? 'Effect',
            sourceId: selector.sourceId ?? eventContext.sourceId ?? null,
            ownerId: selector.ownerId ?? eventContext.ownerId ?? null,
            targetId: selector.targetId ?? eventContext.targetId ?? null,
            buffInstanceId: selector.buffInstanceId ?? eventContext.buffInstanceId ?? null,
            castId: selector.castId ?? eventContext.castId ?? null,
            ruleId: selector.ruleId ?? eventContext.ruleId ?? null,
            appliedFrame: Number(selector.frame ?? eventContext.frame ?? 0)
        }, eventContext, {
            before: matches.map(cloneValue),
            requested: cloneValue(selector),
            actual: matches.length,
            discarded: matches.length === 0 ? 1 : 0,
            after: recomputed
        });
        return { removed: matches.map(cloneValue), recomputed, record };
    }

    removeBySource(sourceId, frame = 0) {
        return this.remove({ sourceId, frame });
    }

    removeByOwner(ownerId, frame = 0) {
        return this.remove({ ownerId, frame });
    }

    damageZone({ targetId, side, damageType, attackerId, defenderId }, eventContext = {}) {
        identifier(targetId, 'damage-zone targetId');
        attackerId ??= eventContext.sourceId ?? null;
        defenderId ??= eventContext.targetId ?? null;
        const zones = new Map();
        const contributions = [];
        for (const source of this.sources.values()) {
            for (const modifier of source.damageModifiers ?? []) {
                const activationTargetId = modifier.side === 'Attacker'
                    ? attackerId
                    : modifier.side === 'Defender'
                        ? defenderId
                        : targetId;
                if (source.targetId !== activationTargetId) continue;
                if (modifier.damageTypes.length > 0
                    && !modifier.damageTypes.includes(damageType)) continue;
                if (!modifier.conditionsExecutable) continue;
                const modifierContext = {
                    ...eventContext,
                    blackboard: source.blackboard,
                    payload: {
                        ...cloneValue(source.payload),
                        ...cloneValue(eventContext.payload ?? {}),
                        damageType
                    },
                    effectSourceTargetId: targetId
                };
                if ((modifier.conditions ?? []).length > 0
                    && (!this.evaluateCondition || !modifier.conditions.every(condition =>
                        this.evaluateCondition(condition, modifierContext)
                    ))) continue;
                for (const processor of modifier.processors) {
                    const effectiveSide = processor.side ?? modifier.side;
                    if (effectiveSide && side && effectiveSide !== side) continue;
                    const addition = finite(
                        this.resolveValue(processor.addition, modifierContext),
                        `damage zone ${processor.zoneName}`
                    );
                    zones.set(processor.zoneName, (zones.get(processor.zoneName) ?? 0) + addition);
                    contributions.push({
                        contributionId: `${String(source.sourceKey)}:damage:${modifier.modifierIndex}:${processor.processorIndex}`,
                        semanticKey: `damage-zone.${String(processor.zoneName)}`,
                        sourceKey: source.sourceKey,
                        sourceType: source.sourceType,
                        sourceCategory: source.sourceCategory,
                        sourceId: source.sourceId,
                        ownerId: source.ownerId,
                        carrierId: source.carrierId,
                        targetId: source.targetId,
                        damageSourceId: source.damageSourceId,
                        buffId: source.buffId,
                        buffInstanceId: source.buffInstanceId,
                        sourceSkillId: source.sourceSkillId,
                        side: effectiveSide,
                        zoneName: processor.zoneName,
                        operation: 'AddRate',
                        rawField: processor.zoneName,
                        rawValue: addition,
                        resolvedValue: addition,
                        addition,
                        stackCount: Number(source.payload?.stackCount ?? 1),
                        appliedFrame: source.appliedFrame,
                        expireFrame: source.metadata?.expireFrame ?? null,
                        transactionId: source.transactionId,
                        metadata: cloneValue(source.metadata)
                    });
                }
            }
        }
        const zoneValues = [...zones.entries()].map(([zoneName, addition]) => ({
            zoneName,
            addition,
            scale: 1 + addition
        }));
        return {
            targetId,
            side,
            damageType,
            attackerId,
            defenderId,
            scale: zoneValues.reduce((scale, zone) => scale * zone.scale, 1),
            zones: zoneValues,
            contributions
        };
    }

    /**
     * Returns the exact runtime sources that produced one attribute value.
     * Damage-zone snapshots alone cannot explain self Buffs such as Chen's
     * stacking ATK talent because those sources enter the nine-field panel
     * formula before the damage zones are evaluated.
     */
    attributeSnapshot({ targetId, attribute }, eventContext = {}) {
        identifier(targetId, 'attribute-snapshot targetId');
        if (typeof attribute !== 'string' || attribute.length === 0) {
            throw new TypeError('attribute-snapshot attribute must be a non-empty string.');
        }
        const key = statKey(targetId, attribute);
        const base = this.baseAttributes.get(key);
        const registered = this.attributeComponents.get(key);
        const currentValue = finite(
            this.context.getAttribute(targetId, attribute) ?? 0,
            'attribute snapshot ' + attribute
        );
        const baseComponent = base
            ? cloneValue(base.component)
            : registered
                ? cloneValue(registered.component)
                : emptyAttributeComponent(currentValue);
        const component = cloneValue(baseComponent);
        const contributions = [];
        for (const source of [
            ...this.baselineSources.values(),
            ...this.sources.values()
        ]) {
            if (source.targetId !== targetId) continue;
            for (const modifier of source.modifiers) {
                if (modifier.attribute !== attribute) continue;
                const value = finite(this.resolveValue(modifier.value, {
                    ...eventContext,
                    targetId,
                    blackboard: source.blackboard,
                    payload: source.payload
                }), attribute + '.' + modifier.zone);
                const resolvedValue = resolveModifierOperand(value, modifier);
                const field = modifier.zone[0].toLowerCase() + modifier.zone.slice(1);
                if (!source.baseline) {
                    if (modifier.zone === 'BaseFinalMultiplier'
                        || modifier.zone === 'FinalMultiplier') {
                        component[field] *= resolvedValue;
                    } else {
                        component[field] += resolvedValue;
                    }
                }
                contributions.push({
                    contributionId: `${String(source.sourceKey)}:attribute:${attribute}:${modifier.modifierIndex}`,
                    semanticKey: `${attribute}.${modifier.zone}`,
                    sourceKey: source.sourceKey,
                    sourceType: source.sourceType,
                    sourceCategory: source.sourceCategory,
                    sourceId: source.sourceId,
                    ownerId: source.ownerId,
                    carrierId: source.carrierId,
                    buffInstanceId: source.buffInstanceId,
                    buffId: source.buffId,
                    targetId: source.targetId,
                    damageSourceId: source.damageSourceId,
                    sourceSkillId: source.sourceSkillId,
                    attribute,
                    zone: modifier.zone,
                    operation: modifier.zone.endsWith('Multiplier')
                        ? 'Multiply'
                        : 'Add',
                    rawField: modifier.metadata?.rawFormulaItem ?? modifier.zone,
                    rawFormulaItem: modifier.metadata?.rawFormulaItem ?? modifier.zone,
                    rawValue: value,
                    resolvedValue,
                    value: resolvedValue,
                    baseline: source.baseline === true,
                    preApplied: source.preApplied === true,
                    stackCount: Number(source.payload?.stackCount ?? 1),
                    metadata: cloneValue(modifier.metadata),
                    sourceMetadata: cloneValue(source.metadata),
                    appliedFrame: source.appliedFrame,
                    expireFrame: source.metadata?.expireFrame ?? null,
                    transactionId: source.transactionId
                });
            }
        }
        return {
            targetId,
            attribute,
            baseValue: base?.value ?? evaluateAttributeComponent(baseComponent).value,
            baseComponent,
            evaluation: evaluateAttributeComponent(component),
            contributions
        };
    }

    snapshot() {
        return {
            sources: [...this.sources.values()].map(cloneValue),
            baselineSources: [...this.baselineSources.values()].map(cloneValue),
            baseAttributes: [...this.baseAttributes.values()].map(cloneValue),
            attributeComponents: [...this.attributeComponents.values()].map(cloneValue),
            trace: this.trace.map(cloneValue)
        };
    }

    #recompute(targetId, attribute, eventContext) {
        const key = statKey(targetId, attribute);
        const base = this.baseAttributes.get(key);
        if (!base) return null;
        const contributions = [...this.sources.values()]
            .filter(source => source.targetId === targetId)
            .flatMap(source => source.modifiers
                .filter(modifier => modifier.attribute === attribute)
                .map(modifier => ({ source, modifier })));
        const component = cloneValue(base.component);
        for (const { source, modifier } of contributions) {
            const value = finite(this.resolveValue(modifier.value, {
                ...eventContext,
                targetId,
                blackboard: source.blackboard,
                payload: source.payload
            }), attribute + '.' + modifier.zone);
            const resolvedValue = resolveModifierOperand(value, modifier);
            const field = modifier.zone[0].toLowerCase() + modifier.zone.slice(1);
            if (modifier.zone === 'BaseFinalMultiplier'
                || modifier.zone === 'FinalMultiplier') {
                component[field] *= resolvedValue;
            } else {
                component[field] += resolvedValue;
            }
        }
        const evaluation = evaluateAttributeComponent(component);
        this.context.setAttribute(targetId, attribute, evaluation.value, {
            ...eventContext,
            targetId,
            reason: 'EffectSourceRecompute'
        });
        if (contributions.length === 0) this.baseAttributes.delete(key);
        return { targetId, attribute, contributions: contributions.length, evaluation };
    }

    #tagReferenceKey(targetId, tag) {
        return typedKey(targetId) + '\u0000' + tag;
    }

    #addTagReference(targetId, tag, eventContext) {
        const key = this.#tagReferenceKey(targetId, tag);
        const count = this.tagReferences.get(key) ?? 0;
        this.tagReferences.set(key, count + 1);
        if (count === 0) this.context.addTag(targetId, tag, eventContext);
    }

    #removeTagReference(targetId, tag, eventContext) {
        const key = this.#tagReferenceKey(targetId, tag);
        const count = this.tagReferences.get(key) ?? 0;
        if (count <= 1) {
            this.tagReferences.delete(key);
            this.context.removeTag(targetId, tag, eventContext);
        } else {
            this.tagReferences.set(key, count - 1);
        }
    }

    #record(stage, source, eventContext, details) {
        const record = {
            frame: Number(eventContext.frame ?? source.appliedFrame ?? 0),
            stage,
            type: stage,
            sourceKey: source.sourceKey,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            ownerId: source.ownerId,
            carrierId: source.carrierId ?? source.targetId,
            targetId: source.targetId,
            damageSourceId: source.damageSourceId ?? source.sourceId,
            buffInstanceId: source.buffInstanceId,
            buffId: source.buffId ?? null,
            sourceSkillId: source.sourceSkillId ?? null,
            transactionId: source.transactionId ?? eventContext.transactionId ?? null,
            reason: eventContext.reason ?? stage,
            ruleId: source.ruleId,
            ...cloneValue(details)
        };
        this.trace.push(record);
        return cloneValue(record);
    }
}

export default EffectSourceRegistry;
