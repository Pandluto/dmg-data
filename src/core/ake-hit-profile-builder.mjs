import fs from 'node:fs';
import path from 'node:path';

import { AkeActionCompiler } from './ake-action-compiler.mjs';
import { AkeDataRepository, parseAkeJson } from './ake-data-repository.mjs';
import { resolveValue } from './ake-parser.mjs';
import { AKE_FORCED_SPELL_STATUS_BUFF_IDS } from './combat-status-resolver.mjs';

export const AKE_SKILL_LEVEL_KEYS = Object.freeze([
    'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'M1', 'M2', 'M3'
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const AKE_HIT_BUFF_LABELS = Object.freeze({
    buff_common_energy_shard_attached_fire: '灼热附着',
    buff_common_energy_shard_attached_natural: '自然附着',
    buff_common_energy_shard_attached_cryst: '寒冷附着',
    buff_common_energy_shard_attached_pulse: '电磁附着',
    buff_common_obtain_ultimate_sp: '终结技能量恢复',
    buff_common_pulse_pulse_conduct_triggered: '导电',
    buff_common_natural_natural_corrupt_triggered: '腐蚀',
    buff_common_fire_fire_burning_triggered: '燃烧',
    buff_common_cryst_cryst_frozen_triggered: '冻结',
    buff_physical_no_guard: '破防',
    buff_common_originum_frozen: '源石结晶封印'
});

const AKE_ELEMENT_ATTACHMENT_BUFF_IDS = Object.freeze({
    Fire: 'buff_common_energy_shard_attached_fire',
    Natural: 'buff_common_energy_shard_attached_natural',
    Cryst: 'buff_common_energy_shard_attached_cryst',
    Pulse: 'buff_common_energy_shard_attached_pulse'
});

const AKE_COMBAT_STATUS_MARKERS = Object.freeze({
    crush: { id: 'ake_status_physical_crush', displayName: '猛击' },
    fracture: { id: 'ake_status_physical_fracture', displayName: '碎甲' },
    knockdown: { id: 'ake_status_physical_knockdown', displayName: '倒地' },
    airborne: { id: 'ake_status_physical_airborne', displayName: '击飞' }
});

function normalizeHitBuffTarget(target) {
    if (isRecord(target)) {
        if (target.type === 'TargetGroup') {
            if (/team|teammate|squad/i.test(String(target.key ?? ''))) return 'team';
            return normalizeHitBuffTarget(target.fallback ?? 'Target');
        }
        return normalizeHitBuffTarget(
            target.targetSource
                ?? target.target
                ?? target.fallback
                ?? target.source
                ?? 'unknown'
        );
    }
    if (target === 'Source' || target === 'Owner' || target === 'Self') return 'self';
    if (target === 'Target') return 'target';
    if (target === 'Team' || target === 'Squad') return 'team';
    return String(target ?? 'unknown').toLowerCase();
}

function hitBuffTargetLabel(target) {
    if (target === 'self') return '自身';
    if (target === 'target') return '目标';
    if (target === 'team') return '队伍';
    return '未知目标';
}

function hitBuffKind(buffId) {
    if (buffId.includes('obtain_ultimate_sp')) return 'resource';
    if (buffId.includes('energy_shard_attached_')) return 'attachment';
    return 'status';
}

function hitBuffStatusKey(buffId) {
    const normalized = String(buffId ?? '').toLowerCase();
    if (normalized.includes('energy_shard_attached_fire')) return 'attachment-fire';
    if (normalized.includes('energy_shard_attached_natural')) return 'attachment-nature';
    if (normalized.includes('energy_shard_attached_cryst')) return 'attachment-ice';
    if (normalized.includes('energy_shard_attached_pulse')) return 'attachment-electric';
    if (normalized.includes('physical_no_guard') || normalized.includes('no_guard')) return 'no-guard';
    if (normalized.includes('physical_fracture') || normalized.includes('fracture')) return 'fracture';
    if (normalized.includes('physical_crush') || normalized.includes('_crush')) return 'crush';
    if (normalized.includes('knockdown')) return 'knockdown';
    if (normalized.includes('airborne')) return 'airborne';
    if (normalized.includes('pulse_conduct')) return 'conductive';
    if (normalized.includes('natural_corrupt') || normalized.includes('corrosion')) return 'corrosion';
    if (normalized.includes('fire_burning')) return 'burn';
    if (normalized.includes('cryst_frozen')) return 'freeze';
    if (normalized.includes('poise_break')) return 'imbalance';
    if (normalized.includes('originum_frozen')) return 'originium-seal';
    return null;
}

function isDisplayableHitBuff(buffId) {
    // Tutorial/debug markers are implementation sentinels, not player-visible
    // effects. Keeping them out also prevents inflated per-hit Buff counts.
    return !/(?:tutorial|debug|test)_marker(?:_|$)/i.test(buffId)
        && !/_tutorial_marker$/i.test(buffId);
}

function displayNameForHitBuff(buffId) {
    return AKE_HIT_BUFF_LABELS[buffId]
        ?? buffId.replace(/^buff_(?:common|chr_[^_]+_[^_]+)_/, '').replaceAll('_', ' ');
}

function actionHitBuffs(action, blackboard, data) {
    if (['ApplyInfliction', 'ApplyEnemyInfliction'].includes(action.type)) {
        const buffId = action.buffId ?? AKE_ELEMENT_ATTACHMENT_BUFF_IDS[action.element];
        if (!buffId) return [];
        const target = normalizeHitBuffTarget(action.target);
        return [{
            id: buffId,
            displayName: displayNameForHitBuff(buffId),
            target,
            targetLabel: hitBuffTargetLabel(target),
            kind: 'attachment',
            statusKey: hitBuffStatusKey(buffId),
            description: `AKE 法术附着动作 · ${hitBuffTargetLabel(target)} · ${buffId}`
        }];
    }
    if (action.type === 'ForceEnemySpellStatus') {
        const buffId = action.statusBuffId
            ?? AKE_FORCED_SPELL_STATUS_BUFF_IDS[action.spellStatusType];
        if (!buffId) return [];
        const target = normalizeHitBuffTarget(action.target);
        return [{
            id: buffId,
            displayName: displayNameForHitBuff(buffId),
            target,
            targetLabel: hitBuffTargetLabel(target),
            kind: 'status',
            statusKey: hitBuffStatusKey(buffId),
            description: `AKE 强制元素异常 · ${hitBuffTargetLabel(target)} · ${buffId}`
        }];
    }
    if (action.type !== 'ApplyBuff') return [];
    const buffInputs = [
        ...(typeof action.buffId === 'string' && action.buffId.length > 0
            ? [{ buffId: action.buffId, assignments: [] }]
            : []),
        ...(Array.isArray(action.buffs)
            ? action.buffs.flatMap(buff => {
                if (typeof buff === 'string') return [{ buffId: buff, assignments: [] }];
                const buffId = buff?.buffId ?? buff?.id;
                return typeof buffId === 'string' && buffId.length > 0
                    ? [{ buffId, assignments: buff.assignments ?? [] }]
                    : [];
            })
            : [])
    ];
    const target = normalizeHitBuffTarget(action.target);
    return buffInputs.filter(input => isDisplayableHitBuff(input.buffId)).map(input => {
        const assignedBlackboard = Object.fromEntries(input.assignments.flatMap(assignment => {
            const key = String(assignment?.targetKey ?? '').trim();
            if (!key) return [];
            const value = assignment.direct
                ? assignment.directValue
                : blackboard[assignment.sourceKey];
            return [[key, value]];
        }));
        let effects = [];
        try {
            effects = data.catalogBuffEffects(input.buffId, { blackboard: assignedBlackboard });
        } catch {
            // A missing optional BuffData file must not erase the underlying hit.
            effects = [];
        }
        const statusKey = hitBuffStatusKey(input.buffId);
        const assignedTriggerScale = statusKey === 'originium-seal'
            ? Number(assignedBlackboard.atk_scale_trigger)
            : Number.NaN;
        return {
            id: input.buffId,
            displayName: displayNameForHitBuff(input.buffId),
            target,
            targetLabel: hitBuffTargetLabel(target),
            kind: hitBuffKind(input.buffId),
            ...(statusKey
                ? { statusKey }
                : {}),
            ...(Number.isFinite(assignedTriggerScale) && assignedTriggerScale > 0
                ? { statusValue: assignedTriggerScale }
                : {}),
            ...(effects.length > 0 ? { effects } : {}),
            description: `AKE 命中动作 · ${hitBuffTargetLabel(target)} · ${input.buffId}`
        };
    });
}

function metadataHitBuffs(metadata, offsetFrames = null) {
    return (metadata ?? []).flatMap(item => {
        if (item?.category !== 'combat-status' || !item.statusKey) return [];
        // Fixed-dummy/profile probes describe a living target.  OnlyDead
        // actions are post-mortem presentation/control branches and must not
        // be projected as a second live combat-status application.
        if (item.deadOption === 'OnlyDead') return [];
        const marker = AKE_COMBAT_STATUS_MARKERS[item.statusKey];
        if (!marker) return [];
        return [{
            ...marker,
            target: 'target',
            targetLabel: '目标',
            kind: 'status',
            statusKey: item.statusKey,
            ...(Number.isFinite(Number(offsetFrames))
                ? { offsetFrames: Number(offsetFrames) }
                : {}),
            description: `AKE 物理异常动作 · ${item.type}`
        }];
    });
}

function poiseHitBuffs(action, blackboard) {
    const poiseUnits = (action?.damageUnits ?? []).filter(unit =>
        ['Poise', 'Resilience'].includes(unit?.damageAttributeType));
    if (poiseUnits.length === 0) return [];
    const amount = poiseUnits.reduce((sum, unit) => {
        const value = Number(resolveValue(unit.poiseValue ?? unit.scale, blackboard, 0));
        return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    return [{
        id: 'ake_status_poise_damage',
        displayName: amount > 0 ? `失衡值 ${amount}` : '失衡值',
        target: 'target',
        targetLabel: '目标',
        kind: 'status',
        statusKey: 'poise-damage',
        statusValue: amount,
        description: amount > 0
            ? `本次命中造成 ${amount} 点失衡值；是否进入失衡由木桩韧性结算决定。`
            : '本次命中包含失衡伤害；是否进入失衡由木桩韧性结算决定。'
    }];
}

function mergeHitBuffs(...groups) {
    return [...new Map(groups
        .flat()
        .map(buff => [`${buff.id}\u0000${buff.target}`, buff])).values()];
}

function nestedActionLists(action) {
    return [
        ...['actions', 'success', 'failure', 'children', 'steps']
            .flatMap(key => Array.isArray(action?.[key]) ? [action[key]] : []),
        ...['onApplyTargetActions', 'onRemoveTargetActions']
            .flatMap(key => Array.isArray(action?.definition?.[key])
                ? [action.definition[key]]
                : [])
    ];
}

const ATTRIBUTE_TOKEN_KEYS = Object.freeze({
    str: 'Str',
    strength: 'Str',
    agi: 'Agi',
    agility: 'Agi',
    wisd: 'Wisd',
    wisdom: 'Wisd',
    intelligence: 'Wisd',
    will: 'Will'
});

function inferredAttributeComparisonBlackboards(programs, attributes) {
    const values = {};
    const seen = new Set();
    const visit = value => {
        if (!isRecord(value) && !Array.isArray(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        for (const candidate of [value.blackboardKey, value.key]) {
            if (typeof candidate !== 'string') continue;
            const match = /^EntityBB_([a-z]+)_greater_([a-z]+)$/i.exec(candidate);
            if (!match) continue;
            const leftKey = ATTRIBUTE_TOKEN_KEYS[match[1].toLowerCase()];
            const rightKey = ATTRIBUTE_TOKEN_KEYS[match[2].toLowerCase()];
            if (!leftKey || !rightKey) continue;
            values[candidate] = Number(attributes[leftKey] ?? 0)
                >= Number(attributes[rightKey] ?? 0) ? 1 : 0;
        }
        Object.values(value).forEach(visit);
    };
    programs.forEach(visit);
    return values;
}

function staticValue(descriptor, blackboard, attributes = {}) {
    if (descriptor === null || descriptor === undefined) return descriptor;
    if (typeof descriptor === 'number' || typeof descriptor === 'boolean') return descriptor;
    if (typeof descriptor === 'string') {
        if (descriptor.startsWith('$')) return blackboard[descriptor.slice(1)];
        return descriptor;
    }
    if (!isRecord(descriptor)) return descriptor;
    if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
        return blackboard[descriptor.blackboardKey] ?? descriptor.value;
    }
    const type = String(descriptor.type ?? descriptor.kind ?? '').toLowerCase();
    if (type === 'blackboard') {
        return blackboard[descriptor.key ?? descriptor.path ?? descriptor.name]
            ?? descriptor.default;
    }
    if (type === 'attribute') {
        return attributes[descriptor.key ?? descriptor.attribute ?? descriptor.name]
            ?? descriptor.default;
    }
    if (['add', 'multiply', 'subtract', 'divide', 'min', 'max'].includes(type)) {
        const operands = descriptor.values ?? descriptor.operands
            ?? [descriptor.left, descriptor.right];
        if (!Array.isArray(operands) || operands.length === 0) return undefined;
        const values = operands.map(operand => Number(staticValue(
            operand,
            blackboard,
            attributes
        )));
        if (values.some(value => !Number.isFinite(value))) return undefined;
        if (type === 'add') return values.reduce((sum, value) => sum + value, 0);
        if (type === 'multiply') return values.reduce((product, value) => product * value, 1);
        if (type === 'subtract') {
            return values.slice(1).reduce((value, operand) => value - operand, values[0]);
        }
        if (type === 'divide') {
            if (values.slice(1).some(value => value === 0)) return undefined;
            return values.slice(1).reduce((value, operand) => value / operand, values[0]);
        }
        if (type === 'min') return Math.min(...values);
        if (type === 'max') return Math.max(...values);
    }
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) return descriptor.value;
    return undefined;
}

function staticCompare(left, operator, right) {
    const normalized = String(operator ?? 'EQ').toUpperCase();
    if (normalized === 'GT' || normalized === '>') return left > right;
    if (normalized === 'GE' || normalized === '>=') return left >= right;
    if (normalized === 'LT' || normalized === '<') return left < right;
    if (normalized === 'LE' || normalized === '<=') return left <= right;
    if (['EQ', 'EQUALS', '=', '==='].includes(normalized)) return left === right;
    if (['NE', 'NOTEQUALS', '!=', '!=='].includes(normalized)) return left !== right;
    if (normalized === 'IN') return Array.isArray(right) ? right.includes(left) : false;
    if (normalized === 'NOTIN') return Array.isArray(right) ? !right.includes(left) : false;
    return null;
}

function staticConditionValue(descriptor, blackboard, attributes = {}) {
    if (!isRecord(descriptor)) return staticValue(descriptor, blackboard, attributes);
    if (descriptor.useBlackboardKey && descriptor.blackboardKey
        && !Object.prototype.hasOwnProperty.call(blackboard, descriptor.blackboardKey)) {
        return undefined;
    }
    const type = String(descriptor.type ?? descriptor.kind ?? '').toLowerCase();
    if (type === 'blackboard') {
        const key = descriptor.key ?? descriptor.path ?? descriptor.name;
        if (!Object.prototype.hasOwnProperty.call(blackboard, key)) return undefined;
    }
    if (['add', 'multiply', 'subtract', 'divide', 'min', 'max'].includes(type)) {
        const operands = descriptor.values ?? descriptor.operands
            ?? [descriptor.left, descriptor.right];
        if (!Array.isArray(operands) || operands.length === 0) return undefined;
        const resolved = operands.map(operand => staticConditionValue(
            operand,
            blackboard,
            attributes
        ));
        if (resolved.includes(undefined)) return undefined;
    }
    return staticValue(descriptor, blackboard, attributes);
}

function evaluateStaticCondition(condition, blackboard, attributes = {}) {
    if (!isRecord(condition)) return null;
    if (condition.type === 'Compare') {
        const left = staticConditionValue(condition.left, blackboard, attributes);
        const right = staticConditionValue(condition.right, blackboard, attributes);
        if (left === undefined || right === undefined) return null;
        return staticCompare(left, condition.operator, right);
    }
    if (condition.type === 'Not') {
        const child = evaluateStaticCondition(condition.condition, blackboard, attributes);
        return child === null ? null : !child;
    }
    if (condition.type === 'All' || condition.type === 'Any') {
        const values = (condition.conditions ?? []).map(child =>
            evaluateStaticCondition(child, blackboard, attributes));
        if (condition.type === 'All') {
            if (values.includes(false)) return false;
            return values.every(value => value === true) ? true : null;
        }
        if (values.includes(true)) return true;
        return values.every(value => value === false) ? false : null;
    }
    return null;
}

function evaluateStaticConditions(conditions, blackboard, attributes = {}) {
    const values = (conditions ?? []).map(condition =>
        evaluateStaticCondition(condition, blackboard, attributes));
    if (values.includes(false)) return false;
    return values.every(value => value === true) ? true : null;
}

function applyStaticBlackboardAction(action, blackboard, attributes = {}) {
    if (action.type === 'AssignBlackboardValues') {
        for (const entry of action.entries ?? []) {
            if (!entry?.key) continue;
            blackboard[entry.key] = staticValue(entry.value, blackboard, attributes)
                ?? blackboard[entry.key];
        }
        return;
    }
    if (action.type === 'StoreAttributeValue' && action.key) {
        const attribute = Number(attributes[action.attribute] ?? 0);
        const divisor = Number(staticValue(action.divisor, blackboard, attributes) ?? 1);
        const multiplier = Number(staticValue(action.multiplier, blackboard, attributes) ?? 1);
        const baseValue = Number(staticValue(action.baseValue, blackboard, attributes) ?? 0);
        if ([attribute, divisor, multiplier, baseValue].every(Number.isFinite) && divisor !== 0) {
            const value = attribute / divisor * multiplier + baseValue;
            blackboard[action.key] = action.useFloor ? Math.floor(value) : value;
        }
        return;
    }
    if (action.type !== 'ModifyBlackboard' && action.type !== 'CalculateBlackboard') return;
    const key = action.key;
    if (!key) return;
    const current = Number(blackboard[key] ?? 0);
    const right = Number(staticValue(
        action.type === 'CalculateBlackboard' ? action.right : action.value,
        blackboard,
        attributes
    ));
    const left = action.type === 'CalculateBlackboard'
        ? Number(staticValue(action.left, blackboard, attributes) ?? current)
        : current;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return;
    const operation = action.operation;
    if (operation === 'Assign') blackboard[key] = right;
    else if (operation === 'Add') blackboard[key] = left + right;
    else if (operation === 'Subtract') blackboard[key] = left - right;
    else if (operation === 'Multiply') blackboard[key] = left * right;
    else if (operation === 'Divide' && right !== 0) blackboard[key] = left / right;
}

function compiledDamagePackets(program, blackboard, data, attributes = {}) {
    const packets = [];
    // AKE 会把同一帧的伤害与物理异常动作拆到两个 timeline group。
    // 只读当前 group 会令状态退化成 skill-wide marker，前端随后只能把它
    // 错挂到每一段 Hit。先按真实帧合并 metadata，状态就能落回对应伤害包。
    const frameHitBuffs = new Map();
    for (const group of program?.timeline ?? []) {
        const frame = Number(group.startFrame ?? 0);
        frameHitBuffs.set(frame, mergeHitBuffs(
            frameHitBuffs.get(frame) ?? [],
            metadataHitBuffs(group.metadata, frame)
        ));
    }
    for (const group of program?.timeline ?? []) {
        let actionOrder = 0;
        const groupFrame = Number(group.startFrame ?? 0);
        const groupHitBuffs = mergeHitBuffs(
            frameHitBuffs.get(groupFrame - 1) ?? [],
            frameHitBuffs.get(groupFrame) ?? [],
            frameHitBuffs.get(groupFrame + 1) ?? []
        );
        const collectBlock = (
            actions,
            inheritedHitBuffs = groupHitBuffs,
            inheritedBlackboard = blackboard
        ) => {
            const blockBlackboard = { ...inheritedBlackboard };
            const actionBuffs = [];
            for (const action of actions ?? []) {
                if (!isRecord(action)) continue;
                applyStaticBlackboardAction(action, blockBlackboard, attributes);
                actionBuffs.push(...actionHitBuffs(action, blockBlackboard, data));
            }
            const blockHitBuffs = mergeHitBuffs(inheritedHitBuffs, actionBuffs);
            for (const action of actions ?? []) {
                if (!isRecord(action)) continue;
                if (action.type === 'ResolveDamagePacket') {
                    const hpUnits = (action.damageUnits ?? []).filter(unit =>
                        unit?.damageAttributeType === 'Hp');
                    if (hpUnits.length > 0) {
                        packets.push({
                            frame: Number(group.startFrame ?? 0),
                            actionOrder: actionOrder++,
                            hpUnits,
                            blackboard: { ...blockBlackboard },
                            hitBuffs: mergeHitBuffs(
                                blockHitBuffs,
                                poiseHitBuffs(action, blockBlackboard)
                            )
                        });
                    }
                }
                if (action.type === 'IfElseAction') {
                    const outcome = evaluateStaticConditions(
                        action.conditions,
                        blockBlackboard,
                        attributes
                    );
                    if (outcome !== false) {
                        collectBlock(action.success, blockHitBuffs, blockBlackboard);
                    }
                    if (outcome !== true) {
                        collectBlock(action.failure, blockHitBuffs, blockBlackboard);
                    }
                    continue;
                }
                for (const childActions of nestedActionLists(action)) {
                    collectBlock(childActions, blockHitBuffs, blockBlackboard);
                }
            }
        };
        collectBlock(group.actions);
    }
    return packets.sort((left, right) =>
        left.frame - right.frame || left.actionOrder - right.actionOrder);
}

function isProfileStatusEffect(effect) {
    // A skill-level ApplyBuff is meaningful state even when its BuffData uses
    // listeners instead of a directly numeric modifier. Resource receipts are
    // shown on the resource lane and should not masquerade as target state.
    return effect.kind !== 'resource';
}

function compiledProgramStatusEffects(program, blackboard, data, attributes = {}) {
    const effects = [];
    for (const group of program?.timeline ?? []) {
        effects.push(...metadataHitBuffs(group.metadata, group.startFrame));
        const visit = (actions, inheritedBlackboard = blackboard) => {
            const branchBlackboard = { ...inheritedBlackboard };
            for (const action of actions ?? []) {
                if (!isRecord(action)) continue;
                applyStaticBlackboardAction(action, branchBlackboard, attributes);
                effects.push(...actionHitBuffs(action, branchBlackboard, data));
                if (action.type === 'ResolveDamagePacket') {
                    effects.push(...poiseHitBuffs(action, branchBlackboard));
                }
                if (action.type === 'IfElseAction') {
                    const outcome = evaluateStaticConditions(
                        action.conditions,
                        branchBlackboard,
                        attributes
                    );
                    if (outcome !== false) visit(action.success, branchBlackboard);
                    if (outcome !== true) visit(action.failure, branchBlackboard);
                    continue;
                }
                for (const childActions of nestedActionLists(action)) {
                    visit(childActions, branchBlackboard);
                }
            }
        };
        visit(group.actions);
    }
    return mergeHitBuffs(effects.filter(isProfileStatusEffect));
}

function finiteResolvedValue(descriptor, blackboard, fallback) {
    const value = Number(resolveValue(descriptor, blackboard, fallback));
    return Number.isFinite(value) ? value : fallback;
}

function packetMultiplier(packet, blackboard) {
    return packet.hpUnits.reduce((sum, unit) => {
        const scale = finiteResolvedValue(unit.scale, blackboard, 0);
        const calculationMultiplier = finiteResolvedValue(
            unit.calculationMultiplier,
            blackboard,
            1
        );
        return sum + scale * calculationMultiplier;
    }, 0);
}

function groupDamagePacketsByFrame(packets) {
    const groups = new Map();
    for (const packet of packets) {
        const frame = Number(packet.frame ?? 0);
        const current = groups.get(frame) ?? {
            frame,
            packets: [],
            hitBuffs: []
        };
        current.packets.push(packet);
        current.hitBuffs = mergeHitBuffs(current.hitBuffs, packet.hitBuffs);
        groups.set(frame, current);
    }
    return [...groups.values()].sort((left, right) => left.frame - right.frame);
}

function observedRuntimeMultiplier(readProgram, timingHit, level) {
    const observed = Number(timingHit.observedAtkScale);
    if (!Number.isFinite(observed) || observed <= 0) return null;
    const rootAtM3 = readProgram(timingHit.rootSkillId, AKE_SKILL_LEVEL_KEYS.length);
    const candidates = Object.entries(rootAtM3?.blackboard ?? {})
        .filter(([, value]) => Number.isFinite(Number(value))
            && Math.abs(Number(value) - observed) <= 1e-7)
        .sort(([left], [right]) => {
            const score = key => (/atk.*scale|scale.*atk/i.test(key) ? 10 : 0)
                + (/runtime|final/i.test(key) ? 2 : 0);
            return score(right) - score(left) || left.localeCompare(right);
        });
    const inferredKey = candidates[0]?.[0] ?? null;
    if (inferredKey) {
        const levelValue = Number(readProgram(timingHit.rootSkillId, level)
            ?.blackboard?.[inferredKey]);
        if (Number.isFinite(levelValue) && levelValue > 0) {
            return {
                multiplier: levelValue,
                derivation: `runtime-observed-root-blackboard:${inferredKey}`
            };
        }
    }
    return {
        multiplier: observed,
        derivation: 'runtime-observed-atk-scale'
    };
}

function safeSkillPath(projectRoot, skillId) {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(String(skillId ?? ''))) return null;
    const skillDirectory = path.resolve(
        projectRoot,
        'reference',
        'public-data',
        'akedata',
        'Json',
        'SkillData'
    );
    const candidate = path.resolve(skillDirectory, `${skillId}.json`);
    return candidate.startsWith(`${skillDirectory}${path.sep}`) ? candidate : null;
}

function loadSemanticMappings(projectRoot) {
    const semanticPath = path.resolve(projectRoot, 'spec', 'engine-semantic-mappings.json');
    if (!fs.existsSync(semanticPath)) return {};
    return JSON.parse(fs.readFileSync(semanticPath, 'utf8'));
}

function createProgramReader(projectRoot) {
    const data = new AkeDataRepository({ projectRoot });
    const skillPatchTable = data.table('SkillPatchTable');
    const rawSkillCache = new Map();
    const programCache = new Map();
    const compiler = new AkeActionCompiler({
        semanticMappings: loadSemanticMappings(projectRoot),
        targetMappings: { Context: 'Target' },
        capabilities: {
            damageResolver: true,
            skillProgramResolver: true,
            timeDilationResolver: true
        }
    });

    const readRawSkill = skillId => {
        if (rawSkillCache.has(skillId)) return rawSkillCache.get(skillId);
        const skillPath = safeSkillPath(projectRoot, skillId);
        const raw = skillPath && fs.existsSync(skillPath)
            ? parseAkeJson(fs.readFileSync(skillPath, 'utf8'))
            : null;
        rawSkillCache.set(skillId, raw);
        return raw;
    };

    const readProgram = (skillId, level) => {
        const cacheKey = `${skillId}\u0000${level}`;
        if (programCache.has(cacheKey)) return programCache.get(cacheKey);
        const raw = readRawSkill(skillId);
        const program = raw
            ? compiler.compileSkill(raw, skillPatchTable[skillId], { level, tickRate: 30 })
            : null;
        programCache.set(cacheKey, program);
        return program;
    };
    return { readProgram, data };
}

function profileHitMultiplier(
    readProgram,
    data,
    timingHit,
    sourceOccurrenceIndex,
    level,
    staticContext = {}
) {
    const sourceProgram = readProgram(timingHit.sourceSkillId, level);
    const rootProgram = readProgram(timingHit.rootSkillId, level);
    const effectiveBlackboard = {
        ...(sourceProgram?.blackboard ?? {}),
        ...(rootProgram?.blackboard ?? {}),
        ...(staticContext.blackboard ?? {})
    };
    const packets = compiledDamagePackets(
        sourceProgram,
        effectiveBlackboard,
        data,
        staticContext.attributes
    );
    const packetGroups = groupDamagePacketsByFrame(packets);
    if (packetGroups.length > 0) {
        // A projectile SkillData can be launched repeatedly by the same root. In
        // that case the timing list has more entries than the child has damage
        // frames, so cycle through the child's frame groups for each launch.
        const packetGroup = packetGroups[sourceOccurrenceIndex % packetGroups.length];
        const rootHitOffset = Number(timingHit.offsetFrames ?? 0);
        const launchOffset = Number(timingHit.launchOffsetFrames);
        const localHitOffset = Number.isFinite(launchOffset)
            ? rootHitOffset - launchOffset
            : rootHitOffset;
        const hitBuffs = packetGroup.hitBuffs.filter(buff => (
            !Number.isFinite(Number(buff.offsetFrames))
            || Math.abs(Number(buff.offsetFrames) - localHitOffset) <= 1
        ));
        const firstUnit = packetGroup.packets
            .flatMap(packet => packet.hpUnits)
            .find(Boolean);
        const compiledMultiplier = packetGroup.packets.reduce((sum, packet) => (
            sum + packetMultiplier(packet, packet.blackboard ?? effectiveBlackboard)
        ), 0);
        const observed = observedRuntimeMultiplier(readProgram, timingHit, level);
        const shouldUseObserved = observed
            && Math.abs(compiledMultiplier - observed.multiplier) > 1e-7;
        return {
            multiplier: shouldUseObserved ? observed.multiplier : compiledMultiplier,
            damageType: firstUnit?.damageType ?? null,
            hitBuffs,
            derivation: shouldUseObserved
                ? observed.derivation
                : 'compiled-damage-packet'
        };
    }

    const observed = observedRuntimeMultiplier(readProgram, timingHit, level);
    const fallback = Number(rootProgram?.blackboard?.atk_scale);
    return {
        multiplier: observed?.multiplier
            ?? (Number.isFinite(fallback) ? fallback : 0),
        damageType: timingHit.damageTypes?.find(type => type !== 'Physical')
            ?? timingHit.damageTypes?.[0]
            ?? null,
        hitBuffs: [],
        derivation: observed?.derivation
            ?? (Number.isFinite(fallback)
                ? 'root-blackboard-fallback'
                : 'unverified')
    };
}

/**
 * Adds calculation-ready hit multipliers to the already-derived timing catalog.
 *
 * The timing artifact remains the source of truth for which hit actually occurs.
 * Each hit's multiplier is then resolved from the compiled DamageAction packet at
 * all twelve skill levels. Projectile children receive the root skill blackboard,
 * matching CombatRuntime's inheritBlackboard behavior.
 */
export function enrichAkeTimingWithHitMultipliers({ projectRoot, timing }) {
    if (!isRecord(timing?.characters)) return structuredClone(timing);
    const resolvedRoot = path.resolve(projectRoot);
    const { readProgram, data } = createProgramReader(resolvedRoot);
    const enriched = structuredClone(timing);
    const characterCatalog = new Map(data.catalog().characters.map(character => [
        character.id,
        character
    ]));

    for (const [characterId, character] of Object.entries(enriched.characters)) {
        const sourceCharacter = characterCatalog.get(characterId);
        const level90 = sourceCharacter?.attributes?.level90 ?? {};
        const attributes = {
            Str: Number(level90.strength ?? 0),
            Agi: Number(level90.agility ?? 0),
            Wisd: Number(level90.intelligence ?? 0),
            Will: Number(level90.will ?? 0),
            Atk: Number(level90.atk ?? 0),
            MaxHp: Number(level90.hp ?? 0)
        };
        const characterPrograms = [...new Set((character.profiles ?? []).flatMap(profile => [
            profile.skillId,
            ...(profile.hits ?? []).map(hit => hit.sourceSkillId)
        ]))].map(skillId => readProgram(skillId, AKE_SKILL_LEVEL_KEYS.length));
        const staticContext = {
            attributes,
            blackboard: inferredAttributeComparisonBlackboards(characterPrograms, attributes)
        };
        for (const profile of character.profiles ?? []) {
            const statusProgramIds = [...new Set([
                profile.skillId,
                ...(profile.hits ?? []).map(hit => hit.sourceSkillId)
            ])];
            const resolvedStatusLevels = AKE_SKILL_LEVEL_KEYS.map((levelKey, index) => [
                levelKey,
                mergeHitBuffs(...statusProgramIds.map(skillId => {
                    const program = readProgram(skillId, index + 1);
                    return compiledProgramStatusEffects(
                        program,
                        {
                            ...(program?.blackboard ?? {}),
                            ...staticContext.blackboard
                        },
                        data,
                        attributes
                    );
                }))
            ]);
            profile.statusEffects = (resolvedStatusLevels[0]?.[1] ?? []).map(statusEffect => {
                const statusValueLevels = Object.fromEntries(
                    resolvedStatusLevels.flatMap(([levelKey, effects]) => {
                        const matching = effects.find(candidate => (
                            candidate.id === statusEffect.id
                            && candidate.target === statusEffect.target
                            && candidate.statusKey === statusEffect.statusKey
                        ));
                        return Number.isFinite(Number(matching?.statusValue))
                            ? [[levelKey, Number(matching.statusValue)]]
                            : [];
                    })
                );
                return Object.keys(statusValueLevels).length > 0
                    ? { ...statusEffect, statusValueLevels }
                    : statusEffect;
            });
            const sourceOccurrences = new Map();
            profile.hits = (profile.hits ?? []).map(timingHit => {
                const occurrenceIndex = sourceOccurrences.get(timingHit.sourceSkillId) ?? 0;
                sourceOccurrences.set(timingHit.sourceSkillId, occurrenceIndex + 1);
                const resolvedLevels = AKE_SKILL_LEVEL_KEYS.map((levelKey, index) => [
                    levelKey,
                    profileHitMultiplier(
                        readProgram,
                        data,
                        timingHit,
                        occurrenceIndex,
                        index + 1,
                        staticContext
                    )
                ]);
                const firstResolved = resolvedLevels[0]?.[1];
                const derivations = [...new Set(resolvedLevels.map(([, value]) => value.derivation))];
                const leveledHitBuffs = (firstResolved?.hitBuffs ?? []).map(hitBuff => {
                    const statusValueLevels = Object.fromEntries(resolvedLevels.flatMap(([levelKey, value]) => {
                        const matching = value.hitBuffs.find(candidate => (
                            candidate.id === hitBuff.id
                            && candidate.target === hitBuff.target
                            && candidate.statusKey === hitBuff.statusKey
                        ));
                        return Number.isFinite(Number(matching?.statusValue))
                            ? [[levelKey, Number(matching.statusValue)]]
                            : [];
                    }));
                    return Object.keys(statusValueLevels).length > 0
                        ? { ...hitBuff, statusValueLevels }
                        : hitBuff;
                });
                return {
                    ...timingHit,
                    damageType: firstResolved?.damageType ?? null,
                    hitBuffs: leveledHitBuffs,
                    levels: Object.fromEntries(resolvedLevels.map(([levelKey, value]) => [
                        levelKey,
                        value.multiplier
                    ])),
                    multiplierDerivation: derivations.length === 1
                        ? derivations[0]
                        : derivations.join('+')
                };
            });
            // ApplyBuff/physical-status actions are often siblings of the HP
            // packet rather than nested inside it.  Keep them in the skill-wide
            // audit list, but also project every still-unassigned effect onto
            // the final real hit.  The frontend consumes hit settlements, so
            // leaving these effects only on profile.statusEffects made real
            // vulnerability, NoGuard, Crush and Originium events invisible.
            if (profile.hits.length > 0) {
                const projectedKeys = new Set(profile.hits.flatMap(hit => (
                    (hit.hitBuffs ?? []).map(effect => `${effect.id}\u0000${effect.target}`)
                )));
                const unprojected = profile.statusEffects.filter(effect => (
                    !projectedKeys.has(`${effect.id}\u0000${effect.target}`)
                ));
                const finalHit = profile.hits[profile.hits.length - 1];
                finalHit.hitBuffs = mergeHitBuffs(finalHit.hitBuffs, unprojected);
            }
        }
    }

    return enriched;
}

export default enrichAkeTimingWithHitMultipliers;
