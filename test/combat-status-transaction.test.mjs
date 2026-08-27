import assert from 'node:assert/strict';
import test from 'node:test';

import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const NO_GUARD = 'buff_physical_no_guard';
const CRUSHED = 'buff_physical_crushed';
const CRUSH_ATTEMPT = 'buff_physical_do_crush';

function createRuntime() {
    return new CombatRuntime({
        definitions: {
            entities: [
                { id: 'caster', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [NO_GUARD]: {
                    buffId: NO_GUARD,
                    stackingPolicy: 'AddStack',
                    maxStacks: 4
                },
                [CRUSHED]: {
                    buffId: CRUSHED,
                    stackingPolicy: 'Independent'
                },
                [CRUSH_ATTEMPT]: {
                    buffId: CRUSH_ATTEMPT,
                    stackingPolicy: 'Independent',
                    startActions: [{
                        type: 'IfElseAction',
                        conditions: [{ type: 'HasBuff', target: 'Target', buffId: NO_GUARD }],
                        success: [{ type: 'ApplyBuff', target: 'Target', buffId: CRUSHED }, {
                            type: 'FinishBuff',
                            target: 'Target',
                            buffId: NO_GUARD,
                            finishAll: true,
                            reason: 'PhysicalStatusConsumed'
                        }],
                        failure: [{ type: 'ApplyBuff', target: 'Target', buffId: NO_GUARD }]
                    }]
                }
            }
        }
    });
}

function applyCrush(runtime, frame, castId) {
    return runtime.execute({
        type: 'ApplyCombatStatus',
        target: 'Target',
        statusKey: 'crush',
        triggerBuffId: CRUSH_ATTEMPT,
        statusBuffId: CRUSHED,
        initialBuffId: NO_GUARD
    }, {
        frame,
        eventType: 'SkillHit',
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'enemy',
        skillId: 'skill.crush',
        castId
    });
}

test('physical status entry and consumption are resolved as auditable transactions', () => {
    const runtime = createRuntime();
    const first = applyCrush(runtime, 10, 'cast:first');
    const second = applyCrush(runtime, 20, 'cast:second');

    assert.equal(first.status, 'Applied');
    assert.equal(first.branch, 'EnteredNoGuard');
    assert.equal(first.before, 0);
    assert.equal(first.after, 1);
    assert.equal(first.consumedStacks, 0);

    assert.equal(second.status, 'Applied');
    assert.equal(second.branch, 'PhysicalStatusApplied');
    assert.equal(second.before, 1);
    assert.equal(second.after, 0);
    assert.equal(second.consumedStacks, 1);
    assert.deepEqual(second.bySource, [{ sourceId: 'caster', ownerId: 'enemy', count: 1 }]);
    assert.notEqual(first.transactionId, second.transactionId);

    assert.equal(runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: NO_GUARD
    }).length, 0);
    assert.equal(runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: CRUSHED
    }).length, 1);

    const secondEvents = runtime.statusEffects.trace.filter(event => (
        event.transactionId === second.transactionId
    ));
    assert.ok(secondEvents.length >= 3);
    assert.ok(secondEvents.every(event => event.transactionId === second.transactionId));
    assert.ok(secondEvents.some(event => (
        event.stage === 'StatusEffectFinished'
        && event.buffId === NO_GUARD
        && event.consumedStacks === 1
    )));
});
