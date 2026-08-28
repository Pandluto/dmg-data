import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { CombatRuntime, TEAM_COMBO_BUFF_ID } from '../src/core/combat-runtime.mjs';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
));
const semanticMappings = readJson('spec/engine-semantic-mappings.json');

function actionTree(actions) {
    return (actions ?? []).flatMap(action => [
        action,
        ...actionTree(action.actions),
        ...actionTree(action.success),
        ...actionTree(action.failure)
    ]);
}

test('real Camille combo stages compile ComboAction and DoOnceAction as shared primitives', () => {
    const compiler = new AkeActionCompiler();
    const first = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0033_camille_combo_skill.json'
    ));
    const second = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0033_camille_combo_skill_2.json'
    ));
    const firstActions = actionTree(first.timeline.flatMap(group => group.actions));
    const secondActions = actionTree(second.timeline.flatMap(group => group.actions));
    const firstGrant = firstActions.find(action => action.type === 'GrantTeamCombo');
    const secondOnce = secondActions.find(action => action.type === 'ExecuteOnce'
        && actionTree(action.actions).some(child => child.type === 'GrantTeamCombo'));

    assert.equal(firstGrant.buffId, TEAM_COMBO_BUFF_ID);
    assert.equal(firstGrant.durationSeconds.blackboardKey, 'combo_duration');
    assert.deepEqual(firstGrant.metadata.consumeBy, ['NormalSkill', 'UltimateSkill']);
    assert.ok(secondOnce, 'the second combo stage must retain its once-only combo grant');
    assert.equal(
        first.compiler.unresolved.some(entry => entry.sourceType === 'ComboAction'),
        false
    );
    assert.equal(
        second.compiler.unresolved.some(entry => ['ComboAction', 'DoOnceAction'].includes(
            entry.sourceType
        )),
        false
    );
});

test('real Camille field grants shared combo before Wulfa ultimate consumes it', () => {
    const result = simulateSquadDemo({
        enemyId: 'eny_0007_mimicw',
        members: [{
            memberId: 'wulfa',
            characterId: 'chr_0028_wulfa',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 110
        }, {
            memberId: 'camille',
            characterId: 'chr_0033_camille',
            level: 90,
            skillLevel: 12,
            initialUltimateSp: 130
        }],
        commands: [{
            commandId: 'wulfa-skill',
            memberId: 'wulfa',
            commandType: 'NormalSkill',
            frame: 0,
            queueMode: 'timeline-sequence'
        }, {
            commandId: 'camille-skill',
            memberId: 'camille',
            commandType: 'NormalSkill',
            frame: 0,
            queueMode: 'timeline-sequence'
        }, {
            commandId: 'wulfa-combo-1',
            memberId: 'wulfa',
            commandType: 'ComboSkill',
            frame: 94,
            queueMode: 'timeline-sequence'
        }, {
            commandId: 'wulfa-combo-2',
            memberId: 'wulfa',
            commandType: 'ComboSkill',
            frame: 151,
            queueMode: 'timeline-sequence'
        }, {
            commandId: 'camille-combo',
            memberId: 'camille',
            commandType: 'ComboSkill',
            frame: 159,
            queueMode: 'timeline-sequence'
        }, {
            commandId: 'wulfa-ultimate',
            memberId: 'wulfa',
            commandType: 'UltimateSkill',
            frame: 212,
            queueMode: 'timeline-sequence'
        }],
        endFrame: 380
    });
    const weakEvents = result.statusEvents.filter(event => (
        event.buffId === 'buff_chr_0033_camille_normal_skill_weak'
    ));
    assert.deepEqual(weakEvents.map(event => [event.frame, event.stage]), [
        [12, 'StatusEffectApplied']
    ]);

    const comboEvents = result.statusEvents.filter(event => (
        event.buffId === TEAM_COMBO_BUFF_ID
    ));
    assert.deepEqual(comboEvents.filter(event => (
        event.stage === 'StatusEffectApplied'
    )).map(event => [event.frame, event.targetId]).sort(), [
        [206, 'chr_0028_wulfa'],
        [206, 'chr_0033_camille']
    ]);
    assert.deepEqual(comboEvents.filter(event => (
        event.stage === 'StatusEffectFinished'
    )).map(event => [event.frame, event.targetId]).sort(), [
        [212, 'chr_0028_wulfa'],
        [212, 'chr_0033_camille']
    ]);

    const ultimateHit = result.hits.find(hit => (
        hit.rootSkillId === 'chr_0028_wulfa_ultimate_skill'
        && hit.atkScale > 0
    ));
    assert.deepEqual(ultimateHit?.consumedStatuses?.map(status => [
        status.stateType,
        status.buffId,
        status.consumedStacks,
        status.applicationScope
    ]), [['combo', TEAM_COMBO_BUFF_ID, 1, 'team']]);
    assert.equal(ultimateHit?.factors?.some(factor => (
        factor.semanticKey === 'combo-damage'
    )), true);
});

test('team combo grant triggers the real weapon listener once and consumes atomically', () => {
    const compiler = new AkeActionCompiler();
    const passive = compiler.compilePassiveEventActions(readJson(
        'reference/public-data/akedata/Json/SkillData/sk_wpn_sword_0012.json'
    ), {
        blackboard: { atk_up2: 0.08, duration: 20, lv: 4, max_stack: 2 }
    });
    const attackBuff = compiler.compileBuff(readJson(
        'reference/public-data/akedata/Json/BuffData/buff_wpn_sword_0012_atk_up.json'
    ));
    const comboBuff = compiler.compileBuff(readJson(
        `reference/public-data/akedata/Json/BuffData/${TEAM_COMBO_BUFF_ID}.json`
    ));
    const listener = {
        buffId: 'test:team-combo:weapon-listener',
        lifeType: 'Infinity',
        blackboard: passive.blackboard,
        abilityEventActions: passive.groups
    };
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'camille', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'ally', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [listener.buffId]: listener,
                [attackBuff.buffId]: attackBuff,
                [comboBuff.buffId]: comboBuff
            }
        }
    });
    runtime.execute({
        type: 'ApplyBuff', buffId: listener.buffId, target: 'Source'
    }, {
        frame: 0, sourceId: 'camille', ownerId: 'camille', targetId: 'enemy'
    });
    runtime.execute({
        type: 'GrantTeamCombo',
        sourceRef: 'Source',
        buffId: TEAM_COMBO_BUFF_ID,
        durationSeconds: 15,
        count: 1,
        sourceKey: 'test:camille-combo'
    }, {
        frame: 3,
        sourceId: 'camille',
        ownerId: 'camille',
        targetId: 'enemy',
        castId: 'cast:camille:combo'
    });

    const activeCombo = runtime.statusEffects.list({
        active: true, buffId: TEAM_COMBO_BUFF_ID
    });
    assert.deepEqual(activeCombo.map(instance => [
        instance.targetId,
        instance.stackCount,
        instance.expireFrame,
        instance.metadata.teamComboGrantId
    ]).sort(), [
        ['ally', 1, 453, activeCombo[0].metadata.teamComboGrantId],
        ['camille', 1, 453, activeCombo[0].metadata.teamComboGrantId]
    ]);
    assert.equal(runtime.context.getAttribute('camille', 'Atk'), 108);
    assert.equal(runtime.context.getAttribute('ally', 'Atk'), 108);

    const consumed = runtime.consumeTeamComboState({
        frame: 20,
        consumerId: 'ally',
        targetId: 'enemy',
        commandType: 'NormalSkill',
        skillType: 'NormalSkill',
        skillId: 'ally_normal_skill',
        castId: 'cast:ally:normal'
    });
    assert.equal(consumed.status, 'Consumed');
    assert.deepEqual(consumed.targetIds.sort(), ['ally', 'camille']);
    assert.equal(runtime.statusEffects.list({
        active: true, buffId: TEAM_COMBO_BUFF_ID
    }).length, 0);
    const comboTransitions = runtime.statusEffects.trace.filter(entry => (
        entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.frame === 20
        && entry.stage === 'StatusEffectFinished'
    ));
    assert.equal(comboTransitions.length, 2);
    assert.deepEqual(comboTransitions.filter(entry => entry.consumption).map(entry => (
        [entry.targetId, entry.consumerId, entry.triggerCommandType]
    )), [['ally', 'ally', 'NormalSkill']]);
    assert.equal(runtime.consumeTeamComboState({
        frame: 21,
        consumerId: 'camille',
        commandType: 'UltimateSkill'
    }).status, 'Empty');
});

test('squad runner consumes a shared combo only after another member starts a legal B or Q', () => {
    const compiler = new AkeActionCompiler();
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        members: [
            { memberId: 'pelica', characterId: 'chr_0004_pelica' },
            { memberId: 'chen', characterId: 'chr_0005_chen' }
        ]
    });
    const comboBuff = compiler.compileBuff(readJson(
        `reference/public-data/akedata/Json/BuffData/${TEAM_COMBO_BUFF_ID}.json`
    ));
    bundle.buffs.set(TEAM_COMBO_BUFF_ID, comboBuff);
    bundle.definitions.buffs[TEAM_COMBO_BUFF_ID] = comboBuff;
    const attackId = bundle.membersById.pelica.roles.normalAttackIds[0];
    const attack = structuredClone(bundle.programs.get(attackId));
    attack.timeline.unshift({
        groupIndex: -1,
        startFrame: 0,
        endFrame: 0,
        actions: [{
            type: 'GrantTeamCombo',
            sourceRef: 'Source',
            buffId: TEAM_COMBO_BUFF_ID,
            durationSeconds: 15,
            count: 1,
            sourceKey: 'test:squad-combo'
        }],
        cleanupActions: []
    });
    bundle.programs.set(attackId, attack);

    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [
            { frame: 0, memberId: 'pelica', commandType: 'Attack' },
            { frame: 120, memberId: 'chen', commandType: 'NormalSkill' }
        ],
        endFrame: 180
    });
    const chenCast = result.commandTrace.find(entry => entry.type === 'CommandExecuted'
        && entry.memberId === 'chen');
    assert.equal(chenCast.commandType, 'NormalSkill');
    const granted = result.statusTrace.filter(entry => entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.stage === 'StatusEffectApplied');
    assert.deepEqual(granted.map(entry => entry.targetId).sort(), [
        'chr_0004_pelica',
        'chr_0005_chen'
    ]);
    const consumed = result.statusTrace.filter(entry => entry.buffId === TEAM_COMBO_BUFF_ID
        && entry.frame === chenCast.frame
        && entry.stage === 'StatusEffectFinished');
    assert.equal(consumed.length, 2);
    assert.deepEqual(consumed.filter(entry => entry.consumption).map(entry => (
        [entry.targetId, entry.consumerId, entry.triggerCommandType]
    )), [['chr_0005_chen', 'chr_0005_chen', 'NormalSkill']]);
    const chenHit = result.damageLog.find(hit => hit.castId === chenCast.castId);
    assert.deepEqual(chenHit?.consumedStatuses?.map(snapshot => [
        snapshot.stateType,
        snapshot.buffId,
        snapshot.consumedStacks,
        snapshot.applicationScope
    ]), [['combo', TEAM_COMBO_BUFF_ID, 1, 'team']]);
});

function comboDamageFixture({ count, commandType, damageDecorateMask = 512 }) {
    const compiler = new AkeActionCompiler({
        semanticMappings,
        capabilities: { damageResolver: true }
    });
    const buffIds = [
        TEAM_COMBO_BUFF_ID,
        'buff_common_affixes_skillimbue',
        'buff_common_affixes_skillimbue_atk'
    ];
    const buffs = Object.fromEntries(buffIds.map(buffId => {
        const definition = compiler.compileBuff(readJson(
            `reference/public-data/akedata/Json/BuffData/${buffId}.json`
        ));
        return [buffId, definition];
    }));
    const comboAttackBuff = buffs.buff_common_affixes_skillimbue_atk;
    for (const buffId of [
        'buff_common_affixes_skillimbue',
        'buff_common_affixes_skillimbue_atk'
    ]) {
        assert.equal(buffs[buffId].compiler.unresolved.some(entry =>
            entry.sourceType === 'SkillAffixAction'
        ), false);
    }
    assert.equal(comboAttackBuff.compiler.unresolved.some(entry => [
        'AKE_ABILITY_EVENT_EMITTER_REQUIRED',
        'AKE_SKILL_SETTING_MISSING',
        'AKE_CONDITION_UNSUPPORTED'
    ].includes(entry.code)), false);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'provider', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'consumer', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                {
                    id: 'enemy', kind: 'Enemy', team: 'enemy', attributes: { Def: 0 },
                    maxHp: 999999, currentHp: 999999
                }
            ],
            buffs
        },
        damageResolver: createAkeDamageResolver()
    });
    const grant = runtime.execute({
        type: 'GrantTeamCombo',
        sourceRef: 'Source',
        count,
        durationSeconds: 15,
        sourceKey: 'test:combo-damage'
    }, {
        frame: 0,
        sourceId: 'provider',
        ownerId: 'provider',
        targetId: 'enemy'
    });
    const skillId = commandType === 'NormalSkill' ? 'consumer_normal' : 'consumer_ultimate';
    const castId = `cast:${commandType}:${count}:${damageDecorateMask}`;
    const context = {
        frame: 10,
        sourceId: 'consumer',
        ownerId: 'consumer',
        targetId: 'enemy',
        skillId,
        rootSkillId: skillId,
        castId,
        commandType,
        skillType: commandType,
        payload: { commandType, skillType: commandType }
    };
    runtime.beginSkillActionLifetimes({
        frame: 10, actorId: 'consumer', skillId, castId
    }, context);
    runtime.execute({
        type: 'TriggerStatusEvent',
        target: 'Source',
        eventType: 'OnBeforeCastSkill'
    }, context);
    const consumed = runtime.consumeTeamComboState({
        frame: 10,
        consumerId: 'consumer',
        targetId: 'enemy',
        skillId,
        castId,
        commandType,
        skillType: commandType
    }, context);
    const resolved = runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{
            damageType: 'Physical',
            damageAttributeType: 'Hp',
            damageDecorateMask,
            scale: 1,
            calculationType: 'SimpleAtkScaleCalculation'
        }]
    }, context);
    const hit = resolved.hits[0];
    const comboZone = hit.modifierSnapshot.attackerZone.zones.find(zone =>
        zone.zoneName === 'ComboCalcZone'
    );
    runtime.finishSkillActionLifetimes({
        frame: 20, actorId: 'consumer', skillId, castId
    }, context);
    return { runtime, grant, consumed, hit, comboZone };
}

test('shared combo enters the real ComboCalcZone for B/Q and clears all layers atomically', () => {
    const expected = {
        NormalSkill: [0.3, 0.45, 0.6, 0.75],
        UltimateSkill: [0.2, 0.3, 0.4, 0.5]
    };
    for (const [commandType, totals] of Object.entries(expected)) {
        totals.forEach((addition, index) => {
            const count = index + 1;
            const { runtime, grant, consumed, hit, comboZone } = comboDamageFixture({
                count,
                commandType
            });
            assert.equal(grant.appliedCount, count);
            assert.equal(consumed.consumedStacks, count);
            assert.equal(runtime.statusEffects.list({
                active: true,
                buffId: TEAM_COMBO_BUFF_ID
            }).length, 0);
            assert.ok(Math.abs(comboZone.addition - addition) < 1e-12);
            assert.ok(Math.abs(hit.finalDamage - 100 * (1 + addition)) < 1e-10);
            assert.deepEqual(hit.consumedStatuses.map(snapshot => ({
                stateType: snapshot.stateType,
                buffId: snapshot.buffId,
                consumedStacks: snapshot.consumedStacks,
                maxStacks: snapshot.maxStacks,
                applicationScope: snapshot.applicationScope,
                sourceStacks: snapshot.sourceStacks
            })), [{
                stateType: 'combo',
                buffId: TEAM_COMBO_BUFF_ID,
                consumedStacks: count,
                maxStacks: 4,
                applicationScope: 'team',
                sourceStacks: [{ sourceId: 'provider', count }]
            }]);
            const comboFactor = hit.factors.find(factor => (
                factor.semanticKey === 'combo-damage'
            ));
            assert.ok(Math.abs(comboFactor.multiplier - (1 + addition)) < 1e-12);
            assert.deepEqual(comboFactor.contributions.map(contribution => ({
                buffId: contribution.buffId,
                sourceCategory: contribution.sourceCategory,
                stackCount: contribution.stackCount,
                displayName: contribution.sourceMetadata?.displayName
            })), [{
                buffId: TEAM_COMBO_BUFF_ID,
                sourceCategory: 'TeamState',
                stackCount: count,
                displayName: '连击'
            }]);
            assert.equal(hit.factorValidation.valid, true);
            assert.equal(runtime.statusEffects.list({ active: true }).some(instance =>
                instance.buffId.includes('skillimbue')
            ), false);
        });
    }
});

test('shared combo caps at four layers and the decorated hit uses the serialized 1.5 scale', () => {
    const capped = comboDamageFixture({
        count: 6,
        commandType: 'NormalSkill'
    });
    assert.equal(capped.grant.appliedCount, 4);
    assert.equal(capped.grant.discardedCount, 2);
    assert.equal(capped.consumed.consumedStacks, 4);
    assert.ok(Math.abs(capped.comboZone.addition - 0.75) < 1e-12);

    const decorated = comboDamageFixture({
        count: 1,
        commandType: 'NormalSkill',
        damageDecorateMask: 256
    });
    assert.ok(Math.abs(decorated.comboZone.addition - 0.45) < 1e-12);
    assert.ok(Math.abs(decorated.hit.finalDamage - 145) < 1e-10);
});
