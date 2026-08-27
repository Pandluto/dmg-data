import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isActionOwnedDamageHit,
    isPeriodicStatusDamageHit
} from '../src/core/ake-hit-release-policy.mjs';

test('action damage remains a release anchor', () => {
    assert.equal(isActionOwnedDamageHit({ semanticHitType: 'skill' }), true);
    assert.equal(isPeriodicStatusDamageHit({ semanticHitType: 'skill' }), false);
});

test('interval paths are status settlements, not release anchors', () => {
    const hit = {
        semanticHitType: 'buff-derived',
        sourcePath: 'timelineActions[0][0].actionOnTick[0]'
    };
    assert.equal(isPeriodicStatusDamageHit(hit, { buffs: new Map() }), true);
    assert.equal(isActionOwnedDamageHit(hit, { buffs: new Map() }), false);
});

test('repeating Buff event callbacks are status settlements', () => {
    const bundle = {
        buffs: new Map([[
            'buff_bleed',
            {
                triggerIntervalSeconds: 1,
                maxTriggerCount: -1,
                timeline: []
            }
        ]])
    };
    const hit = {
        semanticHitType: 'buff-derived',
        sourceBuffId: 'buff_bleed',
        sourcePath: 'buffEventAction[0].actions[0][0]'
    };
    assert.equal(isPeriodicStatusDamageHit(hit, bundle), true);
    assert.equal(isActionOwnedDamageHit(hit, bundle), false);
});

test('a non-repeating Buff timeline can carry a one-shot action impact', () => {
    const bundle = {
        buffs: new Map([[
            'buff_sword_trigger',
            {
                triggerIntervalSeconds: -1,
                maxTriggerCount: 0,
                timeline: [{ actions: [{ type: 'IfElseAction' }] }]
            }
        ]])
    };
    const hit = {
        semanticHitType: 'buff-derived',
        sourceBuffId: 'buff_sword_trigger',
        sourcePath: 'timelineActions[6][1..][2..][3]'
    };
    assert.equal(isPeriodicStatusDamageHit(hit, bundle), false);
    assert.equal(isActionOwnedDamageHit(hit, bundle), true);
});

test('unknown lifecycle callbacks fail closed', () => {
    const hit = {
        semanticHitType: 'buff-derived',
        sourcePath: 'buffEventAction[0].actions[0][0]'
    };
    assert.equal(isActionOwnedDamageHit(hit, { buffs: new Map() }), false);
});

