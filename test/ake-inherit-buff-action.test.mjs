import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const INHERIT_SKILL_IDS = [
    'chr_0017_yvonne_ult_attack2_1',
    'chr_0017_yvonne_ult_attack2_2',
    'chr_0017_yvonne_ult_attack3_1',
    'chr_0017_yvonne_ult_attack3_2',
    'chr_0017_yvonne_ult_attack_end',
    'chr_0025_ardelia_plunging_attack_end',
    'chr_0030_zhuangfy_plunging_attack_end',
    'chr_0035_liino_attack3',
    'chr_0035_liino_attack4',
    'chr_0035_liino_attack5',
    'chr_0035_liino_combo_skill',
    'chr_0035_liino_normal_skill',
    'chr_0035_liino_normal_skill_combo',
    'chr_0035_liino_plunging_attack_end',
    'chr_0035_liino_power_attack'
];

function readSkill(skillId) {
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/SkillData/${skillId}.json`,
        import.meta.url
    ), 'utf8'));
}

function findRawActions(value, type, found = []) {
    if (!value || typeof value !== 'object') return found;
    if (String(value.$type ?? '').includes(type)) found.push(value);
    for (const child of Object.values(value)) findRawActions(child, type, found);
    return found;
}

function findCompiledActions(value, type, found = [], seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return found;
    seen.add(value);
    if (value.type === type) found.push(value);
    for (const child of Object.values(value)) {
        findCompiledActions(child, type, found, seen);
    }
    return found;
}

function actionForBuff(raw, type, buffId) {
    return findRawActions(raw, type).find(action =>
        action.targetBuffId === buffId
        || action.buffs?.some(buff => buff.buffId === buffId)
    );
}

function context(skillId, castId, programExecutionId, frame = 0) {
    return {
        frame,
        sourceId: 'liino',
        ownerId: 'liino',
        targetId: 'enemy',
        skillId,
        rootSkillId: skillId,
        castId,
        programExecutionId,
        clockDomainId: 'liino:clock',
        blackboard: {
            music_duration: 10,
            atk_scale_3: 1,
            heal_value: 0,
            heal_rate: 0
        }
    };
}

test('all 52 public InheritBuffAction instances compile to transferable action leases', () => {
    let rawCount = 0;
    let inheritCount = 0;
    let releaseCount = 0;
    for (const skillId of INHERIT_SKILL_IDS) {
        const raw = readSkill(skillId);
        rawCount += findRawActions(raw, 'InheritBuffAction').length;
        const compiled = new AkeActionCompiler().compileSkill(raw);
        assert.equal(compiled.compiler.unresolved.some(item =>
            item.sourceType === 'InheritBuffAction'
        ), false, `${skillId} should not retain an InheritBuffAction compiler gap`);
        inheritCount += findCompiledActions(
            compiled,
            'InheritBuffActionLifetime'
        ).length;
        releaseCount += findCompiledActions(
            compiled,
            'ReleaseBuffActionLifetime'
        ).filter(action => action.reason?.startsWith('InheritBuffAction')).length;
    }
    assert.equal(rawCount, 52);
    assert.equal(inheritCount, rawCount);
    assert.equal(releaseCount, rawCount);
});

test('real Liino Buff keeps one instance while successive skills transfer its owner lease', () => {
    const buffId = 'buff_chr_0035_liino_normalskill_music_damage';
    const compiler = new AkeActionCompiler();
    const createRaw = actionForBuff(
        readSkill('chr_0035_liino_normal_skill'),
        'CreateBuffAction',
        buffId
    );
    const inheritRaw = actionForBuff(
        readSkill('chr_0035_liino_combo_skill'),
        'InheritBuffAction',
        buffId
    );
    assert.ok(createRaw);
    assert.ok(inheritRaw);
    const create = compiler.compileAction(createRaw, {
        scope: 'skill',
        path: 'fixture.liino.normal.create-music-damage'
    });
    const inherit = compiler.compileAction(inheritRaw, {
        scope: 'skill',
        path: 'fixture.liino.combo.inherit-music-damage'
    });
    assert.equal(create.actions[0].actionLifetime.inheritSkillIds.includes(
        'chr_0035_liino_combo_skill'
    ), true);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'liino',
                    kind: 'Character',
                    team: 'ally',
                    clockDomainId: 'liino:clock'
                },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [buffId]: { lifeType: 'Infinity' } }
        }
    });
    const normalContext = context(
        'chr_0035_liino_normal_skill',
        'cast:normal',
        'execution:normal'
    );
    runtime.execute(create.actions, normalContext);
    let active = runtime.statusEffects.list({ active: true, buffId })[0];
    const originalInstanceId = active.instanceId;
    assert.equal(active.actionLifetime.ownerCastId, 'cast:normal');

    runtime.execute(create.cleanupActions, { ...normalContext, frame: 60 });
    active = runtime.statusEffects.list({ active: true, buffId })[0];
    assert.equal(active.actionLifetime.awaitingInheritance, true);

    const comboContext = context(
        'chr_0035_liino_combo_skill',
        'cast:combo',
        'execution:combo',
        61
    );
    runtime.beginSkillActionLifetimes({
        frame: 61,
        actorId: 'liino',
        skillId: comboContext.skillId,
        castId: comboContext.castId,
        programExecutionId: comboContext.programExecutionId
    }, comboContext);
    active = runtime.statusEffects.list({ active: true, buffId })[0];
    assert.equal(active.actionLifetime.candidateCastId, 'cast:combo');

    runtime.execute(inherit.actions, comboContext);
    active = runtime.statusEffects.list({ active: true, buffId })[0];
    assert.equal(active.instanceId, originalInstanceId,
        'inheritance transfers ownership instead of copying the Buff');
    assert.equal(active.actionLifetime.ownerCastId, 'cast:combo');
    assert.equal(active.actionLifetime.awaitingInheritance, false);
    assert.deepEqual(active.actionLifetime.inheritSkillIds, [
        'chr_0035_liino_normal_skill_combo'
    ]);

    runtime.execute(inherit.cleanupActions, { ...comboContext, frame: 120 });
    assert.equal(runtime.statusEffects.has({ targetId: 'liino', buffId }), true);
    runtime.beginSkillActionLifetimes({
        frame: 121,
        actorId: 'liino',
        skillId: 'skill.not-in-whitelist',
        castId: 'cast:other',
        programExecutionId: 'execution:other'
    }, context('skill.not-in-whitelist', 'cast:other', 'execution:other', 121));
    assert.equal(runtime.statusEffects.has({ targetId: 'liino', buffId }), false,
        'a non-inherited next skill must close the previous action-owned Buff');
});

test('old action cleanup cannot finish a Buff already claimed by a newer skill', () => {
    const buffId = 'buff.fixture.action-owned';
    const compiler = new AkeActionCompiler();
    const first = compiler.compileAction({
        $type: 'Beyond.Gameplay.Core.CreateBuffAction+Data, Gameplay.Beyond',
        buffs: [{ buffId, assignBlackboard: false, assignItems: [] }],
        count: { value: 1 },
        targetSettings: { targetSource: 'Source' },
        autoFinishByAction: true,
        inheritSkillIdList: ['skill.second'],
        finishWithNextSkillIfNotInherited: true
    }, { scope: 'skill', path: 'fixture.first' });
    const second = compiler.compileAction({
        $type: 'Beyond.Gameplay.Core.CreateBuffAction+Data, Gameplay.Beyond',
        buffs: [{ buffId, assignBlackboard: false, assignItems: [] }],
        count: { value: 1 },
        targetSettings: { targetSource: 'Source' },
        autoFinishByAction: true,
        inheritSkillIdList: [],
        finishWithNextSkillIfNotInherited: true
    }, { scope: 'skill', path: 'fixture.second' });
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'liino', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [buffId]: { lifeType: 'Infinity' } }
        }
    });
    const firstContext = context('skill.first', 'cast:first', 'execution:first');
    runtime.execute(first.actions, firstContext);
    const secondContext = context('skill.second', 'cast:second', 'execution:second', 10);
    runtime.beginSkillActionLifetimes({
        frame: 10,
        actorId: 'liino',
        skillId: 'skill.second',
        castId: 'cast:second',
        programExecutionId: 'execution:second'
    }, secondContext);
    runtime.execute(second.actions, secondContext);

    runtime.execute(first.cleanupActions, { ...firstContext, frame: 11 });
    let active = runtime.statusEffects.list({ active: true, buffId })[0];
    assert.ok(active);
    assert.equal(active.actionLifetime.ownerCastId, 'cast:second');
    assert.equal(runtime.statusEffects.trace.some(entry =>
        entry.stage === 'StatusEffectActionLifetimeReleaseIgnored'
        && entry.requestedLeaseId.includes('execution:first')
    ), true);

    runtime.execute(second.cleanupActions, { ...secondContext, frame: 12 });
    active = runtime.statusEffects.list({ active: true, buffId })[0];
    assert.equal(active, undefined);
});

test('an allowed next skill that never claims the offered Buff closes it at skill end', () => {
    const buffId = 'buff.fixture.unclaimed';
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'liino', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: { [buffId]: { lifeType: 'Infinity' } }
        }
    });
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Source',
        buffId,
        actionLifetime: {
            leaseKey: 'fixture:unclaimed',
            inheritSkillIds: ['skill.allowed'],
            finishByAction: true,
            finishWithNextSkillIfNotInherited: true
        }
    }, context('skill.source', 'cast:source', 'execution:source'));
    const allowedContext = context(
        'skill.allowed',
        'cast:allowed',
        'execution:allowed',
        10
    );
    runtime.beginSkillActionLifetimes({
        frame: 10,
        actorId: 'liino',
        skillId: 'skill.allowed',
        castId: 'cast:allowed',
        programExecutionId: 'execution:allowed'
    }, allowedContext);
    assert.equal(runtime.statusEffects.has({ targetId: 'liino', buffId }), true);

    runtime.finishSkillActionLifetimes({
        frame: 20,
        actorId: 'liino',
        skillId: 'skill.allowed',
        castId: 'cast:allowed'
    }, { ...allowedContext, frame: 20 });
    assert.equal(runtime.statusEffects.has({ targetId: 'liino', buffId }), false);
});
