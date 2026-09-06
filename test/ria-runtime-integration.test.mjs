import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { RiaArchive } from '../src/ria/archive.mjs';
import { createFixtureWorkerExecutor, recordFixtureRun, replayArchivedRun, startFixtureRunExecution } from '../src/ria/execute.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function investigationArchive(t) {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ake-ria-runtime-'));
    t.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
    const archive = await new RiaArchive({
        projectRoot,
        archiveRoot,
        syncEveryRecords: 128
    }).initialize();
    await archive.createCase({ caseId: 'case-runtime', title: 'Runtime integration' });
    await archive.createSession({
        caseId: 'case-runtime',
        sessionId: 'session-runtime',
        summary: 'runtime fact sink integration'
    });
    return archive;
}

test('enabling, disabling or failing the runtime trace sink does not change calculation output', () => {
    const bundle = new AkeSquadScenarioAssembler({ projectRoot }).assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{ memberId: 'pelica', characterId: 'chr_0004_pelica' }]
    });
    const runOptions = {
        commands: [{
            commandId: 'pelica-b',
            memberId: 'pelica',
            commandType: 'NormalSkill',
            frame: 0
        }],
        endFrame: 120
    };
    const baseline = new AkeSquadScenarioRunner(bundle).run(runOptions);
    const observedFacts = [];
    const observed = new AkeSquadScenarioRunner(bundle, {
        traceSink: packet => observedFacts.push(packet)
    }).run(runOptions);
    const failing = new AkeSquadScenarioRunner(bundle, {
        traceSink: () => { throw new Error('recording unavailable'); }
    }).run(runOptions);

    assert.deepEqual(observed, baseline);
    assert.deepEqual(failing, baseline);
    assert.ok(observedFacts.length > 100);
    assert.ok(observedFacts.some(packet => packet.source === 'effect'));
    assert.ok(observedFacts.some(packet => packet.source === 'resource'));
    assert.ok(observedFacts.some(packet => packet.fact.rootCastId));
});

test('an archived real run preserves derived child casts and cross-actor facts, then replays deterministically', async t => {
    const archive = await investigationArchive(t);
    const fixture = {
        schemaVersion: 1,
        adapter: 'ake-squad-demo',
        input: {
            enemyId: 'eny_0007_mimicw',
            initialAtb: 300,
            members: [{
                memberId: 'camille',
                characterId: 'chr_0033_camille',
                level: 90,
                skillLevel: 12,
                initialUltimateSp: 130
            }, {
                memberId: 'chen',
                characterId: 'chr_0005_chen'
            }],
            commands: [{
                commandId: 'camille-ultimate',
                memberId: 'camille',
                commandType: 'UltimateSkill',
                frame: 0
            }, {
                commandId: 'camille-enhanced-b',
                memberId: 'camille',
                commandType: 'NormalSkill',
                frame: 140
            }, {
                commandId: 'chen-attack',
                memberId: 'chen',
                commandType: 'Attack',
                frame: 140
            }, {
                commandId: 'chen-consume-b',
                memberId: 'chen',
                commandType: 'NormalSkill',
                frame: 220
            }],
            endFrame: 360
        }
    };
    const recorded = await recordFixtureRun({
        archive,
        caseId: 'case-runtime',
        sessionId: 'session-runtime',
        runId: 'run-derived-source',
        fixture,
        config: { explicitRecording: true }
    });
    assert.equal(recorded.manifest.status, 'completed');
    assert.ok(recorded.manifest.counts.events > 500);
    assert.equal((await archive.verifyRun(recorded.runId)).ok, true);

    const events = await archive.readRunArtifact(recorded.runId, 'events');
    const derivedHit = events.find(event => (
        event.eventType === 'DamageHit'
        && event.actorId === 'chr_0033_camille'
        && event.rootCastId !== null
        && event.childCastId !== null
        && event.childCastId === event.castId
        && event.childCastId !== event.rootCastId
        && event.inputCommandType === 'NormalSkill'
        && event.effectiveSkillType === 'ComboSkill'
    ));
    assert.ok(derivedHit, 'RIA must preserve the real root/derived-child cast lineage');
    assert.ok(derivedHit.damage.factors.length > 0);
    assert.ok(Object.prototype.hasOwnProperty.call(derivedHit.damage, 'consumedStatuses'));
    assert.ok(events.some(event => event.actorId === 'chr_0005_chen'));
    assert.ok(events.some(event => (
        event.source.stream === 'settled.command-projection'
        && event.actorId === 'chr_0033_camille'
    )));

    const crossSourceConsume = events.filter(event => (
        event.frame === 220
        && event.eventType === 'StatusEffectFinished'
        && event.data?.reason === 'TeamComboConsumedByEffectiveSkill'
        && event.triggerActorId === 'chr_0005_chen'
    ));
    assert.equal(crossSourceConsume.length, 2);
    for (const event of crossSourceConsume) {
        assert.deepEqual({
            primaryIdentityRole: event.primaryIdentityRole,
            actorId: event.actorId,
            executedSkillId: event.executedSkillId,
            effectiveSkillType: event.effectiveSkillType,
            rootCastId: event.rootCastId,
            originActorId: event.originActorId,
            originExecutedSkillId: event.originExecutedSkillId,
            originEffectiveSkillType: event.originEffectiveSkillType,
            originRootCastId: event.originRootCastId,
            triggerActorId: event.triggerActorId,
            triggerExecutedSkillId: event.triggerExecutedSkillId,
            triggerEffectiveSkillType: event.triggerEffectiveSkillType,
            triggerRootCastId: event.triggerRootCastId
        }, {
            primaryIdentityRole: 'trigger',
            actorId: 'chr_0005_chen',
            executedSkillId: 'chr_0005_chen_normal_skill',
            effectiveSkillType: 'NormalSkill',
            rootCastId: 'command-cast:chen:2',
            originActorId: 'chr_0033_camille',
            originExecutedSkillId: 'chr_0033_camille_combo_skill_2',
            originEffectiveSkillType: 'ComboSkill',
            originRootCastId: 'command-cast:camille:2',
            triggerActorId: 'chr_0005_chen',
            triggerExecutedSkillId: 'chr_0005_chen_normal_skill',
            triggerEffectiveSkillType: 'NormalSkill',
            triggerRootCastId: 'command-cast:chen:2'
        });
    }
    assert.equal(events.some(event => (
        event.rootCastId === 'command-cast:camille:2'
        && event.actorId === 'chr_0005_chen'
    )), false, 'Chen must never overwrite Camille root-cast state');
    assert.equal(events.some(event => (
        event.rootCastId === 'command-cast:chen:2'
        && event.actorId === 'chr_0033_camille'
    )), false, 'Camille must never overwrite Chen root-cast state');

    const frame220 = await archive.stateAtFrame(recorded.runId, 220);
    assert.equal(frame220.proof.exact, true);
    assert.deepEqual({
        rootCastId: frame220.state.casts['command-cast:camille:2'].rootCastId,
        actorId: frame220.state.casts['command-cast:camille:2'].actorId,
        executedSkillId: frame220.state.casts['command-cast:camille:2'].executedSkillId,
        effectiveSkillType: frame220.state.casts['command-cast:camille:2'].effectiveSkillType
    }, {
        rootCastId: 'command-cast:camille:2',
        actorId: 'chr_0033_camille',
        executedSkillId: 'chr_0033_camille_combo_skill_2',
        effectiveSkillType: 'ComboSkill'
    });
    assert.deepEqual({
        rootCastId: frame220.state.casts['command-cast:chen:2'].rootCastId,
        actorId: frame220.state.casts['command-cast:chen:2'].actorId,
        executedSkillId: frame220.state.casts['command-cast:chen:2'].executedSkillId,
        effectiveSkillType: frame220.state.casts['command-cast:chen:2'].effectiveSkillType
    }, {
        rootCastId: 'command-cast:chen:2',
        actorId: 'chr_0005_chen',
        executedSkillId: 'chr_0005_chen_normal_skill',
        effectiveSkillType: 'NormalSkill'
    });
    assert.equal(frame220.state.teamCombo.stacks, 0);
    assert.equal(frame220.state.teamCombo.lastTransition, 'consume');
    assert.ok(frame220.state.teamCombo.grantIds.length > 0);

    const replay = await replayArchivedRun({
        archive,
        runId: recorded.runId,
        replayRunId: 'run-derived-replay'
    });
    assert.equal(replay.assertions.passed, true);
    assert.equal(replay.diff.fixture.identical, true);
    assert.equal(replay.diff.environment.rulesIdentical, true);
    assert.equal(replay.diff.eventsIdentical, true);
    assert.equal(replay.diff.resultsIdentical, true);
    assert.equal(replay.deterministic, true);
    assert.equal(replay.diff.firstDivergence.identical, true);
});

test('an execution failure is automatically preserved as a sealed interrupted run', async t => {
    const archive = await investigationArchive(t);
    await assert.rejects(recordFixtureRun({
        archive,
        caseId: 'case-runtime',
        sessionId: 'session-runtime',
        runId: 'run-failed-preserved',
        fixture: {
            schemaVersion: 1,
            adapter: 'ake-squad-demo',
            input: {
                members: [{ memberId: 'missing', characterId: 'not-a-character' }],
                commands: []
            }
        }
    }), error => (
        error.riaRun?.runId === 'run-failed-preserved'
        && error.riaRun?.manifest?.status === 'interrupted'
    ));
    const manifest = await archive.getRun('run-failed-preserved');
    const assertions = await archive.readRunArtifact('run-failed-preserved', 'assertions');
    assert.equal(manifest.sealed, true);
    assert.equal(manifest.status, 'interrupted');
    assert.equal(assertions.passed, false);
    assert.equal((await archive.verifyRun('run-failed-preserved')).ok, true);
});

test('a Worker crash is sealed as interrupted without changing the adapter whitelist', async t => {
    const archive = await investigationArchive(t);
    await assert.rejects(recordFixtureRun({
        archive,
        caseId: 'case-runtime',
        sessionId: 'session-runtime',
        runId: 'run-worker-crash',
        fixture: JSON.parse(await fs.readFile(
            path.join(projectRoot, 'fixtures', 'ria', 'pelica-normal-skill.json'),
            'utf8'
        )),
        workerDataExtras: { testCrashBeforeExecution: true }
    }), error => (
        error.code === 'RIA_WORKER_CRASH'
        && error.riaRun?.manifest?.status === 'interrupted'
        && error.riaRun?.manifest?.sealed === true
    ));
    const manifest = await archive.getRun('run-worker-crash');
    assert.equal(manifest.status, 'interrupted');
    assert.equal(manifest.config.adapter, 'ake-squad-demo');
    assert.equal((await archive.verifyRun('run-worker-crash')).ok, true);
});


test('browser delivery precedes a stalled archive and warm jobs retain identical independent combat results', async t => {
    const archive = await investigationArchive(t);
    const executeWorker = createFixtureWorkerExecutor({ projectRoot });
    t.after(() => executeWorker.close());
    const fixture = JSON.parse(await fs.readFile(path.join(projectRoot, 'fixtures/ria/pelica-normal-skill.json'), 'utf8'));
    const first = await startFixtureRunExecution({ archive, caseId: 'case-runtime', sessionId: 'session-runtime',
        fixture, executeWorker, config: { uiCalculation: true } });
    const originalDrain = first.writer.drain.bind(first.writer);
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    first.writer.drain = async () => { await blocked; return originalDrain(); };
    t.after(() => unblock());
    let archived = false;
    first.execution.then(() => { archived = true; });
    const firstResult = await first.resultReady;
    assert.equal(archived, false, 'disk backpressure cannot hold the browser result hostage');
    unblock();
    const firstSealed = await first.seal();
    const second = await startFixtureRunExecution({ archive, caseId: 'case-runtime', sessionId: 'session-runtime',
        fixture, executeWorker, config: { uiCalculation: true } });
    const secondResult = await second.resultReady;
    assert.deepEqual(secondResult.timeline, firstResult.timeline, 'cached compilation must not retain live combat state');
    assert.deepEqual(secondResult.teamComboLedger, firstResult.teamComboLedger);
    const secondSealed = await second.seal();
    assert.equal(secondSealed.manifest.counts.events, firstSealed.manifest.counts.events);
    assert.equal(firstSealed.manifest.recording.droppedFacts, 0);
    assert.equal(secondSealed.manifest.recording.droppedFacts, 0);
    assert.equal(secondSealed.manifest.status, 'completed');
});
