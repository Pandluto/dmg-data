import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function readBuff(buffId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
}

function readSkill(skillId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/SkillData/${skillId}.json`,
        import.meta.url
    ), 'utf8'));
}

const BUFF_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/BuffData/',
    import.meta.url
);
const SKILL_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/',
    import.meta.url
);

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

test('real AKE consume listeners compile layer and origin-skill context without gaps', () => {
    const compiler = new AkeActionCompiler();
    const dapan = compiler.compileBuff(readBuff('buff_chr_0018_dapan_talent_0'));
    const funnel = compiler.compilePassiveEventActions(readSkill('sk_wpn_funnel_0015'));
    const dapanConsume = dapan.abilityEventActions.find(group =>
        group.eventType === 'OnConsumeBuff'
    );
    const funnelConsume = funnel.groups.find(group =>
        group.eventType === 'OnConsumeBuff'
    );
    const layerCondition = findNode(dapanConsume.actions, node =>
        node?.type === 'PayloadCompare'
        && node.payloadKey === 'consumedStacks'
    );
    const originSkillCondition = findNode(funnelConsume.actions, node =>
        node?.type === 'SkillTypeIs'
    );

    assert.deepEqual(dapanConsume.unresolved, []);
    assert.equal(layerCondition.operator, 'GE');
    assert.equal(layerCondition.storeKey, 'consumedLayer');
    assert.deepEqual(funnelConsume.unresolved, []);
    assert.deepEqual(originSkillCondition.skillType, ['NormalSkill']);
    assert.equal(funnel.compiler.status, 'executable');
});

test('all 21 public AKE consume-listener groups have complete runtime context', () => {
    const compiler = new AkeActionCompiler();
    const groups = [];
    for (const fileName of readdirSync(BUFF_DATA_URL).filter(name =>
        name.endsWith('.json')
    )) {
        const raw = JSON.parse(readFileSync(new URL(fileName, BUFF_DATA_URL), 'utf8'));
        if (!(raw.abilityEventAction ?? []).some(group =>
            group.abilityEvent === 'OnConsumeBuff'
        )) continue;
        const definition = compiler.compileBuff(raw);
        groups.push(...definition.abilityEventActions.filter(group =>
            group.eventType === 'OnConsumeBuff'
        ));
    }
    for (const fileName of readdirSync(SKILL_DATA_URL).filter(name =>
        name.endsWith('.json')
    )) {
        const raw = JSON.parse(readFileSync(new URL(fileName, SKILL_DATA_URL), 'utf8'));
        const definition = compiler.compilePassiveEventActions(raw);
        groups.push(...definition.groups.filter(group =>
            group.eventType === 'OnConsumeBuff'
        ));
    }

    const unresolved = groups.flatMap(group => group.unresolved);
    assert.equal(groups.length, 21);
    assert.equal(groups.filter(group => group.unresolved.length === 0).length, 17);
    assert.equal(unresolved.length, 4);
    assert.ok(unresolved.every(gap =>
        gap.code === 'AKE_ACTION_UNSUPPORTED'
        && gap.sourceType === 'RaiseTrainLevelEvent'
    ), 'only the four external training-progress callbacks may remain unresolved');
});

test('Dapan real listener receives the actual consumed No Guard layer count', () => {
    const compiler = new AkeActionCompiler();
    const talentId = 'buff_chr_0018_dapan_talent_0';
    const outputId = 'buff_chr_0018_dapan_talent_0_dmg_up';
    const noGuardId = 'buff_physical_no_guard';
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'dapan', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [talentId]: compiler.compileBuff(readBuff(talentId)),
                [outputId]: compiler.compileBuff(readBuff(outputId)),
                [noGuardId]: compiler.compileBuff(readBuff(noGuardId))
            }
        }
    });
    const context = (frame, targetId = 'dapan') => ({
        frame,
        sourceId: 'dapan',
        ownerId: 'dapan',
        targetId
    });
    runtime.execute({
        type: 'ApplyBuff',
        target: 'dapan',
        buffId: talentId,
        blackboard: { dmg_up: 0.12, duration: 10, stack: 4 }
    }, context(0));
    for (let frame = 1; frame <= 3; frame += 1) {
        runtime.execute({
            type: 'ApplyBuff', target: 'enemy', buffId: noGuardId
        }, context(frame, 'enemy'));
    }

    runtime.execute({
        type: 'FinishBuff',
        target: 'enemy',
        buffId: noGuardId,
        finishAll: false,
        stackCount: 2,
        consumption: true,
        consumerRef: 'Source'
    }, {
        ...context(4, 'enemy'),
        skillId: 'skill.consume.no-guard',
        skillType: 'NormalSkill'
    });

    const talent = runtime.statusEffects.list({
        active: true, targetId: 'dapan', buffId: talentId
    })[0];
    const output = runtime.statusEffects.list({
        active: true, targetId: 'dapan', buffId: outputId
    })[0];
    const remainingNoGuard = runtime.statusEffects.list({
        active: true, targetId: 'enemy', buffId: noGuardId
    })[0];
    assert.equal(talent.blackboard.consumedLayer, 2);
    assert.equal(output.stackCount, 2);
    assert.equal(output.blackboard.dmg_up, 0.12);
    assert.equal(remainingNoGuard.stackCount, 1);
});

test('equipment listener reads Blackboard from the consumed Buff snapshot', () => {
    const compiler = new AkeActionCompiler();
    const listenerId = 'buff_equipsuit_expend_spell01';
    const outputId = 'buff_equipsuit_expend_spelldamage';
    const consumedId = 'buff_common_pulse_pulse_conduct_triggered_do';
    const listener = compiler.compileBuff(readBuff(listenerId));
    const consumeGroup = listener.abilityEventActions.find(group =>
        group.eventType === 'OnConsumeBuff'
    );
    const contextRead = findNode(consumeGroup.actions, node =>
        node?.type === 'ReadBuffBlackboardCondition'
    );
    assert.equal(contextRead.eventBuffContext, true);
    assert.equal(contextRead.desiredKey, 'count');
    assert.deepEqual(consumeGroup.unresolved, []);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [listenerId]: listener,
                [outputId]: compiler.compileBuff(readBuff(outputId)),
                [consumedId]: compiler.compileBuff(readBuff(consumedId))
            }
        }
    });
    const context = (frame, targetId = 'actor') => ({
        frame,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId
    });
    runtime.execute({
        type: 'ApplyBuff', target: 'actor', buffId: listenerId
    }, context(0));
    runtime.execute({
        type: 'ApplyBuff',
        target: 'enemy',
        buffId: consumedId,
        blackboard: { count: 3 }
    }, context(1, 'enemy'));
    runtime.execute({
        type: 'FinishBuff',
        target: 'enemy',
        buffId: consumedId,
        consumption: true,
        consumerRef: 'Source'
    }, {
        ...context(2, 'enemy'),
        skillId: 'skill.consume.spell-status',
        skillType: 'NormalSkill'
    });

    const output = runtime.statusEffects.list({
        active: true, targetId: 'actor', buffId: outputId
    })[0];
    const listenerInstance = runtime.statusEffects.list({
        active: true, targetId: 'actor', buffId: listenerId
    })[0];
    assert.equal(output.stackCount, 3);
    assert.equal(listenerInstance.blackboard.addstack, 3);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: consumedId
    }), false, 'the consumed instance must already be inactive when its snapshot is read');
});

test('real AKE consume prevention is a source-leased pre-commit guard', () => {
    const compiler = new AkeActionCompiler();
    const guardId = 'buff_eny_0114_jzmking_hdg024';
    const guard = compiler.compileBuff(readBuff(guardId));
    const enableGroup = guard.eventActions.find(group =>
        group.eventType === 'DuringBuffEnable'
    );
    const setGuard = enableGroup.actions.find(action =>
        action.type === 'SetBuffConsumePrevention'
    );
    const removeGuard = guard.endActions.find(action =>
        action.type === 'RemoveBuffConsumePrevention'
    );
    assert.deepEqual(enableGroup.unresolved, []);
    assert.deepEqual(setGuard.tagIds, [1474064594, -430063731]);
    assert.equal(setGuard.tagQueryType, 'HasAny');
    assert.equal(removeGuard.guardKey, setGuard.guardKey);

    const protectedId = 'buff.fixture.protected';
    const otherId = 'buff.fixture.other';
    const observerId = 'buff.fixture.consume-observer';
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [guardId]: guard,
                [protectedId]: {
                    stackingPolicy: 'AddStack',
                    maxStacks: 4,
                    tagIds: [-430063731],
                    blackboard: { count: 7 }
                },
                [otherId]: { tagIds: [123456789] },
                [observerId]: {
                    blackboard: { count: 0 },
                    abilityEventActions: [{
                        eventType: 'OnConsumeBuff',
                        actions: [{
                            type: 'ModifyBlackboard',
                            key: 'count',
                            operation: 'Add',
                            value: 1
                        }]
                    }]
                }
            }
        }
    });
    const actorContext = frame => ({
        frame, sourceId: 'actor', ownerId: 'actor', targetId: 'actor'
    });
    const enemyContext = frame => ({
        frame, sourceId: 'enemy', ownerId: 'enemy', targetId: 'enemy'
    });
    const consume = (frame, buffId, finishAll = true) => runtime.execute({
        type: 'FinishBuff',
        target: 'enemy',
        buffId,
        finishAll,
        stackCount: 1,
        consumption: true,
        consumerRef: 'Source'
    }, {
        ...actorContext(frame),
        targetId: 'enemy',
        skillId: 'skill.consume',
        skillType: 'NormalSkill'
    });
    const observerCount = () => runtime.statusEffects.list({
        active: true, targetId: 'actor', buffId: observerId
    })[0].blackboard.count;

    runtime.execute({
        type: 'ApplyBuff', target: 'enemy', buffId: guardId
    }, enemyContext(0));
    runtime.execute({
        type: 'ApplyBuff', target: 'actor', buffId: observerId
    }, actorContext(1));
    runtime.execute({
        type: 'ApplyBuff', target: 'enemy', buffId: protectedId
    }, enemyContext(2));
    runtime.execute({
        type: 'ApplyBuff', target: 'enemy', buffId: protectedId
    }, enemyContext(3));
    runtime.execute({
        type: 'ApplyBuff', target: 'enemy', buffId: otherId
    }, enemyContext(4));

    consume(5, otherId);
    assert.equal(observerCount(), 1, 'a non-matching Buff remains consumable');
    consume(6, protectedId, false);
    const protectedInstance = runtime.statusEffects.list({
        active: true, targetId: 'enemy', buffId: protectedId
    })[0];
    const prevented = runtime.statusEffects.trace.find(event =>
        event.stage === 'StatusEffectConsumptionPrevented'
        && event.buffId === protectedId
    );
    assert.equal(protectedInstance.stackCount, 2);
    assert.deepEqual(protectedInstance.blackboard, { count: 7 });
    assert.equal(prevented.actual, 0);
    assert.equal(prevented.discarded, 1);
    assert.equal(prevented.consumptionGuards.length, 1);
    assert.equal(observerCount(), 1, 'a prevented transaction emits no consume event');

    runtime.execute({
        type: 'FinishBuff', target: 'enemy', buffId: guardId
    }, enemyContext(7));
    assert.deepEqual(runtime.snapshot().buffConsumeProtections, []);
    consume(8, protectedId, false);
    assert.equal(runtime.statusEffects.list({
        active: true, targetId: 'enemy', buffId: protectedId
    })[0].stackCount, 1);
    assert.equal(observerCount(), 2,
        'the same consumption resumes after its guard lease ends');
});
