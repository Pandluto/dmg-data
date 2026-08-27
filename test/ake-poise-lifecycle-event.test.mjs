import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function readBuff(buffId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
}

function eventContext(frame) {
    return {
        frame,
        eventType: 'Hit',
        sourceId: 'operator',
        ownerId: 'operator',
        targetId: 'enemy',
        skillId: `skill:${frame}`,
        rootSkillId: `skill:${frame}`,
        castId: `cast:${frame}`,
        clockDomainId: 'operator:clock'
    };
}

function runtimeFixture() {
    return new CombatRuntime({
        definitions: {
            entities: [{
                id: 'operator',
                kind: 'Character',
                team: 'ally',
                clockDomainId: 'operator:clock'
            }, {
                id: 'enemy',
                kind: 'Enemy',
                team: 'enemy',
                clockDomainId: 'enemy:clock',
                attributes: { PoiseZeroEvents: 0, PoiseRecoverEvents: 0 },
                resilience: { maxResilience: 20 },
                poise: {
                    enabled: true,
                    maxPoise: 60,
                    recoverySeconds: 2,
                    executionDamageScalar: 1,
                    executionAtbGain: 20,
                    brokenDamageScale: 1.3,
                    breakDamageBuffId: 'fixture:poise-break-damage',
                    executionGateBuffId: 'fixture:poise-execution-gate'
                }
            }],
            buffs: {
                'fixture:poise-break-damage': {
                    lifeType: 'Infinity'
                },
                'fixture:poise-execution-gate': {
                    lifeType: 'Infinity'
                },
                'fixture:poise-listener': {
                    lifeType: 'Infinity',
                    abilityEventActions: [{
                        eventType: 'OnPoiseZero',
                        actions: [{
                            type: 'ModifyAttribute',
                            entity: 'Owner',
                            attribute: 'PoiseZeroEvents',
                            amount: 1
                        }]
                    }, {
                        eventType: 'OnPoiseRecover',
                        actions: [{
                            type: 'ModifyAttribute',
                            entity: 'Owner',
                            attribute: 'PoiseRecoverEvents',
                            amount: 1
                        }]
                    }]
                }
            }
        },
        damageResolver: () => ({
            status: 'Resolved',
            hits: [{
                damageUnitIndex: 0,
                damageAttributeType: 'Poise',
                amount: 60
            }]
        })
    });
}

test('AKE poise zero and recovery are target-owned, ordered lifecycle edges', () => {
    const runtime = runtimeFixture();
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: 'fixture:poise-listener'
    }, eventContext(0));

    runtime.execute({ type: 'ApplyPoiseDamage', target: 'Target', amount: 65 }, eventContext(10));
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseZeroEvents'), 1);
    assert.equal(runtime.poise.snapshot('enemy').broken, true);
    assert.equal(runtime.poise.snapshot('enemy').clockDomainId, 'enemy:clock');
    assert.deepEqual(runtime.statusEffects.list({ active: true, targetId: 'enemy' })
        .map(instance => instance.buffId)
        .filter(buffId => buffId.startsWith('fixture:poise-'))
        .sort(), [
        'fixture:poise-break-damage',
        'fixture:poise-execution-gate',
        'fixture:poise-listener'
    ]);
    const execution = runtime.execute({
        type: 'ConsumePoiseExecution',
        target: 'Target'
    }, eventContext(11));
    assert.equal(execution.stage, 'ExecutionConsumed');
    assert.equal(runtime.poise.canExecute('enemy'), false);
    assert.deepEqual(runtime.statusEffects.list({ active: true, targetId: 'enemy' })
        .map(instance => instance.buffId)
        .filter(buffId => buffId.startsWith('fixture:poise-'))
        .sort(), [
        'fixture:poise-break-damage',
        'fixture:poise-listener'
    ], 'consuming execution removes only the gate while the break damage zone remains');
    assert.equal(runtime.execute({
        type: 'ConsumePoiseExecution',
        target: 'Target'
    }, eventContext(12)), null);
    assert.equal(runtime.resilience.snapshot('enemy').resilience, 20,
        'Poise damage cannot mutate control resilience');
    runtime.execute({ type: 'ApplyPoiseDamage', target: 'Target', amount: 10 }, eventContext(20));
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseZeroEvents'), 1,
        'hits during an existing break cannot repeat OnPoiseZero');

    runtime.runUntil(69);
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseRecoverEvents'), 0);
    runtime.runUntil(70);
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseRecoverEvents'), 1);
    assert.equal(runtime.poise.snapshot('enemy').broken, false);
    assert.deepEqual(runtime.statusEffects.list({ active: true, targetId: 'enemy' })
        .map(instance => instance.buffId)
        .filter(buffId => buffId !== 'fixture:poise-listener'), [],
    'poise recovery removes both intrinsic break statuses');

    runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{ damageAttributeType: 'Poise' }]
    }, eventContext(80));
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseZeroEvents'), 2);
    const poiseLifecycleEvents = new Set([
        'OnBeforeOutputPoiseDamage',
        'OnBeforeTakePoiseDamage',
        'OnTakePoiseDamage',
        'OnPoiseZero'
    ]);
    assert.deepEqual(runtime.trace.filter(entry =>
        entry.stage === 'AbilityEventNotified' && entry.frame === 80
            && poiseLifecycleEvents.has(entry.eventType)
    ).map(entry => entry.eventType), [
        'OnBeforeOutputPoiseDamage',
        'OnBeforeTakePoiseDamage',
        'OnTakePoiseDamage',
        'OnPoiseZero'
    ]);

    runtime.execute({ type: 'ApplyImpact', target: 'Target', amount: 20 }, eventContext(90));
    assert.equal(runtime.resilience.snapshot('enemy').state, 'Staggered');
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseZeroEvents'), 2,
        'control-resilience depletion is not a Poise lifecycle event');
});

test('real AKE poise break Buff changes HP damage only for the broken window', () => {
    const compiler = new AkeActionCompiler({ capabilities: { damageResolver: true } });
    const breakBuffId = 'buff_common_poise_break_damage_taken_scale';
    const breakBuff = compiler.compileBuff(readBuff(breakBuffId));
    const runtime = new CombatRuntime({
        damageResolver: createAkeDamageResolver(),
        definitions: {
            entities: [{
                id: 'operator',
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
                vital: { maxHp: 1000, currentHp: 1000 },
                poise: {
                    enabled: true,
                    maxPoise: 60,
                    recoverySeconds: 2,
                    breakDamageBuffId: breakBuffId
                }
            }],
            buffs: { [breakBuffId]: breakBuff }
        }
    });
    runtime.execute({
        type: 'ApplyPoiseDamage',
        target: 'Target',
        amount: 60
    }, eventContext(0));
    const brokenHit = runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{
            damageType: 'Physical',
            damageAttributeType: 'Hp',
            scale: 1,
            calculationType: 'SimpleAtkScaleCalculation'
        }]
    }, eventContext(1)).resolution.hits[0];
    assert.equal(brokenHit.nonCriticalDamage, 130);
    assert.equal(brokenHit.factors.find(factor =>
        factor.semanticKey === 'defender-zone'
    ).contributions[0].buffId, breakBuffId);

    runtime.runUntil(60);
    const recoveredHit = runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{
            damageType: 'Physical',
            damageAttributeType: 'Hp',
            scale: 1,
            calculationType: 'SimpleAtkScaleCalculation'
        }]
    }, eventContext(61)).resolution.hits[0];
    assert.equal(recoveredHit.nonCriticalDamage, 100);
});
