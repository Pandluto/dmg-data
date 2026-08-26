import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';

const oracle = JSON.parse(readFileSync(new URL(
    '../fixtures/calc/squad-resource-boundaries.oracle.json',
    import.meta.url
), 'utf8'));

const explicitWeapons = Object.freeze({
    chr_0014_aurora: 'wpn_claym_0010',
    chr_0035_liino: 'wpn_lance_0009'
});

function compactCommand(entry) {
    return {
        frame: entry.frame,
        commandType: entry.commandType,
        casterCharId: entry.characterId ?? entry.casterCharId,
        skillId: entry.skillId,
        success: entry.success
    };
}

test('shared resource runtime matches all frozen Calc squad boundary oracles', () => {
    for (const testCase of oracle.cases) {
        const members = testCase.squad.map(member => ({
            memberId: member.uuid,
            characterId: member.characterId,
            ...(explicitWeapons[member.characterId]
                ? { weaponId: explicitWeapons[member.characterId] }
                : {}),
            ...(testCase.combatSetting.startWithFullUsp
                ? {}
                : { initialUltimateSp: 0 })
        }));
        const bundle = new AkeSquadScenarioAssembler().assemble({
            enemyId: 'eny_0007_mimicw',
            initialAtb: testCase.combatSetting.initialAtb,
            members
        });
        const result = new AkeSquadScenarioRunner(bundle).run({
            commands: testCase.commands,
            endFrame: testCase.durationTicks
        });
        const expectedCommands = testCase.commandTrace
            .filter(entry => entry.$type === 'CommandExecutedTrace')
            .map(entry => compactCommand({
                ...entry,
                characterId: entry.casterCharId
            }));
        const actualCommands = result.commandTrace
            .filter(entry => entry.type === 'CommandExecuted')
            .map(compactCommand);
        assert.deepEqual(actualCommands, expectedCommands, `${testCase.id}: commands`);

        const finalSnapshot = testCase.snapshots.at(-1);
        assert.equal(result.finalState.sharedAtb.current, finalSnapshot[1],
            `${testCase.id}: ATB`);
        assert.equal(result.finalState.sharedAtb.returned, finalSnapshot[2],
            `${testCase.id}: returned ATB`);
        testCase.squad.forEach((member, index) => {
            assert.equal(
                result.finalState.ultimateSpByCharacterId[member.characterId],
                finalSnapshot[3 + index],
                `${testCase.id}: ${member.characterId} USP`
            );
        });
        assert.equal(result.diagnostics.unresolvedEffectCount, 0,
            `${testCase.id}: unresolved runtime effects`);
    }
});
