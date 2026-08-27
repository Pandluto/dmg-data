import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeDataRepository } from '../src/core/ake-data-repository.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const AZRILA_WEAK = 'buff_chr_0009_azrila_normal_skill_weak';
const COMMON_WEAK = 'buff_common_affixes_weak';
const COMMON_WEAK_CHILD = 'buff_common_affixes_weak_default_child';
const WEAK_ACTION_BUFFS = [
    AZRILA_WEAK,
    'buff_chr_0020_meurs_nor_skill_weak',
    'buff_chr_0020_meurs_ult_weak',
    'buff_chr_0020_meurs_ult_weak_strong',
    'buff_chr_0033_camille_normal_skill_weak'
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

function compiledLifecycleActions(definition) {
    return [
        ...(definition.startActions ?? []),
        ...(definition.enableActions ?? []),
        ...(definition.duringEnableActions ?? []),
        ...(definition.triggerActions ?? [])
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

test('every public WeakAction compiles to the shared signed weakness Buff', () => {
    for (const buffId of WEAK_ACTION_BUFFS) {
        const definition = compiler().compileBuff(readBuff(buffId));
        assert.equal(definition.compiler.unresolved.some(item =>
            item.sourceType === 'WeakAction'
        ), false, `${buffId} should not retain a WeakAction compiler gap`);

        const applications = compiledLifecycleActions(definition).filter(action =>
            action.type === 'ApplyBuff'
            && action.buffs?.some(buff => buff.buffId === COMMON_WEAK)
        );
        assert.equal(applications.length > 0, true, `${buffId} should apply common weakness`);
        for (const application of applications) {
            const rate = application.buffs[0].assignments.find(item =>
                item.targetKey === 'rate'
            )?.value;
            assert.equal(rate?.type, 'Multiply');
            assert.deepEqual(rate?.values?.at(-1), -1);
            assert.equal(application.metadata.akeEffectKind, 'Weakness');
            assert.equal(application.asChildBuff, true);
        }
    }
});

test('WeakAction lowers only the carrier outgoing damage and rolls back with its parent', () => {
    const akeCompiler = compiler();
    const definitions = Object.fromEntries([
        AZRILA_WEAK,
        COMMON_WEAK,
        COMMON_WEAK_CHILD
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
                vital: { maxHp: 10000, currentHp: 10000 }
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
                vital: { maxHp: 10000, currentHp: 10000 }
            }],
            buffs: definitions
        }
    });
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: AZRILA_WEAK,
        blackboard: { rate: 0.2, duration: 8 }
    }, {
        frame: 0,
        sourceId: 'azrila',
        ownerId: 'azrila',
        targetId: 'enemy',
        skillId: 'chr_0009_azrila_normal_skill'
    });

    assert.equal(runtime.context.getAttribute('enemy', 'WeaknessDmgScalar'), 0.8);
    assert.equal(hpHit(runtime, 'azrila', 'enemy', 1).nonCriticalDamage, 100);
    assert.equal(hpHit(runtime, 'enemy', 'azrila', 2).nonCriticalDamage, 80);

    const parent = runtime.statusEffects.list({
        active: true,
        buffId: AZRILA_WEAK
    })[0];
    runtime.statusEffects.finish({
        frame: 3,
        instanceId: parent.instanceId,
        reason: 'fixture-parent-finish'
    }, {
        frame: 3,
        sourceId: 'azrila',
        ownerId: 'azrila',
        targetId: 'enemy'
    });
    assert.equal(runtime.context.getAttribute('enemy', 'WeaknessDmgScalar'), 1);
    assert.equal(hpHit(runtime, 'enemy', 'azrila', 4).nonCriticalDamage, 100);
});

test('catalog exposes WeakAction as weakness instead of vulnerability or fragile', () => {
    const effects = new AkeDataRepository().catalogBuffEffects(AZRILA_WEAK, {
        blackboard: { rate: 0.2, duration: 8 }
    });
    assert.deepEqual(effects.map(effect => ({
        type: effect.type,
        value: effect.value
    })), [{
        type: 'weakness',
        value: 0.2
    }]);
});
