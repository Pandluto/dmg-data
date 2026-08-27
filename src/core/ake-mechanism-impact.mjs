const PRESENTATION_TYPES = new Set([
    'AddDynamicCcsAction',
    'AnimEventReceiver',
    'BoneAttachAction',
    'CheckComboSkillCameraAlphaSetting',
    'CheckSkillCameraMotionFree',
    'ContinuousSetAnimTimeScale',
    'CreateAdditionalBattleShape',
    'IgnoreModelIntervalCheck',
    'ModifyWeaponMountPoint',
    'NotifyCharPassiveUIAction',
    'SendBattleSignalToLevel',
    'ShowComboRingQte',
    'TriggerLiinoUIEvent'
]);

const SPATIAL_TYPES = new Set([
    'CheckHasMoveInput',
    'CheckTargetAngle',
    'CheckTargetInScreen',
    'CheckTwoDirectionAngle',
    'ConvertToTargetContext',
    'CustomRootMotionAction',
    'DisableRootMotionAction',
    'ForceTargetInFightAction',
    'MergeTargetAction',
    'MoveToAction',
    'ReceiveMoveInputAction',
    'SaveTargetDistanceAction',
    'SaveTwoDirectionAngle',
    'SelfRotateAction',
    'SkillAIMoveAction',
    'SnapToTargetWithRangeAction',
    'TargetPostProcessorAction',
    'TeleportAction',
    'TeleportPosSelectAction',
    'TryToTeleportSquadAction'
]);

const PHYSICAL_SPATIAL_TYPES = new Set([
    'AirborneAction',
    'BlowOffAction',
    'BlowOffEnemyAction',
    'LaunchUpwardAction',
    'PullAction',
    'PushBackAction',
    'TakeDownAction'
]);

const STATUS_LIFECYCLE_TYPES = new Set([
    'DispelAction',
    'ExtendBuffAction',
    'FinishBuffAdvanced',
    'ForceSpellStatusAction',
    'InheritBuffAction',
    'PauseBuffTime',
    'SaveBuffLifeTime',
    'SaveBuffStackNum',
    'SaveBuffStackNumAdvanced',
    'SaveBuffStackNumByTag',
    'SealAction',
    'SlowAction',
    'SpeedupAction',
    'WeakAction'
]);

const DAMAGE_FACTOR_TYPES = new Set([
    'EnhancedAction',
    'ShelterAction',
    'VulnerableAction'
]);

const COOLDOWN_TYPES = new Set([
    'AddGlobalCDTimer',
    'CheckGlobalCDTimerAction',
    'PauseComboSkillTime',
    'SetSkillCdAtOnce'
]);

const CHILD_ACTION_TYPES = new Set([
    'CastSkill',
    'ClearProjectileAction',
    'SetAbilityEntityDuration',
    'SetAbilityEntityTarget',
    'SpawnAbilityEntity'
]);

const FORM_TYPES = new Set([
    'AddTagAction',
    'AddTagToEntities',
    'BombClearAction',
    'ChangeSkillType',
    'ChangeSpecificLayerAction',
    'OverrideMultiDashLimit',
    'SkillAffixAction',
    'TagQueryListenerAction',
    'TogglableAction'
]);

const EVENT_TYPES = new Set([
    'AttackClickListenerAction',
    'ComboAction',
    'DoOnceAction',
    'EventListenerAction',
    'TriggerComboSkillAction',
    'TriggerCustomAbilityEvent'
]);

const STATE_VALUE_TYPES = new Set([
    'ModifyCollectedBuffBbValue',
    'SaveCollectedBuffBbValue',
    'StoreCurSkillExecuteFrame',
    'StoreSkillDamageType'
]);

const COMBAT_CONDITION_TYPES = new Set([
    'CheckBuffStackNumByTag',
    'CheckCustomAbilityEvent',
    'CheckEnemyRank',
    'CheckObjectTypeMatch',
    'CheckOriginSkillType',
    'CheckProfession',
    'CheckSkillCastId',
    'CheckSkillHasHit',
    'CheckSpellInflictionType',
    'CheckSuperArmor',
    'NotNextCheckAction',
    'OrConditionAction'
]);

function result(impact, priority, capability, rationale) {
    return { impact, priority, capability, rationale };
}

/**
 * Classifies a compiler gap by gameplay consequence.  This is intentionally
 * independent of operator ids: a raw AKE capability has the same consequence
 * wherever it appears.
 */
export function classifyAkeMechanismGap({ sourceType = '', code = '', category = '' } = {}) {
    const type = String(sourceType ?? '');
    const diagnosticCode = String(code ?? '');

    if (PRESENTATION_TYPES.has(type)) {
        return result(
            'presentation-only', 'P3', 'presentation',
            'The action changes audiovisual or editor presentation, not fixed-dummy combat state.'
        );
    }
    if (PHYSICAL_SPATIAL_TYPES.has(type)) {
        return result(
            'combat-partial', 'P1', 'physical-status',
            'Spatial resolution can also decide a physical status attempt and cannot be discarded as presentation.'
        );
    }
    if (SPATIAL_TYPES.has(type) || diagnosticCode === 'AKE_SPATIAL_PROVIDER_REQUIRED') {
        return result(
            'spatial-assumption', 'P2', 'targeting-spatial',
            'The fixed-dummy runtime needs an explicit spatial assumption or target provider.'
        );
    }
    if (STATUS_LIFECYCLE_TYPES.has(type)) {
        return result(
            'combat-blocking', 'P0', 'status-lifecycle',
            'The action changes status application, duration, stacks, inheritance, consumption, or removal.'
        );
    }
    if (DAMAGE_FACTOR_TYPES.has(type)) {
        return result(
            'combat-blocking', 'P0', 'damage-factor',
            'The action changes a target-side or source-side damage factor.'
        );
    }
    if (COOLDOWN_TYPES.has(type)) {
        return result(
            'combat-blocking', 'P0', 'cooldown-window',
            'The action changes cooldown or combo-window admission state.'
        );
    }
    if (CHILD_ACTION_TYPES.has(type)
        || diagnosticCode === 'AKE_ABILITY_ENTITY_SKILL_MISSING') {
        return result(
            'combat-blocking', 'P0', 'child-action',
            'The action schedules, mutates, or removes a child skill/entity that can own independent hits.'
        );
    }
    if (FORM_TYPES.has(type)) {
        return result(
            'combat-blocking', 'P0', 'form-state',
            'The action changes tags, layers, skill replacement, or a toggle used by form selection.'
        );
    }
    if (EVENT_TYPES.has(type)
        || diagnosticCode === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
        || diagnosticCode === 'AKE_ABILITY_EVENT_TYPE_REQUIRED') {
        return result(
            'combat-blocking', 'P0', 'event-subscription',
            'The action controls whether a later gameplay event is observed or emitted.'
        );
    }
    if (STATE_VALUE_TYPES.has(type)) {
        return result(
            'combat-blocking', 'P1', 'derived-state',
            'The action stores a runtime value that later conditions or damage effects can consume.'
        );
    }
    if (COMBAT_CONDITION_TYPES.has(type)
        || diagnosticCode === 'AKE_CONDITION_UNSUPPORTED') {
        return result(
            'combat-blocking', 'P1', 'condition-algebra',
            'An unevaluated condition can select the wrong gameplay branch.'
        );
    }
    if (type === 'RandomAction' || type === 'Probablity' || type === 'CurveEvaluateFloat') {
        return result(
            'evidence-missing', 'P1', 'deterministic-choice',
            'The branch/value can affect combat, but its sampling or curve semantics require evidence and replay rules.'
        );
    }
    if (diagnosticCode === 'AKE_CHANNEL_SCHEDULER_REQUIRED') {
        return result(
            'combat-blocking', 'P0', 'event-scheduling',
            'Channel timing determines tick count, hit time, and interruption behavior.'
        );
    }
    if (diagnosticCode === 'AKE_NORMAL_SKILL_USP_BLACKBOARD_REQUIRED') {
        return result(
            'combat-blocking', 'P0', 'resource-transaction',
            'A missing resource value changes future command admission.'
        );
    }
    if (diagnosticCode === 'AKE_BUFF_SELECTOR_PROVIDER_REQUIRED') {
        return result(
            'combat-blocking', 'P0', 'status-lifecycle',
            'The runtime cannot identify which status instance must be changed.'
        );
    }
    if (diagnosticCode === 'AKE_TARGET_PROVIDER_REQUIRED'
        || diagnosticCode === 'AKE_TARGET_FINDER_PROVIDER_REQUIRED') {
        return result(
            'combat-partial', 'P1', 'targeting-scope',
            'The runtime cannot prove the recipient set under the current fixed-dummy binding.'
        );
    }
    if (diagnosticCode === 'AKE_SKILL_SETTING_MISSING'
        || diagnosticCode === 'AKE_DYNAMIC_CALCULATION_REQUIRED'
        || diagnosticCode === 'AKE_ENVIRONMENT_BUFF_PROVIDER_REQUIRED') {
        return result(
            'evidence-missing', 'P1', 'data-provider',
            'The raw action depends on data or context that is not present in the assembled evidence closure.'
        );
    }
    if (diagnosticCode === 'AKE_SKILL_DATA_MISSING'
        || diagnosticCode === 'AKE_BUFF_DATA_MISSING') {
        return result(
            'combat-blocking', 'P0', 'dependency-closure',
            'A referenced SkillData or BuffData document is absent from the runtime closure.'
        );
    }
    if (category === 'presentation') {
        return result(
            'presentation-only', 'P3', 'presentation',
            'The compiler identified this node as presentation metadata.'
        );
    }
    return result(
        'evidence-missing', 'P2', 'unclassified',
        'The gameplay consequence has not yet been proven; it must not be silently treated as supported.'
    );
}

export const AKE_MECHANISM_IMPACTS = Object.freeze([
    'presentation-only',
    'spatial-assumption',
    'combat-partial',
    'combat-blocking',
    'evidence-missing'
]);
