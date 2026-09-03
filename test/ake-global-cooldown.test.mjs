import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const AKE_JSON_URL = new URL(
    '../reference/public-data/akedata/Json/',
    import.meta.url
);

function findActions(root, expectedType) {
    const result = [];
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(visit);
        if (String(value.$type ?? '').includes(`${expectedType}+Data`)) result.push(value);
        Object.values(value).forEach(visit);
    };
    visit(root);
    return result;
}

function loadJson(relativePath) {
    return JSON.parse(readFileSync(new URL(relativePath, AKE_JSON_URL), 'utf8'));
}

test('all public AKE global-cooldown gates compile to entity-scoped timed markers', () => {
    const compiler = new AkeActionCompiler();
    const checks = [];
    const starts = [];
    for (const directory of ['SkillData', 'BuffData']) {
        const directoryUrl = new URL(`${directory}/`, AKE_JSON_URL);
        for (const fileName of readdirSync(directoryUrl).filter(name => name.endsWith('.json'))) {
            const raw = JSON.parse(readFileSync(new URL(fileName, directoryUrl), 'utf8'));
            checks.push(...findActions(raw, 'CheckGlobalCDTimerAction').map(action =>
                compiler.compileCondition(action, {
                    path: `${directory}/${fileName}:CheckGlobalCDTimerAction`
                })));
            starts.push(...findActions(raw, 'AddGlobalCDTimer').map(action =>
                compiler.compileAction(action, {
                    path: `${directory}/${fileName}:AddGlobalCDTimer`
                })));
        }
    }

    assert.equal(checks.length, 15);
    assert.equal(starts.length, 15);
    assert.equal(checks.every(result =>
        result.unresolved.length === 0
        && result.condition.type === 'TimedMarkerExists'
        && result.condition.returnTrueIfNotExists === true
        && result.condition.markerId.startsWith('ake-global-cd:')
    ), true);
    assert.equal(starts.every(result =>
        result.unresolved.length === 0
        && result.actions.length === 1
        && result.actions[0].type === 'CreateTimedMarker'
        && result.actions[0].useTimeDilationDt === false
        && result.actions[0].markerId.startsWith('ake-global-cd:')
    ), true);
});

test('real skill and equipment ICD data share strict entity-and-bucket semantics', () => {
    const compiler = new AkeActionCompiler();
    const mifu = loadJson('SkillData/chr_0031_mifu_combo_skill.json');
    const equipment = loadJson('BuffData/buff_equipsuit_physuit_01.json');
    const mifuCheck = compiler.compileCondition(
        findActions(mifu, 'CheckGlobalCDTimerAction')[0],
        { path: 'mifu.combo.global-cd.check' }
    ).condition;
    const mifuStart = compiler.compileAction(
        findActions(mifu, 'AddGlobalCDTimer')[0],
        { path: 'mifu.combo.global-cd.start' }
    ).actions;
    const equipmentStart = compiler.compileAction(
        findActions(equipment, 'AddGlobalCDTimer')[0],
        { path: 'physuit.global-cd.start' }
    ).actions;
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor-a', kind: 'Character', team: 'ally' },
                { id: 'actor-b', kind: 'Character', team: 'ally' }
            ]
        }
    });
    const context = (ownerId, frame, blackboard = {}) => ({
        frame,
        sourceId: ownerId,
        ownerId,
        targetId: ownerId,
        blackboard
    });

    assert.equal(runtime.effects.evaluate(
        mifuCheck,
        context('actor-a', 0, { talent_shield_cd: 2 })
    ), true, 'the first proc is ready');
    runtime.effects.executeTransaction(
        mifuStart,
        context('actor-a', 0, { talent_shield_cd: 2 })
    );
    assert.equal(runtime.effects.evaluate(mifuCheck, context('actor-a', 0)), false,
        'the timer blocks immediately in its starting frame');
    assert.equal(runtime.effects.evaluate(mifuCheck, context('actor-b', 0)), true,
        'the same serialized bucket is isolated by target entity');
    assert.equal(runtime.effects.evaluate(mifuCheck, context('actor-a', 59)), false);
    assert.equal(runtime.effects.evaluate(mifuCheck, context('actor-a', 60)), true,
        'the end frame is a strict ready boundary');

    runtime.effects.executeTransaction(
        equipmentStart,
        context('actor-b', 90, { duration: 15 })
    );
    const equipmentMarker = runtime.snapshot().timedMarkers.find(marker =>
        marker.targetId === 'actor-b'
        && marker.markerId === 'ake-global-cd:buff_equipsuit_physuit_01'
    );
    assert.equal(equipmentMarker.expiresFrame, 540,
        'BuffData blackboard seconds use the same global-time marker primitive');
});
