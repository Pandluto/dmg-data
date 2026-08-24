import { calculateDamage } from './damage.mjs';

function firstFiniteAttribute(context, entityId, names, fallback) {
    for (const name of names) {
        const value = context.getAttribute(entityId, name);
        if (Number.isFinite(Number(value))) return Number(value);
    }
    return fallback;
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
        const attack = firstFiniteAttribute(
            runtime.context,
            sourceId,
            attackAttributes,
            Number.NaN
        );
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
            const attackerZone = runtime.effectSources.damageZone({
                targetId: sourceId,
                side: 'Attacker',
                damageType: unit.damageType
            }, eventContext);
            const defenderZone = runtime.effectSources.damageZone({
                targetId,
                side: 'Defender',
                damageType: unit.damageType
            }, eventContext);
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
                amount: result.finalDamage,
                ...result,
                modifierSnapshot: { attackerZone, defenderZone, specialScale }
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
