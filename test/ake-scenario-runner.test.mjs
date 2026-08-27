import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const baseOptions = Object.freeze({
    characterId: 'chr_0004_pelica',
    enemyId: 'eny_0007_mimicw'
});

function close(actual, expected, epsilon = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= epsilon,
        `${actual} differs from ${expected} by more than ${epsilon}`);
}

test('AKE scenario assembler joins versioned AKEDatabase tables and dependency closure', () => {
    const bundle = new AkeScenarioAssembler().assemble(baseOptions);

    assert.equal(bundle.identity.weaponId, 'wpn_funnel_0002');
    assert.equal(bundle.parameters.characterAttributes.Atk, 83.851);
    assert.equal(bundle.parameters.enemyMaxHp, 692);
    assert.equal(bundle.parameters.enemyAttributes.Def, 100);
    assert.deepEqual(bundle.definitions.entities.find(entity =>
        entity.id === baseOptions.enemyId
    ).poise, {
        enabled: true,
        maxPoise: 160,
        recoverySeconds: 7,
        executionDamageScalar: 1.25,
        executionAtbGain: 35,
        knotPercentages: [],
        knotBuffIds: [],
        knotDurationTicksByBuffId: {},
        brokenDamageScale: 1.3,
        breakDamageBuffId: 'buff_common_poise_break_damage_taken_scale',
        executionGateBuffId: 'buff_common_poise_can_be_breaking_attacked',
        recoveryTimingModel: 'nominal-gameplay-ticks-excludes-presentation-pauses',
        rapidBreakPolicy: { enabled: false }
    });
    assert.deepEqual(bundle.roles.normalAttackIds, [
        'chr_0004_pelica_attack1',
        'chr_0004_pelica_attack2',
        'chr_0004_pelica_attack3',
        'chr_0004_pelica_attack4'
    ]);
    assert.equal(bundle.programs.get('chr_0004_pelica_attack1').blackboard.atk_scale, 0.25);
    assert.equal(bundle.programs.get('chr_0004_pelica_combo_skill').blackboard.atk_scale, 0.8);
    assert.equal(bundle.programs.get('chr_0004_pelica_normal_skill').blackboard.atk_scale, 1.78);
    assert.ok(bundle.programs.has('chr_0004_pelica_combo_skill_projhit'));
    assert.ok(bundle.buffs.has('buff_common_pulse_pulse_conduct_triggered_do'));
    assert.equal(bundle.dependencySummary.missingSkillCount, 0);
    assert.equal(bundle.dependencySummary.missingBuffCount, 0);
    assert.deepEqual(bundle.diagnostics, []);
});

test('generic command runner reproduces Pelica command, combo, Buff and damage chain', () => {
    const bundle = new AkeScenarioAssembler().assemble(baseOptions);
    const runner = new AkeScenarioRunner(bundle);
    const result = runner.run();

    assert.equal(result.durationTicks, 269);
    assert.deepEqual(result.commandTrace
        .filter(entry => entry.type === 'CommandExecuted' && entry.success)
        .map(entry => entry.frame), [0, 15, 33, 59, 90, 120]);
    const hpHits = result.damageLog.filter(hit => hit.damageAttributeType === 'Hp');
    assert.deepEqual(hpHits.map(hit => hit.frame), [8, 24, 27, 49, 52, 55, 86, 114, 133]);
    const expectedDamage = [
        10.481375,
        6.288825,
        6.288825,
        5.03106,
        5.03106,
        5.03106,
        23.897535,
        37.565248,
        83.5826768
    ];
    hpHits.forEach((hit, index) => close(hit.finalDamage, expectedDamage[index]));
    close(result.damageSummary.totalDamage, 183.1976648);
    close(result.finalState.targetHp, 508.8023352000001);
    close(result.finalState.resources.Atb, 235.7333351969719);
    assert.equal(result.finalState.resources.UltimateSp, 80);
    assert.equal(result.diagnostics.unresolvedEffectCount, 0);

    assert.ok(result.comboTrace.some(entry =>
        entry.stage === 'PENDING_CREATED' && entry.frame === 86
    ));
    assert.ok(result.comboTrace.some(entry =>
        entry.stage === 'PENDING_CONSUMED' && entry.frame === 90
    ));
    assert.equal(hpHits[7].modifierSnapshot.defenderZone.scale, 1.12);
    assert.equal(hpHits[8].modifierSnapshot.defenderZone.scale, 1.12);
    assert.ok(result.statusTrace.some(entry =>
        entry.stage === 'StatusEffectApplied'
        && entry.buffId === 'buff_common_pulse_pulse_conduct_triggered_do'
        && entry.targetId === 'eny_0007_mimicw'
    ));
});

test('generic runner aligns uncapped Pelica ATB and USP gains', () => {
    const emptyUsp = new AkeScenarioAssembler().assemble({
        ...baseOptions,
        initialUltimateSp: 0
    });
    const emptyUspResult = new AkeScenarioRunner(emptyUsp).run();
    close(emptyUspResult.finalState.resources.UltimateSp, 16.49999976158142);
    assert.deepEqual(emptyUspResult.resourceTrace
        .filter(entry => entry.resourceType === 'UltimateSp'
            && entry.stage === 'ResourceGained')
        .map(entry => [entry.frame, entry.requested, entry.actual]), [
        [114, 10, 10],
        [133, 6.499999761581421, 6.499999761581421]
    ]);

    const emptyAtb = new AkeScenarioAssembler().assemble({
        ...baseOptions,
        initialAtb: 0,
        initialUltimateSp: 0
    });
    const attack4Result = new AkeScenarioRunner(emptyAtb).run({
        commands: [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 45, commandType: 'Attack' }
        ]
    });
    const gain = attack4Result.resourceTrace.find(entry =>
        entry.frame === 86 && entry.resourceType === 'Atb'
        && entry.stage === 'ResourceGained' && entry.requested === 15
    );
    close(gain.before, 22.666667848825455);
    assert.equal(gain.actual, 15);
    close(gain.after, 37.666667848825455);
});

test('generic runner applies only evidence-mapped enemy local-clock pauses', () => {
    const bundle = new AkeScenarioAssembler().assemble({
        ...baseOptions,
        enemyMaxResilience: 15
    });
    const result = new AkeScenarioRunner(bundle).run({
        commands: [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 45, commandType: 'Attack' }
        ]
    });

    assert.ok(result.localClockTriggerTrace.some(entry =>
        entry.stage === 'LocalClockPauseApplied'
        && entry.frame === 86
        && entry.trigger === 'PoiseBreak'
        && entry.durationTicks === 7
    ));
    assert.equal(result.finalState.clocks.byDomainId['eny_0007_mimicw:clock']
        .totalPausedTicks, 7);
});

test('generic runner derives ultimate ATB recovery pause from UltimateTimeAction', () => {
    const bundle = new AkeScenarioAssembler().assemble({
        ...baseOptions,
        initialAtb: 0
    });
    const ultimate = bundle.programs.get('chr_0004_pelica_ultimate_skill');
    const recoveryWindow = ultimate.timeline.find(group => group.actions.some(action =>
        action.type === 'SuspendResourceRecovery'
    ));
    assert.deepEqual(
        { startFrame: recoveryWindow.startFrame, endFrame: recoveryWindow.endFrame },
        { startFrame: 0, endFrame: 50 }
    );

    const result = new AkeScenarioRunner(bundle).run({
        commands: [{ frame: 0, commandType: 'UltimateSkill' }],
        endFrame: 60
    });
    assert.deepEqual(result.resourceTrace
        .filter(entry => entry.stage === 'ResourceGained'
            && entry.resourceType === 'Atb' && entry.actual > 0)
        .map(entry => entry.frame), [1, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    assert.ok(result.resourceTrace.some(entry =>
        entry.stage === 'ResourceRecoveryResumed' && entry.frame === 50
    ));
});
