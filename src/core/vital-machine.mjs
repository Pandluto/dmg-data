function objectInput(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
    return number;
}

function nonNegativeNumber(value, label) {
    const number = finiteNumber(value, label);
    if (number < 0) throw new RangeError(`${label} must be non-negative.`);
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
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
        return value;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function normalizeStackingPolicy(value) {
    const policy = String(value ?? 'Replace');
    const aliases = {
        Replace: 'Replace',
        Refresh: 'Refresh',
        Stack: 'Stack',
        Add: 'Stack',
        Ignore: 'Ignore',
        replace: 'Replace',
        refresh: 'Refresh',
        stack: 'Stack',
        add: 'Stack',
        ignore: 'Ignore'
    };
    if (!aliases[policy]) throw new Error(`Unknown shield stacking policy: ${policy}`);
    return aliases[policy];
}

function normalizeEntityDefinition(definition, fallbackId = null) {
    const input = typeof definition === 'string'
        ? { id: definition }
        : objectInput(definition, 'vital entity definition');
    const id = identifier(input.id ?? fallbackId, 'vital entity id');
    const maxHp = nonNegativeNumber(input.maxHp, `${id}.maxHp`);
    const currentHp = nonNegativeNumber(
        input.currentHp ?? input.initialHp ?? maxHp,
        `${id}.currentHp`
    );
    if (currentHp > maxHp) throw new RangeError(`${id}.currentHp cannot exceed maxHp.`);
    const rawHealingCap = input.healingCap ?? input.healCap ?? input.maxHealingPerCall;
    const healingCap = rawHealingCap === undefined || rawHealingCap === null
        ? null
        : nonNegativeNumber(
            typeof rawHealingCap === 'object'
                ? (rawHealingCap.perCall ?? rawHealingCap.amount)
                : rawHealingCap,
            `${id}.healingCap`
        );
    return {
        id,
        maxHp,
        currentHp,
        healingCap,
        allowRevive: Boolean(input.allowRevive ?? false),
        shieldStackingPolicy: normalizeStackingPolicy(
            input.shieldStackingPolicy ?? input.stackingPolicy ?? 'Replace'
        ),
        metadata: input.metadata && typeof input.metadata === 'object'
            ? clone(input.metadata)
            : {}
    };
}

function resolveTargetId(input, label = 'targetId') {
    const raw = input.targetId ?? input.entityId ?? input.target ?? input.id;
    if (raw && typeof raw === 'object') return identifier(raw.id, label);
    return identifier(raw, label);
}

/**
 * Stores HP and source-aware shields for arbitrary combat entities.  The
 * machine owns only state transitions; callers retain ownership of effects
 * and can use sourceId/ownerId/buffId in every transition trace.
 */
export class VitalMachine {
    constructor({
        entities = [],
        definitions = null,
        shieldStackingPolicy = 'Replace'
    } = {}) {
        this.defaultShieldStackingPolicy = normalizeStackingPolicy(shieldStackingPolicy);
        this.entities = new Map();
        this.trace = [];
        this.nextShieldId = 1;
        this.nextShieldOrder = 1;

        if (definitions !== null) {
            let entries;
            if (definitions instanceof Map) {
                entries = [...definitions.entries()];
            } else if (definitions && typeof definitions === 'object' && !Array.isArray(definitions)) {
                entries = Object.entries(definitions);
            } else {
                throw new TypeError('vital definitions must be an object or map.');
            }
            for (const [fallbackId, definition] of entries) {
                this.registerEntity({
                    ...objectInput(definition, `${fallbackId} definition`),
                    id: definition.id ?? fallbackId
                });
            }
        }
        if (!Array.isArray(entities)) throw new TypeError('entities must be an array.');
        for (const definition of entities) this.registerEntity(definition);
    }

    #record(record) {
        const frame = record.frame === undefined
            ? 0
            : nonNegativeInteger(record.frame, 'vital trace frame');
        const stage = record.stage ?? record.type ?? 'VitalEvent';
        const normalized = {
            frame,
            stage,
            type: record.type ?? stage,
            sourceId: record.sourceId ?? null,
            ownerId: record.ownerId ?? null,
            targetId: record.targetId ?? null,
            reason: record.reason ?? null,
            ruleId: record.ruleId ?? null,
            ...record,
            frame,
            stage,
            type: record.type ?? stage,
            sourceId: record.sourceId ?? null,
            ownerId: record.ownerId ?? null,
            targetId: record.targetId ?? null,
            reason: record.reason ?? null,
            ruleId: record.ruleId ?? null
        };
        this.trace.push(normalized);
        return normalized;
    }

    registerEntity(definition, overrides = null) {
        let input = definition;
        if (typeof definition === 'string') {
            input = { ...(overrides ?? {}), id: definition };
        } else if (overrides !== null) {
            input = { ...objectInput(definition, 'vital entity definition'), ...overrides };
        }
        const normalized = normalizeEntityDefinition(input);
        if (this.entities.has(normalized.id)) {
            throw new Error(`Vital entity already exists: ${normalized.id}`);
        }
        const state = {
            ...normalized,
            alive: normalized.currentHp > 0,
            shields: []
        };
        this.entities.set(state.id, state);
        this.#record({
            frame: 0,
            stage: 'VitalEntityRegistered',
            type: 'RegisterEntity',
            sourceId: null,
            ownerId: null,
            targetId: state.id,
            reason: 'RegisterEntity',
            ruleId: null,
            before: 0,
            requested: state.currentHp,
            actual: state.currentHp,
            discarded: 0,
            after: state.currentHp,
            maxHp: state.maxHp,
            alive: state.alive
        });
        return this.#publicEntity(state);
    }

    hasEntity(entityId) {
        return (typeof entityId === 'string'
            || (typeof entityId === 'number' && Number.isFinite(entityId)))
            && this.entities.has(entityId);
    }

    #entity(entityId) {
        const id = identifier(entityId, 'vital entity id');
        const entity = this.entities.get(id);
        if (!entity) throw new Error(`Unknown vital entity: ${id}`);
        return entity;
    }

    #parseHealArgs(args) {
        if (args.length === 0) throw new TypeError('heal requires input.');
        let input;
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            input = { ...args[0] };
        } else {
            input = {
                targetId: args[0],
                baseAmount: args[1],
                ...(args[2] && typeof args[2] === 'object' ? args[2] : {})
            };
        }
        input.targetId = resolveTargetId(input);
        input.baseAmount = nonNegativeNumber(input.baseAmount, 'baseAmount');
        input.healingDoneScalar = finiteNumber(input.healingDoneScalar ?? 1, 'healingDoneScalar');
        input.healingTakenScalar = finiteNumber(input.healingTakenScalar ?? 1, 'healingTakenScalar');
        if (input.healingDoneScalar < 0 || input.healingTakenScalar < 0) {
            throw new RangeError('healing scalars must be non-negative.');
        }
        input.frame = nonNegativeInteger(input.frame ?? 0, 'heal frame');
        input.sourceId = identifier(input.sourceId, 'heal sourceId', { allowNull: true });
        input.ownerId = identifier(input.ownerId, 'heal ownerId', { allowNull: true });
        input.buffId = identifier(input.buffId, 'heal buffId', { allowNull: true });
        input.reason = input.reason ?? 'Heal';
        input.ruleId = identifier(input.ruleId, 'heal ruleId', { allowNull: true });
        if (input.revive !== undefined && typeof input.revive !== 'boolean') {
            throw new TypeError('heal revive must be boolean.');
        }
        return input;
    }

    heal(...args) {
        const input = this.#parseHealArgs(args);
        const entity = this.#entity(input.targetId);
        const before = entity.currentHp;
        const requested = input.baseAmount * input.healingDoneScalar * input.healingTakenScalar;
        const cap = entity.healingCap === null
            ? requested
            : Math.min(requested, entity.healingCap);
        const canHeal = entity.alive || input.revive === true || entity.allowRevive;
        const actual = canHeal ? Math.min(cap, entity.maxHp - before) : 0;
        entity.currentHp += actual;
        if (entity.currentHp > 0) entity.alive = true;
        const record = this.#record({
            frame: input.frame,
            stage: 'Healed',
            type: 'Heal',
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: entity.id,
            buffId: input.buffId,
            reason: input.reason,
            ruleId: input.ruleId,
            before,
            requested,
            requestedAmount: requested,
            actual,
            actualHealing: actual,
            discarded: requested - actual,
            healingOverflow: requested - actual,
            capOverflow: Math.max(0, requested - cap),
            hpOverflow: Math.max(0, cap - actual),
            after: entity.currentHp,
            maxHp: entity.maxHp,
            alive: entity.alive,
            healingDoneScalar: input.healingDoneScalar,
            healingTakenScalar: input.healingTakenScalar
        });
        return record;
    }

    #parseShieldArgs(args) {
        if (args.length === 0) throw new TypeError('addShield requires input.');
        let input;
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            input = { ...args[0] };
        } else {
            input = {
                targetId: args[0],
                amount: args[1],
                ...(args[2] && typeof args[2] === 'object' ? args[2] : {})
            };
        }
        input.targetId = resolveTargetId(input);
        input.amount = nonNegativeNumber(input.amount, 'shield amount');
        input.priority = finiteNumber(input.priority ?? 0, 'shield priority');
        input.stackingKey = identifier(input.stackingKey, 'shield stackingKey', { allowNull: true });
        input.sourceId = identifier(input.sourceId, 'shield sourceId', { allowNull: true });
        input.ownerId = identifier(input.ownerId, 'shield ownerId', { allowNull: true });
        input.buffId = identifier(input.buffId, 'shield buffId', { allowNull: true });
        input.reason = input.reason ?? 'AddShield';
        input.ruleId = identifier(input.ruleId, 'shield ruleId', { allowNull: true });
        input.frame = nonNegativeInteger(input.frame ?? 0, 'shield frame');
        if (input.stackingPolicy !== undefined) {
            input.stackingPolicy = normalizeStackingPolicy(input.stackingPolicy);
        } else if (input.stacking !== undefined) {
            input.stackingPolicy = normalizeStackingPolicy(
                typeof input.stacking === 'object'
                    ? (input.stacking.policy ?? input.stacking.type)
                    : input.stacking
            );
        }
        return input;
    }

    #shieldSnapshot(shield) {
        return {
            id: shield.id,
            shieldId: shield.id,
            amount: shield.remaining,
            remaining: shield.remaining,
            sourceId: shield.sourceId,
            ownerId: shield.ownerId,
            buffId: shield.buffId,
            priority: shield.priority,
            stackingKey: shield.stackingKey,
            createdFrame: shield.createdFrame,
            createdOrder: shield.createdOrder,
            active: shield.active
        };
    }

    addShield(...args) {
        const input = this.#parseShieldArgs(args);
        const entity = this.#entity(input.targetId);
        const before = entity.shields
            .filter(shield => shield.active)
            .reduce((sum, shield) => sum + shield.remaining, 0);
        const stackingPolicy = input.stackingPolicy
            ?? entity.shieldStackingPolicy
            ?? this.defaultShieldStackingPolicy;
        const replaced = [];
        let existing = null;
        if (input.stackingKey !== null) {
            existing = entity.shields.find(shield =>
                shield.active && shield.stackingKey === input.stackingKey
            ) ?? null;
        }

        if (existing && stackingPolicy === 'Ignore') {
            return this.#record({
                frame: input.frame,
                stage: 'ShieldIgnored',
                type: 'AddShield',
                sourceId: input.sourceId,
                ownerId: input.ownerId,
                targetId: entity.id,
                buffId: input.buffId,
                reason: input.reason,
                ruleId: input.ruleId,
                before,
                requested: input.amount,
                actual: 0,
                discarded: input.amount,
                after: before,
                stackingKey: input.stackingKey,
                stackingPolicy,
                shieldId: existing.id,
                ignored: true
            });
        }

        if (existing && stackingPolicy === 'Refresh') {
            const previous = existing.remaining;
            existing.remaining = input.amount;
            existing.amount = input.amount;
            existing.priority = input.priority;
            existing.sourceId = input.sourceId;
            existing.ownerId = input.ownerId;
            existing.buffId = input.buffId;
            existing.createdFrame = input.frame;
            return this.#record({
                frame: input.frame,
                stage: 'ShieldRefreshed',
                type: 'AddShield',
                sourceId: input.sourceId,
                ownerId: input.ownerId,
                targetId: entity.id,
                buffId: input.buffId,
                reason: input.reason,
                ruleId: input.ruleId,
                before,
                requested: input.amount,
                actual: input.amount,
                discarded: 0,
                after: before - previous + input.amount,
                shieldId: existing.id,
                previousAmount: previous,
                stackingKey: input.stackingKey,
                stackingPolicy
            });
        }

        if (existing && stackingPolicy === 'Replace') {
            existing.active = false;
            replaced.push(existing.id);
        }

        const shield = {
            id: `shield_${this.nextShieldId++}`,
            remaining: input.amount,
            amount: input.amount,
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            buffId: input.buffId,
            priority: input.priority,
            stackingKey: input.stackingKey,
            createdFrame: input.frame,
            createdOrder: this.nextShieldOrder++,
            active: input.amount > 0
        };
        entity.shields.push(shield);
        return this.#record({
            frame: input.frame,
            stage: 'ShieldAdded',
            type: 'AddShield',
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: entity.id,
            buffId: input.buffId,
            reason: input.reason,
            ruleId: input.ruleId,
            before,
            requested: input.amount,
            actual: input.amount,
            discarded: 0,
            after: before - (replaced.length ? existing?.remaining ?? 0 : 0) + input.amount,
            shieldId: shield.id,
            stackingKey: input.stackingKey,
            stackingPolicy,
            replacedShieldIds: replaced
        });
    }

    #parseDamageArgs(args) {
        if (args.length === 0) throw new TypeError('damage requires input.');
        let input;
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            input = { ...args[0] };
        } else {
            input = {
                targetId: args[0],
                amount: args[1],
                ...(args[2] && typeof args[2] === 'object' ? args[2] : {})
            };
        }
        input.targetId = resolveTargetId(input);
        input.amount = nonNegativeNumber(input.amount, 'damage amount');
        input.bypassShield = input.bypassShield ?? false;
        if (typeof input.bypassShield !== 'boolean') throw new TypeError('bypassShield must be boolean.');
        input.damageType = identifier(input.damageType ?? 'Generic', 'damageType');
        input.frame = nonNegativeInteger(input.frame ?? 0, 'damage frame');
        input.sourceId = identifier(input.sourceId, 'damage sourceId', { allowNull: true });
        input.ownerId = identifier(input.ownerId, 'damage ownerId', { allowNull: true });
        input.reason = input.reason ?? 'Damage';
        input.ruleId = identifier(input.ruleId, 'damage ruleId', { allowNull: true });
        return input;
    }

    damage(...args) {
        const input = this.#parseDamageArgs(args);
        const entity = this.#entity(input.targetId);
        const beforeHp = entity.currentHp;
        let remaining = input.amount;
        let shieldAbsorbed = 0;
        const absorbedBy = [];
        const activeShields = entity.shields
            .filter(shield => shield.active && shield.remaining > 0)
            .sort((left, right) => right.priority - left.priority
                || left.createdOrder - right.createdOrder);
        if (!input.bypassShield) {
            for (const shield of activeShields) {
                if (remaining <= 0) break;
                const beforeShield = shield.remaining;
                const absorbed = Math.min(beforeShield, remaining);
                shield.remaining -= absorbed;
                shield.amount = shield.remaining;
                if (shield.remaining <= 0) {
                    shield.remaining = 0;
                    shield.amount = 0;
                    shield.active = false;
                }
                remaining -= absorbed;
                shieldAbsorbed += absorbed;
                absorbedBy.push({
                    shieldId: shield.id,
                    sourceId: shield.sourceId,
                    ownerId: shield.ownerId,
                    priority: shield.priority,
                    before: beforeShield,
                    requested: beforeShield,
                    actual: absorbed,
                    discarded: beforeShield - absorbed,
                    after: shield.remaining
                });
            }
        }
        const shieldOverflow = input.bypassShield ? 0 : remaining;
        const hpDamage = Math.min(remaining, entity.currentHp);
        entity.currentHp -= hpDamage;
        const overkill = remaining - hpDamage;
        if (entity.currentHp <= 0) {
            entity.currentHp = 0;
            entity.alive = false;
        }
        return this.#record({
            frame: input.frame,
            stage: 'Damaged',
            type: 'Damage',
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: entity.id,
            reason: input.reason,
            ruleId: input.ruleId,
            damageType: input.damageType,
            bypassShield: input.bypassShield,
            before: beforeHp,
            requested: input.amount,
            actual: hpDamage,
            actualDamage: hpDamage,
            discarded: overkill,
            after: entity.currentHp,
            maxHp: entity.maxHp,
            alive: entity.alive,
            shieldAbsorbed,
            shieldOverflow,
            hpDamage,
            overkill,
            absorbedBy
        });
    }

    #parseRemoveArgs(args) {
        if (args.length === 0) throw new TypeError('removeShieldsBySource requires input.');
        let input;
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            input = { ...args[0] };
        } else {
            input = {
                sourceId: args[0],
                targetId: args[1],
                ...(args[2] && typeof args[2] === 'object' ? args[2] : {})
            };
        }
        input.sourceId = identifier(input.sourceId, 'remove sourceId');
        input.ownerId = identifier(input.ownerId, 'remove ownerId', { allowNull: true });
        input.targetId = input.targetId === undefined || input.targetId === null
            ? null
            : resolveTargetId(input);
        input.frame = nonNegativeInteger(input.frame ?? 0, 'remove shield frame');
        input.reason = input.reason ?? 'RemoveShieldsBySource';
        input.ruleId = identifier(input.ruleId, 'remove ruleId', { allowNull: true });
        return input;
    }

    removeShieldsBySource(...args) {
        const input = this.#parseRemoveArgs(args);
        const targets = input.targetId
            ? [this.#entity(input.targetId)]
            : [...this.entities.values()];
        const removed = [];
        for (const entity of targets) {
            for (const shield of entity.shields) {
                if (!shield.active || shield.sourceId !== input.sourceId) continue;
                if (input.ownerId !== null && shield.ownerId !== input.ownerId) continue;
                shield.active = false;
                removed.push({
                    entityId: entity.id,
                    ...this.#shieldSnapshot(shield)
                });
            }
        }
        return this.#record({
            frame: input.frame,
            stage: 'ShieldsRemovedBySource',
            type: 'RemoveShieldsBySource',
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: input.targetId,
            reason: input.reason,
            ruleId: input.ruleId,
            removed,
            count: removed.length,
            before: removed.reduce((sum, shield) => sum + shield.remaining, 0),
            requested: removed.length,
            actual: removed.length,
            discarded: 0,
            after: 0
        });
    }

    hpRatio(entityId, frame = 0) {
        const entity = this.#entity(entityId);
        const atFrame = nonNegativeInteger(frame, 'hp ratio frame');
        const ratio = entity.maxHp === 0 ? 0 : entity.currentHp / entity.maxHp;
        this.#record({
            frame: atFrame,
            stage: 'HpRatioRead',
            type: 'HpRatio',
            sourceId: null,
            ownerId: null,
            targetId: entity.id,
            reason: 'HpRatio',
            ruleId: null,
            before: entity.currentHp,
            requested: 0,
            actual: 0,
            discarded: 0,
            after: entity.currentHp,
            ratio
        });
        return ratio;
    }

    get(entityId) {
        return this.#publicEntity(this.#entity(entityId));
    }

    #publicEntity(entity) {
        const shields = entity.shields
            .filter(shield => shield.active && shield.remaining > 0)
            .sort((left, right) => right.priority - left.priority
                || left.createdOrder - right.createdOrder)
            .map(shield => this.#shieldSnapshot(shield));
        return {
            id: entity.id,
            maxHp: entity.maxHp,
            currentHp: entity.currentHp,
            alive: entity.alive,
            hpRatio: entity.maxHp === 0 ? 0 : entity.currentHp / entity.maxHp,
            healingCap: entity.healingCap,
            allowRevive: entity.allowRevive,
            shields,
            metadata: clone(entity.metadata)
        };
    }

    snapshot(entityId = undefined) {
        if (entityId !== undefined && entityId !== null) {
            return this.#publicEntity(this.#entity(entityId));
        }
        const entities = [...this.entities.values()].map(entity => this.#publicEntity(entity));
        const byEntityId = Object.fromEntries(entities.map(entity => [String(entity.id), entity]));
        for (const [id, entity] of Object.entries(byEntityId)) entities[id] = entity;
        const snapshot = {
            entities,
            byEntityId,
            trace: this.trace.map(record => clone(record))
        };
        for (const [id, entity] of Object.entries(byEntityId)) snapshot[id] = entity;
        return snapshot;
    }
}

export default VitalMachine;
