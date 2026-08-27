import assert from 'node:assert/strict';
import test from 'node:test';

import { ClockDomainManager } from '../src/core/clock-domain-manager.mjs';
import { PoiseSystem } from '../src/core/poise-system.mjs';

function scheduler() {
    const events = [];
    let sequence = 0;
    return {
        schedule(frame, priority, run, label) {
            events.push({ frame, priority, run, label, sequence: sequence++ });
        },
        runThrough(frame) {
            while (true) {
                events.sort((left, right) => left.frame - right.frame
                    || left.priority - right.priority
                    || left.sequence - right.sequence);
                const next = events[0];
                if (!next || next.frame > frame) return;
                events.shift();
                next.run();
            }
        }
    };
}

function definition(maxPoise) {
    return {
        enabled: true,
        maxPoise,
        recoverySeconds: 2,
        executionDamageScalar: 1,
        executionAtbGain: 20,
        brokenDamageScale: 1.3
    };
}

test('multi-target poise cycles use isolated local clocks and causal transitions', () => {
    const clock = scheduler();
    const domains = new ClockDomainManager({
        schedule: clock.schedule,
        domains: [
            { id: 'enemy-a:clock', ownerId: 'enemy-a' },
            { id: 'enemy-b:clock', ownerId: 'enemy-b' }
        ]
    });
    const transitions = [];
    const system = new PoiseSystem({
        schedule: clock.schedule,
        clockDomains: domains,
        targetValidator: targetId => ['enemy-a', 'enemy-b'].includes(targetId),
        onTransition: transition => transitions.push(transition)
    });
    system.registerEntity({
        targetId: 'enemy-a',
        clockDomainId: 'enemy-a:clock',
        definition: definition(60)
    });
    system.registerEntity({
        targetId: 'enemy-b',
        clockDomainId: 'enemy-b:clock',
        definition: definition(100)
    });

    const broken = system.applyDamage({
        targetId: 'enemy-a',
        frame: 10,
        amount: 65,
        sourceId: 'operator',
        ownerId: 'operator',
        skillId: 'skill:break',
        castId: 'cast:1',
        hitId: 'hit:1'
    });
    system.applyDamage({
        targetId: 'enemy-b',
        frame: 10,
        amount: 50,
        sourceId: 'operator',
        skillId: 'skill:other'
    });

    assert.equal(broken.broke, true);
    assert.equal(broken.transition.eventType, 'OnPoiseZero');
    assert.equal(broken.transition.targetId, 'enemy-a');
    assert.equal(broken.transition.skillId, 'skill:break');
    assert.equal(broken.transition.hitId, 'hit:1');
    assert.equal(system.snapshot('enemy-a').broken, true);
    assert.equal(system.snapshot('enemy-b').accumulated, 50);

    domains.pause('enemy-a:clock', {
        frame: 20,
        durationTicks: 5,
        reason: 'HitStop'
    });
    clock.runThrough(69);
    assert.equal(transitions.filter(entry => entry.eventType === 'OnPoiseRecover').length, 0);
    clock.runThrough(75);
    const recovered = transitions.filter(entry => entry.eventType === 'OnPoiseRecover');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].frame, 75);
    assert.equal(recovered[0].targetId, 'enemy-a');
    assert.equal(recovered[0].skillId, 'skill:break',
        'automatic recovery keeps the break transaction as causal metadata');
    assert.equal(system.snapshot('enemy-a').broken, false);
    assert.equal(system.snapshot('enemy-a').cycle, 2);
    assert.equal(system.snapshot('enemy-b').cycle, 1);
});

test('poise registry rejects duplicate and unknown targets before state mutation', () => {
    const system = new PoiseSystem({ targetValidator: targetId => targetId === 'enemy' });
    system.registerEntity({ targetId: 'enemy', definition: definition(60) });
    assert.throws(() => system.registerEntity({
        targetId: 'enemy',
        definition: definition(60)
    }), /Duplicate poise entity/);
    assert.throws(() => system.registerEntity({
        targetId: 'other',
        definition: definition(60)
    }), /Unknown or invalid poise entity/);
    assert.equal(system.snapshot().entities.length, 1);
});
