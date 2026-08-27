function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function countLayers(statusEffects, targetId, buffId) {
    if (!buffId) return 0;
    return statusEffects.list({ active: true, targetId, buffId })
        .reduce((sum, instance) => sum + Number(instance.stackCount ?? 0), 0);
}

function normalizedAttachmentMap(action) {
    const entries = Object.entries(action.attachmentBuffIds ?? {})
        .filter(([element, buffId]) => typeof element === 'string' && element.length > 0
            && typeof buffId === 'string' && buffId.length > 0);
    if (typeof action.element === 'string' && action.element.length > 0
        && typeof action.buffId === 'string' && action.buffId.length > 0
        && !entries.some(([element]) => element === action.element)) {
        entries.push([action.element, action.buffId]);
    }
    return new Map(entries);
}

function statusEventsForTransaction(statusEffects, startIndex, transactionId) {
    return statusEffects.trace.slice(startIndex)
        .filter(event => event.transactionId === transactionId);
}

/**
 * Executes an AKE physical status attempt as one auditable transaction.
 *
 * The serialized trigger Buff is the authority: its OnBuffStart branch decides
 * whether the target enters no-guard, consumes layers, applies crush/fracture,
 * and spawns derived damage.  This resolver deliberately owns no character or
 * status-specific shortcut.
 */
export class EnemyMechanicResolver {
    constructor({ statusEffects, executeTransaction, getEffectTrace = () => [] } = {}) {
        if (!statusEffects || typeof statusEffects.list !== 'function') {
            throw new TypeError('EnemyMechanicResolver requires statusEffects.');
        }
        if (typeof executeTransaction !== 'function') {
            throw new TypeError('EnemyMechanicResolver requires executeTransaction.');
        }
        if (typeof getEffectTrace !== 'function') {
            throw new TypeError('getEffectTrace must be a function.');
        }
        this.statusEffects = statusEffects;
        this.executeTransaction = executeTransaction;
        this.getEffectTrace = getEffectTrace;
        this.nextTransactionSequence = 1;
    }

    /**
     * Resolves the four player-to-enemy elemental attachments as one enemy
     * transaction. A target owns one attachment slot: same-element attempts
     * enhance it, while a different element ignites and consumes the existing
     * attachment without leaving the incoming element behind.
     */
    resolveInfliction(action, eventContext, targetId) {
        const transactionId = eventContext.transactionId
            ?? `enemy-infliction:${this.nextTransactionSequence++}`;
        const element = action.element ?? null;
        const buffId = action.buffId ?? null;
        const attachmentBuffIds = normalizedAttachmentMap(action);
        const knownBuffIds = new Set(attachmentBuffIds.values());
        const beforeInstances = this.statusEffects.list({ active: true, targetId })
            .filter(instance => knownBuffIds.has(instance.buffId))
            .sort((left, right) => Number(left.startFrame ?? 0) - Number(right.startFrame ?? 0)
                || String(left.instanceId).localeCompare(String(right.instanceId)));
        const before = beforeInstances.reduce(
            (sum, instance) => sum + Number(instance.stackCount ?? 0),
            0
        );
        const statusTraceStart = this.statusEffects.trace.length;
        const effectTraceStart = this.getEffectTrace().length;
        const context = {
            ...clone(eventContext),
            targetId,
            carrierId: targetId,
            damageSourceId: eventContext.damageSourceId ?? eventContext.sourceId ?? null,
            transactionId,
            eventType: 'EnemyInflictionTransaction',
            payload: {
                ...clone(eventContext.payload ?? {}),
                element,
                inflictionBuffId: buffId,
                attachmentBuffIds: Object.fromEntries(attachmentBuffIds)
            }
        };

        if (typeof element !== 'string' || element.length === 0
            || typeof buffId !== 'string' || buffId.length === 0
            || attachmentBuffIds.size === 0) {
            return {
                status: 'Unresolved',
                code: 'ENEMY_INFLICTION_MAPPING_MISSING',
                reason: 'MissingElementalAttachmentMapping',
                transactionId,
                element,
                targetId,
                buffId,
                before,
                after: before,
                branch: 'Unresolved',
                diagnostics: [{
                    code: 'ENEMY_INFLICTION_MAPPING_MISSING',
                    severity: 'error',
                    transactionId
                }]
            };
        }

        const conflicting = beforeInstances.filter(instance => instance.buffId !== buffId);
        const sameElement = beforeInstances.length > 0 && conflicting.length === 0;
        const branch = beforeInstances.length === 0
            ? 'AttachmentApplied'
            : sameElement
                ? 'AttachmentEnhanced'
                : 'ElementalReaction';
        const actions = conflicting.length === 0
            ? [{
                type: 'ApplyBuff',
                buffId,
                target: targetId,
                inheritEventBlackboard: false,
                triggerEnhancementEvent: true,
                reason: action.reason ?? 'SpellInfliction'
            }]
            : [
                {
                    type: 'TriggerStatusEvent',
                    eventType: `EnergyShardBy${element}`,
                    element,
                    target: targetId,
                    // The incoming inflictor triggers and owns the reaction.
                    // The consumed attachment retains its own stack-source
                    // ledger separately; it must not steal damage attribution.
                    eventSourceAsActionSource: true,
                    reason: action.reason ?? 'SpellInfliction'
                },
                ...beforeInstances.map(instance => ({
                    type: 'FinishBuff',
                    instanceId: instance.instanceId,
                    target: targetId,
                    finishAll: true,
                    reason: `ElementalReaction:${element}`
                }))
            ];
        const execution = this.executeTransaction(actions, context);
        const statusEvents = statusEventsForTransaction(
            this.statusEffects,
            statusTraceStart,
            transactionId
        );
        const effectEvents = this.getEffectTrace().slice(effectTraceStart)
            .filter(event => event.transactionId === transactionId);
        const afterInstances = this.statusEffects.list({ active: true, targetId })
            .filter(instance => knownBuffIds.has(instance.buffId));
        const after = afterInstances.reduce(
            (sum, instance) => sum + Number(instance.stackCount ?? 0),
            0
        );
        return {
            status: 'Applied',
            reason: action.reason ?? 'SpellInfliction',
            transactionId,
            element,
            targetId,
            buffId,
            branch,
            before,
            after,
            consumedStacks: branch === 'ElementalReaction' ? before : 0,
            activeAttachmentBuffIds: afterInstances.map(instance => instance.buffId),
            statusEvents: clone(statusEvents),
            effectEvents: clone(effectEvents),
            execution: clone(execution),
            diagnostics: beforeInstances.length > 1 ? [{
                code: 'ENEMY_ATTACHMENT_SLOT_CONFLICT',
                severity: 'error',
                transactionId,
                activeBuffIds: beforeInstances.map(instance => instance.buffId)
            }] : []
        };
    }

    resolve(action, eventContext, targetId) {
        const transactionId = eventContext.transactionId
            ?? `combat-status:${this.nextTransactionSequence++}`;
        const triggerBuffId = action.triggerBuffId;
        const initialBuffId = action.initialBuffId ?? 'buff_physical_no_guard';
        const statusBuffId = action.statusBuffId ?? null;
        const before = countLayers(this.statusEffects, targetId, initialBuffId);
        const statusTraceStart = this.statusEffects.trace.length;
        const effectTraceStart = this.getEffectTrace().length;
        const context = {
            ...clone(eventContext),
            targetId,
            carrierId: targetId,
            damageSourceId: eventContext.damageSourceId ?? eventContext.sourceId ?? null,
            transactionId,
            eventType: 'PhysicalStatusTransaction',
            payload: {
                ...clone(eventContext.payload ?? {}),
                statusKey: action.statusKey ?? null,
                triggerBuffId,
                initialBuffId,
                statusBuffId,
                // Lift/knockdown add vulnerability in the canonical enemy
                // state. Raw AKE control Buffs temporarily finish no_guard and
                // create an internal fake marker; retaining the real stack here
                // prevents that implementation detail from becoming a false
                // state transition in damage and UI ledgers.
                preserveBuffIds: ['airborne', 'knockdown'].includes(action.statusKey)
                    ? [initialBuffId]
                    : [],
                // Every lift/knockdown attempt is an enemy event. Re-entering
                // the same control state must execute its OnBuffStart damage
                // and vulnerability action again instead of becoming a visual
                // duration-only refresh at the shared `physical` slot.
                reenterStatusBuffIds: ['airborne', 'knockdown'].includes(action.statusKey)
                    && statusBuffId
                    ? [statusBuffId]
                    : []
            }
        };

        if (typeof triggerBuffId !== 'string' || triggerBuffId.length === 0) {
            return {
                status: 'Unresolved',
                code: 'COMBAT_STATUS_TRIGGER_MISSING',
                reason: 'MissingTriggerBuffId',
                transactionId,
                statusKey: action.statusKey ?? null,
                targetId,
                triggerBuffId: triggerBuffId ?? null,
                statusBuffId,
                initialBuffId,
                before,
                requested: 1,
                actual: 0,
                discarded: 1,
                consumedStacks: 0,
                bySource: [],
                after: before,
                spawnedHitIds: [],
                diagnostics: [{
                    code: 'COMBAT_STATUS_TRIGGER_MISSING',
                    severity: 'error',
                    transactionId
                }]
            };
        }

        const execution = this.executeTransaction([{
            type: 'ApplyBuff',
            target: targetId,
            buffs: [{
                buffId: triggerBuffId,
                assignBlackboard: false,
                assignments: []
            }],
            count: 1,
            inheritEventBlackboard: false,
            triggerEnhancementEvent: true,
            // Attempt Buffs are events. Reusing an old instance would suppress
            // their OnBuffStart branch and make the second status application
            // depend on UI ordering rather than raw AKE data.
            stackingPolicy: 'Independent',
            blackboard: clone(action.blackboard ?? {}),
            metadata: {
                ...clone(action.metadata ?? {}),
                akePhysicalStateTransaction: true,
                transactionId,
                initialNoGuardLayers: before
            },
            reason: action.reason ?? `CombatStatus:${String(action.statusKey ?? 'unknown')}`
        }], context);

        const statusEvents = this.statusEffects.trace
            .slice(statusTraceStart)
            .filter(event => event.transactionId === transactionId);
        const effectEvents = this.getEffectTrace()
            .slice(effectTraceStart)
            .filter(event => event.transactionId === transactionId);
        const after = countLayers(this.statusEffects, targetId, initialBuffId);
        const consumedEvents = statusEvents.filter(event =>
            event.buffId === initialBuffId
            && ['StatusEffectStackRemoved', 'StatusEffectFinished'].includes(event.stage));
        const consumedStacks = consumedEvents.reduce(
            (sum, event) => sum + Number(event.consumedStacks ?? event.actual ?? 0),
            0
        );
        const bySource = new Map();
        for (const event of consumedEvents) {
            for (const source of event.bySource ?? []) {
                const key = `${String(source.sourceId)}\u0000${String(source.ownerId)}`;
                const current = bySource.get(key) ?? {
                    sourceId: source.sourceId ?? null,
                    ownerId: source.ownerId ?? null,
                    count: 0
                };
                current.count += Number(source.count ?? 0);
                bySource.set(key, current);
            }
        }
        const spawnedHits = effectEvents
            .filter(event => event.stage === 'ActionDelegated'
                && event.type === 'ResolveDamagePacket')
            .flatMap(event => event.result?.resolution?.hits ?? []);
        const unresolvedEvents = statusEvents.filter(event =>
            event.stage === 'StatusEffectUnresolved');
        const enteredNoGuard = statusEvents.some(event =>
            event.buffId === initialBuffId
            && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
        const appliedStatus = statusBuffId && statusEvents.some(event =>
            event.buffId === statusBuffId
            && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
        const branch = appliedStatus
            ? 'PhysicalStatusApplied'
            : enteredNoGuard
                ? (before === 0 ? 'EnteredNoGuard' : 'NoGuardRefreshed')
                : unresolvedEvents.length > 0
                    ? 'Unresolved'
                    : 'NoStateChange';
        const status = unresolvedEvents.length > 0 ? 'Unresolved' : 'Applied';

        return {
            status,
            code: unresolvedEvents[0]?.code ?? null,
            reason: unresolvedEvents[0]?.reason ?? action.reason ?? 'CombatStatusResolved',
            transactionId,
            statusKey: action.statusKey ?? null,
            targetId,
            triggerBuffId,
            statusBuffId,
            initialBuffId,
            branch,
            before,
            requested: 1,
            actual: Math.max(0, after - before) + (appliedStatus ? 1 : 0),
            discarded: status === 'Unresolved' ? 1 : 0,
            consumedStacks,
            bySource: [...bySource.values()],
            after,
            spawnedHitIds: spawnedHits.map(hit => hit.hitId).filter(Boolean),
            spawnedHits: clone(spawnedHits),
            statusEvents: clone(statusEvents),
            execution: clone(execution),
            diagnostics: unresolvedEvents.map(event => ({
                code: event.code,
                severity: 'error',
                buffId: event.buffId,
                eventId: event.eventId,
                transactionId
            }))
        };
    }
}

// Compatibility export for integrations that still use the earlier name.
// The implementation owns both physical and elemental enemy mechanics.
export const CombatStatusResolver = EnemyMechanicResolver;

export default EnemyMechanicResolver;
