// A reactive branch keeps the producing cast as its damage owner. These fields
// identify the separate transaction that made the branch condition become true.
const FIELDS = ['triggerCastId', 'triggerRootCastId', 'triggerSourceId',
    'triggerSkillId', 'triggerRootSkillId', 'triggerFrame'];

export function combatTriggerAttribution(context = {}) {
    return Object.fromEntries(FIELDS.filter(key => context[key] != null)
        .map(key => [key, context[key]]));
}

export function combatTransactionTrigger(context = {}) {
    if (context.triggerCastId != null) return combatTriggerAttribution(context);
    if (context.castId == null) return {};
    return {
        triggerCastId: context.castId,
        triggerRootCastId: context.rootCastId ?? context.castId,
        triggerSourceId: context.sourceId ?? null,
        triggerSkillId: context.skillId ?? null,
        triggerRootSkillId: context.rootSkillId ?? context.skillId ?? null,
        triggerFrame: context.frame ?? null
    };
}
