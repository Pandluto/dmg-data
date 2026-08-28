import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';
import { TEAM_COMBO_BUFF_ID } from '../src/core/combat-runtime.mjs';

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

test('Camille enhanced battle-skill input executes the derived combo skill and grants combo on its real final hit', () => {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{
            memberId: 'camille',
            characterId: 'chr_0033_camille',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 130
        }]
    });
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            commandId: 'camille-ultimate',
            memberId: 'camille',
            commandType: 'UltimateSkill',
            frame: 0
        }, {
            commandId: 'camille-enhanced-skill',
            memberId: 'camille',
            commandType: 'NormalSkill',
            frame: 140
        }],
        endFrame: 250
    });
    const command = result.commandTrace.find(entry => (
        entry.commandId === 'camille-enhanced-skill'
        && entry.type === 'CommandExecuted'
    ));
    const hits = result.damageLog.filter(hit => hit.rootCastId === command?.castId);
    const hpHits = hits.filter(hit => hit.damageAttributeType === 'Hp');
    const combo = result.statusTrace.find(event => (
        event.buffId === TEAM_COMBO_BUFF_ID
        && event.stage === 'StatusEffectApplied'
        && event.rootCastId === command?.castId
    ));
    const fireAttachments = result.statusTrace.filter(event => (
        event.buffId === 'buff_common_energy_shard_attached_fire'
        && event.stage === 'StatusEffectApplied'
        && event.rootCastId === command?.castId
    ));

    assert.equal(command?.commandType, 'NormalSkill');
    assert.equal(command?.skillId, 'chr_0033_camille_normal_skill_2');
    assert.equal(hpHits.length, 4);
    assert.deepEqual([...new Set(hpHits.map(hit => hit.skillId))], [
        'chr_0033_camille_combo_skill_2'
    ]);
    assert.deepEqual([...new Set(hpHits.map(hit => hit.inputCommandType))], [
        'NormalSkill'
    ]);
    assert.deepEqual([...new Set(hpHits.map(hit => hit.effectiveSkillType))], [
        'ComboSkill'
    ]);
    assert.ok(hpHits.every(hit => hit.castId !== command.castId));
    assert.equal(combo?.frame, hpHits.at(-1)?.frame);
    assert.equal(combo?.effectiveSkillType, 'ComboSkill');
    assert.equal(combo?.stackCount, 1);
    assert.equal(
        fireAttachments.length,
        0,
        'the enhanced battle-skill input settles as a combo skill and must not copy the base battle-skill Fire attachment'
    );

    const timeline = projectAkeTimeline(result);
    const settlement = timeline.commands.find(entry => (
        entry.commandId === 'camille-enhanced-skill'
    ));
    assert.equal(settlement?.hitCount, 4);
    assert.deepEqual(settlement?.executedSkillIds, ['chr_0033_camille_combo_skill_2']);
    assert.deepEqual(settlement?.effectiveSkillTypes, ['ComboSkill']);
    assert.ok(timeline.hitBursts.filter(burst => (
        burst.frame >= 160 && burst.frame <= 210
    )).every(burst => burst.castId === command.castId));
});

test('real Wulfa-Camille axis re-resolves a buffered B against the active form', () => {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{
            memberId: 'wulfa',
            characterId: 'chr_0028_wulfa',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 110
        }, {
            memberId: 'camille',
            characterId: 'chr_0033_camille',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 130
        }]
    });
    // This is the shape emitted by the real frontend: it sends input intent
    // and planned frames, but no concrete skillId and no test-only queue flag.
    const commands = [
        ['wulfa-b', 'wulfa', 'NormalSkill', 0],
        ['camille-b', 'camille', 'NormalSkill', 0],
        ['wulfa-e-1', 'wulfa', 'ComboSkill', 94],
        ['wulfa-e-2', 'wulfa', 'ComboSkill', 151],
        ['camille-q', 'camille', 'UltimateSkill', 159],
        ['camille-enhanced-b', 'camille', 'NormalSkill', 292],
        ['wulfa-q', 'wulfa', 'UltimateSkill', 316]
    ].map(([commandId, memberId, commandType, frame]) => ({
        commandId,
        memberId,
        commandType,
        frame
    }));
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands,
        endFrame: 500
    });
    const queued = result.commandTrace.find(entry => (
        entry.commandId === 'camille-enhanced-b'
        && entry.type === 'CommandQueued'
    ));
    const executed = result.commandTrace.find(entry => (
        entry.commandId === 'camille-enhanced-b'
        && entry.type === 'CommandExecuted'
    ));
    const hpHits = result.damageLog.filter(hit => (
        hit.rootCastId === executed?.castId
        && hit.damageAttributeType === 'Hp'
    ));
    const fireAppliedByEnhancedInput = result.statusTrace.filter(event => (
        event.rootCastId === executed?.castId
        && event.buffId === 'buff_common_energy_shard_attached_fire'
        && event.stage === 'StatusEffectApplied'
    ));
    const comboAppliedByEnhancedInput = result.statusTrace.filter(event => (
        event.rootCastId === executed?.castId
        && event.buffId === TEAM_COMBO_BUFF_ID
        && event.stage === 'StatusEffectApplied'
    ));
    const activeNoGuard = result.finalState.statuses.filter(status => (
        status.active
        && status.targetId === 'eny_0007_mimicw'
        && status.buffId === 'buff_physical_no_guard'
    ));

    assert.equal(queued?.frame, 292, 'the input is buffered while the ultimate still owns the action center');
    assert.equal(executed?.frame, 294, 'the buffered input executes at the native allow-next boundary');
    assert.equal(executed?.skillId, 'chr_0033_camille_normal_skill_2');
    assert.equal(executed?.skillSource, 'skill-form-override');
    assert.equal(hpHits.length, 4);
    assert.deepEqual([...new Set(hpHits.map(hit => hit.skillId))], [
        'chr_0033_camille_combo_skill_2'
    ]);
    assert.deepEqual([...new Set(hpHits.map(hit => hit.effectiveSkillType))], [
        'ComboSkill'
    ]);
    assert.equal(fireAppliedByEnhancedInput.length, 0);
    assert.deepEqual(
        [...new Set(comboAppliedByEnhancedInput.map(event => event.targetId))].sort(),
        ['chr_0028_wulfa', 'chr_0033_camille']
    );
    assert.ok(activeNoGuard.length > 0, 'the pre-existing enemy No Guard state survives Camille Q and enhanced B');

    const settlement = projectAkeTimeline(result).commands.find(entry => (
        entry.commandId === 'camille-enhanced-b'
    ));
    assert.equal(settlement?.hitCount, 4);
    assert.deepEqual(settlement?.executedSkillIds, [
        'chr_0033_camille_combo_skill_2'
    ]);
    assert.deepEqual(settlement?.effectiveSkillTypes, ['ComboSkill']);
});
