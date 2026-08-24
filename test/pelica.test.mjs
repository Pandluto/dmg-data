import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { simulateScenario } from '../src/core/simulator.mjs';
import { buildPelicaScenarioModel, serializablePelicaModel } from '../src/scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oracle = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'fixtures', 'calc', 'pelica-heavy-combo-skill.oracle.json'),
    'utf8'
));

function run() {
    const model = buildPelicaScenarioModel();
    return { model, result: simulateScenario(model) };
}

test('raw tables and level-1 patches produce the Pelica scenario model', () => {
    const { model } = run();
    assert.equal(model.identity.chineseName, '佩丽卡');
    assert.equal(model.identity.defaultWeaponId, 'wpn_funnel_0002');
    assert.equal(model.character.attack, 83.851);
    assert.equal(model.enemy.maxHp, 692);
    assert.equal(model.enemy.defense, 100);

    const expectedScales = [0.25, 0.15, 0.12, 0.57, 0.8, 1.78];
    const ids = [
        ...model.roles.normalAttackIds,
        model.roles.comboSkillId,
        model.roles.normalSkillId
    ];
    assert.deepEqual(ids.map(id => model.skills.get(id).blackboard.atk_scale), expectedScales);
    assert.deepEqual(
        ids.map(id => model.skills.get(id).blackboardLineage.atk_scale.at(-1).source),
        Array(6).fill('SkillPatchTable.level1')
    );
    assert.deepEqual(
        model.roles.normalAttackIds.flatMap(id =>
            model.skills.get(id).launches.map(launch => launch.startFrame)
        ),
        [8, 9, 12, 16, 19, 22, 27]
    );
    assert.equal(model.skills.get(model.roles.comboSkillId).launches[0].startFrame, 24);
    assert.equal(model.skills.get(model.roles.normalSkillId).damages[0].startFrame, 13);
    assert.deepEqual(
        model.skills.get('chr_0004_pelica_attack4_projhit').hitStops.map(action => [
            action.affectType,
            action.curveKey,
            action.durationSeconds
        ]),
        [['OnlyTarget', 'char_normal_attack', 0.3]]
    );
    assert.equal(
        model.skills.get('chr_0004_pelica_attack4_projhit')
            .damages[0].damageUnits[0].enablePoiseBreakTimeDilation,
        true
    );
    assert.deepEqual(
        model.skills.get(model.roles.comboSkillId).timeDilations.map(action => [
            action.layer,
            action.curveKey,
            action.duration.value
        ]),
        [['Global', 'ComboSkill', 0.833]]
    );
    assert.deepEqual(
        model.skills.get(model.roles.ultimateSkillId).ultimateTimeActions.map(action =>
            action.timeScale),
        [0]
    );
    assert.doesNotThrow(() => JSON.stringify(serializablePelicaModel(model)));
});

test('current ordinary-enemy rapid-break profile is joined to public guard BuffData', () => {
    const model = buildPelicaScenarioModel({ enemyId: 'eny_0021_agmelee' });
    const policy = model.semanticRules.poiseRules.rapidBreakPolicy;
    assert.deepEqual(
        [policy.qualifyingTicks, policy.guardDurationTicks, policy.minimumTakenScalar,
            policy.lifecycleOffsetTicks, policy.buffId],
        [48, 90, 0.6, 1, 'buff_common_poise_guard']
    );
    assert.deepEqual(
        model.buffs.get(policy.buffId).attributeModifiers.map(modifier => [
            modifier.attributeType,
            modifier.formulaItem,
            modifier.param.blackboardKey
        ]),
        [['PoiseDamageTakenScalar', 'FinalMultiplier', 'poiseTakenScalar']]
    );
});

test('state machine executes queued attacks, combo gate, cost and cooldown', () => {
    const { model, result } = run();
    const executed = result.commandTrace.filter(trace => trace.type === 'CommandExecuted');
    assert.deepEqual(executed.map(trace => trace.frame), [0, 15, 33, 59, 90, 120]);
    assert.deepEqual(executed.map(trace => trace.skillId), [
        ...model.roles.normalAttackIds,
        model.roles.comboSkillId,
        model.roles.normalSkillId
    ]);
    assert.deepEqual(
        result.commandTrace.filter(trace => trace.type === 'CommandQueued')
            .map(trace => [trace.frame, trace.executeFrame]),
        [[30, 33], [45, 59]]
    );
    assert.deepEqual(result.comboSkillTrace.map(trace => [trace.frame, trace.stage]), [
        [86, 'PENDING_CREATED'],
        [90, 'COMMAND_GATE'],
        [90, 'PENDING_CONSUMED']
    ]);
    assert.deepEqual(result.cooldownTrace[0], {
        frame: 90,
        stage: 'Started',
        skillId: model.roles.comboSkillId,
        durationTicks: 600,
        endFrame: 690
    });
    const skillCost = result.resourceTrace.find(trace => trace.reason === 'CastCost');
    assert.deepEqual(
        [skillCost.frame, skillCost.resourceType, skillCost.requestedDelta, skillCost.after],
        [120, 'Atb', -100, 200]
    );
    assert.equal(result.durationTicks, oracle.durationTicks);
});

test('buff machine derives conduct children, duration and 12% defender zone', () => {
    const { result } = run();
    const expectedStarted = [
        ['buff_chr_0004_pelica_combo_skill_tutorial_marker', 114, 30, 144],
        ['buff_common_pulse_triggered_start', 114, 90, 205],
        ['buff_common_pulse_triggered_fx', 114, 150, 265],
        ['buff_common_pulse_pulse_conduct_triggered_do', 114, 150, 265],
        ['buff_common_pulse_pulse_conduct_triggered', 114, 60, 175],
        ['buff_common_energy_shard_attached_pulse', 133, 600, 733],
        ['buff_common_obtain_ultimate_sp', 133, 30, 163]
    ];
    const started = result.buffTrace.filter(trace => trace.stage === 'Started');
    assert.deepEqual(started.map(trace => [
        trace.buffId, trace.frame, trace.durationTicks, trace.expireFrame
    ]), expectedStarted);
    const conduct = started.find(trace =>
        trace.buffId === 'buff_common_pulse_pulse_conduct_triggered_do'
    );
    assert.equal(conduct.blackboard.spell_resistance_decrease, 0.12);
    assert.equal(conduct.blackboard.final_spell_resistance_decrease, 0.12);
    assert.equal(result.damageLog.find(hit => hit.frame === 114)
        .modifierSnapshot.defenderZoneScale, 1.12);
    assert.equal(result.damageLog.find(hit => hit.frame === 133)
        .modifierSnapshot.defenderZoneScale, 1.12);
});

test('clean-room damage output matches the captured Calc oracle hit by hit', () => {
    const { result } = run();
    assert.deepEqual(result.damageLog.map(hit => hit.frame), oracle.damageLog.map(hit => hit.frame));
    assert.deepEqual(result.damageLog.map(hit => hit.skillId), oracle.damageLog.map(hit => hit.skillId));
    assert.deepEqual(result.damageLog.map(hit => hit.rawDamage), oracle.damageLog.map(hit => hit.rawDamage));
    assert.deepEqual(result.damageLog.map(hit => hit.finalDamage), oracle.damageLog.map(hit => hit.finalDamage));
    assert.deepEqual(
        result.damageLog.map(hit => hit.nonCriticalDamage),
        oracle.damageLog.map(hit => hit.nonCriticalDamage)
    );
    assert.deepEqual(
        result.damageLog.map(hit => hit.criticalDamage),
        oracle.damageLog.map(hit => hit.criticalDamage)
    );
    assert.deepEqual(
        result.damageLog.map(hit => hit.expectedDamage),
        oracle.damageLog.map(hit => hit.expectedDamage)
    );
    assert.equal(result.damageSummary.totalDamage, oracle.damageSummary.totalDamage);
    assert.equal(result.finalState.targetHp, oracle.damageLog.at(-1).targetHpAfter);
});

test('the engine does not read the Calc oracle at runtime', () => {
    const implementation = fs.readFileSync(
        path.join(projectRoot, 'src', 'core', 'simulator.mjs'),
        'utf8'
    );
    assert.equal(implementation.includes('fixtures/calc'), false);
    assert.equal(implementation.includes('pelica-heavy-combo-skill.oracle'), false);
});
