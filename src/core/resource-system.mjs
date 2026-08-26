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

function normalizedTags(value) {
    const entries = Array.isArray(value)
        ? value
        : (Array.isArray(value?.predefinedTag) ? value.predefinedTag : []);
    return [...new Set(entries
        .map(entry => (entry && typeof entry === 'object' ? entry.tagId : entry))
        .filter(entry => entry !== null && entry !== undefined && entry !== 0))];
}

function normalizePassiveRecovery(value, tickRate, resourceType) {
    if (value === undefined || value === null || value === false) return null;
    if (typeof value === 'number' || typeof value === 'string') {
        return {
            amountPerTick: nonNegativeNumber(value, `${resourceType}.passiveRecovery`),
            firstTickFrame: 1,
            resumeDelayTicksAfterSpend: 0,
            ratePerSecond: null,
            quantization: 'none'
        };
    }
    const input = objectInput(value, `${resourceType}.passiveRecovery`);
    const quantization = input.quantization ?? 'none';
    if (quantization !== 'none' && quantization !== 'float32') {
        throw new Error(`${resourceType}.passiveRecovery.quantization must be none or float32.`);
    }
    const ratePerSecond = input.ratePerSecond === undefined
        ? null
        : nonNegativeNumber(input.ratePerSecond, `${resourceType}.passiveRecovery.ratePerSecond`);
    const explicitAmount = input.amountPerTick ?? input.amount ?? input.tickAmount;
    if (ratePerSecond === null && explicitAmount === undefined) {
        throw new TypeError(
            `${resourceType}.passiveRecovery requires amountPerTick or ratePerSecond.`
        );
    }
    const rawAmount = ratePerSecond === null
        ? nonNegativeNumber(explicitAmount, `${resourceType}.passiveRecovery.amountPerTick`)
        : ratePerSecond / finiteNumber(tickRate, 'tickRate');
    const amountPerTick = quantization === 'float32' ? Math.fround(rawAmount) : rawAmount;
    const firstTickFrame = nonNegativeInteger(
        input.firstTickFrame ?? 1,
        `${resourceType}.passiveRecovery.firstTickFrame`
    );
    const resumeDelayTicksAfterSpend = nonNegativeInteger(
        input.resumeDelayTicksAfterSpend ?? 0,
        `${resourceType}.passiveRecovery.resumeDelayTicksAfterSpend`
    );
    return {
        amountPerTick,
        firstTickFrame,
        resumeDelayTicksAfterSpend,
        ratePerSecond,
        quantization
    };
}

function normalizePoolDefinition(definition, fallbackId, tickRate) {
    const input = objectInput(definition, 'resource pool definition');
    const id = identifier(input.id ?? fallbackId, 'resource pool id');
    const resourceType = identifier(input.resourceType ?? input.type, 'resourceType');
    const scope = input.scope ?? 'Entity';
    if (scope !== 'Shared' && scope !== 'Entity') {
        throw new Error(`Invalid resource pool scope: ${scope}`);
    }
    const ownerId = identifier(input.ownerId, 'resource pool ownerId', { allowNull: true });
    if (scope === 'Entity' && ownerId === null) {
        throw new Error(`Entity resource pool requires ownerId: ${id}`);
    }
    const max = nonNegativeNumber(input.max, `${id}.max`);
    const initial = nonNegativeNumber(input.initial ?? input.current ?? 0, `${id}.initial`);
    if (initial > max) throw new RangeError(`${id}.initial cannot exceed max.`);
    const trackReturned = input.trackReturned === undefined
        ? scope === 'Shared' && resourceType === 'Atb'
        : Boolean(input.trackReturned);
    const returned = nonNegativeNumber(
        input.returned ?? input.returnedInitial ?? input.reserved ?? 0,
        `${id}.returned`
    );
    if (returned > initial) throw new RangeError(`${id}.returned cannot exceed initial.`);
    if (!trackReturned && returned !== 0) {
        throw new RangeError(`${id}.returned requires trackReturned.`);
    }
    const clockDomainId = identifier(input.clockDomainId ?? 'global', 'clockDomainId');
    return {
        id,
        resourceType,
        scope,
        ownerId,
        initial,
        max,
        current: initial,
        trackReturned,
        returned,
        recoverySuspensions: new Map(),
        gainSuppressions: new Map(),
        passiveRecovery: normalizePassiveRecovery(input.passiveRecovery, tickRate, resourceType),
        clockDomainId,
        metadata: input.metadata && typeof input.metadata === 'object'
            ? clone(input.metadata)
            : {}
    };
}

function isObjectStyle(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Generic resource pools.  This class deliberately does not replace the
 * legacy ResourceMachine: the latter models the exact Pelica resource oracle,
 * while this class models reusable shared/entity pools for the general runtime.
 */
export class ResourceSystem {
    constructor({
        pools = [],
        definitions = null,
        schedule,
        clockDomainManager = null,
        tickRate = 30,
        strictSpend = false
    } = {}) {
        this.tickRate = finiteNumber(tickRate, 'tickRate');
        if (this.tickRate <= 0) throw new RangeError('tickRate must be positive.');
        if (schedule !== undefined && typeof schedule !== 'function') {
            throw new TypeError('ResourceSystem schedule must be a function.');
        }
        if (clockDomainManager !== null
            && (typeof clockDomainManager.localFrameAt !== 'function'
                || typeof clockDomainManager.startTimer !== 'function')) {
            throw new TypeError('clockDomainManager must implement localFrameAt/startTimer.');
        }
        if (typeof strictSpend !== 'boolean') throw new TypeError('strictSpend must be boolean.');
        this.schedule = schedule ?? null;
        this.clockDomainManager = clockDomainManager;
        this.strictSpend = strictSpend;
        this.pools = new Map();
        this.spendLedger = new Map();
        this.trace = [];

        if (definitions !== null) {
            let entries;
            if (definitions instanceof Map) {
                entries = [...definitions.entries()];
            } else if (definitions && typeof definitions === 'object' && !Array.isArray(definitions)) {
                entries = Object.entries(definitions);
            } else {
                throw new TypeError('resource definitions must be an object or map.');
            }
            for (const [fallbackId, definition] of entries) {
                this.registerPool({
                    ...objectInput(definition, `${fallbackId} definition`),
                    id: definition.id ?? fallbackId,
                    resourceType: definition.resourceType ?? fallbackId,
                    scope: definition.scope ?? 'Entity',
                    ownerId: definition.ownerId ?? fallbackId
                });
            }
        }
        if (!Array.isArray(pools)) throw new TypeError('pools must be an array.');
        for (const definition of pools) this.registerPool(definition);
    }

    #record(record) {
        const frame = record.frame === undefined
            ? 0
            : nonNegativeInteger(record.frame, 'resource trace frame');
        const stage = record.stage ?? record.type ?? 'ResourceEvent';
        const {
            frame: ignoredFrame,
            stage: ignoredStage,
            type: ignoredType,
            sourceId: ignoredSourceId,
            ownerId: ignoredOwnerId,
            targetId: ignoredTargetId,
            reason: ignoredReason,
            ruleId: ignoredRuleId,
            ...extra
        } = record;
        const normalized = {
            frame,
            stage,
            type: record.type ?? stage,
            sourceId: record.sourceId ?? null,
            ownerId: record.ownerId ?? null,
            targetId: record.targetId ?? null,
            reason: record.reason ?? null,
            ruleId: record.ruleId ?? null,
            ...extra
        };
        this.trace.push(normalized);
        return normalized;
    }

    registerPool(definition) {
        const pool = normalizePoolDefinition(definition, null, this.tickRate);
        if (this.pools.has(pool.id)) throw new Error(`Resource pool already exists: ${pool.id}`);
        if (this.clockDomainManager?.hasDomain
            && !this.clockDomainManager.hasDomain(pool.clockDomainId)) {
            throw new Error(`Unknown clock domain for resource pool: ${pool.clockDomainId}`);
        }
        this.pools.set(pool.id, pool);
        this.#record({
            frame: 0,
            stage: 'ResourcePoolRegistered',
            poolId: pool.id,
            resourceType: pool.resourceType,
            scope: pool.scope,
            clockDomainId: pool.clockDomainId,
            sourceId: null,
            ownerId: pool.ownerId,
            targetId: pool.scope === 'Entity' ? pool.ownerId : null,
            reason: 'RegisterPool',
            ruleId: null,
            before: 0,
            requested: pool.initial,
            requestedDelta: pool.initial,
            actual: pool.initial,
            actualDelta: pool.initial,
            discarded: 0,
            discardedDelta: 0,
            after: pool.initial,
            cap: pool.max,
            returnedBefore: 0,
            returnedAfter: pool.returned,
            ordinaryBefore: 0,
            ordinaryAfter: pool.initial - pool.returned
        });
        if (pool.passiveRecovery && (this.schedule || this.clockDomainManager)) {
            this.#schedulePassive(pool, 0);
        }
        return this.#publicPool(pool);
    }

    hasPool(poolRef) {
        if (typeof poolRef === 'string'
            || (typeof poolRef === 'number' && Number.isFinite(poolRef))) return this.pools.has(poolRef);
        if (!isObjectStyle(poolRef)) return false;
        const id = poolRef.poolId ?? poolRef.id ?? poolRef.resourcePoolId;
        return typeof id === 'string' && this.pools.has(id);
    }

    #pool(poolRef) {
        let id = null;
        if (typeof poolRef === 'string') {
            id = poolRef;
        } else if (isObjectStyle(poolRef)) {
            id = poolRef.poolId ?? poolRef.id ?? poolRef.resourcePoolId ?? null;
            if (id === null && poolRef.resourceType !== undefined) {
                const resourceType = identifier(poolRef.resourceType, 'resourceType');
                const scope = poolRef.scope ?? null;
                const ownerId = identifier(poolRef.ownerId, 'ownerId', { allowNull: true });
                const matches = [...this.pools.values()].filter(pool =>
                    pool.resourceType === resourceType
                    && (scope === null || pool.scope === scope)
                    && (ownerId === null || pool.ownerId === ownerId)
                );
                if (matches.length === 1) return matches[0];
                if (matches.length > 1) {
                    throw new Error(`Ambiguous resource pool for ${resourceType}.`);
                }
            }
        }
        if (typeof id !== 'string' || id.trim() === '') {
            throw new TypeError('A resource pool id or descriptor is required.');
        }
        const pool = this.pools.get(id);
        if (!pool) throw new Error(`Unknown resource pool: ${id}`);
        return pool;
    }

    #publicPool(pool) {
        return {
            id: pool.id,
            poolId: pool.id,
            resourceType: pool.resourceType,
            scope: pool.scope,
            ownerId: pool.ownerId,
            initial: pool.initial,
            current: pool.current,
            value: pool.current,
            max: pool.max,
            trackReturned: pool.trackReturned,
            returned: pool.returned,
            reserved: pool.returned,
            ordinary: pool.current - pool.returned,
            recoverySuspensions: [...pool.recoverySuspensions.values()].map(clone),
            gainSuppressions: [...pool.gainSuppressions.values()].map(clone),
            passiveRecovery: pool.passiveRecovery ? { ...pool.passiveRecovery } : null,
            clockDomainId: pool.clockDomainId,
            metadata: clone(pool.metadata)
        };
    }

    resolvePool(poolRef) {
        const pool = this.#pool(poolRef);
        this.#record({
            frame: isObjectStyle(poolRef) ? (poolRef.frame ?? 0) : 0,
            stage: 'ResourcePoolResolved',
            poolId: pool.id,
            resourceType: pool.resourceType,
            scope: pool.scope,
            clockDomainId: pool.clockDomainId,
            sourceId: null,
            ownerId: pool.ownerId,
            targetId: pool.scope === 'Entity' ? pool.ownerId : null,
            reason: 'ResolvePool',
            ruleId: null
        });
        return this.#publicPool(pool);
    }

    describePool(poolRef) {
        return this.#publicPool(this.#pool(poolRef));
    }

    get(poolRef, frame = 0) {
        const pool = this.#pool(poolRef);
        const atFrame = nonNegativeInteger(frame, 'resource read frame');
        this.#record({
            frame: atFrame,
            stage: 'ResourceRead',
            poolId: pool.id,
            resourceType: pool.resourceType,
            sourceId: null,
            ownerId: pool.ownerId,
            targetId: pool.scope === 'Entity' ? pool.ownerId : null,
            reason: 'Get',
            ruleId: null,
            before: pool.current,
            requested: 0,
            actual: 0,
            discarded: 0,
            after: pool.current,
            cap: pool.max
        });
        return pool.current;
    }

    canPay(poolRef, amount, frame = 0) {
        const pool = this.#pool(poolRef);
        const cost = nonNegativeNumber(amount, `${pool.id} cost`);
        const atFrame = nonNegativeInteger(frame, 'resource read frame');
        const result = pool.current >= cost;
        this.#record({
            frame: atFrame,
            stage: 'ResourceCanPay',
            poolId: pool.id,
            resourceType: pool.resourceType,
            sourceId: null,
            ownerId: pool.ownerId,
            targetId: pool.scope === 'Entity' ? pool.ownerId : null,
            reason: 'CanPay',
            ruleId: null,
            before: pool.current,
            requested: cost,
            actual: result ? cost : 0,
            discarded: result ? 0 : cost,
            after: pool.current,
            cap: pool.max,
            success: result
        });
        return result;
    }

    #parseChangeArgs(args, operation) {
        if (args.length === 0) throw new TypeError(`${operation} requires input.`);
        let input;
        if (isObjectStyle(args[0])) {
            input = { ...args[0] };
            input.poolRef = input.poolRef ?? input.poolId ?? input.pool ?? input.resourcePoolId
                ?? (input.resourceType ? input : input.id);
        } else if (typeof args[0] === 'number') {
            input = {
                frame: args[0],
                poolRef: args[1],
                amount: args[2],
                reason: args[3],
                sourceId: args[4]
            };
        } else {
            input = {
                poolRef: args[0],
                amount: args[1],
                ...(isObjectStyle(args[2]) ? args[2] : { reason: args[2], sourceId: args[3] })
            };
        }
        input.frame = nonNegativeInteger(input.frame ?? 0, `${operation} frame`);
        input.amount = nonNegativeNumber(input.amount, `${operation} amount`);
        input.reason = input.reason ?? (operation === 'spend' ? 'Spend' : 'Gain');
        input.sourceId = identifier(input.sourceId, `${operation} sourceId`, { allowNull: true });
        input.ownerId = identifier(input.ownerId, `${operation} ownerId`, { allowNull: true });
        input.targetId = identifier(input.targetId, `${operation} targetId`, { allowNull: true });
        input.ruleId = identifier(input.ruleId, `${operation} ruleId`, { allowNull: true });
        input.resourceSourceType = input.resourceSourceType ?? input.atbSourceType ?? null;
        input.resourceGainMethod = input.resourceGainMethod ?? input.atbGainMethod ?? null;
        input.resourceGainTags = normalizedTags(
            input.resourceGainTags ?? input.uspRecoverTags ?? input.uspRecoverTag
        );
        input.commandId = identifier(input.commandId, `${operation} commandId`, { allowNull: true });
        input.castId = identifier(input.castId, `${operation} castId`, { allowNull: true });
        input.skillId = identifier(input.skillId, `${operation} skillId`, { allowNull: true });
        input.replaceReturnedOnCap = input.replaceReturnedOnCap !== false;
        input.spendReturnedFirst = input.spendReturnedFirst !== false;
        input.strict = input.strict === undefined ? this.strictSpend : input.strict;
        if (typeof input.strict !== 'boolean') throw new TypeError(`${operation} strict must be boolean.`);
        return input;
    }

    #change(pool, input, operation) {
        const requestedAmount = input.amount;
        const before = pool.current;
        const returnedBefore = pool.returned;
        if (operation === 'gain' && pool.gainSuppressions.size > 0) {
            const matchingSuppression = [...pool.gainSuppressions.values()].find(suppression =>
                suppression.tags.length === 0
                || suppression.tags.some(tag => input.resourceGainTags.includes(tag))
            );
            if (matchingSuppression) {
                return this.#record({
                    frame: input.frame,
                    stage: 'ResourceGainSuppressed',
                    type: 'GainSuppressed',
                    kind: 'Gain',
                    poolId: pool.id,
                    resourceType: pool.resourceType,
                    scope: pool.scope,
                    clockDomainId: pool.clockDomainId,
                    sourceId: input.sourceId,
                    ownerId: input.ownerId ?? pool.ownerId,
                    targetId: input.targetId ?? (pool.scope === 'Entity' ? pool.ownerId : null),
                    reason: input.reason,
                    ruleId: input.ruleId,
                    commandId: input.commandId,
                    castId: input.castId,
                    skillId: input.skillId,
                    resourceSourceType: input.resourceSourceType,
                    resourceGainMethod: input.resourceGainMethod,
                    resourceGainTags: clone(input.resourceGainTags),
                    suppressionToken: matchingSuppression.token,
                    suppressionTags: clone(matchingSuppression.tags),
                    before,
                    requested: requestedAmount,
                    requestedAmount,
                    requestedDelta: requestedAmount,
                    actual: 0,
                    actualAmount: 0,
                    actualDelta: 0,
                    discarded: requestedAmount,
                    discardedAmount: requestedAmount,
                    discardedDelta: requestedAmount,
                    after: before,
                    cap: pool.max,
                    returnedBefore,
                    returnedAfter: returnedBefore,
                    ordinaryBefore: before - returnedBefore,
                    ordinaryAfter: before - returnedBefore,
                    success: false,
                    failure: 'ResourceGainSuppressed'
                });
            }
        }
        let success = true;
        let actualAmount = requestedAmount;
        let failure = null;
        let returnedGained = 0;
        let returnedSpent = 0;
        let returnedReplaced = 0;
        let eligibleSpend = 0;
        if (operation === 'gain') {
            actualAmount = Math.min(requestedAmount, pool.max - before);
            pool.current += actualAmount;
            const gainMethod = String(input.resourceGainMethod ?? '').toLowerCase();
            if (pool.trackReturned && gainMethod === 'return') {
                returnedGained = actualAmount;
                pool.returned += returnedGained;
            } else if (pool.trackReturned && input.replaceReturnedOnCap) {
                // Normal recovery has precedence over returned ATB at the cap.
                // It replaces the returned composition without changing the
                // displayed total, matching Calc's reserved-ATB boundary.
                returnedReplaced = Math.min(
                    requestedAmount - actualAmount,
                    pool.returned
                );
                pool.returned -= returnedReplaced;
            }
        } else {
            if (requestedAmount > before) {
                success = false;
                actualAmount = 0;
                failure = 'InsufficientResource';
            } else {
                pool.current -= requestedAmount;
                actualAmount = requestedAmount;
                if (pool.trackReturned && input.spendReturnedFirst) {
                    returnedSpent = Math.min(requestedAmount, pool.returned);
                    pool.returned -= returnedSpent;
                }
                eligibleSpend = actualAmount - returnedSpent;
            }
        }
        const requestedDelta = operation === 'gain' ? requestedAmount : -requestedAmount;
        const actualDelta = operation === 'gain' ? actualAmount : -actualAmount;
        const discardedAmount = requestedAmount - actualAmount;
        const record = this.#record({
            frame: input.frame,
            stage: operation === 'gain' ? 'ResourceGained' : 'ResourceSpent',
            type: operation === 'gain' ? 'Gain' : 'Spend',
            kind: operation === 'gain' ? 'Gain' : 'Spend',
            poolId: pool.id,
            resourceType: pool.resourceType,
            scope: pool.scope,
            clockDomainId: pool.clockDomainId,
            sourceId: input.sourceId,
            ownerId: input.ownerId ?? pool.ownerId,
            targetId: input.targetId ?? (pool.scope === 'Entity' ? pool.ownerId : null),
            reason: input.reason,
            ruleId: input.ruleId,
            commandId: input.commandId,
            castId: input.castId,
            skillId: input.skillId,
            resourceSourceType: input.resourceSourceType,
            resourceGainMethod: input.resourceGainMethod,
            resourceGainTags: clone(input.resourceGainTags),
            before,
            requested: requestedAmount,
            requestedAmount,
            requestedDelta,
            actual: actualAmount,
            actualAmount,
            actualDelta,
            discarded: discardedAmount,
            discardedAmount,
            discardedDelta: requestedDelta - actualDelta,
            after: pool.current,
            cap: pool.max,
            returnedBefore,
            returnedGained,
            returnedSpent,
            returnedReplaced,
            returnedAfter: pool.returned,
            reservedBefore: returnedBefore,
            reservedAfter: pool.returned,
            ordinaryBefore: before - returnedBefore,
            ordinaryAfter: pool.current - pool.returned,
            eligibleSpend,
            uspEligibleSpend: eligibleSpend,
            uspEligibilityRatio: operation === 'spend' && actualAmount > 0
                ? eligibleSpend / actualAmount
                : null,
            success,
            failure,
            insufficient: failure === 'InsufficientResource',
            shortfall: failure ? requestedAmount - before : 0
        });
        if (operation === 'spend' && success && pool.passiveRecovery) {
            const localFrame = this.#localFrame(pool, input.frame);
            pool.resumeAfterLocalFrame = Math.max(
                pool.resumeAfterLocalFrame ?? 0,
                localFrame + pool.passiveRecovery.resumeDelayTicksAfterSpend
            );
        }
        if (operation === 'spend' && success && pool.resourceType === 'Atb') {
            this.#rememberSpend(record);
        }
        if (!success && input.strict) {
            throw new Error(
                `Insufficient ${pool.resourceType}: need ${requestedAmount}, have ${before}.`
            );
        }
        return record;
    }

    #spendLedgerKeys(input) {
        return [
            input.castId === null || input.castId === undefined
                ? null
                : `cast:${String(input.castId)}`,
            input.commandId === null || input.commandId === undefined
                ? null
                : `command:${String(input.commandId)}`
        ].filter(Boolean);
    }

    #rememberSpend(record) {
        for (const key of this.#spendLedgerKeys(record)) {
            const previous = this.spendLedger.get(key) ?? {
                requested: 0,
                actual: 0,
                returnedSpent: 0,
                eligibleSpend: 0,
                events: []
            };
            previous.requested += record.requestedAmount;
            previous.actual += record.actualAmount;
            previous.returnedSpent += record.returnedSpent;
            previous.eligibleSpend += record.eligibleSpend;
            previous.events.push({
                frame: record.frame,
                poolId: record.poolId,
                skillId: record.skillId,
                sourceId: record.sourceId
            });
            this.spendLedger.set(key, previous);
        }
    }

    spendEligibility(input = {}) {
        const descriptor = isObjectStyle(input) ? input : { castId: input };
        const key = descriptor.castId !== null && descriptor.castId !== undefined
            ? `cast:${String(descriptor.castId)}`
            : (descriptor.commandId !== null && descriptor.commandId !== undefined
                ? `command:${String(descriptor.commandId)}`
                : null);
        const entry = key === null ? null : this.spendLedger.get(key);
        if (!entry) return {
            found: false,
            requested: 0,
            actual: 0,
            returnedSpent: 0,
            eligibleSpend: 0,
            ratio: 1,
            events: []
        };
        return {
            found: true,
            ...clone(entry),
            ratio: entry.actual > 0 ? entry.eligibleSpend / entry.actual : 1
        };
    }

    gain(...args) {
        const input = this.#parseChangeArgs(args, 'gain');
        const pool = this.#pool(input.poolRef);
        return this.#change(pool, input, 'gain');
    }

    spend(...args) {
        const input = this.#parseChangeArgs(args, 'spend');
        const pool = this.#pool(input.poolRef);
        return this.#change(pool, input, 'spend');
    }

    #matchingPools(input) {
        if (input.poolRef !== undefined || input.poolId !== undefined
            || input.resourcePoolId !== undefined) {
            return [this.#pool(input.poolRef ?? input.poolId ?? input.resourcePoolId)];
        }
        const resourceType = input.resourceType ?? null;
        const scope = input.scope ?? null;
        const ownerId = input.ownerId ?? null;
        const matches = [...this.pools.values()].filter(pool =>
            (resourceType === null || pool.resourceType === resourceType)
            && (scope === null || pool.scope === scope)
            && (ownerId === null || pool.ownerId === ownerId)
        );
        if (matches.length === 0) throw new Error('No resource pool matches recovery suspension.');
        return matches;
    }

    suspendRecovery(input = {}) {
        if (!isObjectStyle(input)) throw new TypeError('suspendRecovery requires an object.');
        const frame = nonNegativeInteger(input.frame ?? 0, 'recovery suspension frame');
        const delayTicks = nonNegativeInteger(input.delayTicks ?? 0, 'recovery suspension delayTicks');
        const token = identifier(
            input.token ?? input.sourceKey ?? input.castId,
            'recovery suspension token'
        );
        const results = [];
        for (const pool of this.#matchingPools(input)) {
            const suspension = {
                token,
                poolId: pool.id,
                frame,
                activeFromFrame: frame + delayTicks,
                sourceId: input.sourceId ?? null,
                ownerId: input.ownerId ?? pool.ownerId,
                castId: input.castId ?? null,
                skillId: input.skillId ?? null,
                reason: input.reason ?? 'SuspendRecovery'
            };
            pool.recoverySuspensions.set(token, suspension);
            results.push(this.#record({
                ...suspension,
                stage: 'ResourceRecoverySuspended',
                type: 'SuspendRecovery',
                resourceType: pool.resourceType,
                scope: pool.scope,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                ruleId: input.ruleId ?? null
            }));
        }
        return results.length === 1 ? results[0] : results;
    }

    resumeRecovery(input = {}) {
        if (!isObjectStyle(input)) throw new TypeError('resumeRecovery requires an object.');
        const frame = nonNegativeInteger(input.frame ?? 0, 'recovery resume frame');
        const token = identifier(
            input.token ?? input.sourceKey ?? input.castId,
            'recovery suspension token'
        );
        const results = [];
        for (const pool of this.#matchingPools(input)) {
            const suspension = pool.recoverySuspensions.get(token);
            if (!suspension) continue;
            pool.recoverySuspensions.delete(token);
            results.push(this.#record({
                frame,
                stage: 'ResourceRecoveryResumed',
                type: 'ResumeRecovery',
                poolId: pool.id,
                resourceType: pool.resourceType,
                scope: pool.scope,
                sourceId: input.sourceId ?? suspension.sourceId,
                ownerId: input.ownerId ?? suspension.ownerId,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                reason: input.reason ?? 'ResumeRecovery',
                ruleId: input.ruleId ?? null,
                token,
                castId: suspension.castId,
                skillId: suspension.skillId,
                activeFromFrame: suspension.activeFromFrame
            }));
        }
        return results.length === 1 ? results[0] : results;
    }

    resumeRecoveryByCastId(castId, frame = 0, reason = 'CastEnded') {
        const id = identifier(castId, 'recovery suspension castId');
        const results = [];
        for (const pool of this.pools.values()) {
            for (const suspension of [...pool.recoverySuspensions.values()]) {
                if (suspension.castId !== id) continue;
                results.push(this.resumeRecovery({
                    frame,
                    poolRef: pool.id,
                    token: suspension.token,
                    sourceId: suspension.sourceId,
                    ownerId: suspension.ownerId,
                    reason
                }));
            }
        }
        return results;
    }

    suppressGain(input = {}) {
        if (!isObjectStyle(input)) throw new TypeError('suppressGain requires an object.');
        const frame = nonNegativeInteger(input.frame ?? 0, 'resource gain suppression frame');
        const token = identifier(
            input.token ?? input.sourceKey ?? input.castId,
            'resource gain suppression token'
        );
        const tags = normalizedTags(input.tags ?? input.resourceGainTags);
        const results = [];
        for (const pool of this.#matchingPools(input)) {
            const suppression = {
                token,
                poolId: pool.id,
                frame,
                tags,
                sourceId: input.sourceId ?? null,
                ownerId: input.ownerId ?? pool.ownerId,
                castId: input.castId ?? null,
                skillId: input.skillId ?? null,
                reason: input.reason ?? 'SuppressResourceGain'
            };
            pool.gainSuppressions.set(token, suppression);
            results.push(this.#record({
                ...suppression,
                stage: 'ResourceGainSuppressionStarted',
                type: 'SuppressResourceGain',
                resourceType: pool.resourceType,
                scope: pool.scope,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                ruleId: input.ruleId ?? null
            }));
        }
        return results.length === 1 ? results[0] : results;
    }

    resumeGain(input = {}) {
        if (!isObjectStyle(input)) throw new TypeError('resumeGain requires an object.');
        const frame = nonNegativeInteger(input.frame ?? 0, 'resource gain resume frame');
        const token = identifier(
            input.token ?? input.sourceKey ?? input.castId,
            'resource gain suppression token'
        );
        const results = [];
        for (const pool of this.#matchingPools(input)) {
            const suppression = pool.gainSuppressions.get(token);
            if (!suppression) continue;
            pool.gainSuppressions.delete(token);
            results.push(this.#record({
                frame,
                stage: 'ResourceGainSuppressionEnded',
                type: 'ResumeResourceGain',
                poolId: pool.id,
                resourceType: pool.resourceType,
                scope: pool.scope,
                sourceId: input.sourceId ?? suppression.sourceId,
                ownerId: input.ownerId ?? suppression.ownerId,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                reason: input.reason ?? 'ResumeResourceGain',
                ruleId: input.ruleId ?? null,
                token,
                tags: clone(suppression.tags),
                castId: suppression.castId,
                skillId: suppression.skillId
            }));
        }
        return results.length === 1 ? results[0] : results;
    }

    #parseTransferArgs(args) {
        if (args.length === 0) throw new TypeError('transfer requires input.');
        let input;
        if (isObjectStyle(args[0])) {
            input = { ...args[0] };
        } else {
            input = {
                fromPoolId: args[0],
                toPoolId: args[1],
                amount: args[2],
                ...(isObjectStyle(args[3]) ? args[3] : { reason: args[3], sourceId: args[4] })
            };
        }
        input.fromPoolRef = input.fromPoolRef ?? input.fromPoolId ?? input.sourcePoolId
            ?? input.from;
        input.toPoolRef = input.toPoolRef ?? input.toPoolId ?? input.targetPoolId ?? input.to;
        if (input.fromPoolRef === undefined || input.toPoolRef === undefined) {
            throw new TypeError('transfer requires fromPoolId and toPoolId.');
        }
        input.frame = nonNegativeInteger(input.frame ?? 0, 'transfer frame');
        input.amount = nonNegativeNumber(input.amount, 'transfer amount');
        input.sourceId = identifier(input.sourceId, 'transfer sourceId', { allowNull: true });
        input.ownerId = identifier(input.ownerId, 'transfer ownerId', { allowNull: true });
        input.targetId = identifier(input.targetId, 'transfer targetId', { allowNull: true });
        input.reason = input.reason ?? 'Transfer';
        input.ruleId = identifier(input.ruleId, 'transfer ruleId', { allowNull: true });
        return input;
    }

    transfer(...args) {
        const input = this.#parseTransferArgs(args);
        const source = this.#pool(input.fromPoolRef);
        const target = this.#pool(input.toPoolRef);
        if (source.id === target.id) throw new Error('Cannot transfer a resource pool to itself.');
        const sourceBefore = source.current;
        const targetBefore = target.current;
        const capacity = target.max - target.current;
        const available = Math.min(input.amount, source.current, capacity);
        const sufficient = source.current >= input.amount;
        if (!sufficient || capacity <= 0) {
            const rejected = this.#record({
                frame: input.frame,
                stage: 'ResourceTransferRejected',
                type: 'Transfer',
                fromPoolId: source.id,
                toPoolId: target.id,
                resourceType: source.resourceType,
                sourceId: input.sourceId,
                ownerId: input.ownerId ?? source.ownerId,
                targetId: input.targetId ?? target.ownerId,
                reason: input.reason,
                ruleId: input.ruleId,
                before: sourceBefore,
                requested: input.amount,
                actual: 0,
                discarded: input.amount,
                after: sourceBefore,
                sourceBefore,
                sourceAfter: sourceBefore,
                targetBefore,
                targetAfter: targetBefore,
                success: false,
                failure: !sufficient ? 'InsufficientResource' : 'TargetPoolFull'
            });
            return rejected;
        }

        // Transfer only the amount accepted by the target.  In the normal
        // case this equals the request; target capacity is still checked so a
        // capped destination cannot destroy source resource.
        const changeInput = {
            frame: input.frame,
            amount: available,
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            targetId: input.targetId ?? target.ownerId,
            reason: input.reason,
            ruleId: input.ruleId,
            strict: false
        };
        this.#change(source, changeInput, 'spend');
        this.#change(target, changeInput, 'gain');
        return this.#record({
            frame: input.frame,
            stage: 'ResourceTransferred',
            type: 'Transfer',
            fromPoolId: source.id,
            toPoolId: target.id,
            resourceType: source.resourceType,
            sourceId: input.sourceId,
            ownerId: input.ownerId ?? source.ownerId,
            targetId: input.targetId ?? target.ownerId,
            reason: input.reason,
            ruleId: input.ruleId,
            before: sourceBefore,
            requested: input.amount,
            actual: available,
            discarded: input.amount - available,
            after: source.current,
            sourceBefore,
            sourceAfter: source.current,
            targetBefore,
            targetAfter: target.current,
            success: true
        });
    }

    #localFrame(pool, frame) {
        if (this.clockDomainManager) {
            return nonNegativeInteger(
                this.clockDomainManager.localFrameAt(pool.clockDomainId, frame),
                `${pool.id} local frame`
            );
        }
        return frame;
    }

    #schedulePassive(pool, startFrame) {
        const run = completionFrame => {
            this.#processPassive(pool, completionFrame);
            this.#schedulePassive(pool, completionFrame);
        };
        if (this.clockDomainManager) {
            this.clockDomainManager.startTimer(pool.clockDomainId, {
                frame: startFrame,
                durationTicks: 1,
                priority: 2,
                label: `resource-passive:${pool.id}`,
                sourceId: null,
                ownerId: pool.ownerId,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                reason: 'PassiveRecovery',
                onComplete: run
            });
            return;
        }
        const completionFrame = startFrame + 1;
        this.schedule(completionFrame, 2, () => run(completionFrame),
            `resource-passive:${pool.id}`);
    }

    #processPassive(pool, frame) {
        if (!pool.passiveRecovery) return [];
        const localFrame = this.#localFrame(pool, frame);
        if (pool.nextRecoveryLocalFrame === undefined) {
            pool.nextRecoveryLocalFrame = pool.passiveRecovery.firstTickFrame;
        }
        const suspensions = [...pool.recoverySuspensions.values()].filter(suspension =>
            frame >= suspension.activeFromFrame
        );
        if (suspensions.length > 0) {
            pool.nextRecoveryLocalFrame = Math.max(
                pool.nextRecoveryLocalFrame,
                localFrame + 1
            );
            this.#record({
                frame,
                stage: 'ResourceRecoverySuppressed',
                type: 'RecoverySuppressed',
                poolId: pool.id,
                resourceType: pool.resourceType,
                scope: pool.scope,
                sourceId: suspensions[0].sourceId,
                ownerId: pool.ownerId,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                reason: 'ExplicitSuspension',
                ruleId: null,
                suspensionTokens: suspensions.map(item => item.token),
                before: pool.current,
                after: pool.current,
                returnedBefore: pool.returned,
                returnedAfter: pool.returned
            });
            return [];
        }
        if (pool.resumeAfterLocalFrame !== undefined
            && localFrame < pool.resumeAfterLocalFrame) {
            // Recovery ticks inside a post-spend delay are suppressed, not
            // deferred. Advancing the cursor prevents all skipped ticks from
            // being paid out together on the first eligible frame.
            pool.nextRecoveryLocalFrame = Math.max(
                pool.nextRecoveryLocalFrame,
                localFrame + 1
            );
            return [];
        }
        const changes = [];
        while (pool.nextRecoveryLocalFrame <= localFrame) {
            const change = this.#change(pool, {
                frame,
                amount: pool.passiveRecovery.amountPerTick,
                sourceId: null,
                ownerId: pool.ownerId,
                targetId: pool.scope === 'Entity' ? pool.ownerId : null,
                reason: 'PassiveRecovery',
                ruleId: null,
                strict: false
            }, 'gain');
            changes.push(change);
            pool.nextRecoveryLocalFrame += 1;
        }
        return changes;
    }

    tick(frame) {
        const atFrame = nonNegativeInteger(frame, 'resource tick frame');
        const changes = [];
        for (const pool of this.pools.values()) changes.push(...this.#processPassive(pool, atFrame));
        this.#record({
            frame: atFrame,
            stage: 'ResourceTick',
            type: 'Tick',
            sourceId: null,
            ownerId: null,
            targetId: null,
            reason: 'Tick',
            ruleId: null,
            changedPools: changes.map(change => change.poolId)
        });
        return changes;
    }

    snapshot() {
        const pools = [...this.pools.values()].map(pool => this.#publicPool(pool));
        const byPoolId = Object.fromEntries(pools.map(pool => [String(pool.id), pool]));
        // Arrays match the other generic machines' snapshot convention.  The
        // keyed properties keep descriptor-style callers convenient without
        // making the public shape depend on insertion order.
        for (const [id, pool] of Object.entries(byPoolId)) pools[id] = pool;
        const snapshot = {
            pools,
            byPoolId,
            trace: this.trace.map(record => clone(record))
        };
        for (const [id, pool] of Object.entries(byPoolId)) snapshot[id] = pool;
        return snapshot;
    }
}

export default ResourceSystem;
