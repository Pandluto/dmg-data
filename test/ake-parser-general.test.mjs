import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseBuff, parseSkill } from '../src/core/ake-parser.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(...parts) {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, ...parts), 'utf8'));
}

function rawBuff(buffId) {
    return readJson(
        'reference', 'public-data', 'akedata', 'Json', 'BuffData', `${buffId}.json`
    );
}

test('general parser retains healing, reaction and resilience buff actions', () => {
    const healing = parseBuff(rawBuff('buff_common_heal_moss_1'));
    assert.deepEqual(
        healing.eventActions.map(group => [
            group.eventType,
            group.actions.filter(action => action.type === 'HealAction').length
        ]),
        [['OnBuffStart', 2], ['OnBuffTrigger', 1]]
    );
    assert.deepEqual(
        healing.eventActions[0].actions[0],
        {
            type: 'HealAction',
            healType: 'Normal',
            healer: 'ActionSource',
            targetSource: 'Target',
            calculationType: 'DefiniteValueCalculation',
            value: { useBlackboardKey: true, value: 0, blackboardKey: 'value' },
            applyScale: false,
            valueScale: { useBlackboardKey: false, value: 0, blackboardKey: '' },
            showHealText: true
        }
    );

    const pulse = parseBuff(rawBuff('buff_common_pulse_pulse_triggered'));
    assert.equal(
        pulse.eventActions.flatMap(group => group.actions)
            .find(action => action.type === 'TriggerSpellBurstEventAction')
            .spellBurstType,
        'Pulse'
    );

    const resilience = parseBuff(rawBuff('buff_common_resilience_decrease'));
    const modifier = resilience.eventActions.flatMap(group => group.actions)
        .find(action => action.type === 'ModifyResilienceDecreaseFactor');
    assert.deepEqual(
        modifier.resilienceDecreaseFactor,
        { useBlackboardKey: false, value: 0, blackboardKey: '' }
    );
});

test('general parser retains skill super-armor windows', () => {
    const skillId = 'chr_0004_pelica_attack1';
    const raw = readJson(
        'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
    );
    const patches = readJson(
        'reference', 'public-data', 'akedata', 'TableCfg', 'SkillPatchTable.json'
    );
    const parsed = parseSkill(raw, patches[skillId], { level: 1 });
    assert.deepEqual(
        parsed.superArmorActions.map(action => [
            action.startFrame,
            action.endFrame,
            action.targetSource,
            action.superArmorValue.value,
            action.impactResistance.value
        ]),
        [[0, 15, 'Source', 15, 100]]
    );
});
