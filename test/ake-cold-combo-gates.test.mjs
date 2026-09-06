import assert from 'node:assert/strict';
import test from 'node:test';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const tangtang = 'chr_0027_tangtang';
const lastrite = 'chr_0026_lastrite';
const enemyId = 'eny_0007_mimicw';
const attachmentBuffIds = Object.fromEntries(['Fire', 'Cryst', 'Pulse', 'Natural'].map(element =>
    [element, `buff_common_energy_shard_attached_${element.toLowerCase()}`]));
const bundle = new AkeSquadScenarioAssembler().assemble({
    enemyId, enemyMaxHp: 1e8, initialAtb: 300,
    members: [{ memberId: 'tangtang', characterId: tangtang, level: 90, skillLevel: 12 },
        { memberId: 'lastrite', characterId: lastrite, level: 90, skillLevel: 12 }]
});

function emptyRunner() {
    const runner = new AkeSquadScenarioRunner(bundle);
    runner.run({ commands: [], endFrame: 0 });
    return runner;
}

function inflict(runner, element, frame, targetId = enemyId) {
    runner.lastRuntime.execute({ type: 'ApplyEnemyInfliction', element,
        buffId: attachmentBuffIds[element], attachmentBuffIds,
        target: 'Target', reason: 'SpellInfliction' }, {
        frame, sourceId: tangtang, ownerId: tangtang, targetId,
        skillId: 'fixture.infliction', rootSkillId: 'fixture.infliction',
        castId: `fixture.infliction:${frame}`, effectiveSkillType: 'NormalSkill'
    });
}

test('neither cold combo is admissible on an empty battlefield', () => {
    for (const memberId of ['tangtang', 'lastrite']) {
        const result = new AkeSquadScenarioRunner(bundle).run({
            commands: [{ memberId, commandType: 'ComboSkill', frame: 0 }], endFrame: 31
        });
        assert.equal(result.commandTrace.some(event => event.type === 'CommandExecuted'
            && event.success), false, `${memberId} must wait for its actual trigger`);
        assert.ok(result.comboTrace.some(event => event.reason === 'COMBO_PENDING_MISSING'));
    }
});

test('cold applies Tangtang pending at one layer and Last Rite pending only when crossing three', () => {
    const runner = emptyRunner();
    const pending = () => runner.lastComboMachine.snapshot();
    inflict(runner, 'Cryst', 0);
    assert.deepEqual(pending().map(entry => entry.ownerId), [tangtang]);
    inflict(runner, 'Cryst', 1);
    assert.deepEqual(pending().map(entry => entry.ownerId), [tangtang]);
    inflict(runner, 'Cryst', 2);
    assert.deepEqual(new Set(pending().map(entry => entry.ownerId)), new Set([tangtang, lastrite]));
    const selected = pending().find(entry => entry.ownerId === lastrite);
    runner.lastComboMachine.consume({ frame: 2, pendingId: selected.id });
    inflict(runner, 'Cryst', 3);
    assert.equal(pending().some(entry => entry.ownerId === lastrite), false,
        'a fourth layer must not pretend to cross the third-layer threshold again');
});

test('a raw same-element Fire burst opens Tangtang combo without cold', () => {
    const runner = emptyRunner();
    inflict(runner, 'Fire', 0);
    inflict(runner, 'Fire', 1);
    assert.equal(runner.lastComboMachine.snapshot().length, 0);
    runner.lastRuntime.runUntil(35);
    assert.deepEqual(runner.lastComboMachine.snapshot().map(entry => entry.ownerId), [tangtang]);
    assert.equal(runner.lastRuntime.statusEffects.has({ targetId: enemyId,
        buffId: attachmentBuffIds.Cryst }), false);
});

test('friendly cold cannot satisfy either enemy-only combo condition', () => {
    const runner = emptyRunner();
    for (let frame = 0; frame < 3; frame += 1) inflict(runner, 'Cryst', frame, tangtang);
    runner.lastRuntime.runUntil(35);
    assert.equal(runner.lastComboMachine.snapshot().length, 0);
});

test('a real Tangtang battle skill enables and consumes its combo through command admission', () => {
    const result = new AkeSquadScenarioRunner(bundle).run({ commands: [
        { memberId: 'tangtang', commandType: 'NormalSkill', frame: 0 },
        { memberId: 'tangtang', commandType: 'ComboSkill', frame: 60 }
    ], endFrame: 140 });
    assert.equal(result.commandTrace.some(event => event.type === 'CommandExecuted'
        && event.commandType === 'ComboSkill' && event.success), true);
    assert.ok(result.comboTrace.some(event => event.stage === 'PENDING_CONSUMED'
        && event.skillId === `${tangtang}_combo_skill`));
});

test('three real battle skills enable Last Rite combo, whose raw hit consumes the cold layers', () => {
    const result = new AkeSquadScenarioRunner(bundle).run({ commands: [
        ...[0, 150, 300].map(frame => ({ memberId: 'tangtang', commandType: 'NormalSkill', frame })),
        { memberId: 'lastrite', commandType: 'ComboSkill', frame: 350 }
    ], endFrame: 490 });
    assert.ok(result.commandTrace.some(event => event.type === 'CommandExecuted'
        && event.memberId === 'lastrite' && event.success));
    assert.ok(result.comboTrace.some(event => event.stage === 'PENDING_CONSUMED'
        && event.skillId === `${lastrite}_combo_skill`));
    assert.ok(result.statusTrace.some(event => event.buffId === attachmentBuffIds.Cryst
        && event.stage === 'StatusEffectFinished' && event.consumption
        && event.consumerId === lastrite));
    assert.deepEqual(result.statusTrace.filter(event => event.buffId === attachmentBuffIds.Cryst
        && Number(event.actual) > 0 && event.stage !== 'StatusEffectFinished')
        .map(event => event.frame), [23, 173, 323],
    'a preceding cast marker must not delay the next tornado\'s one cold application');
});

test('Last Rite combo converts three or four actual cold layers into its finishing hit and energy', () => {
    const scenario = new AkeSquadScenarioAssembler().assemble({
        enemyId, enemyMaxHp: 1e12, initialAtb: 300,
        members: [{ memberId: 'tangtang', characterId: tangtang, level: 90, skillLevel: 12 },
            { memberId: 'lastrite', characterId: lastrite, level: 90, skillLevel: 12,
                initialUltimateSp: 0 }]
    });
    const skillId = `${lastrite}_combo_skill`;
    const blackboard = scenario.programs.get(skillId).blackboard;
    const rows = [];
    for (const layers of [0, 3, 4]) {
        const frame = layers === 4 ? 500 : 350;
        const result = new AkeSquadScenarioRunner(scenario).run({ commands: [
            ...[0, 150, 300, 450].slice(0, layers).map(frame => ({
                memberId: 'tangtang', commandType: 'NormalSkill', frame
            })),
            { memberId: 'lastrite', commandType: 'ComboSkill', frame }
        ], endFrame: frame + 150 });
        const hits = result.damageLog.filter(hit => hit.skillId === skillId
            && hit.damageAttributeType === 'Hp');
        const consumed = result.statusTrace.filter(event => event.buffId === attachmentBuffIds.Cryst
            && event.consumption && event.consumerId === lastrite);
        const energy = result.resourceTrace.filter(event => event.skillId === skillId
            && event.resourceType === 'UltimateSp' && event.stage === 'ResourceGained');
        if (layers === 0) {
            assert.equal(result.commandTrace.some(event => event.type === 'CommandExecuted'
                && event.memberId === 'lastrite' && event.success), false);
            assert.deepEqual(hits, []);
            assert.deepEqual(consumed, []);
            assert.deepEqual(energy, []);
            continue;
        }
        assert.deepEqual(consumed.map(event => [event.consumedStacks, event.after]), [[layers, 0]]);
        assert.equal(hits.length, 3);
        assert.ok(Math.abs(hits[1].atkScale - blackboard.atk_scale3 * layers) < 1e-10,
            `${layers} consumed cold layers must drive the final hit scale`);
        assert.ok(hits.every(hit => hit.finalDamage > 0));
        assert.deepEqual(energy.map(event => event.actual), [blackboard.usp_base, blackboard.usp * layers],
            'per-target ForEach accumulation must reach the later energy action');
        rows.push(hits[1]);
    }
    assert.ok(Math.abs(rows[1].finalDamage / rows[0].finalDamage - 4 / 3) < 1e-10);
});

test('one real battle skill consuming two whirlpools deals three tornado streams but applies one cold layer', () => {
    const result = new AkeSquadScenarioRunner(bundle).run({ commands: [
        { memberId: 'tangtang', commandType: 'NormalSkill', frame: 0 },
        { memberId: 'tangtang', commandType: 'ComboSkill', frame: 60 },
        { memberId: 'tangtang', commandType: 'NormalSkill', frame: 120 }
    ], endFrame: 300 });
    const cold = result.statusTrace.filter(event => event.buffId === attachmentBuffIds.Cryst
        && event.actual > 0 && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
    assert.deepEqual(cold.map(event => [event.frame, event.before, event.after]), [[23, 0, 1], [143, 1, 2]]);
    const secondCast = cold[1].rootCastId;
    const tornadoHits = result.damageLog.filter(hit => hit.rootCastId === secondCast
        && hit.damageAttributeType === 'Hp' && hit.skillId.includes('water_projhit'));
    assert.equal(new Set(tornadoHits.map(hit => hit.castId)).size, 3);
    assert.equal(result.comboTrace.some(event => event.stage === 'PENDING_CREATED'
        && event.skillId === `${lastrite}_combo_skill`), false,
    'one enhanced battle skill cannot manufacture three independent cold applications');
});

test('Last Rite phantom inflicts the enemy found by its Buff and combines cold with Tangtang', () => {
    const result = new AkeSquadScenarioRunner(bundle).run({ initialControllerCharacterId: lastrite,
        commands: [
            { memberId: 'lastrite', commandType: 'Attack', frame: 0, attackMode: 'full-combo' },
            { memberId: 'tangtang', commandType: 'NormalSkill', frame: 0 },
            { memberId: 'lastrite', commandType: 'NormalSkill', frame: 50 },
            { memberId: 'tangtang', commandType: 'ComboSkill', frame: 70 },
            { memberId: 'tangtang', commandType: 'NormalSkill', frame: 200 },
            { memberId: 'lastrite', commandType: 'ComboSkill', frame: 250 }
        ], endFrame: 400 });
    const cold = result.statusTrace.filter(event => event.buffId === attachmentBuffIds.Cryst
        && event.actual > 0 && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
    assert.ok(cold.every(event => event.targetId === enemyId), 'a self-owned phantom Buff must never inflict its carrier');
    assert.deepEqual(cold.map(event => [event.sourceId, event.after]), [[tangtang, 1], [lastrite, 2], [tangtang, 3]]);
    assert.ok(result.commandTrace.some(event => event.memberId === 'lastrite'
        && event.type === 'CommandExecuted' && event.commandType === 'ComboSkill' && event.success));
    assert.ok(result.statusTrace.some(event => event.buffId === attachmentBuffIds.Cryst
        && event.consumption && event.consumerId === lastrite && event.consumedStacks === 3));
});

test('the single-character runner observes real cold and burst events for the same admission rules', () => {
    const single = new AkeScenarioAssembler().assemble({ characterId: tangtang,
        enemyId, enemyMaxHp: 1e8 });
    const result = new AkeScenarioRunner(single).run({ commands: [
        { commandType: 'ComboSkill', frame: 0 },
        { commandType: 'NormalSkill', frame: 40 },
        { commandType: 'ComboSkill', frame: 100 }
    ], endFrame: 180 });
    assert.equal(result.commandTrace.filter(event => event.type === 'CommandExecuted'
        && event.commandType === 'ComboSkill' && event.success).length, 1);
    const runner = new AkeScenarioRunner(single);
    runner.run({ commands: [], endFrame: 0 });
    inflict(runner, 'Fire', 0);
    inflict(runner, 'Fire', 1);
    runner.lastRuntime.runUntil(35);
    assert.deepEqual(runner.lastComboMachine.snapshot().map(entry => entry.ownerId), [tangtang]);
});
