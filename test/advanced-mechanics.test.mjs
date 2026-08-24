import assert from 'node:assert/strict';
import test from 'node:test';

import { AuraMachine } from '../src/core/aura-machine.mjs';
import { ReactionMachine } from '../src/core/reaction-machine.mjs';
import { ResilienceMachine } from '../src/core/resilience-machine.mjs';

test('aura target enter/leave and source/owner cleanup preserve ownership', () => {
    const lifecycle = [];
    const machine = new AuraMachine({
        definitions: {
            pulse: {
                ruleId: 'rule-pulse',
                onApplyTarget: context => lifecycle.push(['enter', context.targetId, context.sourceId, context.ownerId]),
                onRemoveTarget: context => lifecycle.push(['leave', context.targetId, context.sourceId, context.ownerId])
            }
        }
    });

    const first = machine.createAura({
        frame: 10,
        auraId: 'pulse',
        sourceId: 'summon-a',
        ownerId: 'character-a',
        targetIds: ['enemy-a', 'enemy-b']
    });
    machine.refreshTargets({ frame: 12, auraInstanceId: first.instanceId, targetIds: ['enemy-b', 'enemy-c'] });
    assert.deepEqual(lifecycle, [
        ['enter', 'enemy-a', 'summon-a', 'character-a'],
        ['enter', 'enemy-b', 'summon-a', 'character-a'],
        ['enter', 'enemy-c', 'summon-a', 'character-a'],
        ['leave', 'enemy-a', 'summon-a', 'character-a']
    ]);

    const second = machine.createAura({
        frame: 20,
        auraId: 'pulse',
        sourceId: 'summon-b',
        ownerId: 'character-a',
        targetIds: ['enemy-z']
    });
    const removed = machine.removeBySource({ frame: 21, sourceId: 'summon-a' });
    assert.equal(removed.removedCount, 1);
    assert.deepEqual(machine.getAura(second.instanceId).targetIds, ['enemy-z']);
    machine.removeByOwner({ frame: 22, ownerId: 'character-a' });
    assert.equal(machine.snapshot().activeInstances.length, 0);
    assert.equal(machine.trace.filter(entry => entry.stage === 'AuraFinished').length, 2);
    assert.ok(machine.trace.every(entry => 'sourceId' in entry && 'ownerId' in entry
        && 'targetId' in entry && 'reason' in entry && 'ruleId' in entry));
});

test('reaction buildup is independent per element and consumes crossed thresholds by definition', () => {
    const reactions = [];
    const machine = new ReactionMachine({
        definitions: {
            fire: {
                threshold: 10,
                maxBuildup: 30,
                consumePolicy: { mode: 'threshold', triggerPolicy: 'all' },
                reactionId: 'fire-reaction',
                cooldownTicks: 0,
                onTriggerActions: [{ type: 'ApplyImpact', amount: 2 }]
            },
            ice: {
                threshold: 5,
                maxBuildup: 20,
                consumePolicy: 'all',
                reactionId: 'ice-reaction',
                cooldownTicks: 3
            }
        },
        onReaction: event => reactions.push([event.reactionId, event.sourceId, event.ownerId])
    });
    machine.registerTarget({ targetId: 'enemy' });

    const result = machine.applyInfliction({
        frame: 5,
        sourceId: 'summon',
        ownerId: 'character',
        targetId: 'enemy',
        element: 'fire',
        amount: 25
    });
    assert.equal(result.triggered.length, 2);
    assert.equal(result.state.buildup, 5);
    assert.deepEqual(reactions, [
        ['fire-reaction', 'summon', 'character'],
        ['fire-reaction', 'summon', 'character']
    ]);

    const ice = machine.applyInfliction({ frame: 6, targetId: 'enemy', element: 'ice', amount: 8 });
    assert.equal(ice.triggered.length, 1);
    assert.equal(machine.canTrigger({ frame: 7, targetId: 'enemy', element: 'ice' }), false);
    const fireState = machine.snapshot('enemy').elements.find(state => state.element === 'fire');
    const iceState = machine.snapshot('enemy').elements.find(state => state.element === 'ice');
    assert.equal(fireState.buildup, 5);
    assert.equal(iceState.buildup, 0);
    assert.equal(iceState.cooldownUntil, 9);
    assert.ok(machine.trace.some(entry => entry.stage === 'ReactionTriggered'
        && entry.sourceId === 'summon' && entry.ownerId === 'character'));
});

test('reaction cooldown can use a supplied local clock domain', () => {
    const machine = new ReactionMachine({
        definitions: {
            lightning: {
                threshold: 10,
                maxBuildup: 30,
                reactionId: 'conduct',
                cooldownTicks: 5,
                clockDomainResolver: () => 'target-local'
            }
        },
        clockDomains: {
            'target-local': { localFrameAt: frame => frame - 3 }
        }
    });
    machine.registerTarget({ targetId: 'enemy' });
    assert.equal(machine.applyInfliction({ frame: 10, targetId: 'enemy', element: 'lightning', amount: 10 })
        .triggered.length, 1);
    machine.applyInfliction({ frame: 11, targetId: 'enemy', element: 'lightning', amount: 10 });
    assert.equal(machine.canTrigger({ frame: 11, targetId: 'enemy', element: 'lightning' }), false);
    assert.equal(machine.canTrigger({ frame: 15, targetId: 'enemy', element: 'lightning' }), true);
});

test('resilience has independent control gates, recovery and execution gate states', () => {
    const machine = new ResilienceMachine({
        targetId: 'enemy',
        definition: {
            maxResilience: 100,
            recoveryPerTick: 20,
            superArmorLevel: 2,
            controlImmunityLevel: 1,
            executionGaugeMax: 30
        }
    });
    const immune = machine.applyControl({ targetId: 'enemy', frame: 1, controlType: 'Stun', controlLevel: 1 });
    const reduced = machine.applyControl({ targetId: 'enemy', frame: 2, controlType: 'Stun', controlLevel: 2 });
    const applied = machine.applyControl({ targetId: 'enemy', frame: 3, controlType: 'Downed', controlLevel: 5 });
    assert.equal(immune.outcome, 'Immune');
    assert.equal(reduced.outcome, 'Reduced');
    assert.equal(applied.outcome, 'Applied');
    assert.equal(machine.snapshot('enemy').state, 'Downed');

    machine.recover({ targetId: 'enemy', frame: 4, amount: 20 });
    assert.equal(machine.snapshot('enemy').state, 'Stable');
    machine.applyImpact({ targetId: 'enemy', frame: 5, amount: 100 });
    assert.equal(machine.snapshot('enemy').state, 'Staggered');
    const gauge = machine.applyExecutionGauge({ targetId: 'enemy', frame: 6, amount: 40 });
    assert.deepEqual([gauge.actual, gauge.discarded, gauge.ready], [30, 10, true]);
    const gate = machine.consumeExecutionGate({ targetId: 'enemy', frame: 7 });
    assert.equal(gate.consumed, true);
    assert.equal(machine.snapshot('enemy').state, 'Downed');
    assert.equal(machine.snapshot('enemy').executionGauge, 0);
    assert.ok(machine.trace.some(entry => entry.stage === 'ImpactApplied'
        && entry.before === 100 && entry.after === 0));
});

test('invalid advanced mechanic input fails explicitly', () => {
    assert.throws(() => new AuraMachine().createAura({
        auraId: 'aura', sourceId: 'source', ownerId: 'owner'
    }), /Missing aura definition/);
    const reaction = new ReactionMachine({ definitions: { fire: { threshold: 10, maxBuildup: 10 } } });
    assert.throws(() => reaction.applyInfliction({ element: 'fire', amount: 1 }), /targetId/);
    const resilience = new ResilienceMachine({ definition: { maxResilience: 10 } });
    assert.throws(() => resilience.applyImpact({ amount: -1 }), /non-negative/);
});
