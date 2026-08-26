import { calculateDamage } from './damage.mjs';

function firstFiniteAttributeEntry(context, entityId, names, fallback) {
    for (const name of names) {
        const value = context.getAttribute(entityId, name);
        if (Number.isFinite(Number(value))) return { attribute: name, value: Number(value) };
    }
    return { attribute: names[0] ?? null, value: fallback };
}

function firstFiniteAttribute(context, entityId, names, fallback) {
    return firstFiniteAttributeEntry(context, entityId, names, fallback).value;
}

function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
    return number;
}

function supportedHpCalculation(type) {
    return type === undefined || type === null || type === ''
        || type === 'AtkScaleCalculation'
        || type === 'SimpleAtkScaleCalculation'
        || type === 'BreakingAttackCalculation'
        || String(type).endsWith('AtkCalculation');
}

const CONFIGURED_ELEMENT_BONUS_ATTRIBUTE = Object.freeze({
    Physical: 'ConfiguredPhysicalDamageBonus',
    Fire: 'ConfiguredFireDamageBonus',
    Pulse: 'ConfiguredPulseDamageBonus',
    Cryst: 'ConfiguredCrystDamageBonus',
    Natural: 'ConfiguredNaturalDamageBonus'
});

const CONFIGURED_COMMAND_BONUS_ATTRIBUTE = Object.freeze({
    Attack: 'ConfiguredNormalAttackDamageBonus',
    NormalSkill: 'ConfiguredNormalSkillDamageBonus',
    ComboSkill: 'ConfiguredComboSkillDamageBonus',
    UltimateSkill: 'ConfiguredUltimateSkillDamageBonus'
});

const AKE_ELEMENT_DAMAGE_ATTRIBUTE = Object.freeze({
    Physical: 'PhysicalDamageIncrease',
    Fire: 'FireDamageIncrease',
    Pulse: 'PulseDamageIncrease',
    Cryst: 'CrystDamageIncrease',
    Natural: 'NaturalDamageIncrease',
    Ether: 'EtherDamageIncrease'
});

const AKE_COMMAND_DAMAGE_ATTRIBUTE = Object.freeze({
    Attack: 'NormalAttackDamageIncrease',
    NormalAttack: 'NormalAttackDamageIncrease',
    NormalSkill: 'NormalSkillDamageIncrease',
    ComboSkill: 'ComboSkillDamageIncrease',
    UltimateSkill: 'UltimateSkillDamageIncrease'
});

function mergeDamageZone(base, additions = []) {
    const zones = new Map((base.zones ?? []).map(zone => [zone.zoneName, zone.addition]));
    for (const contribution of additions) {
        zones.set(
            contribution.zoneName,
            (zones.get(contribution.zoneName) ?? 0) + contribution.addition
        );
    }
    const zoneValues = [...zones.entries()].map(([zoneName, addition]) => ({
        zoneName,
        addition,
        scale: 1 + addition
    }));
    return {
        ...base,
        scale: zoneValues.reduce((scale, zone) => scale * zone.scale, 1),
        zones: zoneValues,
        contributions: [
            ...(base.contributions ?? []),
            ...additions
        ]
    };
}

function attackerAttributeZone(context, sourceId, damageType, commandType) {
    const attributes = [
        AKE_ELEMENT_DAMAGE_ATTRIBUTE[damageType],
        AKE_COMMAND_DAMAGE_ATTRIBUTE[commandType]
    ].filter(Boolean);
    return attributes.flatMap(attribute => {
        const addition = Number(context.getAttribute(sourceId, attribute));
        return Number.isFinite(addition) && addition !== 0 ? [{
            sourceKey: `attribute:${sourceId}:${attribute}`,
            sourceType: 'Attribute',
            attribute,
            side: 'Attacker',
            zoneName: 'NormalCalcZone',
            addition
        }] : [];
    });
}

function configuredDamageBonus(context, sourceId, damageType, commandType) {
    let bonus = firstFiniteAttribute(
        context,
        sourceId,
        ['ConfiguredAllDamageBonus'],
        0
    );
    const elementAttribute = CONFIGURED_ELEMENT_BONUS_ATTRIBUTE[damageType];
    if (elementAttribute) {
        bonus += firstFiniteAttribute(context, sourceId, [elementAttribute], 0);
    }
    if (damageType === 'Fire' || damageType === 'Pulse'
        || damageType === 'Cryst' || damageType === 'Natural') {
        bonus += firstFiniteAttribute(
            context,
            sourceId,
            ['ConfiguredMagicDamageBonus'],
            0
        );
    }
    const commandAttribute = CONFIGURED_COMMAND_BONUS_ATTRIBUTE[commandType];
    if (commandAttribute) {
        bonus += firstFiniteAttribute(context, sourceId, [commandAttribute], 0);
    }
    return bonus;
}

/**
 * Creates the default clean-room adapter for compiled AKE DamageAction nodes.
 * Entity attributes and active damage-zone Buff sources are read at hit time.
 */
export function createAkeDamageResolver({
    attackAttributes = ['Atk', 'Attack', 'attack'],
    defenseAttributes = ['Def', 'Defense', 'defense'],
    criticalMode = 'None',
    defaultCriticalRate = 0.05,
    defaultCriticalDamageIncrease = 0.5
} = {}) {
    return ({ action, eventContext, runtime, resolveValue }) => {
        const sourceId = eventContext.sourceId;
        const targetId = eventContext.targetId;
        if (sourceId === null || sourceId === undefined
            || targetId === null || targetId === undefined) {
            return {
                status: 'Unresolved',
                reason: 'DamageSourceOrTargetMissing',
                hits: []
            };
        }
        const attackEntry = firstFiniteAttributeEntry(
            runtime.context,
            sourceId,
            attackAttributes,
            Number.NaN
        );
        const attack = attackEntry.value;
        const defense = firstFiniteAttribute(runtime.context, targetId, defenseAttributes, 0);
        const hits = [];
        const unresolved = [];
        for (const [damageUnitIndex, unit] of (action.damageUnits ?? []).entries()) {
            if (unit.damageAttributeType === 'Poise'
                || unit.damageAttributeType === 'Resilience') {
                let amount = finite(resolveValue(unit.poiseValue ?? unit.scale ?? 0), 'poise value');
                if (unit.poiseApplyScale) {
                    amount *= finite(resolveValue(unit.poiseValueScale ?? 1), 'poise value scale');
                }
                amount *= firstFiniteAttribute(
                    runtime.context,
                    sourceId,
                    ['PoiseDamageOutputScalar', 'ResilienceDamageOutputScalar'],
                    1
                );
                amount *= firstFiniteAttribute(
                    runtime.context,
                    targetId,
                    ['PoiseDamageTakenScalar', 'ResilienceDamageTakenScalar'],
                    1
                );
                hits.push({
                    damageUnitIndex,
                    damageType: unit.damageType,
                    damageAttributeType: unit.damageAttributeType,
                    damageDecorateMask: Number(unit.damageDecorateMask ?? 0),
                    damageTypeMask: unit.damageTypeMask ?? null,
                    amount,
                    finalDamage: amount,
                    operands: { kind: 'Poise', amount }
                });
                continue;
            }
            if (unit.damageAttributeType !== 'Hp') continue;
            if (!Number.isFinite(attack)) {
                unresolved.push({
                    damageUnitIndex,
                    code: 'AKE_ATTACK_ATTRIBUTE_MISSING',
                    sourceId,
                    attributes: attackAttributes
                });
                continue;
            }
            if (!supportedHpCalculation(unit.calculationType)) {
                unresolved.push({
                    damageUnitIndex,
                    code: 'AKE_DAMAGE_CALCULATION_UNSUPPORTED',
                    calculationType: unit.calculationType
                });
                continue;
            }
            const atkScale = finite(resolveValue(unit.scale ?? 0), 'attack scale')
                * finite(resolveValue(unit.calculationMultiplier ?? 1), 'calculation multiplier');
            const registeredAttackerZone = runtime.effectSources.damageZone({
                targetId: sourceId,
                attackerId: sourceId,
                defenderId: targetId,
                side: 'Attacker',
                damageType: unit.damageType
            }, {
                ...eventContext,
                payload: { ...eventContext.payload, damageType: unit.damageType }
            });
            const attackerZone = mergeDamageZone(
                registeredAttackerZone,
                attackerAttributeZone(
                    runtime.context,
                    sourceId,
                    unit.damageType,
                    eventContext.commandType ?? eventContext.skillType
                )
            );
            const defenderZone = runtime.effectSources.damageZone({
                targetId,
                attackerId: sourceId,
                defenderId: targetId,
                side: 'Defender',
                damageType: unit.damageType
            }, {
                ...eventContext,
                payload: { ...eventContext.payload, damageType: unit.damageType }
            });
            const resistance = firstFiniteAttribute(runtime.context, targetId, [
                `${unit.damageType}Resistance`,
                `${unit.damageType}Res`,
                'Resistance',
                'resistance'
            ], 0);
            const specialScale = unit.calculationType === 'BreakingAttackCalculation'
                ? firstFiniteAttribute(runtime.context, targetId, [
                    'ExecutionDamageScalar', 'executionDamageScalar'
                ], 1)
                : 1;
            const configuredBonus = configuredDamageBonus(
                runtime.context,
                sourceId,
                unit.damageType,
                eventContext.commandType
            );
            const configuredDamageBonusScale = Math.max(0, 1 + configuredBonus);
            const result = calculateDamage({
                attack,
                atkScale,
                defense,
                resistance,
                damageTakenScalar: firstFiniteAttribute(runtime.context, targetId, [
                    'DamageTakenScalar', 'damageTakenScalar'
                ], 1),
                weaknessDmgScalar: firstFiniteAttribute(runtime.context, targetId, [
                    'WeaknessDmgScalar', 'weaknessDmgScalar'
                ], 1),
                shelterDmgScalar: firstFiniteAttribute(runtime.context, targetId, [
                    'ShelterDmgScalar', 'shelterDmgScalar'
                ], 0),
                attackerZoneScale: attackerZone.scale,
                defenderZoneScale: defenderZone.scale,
                configuredDamageBonusScale,
                specialScale,
                criticalMode,
                criticalRate: firstFiniteAttribute(runtime.context, sourceId, [
                    'CriticalRate', 'criticalRate'
                ], defaultCriticalRate),
                criticalDamageIncrease: firstFiniteAttribute(runtime.context, sourceId, [
                    'CriticalDamageIncrease', 'criticalDamageIncrease'
                ], defaultCriticalDamageIncrease)
            });
            hits.push({
                damageUnitIndex,
                damageType: unit.damageType,
                damageAttributeType: 'Hp',
                damageDecorateMask: Number(unit.damageDecorateMask ?? 0),
                damageTypeMask: unit.damageTypeMask ?? null,
                amount: result.finalDamage,
                ...result,
                modifierSnapshot: {
                    attackAttribute: attackEntry.attribute
                        ? runtime.effectSources.attributeSnapshot({
                            targetId: sourceId,
                            attribute: attackEntry.attribute
                        }, eventContext)
                        : null,
                    attackerZone,
                    defenderZone,
                    configuredBonus,
                    configuredDamageBonusScale,
                    specialScale
                }
            });
        }
        return {
            status: hits.length === 0 && unresolved.length > 0
                ? 'Unresolved'
                : unresolved.length > 0
                    ? 'PartiallyApplied'
                    : 'Applied',
            hits,
            unresolved
        };
    };
}

export default createAkeDamageResolver;
