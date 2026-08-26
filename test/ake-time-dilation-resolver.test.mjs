import assert from 'node:assert/strict';
import test from 'node:test';

import { createAkeTimeDilationResolver } from '../src/core/ake-time-dilation-resolver.mjs';

test('AKE -1 time-dilation duration is retained as an until-disabled sentinel', () => {
    const resolve = createAkeTimeDilationResolver();
    const result = resolve({
        action: {
            sourceType: 'TimeDilationAction',
            raw: {
                duration: {
                    useBlackboardKey: false,
                    value: -1,
                    blackboardKey: ''
                },
                layer: 'Entity'
            }
        },
        eventContext: { targetId: 'enemy', blackboard: {} },
        tickRate: 30
    });

    assert.equal(result.status, 'RetainedWithoutClockMutation');
    assert.equal(result.durationMode, 'UntilDisabled');
    assert.equal(result.durationSeconds, null);
    assert.equal(result.nominalDurationTicks, null);
    assert.deepEqual(result.pauses, []);
});

test('global ComboSkill curve samples every other character clock but not its caster', () => {
    const resolve = createAkeTimeDilationResolver();
    const runtime = {
        clockDomains: {
            listDomains: () => [
                { id: 'caster:clock', kind: 'Character', ownerId: 'caster' },
                { id: 'ally:clock', kind: 'Character', ownerId: 'ally' },
                { id: 'enemy:clock', kind: 'Enemy', ownerId: 'enemy' }
            ]
        }
    };
    const result = resolve({
        action: {
            sourceType: 'TimeDilationAction',
            raw: {
                layer: 'Global',
                useCurveKey: true,
                curveKey: 'ComboSkill',
                duration: { useBlackboardKey: false, value: 0.6 }
            }
        },
        eventContext: { sourceId: 'caster', blackboard: {} },
        runtime,
        tickRate: 30
    });

    assert.equal(result.status, 'ResolvedByFrozenBlackBoxEvidence');
    assert.equal(result.nominalDurationTicks, 18);
    assert.equal(result.excludedTicks, 17);
    assert.deepEqual(result.targetDomainIds, ['ally:clock']);
    assert.equal(result.pauses.length, 17);
    assert.ok(result.pauses.every(pause => pause.domainId === 'ally:clock'));
    assert.ok(result.pauses.every(pause => pause.durationTicks === 1 && pause.priority === 0));
    assert.deepEqual(
        [...new Set(result.pauses.map(pause => pause.frameOffsetTicks))],
        Array.from({ length: 17 }, (_, index) => index + 1)
    );
});

test('0.8 second ComboSkill curve retains the observed 21 excluded ticks', () => {
    const resolve = createAkeTimeDilationResolver();
    const result = resolve({
        action: {
            sourceType: 'TimeDilationAction',
            raw: {
                layer: 'Global',
                useCurveKey: true,
                curveKey: 'ComboSkill',
                duration: 0.8
            }
        },
        eventContext: { sourceId: 'caster', blackboard: {} },
        runtime: {
            clockDomains: {
                listDomains: () => [
                    { id: 'caster:clock', kind: 'Character', ownerId: 'caster' },
                    { id: 'ally:clock', kind: 'Character', ownerId: 'ally' }
                ]
            }
        },
        tickRate: 30
    });

    assert.equal(result.nominalDurationTicks, 24);
    assert.equal(result.excludedTicks, 21);
    assert.equal(result.pauses.length, 21);
});
