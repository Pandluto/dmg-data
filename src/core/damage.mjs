export function calculateDamage({
    attack,
    atkScale,
    defense,
    resistance = 0,
    damageTakenScalar = 1,
    weaknessDmgScalar = 1,
    shelterDmgScalar = 0,
    attackerZoneScale = 1,
    defenderZoneScale = 1,
    specialScale = 1,
    criticalMode = 'None',
    criticalRate = 0.05,
    criticalDamageIncrease = 0.5
}) {
    const rawDamage = attack * atkScale;
    const defEfficiency = 0.01;
    const defScale = 1 / (1 + defense * defEfficiency);
    const resistancePercentDivisor = 100;
    const damageTypeResistanceScale = Math.max(
        0,
        (1 - resistance / resistancePercentDivisor) * damageTakenScalar
    );
    const shelterScale = 1 - shelterDmgScalar;
    const igniteDamageScalar = 1;
    const physicalInflictionDamageScalar = 1;
    const sharedScale = defScale
        * damageTypeResistanceScale
        * weaknessDmgScalar
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
    const commonScale = attackerZoneScale * defenderZoneScale * sharedScale * specialScale;
    const nonCriticalDamage = rawDamage * commonScale * nonCriticalScale;
    const criticalDamage = rawDamage * commonScale * allCriticalScale;
    const expectedDamage = rawDamage * commonScale * expectedCriticalScale;
    const finalDamage = rawDamage
        * attackerZoneScale
        * defenderZoneScale
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
            damageTypeResistanceScale,
            weaknessDmgScalar,
            shelterDmgScalar,
            shelterScale,
            igniteDamageScalar,
            physicalInflictionDamageScalar,
            sharedScale,
            attackerZoneScale,
            defenderZoneScale,
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
