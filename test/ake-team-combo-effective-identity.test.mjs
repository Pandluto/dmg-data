import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { CombatRuntime, TEAM_COMBO_BUFF_ID } from '../src/core/combat-runtime.mjs';
import { normalizeTeamComboEventLedger } from '../src/core/team-combo-event-ledger.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL(
    '../fixtures/parity/team-combo-effective-identity.json',
    import.meta.url
), 'utf8'));
const comboBuffRaw = JSON.parse(fs.readFileSync(new URL(
    `../reference/public-data/akedata/Json/BuffData/${TEAM_COMBO_BUFF_ID}.json`,
    import.meta.url
), 'utf8'));

function installComboBuff(bundle) {
    if (bundle.buffs.has(TEAM_COMBO_BUFF_ID)) return;
    const definition = new AkeActionCompiler().compileBuff(comboBuffRaw);
    bundle.buffs.set(TEAM_COMBO_BUFF_ID, definition);
    bundle.definitions.buffs[TEAM_COMBO_BUFF_ID] = definition;
}

function injectGrant(bundle, memberId, commandType, offset, sourceKey) {
    installComboBuff(bundle);
    const member = bundle.membersById[memberId];
    const skillId = commandType === 'UltimateSkill'
        ? member.roles.ultimateSkillId
        : member.roles.normalAttackIds[0];
    const program = structuredClone(bundle.programs.get(skillId));
    program.timeline.unshift({
        groupIndex: -1000 - offset,
        startFrame: offset,
        endFrame: offset,
        actions: [{
            type: 'GrantTeamCombo',
            sourceRef: 'Source',
            buffId: TEAM_COMBO_BUFF_ID,
            durationSeconds: 15,
            count: 1,
            sourceKey
        }],
        cleanupActions: []
    });
    bundle.programs.set(skillId, program);
}

function enhancedCamilleRun({ includeConsumer = false, consumerCommandType = 'NormalSkill' } = {}) {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{
            memberId: 'camille',
            characterId: 'chr_0033_camille',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 130
        }, ...(includeConsumer ? [{
            memberId: 'chen',
            characterId: 'chr_0005_chen',
            initialUltimateSp: 70
        }] : [])]
    });
    const source = fixture.cases.find(entry => (
        entry.id === 'camille-enhanced-b-with-existing-combo'
    ));
    injectGrant(
        bundle,
        'camille',
        'UltimateSkill',
        source.preloadedGrantFrame,
        'fixture:preloaded-team-combo'
    );
    const commands = structuredClone(source.commands);
    if (includeConsumer) commands.push({
        commandId: consumerCommandType === 'UltimateSkill'
            ? 'real-ultimate-q'
            : 'real-normal-b',
        memberId: 'chen',
        commandType: consumerCommandType,
        frame: 230
    });
    return new AkeSquadScenarioRunner(bundle).run({
        commands,
        endFrame: includeConsumer ? 430 : 230
    });
}

function timingBoundaryRun(caseDefinition) {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{
            memberId: caseDefinition.providerMemberId,
            characterId: 'chr_0004_pelica'
        }, {
            memberId: caseDefinition.consumerMemberId,
            characterId: 'chr_0005_chen'
        }]
    });
    injectGrant(
        bundle,
        caseDefinition.providerMemberId,
        'Attack',
        caseDefinition.grantOffset,
        `fixture:${caseDefinition.id}`
    );
    return new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            commandId: 'grant',
            memberId: caseDefinition.providerMemberId,
            commandType: 'Attack',
            frame: caseDefinition.grantCommandFrame
        }, {
            commandId: 'q',
            memberId: caseDefinition.consumerMemberId,
            commandType: 'UltimateSkill',
            frame: caseDefinition.qFrame
        }],
        endFrame: Math.max(
            caseDefinition.grantCommandFrame,
            caseDefinition.qFrame
        ) + 160
    });
}

test('neutral parity fixture keeps existing combo through Camille enhanced B effective identity', () => {
    const result = enhancedCamilleRun();
    const expected = fixture.cases.find(entry => (
        entry.id === 'camille-enhanced-b-with-existing-combo'
    )).expected;
    const settlement = result.teamComboLedger.settlements.find(entry => (
        entry.commandId === 'camille-enhanced-b'
    ));
    assert.deepEqual({
        inputCommandType: settlement.inputCommandType,
        executedSkillId: settlement.executedSkillId,
        effectiveSkillType: settlement.effectiveSkillType,
        consumedStacks: settlement.consumedStacks
    }, {
        inputCommandType: expected.inputCommandType,
        executedSkillId: expected.executedSkillId,
        effectiveSkillType: expected.effectiveSkillType,
        consumedStacks: expected.consumedStacks
    });
    assert.notEqual(settlement.castId, settlement.rootCastId,
        'the effective child cast and root input cast must remain separate identities');
    assert.equal(settlement.parentCastId, settlement.rootCastId);
    const childHits = result.teamComboLedger.hits.filter(hit => (
        hit.rootCastId === settlement.rootCastId
        && hit.damageAttributeType === 'Hp'
    ));
    assert.deepEqual(childHits.map(hit => hit.frame), expected.hpHitFrames);
    assert.ok(childHits.every(hit => (
        hit.effectiveSkillType === 'ComboSkill'
        && hit.consumptionSnapshots.length === 0
    )));
    assert.deepEqual(result.teamComboLedger.events.map(event => [
        event.frame,
        event.type,
        event.beforeStacks,
        event.afterStacks,
        event.rootCastId
    ]), [
        [1, 'grant', 0, 1, 'command-cast:camille:1'],
        [expected.grantFrame, 'grant', 1, 2, settlement.rootCastId]
    ]);
});

test('a true B after enhanced B consumes both old and newly granted layers with one frozen snapshot', () => {
    const result = enhancedCamilleRun({ includeConsumer: true });
    const settlement = result.teamComboLedger.settlements.find(entry => (
        entry.commandId === 'real-normal-b'
    ));
    assert.deepEqual([
        settlement.inputCommandType,
        settlement.effectiveSkillType,
        settlement.consumptionStatus,
        settlement.consumedStacks
    ], ['NormalSkill', 'NormalSkill', 'Consumed', 2]);
    const hits = result.teamComboLedger.hits.filter(hit => (
        hit.rootCastId === settlement.rootCastId
        && hit.damageAttributeType === 'Hp'
    ));
    assert.ok(hits.length > 1);
    assert.ok(hits.every(hit => (
        hit.consumptionSnapshots.length === 1
        && hit.consumptionSnapshots[0].consumedStacks === 2
        && hit.consumptionSnapshots[0].rootCastId === settlement.rootCastId
    )), 'every Hit in the action must reuse the same root-cast consumption snapshot');
    assert.deepEqual(result.teamComboLedger.events.at(-1).type, 'consume');
    assert.deepEqual([
        result.teamComboLedger.events.at(-1).beforeStacks,
        result.teamComboLedger.events.at(-1).afterStacks
    ], [2, 0]);
});

test('a true Q after enhanced B consumes the same pool before every Q Hit', () => {
    const result = enhancedCamilleRun({
        includeConsumer: true,
        consumerCommandType: 'UltimateSkill'
    });
    const settlement = result.teamComboLedger.settlements.find(entry => (
        entry.commandId === 'real-ultimate-q'
    ));
    assert.deepEqual([
        settlement.inputCommandType,
        settlement.effectiveSkillType,
        settlement.consumptionStatus,
        settlement.consumedStacks
    ], ['UltimateSkill', 'UltimateSkill', 'Consumed', 2]);
    const hits = result.teamComboLedger.hits.filter(hit => (
        hit.rootCastId === settlement.rootCastId
        && hit.damageAttributeType === 'Hp'
    ));
    assert.ok(hits.length > 0);
    assert.ok(hits.every(hit => (
        hit.consumptionSnapshots.length === 1
        && hit.consumptionSnapshots[0].consumedStacks === 2
        && hit.consumptionSnapshots[0].rootCastId === settlement.rootCastId
    )), 'every Q Hit must reuse the action-start team-combo snapshot');
});

test('grant/Q boundaries use frame plus causal sequence for earlier, same-frame and later grants', () => {
    for (const caseDefinition of fixture.cases.filter(entry => (
        entry.kind === 'causal-boundary'
    ))) {
        const result = timingBoundaryRun(caseDefinition);
        const settlement = result.teamComboLedger.settlements.find(entry => (
            entry.commandId === 'q'
        ));
        assert.equal(
            settlement.consumedStacks,
            caseDefinition.expectedConsumedStacks,
            caseDefinition.id
        );
        const eventsAtQ = result.teamComboLedger.events.filter(event => (
            event.frame === caseDefinition.qFrame
        ));
        if (caseDefinition.expectedConsumedStacks > 0) {
            const grant = eventsAtQ.find(event => event.type === 'grant');
            const consume = eventsAtQ.find(event => event.type === 'consume');
            if (grant) assert.ok(grant.sequence < consume.sequence, caseDefinition.id);
        } else {
            assert.equal(
                eventsAtQ.some(event => event.type === 'consume'),
                false,
                caseDefinition.id
            );
        }
    }
});

test('root consumption snapshot propagates to a separately scheduled child cast', () => {
    const comboBuff = new AkeActionCompiler().compileBuff(comboBuffRaw);
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'provider', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'consumer', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                {
                    id: 'enemy', kind: 'Enemy', team: 'enemy', attributes: { Def: 0 },
                    maxHp: 10000, currentHp: 10000
                }
            ],
            buffs: { [TEAM_COMBO_BUFF_ID]: comboBuff }
        },
        damageResolver: createAkeDamageResolver()
    });
    runtime.execute({
        type: 'GrantTeamCombo', sourceRef: 'Source', count: 1,
        durationSeconds: 15, sourceKey: 'fixture:root-child'
    }, { frame: 0, sourceId: 'provider', ownerId: 'provider', targetId: 'enemy' });
    runtime.registerCastLineage({ castId: 'root-cast', rootCastId: 'root-cast' });
    runtime.consumeTeamComboState({
        frame: 5,
        consumerId: 'consumer',
        targetId: 'enemy',
        inputCommandType: 'NormalSkill',
        commandType: 'NormalSkill',
        effectiveSkillType: 'NormalSkill',
        skillType: 'NormalSkill',
        inputSkillId: 'wrapper-b',
        executedSkillId: 'wrapper-b',
        skillId: 'wrapper-b',
        rootSkillId: 'wrapper-b',
        castId: 'root-cast',
        rootCastId: 'root-cast'
    });
    runtime.scheduleProgram({
        skillId: 'derived-hit',
        effectiveSkillType: 'NormalSkill',
        timeline: [{
            groupIndex: 0,
            startFrame: 0,
            endFrame: 0,
            actions: [{
                type: 'ResolveDamagePacket',
                damageUnits: [{
                    damageType: 'Physical',
                    damageAttributeType: 'Hp',
                    damageDecorateMask: 512,
                    scale: 1,
                    calculationType: 'SimpleAtkScaleCalculation'
                }]
            }],
            cleanupActions: []
        }]
    }, {
        frame: 5,
        sourceId: 'consumer',
        ownerId: 'consumer',
        targetId: 'enemy',
        inputSkillId: 'wrapper-b',
        inputCommandType: 'NormalSkill',
        effectiveSkillType: 'NormalSkill',
        skillType: 'NormalSkill',
        skillId: 'derived-hit',
        rootSkillId: 'wrapper-b',
        castId: 'child-cast',
        rootCastId: 'root-cast',
        parentCastId: 'root-cast'
    });
    runtime.runUntil(5);
    const resolved = runtime.effects.trace.find(entry => (
        entry.stage === 'ActionDelegated'
        && entry.type === 'ResolveDamagePacket'
        && entry.castId === 'child-cast'
    ));
    assert.deepEqual(resolved.result.resolution.hits[0].consumedStatuses.map(snapshot => [
        snapshot.consumedStacks,
        snapshot.castId,
        snapshot.rootCastId
    ]), [[1, 'root-cast', 'root-cast']]);
});

test('normalized ledger preserves consume then grant when the net pool is 1 to 0 to 1', () => {
    const comboBuff = new AkeActionCompiler().compileBuff(comboBuffRaw);
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'provider', kind: 'Character', team: 'ally' },
                { id: 'consumer', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [TEAM_COMBO_BUFF_ID]: comboBuff }
        }
    });
    const context = (frame, sourceId, castId) => ({
        frame, sourceId, ownerId: sourceId, targetId: 'enemy', castId,
        rootCastId: castId, skillId: `${sourceId}-skill`, rootSkillId: `${sourceId}-skill`
    });
    runtime.execute({
        type: 'GrantTeamCombo', sourceRef: 'Source', count: 1,
        durationSeconds: 15, sourceKey: 'fixture:first'
    }, context(0, 'provider', 'provider:first'));
    runtime.consumeTeamComboState({
        frame: 10, consumerId: 'consumer', targetId: 'enemy',
        inputCommandType: 'UltimateSkill', commandType: 'UltimateSkill',
        effectiveSkillType: 'UltimateSkill', skillType: 'UltimateSkill',
        skillId: 'consumer-q', rootSkillId: 'consumer-q',
        castId: 'consumer:q', rootCastId: 'consumer:q'
    });
    runtime.execute({
        type: 'GrantTeamCombo', sourceRef: 'Source', count: 1,
        durationSeconds: 15, sourceKey: 'fixture:second'
    }, context(10, 'provider', 'provider:second'));
    const ledger = normalizeTeamComboEventLedger({
        statusTrace: runtime.statusEffects.trace
    });
    assert.deepEqual(ledger.events.map(event => [
        event.frame,
        event.sequence,
        event.type,
        event.beforeStacks,
        event.afterStacks,
        event.rootCastId
    ]), [
        [0, ledger.events[0].sequence, 'grant', 0, 1, 'provider:first'],
        [10, ledger.events[1].sequence, 'consume', 1, 0, 'consumer:q'],
        [10, ledger.events[2].sequence, 'grant', 0, 1, 'provider:second']
    ]);
    assert.ok(ledger.events[1].sequence < ledger.events[2].sequence);
});

test('shared-clock pause preserves one replicated pool for a concurrent later consumer', () => {
    const comboBuff = new AkeActionCompiler().compileBuff(comboBuffRaw);
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'provider', kind: 'Character', team: 'ally' },
                { id: 'consumer', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [TEAM_COMBO_BUFF_ID]: comboBuff }
        }
    });
    runtime.execute({
        type: 'GrantTeamCombo', sourceRef: 'Source', count: 1,
        durationSeconds: 1, sourceKey: 'fixture:paused-pool'
    }, {
        frame: 0, sourceId: 'provider', ownerId: 'provider', targetId: 'enemy',
        castId: 'provider:grant', rootCastId: 'provider:grant'
    });
    const pause = runtime.execute({
        type: 'PauseClock',
        domainId: 'global',
        durationTicks: 20,
        excludedTicks: 20,
        requestedScale: 0
    }, {
        frame: 5, sourceId: 'provider', ownerId: 'provider'
    });
    assert.deepEqual(pause.delayedTimers.map(timer => timer.deadlineFrame), [50, 50]);
    runtime.schedule(35, 70, () => runtime.consumeTeamComboState({
        frame: 35,
        consumerId: 'consumer',
        targetId: 'enemy',
        inputCommandType: 'UltimateSkill',
        commandType: 'UltimateSkill',
        effectiveSkillType: 'UltimateSkill',
        skillType: 'UltimateSkill',
        skillId: 'consumer-q',
        rootSkillId: 'consumer-q',
        castId: 'consumer:q',
        rootCastId: 'consumer:q'
    }), 'fixture:concurrent-consumer');
    runtime.runUntil(35);
    assert.equal(runtime.statusEffects.list({
        active: true,
        buffId: TEAM_COMBO_BUFF_ID
    }).length, 0, 'the still-active shared pool is consumed atomically across both carriers');
    const ledger = normalizeTeamComboEventLedger({
        statusTrace: runtime.statusEffects.trace
    });
    assert.deepEqual(ledger.events.map(event => [
        event.frame,
        event.type,
        event.beforeStacks,
        event.afterStacks,
        event.rootCastId
    ]), [
        [0, 'grant', 0, 1, 'provider:grant'],
        [35, 'consume', 1, 0, 'consumer:q']
    ]);
    assert.equal(ledger.events.some(event => event.type === 'expire'), false);
});

test('normalized ledger keeps refresh and natural expiry as distinct causal events', () => {
    const comboBuff = new AkeActionCompiler().compileBuff(comboBuffRaw);
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'provider', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [TEAM_COMBO_BUFF_ID]: comboBuff }
        }
    });
    const context = frame => ({
        frame,
        sourceId: 'provider',
        ownerId: 'provider',
        targetId: 'provider',
        skillId: 'provider-skill',
        rootSkillId: 'provider-skill',
        inputSkillId: 'provider-skill',
        inputCommandType: 'Attack',
        effectiveSkillType: 'Attack',
        castId: 'provider:grant',
        rootCastId: 'provider:grant'
    });
    const apply = frame => runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: TEAM_COMBO_BUFF_ID,
        durationSeconds: 1,
        stackingPolicy: 'Refresh',
        metadata: { teamComboGrantId: 'fixture:refresh-expire' }
    }, context(frame));
    apply(0);
    apply(10);
    runtime.runUntil(40);

    const ledger = normalizeTeamComboEventLedger({
        statusTrace: runtime.statusEffects.trace
    });
    assert.deepEqual(ledger.events.map(event => [
        event.frame,
        event.type,
        event.beforeStacks,
        event.afterStacks,
        event.rootCastId
    ]), [
        [0, 'grant', 0, 1, 'provider:grant'],
        [10, 'refresh', 1, 1, 'provider:grant'],
        [40, 'expire', 1, 0, 'provider:grant']
    ]);
    assert.ok(ledger.events[0].sequence < ledger.events[1].sequence);
    assert.ok(ledger.events[1].sequence < ledger.events[2].sequence);
});
