import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const VULNERABLE = 'buff_common_affixes_vulnerable_physical';
const WEAKNESS = 'buff_common_affixes_weak';

function compileRealBuff(buffId) {
    const raw = JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
    return new AkeActionCompiler().compileBuff(raw);
}

function createRuntime() {
    return new CombatRuntime({
        damageResolver: createAkeDamageResolver(),
        definitions: {
            entities: [{
                id: 'caster',
                kind: 'Character',
                team: 'ally',
                attributes: { Atk: 100, CriticalRate: 0, CriticalDamageIncrease: 0 }
            }, {
                id: 'enemy',
                kind: 'Enemy',
                team: 'enemy',
                attributes: {
                    Def: 0,
                    PhysicalResistance: 0,
                    DamageTakenScalar: 1,
                    PhysicalVulnerableDmgIncrease: 0,
                    WeaknessDmgScalar: 1,
                    ShelterDmgScalar: 0
                },
                vital: { maxHp: 10000, currentHp: 10000 }
            }],
            buffs: {
                [VULNERABLE]: compileRealBuff(VULNERABLE),
                [WEAKNESS]: compileRealBuff(WEAKNESS)
            }
        }
    });
}

const context = {
    eventType: 'DamageFixture',
    sourceId: 'caster',
    ownerId: 'caster',
    targetId: 'enemy',
    skillId: 'skill.fixture',
    commandType: 'NormalSkill'
};

function hit(runtime, frame) {
    const result = runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{
            damageType: 'Physical',
            damageAttributeType: 'Hp',
            scale: 1,
            calculationType: 'SimpleAtkScaleCalculation'
        }]
    }, { ...context, frame, castId: `cast:${frame}` });
    return result.resolution.hits[0];
}

test('real physical vulnerability fixture is a named enemy debuff factor and reconstructs damage', () => {
    const runtime = createRuntime();
    runtime.execute({ type: 'ApplyBuff', target: 'Target', buffId: VULNERABLE }, {
        ...context, frame: 0, castId: 'cast:vulnerable'
    });
    const resolved = hit(runtime, 1);
    const factor = resolved.factors.find(entry => entry.semanticKey === 'physical-vulnerable');

    assert.equal(resolved.nonCriticalDamage, 120);
    assert.equal(resolved.factorValidation.valid, true);
    assert.equal(factor.displayName, '物理易伤');
    assert.equal(factor.rawValue, 0.2);
    assert.equal(factor.multiplier, 1.2);
    assert.equal(factor.contributions.length, 1);
    assert.equal(factor.contributions[0].buffId, VULNERABLE);
    assert.equal(factor.contributions[0].carrierId, 'enemy');
    assert.equal(factor.contributions[0].damageSourceId, 'caster');
});

test('real AKE weakness signed rate is converted only at its evidenced factor slot', () => {
    const runtime = createRuntime();
    runtime.execute({ type: 'ApplyBuff', target: 'Target', buffId: WEAKNESS }, {
        ...context, frame: 0, castId: 'cast:weakness'
    });
    const resolved = hit(runtime, 1);
    const factor = resolved.factors.find(entry => entry.semanticKey === 'weakness');

    assert.equal(runtime.context.getAttribute('enemy', 'WeaknessDmgScalar'), 0.8);
    assert.equal(resolved.nonCriticalDamage, 80);
    assert.equal(resolved.factorValidation.valid, true);
    assert.equal(factor.rawValue, 0.8);
    assert.equal(factor.multiplier, 0.8);
    assert.equal(factor.contributions[0].rawValue, -0.2);
    assert.equal(factor.contributions[0].resolvedValue, 0.8);
    assert.equal(factor.contributions[0].metadata.evidenceKey,
        'ake:WeaknessDmgScalar:FinalMultiplier');
});
