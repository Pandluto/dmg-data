/**
 * Small, data-oriented registry shared by the generic combat systems.
 *
 * CombatContext deliberately knows nothing about characters, skills or
 * machines.  It only owns entity state and the common event envelope used by
 * the other runtime modules.
 */

const ENTITY_KINDS = new Set(['Character', 'Enemy', 'Summon', 'Object']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value instanceof Set) return [...value].map(cloneValue);
    if (value instanceof Map) {
        return Object.fromEntries([...value.entries()].map(([key, entry]) => [key, cloneValue(entry)]));
    }
    const result = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneValue(entry);
    return result;
}

function nonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function identifier(value, label) {
    if (typeof value === 'string') return nonEmptyString(value, label);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new TypeError(`${label} must be a non-empty string or finite number.`);
}

function optionalId(value, label) {
    if (value === undefined || value === null) return null;
    return identifier(value, label);
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    return value;
}

function normalizeTags(tags, label = 'tags') {
    if (tags === undefined || tags === null) return [];
    const values = tags instanceof Set ? [...tags] : tags;
    if (!Array.isArray(values)) throw new TypeError(`${label} must be an array or Set.`);
    const normalized = [];
    for (const tag of values) {
        nonEmptyString(tag, `${label} entries`);
        if (!normalized.includes(tag)) normalized.push(tag);
    }
    return normalized;
}

function contextPart(context, key, fallback = null) {
    const value = context?.[key];
    return value === undefined ? fallback : value;
}

function traceContext(eventContext = {}, overrides = {}) {
    return {
        frame: contextPart(overrides, 'frame', contextPart(eventContext, 'frame', null)),
        sourceId: contextPart(overrides, 'sourceId', contextPart(eventContext, 'sourceId', null)),
        ownerId: contextPart(overrides, 'ownerId', contextPart(eventContext, 'ownerId', null)),
        targetId: contextPart(overrides, 'targetId', contextPart(eventContext, 'targetId', null)),
        reason: overrides.reason ?? eventContext?.reason ?? null,
        ruleId: overrides.ruleId ?? eventContext?.ruleId ?? null
    };
}

/**
 * Registry and state container for entities participating in a combat event.
 */
export class CombatContext {
    constructor({ entities = [] } = {}) {
        if (!Array.isArray(entities)) throw new TypeError('entities must be an array.');
        this.entities = new Map();
        this.trace = [];
        for (const definition of entities) this.registerEntity(definition);
    }

    #requireEntity(id) {
        identifier(id, 'entity id');
        const entity = this.entities.get(id);
        if (!entity) throw new Error(`Unknown entity: ${id}`);
        return entity;
    }

    #record(type, eventContext, details = {}) {
        const base = traceContext(eventContext, details);
        const record = {
            frame: base.frame,
            type,
            stage: details.stage ?? type,
            sourceId: base.sourceId,
            ownerId: base.ownerId,
            targetId: base.targetId,
            reason: base.reason ?? type,
            ruleId: base.ruleId,
            ...details
        };
        // Keep the common ownership fields authoritative even when details
        // came from a caller-supplied object.
        record.frame = base.frame;
        record.sourceId = base.sourceId;
        record.ownerId = base.ownerId;
        record.targetId = base.targetId;
        if (record.reason === undefined || record.reason === null) record.reason = type;
        this.trace.push(cloneValue(record));
        return cloneValue(record);
    }

    /** Register an entity, rejecting duplicate ids before any state is changed. */
    registerEntity(definition) {
        if (!isRecord(definition)) throw new TypeError('Entity definition must be an object.');
        const id = identifier(definition.id, 'entity.id');
        if (this.entities.has(id)) throw new Error(`Duplicate entity id: ${id}`);
        const kind = definition.kind;
        if (!ENTITY_KINDS.has(kind)) {
            throw new Error(`entity.kind must be one of ${[...ENTITY_KINDS].join(', ')}.`);
        }
        const team = definition.team === undefined || definition.team === null
            ? null
            : definition.team;
        if (typeof team !== 'string' && typeof team !== 'number' && team !== null) {
            throw new TypeError('entity.team must be a string, number or null.');
        }
        const ownerId = optionalId(definition.ownerId, 'entity.ownerId');
        const attributes = definition.attributes ?? {};
        if (!isRecord(attributes)) throw new TypeError('entity.attributes must be an object.');
        const metadata = definition.metadata ?? {};
        if (!isRecord(metadata)) throw new TypeError('entity.metadata must be an object.');
        const entity = {
            id,
            kind,
            team,
            ownerId,
            attributes: cloneValue(attributes),
            tags: new Set(normalizeTags(definition.tags)),
            metadata: cloneValue(metadata)
        };
        this.entities.set(id, entity);
        this.#record('EntityRegistered', null, {
            entityId: id,
            kind,
            reason: 'RegisterEntity',
            before: null,
            requested: cloneValue(definition),
            actual: cloneValue(this.#publicEntity(entity)),
            discarded: 0,
            after: cloneValue(this.#publicEntity(entity))
        });
        return this.#publicEntity(entity);
    }

    hasEntity(id) {
        identifier(id, 'entity id');
        return this.entities.has(id);
    }

    getEntity(id) {
        return this.#publicEntity(this.#requireEntity(id));
    }

    listEntities(filter) {
        let predicate = () => true;
        if (typeof filter === 'function') {
            predicate = filter;
        } else if (filter !== undefined && filter !== null) {
            if (!isRecord(filter)) throw new TypeError('entity filter must be an object or function.');
            predicate = (entity) => {
                for (const [key, expected] of Object.entries(filter)) {
                    if (key === 'tag' || key === 'hasTag') {
                        if (!entity.tags.includes(expected)) return false;
                    } else if (key === 'tags') {
                        const tags = normalizeTags(expected, 'filter.tags');
                        if (!tags.every(tag => entity.tags.includes(tag))) return false;
                    } else if (key === 'attributes') {
                        if (!isRecord(expected)) return false;
                        for (const [attribute, value] of Object.entries(expected)) {
                            if (entity.attributes[attribute] !== value) return false;
                        }
                    } else if (entity[key] !== expected) {
                        return false;
                    }
                }
                return true;
            };
        }
        const result = [];
        for (const entity of this.entities.values()) {
            const publicEntity = this.#publicEntity(entity);
            if (predicate(publicEntity)) result.push(publicEntity);
        }
        return result;
    }

    addTag(id, tag, eventContext = null) {
        const entity = this.#requireEntity(id);
        nonEmptyString(tag, 'tag');
        const before = entity.tags.has(tag);
        entity.tags.add(tag);
        return this.#record('TagAdded', eventContext, {
            entityId: id,
            tag,
            requested: tag,
            actual: before ? 0 : 1,
            discarded: before ? 1 : 0,
            before: before ? [tag] : [],
            after: [...entity.tags],
            reason: eventContext?.reason ?? 'ApplyTag'
        });
    }

    removeTag(id, tag, eventContext = null) {
        const entity = this.#requireEntity(id);
        nonEmptyString(tag, 'tag');
        const existed = entity.tags.delete(tag);
        return this.#record('TagRemoved', eventContext, {
            entityId: id,
            tag,
            requested: tag,
            actual: existed ? 1 : 0,
            discarded: existed ? 0 : 1,
            before: existed ? [tag] : [],
            after: [...entity.tags],
            reason: eventContext?.reason ?? 'RemoveTag'
        });
    }

    hasTag(id, tag) {
        const entity = this.#requireEntity(id);
        nonEmptyString(tag, 'tag');
        return entity.tags.has(tag);
    }

    getAttribute(id, key) {
        const entity = this.#requireEntity(id);
        nonEmptyString(key, 'attribute key');
        return cloneValue(entity.attributes[key]);
    }

    setAttribute(id, key, value, eventContext = null) {
        const entity = this.#requireEntity(id);
        nonEmptyString(key, 'attribute key');
        const before = cloneValue(entity.attributes[key]);
        entity.attributes[key] = cloneValue(value);
        const numeric = typeof before === 'number' && typeof value === 'number'
            && Number.isFinite(before) && Number.isFinite(value);
        return this.#record('AttributeSet', eventContext, {
            entityId: id,
            attribute: key,
            before,
            requested: cloneValue(value),
            actual: numeric ? value - before : cloneValue(value),
            discarded: 0,
            after: cloneValue(value),
            reason: eventContext?.reason ?? 'SetAttribute'
        });
    }

    modifyAttribute(id, key, delta, eventContext = null) {
        const entity = this.#requireEntity(id);
        nonEmptyString(key, 'attribute key');
        finiteNumber(delta, 'attribute delta');
        const before = entity.attributes[key] ?? 0;
        finiteNumber(before, `attribute ${key}`);
        const after = before + delta;
        entity.attributes[key] = after;
        return this.#record('AttributeModified', eventContext, {
            entityId: id,
            attribute: key,
            before,
            requested: delta,
            actual: delta,
            discarded: 0,
            after,
            reason: eventContext?.reason ?? 'ModifyAttribute'
        });
    }

    patchMetadata(id, patch, eventContext = null) {
        const entity = this.#requireEntity(id);
        if (!isRecord(patch)) throw new TypeError('metadata patch must be an object.');
        const before = cloneValue(entity.metadata);
        entity.metadata = { ...entity.metadata, ...cloneValue(patch) };
        return this.#record('EntityMetadataPatched', eventContext, {
            entityId: id,
            before,
            requested: cloneValue(patch),
            actual: cloneValue(patch),
            discarded: 0,
            after: cloneValue(entity.metadata),
            reason: eventContext?.reason ?? 'PatchEntityMetadata'
        });
    }

    /**
     * Make an isolated event envelope and validate every entity reference in
     * it.  `ownerId` intentionally remains null when omitted: a source and an
     * owner have different semantics for summons, auras and derived effects.
     */
    createEventContext(base = {}, overrides = {}) {
        if (!isRecord(base)) throw new TypeError('base event context must be an object.');
        if (!isRecord(overrides)) throw new TypeError('event context overrides must be an object.');
        const merged = {
            ...cloneValue(base),
            ...cloneValue(overrides),
            blackboard: {
                ...(isRecord(base.blackboard) ? cloneValue(base.blackboard) : {}),
                ...(isRecord(overrides.blackboard) ? cloneValue(overrides.blackboard) : {})
            },
            payload: {
                ...(isRecord(base.payload) ? cloneValue(base.payload) : {}),
                ...(isRecord(overrides.payload) ? cloneValue(overrides.payload) : {})
            }
        };
        if (base.blackboard !== undefined && !isRecord(base.blackboard)) {
            throw new TypeError('eventContext.blackboard must be an object.');
        }
        if (overrides.blackboard !== undefined && !isRecord(overrides.blackboard)) {
            throw new TypeError('eventContext.blackboard override must be an object.');
        }
        if (base.payload !== undefined && !isRecord(base.payload)) {
            throw new TypeError('eventContext.payload must be an object.');
        }
        if (overrides.payload !== undefined && !isRecord(overrides.payload)) {
            throw new TypeError('eventContext.payload override must be an object.');
        }
        const frame = merged.frame === undefined ? 0 : finiteNumber(merged.frame, 'eventContext.frame');
        if (frame < 0) throw new RangeError('eventContext.frame must be non-negative.');
        const normalized = {
            ...merged,
            frame,
            eventType: merged.eventType === undefined || merged.eventType === null
                ? null
                : nonEmptyString(merged.eventType, 'eventContext.eventType'),
            sourceId: optionalId(merged.sourceId, 'eventContext.sourceId'),
            ownerId: optionalId(merged.ownerId, 'eventContext.ownerId'),
            targetId: optionalId(merged.targetId, 'eventContext.targetId'),
            skillId: optionalId(merged.skillId, 'eventContext.skillId'),
            rootSkillId: optionalId(merged.rootSkillId, 'eventContext.rootSkillId'),
            castId: optionalId(merged.castId, 'eventContext.castId'),
            buffInstanceId: optionalId(merged.buffInstanceId, 'eventContext.buffInstanceId'),
            clockDomainId: optionalId(merged.clockDomainId, 'eventContext.clockDomainId'),
            blackboard: cloneValue(merged.blackboard),
            payload: cloneValue(merged.payload)
        };
        for (const key of ['sourceId', 'ownerId', 'targetId']) {
            if (normalized[key] !== null && !this.entities.has(normalized[key])) {
                throw new Error(`Unknown ${key}: ${normalized[key]}`);
            }
        }
        return cloneValue(normalized);
    }

    resolveEntityRef(ref, eventContext = {}) {
        const context = this.createEventContext(eventContext);
        if (isRecord(ref) && String(ref.type ?? '').toLowerCase() === 'eventtarget') {
            const eventTargetId = context.payload?.eventTargetId;
            if (eventTargetId !== null && eventTargetId !== undefined) {
                return this.#publicEntity(this.#requireEntity(eventTargetId));
            }
            return this.resolveEntityRef(ref.fallback ?? 'Target', context);
        }
        let value = ref;
        if (isRecord(ref)) {
            value = ref.ref ?? ref.role ?? ref.entityId ?? ref.id;
        }
        identifier(value, 'entity reference');
        const role = typeof value === 'string' ? value.toLowerCase() : '';
        const roleMap = {
            source: context.sourceId,
            owner: context.ownerId,
            target: context.targetId,
            self: context.sourceId
        };
        const id = Object.prototype.hasOwnProperty.call(roleMap, role) ? roleMap[role] : value;
        if (id === null || id === undefined) throw new Error(`Event context has no entity for ${value}.`);
        return this.#publicEntity(this.#requireEntity(id));
    }

    snapshot() {
        return {
            entities: [...this.entities.values()].map(entity => this.#publicEntity(entity)),
            trace: cloneValue(this.trace)
        };
    }

    #publicEntity(entity) {
        return {
            id: entity.id,
            kind: entity.kind,
            team: entity.team,
            ownerId: entity.ownerId,
            attributes: cloneValue(entity.attributes),
            tags: [...entity.tags],
            metadata: cloneValue(entity.metadata)
        };
    }
}

export { cloneValue };

export default CombatContext;
