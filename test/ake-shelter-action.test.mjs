import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeDataRepository } from '../src/core/ake-data-repository.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const AZRILA_SHELTER = 'buff_chr_0009_azrila_normal_skill_shelter';
const COMMON_SHELTER = 'buff_common_affixes_shelter';
const COMMON_SHELTER_CHILD = 'buff_common_affixes_shelter_default_child';
const SHELTER_ACTION_BUFFS = [
    AZRILA_SHELTER,
    'buff_chr_0009_azrila_ultimate_skill_Shield_Shelter',
    'buff_chr_0014_aurora_reduce_damage',
    'buff_chr_0014_aurora_reduce_damage_remain',
    'buff_chr_0016_laevat_talent_2_1',
    'buff_chr_0020_meurs_reduce_damage',
    'buff_chr_0020_meurs_reduce_damage_remain'
];

function readBuff(buffId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
}

function compiler() {
    return new AkeActionCompiler({
        capabilities: { dynamicBuffIdResolver: true }
    });
}

function findActions(value, predicate, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    const matches = predicate(value) ? [value] : [];
    if (Array.isArray(value)) {
        return [...matches, ...value.flatMap(item => findActions(item, predicate, seen))];
    }
    return [
        ...matches,
        ...Object.values(value).flatMap(item => findActions(item, predicate, seen))
    ];
}

function hpHit(runtime, sourceId, targetId, frame) {
    return runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{
            damageType: 'Physical',
            damageAttributeType: 'Hp',
            scale: 1,
            calculationType: 'SimpleAtkScaleCalculation'
        }]
    }, {
        frame,
        sourceId,
        ownerId: sourceId,
        targetId,
        skillId: `skill.${sourceId}.physical`,
        commandType: 'NormalSkill',
        castId: `cast:${frame}:${sourceId}:${targetId}`
    }).resolution.hits[0];
}

test('every public ShelterAction compiles to the shared shelter Buff', () => {
    for (const buffId of SHELTER_ACTION_BUFFS) {
        const definition = compiler().compileBuff(readBuff(buffId));
        assert.equal(definition.compiler.unresolved.some(item =>
            item.sourceType === 'ShelterAction'
        ), false, `${buffId} should not retain a ShelterAction compiler gap`);

        const applications = findActions(definition, action =>
            action.type === 'ApplyBuff'
            && action.buffs?.some(buff => buff.buffId === COMMON_SHELTER)
        );
        assert.equal(applications.length > 0, true, `${buffId} should apply common shelter`);
        for (const application of applications) {
            assert.equal(application.metadata.akeEffectKind, 'Shelter');
            assert.equal(application.asChildBuff, true);
        }
    }
});

test('ShelterAction lowers only incoming damage and rolls back with its parent', () => {
    const akeCompiler = compiler();
    const definitions = Object.fromEntries([
        AZRILA_SHELTER,
        COMMON_SHELTER,
        COMMON_SHELTER_CHILD
    ].map(buffId => [buffId, akeCompiler.compileBuff(readBuff(buffId))]));
    const runtime = new CombatRuntime({
        damageResolver: createAkeDamageResolver(),
        definitions: {
            entities: [{
                id: 'azrila',
                kind: 'Character',
                team: 'ally',
                attributes: {
                    Atk: 100,
                    Def: 0,
                    PhysicalResistance: 0,
                    DamageTakenScalar: 1,
                    PhysicalVulnerableDmgIncrease: 0,
                    WeaknessDmgScalar: 1,
                    ShelterDmgScalar: 0,
                    CriticalRate: 0,
                    CriticalDamageIncrease: 0
                },
                vital: { maxHp: 10000, currentHp: 10000 },
                resilience: {
                    maxResilience: 100,
                    currentResilience: 100,
                    superArmorLevel: 0
                }
            }, {
                id: 'enemy',
                kind: 'Enemy',
                team: 'enemy',
                attributes: {
                    Atk: 100,
                    Def: 0,
                    PhysicalResistance: 0,
                    DamageTakenScalar: 1,
                    PhysicalVulnerableDmgIncrease: 0,
                    WeaknessDmgScalar: 1,
                    ShelterDmgScalar: 0,
                    CriticalRate: 0,
                    CriticalDamageIncrease: 0
                },
                vital: { maxHp: 10000, currentHp: 10000 },
                resilience: {
                    maxResilience: 100,
                    currentResilience: 100,
                    superArmorLevel: 0
                }
            }],
            buffs: definitions
        }
    });
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: AZRILA_SHELTER,
        blackboard: { rate: 0.25, duration: 8 }
    }, {
        frame: 0,
        sourceId: 'azrila',
        ownerId: 'azrila',
        targetId: 'azrila',
        skillId: 'chr_0009_azrila_normal_skill'
    });

    assert.equal(runtime.context.getAttribute('azrila', 'ShelterDmgScalar'), 0.25);
    assert.equal(hpHit(runtime, 'enemy', 'azrila', 1).nonCriticalDamage, 75);
    assert.equal(hpHit(runtime, 'azrila', 'enemy', 2).nonCriticalDamage, 100);

    const parent = runtime.statusEffects.list({
        active: true,
        buffId: AZRILA_SHELTER
    })[0];
    runtime.statusEffects.finish({
        frame: 3,
        instanceId: parent.instanceId,
        reason: 'fixture-parent-finish'
    }, {
        frame: 3,
        sourceId: 'azrila',
        ownerId: 'azrila',
        targetId: 'azrila'
    });
    assert.equal(runtime.context.getAttribute('azrila', 'ShelterDmgScalar'), 0);
    assert.equal(hpHit(runtime, 'enemy', 'azrila', 4).nonCriticalDamage, 100);
});

test('catalog exposes ShelterAction as incoming damage reduction', () => {
    const effects = new AkeDataRepository().catalogBuffEffects(AZRILA_SHELTER, {
        blackboard: { rate: 0.25, duration: 8 }
    });
    assert.deepEqual(effects.map(effect => ({
        type: effect.type,
        value: effect.value
    })), [{
        type: 'damageReduction',
        value: 0.25
    }]);
});
