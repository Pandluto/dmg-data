import { calculateDamage } from './damage.mjs';

function firstFiniteAttributeEntry(context, entityId, names, fallback) {
    for (const name of names) {
        const value = context.getAttribute(entityId, name);
        if (Number.isFinite(Number(value))) {
            return { attribute: name, value: Number(value), found: true };
        }
    }
    return { attribute: names[0] ?? null, value: fallback, found: false };
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

const AKE_VULNERABLE_ATTRIBUTE = Object.freeze({
    Physical: 'PhysicalVulnerableDmgIncrease',
    Fire: 'FireVulnerableDmgIncrease',
    Pulse: 'PulseVulnerableDmgIncrease',
    Cryst: 'CrystVulnerableDmgIncrease',
    Natural: 'NaturalVulnerableDmgIncrease',
    Ether: 'EtherVulnerableDmgIncrease'
});

const AKE_DAMAGE_TYPE_DISPLAY = Object.freeze({
    Physical: '物理',
    Fire: '灼热',
    Pulse: '电磁',
    Cryst: '寒冷',
    Natural: '自然',
    Ether: '法术'
});

function attributeContribution(entityId, snapshot, value) {
    if (snapshot?.contributions?.length > 0) return snapshot.contributions;
    return [{
        contributionId: `attribute:${String(entityId)}:${String(snapshot?.attribute ?? 'unknown')}:base`,
        semanticKey: `attribute.${String(snapshot?.attribute ?? 'unknown')}`,
        sourceKey: `attribute:${String(entityId)}:${String(snapshot?.attribute ?? 'unknown')}`,
        sourceType: 'Attribute',
        sourceCategory: 'BaseAttribute',
        sourceId: entityId,
        ownerId: entityId,
        carrierId: entityId,
        targetId: entityId,
        damageSourceId: entityId,
        buffId: null,
        buffInstanceId: null,
        sourceSkillId: null,
        rawField: snapshot?.attribute ?? null,
        rawValue: value,
        resolvedValue: value,
        value,
        stackCount: 1,
        appliedFrame: 0,
        expireFrame: null,
        metadata: { baseAttribute: true }
    }];
}

function damageFactor({
    semanticKey,
    displayName,
    rawValue,
    multiplier,
    contributions = [],
    operation = 'Multiply',
    affectsNonCritical = true,
    evidenceStatus = 'runtime'
}) {
    return {
        factorId: `damage-factor:${semanticKey}`,
        semanticKey,
        displayName,
        operation,
        rawValue,
        additive: operation === 'AddRate' ? rawValue : null,
        multiplier,
        finalValue: multiplier,
        affectsNonCritical,
        evidenceStatus,
        contributions
    };
}

function mergeDamageZone(base, additions = []) {
    const zones = new Map((base.zones ?? []).map(zone => [zone.zoneName, zone.addition]));
    for (const contribution of additions) {
        // Attribute-zone source rows are presentation/audit provenance for an
        // aggregate that has already been evaluated by the attribute system.
        // Retain those rows without adding the same value to the zone twice.
        if (contribution.contributesToZone === false) continue;
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
            ...additions.filter(contribution => (
                contribution.metadata?.omitFromContributionLedger !== true
            ))
        ]
    };
}

function selectDamageZones(snapshot, predicate) {
    const zones = (snapshot.zones ?? []).filter(zone => predicate(zone.zoneName));
    const selectedNames = new Set(zones.map(zone => zone.zoneName));
    return {
        ...snapshot,
        scale: zones.reduce((scale, zone) => scale * Number(zone.scale ?? 1), 1),
        zones,
        contributions: (snapshot.contributions ?? []).filter(contribution => (
            selectedNames.has(contribution.zoneName ?? contribution.zone)
        ))
    };
}

function consumedStatusContribution(snapshot, eventContext, addition) {
    const sourceStacks = Array.isArray(snapshot?.sourceStacks)
        ? snapshot.sourceStacks.map(entry => ({
            sourceId: entry?.sourceId ?? null,
            count: Number(entry?.count ?? 0)
        }))
        : [];
    return {
        contributionId: `consumed-status:${String(snapshot.castId)}:${String(snapshot.key)}`,
        semanticKey: `consumed-status.${String(snapshot.stateType ?? snapshot.key)}`,
        sourceKey: `consumed-status:${String(snapshot.castId)}:${String(snapshot.key)}`,
        sourceType: 'ConsumedStatus',
        sourceCategory: 'TeamState',
        sourceId: sourceStacks[0]?.sourceId ?? snapshot.consumerId ?? eventContext.sourceId,
        ownerId: snapshot.consumerId ?? eventContext.ownerId ?? eventContext.sourceId,
        carrierId: eventContext.sourceId,
        targetId: eventContext.sourceId,
        damageSourceId: eventContext.sourceId,
        buffId: snapshot.buffId ?? null,
        buffInstanceId: null,
        sourceSkillId: eventContext.skillId ?? null,
        side: 'Attacker',
        zoneName: 'ComboCalcZone',
        operation: 'AddRate',
        rawField: 'ComboCalcZone',
        rawValue: addition,
        resolvedValue: addition,
        addition,
        stackCount: Number(snapshot.consumedStacks ?? 0),
        appliedFrame: Number(snapshot.frame ?? eventContext.frame ?? 0),
        expireFrame: null,
        contributesToZone: false,
        sourceMetadata: {
            displayName: '连击',
            applicationScope: snapshot.applicationScope ?? 'team'
        },
        metadata: {
            consumedStatus: true,
            stateType: snapshot.stateType ?? null,
            maxStacks: Number(snapshot.maxStacks ?? 0),
            sourceStacks,
            grantIds: Array.isArray(snapshot.grantIds) ? [...snapshot.grantIds] : []
        }
    };
}

function attackerAttributeZone(
    context,
    effectSources,
    sourceId,
    damageType,
    commandType,
    eventContext
) {
    const attributes = [
        AKE_ELEMENT_DAMAGE_ATTRIBUTE[damageType],
        AKE_COMMAND_DAMAGE_ATTRIBUTE[commandType]
    ].filter(Boolean);
    return attributes.flatMap(attribute => {
        const addition = Number(context.getAttribute(sourceId, attribute));
        if (!Number.isFinite(addition) || addition === 0) return [];
        const snapshot = effectSources?.attributeSnapshot?.({
            targetId: sourceId,
            attribute
        }, eventContext);
        const sourceContributions = (snapshot?.contributions ?? []).map(
            (contribution, index) => ({
                ...contribution,
                contributionId: `${String(contribution.contributionId
                    ?? `attribute:${String(sourceId)}:${attribute}:${index}`)}:damage-zone`,
                semanticKey: `damage-zone.${attribute}.${String(
                    contribution.semanticKey ?? index
                )}`,
                side: 'Attacker',
                zoneName: 'NormalCalcZone',
                addition: Number(contribution.resolvedValue
                    ?? contribution.value
                    ?? contribution.rawValue
                    ?? 0),
                contributesToZone: false,
                metadata: {
                    ...contribution.metadata,
                    attributeDamageZoneSource: true
                }
            })
        );
        return [{
            contributionId: `attribute:${String(sourceId)}:${attribute}:damage-zone`,
            semanticKey: `damage-zone.${attribute}`,
            sourceKey: `attribute:${sourceId}:${attribute}`,
            sourceType: 'Attribute',
            sourceCategory: 'Attribute',
            sourceId,
            ownerId: sourceId,
            carrierId: sourceId,
            targetId: sourceId,
            damageSourceId: sourceId,
            buffId: null,
            buffInstanceId: null,
            sourceSkillId: null,
            attribute,
            side: 'Attacker',
            zoneName: 'NormalCalcZone',
            operation: 'AddRate',
            rawField: attribute,
            rawValue: addition,
            resolvedValue: addition,
            addition,
            stackCount: 1,
            appliedFrame: 0,
            expireFrame: null,
            metadata: {
                attributeDamageZone: true,
                // When exact EffectSource rows exist, expose those to all
                // consumers and keep this aggregate only as the math operand.
                omitFromContributionLedger: sourceContributions.length > 0
            }
        }, ...sourceContributions];
    });
}

function configuredDamageBonus(context, sourceId, damageType, commandType) {
    const components = [];
    const read = (attribute, category) => {
        const value = firstFiniteAttribute(context, sourceId, [attribute], 0);
        components.push({ attribute, category, value });
        return value;
    };
    let bonus = read('ConfiguredAllDamageBonus', 'all');
    const elementAttribute = CONFIGURED_ELEMENT_BONUS_ATTRIBUTE[damageType];
    if (elementAttribute) {
        bonus += read(elementAttribute, 'element');
    }
    if (damageType === 'Fire' || damageType === 'Pulse'
        || damageType === 'Cryst' || damageType === 'Natural') {
        bonus += read('ConfiguredMagicDamageBonus', 'magic');
    }
    const commandAttribute = CONFIGURED_COMMAND_BONUS_ATTRIBUTE[commandType];
    if (commandAttribute) {
        bonus += read(commandAttribute, 'command');
    }
    return { total: bonus, components };
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
        const defenseEntry = firstFiniteAttributeEntry(
            runtime.context,
            targetId,
            defenseAttributes,
            0
        );
        const defense = defenseEntry.value;
        const consumedStatuses = runtime.consumedStatusesForCast?.(
            eventContext.castId
        ) ?? [];
        const consumedCombo = consumedStatuses.find(snapshot => (
            snapshot.stateType === 'combo'
        )) ?? null;
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
                payload: {
                    ...eventContext.payload,
                    damageType: unit.damageType,
                    damageTypeMask: unit.damageTypeMask ?? null,
                    damageDecorateMask: Number(unit.damageDecorateMask ?? 0)
                }
            });
            const attackerZone = mergeDamageZone(
                registeredAttackerZone,
                attackerAttributeZone(
                    runtime.context,
                    runtime.effectSources,
                    sourceId,
                    unit.damageType,
                    eventContext.commandType ?? eventContext.skillType,
                    eventContext
                )
            );
            const comboZone = selectDamageZones(
                attackerZone,
                zoneName => zoneName === 'ComboCalcZone'
            );
            const baseAttackerZone = selectDamageZones(
                attackerZone,
                zoneName => zoneName !== 'ComboCalcZone'
            );
            const comboContributions = consumedCombo && comboZone.zones.length > 0
                ? [consumedStatusContribution(
                    consumedCombo,
                    eventContext,
                    Number(comboZone.zones[0]?.addition ?? 0)
                )]
                : comboZone.contributions;
            const defenderZone = runtime.effectSources.damageZone({
                targetId,
                attackerId: sourceId,
                defenderId: targetId,
                side: 'Defender',
                damageType: unit.damageType
            }, {
                ...eventContext,
                payload: {
                    ...eventContext.payload,
                    damageType: unit.damageType,
                    damageTypeMask: unit.damageTypeMask ?? null,
                    damageDecorateMask: Number(unit.damageDecorateMask ?? 0)
                }
            });
            const commandType = eventContext.commandType
                ?? eventContext.payload?.commandType
                ?? eventContext.skillType;
            const resistanceEntry = firstFiniteAttributeEntry(runtime.context, targetId, [
                `${unit.damageType}Resistance`,
                `${unit.damageType}Res`,
                'Resistance',
                'resistance'
            ], 0);
            const resistance = resistanceEntry.value;
            const specialScale = unit.calculationType === 'BreakingAttackCalculation'
                ? firstFiniteAttribute(runtime.context, targetId, [
                    'ExecutionDamageScalar', 'executionDamageScalar'
                ], 1)
                : 1;
            const configuredBonus = configuredDamageBonus(
                runtime.context,
                sourceId,
                unit.damageType,
                commandType
            );
            const configuredDamageBonusScale = Math.max(0, 1 + configuredBonus.total);
            const damageTakenEntry = firstFiniteAttributeEntry(runtime.context, targetId, [
                'DamageTakenScalar', 'damageTakenScalar'
            ], 1);
            // WeakAction is “虚弱”: it lowers damage dealt by the carrier.
            // Therefore WeaknessDmgScalar belongs to the damage source, while
            // VulnerableDmgIncrease remains a defender-side “脆弱” operand.
            const weaknessEntry = firstFiniteAttributeEntry(runtime.context, sourceId, [
                'WeaknessDmgScalar', 'weaknessDmgScalar'
            ], 1);
            const shelterEntry = firstFiniteAttributeEntry(runtime.context, targetId, [
                'ShelterDmgScalar', 'shelterDmgScalar'
            ], 0);
            const vulnerableAttribute = AKE_VULNERABLE_ATTRIBUTE[unit.damageType] ?? null;
            const vulnerableEntry = vulnerableAttribute
                ? firstFiniteAttributeEntry(
                    runtime.context,
                    targetId,
                    [vulnerableAttribute],
                    0
                )
                : { attribute: null, value: 0, found: false };
            const criticalRateEntry = firstFiniteAttributeEntry(runtime.context, sourceId, [
                'CriticalRate', 'criticalRate'
            ], defaultCriticalRate);
            const criticalDamageEntry = firstFiniteAttributeEntry(runtime.context, sourceId, [
                'CriticalDamageIncrease', 'criticalDamageIncrease'
            ], defaultCriticalDamageIncrease);
            const result = calculateDamage({
                attack,
                atkScale,
                defense,
                resistance,
                damageTakenScalar: damageTakenEntry.value,
                vulnerableDmgIncrease: vulnerableEntry.value,
                weaknessDmgScalar: weaknessEntry.value,
                shelterDmgScalar: shelterEntry.value,
                attackerZoneScale: attackerZone.scale,
                defenderZoneScale: defenderZone.scale,
                configuredDamageBonusScale,
                specialScale,
                criticalMode,
                criticalRate: criticalRateEntry.value,
                criticalDamageIncrease: criticalDamageEntry.value
            });
            const snapshotFor = (entityId, entry) => entry.found && entry.attribute
                ? runtime.effectSources.attributeSnapshot({
                    targetId: entityId,
                    attribute: entry.attribute
                }, eventContext)
                : null;
            const attackSnapshot = snapshotFor(sourceId, attackEntry);
            const defenseSnapshot = snapshotFor(targetId, defenseEntry);
            const resistanceSnapshot = snapshotFor(targetId, resistanceEntry);
            const damageTakenSnapshot = snapshotFor(targetId, damageTakenEntry);
            const vulnerableSnapshot = snapshotFor(targetId, vulnerableEntry);
            const weaknessSnapshot = snapshotFor(sourceId, weaknessEntry);
            const shelterSnapshot = snapshotFor(targetId, shelterEntry);
            const criticalRateSnapshot = snapshotFor(sourceId, criticalRateEntry);
            const criticalDamageSnapshot = snapshotFor(sourceId, criticalDamageEntry);
            const configuredContributions = configuredBonus.components.map(component => ({
                contributionId: `attribute:${String(sourceId)}:${component.attribute}:configured`,
                semanticKey: `configured-bonus.${component.category}`,
                sourceKey: `attribute:${String(sourceId)}:${component.attribute}`,
                sourceType: 'ConfiguredAttribute',
                sourceCategory: 'Loadout',
                sourceId,
                ownerId: sourceId,
                carrierId: sourceId,
                targetId: sourceId,
                damageSourceId: sourceId,
                buffId: null,
                buffInstanceId: null,
                sourceSkillId: eventContext.skillId ?? null,
                rawField: component.attribute,
                rawValue: component.value,
                resolvedValue: component.value,
                value: component.value,
                stackCount: 1,
                appliedFrame: 0,
                expireFrame: null,
                metadata: { configuredBonusCategory: component.category }
            }));
            const factors = [
                damageFactor({
                    semanticKey: 'attack', displayName: '攻击力',
                    rawValue: attack, multiplier: attack,
                    contributions: attributeContribution(sourceId, attackSnapshot, attack)
                }),
                damageFactor({
                    semanticKey: 'attack-scale', displayName: '技能倍率',
                    rawValue: atkScale, multiplier: atkScale,
                    contributions: [{
                        contributionId: `skill:${String(eventContext.skillId)}:unit:${damageUnitIndex}:scale`,
                        semanticKey: 'skill.attack-scale',
                        sourceKey: `skill:${String(eventContext.skillId)}`,
                        sourceType: 'Skill', sourceCategory: 'Skill',
                        sourceId, ownerId: eventContext.ownerId ?? sourceId,
                        carrierId: sourceId, targetId, damageSourceId: sourceId,
                        buffId: eventContext.payload?.buffId ?? null,
                        buffInstanceId: eventContext.buffInstanceId ?? null,
                        sourceSkillId: eventContext.skillId ?? null,
                        rawField: 'scale', rawValue: atkScale,
                        resolvedValue: atkScale, value: atkScale,
                        stackCount: 1, appliedFrame: eventContext.frame,
                        expireFrame: null, metadata: { damageUnitIndex }
                    }]
                }),
                damageFactor({
                    semanticKey: 'attacker-zone', displayName: '攻击方增伤区',
                    rawValue: baseAttackerZone.zones, multiplier: baseAttackerZone.scale,
                    contributions: baseAttackerZone.contributions
                }),
                ...(comboZone.zones.length > 0 ? [damageFactor({
                    semanticKey: 'combo-damage', displayName: '连击区',
                    rawValue: comboZone.zones, multiplier: comboZone.scale,
                    contributions: comboContributions
                })] : []),
                damageFactor({
                    semanticKey: 'configured-damage-bonus', displayName: '配置增伤区',
                    rawValue: configuredBonus.total,
                    multiplier: configuredDamageBonusScale,
                    contributions: configuredContributions,
                    operation: 'AddRate'
                }),
                damageFactor({
                    semanticKey: 'defense', displayName: '防御结算',
                    rawValue: defense, multiplier: result.operands.defScale,
                    contributions: attributeContribution(targetId, defenseSnapshot, defense)
                }),
                damageFactor({
                    semanticKey: 'resistance', displayName: '抗性',
                    rawValue: resistance, multiplier: result.operands.resistanceScale,
                    contributions: attributeContribution(targetId, resistanceSnapshot, resistance)
                }),
                damageFactor({
                    semanticKey: 'damage-taken', displayName: '承伤倍率',
                    rawValue: damageTakenEntry.value,
                    multiplier: result.operands.normalizedDamageTakenScalar,
                    contributions: attributeContribution(
                        targetId,
                        damageTakenSnapshot,
                        damageTakenEntry.value
                    )
                }),
                damageFactor({
                    semanticKey: `${String(unit.damageType).toLowerCase()}-vulnerability`,
                    displayName: `${AKE_DAMAGE_TYPE_DISPLAY[unit.damageType]
                        ?? unit.damageType}脆弱`,
                    rawValue: vulnerableEntry.value,
                    multiplier: result.operands.vulnerableDmgScale,
                    contributions: vulnerableSnapshot
                        ? attributeContribution(targetId, vulnerableSnapshot, vulnerableEntry.value)
                        : [],
                    operation: 'AddRate'
                }),
                damageFactor({
                    semanticKey: 'defender-zone', displayName: '敌方易伤区',
                    rawValue: defenderZone.zones, multiplier: defenderZone.scale,
                    contributions: defenderZone.contributions
                }),
                damageFactor({
                    semanticKey: 'weakness', displayName: '虚弱·造成伤害',
                    rawValue: weaknessEntry.value,
                    multiplier: result.operands.weaknessDmgScalar,
                    contributions: attributeContribution(
                        sourceId,
                        weaknessSnapshot,
                        weaknessEntry.value
                    )
                }),
                damageFactor({
                    semanticKey: 'shelter', displayName: '庇护减伤',
                    rawValue: shelterEntry.value,
                    multiplier: result.operands.shelterScale,
                    contributions: attributeContribution(
                        targetId,
                        shelterSnapshot,
                        shelterEntry.value
                    )
                }),
                damageFactor({
                    semanticKey: 'special', displayName: '特殊结算',
                    rawValue: specialScale, multiplier: specialScale
                }),
                damageFactor({
                    semanticKey: 'critical', displayName: '暴击结算',
                    rawValue: {
                        rate: criticalRateEntry.value,
                        damageIncrease: criticalDamageEntry.value,
                        mode: criticalMode
                    },
                    multiplier: result.operands.selectedCriticalScale,
                    contributions: [
                        ...attributeContribution(
                            sourceId,
                            criticalRateSnapshot,
                            criticalRateEntry.value
                        ),
                        ...attributeContribution(
                            sourceId,
                            criticalDamageSnapshot,
                            criticalDamageEntry.value
                        )
                    ],
                    affectsNonCritical: false
                })
            ];
            const reconstructedNonCritical = factors
                .filter(factor => factor.affectsNonCritical !== false)
                .reduce((value, factor) => value * Number(factor.multiplier ?? 1), 1);
            const factorValidation = {
                reconstructedNonCritical,
                expectedNonCritical: result.nonCriticalDamage,
                delta: reconstructedNonCritical - result.nonCriticalDamage,
                valid: Math.abs(reconstructedNonCritical - result.nonCriticalDamage) <= 1e-8
            };
            hits.push({
                damageUnitIndex,
                damageType: unit.damageType,
                damageAttributeType: 'Hp',
                damageDecorateMask: Number(unit.damageDecorateMask ?? 0),
                damageTypeMask: unit.damageTypeMask ?? null,
                amount: result.finalDamage,
                ...result,
                factors,
                factorValidation,
                diagnostics: [],
                confidence: factorValidation.valid ? 'verified' : 'partial',
                consumedStatuses,
                modifierSnapshot: {
                    attackAttribute: attackSnapshot,
                    defenseAttribute: defenseSnapshot,
                    resistanceAttribute: resistanceSnapshot,
                    damageTakenAttribute: damageTakenSnapshot,
                    vulnerableAttribute: vulnerableSnapshot,
                    weaknessAttribute: weaknessSnapshot,
                    shelterAttribute: shelterSnapshot,
                    criticalRateAttribute: criticalRateSnapshot,
                    criticalDamageAttribute: criticalDamageSnapshot,
                    attackerZone,
                    baseAttackerZone,
                    comboZone,
                    consumedStatuses,
                    defenderZone,
                    configuredBonus: configuredBonus.total,
                    configuredBonusComponents: configuredBonus.components,
                    configuredDamageBonusScale,
                    specialScale
                }
            });
        }
        if (unresolved.length > 0 && hits.length > 0) {
            const packetDiagnostic = {
                code: 'AKE_DAMAGE_PACKET_PARTIAL',
                severity: 'error',
                castId: eventContext.castId ?? null,
                skillId: eventContext.skillId ?? null,
                unresolvedDamageUnitIndexes: unresolved.map(entry => entry.damageUnitIndex),
                unresolved: structuredClone(unresolved)
            };
            for (const hit of hits) {
                hit.diagnostics = [...(hit.diagnostics ?? []), packetDiagnostic];
                hit.confidence = 'partial';
            }
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
