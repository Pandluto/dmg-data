import assert from 'node:assert/strict';
import test from 'node:test';

import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function makeRuntime(overrides = {}) {
    return new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'character',
                    kind: 'Character',
                    team: 'ally',
                    vital: { maxHp: 100, currentHp: 50 }
                },
                {
                    id: 'summon',
                    kind: 'Summon',
                    team: 'ally',
                    ownerId: 'character'
                },
                {
                    id: 'enemy',
                    kind: 'Enemy',
                    team: 'enemy',
                    vital: { maxHp: 500, currentHp: 500 },
                    resilience: {
                        maxResilience: 100,
                        recoveryPerTick: 10,
                        superArmorLevel: 1,
                        controlImmunityLevel: 0,
                        executionGaugeMax: 30
                    }
                }
            ],
            resources: [
                {
                    id: 'squad:Atb',
                    resourceType: 'Atb',
                    scope: 'Shared',
                    initial: 20,
                    max: 100
                }
            ],
            buffs: {
                'buff.aura-mark': { stackingPolicy: 'Refresh' },
                'buff.timed': { stackingPolicy: 'Refresh' }
            },
            auras: {
                conductive: { targetBuffId: 'buff.aura-mark' }
            },
            reactions: {
                lightning: {
                    threshold: 10,
                    maxBuildup: 30,
                    consumePolicy: 'threshold',
                    reactionId: 'reaction.conductive',
                    cooldownTicks: 0,
                    clockDomainId: 'global',
                    onTriggerActions: [{ type: 'ApplyImpact', amount: 20 }]
                }
            },
            rules: [
                {
                    id: 'rule.cast-combo',
                    eventType: 'Cast',
                    condition: {
                        type: 'ResourceCompare',
                        poolId: 'squad:Atb',
                        operator: 'GE',
                        value: 20
                    },
                    actions: [
                        {
                            type: 'ResourceChange',
                            poolId: 'squad:Atb',
                            operation: 'Spend',
                            amount: 20
                        },
                        {
                            type: 'CreateAura',
                            auraId: 'conductive',
                            targetIds: ['Target']
                        },
                        {
                            type: 'ApplyInfliction',
                            element: 'lightning',
                            amount: 12
                        },
                        {
                            type: 'Heal',
                            target: 'Owner',
                            amount: 20
                        },
                        {
                            type: 'AddShield',
                            target: 'Owner',
                            amount: 10,
                            priority: 2
                        },
                        {
                            type: 'ApplyImpact',
                            amount: 30
                        }
                    ]
                }
            ],
            ...overrides
        }
    });
}

test('CombatRuntime composes resources, aura buffs, reactions, vitals and resilience', () => {
    const runtime = makeRuntime();
    const result = runtime.dispatch({
        frame: 5,
        eventType: 'Cast',
        sourceId: 'summon',
        ownerId: 'character',
        targetId: 'enemy',
        skillId: 'skill.combo',
        castId: 'cast:1',
        clockDomainId: 'global'
    });

    assert.deepEqual(result.matchedRules, ['rule.cast-combo']);
    assert.equal(runtime.resources.get('squad:Atb', 5), 0);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.aura-mark', sourceId: 'summon', ownerId: 'character'
    }), true);
    const status = runtime.statusEffects.list({ active: true })[0];
    assert.equal(status.sourceId, 'summon');
    assert.equal(status.ownerId, 'character');
    assert.equal(status.castId, 'cast:1');
    assert.equal(runtime.reactions.snapshot('enemy').elements[0].buildup, 2);
    assert.equal(runtime.vitals.get('character').currentHp, 70);
    assert.equal(runtime.vitals.get('character').shields[0].remaining, 10);
    assert.equal(runtime.resilience.snapshot('enemy').resilience, 50);
    assert.ok(runtime.trace.some(entry => entry.stage === 'EventDispatched'));
    assert.ok(runtime.reactions.trace.some(entry => entry.stage === 'ReactionTriggered'));
});

test('status-effect duration follows its selected local clock and source cleanup is explicit', () => {
    const runtime = makeRuntime({
        clockDomains: [{ id: 'enemy-local', kind: 'Enemy', ownerId: 'enemy' }]
    });
    const context = {
        frame: 0,
        eventType: 'Setup',
        sourceId: 'summon',
        ownerId: 'character',
        targetId: 'enemy',
        clockDomainId: 'enemy-local'
    };
    runtime.execute({
        type: 'ApplyBuff',
        buffId: 'buff.timed',
        durationTicks: 5
    }, context);
    runtime.clockDomains.pause('enemy-local', {
        frame: 2,
        durationTicks: 3,
        sourceId: 'summon',
        ownerId: 'character',
        targetId: 'enemy',
        reason: 'HitStop'
    });

    runtime.runUntil(7);
    assert.equal(runtime.statusEffects.has({ targetId: 'enemy', buffId: 'buff.timed' }), true);
    runtime.runUntil(8);
    assert.equal(runtime.statusEffects.has({ targetId: 'enemy', buffId: 'buff.timed' }), false);

    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.timed' }, { ...context, frame: 9 });
    assert.equal(runtime.statusEffects.removeBySource('summon', 10).length, 1);
    assert.equal(runtime.statusEffects.has({ targetId: 'enemy', buffId: 'buff.timed' }), false);
});

test('AKE-style CreateBuffAction fans out entries and resolves Blackboard assignments', () => {
    const runtime = makeRuntime();
    const context = {
        frame: 3,
        eventType: 'OnBuffStart',
        sourceId: 'summon',
        ownerId: 'character',
        targetId: 'enemy',
        blackboard: { inherited: 17 }
    };
    const result = runtime.execute({
        type: 'CreateBuffAction',
        count: { useBlackboardKey: false, value: 1, blackboardKey: '' },
        targetSource: 'Target',
        buffs: [{
            buffId: 'buff.timed',
            assignBlackboard: true,
            assignments: [{
                targetKey: 'copied',
                direct: false,
                sourceKey: 'inherited'
            }]
        }]
    }, context);

    assert.equal(Array.isArray(result), true);
    assert.equal(runtime.statusEffects.list({ buffId: 'buff.timed' })[0].blackboard.copied, 17);
});

test('parsed AKE Infinity and Unlimited stacking semantics stay indefinite and independent', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'enemy', kind: 'Enemy', team: 'enemy' }],
            buffs: {
                'buff.unlimited': {
                    lifeType: 'Infinity',
                    durationTicks: 0,
                    stacking: {
                        stackingType: 'Unlimited',
                        stackingKey: '',
                        maxStackCount: 0
                    }
                }
            }
        }
    });
    const context = {
        frame: 0,
        eventType: 'Setup',
        sourceId: 'enemy',
        ownerId: null,
        targetId: 'enemy'
    };
    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.unlimited' }, context);
    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.unlimited' }, context);
    runtime.runUntil(1);

    assert.equal(runtime.statusEffects.list({ active: true }).length, 2);
    assert.ok(runtime.statusEffects.list({ active: true }).every(instance =>
        instance.expireFrame === null && instance.stackingKey === 'buff.unlimited'
    ));
});

test('derived event recursion is bounded and unsupported conditions do not silently pass', () => {
    const runtime = makeRuntime();
    runtime.registerRule({
        id: 'rule.unsupported',
        eventType: 'Probe',
        condition: { type: 'UnknownFutureCondition' },
        actions: [{ type: 'ApplyTag', target: 'Target', tag: 'ShouldNotExist' }]
    });
    runtime.registerRule({
        id: 'rule.loop',
        eventType: 'Loop',
        actions: [{ type: 'EmitEvent', eventType: 'Loop' }]
    });
    runtime.dispatch({
        frame: 0,
        eventType: 'Probe',
        sourceId: 'character',
        ownerId: 'character',
        targetId: 'enemy'
    });
    assert.equal(runtime.context.hasTag('enemy', 'ShouldNotExist'), false);
    assert.throws(() => runtime.dispatch({
        frame: 0,
        eventType: 'Loop',
        sourceId: 'character',
        ownerId: 'character',
        targetId: 'enemy'
    }), /Maximum derived event depth/);
});
