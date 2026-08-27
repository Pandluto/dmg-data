import assert from 'node:assert/strict';
import test from 'node:test';

import { CombatRuntime } from '../src/core/combat-runtime.mjs';

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
                    brokenDamageScale: 1.3
                }
            }],
            buffs: {
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

    runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{ damageAttributeType: 'Poise' }]
    }, eventContext(80));
    assert.equal(runtime.context.getAttribute('enemy', 'PoiseZeroEvents'), 2);
    assert.deepEqual(runtime.trace.filter(entry =>
        entry.stage === 'AbilityEventNotified' && entry.frame === 80
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
