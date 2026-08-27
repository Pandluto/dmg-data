export function calculateDamage({
    attack,
    atkScale,
    defense,
    resistance = 0,
    damageTakenScalar = 1,
    vulnerableDmgIncrease = 0,
    weaknessDmgScalar = 1,
    shelterDmgScalar = 0,
    attackerZoneScale = 1,
    defenderZoneScale = 1,
    configuredDamageBonusScale = 1,
    specialScale = 1,
    criticalMode = 'None',
    criticalRate = 0.05,
    criticalDamageIncrease = 0.5
}) {
    const rawDamage = attack * atkScale;
    const defEfficiency = 0.01;
    const defScale = 1 / (1 + defense * defEfficiency);
    const resistancePercentDivisor = 100;
    const resistanceScale = Math.max(0, 1 - resistance / resistancePercentDivisor);
    const normalizedDamageTakenScalar = Math.max(0, damageTakenScalar);
    // Kept as an alias for older report consumers; v3 exposes both operands.
    const damageTypeResistanceScale = resistanceScale * normalizedDamageTakenScalar;
    const vulnerableDmgScale = Math.max(0, 1 + vulnerableDmgIncrease);
    const normalizedWeaknessDmgScalar = Math.max(0, weaknessDmgScalar);
    const shelterScale = Math.max(0, 1 - shelterDmgScalar);
    const igniteDamageScalar = 1;
    const physicalInflictionDamageScalar = 1;
    const sharedScale = defScale
        * damageTypeResistanceScale
        * vulnerableDmgScale
        * normalizedWeaknessDmgScalar
        * shelterScale
        * igniteDamageScalar
        * physicalInflictionDamageScalar;
    const nonCriticalScale = 1;
    const allCriticalScale = 1 + criticalDamageIncrease;
    const expectedCriticalScale = 1 + criticalRate * criticalDamageIncrease;
    const selectedCriticalScale = criticalMode === 'All'
        ? allCriticalScale
        : criticalMode === 'Expect'
            ? expectedCriticalScale
            : 1;
    const isCritical = criticalMode === 'All';
    const commonScale = attackerZoneScale
        * defenderZoneScale
        * configuredDamageBonusScale
        * sharedScale
        * specialScale;
    const nonCriticalDamage = rawDamage * commonScale * nonCriticalScale;
    const criticalDamage = rawDamage * commonScale * allCriticalScale;
    const expectedDamage = rawDamage * commonScale * expectedCriticalScale;
    const finalDamage = rawDamage
        * attackerZoneScale
        * defenderZoneScale
        * configuredDamageBonusScale
        * sharedScale
        * specialScale
        * selectedCriticalScale;

    return {
        rawDamage,
        finalDamage,
        nonCriticalDamage,
        criticalDamage,
        expectedDamage,
        isCritical,
        operands: {
            attack,
            atkScale,
            defense,
            defEfficiency,
            defScale,
            resistance,
            resistancePercentDivisor,
            damageTakenScalar,
            normalizedDamageTakenScalar,
            resistanceScale,
            damageTypeResistanceScale,
            vulnerableDmgIncrease,
            vulnerableDmgScale,
            weaknessDmgScalar: normalizedWeaknessDmgScalar,
            shelterDmgScalar,
            shelterScale,
            igniteDamageScalar,
            physicalInflictionDamageScalar,
            sharedScale,
            attackerZoneScale,
            defenderZoneScale,
            configuredDamageBonusScale,
            specialScale,
            criticalRate,
            criticalDamageIncrease,
            selectedCriticalScale,
            nonCriticalScale,
            allCriticalScale,
            expectedCriticalScale
        }
    };
}
