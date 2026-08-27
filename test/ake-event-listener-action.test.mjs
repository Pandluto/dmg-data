import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const SKILL_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/',
    import.meta.url
);

function listenerProgram({ endFrame = 10 } = {}) {
    const sourceKey = 'ake-skill:fixture:ability-listener';
    return {
        skillId: 'skill.listener-fixture',
        blackboard: { handled: 0 },
        timeline: [{
            groupIndex: 0,
            startFrame: 0,
            endFrame,
            actions: [{
                type: 'RegisterAbilityEventListener',
                sourceKey,
                listenerTarget: 'Owner',
                timelineStartFrame: 0,
                timelineEndFrame: endFrame,
                eventGroups: [{
                    eventType: 'OnFixtureEvent',
                    actions: [{
                        type: 'ModifyBlackboard',
                        key: 'handled',
                        operation: 'Add',
                        value: 1
                    }, {
                        type: 'ApplyBuff',
                        sourceRef: 'Source',
                        target: { type: 'EventTarget', fallback: 'Target' },
                        buffId: 'buff.event-target'
                    }]
                }]
            }],
            cleanupActions: [{
                type: 'UnregisterAbilityEventListener',
                sourceKey
            }]
        }]
    };
}

function makeRuntime() {
    return new CombatRuntime({
        definitions: {
            entities: [{
                id: 'actor', kind: 'Character', team: 'ally'
            }, {
                id: 'other', kind: 'Character', team: 'ally'
            }, {
                id: 'enemy', kind: 'Enemy', team: 'enemy'
            }],
            buffs: {
                'buff.event-target': { stackingPolicy: 'Refresh' }
            }
        }
    });
}

test('skill EventListenerAction lifetime routes events to the cast context and event target', () => {
    const runtime = makeRuntime();
    const scheduled = runtime.scheduleProgram(listenerProgram(), {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'actor',
        castId: 'cast:listener'
    });
    runtime.runUntil(0);

    assert.equal(runtime.abilityEventListeners.list({ active: true }).length, 1);
    assert.deepEqual(runtime.notifyAbilityEvent({
        frame: 1,
        eventType: 'OnFixtureEvent',
        sourceId: 'other',
        ownerId: 'other',
        targetId: 'enemy',
        listenerTargetId: 'other'
    }), [], 'an event for another listener owner must not cross casts');

    for (const frame of [2, 3]) runtime.notifyAbilityEvent({
        frame,
        eventType: 'OnFixtureEvent',
        sourceId: 'other',
        ownerId: 'other',
        targetId: 'enemy',
        listenerTargetId: 'actor'
    });
    const listener = runtime.abilityEventListeners.list({ active: true })[0];
    assert.equal(listener.blackboard.handled, 2,
        'listener Blackboard writes must survive across incoming events');
    assert.equal(listener.programExecutionId, scheduled.executionId);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy',
        buffId: 'buff.event-target',
        sourceId: 'actor'
    }), true, 'serialized Target must resolve to the incoming event target');
    assert.equal(runtime.statusEffects.has({
        targetId: 'actor',
        buffId: 'buff.event-target'
    }), false);

    runtime.runUntil(10);
    assert.equal(runtime.abilityEventListeners.list({ active: true }).length, 0);
    assert.equal(runtime.notifyAbilityEvent({
        frame: 11,
        eventType: 'OnFixtureEvent',
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'enemy',
        listenerTargetId: 'actor'
    }).length, 0);
});

test('timeline seek, program cancellation and early skill finish remove transient listeners', () => {
    const runtime = makeRuntime();
    const context = {
        sourceId: 'actor', ownerId: 'actor', targetId: 'actor'
    };

    const seeked = runtime.scheduleProgram(listenerProgram({ endFrame: 10 }), {
        ...context, frame: 0, castId: 'cast:seek'
    });
    runtime.runUntil(0);
    runtime.seekProgram(seeked.executionId, {
        frame: 2,
        sourceTimelineFrame: 2,
        destFrame: 12
    });
    assert.equal(runtime.abilityEventListeners.list({ active: true }).length, 0);

    const cancelled = runtime.scheduleProgram(listenerProgram(), {
        ...context, frame: 20, castId: 'cast:cancel'
    });
    runtime.runUntil(20);
    runtime.cancelProgramExecution(cancelled.executionId, 21, 'Interrupted');
    assert.equal(runtime.abilityEventListeners.list({ active: true }).length, 0);

    runtime.scheduleProgram(listenerProgram(), {
        ...context, frame: 30, castId: 'cast:finish'
    });
    runtime.runUntil(30);
    runtime.finishSkillActionLifetimes({
        frame: 31,
        actorId: 'actor',
        skillId: 'skill.listener-fixture',
        castId: 'cast:finish',
        reason: 'SkillInterrupted'
    }, { ...context, frame: 31, castId: 'cast:finish' });
    assert.equal(runtime.abilityEventListeners.list({ active: true }).length, 0);
});

test('all public SkillData EventListenerAction nodes use the generic compiler route', () => {
    let rawListenerCount = 0;
    let registerCount = 0;
    const listenerGaps = [];
    for (const fileName of readdirSync(SKILL_DATA_URL)
        .filter(name => name.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(fileName, SKILL_DATA_URL), 'utf8'));
        const serialized = JSON.stringify(raw);
        const count = serialized.match(/EventListenerAction\+Data/g)?.length ?? 0;
        if (count === 0) continue;
        rawListenerCount += count;
        const compiled = new AkeActionCompiler().compileSkill(raw);
        registerCount += compiled.timeline
            .flatMap(group => group.actions)
            .filter(action => action.type === 'RegisterAbilityEventListener').length;
        listenerGaps.push(...compiled.compiler.unresolved.filter(gap =>
            gap.sourceType === 'EventListenerAction'
        ));
    }

    assert.equal(rawListenerCount, 17);
    assert.equal(registerCount, 15,
        'Chen cooldown reset and Wulfgard empty finish selector remain explicit child gaps');
    assert.equal(listenerGaps.some(gap =>
        gap.code === 'AKE_ACTION_UNSUPPORTED'
    ), false, 'the EventListenerAction wrapper itself must never fall through');
    assert.equal(listenerGaps.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
    ), true, 'unimplemented event producers must remain visible in the audit');
    assert.equal(listenerGaps.some(gap =>
        gap.code === 'AKE_EVENT_LISTENER_ACTIONS_EMPTY'
    ), true, 'empty serialized selectors must not masquerade as executable');
});

test('BuffData EventListenerAction stays closed until Buff-owned lifetime is implemented', () => {
    const raw = JSON.parse(readFileSync(new URL(
        '../reference/public-data/akedata/Json/BuffData/buff_chr_0017_yvonne_ultimate_skill_potential4_valid.json',
        import.meta.url
    ), 'utf8'));
    const listener = raw.buffEventAction[0].actions[0].actionData[0];
    const compiled = new AkeActionCompiler().compileAction(listener, {
        scope: 'buff',
        path: 'buffEventAction[0]'
    });

    assert.equal(compiled.actions.length, 0);
    assert.equal(compiled.unresolved.some(gap =>
        gap.code === 'AKE_EVENT_LISTENER_LIFETIME_REQUIRED'
    ), true);
});

test('skill EventListenerAction without a timeline window fails closed', () => {
    const compiled = new AkeActionCompiler().compileAction({
        $type: 'Beyond.Gameplay.Core.EventListenerAction+Data, Gameplay.Beyond',
        isEnable: true,
        abilityActionMap: [{
            abilityEvent: 'OnAddedBuff',
            actions: [{ actionData: [{
                $type: 'Beyond.Gameplay.Core.ModifyDynamicBlackboard+Data, Gameplay.Beyond',
                isEnable: true,
                directValue: true,
                key: 'count',
                operation: 'Add',
                value: { useBlackboardKey: false, value: 1, blackboardKey: '' }
            }] }]
        }]
    }, { scope: 'skill' });

    assert.equal(compiled.actions.length, 0);
    assert.equal(compiled.unresolved.some(gap =>
        gap.code === 'AKE_EVENT_LISTENER_TIMELINE_REQUIRED'
    ), true);
});
