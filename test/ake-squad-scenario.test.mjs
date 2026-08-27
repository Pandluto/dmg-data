import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';

const enemyId = 'eny_0007_mimicw';
const baseMembers = Object.freeze([
    Object.freeze({ memberId: 'pelica', characterId: 'chr_0004_pelica' }),
    Object.freeze({ memberId: 'chen', characterId: 'chr_0005_chen' })
]);

function assemble(overrides = {}) {
    return new AkeSquadScenarioAssembler().assemble({
        enemyId,
        members: baseMembers,
        ...overrides
    });
}

function executed(result) {
    return result.commandTrace.filter(entry => entry.type === 'CommandExecuted');
}

test('squad assembler keeps one enemy, one shared ATB pool and one USP pool per member', () => {
    const bundle = assemble();
    assert.deepEqual(bundle.definitions.entities.map(entity => entity.id), [
        'chr_0004_pelica',
        'chr_0005_chen',
        enemyId
    ]);
    assert.deepEqual(bundle.definitions.resources.map(pool => [
        pool.id,
        pool.scope,
        pool.ownerId
    ]), [
        ['squad:Atb', 'Shared', null],
        ['chr_0004_pelica:UltimateSp', 'Entity', 'chr_0004_pelica'],
        ['chr_0005_chen:UltimateSp', 'Entity', 'chr_0005_chen']
    ]);
    assert.equal(bundle.members[0].parameters.characterAttributes.Atk, 83.851);
    assert.equal(bundle.members[1].parameters.characterAttributes.Atk, 83.07);
});

test('same-frame shared ATB contention follows observed lexical member UUID order', () => {
    const bundle = assemble({ initialAtb: 100 });
    const result = new AkeSquadScenarioRunner(bundle).run({
        // Deliberately submit Pelica first. Calc orders same-frame commands by
        // member UUID, so chen consumes the only 100 ATB first.
        commands: [
            { memberId: 'pelica', frame: 0, commandType: 'NormalSkill' },
            { memberId: 'chen', frame: 0, commandType: 'NormalSkill' }
        ],
        endFrame: 1
    });
    assert.deepEqual(executed(result).map(entry => [
        entry.memberId,
        entry.success,
        entry.reason ?? null
    ]), [
        ['chen', true, null],
        ['pelica', false, 'INSUFFICIENT_RESOURCE']
    ]);
    assert.deepEqual(result.resourceTrace.filter(entry =>
        entry.stage === 'ResourceSpent' && entry.resourceType === 'Atb'
    ).map(entry => [entry.frame, entry.sourceId, entry.before, entry.after]), [
        [0, 'chr_0005_chen', 100, 0]
    ]);
});

test('same-frame squad executions reserve one shared enemy poise gate', () => {
    const bundle = assemble({
        enemyId: 'eny_0121_klbud',
        enemyMaxHp: 100000,
        initialAtb: 300
    });
    const setup = [
        [0, 'Attack'], [15, 'Attack'], [30, 'Attack'], [45, 'Attack'],
        [90, 'ComboSkill'], [120, 'NormalSkill'], [150, 'UltimateSkill'],
        [280, 'NormalSkill'], [340, 'Attack'], [355, 'Attack'],
        [370, 'Attack'], [385, 'Attack']
    ].map(([frame, commandType], index) => ({
        memberId: 'pelica',
        frame,
        commandType,
        commandId: `poise-setup:${index}`
    }));
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            ...setup,
            {
                memberId: 'pelica', frame: 450, commandType: 'BreakingAttack',
                commandId: 'execution:pelica'
            },
            {
                memberId: 'chen', frame: 450, commandType: 'BreakingAttack',
                commandId: 'execution:chen'
            }
        ],
        endFrame: 451
    });
    assert.deepEqual(executed(result).filter(entry =>
        entry.commandType === 'BreakingAttack'
    ).map(entry => [entry.memberId, entry.success, entry.reason ?? null]), [
        ['chen', true, null],
        ['pelica', false, 'EXECUTION_RESERVED']
    ]);
    assert.equal(result.finalState.poise.byTargetId['eny_0121_klbud']
        .executionReservation.sourceId, 'chr_0005_chen');
});

test('queued commands recheck the shared pool at their actual execution frame', () => {
    const bundle = assemble({ initialAtb: 198 });
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            { memberId: 'pelica', frame: 0, commandType: 'NormalSkill' },
            { memberId: 'pelica', frame: 1, commandType: 'NormalSkill' }
        ],
        endFrame: 200
    });
    assert.deepEqual(executed(result).map(entry => [entry.frame, entry.success]), [
        [0, true],
        [28, true]
    ]);
    assert.ok(result.commandTrace.some(entry =>
        entry.type === 'CommandQueued' && entry.frame === 1 && entry.executeFrame === 28
    ));
    assert.deepEqual(result.resourceTrace.filter(entry =>
        entry.stage === 'ResourceSpent' && entry.resourceType === 'Atb'
    ).map(entry => entry.frame), [0, 28]);
});

test('timeline sequence lets one operator repeatedly spend the shared ATB pool', () => {
    const bundle = assemble({ initialAtb: 300 });
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            {
                memberId: 'pelica', frame: 0, commandType: 'NormalSkill',
                commandId: 'pelica-b-1', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'pelica', frame: 1, commandType: 'NormalSkill',
                commandId: 'pelica-b-2', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'pelica', frame: 2, commandType: 'NormalSkill',
                commandId: 'pelica-b-3', queueMode: 'timeline-sequence'
            }
        ],
        endFrame: 100
    });

    assert.deepEqual(executed(result).map(entry => [entry.commandId, entry.frame, entry.success]), [
        ['pelica-b-1', 0, true],
        ['pelica-b-2', 28, true],
        ['pelica-b-3', 56, true]
    ]);
    assert.deepEqual(result.resourceTrace.filter(entry =>
        entry.stage === 'ResourceSpent' && entry.resourceType === 'Atb'
    ).map(entry => entry.frame), [0, 28, 56]);
    assert.equal(result.commandTrace.some(entry =>
        entry.reason === 'QUEUED_COMMAND_STILL_BLOCKED'
    ), false);
});

test('full-combo attack intent executes every normal-attack stage and the heavy-hit gain', () => {
    const bundle = assemble({
        initialAtb: 0,
        members: [{ memberId: 'pelica', characterId: 'chr_0004_pelica' }]
    });
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            memberId: 'pelica',
            frame: 0,
            commandType: 'Attack',
            commandId: 'pelica-full-attack',
            queueMode: 'timeline-sequence',
            attackMode: 'full-combo'
        }],
        endFrame: 130
    });
    const timeline = projectAkeTimeline(result);
    const command = timeline.commands[0];

    assert.deepEqual(executed(result).map(entry => [entry.commandId, entry.frame, entry.success]), [
        ['pelica-full-attack', 0, true]
    ]);
    assert.deepEqual([...new Set(result.damageLog.map(hit => hit.rootSkillId))], [
        'chr_0004_pelica_attack1',
        'chr_0004_pelica_attack2',
        'chr_0004_pelica_attack3',
        'chr_0004_pelica_attack4'
    ]);
    assert.ok(result.resourceTrace.some(entry =>
        entry.stage === 'ResourceGained'
        && entry.resourceType === 'Atb'
        && entry.sourceId === 'chr_0004_pelica'
        && entry.actual === 15
    ));
    assert.ok(command.hitCount >= 4);
    assert.equal(command.completion, 'Completed');
});

test('another controlled operator heavy attack opens Pelica combo pending', () => {
    const result = new AkeSquadScenarioRunner(assemble({
        members: [
            { memberId: 'zhuang', characterId: 'chr_0030_zhuangfy' },
            { memberId: 'pelica', characterId: 'chr_0004_pelica' }
        ]
    })).run({
        commands: [
            {
                memberId: 'zhuang', frame: 0, commandType: 'Attack',
                commandId: 'zhuang-full-attack', queueMode: 'timeline-sequence',
                attackMode: 'full-combo'
            },
            {
                memberId: 'pelica', frame: 100, commandType: 'ComboSkill',
                commandId: 'pelica-combo', queueMode: 'timeline-sequence'
            }
        ],
        endFrame: 180
    });
    const pelicaCombo = executed(result).find(entry => entry.commandId === 'pelica-combo');
    assert.equal(pelicaCombo.success, true);
    const pending = result.comboTrace.find(entry =>
        entry.ruleId === 'pelica.attack4.first-hp-damage'
        && entry.stage === 'PENDING_CREATED');
    assert.equal(pending.frame, 93);
    assert.equal(pending.currentSkillId, 'chr_0030_zhuangfy_attack5');
    assert.equal(pending.targetId, 'chr_0004_pelica');
});

test('full normal attacks can repeat while Chen combo expires outside its trigger window', () => {
    const chenOnly = [{ memberId: 'chen', characterId: 'chr_0005_chen' }];
    const repeated = new AkeSquadScenarioRunner(assemble({ members: chenOnly })).run({
        commands: [
            {
                memberId: 'chen', frame: 0, commandType: 'Attack',
                commandId: 'chen-a-1', queueMode: 'timeline-sequence',
                attackMode: 'full-combo'
            },
            {
                memberId: 'chen', frame: 1, commandType: 'Attack',
                commandId: 'chen-a-2', queueMode: 'timeline-sequence',
                attackMode: 'full-combo'
            }
        ],
        endFrame: 220
    });
    const secondAttack = executed(repeated).find(entry => entry.commandId === 'chen-a-2');
    assert.equal(secondAttack.success, true);
    assert.equal(secondAttack.frame, 95);

    const expired = new AkeSquadScenarioRunner(assemble({ members: chenOnly })).run({
        commands: [
            {
                memberId: 'chen', frame: 0, commandType: 'NormalSkill',
                commandId: 'chen-b', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'chen', frame: 212, commandType: 'ComboSkill',
                commandId: 'chen-expired-e', queueMode: 'timeline-sequence'
            }
        ],
        endFrame: 260
    });
    const lateCombo = executed(expired).find(entry => entry.commandId === 'chen-expired-e');
    assert.equal(lateCombo.success, false);
    assert.equal(lateCombo.reason, 'COMBO_NOT_READY');
});

test('Administrator combo is rejected before another squad member combo deals damage', () => {
    const result = new AkeSquadScenarioRunner(assemble({
        members: [
            { memberId: 'admin', characterId: 'chr_0003_endminf' },
            { memberId: 'chen', characterId: 'chr_0005_chen' }
        ]
    })).run({
        commands: [{
            memberId: 'admin', frame: 0, commandType: 'ComboSkill',
            commandId: 'admin-too-early', queueMode: 'timeline-sequence'
        }],
        endFrame: 30
    });
    const adminCombo = executed(result).find(entry => entry.commandId === 'admin-too-early');
    assert.equal(adminCombo.success, false);
    assert.equal(adminCombo.reason, 'COMBO_NOT_READY');
});

test('normal-skill USP fans out to the squad while ultimate spending stays entity-scoped', () => {
    const emptyUspMembers = baseMembers.map(member => ({
        ...member,
        initialUltimateSp: 0
    }));
    const gainBundle = assemble({ initialAtb: 200, members: emptyUspMembers });
    const gainResult = new AkeSquadScenarioRunner(gainBundle).run({
        commands: [{ memberId: 'pelica', frame: 0, commandType: 'NormalSkill' }],
        endFrame: 20
    });
    assert.deepEqual(gainResult.resourceTrace.filter(entry =>
        entry.stage === 'ResourceGained' && entry.resourceType === 'UltimateSp'
    ).map(entry => [entry.frame, entry.sourceId, entry.targetId, entry.actual]), [
        [13, 'chr_0004_pelica', 'chr_0004_pelica', 6.499999761581421],
        [13, 'chr_0004_pelica', 'chr_0005_chen', 6.499999761581421]
    ]);

    const spendResult = new AkeSquadScenarioRunner(assemble()).run({
        commands: [{ memberId: 'pelica', frame: 0, commandType: 'UltimateSkill' }],
        endFrame: 1
    });
    assert.deepEqual(spendResult.finalState.ultimateSpByCharacterId, {
        chr_0004_pelica: 0,
        chr_0005_chen: 70
    });
});

test('timeline projection retains actor identity for buttons, casts, hits and USP lanes', () => {
    const result = new AkeSquadScenarioRunner(assemble()).run({
        commands: [
            { memberId: 'pelica', frame: 0, commandType: 'Attack' },
            { memberId: 'chen', frame: 0, commandType: 'Attack' }
        ],
        endFrame: 200
    });
    const timeline = projectAkeTimeline(result);
    assert.deepEqual(timeline.commands.map(command => [
        command.memberId,
        command.characterId,
        command.actualFrame,
        command.endFrame
    ]), [
        ['chen', 'chr_0005_chen', 0, 19],
        ['pelica', 'chr_0004_pelica', 0, 15]
    ]);
    assert.deepEqual(
        [...new Set(timeline.hitBursts.map(hit => hit.memberId))].sort(),
        ['chen', 'pelica']
    );
    assert.deepEqual(timeline.uspPools.map(pool => pool.ownerId), [
        'chr_0004_pelica',
        'chr_0005_chen'
    ]);
});

test('generic skill-form state resolves Zhuang Fangyi ultimate overrides without character branches', () => {
    const bundle = assemble({
        members: [{ memberId: 'zhuang', characterId: 'chr_0030_zhuangfy' }]
    });
    const normalResult = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            { memberId: 'zhuang', frame: 0, commandType: 'UltimateSkill' },
            { memberId: 'zhuang', frame: 210, commandType: 'NormalSkill' }
        ],
        endFrame: 240
    });
    const transformedNormal = executed(normalResult).at(-1);
    assert.equal(transformedNormal.skillId, 'chr_0030_zhuangfy_normal_skill_ult');
    assert.equal(transformedNormal.skillSource, 'skill-form-override');

    const attackResult = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            { memberId: 'zhuang', frame: 0, commandType: 'UltimateSkill' },
            { memberId: 'zhuang', frame: 210, commandType: 'Attack' }
        ],
        endFrame: 240
    });
    const transformedAttack = executed(attackResult).at(-1);
    assert.equal(transformedAttack.skillId, 'chr_0030_zhuangfy_attack1_ult');
    assert.equal(transformedAttack.skillSource, 'skill-mode');
});

test('generic hit listeners stack self state while a shared enemy debuff modifies every actor hit', () => {
    const configuredMembers = [
        {
            memberId: 'admin', characterId: 'chr_0003_endminf',
            level: 90, skillLevel: 12, potentialLevel: 5,
            weaponLevel: 90, weaponPotential: 9
        },
        {
            memberId: 'chen', characterId: 'chr_0005_chen',
            level: 90, skillLevel: 12, potentialLevel: 5,
            weaponLevel: 90, weaponPotential: 9
        }
    ];
    const result = new AkeSquadScenarioRunner(assemble({
        members: configuredMembers
    })).run({
        commands: [
            {
                memberId: 'chen', frame: 0, commandType: 'NormalSkill',
                commandId: 'chen-no-guard', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'chen', frame: 13, commandType: 'ComboSkill',
                commandId: 'chen-combo-trigger', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'admin', frame: 30, commandType: 'ComboSkill',
                commandId: 'admin-originum', queueMode: 'timeline-sequence'
            },
            {
                memberId: 'chen', frame: 100, commandType: 'UltimateSkill',
                commandId: 'chen-ultimate', queueMode: 'timeline-sequence'
            }
        ],
        endFrame: 230
    });
    const chenCastId = executed(result).find(entry =>
        entry.commandId === 'chen-ultimate').castId;
    const chenHpHits = result.damageLog.filter(hit =>
        hit.castId === chenCastId && hit.damageAttributeType === 'Hp');

    assert.deepEqual(chenHpHits.slice(0, 6).map(hit =>
        hit.modifierSnapshot.defenderZone.scale), [1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
    assert.equal(chenHpHits.at(-1).modifierSnapshot.defenderZone.scale, 1);
    const stackEvents = result.statusTrace.filter(event =>
        event.buffId === 'buff_chr_0005_chen_talent_0_1'
        && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage));
    assert.deepEqual(stackEvents.slice(0, 5).map(event => event.after), [1, 2, 3, 4, 5]);
    assert.equal(stackEvents.at(-1).after, 5);
    const stackInstanceId = stackEvents[0].instanceId;
    const stackedHit = chenHpHits.find(hit =>
        hit.modifierSnapshot.attackAttribute?.contributions?.some(contribution =>
            contribution.buffInstanceId === stackInstanceId));
    assert.ok(stackedHit, 'a later Chen hit must expose the active talent in its ATK snapshot');
    assert.equal(stackedHit.modifierSnapshot.attackAttribute.attribute, 'Atk');
    assert.ok(Math.abs(
        stackedHit.modifierSnapshot.attackAttribute.evaluation.value
        - stackedHit.operands.attack
    ) < 1e-9);
});

test('generic runtime keeps main, status-triggered and anomaly damage as independent formula hits', () => {
    const configuredMembers = [
        {
            memberId: 'chen', characterId: 'chr_0005_chen',
            level: 90, skillLevel: 12, potentialLevel: 5,
            weaponLevel: 90, weaponPotential: 9
        },
        {
            memberId: 'admin', characterId: 'chr_0003_endminf',
            level: 90, skillLevel: 12, potentialLevel: 5,
            weaponLevel: 90, weaponPotential: 9
        }
    ];
    const result = new AkeSquadScenarioRunner(assemble({
        members: configuredMembers
    })).run({
        commands: [
            { memberId: 'chen', frame: 0, commandType: 'NormalSkill', commandId: 'chen-b', queueMode: 'timeline-sequence' },
            { memberId: 'chen', frame: 30, commandType: 'ComboSkill', commandId: 'chen-e', queueMode: 'timeline-sequence' },
            { memberId: 'admin', frame: 70, commandType: 'ComboSkill', commandId: 'admin-e', queueMode: 'timeline-sequence' },
            { memberId: 'admin', frame: 120, commandType: 'NormalSkill', commandId: 'admin-b', queueMode: 'timeline-sequence' }
        ],
        endFrame: 180
    });
    const adminCastId = executed(result).find(entry => entry.commandId === 'admin-b').castId;
    const hpHits = result.damageLog.filter(hit =>
        hit.castId === adminCastId && hit.damageAttributeType === 'Hp');

    assert.equal(hpHits.length, 3);
    assert.deepEqual(new Set(hpHits.map(hit => hit.sourceBuffId).filter(Boolean)), new Set([
        'buff_physical_crushed',
        'buff_common_originum_frozen'
    ]));
    assert.ok(hpHits.every(hit => Number.isFinite(hit.nonCriticalDamage)
        && Number.isFinite(hit.criticalDamage)
        && Number.isFinite(hit.expectedDamage)
        && Number.isFinite(hit.operands.atkScale)
        && hit.sourcePath));
    assert.ok(result.statusTrace.some(event =>
        event.buffId === 'buff_physical_no_guard'
        && event.stage === 'StatusEffectFinished'
        && event.triggerCastId === adminCastId));
    assert.ok(result.statusTrace.some(event =>
        event.buffId === 'buff_common_originum_frozen'
        && event.stage === 'StatusEffectFinished'
        && event.triggerCastId === adminCastId));
});
