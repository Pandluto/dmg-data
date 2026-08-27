function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`);
    return number;
}

function normalizeKnots(percentages = [], buffIds = [], durationTicksByBuffId = {}) {
    return percentages.map((percentage, index) => {
        const normalized = finiteNumber(percentage, `poise knot ${index}`);
        if (normalized <= 0 || normalized >= 1) {
            throw new Error(`Poise knot ${index} must be between 0 and 1.`);
        }
        const buffId = buffIds[index] ?? null;
        return {
            index,
            percentage: normalized,
            buffId,
            durationTicks: buffId === null
                ? null
                : Number(durationTicksByBuffId[buffId] ?? 0)
        };
    }).sort((left, right) => left.percentage - right.percentage);
}

function normalizeRapidBreakPolicy(policy = null) {
    if (!policy?.enabled) return { enabled: false };
    const qualifyingTicks = finiteNumber(policy.qualifyingTicks, 'rapid-break qualifyingTicks');
    const guardDurationTicks = finiteNumber(
        policy.guardDurationTicks,
        'rapid-break guardDurationTicks'
    );
    const minimumTakenScalar = finiteNumber(
        policy.minimumTakenScalar,
        'rapid-break minimumTakenScalar'
    );
    const lifecycleOffsetTicks = finiteNumber(
        policy.lifecycleOffsetTicks ?? 1,
        'rapid-break lifecycleOffsetTicks'
    );
    if (!Number.isInteger(qualifyingTicks) || qualifyingTicks <= 0) {
        throw new Error('rapid-break qualifyingTicks must be a positive integer.');
    }
    if (!Number.isInteger(guardDurationTicks) || guardDurationTicks < 0
        || !Number.isInteger(lifecycleOffsetTicks) || lifecycleOffsetTicks < 0) {
        throw new Error('rapid-break guard durations must be non-negative integers.');
    }
    if (minimumTakenScalar < 0 || minimumTakenScalar > 1) {
        throw new Error('rapid-break minimumTakenScalar must be between 0 and 1.');
    }
    return {
        enabled: true,
        qualifyingTicks,
        guardDurationTicks,
        minimumTakenScalar,
        lifecycleOffsetTicks,
        interpolation: policy.interpolation ?? 'linear-to-one',
        buffId: policy.buffId ?? null,
        profileId: policy.profileId ?? null,
        evidence: policy.evidence ?? []
    };
}

export class PoiseMachine {
    constructor({ definition, schedule = () => {}, localClock = null,
        onKnot = () => {}, onBroken = () => {}, onRecovered = () => {}, tickRate = 30 }) {
        if (!definition || typeof definition !== 'object') {
            throw new Error('Poise definition is required.');
        }
        if (typeof onKnot !== 'function'
            || typeof onBroken !== 'function'
            || typeof onRecovered !== 'function') {
            throw new TypeError('Poise lifecycle callbacks must be functions.');
        }
        this.enabled = Boolean(definition.enabled);
        this.maxPoise = finiteNumber(definition.maxPoise ?? 0, 'maxPoise');
        this.recoverySeconds = finiteNumber(definition.recoverySeconds ?? 0, 'recoverySeconds');
        this.recoveryTicks = Number.isInteger(definition.recoveryTicks)
            ? definition.recoveryTicks
            : Math.round(this.recoverySeconds * tickRate);
        this.executionDamageScalar = finiteNumber(
            definition.executionDamageScalar ?? 1,
            'executionDamageScalar'
        );
        this.executionAtbGain = finiteNumber(
            definition.executionAtbGain ?? 0,
            'executionAtbGain'
        );
        this.brokenDamageScale = finiteNumber(
            definition.brokenDamageScale ?? 1,
            'brokenDamageScale'
        );
        if (this.maxPoise < 0 || this.recoveryTicks < 0 || this.executionAtbGain < 0) {
            throw new Error('Poise limits, recovery and execution gain must be non-negative.');
        }
        if (this.executionDamageScalar < 0 || this.brokenDamageScale < 0) {
            throw new Error('Poise damage scalars must be non-negative.');
        }

        this.breakDamageBuffId = definition.breakDamageBuffId ?? null;
        this.executionGateBuffId = definition.executionGateBuffId ?? null;
        this.recoveryTimingModel = definition.recoveryTimingModel
            ?? 'nominal-gameplay-ticks-excludes-presentation-pauses';
        this.rapidBreakPolicy = normalizeRapidBreakPolicy(definition.rapidBreakPolicy);
        this.knots = normalizeKnots(
            definition.knotPercentages,
            definition.knotBuffIds,
            definition.knotDurationTicksByBuffId
        );
        this.schedule = schedule;
        this.localClock = localClock;
        this.onKnot = onKnot;
        this.onBroken = onBroken;
        this.onRecovered = onRecovered;
        this.accumulated = 0;
        this.broken = false;
        this.executionAvailable = false;
        this.triggeredKnotIndexes = new Set();
        this.cycle = 1;
        this.recoveryGeneration = 0;
        this.recoveryTimerId = null;
        this.nominalRecoveryFrame = null;
        this.firstPoiseDamageLocalFrame = null;
        this.pendingGuard = null;
        this.activeGuard = null;
        this.guardGeneration = 0;
        this.trace = [{
            frame: 0,
            stage: 'Initialized',
            enabled: this.enabled,
            maxPoise: this.maxPoise,
            recoveryTicks: this.recoveryTicks,
            accumulated: 0,
            remaining: this.maxPoise
        }];
    }

    applyDamage({
        frame,
        basePoise,
        outputScalar = 1,
        takenScalar = 1,
        sourceSkillId = null,
        rootSkillId = null,
        damageUnitIndex = null
    }) {
        const base = finiteNumber(basePoise, 'basePoise');
        const output = finiteNumber(outputScalar, 'outputScalar');
        const taken = finiteNumber(takenScalar, 'takenScalar');
        if (base < 0 || output < 0 || taken < 0) {
            throw new Error('Poise damage and its scalars must be non-negative.');
        }
        const guardTakenScalar = this.activeGuard?.active
            ? this.activeGuard.takenScalar
            : 1;
        const effectiveTakenScalar = taken * guardTakenScalar;
        const finalPoiseDamage = base * output * effectiveTakenScalar;
        const before = this.accumulated;

        if (!this.enabled || this.maxPoise === 0) {
            return {
                enabled: false,
                basePoise: base,
                finalPoiseDamage: 0,
                actualPoiseDamage: 0,
                overflow: 0,
                before,
                after: before,
                broken: this.broken,
                broke: false
            };
        }

        if (this.broken) {
            const ignored = {
                frame,
                stage: 'DamageIgnored',
                reason: 'AlreadyBroken',
                sourceSkillId,
                rootSkillId,
                damageUnitIndex,
                basePoise: base,
                outputScalar: output,
                takenScalar: taken,
                guardTakenScalar,
                effectiveTakenScalar,
                finalPoiseDamage,
                actualPoiseDamage: 0,
                overflow: finalPoiseDamage,
                before,
                after: before,
                remaining: 0,
                cycle: this.cycle
            };
            this.trace.push(ignored);
            return { ...ignored, enabled: true, broken: true, broke: false };
        }

        const uncapped = before + finalPoiseDamage;
        const after = Math.min(this.maxPoise, uncapped);
        const actualPoiseDamage = after - before;
        const overflow = uncapped - after;
        this.accumulated = after;
        const record = {
            frame,
            stage: 'DamageApplied',
            sourceSkillId,
            rootSkillId,
            damageUnitIndex,
            basePoise: base,
            outputScalar: output,
            takenScalar: taken,
            guardTakenScalar,
            effectiveTakenScalar,
            finalPoiseDamage,
            actualPoiseDamage,
            overflow,
            before,
            after,
            remaining: this.maxPoise - after,
            cycle: this.cycle
        };
        this.trace.push(record);

        if (actualPoiseDamage > 0 && this.firstPoiseDamageLocalFrame === null) {
            this.firstPoiseDamageLocalFrame = this.#localFrameAt(frame);
            this.trace.push({
                frame,
                stage: 'CycleDamageStarted',
                localFrame: this.firstPoiseDamageLocalFrame,
                cycle: this.cycle,
                sourceSkillId,
                rootSkillId
            });
        }

        for (const knot of this.knots) {
            const threshold = this.maxPoise * knot.percentage;
            if (this.triggeredKnotIndexes.has(knot.index)
                || before >= threshold
                || after < threshold) continue;
            this.triggeredKnotIndexes.add(knot.index);
            const knotRecord = {
                frame,
                stage: 'KnotTriggered',
                knotIndex: knot.index,
                percentage: knot.percentage,
                threshold,
                buffId: knot.buffId,
                durationTicks: knot.durationTicks,
                accumulated: after,
                cycle: this.cycle,
                sourceSkillId,
                rootSkillId
            };
            this.trace.push(knotRecord);
            this.onKnot(knotRecord);
        }

        let broke = false;
        if (after >= this.maxPoise) {
            broke = true;
            this.#enterBroken(frame, { sourceSkillId, rootSkillId });
        }
        return {
            ...record,
            enabled: true,
            broken: this.broken,
            broke
        };
    }

    #enterBroken(frame, source) {
        this.broken = true;
        this.executionAvailable = true;
        this.recoveryGeneration += 1;
        const generation = this.recoveryGeneration;
        this.nominalRecoveryFrame = frame + this.recoveryTicks;
        const breakLocalFrame = this.#localFrameAt(frame);
        const breakElapsedLocalTicks = this.firstPoiseDamageLocalFrame === null
            ? null
            : Math.max(0, breakLocalFrame - this.firstPoiseDamageLocalFrame);
        this.pendingGuard = this.#qualifyRapidBreak(frame, breakElapsedLocalTicks, source);
        const brokenRecord = {
            frame,
            stage: 'Broken',
            accumulated: this.accumulated,
            remaining: 0,
            cycle: this.cycle,
            executionAvailable: true,
            executionGateBuffId: this.executionGateBuffId,
            breakDamageBuffId: this.breakDamageBuffId,
            brokenDamageScale: this.brokenDamageScale,
            nominalRecoveryFrame: this.nominalRecoveryFrame,
            scheduledRecoveryFrame: this.nominalRecoveryFrame,
            recoveryTicks: this.recoveryTicks,
            recoveryTimingModel: this.recoveryTimingModel,
            breakLocalFrame,
            firstPoiseDamageLocalFrame: this.firstPoiseDamageLocalFrame,
            breakElapsedLocalTicks,
            rapidBreakQualified: this.pendingGuard !== null,
            ...source
        };
        this.trace.push(brokenRecord);
        if (this.localClock) {
            this.recoveryTimerId = this.localClock.startTimer({
                frame,
                durationTicks: this.recoveryTicks,
                priority: 80,
                label: 'poise-recovery',
                onComplete: actualFrame => {
                    if (!this.broken || generation !== this.recoveryGeneration) return;
                    this.recover(actualFrame, 'LocalClockTimer');
                }
            });
        } else {
            this.schedule(this.nominalRecoveryFrame, 80, () => {
                if (!this.broken || generation !== this.recoveryGeneration) return;
                this.recover(this.nominalRecoveryFrame, 'NominalTimer');
            }, 'poise-recovery');
        }
        this.onBroken({
            ...brokenRecord,
            recoveryTimerId: this.recoveryTimerId,
            state: this.snapshot()
        });
    }

    recover(frame, reason = 'Manual') {
        if (!this.broken) return false;
        const before = this.accumulated;
        this.broken = false;
        this.executionAvailable = false;
        this.accumulated = 0;
        if (this.recoveryTimerId !== null) {
            this.localClock?.cancelTimer(this.recoveryTimerId, frame, reason);
            this.recoveryTimerId = null;
        }
        this.nominalRecoveryFrame = null;
        this.triggeredKnotIndexes.clear();
        this.recoveryGeneration += 1;
        const recoveredRecord = {
            frame,
            stage: 'Recovered',
            reason,
            before,
            after: 0,
            remaining: this.maxPoise,
            cycle: this.cycle
        };
        this.trace.push(recoveredRecord);
        this.#startPendingGuard(frame);
        this.firstPoiseDamageLocalFrame = null;
        this.cycle += 1;
        this.onRecovered({
            ...recoveredRecord,
            nextCycle: this.cycle,
            state: this.snapshot()
        });
        return true;
    }

    canExecute() {
        return this.enabled && this.broken && this.executionAvailable;
    }

    consumeExecution({ frame, sourceSkillId = null, rootSkillId = null } = {}) {
        if (!this.canExecute()) return null;
        this.executionAvailable = false;
        const result = {
            frame,
            stage: 'ExecutionConsumed',
            sourceSkillId,
            rootSkillId,
            executionDamageScalar: this.executionDamageScalar,
            executionAtbGain: this.executionAtbGain,
            executionGateBuffId: this.executionGateBuffId,
            cycle: this.cycle
        };
        this.trace.push(result);
        return result;
    }

    damageZone() {
        if (!this.enabled || !this.broken) return { scale: 1, zones: [] };
        return {
            scale: this.brokenDamageScale,
            zones: [{
                zoneName: 'PoiseBreakZone',
                addition: this.brokenDamageScale - 1,
                scale: this.brokenDamageScale,
                buffId: this.breakDamageBuffId
            }]
        };
    }

    snapshot() {
        const recoveryTimer = this.recoveryTimerId === null
            ? null
            : this.localClock?.timer(this.recoveryTimerId);
        return {
            enabled: this.enabled,
            maxPoise: this.maxPoise,
            accumulated: this.accumulated,
            remaining: Math.max(0, this.maxPoise - this.accumulated),
            broken: this.broken,
            executionAvailable: this.executionAvailable,
            executionDamageScalar: this.executionDamageScalar,
            executionAtbGain: this.executionAtbGain,
            nominalRecoveryFrame: this.nominalRecoveryFrame,
            scheduledRecoveryFrame: recoveryTimer?.deadlineFrame ?? this.nominalRecoveryFrame,
            recoveryTicks: this.recoveryTicks,
            cycle: this.cycle,
            triggeredKnotIndexes: [...this.triggeredKnotIndexes],
            firstPoiseDamageLocalFrame: this.firstPoiseDamageLocalFrame,
            rapidBreakPolicy: this.rapidBreakPolicy.enabled
                ? { ...this.rapidBreakPolicy }
                : { enabled: false },
            activeGuard: this.activeGuard?.active ? {
                buffId: this.activeGuard.buffId,
                profileId: this.activeGuard.profileId,
                startFrame: this.activeGuard.startFrame,
                endFrame: this.activeGuard.endFrame,
                expireFrame: this.activeGuard.expireFrame,
                takenScalar: this.activeGuard.takenScalar,
                breakElapsedLocalTicks: this.activeGuard.breakElapsedLocalTicks
            } : null
        };
    }

    #localFrameAt(frame) {
        return this.localClock ? this.localClock.localFrameAt(frame) : frame;
    }

    #qualifyRapidBreak(frame, elapsedLocalTicks, source) {
        const policy = this.rapidBreakPolicy;
        if (!policy.enabled
            || elapsedLocalTicks === null
            || elapsedLocalTicks >= policy.qualifyingTicks) return null;
        if (policy.interpolation !== 'linear-to-one') {
            throw new Error(`Unsupported rapid-break interpolation ${policy.interpolation}.`);
        }
        const progress = elapsedLocalTicks / policy.qualifyingTicks;
        const takenScalar = policy.minimumTakenScalar
            + progress * (1 - policy.minimumTakenScalar);
        const pending = {
            buffId: policy.buffId,
            profileId: policy.profileId,
            guardDurationTicks: policy.guardDurationTicks,
            lifecycleOffsetTicks: policy.lifecycleOffsetTicks,
            takenScalar,
            breakElapsedLocalTicks: elapsedLocalTicks,
            qualifyingTicks: policy.qualifyingTicks,
            sourceSkillId: source.sourceSkillId ?? null,
            rootSkillId: source.rootSkillId ?? null,
            breakFrame: frame
        };
        this.trace.push({
            frame,
            stage: 'RapidBreakQualified',
            cycle: this.cycle,
            ...pending
        });
        return pending;
    }

    #startPendingGuard(frame) {
        const pending = this.pendingGuard;
        this.pendingGuard = null;
        if (!pending) return;
        this.guardGeneration += 1;
        const generation = this.guardGeneration;
        const endFrame = frame + pending.guardDurationTicks;
        const expireFrame = endFrame + pending.lifecycleOffsetTicks;
        this.activeGuard = {
            ...pending,
            active: true,
            startFrame: frame,
            endFrame,
            expireFrame
        };
        this.trace.push({
            frame,
            stage: 'PoiseGuardStarted',
            cycle: this.cycle,
            buffId: pending.buffId,
            profileId: pending.profileId,
            durationTicks: pending.guardDurationTicks,
            endFrame,
            expireFrame,
            takenScalar: pending.takenScalar,
            breakElapsedLocalTicks: pending.breakElapsedLocalTicks
        });
        this.schedule(expireFrame, 90, () => {
            if (!this.activeGuard?.active || generation !== this.guardGeneration) return;
            const ended = this.activeGuard;
            ended.active = false;
            this.trace.push({
                frame: expireFrame,
                stage: 'PoiseGuardEnded',
                cycle: this.cycle,
                buffId: ended.buffId,
                profileId: ended.profileId,
                startFrame: ended.startFrame,
                endFrame: ended.endFrame,
                takenScalar: ended.takenScalar
            });
        }, 'poise-guard-expiry');
    }
}
