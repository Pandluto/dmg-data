import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ComboTriggerMachine } from '../src/core/combo-trigger-machine.mjs';
import { simulateScenario } from '../src/core/simulator.mjs';
import { buildPelicaScenarioModel } from '../src/scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boundaryOracle = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-combo-boundaries.oracle.json'
), 'utf8'));

function compactComboTrace(trace) {
    return trace.map(entry => {
        const compact = {
            frame: entry.frame,
            stage: entry.stage,
            result: entry.result,
            reason: entry.reason
        };
        if (entry.pendingRemainingFrames !== undefined
            && entry.pendingRemainingFrames !== null) {
            compact.pendingRemainingFrames = entry.pendingRemainingFrames;
        }
        return compact;
    });
}

test('Pelica combo boundaries match all captured Calc black-box cases', async testContext => {
    for (const oracleCase of boundaryOracle.cases) {
        await testContext.test(oracleCase.id, () => {
            const model = buildPelicaScenarioModel();
            model.commands = oracleCase.commands.map(command => ({ ...command }));
            const result = simulateScenario(model);
            assert.deepEqual(
                compactComboTrace(result.comboSkillTrace),
                compactComboTrace(oracleCase.comboSkillTrace)
            );
        });
    }
});

test('the trigger source is data-driven instead of hard-coded to Pelica attack4', () => {
    const model = buildPelicaScenarioModel();
    const rule = model.semanticRules.comboTriggerRules[0];
    rule.selector.rootSkillIds = [model.roles.normalAttackIds[2]];
    delete rule.selector.sourceSkillIds;
    model.commands = [
        { frame: 0, commandType: 'Attack' },
        { frame: 15, commandType: 'Attack' },
        { frame: 30, commandType: 'Attack' },
        { frame: 50, commandType: 'ComboSkill' }
    ];

    const result = simulateScenario(model);
    const created = result.comboSkillTrace.find(trace => trace.stage === 'PENDING_CREATED');
    const gate = result.comboSkillTrace.find(trace => trace.stage === 'COMMAND_GATE');
    assert.equal(created.frame, 49);
    assert.equal(created.currentSkillId, model.roles.normalAttackIds[2]);
    assert.equal(gate.frame, 50);
    assert.equal(gate.result, true);
});

test('target-bound pending entries do not cross enemies and can be consumed independently', () => {
    const trace = [];
    const machine = new ComboTriggerMachine({
        trace,
        rules: [{
            id: 'test.multi-target',
            eventType: 'BeforeHpDamage',
            selector: {
                rootSkillIds: ['root-skill'],
                damageAttributeType: 'Hp',
                occurrence: 'first-per-cast-target'
            },
            effect: {
                comboSkillId: 'combo-skill',
                pendingDurationTicks: 30,
                ownerBinding: 'event-source',
                triggerTargetBinding: 'event-target',
                pendingPolicy: 'append',
                selectionPolicy: 'newest',
                consumePolicy: 'selected'
            }
        }]
    });
    const baseEvent = {
        eventType: 'BeforeHpDamage',
        frame: 10,
        sourceId: 'character',
        sourceSkillId: 'projectile',
        rootSkillId: 'root-skill',
        sourceCastId: 1,
        damageAttributeType: 'Hp'
    };

    machine.observe({ ...baseEvent, targetId: 'enemy-a' });
    machine.observe({ ...baseEvent, targetId: 'enemy-b' });
    const duplicate = machine.observe({ ...baseEvent, frame: 11, targetId: 'enemy-a' });
    assert.equal(duplicate[0].reason, 'OCCURRENCE_ALREADY_SEEN');

    const gateA = machine.gate({
        frame: 12,
        skillId: 'combo-skill',
        ownerId: 'character',
        targetId: 'enemy-a'
    });
    assert.equal(gateA.ready, true);
    assert.equal(gateA.pending.triggerTargetId, 'enemy-a');
    machine.consume({
        frame: 12,
        pendingId: gateA.pending.id,
        currentSkillId: 'combo-skill'
    });

    assert.deepEqual(machine.snapshot().map(pending => pending.triggerTargetId), ['enemy-b']);
    assert.equal(machine.gate({
        frame: 13,
        skillId: 'combo-skill',
        ownerId: 'character',
        targetId: 'enemy-a'
    }).ready, false);
    assert.equal(machine.gate({
        frame: 13,
        skillId: 'combo-skill',
        ownerId: 'character',
        targetId: 'enemy-b'
    }).ready, true);
});

test('semantic selectors can open a fixed operator combo from another operator event', () => {
    const machine = new ComboTriggerMachine({
        rules: [{
            id: 'test.pelica.any-controlled-heavy',
            eventType: 'BeforeHpDamage',
            selector: {
                rootSkillIds: [],
                rootSkillRole: 'heavy-attack',
                damageAttributeType: 'Hp',
                occurrence: 'first-per-cast-target'
            },
            effect: {
                comboSkillId: 'pelica-combo',
                pendingDurationTicks: 180,
                ownerBinding: 'fixed',
                ownerId: 'pelica',
                triggerTargetBinding: 'event-target',
                pendingPolicy: 'replace-all',
                selectionPolicy: 'newest',
                consumePolicy: 'all-for-owner-and-skill'
            }
        }]
    });

    machine.observe({
        eventType: 'BeforeHpDamage',
        frame: 42,
        sourceId: 'zhuang-fangyi',
        sourceSkillId: 'zhuang-heavy-hit',
        rootSkillId: 'zhuang-attack-final',
        rootSkillRoles: ['heavy-attack'],
        sourceCommandType: 'Attack',
        sourceCastId: 1,
        targetId: 'enemy',
        damageAttributeType: 'Hp'
    });

    assert.equal(machine.gate({
        frame: 48,
        skillId: 'pelica-combo',
        ownerId: 'pelica',
        targetId: 'enemy'
    }).ready, true);
    assert.equal(machine.gate({
        frame: 48,
        skillId: 'pelica-combo',
        ownerId: 'zhuang-fangyi',
        targetId: 'enemy'
    }).ready, false);
});

test('status transitions and other-operator combo hits use the same generic pending machine', () => {
    const machine = new ComboTriggerMachine({
        rules: [{
            id: 'test.chen.no-guard',
            eventType: 'StatusEffectApplied',
            selector: {
                rootSkillIds: [],
                statusBuffIds: ['buff_physical_no_guard'],
                occurrence: 'first-per-cast-target'
            },
            effect: {
                comboSkillId: 'chen-combo',
                pendingDurationTicks: 180,
                ownerBinding: 'fixed',
                ownerId: 'chen',
                triggerTargetBinding: 'event-target',
                pendingPolicy: 'replace-all',
                selectionPolicy: 'newest',
                consumePolicy: 'all-for-owner-and-skill'
            }
        }, {
            id: 'test.admin.other-combo-hit',
            eventType: 'BeforeHpDamage',
            selector: {
                rootSkillIds: [],
                sourceCommandTypes: ['ComboSkill'],
                requireSourceOtherThanOwner: true,
                damageAttributeType: 'Hp',
                occurrence: 'first-per-cast-target'
            },
            effect: {
                comboSkillId: 'admin-combo',
                pendingDurationTicks: 180,
                ownerBinding: 'fixed',
                ownerId: 'admin',
                triggerTargetBinding: 'event-target',
                pendingPolicy: 'replace-all',
                selectionPolicy: 'newest',
                consumePolicy: 'all-for-owner-and-skill'
            }
        }]
    });

    machine.observe({
        eventType: 'StatusEffectApplied',
        frame: 13,
        sourceId: 'chen',
        sourceSkillId: 'chen-normal-hit',
        rootSkillId: 'chen-normal',
        sourceCommandType: 'NormalSkill',
        sourceCastId: 1,
        targetId: 'enemy',
        buffId: 'buff_physical_no_guard',
        damageAttributeType: null
    });
    assert.equal(machine.gate({
        frame: 191,
        skillId: 'chen-combo',
        ownerId: 'chen',
        targetId: 'enemy'
    }).ready, true);
    assert.equal(machine.gate({
        frame: 192,
        skillId: 'chen-combo',
        ownerId: 'chen',
        targetId: 'enemy'
    }).ready, false);

    const ignored = machine.observe({
        eventType: 'BeforeHpDamage',
        frame: 200,
        sourceId: 'admin',
        sourceSkillId: 'admin-combo-hit',
        rootSkillId: 'admin-combo',
        sourceCommandType: 'ComboSkill',
        sourceCastId: 2,
        targetId: 'enemy',
        damageAttributeType: 'Hp'
    });
    assert.equal(ignored[0].reason, 'SOURCE_IS_PENDING_OWNER');
    assert.equal(machine.gate({
        frame: 201,
        skillId: 'admin-combo',
        ownerId: 'admin',
        targetId: 'enemy'
    }).ready, false);

    machine.observe({
        eventType: 'BeforeHpDamage',
        frame: 210,
        sourceId: 'chen',
        sourceSkillId: 'chen-combo-hit',
        rootSkillId: 'chen-combo',
        sourceCommandType: 'ComboSkill',
        sourceCastId: 3,
        targetId: 'enemy',
        damageAttributeType: 'Hp'
    });
    assert.equal(machine.gate({
        frame: 211,
        skillId: 'admin-combo',
        ownerId: 'admin',
        targetId: 'enemy'
    }).ready, true);
});

test('owner-scoped pause leases freeze combo expiry with strict resume boundaries', () => {
    const machine = new ComboTriggerMachine({
        rules: [{
            id: 'test.pause-window',
            eventType: 'BeforeHpDamage',
            selector: {
                rootSkillIds: ['trigger-skill'],
                damageAttributeType: 'Hp',
                occurrence: 'first-per-cast-target'
            },
            effect: {
                comboSkillId: 'combo-skill',
                pendingDurationTicks: 30,
                ownerBinding: 'event-source',
                triggerTargetBinding: 'event-target',
                pendingPolicy: 'replace-all',
                selectionPolicy: 'newest',
                consumePolicy: 'selected'
            }
        }]
    });
    machine.observe({
        eventType: 'BeforeHpDamage',
        frame: 10,
        sourceId: 'actor',
        sourceSkillId: 'trigger-hit',
        rootSkillId: 'trigger-skill',
        sourceCastId: 'trigger-cast',
        targetId: 'enemy',
        damageAttributeType: 'Hp'
    });

    machine.pause({
        frame: 20,
        ownerId: 'actor',
        leaseId: 'heavy-action:1',
        castId: 'heavy-cast'
    });
    const paused = machine.snapshot(45)[0];
    assert.equal(paused.paused, true);
    assert.equal(paused.remainingFrames, 19,
        'wall time does not consume the frozen right-open combo window');

    machine.resume({ frame: 50, leaseId: 'heavy-action:1' });
    assert.equal(machine.gate({
        frame: 68,
        skillId: 'combo-skill',
        ownerId: 'actor',
        targetId: 'enemy'
    }).ready, true);
    assert.equal(machine.gate({
        frame: 69,
        skillId: 'combo-skill',
        ownerId: 'actor',
        targetId: 'enemy'
    }).ready, false, 'the resumed end frame remains a strict expiry boundary');
});

test('simulator contains no character-specific combo trigger branch', () => {
    const implementation = fs.readFileSync(
        path.join(projectRoot, 'src', 'core', 'simulator.mjs'),
        'utf8'
    );
    assert.equal(implementation.includes('semanticRules.comboTrigger.sourceSkillId'), false);
    assert.equal(implementation.includes('chr_0004_pelica_attack4'), false);
    assert.equal(/\b(?:let|const)\s+pendingCombo\b/.test(implementation), false);
});
