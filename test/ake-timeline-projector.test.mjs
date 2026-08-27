import assert from 'node:assert/strict';
import test from 'node:test';

import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';

test('AKE timeline projector fuses input, cast, hits, shared ATB segments and cooldowns', () => {
    const projection = projectAkeTimeline({
        tickRate: 30,
        durationTicks: 100,
        scenario: {
            commands: [{ frame: 0, commandType: 'NormalSkill', commandId: 'cmd:1' }]
        },
        commandTrace: [
            {
                type: 'CommandSubmitted', frame: 0, commandId: 'cmd:1',
                commandType: 'NormalSkill'
            },
            {
                type: 'CommandQueued', frame: 0, commandId: 'cmd:1',
                commandType: 'NormalSkill', skillId: 'skill:normal', executeFrame: 5
            },
            {
                type: 'CommandExecuted', frame: 5, commandId: 'cmd:1',
                commandType: 'NormalSkill', skillId: 'skill:normal',
                castId: 'cast:1', success: true
            }
        ],
        centerStateTrace: [{
            frame: 20,
            from: 'Skill',
            to: 'Free',
            reason: 'skill-end:skill:normal:Completed'
        }],
        damageLog: [
            {
                frame: 12, castId: 'cast:1', skillId: 'skill:normal',
                rootSkillId: 'skill:normal', damageType: 'Pulse',
                damageAttributeType: 'Hp', finalDamage: 123
            },
            {
                frame: 12, castId: 'cast:1', skillId: 'skill:normal',
                rootSkillId: 'skill:normal', damageType: 'Pulse',
                damageAttributeType: 'Poise', poiseDamage: 10
            }
        ],
        resourceTrace: [
            {
                frame: 0, stage: 'ResourcePoolRegistered', poolId: 'squad:Atb',
                resourceType: 'Atb', scope: 'Shared', before: 0, after: 100,
                cap: 300, returnedAfter: 0, ordinaryAfter: 100
            },
            {
                frame: 6, stage: 'ResourceGained', poolId: 'squad:Atb',
                resourceType: 'Atb', scope: 'Shared', before: 100, after: 130,
                cap: 300, returnedAfter: 30, ordinaryAfter: 100,
                resourceGainMethod: 'Return', actual: 30
            },
            {
                frame: 8, stage: 'ResourceSpent', poolId: 'squad:Atb',
                resourceType: 'Atb', scope: 'Shared', before: 130, after: 30,
                cap: 300, returnedBefore: 30, returnedAfter: 0,
                returnedSpent: 30, eligibleSpend: 70, ordinaryAfter: 30,
                actual: 100, castId: 'cast:1', commandId: 'cmd:1'
            },
            {
                frame: 10, activeFromFrame: 12, stage: 'ResourceRecoverySuspended',
                poolId: 'squad:Atb', resourceType: 'Atb', scope: 'Shared',
                token: 'ultimate:1'
            },
            {
                frame: 20, stage: 'ResourceRecoveryResumed', poolId: 'squad:Atb',
                resourceType: 'Atb', scope: 'Shared', token: 'ultimate:1'
            }
        ],
        cooldownTrace: [{
            frame: 5,
            stage: 'Started',
            skillId: 'skill:normal',
            durationTicks: 120,
            endFrame: 125
        }],
        timedInputWindows: [{
            id: 'timed-input:1',
            ownerId: 'chr:test',
            inputTypes: ['ComboSkill'],
            createdFrame: 30,
            earlyDurationTicks: 15,
            activeDurationTicks: 12,
            activeStartFrame: 45,
            activeEndFrameExclusive: 57,
            resolvedFrame: 50,
            resolvedCommandId: 'cmd:combo',
            boundary: 'start-inclusive-end-exclusive',
            sourceSkillId: 'skill:combo-1',
            reason: 'ShowComboRingQte'
        }, {
            id: 'timed-input:2',
            ownerId: 'chr:test',
            inputTypes: ['ComboSkill'],
            createdFrame: 80,
            earlyDurationTicks: 15,
            activeDurationTicks: 12,
            activeStartFrame: 95,
            activeEndFrameExclusive: 107,
            resolvedFrame: null,
            resolvedCommandId: null,
            boundary: 'start-inclusive-end-exclusive',
            sourceSkillId: 'skill:combo-2',
            reason: 'ShowComboRingQte'
        }],
        finalState: {
            resourcePools: {
                'squad:Atb': {
                    resourceType: 'Atb', scope: 'Shared', ownerId: null, max: 300
                }
            }
        }
    });

    assert.deepEqual(
        projection.commands.map(command => [
            command.state,
            command.requestedFrame,
            command.actualFrame,
            command.endFrame,
            command.damage,
            command.poiseDamage
        ]),
        [['queued-then-executed', 0, 5, 20, 123, 10]]
    );
    assert.deepEqual(
        projection.hitBursts.map(hit => [hit.frame, hit.damage, hit.poiseDamage]),
        [[12, 123, 10]]
    );
    assert.deepEqual(
        projection.sharedAtb.points.map(point => [point.frame, point.value, point.ordinary, point.returned]),
        [[0, 100, 100, 0], [6, 130, 100, 30], [8, 30, 30, 0]]
    );
    assert.deepEqual(projection.sharedAtb.recoveryWindows, [{
        token: 'ultimate:1',
        startFrame: 12,
        eventFrame: 10,
        tags: [],
        reason: null,
        castId: null,
        skillId: null,
        endFrame: 20,
        open: false
    }]);
    assert.equal(projection.cooldowns[0].remainingFrames, 25);
    assert.deepEqual(projection.timedInputWindows.map(window => [
        window.ownerId,
        window.startFrame,
        window.endFrameExclusive,
        window.state
    ]), [
        ['chr:test', 45, 57, 'resolved'],
        ['chr:test', 95, 107, 'active']
    ]);
    assert.equal(projection.timedInputWindows[1].resolvedFrame, null);
    assert.deepEqual(
        projection.lanes.map(lane => lane.kind),
        [
            'CommandInput',
            'SkillCast',
            'HitBurst',
            'SharedAtb',
            'Cooldown',
            'TimedInputWindow'
        ]
    );
});
