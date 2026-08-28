import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
));
const skill = skillId => readJson(
    `reference/public-data/akedata/Json/SkillData/${skillId}.json`
);
const buff = buffId => readJson(
    `reference/public-data/akedata/Json/BuffData/${buffId}.json`
);

function actionTree(actions) {
    return (actions ?? []).flatMap(action => [
        action,
        ...actionTree(action.actions),
        ...actionTree(action.success),
        ...actionTree(action.failure)
    ]);
}

test('non-empty switchToBuffConfig compiles as a conditional cast-start Buff action', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { skillProgramResolver: true }
    });
    const program = compiler.compileSkill(skill('chr_0033_camille_normal_skill_2'));
    const actions = actionTree(program.castStartActions);
    const condition = actions.find(action => action.type === 'IfElseAction')?.conditions?.[0];
    const apply = actions.find(action => action.type === 'ApplyBuff');

    assert.equal(program.effectiveSkillType, 'NormalSkill');
    assert.deepEqual(condition, {
        type: 'BuffStackCompare',
        target: 'Owner',
        buffIds: ['buff_chr_0033_camille_ult_henshin_state'],
        tagIds: [],
        tagQueryType: 'HasAny',
        countType: 'BuffCount',
        operator: 'GE',
        value: {
            useBlackboardKey: false,
            value: 1,
            blackboardKey: ''
        }
    });
    assert.equal(apply?.buffs?.[0]?.buffId, 'buff_chr_0033_camille_cast_combo2');
    assert.equal(apply?.metadata?.asSkillCast, false);
    assert.equal(program.compiler.unresolved.length, 0);
});

test('CastSkill compiles to a generic derived launch with separate caster and target', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { skillProgramResolver: true }
    });
    const definition = compiler.compileBuff(buff('buff_chr_0033_camille_cast_combo2'));
    const launch = actionTree(definition.enableActions).find(action => (
        action.type === 'LaunchSkillProgram' && action.launchKind === 'CastSkill'
    ));

    assert.equal(launch?.childSkillId, 'chr_0033_camille_combo_skill_2');
    assert.equal(launch?.casterRef, 'Owner');
    assert.deepEqual(launch?.targetRef, { type: 'EventTarget', fallback: 'Target' });
    assert.equal(launch?.skipApplyCost, false);
    assert.equal(launch?.inheritSourceSkillCastId, false);
    assert.equal(definition.compiler.unresolved.some(entry => (
        entry.sourceType === 'CastSkill'
    )), false);
});

test('the same CastSkill compiler route covers Liino without an operator branch', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { skillProgramResolver: true }
    });
    const definition = compiler.compileBuff(buff('buff_chr_0035_liino_comboskill_castskill'));
    const launch = actionTree(definition.enableActions).find(action => (
        action.type === 'LaunchSkillProgram' && action.launchKind === 'CastSkill'
    ));

    assert.equal(launch?.childSkillId, 'chr_0035_liino_normal_skill_combonext');
    assert.equal(launch?.casterRef, 'Source');
    assert.equal(launch?.targetRef, 'Source');
    assert.equal(launch?.skipApplyCost, true);
    assert.equal(launch?.inheritSourceSkillCastId, false);
});
