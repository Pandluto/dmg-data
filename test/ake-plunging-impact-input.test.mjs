import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateDemo, simulateSquadDemo } from '../demo/demo-service.mjs';

const L = 'chr_0026_lastrite';
const T = 'chr_0027_tangtang';
const members = [L, T].map(characterId => ({ memberId: characterId, characterId,
    level: 90, skillLevel: 12, potentialLevel: 0,
    initialUltimateSp: characterId === T ? 90 : 240 }));
const ultimate = { memberId: T, commandId: 'ultimate', commandType: 'UltimateSkill', frame: 0 };
const landing = { memberId: L, commandId: 'landing', commandType: 'Attack',
    attackMode: 'plunging-impact', frame: 100, queueMode: 'timeline-sequence' };
const run = (commands, options = {}, traceSink) => simulateSquadDemo({ members,
    initialControllerCharacterId: L, commands, endFrame: 400, ...options }, { traceSink });
const wave = result => result.hits.filter(hit => hit.skillId === `${T}_ultimate_skill_1`
    && hit.damageAttributeType === 'Hp');
const tornado = result => result.hits.filter(hit => hit.skillId === `${T}_normal_skill_water_projhit`
    && hit.damageAttributeType === 'Hp');

test('the normal and explicit landing inputs select distinct real programs and ultimate branches', () => {
    const natural = run([ultimate]);
    const ordinary = run([ultimate, { ...landing, attackMode: undefined }]);
    const seeks = [];
    const triggered = run([ultimate, landing], {}, event => {
        if (event.fact.stage === 'SkillProgramSeeked') seeks.push(event.fact);
    });
    assert.deepEqual(wave(natural).map(hit => hit.atkScale), [...Array(8).fill(0.4), 4]);
    assert.deepEqual(wave(ordinary).map(hit => [hit.frame, hit.atkScale]),
        wave(natural).map(hit => [hit.frame, hit.atkScale]));
    assert.equal(tornado(ordinary).length, 0);
    const command = triggered.commands.find(item => item.commandId === landing.commandId);
    assert.equal(command.skillId, `${L}_plunging_attack_end`);
    assert.equal(command.attackMode, 'plunging-impact');
    assert.equal(command.actualFrame, 100);
    assert.equal(command.queued, false);
    assert.deepEqual(wave(triggered).map(hit => hit.atkScale), [0.4, 0.4, 7]);
    assert.equal(seeks.length, 1);
    assert.equal(seeks[0].frame, 102, 'the original landing damage occurs two frames after action input');
    assert.equal(seeks[0].rootCastId, triggered.commands[0].castId);
    assert.equal(tornado(triggered).length, 12);
    assert.ok(tornado(triggered).every(hit => hit.sourceId === T
        && hit.damageSourceId === T && hit.rootCastId === triggered.commands[0].castId),
    'the reactive tornado belongs to Tangtang ultimate, not the triggering ally');
    assert.ok([...tornado(triggered), ...wave(triggered).filter(hit => hit.atkScale === 7)]
        .every(hit => hit.triggerCastId === command.castId
            && hit.triggerRootCastId === command.castId && hit.triggerSourceId === L
            && hit.triggerSkillId === `${L}_plunging_attack_end` && hit.triggerFrame === 102),
    'the branch and its delayed children retain the separate landing trigger');
    assert.equal(seeks[0].triggerRootCastId, command.castId);
    assert.ok(wave(natural).every(hit => hit.triggerCastId === null));
    assert.equal(triggered.hits.some(hit => hit.skillId.endsWith('_plunging_attack_start')), false);
});

test('landing requires current control and a legal exact-frame admission, and has no unconditional Q enhancement', () => {
    const offField = run([ultimate, { ...landing, memberId: T }]);
    assert.equal(offField.commands[1].success, false);
    assert.equal(offField.commands[1].reason, 'PLUNGING_IMPACT_REQUIRES_MAIN_CHARACTER');
    assert.equal(offField.commands[1].attackMode, 'plunging-impact');
    assert.deepEqual(wave(offField).map(hit => hit.atkScale), [...Array(8).fill(0.4), 4]);
    const blocked = run([{ ...ultimate, memberId: L }, { ...landing, frame: 1 }]);
    assert.equal(blocked.commands[1].reason, 'PLUNGING_IMPACT_BLOCKED');
    assert.equal(blocked.commands[1].queued, false, 'an external landing time cannot silently move into an input queue');
    assert.equal(blocked.commands[1].actualFrame, null);
    const outside = run([landing]);
    assert.equal(outside.commands[0].success, true);
    assert.equal(wave(outside).length, 0);
    assert.equal(tornado(outside).length, 0);
    const switched = run([ultimate, { ...landing, memberId: T }], {
        operatorSwitches: [{ characterId: T, frame: 90 }],
    });
    assert.equal(switched.commands[1].success, true, 'control is checked at the actual input, not initial lineup');
    assert.equal(wave(switched).filter(hit => hit.atkScale === 7).length, 1,
        'the four original landing impacts still produce only one enhanced ending');
});

test('the single-character API also preserves landing intent and executes the end program', () => {
    const characterId = 'chr_0004_pelica';
    const result = simulateDemo({ characterId, enemyId: 'eny_0007_mimicw',
        level: 90, skillLevel: 12, endFrame: 200,
        commands: [{ ...landing, memberId: characterId }] });
    assert.equal(result.commands[0].attackMode, 'plunging-impact');
    assert.equal(result.commands[0].success, true);
    assert.equal(result.commands[0].queued, false);
    assert.equal(result.commands[0].skillId, `${characterId}_plunging_attack_end`);
});
