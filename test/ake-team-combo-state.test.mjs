import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { CombatRuntime, TEAM_COMBO_BUFF_ID } from '../src/core/combat-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
));

function actionTree(actions) {
    return (actions ?? []).flatMap(action => [
        action,
        ...actionTree(action.actions),
        ...actionTree(action.success),
        ...actionTree(action.failure)
    ]);
}

test('real Camille combo stages compile ComboAction and DoOnceAction as shared primitives', () => {
    const compiler = new AkeActionCompiler();
    const first = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0033_camille_combo_skill.json'
    ));
    const second = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0033_camille_combo_skill_2.json'
    ));
    const firstActions = actionTree(first.timeline.flatMap(group => group.actions));
    const secondActions = actionTree(second.timeline.flatMap(group => group.actions));
    const firstGrant = firstActions.find(action => action.type === 'GrantTeamCombo');
    const secondOnce = secondActions.find(action => action.type === 'ExecuteOnce'
        && actionTree(action.actions).some(child => child.type === 'GrantTeamCombo'));

    assert.equal(firstGrant.buffId, TEAM_COMBO_BUFF_ID);
    assert.equal(firstGrant.durationSeconds.blackboardKey, 'combo_duration');
    assert.deepEqual(firstGrant.metadata.consumeBy, ['NormalSkill', 'UltimateSkill']);
    assert.ok(secondOnce, 'the second combo stage must retain its once-only combo grant');
    assert.equal(
        first.compiler.unresolved.some(entry => entry.sourceType === 'ComboAction'),
        false
    );
    assert.equal(
        second.compiler.unresolved.some(entry => ['ComboAction', 'DoOnceAction'].includes(
            entry.sourceType
        )),
        false
    );
});

test('team combo grant triggers the real weapon listener once and consumes atomically', () => {
    const compiler = new AkeActionCompiler();
    const passive = compiler.compilePassiveEventActions(readJson(
        'reference/public-data/akedata/Json/SkillData/sk_wpn_sword_0012.json'
    ), {
        blackboard: { atk_up2: 0.08, duration: 20, lv: 4, max_stack: 2 }
    });
    const attackBuff = compiler.compileBuff(readJson(
        'reference/public-data/akedata/Json/BuffData/buff_wpn_sword_0012_atk_up.json'
    ));
    const comboBuff = compiler.compileBuff(readJson(
        `reference/public-data/akedata/Json/BuffData/${TEAM_COMBO_BUFF_ID}.json`
    ));
    const listener = {
        buffId: 'test:team-combo:weapon-listener',
        lifeType: 'Infinity',
        blackboard: passive.blackboard,
        abilityEventActions: passive.groups
    };
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'camille', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'ally', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [listener.buffId]: listener,
                [attackBuff.buffId]: attackBuff,
                [comboBuff.buffId]: comboBuff
            }
        }
    });
    runtime.execute({
        type: 'ApplyBuff', buffId: listener.buffId, target: 'Source'
    }, {
        frame: 0, sourceId: 'camille', ownerId: 'camille', targetId: 'enemy'
    });
    runtime.execute({
        type: 'GrantTeamCombo',
        sourceRef: 'Source',
        buffId: TEAM_COMBO_BUFF_ID,
        durationSeconds: 15,
        count: 1,
        sourceKey: 'test:camille-combo'
    }, {
        frame: 3,
        sourceId: 'camille',
        ownerId: 'camille',
        targetId: 'enemy',
        castId: 'cast:camille:combo'
    });

    const activeCombo = runtime.statusEffects.list({
        active: true, buffId: TEAM_COMBO_BUFF_ID
    });
    assert.deepEqual(activeCombo.map(instance => [
        instance.targetId,
        instance.stackCount,
        instance.expireFrame,
        instance.metadata.teamComboGrantId
    ]).sort(), [
        ['ally', 1, 453, activeCombo[0].metadata.teamComboGrantId],
        ['camille', 1, 453, activeCombo[0].metadata.teamComboGrantId]
    ]);
    assert.equal(runtime.context.getAttribute('camille', 'Atk'), 108);
    assert.equal(runtime.context.getAttribute('ally', 'Atk'), 108);

    const consumed = runtime.consumeTeamComboState({
        frame: 20,
        consumerId: 'ally',
        targetId: 'enemy',
        commandType: 'NormalSkill',
        skillType: 'NormalSkill',
        skillId: 'ally_normal_skill',
        castId: 'cast:ally:normal'
    });
    assert.equal(consumed.status, 'Consumed');
    assert.deepEqual(consumed.targetIds.sort(), ['ally', 'camille']);
    assert.equal(runtime.statusEffects.list({
        active: true, buffId: TEAM_COMBO_BUFF_ID
    }).length, 0);
    const comboTransitions = runtime.statusEffects.trace.filter(entry => (
        entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.frame === 20
        && entry.stage === 'StatusEffectFinished'
    ));
    assert.equal(comboTransitions.length, 2);
    assert.deepEqual(comboTransitions.filter(entry => entry.consumption).map(entry => (
        [entry.targetId, entry.consumerId, entry.triggerCommandType]
    )), [['ally', 'ally', 'NormalSkill']]);
    assert.equal(runtime.consumeTeamComboState({
        frame: 21,
        consumerId: 'camille',
        commandType: 'UltimateSkill'
    }).status, 'Empty');
});

test('squad runner consumes a shared combo only after another member starts a legal B or Q', () => {
    const compiler = new AkeActionCompiler();
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        members: [
            { memberId: 'pelica', characterId: 'chr_0004_pelica' },
            { memberId: 'chen', characterId: 'chr_0005_chen' }
        ]
    });
    const comboBuff = compiler.compileBuff(readJson(
        `reference/public-data/akedata/Json/BuffData/${TEAM_COMBO_BUFF_ID}.json`
    ));
    bundle.buffs.set(TEAM_COMBO_BUFF_ID, comboBuff);
    bundle.definitions.buffs[TEAM_COMBO_BUFF_ID] = comboBuff;
    const attackId = bundle.membersById.pelica.roles.normalAttackIds[0];
    const attack = structuredClone(bundle.programs.get(attackId));
    attack.timeline.unshift({
        groupIndex: -1,
        startFrame: 0,
        endFrame: 0,
        actions: [{
            type: 'GrantTeamCombo',
            sourceRef: 'Source',
            buffId: TEAM_COMBO_BUFF_ID,
            durationSeconds: 15,
            count: 1,
            sourceKey: 'test:squad-combo'
        }],
        cleanupActions: []
    });
    bundle.programs.set(attackId, attack);

    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            { frame: 0, memberId: 'pelica', commandType: 'Attack' },
            { frame: 120, memberId: 'chen', commandType: 'NormalSkill' }
        ],
        endFrame: 180
    });
    const chenCast = result.commandTrace.find(entry => entry.type === 'CommandExecuted'
        && entry.memberId === 'chen');
    assert.equal(chenCast.commandType, 'NormalSkill');
    const granted = result.statusTrace.filter(entry => entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.stage === 'StatusEffectApplied');
    assert.deepEqual(granted.map(entry => entry.targetId).sort(), [
        'chr_0004_pelica',
        'chr_0005_chen'
    ]);
    const consumed = result.statusTrace.filter(entry => entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.frame === chenCast.frame
        && entry.stage === 'StatusEffectFinished');
    assert.equal(consumed.length, 2);
    assert.deepEqual(consumed.filter(entry => entry.consumption).map(entry => (
        [entry.targetId, entry.consumerId, entry.triggerCommandType]
    )), [['chr_0005_chen', 'chr_0005_chen', 'NormalSkill']]);
});
