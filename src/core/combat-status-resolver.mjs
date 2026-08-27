function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function countLayers(statusEffects, targetId, buffId) {
    if (!buffId) return 0;
    return statusEffects.list({ active: true, targetId, buffId })
        .reduce((sum, instance) => sum + Number(instance.stackCount ?? 0), 0);
}

/**
 * Executes an AKE physical status attempt as one auditable transaction.
 *
 * The serialized trigger Buff is the authority: its OnBuffStart branch decides
 * whether the target enters no-guard, consumes layers, applies crush/fracture,
 * and spawns derived damage.  This resolver deliberately owns no character or
 * status-specific shortcut.
 */
export class CombatStatusResolver {
    constructor({ statusEffects, executeTransaction, getEffectTrace = () => [] } = {}) {
        if (!statusEffects || typeof statusEffects.list !== 'function') {
            throw new TypeError('CombatStatusResolver requires statusEffects.');
        }
        if (typeof executeTransaction !== 'function') {
            throw new TypeError('CombatStatusResolver requires executeTransaction.');
        }
        if (typeof getEffectTrace !== 'function') {
            throw new TypeError('getEffectTrace must be a function.');
        }
        this.statusEffects = statusEffects;
        this.executeTransaction = executeTransaction;
        this.getEffectTrace = getEffectTrace;
        this.nextTransactionSequence = 1;
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
                statusBuffId
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

export default CombatStatusResolver;
