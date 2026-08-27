import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function readJson(relativePath) {
    return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

test('real AKE PauseBuffTime compiles to generic current-status time control', () => {
    const compiler = new AkeActionCompiler();
    const definition = compiler.compileBuff(readJson(
        'reference/public-data/akedata/Json/BuffData/buff_chr_0016_laevat_ult_end.json'
    ));
    assert.equal(
        definition.compiler.unresolved.some(item => item.sourceType === 'PauseBuffTime'),
        false
    );
    const controls = definition.abilityEventActions.flatMap(group => {
        const found = [];
        const visit = actions => {
            for (const action of actions ?? []) {
                if (action.type === 'SetCurrentBuffTimePaused') found.push(action);
                visit(action.success);
                visit(action.failure);
            }
        };
        visit(group.actions);
        return found.map(action => ({ eventType: group.eventType, isPaused: action.isPaused }));
    });
    assert.deepEqual(controls, [
        { eventType: 'OnAddedBuff', isPaused: true },
        { eventType: 'OnFinishedBuff', isPaused: false }
    ]);
});

test('status time pause freezes expiry, periodic ticks, and timeline actions until resume', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: 'character',
                kind: 'Character',
                team: 'ally',
                clockDomainId: 'character:clock',
                vital: { maxHp: 100, currentHp: 50 }
            }],
            buffs: {
                'buff.time-control': {
                    durationTicks: 10,
                    triggerIntervalTicks: 4,
                    abilityEventActions: [{
                        eventType: 'PauseFixture',
                        actions: [{
                            type: 'SetCurrentBuffTimePaused',
                            isPaused: true,
                            reason: 'PauseFixture'
                        }]
                    }, {
                        eventType: 'ResumeFixture',
                        actions: [{
                            type: 'SetCurrentBuffTimePaused',
                            isPaused: false,
                            reason: 'ResumeFixture'
                        }]
                    }],
                    eventActions: [{
                        eventType: 'OnBuffTrigger',
                        actions: [{ type: 'Heal', target: 'Target', amount: 1 }]
                    }],
                    timeline: [{
                        groupIndex: 0,
                        startFrame: 5,
                        endFrame: 5,
                        actions: [{ type: 'Heal', target: 'Target', amount: 1 }],
                        cleanupActions: []
                    }]
                }
            }
        }
    });
    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.time-control' }, {
        frame: 0,
        sourceId: 'character',
        ownerId: 'character',
        targetId: 'character',
        clockDomainId: 'character:clock'
    });

    runtime.runUntil(3);
    runtime.statusEffects.notifyAbilityEvent({
        frame: 3,
        eventType: 'PauseFixture',
        listenerTargetId: 'character',
        sourceId: 'character',
        ownerId: 'character',
        targetId: 'character'
    });
    let active = runtime.statusEffects.list({ active: true })[0];
    assert.equal(active.timePaused, true);
    assert.equal(active.remainingDurationTicks, 7);
    assert.equal(active.expireFrame, null);

    runtime.runUntil(8);
    assert.equal(runtime.vitals.get('character').currentHp, 50);
    assert.equal(runtime.statusEffects.has({
        targetId: 'character', buffId: 'buff.time-control'
    }), true);

    runtime.statusEffects.notifyAbilityEvent({
        frame: 8,
        eventType: 'ResumeFixture',
        listenerTargetId: 'character',
        sourceId: 'character',
        ownerId: 'character',
        targetId: 'character'
    });
    active = runtime.statusEffects.list({ active: true })[0];
    assert.equal(active.timePaused, false);
    assert.equal(active.remainingDurationTicks, null);
    assert.equal(active.expireFrame, 15);

    runtime.runUntil(9);
    assert.equal(runtime.vitals.get('character').currentHp, 51,
        'the periodic timer resumes with its one remaining tick');
    runtime.runUntil(10);
    assert.equal(runtime.vitals.get('character').currentHp, 52,
        'the status timeline resumes with its two remaining ticks');
    runtime.runUntil(13);
    assert.equal(runtime.vitals.get('character').currentHp, 53);
    runtime.runUntil(14);
    assert.equal(runtime.statusEffects.has({
        targetId: 'character', buffId: 'buff.time-control'
    }), true);
    runtime.runUntil(15);
    assert.equal(runtime.statusEffects.has({
        targetId: 'character', buffId: 'buff.time-control'
    }), false);

    assert.deepEqual(runtime.statusEffects.trace
        .filter(entry => entry.stage === 'StatusEffectTriggered')
        .map(entry => entry.frame), [9, 13]);
    assert.deepEqual(runtime.statusEffects.trace
        .filter(entry => ['StatusEffectTimePaused', 'StatusEffectTimeResumed'].includes(entry.stage))
        .map(entry => [entry.stage, entry.frame]), [
        ['StatusEffectTimePaused', 3],
        ['StatusEffectTimeResumed', 8]
    ]);
});
