import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const oracle = JSON.parse(readFileSync(new URL(
    '../fixtures/calc/ake-cross-character-smoke.oracle.json',
    import.meta.url
), 'utf8'));

function close(actual, expected, epsilon = 1e-10) {
    assert.ok(Math.abs(actual - expected) <= epsilon,
        `${actual} differs from ${expected} by more than ${epsilon}`);
}

function assemble(testCase) {
    return new AkeScenarioAssembler().assemble({
        characterId: testCase.characterId,
        weaponId: testCase.weaponId,
        enemyId: oracle.enemyId
    });
}

test('cross-character panels derive each operator Ultimate SP cap without Pelica constants', () => {
    for (const testCase of oracle.cases) {
        const bundle = assemble(testCase);
        const ultimatePool = bundle.definitions.resources.find(pool =>
            pool.resourceType === 'UltimateSp'
        );
        close(bundle.parameters.characterAttributes.Atk, testCase.panel.Atk);
        close(bundle.parameters.characterAttributes.MaxUltimateSp,
            testCase.panel.MaxUltimateSp);
        close(ultimatePool.initial, testCase.panel.MaxUltimateSp);
        close(ultimatePool.max, testCase.panel.MaxUltimateSp);
    }
});

for (const testCase of oracle.cases) {
    test(`${testCase.id} matches frozen Calc command frames and every damage packet`, () => {
        const bundle = assemble(testCase);
        const result = new AkeScenarioRunner(bundle).run({
            commands: testCase.commands,
            // Use Calc's recorded horizon so this test covers the complete
            // periodic tail independently of the still-separate fight-exit
            // heuristic.
            endFrame: testCase.durationTicks
        });

        assert.deepEqual(result.commandTrace
            .filter(entry => entry.type === 'CommandExecuted' && entry.success)
            .map(entry => ({
                frame: entry.frame,
                commandType: entry.commandType,
                skillId: entry.skillId,
                success: entry.success
            })), testCase.commandTrace.map(entry => ({
            frame: entry.frame,
            commandType: entry.commandType,
            skillId: entry.skillId,
            success: entry.success
        })));

        const localHits = result.damageLog.filter(hit => hit.damageAttributeType === 'Hp');
        assert.equal(localHits.length, testCase.damageLog.length);
        localHits.forEach((hit, index) => {
            const expected = testCase.damageLog[index];
            assert.deepEqual({
                frame: hit.frame,
                skillId: hit.skillId,
                damageType: hit.damageType
            }, {
                frame: expected.frame,
                skillId: expected.skillId,
                damageType: expected.damageType
            });
            close(hit.rawDamage, expected.rawDamage);
            close(hit.finalDamage, expected.finalDamage);
        });
        close(result.damageSummary.totalDamage, testCase.damageSummary.totalDamage);

        const ultimateCommand = testCase.commandTrace.find(entry =>
            entry.commandType === 'UltimateSkill' && entry.success
        );
        assert.ok(result.clockTrace.some(entry =>
            entry.stage === 'ClockPaused'
            && entry.frame === ultimateCommand.frame
            && entry.durationTicks === 1
            && entry.reason === 'TimeDilationAction:RESETto1'
        ));

        if (testCase.characterId === 'chr_0005_chen') {
            const attack5 = bundle.programs.get('chr_0005_chen_attack5');
            assert.ok(attack5.timeline.flatMap(group => group.metadata).some(entry =>
                entry.type === 'ResolvedChannelingMode'
                && entry.mode === 'ImmediateOncePerExplicitTarget'
            ));
        }
        if (testCase.characterId === 'chr_0006_wolfgd') {
            assert.deepEqual(result.statusTrace
                .filter(entry => entry.buffId === 'buff_common_burning_status'
                    && entry.stage === 'StatusEffectTriggered')
                .map(entry => entry.frame), [
                326, 356, 386, 416, 446, 476, 506, 536, 566, 596
            ]);
        }
    });
}
