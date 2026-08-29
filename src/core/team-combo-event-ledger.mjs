const DEFAULT_TEAM_COMBO_BUFF_ID = 'buff_common_affixes_combo_trigger';

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function transitionType(event) {
    if (event.stage === 'StatusEffectApplied') return 'grant';
    if (event.stage === 'StatusEffectRefreshed') return 'refresh';
    if (event.consumption === true
        || /^TeamComboConsumedBy/.test(String(event.reason ?? ''))) return 'consume';
    if (event.stage === 'StatusEffectExpired' || event.reason === 'Expired') {
        return 'expire';
    }
    if ([
        'StatusEffectFinished',
        'StatusEffectRemoved',
        'StatusEffectStackRemoved'
    ].includes(event.stage)) return 'remove';
    return null;
}

function grantIdFor(event) {
    return event.sourceMetadata?.teamComboGrantId
        ?? `legacy:${String(event.instanceId ?? [
            event.sourceId,
            event.targetId,
            event.frame
        ].join(':'))}`;
}

function causalIdentity(event, type) {
    if (type === 'consume') {
        return {
            sourceId: event.consumerId ?? event.triggerSourceId ?? null,
            consumerId: event.consumerId ?? event.triggerSourceId ?? null,
            inputSkillId: event.triggerInputSkillId
                ?? event.triggerRootSkillId
                ?? event.triggerSkillId
                ?? null,
            inputCommandType: event.triggerInputCommandType
                ?? event.triggerCommandType
                ?? null,
            executedSkillId: event.triggerSkillId ?? null,
            effectiveSkillType: event.triggerEffectiveSkillType
                ?? event.triggerSkillType
                ?? null,
            castId: event.triggerCastId ?? null,
            rootCastId: event.triggerRootCastId ?? event.triggerCastId ?? null,
            parentCastId: event.triggerParentCastId ?? null
        };
    }
    return {
        sourceId: event.sourceId ?? null,
        consumerId: null,
        inputSkillId: event.inputSkillId ?? event.rootSkillId ?? event.sourceSkillId ?? null,
        inputCommandType: event.inputCommandType ?? event.commandType ?? null,
        executedSkillId: event.sourceSkillId ?? null,
        effectiveSkillType: event.effectiveSkillType ?? event.skillType ?? null,
        castId: event.castId ?? null,
        rootCastId: event.rootCastId ?? event.castId ?? null,
        parentCastId: event.parentCastId ?? null
    };
}

function groupingKey(event, type, identity, grantId) {
    if (type === 'consume') {
        return [
            event.frame,
            type,
            identity.rootCastId,
            identity.castId,
            identity.consumerId,
            event.reason
        ].join('|');
    }
    return [
        event.frame,
        type,
        grantId,
        identity.rootCastId,
        identity.castId,
        event.reason
    ].join('|');
}

function snapshotIdentity(snapshot) {
    return [
        snapshot.key,
        snapshot.buffId,
        snapshot.frame,
        snapshot.rootCastId ?? snapshot.castId
    ].join('|');
}

function snapshotForTransition(damageLog, transition) {
    if (transition.type !== 'consume') return null;
    for (const hit of damageLog) {
        if (hit.rootCastId !== transition.rootCastId
            && hit.castId !== transition.castId) continue;
        const snapshot = (hit.consumedStatuses ?? []).find(candidate => (
            candidate.stateType === 'combo'
        ));
        if (snapshot) return clone(snapshot);
    }
    return null;
}

/**
 * Build a neutral, causal projection of the replicated team-combo Buff.
 *
 * StatusEffectSystem stores one carrier per teammate.  This ledger collapses
 * those carriers back into one logical grant/consume/refresh/expire event,
 * preserves root/child cast identity, and serializes every Hit's frozen
 * consumption snapshot for parity comparisons with another runtime.
 */
export function normalizeTeamComboEventLedger({
    statusTrace = [],
    damageLog = [],
    settlements = [],
    buffId = DEFAULT_TEAM_COMBO_BUFF_ID
} = {}) {
    const groups = new Map();
    for (const event of statusTrace) {
        if (event.buffId !== buffId) continue;
        const type = transitionType(event);
        if (type === null) continue;
        const grantId = grantIdFor(event);
        const identity = causalIdentity(event, type);
        const key = groupingKey(event, type, identity, grantId);
        const group = groups.get(key) ?? {
            type,
            frame: finite(event.frame),
            sequence: finite(event.sequence, Number.MAX_SAFE_INTEGER),
            reason: event.reason ?? null,
            ...identity,
            grantIds: new Set(),
            instanceIds: new Set(),
            targetIds: new Set(),
            sourceEventIds: [],
            events: []
        };
        group.sequence = Math.min(
            group.sequence,
            finite(event.sequence, Number.MAX_SAFE_INTEGER)
        );
        group.grantIds.add(grantId);
        if (event.instanceId !== null && event.instanceId !== undefined) {
            group.instanceIds.add(event.instanceId);
        }
        if (event.targetId !== null && event.targetId !== undefined) {
            group.targetIds.add(event.targetId);
        }
        if (event.eventId) group.sourceEventIds.push(event.eventId);
        group.events.push(event);
        groups.set(key, group);
    }

    const logical = [...groups.values()].sort((left, right) => (
        left.frame - right.frame
        || left.sequence - right.sequence
        || left.type.localeCompare(right.type)
    ));
    const activeGrantIds = new Set();
    const events = logical.map((group, index) => {
        const grantIds = [...group.grantIds];
        const beforeStacks = activeGrantIds.size;
        if (group.type === 'grant') {
            grantIds.forEach(grantId => activeGrantIds.add(grantId));
        } else if (['consume', 'expire', 'remove'].includes(group.type)) {
            grantIds.forEach(grantId => activeGrantIds.delete(grantId));
        }
        const afterStacks = activeGrantIds.size;
        const transition = {
            eventId: `team-combo-event:${index + 1}`,
            frame: group.frame,
            sequence: group.sequence,
            type: group.type,
            buffId,
            sourceId: group.sourceId,
            consumerId: group.consumerId,
            inputSkillId: group.inputSkillId,
            inputCommandType: group.inputCommandType,
            executedSkillId: group.executedSkillId,
            effectiveSkillType: group.effectiveSkillType,
            castId: group.castId,
            rootCastId: group.rootCastId,
            parentCastId: group.parentCastId,
            grantIds,
            instanceIds: [...group.instanceIds],
            targetIds: [...group.targetIds],
            beforeStacks,
            deltaStacks: afterStacks - beforeStacks,
            afterStacks,
            reason: group.reason,
            sourceEventIds: clone(group.sourceEventIds)
        };
        return {
            ...transition,
            consumptionSnapshot: snapshotForTransition(damageLog, transition)
        };
    });

    const hits = damageLog.map(hit => {
        const snapshots = new Map();
        for (const snapshot of (hit.consumedStatuses ?? []).filter(candidate => (
            candidate.stateType === 'combo'
        ))) {
            snapshots.set(snapshotIdentity(snapshot), clone(snapshot));
        }
        return {
            hitId: hit.hitId ?? null,
            frame: finite(hit.frame),
            sequence: finite(hit.sequence),
            castId: hit.castId ?? null,
            rootCastId: hit.rootCastId ?? hit.castId ?? null,
            parentCastId: hit.parentCastId ?? null,
            inputSkillId: hit.inputSkillId ?? hit.rootSkillId ?? null,
            inputCommandType: hit.inputCommandType ?? null,
            executedSkillId: hit.skillId ?? null,
            effectiveSkillType: hit.effectiveSkillType ?? null,
            damageAttributeType: hit.damageAttributeType ?? null,
            consumptionSnapshots: [...snapshots.values()]
        };
    });

    return {
        schemaVersion: 1,
        buffId,
        settlements: clone(settlements),
        events,
        hits
    };
}

export default normalizeTeamComboEventLedger;
