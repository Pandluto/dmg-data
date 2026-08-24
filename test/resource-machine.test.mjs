import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { simulateScenario } from '../src/core/simulator.mjs';
import { buildPelicaScenarioModel } from '../src/scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceOracle = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-resource-boundaries.oracle.json'
), 'utf8'));

function compactResourceEvent(event) {
    return {
        frame: event.frame,
        resourceType: event.resourceType,
        kind: event.kind,
        requestedDelta: event.requestedDelta,
        actualDelta: event.actualDelta,
        before: event.before,
        after: event.after
    };
}

function compactCommand(trace) {
    return {
        frame: trace.frame,
        commandType: trace.commandType,
        skillId: trace.skillId,
        success: trace.success
    };
}

function runCase(oracleCase) {
    const model = buildPelicaScenarioModel();
    model.commands = oracleCase.commands.map(command => ({ ...command }));
    model.character.initialAtb = oracleCase.combatSetting.initialAtb;
    model.character.initialUltimateSp = oracleCase.combatSetting.startWithFullUsp
        ? model.character.maxUltimateSp
        : 0;
    return { model, result: simulateScenario(model) };
}

test('all captured ATB and USP boundary events match Calc exactly', async testContext => {
    for (const oracleCase of resourceOracle.cases) {
        await testContext.test(oracleCase.id, () => {
            const { result } = runCase(oracleCase);
            const actualEvents = result.resourceTrace
                .filter(event => event.kind !== 'Initialize')
                .map(compactResourceEvent);
            const expectedEvents = oracleCase.resourceEvents
                .filter(event => event.kind !== 'Initialize')
                .map(compactResourceEvent);
            assert.deepEqual(actualEvents, expectedEvents);

            assert.deepEqual(
                result.commandTrace
                    .filter(trace => trace.type === 'CommandExecuted')
                    .map(compactCommand),
                oracleCase.commandTrace.map(compactCommand)
            );

            const finalSnapshot = oracleCase.snapshots.at(-1);
            assert.equal(result.finalState.resources.Atb, finalSnapshot[1]);
            assert.equal(result.finalState.resources.UltimateSp, finalSnapshot[3]);
        });
    }
});

test('raw public data closes Pelica ultimate cost, timing and damage', () => {
    const oracleCase = resourceOracle.cases.find(candidate =>
        candidate.id === 'ultimate-from-full-usp'
    );
    const { model, result } = runCase(oracleCase);
    const ultimate = model.skills.get(model.roles.ultimateSkillId);

    assert.equal(model.roles.ultimateSkillId, 'chr_0004_pelica_ultimate_skill');
    assert.equal(ultimate.costType, 'UltimateSp');
    assert.equal(ultimate.costValue, 80);
    assert.equal(ultimate.cooldownTicks, 300);
    assert.equal(ultimate.blackboard.atk_scale, 4.45);
    assert.equal(ultimate.damages[0].startFrame, 58);
    assert.deepEqual(
        result.damageLog.map(hit => [hit.frame, hit.rawDamage, hit.finalDamage]),
        oracleCase.damageLog.map(hit => [hit.frame, hit.rawDamage, hit.finalDamage])
    );
});

test('normal-skill USP gain is parsed from BuffData instead of embedded in the simulator', () => {
    const model = buildPelicaScenarioModel();
    const obtainUsp = model.buffs.get('buff_common_obtain_ultimate_sp');
    assert.deepEqual(
        obtainUsp.startActions.map(action => action.type),
        ['ObtainUspInNormalSkill']
    );
    assert.equal(obtainUsp.blackboard.usp_everyone, 6.5);
    assert.equal(obtainUsp.blackboard.usp_self, 0);
    assert.equal(obtainUsp.blackboard.ratio, 1);

    const simulator = fs.readFileSync(
        path.join(projectRoot, 'src', 'core', 'simulator.mjs'),
        'utf8'
    );
    assert.equal(simulator.includes('6.499999761581421'), false);
    assert.equal(simulator.includes('fixtures/calc'), false);
});
