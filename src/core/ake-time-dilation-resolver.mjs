function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function finiteNonNegative(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative finite number.`);
    }
    return number;
}

function serializedNumber(value, eventContext, fallback = 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.useBlackboardKey === true && value.blackboardKey) {
            const resolved = eventContext?.blackboard?.[value.blackboardKey];
            if (Number.isFinite(Number(resolved))) return Number(resolved);
        }
        if (Number.isFinite(Number(value.value))) return Number(value.value);
        return fallback;
    }
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function distributedExcludedOffsets(nominalDurationTicks, excludedTicks) {
    const offsets = [];
    for (let offset = 0; offset < nominalDurationTicks; offset += 1) {
        const before = Math.floor(offset * excludedTicks / nominalDurationTicks);
        const after = Math.floor((offset + 1) * excludedTicks / nominalDurationTicks);
        if (after > before) offsets.push(offset);
    }
    return offsets;
}

function comboSkillActorPauses(request, durationSeconds) {
    if (!request.runtime?.clockDomains?.listDomains) return null;
    const nominalDurationTicks = Math.round(durationSeconds * request.tickRate);
    if (nominalDurationTicks <= 1) return null;

    // Frozen CaLC comparisons give 17 excluded actor ticks for the 0.6 s
    // ComboSkill curve and 21 for 0.8 s.  The affine integral below preserves
    // both observations and leaves at least one advancing tick in every curve.
    const excludedTicks = Math.min(
        nominalDurationTicks - 1,
        Math.max(0, Math.round(durationSeconds * 20 + 5))
    );
    const sourceId = request.eventContext?.sourceId;
    const targetDomains = request.runtime.clockDomains
        .listDomains({ includeGlobal: false })
        .filter(domain => domain.kind === 'Character')
        .filter(domain => domain.ownerId !== sourceId);
    const offsets = distributedExcludedOffsets(nominalDurationTicks, excludedTicks);
    return {
        nominalDurationTicks,
        excludedTicks,
        targetDomains,
        pauses: targetDomains.flatMap(domain => offsets.map(frameOffsetTicks => ({
            domainId: domain.id,
            frameOffsetTicks,
            durationTicks: 1,
            excludedTicks: 1,
            // Skill-program phase timers use priority 1.  A sampled clock stop
            // at the same global frame must land first or the timer would fire
            // one frame too early.
            priority: 0,
            reason: 'TimeDilationAction:ComboSkill:GlobalActorSample'
        })))
    };
}

/**
 * Retains exported HitStop/TimeDilation nodes without inventing a curve.
 * A caller can inject an evidence-backed curveProvider; absent that provider,
 * the action is auditable but intentionally makes no gameplay-clock mutation.
 */
export function createAkeTimeDilationResolver({
    curveProvider = null,
    semanticMappings = []
} = {}) {
    if (curveProvider !== null && typeof curveProvider !== 'function') {
        throw new TypeError('curveProvider must be a function or null.');
    }
    const mappings = Array.isArray(semanticMappings)
        ? semanticMappings
        : semanticMappings?.mappings;
    if (!Array.isArray(mappings)) {
        throw new TypeError('semanticMappings must be an array or object with mappings.');
    }
    return request => {
        const raw = request.action?.raw ?? {};
        if (curveProvider) {
            const supplied = curveProvider(clone(request));
            if (supplied !== null && supplied !== undefined) {
                if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
                    throw new TypeError('curveProvider must return an object, null or undefined.');
                }
                return { status: 'ResolvedByCurveProvider', ...clone(supplied) };
            }
        }
        const serializedDuration = serializedNumber(raw.duration, request.eventContext, 0);
        // Exported AKE TimeDilationAction data uses -1 as an "until explicitly
        // disabled" sentinel. It is neither a negative wall-clock duration nor
        // a very long animation duration, so retain that lifecycle explicitly
        // instead of rejecting it or projecting a fabricated end frame.
        const durationMode = serializedDuration === -1 ? 'UntilDisabled' : 'Fixed';
        const durationSeconds = durationMode === 'UntilDisabled'
            ? null
            : finiteNonNegative(serializedDuration, 'time-dilation duration');

        if (request.action?.sourceType === 'TimeDilationAction'
            && raw.layer === 'Global'
            && raw.useCurveKey === true
            && raw.curveKey === 'ComboSkill'
            && durationSeconds !== null
            && durationSeconds > 0) {
            const sampled = comboSkillActorPauses(request, durationSeconds);
            // Do not let an empty multi-actor projection swallow the generic
            // evidence-backed target-clock rule below. A single-actor runtime
            // has no peer character to sample, but its enemy clock can still
            // be a real target of the same serialized curve.
            if (sampled && sampled.pauses.length > 0) {
                return {
                    status: 'ResolvedByFrozenBlackBoxEvidence',
                    reason: 'ComboSkillGlobalActorCurveSamples',
                    sampleGroupId: [
                        'TimeDilationAction',
                        raw.layer,
                        raw.timeDilationPriority?.tagId ?? 'default-priority',
                        raw.slot?.tagId ?? 'default-slot'
                    ].join(':'),
                    sourceType: request.action.sourceType,
                    curveKey: raw.curveKey,
                    durationSeconds,
                    durationMode,
                    nominalDurationTicks: sampled.nominalDurationTicks,
                    excludedTicks: sampled.excludedTicks,
                    targetDomainIds: sampled.targetDomains.map(domain => domain.id),
                    pauses: sampled.pauses
                };
            }
        }
        const mappedCurve = mappings.find(mapping => {
            if (mapping.actionType !== 'TimeDilationCurveRule') return false;
            const selector = mapping.selector ?? {};
            if (selector.sourceType && selector.sourceType !== request.action?.sourceType) {
                return false;
            }
            if (selector.curveKey && selector.curveKey !== raw.curveKey) return false;
            if (selector.durationSeconds !== undefined
                && (durationSeconds === null
                    || Math.abs(Number(selector.durationSeconds) - durationSeconds) > 1e-9)) {
                return false;
            }
            return true;
        });
        if (mappedCurve) {
            const effect = mappedCurve.effect ?? {};
            const targetId = request.eventContext?.targetId;
            const domainId = effect.domainBinding === 'EventTarget'
                ? `${String(targetId)}:clock`
                : (effect.domainId ?? request.eventContext?.clockDomainId ?? 'global');
            return {
                status: 'ResolvedBySemanticMapping',
                reason: mappedCurve.id ?? 'TimeDilationCurveRule',
                ruleId: mappedCurve.id ?? null,
                sourceType: request.action?.sourceType ?? null,
                curveKey: raw.curveKey ?? null,
                durationSeconds,
                durationMode,
                nominalDurationTicks: durationSeconds === null
                    ? null
                    : Math.round(durationSeconds * request.tickRate),
                pauses: [{
                    domainId,
                    frameOffsetTicks: effect.frameOffsetTicks ?? 0,
                    durationTicks: effect.excludedTicks,
                    excludedTicks: effect.excludedTicks,
                    priority: effect.priority ?? 50,
                    reason: mappedCurve.id ?? `TimeDilationAction:${raw.curveKey ?? 'curve'}`
                }]
            };
        }
        if (request.action?.sourceType === 'TimeDilationAction'
            && raw.useCurveKey === true
            && raw.curveKey === 'RESETto1'
            && durationSeconds === 1) {
            // Frozen Calc traces for Chen Qianyu and Wulfgard both advance
            // every later actor-local Ultimate timeline event by exactly one
            // tick when this serialized reset action runs at cast frame 0.
            // Keep the calibration deliberately narrow: other curves still
            // require an injected provider instead of borrowing this result.
            return {
                status: 'ResolvedByFrozenBlackBoxEvidence',
                reason: 'RESETto1ObservedExcludedTick',
                sourceType: request.action.sourceType,
                curveKey: raw.curveKey,
                durationSeconds,
                nominalDurationTicks: Math.round(durationSeconds * request.tickRate),
                pauses: [{
                    domainId: request.eventContext?.clockDomainId ?? 'global',
                    durationTicks: 1,
                    excludedTicks: 1,
                    reason: 'TimeDilationAction:RESETto1'
                }]
            };
        }
        return {
            status: 'RetainedWithoutClockMutation',
            reason: 'NoEvidenceBackedCurveForThisAction',
            sourceType: request.action?.sourceType ?? null,
            curveKey: raw.curveKey ?? null,
            affectType: raw.affectType ?? raw.layer ?? null,
            durationSeconds,
            durationMode,
            nominalDurationTicks: durationSeconds === null
                ? null
                : Math.round(durationSeconds * request.tickRate),
            pauses: []
        };
    };
}

/** Apply only explicit semantic LocalClockPauseRule mappings. */
export function applyAkeLocalClockTrigger({
    trigger,
    eventContext,
    runtime,
    semanticMappings = [],
    seen = new Set(),
    trace = []
}) {
    const records = [];
    for (const mapping of semanticMappings) {
        if (mapping.actionType !== 'LocalClockPauseRule') continue;
        if (mapping.selector?.trigger !== trigger) continue;
        if (mapping.selector?.sourceSkillIds
            && !mapping.selector.sourceSkillIds.includes(eventContext.skillId)) continue;
        if (mapping.selector?.rootSkillIds
            && !mapping.selector.rootSkillIds.includes(eventContext.rootSkillId)) continue;
        if (mapping.selector?.eventTypes
            && !mapping.selector.eventTypes.includes(eventContext.eventType)) continue;
        const key = [
            mapping.id,
            eventContext.frame,
            eventContext.castId,
            eventContext.targetId
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const domainId = eventContext.targetClockDomainId
            ?? `${String(eventContext.targetId)}:clock`;
        if (!runtime.clockDomains.hasDomain(domainId)) {
            const record = {
                frame: eventContext.frame,
                stage: 'LocalClockPauseSkipped',
                trigger,
                ruleId: mapping.id,
                domainId,
                reason: 'TargetClockDomainMissing'
            };
            trace.push(record);
            records.push(record);
            continue;
        }
        const applied = runtime.clockDomains.pause(domainId, {
            frame: eventContext.frame,
            durationTicks: Number(mapping.effect.durationTicks),
            sourceId: eventContext.sourceId,
            ownerId: eventContext.ownerId,
            targetId: eventContext.targetId,
            sourceSkillId: eventContext.skillId,
            rootSkillId: eventContext.rootSkillId,
            reason: trigger,
            ruleId: mapping.id
        });
        const record = {
            frame: eventContext.frame,
            stage: 'LocalClockPauseApplied',
            trigger,
            ruleId: mapping.id,
            domainId,
            durationTicks: Number(mapping.effect.durationTicks),
            applied: clone(applied)
        };
        trace.push(record);
        records.push(record);
    }
    return records;
}

export default createAkeTimeDilationResolver;
