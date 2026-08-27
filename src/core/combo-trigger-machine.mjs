const OCCURRENCES = new Set(['every-event', 'first-per-cast', 'first-per-cast-target']);
const PENDING_POLICIES = new Set(['append', 'keep-existing', 'refresh-newest', 'replace-all']);
const SELECTION_POLICIES = new Set(['newest', 'oldest']);
const CONSUME_POLICIES = new Set(['selected', 'all-for-owner-and-skill']);
const OWNER_BINDINGS = new Set(['event-source', 'fixed', 'none']);
const TARGET_BINDINGS = new Set(['event-target', 'none']);

function requiredString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function selectedPolicy(value, allowed, label) {
    if (!allowed.has(value)) {
        throw new Error(`${label} must be one of: ${[...allowed].join(', ')}.`);
    }
    return value;
}

function normalizeRule(rawRule, index) {
    const id = requiredString(rawRule?.id, `combo trigger rule ${index} id`);
    const selector = rawRule.selector ?? {};
    const effect = rawRule.effect ?? {};
    const eventTypes = rawRule.eventTypes
        ?? (rawRule.eventType === undefined ? [] : [rawRule.eventType]);
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
        throw new Error(`Combo trigger rule ${id} must declare eventType or eventTypes.`);
    }
    const conditions = rawRule.conditions
        ?? (rawRule.condition === undefined ? [] : [rawRule.condition]);
    if (!Array.isArray(conditions) || conditions.some(condition => (
        condition === null || typeof condition !== 'object' || Array.isArray(condition)
    ))) {
        throw new Error(`Combo trigger rule ${id} conditions must be an array of objects.`);
    }
    const rootSkillIds = selector.rootSkillIds
        ?? (selector.rootSkillId ? [selector.rootSkillId] : []);
    if (!Array.isArray(rootSkillIds)) {
        throw new Error(`Combo trigger rule ${id} selector.rootSkillIds must be an array.`);
    }
    const rootSkillRole = selector.rootSkillRole ?? null;
    const statusBuffIds = selector.statusBuffIds ?? [];
    const sourceCommandTypes = selector.sourceCommandTypes ?? [];
    if (!Array.isArray(statusBuffIds) || !Array.isArray(sourceCommandTypes)) {
        throw new Error(
            `Combo trigger rule ${id} statusBuffIds/sourceCommandTypes must be arrays.`
        );
    }
    if (rootSkillIds.length === 0 && !rootSkillRole
        && statusBuffIds.length === 0 && sourceCommandTypes.length === 0) {
        throw new Error(
            `Combo trigger rule ${id} must select a root skill, semantic role, status, or command type.`
        );
    }
    const durationTicks = Number(effect.pendingDurationTicks);
    if (!Number.isInteger(durationTicks) || durationTicks <= 0) {
        throw new Error(`Combo trigger rule ${id} has invalid pendingDurationTicks.`);
    }
    if (selector.sourceSkillIds !== undefined
        && (!Array.isArray(selector.sourceSkillIds) || selector.sourceSkillIds.length === 0)) {
        throw new Error(`Combo trigger rule ${id} selector.sourceSkillIds must be a non-empty array.`);
    }

    return {
        ...rawRule,
        id,
        eventType: requiredString(eventTypes[0], `combo trigger rule ${id} eventTypes[0]`),
        eventTypes: [...new Set(eventTypes.map((eventType, eventIndex) =>
            requiredString(eventType, `combo trigger rule ${id} eventTypes[${eventIndex}]`)
        ))],
        conditions: structuredClone(conditions),
        selector: {
            ...selector,
            rootSkillIds: [...new Set(rootSkillIds.map((skillId, skillIndex) =>
                requiredString(skillId, `combo trigger rule ${id} rootSkillIds[${skillIndex}]`)
            ))],
            rootSkillRole: rootSkillRole === null
                ? null
                : requiredString(rootSkillRole, `combo trigger rule ${id} selector.rootSkillRole`),
            statusBuffIds: [...new Set(statusBuffIds.map((buffId, buffIndex) =>
                requiredString(buffId, `combo trigger rule ${id} statusBuffIds[${buffIndex}]`)
            ))],
            sourceCommandTypes: [...new Set(sourceCommandTypes.map((commandType, commandIndex) =>
                requiredString(
                    commandType,
                    `combo trigger rule ${id} sourceCommandTypes[${commandIndex}]`
                )
            ))],
            requireSourceOtherThanOwner: selector.requireSourceOtherThanOwner === true,
            sourceSkillIds: selector.sourceSkillIds
                ? [...new Set(selector.sourceSkillIds.map((skillId, skillIndex) =>
                    requiredString(skillId, `combo trigger rule ${id} sourceSkillIds[${skillIndex}]`)
                ))]
                : undefined,
            damageAttributeType: selector.damageAttributeType ?? null,
            occurrence: selectedPolicy(
                selector.occurrence ?? 'every-event',
                OCCURRENCES,
                `combo trigger rule ${id} selector.occurrence`
            )
        },
        effect: {
            ...effect,
            comboSkillId: requiredString(
                effect.comboSkillId,
                `combo trigger rule ${id} effect.comboSkillId`
            ),
            pendingDurationTicks: durationTicks,
            ownerBinding: selectedPolicy(
                effect.ownerBinding ?? 'event-source',
                OWNER_BINDINGS,
                `combo trigger rule ${id} effect.ownerBinding`
            ),
            ownerId: effect.ownerBinding === 'fixed'
                ? requiredString(effect.ownerId, `combo trigger rule ${id} effect.ownerId`)
                : effect.ownerId ?? null,
            triggerTargetBinding: selectedPolicy(
                effect.triggerTargetBinding ?? 'event-target',
                TARGET_BINDINGS,
                `combo trigger rule ${id} effect.triggerTargetBinding`
            ),
            requireComboOffCooldown: effect.requireComboOffCooldown ?? false,
            bypassSkillCooldown: effect.bypassSkillCooldown === true,
            pendingPolicy: selectedPolicy(
                effect.pendingPolicy ?? 'append',
                PENDING_POLICIES,
                `combo trigger rule ${id} effect.pendingPolicy`
            ),
            selectionPolicy: selectedPolicy(
                effect.selectionPolicy ?? 'newest',
                SELECTION_POLICIES,
                `combo trigger rule ${id} effect.selectionPolicy`
            ),
            consumePolicy: selectedPolicy(
                effect.consumePolicy ?? 'selected',
                CONSUME_POLICIES,
                `combo trigger rule ${id} effect.consumePolicy`
            )
        }
    };
}

function sameSlot(left, right) {
    return left.ownerId === right.ownerId
        && left.skillId === right.skillId
        && left.triggerTargetId === right.triggerTargetId;
}

function managedSkillKey(ownerId, skillId) {
    return JSON.stringify([ownerId, skillId]);
}

export function normalizeComboTriggerRules(rules = []) {
    if (!Array.isArray(rules)) throw new Error('combo trigger rules must be an array.');
    const normalized = rules.map(normalizeRule);
    const ids = new Set();
    for (const rule of normalized) {
        if (ids.has(rule.id)) throw new Error(`Duplicate combo trigger rule id: ${rule.id}`);
        ids.add(rule.id);
    }
    return normalized;
}

export class ComboTriggerMachine {
    constructor({ rules = [], schedule = null, trace = [], getCooldownEnd = () => 0,
        evaluateCondition = null } = {}) {
        if (evaluateCondition !== null && typeof evaluateCondition !== 'function') {
            throw new TypeError('combo evaluateCondition must be a function or null.');
        }
        this.rules = normalizeComboTriggerRules(rules);
        this.schedule = schedule;
        this.trace = trace;
        this.getCooldownEnd = getCooldownEnd;
        this.evaluateCondition = evaluateCondition;
        this.pending = new Map();
        this.actionManagedSkills = new Set();
        this.pauseLeases = new Map();
        this.seenOccurrences = new Set();
        this.nextPendingId = 1;
        this.nextTraceSequence = 1;
    }

    #record(event) {
        const sequence = this.nextTraceSequence++;
        this.trace.push({
            eventId: `combo-event:${sequence}`,
            sequence,
            ...event
        });
    }

    #occurrenceKey(rule, event) {
        switch (rule.selector.occurrence) {
            case 'first-per-cast':
                return `${rule.id}|source:${event.sourceId}|cast:${event.sourceCastId}`;
            case 'first-per-cast-target':
                return `${rule.id}|source:${event.sourceId}|cast:${event.sourceCastId}|target:${event.targetId}`;
            default:
                return null;
        }
    }

    #matches(rule, event) {
        if (!rule.eventTypes.includes(event.eventType)) return false;
        const selectsRoot = rule.selector.rootSkillIds.length > 0
            || rule.selector.rootSkillRole !== null;
        if (selectsRoot) {
            const idMatched = rule.selector.rootSkillIds.includes(event.rootSkillId);
            const roleMatched = rule.selector.rootSkillRole !== null
                && (event.rootSkillRoles ?? []).includes(rule.selector.rootSkillRole);
            if (!idMatched && !roleMatched) return false;
        }
        if (rule.selector.sourceSkillIds
            && !rule.selector.sourceSkillIds.includes(event.sourceSkillId)) return false;
        if (rule.selector.statusBuffIds.length > 0
            && !rule.selector.statusBuffIds.includes(event.buffId)) return false;
        if (rule.selector.sourceCommandTypes.length > 0
            && !rule.selector.sourceCommandTypes.includes(event.sourceCommandType)) return false;
        if (rule.selector.damageAttributeType
            && event.damageAttributeType !== rule.selector.damageAttributeType) return false;
        return true;
    }

    #conditionContext(rule, event, ownerId) {
        return {
            ...structuredClone(event),
            eventType: event.eventType,
            frame: event.frame,
            sourceId: event.sourceId ?? null,
            ownerId: ownerId ?? event.ownerId ?? event.sourceId ?? null,
            targetId: event.targetId ?? null,
            skillId: event.sourceSkillId ?? null,
            rootSkillId: event.rootSkillId ?? null,
            castId: event.sourceCastId ?? null,
            commandType: event.sourceCommandType ?? null,
            ruleId: rule.id,
            payload: {
                ...structuredClone(event.payload ?? {}),
                buffId: event.buffId ?? null,
                damageAttributeType: event.damageAttributeType ?? null,
                sourceCommandType: event.sourceCommandType ?? null
            }
        };
    }

    #conditionsPass(rule, event, ownerId) {
        if (rule.conditions.length === 0) return { passed: true, reason: 'NO_CONDITIONS' };
        if (!this.evaluateCondition) {
            return { passed: false, reason: 'CONDITION_EVALUATOR_MISSING' };
        }
        const conditionContext = this.#conditionContext(rule, event, ownerId);
        try {
            for (let index = 0; index < rule.conditions.length; index += 1) {
                if (!this.evaluateCondition(rule.conditions[index], conditionContext)) {
                    return { passed: false, reason: 'CONDITION_FAILED', conditionIndex: index };
                }
            }
            return { passed: true, reason: 'CONDITIONS_PASSED' };
        } catch (error) {
            return {
                passed: false,
                reason: 'CONDITION_EVALUATION_ERROR',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    #boundOwner(rule, event) {
        if (rule.effect.ownerBinding === 'event-source') return event.sourceId;
        if (rule.effect.ownerBinding === 'fixed') return rule.effect.ownerId;
        if (rule.effect.ownerBinding === 'none') return null;
        throw new Error(`Unsupported combo owner binding: ${rule.effect.ownerBinding}`);
    }

    #boundTarget(rule, event) {
        if (rule.effect.triggerTargetBinding === 'event-target') return event.targetId;
        if (rule.effect.triggerTargetBinding === 'none') return null;
        throw new Error(`Unsupported combo trigger target binding: ${rule.effect.triggerTargetBinding}`);
    }

    #expire(pendingId, frame) {
        const pending = this.pending.get(pendingId);
        if (!pending || pending.expireFrame !== frame
            || pending.pauseLeaseIds.size > 0) return false;
        this.pending.delete(pendingId);
        this.#record({
            frame,
            stage: 'PENDING_EXPIRED',
            ruleId: pending.ruleId,
            pendingId,
            skillId: pending.skillId,
            targetId: pending.ownerId,
            triggerTargetId: pending.triggerTargetId,
            pendingRemainingFrames: 0,
            result: false,
            reason: 'TIMEOUT'
        });
        return true;
    }

    #expireDueBeforeOrAt(frame) {
        for (const pending of [...this.pending.values()]) {
            if (pending.expireFrame <= frame) this.#expire(pending.id, pending.expireFrame);
        }
    }

    #scheduleExpiry(pending) {
        if (!this.schedule) return;
        this.schedule(
            pending.expireFrame,
            4,
            () => this.#expire(pending.id, pending.expireFrame),
            `combo-pending-expiry:${pending.id}`
        );
    }

    #createPending(rule, event, ownerId, triggerTargetId) {
        const pauseLeaseIds = new Set([...this.pauseLeases.values()]
            .filter(lease => lease.isAll || lease.ownerId === ownerId)
            .map(lease => lease.leaseId));
        const pending = {
            id: this.nextPendingId++,
            ruleId: rule.id,
            skillId: rule.effect.comboSkillId,
            ownerId,
            triggerTargetId,
            sourceSkillId: event.sourceSkillId,
            rootSkillId: event.rootSkillId,
            sourceCastId: event.sourceCastId,
            createdFrame: event.frame,
            expireFrame: event.frame + rule.effect.pendingDurationTicks - 1,
            durationTicks: rule.effect.pendingDurationTicks,
            selectionPolicy: rule.effect.selectionPolicy,
            consumePolicy: rule.effect.consumePolicy,
            bypassSkillCooldown: rule.effect.bypassSkillCooldown === true,
            pauseLeaseIds,
            pausedAtFrame: pauseLeaseIds.size > 0 ? event.frame : null
        };
        this.pending.set(pending.id, pending);
        this.#scheduleExpiry(pending);
        return pending;
    }

    #remainingFrames(pending, frame) {
        const effectiveFrame = pending.pausedAtFrame ?? frame;
        return Math.max(0, pending.expireFrame - effectiveFrame);
    }

    #activatePending(rule, event, ownerId, triggerTargetId, context = {}, reason = 'TRIGGERED') {
        const slot = {
            ownerId,
            skillId: rule.effect.comboSkillId,
            triggerTargetId
        };
        const existing = [...this.pending.values()].filter(candidate => sameSlot(candidate, slot));
        let pending;
        let stage = 'PENDING_CREATED';

        switch (rule.effect.pendingPolicy) {
            case 'keep-existing':
                if (existing.length > 0) {
                    return {
                        ruleId: rule.id,
                        status: 'ignored',
                        reason: 'EXISTING_PENDING_KEPT',
                        pendingId: existing.at(-1).id
                    };
                }
                pending = this.#createPending(rule, event, slot.ownerId, slot.triggerTargetId);
                break;
            case 'refresh-newest': {
                const newest = existing.sort((left, right) => right.createdFrame - left.createdFrame
                    || right.id - left.id)[0];
                if (!newest) {
                    pending = this.#createPending(rule, event, slot.ownerId, slot.triggerTargetId);
                    break;
                }
                this.pending.delete(newest.id);
                pending = this.#createPending(rule, event, slot.ownerId, slot.triggerTargetId);
                stage = 'PENDING_REFRESHED';
                break;
            }
            case 'replace-all':
                for (const candidate of existing) this.pending.delete(candidate.id);
                pending = this.#createPending(rule, event, slot.ownerId, slot.triggerTargetId);
                stage = existing.length > 0 ? 'PENDING_REPLACED' : 'PENDING_CREATED';
                break;
            default:
                pending = this.#createPending(rule, event, slot.ownerId, slot.triggerTargetId);
                break;
        }

        this.#record({
            frame: event.frame,
            stage,
            ruleId: rule.id,
            pendingId: pending.id,
            skillId: pending.skillId,
            currentSkillId: context.currentSkillId ?? event.rootSkillId,
            currentPriority: context.currentPriority ?? 0,
            targetId: pending.ownerId,
            triggerTargetId: pending.triggerTargetId,
            pendingRemainingFrames: pending.durationTicks,
            bypassSkillCooldown: pending.bypassSkillCooldown,
            sourceActionType: context.sourceActionType ?? null,
            sourceActionPath: context.sourceActionPath ?? null,
            result: true,
            reason
        });
        return { ruleId: rule.id, status: 'created', pending };
    }

    trigger(input = {}, context = {}) {
        const frame = Number(input.frame);
        if (!Number.isInteger(frame) || frame < 0) {
            throw new TypeError('combo action trigger frame must be a non-negative integer.');
        }
        const ownerId = requiredString(input.ownerId, 'combo action trigger ownerId');
        const skillId = requiredString(input.skillId, 'combo action trigger skillId');
        const durationTicks = Number(input.pendingDurationTicks);
        if (!Number.isInteger(durationTicks) || durationTicks <= 0) {
            throw new TypeError('combo action trigger pendingDurationTicks must be a positive integer.');
        }
        const ruleId = requiredString(
            input.ruleId ?? input.triggerId,
            'combo action trigger ruleId'
        );
        const rule = {
            id: ruleId,
            effect: {
                comboSkillId: skillId,
                pendingDurationTicks: durationTicks,
                requireComboOffCooldown: input.requireComboOffCooldown === true,
                bypassSkillCooldown: input.bypassSkillCooldown === true,
                pendingPolicy: selectedPolicy(
                    input.pendingPolicy ?? 'replace-all',
                    PENDING_POLICIES,
                    `combo action trigger ${ruleId} pendingPolicy`
                ),
                selectionPolicy: selectedPolicy(
                    input.selectionPolicy ?? 'newest',
                    SELECTION_POLICIES,
                    `combo action trigger ${ruleId} selectionPolicy`
                ),
                consumePolicy: selectedPolicy(
                    input.consumePolicy ?? 'selected',
                    CONSUME_POLICIES,
                    `combo action trigger ${ruleId} consumePolicy`
                )
            }
        };
        this.#expireDueBeforeOrAt(frame);
        this.actionManagedSkills.add(managedSkillKey(ownerId, skillId));
        const cooldownEnd = Number(this.getCooldownEnd(skillId) ?? 0);
        if (rule.effect.requireComboOffCooldown && cooldownEnd > frame) {
            return {
                ruleId,
                status: 'suppressed',
                reason: 'COMBO_ON_COOLDOWN',
                cooldownEndFrame: cooldownEnd
            };
        }
        const event = {
            eventType: 'TriggerComboSkillAction',
            frame,
            sourceId: input.sourceId ?? null,
            sourceSkillId: input.sourceSkillId ?? null,
            rootSkillId: input.rootSkillId ?? null,
            sourceCastId: input.sourceCastId ?? null,
            targetId: input.targetId ?? null
        };
        return this.#activatePending(
            rule,
            event,
            ownerId,
            input.targetId ?? null,
            context,
            input.reason ?? 'ACTION_TRIGGERED'
        );
    }

    isManagedSkill({ ownerId, skillId } = {}) {
        if (this.actionManagedSkills.has(managedSkillKey(ownerId, skillId))) return true;
        return this.rules.some(rule => (
            rule.effect.comboSkillId === skillId
            && (rule.effect.ownerBinding !== 'fixed' || rule.effect.ownerId === ownerId)
        ));
    }

    pause({ frame, ownerId = null, isAll = false, leaseId, castId = null,
        reason = 'PauseComboWindowTime' }) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new TypeError('combo pause frame must be a non-negative integer.');
        }
        requiredString(leaseId, 'combo pause leaseId');
        if (!isAll) requiredString(ownerId, 'combo pause ownerId');
        this.#expireDueBeforeOrAt(frame);
        const existing = this.pauseLeases.get(leaseId);
        if (existing) {
            if (existing.ownerId !== ownerId || existing.isAll !== isAll) {
                throw new Error(`Conflicting combo pause lease ${leaseId}.`);
            }
            return { status: 'Ignored', reason: 'LEASE_ALREADY_ACTIVE', ...existing };
        }
        const lease = { leaseId, ownerId, isAll, castId, frame, reason };
        this.pauseLeases.set(leaseId, lease);
        let affectedCount = 0;
        for (const pending of this.pending.values()) {
            if (!isAll && pending.ownerId !== ownerId) continue;
            if (pending.pauseLeaseIds.size === 0) pending.pausedAtFrame = frame;
            pending.pauseLeaseIds.add(leaseId);
            affectedCount += 1;
            this.#record({
                frame,
                stage: 'PENDING_TIME_PAUSED',
                ruleId: pending.ruleId,
                pendingId: pending.id,
                skillId: pending.skillId,
                targetId: pending.ownerId,
                triggerTargetId: pending.triggerTargetId,
                pendingRemainingFrames: this.#remainingFrames(pending, frame),
                result: true,
                reason
            });
        }
        return { status: 'Paused', affectedCount, ...lease };
    }

    resume({ frame, leaseId, reason = 'ResumeComboWindowTime' }) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new TypeError('combo resume frame must be a non-negative integer.');
        }
        requiredString(leaseId, 'combo resume leaseId');
        const lease = this.pauseLeases.get(leaseId);
        if (!lease) return { status: 'Ignored', reason: 'LEASE_NOT_ACTIVE', leaseId };
        this.pauseLeases.delete(leaseId);
        let affectedCount = 0;
        for (const pending of this.pending.values()) {
            if (!pending.pauseLeaseIds.delete(leaseId)) continue;
            affectedCount += 1;
            if (pending.pauseLeaseIds.size === 0) {
                const pausedAtFrame = pending.pausedAtFrame ?? frame;
                pending.expireFrame += Math.max(0, frame - pausedAtFrame);
                pending.pausedAtFrame = null;
                this.#scheduleExpiry(pending);
            }
            this.#record({
                frame,
                stage: 'PENDING_TIME_RESUMED',
                ruleId: pending.ruleId,
                pendingId: pending.id,
                skillId: pending.skillId,
                targetId: pending.ownerId,
                triggerTargetId: pending.triggerTargetId,
                pendingRemainingFrames: this.#remainingFrames(pending, frame),
                result: true,
                reason
            });
        }
        this.#expireDueBeforeOrAt(frame);
        return { status: 'Resumed', affectedCount, ...lease, resumeFrame: frame };
    }

    releaseCastPauses({ frame, castId, reason = 'ComboPauseCastEnded' }) {
        if (castId === null || castId === undefined) {
            return { status: 'Ignored', reason: 'CAST_ID_MISSING', releasedCount: 0 };
        }
        const leaseIds = [...this.pauseLeases.values()]
            .filter(lease => lease.castId === castId)
            .map(lease => lease.leaseId);
        for (const leaseId of leaseIds) this.resume({ frame, leaseId, reason });
        return {
            status: leaseIds.length > 0 ? 'Released' : 'Ignored',
            reason: leaseIds.length > 0 ? reason : 'NO_CAST_PAUSE_LEASES',
            releasedCount: leaseIds.length,
            castId
        };
    }

    resolveTimeControl(input = {}) {
        switch (input.operation) {
            case 'Pause':
                return this.pause(input);
            case 'Resume':
                return this.resume(input);
            case 'ReleaseCast':
                return this.releaseCastPauses(input);
            default:
                throw new Error(`Unsupported combo pending time operation: ${input.operation}.`);
        }
    }

    observe(event, context = {}) {
        const decisions = [];
        for (const rule of this.rules) {
            if (!this.#matches(rule, event)) continue;

            const ownerId = this.#boundOwner(rule, event);
            const conditionResult = this.#conditionsPass(rule, event, ownerId);
            if (!conditionResult.passed) {
                this.#record({
                    frame: event.frame,
                    stage: 'PENDING_REJECTED',
                    ruleId: rule.id,
                    pendingId: null,
                    skillId: rule.effect.comboSkillId,
                    targetId: ownerId,
                    triggerTargetId: this.#boundTarget(rule, event),
                    result: false,
                    ...conditionResult
                });
                decisions.push({
                    ruleId: rule.id,
                    status: 'ignored',
                    ...conditionResult
                });
                continue;
            }

            const occurrenceKey = this.#occurrenceKey(rule, event);
            if (occurrenceKey !== null) {
                if (event.sourceCastId === undefined || event.sourceCastId === null) {
                    throw new Error(`Combo trigger rule ${rule.id} requires sourceCastId.`);
                }
                if (this.seenOccurrences.has(occurrenceKey)) {
                    decisions.push({ ruleId: rule.id, status: 'ignored', reason: 'OCCURRENCE_ALREADY_SEEN' });
                    continue;
                }
                this.seenOccurrences.add(occurrenceKey);
            }

            const cooldownEnd = Number(this.getCooldownEnd(rule.effect.comboSkillId) ?? 0);
            if (rule.effect.requireComboOffCooldown && cooldownEnd > event.frame) {
                decisions.push({
                    ruleId: rule.id,
                    status: 'suppressed',
                    reason: 'COMBO_ON_COOLDOWN',
                    cooldownEndFrame: cooldownEnd
                });
                continue;
            }

            const triggerTargetId = this.#boundTarget(rule, event);
            if (rule.selector.requireSourceOtherThanOwner
                && ownerId === event.sourceId) {
                decisions.push({
                    ruleId: rule.id,
                    status: 'ignored',
                    reason: 'SOURCE_IS_PENDING_OWNER'
                });
                continue;
            }
            decisions.push(this.#activatePending(
                rule,
                event,
                ownerId,
                triggerTargetId,
                context
            ));
        }
        return decisions;
    }

    gate({ frame, skillId, ownerId, targetId, cooldownEnd = 0, currentSkillId = null,
        currentPriority = 0, commandId = null, castId = null }) {
        this.#expireDueBeforeOrAt(frame);
        const candidates = [...this.pending.values()].filter(pending =>
            pending.skillId === skillId
            && pending.ownerId === ownerId
            && (pending.triggerTargetId === null || pending.triggerTargetId === targetId)
        );
        const selectionPolicies = new Set(candidates.map(candidate => candidate.selectionPolicy));
        if (selectionPolicies.size > 1) {
            throw new Error(`Conflicting combo selection policies for ${ownerId}/${skillId}.`);
        }
        const selectionPolicy = [...selectionPolicies][0] ?? 'newest';
        candidates.sort((left, right) => {
            const direction = selectionPolicy === 'oldest' ? 1 : -1;
            return direction * (left.createdFrame - right.createdFrame || left.id - right.id);
        });
        const pending = candidates[0] ?? null;
        const ready = Boolean(pending) && (
            pending.bypassSkillCooldown || Number(cooldownEnd) <= frame
        );
        const reason = ready
            ? 'COMBO_PENDING_READY'
            : (pending ? 'COOLDOWN' : 'COMBO_PENDING_MISSING');
        this.#record({
            frame,
            stage: 'COMMAND_GATE',
            pendingId: pending?.id ?? null,
            skillId,
            currentSkillId,
            currentPriority,
            targetId,
            commandId,
            castId,
            triggerTargetId: pending?.triggerTargetId ?? null,
            pendingRemainingFrames: pending ? this.#remainingFrames(pending, frame) : null,
            result: ready,
            reason
        });
        return { ready, reason, pending };
    }

    consume({ frame, pendingId, currentSkillId, currentPriority = 0,
        commandId = null, castId = null }) {
        const selected = this.pending.get(pendingId);
        if (!selected) throw new Error(`Cannot consume missing combo pending ${pendingId}.`);
        if (selected.consumePolicy === 'all-for-owner-and-skill') {
            for (const candidate of [...this.pending.values()]) {
                if (candidate.ownerId === selected.ownerId && candidate.skillId === selected.skillId) {
                    this.pending.delete(candidate.id);
                }
            }
        } else {
            this.pending.delete(selected.id);
        }
        this.#record({
            frame,
            stage: 'PENDING_CONSUMED',
            ruleId: selected.ruleId,
            pendingId: selected.id,
            skillId: selected.skillId,
            currentSkillId,
            currentPriority,
            targetId: selected.ownerId,
            commandId,
            castId,
            triggerTargetId: selected.triggerTargetId,
            pendingRemainingFrames: this.#remainingFrames(selected, frame),
            result: true,
            reason: 'CAST_SUCCESS'
        });
        return selected;
    }

    snapshot(frame = Number.NEGATIVE_INFINITY) {
        if (Number.isFinite(frame)) this.#expireDueBeforeOrAt(frame);
        return [...this.pending.values()]
            .sort((left, right) => left.createdFrame - right.createdFrame || left.id - right.id)
            .map(pending => {
                const { pauseLeaseIds, ...snapshot } = pending;
                return {
                    ...snapshot,
                    paused: pauseLeaseIds.size > 0,
                    pauseLeaseIds: [...pauseLeaseIds],
                    remainingFrames: Number.isFinite(frame)
                        ? this.#remainingFrames(pending, frame)
                        : null
                };
            });
    }
}
