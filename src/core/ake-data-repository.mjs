import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeLoadoutCompiler } from './ake-loadout-compiler.mjs';
import { evaluateAttributeComponent } from './attribute.mjs';

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(modulePath), '..', '..');

export const AKE_DATA_ORIGIN = 'https://data.akedata.wiki';

export const AKE_ATTRIBUTE_NAMES = Object.freeze([
    'Level', 'MaxHp', 'Atk', 'Def', 'PhysicalDamageTakenScalar',
    'FireDamageTakenScalar', 'PulseDamageTakenScalar', 'CrystDamageTakenScalar',
    'Weight', 'CriticalRate', 'CriticalDamageIncrease', 'Hatred',
    'NormalAttackRange', 'MoveSpeedScalar', 'TurnRateScalar', 'AttackRate',
    'SkillCooldownScalar', 'NormalAttackDamageIncrease', 'HpRecoveryPerSec',
    'HpRecoveryPerSecByMaxHpRatio', 'MaxPoise', 'PoiseRecTime', 'MaxUltimateSp',
    'ComboSkillCooldownFinalAddition', 'PoiseDamageTakenScalar',
    'PhysicalInflictionDamageScalar', 'PoiseDamageOutputScalar',
    'BreakingAttackDamageTakenScalar', 'UltimateSkillDamageIncrease',
    'HealOutputIncrease', 'HealTakenIncrease', 'PoiseRecTimeScalar',
    'NormalSkillDamageIncrease', 'ComboSkillDamageIncrease', 'KnockDownTimeAddition',
    'FireBurstDamageIncrease', 'PulseBurstDamageIncrease', 'CrystBurstDamageIncrease',
    'NaturalBurstDamageIncrease', 'Str', 'Agi', 'Wisd', 'Will', 'LifeSteal',
    'UltimateSpGainScalar', 'AtbCostAddition', 'NormalSkillCooldownAddition',
    'ComboSkillCooldownScalar', 'NaturalDamageTakenScalar', 'IgniteDamageScalar',
    'PhysicalDamageIncrease', 'FireDamageIncrease', 'PulseDamageIncrease',
    'CrystDamageIncrease', 'NaturalDamageIncrease', 'EtherDamageIncrease',
    'FireAbnormalDamageIncrease', 'PulseAbnormalDamageIncrease',
    'CrystAbnormalDamageIncrease', 'NaturalAbnormalDamageIncrease',
    'EtherDamageTakenScalar', 'DamageToBrokenUnitIncrease', 'WeaknessDmgScalar',
    'ShelterDmgScalar', 'PhysicalEnhancedDmgIncrease', 'FireEnhancedDmgIncrease',
    'PulseEnhancedDmgIncrease', 'CrystEnhancedDmgIncrease',
    'NaturalEnhancedDmgIncrease', 'EtherEnhancedDmgIncrease',
    'PhysicalVulnerableDmgIncrease', 'FireVulnerableDmgIncrease',
    'PulseVulnerableDmgIncrease', 'CrystVulnerableDmgIncrease',
    'NaturalVulnerableDmgIncrease', 'EtherVulnerableDmgIncrease',
    'AtkIncreaseFactorFromStr', 'AtkIncreaseFactorFromAgi',
    'AtkIncreaseFactorFromWisd', 'AtkIncreaseFactorFromWill',
    'PhysicalDmgResistScalar', 'NaturalDmgResistScalar', 'CrystDmgResistScalar',
    'PulseDmgResistScalar', 'FireDmgResistScalar', 'EtherDmgResistScalar',
    'SlowActionSpeedScalar', 'PhysicalAndSpellInflictionEnhance',
    'ShieldOutputIncrease', 'ShieldTakenIncrease', 'NormalAttackStartRange',
    'InAirMoveSpeedScalar', 'KeywordSpeedUpScalar',
    'ComboSkillCooldownRecoveryScalar', 'PhysicalResistance', 'NaturalResistance',
    'CrystResistance', 'PulseResistance', 'FireResistance', 'EtherResistance',
    'ComboSkillCooldownDecrease'
]);

export const AKE_MODIFIER_ZONES = Object.freeze({
    0: 'Addition',
    1: 'Multiplier',
    3: 'FinalAddition',
    4: 'FinalMultiplier',
    5: 'BaseAddition',
    6: 'BaseMultiplier',
    7: 'BaseFinalAddition',
    8: 'BaseFinalMultiplier'
});

export const AKE_WEAPON_TYPES = Object.freeze({
    1: '单手剑',
    2: '施术单元',
    3: '双手剑',
    5: '长柄武器',
    6: '手铳'
});

export const AKE_PROFESSIONS = Object.freeze({
    0: '近卫',
    2: '重装',
    4: '辅助',
    5: '术师',
    7: '先锋',
    8: '突击'
});

export const AKE_ELEMENTS = Object.freeze({
    Physical: '物理',
    Fire: '灼热',
    Pulse: '电磁',
    Cryst: '寒冷',
    Natural: '自然'
});

export const AKE_ABILITY_LABELS = Object.freeze({
    39: '力量',
    40: '敏捷',
    41: '智识',
    42: '意志'
});

export const AKE_EQUIPMENT_PARTS = Object.freeze({
    0: { key: 'body', name: '护甲', maximum: 1 },
    1: { key: 'hand', name: '护手', maximum: 1 },
    2: { key: 'edc', name: '配件', maximum: 2 }
});

const SKILL_GROUP_TYPES = Object.freeze({
    0: 'Attack',
    1: 'NormalSkill',
    2: 'UltimateSkill',
    3: 'ComboSkill'
});

function clampInteger(value, minimum, maximum, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return number;
}

/** Preserve signed Int64 text ids before JSON.parse rounds them. */
export function parseAkeJson(text) {
    return JSON.parse(String(text).replace(
        /("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g,
        '$1"$2"'
    ));
}

function attributeObject(entries = []) {
    const result = {};
    for (const entry of entries) {
        const type = Number(entry?.attrType);
        const value = Number(entry?.attrValue);
        if (!Number.isInteger(type) || !Number.isFinite(value)) continue;
        result[`Attr${type}`] = value;
        const name = AKE_ATTRIBUTE_NAMES[type];
        if (name) result[name] = value;
    }
    return result;
}

function emptyAttributeComponent(rawValue = 0) {
    return {
        rawValue: Number(rawValue) || 0,
        baseAddition: 0,
        baseMultiplier: 1,
        baseFinalAddition: 0,
        baseFinalMultiplier: 1,
        addition: 0,
        multiplier: 1,
        finalAddition: 0,
        finalMultiplier: 1
    };
}

function canonicalAttributeName(attribute, attrType) {
    return attribute
        ?? AKE_ATTRIBUTE_NAMES[Number(attrType)]
        ?? `Attr${attrType}`;
}

/**
 * Builds Calc/AKE's nine-field attribute components without collapsing zone
 * identity.  BaseMultiplier and Multiplier are additive percentage zones;
 * BaseFinalMultiplier and FinalMultiplier are factor zones and therefore
 * multiply.  Keeping this structure is required for later runtime Buffs to
 * enter the correct zone instead of multiplying an already-final panel value.
 */
export function buildAkeAttributeComponents(baseAttributes, modifiers = []) {
    const components = {};
    for (const [attribute, rawValue] of Object.entries(baseAttributes ?? {})) {
        const rawType = /^Attr(\d+)$/.exec(attribute)?.[1];
        const named = rawType === undefined ? null : AKE_ATTRIBUTE_NAMES[Number(rawType)];
        if (named && Object.hasOwn(baseAttributes, named)) continue;
        components[attribute] = emptyAttributeComponent(rawValue);
    }
    for (const modifier of modifiers) {
        const attribute = canonicalAttributeName(modifier.attribute, modifier.attrType);
        const rawType = Number(modifier.attrType);
        const rawValue = Number(
            baseAttributes?.[attribute]
                ?? (Number.isInteger(rawType) ? baseAttributes?.[`Attr${rawType}`] : 0)
                ?? 0
        );
        const component = components[attribute]
            ?? (components[attribute] = emptyAttributeComponent(rawValue));
        const operand = Number(modifier.value ?? modifier.attrValue ?? 0);
        if (!Number.isFinite(operand)) continue;
        switch (Number(modifier.modifierType)) {
            case 5: component.baseAddition += operand; break;
            case 6: component.baseMultiplier += operand; break;
            case 7: component.baseFinalAddition += operand; break;
            case 8: component.baseFinalMultiplier *= operand; break;
            case 3: component.finalAddition += operand; break;
            case 4: component.finalMultiplier *= operand; break;
            case 0: component.addition += operand; break;
            case 1: component.multiplier += operand; break;
            default: break;
        }
    }
    return components;
}

export function evaluateAkeAttributeComponents(components) {
    const result = {};
    for (const [attribute, component] of Object.entries(components ?? {})) {
        const value = evaluateAttributeComponent(component).value;
        result[attribute] = value;
        const namedType = AKE_ATTRIBUTE_NAMES.indexOf(attribute);
        if (namedType >= 0) result[`Attr${namedType}`] = value;
    }
    return result;
}

export function applyAkeAttributeModifiers(baseAttributes, modifiers = []) {
    return evaluateAkeAttributeComponents(
        buildAkeAttributeComponents(baseAttributes, modifiers)
    );
}

export function akeDerivedAbilityModifiers(attributes, { mainAttrType, subAttrType }) {
    const valueOf = attrType => Math.floor(Number(
        attributes[AKE_ATTRIBUTE_NAMES[attrType]]
            ?? attributes[`Attr${attrType}`]
            ?? 0
    ));
    const main = valueOf(Number(mainAttrType));
    const sub = valueOf(Number(subAttrType));
    const strength = valueOf(39);
    const agility = valueOf(40);
    const wisdom = valueOf(41);
    const will = valueOf(42);
    const resistance = ability => 100 - (100 / (1 + 0.001 * ability));
    return [
        {
            attribute: 'Atk', attrType: 2, modifierType: 8,
            zone: 'BaseFinalMultiplier', value: 1 + main * 0.005 + sub * 0.002,
            source: 'AKEDatabase:DerivedAbility:Attack'
        },
        {
            attribute: 'MaxHp', attrType: 1, modifierType: 7,
            zone: 'BaseFinalAddition', value: strength * 5,
            source: 'AKEDatabase:DerivedAbility:Strength'
        },
        {
            attribute: 'PhysicalResistance', attrType: 94, modifierType: 7,
            zone: 'BaseFinalAddition', value: resistance(agility),
            source: 'AKEDatabase:DerivedAbility:Agility'
        },
        ...[95, 96, 97, 98].map(attrType => ({
            attribute: AKE_ATTRIBUTE_NAMES[attrType], attrType, modifierType: 7,
            zone: 'BaseFinalAddition', value: resistance(wisdom),
            source: 'AKEDatabase:DerivedAbility:Wisdom'
        })),
        {
            attribute: 'HealTakenIncrease', attrType: 30, modifierType: 7,
            zone: 'BaseFinalAddition', value: will * 0.001,
            source: 'AKEDatabase:DerivedAbility:Will'
        }
    ];
}

function blackboardAtLevel(skillPatch, level) {
    const bundle = skillPatch?.SkillPatchDataBundle ?? [];
    const selected = bundle.find(entry => Number(entry.level) === level)
        ?? bundle[Math.max(0, Math.min(bundle.length - 1, level - 1))]
        ?? null;
    return selected
        ? Object.fromEntries((selected.blackboard ?? []).map(entry => [
            entry.key,
            entry.valueStr !== '' && entry.valueStr !== undefined
                ? entry.valueStr
                : entry.value
        ]))
        : {};
}

function skillPatchAtLevel(skillPatch, level) {
    const bundle = skillPatch?.SkillPatchDataBundle ?? [];
    return bundle.find(entry => Number(entry.level) === level)
        ?? bundle[Math.max(0, Math.min(bundle.length - 1, level - 1))]
        ?? null;
}

function imageUrl(origin, directory, id) {
    if (!id) return '';
    return `${origin}/public/images/assets/beyond/dynamicassets/gameplay/ui/sprites/${directory}/${id}.png`;
}

function cleanAkeRichText(value = '') {
    return String(value)
        .replace(/<[@#][^>]*>/g, '')
        .replace(/<\/>/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function serializedAkeType(value) {
    return String(value?.$type ?? '').split(',')[0].split('+')[0].split('.').at(-1);
}

function akeBlackboardObject(entries = []) {
    return Object.fromEntries(entries.flatMap(entry => {
        const key = String(entry?.key ?? '').trim();
        if (!key) return [];
        return [[key, entry.valueStr !== '' && entry.valueStr !== undefined
            ? entry.valueStr
            : (entry.value ?? entry.valueDouble)]];
    }));
}

function akeDescriptorValue(descriptor, blackboard, fallback = 0) {
    if (descriptor === undefined || descriptor === null) return fallback;
    if (typeof descriptor === 'number' || typeof descriptor === 'string') return descriptor;
    if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
        return blackboard[descriptor.blackboardKey] ?? descriptor.value ?? fallback;
    }
    return descriptor.value ?? fallback;
}

const AKE_OPERATOR_ATTRIBUTE_BUFF_TYPES = Object.freeze({
    MaxHp: 'hpPercent',
    Atk: 'atkPercentBoost',
    CriticalRate: 'critRateBoost',
    CriticalDamageIncrease: 'critDmgBonusBoost',
    NormalAttackDamageIncrease: 'normalAttackDmgBonus',
    UltimateSkillDamageIncrease: 'ultimateDmgBonus',
    HealOutputIncrease: 'healingBonus',
    NormalSkillDamageIncrease: 'skillDmgBonus',
    ComboSkillDamageIncrease: 'chainSkillDmgBonus',
    Str: 'strengthBoost',
    Agi: 'agilityBoost',
    Wisd: 'intelligenceBoost',
    Will: 'willBoost',
    UltimateSpGainScalar: 'ultimateChargeEfficiency',
    PhysicalDamageIncrease: 'physicalDmgBonus',
    FireDamageIncrease: 'fireDmgBonus',
    PulseDamageIncrease: 'electricDmgBonus',
    CrystDamageIncrease: 'iceDmgBonus',
    NaturalDamageIncrease: 'natureDmgBonus',
    EtherDamageIncrease: 'magicDmgBonus',
    DamageToBrokenUnitIncrease: 'imbalanceDmgBonus',
    PhysicalAndSpellInflictionEnhance: 'sourceSkillBoost',
    PoiseDamageOutputScalar: 'imbalanceEfficiency'
});

const AKE_RESISTANCE_IGNORE_BUFF_TYPES = Object.freeze({
    PhysicalResistance: 'physicalResistanceIgnore',
    FireResistance: 'fireResistanceIgnore',
    PulseResistance: 'electricResistanceIgnore',
    CrystResistance: 'iceResistanceIgnore',
    NaturalResistance: 'natureResistanceIgnore'
});

// A defender-side NormalCalcZone contribution is the DEF calculator's
// “易伤” (Fragile) zone. Do not merge it with AKE VulnerableAction below.
const AKE_FRAGILE_BUFF_TYPES = Object.freeze({
    Physical: 'physicalFragile',
    Spell: 'magicFragile',
    Fire: 'fireFragile',
    Pulse: 'electricFragile',
    Cryst: 'iceFragile',
    Crystal: 'iceFragile',
    Natural: 'natureFragile'
});

// AKE VulnerableAction is the game's explicit “脆弱” status family. It is
// distinct from a defender-side NormalCalcZone contribution, which the DEF
// calculator calls “易伤”. Keeping both maps prevents UI vocabulary from
// silently merging two independent formula zones.
const AKE_VULNERABILITY_BUFF_TYPES = Object.freeze({
    Physical: 'physicalVulnerability',
    Spell: 'magicVulnerability',
    Fire: 'fireVulnerability',
    Pulse: 'electricVulnerability',
    Cryst: 'iceVulnerability',
    Crystal: 'iceVulnerability',
    Natural: 'natureVulnerability'
});

const AKE_DAMAGE_BONUS_BUFF_TYPES = Object.freeze({
    Physical: 'physicalDmgBonus',
    Spell: 'magicDmgBonus',
    Fire: 'fireDmgBonus',
    Pulse: 'electricDmgBonus',
    Cryst: 'iceDmgBonus',
    Natural: 'natureDmgBonus'
});

function fragileTypeFromDamageConditions(conditions = []) {
    const damageType = conditions.find(condition =>
        serializedAkeType(condition) === 'CheckDamageType')?.damageType;
    return AKE_FRAGILE_BUFF_TYPES[damageType] ?? null;
}

function damageBonusTypeFromDamageConditions(conditions = []) {
    const damageType = conditions.find(condition =>
        serializedAkeType(condition) === 'CheckDamageType')?.damageType;
    return AKE_DAMAGE_BONUS_BUFF_TYPES[damageType] ?? null;
}

function catalogAttributeEffect(attribute, formulaItem, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value === 0) return null;
    const type = AKE_OPERATOR_ATTRIBUTE_BUFF_TYPES[attribute];
    if (!type) return null;
    if (attribute === 'Atk' && formulaItem !== 'BaseMultiplier') {
        return { type: 'flatAtk', value, unit: 'flat' };
    }
    if (attribute === 'MaxHp' && formulaItem !== 'BaseMultiplier') {
        return { type: 'flatHp', value, unit: 'flat' };
    }
    return {
        type,
        value,
        unit: ['Str', 'Agi', 'Wisd', 'Will', 'PhysicalAndSpellInflictionEnhance']
            .includes(attribute) ? 'flat' : 'percent'
    };
}

function assignedAkeBlackboard(assignmentSource, blackboard) {
    const assignments = assignmentSource?.assignItems
        ?? assignmentSource?.assignments
        ?? [];
    return Object.fromEntries(assignments.flatMap(assignment => {
        const key = String(assignment?.targetKey ?? '').trim();
        if (!key) return [];
        const direct = assignment.useDirectValue ?? assignment.direct;
        const sourceKey = assignment.inputValueKey ?? assignment.sourceKey;
        let value = direct
            ? (assignment.directValueType === 'String'
                ? assignment.stringValue
                : (assignment.numericValue ?? assignment.directValue))
            : blackboard[sourceKey]
                ?? blackboard[key];
        // Several SkillData rows materialize `final_effect/final_time` only at
        // runtime from a base key plus its potential's `extra_*` key. Raw JSON
        // keeps those intermediate fields at zero, so reconstruct the declared
        // arithmetic instead of letting the placeholder erase the real M3 data.
        if (!direct && /^final_/.test(String(sourceKey ?? '')) && Number(value) === 0) {
            const suffix = String(sourceKey).slice('final_'.length);
            const base = Number(blackboard[key]);
            const extra = Number(blackboard[`extra_${suffix}`] ?? 0);
            if (Number.isFinite(base) && Number.isFinite(extra)) value = base + extra;
        }
        return value === undefined ? [] : [[key, value]];
    }));
}

function catalogActivationFromConditions(conditions = []) {
    for (const condition of conditions) {
        const type = serializedAkeType(condition);
        const compare = condition.compare ?? condition.compareType;
        const value = Number(akeDescriptorValue(condition.value, {}, Number.NaN));
        if (type === 'CheckPoiseValue' && ['Equals', 'EQ'].includes(compare) && value === 0) {
            return { kind: 'targetImbalanced' };
        }
        if (type === 'CheckHp' && ['LT', 'Less'].includes(compare) && Number.isFinite(value)) {
            return { kind: 'targetHpBelow', value };
        }
    }
    return null;
}

function catalogActivationFromDescription(description) {
    const text = String(description ?? '');
    // “消耗后获得”是一个后置状态转移，不能伪装成当前 Hit 对目标状态的
    // 前置校验，否则消耗结晶的那一击会错误地提前吃到自身 Buff。
    if (/消耗[^。\n]*后|被[^。\n]*消耗后/.test(text)) return null;
    if (/失衡|倒地/.test(text)) return { kind: 'targetImbalanced' };
    if (/施加[^。\n]*燃烧|燃烧状态/.test(text)) return { kind: 'targetStatus', status: 'burn' };
    if (/施加[^。\n]*冻结|冻结状态/.test(text)) return { kind: 'targetStatus', status: 'freeze' };
    if (/导电状态|施加[^。\n]*导电/.test(text)) return { kind: 'targetStatus', status: 'conductive' };
    if (/腐蚀状态|施加[^。\n]*腐蚀/.test(text)) return { kind: 'targetStatus', status: 'corrosion' };
    if (/破防状态|碎甲状态/.test(text)) return { kind: 'targetStatus', status: 'armor-break' };
    if (/源石结晶|结晶封印|被封印/.test(text)) {
        return { kind: 'targetStatus', status: 'originium-seal' };
    }
    return null;
}

function childBuffInputs(raw, blackboard) {
    const result = [];
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        const type = serializedAkeType(value);
        const createdBuffs = type === 'CreateBuffAction'
            ? value.buffs
            : type === 'AuraAction'
                ? value.buffInput
                : [];
        const applicationScope = type === 'AuraAction'
            && value.targetObjectType === 'Character'
            && value.targetFilter?.factionTarget === 'Ally'
            ? 'team'
            : undefined;
        for (const buff of createdBuffs ?? []) {
            if (!buff?.buffId) continue;
            result.push({
                buffId: buff.buffId,
                blackboard: assignedAkeBlackboard(buff, blackboard),
                ...(applicationScope ? { applicationScope } : {})
            });
        }
        for (const nested of Object.values(value)) visit(nested);
    };
    visit({
        buffEventAction: raw.buffEventAction,
        abilityEventAction: raw.abilityEventAction,
        igniteEventAction: raw.igniteEventAction,
        timelineActions: raw.timelineActions,
        actionGroupData: raw.actionGroupData,
        passiveEventActions: raw.passiveEventActions
    });
    return result;
}

function effectBlackboard(row) {
    const result = {};
    for (const entry of row?.dataList ?? []) {
        Object.assign(result, akeBlackboardObject(entry.attachBuff?.blackboard));
        const attribute = AKE_ATTRIBUTE_NAMES[Number(entry.attrModifier?.attrType)];
        const attributeValue = Number(entry.attrModifier?.attrValue);
        if (attribute && Number.isFinite(attributeValue) && attributeValue !== 0) {
            result[attribute] = attributeValue;
        }
        const key = String(entry.skillBbModifier?.bbKey ?? '').trim();
        if (key) {
            result[key] = entry.skillBbModifier.stringValue
                || entry.skillBbModifier.floatValue;
        }
    }
    return result;
}

function applyAkeBlackboardPatch(currentValue, patchValue, operationCode) {
    const current = Number(currentValue);
    const value = Number(patchValue);
    if (!Number.isFinite(value)) return patchValue;
    if (Number(operationCode) === 1) return (Number.isFinite(current) ? current : 0) + value;
    if (Number(operationCode) === 2) return (Number.isFinite(current) ? current : 0) * value;
    // PotentialTalentEffectTable uses 3 for assign. Unknown operations are
    // deliberately treated as assignment instead of silently discarding data.
    return value;
}

function skillPatchBlackboard(entry) {
    return Object.fromEntries((entry?.blackboard ?? []).flatMap(item => {
        const key = String(item?.key ?? '').trim();
        if (!key) return [];
        const value = item.valueStr !== '' && item.valueStr !== undefined
            ? item.valueStr
            : item.value;
        return [[key, value]];
    }));
}

function evaluateAkePlaceholder(expression, blackboard) {
    const source = String(expression).replace(/\s+/g, '');
    const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)|[+\-*/]/g);
    if (!tokens || tokens.join('') !== source) return null;
    let cursor = 0;
    const atom = () => {
        let sign = 1;
        while (tokens[cursor] === '+' || tokens[cursor] === '-') {
            if (tokens[cursor] === '-') sign *= -1;
            cursor += 1;
        }
        const token = tokens[cursor++];
        if (!token || ['+', '-', '*', '/'].includes(token)) return null;
        const numeric = Object.hasOwn(blackboard, token)
            ? Number(blackboard[token])
            : Number(token);
        return Number.isFinite(numeric) ? sign * numeric : null;
    };
    const product = () => {
        let value = atom();
        if (value === null) return null;
        while (tokens[cursor] === '*' || tokens[cursor] === '/') {
            const operation = tokens[cursor++];
            const right = atom();
            if (right === null || (operation === '/' && right === 0)) return null;
            value = operation === '*' ? value * right : value / right;
        }
        return value;
    };
    let value = product();
    if (value === null) return null;
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
        const operation = tokens[cursor++];
        const right = product();
        if (right === null) return null;
        value = operation === '+' ? value + right : value - right;
    }
    return cursor === tokens.length ? value : null;
}

function formatAkePlaceholder(value, format = '') {
    const percentMatch = String(format).match(/^0(?:\.(0+))?%$/);
    if (percentMatch) {
        const digits = percentMatch[1]?.length ?? 0;
        return `${Number((value * 100).toFixed(digits))}%`;
    }
    const decimalMatch = String(format).match(/^0(?:\.(0+))?$/);
    if (decimalMatch) {
        const digits = decimalMatch[1]?.length ?? 0;
        return String(Number(value.toFixed(digits)));
    }
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

/** Turn AKE's localized rich-text template into a compact, resolved UI string. */
export function renderAkeSkillText(template, blackboard = {}) {
    return cleanAkeRichText(template).replace(/\{([^{}]+)\}/g, (token, source) => {
        const separator = source.indexOf(':');
        const expression = separator >= 0 ? source.slice(0, separator).trim() : source.trim();
        const format = separator >= 0 ? source.slice(separator + 1).trim() : '';
        const value = evaluateAkePlaceholder(expression, blackboard);
        return value === null ? token : formatAkePlaceholder(value, format);
    });
}

export class AkeDataRepository {
    constructor({ projectRoot = defaultProjectRoot, dataOrigin = AKE_DATA_ORIGIN } = {}) {
        this.projectRoot = path.resolve(projectRoot);
        this.dataOrigin = String(dataOrigin).replace(/\/+$/, '');
        this.cache = new Map();
        this.loadoutCompiler = new AkeLoadoutCompiler({
            attributeTypeMappings: Object.fromEntries(
                AKE_ATTRIBUTE_NAMES.map((name, attrType) => [attrType, name])
            ),
            modifierZoneMappings: AKE_MODIFIER_ZONES
        });
    }

    buffDataIds() {
        const cacheKey = 'BuffData:file-ids';
        if (!this.cache.has(cacheKey)) {
            const directory = path.join(
                this.projectRoot,
                'reference', 'public-data', 'akedata', 'Json', 'BuffData'
            );
            this.cache.set(cacheKey, fs.readdirSync(directory)
                .filter(file => file.endsWith('.json'))
                .map(file => file.slice(0, -'.json'.length)));
        }
        return this.cache.get(cacheKey);
    }

    table(name) {
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new TypeError(`Unsafe AKE table name: ${name}`);
        if (!this.cache.has(name)) {
            const target = path.join(
                this.projectRoot,
                'reference', 'public-data', 'akedata', 'TableCfg', `${name}.json`
            );
            if (!fs.existsSync(target)) throw new Error(`Missing AKEDatabase table: ${name}.json`);
            this.cache.set(name, parseAkeJson(fs.readFileSync(target, 'utf8')));
        }
        return this.cache.get(name);
    }

    buffData(buffId) {
        if (!/^[A-Za-z0-9_]+$/.test(buffId)) {
            throw new TypeError(`Unsafe AKE BuffData id: ${buffId}`);
        }
        const cacheKey = `BuffData:${buffId}`;
        if (!this.cache.has(cacheKey)) {
            const target = path.join(
                this.projectRoot,
                'reference', 'public-data', 'akedata', 'Json', 'BuffData', `${buffId}.json`
            );
            if (!fs.existsSync(target)) throw new Error(`Missing AKEDatabase BuffData: ${buffId}.json`);
            this.cache.set(cacheKey, parseAkeJson(fs.readFileSync(target, 'utf8')));
        }
        return this.cache.get(cacheKey);
    }

    skillData(skillId) {
        if (!/^[A-Za-z0-9_]+$/.test(skillId)) {
            throw new TypeError(`Unsafe AKE SkillData id: ${skillId}`);
        }
        const cacheKey = `SkillData:${skillId}`;
        if (!this.cache.has(cacheKey)) {
            const target = path.join(
                this.projectRoot,
                'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
            );
            if (!fs.existsSync(target)) throw new Error(`Missing AKEDatabase SkillData: ${skillId}.json`);
            this.cache.set(cacheKey, parseAkeJson(fs.readFileSync(target, 'utf8')));
        }
        return this.cache.get(cacheKey);
    }

    catalogBuffEffects(buffId, { blackboard: overrides = {} } = {}) {
        const effects = [];
        const seenEffects = new Set();
        const appendEffect = (effect, sourceBuffId, durationSeconds, maxStacks) => {
            if (!effect?.type || !Number.isFinite(Number(effect.value)) || Number(effect.value) === 0) {
                return;
            }
            const normalizedMaxStacks = Number(maxStacks);
            const key = [effect.type, Number(effect.value), sourceBuffId].join('|');
            if (seenEffects.has(key)) return;
            seenEffects.add(key);
            effects.push({
                id: `${sourceBuffId}:${effects.length + 1}`,
                sourceBuffId,
                type: effect.type,
                value: Number(effect.value),
                unit: effect.unit ?? 'percent',
                category: normalizedMaxStacks > 1 ? 'countable' : 'condition',
                ...(normalizedMaxStacks > 1
                    ? { maxStacks: Math.floor(normalizedMaxStacks) }
                    : {}),
                ...(Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) >= 0
                    ? { durationSeconds: Number(durationSeconds) }
                    : {})
            });
        };
        const queue = [{ buffId, blackboard: structuredClone(overrides), triggered: false }];
        const visited = new Set();
        while (queue.length > 0) {
            const input = queue.shift();
            const visitKey = `${input.buffId}:${JSON.stringify(input.blackboard)}`;
            if (visited.has(visitKey)) continue;
            visited.add(visitKey);
            const raw = this.buffData(input.buffId);
            const blackboard = {
                ...akeBlackboardObject(raw.blackboard),
                ...input.blackboard
            };
            const stacking = raw.stackingSettings ?? {};
            const maxStacks = Number(stacking.useMaxStackCntKey && stacking.maxStackCntKey
                ? blackboard[stacking.maxStackCntKey]
                : stacking.maxStackCnt);
            const durationSeconds = Number(akeDescriptorValue(raw.duration, blackboard, Number.NaN));

            for (const modifier of raw.attributeModifier?.attributeModifiers ?? []) {
                const mapped = catalogAttributeEffect(
                    modifier.attributeType,
                    modifier.formulaItem,
                    akeDescriptorValue(modifier.param, blackboard)
                );
                if (mapped) appendEffect(mapped, input.buffId, durationSeconds, maxStacks);
            }

            for (const modifier of raw.damageModifier ?? []) {
                const conditions = modifier.condition?.actionData ?? [];
                for (const processor of modifier.damageProcessors ?? []) {
                    const processorType = serializedAkeType(processor);
                    if (processorType === 'DamageScaleProcessor'
                        && processor.zoneName === 'NormalCalcZone') {
                        const value = Number(akeDescriptorValue(processor.addition, blackboard));
                        // `enableSide` selects which combatant's Buff participates in
                        // the damage event. The processor's own `side` selects the
                        // side whose damage zone is modified. A self-owned talent can
                        // therefore be enabled on Attacker while modifying Defender
                        // (for example Endministrator's "现实静滞").
                        const affectedSide = processor.side ?? modifier.enableSide;
                        const type = affectedSide === 'Defender'
                            ? fragileTypeFromDamageConditions(conditions)
                            : catalogActivationFromConditions(conditions)?.kind === 'targetImbalanced'
                                ? 'imbalanceDmgBonus'
                                : damageBonusTypeFromDamageConditions(conditions)
                                    ?? 'allDmgBonus';
                        if (type) appendEffect(
                            { type, value, unit: 'percent' },
                            input.buffId,
                            durationSeconds,
                            maxStacks
                        );
                    }
                    if (processorType === 'InstantModifyAttribute'
                        && processor.modifyTargetSide === 'Defender') {
                        const type = AKE_RESISTANCE_IGNORE_BUFF_TYPES[
                            processor.modifier?.attributeType
                        ];
                        const value = Number(akeDescriptorValue(
                            processor.modifier?.param,
                            blackboard
                        ));
                        if (type) appendEffect(
                            { type, value: Math.abs(value), unit: 'flat' },
                            input.buffId,
                            durationSeconds,
                            maxStacks
                        );
                    }
                }
            }

            const inspectActions = value => {
                if (!value || typeof value !== 'object') return;
                if (serializedAkeType(value) === 'VulnerableAction') {
                    const type = AKE_VULNERABILITY_BUFF_TYPES[value.subType];
                    const rate = Number(akeDescriptorValue(value.rate, blackboard));
                    if (type) appendEffect(
                        { type, value: Math.abs(rate), unit: 'percent' },
                        input.buffId,
                        durationSeconds,
                        maxStacks
                    );
                }
                if (serializedAkeType(value) === 'WeakAction') {
                    const rate = Number(akeDescriptorValue(value.rate, blackboard));
                    appendEffect(
                        { type: 'weakness', value: Math.abs(rate), unit: 'percent' },
                        input.buffId,
                        durationSeconds,
                        maxStacks
                    );
                }
                if (serializedAkeType(value) === 'ShelterAction') {
                    const rate = Number(akeDescriptorValue(value.rate, blackboard));
                    appendEffect(
                        { type: 'damageReduction', value: Math.abs(rate), unit: 'percent' },
                        input.buffId,
                        durationSeconds,
                        maxStacks
                    );
                }
                for (const nested of Object.values(value)) inspectActions(nested);
            };
            inspectActions({
                buffEventAction: raw.buffEventAction,
                abilityEventAction: raw.abilityEventAction,
                igniteEventAction: raw.igniteEventAction,
                timelineActions: raw.timelineActions
            });

            for (const child of childBuffInputs(raw, blackboard)) {
                queue.push({ ...child, triggered: true });
            }
        }
        return effects;
    }

    /**
     * Resolve the player-facing numeric effects of a passive SkillData row.
     * Card modifiers are the unconditional panel portion; referenced BuffData
     * contributes conditional/countable runtime portions.
     */
    catalogSkillEffects(skillId, { blackboard: overrides = {} } = {}) {
        const raw = this.skillData(skillId);
        const blackboard = {
            ...akeBlackboardObject(raw.blackboard),
            ...overrides
        };
        const effects = [];
        const seenEffects = new Set();
        const appendEffect = (effect, meta = {}) => {
            if (!effect?.type || !Number.isFinite(Number(effect.value)) || Number(effect.value) === 0) {
                return;
            }
            const category = effect.category === 'countable'
                ? 'countable'
                : meta.category === 'passive'
                    ? 'passive'
                    : 'condition';
            const value = Number(effect.value);
            const key = [effect.type, value, category, effect.maxStacks ?? ''].join('|');
            if (seenEffects.has(key)) return;
            seenEffects.add(key);
            effects.push({
                effectId: `${skillId}:${meta.sourceBuffId || 'card'}:${effects.length + 1}`,
                sourceBuffId: meta.sourceBuffId || skillId,
                type: effect.type,
                value,
                unit: effect.unit ?? 'percent',
                category,
                ...(Number(effect.maxStacks) > 1
                    ? { maxStacks: Math.floor(Number(effect.maxStacks)) }
                    : {}),
                ...(Number.isFinite(Number(effect.durationSeconds))
                    ? { durationSeconds: Number(effect.durationSeconds) }
                    : {}),
                ...(effect.effectKind === 'extraHit' ? {
                    effectKind: 'extraHit',
                    extraHitConfig: structuredClone(effect.extraHitConfig)
                } : {})
            });
        };

        for (const [index, modifier] of (raw.cardAttributeModifier?.attributeModifiers ?? []).entries()) {
            const descriptor = modifier.param;
            const value = akeDescriptorValue(descriptor, blackboard);
            const blackboardKey = String(descriptor?.blackboardKey ?? '');
            const mapped = modifier.attributeType === 'Level'
                ? modifier.modifyAttributeType === 'Main' || blackboardKey.includes('primary')
                    ? { type: 'mainStatBoost', value: Number(value), unit: 'percent' }
                    : modifier.modifyAttributeType === 'Secondary' || blackboardKey.includes('second')
                        ? { type: 'subStatBoost', value: Number(value), unit: 'percent' }
                        : null
                : catalogAttributeEffect(modifier.attributeType, modifier.formulaItem, value);
            if (mapped) appendEffect(mapped, {
                category: 'passive',
                sourceBuffId: `${skillId}:card:${index + 1}`
            });
        }

        const referencedBuffs = [
            ...(raw.buffs ?? []).map(buff => ({
                buffId: buff.buffId,
                blackboard: assignedAkeBlackboard(buff, blackboard),
                hasConditions: false
            })),
            ...(raw.toggleBuffs ?? []).flatMap(toggle => (
                (toggle.buffs ?? []).map(buff => ({
                    buffId: buff.buffId,
                    blackboard: assignedAkeBlackboard(buff, blackboard),
                    hasConditions: (toggle.conditions ?? []).length > 0
                }))
            )),
            ...childBuffInputs(raw, blackboard).map(child => ({
                buffId: child.buffId,
                blackboard: child.blackboard,
                hasConditions: true
            }))
        ];
        for (const { buffId, blackboard: buffBlackboard, hasConditions } of referencedBuffs) {
            if (!buffId) continue;
            let buffEffects;
            let isStaticDirectBuff = false;
            try {
                const buffRaw = this.buffData(buffId);
                isStaticDirectBuff = (buffRaw.attributeModifier?.attributeModifiers ?? []).length > 0
                    && (buffRaw.buffEventAction ?? []).length === 0
                    && (buffRaw.abilityEventAction ?? []).length === 0
                    && (buffRaw.igniteEventAction ?? []).length === 0
                    && (buffRaw.timelineActions ?? []).length === 0;
                buffEffects = this.catalogBuffEffects(buffId, {
                    blackboard: buffBlackboard
                });
            } catch {
                // The public corpus omits a few shared marker BuffData rows.
                // Card modifiers still preserve their real numeric effects.
                if (buffId === 'buff_wpn_passive_spirit_01'
                    && !effects.some(effect => (
                        effect.type === 'flatAtk' || effect.type === 'atkPercentBoost'
                    ))) {
                    const value = Number(buffBlackboard.atk_up ?? blackboard.atk_up);
                    if (Number.isFinite(value) && value !== 0) {
                        appendEffect({
                            type: 'atkPercentBoost',
                            value,
                            unit: 'percent',
                            durationSeconds: Number(blackboard.duration)
                        }, {
                            sourceBuffId: buffId,
                            category: 'condition'
                        });
                    }
                }
                continue;
            }
            for (const effect of buffEffects) {
                appendEffect(effect, {
                    sourceBuffId: effect.sourceBuffId,
                    category: !hasConditions
                        && isStaticDirectBuff
                        && effect.sourceBuffId === buffId
                        ? 'passive'
                        : effect.category
                });
            }
        }
        // 点剑的三件套追加段藏在 BuffData 的 OnOutputBuff DamageAction 中，
        // 不属于 attribute/damage modifier。数值仍全部来自该等级的 AKE
        // blackboard；这里只把已经明确的触发语义投影到现有额外 Hit 契约。
        if (skillId === 'passive_equipsuit_physuit_01') {
            const baseMultiplier = Number(blackboard.atk_scale);
            const imbalanceValue = Number(blackboard.poise);
            const cooldownSeconds = Number(blackboard.duration);
            if (Number.isFinite(baseMultiplier) && baseMultiplier > 0) {
                appendEffect({
                    type: 'extraHit',
                    value: baseMultiplier,
                    unit: 'multiplier',
                    category: 'condition',
                    effectKind: 'extraHit',
                    extraHitConfig: {
                        key: `${skillId}-physical-anomaly-extra-hit`,
                        damageType: 'physical',
                        skillType: '',
                        baseMultiplier,
                        imbalanceValue: Number.isFinite(imbalanceValue) ? imbalanceValue : 0,
                        cooldownSeconds: Number.isFinite(cooldownSeconds) ? cooldownSeconds : 0,
                        trigger: 'physicalAbnormal'
                    }
                }, {
                    sourceBuffId: 'buff_equipsuit_physuit_01',
                    category: 'condition'
                });
            }
        }
        return effects;
    }

    catalogLoadoutEffect(effectId, { name, description, group, level = 0 } = {}) {
        const row = this.table('PotentialTalentEffectTable')[effectId];
        if (!row) return null;
        const compiled = this.loadoutCompiler.compile(effectId, row);
        const rawBlackboard = {
            ...effectBlackboard(row),
            ...Object.assign({}, ...compiled.skills.map(skill => skill.blackboard)),
            ...Object.fromEntries(compiled.skillBlackboardPatches.map(patch => [
                patch.key,
                patch.value
            ]))
        };
        const resolvedDescription = renderAkeSkillText(
            description || this.text(row.desc),
            rawBlackboard
        );
        const displayName = group === 'potential'
            ? `${['', '一', '二', '三', '四', '五', '六'][level] ?? level}潜·${name || effectId}`
            : `天赋·${name || effectId}`;
        const effects = [];
        const seenEffects = new Set();
        const appendEffect = (effect, sourceBuffId = null, applicationScope = 'self') => {
            if (!effect?.type || !Number.isFinite(Number(effect.value)) || Number(effect.value) === 0) {
                return;
            }
            const value = Number(effect.value);
            const key = [
                effect.type,
                value,
                effect.category,
                effect.maxStacks ?? '',
                sourceBuffId ?? '',
                applicationScope
            ].join('|');
            if (seenEffects.has(key)) return;
            seenEffects.add(key);
            effects.push({
                effectId: `${effectId}:${sourceBuffId || 'direct'}:${effects.length + 1}`,
                name: displayName,
                type: effect.type,
                category: effect.category ?? 'passive',
                value,
                unit: effect.unit ?? 'percent',
                ...(Number(effect.maxStacks) > 1
                    ? { maxStacks: Math.floor(Number(effect.maxStacks)) }
                    : {}),
                ...(effect.activation ? { activation: effect.activation } : {}),
                ...(Number.isFinite(Number(effect.durationSeconds))
                    ? { durationSeconds: Number(effect.durationSeconds) }
                    : {}),
                ...(effect.effectKind === 'extraHit' ? {
                    effectKind: 'extraHit',
                    extraHitConfig: structuredClone(effect.extraHitConfig)
                } : {}),
                applicationScope,
                description: resolvedDescription,
                raw: resolvedDescription,
                ...(sourceBuffId ? { sourceBuffId } : {})
            });
        };

        for (const modifier of compiled.attributeModifiers) {
            const mapped = catalogAttributeEffect(
                modifier.attribute,
                modifier.zone,
                modifier.value
            );
            if (mapped) appendEffect({ ...mapped, category: 'passive' });
        }

        const loadoutBuffInputs = compiled.buffs.map(buff => ({
            buffId: buff.buffId,
            blackboard: buff.blackboard,
            triggered: false,
            applicationScope: 'self'
        }));
        const queue = structuredClone(loadoutBuffInputs);
        const visited = new Set();
        while (queue.length > 0) {
            const input = queue.shift();
            const visitKey = `${input.buffId}:${JSON.stringify(input.blackboard)}:${input.applicationScope}`;
            if (visited.has(visitKey)) continue;
            visited.add(visitKey);
            const raw = this.buffData(input.buffId);
            const blackboard = {
                ...akeBlackboardObject(raw.blackboard),
                ...input.blackboard
            };
            const stacking = raw.stackingSettings ?? {};
            const maxStacks = Number(stacking.useMaxStackCntKey && stacking.maxStackCntKey
                ? blackboard[stacking.maxStackCntKey]
                : stacking.maxStackCnt);
            const hasRuntimeTrigger = input.triggered
                || (raw.buffEventAction ?? []).length > 0
                || (raw.abilityEventAction ?? []).length > 0
                || (raw.igniteEventAction ?? []).length > 0
                || (raw.timelineActions ?? []).length > 0;
            const baseCategory = Number.isFinite(maxStacks) && maxStacks > 1
                ? 'countable'
                : raw.lifeType === 'Limited' || hasRuntimeTrigger
                    ? 'condition'
                    : 'passive';

            for (const modifier of raw.attributeModifier?.attributeModifiers ?? []) {
                const mapped = catalogAttributeEffect(
                    modifier.attributeType,
                    modifier.formulaItem,
                    akeDescriptorValue(modifier.param, blackboard)
                );
                if (!mapped) continue;
                appendEffect({
                    ...mapped,
                    category: baseCategory,
                    maxStacks,
                    activation: baseCategory === 'condition'
                        ? catalogActivationFromDescription(resolvedDescription)
                        : null
                }, input.buffId, input.applicationScope);
            }

            for (const modifier of raw.damageModifier ?? []) {
                if (modifier.enableSide !== 'Attacker') continue;
                const conditions = modifier.condition?.actionData ?? [];
                const conditionActivation = catalogActivationFromConditions(conditions)
                    ?? catalogActivationFromDescription(resolvedDescription);
                for (const processor of modifier.damageProcessors ?? []) {
                    const processorType = serializedAkeType(processor);
                    if (processorType === 'DamageScaleProcessor'
                        && processor.zoneName === 'NormalCalcZone') {
                        const value = Number(akeDescriptorValue(processor.addition, blackboard));
                        appendEffect({
                            type: (processor.side ?? modifier.enableSide) === 'Defender'
                                ? fragileTypeFromDamageConditions(conditions)
                                    ?? 'allFragile'
                                : conditionActivation?.kind === 'targetImbalanced'
                                    ? 'imbalanceDmgBonus'
                                    : damageBonusTypeFromDamageConditions(conditions)
                                        ?? 'allDmgBonus',
                            value,
                            unit: 'percent',
                            category: conditions.length > 0 ? 'condition' : baseCategory,
                            maxStacks,
                            activation: conditionActivation
                        }, input.buffId, input.applicationScope);
                    }
                    if (processorType === 'InstantModifyAttribute'
                        && processor.modifyTargetSide === 'Defender') {
                        const attribute = processor.modifier?.attributeType;
                        const type = AKE_RESISTANCE_IGNORE_BUFF_TYPES[attribute];
                        const rawValue = Number(akeDescriptorValue(
                            processor.modifier?.param,
                            blackboard
                        ));
                        if (!type || !Number.isFinite(rawValue) || rawValue === 0) continue;
                        appendEffect({
                            type,
                            value: Math.abs(rawValue),
                            unit: 'flat',
                            category: conditions.length > 0 ? 'condition' : baseCategory,
                            maxStacks,
                            activation: conditionActivation
                        }, input.buffId, input.applicationScope);
                    }
                }
            }

            for (const child of childBuffInputs(raw, blackboard)) {
                queue.push({
                    ...child,
                    triggered: true,
                    applicationScope: child.applicationScope ?? input.applicationScope
                });
            }
        }

        // AKE commonly stores a loadout marker and the actual numeric carrier
        // in a sibling BuffData row (`marker_*`). Only consult those companions
        // when normal graph traversal produced no effect for that marker.
        for (const input of loadoutBuffInputs) {
            const alreadyResolved = effects.some(effect => (
                String(effect.sourceBuffId ?? '').startsWith(input.buffId)
            ));
            if (alreadyResolved) continue;
            const companionIds = this.buffDataIds().filter(candidate => (
                candidate.startsWith(`${input.buffId}_`)
            ));
            for (const companionId of companionIds) {
                let companionEffects = [];
                try {
                    companionEffects = this.catalogBuffEffects(companionId, {
                        blackboard: input.blackboard
                    });
                } catch {
                    continue;
                }
                for (const effect of companionEffects) {
                    appendEffect({
                        ...effect,
                        category: effect.category ?? 'condition',
                        activation: catalogActivationFromDescription(resolvedDescription)
                    }, effect.sourceBuffId || companionId);
                }
            }
        }

        const skillInputs = compiled.skills.map(skill => ({
            ...skill,
            baselineEffects: []
        }));
        const patchesBySkill = new Map();
        for (const patch of compiled.skillBlackboardPatches) {
            if (!patchesBySkill.has(patch.skillId)) patchesBySkill.set(patch.skillId, []);
            patchesBySkill.get(patch.skillId).push(patch);
        }
        for (const [skillId, patches] of patchesBySkill) {
            let baseBlackboard = {};
            try {
                baseBlackboard = this.skillBlackboard(skillId, 12);
            } catch {
                baseBlackboard = akeBlackboardObject(this.skillData(skillId).blackboard);
            }
            const blackboard = structuredClone(baseBlackboard);
            for (const patch of patches) {
                blackboard[patch.key] = applyAkeBlackboardPatch(
                    blackboard[patch.key],
                    patch.value,
                    patch.operationCode
                );
            }
            let baselineEffects = [];
            try {
                baselineEffects = this.catalogSkillEffects(skillId, {
                    blackboard: baseBlackboard
                });
            } catch {
                baselineEffects = [];
            }
            skillInputs.push({ skillId, blackboard, baselineEffects });
        }
        for (const input of skillInputs) {
            let skillEffects = [];
            try {
                skillEffects = this.catalogSkillEffects(input.skillId, {
                    blackboard: input.blackboard
                });
            } catch {
                continue;
            }
            for (const effect of skillEffects) {
                const baseline = input.baselineEffects.find(candidate => (
                    candidate.sourceBuffId === effect.sourceBuffId
                    && candidate.type === effect.type
                    && candidate.effectKind === effect.effectKind
                ));
                const projectedEffect = baseline
                    ? {
                        ...effect,
                        value: Number((
                            Number(effect.value) - Number(baseline.value)
                        ).toFixed(12))
                    }
                    : effect;
                appendEffect({
                    ...projectedEffect,
                    activation: projectedEffect.activation
                        ?? catalogActivationFromDescription(resolvedDescription)
                }, projectedEffect.sourceBuffId || input.skillId);
            }
        }

        return {
            effectId,
            name: displayName,
            description: resolvedDescription,
            level: Number(level),
            effects
        };
    }

    corpusManifest() {
        const target = path.join(
            this.projectRoot,
            'reference', 'public-data', 'akedata', 'table-corpus.manifest.json'
        );
        return parseAkeJson(fs.readFileSync(target, 'utf8'));
    }

    text(reference, fallback = '') {
        if (typeof reference === 'string') return reference || fallback;
        if (reference?.text) return reference.text;
        const id = reference?.id;
        if (id === undefined || id === null || String(id) === '0') return fallback;
        return this.table('I18nTextTable_CN')[String(id)] ?? fallback;
    }

    characterIcon(characterId) {
        return imageUrl(this.dataOrigin, 'charremoteicon', `icon_${characterId}`);
    }

    itemIcon(itemId, iconId = itemId) {
        return imageUrl(this.dataOrigin, 'itemiconbig', iconId || itemId);
    }

    skillIcon(iconId) {
        return imageUrl(this.dataOrigin, 'skillicon', iconId);
    }

    buffIcon(iconId) {
        return imageUrl(this.dataOrigin, 'bufficon', iconId);
    }

    buffPresentation(buffId) {
        const raw = this.buffData(buffId);
        const iconConfig = raw?.iconConfig ?? {};
        const iconId = String(iconConfig._spritePath ?? '').trim();
        const displayChannels = [
            'showInHeadBarCommon',
            'showInHeadBarAttached',
            'showInSquadIcon',
            'showProgressInHpBar',
            'showProgressInNormalSkillButton',
            'showProgressInUltimateSkillButton',
            'forceRaiseIconEvent'
        ].filter(channel => iconConfig[channel] === true);
        return {
            buffId,
            iconId,
            iconUrl: this.buffIcon(iconId),
            displayable: iconId.length > 0,
            displayChannels,
            onlyShowForMainCharacter: iconConfig.onlyShowForMainCharacter === true,
            abnormalColorType: iconConfig.abnormalColorType ?? null,
            iconStyleInSquad: iconConfig.iconStyleInSquad ?? null
        };
    }

    skillPatch(skillId, level = 1) {
        const requestedLevel = clampInteger(level, 1, 99, 'skill patch level');
        return structuredClone(skillPatchAtLevel(
            this.table('SkillPatchTable')[skillId],
            requestedLevel
        ));
    }

    skillBlackboard(skillId, level = 1) {
        const requestedLevel = clampInteger(level, 1, 99, 'skill Blackboard level');
        return structuredClone(blackboardAtLevel(
            this.table('SkillPatchTable')[skillId],
            requestedLevel
        ));
    }

    characterAttributes(characterId, { level = 1, breakStage } = {}) {
        const row = this.table('CharacterTable')[characterId];
        if (!row) throw new Error(`Unknown AKEDatabase character: ${characterId}`);
        const requestedLevel = clampInteger(level, 1, 90, 'character level');
        const matches = (row.attributes ?? []).filter(entry =>
            (entry.Attribute?.attrs ?? []).some(attribute =>
                Number(attribute.attrType) === 0 && Number(attribute.attrValue) === requestedLevel
            ));
        if (matches.length === 0) throw new Error(`Character ${characterId} has no level ${requestedLevel} row.`);
        const selected = breakStage === undefined
            ? matches.reduce((best, entry) => Number(entry.breakStage) > Number(best.breakStage) ? entry : best)
            : matches.find(entry => Number(entry.breakStage) === Number(breakStage));
        if (!selected) {
            throw new Error(`Character ${characterId} has no level ${requestedLevel}, break ${breakStage} row.`);
        }
        return {
            level: requestedLevel,
            breakStage: Number(selected.breakStage),
            attributes: attributeObject(selected.Attribute?.attrs ?? []),
            raw: structuredClone(selected)
        };
    }

    weaponAttributes(weaponId, {
        level = 1,
        potential = 1,
        skillLevels = {},
        mainAttrType
    } = {}) {
        const weapon = this.table('WeaponBasicTable')[weaponId];
        if (!weapon) throw new Error(`Unknown AKEDatabase weapon: ${weaponId}`);
        const requestedLevel = clampInteger(level, 1, Number(weapon.maxLv || 90), 'weapon level');
        const requestedPotential = clampInteger(potential, 1, 9, 'weapon potential');
        const curve = this.table('WeaponUpgradeTemplateTable')[weapon.levelTemplateId];
        const levelRow = (curve?.list ?? []).find(entry => Number(entry.weaponLv) === requestedLevel);
        if (!levelRow) throw new Error(`Weapon ${weaponId} has no level ${requestedLevel} curve row.`);
        const modifiers = [{
            attribute: 'Atk',
            attrType: 2,
            zone: 'BaseAddition',
            modifierType: 5,
            value: Number(levelRow.baseAtk ?? 0),
            source: `${weaponId}:baseAtk`
        }];
        const passiveSkillId = weapon.weaponPotentialSkill || (weapon.weaponSkillList ?? [])
            .find(id => /^sk_wpn_/.test(id));
        const skillPatch = this.table('SkillPatchTable');
        const modifierTypeByZone = Object.fromEntries(
            Object.entries(AKE_MODIFIER_ZONES).map(([type, zone]) => [zone, Number(type)])
        );
        const resolvedSkillLevels = {};
        for (const [index, skillId] of (weapon.weaponSkillList ?? []).entries()) {
            const patchLevels = skillPatch[skillId]?.SkillPatchDataBundle ?? [];
            const maximum = Math.max(1, ...patchLevels.map(entry => Number(entry.level) || 1));
            const requested = skillLevels[skillId]
                ?? skillLevels[`skill${index + 1}`]
                ?? requestedPotential;
            const selectedLevel = clampInteger(
                requested,
                1,
                maximum,
                `${weaponId}.${skillId} level`
            );
            resolvedSkillLevels[skillId] = selectedLevel;
            resolvedSkillLevels[`skill${index + 1}`] = selectedLevel;
            if (skillId === passiveSkillId) continue;
            const rawSkill = this.skillData(skillId);
            const blackboard = blackboardAtLevel(skillPatch[skillId], selectedLevel);
            const effect = this.loadoutCompiler.compilePassiveSkill(rawSkill, { blackboard });
            for (const modifier of effect.attributeModifiers) {
                const attribute = modifier.metadata?.modifyAttributeType === 'Main'
                    && mainAttrType !== undefined
                    ? AKE_ATTRIBUTE_NAMES[Number(mainAttrType)] ?? `Attr${mainAttrType}`
                    : modifier.attribute;
                const attrType = AKE_ATTRIBUTE_NAMES.indexOf(attribute);
                const modifierType = modifierTypeByZone[modifier.zone];
                const value = Number(modifier.value);
                if (!attribute || !Number.isFinite(value)
                    || !Number.isInteger(modifierType)) continue;
                modifiers.push({
                    attribute,
                    attrType,
                    zone: modifier.zone,
                    modifierType,
                    value,
                    source: `${weaponId}:${skillId}`
                });
            }
        }
        const passiveLevel = passiveSkillId
            ? resolvedSkillLevels[passiveSkillId] ?? requestedPotential
            : null;
        return {
            weaponId,
            level: requestedLevel,
            potential: requestedPotential,
            baseAtk: Number(levelRow.baseAtk ?? 0),
            modifiers,
            passiveSkillId: passiveSkillId || null,
            skillLevels: structuredClone(resolvedSkillLevels),
            passiveBlackboard: passiveSkillId
                ? blackboardAtLevel(skillPatch[passiveSkillId], passiveLevel)
                : {},
            raw: structuredClone(weapon)
        };
    }

    equipmentModifiers(equipment = []) {
        if (!Array.isArray(equipment)) throw new TypeError('equipment must be an array.');
        const table = this.table('EquipTable');
        const partCounts = new Map();
        return equipment.flatMap((input, index) => {
            const selection = typeof input === 'string' ? { equipmentId: input } : input;
            const equipmentId = selection?.equipmentId ?? selection?.id;
            const row = table[equipmentId];
            if (!row) throw new Error(`Unknown AKEDatabase equipment: ${equipmentId}`);
            const part = AKE_EQUIPMENT_PARTS[row.partType];
            if (!part) throw new Error(`Unsupported equipment partType ${row.partType} for ${equipmentId}.`);
            const nextCount = (partCounts.get(row.partType) ?? 0) + 1;
            partCounts.set(row.partType, nextCount);
            if (nextCount > part.maximum) {
                throw new Error(`Equipment part ${part.name} exceeds ${part.maximum} slot(s).`);
            }
            const enhance = clampInteger(selection?.enhance ?? 0, 0, 3, `equipment[${index}].enhance`);
            return (row.equipAttrModifiers ?? []).map(modifier => {
                const type = Number(modifier.attrType);
                return {
                    attribute: AKE_ATTRIBUTE_NAMES[type] ?? `Attr${type}`,
                    attrType: type,
                    zone: AKE_MODIFIER_ZONES[modifier.modifierType] ?? null,
                    modifierType: Number(modifier.modifierType),
                    value: Number(modifier.attrValues?.[enhance] ?? 0),
                    source: equipmentId,
                    partType: Number(row.partType),
                    enhance
                };
            });
        });
    }

    catalog() {
        const manifest = this.corpusManifest();
        const characters = this.table('CharacterTable');
        const growth = this.table('CharGrowthTable');
        const potentials = this.table('CharacterPotentialTable');
        this.table('PotentialTalentEffectTable');
        const skillPatch = this.table('SkillPatchTable');
        const weapons = this.table('WeaponBasicTable');
        const items = this.table('ItemTable');
        const equips = this.table('EquipTable');
        const suits = this.table('EquipSuitTable');
        const characterRows = Object.entries(characters).map(([characterId, character]) => {
            const grow = growth[characterId] ?? {};
            const attributeLevels = Object.fromEntries([1, 20, 40, 60, 80, 90].map(level => {
                const attributes = this.characterAttributes(characterId, { level }).attributes;
                return [`level${level}`, {
                    strength: Number(attributes.Str ?? 0),
                    agility: Number(attributes.Agi ?? 0),
                    intelligence: Number(attributes.Wisd ?? 0),
                    will: Number(attributes.Will ?? 0),
                    atk: Number(attributes.Atk ?? 0),
                    hp: Number(attributes.MaxHp ?? 0),
                    defense: Number(attributes.Def ?? 0),
                    criticalRate: Number(attributes.CriticalRate ?? 0),
                    criticalDamageIncrease: Number(attributes.CriticalDamageIncrease ?? 0)
                }];
            }));
            const groups = Object.values(grow.skillGroupMap ?? {}).map(group => {
                const commandType = SKILL_GROUP_TYPES[group.skillGroupType] ?? 'Unknown';
                const primarySkillId = group.skillIdList?.[0] ?? null;
                const patch = primarySkillId ? skillPatchAtLevel(skillPatch[primarySkillId], 1) : null;
                return {
                    groupId: group.skillGroupId,
                    commandType,
                    name: this.text(group.name, commandType),
                    description: this.text(group.desc),
                    iconId: patch?.iconId || group.icon || '',
                    iconUrl: this.skillIcon(patch?.iconId || group.icon),
                    skillIds: structuredClone(group.skillIdList ?? []),
                    costType: patch?.costType ?? null,
                    costValue: Number(patch?.costValue ?? 0),
                    cooldown: Number(patch?.coolDown ?? 0)
                };
            });
            const attack = groups.find(group => group.commandType === 'Attack');
            const breakingSkillId = attack?.skillIds.find(skillId => /_power_attack$/.test(skillId));
            if (breakingSkillId) {
                const patch = skillPatchAtLevel(skillPatch[breakingSkillId], 1);
                groups.push({
                    groupId: `${attack.groupId}:BreakingAttack`,
                    commandType: 'BreakingAttack',
                    name: this.text(patch?.skillName, '处决攻击'),
                    description: this.text(patch?.description),
                    iconId: patch?.iconId || attack.iconId,
                    iconUrl: this.skillIcon(patch?.iconId || attack.iconId),
                    skillIds: [breakingSkillId],
                    costType: patch?.costType ?? null,
                    costValue: Number(patch?.costValue ?? 0),
                    cooldown: Number(patch?.coolDown ?? 0)
                });
            }
            const ultimate = groups.find(group => group.commandType === 'UltimateSkill');
            // Administrators expose male/female presentation rows but share the
            // real loadout owner through `item_charpotentialup_chr_9000_endmin`.
            // Resolve that link from CharacterPotentialTable instead of
            // maintaining a character-specific alias list.
            const loadoutOwnerMatch = String(
                potentials[characterId]?.firstItemId ?? ''
            ).match(/^item_charpotentialup_(chr_[A-Za-z0-9_]+)$/);
            const loadoutOwnerId = loadoutOwnerMatch?.[1] ?? characterId;
            const loadoutGrowth = growth[loadoutOwnerId] ?? grow;
            const activeTalentNodes = [...Object.values(loadoutGrowth.talentNodeMap ?? {})]
                .map(node => node?.passiveSkillNodeInfo)
                .filter(node => node?.talentEffectId)
                .reduce((selected, node) => {
                    const index = Number(node.index);
                    const previous = selected.get(index);
                    if (!previous
                        || Number(node.level) > Number(previous.level)
                        || (Number(node.level) === Number(previous.level)
                            && Number(node.breakStage) > Number(previous.breakStage))) {
                        selected.set(index, node);
                    }
                    return selected;
                }, new Map());
            const talentLoadoutEffects = [...activeTalentNodes.values()]
                .sort((left, right) => Number(left.index) - Number(right.index))
                .map(node => this.catalogLoadoutEffect(node.talentEffectId, {
                    name: this.text(node.name, node.talentEffectId),
                    group: 'talent',
                    level: Number(node.level)
                }))
                .filter(Boolean);
            const potentialLoadoutEffects = (potentials[characterId]?.potentialUnlockBundle ?? [])
                .map(entry => this.catalogLoadoutEffect(entry.potentialEffectId, {
                    name: this.text(entry.name, entry.potentialEffectId),
                    group: 'potential',
                    level: Number(entry.level)
                }))
                .filter(Boolean);
            return {
                id: characterId,
                name: this.text(character.name, characterId),
                englishName: this.text(character.engName ?? grow.engName),
                rarity: Number(character.rarity ?? 0),
                professionId: Number(grow.profession),
                profession: AKE_PROFESSIONS[grow.profession] ?? String(grow.profession ?? ''),
                elementId: grow.charTypeId,
                element: AKE_ELEMENTS[grow.charTypeId] ?? grow.charTypeId,
                weaponTypeId: Number(grow.weaponType),
                weaponType: AKE_WEAPON_TYPES[grow.weaponType] ?? String(grow.weaponType ?? ''),
                mainAttrType: Number(character.mainAttrType),
                mainAttribute: AKE_ATTRIBUTE_NAMES[character.mainAttrType] ?? `Attr${character.mainAttrType}`,
                mainAttributeLabel: AKE_ABILITY_LABELS[character.mainAttrType] ?? '',
                subAttrType: Number(character.subAttrType),
                subAttribute: AKE_ATTRIBUTE_NAMES[character.subAttrType] ?? `Attr${character.subAttrType}`,
                subAttributeLabel: AKE_ABILITY_LABELS[character.subAttrType] ?? '',
                attributes: attributeLevels,
                defaultWeaponId: grow.defaultWeaponId,
                maxUltimateSp: Number(ultimate?.costValue ?? 0),
                iconUrl: this.characterIcon(characterId),
                skills: groups,
                potentials: (potentials[characterId]?.potentialUnlockBundle ?? []).map(entry => ({
                    level: Number(entry.level),
                    effectId: entry.potentialEffectId,
                    name: this.text(entry.name, `潜能 ${entry.level}`)
                })),
                loadoutEffects: {
                    talent: talentLoadoutEffects,
                    potential: potentialLoadoutEffects
                }
            };
        });
        const catalogWeaponSkill = skillId => {
            const patch = skillPatch[skillId];
            const role = /^sk_wpn_/.test(skillId)
                ? 'passive'
                : /^wpn_sp_attr_/.test(skillId)
                    ? 'secondary'
                    : 'primary';
            const levels = (patch?.SkillPatchDataBundle ?? []).map(entry => {
                const blackboard = skillPatchBlackboard(entry);
                const descriptionTemplate = cleanAkeRichText(this.text(entry.description));
                return {
                    level: Number(entry.level ?? 1),
                    name: this.text(entry.skillName, skillId),
                    tagId: entry.tagId || '',
                    descriptionTemplate,
                    description: renderAkeSkillText(descriptionTemplate, blackboard),
                    blackboard,
                    effects: role === 'passive'
                        ? this.catalogSkillEffects(skillId, { blackboard })
                        : []
                };
            });
            return {
                id: skillId,
                role,
                name: levels[0]?.name ?? skillId,
                tagId: levels[0]?.tagId ?? '',
                levels
            };
        };
        const weaponRows = Object.entries(weapons).map(([weaponId, weapon]) => {
            const item = items[weaponId] ?? {};
            const upgradeCurve = this.table('WeaponUpgradeTemplateTable')[weapon.levelTemplateId];
            const skillIds = [...new Set([
                ...(weapon.weaponSkillList ?? []),
                weapon.weaponPotentialSkill
            ].filter(Boolean))];
            return {
                id: weaponId,
                name: this.text(item.name, weaponId),
                description: this.text(item.decoDesc ?? weapon.weaponDesc),
                rarity: Number(weapon.rarity ?? item.rarity ?? 0),
                weaponTypeId: Number(weapon.weaponType),
                weaponType: AKE_WEAPON_TYPES[weapon.weaponType] ?? String(weapon.weaponType ?? ''),
                maxLevel: Number(weapon.maxLv ?? 90),
                iconUrl: this.itemIcon(weaponId, item.iconId),
                skillIds: structuredClone(skillIds),
                skillPatches: skillIds.map(catalogWeaponSkill),
                attackGrowth: Object.fromEntries((upgradeCurve?.list ?? []).map(entry => [
                    String(entry.weaponLv),
                    Number(entry.baseAtk ?? 0)
                ])),
                passiveSkillId: weapon.weaponPotentialSkill || null
            };
        });
        const equipmentRows = Object.entries(equips).map(([equipmentId, equipment]) => {
            const item = items[equipmentId] ?? {};
            const part = AKE_EQUIPMENT_PARTS[equipment.partType];
            const rawModifiers = equipment.equipAttrModifiers ?? [];
            const catalogEquipmentModifier = displayModifier => {
                const attrIndex = Number(displayModifier.attrIndex);
                const sourceModifiers = rawModifiers.filter(modifier =>
                    Number(modifier.attrIndex) === attrIndex);
                const sourceModifier = sourceModifiers.find(modifier =>
                    Number(modifier.attrType) === Number(displayModifier.attrType))
                    ?? sourceModifiers[0]
                    ?? displayModifier;
                const enhancedValues = Array.isArray(displayModifier.enhancedAttrValues)
                    ? displayModifier.enhancedAttrValues
                    : [];
                const displayValues = [displayModifier.attrValue, ...enhancedValues]
                    .map(Number)
                    .filter(Number.isFinite);
                const sourceValues = (sourceModifier.attrValues ?? [])
                    .map(Number)
                    .filter(Number.isFinite);
                // Keep the raw modifier values for calculations; the display
                // table rounds some enhanced decimals (for example 0.22771962)
                // and exists to describe row grouping, not numeric precision.
                const values = sourceValues.length > 0 ? sourceValues : displayValues;
                return {
                    attrIndex,
                    attrType: Number(displayModifier.attrType),
                    attribute: AKE_ATTRIBUTE_NAMES[displayModifier.attrType]
                        ?? `Attr${displayModifier.attrType}`,
                    sourceAttrTypes: [...new Set(sourceModifiers.map(modifier =>
                        Number(modifier.attrType)))],
                    compositeAttr: displayModifier.compositeAttr || '',
                    modifierType: Number(displayModifier.modifierType ?? sourceModifier.modifierType),
                    modifyAttributeType: Number(sourceModifier.modifyAttributeType ?? 0),
                    zone: AKE_MODIFIER_ZONES[displayModifier.modifierType ?? sourceModifier.modifierType] ?? null,
                    values: structuredClone(values)
                };
            };
            const displayModifiers = equipment.displayAttrModifiers ?? [];
            const baseDisplayModifier = equipment.displayBaseAttrModifier;
            return {
                id: equipmentId,
                name: this.text(item.name, equipmentId),
                description: this.text(item.decoDesc),
                rarity: Number(item.rarity ?? 0),
                partType: Number(equipment.partType),
                partKey: part?.key ?? String(equipment.partType),
                partName: part?.name ?? String(equipment.partType),
                suitId: equipment.suitID || null,
                minWearLevel: Number(equipment.minWearLv ?? 1),
                iconUrl: this.itemIcon(equipmentId, item.iconId),
                baseModifier: baseDisplayModifier
                    ? catalogEquipmentModifier(baseDisplayModifier)
                    : null,
                // AKE stores a composite display affix as several raw modifiers
                // sharing the same attrIndex.  The UI needs one row per displayed
                // affix, otherwise a composite third affix is duplicated or lost.
                modifiers: displayModifiers.map(catalogEquipmentModifier)
            };
        });
        const suitRows = Object.entries(suits).map(([suitId, suit]) => ({
            id: suitId,
            name: this.text(suit.list?.[0]?.suitName, suitId),
            equipmentIds: structuredClone(suit.equipList ?? []),
            bonuses: (suit.list ?? []).map(entry => {
                const skillLevel = Number(entry.skillLv ?? 1);
                const patch = skillPatchAtLevel(skillPatch[entry.skillID], skillLevel);
                const blackboard = skillPatchBlackboard(patch);
                const descriptionTemplate = cleanAkeRichText(this.text(patch?.description));
                return {
                    count: Number(entry.equipCnt ?? 0),
                    skillId: entry.skillID,
                    skillLevel,
                    descriptionTemplate,
                    description: renderAkeSkillText(descriptionTemplate, blackboard),
                    blackboard,
                    effects: this.catalogSkillEffects(entry.skillID, { blackboard })
                };
            })
        }));
        return {
            schemaVersion: 2,
            source: {
                provider: 'AKEDatabase',
                origin: this.dataOrigin,
                version: manifest.sourceVersion?.id,
                sharedRevision: manifest.sharedRevision,
                tableManifest: 'reference/public-data/akedata/table-corpus.manifest.json'
            },
            equipmentSlots: Object.entries(AKE_EQUIPMENT_PARTS).map(([partType, part]) => ({
                partType: Number(partType),
                ...part
            })),
            characters: characterRows.sort((left, right) =>
                right.rarity - left.rarity || left.id.localeCompare(right.id)),
            weapons: weaponRows.sort((left, right) =>
                right.rarity - left.rarity || left.id.localeCompare(right.id)),
            equipment: equipmentRows.sort((left, right) =>
                right.rarity - left.rarity || left.id.localeCompare(right.id)),
            suits: suitRows.sort((left, right) => left.id.localeCompare(right.id))
        };
    }
}

export default AkeDataRepository;
