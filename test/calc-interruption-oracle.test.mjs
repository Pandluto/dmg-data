import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const oracleUrl = new URL(
    '../fixtures/calc/ake-interruption-probe.oracle.json',
    import.meta.url
);
const oracleBytes = readFileSync(oracleUrl);
const oracle = JSON.parse(oracleBytes);
const manifest = JSON.parse(readFileSync(new URL(
    '../fixtures/calc/ake-interruption-probe.manifest.json',
    import.meta.url
)));

function observation(id) {
    const result = oracle.observations.find(entry => entry.id === id);
    assert.ok(result, `Missing interruption observation ${id}`);
    return result;
}

function attack1Frames(id) {
    return observation(id).damageLog
        .filter(entry => entry.skillId.startsWith('chr_0006_wolfgd_attack1'))
        .map(entry => entry.frame);
}

function close(actual, expected, message, epsilon = 1e-10) {
    assert.ok(Math.abs(Number(actual) - Number(expected)) <= epsilon,
        `${message}: ${actual} != ${expected}`);
}

test('interruption oracle is complete and its manifest hashes the frozen evidence', () => {
    assert.equal(oracle.calcDataVersion, '9163343-11');
    assert.equal(oracle.observations.length, 43);
    assert.equal(manifest.files[0].sha256,
        crypto.createHash('sha256').update(oracleBytes).digest('hex'));
});

test('Calc executes old timeline damage before a same-frame Ultimate interrupt', () => {
    assert.deepEqual(observation('normal-to-ultimate-5').normalSkillDamageFrames, []);
    assert.deepEqual(observation('normal-to-ultimate-6').normalSkillDamageFrames, [6]);
    assert.deepEqual(observation('normal-to-ultimate-16').normalSkillDamageFrames, [6, 16]);
    assert.deepEqual(observation('normal-to-ultimate-23').normalSkillDamageFrames, [6, 16, 23]);
});

test('Calc queue expiry is strict and MarkCanInterrupt opens at frame 48', () => {
    const expired = observation('normal-to-attack-18').commandTrace;
    assert.deepEqual(expired.map(entry => [entry.$type, entry.frame]), [
        ['CommandExecutedTrace', 0],
        ['CommandQueuedTrace', 18],
        ['CommandExpiredTrace', 48]
    ]);
    const accepted = observation('normal-to-attack-19').commandTrace;
    assert.deepEqual(accepted.map(entry => [entry.$type, entry.frame]), [
        ['CommandExecutedTrace', 0],
        ['CommandQueuedTrace', 19],
        ['CommandExecutedTrace', 48]
    ]);
});

test('local admission audit explains the priority block and frame-48 retry', () => {
    const bundle = new AkeScenarioAssembler().assemble({
        characterId: oracle.characterId,
        weaponId: 'wpn_pistol_0001',
        enemyId: 'eny_0007_mimicw'
    });
    const result = new AkeScenarioRunner(bundle).run({
        commands: observation('normal-to-attack-30').commands,
        endFrame: 80
    });
    assert.deepEqual(result.commandAdmissionTrace.map(entry => ({
        frame: entry.frame,
        accepted: entry.accepted,
        reason: entry.reason,
        currentPriority: entry.currentPriority,
        newPriority: entry.newPriority,
        nextTimelineFrame: entry.nextTimelineFrame
    })), [
        {
            frame: 0,
            accepted: true,
            reason: 'NO_ACTIVE_SKILL',
            currentPriority: null,
            newPriority: 2,
            nextTimelineFrame: undefined
        },
        {
            frame: 30,
            accepted: false,
            reason: 'PRIORITY_BLOCK',
            currentPriority: 2,
            newPriority: 0,
            nextTimelineFrame: 48
        },
        {
            frame: 48,
            accepted: true,
            reason: 'CURRENT_CAN_BE_INTERRUPTED',
            currentPriority: 2,
            newPriority: 0,
            nextTimelineFrame: undefined
        }
    ]);
});

test('element state selects Wulfgard enhanced JumpToAction branch and consumes burning', () => {
    const enhanced = observation('ultimate-to-normal-47');
    const plus = enhanced.damageLog.find(entry =>
        entry.skillId === 'chr_0006_wolfgd_normal_skill_plus_projhit'
    );
    assert.deepEqual({
        frame: plus.frame,
        rawDamage: plus.rawDamage,
        finalDamage: plus.finalDamage
    }, {
        frame: 131,
        rawDamage: 310.78404,
        finalDamage: 155.39202
    });
    assert.ok(enhanced.burningEvents.some(entry =>
        entry.frame === 131 && entry.event === 'OnFinishedBuff'
    ));
});

test('in-flight attack projectiles cancel before hit while burning survives interruption', () => {
    assert.deepEqual(attack1Frames('attack-to-ultimate-6'), []);
    assert.deepEqual(attack1Frames('attack-to-ultimate-7'), [7]);
    assert.deepEqual(attack1Frames('attack-to-ultimate-13'), [7]);
    assert.deepEqual(attack1Frames('attack-to-ultimate-14'), [7, 14]);
    assert.deepEqual(observation('ultimate-to-attack-76').burningDamageFrames, [
        76, 106, 136, 166, 196, 226, 256, 286, 316, 346
    ]);
});

test('local runtime reproduces all 43 Calc interruption observations packet by packet', () => {
    const bundle = new AkeScenarioAssembler().assemble({
        characterId: oracle.characterId,
        weaponId: 'wpn_pistol_0001',
        enemyId: 'eny_0007_mimicw'
    });
    for (const expected of oracle.observations) {
        const actual = new AkeScenarioRunner(bundle).run({
            commands: expected.commands,
            endFrame: expected.durationTicks
        });
        assert.deepEqual(actual.commandTrace
            .filter(entry => entry.type === 'CommandExecuted' && entry.success)
            .map(entry => ({
                frame: entry.frame,
                commandType: entry.commandType,
                skillId: entry.skillId
            })), expected.commandTrace
            .filter(entry => entry.$type === 'CommandExecutedTrace' && entry.success)
            .map(entry => ({
                frame: entry.frame,
                commandType: entry.commandType,
                skillId: entry.skillId
            })), `${expected.id}: command execution mismatch`);

        const packets = actual.damageLog.filter(entry =>
            entry.damageAttributeType === 'Hp'
        );
        assert.equal(packets.length, expected.damageLog.length,
            `${expected.id}: damage packet count`);
        packets.forEach((packet, index) => {
            const target = expected.damageLog[index];
            assert.deepEqual({
                frame: packet.frame,
                skillId: packet.skillId,
                damageType: packet.damageType
            }, {
                frame: target.frame,
                skillId: target.skillId,
                damageType: target.damageType
            }, `${expected.id}: packet ${index} identity`);
            close(packet.rawDamage, target.rawDamage,
                `${expected.id}: packet ${index} raw damage`);
            close(packet.finalDamage, target.finalDamage,
                `${expected.id}: packet ${index} final damage`);
        });
        close(actual.damageSummary.totalDamage, expected.totalDamage,
            `${expected.id}: total damage`);
    }
});
