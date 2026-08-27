import assert from 'node:assert/strict';
import test from 'node:test';

import { simulateSquadDemo } from '../demo/demo-service.mjs';

const enemyId = 'eny_0007_mimicw';

test('calculator dummy stays alive so a living-target launch does not enter OnlyDead branches', () => {
    const result = simulateSquadDemo({
        enemyId,
        members: [{ memberId: 'chen', characterId: 'chr_0005_chen' }],
        commands: [{
            commandId: 'chen-normal',
            memberId: 'chen',
            commandType: 'NormalSkill',
            frame: 0,
            queueMode: 'timeline-sequence'
        }],
        endFrame: 120
    });

    const noGuardEvents = result.statusEvents.filter(event => (
        event.buffId === 'buff_physical_no_guard'
        && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage)
    ));
    assert.deepEqual(noGuardEvents.map(event => [event.stage, event.before, event.after]), [
        ['StatusEffectApplied', 0, 1]
    ]);
    assert.equal(
        result.hits.some(hit => hit.sourceBuffId === 'buff_physical_airborne'),
        false,
        'the death-only airborne branch must not add a second anomaly hit'
    );
    assert.ok(result.finalState.targetHp > 999_000_000_000);
    assert.equal(result.finalState.poise.byTargetId[enemyId].maxPoise, 160,
        'demo transport must retain the generic runtime poise state');
});

test('calculator accepts commands moved beyond one minute by fixed waits', () => {
    const result = simulateSquadDemo({
        enemyId,
        members: [{ memberId: 'chen', characterId: 'chr_0005_chen' }],
        commands: [{
            commandId: 'after-long-wait',
            memberId: 'chen',
            commandType: 'Attack',
            frame: 2_000,
            queueMode: 'timeline-sequence',
            attackMode: 'full-combo'
        }],
        endFrame: 2_160
    });

    assert.equal(result.timeline.commands[0]?.requestedFrame, 2_000);
    assert.equal(result.timeline.commands[0]?.success, true);
});
