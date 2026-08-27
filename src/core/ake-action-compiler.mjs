import {
    actionType,
    parseBlackboard,
    parseBuff,
    parseSkill,
    resolveValue
} from './ake-parser.mjs';
import {
    AKE_FORCED_SPELL_STATUS_BUFF_IDS
} from './combat-status-resolver.mjs';

const PRESENTATION_TOKENS = [
    'animation', 'animator', 'hurtanim', 'playanim', 'effectaction', 'vfx',
    'playsound', 'soundaction', 'voice', 'camera', 'screenshake',
    'weaponvisible', 'weaponanimation', 'hideui', 'ultimateshow',
    'showhideactor', 'materialaction', 'debugprint'
];
const TIMELINE_METADATA_TYPES = new Set([
    'LaunchProjectile', 'ComboCacheAction', 'AllowNextSkillAction',
    'JumpToAction', 'MarkCanInterrupt', 'SpawnAbilityEntity',
    'HitStopAction', 'TimeDilationAction', 'UltimateTimeAction',
    'TickIntervalAction', 'ChannelingAction', 'ChannelingCastingAction'
]);
const TIMELINE_RESOLVER_TYPES = new Set([
    'HitStopAction', 'TimeDilationAction', 'JumpToAction',
    'MarkCanInterrupt', 'SpawnAbilityEntity',
    'ChannelingAction', 'ChannelingCastingAction', 'UltimateTimeAction'
]);
const SPATIAL_TYPES = new Set([
    'MergeTargetAction', 'MoveToAction', 'TeleportAction',
    'TeleportPosSelectAction', 'CustomRootMotionAction', 'SelfRotateAction',
    'SnapToTargetWithRangeAction', 'PushBackAction', 'PullAction',
    'BlowOffAction', 'AirborneAction', 'LaunchUpwardAction'
]);
const COMBAT_STATUS_METADATA = new Map([
    ['CrushAction', {
        statusKey: 'crush', displayName: '猛击',
        buffId: 'buff_physical_try_crushed',
        statusBuffId: 'buff_physical_crushed'
    }],
    ['FractureAction', {
        statusKey: 'fracture', displayName: '碎甲',
        buffId: 'buff_physical_fracture',
        statusBuffId: 'buff_physical_fracture'
    }],
    ['KnockDownAction', {
        statusKey: 'knockdown', displayName: '倒地',
        buffId: 'buff_physical_try_knockdown',
        statusBuffId: 'buff_physical_knockdown'
    }],
    ['AirborneAction', {
        statusKey: 'airborne', displayName: '击飞',
        buffId: 'buff_physical_try_airborne',
        statusBuffId: 'buff_physical_airborne'
    }]
]);
const VULNERABILITY_BUFF_IDS = Object.freeze({
    Physical: 'buff_common_affixes_vulnerable_physical',
    Spell: 'buff_common_affixes_vulnerable_spell',
    Fire: 'buff_common_affixes_vulnerable_fire',
    Pulse: 'buff_common_affixes_vulnerable_pulse',
    Crystal: 'buff_common_affixes_vulnerable_crystal',
    // Retain the compact enum spelling used by damage packets and older data.
    Cryst: 'buff_common_affixes_vulnerable_crystal',
    Natural: 'buff_common_affixes_vulnerable_natural'
});
const WEAKNESS_BUFF_ID = 'buff_common_affixes_weak';
const SHELTER_BUFF_ID = 'buff_common_affixes_shelter';
const STATUS_ENHANCEMENT_OPERATIONS = Object.freeze({
    Add: 'Add',
    Subtract: 'Subtract',
    Multiply: 'Multiply',
    Divide: 'Divide',
    Min: 'Min',
    Max: 'Max'
});
const SPELL_ABNORMAL_TYPES = new Set([
    'Fire', 'Pulse', 'Cryst', 'Natural', 'Burst'
]);
const CONDITION_PREFIX = /^(Check|Compare|Probablity$|OrCondition|NotNextCheck)/;
// Keep this list synchronized with CombatRuntime's concrete event emitters.
// An EventListenerAction may still compile its executable child actions when
// an emitter is missing, but the compiler must retain that missing boundary as
// an explicit audit blocker instead of pretending that the listener can fire.
const RUNTIME_ABILITY_EVENT_TYPES = new Set([
    'OnBeforeTakeDamage',
    'OnAddedBuff',
    'OnOutputBuff',
    'OnBeforeOutputAirborne',
    'OnAfterKillEntity',
    'OnSkillEnd',
    'OnBeforeAddedBuff',
    'OnTrulyExitFight',
    'OnFinishedBuff'
]);
const TARGET_ALIASES = new Map([
    ['Source', 'Source'],
    ['ActionSource', 'Source'],
    ['Self', 'Source'],
    ['Owner', 'Owner'],
    ['ActionOwner', 'Owner'],
    ['Target', 'Target'],
    ['CurrentTarget', 'Target'],
    // The clean-room scenario has one explicit hostile target. These AKE
    // selector modes are therefore deterministic bindings, not spatial guesses.
    ['MainTarget', 'Target'],
    ['InstantSearch', 'Target'],
    ['SmartTarget', 'Target']
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function shortType(node) {
    return actionType(node?.$type) || node?.type;
}

function actionData(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.actionData)) return value.actionData;
    return [];
}

function selectorSource(value) {
    if (typeof value === 'string') return value;
    return value?.targetSource ?? value?.target ?? null;
}

function selectorGroupKey(value) {
    if (!isRecord(value)) return null;
    const key = value.targetGroupKey ?? value.contextKey;
    return typeof key === 'string' && key.length > 0 ? key : null;
}

function nestedDataType(value) {
    const rawType = value?.$type;
    if (typeof rawType !== 'string') return null;
    const nested = rawType.split(',', 1)[0].split('+');
    return nested.length > 1
        ? nested.at(-2).split('.').at(-1)
        : actionType(rawType);
}

function finderType(node) {
    return nestedDataType(node?.selectorData?.finderData);
}

function emptyCompilation(sourceType = null) {
    return {
        sourceType,
        status: 'metadata-only',
        actions: [],
        cleanupActions: [],
        metadata: [],
        unresolved: [],
        diagnostics: []
    };
}

function finalize(compilation) {
    if (compilation.unresolved.length > 0) {
        compilation.status = 'unresolved';
    } else if (compilation.actions.length > 0 || compilation.cleanupActions.length > 0) {
        compilation.status = 'executable';
    } else {
        compilation.status = 'metadata-only';
    }
    return compilation;
}

function mergeCompilation(target, source) {
    target.actions.push(...source.actions);
    target.cleanupActions.push(...source.cleanupActions);
    target.metadata.push(...source.metadata);
    target.unresolved.push(...source.unresolved);
    target.diagnostics.push(...source.diagnostics);
    return target;
}

function descriptor(value, fallback = 0) {
    if (value === undefined || value === null) return fallback;
    return clone(value);
}

function elementalAttachmentBuffIds(semanticMappings) {
    return Object.fromEntries(semanticMappings
        .filter(candidate => candidate.actionType === 'SpellInfliction'
            && candidate.effect?.operation === 'ApplyBuff'
            && typeof candidate.selector?.inflictionType === 'string'
            && typeof candidate.effect?.buffId === 'string')
        .map(candidate => [
            candidate.selector.inflictionType,
            candidate.effect.buffId
        ]));
}

function normalizeAssignments(buff) {
    return (buff.assignments ?? buff.assignItems ?? [])
        .filter(item => (typeof item?.targetKey === 'string'
            && item.targetKey.trim().length > 0)
            || Number.isFinite(item?.targetKey))
        .map(item => ({
            targetKey: item.targetKey,
            sourceKey: item.sourceKey ?? item.inputValueKey ?? null,
            direct: Boolean(item.direct ?? item.useDirectValue),
            directValue: item.directValue ?? (item.directValueType === 'String'
                ? item.stringValue
                : item.numericValue)
        }));
}

function normalizeDamageUnits(node) {
    const units = node.damageUnits ?? [];
    return units
        .filter(unit => ['Hp', 'Poise'].includes(unit.damageAttributeType))
        .map(unit => ({
            damageType: unit.damageType,
            damageAttributeType: unit.damageAttributeType,
            // This bit field is gameplay data, not presentation metadata. Buff
            // listeners such as Chen Qianyu's talent distinguish crush,
            // fracture and airborne hits through these bits.
            damageDecorateMask: Number(unit.damageDecorateMask ?? 0),
            damageTypeMask: unit.damageTypeMask ?? null,
            scale: unit.scale ?? (unit.simpleCalculation === false
                ? (unit.atkCalculation?.atkScale ?? unit.atkScale)
                : unit.atkScale),
            calculationType: unit.calculationType
                ?? (unit.simpleCalculation === false
                    ? (actionType(unit.atkCalculation?.$type) || 'UnknownAtkCalculation')
                    : 'SimpleAtkScaleCalculation'),
            calculationMultiplier: unit.calculationMultiplier
                ?? unit.atkCalculation?.multiplier
                ?? { useBlackboardKey: false, value: 1, blackboardKey: '' },
            poiseCalculationType: unit.poiseCalculationType
                ?? actionType(unit.poiseCalculation?.$type),
            poiseValue: unit.poiseValue
                ?? unit.poiseCalculation?.value
                ?? { useBlackboardKey: false, value: 0, blackboardKey: '' },
            poiseApplyScale: unit.poiseApplyScale
                ?? Boolean(unit.poiseCalculation?.applyScale),
            poiseValueScale: unit.poiseValueScale
                ?? unit.poiseCalculation?.valueScale
                ?? { useBlackboardKey: false, value: 0, blackboardKey: '' },
            enablePoiseBreakTimeDilation: Boolean(unit.enablePoiseBreakTimeDilation),
            simpleCalculation: unit.simpleCalculation !== false,
            onlyEnableForMainChar: Boolean(unit.onlyEnableForMainChar)
        }));
}

function tagIds(value) {
    const result = [];
    const visit = item => {
        if (item === null || item === undefined) return;
        if (Array.isArray(item)) return item.forEach(visit);
        if (typeof item === 'number' || typeof item === 'string') {
            result.push(item);
            return;
        }
        if (!isRecord(item)) return;
        if (item.tagId !== undefined) result.push(item.tagId);
        else Object.values(item).forEach(visit);
    };
    visit(value);
    return [...new Set(result)];
}

export function isAkeConditionType(type) {
    return CONDITION_PREFIX.test(String(type ?? ''));
}

export function classifyAkeActionType(type) {
    const name = String(type ?? '');
    const normalized = name.toLowerCase();
    if (isAkeConditionType(name)) return { category: 'condition', disposition: 'compiler' };
    if (PRESENTATION_TOKENS.some(token => normalized.includes(token))) {
        return { category: 'presentation', disposition: 'metadata-only' };
    }
    if (TIMELINE_METADATA_TYPES.has(name)) {
        return { category: 'timeline', disposition: 'metadata-only' };
    }
    if (SPATIAL_TYPES.has(name)) return { category: 'spatial', disposition: 'external-provider' };
    if (normalized.includes('damage')) return { category: 'damage', disposition: 'compiler' };
    if (normalized.includes('heal') || normalized.includes('recover')) {
        return { category: 'recovery', disposition: 'compiler' };
    }
    if (normalized.includes('buff') || normalized.includes('aura')) {
        return { category: 'buff', disposition: 'compiler' };
    }
    if (normalized.includes('atb') || normalized.includes('usp') || normalized.includes('cost')) {
        return { category: 'resource', disposition: 'compiler' };
    }
    if (normalized.includes('blackboard') || normalized.includes('simplecalc')
        || normalized.includes('attribute') || normalized.includes('ifelse')) {
        return { category: 'logic', disposition: 'compiler' };
    }
    if (normalized.includes('infliction') || normalized.includes('superarmor')
        || normalized.includes('resilience') || normalized.includes('control')) {
        return { category: 'control', disposition: 'compiler' };
    }
    return { category: 'other', disposition: 'unresolved' };
}

export class AkeActionCompiler {
    constructor({
        tickRate = 30,
        semanticMappings = [],
        targetMappings = {},
        capabilities = {}
    } = {}) {
        this.tickRate = Number(tickRate);
        if (!Number.isFinite(this.tickRate) || this.tickRate <= 0) {
            throw new TypeError('tickRate must be a positive finite number.');
        }
        const mappings = Array.isArray(semanticMappings)
            ? semanticMappings
            : semanticMappings?.mappings;
        if (!Array.isArray(mappings)) {
            throw new TypeError('semanticMappings must be an array or object with mappings.');
        }
        if (!isRecord(targetMappings)) throw new TypeError('targetMappings must be an object.');
        if (!isRecord(capabilities)) throw new TypeError('capabilities must be an object.');
        this.semanticMappings = clone(mappings);
        this.targetMappings = clone(targetMappings);
        this.capabilities = clone(capabilities);
        this.diagnostics = [];
    }

    compileActions(nodes, options = {}) {
        if (!Array.isArray(nodes)) throw new TypeError('compileActions requires an array.');
        const result = this.#compileSequence(nodes, {
            path: options.path ?? '$',
            blackboard: options.blackboard ?? {},
            scope: options.scope ?? 'standalone',
            skillId: options.skillId ?? null,
            eventTargetMode: options.eventTargetMode === true,
            timelineStartFrame: options.timelineStartFrame ?? null,
            timelineEndFrame: options.timelineEndFrame ?? null
        });
        result.summary = {
            sourceActions: nodes.length,
            runtimeActions: result.actions.length,
            cleanupActions: result.cleanupActions.length,
            metadata: result.metadata.length,
            unresolved: result.unresolved.length
        };
        this.diagnostics.push(...result.diagnostics.map(clone));
        return finalize(result);
    }

    compileAction(node, options = {}) {
        if (!isRecord(node)) throw new TypeError('compileAction requires an object.');
        const result = this.#compileAction(node, {
            path: options.path ?? '$',
            blackboard: options.blackboard ?? {},
            scope: options.scope ?? 'standalone',
            skillId: options.skillId ?? null,
            eventTargetMode: options.eventTargetMode === true,
            timelineStartFrame: options.timelineStartFrame ?? null,
            timelineEndFrame: options.timelineEndFrame ?? null
        });
        this.diagnostics.push(...result.diagnostics.map(clone));
        return finalize(result);
    }

    compileCondition(node, options = {}) {
        if (!isRecord(node)) throw new TypeError('compileCondition requires an object.');
        const result = this.#compileCondition(node, {
            path: options.path ?? '$',
            blackboard: options.blackboard ?? {}
        });
        this.diagnostics.push(...result.diagnostics.map(clone));
        return result;
    }

    compileBuff(raw, options = {}) {
        if (!isRecord(raw)) throw new TypeError('compileBuff requires raw BuffData.');
        const parsed = parseBuff(raw, { tickRate: options.tickRate ?? this.tickRate });
        const { values: blackboard } = parseBlackboard(raw.blackboard);
        const triggerTimingMapping = this.#findMapping(
            'StatusTriggerTimingRule',
            mapping => mapping.selector?.buffId === raw.id
                || mapping.selector?.buffIds?.includes(raw.id)
        );
        const compileGroups = (groups, eventField, collectionPath) =>
            (groups ?? []).map((group, groupIndex) => {
                // Each serialized wrapper is an independent condition/action
                // branch. Flattening wrappers turns `if A -> X; if B -> Y`
                // into `if A -> X; if B -> Y` under one outer gate, which made
                // only the first decorate-mask branch reachable.
                const actionSets = (group.actions ?? []).map((wrapper, actionSetIndex) =>
                    this.compileActions(actionData(wrapper), {
                        path: `${collectionPath}[${groupIndex}].actions[${actionSetIndex}]`,
                        blackboard,
                        scope: 'buff',
                        // Ability/ignite callbacks expose the entity involved
                        // in the incoming event as Target. Ordinary Buff
                        // lifecycle callbacks keep Target on the Buff carrier.
                        eventTargetMode: collectionPath !== 'buffEventAction'
                    })
                );
                return {
                    eventType: group[eventField],
                    finishAfterIgnited: Boolean(group.finishAfterIgnited),
                    actions: actionSets.flatMap(compiled => compiled.actions),
                    cleanupActions: actionSets.flatMap(compiled => compiled.cleanupActions),
                    metadata: actionSets.flatMap(compiled => compiled.metadata),
                    unresolved: actionSets.flatMap(compiled => compiled.unresolved),
                    diagnostics: actionSets.flatMap(compiled => compiled.diagnostics)
                };
            });
        const eventActions = compileGroups(raw.buffEventAction, 'buffEvent', 'buffEventAction');
        const abilityEventActions = compileGroups(
            raw.abilityEventAction,
            'abilityEvent',
            'abilityEventAction'
        );
        const igniteEventActions = compileGroups(
            raw.igniteEventAction,
            'igniteType',
            'igniteEventAction'
        );
        const timeline = (raw.timelineActions ?? []).map((group, groupIndex) => {
                const compiled = this.compileActions(actionData(group._sequenceActionData), {
                    path: `timelineActions[${groupIndex}]`,
                    blackboard,
                    scope: 'buff',
                    timelineStartFrame: Number(group._startFrame ?? 0),
                    timelineEndFrame: Number(group._endFrame ?? group._startFrame ?? 0)
                });
            return {
                groupIndex,
                startFrame: Number(group._startFrame ?? 0),
                endFrame: Number(group._endFrame ?? group._startFrame ?? 0),
                ...compiled
            };
        });
        const actionsFor = (groups, eventType) => groups
            .filter(group => group.eventType === eventType)
            .flatMap(group => group.actions);
        const cleanup = eventActions
            .filter(group => ['DuringBuffEnable', 'OnBuffEnable'].includes(group.eventType))
            .flatMap(group => group.cleanupActions);
        const stackingScalesModifiers = [
            'EnhanceAndRefresh', 'EnhanceAndOverwriteDuration', 'Enhance',
            'Stack', 'HighPriorityWithMaxStack'
        ].includes(parsed.stacking.stackingType);
        const persistentModifiers = parsed.attributeModifiers.map(modifier => ({
            attribute: modifier.attributeType,
            zone: modifier.formulaItem,
            value: stackingScalesModifiers
                ? {
                    type: 'Multiply',
                    values: [
                        clone(modifier.param),
                        { type: 'Payload', key: 'stackCount', default: 1 }
                    ]
                }
                : clone(modifier.param),
            metadata: {
                modifyAttributeType: modifier.modifyAttributeType,
                rawFormulaItem: modifier.formulaItem,
                // Calc/AKE serializes Weakness as a signed rate in a factor
                // slot.  This evidence-scoped conversion must not be applied
                // to arbitrary FinalMultiplier attributes.
                ...(modifier.attributeType === 'WeaknessDmgScalar'
                    && modifier.formulaItem === 'FinalMultiplier'
                    ? {
                        operandSemantics: 'rate-to-factor',
                        evidenceKey: 'ake:WeaknessDmgScalar:FinalMultiplier'
                    }
                    : { operandSemantics: 'direct-factor' })
            }
        }));
        const persistentTags = tagIds(raw.applyTags).map(tagId => `ake-tag:${tagId}`);
        const extendTagIds = tagIds(raw.tagsAfterTriggerExtendBuffAction);
        const persistentExtendTags = extendTagIds.map(tagId => `ake-tag:${tagId}`);
        const damageModifierConditionResults = (raw.damageModifier ?? []).map(
            (modifier, modifierIndex) => (modifier.condition?.actionData ?? []).map(
                (condition, conditionIndex) => this.#compileCondition(condition, {
                    path: `damageModifier[${modifierIndex}].condition.actionData[${conditionIndex}]`,
                    blackboard,
                    scope: 'buff'
                })
            )
        );
        const persistentDamageModifiers = parsed.damageModifiers.map((modifier, modifierIndex) => {
            const conditionResults = damageModifierConditionResults[modifierIndex] ?? [];
            const conditionUnresolved = conditionResults.flatMap(result => result.unresolved);
            return {
                ...clone(modifier),
                conditions: conditionResults.map(result => result.condition).filter(Boolean),
                conditionsExecutable: conditionUnresolved.length === 0
                    && conditionResults.every(result => result.condition !== null)
            };
        });
        const effectSourceActions = persistentModifiers.length > 0
            || persistentDamageModifiers.length > 0
            || persistentTags.length > 0
            ? [{
                type: 'ApplyEffectSource',
                target: 'Target',
                sourceType: 'StatusEffect',
                modifiers: persistentModifiers,
                damageModifiers: persistentDamageModifiers,
                tags: persistentTags,
                reason: 'DuringBuffEnable'
            }]
            : [];
        const effectSourceCleanup = effectSourceActions.length > 0
            ? [{
                type: 'RemoveEffectSource',
                target: 'Target',
                sourceType: 'StatusEffect',
                reason: 'OnBuffFinish:source-cleanup'
            }]
            : [];
        const unresolved = [
            ...eventActions,
            ...abilityEventActions,
            ...igniteEventActions,
            ...timeline
        ].flatMap(group => group.unresolved).concat(
            damageModifierConditionResults.flat(1).flatMap(result => result.unresolved)
        );
        const definition = {
            ...parsed,
            blackboard,
            duration: clone(raw.duration),
            triggerInterval: clone(raw.triggerInterval),
            maxTriggerCnt: clone(raw.maxTriggerCnt),
            waitFirstTriggerInterval: raw.waitFirstTriggerInterval !== false,
            firstTriggerDelayTicks: triggerTimingMapping?.effect?.firstTriggerDelayTicks
                ?? null,
            tagIds: tagIds(raw.applyTags),
            extendTagIds,
            eventActions,
            abilityEventActions,
            igniteEventActions,
            timeline,
            startActions: actionsFor(eventActions, 'OnBuffStart'),
            triggerActions: actionsFor(eventActions, 'OnBuffTrigger'),
            enableActions: actionsFor(eventActions, 'OnBuffEnable'),
            duringEnableActions: [
                ...actionsFor(eventActions, 'DuringBuffEnable'),
                ...effectSourceActions
            ],
            persistentModifiers,
            persistentDamageModifiers,
            persistentTags,
            persistentExtendTags,
            endActions: [
                ...actionsFor(eventActions, 'OnBuffFinish'),
                ...cleanup,
                ...timeline.flatMap(group => group.cleanupActions),
                ...effectSourceCleanup
            ],
            compiler: {
                status: unresolved.length === 0 ? 'executable' : 'unresolved',
                unresolved,
                diagnostics: [...eventActions, ...abilityEventActions, ...igniteEventActions]
                    .flatMap(group => group.diagnostics)
            }
        };
        return definition;
    }

    compileSkill(raw, patchBundle = null, options = {}) {
        if (!isRecord(raw)) throw new TypeError('compileSkill requires raw SkillData.');
        const parsed = parseSkill(raw, patchBundle, options);
        const timeline = (raw.actionGroupData?.timelineActions ?? []).map((group, groupIndex) => {
            const nodes = actionData(group._sequenceActionData);
            const compiled = this.compileActions(nodes, {
                path: `actionGroupData.timelineActions[${groupIndex}]`,
                blackboard: parsed.blackboard,
                scope: 'skill',
                skillId: parsed.skillId,
                timelineStartFrame: Number(group._startFrame ?? 0),
                timelineEndFrame: Number(group._endFrame ?? group._startFrame ?? 0)
            });
            return {
                groupIndex,
                startFrame: Number(group._startFrame ?? 0),
                endFrame: Number(group._endFrame ?? group._startFrame ?? 0),
                ...compiled
            };
        });
        return {
            ...parsed,
            timeline,
            compiler: {
                status: timeline.some(group => group.unresolved.length > 0)
                    ? 'unresolved'
                    : 'executable',
                runtimeActionCount: timeline.reduce((sum, group) => sum + group.actions.length, 0),
                metadataCount: timeline.reduce((sum, group) => sum + group.metadata.length, 0),
                unresolved: timeline.flatMap(group => group.unresolved)
            }
        };
    }

    compilePassiveEventActions(raw, options = {}) {
        if (!isRecord(raw)) {
            throw new TypeError('compilePassiveEventActions requires raw SkillData.');
        }
        const { values: defaults } = parseBlackboard(raw.blackboard);
        const blackboard = { ...defaults, ...clone(options.blackboard ?? {}) };
        const groups = (raw.actionGroupData?.passiveEventActions ?? []).map(
            (group, groupIndex) => {
                const actionSets = (group.actions ?? []).map((wrapper, actionSetIndex) =>
                    this.compileActions(actionData(wrapper), {
                        path: `actionGroupData.passiveEventActions[${groupIndex}].actions[${actionSetIndex}]`,
                        blackboard,
                        scope: 'passive-skill',
                        skillId: raw.skillId,
                        eventTargetMode: true
                    })
                );
                return {
                    eventType: group.abilityEvent,
                    actions: actionSets.flatMap(compiled => compiled.actions),
                    cleanupActions: actionSets.flatMap(compiled => compiled.cleanupActions),
                    metadata: actionSets.flatMap(compiled => compiled.metadata),
                    unresolved: actionSets.flatMap(compiled => compiled.unresolved),
                    diagnostics: actionSets.flatMap(compiled => compiled.diagnostics)
                };
            }
        );
        return {
            skillId: raw.skillId,
            blackboard,
            groups,
            compiler: {
                status: groups.some(group => group.unresolved.length > 0)
                    ? 'unresolved'
                    : 'executable',
                unresolved: groups.flatMap(group => group.unresolved)
            }
        };
    }

    #compileSequence(nodes, state) {
        const result = emptyCompilation('Sequence');
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            const type = shortType(node);
            if (type === 'GetTargetBuffBBAdvanced' && node.alwaysNext !== true) {
                const read = this.#compileAction(node, {
                    ...state,
                    path: `${state.path}[${index}]`
                });
                const lookup = read.actions.find(action =>
                    action.type === 'ReadBuffBlackboard'
                );
                result.metadata.push(...read.metadata);
                result.unresolved.push(...read.unresolved);
                result.diagnostics.push(...read.diagnostics);
                if (!lookup) return finalize(result);
                const tail = this.#compileSequence(nodes.slice(index + 1), {
                    ...state,
                    path: `${state.path}[${index + 1}..]`
                });
                result.actions.push({
                    type: 'IfElseAction',
                    conditions: [{
                        ...lookup,
                        type: 'ReadBuffBlackboardCondition'
                    }],
                    success: tail.actions,
                    failure: [],
                    reason: `AKE Buff Blackboard gate at ${state.path}[${index}]`
                });
                result.cleanupActions.push(...tail.cleanupActions);
                result.metadata.push(...tail.metadata);
                result.unresolved.push(...tail.unresolved);
                result.diagnostics.push(...tail.diagnostics);
                return finalize(result);
            }
            if (isAkeConditionType(type)) {
                const conditions = [];
                while (index < nodes.length && isAkeConditionType(shortType(nodes[index]))) {
                    const compiledCondition = this.#compileCondition(nodes[index], {
                        ...state,
                        path: `${state.path}[${index}]`
                    });
                    conditions.push(compiledCondition.condition);
                    result.unresolved.push(...compiledCondition.unresolved);
                    result.diagnostics.push(...compiledCondition.diagnostics);
                    index += 1;
                }
                const tail = this.#compileSequence(nodes.slice(index), {
                    ...state,
                    path: `${state.path}[${index}..]`
                });
                result.actions.push({
                    type: 'IfElseAction',
                    conditions,
                    success: tail.actions,
                    failure: [],
                    reason: `AKE condition gate at ${state.path}`
                });
                result.cleanupActions.push(...tail.cleanupActions);
                result.metadata.push(...tail.metadata);
                result.unresolved.push(...tail.unresolved);
                result.diagnostics.push(...tail.diagnostics);
                return finalize(result);
            }
            mergeCompilation(result, this.#compileAction(node, {
                ...state,
                path: `${state.path}[${index}]`
            }));
        }
        return finalize(result);
    }

    #targetRef(value, state, label = 'target') {
        const source = selectorSource(value);
        const groupKey = selectorGroupKey(value);
        if (source === 'Context' && groupKey) {
            return {
                ref: { type: 'TargetGroup', key: groupKey, index: 0, fallback: 'Target' },
                unresolved: null
            };
        }
        if (source === null || source === undefined || source === '') {
            return { ref: 'Target', unresolved: null };
        }
        if (source === 'Target' && state.eventTargetMode === true) {
            return {
                ref: { type: 'EventTarget', fallback: 'Target' },
                unresolved: null
            };
        }
        if (TARGET_ALIASES.has(source)) {
            return { ref: TARGET_ALIASES.get(source), unresolved: null };
        }
        if (Object.prototype.hasOwnProperty.call(this.targetMappings, source)) {
            return { ref: this.targetMappings[source], unresolved: null };
        }
        return {
            ref: null,
            unresolved: this.#unresolved(
                'AKE_TARGET_PROVIDER_REQUIRED',
                shortType(value) || 'Selector',
                state.path,
                `${label} selector ${source} requires an external target provider.`,
                { selectorSource: source }
            )
        };
    }

    #compileParameterizedStatusAction(node, state, {
        sourceType,
        buffId,
        effectKind,
        category,
        metadata = {},
        rateTransform = value => value,
        diagnosticPrefix,
        displayName
    }) {
        const result = emptyCompilation(sourceType);
        const source = this.#targetRef(
            node.source ?? 'Source',
            state,
            `${displayName} source`
        );
        const target = this.#targetRef(
            node.target ?? 'Target',
            state,
            `${displayName} target`
        );
        if (source.unresolved) result.unresolved.push(source.unresolved);
        if (target.unresolved) result.unresolved.push(target.unresolved);
        if (!source.ref || !target.ref) return finalize(result);

        const resolvedChildBuffId = node.overrideChildBuffId === true
            ? resolveValue(node.childBuffId, state.blackboard, null)
            : null;
        if (node.overrideChildBuffId === true
            && (typeof resolvedChildBuffId !== 'string'
                || resolvedChildBuffId.length === 0)) {
            result.unresolved.push(this.#unresolved(
                `${diagnosticPrefix}_CHILD_BUFF_REQUIRED`,
                sourceType,
                state.path,
                `${displayName} overrides its child Buff but no static dependency can be resolved.`
            ));
        }
        const dependencyBuffIds = typeof resolvedChildBuffId === 'string'
            && resolvedChildBuffId.length > 0
            ? [resolvedChildBuffId]
            : [];
        const makeApplyAction = rate => ({
            type: 'ApplyBuff',
            sourceRef: source.ref,
            target: target.ref,
            count: 1,
            buffs: [{
                buffId,
                buffIdBlackboardKey: null,
                assignBlackboard: true,
                assignments: [{
                    targetKey: 'rate',
                    value: rateTransform(clone(rate))
                }, {
                    targetKey: 'duration',
                    value: descriptor(node.duration, -1)
                }, ...(node.overrideChildBuffId === true ? [{
                    targetKey: 'child_buff_id',
                    value: descriptor(node.childBuffId, '')
                }] : [])]
            }],
            dependencyBuffIds,
            inheritEventBlackboard: false,
            triggerEnhancementEvent: true,
            asChildBuff: node.asChildBuff !== false,
            metadata: {
                akeEffectKind: effectKind,
                akeSourceAction: sourceType,
                akeSourcePath: state.path,
                displayBuffId: resolvedChildBuffId || buffId,
                ...clone(metadata)
            },
            reason: sourceType
        });

        const enhancements = [];
        for (const [index, enhancement] of (node.enhancingList ?? []).entries()) {
            const operation = STATUS_ENHANCEMENT_OPERATIONS[
                enhancement.operationType
            ];
            const buffIds = (enhancement.buffIds ?? []).filter(candidate =>
                typeof candidate === 'string' && candidate.length > 0
            );
            if (!operation || buffIds.length === 0) {
                result.unresolved.push(this.#unresolved(
                    `${diagnosticPrefix}_ENHANCEMENT_UNSUPPORTED`,
                    sourceType,
                    `${state.path}.enhancingList[${index}]`,
                    `${displayName} enhancement requires a supported arithmetic operation and at least one Buff id.`,
                    {
                        operationType: enhancement.operationType ?? null,
                        buffIds
                    }
                ));
                continue;
            }
            enhancements.push({
                operation,
                buffIds,
                value: descriptor(enhancement.value, 0)
            });
        }

        const buildBranch = (index, rate) => {
            if (index >= enhancements.length) return [makeApplyAction(rate)];
            const enhancement = enhancements[index];
            return [{
                type: 'IfElseAction',
                conditions: [{
                    type: 'Any',
                    conditions: enhancement.buffIds.map(candidate => ({
                        type: 'HasBuff',
                        target: source.ref,
                        buffId: candidate
                    }))
                }],
                success: buildBranch(index + 1, {
                    type: enhancement.operation,
                    values: [clone(rate), clone(enhancement.value)]
                }),
                failure: buildBranch(index + 1, rate),
                reason: `${sourceType}:enhancement:${index}`
            }];
        };
        result.actions.push(...buildBranch(0, descriptor(node.rate, 0)));
        if (node.autoFinishByAction === true) {
            result.cleanupActions.push({
                type: 'FinishBuff',
                sourceRef: source.ref,
                target: target.ref,
                buffId,
                childOfCurrentBuff: node.asChildBuff !== false,
                finishAll: true,
                reason: `${sourceType}:auto-finish`
            });
        }
        result.metadata.push({
            type: sourceType,
            path: state.path,
            category,
            buffId,
            childBuffId: resolvedChildBuffId,
            enhancementCount: enhancements.length,
            ...clone(metadata)
        });
        return finalize(result);
    }

    #compileAction(node, state) {
        const type = shortType(node);
        const result = emptyCompilation(type || 'Unknown');
        if (!type) {
            result.unresolved.push(this.#unresolved(
                'AKE_ACTION_TYPE_MISSING',
                'Unknown',
                state.path,
                'Serialized action has no recognizable type.'
            ));
            return finalize(result);
        }
        if (node.isEnable === false) {
            result.metadata.push({ type, path: state.path, disabled: true });
            return finalize(result);
        }
        const classification = classifyAkeActionType(type);
        if (classification.category === 'presentation') {
            result.metadata.push({ type, path: state.path, category: 'presentation' });
            return finalize(result);
        }
        if (TIMELINE_METADATA_TYPES.has(type)
            && !TIMELINE_RESOLVER_TYPES.has(type)
            && type !== 'LaunchProjectile'
            && type !== 'TickIntervalAction') {
            result.metadata.push(this.#timelineMetadata(type, node, state));
            return finalize(result);
        }
        if (COMBAT_STATUS_METADATA.has(type)) {
            const marker = COMBAT_STATUS_METADATA.get(type);
            const target = this.#targetRef(
                node.targetSettings ?? node.target,
                state,
                `${marker.displayName} target`
            );
            if (target.unresolved) result.unresolved.push(target.unresolved);
            result.metadata.push({
                type,
                path: state.path,
                category: 'combat-status',
                statusKey: marker.statusKey,
                displayName: marker.displayName,
                buffId: marker.buffId,
                deadOption: node.deadOption ?? 'AllValid',
                target: clone(node.target ?? node.targetSettings ?? 'Target'),
                raw: clone(node)
            });
            const applyStatus = target.ref ? {
                type: 'ApplyCombatStatus',
                target: target.ref,
                statusKey: marker.statusKey,
                triggerBuffId: marker.buffId,
                statusBuffId: marker.statusBuffId,
                initialBuffId: 'buff_physical_no_guard',
                blackboard: marker.statusKey === 'crush'
                    ? {
                        blow_off_distance: resolveValue(
                            node.blowOffDistance,
                            state.blackboard,
                            0
                        ),
                        distance_random_range: resolveValue(
                            node.distanceRandomRange,
                            state.blackboard,
                            0
                        )
                    }
                    : {},
                metadata: {
                    akeCombatStatus: marker.statusKey,
                    akeSourceAction: type,
                    akeSourcePath: state.path
                },
                reason: type
            } : null;
            if (applyStatus && node.deadOption === 'OnlyDead') {
                result.actions.push({
                    type: 'IfElseAction',
                    conditions: [{
                        type: 'EntityAlive',
                        target: target.ref,
                        expected: false
                    }],
                    success: [applyStatus],
                    failure: [],
                    reason: `${type}:OnlyDead`
                });
            } else if (applyStatus) {
                result.actions.push(applyStatus);
            }
            return finalize(result);
        }
        if (SPATIAL_TYPES.has(type)) {
            result.metadata.push({ type, path: state.path, category: 'spatial', raw: clone(node) });
            result.unresolved.push(this.#unresolved(
                'AKE_SPATIAL_PROVIDER_REQUIRED',
                type,
                state.path,
                'Spatial selection or movement is retained as metadata and needs a target/spatial provider.'
            ));
            return finalize(result);
        }

        switch (type) {
            case 'FindTargetAction':
            case 'ContinuousFindTargetAction': {
                const groupKey = node.targetGroupKey ?? node.contextKey;
                const rawFinderType = finderType(node);
                if (typeof groupKey !== 'string' || groupKey.length === 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TARGET_GROUP_KEY_MISSING',
                        type,
                        state.path,
                        `${type} has no targetGroupKey.`
                    ));
                    break;
                }
                const owner = this.#targetRef(
                    node.selectorOwner ?? node.target ?? node.center,
                    state,
                    'target-finder owner'
                );
                if (owner.unresolved) result.unresolved.push(owner.unresolved);
                const ownerSpawned = rawFinderType === 'OwnerSpawnedEntityFinder';
                const hostileFinder = [
                    'HitBoxFinder',
                    'SmartTargetFinder',
                    'MainTargetFinder'
                ].includes(rawFinderType);
                const pointFinder = [
                    'RandomPointFinder',
                    'FixedPointFinder'
                ].includes(rawFinderType);
                const characterTeamFinder = rawFinderType === 'CharacterTeamFinder';
                let finderMode = null;
                if (ownerSpawned) finderMode = 'OwnerSpawnedEntities';
                else if (hostileFinder) finderMode = 'HostileEntities';
                else if (characterTeamFinder) finderMode = 'AlliedCharacters';
                else if (pointFinder) finderMode = 'ReferencePoint';
                if (!finderMode) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TARGET_FINDER_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        `Target finder ${rawFinderType ?? 'Unknown'} needs an external provider.`,
                        { finderType: rawFinderType, targetGroupKey: groupKey }
                    ));
                    break;
                }
                const validators = node.selectorData?.validatorData ?? [];
                result.actions.push({
                    type: 'FindTargets',
                    targetGroupKey: groupKey,
                    finderMode,
                    ownerRef: owner.ref ?? 'Source',
                    excludeOwner: validators.some(validator =>
                        nestedDataType(validator) === 'ExcludeOwnerValidator'
                    ),
                    tagIds: validators.flatMap(validator =>
                        nestedDataType(validator) === 'TagValidator'
                            ? tagIds(validator.query?.tags)
                            : []
                    ),
                    continuous: type === 'ContinuousFindTargetAction',
                    rawFinderType,
                    reason: type
                });
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'target-group',
                    targetGroupKey: groupKey,
                    finderMode,
                    rawFinderType
                });
                break;
            }
            case 'PickTargetAction': {
                const source = this.#targetRef(node.target, state, 'picked target group');
                if (source.unresolved) result.unresolved.push(source.unresolved);
                const sourceGroupKey = selectorGroupKey(node.target);
                const destinationGroupKey = node.contextKey ?? node.targetGroupKey;
                if (!sourceGroupKey || !destinationGroupKey) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TARGET_GROUP_KEY_MISSING',
                        type,
                        state.path,
                        'PickTargetAction requires source and destination target-group keys.'
                    ));
                    break;
                }
                result.actions.push({
                    type: 'PickTarget',
                    sourceGroupKey,
                    targetGroupKey: destinationGroupKey,
                    index: descriptor(node.index, 0),
                    reason: type
                });
                break;
            }
            case 'LaunchProjectile': {
                const metadata = this.#timelineMetadata(type, node, state);
                result.metadata.push(metadata);
                const flightMapping = this.#findMapping(
                    'ProjectileFlightRule',
                    mapping => mapping.selector?.projectileId === metadata.projectileId
                        || mapping.selector?.projectileIds?.includes(metadata.projectileId)
                );
                for (const trigger of metadata.skillTriggers ?? []) {
                    if (!trigger.enabled) continue;
                    const childSkillId = trigger.childSkillId;
                    if (!childSkillId) {
                        result.unresolved.push(this.#unresolved(
                            'AKE_PROJECTILE_TERMINAL_SKILL_MISSING',
                            type,
                            state.path,
                            `Projectile ${trigger.terminalEvent} trigger is enabled but has no child SkillData id.`,
                            { terminalEvent: trigger.terminalEvent }
                        ));
                        continue;
                    }
                    if (childSkillId === state.skillId) {
                        result.diagnostics.push({
                            code: 'AKE_SELF_REFERENTIAL_PROJECTILE_RETAINED',
                            sourceType: type,
                            path: state.path,
                            childSkillId,
                            terminalEvent: trigger.terminalEvent
                        });
                        continue;
                    }
                    const delayKey = `${String(trigger.terminalEvent).toLowerCase()}DelayTicks`;
                    result.actions.push({
                        type: 'LaunchSkillProgram',
                        projectileId: metadata.projectileId ?? null,
                        projectileTerminalEvent: trigger.terminalEvent,
                        childSkillId,
                        launchDelayTicks: flightMapping?.effect?.[delayKey]
                            ?? flightMapping?.effect?.delayTicks
                            ?? 0,
                        assignments: clone(metadata.assignments ?? []),
                        inheritBlackboard: true,
                        reason: `LaunchProjectile:${trigger.terminalEvent}`
                    });
                    if (!this.capabilities.skillProgramResolver) {
                        result.unresolved.push(this.#unresolved(
                            'AKE_SKILL_PROGRAM_RESOLVER_REQUIRED',
                            type,
                            state.path,
                            `Projectile child SkillData ${childSkillId} requires a skillProgramResolver.`,
                            { childSkillId, terminalEvent: trigger.terminalEvent }
                        ));
                    }
                }
                break;
            }
            case 'SpawnAbilityEntity': {
                const childSkillId = node.childSkillId ?? node.abilityEntitySkillId;
                const tagMapping = this.#findMapping(
                    'AbilityEntityTagRule',
                    mapping => mapping.selector?.abilityEntityId === node.abilityEntityId
                );
                const akeTagIds = tagIds(tagMapping?.effect?.tagIds);
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'timeline',
                    abilityEntityId: node.abilityEntityId ?? null,
                    childSkillId: childSkillId ?? null,
                    akeTagIds
                });
                if (!childSkillId) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_ABILITY_ENTITY_SKILL_MISSING',
                        type,
                        state.path,
                        'SpawnAbilityEntity has no abilityEntitySkillId.'
                    ));
                    break;
                }
                result.actions.push({
                    type: 'LaunchSkillProgram',
                    abilityEntityId: node.abilityEntityId ?? null,
                    akeTagIds,
                    childSkillId,
                    assignments: normalizeAssignments({
                        assignItems: node.assignPairs ?? node.assignments ?? []
                    }),
                    inheritBlackboard: true,
                    reason: type
                });
                if (!this.capabilities.skillProgramResolver) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SKILL_PROGRAM_RESOLVER_REQUIRED',
                        type,
                        state.path,
                        `Ability-entity SkillData ${childSkillId} requires a skillProgramResolver.`,
                        { childSkillId }
                    ));
                }
                break;
            }
            case 'HitStopAction':
            case 'TimeDilationAction':
                result.actions.push({
                    type: 'ResolveTimeDilation',
                    sourceType: type,
                    raw: clone(node),
                    reason: type
                });
                result.metadata.push(this.#timelineMetadata(type, node, state));
                if (!this.capabilities.timeDilationResolver) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TIME_DILATION_RESOLVER_REQUIRED',
                        type,
                        state.path,
                        'Curve-integrated excluded ticks require a timeDilationResolver.'
                    ));
                }
                break;
            case 'ChannelingAction':
            case 'ChannelingCastingAction': {
                const metadata = this.#timelineMetadata(type, node, state);
                result.metadata.push(metadata);
                const children = this.#compileSequence(actionData(
                    node.actionOnTick ?? node.actionsOnTick ?? node.tickActions
                ), {
                    ...state,
                    path: `${state.path}.actionOnTick`
                });
                result.metadata.push(...children.metadata);
                result.unresolved.push(...children.unresolved);
                result.diagnostics.push(...children.diagnostics);

                const maxCountPerTarget = Number(resolveValue(
                    node.maxCountPerTarget,
                    state.blackboard,
                    -1
                ));
                if (maxCountPerTarget === 1) {
                    // The public Chen and Wulfgard traces establish that a
                    // one-per-target channel fires immediately when its
                    // timeline group starts. The scenario runtime has one
                    // explicit target, so flattening this case is exact and
                    // does not invent an interval or spatial fan-out policy.
                    result.actions.push(...children.actions);
                    result.cleanupActions.push(...children.cleanupActions);
                    result.metadata.push({
                        type: 'ResolvedChannelingMode',
                        sourceType: type,
                        path: state.path,
                        mode: 'ImmediateOncePerExplicitTarget'
                    });
                } else {
                    const startFrame = Number(state.timelineStartFrame ?? 0);
                    const endFrame = Number(state.timelineEndFrame ?? startFrame);
                    const durationTicks = Math.max(0, Math.round(endFrame - startFrame));
                    const intervalSeconds = Number(resolveValue(
                        node.triggerInterval,
                        state.blackboard,
                        Number.NaN
                    ));
                    const hasExecutableInterval = Boolean(node.executeEachFrame)
                        || (Number.isFinite(intervalSeconds) && intervalSeconds > 0);
                    if (hasExecutableInterval && children.actions.length > 0) {
                        result.actions.push({
                            type: 'ScheduleIntervalActions',
                            intervalTicks: node.executeEachFrame ? 1 : null,
                            intervalSeconds: node.executeEachFrame ? null : intervalSeconds,
                            durationTicks,
                            timelineStartFrame: startFrame,
                            timelineEndFrame: endFrame,
                            includeStart: true,
                            maxExecutions: maxCountPerTarget > 0 ? maxCountPerTarget : null,
                            targetIntervalSeconds: Number(resolveValue(
                                node.targetTriggerInterval,
                                state.blackboard,
                                -1
                            )),
                            actions: children.actions,
                            reason: type
                        });
                        result.cleanupActions.push(...children.cleanupActions);
                        result.metadata.push({
                            type: 'ResolvedChannelingMode',
                            sourceType: type,
                            path: state.path,
                            mode: 'IntervalPerExplicitTarget',
                            durationTicks,
                            intervalSeconds: node.executeEachFrame ? null : intervalSeconds,
                            maxExecutions: maxCountPerTarget > 0 ? maxCountPerTarget : null
                        });
                        break;
                    }
                    result.unresolved.push(this.#unresolved(
                        'AKE_CHANNEL_SCHEDULER_REQUIRED',
                        type,
                        state.path,
                        'Multi-trigger channel timing requires an interval and target scheduler.',
                        {
                            maxCountPerTarget,
                            triggerInterval: clone(node.triggerInterval),
                            executeEachFrame: Boolean(node.executeEachFrame)
                        }
                    ));
                }
                break;
            }
            case 'TickIntervalAction': {
                const metadata = this.#timelineMetadata(type, node, state);
                result.metadata.push(metadata);
                const children = this.#compileSequence(actionData(node.actionOnTick), {
                    ...state,
                    path: `${state.path}.actionOnTick`
                });
                result.metadata.push(...children.metadata);
                result.unresolved.push(...children.unresolved);
                result.diagnostics.push(...children.diagnostics);
                result.cleanupActions.push(...children.cleanupActions);
                const startFrame = Number(state.timelineStartFrame ?? 0);
                const endFrame = Number(state.timelineEndFrame ?? startFrame);
                const durationTicks = Math.max(0, Math.round(endFrame - startFrame));
                if (children.actions.length > 0) result.actions.push({
                    type: 'ScheduleIntervalActions',
                    intervalTicks: node.executeEachFrame ? 1 : null,
                    intervalSeconds: node.useTickIntervalBlackboardKey
                        && node.tickIntervalBlackboardKey
                        ? {
                            type: 'Blackboard',
                            key: node.tickIntervalBlackboardKey,
                            default: Number(node.tickInterval ?? 0)
                        }
                        : Number(node.tickInterval ?? 0),
                    durationTicks,
                    timelineStartFrame: startFrame,
                    timelineEndFrame: endFrame,
                    includeStart: true,
                    actions: children.actions,
                    reason: type
                });
                break;
            }
            case 'JumpToAction':
                result.actions.push({
                    type: 'SeekSkillTimeline',
                    destFrame: Number(node.destFrame ?? 0),
                    sourcePath: state.path,
                    reason: type
                });
                break;
            case 'MarkCanInterrupt':
                result.actions.push({
                    type: 'MarkSkillInterruptible',
                    sourcePath: state.path,
                    reason: type
                });
                result.metadata.push(this.#timelineMetadata(type, node, state));
                break;
            case 'IfElseAction': {
                const conditions = node.conditions ?? actionData(node.conditionAction);
                const compiledConditions = conditions.map((condition, index) => this.#compileCondition(
                    condition,
                    { ...state, path: `${state.path}.condition[${index}]` }
                ));
                const success = this.#compileSequence(
                    node.success ?? actionData(node.succeedActions),
                    { ...state, path: `${state.path}.success` }
                );
                const failure = this.#compileSequence(
                    node.failure ?? actionData(node.failActions),
                    { ...state, path: `${state.path}.failure` }
                );
                result.actions.push({
                    type: 'IfElseAction',
                    conditions: compiledConditions.map(entry => entry.condition),
                    success: success.actions,
                    failure: failure.actions
                });
                result.cleanupActions.push(...success.cleanupActions, ...failure.cleanupActions);
                result.metadata.push(...success.metadata, ...failure.metadata);
                result.unresolved.push(
                    ...compiledConditions.flatMap(entry => entry.unresolved),
                    ...success.unresolved,
                    ...failure.unresolved
                );
                result.diagnostics.push(
                    ...compiledConditions.flatMap(entry => entry.diagnostics),
                    ...success.diagnostics,
                    ...failure.diagnostics
                );
                break;
            }
            case 'ForEachAction': {
                const target = this.#targetRef(node.target, state, 'foreach target');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const children = this.#compileSequence(actionData(node.action), {
                    ...state,
                    path: `${state.path}.action`
                });
                result.metadata.push(...children.metadata);
                result.unresolved.push(...children.unresolved);
                result.diagnostics.push(...children.diagnostics);
                if (target.ref === 'Target') {
                    // The clean-room scenario owns one explicit combat target;
                    // Context/targets therefore has exactly one member and the
                    // nested Blackboard writes can stay in this transaction.
                    result.actions.push(...children.actions);
                    result.cleanupActions.push(...children.cleanupActions);
                    result.metadata.push({
                        type: 'ResolvedForEachMode',
                        sourceType: type,
                        path: state.path,
                        mode: 'SingleExplicitTarget'
                    });
                } else if (isRecord(target.ref) && target.ref.type === 'TargetGroup') {
                    result.actions.push({
                        type: 'ForEachTarget',
                        targetGroupKey: target.ref.key,
                        actions: children.actions,
                        reason: type
                    });
                    result.cleanupActions.push(...children.cleanupActions);
                } else if (target.ref) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_MULTI_TARGET_ITERATOR_REQUIRED',
                        type,
                        state.path,
                        `ForEach selector ${target.ref} needs a target-iteration provider.`
                    ));
                }
                break;
            }
            case 'ModifyDynamicBlackboard': {
                if (node.directValue === false) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DYNAMIC_CALCULATION_REQUIRED',
                        type,
                        state.path,
                        `Dynamic calculation ${node.calculateType ?? 'Unknown'} needs a calculation provider.`
                    ));
                    break;
                }
                const calculationTarget = this.#targetRef(
                    node.calculationTarget,
                    state,
                    'dynamic Blackboard target'
                );
                if (calculationTarget.unresolved) {
                    result.unresolved.push(calculationTarget.unresolved);
                }
                result.actions.push({
                    type: String(node.key ?? '').startsWith('EntityBB_')
                        ? 'ModifyEntityBlackboard'
                        : 'ModifyBlackboard',
                    ...(String(node.key ?? '').startsWith('EntityBB_')
                        ? { target: calculationTarget.ref ?? 'Owner' }
                        : {}),
                    key: node.key,
                    operation: node.operation,
                    value: descriptor(node.value)
                });
                break;
            }
            case 'SimpleCalcBBAction':
                result.actions.push({
                    type: 'CalculateBlackboard',
                    key: node.key,
                    operation: node.operation,
                    left: descriptor(node.value1),
                    right: descriptor(node.value2)
                });
                break;
            case 'StoreAttributeValue': {
                const target = this.#targetRef(node.targetSettings ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!node.key) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BLACKBOARD_KEY_MISSING',
                        type,
                        state.path,
                        'StoreAttributeValue has an empty destination key.'
                    ));
                    break;
                }
                if (target.ref) result.actions.push({
                    type: 'StoreAttributeValue',
                    target: target.ref,
                    attribute: node.attributeType,
                    divisor: descriptor(node.divisor ?? node.divisorValue, 1),
                    multiplier: descriptor(node.multiplier ?? node.multiplierValue, 1),
                    baseValue: descriptor(node.baseValue, 0),
                    useFloor: Boolean(node.useFloor),
                    key: node.key
                });
                break;
            }
            case 'StoreBuffCount': {
                const target = this.#targetRef(node.buffOwners, state, 'Buff count target');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!node.blackboardKey) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BLACKBOARD_KEY_MISSING',
                        type,
                        state.path,
                        'StoreBuffCount has an empty destination key.'
                    ));
                    break;
                }
                if (target.ref) result.actions.push({
                    type: 'StoreBuffCount',
                    target: target.ref,
                    useCurrentBuff: Boolean(node.useCurrentBuff),
                    buffId: node.buffId || undefined,
                    key: node.blackboardKey
                });
                break;
            }
            case 'GetTargetBuffBBAdvanced': {
                const target = this.#targetRef(
                    node.targetSettings ?? node.target,
                    state,
                    'Buff Blackboard target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const settings = node.buffSettings ?? {};
                if (settings.checkType === 'Environment') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_ENVIRONMENT_BUFF_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        'Environment Buff Blackboard reads require an external provider.'
                    ));
                    break;
                }
                if (target.ref && node.desiredKey && node.blackboardKey) {
                    result.actions.push({
                        type: 'ReadBuffBlackboard',
                        target: target.ref,
                        buffIds: settings.checkType === 'Id'
                            ? (settings.buffIdList ?? []).filter(Boolean)
                            : [],
                        tagIds: settings.checkType === 'Tag'
                            ? tagIds(settings.tagQuery?.tags)
                            : [],
                        tagQueryType: settings.tagQuery?.queryType ?? 'HasAny',
                        desiredKey: node.desiredKey,
                        blackboardKey: node.blackboardKey,
                        defaultValue: node.defaultValue ?? 0,
                        reason: type
                    });
                }
                break;
            }
            case 'SaveAtbObtainValue': {
                const entries = [];
                if (typeof node.valueKey === 'string' && node.valueKey.length > 0) {
                    entries.push({
                        key: node.valueKey,
                        value: { type: 'Payload', key: 'requestedAmount', default: 0 }
                    });
                }
                if (typeof node.realDeltaKey === 'string' && node.realDeltaKey.length > 0) {
                    entries.push({
                        key: node.realDeltaKey,
                        value: { type: 'Payload', key: 'actualDelta', default: 0 }
                    });
                }
                if (entries.length === 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BLACKBOARD_KEY_MISSING',
                        type,
                        state.path,
                        'SaveAtbObtainValue has no destination Blackboard key.'
                    ));
                } else {
                    result.actions.push({ type: 'AssignBlackboardValues', entries });
                }
                break;
            }
            case 'SaveBuffStackNumAdvanced': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'advanced Buff-count target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!node.key) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BLACKBOARD_KEY_MISSING',
                        type,
                        state.path,
                        'SaveBuffStackNumAdvanced has an empty destination key.'
                    ));
                    break;
                }
                const settings = node.buffSettings ?? {};
                if (settings.checkType === 'Environment') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_ENVIRONMENT_BUFF_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        'Environment Buff counts require an external environment provider.'
                    ));
                    break;
                }
                if (target.ref) result.actions.push({
                    type: 'StoreBuffCount',
                    target: target.ref,
                    buffIds: settings.checkType === 'Id'
                        ? (settings.buffIdList ?? []).filter(Boolean)
                        : [],
                    tagIds: settings.checkType === 'Tag'
                        ? tagIds(settings.tagQuery?.tags)
                        : [],
                    tagQueryType: settings.tagQuery?.queryType ?? 'HasAny',
                    countType: node.buffStackNumType ?? 'BuffCount',
                    key: node.key
                });
                break;
            }
            case 'ReadSkillSettingData': {
                const reads = node.reads ?? node.dataList ?? [];
                const entries = [];
                const runtimeEntries = [];
                for (const [index, read] of reads.entries()) {
                    const dynamicColumn = Boolean(
                        read.column?.useBlackboardKey && read.column?.blackboardKey
                    );
                    const column = resolveValue(read.column, state.blackboard, 1);
                    const mapping = this.#findMapping('ReadSkillSettingData', candidate =>
                        candidate.selector?.lookupKey === read.dataKey
                        && Number(candidate.selector?.column ?? 1) === Number(column)
                        && candidate.effect?.operation === 'ReturnValue'
                    );
                    const tableMapping = this.#findMapping(
                        'ReadSkillSettingData',
                        candidate => candidate.selector?.lookupKey === read.dataKey
                            && candidate.effect?.operation === 'ReturnTable'
                    );
                    if (tableMapping) {
                        const values = clone(tableMapping.effect.values ?? {});
                        if (dynamicColumn || tableMapping.effect.enhancementMode) {
                            runtimeEntries.push({
                                key: read.storeKey,
                                lookupKey: read.dataKey,
                                column: descriptor(read.column, 1),
                                values,
                                clamp: tableMapping.effect.clamp !== false,
                                enhancementMode: tableMapping.effect.enhancementMode ?? null
                            });
                        } else if (Object.prototype.hasOwnProperty.call(
                            values,
                            String(Number(column))
                        )) {
                            entries.push({
                                key: read.storeKey,
                                value: values[String(Number(column))]
                            });
                        } else {
                            result.unresolved.push(this.#unresolved(
                                'AKE_SKILL_SETTING_COLUMN_MISSING',
                                type,
                                `${state.path}.dataList[${index}]`,
                                `Missing runtime SkillSetting table column for ${read.dataKey}, column ${column}.`,
                                { lookupKey: read.dataKey, column, storeKey: read.storeKey }
                            ));
                        }
                    } else if (mapping?.effect?.operation === 'ReturnValue') {
                        entries.push({ key: read.storeKey, value: mapping.effect.value });
                    } else {
                        result.unresolved.push(this.#unresolved(
                            'AKE_SKILL_SETTING_MISSING',
                            type,
                            `${state.path}.dataList[${index}]`,
                            `Missing runtime SkillSetting value for ${read.dataKey}, column ${column}.`,
                            { lookupKey: read.dataKey, column, storeKey: read.storeKey }
                        ));
                    }
                }
                if (entries.length > 0) result.actions.push({ type: 'AssignBlackboardValues', entries });
                if (runtimeEntries.length > 0) result.actions.push({
                    type: 'ReadSkillSettingValues',
                    entries: runtimeEntries,
                    reason: type
                });
                break;
            }
            case 'IgniteAction': {
                const listener = this.#targetRef(
                    node.targetSettings ?? node.target,
                    state,
                    'Ignite listener target'
                );
                const source = this.#targetRef(
                    node.igniteSource ?? 'Source',
                    state,
                    'Ignite source'
                );
                if (listener.unresolved) result.unresolved.push(listener.unresolved);
                if (source.unresolved) result.unresolved.push(source.unresolved);
                if (listener.ref && source.ref && node.igniteType) result.actions.push({
                    type: 'TriggerStatusEvent',
                    eventType: node.igniteType,
                    target: listener.ref,
                    sourceRef: source.ref,
                    reason: type
                });
                break;
            }
            case 'RefreshBuffAttrModifierValue':
                result.actions.push({
                    type: 'RefreshCurrentBuffEffectSource',
                    reason: type
                });
                break;
            case 'VulnerableAction': {
                const vulnerableBuffId = VULNERABILITY_BUFF_IDS[node.subType];
                if (!vulnerableBuffId) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_VULNERABILITY_SUBTYPE_UNSUPPORTED',
                        type,
                        state.path,
                        `VulnerableAction subtype ${String(node.subType)} has no common AKE Buff mapping.`,
                        { subType: node.subType ?? null }
                    ));
                    break;
                }
                return this.#compileParameterizedStatusAction(node, state, {
                    sourceType: type,
                    buffId: vulnerableBuffId,
                    effectKind: 'Vulnerability',
                    category: 'vulnerability',
                    metadata: {
                        akeVulnerabilityType: node.subType,
                        subType: node.subType
                    },
                    diagnosticPrefix: 'AKE_VULNERABILITY',
                    displayName: 'VulnerableAction'
                });
            }
            case 'WeakAction':
                return this.#compileParameterizedStatusAction(node, state, {
                    sourceType: type,
                    buffId: WEAKNESS_BUFF_ID,
                    effectKind: 'Weakness',
                    category: 'weakness',
                    metadata: { akeWeaknessType: 'OutgoingDamageReduction' },
                    // AKE WeakAction stores a positive reduction magnitude, while
                    // the common Buff's FinalMultiplier attribute expects a
                    // negative delta (0.2 -> -0.2 -> multiplier 0.8).
                    rateTransform: value => ({
                        type: 'Multiply',
                        values: [value, -1]
                    }),
                    diagnosticPrefix: 'AKE_WEAKNESS',
                    displayName: 'WeakAction'
                });
            case 'ShelterAction':
                return this.#compileParameterizedStatusAction(node, state, {
                    sourceType: type,
                    buffId: SHELTER_BUFF_ID,
                    effectKind: 'Shelter',
                    category: 'shelter',
                    metadata: { akeShelterType: 'IncomingDamageReduction' },
                    diagnosticPrefix: 'AKE_SHELTER',
                    displayName: 'ShelterAction'
                });
            case 'PauseBuffTime':
                if (typeof node.isPaused !== 'boolean') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BUFF_PAUSE_STATE_REQUIRED',
                        type,
                        state.path,
                        'PauseBuffTime requires an explicit boolean isPaused value.'
                    ));
                    break;
                }
                result.actions.push({
                    type: 'SetCurrentBuffTimePaused',
                    isPaused: node.isPaused,
                    reason: type,
                    metadata: {
                        akeSourceAction: type,
                        akeSourcePath: state.path
                    }
                });
                break;
            case 'OnPhysicalNoGuardStart':
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'status-lifecycle'
                });
                break;
            case 'InterruptAction': {
                const target = this.#targetRef(
                    node.defender ?? node.targetSettings ?? node.target,
                    state,
                    'interrupt target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (target.ref) result.actions.push({
                    type: 'ApplyControl',
                    target: target.ref,
                    controlType: 'Interrupt',
                    controlLevel: Math.max(0, Number(node.overrideSuperArmorLimit ?? 0)),
                    reason: type
                });
                break;
            }
            case 'SwitchAction': {
                const options = node.options ?? [];
                let branch = [];
                for (let index = options.length - 1; index >= 0; index -= 1) {
                    const option = options[index];
                    const compiled = this.#compileSequence(actionData(option.actionData), {
                        ...state,
                        path: `${state.path}.options[${index}]`
                    });
                    branch = [{
                        type: 'IfElseAction',
                        conditions: [{
                            type: 'Compare',
                            left: descriptor(node.choice, 0),
                            operator: 'EQ',
                            right: descriptor(option.value, index)
                        }],
                        success: compiled.actions,
                        failure: branch,
                        reason: `${type}:option:${index}`
                    }];
                    result.cleanupActions.push(...compiled.cleanupActions);
                    result.metadata.push(...compiled.metadata);
                    result.unresolved.push(...compiled.unresolved);
                    result.diagnostics.push(...compiled.diagnostics);
                }
                result.actions.push(...branch);
                break;
            }
            case 'CreateTimedMarker': {
                const target = this.#targetRef(
                    node.targetSettings ?? node.target,
                    state,
                    'timed-marker target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (target.ref) result.actions.push({
                    type: 'CreateTimedMarker',
                    target: target.ref,
                    markerId: descriptor(node.markerId),
                    durationSeconds: descriptor(node.duration, 0),
                    useTimeDilationDt: Boolean(node.useTimeDilationDt),
                    reason: type
                });
                break;
            }
            case 'CreateBuffAction':
            case 'CreateBuffAttachingSkill': {
                const targetSettings = node.targetSettings ?? node.targetSource;
                const target = this.#targetRef(targetSettings, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const buffs = (node.buffs ?? []).map(buff => {
                    const buffIdBlackboardKey = buff.readIdFromBlackboard === true
                        && typeof buff.buffIdKey === 'string'
                        && buff.buffIdKey.length > 0
                        ? buff.buffIdKey
                        : null;
                    const fallbackBuffId = buff.buffId
                        || (buffIdBlackboardKey
                            ? state.blackboard?.[buffIdBlackboardKey]
                            : null);
                    return {
                        buffId: typeof fallbackBuffId === 'string'
                            && fallbackBuffId.length > 0
                            ? fallbackBuffId
                            : null,
                        buffIdBlackboardKey,
                        assignBlackboard: Boolean(buff.assignBlackboard),
                        assignments: normalizeAssignments(buff)
                    };
                });
                const dynamic = (node.buffs ?? []).filter(buff => buff.readIdFromBlackboard);
                if (dynamic.some(buff => typeof buff.buffIdKey !== 'string'
                    || buff.buffIdKey.length === 0)) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DYNAMIC_BUFF_ID_KEY_REQUIRED',
                        type,
                        state.path,
                        'A dynamic Buff id has no Blackboard key.'
                    ));
                }
                if (dynamic.length > 0 && !this.capabilities.dynamicBuffIdResolver) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DYNAMIC_BUFF_ID_REQUIRED',
                        type,
                        state.path,
                        'Dynamic Buff ids require the runtime Blackboard resolver.'
                    ));
                }
                const executableBuffs = buffs.filter(buff =>
                    buff.buffId || buff.buffIdBlackboardKey
                );
                if (target.ref && executableBuffs.length > 0) {
                    const actionLifetimeLeaseKey = state.scope === 'skill'
                        && node.autoFinishByAction === true
                        ? `ake-skill:${state.path}:buff-action-lifetime`
                        : null;
                    const applyBuff = {
                        type: 'ApplyBuff',
                        target: 'Target',
                        count: descriptor(node.count, 1),
                        buffs: executableBuffs,
                        // AKE copies only the explicitly serialized assignItems.
                        // Inheriting the entire parent Blackboard would let an
                        // unrelated key such as `duration` overwrite child
                        // Buff defaults.
                        inheritEventBlackboard: false,
                        // EnhanceAndRefresh and the other AKE stacking modes
                        // route their OnBuffAfterTryEnhanced hooks on every
                        // successful reapplication (for example NoGuard's
                        // crystal-break notification).
                        triggerEnhancementEvent: true,
                        asChildBuff: Boolean(node.asChildBuff),
                        attachToCurrentSkill: type === 'CreateBuffAttachingSkill',
                        ...(actionLifetimeLeaseKey === null ? {} : {
                            actionLifetime: {
                                leaseKey: actionLifetimeLeaseKey,
                                inheritSkillIds: (node.inheritSkillIdList ?? [])
                                    .filter(skillId => typeof skillId === 'string'
                                        && skillId.length > 0),
                                finishByAction: true,
                                finishWithNextSkillIfNotInherited:
                                    node.finishWithNextSkillIfNotInherited !== false
                            }
                        }),
                        reason: type
                    };
                    const directFinderType = selectorSource(targetSettings) === 'InstantSearch'
                        ? finderType(targetSettings)
                        : null;
                    if (directFinderType === 'CharacterTeamFinder') {
                        const groupKey = `instant-team:${state.path}`;
                        const validators = targetSettings?.selectorData?.validatorData ?? [];
                        result.actions.push({
                            type: 'FindTargets',
                            targetGroupKey: groupKey,
                            finderMode: 'AlliedCharacters',
                            ownerRef: this.#targetRef(
                                targetSettings.selectorOwner ?? 'Source',
                                state,
                                'instant team finder owner'
                            ).ref ?? 'Source',
                            excludeOwner: validators.some(validator =>
                                nestedDataType(validator) === 'ExcludeOwnerValidator'
                            ),
                            tagIds: validators.flatMap(validator =>
                                nestedDataType(validator) === 'TagValidator'
                                    ? tagIds(validator.query?.tags)
                                    : []
                            ),
                            rawFinderType: directFinderType,
                            reason: `${type}:InstantSearch`
                        }, {
                            type: 'ForEachTarget',
                            targetGroupKey: groupKey,
                            actions: [applyBuff],
                            reason: `${type}:CharacterTeamFinder`
                        });
                    } else if (isRecord(target.ref) && target.ref.type === 'TargetGroup') {
                        result.actions.push({
                            type: 'ForEachTarget',
                            targetGroupKey: target.ref.key,
                            actions: [applyBuff],
                            reason: `${type}:TargetGroup`
                        });
                    } else {
                        result.actions.push({
                            ...applyBuff,
                            target: target.ref
                        });
                    }
                    if (node.autoFinishByAction === true) {
                        const finishActions = executableBuffs.map(buff => ({
                            type: actionLifetimeLeaseKey === null
                                ? 'FinishBuff'
                                : 'ReleaseBuffActionLifetime',
                            target: 'Target',
                            sourceRef: 'Source',
                            buffId: buff.buffId,
                            buffIdBlackboardKey: buff.buffIdBlackboardKey,
                            childOfCurrentBuff: Boolean(node.asChildBuff),
                            ...(actionLifetimeLeaseKey === null ? {} : {
                                leaseKey: actionLifetimeLeaseKey
                            }),
                            finishAll: true,
                            reason: `${type}:auto-finish`
                        }));
                        if (isRecord(target.ref) && target.ref.type === 'TargetGroup') {
                            result.cleanupActions.push({
                                type: 'ForEachTarget',
                                targetGroupKey: target.ref.key,
                                actions: finishActions,
                                reason: `${type}:auto-finish:TargetGroup`
                            });
                        } else {
                            result.cleanupActions.push(...finishActions.map(action => ({
                                ...action,
                                target: target.ref
                            })));
                        }
                    }
                }
                break;
            }
            case 'AddTagAction': {
                const target = this.#targetRef(
                    node.tagOwner,
                    state,
                    'temporary tag owner'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const tags = tagIds(node.tags).map(tagId =>
                    `ake-tag:${String(tagId)}`
                );
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'form-state',
                    target: clone(node.tagOwner ?? null),
                    tagIds: tagIds(node.tags),
                    useBlackboard: Boolean(node.useBlackboard)
                });
                if (state.scope !== 'skill') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TAG_ACTION_LIFETIME_REQUIRED',
                        type,
                        state.path,
                        'Non-skill AddTagAction lifetime must be bound to its Buff or event subscription before execution.',
                        { scope: state.scope }
                    ));
                    break;
                }
                if (node.useBlackboard === true) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DYNAMIC_TAG_VALUE_REQUIRED',
                        type,
                        state.path,
                        'Blackboard-selected AddTagAction values require a runtime tag-value resolver.',
                        { tag: clone(node.tag ?? null) }
                    ));
                    break;
                }
                if (tags.length === 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_TAG_LIST_EMPTY',
                        type,
                        state.path,
                        'AddTagAction has no static tag ids.'
                    ));
                    break;
                }
                if (!target.ref) break;
                // Skill timeline groups define the exact tag window: apply on
                // the group's start frame and release on its end frame.  A
                // reversible effect source gives overlapping casts and
                // pre-existing Buff tags reference-counted ownership instead
                // of deleting one another during cleanup.
                const sourceKey = `ake-skill:${state.path}:temporary-tags`;
                result.actions.push({
                    type: 'ApplyEffectSource',
                    target: target.ref,
                    sourceKey,
                    sourceType: 'SkillActionTag',
                    modifiers: [],
                    damageModifiers: [],
                    tags,
                    reason: type,
                    metadata: {
                        akeSourceAction: type,
                        akeSourcePath: state.path,
                        lifetime: 'TimelineGroup'
                    }
                });
                result.cleanupActions.push({
                    type: 'RemoveEffectSource',
                    sourceKey,
                    sourceType: 'SkillActionTag',
                    reason: `${type}:timeline-end`
                });
                break;
            }
            case 'EventListenerAction': {
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'ability-event-listener',
                    scope: state.scope,
                    timelineStartFrame: state.timelineStartFrame,
                    timelineEndFrame: state.timelineEndFrame,
                    eventTypes: (node.abilityActionMap ?? [])
                        .map(group => group?.abilityEvent)
                        .filter(Boolean)
                });
                const skillOwned = state.scope === 'skill';
                const buffOwned = state.scope === 'buff';
                if (!skillOwned && !buffOwned) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_EVENT_LISTENER_LIFETIME_REQUIRED',
                        type,
                        state.path,
                        'EventListenerAction must be bound to a Skill timeline or Buff instance lifetime before execution.',
                        { scope: state.scope }
                    ));
                    break;
                }
                if (skillOwned && (state.timelineStartFrame === null
                    || state.timelineStartFrame === undefined
                    || state.timelineEndFrame === null
                    || state.timelineEndFrame === undefined
                    || !Number.isFinite(Number(state.timelineStartFrame))
                    || !Number.isFinite(Number(state.timelineEndFrame)))) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_EVENT_LISTENER_TIMELINE_REQUIRED',
                        type,
                        state.path,
                        'Skill EventListenerAction requires an explicit timeline start and end frame.'
                    ));
                    break;
                }
                const eventGroups = [];
                for (const [groupIndex, group] of (node.abilityActionMap ?? []).entries()) {
                    const eventType = group?.abilityEvent;
                    const wrappers = Array.isArray(group?.actions) ? group.actions : [];
                    if (typeof eventType !== 'string' || eventType.length === 0) {
                        result.unresolved.push(this.#unresolved(
                            'AKE_EVENT_LISTENER_EVENT_TYPE_REQUIRED',
                            type,
                            `${state.path}.abilityActionMap[${groupIndex}]`,
                            'EventListenerAction group has no abilityEvent.'
                        ));
                        continue;
                    }
                    if (!RUNTIME_ABILITY_EVENT_TYPES.has(eventType)) {
                        result.unresolved.push(this.#unresolved(
                            'AKE_ABILITY_EVENT_EMITTER_REQUIRED',
                            type,
                            `${state.path}.abilityActionMap[${groupIndex}]`,
                            `Runtime has no proven emitter for ${eventType}.`,
                            { abilityEvent: eventType }
                        ));
                    }
                    const compiledWrappers = wrappers.map((wrapper, wrapperIndex) =>
                        this.compileActions(actionData(wrapper), {
                            path: `${state.path}.abilityActionMap[${groupIndex}].actions[${wrapperIndex}]`,
                            blackboard: state.blackboard,
                            scope: state.scope,
                            skillId: state.skillId,
                            eventTargetMode: true,
                            timelineStartFrame: state.timelineStartFrame,
                            timelineEndFrame: state.timelineEndFrame
                        })
                    );
                    for (const compiled of compiledWrappers) {
                        result.metadata.push(...compiled.metadata);
                        result.unresolved.push(...compiled.unresolved);
                        result.diagnostics.push(...compiled.diagnostics);
                        if (compiled.cleanupActions.length > 0) {
                            result.unresolved.push(this.#unresolved(
                                'AKE_EVENT_LISTENER_CHILD_CLEANUP_LIFETIME_REQUIRED',
                                type,
                                `${state.path}.abilityActionMap[${groupIndex}]`,
                                'An event-listener child action produced cleanup actions whose event lifetime is not yet proven.',
                                { cleanupActionCount: compiled.cleanupActions.length }
                            ));
                        }
                    }
                    const actions = compiledWrappers.flatMap(compiled => compiled.actions);
                    const childUnresolved = compiledWrappers.flatMap(compiled =>
                        compiled.unresolved
                    );
                    if (actions.length === 0 && childUnresolved.length === 0) {
                        result.unresolved.push(this.#unresolved(
                            'AKE_EVENT_LISTENER_ACTIONS_EMPTY',
                            type,
                            `${state.path}.abilityActionMap[${groupIndex}]`,
                            `${eventType} has no executable child action.`,
                            { abilityEvent: eventType }
                        ));
                    }
                    if (actions.length > 0) eventGroups.push({
                        eventType,
                        actions,
                        priority: Number(node.priorityOffset ?? 0)
                    });
                }
                if (eventGroups.length === 0) break;
                const ownerLifetime = skillOwned ? 'SkillTimeline' : 'BuffInstance';
                const sourceKey = `${skillOwned ? 'ake-skill' : 'ake-buff'}:${state.path}:ability-listener`;
                result.actions.push({
                    type: 'RegisterAbilityEventListener',
                    sourceKey,
                    listenerTarget: 'Owner',
                    ownerLifetime,
                    timelineStartFrame: skillOwned
                        ? Number(state.timelineStartFrame)
                        : 0,
                    timelineEndFrame: skillOwned
                        ? Number(state.timelineEndFrame)
                        : null,
                    priority: Number(node.priorityOffset ?? 0),
                    eventGroups,
                    metadata: {
                        akeSourceAction: type,
                        akeSourcePath: state.path,
                        lifetime: ownerLifetime
                    },
                    reason: type
                });
                result.cleanupActions.push({
                    type: 'UnregisterAbilityEventListener',
                    sourceKey,
                    ownerLifetime,
                    reason: skillOwned
                        ? `${type}:timeline-end`
                        : `${type}:buff-end`
                });
                break;
            }
            case 'InheritBuffAction': {
                const target = this.#targetRef(
                    node.buffOwner,
                    state,
                    'inherited Buff owner'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const buffId = typeof node.targetBuffId === 'string'
                    && node.targetBuffId.length > 0
                    ? node.targetBuffId
                    : null;
                if (!buffId) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_INHERIT_BUFF_ID_REQUIRED',
                        type,
                        state.path,
                        'InheritBuffAction requires a target Buff id.'
                    ));
                }
                if (!target.ref || !buffId) break;
                const leaseKey = `ake-skill:${state.path}:inherited-buff-action-lifetime`;
                const inheritSkillIds = (node.inheritSkillIdList ?? [])
                    .filter(skillId => typeof skillId === 'string' && skillId.length > 0);
                const inheritAction = {
                    type: 'InheritBuffActionLifetime',
                    target: 'Target',
                    buffId,
                    leaseKey,
                    inheritSkillIds,
                    finishByAction: node.finishByAction !== false,
                    finishWithNextSkillIfNotInherited:
                        node.finishWithNextSkillIfNotInherited !== false,
                    reason: type
                };
                const cleanupAction = {
                    type: 'ReleaseBuffActionLifetime',
                    target: 'Target',
                    buffId,
                    leaseKey,
                    reason: `${type}:auto-finish`
                };
                if (isRecord(target.ref) && target.ref.type === 'TargetGroup') {
                    result.actions.push({
                        type: 'ForEachTarget',
                        targetGroupKey: target.ref.key,
                        actions: [inheritAction],
                        reason: `${type}:TargetGroup`
                    });
                    if (node.finishByAction !== false) {
                        result.cleanupActions.push({
                            type: 'ForEachTarget',
                            targetGroupKey: target.ref.key,
                            actions: [cleanupAction],
                            reason: `${type}:auto-finish:TargetGroup`
                        });
                    }
                } else {
                    result.actions.push({ ...inheritAction, target: target.ref });
                    if (node.finishByAction !== false) {
                        result.cleanupActions.push({
                            ...cleanupAction,
                            target: target.ref
                        });
                    }
                }
                break;
            }
            case 'AuraAction': {
                const enter = this.#compileSequence(actionData(node.actionInAura), {
                    ...state,
                    path: `${state.path}.actionInAura`
                });
                const exit = this.#compileSequence(actionData(node.actionWhenExitAura), {
                    ...state,
                    path: `${state.path}.actionWhenExitAura`
                });
                const targetBuffs = (node.buffInput ?? []).filter(buff => buff.buffId).map(buff => ({
                    buffId: buff.buffId,
                    assignBlackboard: Boolean(buff.assignBlackboard),
                    assignments: normalizeAssignments(buff)
                }));
                const auraId = `ake-aura:${state.path}`;
                const targetFilter = node.targetFilter ?? {};
                result.actions.push({
                    type: 'CreateAura',
                    auraId,
                    scopeAuraId: true,
                    targetSelector: {
                        mode: node.auraType === 'GlobalAura'
                            ? 'Global'
                            : this.capabilities.singleTargetSpatialBinding
                                ? 'ContextTarget'
                                : 'ExternalSpatialProvider',
                        faction: targetFilter.factionTarget,
                        objectType: node.targetObjectType,
                        excludeOwner: Boolean(node.excludeOwner),
                        tagIds: tagIds(targetFilter.tagQuery?.tags),
                        tagQueryType: targetFilter.tagQuery?.queryType ?? 'HasAny'
                    },
                    definition: {
                        auraType: node.auraType,
                        targetBuffs,
                        onApplyTargetActions: enter.actions,
                        onRemoveTargetActions: [
                            ...enter.cleanupActions,
                            ...exit.actions
                        ],
                        rawShape: clone(node.shapeData),
                        rawTargetFilter: clone(targetFilter)
                    },
                    reason: type
                });
                result.cleanupActions.push({
                    type: 'RemoveAura',
                    auraId,
                    scopeAuraId: true,
                    reason: `${type}:cleanup`
                });
                result.metadata.push(
                    ...enter.metadata,
                    ...exit.metadata,
                    {
                        type,
                        path: state.path,
                        category: 'aura',
                        auraType: node.auraType,
                        rawShape: clone(node.shapeData)
                    }
                );
                result.unresolved.push(...enter.unresolved, ...exit.unresolved);
                result.diagnostics.push(...enter.diagnostics, ...exit.diagnostics);
                if (node.auraType !== 'GlobalAura'
                    && !this.capabilities.singleTargetSpatialBinding) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_AURA_TARGET_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        'Ranged aura creation is executable, but target membership needs a spatial provider.'
                    ));
                }
                break;
            }
            case 'FinishBuffAction':
            case 'FinishBuffAdvanced':
            case 'FinishBuffByTag': {
                const target = this.#targetRef(node.buffOwner ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const ids = type === 'FinishBuffAction'
                    ? (node.buffIds ?? []).map(entry => typeof entry === 'string' ? entry : entry.buffId)
                    : (node.buffIds ?? node.buffSettings?.buffIdList ?? []);
                const checkType = type === 'FinishBuffByTag'
                    ? 'Tag'
                    : (node.checkType ?? node.buffSettings?.checkType ?? 'Id');
                const query = node.tagQuery ?? node.buffSettings?.tagQuery ?? {};
                const queryTagIds = tagIds(node.tagIds ?? query.tags);
                let sourceRef;
                if (node.limitSource) {
                    const source = this.#targetRef(node.buffSource, state, 'buff source');
                    if (source.unresolved) result.unresolved.push(source.unresolved);
                    sourceRef = source.ref;
                }
                if (!['Id', 'Tag', 'Environment'].includes(checkType)
                    || (checkType === 'Environment' && state.scope !== 'buff')) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BUFF_SELECTOR_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        checkType === 'Environment'
                            ? 'Environment Buff selection requires the current Buff instance context.'
                            : `Buff selector type ${checkType} requires an external provider.`,
                        { checkType }
                    ));
                }
                if (target.ref) {
                    const common = {
                        type: 'FinishBuff',
                        target: target.ref,
                        sourceRef,
                        finishAll: node.finishAll !== false,
                        stackCount: descriptor(node.finishLayerCount ?? node.finishLayerCnt, 1),
                        reason: type
                    };
                    if (checkType === 'Id') {
                        for (const buffId of ids.filter(Boolean)) {
                            result.actions.push({ ...common, buffId });
                        }
                    } else if (checkType === 'Tag' && queryTagIds.length > 0) {
                        result.actions.push({
                            ...common,
                            tagIds: queryTagIds,
                            tagQueryType: query.queryType ?? 'HasAny'
                        });
                    } else if (checkType === 'Environment' && state.scope === 'buff') {
                        // AKE's Environment selector is the Buff instance whose
                        // lifecycle/ability callback is currently executing.
                        // Serialized ids in this mode are editor residue and
                        // must not widen the finish to sibling instances.
                        result.actions.push({
                            ...common,
                            currentBuffInstance: true
                        });
                    } else if (checkType === 'Tag') {
                        result.unresolved.push(this.#unresolved(
                            'AKE_BUFF_TAG_QUERY_EMPTY',
                            type,
                            state.path,
                            'Tag-based Buff finishing has no tag IDs.'
                        ));
                    }
                }
                break;
            }
            case 'ExtendBuffAction': {
                const target = this.#targetRef(
                    node.buffOwner,
                    state,
                    'extended Buff owner'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const settings = node.buffSettings ?? {};
                const checkType = settings.checkType ?? 'Id';
                const buffIds = checkType === 'Id'
                    ? (settings.buffIdList ?? []).filter(Boolean)
                    : [];
                const extendTagIds = checkType === 'Tag'
                    ? tagIds(settings.tagQuery?.tags)
                    : [];
                if (!['Id', 'Tag'].includes(checkType)) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_EXTEND_BUFF_SELECTOR_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        `ExtendBuffAction selector type ${checkType} requires an external provider.`,
                        { checkType }
                    ));
                    break;
                }
                if ((checkType === 'Id' && buffIds.length === 0)
                    || (checkType === 'Tag' && extendTagIds.length === 0)) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_EXTEND_BUFF_SELECTOR_EMPTY',
                        type,
                        state.path,
                        'ExtendBuffAction requires at least one Buff id or tag.'
                    ));
                    break;
                }
                if (target.ref) {
                    const leaseKey = `ake:${state.scope}:${state.path}:extend-buff`;
                    const hold = {
                        type: 'SetBuffExpiryHeld',
                        target: target.ref,
                        buffIds,
                        tagIds: extendTagIds,
                        tagQueryType: settings.tagQuery?.queryType ?? 'HasAny',
                        leaseKey,
                        isHeld: true,
                        reason: type
                    };
                    result.actions.push(hold);
                    result.cleanupActions.push({
                        ...hold,
                        isHeld: false,
                        reason: `${type}:cleanup`
                    });
                    result.metadata.push({
                        type,
                        path: state.path,
                        category: 'status-lifecycle',
                        operation: 'hold-expiry',
                        checkType,
                        buffIds,
                        tagIds: extendTagIds,
                        leaseKey
                    });
                }
                break;
            }
            case 'HealAction': {
                const target = this.#targetRef(node.target ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const calculation = this.#healCalculation(node, state);
                result.unresolved.push(...calculation.unresolved);
                if (target.ref && calculation.value !== null) result.actions.push({
                    type: 'Heal',
                    target: target.ref,
                    baseAmount: calculation.value,
                    healType: node.healType,
                    reason: type
                });
                break;
            }
            case 'ObtainCostAction': {
                const costType = node.costType;
                const scope = costType === 'Atb' ? 'Shared' : 'Entity';
                const target = scope === 'Entity'
                    ? this.#targetRef(node.target ?? node.source, state, 'resource target')
                    : { ref: null, unresolved: null };
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (scope === 'Shared' || target.ref) {
                    result.actions.push({
                        type: 'ResourceChange',
                        resourceType: costType,
                        scope,
                        resourceOwner: scope === 'Entity' ? target.ref : null,
                        operation: node.gainMethod ?? node.atbGainMethod ?? 'Gain',
                        amount: descriptor(node.value ?? node.costValue),
                        coefficient: descriptor(node.coefficient, 1),
                        percentOfMax: Boolean(node.isPercentValue),
                        requireSourceMainCharacter: Boolean(node.atbOnlyMainChar),
                        ignoreGainScalar: Boolean(node.ignoreUspGainScalar),
                        resourceSourceType: node.atbSourceType ?? null,
                        resourceGainMethod: node.atbGainMethod ?? node.gainMethod ?? null,
                        resourceGainTags: node.useUspRecoverTag
                            ? tagIds(node.uspRecoverTag).filter(tagId => tagId !== 0)
                            : [],
                        reason: type
                    });
                }
                break;
            }
            case 'RefrainObtainUsp': {
                const target = this.#targetRef(
                    node.targetSettings ?? node.target,
                    state,
                    'USP gain suppression target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!target.ref) break;
                const sourceKey = `ake:${state.path}:refrain-usp`;
                const resourceGainTags = tagIds(node.refrainObtainUspTags)
                    .filter(tagId => tagId !== 0);
                result.actions.push({
                    type: 'SuppressResourceGain',
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    resourceOwner: target.ref,
                    resourceGainTags,
                    sourceKey,
                    reason: type
                });
                result.cleanupActions.push({
                    type: 'ResumeResourceGain',
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    resourceOwner: target.ref,
                    sourceKey,
                    reason: `${type}:cleanup`
                });
                if (node.clearUspOnEnd) {
                    result.cleanupActions.push({
                        type: 'ClearResource',
                        resourceType: 'UltimateSp',
                        scope: 'Entity',
                        resourceOwner: target.ref,
                        reason: `${type}:clear-on-end`
                    });
                }
                break;
            }
            case 'ObtainUspInNormalSkill': {
                const mapping = this.#findMapping('ResourceActionRule', candidate =>
                    candidate.selector?.actionType === type
                );
                if (!mapping) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_RESOURCE_RULE_MISSING',
                        type,
                        state.path,
                        'ObtainUspInNormalSkill requires an evidence-backed ResourceActionRule.'
                    ));
                    break;
                }
                const quantified = value => mapping.effect.quantization === 'percentage-float32'
                    ? { type: 'PercentageFloat32', value }
                    : value;
                const coefficient = descriptor(node.coefficient, 1);
                const hasEveryone = Object.prototype.hasOwnProperty.call(
                    state.blackboard ?? {},
                    'usp_everyone'
                );
                const hasSelf = Object.prototype.hasOwnProperty.call(
                    state.blackboard ?? {},
                    'usp_self'
                );
                if (!hasEveryone && !hasSelf) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_NORMAL_SKILL_USP_BLACKBOARD_REQUIRED',
                        type,
                        state.path,
                        'The action has no local usp_everyone/usp_self values; a global setting provider is required.'
                    ));
                }
                if (mapping.effect.includeEveryone && hasEveryone
                    && Number(state.blackboard.usp_everyone) !== 0) result.actions.push({
                    type: 'ResourceChange',
                    resourceType: mapping.effect.resourceType ?? 'UltimateSp',
                    scope: 'Entity',
                    resourceRecipients: 'AlliedCharacters',
                    operation: 'Gain',
                    scaleByAtbSpendEligibility: true,
                    amount: quantified({
                        type: 'Multiply',
                        values: [
                            { type: 'Blackboard', key: 'usp_everyone', default: 0 },
                            coefficient
                        ]
                    }),
                    reason: type
                });
                if (mapping.effect.includeSelf && hasSelf
                    && Number(state.blackboard.usp_self) !== 0) result.actions.push({
                    type: 'ResourceChange',
                    resourceType: mapping.effect.resourceType ?? 'UltimateSp',
                    scope: 'Entity',
                    resourceOwner: 'Source',
                    operation: 'Gain',
                    scaleByAtbSpendEligibility: true,
                    amount: quantified({
                        type: 'Multiply',
                        values: [
                            { type: 'Blackboard', key: 'usp_self', default: 0 },
                            coefficient
                        ]
                    }),
                    reason: type
                });
                break;
            }
            case 'UltimateTimeAction': {
                const timeScale = Number(node.timeScale ?? 1);
                result.metadata.push(this.#timelineMetadata(type, node, state));
                if (timeScale !== 0) break;
                const durationTicks = Math.max(
                    0,
                    Number(state.timelineEndFrame ?? state.timelineStartFrame ?? 0)
                        - Number(state.timelineStartFrame ?? 0)
                );
                if (durationTicks > 0) result.actions.push({
                    type: 'PauseOtherClockDomains',
                    durationTicks,
                    excludedDomainId: 'SourceClock',
                    includeEnemyDomains: true,
                    reason: type
                });
                const sourceKey = state.scope === 'skill'
                    ? `ake-skill:${state.path}:ultimate-atb-recovery`
                    : `ake:${state.path}:ultimate-atb-recovery`;
                result.actions.push({
                    type: 'SuspendResourceRecovery',
                    resourceType: 'Atb',
                    scope: 'Shared',
                    sourceKey,
                    // Calc preserves the cast frame and the following ATB
                    // tick, then suppresses recovery for the action window.
                    delayTicks: 2,
                    reason: type
                });
                result.cleanupActions.push({
                    type: 'ResumeResourceRecovery',
                    resourceType: 'Atb',
                    scope: 'Shared',
                    sourceKey,
                    reason: `${type}:cleanup`
                });
                break;
            }
            case 'GainBreakingAttackAtb': {
                result.actions.push({
                    type: 'ResourceChange',
                    resourceType: 'Atb',
                    scope: 'Shared',
                    operation: 'Gain',
                    amount: {
                        type: 'Multiply',
                        values: [
                            {
                                type: 'Attribute',
                                entity: 'Target',
                                key: 'BreakingAttackedAtbObtain',
                                default: 0
                            },
                            descriptor(node.factor, 1)
                        ]
                    },
                    resourceSourceType: 'Skill',
                    resourceGainMethod: 'Gain',
                    reason: type
                });
                break;
            }
            case 'GainCostAction': {
                const costType = node.costData?.costType;
                const scope = costType === 'Atb' ? 'Shared' : 'Entity';
                const target = scope === 'Entity'
                    ? this.#targetRef(
                        node.targetType ?? node.sourceType,
                        state,
                        'gained resource target'
                    )
                    : { ref: null, unresolved: null };
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (costType && (scope === 'Shared' || target.ref)) {
                    result.actions.push({
                        type: 'ResourceChange',
                        resourceType: costType,
                        scope,
                        resourceOwner: scope === 'Entity' ? target.ref : null,
                        operation: 'Gain',
                        amount: descriptor(node.costData?.costValue),
                        resourceGainMethod: 'Gain',
                        reason: type
                    });
                }
                break;
            }
            case 'InterruptCurSkillAction': {
                const target = this.#targetRef(
                    node.skillOwner,
                    state,
                    'interrupted skill owner'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.actions.push({
                    type: 'InterruptCurrentSkill',
                    target: target.ref ?? 'Owner',
                    reason: type
                });
                break;
            }
            case 'FinishOwnerAction': {
                const target = this.#targetRef(node.owner, state, 'finished entity owner');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (target.ref) result.actions.push({
                    type: 'DeactivateEntity',
                    // FinishOwnerAction is commonly used to retire spawned
                    // ability entities found into a Context group.  An empty
                    // group means "there is nothing to finish"; it must never
                    // fall back to the combat target (which would make the
                    // enemy disappear from later hit-box searches).
                    target: isRecord(target.ref)
                        && target.ref.type === 'TargetGroup'
                        ? { ...target.ref, fallback: null, all: true }
                        : target.ref,
                    reason: type
                });
                break;
            }
            case 'DamageAction': {
                const damageUnits = normalizeDamageUnits(node);
                const target = this.#targetRef(
                    node.targetSettings ?? node.targetSource,
                    state,
                    'damage target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.actions.push({
                    type: 'ResolveDamagePacket',
                    ...(target.ref ? { targetRef: target.ref } : {}),
                    damageUnits,
                    reason: type,
                    sourcePath: state.path
                });
                if (!this.capabilities.damageResolver) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DAMAGE_RESOLVER_REQUIRED',
                        type,
                        state.path,
                        'Damage units are parsed, but formula resolution requires a damageResolver.'
                    ));
                }
                break;
            }
            case 'SpellInfliction': {
                const mapping = this.#findMapping(type, candidate =>
                    candidate.selector?.inflictionType === node.inflictionType
                );
                if (mapping?.effect?.operation === 'ApplyBuff') {
                    const attachmentBuffIds = elementalAttachmentBuffIds(
                        this.semanticMappings
                    );
                    result.actions.push({
                        type: 'ApplyEnemyInfliction',
                        element: node.inflictionType,
                        buffId: mapping.effect.buffId,
                        attachmentBuffIds,
                        target: 'Target',
                        inheritEventBlackboard: false,
                        reason: type
                    });
                } else {
                    result.unresolved.push(this.#unresolved(
                        'AKE_INFLICTION_MAPPING_MISSING',
                        type,
                        state.path,
                        `No attachment mapping is available for ${node.inflictionType}.`
                    ));
                }
                break;
            }
            case 'ForceSpellStatusAction': {
                const source = this.#targetRef(
                    node.source ?? 'Source',
                    state,
                    'forced spell status source'
                );
                const target = this.#targetRef(
                    node.target ?? 'Target',
                    state,
                    'forced spell status target'
                );
                if (source.unresolved) result.unresolved.push(source.unresolved);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const spellStatusType = resolveValue(
                    node.spellStatusType,
                    state.blackboard,
                    node.spellStatusType
                );
                const statusBuffId = AKE_FORCED_SPELL_STATUS_BUFF_IDS[
                    spellStatusType
                ];
                const attachmentBuffIds = elementalAttachmentBuffIds(
                    this.semanticMappings
                );
                if (typeof statusBuffId !== 'string' || statusBuffId.length === 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_FORCED_SPELL_STATUS_MAPPING_MISSING',
                        type,
                        state.path,
                        `No canonical abnormal-state Buff is available for ${String(spellStatusType)}.`,
                        { spellStatusType }
                    ));
                }
                const missingElements = Object.keys(AKE_FORCED_SPELL_STATUS_BUFF_IDS)
                    .filter(element => typeof attachmentBuffIds[element] !== 'string');
                if (missingElements.length > 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_FORCED_SPELL_ATTACHMENT_MAPPING_MISSING',
                        type,
                        state.path,
                        'ForceSpellStatusAction requires the shared four-element attachment mapping.',
                        { missingElements }
                    ));
                }
                if (source.ref && target.ref && statusBuffId
                    && missingElements.length === 0) {
                    result.actions.push({
                        type: 'ForceEnemySpellStatus',
                        sourceRef: source.ref,
                        target: target.ref,
                        spellStatusType,
                        statusBuffId,
                        attachmentBuffIds,
                        count: descriptor(node.count, 1),
                        consumedLayer: descriptor(node.consumedLayer, 0),
                        consumedType: descriptor(node.consumedType),
                        isExtra: node.isExtra === true,
                        metadata: {
                            akeSourceAction: type,
                            akeSourcePath: state.path
                        },
                        reason: type,
                        sourcePath: state.path
                    });
                }
                break;
            }
            case 'SpellInflictionOnChar': {
                const target = this.#targetRef(node.target ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (target.ref) result.actions.push({
                    type: 'ApplyInfliction',
                    target: target.ref,
                    element: node.inflictionType,
                    amount: node.useInflictionCountBlackboardKey
                        ? {
                            useBlackboardKey: true,
                            value: node.inflictionCount,
                            blackboardKey: node.inflictionCountBlackboardKey
                        }
                        : descriptor(node.inflictionCount, 1),
                    reason: type
                });
                break;
            }
            case 'OnSpellInflictionStart': {
                const element = node.element ?? node.inflictionType ?? node.type;
                if (typeof element !== 'string' || element.length === 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_INFLICTION_ELEMENT_MISSING',
                        type,
                        state.path,
                        'OnSpellInflictionStart has no element type.'
                    ));
                    break;
                }
                result.actions.push({
                    type: 'TriggerStatusEvent',
                    eventType: `EnergyShardBy${element}`,
                    element,
                    reason: type
                });
                break;
            }
            case 'TriggerSpellBurstEventAction':
                result.actions.push({
                    type: 'EmitEvent',
                    eventType: 'SpellBurstTriggered',
                    spellBurstType: node.spellBurstType,
                    payload: { spellBurstType: node.spellBurstType },
                    reason: type
                });
                break;
            case 'OnSpellAbnormalStartFinish': {
                if (typeof node.isStart !== 'boolean') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SPELL_ABNORMAL_LIFECYCLE_PHASE_MISSING',
                        type,
                        state.path,
                        'OnSpellAbnormalStartFinish requires a Boolean isStart value.'
                    ));
                    break;
                }
                if (!SPELL_ABNORMAL_TYPES.has(node.abnormalType)) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SPELL_ABNORMAL_LIFECYCLE_TYPE_UNSUPPORTED',
                        type,
                        state.path,
                        `Unsupported spell abnormal type ${String(node.abnormalType)}.`,
                        { abnormalType: node.abnormalType ?? null }
                    ));
                    break;
                }
                const eventType = node.isStart
                    ? 'SpellAbnormalStarted'
                    : 'SpellAbnormalFinished';
                result.actions.push({
                    type: 'EmitEvent',
                    eventType,
                    payload: {
                        abnormalType: node.abnormalType,
                        isStart: node.isStart
                    },
                    reason: type
                });
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'spell-abnormal-lifecycle',
                    eventType,
                    abnormalType: node.abnormalType,
                    isStart: node.isStart
                });
                break;
            }
            case 'SetSuperArmorAction': {
                const target = this.#targetRef(node.targetSettings ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (target.ref) {
                    const sourceKey = state.scope === 'skill'
                        ? `ake-skill:${state.path}:super-armor`
                        : undefined;
                    result.actions.push({
                        type: 'SetResilienceModifier',
                        target: target.ref,
                        sourceKey,
                        superArmorLevel: descriptor(node.superArmorValue),
                        impactResistance: descriptor(node.impactResistance),
                        reason: type
                    });
                    result.cleanupActions.push({
                        type: 'RemoveResilienceModifier',
                        target: target.ref,
                        sourceKey,
                        reason: `${type}:cleanup`
                    });
                }
                break;
            }
            case 'ModifyResilienceDecreaseFactor': {
                const sourceKey = state.scope === 'skill'
                    ? `ake-skill:${state.path}:resilience-factor`
                    : undefined;
                result.actions.push({
                    type: 'SetResilienceModifier',
                    target: 'Target',
                    sourceKey,
                    rawResilienceDecreaseFactor: descriptor(node.resilienceDecreaseFactor),
                    reason: type
                });
                result.cleanupActions.push({
                    type: 'RemoveResilienceModifier',
                    target: 'Target',
                    sourceKey,
                    reason: `${type}:cleanup`
                });
                result.unresolved.push(this.#unresolved(
                    'AKE_RESILIENCE_FACTOR_UNIT_UNKNOWN',
                    type,
                    state.path,
                    'The raw resilience decrease factor is retained, but its numeric unit is not inferred.'
                ));
                break;
            }
            case 'ChangeSkillAction': {
                const target = this.#targetRef(
                    node.skillSource ?? node.target ?? node.targetSource,
                    state,
                    'skill-form target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!node.skillSlot || !node.targetSkillId) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SKILL_OVERRIDE_DATA_MISSING',
                        type,
                        state.path,
                        'ChangeSkillAction requires both skillSlot and targetSkillId.'
                    ));
                    break;
                }
                if (!target.ref) break;
                const prefix = state.scope === 'skill' ? 'ake-skill' : 'ake';
                const sourceKey = `${prefix}:${state.path}:skill-override:${node.skillSlot}`;
                result.actions.push({
                    type: 'ApplySkillOverride',
                    target: target.ref,
                    sourceKey,
                    skillSlot: node.skillSlot,
                    targetSkillId: node.targetSkillId,
                    revertedSkillId: node.specificRevertedSkillId
                        ? node.revertedSkillId || null
                        : null,
                    priorityLevel: node.priorityLevel ?? 'Default',
                    priorityOffset: Number(node.priorityOffset ?? 0),
                    inheritOriginSkillCdProgress: Boolean(node.inheritOriginSkillCdProgress),
                    overrideCacheTime: Boolean(node.overrideCacheTime),
                    cacheTime: descriptor(node.cacheTime, null),
                    lifeTimeType: node.lifeTimeType ?? 'FinishByAction',
                    duration: descriptor(node.duration, 0),
                    reason: type
                });
                if (node.lifeTimeType !== 'Infinite') result.cleanupActions.push({
                    type: 'RemoveSkillOverride',
                    target: target.ref,
                    sourceKey,
                    skillSlot: node.skillSlot,
                    reason: `${type}:cleanup`
                });
                break;
            }
            case 'SwitchModeAction': {
                if (!node.modeId) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SKILL_MODE_ID_MISSING',
                        type,
                        state.path,
                        'SwitchModeAction requires modeId.'
                    ));
                    break;
                }
                const prefix = state.scope === 'skill' ? 'ake-skill' : 'ake';
                const sourceKey = `${prefix}:${state.path}:skill-mode:${node.modeId}`;
                result.actions.push({
                    type: 'ApplySkillMode',
                    target: 'Source',
                    sourceKey,
                    modeId: node.modeId,
                    resetOnEnd: node.resetOnEnd !== false,
                    priorityLevel: node.priorityLevel ?? 'Default',
                    priorityOffset: Number(node.priorityOffset ?? 0),
                    reason: type
                });
                if (node.resetOnEnd !== false) result.cleanupActions.push({
                    type: 'RemoveSkillMode',
                    target: 'Source',
                    sourceKey,
                    modeId: node.modeId,
                    reason: `${type}:cleanup`
                });
                break;
            }
            default:
                result.unresolved.push(this.#unresolved(
                    'AKE_ACTION_UNSUPPORTED',
                    type,
                    state.path,
                    `No executable compiler route exists for ${type}.`,
                    { category: classification.category }
                ));
        }
        return finalize(result);
    }

    #compileCondition(node, state) {
        const type = shortType(node) || 'UnknownCondition';
        const result = { condition: null, unresolved: [], diagnostics: [] };
        switch (type) {
            case 'CompareFloat':
            case 'CompareString':
                result.condition = {
                    type: 'Compare',
                    left: descriptor(node.left ?? node.valueA),
                    operator: node.operator ?? node.compare,
                    right: descriptor(node.right ?? node.valueB)
                };
                break;
            case 'CompareDeckAttr': {
                const target = this.#targetRef(
                    node.target,
                    state,
                    'deck-attribute target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                if (!node.lhsType || !node.rhsType) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DECK_ATTRIBUTE_MISSING',
                        type,
                        state.path,
                        'CompareDeckAttr requires both lhsType and rhsType.'
                    ));
                    break;
                }
                result.condition = target.ref ? {
                    type: 'Compare',
                    left: {
                        type: 'Add',
                        values: [
                            {
                                type: 'Attribute',
                                entity: target.ref,
                                attribute: node.lhsType,
                                default: 0
                            },
                            descriptor(node.lhsValue, 0)
                        ]
                    },
                    operator: node.compare,
                    right: {
                        type: 'Add',
                        values: [
                            {
                                type: 'Attribute',
                                entity: target.ref,
                                attribute: node.rhsType,
                                default: 0
                            },
                            descriptor(node.rhsValue, 0)
                        ]
                    }
                } : null;
                break;
            }
            case 'CheckDamageType':
                result.condition = {
                    type: 'Compare',
                    left: { type: 'Payload', key: 'damageType' },
                    operator: 'EQ',
                    right: node.damageType
                };
                break;
            case 'CheckDamageDecorateMask':
                result.condition = {
                    type: 'BitMaskCompare',
                    value: { type: 'Payload', key: 'damageDecorateMask', default: 0 },
                    mask: Number(node.mask ?? 0),
                    checkType: node.checkType ?? 'HasAll'
                };
                break;
            case 'CheckDamageTypeMask': {
                const damageTypes = String(node.damageTypeMask ?? '')
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean);
                result.condition = {
                    type: 'Compare',
                    left: { type: 'Payload', key: 'damageType' },
                    operator: 'IN',
                    right: damageTypes
                };
                break;
            }
            case 'CheckTargetsEqual': {
                const firstSettings = node.firstTargetSettings ?? node.firstTarget;
                const secondSettings = node.secondTargetSettings ?? node.secondTarget;
                const first = this.#targetRef(firstSettings, state, 'first compared target');
                const second = this.#targetRef(secondSettings, state, 'second compared target');
                if (first.unresolved) result.unresolved.push(first.unresolved);
                if (second.unresolved) result.unresolved.push(second.unresolved);
                result.condition = first.ref && second.ref ? {
                    type: 'TargetsEqual',
                    first: first.ref,
                    second: second.ref,
                    firstUsesEventTarget: selectorSource(firstSettings) === 'Target',
                    secondUsesEventTarget: selectorSource(secondSettings) === 'Target'
                } : null;
                break;
            }
            case 'CheckSkillType':
                result.condition = {
                    type: 'SkillTypeIs',
                    skillType: node.skillTypeList ?? []
                };
                break;
            case 'CheckSkillId': {
                const ids = (node.skillIdList ?? []).map(entry => descriptor(entry));
                result.condition = {
                    type: 'Compare',
                    left: { type: 'Context', key: 'skillId' },
                    operator: 'IN',
                    right: ids.map(entry => resolveValue(entry, state.blackboard, null)).filter(Boolean)
                };
                break;
            }
            case 'CheckBuffIdInContext': {
                const checkType = node.checkType ?? 'Id';
                if (checkType === 'Id') {
                    const ids = (node.buffIdList ?? []).map(entry => entry.buffId ?? entry).filter(Boolean);
                    result.condition = {
                        type: 'Compare',
                        left: { type: 'Payload', key: 'buffId' },
                        operator: 'IN',
                        right: ids
                    };
                } else if (checkType === 'Tag') {
                    const ids = tagIds(node.query?.tags);
                    const conditions = ids.map(tagId => ({
                        type: 'Compare',
                        left: tagId,
                        operator: 'IN',
                        right: { type: 'Payload', key: 'buffTagIds', default: [] }
                    }));
                    result.condition = {
                        type: node.query?.queryType === 'HasAll' ? 'All' : 'Any',
                        conditions
                    };
                }
                break;
            }
            case 'CheckBuffIdInContextAdvanced': {
                const checkType = node.checkType ?? 'Id';
                if (checkType === 'Id') {
                    const ids = (node.buffIdList ?? [])
                        .map(entry => resolveValue(entry, state.blackboard, null))
                        .filter(Boolean);
                    result.condition = {
                        type: 'Compare',
                        left: { type: 'Payload', key: 'buffId' },
                        operator: 'IN',
                        right: ids
                    };
                } else if (checkType === 'Tag') {
                    const ids = tagIds(node.query?.tags);
                    const conditions = ids.map(tagId => ({
                        type: 'Compare',
                        left: tagId,
                        operator: 'IN',
                        right: { type: 'Payload', key: 'buffTagIds', default: [] }
                    }));
                    const queryType = node.query?.queryType ?? 'HasAny';
                    result.condition = queryType === 'HasNone'
                        ? { type: 'Not', condition: { type: 'Any', conditions } }
                        : {
                            type: queryType === 'HasAll' ? 'All' : 'Any',
                            conditions
                        };
                }
                break;
            }
            case 'CheckBuffStackNum': {
                const target = this.#targetRef(node.checkTarget, state, 'Buff stack target');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: 'BuffStackCompare',
                    target: target.ref,
                    buffId: node.buffId?.buffId ?? node.buffId,
                    operator: node.compareType,
                    value: descriptor(node.value)
                } : null;
                break;
            }
            case 'CheckBuffStackNumAdvanced': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'advanced Buff stack target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const settings = node.buffSettings ?? {};
                if (settings.checkType === 'Environment') {
                    result.unresolved.push(this.#unresolved(
                        'AKE_ENVIRONMENT_BUFF_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        'Environment Buff counts require an external environment provider.'
                    ));
                    break;
                }
                result.condition = target.ref ? {
                    type: 'BuffStackCompare',
                    target: target.ref,
                    buffIds: settings.checkType === 'Id'
                        ? (settings.buffIdList ?? []).filter(Boolean)
                        : [],
                    tagIds: settings.checkType === 'Tag'
                        ? tagIds(settings.tagQuery?.tags)
                        : [],
                    tagQueryType: settings.tagQuery?.queryType ?? 'HasAny',
                    countType: node.buffStackNumType ?? 'BuffCount',
                    operator: node.compareType,
                    value: descriptor(node.value)
                } : null;
                break;
            }
            case 'CheckHp': {
                const target = this.#targetRef(node.hpOwner, state, 'HP target');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: node.isRatio ? 'HpRatioCompare' : 'HpCompare',
                    target: target.ref,
                    operator: node.compare,
                    value: descriptor(node.value)
                } : null;
                break;
            }
            case 'CheckUsp': {
                const target = this.#targetRef(node.uspOwner, state, 'USP owner');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: 'ResourceCompare',
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    ownerRef: target.ref,
                    ratio: Boolean(node.isRatio),
                    operator: node.compare,
                    value: descriptor(node.value)
                } : null;
                break;
            }
            case 'CheckObtainAtbType': {
                const conditions = [];
                if (node.checkObtainType) conditions.push({
                    type: 'Compare',
                    left: { type: 'Payload', key: 'resourceSourceType' },
                    operator: 'IN',
                    right: node.obtainTypeList ?? []
                });
                if (node.checkObtainMethod) conditions.push({
                    type: 'Compare',
                    left: { type: 'Payload', key: 'resourceGainMethod' },
                    operator: 'IN',
                    right: node.obtainMethodList ?? []
                });
                result.condition = conditions.length === 1
                    ? conditions[0]
                    : { type: 'All', conditions };
                break;
            }
            case 'CheckMainCharacterCondition': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'main-character target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: 'EntityIsMainCharacter',
                    target: target.ref
                } : null;
                break;
            }
            case 'CheckSquadInFight':
                // SkillData uses this gate for combat-only resource and Buff
                // branches. The runtime derives it from the registered allied
                // character and a living hostile entity; it is not a UI flag.
                result.condition = { type: 'SquadInFight' };
                break;
            case 'CheckTimedMarkerCondition': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'timed-marker target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: 'TimedMarkerExists',
                    target: target.ref,
                    markerId: node.useBlackboardKey
                        ? {
                            useBlackboardKey: true,
                            blackboardKey: node.blackboardKey,
                            value: node.id ?? ''
                        }
                        : node.id,
                    returnTrueIfNotExists: Boolean(node.returnTrueIfNotExists)
                } : null;
                break;
            }
            case 'CheckEntityNum': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'entity-count target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const groupKey = selectorGroupKey(node.checkTarget);
                result.condition = target.ref ? {
                    type: groupKey ? 'TargetGroupCountCompare' : 'EntityCountCompare',
                    ...(groupKey
                        ? { targetGroupKey: groupKey }
                        : { target: target.ref }),
                    operator: node.compareType ?? 'GE',
                    value: Number(node.minNum ?? 1),
                    storeKey: node.storeKey || null,
                    excludeDeadEntity: Boolean(node.excludeDeadEntity),
                    containsHittableTarget: Boolean(node.containsHittableTarget)
                } : null;
                break;
            }
            case 'CheckDistanceCondition': {
                const source = this.#targetRef(
                    node.source,
                    state,
                    'distance source'
                );
                const target = this.#targetRef(
                    node.target,
                    state,
                    'distance target'
                );
                if (source.unresolved) result.unresolved.push(source.unresolved);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = source.ref && target.ref ? {
                    type: 'DistanceCompare',
                    source: source.ref,
                    target: target.ref,
                    operator: node.lessThan === false ? 'GE' : 'LT',
                    distance: Number(node.distance ?? 0),
                    includeTargetRadius: Boolean(node.includeTargetRadius),
                    // Assembled fixed-dummy entities intentionally have no
                    // world transform. Their deterministic overlap is 0 m.
                    fallbackDistance: 0
                } : null;
                break;
            }
            case 'CheckTagMatch': {
                const target = this.#targetRef(node.checkTarget, state, 'tag-check target');
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const tags = tagIds(node.query?.tags).map(tagId =>
                    `ake-tag:${String(tagId)}`
                );
                const children = tags.map(tag => ({
                    type: 'HasTag',
                    entity: target.ref,
                    tag
                }));
                const queryType = node.query?.queryType ?? 'HasAny';
                if (target.ref && children.length > 0) {
                    if (queryType === 'HasNone') {
                        result.condition = {
                            type: 'Not',
                            condition: { type: 'Any', conditions: children }
                        };
                    } else {
                        result.condition = {
                            type: queryType === 'HasAll' ? 'All' : 'Any',
                            conditions: children
                        };
                    }
                }
                break;
            }
            default:
                result.unresolved.push(this.#unresolved(
                    'AKE_CONDITION_UNSUPPORTED',
                    type,
                    state.path,
                    `Condition ${type} has no safe local evaluator.`
                ));
        }
        if (!result.condition) result.condition = {
            type: 'AkeUnresolvedCondition',
            sourceType: type,
            sourcePath: state.path
        };
        result.diagnostics.push(...result.unresolved.map(clone));
        return result;
    }

    #healCalculation(node, state) {
        const calculation = node.healCalculation ?? node;
        const calculationType = node.calculationType ?? actionType(calculation.$type);
        if (calculationType === 'DefiniteValueCalculation') {
            let value = descriptor(node.value ?? calculation.value);
            const applyScale = node.applyScale ?? calculation.applyScale;
            if (applyScale) value = {
                type: 'Multiply',
                values: [value, descriptor(node.valueScale ?? calculation.valueScale, 1)]
            };
            return { value, unresolved: [] };
        }
        if (calculationType === 'MultiplyAttributeCalculation') {
            const source = calculation.valueSource === 'Target'
                ? 'Target'
                : (TARGET_ALIASES.get(node.healer) ?? 'Source');
            return {
                value: {
                    type: 'Add',
                    values: [
                        {
                            type: 'Multiply',
                            values: [
                                {
                                    type: 'Attribute',
                                    entity: source,
                                    attribute: calculation.attributeType,
                                    default: 0
                                },
                                descriptor(calculation.multiplier, 1)
                            ]
                        },
                        descriptor(calculation.addition, 0)
                    ]
                },
                unresolved: []
            };
        }
        return {
            value: null,
            unresolved: [this.#unresolved(
                'AKE_HEAL_CALCULATION_UNSUPPORTED',
                'HealAction',
                state.path,
                `Heal calculation ${calculationType || 'Unknown'} is not implemented.`
            )]
        };
    }

    #timelineMetadata(type, node, state) {
        const base = {
            type,
            path: state.path,
            category: 'timeline',
            startFrame: node.startFrame ?? null,
            endFrame: node.endFrame ?? null
        };
        if (type === 'LaunchProjectile') return {
            ...base,
            projectileId: node.projectileId,
            childSkillId: node.childSkillId ?? node.projectileSkillId
                ?? node.skillIdOnReach ?? node.skillIdOnFinish ?? node.skillIdOnBlock,
            castSkillOnHit: node.castSkillOnHit !== false,
            skillTriggers: [
                {
                    terminalEvent: 'Hit',
                    enabled: node.castSkillOnHit !== false,
                    childSkillId: node.childSkillId ?? node.projectileSkillId ?? null
                },
                {
                    terminalEvent: 'Block',
                    enabled: node.castSkillOnBlock === true,
                    childSkillId: node.skillIdOnBlock ?? null
                },
                {
                    terminalEvent: 'Reach',
                    enabled: node.castSkillOnReach === true,
                    childSkillId: node.skillIdOnReach ?? null
                },
                {
                    terminalEvent: 'Finish',
                    enabled: node.castSkillOnFinish === true,
                    childSkillId: node.skillIdOnFinish ?? null
                }
            ],
            assignments: normalizeAssignments({
                assignItems: node.assignPairs ?? node.assignments ?? []
            })
        };
        if (type === 'ComboCacheAction') return {
            ...base,
            mappings: node.mappings ?? (node.mappingDataList ?? []).map(mapping => ({
                command: mapping.cmdType,
                skillId: mapping.skillId,
                cacheEndByAction: Boolean(mapping.cacheEndByAction),
                overrideCacheTime: Boolean(mapping.overrideCacheTime),
                cacheTime: mapping.cacheTime
            }))
        };
        if (type === 'AllowNextSkillAction') return {
            ...base,
            allowedSkillIds: node.allowedSkillIds ?? node.allowedSkillIdList ?? []
        };
        if (type === 'TickIntervalAction') return {
            ...base,
            intervalSeconds: node.useTickIntervalBlackboardKey
                ? {
                    type: 'Blackboard',
                    key: node.tickIntervalBlackboardKey,
                    default: Number(node.tickInterval ?? 0)
                }
                : node.tickInterval,
            timelineStartFrame: state.timelineStartFrame ?? null,
            timelineEndFrame: state.timelineEndFrame ?? null,
            executeEachFrame: Boolean(node.executeEachFrame)
        };
        if (type === 'ChannelingAction' || type === 'ChannelingCastingAction') return {
            ...base,
            intervalSeconds: node.triggerInterval ?? null,
            targetIntervalSeconds: node.targetTriggerInterval ?? null,
            maxCountPerTarget: node.maxCountPerTarget ?? null,
            executeEachFrame: Boolean(node.executeEachFrame)
        };
        return {
            ...base,
            duration: node.duration ?? node.durationSeconds ?? null,
            requestedScale: node.timeScale ?? null,
            curveKey: node.curveKey ?? null,
            priorityTagId: node.timeDilationPriority?.tagId
                ?? node.timeDilationPriorityTagId
                ?? null
        };
    }

    #findMapping(actionTypeName, predicate) {
        return this.semanticMappings.find(mapping =>
            mapping.actionType === actionTypeName && predicate(mapping)
        ) ?? null;
    }

    #unresolved(code, sourceType, path, message, details = {}) {
        return { code, sourceType, path, message, ...clone(details) };
    }
}

export default AkeActionCompiler;
