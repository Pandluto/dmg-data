import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LocalClock } from '../src/core/local-clock.mjs';
import { PoiseMachine } from '../src/core/poise-machine.mjs';
import { simulateScenario } from '../src/core/simulator.mjs';
import { buildPelicaScenarioModel } from '../src/scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poiseOracle = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-poise-boundaries.oracle.json'
), 'utf8'));
const poiseGuardOracle = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'fixtures',
    'calc',
    'poise-guard-boundaries.oracle.json'
), 'utf8'));

function scheduler() {
    const events = [];
    let sequence = 0;
    return {
        events,
        schedule(frame, priority, run, label) {
            events.push({ frame, priority, run, label, sequence: sequence++ });
        },
        runThrough(frame) {
            while (true) {
                events.sort((left, right) => left.frame - right.frame
                    || left.priority - right.priority
                    || left.sequence - right.sequence);
                const next = events[0];
                if (!next || next.frame > frame) return;
                events.shift();
                next.run();
            }
        }
    };
}

function definition(overrides = {}) {
    return {
        enabled: true,
        maxPoise: 60,
        recoverySeconds: 6,
        executionDamageScalar: 1.5,
        executionAtbGain: 50,
        brokenDamageScale: 1.3,
        breakDamageBuffId: 'break-damage-buff',
        executionGateBuffId: 'execution-gate-buff',
        ...overrides
    };
}

test('poise caps state on overflow but preserves the full reported hit', () => {
    const clock = scheduler();
    const machine = new PoiseMachine({ definition: definition(), schedule: clock.schedule });

    const below = machine.applyDamage({ frame: 10, basePoise: 55 });
    assert.deepEqual(
        [below.before, below.after, below.actualPoiseDamage, below.overflow, below.broke],
        [0, 55, 55, 0, false]
    );
    const crossing = machine.applyDamage({ frame: 20, basePoise: 10 });
    assert.deepEqual(
        [crossing.finalPoiseDamage, crossing.actualPoiseDamage, crossing.overflow, crossing.broke],
        [10, 5, 5, true]
    );
    assert.equal(machine.snapshot().accumulated, 60);
    assert.equal(machine.damageZone().scale, 1.3);

    const whileBroken = machine.applyDamage({ frame: 30, basePoise: 10 });
    assert.deepEqual(
        [whileBroken.finalPoiseDamage, whileBroken.actualPoiseDamage, whileBroken.overflow],
        [10, 0, 10]
    );
});

test('execution gate is consumed once while the broken damage zone remains active', () => {
    const clock = scheduler();
    const machine = new PoiseMachine({ definition: definition(), schedule: clock.schedule });
    machine.applyDamage({ frame: 20, basePoise: 60 });

    assert.equal(machine.canExecute(), true);
    assert.deepEqual(machine.consumeExecution({ frame: 40, sourceSkillId: 'power-attack' }), {
        frame: 40,
        stage: 'ExecutionConsumed',
        sourceSkillId: 'power-attack',
        rootSkillId: null,
        executionDamageScalar: 1.5,
        executionAtbGain: 50,
        executionGateBuffId: 'execution-gate-buff',
        cycle: 1
    });
    assert.equal(machine.consumeExecution({ frame: 41 }), null);
    assert.equal(machine.canExecute(), false);
    assert.equal(machine.damageZone().scale, 1.3);

    clock.runThrough(199);
    assert.equal(machine.snapshot().broken, true);
    clock.runThrough(200);
    assert.deepEqual(machine.snapshot(), {
        enabled: true,
        maxPoise: 60,
        accumulated: 0,
        remaining: 60,
        broken: false,
        executionAvailable: false,
        executionDamageScalar: 1.5,
        executionAtbGain: 50,
        nominalRecoveryFrame: null,
        scheduledRecoveryFrame: null,
        recoveryTicks: 180,
        cycle: 2,
        triggeredKnotIndexes: [],
        firstPoiseDamageLocalFrame: null,
        rapidBreakPolicy: { enabled: false },
        activeGuard: null
    });
});

test('enemy-local timers move by calibrated pauses without moving global events', () => {
    const clock = scheduler();
    const localClock = new LocalClock({ schedule: clock.schedule, name: 'enemy-gameplay' });
    let completionFrame = null;
    const timerId = localClock.startTimer({
        frame: 100,
        durationTicks: 180,
        label: 'poise-recovery',
        onComplete: frame => { completionFrame = frame; }
    });
    localClock.pause({ frame: 120, durationTicks: 7, reason: 'PoiseBreak' });
    localClock.pause({ frame: 200, durationTicks: 4, reason: 'HpDamageWhileBroken' });

    assert.equal(localClock.timer(timerId).deadlineFrame, 291);
    assert.equal(localClock.localFrameAt(200), 189);
    clock.runThrough(290);
    assert.equal(completionFrame, null);
    clock.runThrough(291);
    assert.equal(completionFrame, 291);
});

test('rapid-break guard reproduces current Calc scalar, duration and expiry boundary', () => {
    const clock = scheduler();
    const localClock = new LocalClock({ schedule: clock.schedule, name: 'enemy-gameplay' });
    const machine = new PoiseMachine({
        definition: definition({
            executionDamageScalar: 1,
            executionAtbGain: 25,
            rapidBreakPolicy: {
                enabled: true,
                profileId: 'calc-current.ordinary.rapid-poise-break-guard',
                qualifyingTicks: 48,
                guardDurationTicks: 90,
                minimumTakenScalar: 0.6,
                interpolation: 'linear-to-one',
                lifecycleOffsetTicks: 1,
                buffId: 'buff_common_poise_guard'
            }
        }),
        schedule: clock.schedule,
        localClock
    });

    machine.applyDamage({ frame: 51, basePoise: 25 });
    localClock.pause({ frame: 51, durationTicks: 42, reason: 'UltimateTime' });
    machine.applyDamage({ frame: 93, basePoise: 25 });
    machine.applyDamage({ frame: 93, basePoise: 25 });
    localClock.pause({ frame: 93, durationTicks: 7, reason: 'PoiseBreak' });
    clock.runThrough(280);

    const capturedBaseline = poiseGuardOracle.cases.find(entry =>
        entry.id === 'minimum-scalar-baseline');
    const capturedWindow = capturedBaseline.enemyPoise.guardWindows[0];
    const guard = machine.snapshot().activeGuard;
    assert.deepEqual(
        [guard.startFrame, guard.endFrame, guard.expireFrame],
        [capturedWindow.startFrame, capturedWindow.endFrame, 371]
    );
    assert.ok(Math.abs(guard.takenScalar - capturedWindow.poiseTakenScalar) < 1e-6);

    const inside = machine.applyDamage({ frame: 313, basePoise: 10 });
    assert.ok(Math.abs(inside.finalPoiseDamage - 6) < 1e-9);
    clock.runThrough(370);
    const onExpiryEventFrame = machine.applyDamage({ frame: 371, basePoise: 10 });
    assert.ok(Math.abs(onExpiryEventFrame.finalPoiseDamage - 6) < 1e-9);
    clock.runThrough(371);
    const afterExpiry = machine.applyDamage({ frame: 372, basePoise: 10 });
    assert.equal(afterExpiry.finalPoiseDamage, 10);
});

test('rapid-break scalar interpolates by enemy-local ticks and rejects the threshold', () => {
    function breakWithElapsed(elapsedLocalTicks) {
        const clock = scheduler();
        const localClock = new LocalClock({ schedule: clock.schedule });
        const machine = new PoiseMachine({
            definition: definition({
                rapidBreakPolicy: {
                    enabled: true,
                    qualifyingTicks: 48,
                    guardDurationTicks: 90,
                    minimumTakenScalar: 0.6,
                    interpolation: 'linear-to-one',
                    buffId: 'buff_common_poise_guard'
                }
            }),
            schedule: clock.schedule,
            localClock
        });
        machine.applyDamage({ frame: 100, basePoise: 25 });
        machine.applyDamage({ frame: 100 + elapsedLocalTicks, basePoise: 35 });
        clock.runThrough(100 + elapsedLocalTicks + 180);
        return machine.snapshot().activeGuard;
    }

    const interpolated = breakWithElapsed(16);
    const captured = poiseGuardOracle.cases.find(entry =>
        entry.id === 'interpolated-scalar-third-ultimate-delayed')
        .enemyPoise.guardWindows[0].poiseTakenScalar;
    assert.ok(Math.abs(interpolated.takenScalar - captured) < 1e-6);
    assert.equal(breakWithElapsed(48), null);
});

test('poise knots trigger once per cycle at their template percentages', () => {
    const clock = scheduler();
    const knots = [];
    const machine = new PoiseMachine({
        definition: definition({
            maxPoise: 140,
            recoverySeconds: 9,
            knotPercentages: [0.5],
            knotBuffIds: ['buff_common_mini_poise_break'],
            knotDurationTicksByBuffId: { buff_common_mini_poise_break: 75 }
        }),
        schedule: clock.schedule,
        onKnot: knot => knots.push(knot)
    });

    machine.applyDamage({ frame: 10, basePoise: 65 });
    machine.applyDamage({ frame: 20, basePoise: 15, sourceSkillId: 'heavy-hit' });
    machine.applyDamage({ frame: 30, basePoise: 10 });
    assert.equal(knots.length, 1);
    assert.deepEqual(
        [knots[0].frame, knots[0].threshold, knots[0].buffId, knots[0].durationTicks],
        [20, 70, 'buff_common_mini_poise_break', 75]
    );
});

function runOracleCase(oracleCase) {
    const model = buildPelicaScenarioModel({
        enemyId: oracleCase.enemy.id,
        commands: oracleCase.commands,
        combatSetting: {
            simulatePoise: oracleCase.combatSetting.simulatePoise,
            actionIdleExitFightFrames: 500
        }
    });
    return { model, result: simulateScenario(model) };
}

test('all captured Pelica poise hits and execution command gates match Calc', async context => {
    for (const oracleCase of poiseOracle.cases) {
        await context.test(oracleCase.id, () => {
            const { result } = runOracleCase(oracleCase);
            assert.deepEqual(
                result.damageLog
                    .filter(hit => hit.damageAttributeType === 'Poise')
                    .map(hit => [hit.frame, hit.skillId, hit.poiseDamage]),
                oracleCase.damageLog
                    .filter(hit => hit.poiseDamage > 0)
                    .map(hit => [hit.frame, hit.skillId, hit.poiseDamage])
            );
            assert.deepEqual(
                result.commandTrace
                    .filter(trace => trace.type === 'CommandExecuted'
                        && trace.commandType === 'BreakingAttack')
                    .map(trace => [trace.frame, trace.skillId, trace.success]),
                oracleCase.commandTrace
                    .filter(trace => trace.commandType === 'BreakingAttack')
                    .map(trace => [trace.frame, trace.skillId, trace.success])
            );
        });
    }
});

test('captured exact, overflow, knot, broken damage and execution outcomes are reproduced', () => {
    const exact = runOracleCase(poiseOracle.cases.find(entry =>
        entry.id === 'exact-threshold-breaks')).result;
    assert.equal(exact.poiseTrace.find(entry => entry.stage === 'Broken').frame, 426);

    const overflow = runOracleCase(poiseOracle.cases.find(entry =>
        entry.id === 'overflow-threshold-breaks')).result;
    const overflowHit = overflow.damageLog.find(hit =>
        hit.damageAttributeType === 'Poise' && hit.frame === 293);
    assert.deepEqual(
        [overflowHit.poiseDamage, overflowHit.actualPoiseDamage, overflowHit.poiseOverflow],
        [10, 5, 5]
    );

    const knot = runOracleCase(poiseOracle.cases.find(entry =>
        entry.id === 'half-knot-applies-mini-break')).result;
    const knotEvent = knot.poiseTrace.find(entry => entry.stage === 'KnotTriggered');
    assert.deepEqual(
        [knotEvent.frame, knotEvent.threshold, knotEvent.buffId, knotEvent.durationTicks],
        [426, 70, 'buff_common_mini_poise_break', 75]
    );

    const broken = runOracleCase(poiseOracle.cases.find(entry =>
        entry.id === 'broken-target-damage-scale')).result;
    const brokenHit = broken.damageLog.find(hit => hit.frame === 463
        && hit.damageAttributeType === 'Hp');
    assert.equal(brokenHit.modifierSnapshot.defenderZoneScale, 1.3);
    assert.equal(brokenHit.finalDamage, 97.01560700000002);

    const execution = runOracleCase(poiseOracle.cases.find(entry =>
        entry.id === 'execution-consumes-gate-and-refunds-atb')).result;
    const executionHit = execution.damageLog.find(hit => hit.frame === 485);
    assert.deepEqual(
        [executionHit.rawDamage, executionHit.finalDamage],
        [335.404, 218.0126]
    );
    const executionGain = execution.resourceTrace.find(entry =>
        entry.reason === 'BreakingAttack');
    assert.deepEqual(
        [executionGain.frame, executionGain.requestedDelta, executionGain.actualDelta],
        [485, 25, 25]
    );
});

test('recovery trace matches all captured presentation-pause wall frames', () => {
    const expectedRecoveryFrames = {
        'exact-threshold-breaks': 613,
        'overflow-threshold-breaks': 484,
        'broken-target-damage-scale': 617,
        'execution-consumes-gate-and-refunds-atb': 620
    };
    for (const [id, expectedRecoveryFrame] of Object.entries(expectedRecoveryFrames)) {
        const oracleCase = poiseOracle.cases.find(entry => entry.id === id);
        const { result } = runOracleCase(oracleCase);
        const broken = result.poiseTrace.find(entry => entry.stage === 'Broken');
        const observedRecovery = oracleCase.poiseEvents.find(entry =>
            entry.eventName === 'OnPoiseRecover').frame;
        const recovered = result.poiseTrace.find(entry => entry.stage === 'Recovered');
        assert.equal(broken.nominalRecoveryFrame, broken.frame + oracleCase.enemy.poiseRecTime * 30);
        assert.equal(observedRecovery, expectedRecoveryFrame);
        assert.equal(recovered.frame, observedRecovery);
        assert.equal(
            broken.recoveryTimingModel,
            'nominal-gameplay-ticks-excludes-presentation-pauses'
        );
    }
});
