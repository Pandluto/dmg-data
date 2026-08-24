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

/**
 * Reversible source registry for equipment, talents, potentials, contracts
 * and status effects.
 */
export class EffectSourceRegistry {
    constructor({ context, resolveValue = value => value } = {}) {
        if (!context || typeof context.getAttribute !== 'function'
            || typeof context.setAttribute !== 'function') {
            throw new TypeError('EffectSourceRegistry requires a CombatContext-compatible context.');
        }
        if (typeof resolveValue !== 'function') throw new TypeError('resolveValue must be a function.');
        this.context = context;
        this.resolveValue = resolveValue;
        this.sources = new Map();
        this.baseAttributes = new Map();
        this.tagReferences = new Map();
        this.trace = [];
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
        const modifiers = (input.modifiers ?? []).map((modifier, index) => {
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
                attribute,
                zone,
                value: cloneValue(modifier.value ?? modifier.param ?? 0),
                metadata: cloneValue(modifier.metadata ?? {})
            };
        });
        const tags = [...new Set((input.tags ?? []).map(tag => String(tag)))];
        const damageModifiers = (input.damageModifiers ?? []).map((modifier, index) => {
            if (!isRecord(modifier)) {
                throw new TypeError('damageModifiers[' + index + '] must be an object.');
            }
            return {
                side: modifier.side ?? null,
                damageTypes: cloneValue(modifier.damageTypes ?? []),
                processors: (modifier.processors ?? []).map(processor => ({
                    side: processor.side ?? modifier.side ?? null,
                    zoneName: processor.zoneName ?? 'NormalCalcZone',
                    addition: cloneValue(processor.addition ?? 0)
                }))
            };
        });
        const source = {
            sourceKey: key,
            sourceType: input.sourceType ?? 'Effect',
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            targetId,
            buffInstanceId: input.buffInstanceId ?? eventContext.buffInstanceId ?? null,
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
                this.baseAttributes.set(keyForAttribute, {
                    targetId,
                    attribute: modifier.attribute,
                    value: finite(
                        this.context.getAttribute(targetId, modifier.attribute) ?? 0,
                        'base attribute ' + modifier.attribute
                    )
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

    damageZone({ targetId, side, damageType }, eventContext = {}) {
        identifier(targetId, 'damage-zone targetId');
        const zones = new Map();
        const contributions = [];
        for (const source of this.sources.values()) {
            if (source.targetId !== targetId) continue;
            for (const modifier of source.damageModifiers ?? []) {
                if (modifier.side && side && modifier.side !== side) continue;
                if (modifier.damageTypes.length > 0
                    && !modifier.damageTypes.includes(damageType)) continue;
                for (const processor of modifier.processors) {
                    if (processor.side && side && processor.side !== side) continue;
                    const addition = finite(this.resolveValue(processor.addition, {
                        ...eventContext,
                        targetId,
                        blackboard: source.blackboard,
                        payload: source.payload
                    }), `damage zone ${processor.zoneName}`);
                    zones.set(processor.zoneName, (zones.get(processor.zoneName) ?? 0) + addition);
                    contributions.push({
                        sourceKey: source.sourceKey,
                        zoneName: processor.zoneName,
                        addition
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
            scale: zoneValues.reduce((scale, zone) => scale * zone.scale, 1),
            zones: zoneValues,
            contributions
        };
    }

    snapshot() {
        return {
            sources: [...this.sources.values()].map(cloneValue),
            baseAttributes: [...this.baseAttributes.values()].map(cloneValue),
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
        const component = {
            rawValue: base.value,
            baseAddition: 0,
            baseMultiplier: 1,
            baseFinalAddition: 0,
            baseFinalMultiplier: 1,
            addition: 0,
            multiplier: 1,
            finalAddition: 0,
            finalMultiplier: 1
        };
        for (const { source, modifier } of contributions) {
            const value = finite(this.resolveValue(modifier.value, {
                ...eventContext,
                targetId,
                blackboard: source.blackboard,
                payload: source.payload
            }), attribute + '.' + modifier.zone);
            const field = modifier.zone[0].toLowerCase() + modifier.zone.slice(1);
            component[field] += value;
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
            targetId: source.targetId,
            buffInstanceId: source.buffInstanceId,
            reason: eventContext.reason ?? stage,
            ruleId: source.ruleId,
            ...cloneValue(details)
        };
        this.trace.push(record);
        return cloneValue(record);
    }
}

export default EffectSourceRegistry;
