const PRODUCER_DEFINITIONS = [
    ['OnBeforeCastSkill', 'scenario-command-start'],
    ['OnSkillEnd', 'combat-runtime-skill-lifecycle'],
    ['OnTrulyExitFight', 'combat-runtime-fight-lifecycle'],
    ['OnBeforeAddedBuff', 'combat-runtime-status-transaction'],
    ['OnAddedBuff', 'combat-runtime-status-transaction'],
    ['OnBeforeOutputBuff', 'combat-runtime-status-transaction'],
    ['OnOutputBuff', 'combat-runtime-status-transaction'],
    ['OnFinishedBuff', 'combat-runtime-status-lifecycle'],
    ['OnConsumeBuff', 'combat-runtime-status-consumption'],
    ['OnBeforeOutputDamage', 'combat-runtime-damage-transaction'],
    ['OnBeforeTakeDamage', 'combat-runtime-damage-transaction'],
    ['OnOutputDamage', 'combat-runtime-damage-transaction'],
    ['OnTakeDamage', 'combat-runtime-damage-transaction'],
    ['OnOutputHeal', 'combat-runtime-heal-transaction'],
    ['OnReceiveHeal', 'combat-runtime-heal-transaction'],
    ['OnOutputCriticalDamage', 'combat-runtime-damage-transaction'],
    ['OnTakeCriticalDamage', 'combat-runtime-damage-transaction'],
    ['OnBeforeOutputPoiseDamage', 'combat-runtime-poise-damage-transaction'],
    ['OnBeforeTakePoiseDamage', 'combat-runtime-poise-damage-transaction'],
    ['OnPoiseZero', 'poise-system-broken-edge'],
    ['OnPoiseRecover', 'poise-system-recovered-edge'],
    ['OnOwnerHpZero', 'combat-runtime-vital-zero-edge'],
    ['OnAfterKillEntity', 'combat-runtime-damage-transaction'],
    ['OnTakePoiseDamage', 'combat-runtime-damage-transaction'],
    ['OnBeforeOutputAirborne', 'combat-runtime-status-transaction'],
    ['OnObtainAtb', 'combat-runtime-resource-transaction'],
    ['OnAtbMax', 'combat-runtime-resource-transaction'],
    ['OnAfterSkillApplyCost', 'combat-runtime-resource-transaction'],
    ['OnSquadUspChange', 'combat-runtime-resource-transaction'],
    ['OnRemoveAllPendingComboSkill', 'combo-trigger-owner-empty-edge'],
    ['ReactionTriggered', 'combat-runtime-reaction-callback']
];

export const RUNTIME_ABILITY_EVENT_PRODUCERS = Object.freeze(Object.fromEntries(
    PRODUCER_DEFINITIONS.map(([eventType, producer]) => [
        eventType,
        Object.freeze({ eventType, producer })
    ])
));

export const RUNTIME_ABILITY_EVENT_TYPES = Object.freeze(
    Object.keys(RUNTIME_ABILITY_EVENT_PRODUCERS).sort()
);

export function hasRuntimeAbilityEventProducer(eventType) {
    return typeof eventType === 'string'
        && Object.hasOwn(RUNTIME_ABILITY_EVENT_PRODUCERS, eventType);
}

export function runtimeAbilityEventProducer(eventType) {
    return hasRuntimeAbilityEventProducer(eventType)
        ? RUNTIME_ABILITY_EVENT_PRODUCERS[eventType]
        : null;
}
