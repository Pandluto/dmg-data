/**
 * Shared classification for damage hits that may be used as a release anchor.
 *
 * AKE emits both action impacts and real damage from Buff/status callbacks in
 * the same damage ledger.  The latter must remain visible and affect damage,
 * but periodic settlements are not player release boundaries.  Do not infer
 * this from `sourceBuffId` alone: a few actions install a short-lived Buff
 * whose timeline contains the action's one-shot impact.
 */

const ACTION_DAMAGE_SEMANTICS = new Set(['', 'skill']);
const INTERVAL_ACTION_PATH = /(?:\.actionOnTick(?:\[|$)|(?:^|\.)(?:tick|interval))/i;
const BUFF_EVENT_ACTION_PATH = /(?:^|\.)buffEventAction(?:\[|$)/i;

function repeatingBuffDefinition(buff) {
    if (!buff || typeof buff !== 'object') return false;
    const intervalSeconds = Number(buff.triggerIntervalSeconds);
    const intervalTicks = Number(buff.triggerIntervalTicks);
    const maxTriggerCount = Number(buff.maxTriggerCount);
    if ((Number.isFinite(intervalSeconds) && intervalSeconds > 0)
        || (Number.isFinite(intervalTicks) && intervalTicks > 0)
        || (Number.isFinite(maxTriggerCount) && maxTriggerCount > 1)) {
        return true;
    }
    return (buff.timeline ?? []).some(group => (
        (group?.actions ?? []).some(action => (
            action?.type === 'ScheduleIntervalActions'
            || action?.type === 'TickIntervalAction'
        ))
    ));
}

/**
 * Return true when a hit is emitted by a periodic status settlement rather
 * than by the action that opened the current timeline window.
 */
export function isPeriodicStatusDamageHit(hit, bundle) {
    const semantic = String(hit?.semanticHitType ?? '').trim().toLowerCase();
    if (ACTION_DAMAGE_SEMANTICS.has(semantic)) return false;
    if (semantic !== 'buff-derived') return true;

    const sourcePath = String(hit?.sourcePath ?? '');
    if (INTERVAL_ACTION_PATH.test(sourcePath)) return true;

    const sourceBuffId = String(hit?.sourceBuffId ?? '').trim();
    const buff = sourceBuffId && bundle?.buffs?.get
        ? bundle.buffs.get(sourceBuffId)
        : null;
    if (repeatingBuffDefinition(buff)) return true;

    // Unknown lifecycle callbacks are fail-closed.  A missing Buff definition
    // cannot prove that a callback is a one-shot action impact, while a
    // non-event timeline path can still be traced to its owning action.
    return !buff && BUFF_EVENT_ACTION_PATH.test(sourcePath);
}

/**
 * Return true when a positive HP hit is a legal damage-hit release anchor.
 * The hit is still rendered/calculated when this returns false; the flag only
 * controls magnetic release placement.
 */
export function isActionOwnedDamageHit(hit, bundle) {
    const semantic = String(hit?.semanticHitType ?? '').trim().toLowerCase();
    if (ACTION_DAMAGE_SEMANTICS.has(semantic)) return true;
    if (semantic !== 'buff-derived') return false;
    return !isPeriodicStatusDamageHit(hit, bundle);
}

