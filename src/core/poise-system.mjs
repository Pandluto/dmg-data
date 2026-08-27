import { PoiseMachine } from './poise-machine.mjs';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function finite(value, label) {
    const result = Number(value);
    if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite.`);
    return result;
}

function clone(value) {
    if (value === undefined || value === null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function targetKey(value) {
    return `${typeof value}\u0000${String(value)}`;
}

function targetIdFrom(input) {
    return identifier(input.targetId ?? input.entityId ?? input.id, 'poise targetId');
}

/**
 * Multi-target adapter around the Calc-verified PoiseMachine. It owns routing,
 * target-local clocks and causal lifecycle records; PoiseMachine remains the
 * single source of break/recovery arithmetic and cycle semantics.
 */
export class PoiseSystem {
    constructor({
        schedule = () => {},
        clockDomains = null,
        tickRate = 30,
        targetValidator = null,
        onTransition = null,
        onKnot = null,
        trace = []
    } = {}) {
        if (typeof schedule !== 'function') throw new TypeError('PoiseSystem schedule must be a function.');
        if (clockDomains !== null && !isObject(clockDomains)) {
            throw new TypeError('PoiseSystem clockDomains must be an object or null.');
        }
        if (targetValidator !== null && typeof targetValidator !== 'function') {
            throw new TypeError('PoiseSystem targetValidator must be a function or null.');
        }
        if (onTransition !== null && typeof onTransition !== 'function') {
            throw new TypeError('PoiseSystem onTransition must be a function or null.');
        }
        if (onKnot !== null && typeof onKnot !== 'function') {
            throw new TypeError('PoiseSystem onKnot must be a function or null.');
        }
        if (!Array.isArray(trace)) throw new TypeError('PoiseSystem trace must be an array.');
        this.schedule = schedule;
        this.clockDomains = clockDomains;
        this.tickRate = finite(tickRate, 'PoiseSystem tickRate');
        if (this.tickRate <= 0) throw new RangeError('PoiseSystem tickRate must be positive.');
        this.targetValidator = targetValidator;
        this.onTransition = onTransition;
        this.onKnot = onKnot;
        this.trace = trace;
        this.entities = new Map();
    }

    #entry(targetId) {
        const id = identifier(targetId, 'poise targetId');
        const entry = this.entities.get(targetKey(id));
        if (!entry) throw new Error(`Unknown poise entity: ${String(id)}.`);
        return entry;
    }

    #clockAdapter(clockDomainId, targetId) {
        if (this.clockDomains === null) return null;
        if (!this.clockDomains.hasDomain(clockDomainId)) {
            throw new Error(`Unknown poise clock domain: ${String(clockDomainId)}.`);
        }
        return {
            localFrameAt: frame => this.clockDomains.localFrameAt(clockDomainId, frame),
            startTimer: definition => this.clockDomains.startTimer(clockDomainId, {
                ...definition,
                targetId
            }),
            cancelTimer: (timerId, frame, reason) =>
                this.clockDomains.cancelTimer(clockDomainId, timerId, frame, reason),
            timer: timerId => this.clockDomains.timer(clockDomainId, timerId)
        };
    }

    #context(entry, fallback = {}) {
        return clone(entry.activeContext ?? entry.lastBreakContext ?? fallback ?? {});
    }

    #publish(entry, eventType, transition) {
        const context = this.#context(entry);
        const record = {
            frame: transition.frame ?? context.frame ?? 0,
            stage: 'PoiseLifecycleTransition',
            type: 'PoiseLifecycleTransition',
            eventType,
            sourceId: context.sourceId ?? null,
            ownerId: context.ownerId ?? null,
            targetId: entry.targetId,
            skillId: context.skillId ?? null,
            rootSkillId: context.rootSkillId ?? null,
            castId: context.castId ?? null,
            hitId: context.hitId ?? null,
            clockDomainId: entry.clockDomainId,
            reason: transition.reason ?? eventType,
            cycle: transition.cycle ?? null,
            breakDamageBuffId: entry.definition.breakDamageBuffId ?? null,
            executionGateBuffId: entry.definition.executionGateBuffId ?? null,
            transition: clone(transition)
        };
        this.trace.push(record);
        entry.lastTransition = record;
        if (eventType === 'OnPoiseZero') entry.pendingBrokenTransition = record;
        if (this.onTransition) this.onTransition(clone(record));
        return record;
    }

    registerEntity(input = {}) {
        if (!isObject(input)) throw new TypeError('PoiseSystem registerEntity requires an object.');
        const targetId = targetIdFrom(input);
        const key = targetKey(targetId);
        if (this.entities.has(key)) throw new Error(`Duplicate poise entity: ${String(targetId)}.`);
        if (this.targetValidator && !this.targetValidator(targetId, input)) {
            throw new Error(`Unknown or invalid poise entity: ${String(targetId)}.`);
        }
        const rawDefinition = input.definition ?? input.poise ?? input;
        if (!isObject(rawDefinition)) throw new TypeError('Poise definition must be an object.');
        const clockDomainId = input.clockDomainId ?? rawDefinition.clockDomainId ?? 'global';
        identifier(clockDomainId, 'poise clockDomainId');
        const definition = {
            ...clone(rawDefinition),
            enabled: rawDefinition.enabled !== false
        };
        const entry = {
            targetId,
            clockDomainId,
            definition,
            activeContext: null,
            lastBreakContext: null,
            lastTransition: null,
            pendingBrokenTransition: null,
            machine: null
        };
        entry.machine = new PoiseMachine({
            definition,
            schedule: this.schedule,
            localClock: this.#clockAdapter(clockDomainId, targetId),
            tickRate: this.tickRate,
            onKnot: transition => {
                const context = this.#context(entry);
                const record = {
                    ...clone(transition),
                    targetId,
                    clockDomainId,
                    sourceId: context.sourceId ?? null,
                    ownerId: context.ownerId ?? null,
                    skillId: context.skillId ?? transition.sourceSkillId ?? null,
                    rootSkillId: context.rootSkillId ?? transition.rootSkillId ?? null,
                    castId: context.castId ?? null,
                    hitId: context.hitId ?? null
                };
                if (this.onKnot) this.onKnot(clone(record));
            },
            onBroken: transition => {
                entry.lastBreakContext = this.#context(entry);
                this.#publish(entry, 'OnPoiseZero', transition);
            },
            onRecovered: transition => this.#publish(entry, 'OnPoiseRecover', transition)
        });
        this.entities.set(key, entry);
        this.trace.push({
            frame: 0,
            stage: 'PoiseEntityRegistered',
            type: 'PoiseEntityRegistered',
            sourceId: null,
            ownerId: null,
            targetId,
            clockDomainId,
            reason: 'RegisterEntity',
            maxPoise: entry.machine.snapshot().maxPoise,
            recoveryTicks: entry.machine.snapshot().recoveryTicks
        });
        return this.snapshot(targetId);
    }

    hasEntity(targetId) {
        if ((typeof targetId !== 'string' || targetId.trim() === '')
            && (typeof targetId !== 'number' || !Number.isFinite(targetId))) return false;
        return this.entities.has(targetKey(targetId));
    }

    applyDamage(input = {}) {
        if (!isObject(input)) throw new TypeError('PoiseSystem applyDamage requires an object.');
        const targetId = targetIdFrom(input);
        const requested = finite(
            input.basePoise ?? input.amount ?? input.value,
            'poise damage amount'
        );
        if (!this.hasEntity(targetId)) {
            if (requested !== 0) {
                throw new Error(`Unknown poise entity: ${String(targetId)}.`);
            }
            const ignored = {
                frame: input.frame ?? input.eventContext?.frame ?? 0,
                stage: 'PoiseDamageIgnored',
                type: 'PoiseDamageIgnored',
                sourceId: input.sourceId ?? input.eventContext?.sourceId ?? null,
                ownerId: input.ownerId ?? input.eventContext?.ownerId ?? null,
                targetId,
                skillId: input.skillId ?? input.eventContext?.skillId ?? null,
                rootSkillId: input.rootSkillId ?? input.eventContext?.rootSkillId ?? null,
                castId: input.castId ?? input.eventContext?.castId ?? null,
                reason: 'TargetHasNoPoise',
                enabled: false,
                basePoise: 0,
                finalPoiseDamage: 0,
                actualPoiseDamage: 0,
                overflow: 0,
                before: 0,
                after: 0,
                broken: false,
                broke: false,
                transition: null
            };
            this.trace.push(ignored);
            return clone(ignored);
        }
        const entry = this.#entry(targetId);
        entry.activeContext = clone(input.eventContext ?? input);
        entry.pendingBrokenTransition = null;
        try {
            const result = entry.machine.applyDamage({
                frame: input.frame ?? entry.activeContext.frame ?? 0,
                basePoise: requested,
                outputScalar: input.outputScalar ?? 1,
                takenScalar: input.takenScalar ?? 1,
                sourceSkillId: input.sourceSkillId ?? input.skillId ?? entry.activeContext.skillId ?? null,
                rootSkillId: input.rootSkillId ?? entry.activeContext.rootSkillId ?? null,
                damageUnitIndex: input.damageUnitIndex ?? entry.activeContext.damageUnitIndex ?? null
            });
            return {
                ...result,
                targetId,
                transition: entry.pendingBrokenTransition === null
                    ? null
                    : clone(entry.pendingBrokenTransition)
            };
        } finally {
            entry.activeContext = null;
        }
    }

    recover(input = {}) {
        if (!isObject(input)) throw new TypeError('PoiseSystem recover requires an object.');
        const targetId = targetIdFrom(input);
        const entry = this.#entry(targetId);
        entry.activeContext = clone(input.eventContext ?? input);
        try {
            return entry.machine.recover(
                input.frame ?? entry.activeContext.frame ?? 0,
                input.reason ?? 'Manual'
            );
        } finally {
            entry.activeContext = null;
        }
    }

    canExecute(targetId) {
        return this.#entry(targetId).machine.canExecute();
    }

    consumeExecution(input = {}) {
        if (!isObject(input)) throw new TypeError('PoiseSystem consumeExecution requires an object.');
        const targetId = targetIdFrom(input);
        return this.#entry(targetId).machine.consumeExecution(input);
    }

    damageZone(targetId) {
        return this.#entry(targetId).machine.damageZone();
    }

    snapshot(targetId = undefined) {
        if (targetId !== undefined && targetId !== null) {
            const entry = this.#entry(targetId);
            return {
                targetId: entry.targetId,
                clockDomainId: entry.clockDomainId,
                ...entry.machine.snapshot()
            };
        }
        const entities = [...this.entities.values()].map(entry => this.snapshot(entry.targetId));
        const result = {
            entities,
            byTargetId: Object.fromEntries(entities.map(entity => [String(entity.targetId), entity])),
            trace: this.trace.map(record => clone(record))
        };
        if (entities.length === 1) Object.assign(result, entities[0]);
        return result;
    }
}
