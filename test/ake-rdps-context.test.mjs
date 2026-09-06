import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { buildAkeRdpsContext } from '../src/core/ake-rdps-context.mjs';

const characters = ['caster', 'support'].map(id => ({ localCharacterId: id, akeCharacterId: id, memberId: id }));
const effects = [
    { sourceKey: 'weapon', sourceId: 'support', ownerId: 'caster', targetId: 'caster', sourceType: 'WeaponPassive',
        modifiers: [{ attribute: 'Atk', zone: 'BaseMultiplier', value: .2 }] },
    { sourceKey: 'equipment', sourceId: 'caster', targetId: 'caster', sourceType: 'EquipmentSet',
        modifiers: [{ attribute: 'Atk', zone: 'FinalMultiplier', value: 1.5 },
            { attribute: 'PhysicalDamageIncrease', zone: 'FinalAddition', value: .3 },
            { attribute: 'CriticalRate', zone: 'Addition', value: .4 }] },
    { sourceKey: 'operator', sourceId: 'support', targetId: 'enemy', sourceType: 'Skill',
        modifiers: [{ attribute: 'PhysicalResistance', zone: 'Addition', value: -20 }] },
];
const keys = ['support::weapon', 'caster::equipment', 'support::operator'];
function resolve(enabled = new Set(keys), extras = []) {
    const runtime = new CombatRuntime({ damageResolver: createAkeDamageResolver(), definitions: { entities: [
        { id: 'caster', kind: 'Character', team: 'ally', attributes: { Atk: 150, PhysicalDamageIncrease: .25, CriticalRate: .1, CriticalDamageIncrease: .5 } },
        { id: 'support', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
        { id: 'enemy', kind: 'Enemy', team: 'enemy', vital: { maxHp: 1e9, currentHp: 1e9 }, attributes: { Def: 20, PhysicalResistance: 10 } },
    ] } });
    // Pre-applied static equipment panel must remain in the no-buff direct baseline.
    runtime.effectSources.registerAttributeComponents('caster', { Atk: { rawValue: 100, baseAddition: 50 } });
    runtime.effectSources.registerBaselineSources('caster', [{ sourceKey: 'static-equip', sourceId: 'caster', sourceType: 'Equipment',
        modifiers: [{ attribute: 'Atk', zone: 'BaseAddition', value: 50 }] }]);
    runtime.effectSources.registerBaselineSources('caster', [{ sourceKey: 'configured-crit',
        modifiers: [{ attribute: 'CriticalRate', zone: 'Addition', value: .1 }] }]);
    effects.forEach((effect, i) => { if (enabled.has(keys[i])) runtime.effectSources.apply(effect); });
    extras.forEach(effect => runtime.effectSources.apply(effect));
    const result = runtime.execute({ type: 'ResolveDamagePacket', damageUnits: [{ damageType: 'Physical', damageAttributeType: 'Hp', scale: 2 }] },
        { frame: 0, sourceId: 'caster', targetId: 'enemy', ownerId: 'caster', skillId: 'skill', commandType: 'NormalSkill' });
    return { ...result.resolution.hits[0], sourceId: 'caster', memberId: 'caster', targetId: 'enemy' };
}
const near = (a, b) => assert(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test('RD coalitions reproduce actual runtime recalculation across nonlinear ATK, equipment crit/bonus, resistance and foreign weapon', () => {
    const hit = resolve();
    const context = buildAkeRdpsContext({ hits: [hit], characters, enemyId: 'enemy' });
    const before = JSON.stringify(hit);
    for (let mask = 0; mask < 8; mask++) {
        const enabled = new Set(keys.filter((_, i) => (mask & (1 << i)) !== 0));
        near(context.evaluateTotal(enabled), resolve(enabled).expectedDamage);
    }
    assert.equal(JSON.stringify(hit), before, 'coalitions cannot mutate frozen hit inputs');
    assert.equal(context.audit.maximumHitError, 0);
    assert.equal(context.audit.unresolvedApplicationCount, 0);
    assert(context.applications.some(a => a.sourceKey === 'support::weapon'));
    assert(!context.applications.some(a => a.applicationKey.includes('static-equip')));
    near(context.directDamageByCharacter.get('caster'), resolve(new Set()).expectedDamage);
});
test('unknown effects and strict imbalance have independently reconciled residuals; source negatives stay signed', () => {
    const extras = [
        { sourceKey: 'unknown', sourceId: 'environment', targetId: 'caster', sourceType: 'Global', modifiers: [{ attribute: 'Atk', zone: 'Addition', value: 25 }] },
        { sourceKey: 'imbalance', sourceId: 'support', targetId: 'enemy', sourceType: 'StatusEffect', metadata: { rdpsExcludedReason: 'imbalance' },
            damageModifiers: [{ side: 'Defender', processors: [{ zoneName: 'ProdCalcZone', addition: .3 }] }] },
        { sourceKey: 'negative', sourceId: 'caster', targetId: 'caster', sourceType: 'Skill', modifiers: [{ attribute: 'Atk', zone: 'FinalMultiplier', value: .8 }] },
    ];
    const context = buildAkeRdpsContext({ hits: [resolve(new Set(keys), extras)], characters, enemyId: 'enemy' });
    const all = new Set(context.applications.map(a => a.sourceKey));
    assert(context.audit.excludedImbalanceDamage > 0);
    assert(context.audit.unresolvedBaselineDamage > 0);
    assert.equal(context.excludedImbalanceEffectCount, 1);
    assert.equal(context.audit.unresolvedApplicationCount, 1);
    const withoutNegative = new Set([...all].filter(key => key !== 'caster::operator'));
    assert(context.evaluateTotal(all) < context.evaluateTotal(withoutNegative));
    near(context.evaluateTotal(all), resolve(new Set(keys), extras.filter(e => e.sourceKey !== 'imbalance')).expectedDamage);
});
test('generated damage disappears with its source; self HP and both poise types never enter output RD', () => {
    const hit = { ...resolve(), sourceBuffId: 'proc', sourceBuffInstanceId: 'status:proc' };
    const context = buildAkeRdpsContext({ hits: [hit, { ...hit, targetId: 'caster' },
        { ...hit, damageAttributeType: 'Poise' }, { ...hit, damageAttributeType: 'Resilience' }], characters, enemyId: 'enemy',
        statusEvents: [{ instanceId: 'status:proc', sourceId: 'support', sourceMetadata: { loadoutSourceKey: 'WeaponPassive:weapon:support', sourceType: 'WeaponPassive' } }] });
    assert.equal(context.audit.hitCount, 1);
    assert.equal(context.evaluateTotal(new Set()), 0);
    assert.equal(context.directDamageByCharacter.get('caster'), 0);
    near(context.actualTotal, hit.expectedDamage);
    assert.throws(() => buildAkeRdpsContext({ hits: [{ ...hit, modifierSnapshot: {} }], characters, enemyId: 'enemy' }), /旧结算/);
    assert.throws(() => buildAkeRdpsContext({ hits: [{ ...hit, expectedDamage: Number.NaN }], characters, enemyId: 'enemy' }), /非有限/);
    assert.throws(() => buildAkeRdpsContext({ hits: [{ ...hit, expectedDamage: hit.expectedDamage + 10 }], characters, enemyId: 'enemy' }), /重算与原命中不一致/);
});
