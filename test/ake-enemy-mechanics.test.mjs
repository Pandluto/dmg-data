import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const enemyId = 'eny_0007_mimicw';
const attachmentBuffIds = Object.freeze({
    Fire: 'buff_common_energy_shard_attached_fire',
    Cryst: 'buff_common_energy_shard_attached_cryst',
    Pulse: 'buff_common_energy_shard_attached_pulse',
    Natural: 'buff_common_energy_shard_attached_natural'
});

function assemble(members, overrides = {}) {
    return new AkeSquadScenarioAssembler().assemble({
        enemyId,
        initialAtb: 300,
        members,
        ...overrides
    });
}

function infliction(element) {
    return {
        type: 'ApplyEnemyInfliction',
        element,
        buffId: attachmentBuffIds[element],
        attachmentBuffIds,
        target: 'Target',
        reason: 'SpellInfliction'
    };
}

test('AKE elemental attachment slot follows same-element burst and cross-element consume rules', () => {
    const bundle = assemble([
        { memberId: 'tangtang', characterId: 'chr_0027_tangtang' },
        { memberId: 'laevat', characterId: 'chr_0016_laevat' }
    ]);
    const runtime = new CombatRuntime({
        tickRate: bundle.tickRate,
        definitions: bundle.definitions
    });
    const context = {
        frame: 0,
        sourceId: 'chr_0027_tangtang',
        ownerId: 'chr_0027_tangtang',
        targetId: enemyId,
        skillId: 'test-infliction',
        rootSkillId: 'test-infliction',
        castId: 'test-cast'
    };

    runtime.execute(infliction('Cryst'), context);
    runtime.execute(infliction('Cryst'), { ...context, frame: 1 });

    const cryst = runtime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId: attachmentBuffIds.Cryst
    });
    assert.equal(cryst.length, 1);
    assert.equal(cryst[0].stackCount, 2, 'one repeated infliction must add exactly one layer');
    assert.equal(runtime.statusEffects.has({
        targetId: enemyId,
        buffId: 'buff_common_cryst_cryst_triggered'
    }), true, 'same element must create its burst Buff');

    runtime.execute(infliction('Fire'), {
        ...context,
        frame: 2,
        sourceId: 'chr_0016_laevat',
        ownerId: 'chr_0016_laevat',
        skillId: 'test-reaction',
        rootSkillId: 'test-reaction',
        castId: 'test-reaction-cast'
    });

    for (const buffId of Object.values(attachmentBuffIds)) {
        assert.equal(runtime.statusEffects.has({ targetId: enemyId, buffId }), false);
    }
    const reaction = runtime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId: 'buff_common_fire_cryst_triggered'
    })[0];
    assert.ok(reaction, 'different element must create the raw AKE reaction Buff');
    assert.equal(reaction.sourceId, 'chr_0016_laevat');
    assert.equal(reaction.blackboard.consumed_layer, 2);
    assert.equal(reaction.blackboard.count, 2);
    const consumedAttachment = runtime.statusEffects.trace.find(event =>
        event.buffId === attachmentBuffIds.Cryst
        && event.stage === 'StatusEffectFinished'
        && event.frame === 2
    );
    assert.equal(consumedAttachment.consumption, true);
    assert.equal(consumedAttachment.consumerId, 'chr_0016_laevat');
    assert.equal(consumedAttachment.consumeKind, 'ElementalReaction');
    assert.equal(runtime.trace.some(event =>
        event.stage === 'AbilityEventNotified'
        && event.eventType === 'OnConsumeBuff'
        && event.listenerTargetId === 'chr_0016_laevat'
    ), true);
});

test('all four AKE attachments share one generic 4x4 reaction matrix', () => {
    const bundle = assemble([
        { memberId: 'tangtang', characterId: 'chr_0027_tangtang' },
        { memberId: 'laevat', characterId: 'chr_0016_laevat' }
    ]);
    const elements = Object.keys(attachmentBuffIds);

    for (const existingElement of elements) {
        for (const incomingElement of elements) {
            const runtime = new CombatRuntime({
                tickRate: bundle.tickRate,
                definitions: bundle.definitions
            });
            const firstContext = {
                frame: 0,
                sourceId: 'chr_0027_tangtang',
                ownerId: 'chr_0027_tangtang',
                targetId: enemyId,
                skillId: `matrix-${existingElement}`,
                rootSkillId: `matrix-${existingElement}`,
                castId: `matrix-first-${existingElement}`
            };
            const secondContext = {
                ...firstContext,
                frame: 1,
                sourceId: 'chr_0016_laevat',
                ownerId: 'chr_0016_laevat',
                skillId: `matrix-${incomingElement}`,
                rootSkillId: `matrix-${incomingElement}`,
                castId: `matrix-second-${incomingElement}`
            };

            runtime.execute(infliction(existingElement), firstContext);
            runtime.execute(infliction(incomingElement), secondContext);

            const activeAttachments = runtime.statusEffects.list({
                active: true,
                targetId: enemyId
            }).filter(instance => Object.values(attachmentBuffIds).includes(instance.buffId));
            if (incomingElement === existingElement) {
                assert.equal(activeAttachments.length, 1);
                assert.equal(activeAttachments[0].buffId, attachmentBuffIds[existingElement]);
                assert.equal(activeAttachments[0].stackCount, 2);
            } else {
                assert.equal(
                    activeAttachments.length,
                    0,
                    `${existingElement} -> ${incomingElement} must consume the attachment slot`
                );
                const reactionBuffId = `buff_common_${incomingElement.toLowerCase()}_${existingElement.toLowerCase()}_triggered`;
                const reaction = runtime.statusEffects.list({
                    active: true,
                    targetId: enemyId,
                    buffId: reactionBuffId
                })[0];
                assert.ok(reaction, `${existingElement} -> ${incomingElement} must create ${reactionBuffId}`);
                assert.equal(reaction.sourceId, 'chr_0016_laevat');
            }
        }
    }
});

test('elemental attachments and physical vulnerability both cap at four layers', () => {
    const elementalBundle = assemble([
        { memberId: 'tangtang', characterId: 'chr_0027_tangtang' }
    ]);
    const elementalRuntime = new CombatRuntime({
        tickRate: elementalBundle.tickRate,
        definitions: elementalBundle.definitions
    });
    for (let frame = 0; frame < 6; frame += 1) {
        elementalRuntime.execute(infliction('Cryst'), {
            frame,
            sourceId: 'chr_0027_tangtang',
            ownerId: 'chr_0027_tangtang',
            targetId: enemyId,
            skillId: 'attachment-cap',
            rootSkillId: 'attachment-cap',
            castId: `attachment-cap:${frame}`
        });
    }
    assert.equal(elementalRuntime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId: attachmentBuffIds.Cryst
    })[0].stackCount, 4);

    const physicalBundle = assemble([
        { memberId: 'chen', characterId: 'chr_0005_chen' }
    ]);
    const physicalRuntime = new CombatRuntime({
        tickRate: physicalBundle.tickRate,
        definitions: physicalBundle.definitions
    });
    for (let frame = 0; frame < 6; frame += 1) {
        physicalRuntime.execute({
            type: 'ApplyCombatStatus',
            target: 'Target',
            statusKey: 'airborne',
            triggerBuffId: 'buff_physical_try_airborne',
            statusBuffId: 'buff_physical_airborne',
            initialBuffId: 'buff_physical_no_guard'
        }, {
            frame,
            sourceId: 'chr_0005_chen',
            ownerId: 'chr_0005_chen',
            targetId: enemyId,
            skillId: 'vulnerability-cap',
            rootSkillId: 'vulnerability-cap',
            castId: `vulnerability-cap:${frame}`
        });
    }
    assert.equal(physicalRuntime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId: 'buff_physical_no_guard'
    })[0].stackCount, 4);
});

test('real Tangtang channel executes its interval actions and applies cold attachment', () => {
    const bundle = assemble([{ memberId: 'tangtang', characterId: 'chr_0027_tangtang' }]);
    const channelProgram = bundle.programs.get(
        'chr_0027_tangtang_normal_skill_water_projhit'
    );
    const scheduled = channelProgram.timeline.flatMap(group => group.actions)
        .find(action => action.type === 'ScheduleIntervalActions');
    assert.ok(scheduled, 'serialized ChannelingAction must not be discarded');
    assert.equal(scheduled.intervalSeconds, 0.26);
    assert.equal(scheduled.durationTicks, 90);

    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            memberId: 'tangtang',
            frame: 0,
            commandType: 'NormalSkill',
            commandId: 'tangtang-normal',
            queueMode: 'timeline-sequence'
        }],
        endFrame: 180
    });
    const attachmentEvents = result.statusTrace.filter(event =>
        event.buffId === attachmentBuffIds.Cryst
        && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
    assert.ok(attachmentEvents.length > 0, 'the real skill must reach SpellInfliction');
    assert.equal(attachmentEvents.at(-1).after, 1);
});

test('lift and knockdown retain vulnerability layers in the shared enemy state', () => {
    const bundle = assemble([{ memberId: 'chen', characterId: 'chr_0005_chen' }]);
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            {
                memberId: 'chen', frame: 0, commandType: 'NormalSkill',
                commandId: 'chen-normal', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'chen', frame: 30, commandType: 'ComboSkill',
                commandId: 'chen-combo', queueMode: 'timeline-sequence'
            }
        ],
        endFrame: 120
    });
    const noGuard = result.finalState.statuses.find(status =>
        status.targetId === enemyId && status.buffId === 'buff_physical_no_guard');
    assert.ok(noGuard, 'vulnerability must remain active after lift');
    assert.equal(noGuard.stackCount, 2);
    assert.deepEqual(result.statusTrace.filter(event =>
        event.buffId === 'buff_physical_no_guard'
        && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage)
    ).map(event => event.after), [1, 2], 'each real status attempt must add exactly one layer');
    assert.equal(result.damageLog.some(hit =>
        hit.sourceBuffId === 'buff_physical_airborne'
        && hit.damageAttributeType === 'Hp'
        && hit.finalDamage > 0), true, 'lift after vulnerability must remain an independent physical hit');
    assert.equal(result.finalState.statuses.some(status =>
        status.buffId === 'buff_physical_no_guard_fake'), false);
    assert.equal(result.statusTrace.some(event =>
        event.buffId === 'buff_physical_no_guard'
        && event.stage === 'StatusEffectFinished'
        && event.triggerCastId === 'command-cast:chen:2'), false);
});
