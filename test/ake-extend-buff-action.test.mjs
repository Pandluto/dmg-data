import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const TARGET_BUFF = 'buff_chr_0030_zhuangfy_ult_base';
const EXTEND_ACTION_SOURCES = [{
    kind: 'buff',
    id: 'buff_chr_0030_zhuangfy_air_attack_ult_extend_buff'
}, ...[
    'chr_0030_zhuangfy_attack1_ult',
    'chr_0030_zhuangfy_attack2_ult',
    'chr_0030_zhuangfy_attack3_ult',
    'chr_0030_zhuangfy_combo_skill_ult',
    'chr_0030_zhuangfy_normal_skill_ult'
].map(id => ({ kind: 'skill', id }))];

function readAke(kind, id) {
    const directory = kind === 'buff' ? 'BuffData' : 'SkillData';
    return JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/${directory}/${id}.json`,
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

test('all public ExtendBuffAction shapes compile to reference-counted expiry leases', () => {
    const compiler = new AkeActionCompiler();
    for (const source of EXTEND_ACTION_SOURCES) {
        const raw = readAke(source.kind, source.id);
        const definition = source.kind === 'buff'
            ? compiler.compileBuff(raw)
            : compiler.compileSkill(raw);
        assert.equal(definition.compiler.unresolved.some(item =>
            item.sourceType === 'ExtendBuffAction'
        ), false, `${source.id} should not retain an ExtendBuffAction compiler gap`);

        const holds = findCompiledActions(definition, 'SetBuffExpiryHeld');
        assert.equal(holds.some(action => action.isHeld === true), true);
        assert.equal(holds.some(action => action.isHeld === false), true);
        assert.equal(holds.every(action => action.buffIds.includes(TARGET_BUFF)), true);
    }

    const targetDefinition = compiler.compileBuff(readAke('buff', TARGET_BUFF));
    assert.deepEqual(targetDefinition.extendTagIds, [-1486085048, -496376350]);
    assert.deepEqual(targetDefinition.persistentExtendTags, [
        'ake-tag:-1486085048',
        'ake-tag:-496376350'
    ]);
});

test('overlapping ExtendBuffAction leases hold only expiry and activate after-extend tags', () => {
    const rawAction = findRawActions(
        readAke('skill', 'chr_0030_zhuangfy_attack1_ult'),
        'ExtendBuffAction'
    )[0];
    const compiled = new AkeActionCompiler().compileAction(rawAction, {
        scope: 'skill',
        path: 'fixture.timeline.extend'
    });
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: 'zhuangfy',
                kind: 'Character',
                team: 'ally'
            }],
            buffs: {
                [TARGET_BUFF]: {
                    durationTicks: 10,
                    triggerIntervalTicks: 2,
                    waitFirstTriggerInterval: true,
                    tagIds: [100],
                    extendTagIds: [200],
                    persistentTags: ['ake-tag:100'],
                    persistentExtendTags: ['ake-tag:200'],
                    duringEnableActions: [{
                        type: 'ApplyEffectSource',
                        target: 'Target',
                        sourceType: 'StatusEffect',
                        tags: ['ake-tag:100']
                    }],
                    endActions: [{
                        type: 'RemoveEffectSource',
                        target: 'Target',
                        sourceType: 'StatusEffect'
                    }]
                }
            }
        }
    });
    runtime.execute({ type: 'ApplyBuff', buffId: TARGET_BUFF }, {
        frame: 0,
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy',
        skillId: 'chr_0030_zhuangfy_ultimate_skill',
        castId: 'cast:ultimate'
    });
    assert.equal(runtime.context.hasTag('zhuangfy', 'ake-tag:100'), true);
    assert.equal(runtime.context.hasTag('zhuangfy', 'ake-tag:200'), false);

    runtime.execute(compiled.actions, {
        frame: 1,
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy',
        skillId: 'chr_0030_zhuangfy_attack1_ult',
        castId: 'cast:attack-a'
    });
    runtime.execute(compiled.actions, {
        frame: 2,
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy',
        skillId: 'chr_0030_zhuangfy_attack2_ult',
        castId: 'cast:attack-b'
    });
    assert.equal(runtime.context.hasTag('zhuangfy', 'ake-tag:200'), true);

    runtime.runUntil(20);
    let active = runtime.statusEffects.list({ active: true, buffId: TARGET_BUFF })[0];
    assert.ok(active, 'the original ten-frame Buff must survive while expiry is held');
    assert.equal(active.expiryHoldLeaseIds.length, 2);
    assert.equal(active.triggerCount > 5, true,
        'ExtendBuffAction must not pause periodic Buff behavior');

    runtime.execute(compiled.cleanupActions, {
        frame: 20,
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy',
        skillId: 'chr_0030_zhuangfy_attack1_ult',
        castId: 'cast:attack-a'
    });
    active = runtime.statusEffects.list({ active: true, buffId: TARGET_BUFF })[0];
    assert.equal(active.expiryHoldLeaseIds.length, 1);
    assert.equal(active.expireFrame, null, 'one remaining lease must keep expiry held');

    runtime.execute(compiled.cleanupActions, {
        frame: 22,
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy',
        skillId: 'chr_0030_zhuangfy_attack2_ult',
        castId: 'cast:attack-b'
    });
    active = runtime.statusEffects.list({ active: true, buffId: TARGET_BUFF })[0];
    assert.equal(active.expiryHoldLeaseIds.length, 0);
    assert.equal(active.expireFrame, 31,
        'the nine ticks remaining at the first hold must resume from final release');

    runtime.runUntil(30);
    assert.equal(runtime.statusEffects.has({ targetId: 'zhuangfy', buffId: TARGET_BUFF }), true);
    runtime.runUntil(31);
    assert.equal(runtime.statusEffects.has({ targetId: 'zhuangfy', buffId: TARGET_BUFF }), false);
    assert.equal(runtime.context.hasTag('zhuangfy', 'ake-tag:200'), false,
        'after-extend tags must be removed with the target Buff effect source');
});
