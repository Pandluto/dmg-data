import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';

const readJson = relativePath => JSON.parse(readFileSync(new URL(
    `../reference/public-data/akedata/Json/${relativePath}`,
    import.meta.url
), 'utf8'));

function shortType(node) {
    const raw = node?.$type;
    if (typeof raw !== 'string') return null;
    return raw.split(',', 1)[0].split('+', 1)[0].split('.').at(-1);
}

function findNodes(root, type) {
    const found = [];
    const visit = value => {
        if (value === null || typeof value !== 'object') return;
        if (shortType(value) === type) found.push(value);
        if (Array.isArray(value)) value.forEach(visit);
        else Object.values(value).forEach(visit);
    };
    visit(root);
    return found;
}

function findRuntimeActions(root, predicate) {
    const found = [];
    const visit = value => {
        if (value === null || typeof value !== 'object') return;
        if (!Array.isArray(value) && typeof value.type === 'string' && predicate(value)) {
            found.push(value);
        }
        if (Array.isArray(value)) value.forEach(visit);
        else Object.values(value).forEach(visit);
    };
    visit(root);
    return found;
}

test('AKE condition lists preserve Not-next and nested Or algebra', () => {
    const compiler = new AkeActionCompiler();
    const endministrator = compiler.compileSkill(readJson(
        'SkillData/chr_0002_endminm_normal_skill.json'
    ));
    assert.equal(endministrator.compiler.unresolved.some(entry => (
        entry.sourceType === 'NotNextCheckAction'
    )), false);
    assert.match(JSON.stringify(endministrator.timeline), /"type":"Not"/);

    const mifu = compiler.compileBuff(readJson('BuffData/buff_chr_0031_mifu_passive.json'));
    assert.equal(mifu.compiler.unresolved.some(entry => [
        'OrConditionAction',
        'CheckPoiseValue'
    ].includes(entry.sourceType)), false);
    assert.equal(mifu.persistentDamageModifiers[0].conditions[1].type, 'Any');
    assert.deepEqual(
        mifu.persistentDamageModifiers[0].conditions[1].conditions.map(entry => entry.type),
        ['PoiseCompare', 'BuffStackCompare']
    );
});

test('source-backed entity, target-set, super-armor and poise predicates execute generically', () => {
    const compiler = new AkeActionCompiler();
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'actor',
                    kind: 'Character',
                    team: 'ally',
                    metadata: { isMainCharacter: true }
                },
                {
                    id: 'enemy',
                    kind: 'Enemy',
                    team: 'enemy',
                    resilience: {
                        maxResilience: 0,
                        initialResilience: 0,
                        superArmorLevel: 30
                    },
                    poise: {
                        enabled: true,
                        maxPoise: 100,
                        recoverySeconds: 2,
                        executionDamageScalar: 1,
                        executionAtbGain: 0,
                        brokenDamageScale: 1
                    }
                }
            ]
        }
    });
    const context = {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'enemy',
        blackboard: { __akeTargetGroups: { tar: ['enemy'] } },
        payload: {}
    };
    const objectType = findNodes(
        readJson('BuffData/buff_chr_0009_azrila_talent_2.json'),
        'CheckObjectTypeMatch'
    )[0];
    const targetContains = findNodes(
        readJson('BuffData/buff_eny_0077_agshield_skill01_counter.json'),
        'CheckTargetContains'
    )[0];
    const superArmor = findNodes(
        readJson('SkillData/chr_0031_mifu_normalskill_1.json'),
        'CheckSuperArmor'
    ).find(node => node.compareType === 'GE' && Number(node.value?.value) === 30);
    const poise = findNodes(
        readJson('BuffData/buff_chr_0004_pelica_talent_0.json'),
        'CheckPoiseValue'
    )[0];

    for (const rawCondition of [objectType, targetContains, superArmor]) {
        const compiled = compiler.compileCondition(rawCondition);
        assert.deepEqual(compiled.unresolved, []);
        assert.equal(runtime.effects.evaluate(compiled.condition, context), true);
    }
    const poiseCondition = compiler.compileCondition(poise).condition;
    assert.equal(runtime.effects.evaluate(poiseCondition, context), false);
    runtime.poise.applyDamage({ targetId: 'enemy', frame: 0, amount: 100 });
    assert.equal(runtime.effects.evaluate(poiseCondition, context), true);
});

test('custom ability events carry their name and parameter through a real producer edge', () => {
    const compiler = new AkeActionCompiler();
    const triggerRaw = findNodes(readJson(
        'BuffData/buff_chr_0032_lizhiyan_combo_skill_seal_finisher_wisd.json'
    ), 'TriggerCustomAbilityEvent')[0];
    const receiverRaw = structuredClone(findNodes(readJson(
        'BuffData/buff_chr_0032_lizhiyan_train_combo_wisd_check.json'
    ), 'CheckCustomAbilityEvent')[0]);
    receiverRaw.savedParamKey = 'captured_event_param';
    const trigger = compiler.compileAction(triggerRaw).actions[0];
    const condition = compiler.compileCondition(receiverRaw).condition;
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'actor', kind: 'Character', team: 'ally' }],
            buffs: {
                'buff.custom-listener': {
                    lifeType: 'Infinity',
                    abilityEventActions: [{
                        eventType: 'OnCustomAbilityEvent',
                        actions: [{
                            type: 'IfElseAction',
                            conditions: [condition],
                            success: [],
                            failure: []
                        }]
                    }]
                }
            }
        }
    });
    const context = {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'actor',
        blackboard: {},
        payload: {}
    };
    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.custom-listener' }, context);
    const result = runtime.execute(trigger, context);

    assert.equal(result.length, 1);
    const listener = runtime.statusEffects.list({
        active: true,
        buffId: 'buff.custom-listener'
    })[0];
    assert.equal(Object.hasOwn(listener.blackboard, 'captured_event_param'), true);
    assert.equal(listener.blackboard.captured_event_param, 0);
});

test('damage tags and main-character validators survive AKE compilation', () => {
    const compiler = new AkeActionCompiler({ capabilities: { damageResolver: true } });
    const taggedSkill = readJson(
        'SkillData/chr_0034_typhoea_floating_attack5_01_projhit.json'
    );
    const taggedDamage = findNodes(taggedSkill, 'DamageAction')
        .map(node => compiler.compileAction(node))
        .flatMap(compiled => compiled.actions)
        .find(action => action.type === 'ResolveDamagePacket'
            && action.damageUnits.some(unit => unit.damageTagIds.length > 0));
    assert.ok(taggedDamage);
    assert.ok(taggedDamage.damageUnits.some(unit => unit.damageTagIds.includes(959424907)));

    const damageTagRaw = findNodes(readJson(
        'BuffData/buff_chr_0034_typhoea_ultimate_skill_cause_subarrowrain.json'
    ), 'CheckDamageTag')[0];
    const damageTag = compiler.compileCondition(damageTagRaw);
    const runtime = new CombatRuntime({
        definitions: { entities: [{ id: 'actor', kind: 'Character', team: 'ally' }] }
    });
    assert.equal(runtime.effects.evaluate(damageTag.condition, {
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'actor',
        payload: { damageTagIds: [959424907] }
    }), true);

    const ardelia = compiler.compileSkill(readJson(
        'SkillData/chr_0025_ardelia_combo_skill.json'
    ));
    const mainCharacterFinder = findRuntimeActions(ardelia.timeline, action => (
        action.type === 'FindTargets' && action.onlyMainCharacter === true
    ))[0];
    assert.ok(mainCharacterFinder);
});

test('per-target channel cadence throttles the one explicit target', () => {
    const runtime = new CombatRuntime({
        definitions: { entities: [{ id: 'actor', kind: 'Character', team: 'ally' }] }
    });
    const scheduled = runtime.scheduleIntervalActions({
        actions: [{ type: 'ModifyBlackboard', key: 'ticks', operation: 'Add', value: 1 }],
        intervalTicks: 1,
        targetIntervalSeconds: 0.1,
        durationTicks: 12,
        includeStart: true,
        maxExecutions: 3
    }, {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'actor',
        blackboard: {}
    });
    runtime.runUntil(12);

    assert.equal(scheduled.sourceIntervalTicks, 1);
    assert.equal(scheduled.targetIntervalTicks, 3);
    assert.deepEqual(scheduled.tickOffsets, [0, 3, 6]);
    assert.deepEqual(runtime.trace.filter(entry => (
        entry.stage === 'SkillProgramIntervalTickExecuted'
    )).map(entry => entry.frame), [0, 3, 6]);
});

test('marker ability entities exist without child SkillData and keep mutable lifecycle state', () => {
    const compiler = new AkeActionCompiler();
    const spawnRaw = findNodes(readJson(
        'BuffData/buff_chr_0030_zhuangfy_normal_skill_trigger_sword_tar.json'
    ), 'SpawnAbilityEntity').find(node => node.abilityEntitySkillId === '');
    const durationRaw = findNodes(readJson(
        'SkillData/chr_0030_zhuangfy_normal_skill.json'
    ), 'SetAbilityEntityDuration')[0];
    const targetRaw = findNodes(readJson(
        'SkillData/chr_0033_camille_normal_skill_projhit_sub.json'
    ), 'SetAbilityEntityTarget')[0];
    const durationConditionRaw = findNodes(readJson(
        'SkillData/chr_0030_zhuangfy_normal_skill_ult.json'
    ), 'CheckAbilityEntityCurDuration')[0];
    const spawn = compiler.compileAction(spawnRaw);
    const duration = compiler.compileAction(durationRaw);
    const target = compiler.compileAction(targetRaw);
    const durationCondition = compiler.compileCondition(durationConditionRaw);
    assert.equal(spawn.status, 'executable');
    assert.deepEqual(spawn.unresolved, []);
    assert.equal(duration.status, 'executable');
    assert.equal(target.status, 'executable');
    assert.deepEqual(durationCondition.unresolved, []);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ]
        }
    });
    const context = {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'enemy',
        skillId: 'skill.parent',
        rootSkillId: 'skill.parent',
        castId: 'cast.parent',
        blackboard: {},
        payload: {}
    };
    const spawned = runtime.execute(spawn.actions[0], context);
    const entityId = spawned.spawnedAbilityEntityId;
    assert.equal(spawned.status, 'Spawned');
    assert.equal(runtime.context.getEntity(entityId).ownerId, 'actor');
    assert.equal(runtime.context.getEntity(entityId).metadata.abilityEntityActive, true);

    runtime.execute(target.actions[0], {
        ...context,
        ownerId: entityId,
        targetId: 'enemy'
    });
    assert.equal(runtime.context.getEntity(entityId).metadata.abilityEntityTargetId, 'enemy');
    assert.equal(runtime.effects.evaluate(durationCondition.condition, {
        ...context,
        targetId: entityId
    }), true);
    runtime.execute(duration.actions[0], { ...context, targetId: entityId });
    assert.equal(runtime.effects.evaluate(durationCondition.condition, {
        ...context,
        targetId: entityId
    }), false);
    assert.equal(runtime.effects.evaluate(durationCondition.condition, {
        ...context,
        frame: 1,
        targetId: entityId
    }), true);
    runtime.runUntil(89);
    assert.equal(runtime.context.hasTag(entityId, 'ake-ability-entity-inactive'), false);
    runtime.runUntil(90);
    assert.equal(runtime.context.hasTag(entityId, 'ake-ability-entity-inactive'), true);
});

test('profession, skill-hit and interrupt predicates use runtime facts', () => {
    const compiler = new AkeActionCompiler();
    const professionRaw = findNodes(readJson(
        'BuffData/buff_chr_0013_aglina_talent_0_effectbuff.json'
    ), 'CheckProfession')[0];
    const skillHitRaw = findNodes(readJson(
        'SkillData/chr_0031_mifu_combo_skill.json'
    ), 'CheckSkillHasHit')[0];
    const interruptRaw = findNodes(readJson(
        'BuffData/buff_chr_0034_typhoea_floatingmode.json'
    ), 'CheckSkillInterruptReason')[0];
    const profession = compiler.compileCondition(professionRaw);
    const skillHit = compiler.compileCondition(skillHitRaw);
    const interrupt = compiler.compileCondition(interruptRaw);
    assert.deepEqual(profession.unresolved, []);
    assert.deepEqual(skillHit.unresolved, []);
    assert.deepEqual(interrupt.unresolved, []);

    const assembled = new AkeScenarioAssembler().assemble({
        characterId: 'chr_0013_aglina',
        enemyId: 'eny_0007_mimicw'
    });
    const character = assembled.definitions.entities.find(entity => (
        entity.id === 'chr_0013_aglina'
    ));
    assert.equal(character.metadata.akeProfession, 'Supporter');

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                character,
                {
                    id: 'enemy',
                    kind: 'Enemy',
                    team: 'enemy',
                    vital: { maxHp: 10, currentHp: 10 }
                }
            ]
        },
        damageResolver: () => ({
            status: 'Applied',
            hits: [{
                amount: 1,
                damageUnitIndex: 0,
                damageAttributeType: 'Hp'
            }]
        })
    });
    const context = {
        frame: 0,
        sourceId: character.id,
        ownerId: character.id,
        targetId: 'enemy',
        skillId: 'skill.fixture',
        rootSkillId: 'skill.fixture',
        castId: 'cast.fixture',
        rootCastId: 'cast.fixture',
        blackboard: {},
        payload: {}
    };
    assert.equal(runtime.effects.evaluate(profession.condition, {
        ...context,
        targetId: character.id
    }), true);
    assert.equal(runtime.effects.evaluate(skillHit.condition, context), false);
    runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{}]
    }, context);
    assert.equal(runtime.effects.evaluate(skillHit.condition, context), true);
    assert.equal(runtime.effects.evaluate(interrupt.condition, {
        ...context,
        payload: { skillEndReason: 'CastNextSkill' }
    }), true);
});
