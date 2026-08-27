import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ComboTriggerMachine } from '../src/core/combo-trigger-machine.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const NO_GUARD = 'buff_physical_no_guard';
const FIRE_ATTACHMENT = 'buff_common_energy_shard_attached_fire';
const PULSE_ATTACHMENT = 'buff_common_energy_shard_attached_pulse';
const WULFA = 'chr_0028_wulfa';
const WULFA_COMBO = 'chr_0028_wulfa_combo_2_skill';

const semanticMappings = JSON.parse(readFileSync(new URL(
    '../spec/engine-semantic-mappings.json',
    import.meta.url
), 'utf8')).mappings;
const wulfaRules = semanticMappings.filter(mapping =>
    mapping.actionType === 'ComboTriggerRule'
    && mapping.effect?.ownerId === WULFA
);

function harness() {
    const comboTrace = [];
    let machine = null;
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: WULFA,
                kind: 'Character',
                team: 'ally'
            }, {
                id: 'source',
                kind: 'Character',
                team: 'ally'
            }, {
                id: 'enemy',
                kind: 'Enemy',
                team: 'enemy'
            }],
            buffs: {
                [NO_GUARD]: { stackingPolicy: 'Refresh', durationTicks: 600 },
                [FIRE_ATTACHMENT]: { stackingPolicy: 'Refresh', durationTicks: 600 },
                [PULSE_ATTACHMENT]: { stackingPolicy: 'Refresh', durationTicks: 600 }
            }
        },
        onStatusTransition: transition => machine?.observe({
            eventType: transition.stage,
            frame: transition.frame,
            buffId: transition.buffId,
            sourceId: transition.sourceId,
            sourceSkillId: transition.sourceSkillId,
            rootSkillId: transition.rootSkillId,
            rootSkillRoles: [],
            sourceCommandType: transition.commandType,
            sourceCastId: transition.castId,
            targetId: transition.targetId,
            damageAttributeType: null
        })
    });
    machine = new ComboTriggerMachine({
        rules: wulfaRules,
        schedule: runtime.schedule,
        trace: comboTrace,
        getCooldownEnd: () => 0,
        evaluateCondition: (condition, eventContext) =>
            runtime.effects.evaluate(condition, eventContext)
    });
    const apply = (buffId, frame, castId) => runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId
    }, {
        frame,
        sourceId: 'source',
        ownerId: 'source',
        targetId: 'enemy',
        skillId: `skill:${castId}`,
        rootSkillId: `skill:${castId}`,
        castId,
        commandType: 'NormalSkill'
    });
    return { runtime, machine, comboTrace, apply };
}

test('compound combo conditions are evaluated against the committed runtime status snapshot', () => {
    assert.equal(wulfaRules.length, 2, 'both state-transition orders are data rules');
    const { machine, comboTrace, apply } = harness();

    apply(FIRE_ATTACHMENT, 1, 'attachment-first');
    assert.equal(machine.snapshot(1).length, 0,
        'an attachment alone does not create Rossi pending');
    assert.equal(comboTrace.at(-1).reason, 'CONDITION_FAILED');

    apply(NO_GUARD, 2, 'no-guard-second');
    const pending = machine.snapshot(2);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ruleId, 'wulfa.no-guard-with-spell-infliction');
    assert.equal(pending[0].ownerId, WULFA);
    assert.equal(pending[0].skillId, WULFA_COMBO);
    assert.equal(machine.gate({
        frame: 2,
        skillId: WULFA_COMBO,
        ownerId: WULFA,
        targetId: 'enemy'
    }).ready, true);
});

test('compound combo rules are symmetric and include AKE refresh transitions', () => {
    const { machine, apply } = harness();

    apply(NO_GUARD, 1, 'no-guard-first');
    assert.equal(machine.snapshot(1).length, 0);
    apply(PULSE_ATTACHMENT, 2, 'attachment-second');
    assert.equal(machine.snapshot(2)[0].ruleId, 'wulfa.spell-infliction-with-no-guard');
    assert.equal(machine.snapshot(2)[0].createdFrame, 2);

    apply(PULSE_ATTACHMENT, 3, 'attachment-refresh');
    const refreshed = machine.snapshot(3);
    assert.equal(refreshed.length, 1, 'replace-all retains one pending slot');
    assert.equal(refreshed[0].createdFrame, 3,
        'StatusEffectRefreshed reopens the declarative simultaneous-state window');
});

test('conditional rules fail closed when no shared condition evaluator is installed', () => {
    const machine = new ComboTriggerMachine({ rules: wulfaRules });
    const decisions = machine.observe({
        eventType: 'StatusEffectApplied',
        frame: 1,
        buffId: NO_GUARD,
        sourceId: 'source',
        sourceSkillId: 'skill',
        rootSkillId: 'skill',
        sourceCastId: 'cast',
        targetId: 'enemy',
        damageAttributeType: null
    });
    assert.equal(decisions[0].reason, 'CONDITION_EVALUATOR_MISSING');
    assert.equal(machine.snapshot(1).length, 0);
});
