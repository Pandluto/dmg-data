const COST_TYPES = new Map([
    [0, 'UltimateSp'],
    [1, 'Atb']
]);

export function actionType(rawType) {
    if (typeof rawType !== 'string') return '';
    const className = rawType.split(',', 1)[0].split('+', 1)[0].split('.').at(-1);
    return className === 'Data' ? '' : className;
}

export function resolveValue(descriptor, blackboard, fallback = 0) {
    if (descriptor === null || descriptor === undefined) return fallback;
    if (typeof descriptor === 'number' || typeof descriptor === 'string') return descriptor;
    if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
        return blackboard[descriptor.blackboardKey] ?? descriptor.value ?? fallback;
    }
    return descriptor.value ?? fallback;
}

export const AKE_SKILL_ACTION_TYPES = Object.freeze([
    'LaunchProjectile', 'DamageAction', 'CreateBuffAction', 'SpellInfliction',
    'ObtainCostAction', 'ComboCacheAction', 'AllowNextSkillAction',
    'JumpToAction', 'MarkCanInterrupt',
    'HitStopAction', 'TimeDilationAction', 'UltimateTimeAction',
    'HealAction', 'SetSuperArmorAction', 'TriggerSpellBurstEventAction'
]);

export const AKE_BUFF_ACTION_TYPES = Object.freeze([
    'IfElseAction', 'ModifyDynamicBlackboard', 'ReadSkillSettingData',
    'StoreAttributeValue', 'CreateBuffAction', 'ObtainUspInNormalSkill',
    'HealAction', 'SetSuperArmorAction', 'TriggerSpellBurstEventAction',
    'ModifyResilienceDecreaseFactor', 'DamageAction', 'ObtainCostAction',
    'SimpleCalcBBAction', 'FinishBuffAction', 'FinishBuffAdvanced',
    'SpellInfliction', 'SpellInflictionOnChar'
]);

export function parseBlackboard(rawEntries = []) {
    const values = {};
    const lineage = {};
    for (const entry of rawEntries ?? []) {
        const value = entry.valueDouble ?? entry.valueStr ?? null;
        values[entry.key] = value;
        lineage[entry.key] = [{ source: 'SkillData.default', value }];
    }
    return { values, lineage };
}

function mergeSkillPatch(raw, patchBundle, level) {
    const { values, lineage } = parseBlackboard(raw.blackboard);
    const patch = patchBundle?.SkillPatchDataBundle?.find(entry => Number(entry.level) === Number(level)) ?? null;
    for (const entry of patch?.blackboard ?? []) {
        const value = entry.value ?? entry.valueStr ?? null;
        values[entry.key] = value;
        lineage[entry.key] ??= [];
        lineage[entry.key].push({ source: `SkillPatchTable.level${level}`, value });
    }
    return { values, lineage, patch };
}

function collectTimelineActions(raw) {
    const events = [];
    let order = 0;

    function visit(value, path, timing, branchDepth) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach((entry, index) => visit(entry, `${path}[${index}]`, timing, branchDepth));
            return;
        }

        const type = actionType(value.$type);
        const nextBranchDepth = path.endsWith('.actionData') ? branchDepth + 1 : branchDepth;
        if (type) {
            events.push({
                order: order++,
                type,
                rawType: value.$type,
                startFrame: timing.startFrame,
                endFrame: timing.endFrame,
                branchDepth,
                path,
                raw: value
            });
        }
        for (const [key, child] of Object.entries(value)) {
            visit(child, `${path}.${key}`, timing, key === 'actionData' ? nextBranchDepth : branchDepth);
        }
    }

    for (const [groupIndex, timeline] of (raw.actionGroupData?.timelineActions ?? []).entries()) {
        const timing = {
            startFrame: Number(timeline._startFrame ?? 0),
            endFrame: Number(timeline._endFrame ?? timeline._startFrame ?? 0)
        };
        visit(
            timeline._sequenceActionData?.actionData ?? [],
            `actionGroupData.timelineActions[${groupIndex}]._sequenceActionData.actionData`,
            timing,
            0
        );
    }
    return events;
}

function normalizeAssignments(buffSpec) {
    return (buffSpec.assignItems ?? [])
        .filter(item => (typeof item?.targetKey === 'string'
            && item.targetKey.trim().length > 0)
            || Number.isFinite(item?.targetKey))
        .map(item => ({
            targetKey: item.targetKey,
            sourceKey: item.inputValueKey || null,
            direct: Boolean(item.useDirectValue),
            directValue: item.directValueType === 'String' ? item.stringValue : item.numericValue
        }));
}

function normalizeCreateBuff(raw) {
    return {
        count: raw.count ?? { useBlackboardKey: false, value: 1, blackboardKey: '' },
        buffs: (raw.buffs ?? []).map(buff => ({
            buffId: buff.buffId,
            assignBlackboard: Boolean(buff.assignBlackboard),
            assignments: normalizeAssignments(buff)
        })),
        targetSource: raw.targetSettings?.targetSource ?? null,
        buffSource: raw.buffSource ?? null
    };
}

function normalizeDamage(raw) {
    return (raw.damageUnits ?? [])
        .filter(unit => ['Hp', 'Poise'].includes(unit.damageAttributeType))
        .map(unit => ({
            damageType: unit.damageType,
            damageAttributeType: unit.damageAttributeType,
            scale: unit.simpleCalculation === false
                ? (unit.atkCalculation?.atkScale ?? unit.atkScale)
                : unit.atkScale,
            calculationType: unit.simpleCalculation === false
                ? (actionType(unit.atkCalculation?.$type) || 'UnknownAtkCalculation')
                : 'SimpleAtkScaleCalculation',
            calculationMultiplier: unit.atkCalculation?.multiplier
                ?? { useBlackboardKey: false, value: 1, blackboardKey: '' },
            poiseCalculationType: actionType(unit.poiseCalculation?.$type),
            poiseValue: unit.poiseCalculation?.value
                ?? { useBlackboardKey: false, value: 0, blackboardKey: '' },
            poiseApplyScale: Boolean(unit.poiseCalculation?.applyScale),
            poiseValueScale: unit.poiseCalculation?.valueScale
                ?? { useBlackboardKey: false, value: 0, blackboardKey: '' },
            enablePoiseBreakTimeDilation: Boolean(unit.enablePoiseBreakTimeDilation),
            simpleCalculation: unit.simpleCalculation !== false,
            onlyEnableForMainChar: Boolean(unit.onlyEnableForMainChar)
        }));
}

function normalizeRelevantEvent(event) {
    const raw = event.raw;
    const base = {
        order: event.order,
        type: event.type,
        startFrame: event.startFrame,
        endFrame: event.endFrame,
        branchDepth: event.branchDepth,
        path: event.path
    };
    switch (event.type) {
        case 'LaunchProjectile':
            return {
                ...base,
                projectileId: raw.projectileId,
                childSkillId: raw.projectileSkillId,
                assignEntityBlackboard: Boolean(raw.assignEntityBlackboard)
            };
        case 'DamageAction':
            return { ...base, damageUnits: normalizeDamage(raw) };
        case 'CreateBuffAction':
            return { ...base, ...normalizeCreateBuff(raw) };
        case 'SpellInfliction':
            return { ...base, inflictionType: raw.inflictionType, isExtra: Boolean(raw.isExtra) };
        case 'ObtainCostAction':
            return {
                ...base,
                costType: raw.costType,
                value: raw.costValue,
                coefficient: raw.coefficient,
                atbSourceType: raw.atbSourceType,
                gainMethod: raw.atbGainMethod
            };
        case 'ComboCacheAction':
            return {
                ...base,
                mappings: (raw.mappingDataList ?? []).map(mapping => ({
                    command: mapping.cmdType,
                    skillId: mapping.skillId,
                    cacheEndByAction: Boolean(mapping.cacheEndByAction),
                    overrideCacheTime: Boolean(mapping.overrideCacheTime),
                    cacheTime: mapping.cacheTime
                }))
            };
        case 'AllowNextSkillAction':
            return { ...base, allowedSkillIds: raw.allowedSkillIdList ?? [] };
        case 'JumpToAction':
            return { ...base, destFrame: Number(raw.destFrame ?? 0) };
        case 'MarkCanInterrupt':
            return { ...base };
        case 'HitStopAction':
            return {
                ...base,
                affectType: raw.affectType,
                curveKey: raw.curveKey,
                useDirectCurve: Boolean(raw.useDirectCurve),
                durationSeconds: Number(raw.duration ?? 0),
                timeDilationPriorityTagId: raw.timeDilationPriority?.tagId ?? null
            };
        case 'TimeDilationAction':
            return {
                ...base,
                layer: raw.layer,
                curveKey: raw.curveKey,
                useCurveKey: Boolean(raw.useCurveKey),
                duration: raw.duration,
                finishByAction: Boolean(raw.finishByAction),
                useTimeScaleForSkillCdTick: Boolean(raw.useTimeScaleForSkillCdTick),
                timeDilationPriorityTagId: raw.timeDilationPriority?.tagId ?? null
            };
        case 'UltimateTimeAction':
            return {
                ...base,
                timeScale: Number(raw.timeScale ?? 1),
                timeDilationPriorityTagId: raw.timeDilationPriority?.tagId ?? null
            };
        case 'HealAction':
            return {
                ...base,
                healType: raw.healType,
                healer: raw.healer,
                targetSource: raw.target?.targetSource ?? null,
                calculationType: actionType(raw.healCalculation?.$type),
                value: raw.healCalculation?.value,
                applyScale: Boolean(raw.healCalculation?.applyScale),
                valueScale: raw.healCalculation?.valueScale,
                showHealText: Boolean(raw.showHealText)
            };
        case 'SetSuperArmorAction':
            return {
                ...base,
                targetSource: raw.targetSettings?.targetSource ?? null,
                superArmorValue: raw.superArmorValue,
                impactResistance: raw.impactResistance
            };
        case 'TriggerSpellBurstEventAction':
            return { ...base, spellBurstType: raw.spellBurstType };
        default:
            return null;
    }
}

export function parseSkill(raw, patchBundle, { level = 1, tickRate = 30 } = {}) {
    const { values: blackboard, lineage: blackboardLineage, patch } = mergeSkillPatch(
        raw,
        patchBundle,
        level
    );
    const relevantTypes = new Set(AKE_SKILL_ACTION_TYPES);
    const events = collectTimelineActions(raw)
        .filter(event => relevantTypes.has(event.type))
        .map(normalizeRelevantEvent)
        .filter(Boolean);
    const costType = patch
        ? (COST_TYPES.get(Number(patch.costType)) ?? String(patch.costType))
        : raw.castData?.costData?.costType;
    const costValue = patch?.costValue ?? raw.castData?.costData?.costValue ?? 0;
    const cooldownSeconds = patch?.coolDown ?? raw.castData?.cooldownTime ?? 0;

    return {
        skillId: raw.skillId,
        level,
        skillSpecification: raw.skillSpecification,
        durationFrames: Number(raw.durationFrame ?? 0),
        exclusiveFrames: Number(raw.exclusiveFrame ?? 0),
        offsetRecordFrame: Number(raw.offsetRecordFrame ?? 0),
        cooldownSeconds,
        cooldownTicks: Math.round(cooldownSeconds * tickRate),
        costType,
        costValue,
        blackboard,
        blackboardLineage,
        patch: patch ? {
            level: patch.level,
            coolDown: patch.coolDown,
            costType: patch.costType,
            costValue: patch.costValue
        } : null,
        events,
        launches: events.filter(event => event.type === 'LaunchProjectile'),
        damages: events.filter(event => event.type === 'DamageAction'),
        createBuffs: events.filter(event => event.type === 'CreateBuffAction'),
        spellInflictions: events.filter(event => event.type === 'SpellInfliction'),
        resourceGains: events.filter(event => event.type === 'ObtainCostAction'),
        comboMappings: events.filter(event => event.type === 'ComboCacheAction'),
        allowNextWindows: events.filter(event => event.type === 'AllowNextSkillAction'),
        timelineJumps: events.filter(event => event.type === 'JumpToAction'),
        interruptMarks: events.filter(event => event.type === 'MarkCanInterrupt'),
        hitStops: events.filter(event => event.type === 'HitStopAction'),
        timeDilations: events.filter(event => event.type === 'TimeDilationAction'),
        ultimateTimeActions: events.filter(event => event.type === 'UltimateTimeAction'),
        heals: events.filter(event => event.type === 'HealAction'),
        superArmorActions: events.filter(event => event.type === 'SetSuperArmorAction'),
        reactionTriggers: events.filter(event => event.type === 'TriggerSpellBurstEventAction')
    };
}

function normalizeCondition(raw) {
    const type = actionType(raw?.$type);
    if (type === 'CompareFloat') {
        return { type, left: raw.valueA, operator: raw.compare, right: raw.valueB };
    }
    if (type === 'CheckDamageType') return { type, damageType: raw.damageType };
    return { type: type || 'Unknown', supported: false };
}

function normalizeBuffAction(raw) {
    const type = actionType(raw?.$type);
    switch (type) {
        case 'IfElseAction':
            return {
                type,
                conditions: (raw.conditionAction?.actionData ?? []).map(normalizeCondition),
                success: (raw.succeedActions?.actionData ?? []).map(normalizeBuffAction),
                failure: (raw.failActions?.actionData ?? []).map(normalizeBuffAction)
            };
        case 'ModifyDynamicBlackboard':
            return {
                type,
                key: raw.key,
                operation: raw.operation,
                directValue: raw.directValue !== false,
                value: raw.value,
                calculateType: raw.calculateType,
                calculationTarget: raw.calculationTarget?.targetSource ?? null
            };
        case 'SimpleCalcBBAction':
            return {
                type,
                key: raw.key,
                operation: raw.operation,
                value1: raw.value1,
                value2: raw.value2
            };
        case 'ReadSkillSettingData':
            return {
                type,
                reads: (raw.dataList ?? []).map(item => ({
                    dataKey: item.dataKey,
                    column: item.column,
                    storeKey: item.storeKey
                }))
            };
        case 'StoreAttributeValue':
            return {
                type,
                targetSource: raw.targetSettings?.targetSource ?? null,
                attributeType: raw.attributeType,
                storeAttributeType: raw.storeAttributeType,
                useFloor: Boolean(raw.useFloor),
                divisor: raw.divisorValue,
                multiplier: raw.multiplierValue,
                baseValue: raw.baseValue,
                key: raw.key
            };
        case 'CreateBuffAction':
            return { type, ...normalizeCreateBuff(raw) };
        case 'ObtainUspInNormalSkill':
            return {
                type,
                coefficient: raw.coefficient,
                sourceTarget: raw.source?.targetSource ?? 'Source'
            };
        case 'HealAction':
            return {
                type,
                healType: raw.healType,
                healer: raw.healer,
                targetSource: raw.target?.targetSource ?? null,
                calculationType: actionType(raw.healCalculation?.$type),
                value: raw.healCalculation?.value,
                applyScale: Boolean(raw.healCalculation?.applyScale),
                valueScale: raw.healCalculation?.valueScale,
                showHealText: Boolean(raw.showHealText)
            };
        case 'SetSuperArmorAction':
            return {
                type,
                targetSource: raw.targetSettings?.targetSource ?? null,
                superArmorValue: raw.superArmorValue,
                impactResistance: raw.impactResistance
            };
        case 'TriggerSpellBurstEventAction':
            return { type, spellBurstType: raw.spellBurstType };
        case 'ModifyResilienceDecreaseFactor':
            return { type, resilienceDecreaseFactor: raw.resilienceDecreaseFactor };
        case 'DamageAction':
            return { type, damageUnits: normalizeDamage(raw) };
        case 'ObtainCostAction':
            return {
                type,
                costType: raw.costType,
                value: raw.costValue,
                coefficient: raw.coefficient,
                atbSourceType: raw.atbSourceType,
                gainMethod: raw.atbGainMethod
            };
        case 'FinishBuffAction':
            return {
                type,
                targetSource: raw.buffOwner?.targetSource ?? null,
                buffIds: (raw.buffIds ?? []).map(entry => entry.buffId).filter(Boolean),
                finishAll: Boolean(raw.finishAll),
                finishLayerCount: raw.finishLayerCnt,
                limitSource: Boolean(raw.limitSource),
                sourceTarget: raw.buffSource?.targetSource ?? null
            };
        case 'FinishBuffAdvanced':
            return {
                type,
                targetSource: raw.buffOwner?.targetSource ?? null,
                checkType: raw.buffSettings?.checkType ?? null,
                buffIds: raw.buffSettings?.buffIdList ?? [],
                tagIds: (raw.buffSettings?.tagQuery?.tags ?? []).map(tag => tag.tagId),
                tagQueryType: raw.buffSettings?.tagQuery?.queryType ?? null,
                finishAll: Boolean(raw.finishAll),
                finishLayerCount: raw.finishLayerCnt,
                limitSource: Boolean(raw.limitSource),
                sourceTarget: raw.buffSource?.targetSource ?? null
            };
        case 'SpellInfliction':
            return {
                type,
                inflictionType: raw.inflictionType,
                isExtra: Boolean(raw.isExtra)
            };
        case 'SpellInflictionOnChar':
            return {
                type,
                sourceTarget: raw.source?.targetSource ?? null,
                targetSource: raw.target?.targetSource ?? null,
                inflictionType: raw.inflictionType,
                inflictionCount: raw.useInflictionCountBlackboardKey
                    ? {
                        useBlackboardKey: true,
                        value: raw.inflictionCount,
                        blackboardKey: raw.inflictionCountBlackboardKey
                    }
                    : raw.inflictionCount,
                directToTriggered: Boolean(raw.directToTriggerred),
                ignoreAddingCooldown: Boolean(raw.ignoreAddingCooldown)
            };
        default:
            return { type: type || 'Unknown', supported: false };
    }
}

export function parseBuff(raw, { tickRate = 30 } = {}) {
    const { values: blackboard } = parseBlackboard(raw.blackboard);
    const stacking = raw.stackingSettings ?? {};
    const configuredMaxStackCount = stacking.useMaxStackCntKey
        && typeof stacking.maxStackCntKey === 'string'
        && stacking.maxStackCntKey.length > 0
        ? Number(blackboard[stacking.maxStackCntKey])
        : Number(stacking.maxStackCnt ?? 1);
    // AKE serializes -1 for several non-stacking or externally configured
    // Buffs. It is a sentinel, not a literal runtime layer limit.
    const maxStackCount = Number.isInteger(configuredMaxStackCount)
        && configuredMaxStackCount > 0
        ? configuredMaxStackCount
        : stacking.stackingType === 'Unlimited'
            && configuredMaxStackCount === 0
            ? 0
            : 1;
    const damageModifiers = (raw.damageModifier ?? []).map(modifier => ({
        side: modifier.enableSide,
        damageTypes: (modifier.condition?.actionData ?? [])
            .filter(condition => actionType(condition.$type) === 'CheckDamageType')
            .map(condition => condition.damageType),
        processors: (modifier.damageProcessors ?? [])
            .filter(processor => actionType(processor.$type) === 'DamageScaleProcessor')
            .map(processor => ({
                side: processor.side,
                zoneName: processor.zoneName,
                addition: processor.addition
            }))
    }));
    const attributeModifiers = (raw.attributeModifier?.attributeModifiers ?? []).map(modifier => ({
        modifyAttributeType: modifier.modifyAttributeType,
        attributeType: modifier.attributeType,
        formulaItem: modifier.formulaItem,
        param: modifier.param
    }));
    const eventActions = (raw.buffEventAction ?? []).map(group => ({
        eventType: group.buffEvent,
        actions: (group.actions ?? [])
            .flatMap(actionSet => actionSet.actionData ?? [])
            .map(normalizeBuffAction)
    }));
    const startActions = eventActions
        .filter(group => group.eventType === 'OnBuffStart')
        .flatMap(group => group.actions);
    const triggerActions = eventActions
        .filter(group => group.eventType === 'OnBuffTrigger')
        .flatMap(group => group.actions);
    const endActions = eventActions
        .filter(group => group.eventType === 'OnBuffFinish')
        .flatMap(group => group.actions);
    const enableActions = eventActions
        .filter(group => group.eventType === 'OnBuffEnable')
        .flatMap(group => group.actions);
    const duringEnableActions = eventActions
        .filter(group => group.eventType === 'DuringBuffEnable')
        .flatMap(group => group.actions);
    const durationSeconds = resolveValue(raw.duration, blackboard, 0);
    const triggerIntervalSeconds = resolveValue(raw.triggerInterval, blackboard, -1);
    const maxTriggerCount = resolveValue(raw.maxTriggerCnt, blackboard, -1);

    return {
        buffId: raw.id,
        lifeType: raw.lifeType,
        duration: raw.duration,
        durationSeconds,
        durationTicks: Math.round(Number(durationSeconds) * tickRate),
        useTimeDilationDt: raw.useTimeDilationDt === true,
        onlyUseSelfTimeDilation: raw.onlyUseSelfTimeDilation === true,
        triggerInterval: raw.triggerInterval,
        triggerIntervalSeconds,
        triggerIntervalTicks: Number(triggerIntervalSeconds) > 0
            ? Math.max(1, Math.round(Number(triggerIntervalSeconds) * tickRate))
            : null,
        waitFirstTriggerInterval: raw.waitFirstTriggerInterval !== false,
        maxTriggerCnt: raw.maxTriggerCnt,
        maxTriggerCount,
        blackboard,
        stacking: {
            identifierType: stacking.identifierType ?? 'BuffId',
            stackingType: stacking.stackingType ?? 'Unique',
            stackingKey: stacking.stackingKey ?? '',
            maxStackCount,
            configuredMaxStackCount,
            maxStackCountKey: stacking.useMaxStackCntKey
                ? stacking.maxStackCntKey ?? null
                : null
        },
        attributeModifiers,
        damageModifiers,
        eventActions,
        startActions,
        triggerActions,
        endActions,
        enableActions,
        duringEnableActions
    };
}

export function resolveAssignments(assignments, sourceBlackboard) {
    return Object.fromEntries(assignments.map(assignment => [
        assignment.targetKey,
        assignment.direct
            ? assignment.directValue
            : sourceBlackboard[assignment.sourceKey]
    ]));
}
