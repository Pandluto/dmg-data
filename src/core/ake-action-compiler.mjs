import {
    actionType,
    parseBlackboard,
    parseBuff,
    parseSkill,
    resolveValue
} from './ake-parser.mjs';

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
    'ChannelingAction', 'ChannelingCastingAction'
]);
const SPATIAL_TYPES = new Set([
    'FindTargetAction', 'ContinuousFindTargetAction', 'PickTargetAction',
    'MergeTargetAction', 'MoveToAction', 'TeleportAction',
    'TeleportPosSelectAction', 'CustomRootMotionAction', 'SelfRotateAction',
    'SnapToTargetWithRangeAction', 'PushBackAction', 'PullAction',
    'BlowOffAction', 'AirborneAction', 'LaunchUpwardAction'
]);
const CONDITION_PREFIX = /^(Check|Compare|Probablity$|OrCondition|NotNextCheck)/;
const TARGET_ALIASES = new Map([
    ['Source', 'Source'],
    ['ActionSource', 'Source'],
    ['Self', 'Source'],
    ['Owner', 'Owner'],
    ['ActionOwner', 'Owner'],
    ['Target', 'Target'],
    ['CurrentTarget', 'Target']
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

function normalizeAssignments(buff) {
    return (buff.assignments ?? buff.assignItems ?? []).map(item => ({
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
            skillId: options.skillId ?? null
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
            scope: options.scope ?? 'standalone'
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
                const nodes = (group.actions ?? []).flatMap(wrapper => actionData(wrapper));
                const compiled = this.compileActions(nodes, {
                    path: `${collectionPath}[${groupIndex}]`,
                    blackboard,
                    scope: 'buff'
                });
                return {
                    eventType: group[eventField],
                    finishAfterIgnited: Boolean(group.finishAfterIgnited),
                    actions: compiled.actions,
                    cleanupActions: compiled.cleanupActions,
                    metadata: compiled.metadata,
                    unresolved: compiled.unresolved,
                    diagnostics: compiled.diagnostics
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
                scope: 'buff'
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
            metadata: { modifyAttributeType: modifier.modifyAttributeType }
        }));
        const persistentTags = tagIds(raw.applyTags).map(tagId => `ake-tag:${tagId}`);
        const persistentDamageModifiers = clone(parsed.damageModifiers);
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
        ].flatMap(group => group.unresolved);
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
                skillId: parsed.skillId
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

    #compileSequence(nodes, state) {
        const result = emptyCompilation('Sequence');
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            const type = shortType(node);
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
        if (source === null || source === undefined || source === '') {
            return { ref: 'Target', unresolved: null };
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
            case 'LaunchProjectile': {
                const metadata = this.#timelineMetadata(type, node, state);
                result.metadata.push(metadata);
                const childSkillId = metadata.childSkillId;
                if (metadata.castSkillOnHit === false || !childSkillId) break;
                if (childSkillId === state.skillId) {
                    result.diagnostics.push({
                        code: 'AKE_SELF_REFERENTIAL_PROJECTILE_RETAINED',
                        sourceType: type,
                        path: state.path,
                        childSkillId
                    });
                    break;
                }
                const flightMapping = this.#findMapping(
                    'ProjectileFlightRule',
                    mapping => mapping.selector?.projectileId === metadata.projectileId
                        || mapping.selector?.projectileIds?.includes(metadata.projectileId)
                );
                result.actions.push({
                    type: 'LaunchSkillProgram',
                    projectileId: metadata.projectileId ?? null,
                    childSkillId,
                    launchDelayTicks: flightMapping?.effect?.delayTicks ?? 0,
                    assignments: clone(metadata.assignments ?? []),
                    inheritBlackboard: true,
                    reason: 'LaunchProjectile'
                });
                if (!this.capabilities.skillProgramResolver) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_SKILL_PROGRAM_RESOLVER_REQUIRED',
                        type,
                        state.path,
                        `Projectile child SkillData ${childSkillId} requires a skillProgramResolver.`,
                        { childSkillId }
                    ));
                }
                break;
            }
            case 'SpawnAbilityEntity': {
                const childSkillId = node.childSkillId ?? node.abilityEntitySkillId;
                result.metadata.push({
                    type,
                    path: state.path,
                    category: 'timeline',
                    abilityEntityId: node.abilityEntityId ?? null,
                    childSkillId: childSkillId ?? null
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
            case 'TickIntervalAction':
                result.metadata.push(this.#timelineMetadata(type, node, state));
                result.unresolved.push(this.#unresolved(
                    'AKE_INTERVAL_SCHEDULER_REQUIRED',
                    type,
                    state.path,
                    'Interval action timing is retained but requires an interval scheduling adapter.'
                ));
                break;
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
                result.actions.push({
                    type: 'ModifyBlackboard',
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
            case 'ReadSkillSettingData': {
                const reads = node.reads ?? node.dataList ?? [];
                const entries = [];
                for (const [index, read] of reads.entries()) {
                    const column = resolveValue(read.column, state.blackboard, 1);
                    const mapping = this.#findMapping('ReadSkillSettingData', candidate =>
                        candidate.selector?.lookupKey === read.dataKey
                        && Number(candidate.selector?.column ?? 1) === Number(column)
                    );
                    if (mapping?.effect?.operation === 'ReturnValue') {
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
                break;
            }
            case 'CreateBuffAction': {
                const target = this.#targetRef(node.targetSettings ?? node.targetSource, state);
                if (target.unresolved) result.unresolved.push(target.unresolved);
                const buffs = (node.buffs ?? []).map(buff => ({
                    buffId: buff.buffId,
                    assignBlackboard: Boolean(buff.assignBlackboard),
                    assignments: normalizeAssignments(buff)
                }));
                const dynamic = (node.buffs ?? []).filter(buff => buff.readIdFromBlackboard);
                if (dynamic.length > 0) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_DYNAMIC_BUFF_ID_REQUIRED',
                        type,
                        state.path,
                        'One or more Buff ids are read dynamically from Blackboard.'
                    ));
                }
                const executableBuffs = buffs.filter(buff => buff.buffId);
                if (target.ref && executableBuffs.length > 0) {
                    result.actions.push({
                        type: 'ApplyBuff',
                        target: target.ref,
                        count: descriptor(node.count, 1),
                        buffs: executableBuffs,
                        // AKE copies only the explicitly serialized assignItems.
                        // Inheriting the entire parent Blackboard would let an
                        // unrelated key such as `duration` overwrite child
                        // Buff defaults.
                        inheritEventBlackboard: false,
                        reason: type
                    });
                    if (node.autoFinishByAction === true) {
                        result.cleanupActions.push(...executableBuffs.map(buff => ({
                            type: 'FinishBuff',
                            target: target.ref,
                            sourceRef: 'Source',
                            buffId: buff.buffId,
                            finishAll: true,
                            reason: `${type}:auto-finish`
                        })));
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
                        mode: node.auraType === 'GlobalAura' ? 'Global' : 'ExternalSpatialProvider',
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
                if (node.auraType !== 'GlobalAura') {
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
                if (!['Id', 'Tag'].includes(checkType)) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_BUFF_SELECTOR_PROVIDER_REQUIRED',
                        type,
                        state.path,
                        `Buff selector type ${checkType} requires an external provider.`,
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
                result.actions.push({
                    type: 'ResourceChange',
                    resourceType: costType,
                    scope,
                    resourceOwner: scope === 'Entity' ? 'Source' : null,
                    operation: node.gainMethod ?? node.atbGainMethod ?? 'Gain',
                    amount: descriptor(node.value ?? node.costValue),
                    coefficient: descriptor(node.coefficient, 1),
                    reason: type
                });
                if (node.isPercentValue) {
                    result.unresolved.push(this.#unresolved(
                        'AKE_PERCENT_RESOURCE_VALUE_REQUIRED',
                        type,
                        state.path,
                        'Percent resource values require the selected pool maximum.'
                    ));
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
                const components = [];
                if (mapping.effect.includeEveryone) components.push({
                    type: 'Blackboard', key: 'usp_everyone', default: 0
                });
                if (mapping.effect.includeSelf) components.push({
                    type: 'Blackboard', key: 'usp_self', default: 0
                });
                let amount = {
                    type: 'Multiply',
                    values: [
                        { type: 'Add', values: components.length > 0 ? components : [0] },
                        descriptor(node.coefficient, 1)
                    ]
                };
                if (mapping.effect.quantization === 'percentage-float32') {
                    amount = { type: 'PercentageFloat32', value: amount };
                }
                result.actions.push({
                    type: 'ResourceChange',
                    resourceType: mapping.effect.resourceType ?? 'UltimateSp',
                    scope: 'Entity',
                    resourceOwner: 'Source',
                    operation: 'Gain',
                    amount,
                    reason: type
                });
                break;
            }
            case 'DamageAction': {
                const damageUnits = normalizeDamageUnits(node);
                result.actions.push({
                    type: 'ResolveDamagePacket',
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
                    result.actions.push({
                        type: 'ApplyBuff',
                        buffId: mapping.effect.buffId,
                        target: 'Target',
                        inheritEventBlackboard: false,
                        // OnBuffAfterTryEnhanced is a SpellInfliction lifecycle,
                        // not a side effect of every direct ApplyBuff call.
                        triggerEnhancementEvent: true,
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
            case 'CheckDamageType':
                result.condition = {
                    type: 'Compare',
                    left: { type: 'Payload', key: 'damageType' },
                    operator: 'EQ',
                    right: node.damageType
                };
                break;
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
            case 'CheckEntityNum': {
                const target = this.#targetRef(
                    node.checkTarget,
                    state,
                    'entity-count target'
                );
                if (target.unresolved) result.unresolved.push(target.unresolved);
                result.condition = target.ref ? {
                    type: 'EntityCountCompare',
                    target: target.ref,
                    operator: node.compareType ?? 'GE',
                    value: Number(node.minNum ?? 1),
                    excludeDeadEntity: Boolean(node.excludeDeadEntity),
                    containsHittableTarget: Boolean(node.containsHittableTarget)
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
            childSkillId: node.childSkillId ?? node.projectileSkillId,
            castSkillOnHit: node.castSkillOnHit !== false,
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
            intervalSeconds: node.tickInterval,
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
