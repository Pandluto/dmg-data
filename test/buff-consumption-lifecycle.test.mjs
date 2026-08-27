import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function readBuff(buffId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
}

function findNode(value, predicate) {
    if (predicate(value)) return value;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findNode(child, predicate);
            if (found) return found;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) {
            const found = findNode(child, predicate);
            if (found) return found;
        }
    }
    return null;
}

test('serialized FinishBuff actions preserve consumer and absorb semantics', () => {
    const compiler = new AkeActionCompiler();
    const crushNode = findNode(
        readBuff('buff_physical_try_crushed'),
        value => String(value?.$type ?? '').includes('FinishBuffAction')
    );
    const absorbNode = findNode(
        readBuff('buff_chr_0016_laevat_passive_teammate'),
        value => String(value?.$type ?? '').includes('FinishBuffAdvanced')
            && value.isAbsorbed === true
    );

    const crush = compiler.compileAction(crushNode, { scope: 'buff' }).actions[0];
    const absorb = compiler.compileAction(absorbNode, { scope: 'buff' }).actions[0];

    assert.equal(crush.type, 'FinishBuff');
    assert.equal(crush.consumption, true);
    assert.equal(crush.consumerRef, 'Source');
    assert.equal(crush.consumeKind, 'Consume');
    assert.equal(crush.isAbsorbed, false);
    assert.equal(crush.isFinishedEarly, false);

    assert.equal(absorb.type, 'FinishBuff');
    assert.equal(absorb.consumption, true);
    assert.equal(absorb.consumerRef, 'Source');
    assert.equal(absorb.consumeKind, 'Absorb');
    assert.equal(absorb.isAbsorbed, true);
});

test('status transitions distinguish actual consumption from ordinary finish', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                'buff.fixture.layers': {
                    stackingPolicy: 'AddStack',
                    maxStacks: 3,
                    tagIds: [1075718177],
                    blackboard: { count: 7 }
                }
            }
        }
    });
    const setup = {
        sourceId: 'actor', ownerId: 'actor', targetId: 'enemy'
    };
    for (let frame = 0; frame < 3; frame += 1) {
        runtime.execute({
            type: 'ApplyBuff', target: 'Target', buffId: 'buff.fixture.layers'
        }, { ...setup, frame });
    }

    runtime.execute({
        type: 'FinishBuff',
        target: 'Target',
        buffId: 'buff.fixture.layers',
        finishAll: false,
        stackCount: 2,
        consumption: true,
        consumerRef: 'Source',
        consumeKind: 'Consume'
    }, {
        ...setup,
        frame: 3,
        commandType: 'NormalSkill',
        skillType: 'NormalSkill',
        skillId: 'skill.consume',
        rootSkillId: 'skill.consume',
        castId: 'cast.consume'
    });

    const consumed = runtime.statusEffects.trace.find(event =>
        event.stage === 'StatusEffectStackRemoved'
        && event.buffId === 'buff.fixture.layers'
    );
    assert.equal(consumed.before, 3);
    assert.equal(consumed.consumedStacks, 2);
    assert.equal(consumed.after, 1);
    assert.equal(consumed.consumption, true);
    assert.equal(consumed.consumerId, 'actor');
    assert.equal(consumed.consumeKind, 'Consume');
    assert.equal(consumed.triggerSkillId, 'skill.consume');
    assert.equal(consumed.triggerSkillType, 'NormalSkill');
    assert.deepEqual(consumed.consumedBuffBlackboard, { count: 7 });

    runtime.execute({
        type: 'FinishBuff', target: 'Target', buffId: 'buff.fixture.layers'
    }, { ...setup, frame: 4 });
    const ordinary = runtime.statusEffects.trace.find(event =>
        event.stage === 'StatusEffectFinished'
        && event.buffId === 'buff.fixture.layers'
    );
    assert.equal(ordinary.consumption, false);
    assert.equal('consumerId' in ordinary, false);
});

test('OnConsumeBuff routes to the consumer while preserving the consumed target', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'other', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                'buff.fixture.observer': {
                    stackingPolicy: 'Unique',
                    blackboard: { handled: 0, consumed: 0 },
                    abilityEventActions: [{
                        eventType: 'OnConsumeBuff',
                        actions: [{
                            type: 'ModifyBlackboard',
                            key: 'handled',
                            operation: 'Add',
                            value: 1
                        }, {
                            type: 'ModifyBlackboard',
                            key: 'consumed',
                            operation: 'Add',
                            value: { type: 'Payload', key: 'consumedStacks' }
                        }, {
                            type: 'ApplyBuff',
                            target: { type: 'EventTarget', fallback: 'Target' },
                            buffId: 'buff.fixture.followup'
                        }]
                    }]
                },
                'buff.fixture.victim': {
                    stackingPolicy: 'AddStack',
                    maxStacks: 3,
                    tagIds: [1075718177],
                    blackboard: { count: 9 }
                },
                'buff.fixture.followup': { stackingPolicy: 'Refresh' }
            }
        }
    });
    runtime.execute({
        type: 'ApplyBuff', target: 'actor', buffId: 'buff.fixture.observer'
    }, {
        frame: 0, sourceId: 'actor', ownerId: 'actor', targetId: 'actor'
    });
    const observer = () => runtime.statusEffects.list({
        active: true, targetId: 'actor', buffId: 'buff.fixture.observer'
    })[0];
    const applyVictim = frame => runtime.execute({
        type: 'ApplyBuff', target: 'enemy', buffId: 'buff.fixture.victim'
    }, {
        frame, sourceId: 'actor', ownerId: 'actor', targetId: 'enemy'
    });

    applyVictim(1);
    runtime.execute({
        type: 'FinishBuff', target: 'enemy', buffId: 'buff.fixture.victim'
    }, {
        frame: 2, sourceId: 'actor', ownerId: 'actor', targetId: 'enemy'
    });
    assert.equal(observer().blackboard.handled, 0,
        'ordinary finish must not masquerade as consumption');

    applyVictim(3);
    applyVictim(4);
    runtime.execute({
        type: 'FinishBuff',
        target: 'enemy',
        buffId: 'buff.fixture.victim',
        finishAll: false,
        stackCount: 1,
        consumption: true,
        consumerRef: 'Source'
    }, {
        frame: 5,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'enemy',
        skillId: 'skill.actor.consume',
        skillType: 'NormalSkill'
    });
    assert.equal(observer().blackboard.handled, 1);
    assert.equal(observer().blackboard.consumed, 1);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.fixture.followup'
    }), true, 'listener EventTarget must remain the consumed Buff carrier');

    runtime.execute({
        type: 'FinishBuff',
        target: 'enemy',
        buffId: 'buff.fixture.victim',
        consumption: true,
        consumerRef: 'Source'
    }, {
        frame: 6,
        sourceId: 'other',
        ownerId: 'other',
        targetId: 'enemy',
        skillId: 'skill.other.consume',
        skillType: 'NormalSkill'
    });
    assert.equal(observer().blackboard.handled, 1,
        'a different consumer must not trigger actor-owned listeners');
});
