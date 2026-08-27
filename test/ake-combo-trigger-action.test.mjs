import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    AkeActionCompiler,
    classifyAkeActionType
} from '../src/core/ake-action-compiler.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { ComboTriggerMachine } from '../src/core/combo-trigger-machine.mjs';

const WULFA = 'chr_0028_wulfa';
const COMBO_2 = 'chr_0028_wulfa_combo_2_skill';
const COMBO_3 = 'chr_0028_wulfa_combo_3_skill';
const ENEMY = 'eny_0007_mimicw';

function readJson(relativePath) {
    return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

function collectActions(value, type, result = []) {
    if (value === null || typeof value !== 'object') return result;
    if (value.type === type) result.push(value);
    for (const child of Object.values(value)) collectActions(child, type, result);
    return result;
}

test('TriggerComboSkillAction compiles to one generic pending operation', () => {
    assert.deepEqual(classifyAkeActionType('TriggerComboSkillAction'), {
        category: 'logic',
        disposition: 'compiler'
    });
    const compiler = new AkeActionCompiler({
        semanticMappings: readJson('spec/engine-semantic-mappings.json')
    });
    const skill = compiler.compileSkill(readJson(
        `reference/public-data/akedata/Json/SkillData/${COMBO_2}.json`
    ));
    const actions = collectActions(skill, 'TriggerComboPending');

    assert.equal(actions.length, 2, 'both public target branches use the same operation');
    assert.ok(actions.every(action => (
        action.skillSlot === 'ComboSkill'
        && action.pendingDurationTicks === 180
        && action.bypassSkillCooldown === true
        && action.pendingPolicy === 'replace-all'
    )));
    assert.equal(skill.compiler.unresolved.some(entry =>
        entry.actionType === 'TriggerComboSkillAction'
    ), false);
});

test('ShowComboRingQte compiles the AKE warning and precise intervals as a timed input window', () => {
    assert.deepEqual(classifyAkeActionType('ShowComboRingQte'), {
        category: 'logic',
        disposition: 'compiler'
    });
    const compiler = new AkeActionCompiler({
        semanticMappings: readJson('spec/engine-semantic-mappings.json')
    });
    const definition = compiler.compileBuff(readJson(
        'reference/public-data/akedata/Json/BuffData/'
        + 'buff_chr_0028_wulfa_combo_2_qte_timerlistening.json'
    ));
    const windows = collectActions(definition, 'RegisterTimedInputWindow');

    assert.equal(windows.length, 1);
    assert.deepEqual({
        inputTypes: windows[0].inputTypes,
        earlyDurationTicks: windows[0].nominalEarlyDurationTicks,
        activeDurationTicks: windows[0].nominalActiveDurationTicks,
        boundary: windows[0].boundary
    }, {
        inputTypes: ['ComboSkill'],
        earlyDurationTicks: 15,
        activeDurationTicks: 15,
        boundary: 'start-inclusive-end-exclusive'
    });
    assert.ok(windows[0].triggeredActions.some(action => (
        action.type === 'ModifyEntityBlackboard'
        && action.key === 'EntityBB_Combo_QTE_Trigger'
    )));
    assert.equal(definition.compiler.unresolved.some(entry => (
        entry.actionType === 'ShowComboRingQte'
    )), false);
});

test('action-created combo pending owns its gate and can admit a chained stage', () => {
    const trace = [];
    const machine = new ComboTriggerMachine({
        trace,
        getCooldownEnd: () => 999
    });

    assert.equal(machine.isManagedSkill({ ownerId: WULFA, skillId: COMBO_3 }), false);
    const activated = machine.trigger({
        frame: 37,
        ownerId: WULFA,
        targetId: ENEMY,
        skillId: COMBO_3,
        ruleId: 'fixture:chain-stage',
        pendingDurationTicks: 180,
        bypassSkillCooldown: true,
        pendingPolicy: 'replace-all',
        selectionPolicy: 'newest',
        consumePolicy: 'selected'
    });
    assert.equal(activated.status, 'created');
    assert.equal(machine.isManagedSkill({ ownerId: WULFA, skillId: COMBO_3 }), true);

    const gate = machine.gate({
        frame: 38,
        ownerId: WULFA,
        targetId: ENEMY,
        skillId: COMBO_3,
        cooldownEnd: 999
    });
    assert.equal(gate.ready, true, 'the chained stage bypasses the original group cooldown');
    assert.equal(gate.pending.bypassSkillCooldown, true);
    machine.consume({ frame: 38, pendingId: gate.pending.id, currentSkillId: COMBO_3 });
    assert.equal(machine.snapshot(38).length, 0);
    assert.deepEqual(trace.map(entry => entry.stage), [
        'PENDING_CREATED',
        'COMMAND_GATE',
        'PENDING_CONSUMED'
    ]);
});

test('real Wulfa combo 2 changes the slot and opens combo 3 without clearing cooldown', () => {
    const assembled = new AkeSquadScenarioAssembler().assemble({
        enemyId: ENEMY,
        members: [{ memberId: 'wulfa', characterId: WULFA }],
        initialAtb: 300
    });
    // The first stage prerequisite has separate compound-condition contracts.
    // Seed that stage explicitly here so this test isolates the exported
    // ChangeSkillAction -> TriggerComboSkillAction lifecycle.
    const bundle = {
        ...assembled,
        semanticMappings: assembled.semanticMappings.filter(mapping =>
            mapping.actionType !== 'ComboTriggerRule'
        )
    };
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            memberId: 'wulfa',
            frame: 0,
            commandType: 'ComboSkill',
            skillId: COMBO_2,
            commandId: 'wulfa-combo-2'
        }, {
            memberId: 'wulfa',
            frame: 38,
            commandType: 'ComboSkill',
            commandId: 'wulfa-combo-3'
        }],
        endFrame: 100
    });
    const executed = result.commandTrace.filter(entry =>
        entry.type === 'CommandExecuted'
    );

    assert.deepEqual(executed.map(entry => [
        entry.commandId,
        entry.frame,
        entry.skillId,
        entry.success
    ]), [
        ['wulfa-combo-2', 0, COMBO_2, true],
        ['wulfa-combo-3', 38, COMBO_3, true]
    ]);
    assert.ok(result.comboTrace.some(entry =>
        entry.stage === 'PENDING_CREATED'
        && entry.frame === 37
        && entry.skillId === COMBO_3
        && entry.sourceActionType === 'TriggerComboSkillAction'
        && entry.bypassSkillCooldown === true
    ));
    assert.ok(result.comboTrace.some(entry =>
        entry.stage === 'PENDING_CONSUMED'
        && entry.frame === 38
        && entry.skillId === COMBO_3
    ));
    assert.ok(result.statusTrace.some(entry =>
        entry.stage === 'AbilityEventHandled'
        && entry.frame === 38
        && entry.buffId === 'buff_chr_0028_wulfa_combo_usetimer'
        && entry.eventType === 'OnRemoveAllPendingComboSkill'
    ), 'consuming the final pending dispatches the raw use-timer listener');
    assert.deepEqual(result.cooldownTrace.filter(entry =>
        entry.stage === 'Started'
    ).map(entry => entry.skillId), [COMBO_2],
    'the first-stage group cooldown remains authoritative after the chained stage');
    assert.ok(result.cooldownTrace[0].endFrame > 38);
});

test('real Wulfa chained combo remains legal outside precision but only resolves QTE in its subwindow', () => {
    const assembled = new AkeSquadScenarioAssembler().assemble({
        enemyId: ENEMY,
        members: [{ memberId: 'wulfa', characterId: WULFA }],
        initialAtb: 300
    });
    const bundle = {
        ...assembled,
        semanticMappings: assembled.semanticMappings.filter(mapping =>
            mapping.actionType !== 'ComboTriggerRule'
        )
    };
    const runAt = frame => new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            memberId: 'wulfa',
            frame: 0,
            commandType: 'ComboSkill',
            skillId: COMBO_2,
            commandId: 'wulfa-combo-2'
        }, {
            memberId: 'wulfa',
            frame,
            commandType: 'ComboSkill',
            commandId: 'wulfa-combo-3'
        }],
        endFrame: 100
    });

    const early = runAt(38);
    const precise = runAt(53);
    assert.equal(early.commandTrace.find(entry => (
        entry.commandId === 'wulfa-combo-3'
        && entry.type === 'CommandExecuted'
    ))?.success, true, 'the broad chained-stage window remains legal before precision');
    assert.equal(early.timedInputWindows[0].resolvedFrame, null);
    assert.equal(precise.commandTrace.find(entry => (
        entry.commandId === 'wulfa-combo-3'
        && entry.type === 'CommandExecuted'
    ))?.success, true);
    assert.equal(precise.timedInputWindows[0].resolvedFrame, 53);
    assert.equal(precise.timedInputWindows[0].resolvedCommandId, 'wulfa-combo-3');
});

test('real Wulfa use-timer ends when its final chained pending times out', () => {
    const assembled = new AkeSquadScenarioAssembler().assemble({
        enemyId: ENEMY,
        members: [{ memberId: 'wulfa', characterId: WULFA }],
        initialAtb: 300
    });
    const bundle = {
        ...assembled,
        semanticMappings: assembled.semanticMappings.filter(mapping =>
            mapping.actionType !== 'ComboTriggerRule'
        )
    };
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            memberId: 'wulfa',
            frame: 0,
            commandType: 'ComboSkill',
            skillId: COMBO_2,
            commandId: 'wulfa-combo-2'
        }],
        endFrame: 220
    });
    const useTimerTrace = result.statusTrace.filter(entry =>
        entry.buffId === 'buff_chr_0028_wulfa_combo_usetimer'
    );

    assert.ok(result.comboTrace.some(entry =>
        entry.stage === 'PENDING_EXPIRED'
        && entry.frame === 216
        && entry.skillId === COMBO_3
    ));
    assert.ok(useTimerTrace.some(entry =>
        entry.stage === 'StatusEffectFinished'
        && entry.frame === 216
        && entry.reason === 'FinishBuffAdvanced'
    ), 'the pending edge finishes the six-second timer before its frame-217 expiry');
    assert.ok(useTimerTrace.some(entry =>
        entry.stage === 'AbilityEventHandled'
        && entry.frame === 216
        && entry.eventType === 'OnRemoveAllPendingComboSkill'
    ));
});
