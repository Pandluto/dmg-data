import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { ComboTriggerMachine } from '../src/core/combo-trigger-machine.mjs';

const WULFA_POWER_ATTACK_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/chr_0028_wulfa_power_attack.json',
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

function makeMachine() {
    return new ComboTriggerMachine({
        rules: [{
            id: 'test.real-ake-pause-adapter',
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
}

function openWindow(machine, frame, castId) {
    machine.observe({
        eventType: 'BeforeHpDamage',
        frame,
        sourceId: 'wulfa',
        sourceSkillId: 'trigger-hit',
        rootSkillId: 'trigger-skill',
        sourceCastId: castId,
        targetId: 'enemy',
        damageAttributeType: 'Hp'
    });
}

test('real AKE PauseComboSkillTime compiles as a timeline-owned pause lease', () => {
    const raw = JSON.parse(readFileSync(WULFA_POWER_ATTACK_URL, 'utf8'));
    const actions = findActions(raw, 'PauseComboSkillTime');
    assert.equal(actions.length, 1, 'the public AKE corpus has one concrete shape');

    const compiled = new AkeActionCompiler().compileAction(actions[0], {
        path: 'wulfa.power-attack.pause-combo',
        scope: 'skill',
        timelineStartFrame: 0,
        timelineEndFrame: 65
    });
    assert.equal(compiled.unresolved.length, 0);
    assert.deepEqual(compiled.actions.map(action => ({
        type: action.type,
        target: action.target,
        isAll: action.isAll,
        isPaused: action.isPaused
    })), [{
        type: 'SetComboPendingTimePaused',
        target: 'Owner',
        isAll: false,
        isPaused: true
    }]);
    assert.equal(compiled.cleanupActions.length, 1);
    assert.equal(compiled.cleanupActions[0].isPaused, false);
    assert.equal(compiled.cleanupActions[0].leaseKey, compiled.actions[0].leaseKey);
});

test('compiled pause action freezes pending time and cast end releases interrupted leases', () => {
    const raw = JSON.parse(readFileSync(WULFA_POWER_ATTACK_URL, 'utf8'));
    const compiled = new AkeActionCompiler().compileAction(
        findActions(raw, 'PauseComboSkillTime')[0],
        {
            path: 'wulfa.power-attack.pause-combo',
            scope: 'skill',
            timelineStartFrame: 0,
            timelineEndFrame: 65
        }
    );
    const machine = makeMachine();
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'wulfa', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ]
        },
        comboPendingTimeResolver: request => machine.resolveTimeControl(request)
    });
    const context = (frame, castId) => ({
        frame,
        sourceId: 'wulfa',
        ownerId: 'wulfa',
        targetId: 'enemy',
        skillId: 'chr_0028_wulfa_power_attack',
        rootSkillId: 'chr_0028_wulfa_power_attack',
        castId
    });

    openWindow(machine, 0, 'trigger-cast-1');
    runtime.execute(compiled.actions, context(10, 'heavy-cast-1'));
    assert.equal(machine.snapshot(35)[0].remainingFrames, 19);
    runtime.execute(compiled.cleanupActions, context(40, 'heavy-cast-1'));
    assert.equal(machine.gate({
        frame: 58,
        skillId: 'combo-skill',
        ownerId: 'wulfa',
        targetId: 'enemy'
    }).ready, true);
    assert.equal(machine.gate({
        frame: 59,
        skillId: 'combo-skill',
        ownerId: 'wulfa',
        targetId: 'enemy'
    }).ready, false);

    openWindow(machine, 100, 'trigger-cast-2');
    runtime.execute(compiled.actions, context(110, 'heavy-cast-2'));
    runtime.finishSkillActionLifetimes({
        frame: 120,
        actorId: 'wulfa',
        skillId: 'chr_0028_wulfa_power_attack',
        castId: 'heavy-cast-2',
        reason: 'SkillInterrupted'
    }, context(120, 'heavy-cast-2'));
    assert.equal(machine.snapshot(120)[0].paused, false,
        'skill termination releases the lease even if the group cleanup was cancelled');
    assert.equal(machine.gate({
        frame: 138,
        skillId: 'combo-skill',
        ownerId: 'wulfa',
        targetId: 'enemy'
    }).ready, true);
    assert.equal(machine.gate({
        frame: 139,
        skillId: 'combo-skill',
        ownerId: 'wulfa',
        targetId: 'enemy'
    }).ready, false);
});
