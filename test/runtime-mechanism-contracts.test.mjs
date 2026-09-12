import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

function run(id) {
    const fixture = JSON.parse(readFileSync(new URL(
        `../fixtures/runtime-mechanism-contracts/${id}.minimal.json`, import.meta.url)));
    const events = [];
    const result = simulateSquadDemo(fixture.input, { traceSink: packet => {
        if (['runtime', 'status', 'effect-source'].includes(packet.source)) events.push(packet);
    } });
    return { result, events };
}

test('COST-01 successful ultimate pays once and grants the source-defined weapon buff', () => {
    const { result, events } = run('F-ultimate-cost-event');
    const notifications = events.filter(({ fact }) => fact.stage === 'AbilityEventNotified'
        && fact.eventType === 'OnAfterSkillApplyCost');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].fact.skillId, 'chr_0016_laevat_ultimate_skill');
    assert.equal(notifications[0].fact.castId, result.commands[0].castId);
    const grants = result.statusEvents.filter(x => x.buffId === 'buff_wpn_sword_0006_valid'
        && x.stage === 'StatusEffectApplied');
    assert.equal(grants.length, 1);
    assert.equal(grants[0].expireFrame, 600);
    const appliedSource = events.find(({ source, fact }) => source === 'effect-source'
        && fact.buffId === 'buff_wpn_sword_0006_valid' && fact.stage === 'EffectSourceApplied');
    assert.equal(appliedSource.fact.after.recomputed.find(x =>
        x.attribute === 'NormalAttackDamageIncrease').evaluation.value, 1.2);
    assert.equal(result.resourceEvents.filter(x => x.stage === 'ResourceSpent').length, 1);
});

test('IDENTITY-01 enhanced normal attack executes after ultimate action end', () => {
    const { result } = run('F-enhanced-attack-cooldown');
    const attack = result.commands.find(x => x.commandType === 'Attack');
    assert.equal(attack.success, true);
    assert.equal(attack.actualFrame, 75);
    const hits = result.hits.filter(x => x.commandId === attack.commandId
        || x.inputCommandType === 'Attack');
    assert.ok(hits.length > 0);
    assert.ok(hits.every(x => x.effectiveSkillType === 'NormalAttack'));
    assert.equal(hits[0].skillId, 'chr_0016_laevat_ult_attack1');
});

test('STACK-01 independently timed weapon stacks expire with their attribute contribution', () => {
    const { result, events } = run('F-independent-weapon-stacks');
    assert.equal(result.commands[1].actualFrame, 41);
    const changes = result.statusEvents.filter(x => x.buffId === 'buff_wpn_sword_0019_up');
    for (const [frame, count] of [[701, 2], [728, 1], [761, 0]]) {
        const at = changes.filter(x => x.frame <= frame).at(-1);
        assert.equal(at.stage === 'StatusEffectFinished' ? 0 : at.stackCount, count, `F${frame}`);
    }
    for (const [frame, value] of [[701, 0.168], [728, 0.084]]) {
        const applied = events.filter(x => x.source === 'effect-source'
            && x.fact.buffId === 'buff_wpn_sword_0019_up'
            && x.fact.frame === frame && x.fact.stage === 'EffectSourceApplied').at(-1);
        assert.ok(applied, `attribute source refreshed at F${frame}`);
        assert.ok(Math.abs(applied.fact.after.recomputed.find(x =>
            x.attribute === 'FireDamageIncrease').evaluation.value - value) < 1e-9);
    }
    const removed = events.find(x => x.source === 'effect-source'
        && x.fact.frame === 761 && x.fact.stage === 'EffectSourceRemoved'
        && x.fact.after.some(stat => stat.attribute === 'FireDamageIncrease'));
    assert.equal(removed.fact.after.find(stat => stat.attribute === 'FireDamageIncrease')
        .evaluation.value, 0);
    // The implementation must expose its per-layer expiry in the runtime status ledger.
    assert.deepEqual(events.filter(x => x.source === 'status'
        && x.fact.buffId === 'buff_wpn_sword_0019_up'
        && x.fact.stage === 'StatusEffectStackExpired').map(x => [x.fact.frame, x.fact.after]),
    [[701, 2], [728, 1], [761, 0]]);
});


test('skill cost transaction notifies once for success and never for zero or failure', () => {
    const runtime = new CombatRuntime({ definitions: {
        entities: [{ id: 'actor', kind: 'Character', team: 'ally' }],
        resources: [{ id: 'atb', resourceType: 'Atb', scope: 'Shared', initial: 20, max: 20 }]
    } });
    const context = { frame: 0, sourceId: 'actor', ownerId: 'actor',
        skillId: 'skill', castId: 'cast', skillType: 'NormalSkill' };
    const pay = amount => runtime.applySkillCost({ ...context, poolRef: 'atb', amount }, context);
    assert.equal(pay(10).success, true);
    assert.equal(pay(0).actual, 0);
    assert.equal(pay(20).success, false);
    const notices = runtime.trace.filter(x => x.stage === 'AbilityEventNotified'
        && x.eventType === 'OnAfterSkillApplyCost');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].castId, 'cast');
});


test('stack lifetime preserves shared refresh, independent expiry, consumption and clear', () => {
    const runtime = new CombatRuntime({ definitions: {
        entities: [{ id: 'actor', kind: 'Character', team: 'ally' }],
        buffs: Object.fromEntries(['shared', 'layers'].map(id => [id, {
            durationTicks: 10, maxStacks: 3,
            stacking: { type: 'AddStack', lifetimePolicy: id === 'layers' ? 'Independent' : 'Shared' }
        }]))
    } });
    const apply = (buffId, frame) => runtime.statusEffects.apply({ buffId, frame,
        sourceId: 'actor', ownerId: 'actor', targetId: 'actor' });
    apply('shared', 0); apply('layers', 0);
    runtime.runUntil(3);
    apply('shared', 3); apply('layers', 3);
    runtime.runUntil(10);
    assert.equal(runtime.statusEffects.trace.find(x => x.frame === 10
        && x.stage === 'StatusEffectStackExpired').after, 1);
    assert.equal(runtime.statusEffects.trace.some(x => x.buffId === 'shared'
        && x.stage === 'StatusEffectFinished'), false);
    runtime.statusEffects.setTimePaused({ frame: 10, buffId: 'layers', isPaused: true });
    runtime.runUntil(12);
    runtime.statusEffects.setTimePaused({ frame: 12, buffId: 'layers', isPaused: false });
    apply('layers', 12);
    runtime.statusEffects.finish({ frame: 12, buffId: 'layers', finishAll: false, stackCount: 1 });
    runtime.runUntil(15);
    assert.ok(runtime.statusEffects.trace.some(x => x.buffId === 'layers'
        && x.frame === 15 && x.stage === 'StatusEffectFinished'));
    apply('layers', 16);
    runtime.statusEffects.finish({ frame: 17, buffId: 'layers' });
    const before = runtime.statusEffects.trace.length;
    runtime.runUntil(30);
    assert.equal(runtime.statusEffects.trace.length, before);
    assert.ok(runtime.statusEffects.trace.some(x => x.buffId === 'shared'
        && x.frame === 13 && x.stage === 'StatusEffectFinished'));
});
