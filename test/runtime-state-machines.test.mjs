import assert from 'node:assert/strict';
import test from 'node:test';

import { ClockDomainManager } from '../src/core/clock-domain-manager.mjs';
import { ResourceSystem } from '../src/core/resource-system.mjs';
import { VitalMachine } from '../src/core/vital-machine.mjs';

function scheduler() {
    const events = [];
    return {
        events,
        schedule(frame, priority, run, label = '') {
            events.push({ frame, priority, run, label });
        },
        runUntil(frame) {
            events.sort((left, right) => left.frame - right.frame || left.priority - right.priority);
            while (events[0]?.frame <= frame) events.shift().run();
        }
    };
}

test('ClockDomainManager pauses only the selected local domain', () => {
    const queue = scheduler();
    const clocks = new ClockDomainManager({ schedule: queue.schedule });
    clocks.registerDomain({ id: 'character-a', kind: 'Character', ownerId: 'chr-a' });
    clocks.registerDomain({ id: 'character-b', kind: 'Character', ownerId: 'chr-b' });

    clocks.pause('character-a', {
        frame: 2,
        durationTicks: 3,
        sourceId: 'skill-a',
        ownerId: 'chr-a',
        reason: 'Freeze',
        ruleId: 'rule.freeze'
    });

    assert.equal(clocks.localFrameAt('character-a', 5), 2);
    assert.equal(clocks.localFrameAt('character-b', 5), 5);
    assert.equal(clocks.localFrameAt('global', 5), 5);
    assert.ok(clocks.trace.some(record =>
        record.stage === 'ClockPaused' && record.domainId === 'character-a'
        && record.sourceId === 'skill-a' && record.ruleId === 'rule.freeze'
    ));
});

test('ResourceSystem routes shared and entity pools independently', () => {
    const resources = new ResourceSystem();
    resources.registerPool({
        id: 'squad:Atb',
        resourceType: 'Atb',
        scope: 'Shared',
        initial: 10,
        max: 100
    });
    resources.registerPool({
        id: 'chr-a:UltimateSp',
        resourceType: 'UltimateSp',
        scope: 'Entity',
        ownerId: 'chr-a',
        initial: 20,
        max: 80
    });
    resources.registerPool({
        id: 'chr-b:UltimateSp',
        resourceType: 'UltimateSp',
        scope: 'Entity',
        ownerId: 'chr-b',
        initial: 5,
        max: 80
    });

    resources.gain({ poolId: 'squad:Atb', amount: 15, frame: 2, sourceId: 'attack' });
    resources.spend({
        poolId: 'chr-a:UltimateSp', amount: 10, frame: 3,
        sourceId: 'ultimate', reason: 'CastCost'
    });

    assert.equal(resources.get('squad:Atb'), 25);
    assert.equal(resources.get('chr-a:UltimateSp'), 10);
    assert.equal(resources.get('chr-b:UltimateSp'), 5);
    assert.equal(resources.resolvePool({
        resourceType: 'UltimateSp', scope: 'Entity', ownerId: 'chr-b'
    }).id, 'chr-b:UltimateSp');

    const capped = resources.gain({ poolId: 'squad:Atb', amount: 1000, frame: 4 });
    assert.equal(capped.actual, 75);
    assert.equal(capped.discarded, 925);
    const insufficient = resources.spend({ poolId: 'chr-b:UltimateSp', amount: 6, frame: 5 });
    assert.equal(insufficient.success, false);
    assert.equal(insufficient.insufficient, true);
    assert.equal(resources.get('chr-b:UltimateSp'), 5);
});

test('ResourceSystem suppresses rather than backfills post-spend recovery ticks', () => {
    const queue = scheduler();
    const resources = new ResourceSystem({ schedule: queue.schedule, tickRate: 30 });
    resources.registerPool({
        id: 'squad:Atb',
        resourceType: 'Atb',
        scope: 'Shared',
        initial: 10,
        max: 100,
        passiveRecovery: {
            amountPerTick: 1,
            firstTickFrame: 1,
            resumeDelayTicksAfterSpend: 3
        }
    });

    queue.runUntil(2);
    assert.equal(resources.get('squad:Atb', 2), 12);
    resources.spend({ frame: 2, poolId: 'squad:Atb', amount: 2 });
    queue.runUntil(6);

    assert.equal(resources.get('squad:Atb', 6), 12);
    assert.deepEqual(resources.trace
        .filter(entry => entry.stage === 'ResourceGained' && entry.actual > 0)
        .map(entry => entry.frame), [1, 2, 5, 6]);
});

test('VitalMachine caps healing and consumes shields by priority then creation order', () => {
    const vitals = new VitalMachine();
    vitals.registerEntity({ id: 'enemy', maxHp: 100, currentHp: 60 });

    const heal = vitals.heal({
        targetId: 'enemy',
        baseAmount: 50,
        healingDoneScalar: 1,
        healingTakenScalar: 1,
        frame: 1,
        sourceId: 'healer',
        ownerId: 'party'
    });
    assert.equal(heal.actualHealing, 40);
    assert.equal(heal.healingOverflow, 10);

    const low = vitals.addShield({
        targetId: 'enemy', amount: 10, priority: 1,
        sourceId: 'source-low', frame: 2
    });
    const high = vitals.addShield({
        targetId: 'enemy', amount: 20, priority: 2,
        sourceId: 'source-high', frame: 2
    });
    assert.notEqual(low.shieldId, high.shieldId);

    const firstHit = vitals.damage({ targetId: 'enemy', amount: 25, frame: 3, sourceId: 'attacker' });
    assert.equal(firstHit.shieldAbsorbed, 25);
    assert.equal(firstHit.actualDamage, 0);
    assert.deepEqual(firstHit.absorbedBy.map(item => item.shieldId), [high.shieldId, low.shieldId]);

    const secondHit = vitals.damage({ targetId: 'enemy', amount: 10, frame: 4 });
    assert.equal(secondHit.shieldAbsorbed, 5);
    assert.equal(secondHit.actualDamage, 5);
    assert.equal(vitals.hpRatio('enemy'), 0.95);
    assert.equal(vitals.snapshot().enemy.shields.length, 0);

    for (const record of vitals.trace) {
        assert.ok('frame' in record && 'stage' in record && 'reason' in record);
        assert.ok('sourceId' in record && 'ownerId' in record && 'targetId' in record);
    }
});
