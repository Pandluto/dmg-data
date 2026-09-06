import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { buildAkeRdpsContext } from '../src/core/ake-rdps-context.mjs';

const characterId = 'chr_0027_tangtang';
const enemyId = 'eny_0007_mimicw';
const bundle = new AkeSquadScenarioAssembler().assemble({
    enemyId,
    enemyMaxHp: 1e8,
    members: [{ memberId: 'tangtang', characterId, level: 90, skillLevel: 12 }]
});

function emptyRuntime() {
    const runner = new AkeSquadScenarioRunner(bundle);
    runner.run({ commands: [], endFrame: 0 });
    return runner.lastRuntime;
}

function hpHits(runtime) {
    return runtime.effects.trace.flatMap(entry => entry.type === 'ResolveDamagePacket'
        ? entry.result?.resolution?.hits ?? [] : [])
        .filter(hit => hit.damageAttributeType === 'Hp');
}

test('a tornado born from a self-targeted Buff channels at its hostile finder targets', () => {
    const runtime = emptyRuntime();
    runtime.execute({
        type: 'LaunchSkillProgram',
        abilityEntityId: 'abilityentity.fixture.tornado',
        childSkillId: 'chr_0027_tangtang_normal_skill_water_projhit'
    }, {
        frame: 0, sourceId: characterId, ownerId: characterId, targetId: characterId,
        skillId: 'fixture.self-buff', rootSkillId: 'fixture.ultimate',
        castId: 'fixture.cast', effectiveSkillType: 'UltimateSkill',
        blackboard: { tornado_atk_scale01: 1, hit_spelllnflictionmax_01: 1 }
    });
    runtime.runUntil(100);
    const hits = hpHits(runtime);
    assert.equal(hits.length, 12);
    assert.ok(hits.every(hit => hit.targetId === enemyId));
    const enemyAttachment = runtime.statusEffects.list({ targetId: enemyId,
        buffId: 'buff_common_energy_shard_attached_cryst' });
    assert.ok(enemyAttachment.length > 0);
    assert.equal(runtime.statusEffects.list({ targetId: characterId,
        buffId: 'buff_common_energy_shard_attached_cryst' }).length, 0);
});

test('natural Tangtang ultimate completes once without entering the plunge-only branch', () => {
    const runner = new AkeSquadScenarioRunner(bundle);
    const result = runner.run({
        commands: [{ memberId: 'tangtang', commandType: 'UltimateSkill', frame: 0 }],
        endFrame: 360
    });
    const hp = result.damageLog.filter(hit => hit.damageAttributeType === 'Hp');
    assert.deepEqual(hp.map(hit => hit.atkScale), [...Array(8).fill(0.4), 4]);
    assert.ok(hp.every(hit => hit.targetId === enemyId));
});

test('overlapping tornado entities from one skill cast share its cold-application limit', () => {
    const runtime = emptyRuntime();
    for (const frame of [0, 10]) {
        runtime.runUntil(frame);
        runtime.execute({ type: 'LaunchSkillProgram',
            abilityEntityId: 'abilityentity.fixture.overlapping-tornado',
            childSkillId: 'chr_0027_tangtang_normal_skill_water_projhit' }, {
            frame, sourceId: characterId, ownerId: characterId, targetId: enemyId,
            skillId: 'fixture.parent', rootSkillId: 'fixture.parent',
            castId: 'fixture.shared-parent', rootCastId: 'fixture.shared-parent',
            effectiveSkillType: 'NormalSkill',
            blackboard: { tornado_atk_scale01: 1, hit_spelllnflictionmax_01: 1 }
        });
    }
    runtime.runUntil(120);
    const cold = runtime.statusEffects.trace.filter(entry =>
        entry.buffId === 'buff_common_energy_shard_attached_cryst'
        && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(entry.stage)
        && entry.actual > 0);
    assert.deepEqual(cold.map(entry => entry.frame), [0]);
    assert.equal(new Set(runtime.effects.trace.filter(entry => entry.type === 'ResolveDamagePacket'
        && entry.skillId === 'chr_0027_tangtang_normal_skill_water_projhit')
        .map(entry => entry.castId)).size, 2,
        'both entities still deal damage; only their shared skill-cast limit is coalesced');
    assert.deepEqual([...new Set(cold.map(entry => entry.rootCastId))], ['fixture.shared-parent']);
    assert.ok(cold.every(entry => entry.sourceId === characterId && entry.targetId === enemyId));
});

test('a real plunge inside Tangtang ultimate replaces its natural ending with the enhanced wave', () => {
    const runner = new AkeSquadScenarioRunner(bundle);
    runner.run({ commands: [{ memberId: 'tangtang', commandType: 'UltimateSkill', frame: 0 }],
        endFrame: 100 });
    const runtime = runner.lastRuntime;
    const buff = runtime.statusEffects.list({ active: true, targetId: characterId,
        buffId: 'buff_chr_0027_tangtang_ultskill_buff' })[0];
    assert.ok(buff, 'the allied aura must attach the plunge listener to the character');
    assert.ok(buff.sourceId.startsWith('ability-entity:'));
    runtime.scheduleProgram(bundle.programs.get('chr_0027_tangtang_plunging_attack_end'), {
        frame: 100, sourceId: characterId, ownerId: characterId, targetId: enemyId,
        skillId: 'chr_0027_tangtang_plunging_attack_end',
        rootSkillId: 'chr_0027_tangtang_plunging_attack_end', castId: 'fixture.plunge',
        effectiveSkillType: 'Attack', inputCommandType: 'Attack',
        commandType: 'Attack', skillType: 'Attack'
    });
    runtime.runUntil(400);
    const waveHits = runtime.effects.trace.filter(entry => entry.type === 'ResolveDamagePacket'
        && entry.skillId === 'chr_0027_tangtang_ultimate_skill_1')
        .flatMap(entry => (entry.result?.resolution?.hits ?? [])
            .filter(hit => hit.damageAttributeType === 'Hp'));
    assert.deepEqual(waveHits.map(hit => hit.operands.atkScale), [0.4, 0.4, 7]);
    assert.equal(runtime.trace.filter(entry => entry.type === 'SkillProgramSeeked').length, 1);
    assert.ok(hpHits(runtime).every(hit => hit.targetId === enemyId));
    const damageActions = runtime.effects.trace.filter(entry => entry.type === 'ResolveDamagePacket');
    assert.ok(damageActions.some(entry => entry.action.damageUnits.length > 1));
    const beforeActions = runtime.trace.filter(entry => entry.stage === 'AbilityEventNotified'
        && entry.eventType === 'OnBeforeDamageAction');
    assert.equal(beforeActions.length, damageActions.length,
        'HP and Poise units within one original DamageAction must share one before-action event');
    assert.ok(beforeActions.every(entry => entry.listenerTargetId === characterId));
    const tornadoHits = runtime.effects.trace.filter(entry => entry.type === 'ResolveDamagePacket'
        && entry.skillId === 'chr_0027_tangtang_normal_skill_water_projhit')
        .flatMap(entry => (entry.result?.resolution?.hits ?? [])
            .filter(hit => hit.damageAttributeType === 'Hp'));
    assert.equal(tornadoHits.length, 12);
    assert.ok(tornadoHits.every(hit => Math.abs(hit.operands.attackerZoneScale - 1.6) < 1e-9),
        'the max-rank talent must apply its +60% DamageScaleProcessor');
    const rdps = buildAkeRdpsContext({ hits: hpHits(runtime), enemyId,
        characters: [{ localCharacterId: characterId, akeCharacterId: characterId }],
        statusEvents: runtime.statusEffects.trace });
    assert.ok(rdps.audit.maximumHitError < 1e-8);
});

test('retiring an arbitrary ability entity stops its channel while a sibling cast and detached Buff survive', () => {
    const calls = [];
    const child = { skillId: 'fixture.channel', blackboard: {}, timeline: [{ groupIndex: 0,
        startFrame: 0, endFrame: 30, actions: [{ type: 'ScheduleIntervalActions',
            intervalTicks: 5, durationTicks: 30, actions: [{ type: 'ResolveDamagePacket', damageUnits: [] }] }] }] };
    const runtime = new CombatRuntime({
        definitions: { entities: [{ id: 'actor', kind: 'Character', team: 'ally' },
            { id: 'enemy', kind: 'Enemy', team: 'enemy' }],
        buffs: { 'fixture.detached': { lifeType: 'Infinity' } } },
        damageResolver: ({ eventContext }) => {
            calls.push([eventContext.frame, eventContext.ownerId]);
            return { status: 'Resolved', hits: [] };
        },
        skillProgramResolver: () => child
    });
    const context = { frame: 0, sourceId: 'actor', ownerId: 'actor', targetId: 'enemy',
        skillId: 'fixture.parent', rootSkillId: 'fixture.parent', castId: 'fixture.cast' };
    const spawned = runtime.execute({ type: 'LaunchSkillProgram',
        abilityEntityId: 'fixture.object', childSkillId: child.skillId }, context);
    runtime.execute({ type: 'ApplyBuff', target: 'Target', buffId: 'fixture.detached' }, context);
    runtime.scheduleProgram({ skillId: 'fixture.sibling', blackboard: {}, timeline: [{ groupIndex: 0,
        startFrame: 15, endFrame: 16, actions: [{ type: 'ResolveDamagePacket', damageUnits: [] }] }] },
    { ...context, castId: 'fixture.sibling.cast' });
    runtime.runUntil(7);
    runtime.execute({ type: 'DeactivateEntity', target: spawned.spawnedAbilityEntityId },
        { ...context, frame: 7 });
    runtime.runUntil(30);
    assert.deepEqual(calls, [[0, spawned.spawnedAbilityEntityId],
        [5, spawned.spawnedAbilityEntityId], [15, 'actor']]);
    assert.equal(runtime.statusEffects.has({ targetId: 'enemy', buffId: 'fixture.detached' }), true);
});
