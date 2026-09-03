import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';

test('a missing upstream child SkillData remains diagnostic without aborting its root skill', () => {
    const characterId = 'chr_0034_typhoea';
    const rootSkillId = 'chr_0034_typhoea_attack5';
    const missingChildSkillId = 'chr_0034_typhoea_attack5_02_projhit';
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        enemyMaxHp: 1_000_000_000,
        initialAtb: 300,
        members: [{
            memberId: characterId,
            characterId,
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 130
        }]
    });
    bundle.members[0].roles.normalAttackIds = [rootSkillId];

    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            commandId: 'missing-child-probe',
            memberId: characterId,
            commandType: 'Attack',
            frame: 0
        }],
        endFrame: 180
    });

    assert.ok(result.commandTrace.some(entry => (
        entry.commandId === 'missing-child-probe'
        && entry.type === 'CommandExecuted'
        && entry.success === true
    )));
    assert.ok(result.diagnostics.unresolvedEffects.some(entry => (
        entry.result?.reason === 'SkillProgramNotFound'
        && entry.result?.childSkillId === missingChildSkillId
    )));
});
