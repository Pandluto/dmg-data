function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`);
    return number;
}

function normalizeDefinition(resourceType, definition, tickRate) {
    const initial = finiteNumber(definition.initial, `${resourceType}.initial`);
    const max = finiteNumber(definition.max, `${resourceType}.max`);
    if (max < 0 || initial < 0 || initial > max) {
        throw new Error(`Invalid ${resourceType} range: initial=${initial}, max=${max}.`);
    }
    let passiveRecovery = null;
    if (definition.passiveRecovery) {
        const ratePerSecond = finiteNumber(
            definition.passiveRecovery.ratePerSecond,
            `${resourceType}.passiveRecovery.ratePerSecond`
        );
        const quantization = definition.passiveRecovery.quantization ?? 'none';
        const rawPerTick = ratePerSecond / tickRate;
        const amountPerTick = quantization === 'float32' ? Math.fround(rawPerTick) : rawPerTick;
        const firstTickFrame = Number(definition.passiveRecovery.firstTickFrame ?? 1);
        const resumeDelayTicksAfterSpend = Number(
            definition.passiveRecovery.resumeDelayTicksAfterSpend ?? 0
        );
        if (!Number.isInteger(firstTickFrame) || firstTickFrame < 0) {
            throw new Error(`${resourceType}.passiveRecovery.firstTickFrame must be a non-negative integer.`);
        }
        if (!Number.isInteger(resumeDelayTicksAfterSpend)
            || resumeDelayTicksAfterSpend < 0) {
            throw new Error(
                `${resourceType}.passiveRecovery.resumeDelayTicksAfterSpend must be a non-negative integer.`
            );
        }
        passiveRecovery = {
            ratePerSecond,
            amountPerTick,
            quantization,
            firstTickFrame,
            resumeDelayTicksAfterSpend
        };
    }
    return { initial, max, passiveRecovery };
}

export class ResourceMachine {
    constructor({ definitions, schedule, tickRate = 30 }) {
        if (!definitions || typeof definitions !== 'object') {
            throw new Error('Resource definitions are required.');
        }
        this.schedule = schedule;
        this.tickRate = tickRate;
        this.definitions = Object.fromEntries(Object.entries(definitions)
            .map(([resourceType, definition]) => [
                resourceType,
                normalizeDefinition(resourceType, definition, tickRate)
            ]));
        this.values = {};
        this.passiveResumeFrames = {};
        this.trace = [];

        for (const [resourceType, definition] of Object.entries(this.definitions)) {
            this.values[resourceType] = definition.initial;
            this.passiveResumeFrames[resourceType] = definition.passiveRecovery?.firstTickFrame
                ?? Number.POSITIVE_INFINITY;
            this.trace.push({
                frame: 0,
                resourceType,
                kind: 'Initialize',
                before: 0,
                requestedDelta: definition.initial,
                actualDelta: definition.initial,
                discardedDelta: 0,
                after: definition.initial,
                cap: definition.max,
                reason: 'Initialize',
                skillId: null
            });
            if (definition.passiveRecovery) {
                this.#schedulePassiveTick(resourceType, definition.passiveRecovery.firstTickFrame);
            }
        }
    }

    #definition(resourceType) {
        const definition = this.definitions[resourceType];
        if (!definition) throw new Error(`Unknown resource type: ${resourceType}`);
        return definition;
    }

    #schedulePassiveTick(resourceType, frame) {
        this.schedule(frame, 2, () => {
            const definition = this.#definition(resourceType);
            const passive = definition.passiveRecovery;
            if (frame >= this.passiveResumeFrames[resourceType]) {
                this.#change({
                    frame,
                    resourceType,
                    requestedDelta: passive.amountPerTick,
                    kind: 'PassiveRecovery',
                    reason: 'PassiveRecovery',
                    skillId: null,
                    recordZeroActual: false
                });
            }
            this.#schedulePassiveTick(resourceType, frame + 1);
        }, `resource-passive:${resourceType}`);
    }

    #change({ frame, resourceType, requestedDelta, kind, reason, skillId,
        recordZeroActual = true }) {
        const definition = this.#definition(resourceType);
        const delta = finiteNumber(requestedDelta, `${resourceType} delta`);
        if (delta === 0 && kind !== 'Initialize') return null;
        const before = this.values[resourceType];
        const after = Math.max(0, Math.min(definition.max, before + delta));
        const actualDelta = after - before;
        this.values[resourceType] = after;
        if (!recordZeroActual && actualDelta === 0) return null;
        const record = {
            frame,
            resourceType,
            kind,
            before,
            requestedDelta: delta,
            actualDelta,
            discardedDelta: delta - actualDelta,
            after,
            cap: definition.max,
            reason,
            skillId
        };
        this.trace.push(record);
        return record;
    }

    gain(frame, resourceType, amount, reason = 'Gain', skillId = null) {
        const positiveAmount = finiteNumber(amount, `${resourceType} gain`);
        if (positiveAmount < 0) throw new Error(`${resourceType} gain must be non-negative.`);
        return this.#change({
            frame,
            resourceType,
            requestedDelta: positiveAmount,
            kind: 'Gain',
            reason,
            skillId
        });
    }

    spend(frame, resourceType, amount, reason = 'CastCost', skillId = null) {
        const positiveAmount = finiteNumber(amount, `${resourceType} spend`);
        if (positiveAmount < 0) throw new Error(`${resourceType} spend must be non-negative.`);
        if (!this.canPay(resourceType, positiveAmount)) {
            throw new Error(`Insufficient ${resourceType}: need ${positiveAmount}, have ${this.get(resourceType)}.`);
        }
        const record = this.#change({
            frame,
            resourceType,
            requestedDelta: -positiveAmount,
            kind: 'Spend',
            reason,
            skillId
        });
        const passive = this.#definition(resourceType).passiveRecovery;
        if (passive) {
            this.passiveResumeFrames[resourceType] = Math.max(
                this.passiveResumeFrames[resourceType],
                frame + passive.resumeDelayTicksAfterSpend
            );
        }
        return record;
    }

    canPay(resourceType, amount) {
        return this.get(resourceType) >= finiteNumber(amount, `${resourceType} cost`);
    }

    get(resourceType) {
        this.#definition(resourceType);
        return this.values[resourceType];
    }

    snapshot() {
        return { ...this.values };
    }
}
