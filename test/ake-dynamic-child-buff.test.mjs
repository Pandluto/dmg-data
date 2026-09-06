import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { parseBlackboard, parseSkill } from '../src/core/ake-parser.mjs';

const readBuff = id => JSON.parse(readFileSync(new URL(
    `../reference/public-data/akedata/Json/BuffData/${id}.json`, import.meta.url
), 'utf8'));

test('serialized Blackboard strings retain their type beside the numeric zero slot', () => {
    const id = 'buff_common_affixes_vulnerable_spell';
    const raw = readBuff(id);
    const { values, lineage } = parseBlackboard(raw.blackboard);
    assert.equal(values.child_buff_id, `${id}_default_child`);
    assert.equal(lineage.child_buff_id[0].value, `${id}_default_child`);
    assert.equal(values.rate, 0.2);
    assert.equal(parseBlackboard([{ key: 'zero', valueDouble: 0, valueStr: '' }]).values.zero, 0);
    const skill = parseSkill({ id: 'fixture', blackboard: [] }, {
        SkillPatchDataBundle: [{ level: 1, blackboard: [{
            key: 'child_buff_id', value: 0, valueStr: 'buff.override'
        }] }]
    }, { level: 1 });
    assert.equal(skill.blackboard.child_buff_id, 'buff.override');
});

test('real Tangtang vulnerability retains its parent lifetime and resolves the display child', () => {
    const parentId = 'buff_chr_0027_tangtang_normalskill_spellvulnerable';
    const commonId = 'buff_common_affixes_vulnerable_spell';
    const childId = `${commonId}_default_child`;
    const compiler = new AkeActionCompiler({ capabilities: { dynamicBuffIdResolver: true } });
    const buffs = Object.fromEntries([parentId, commonId, childId,
        'buff_common_vfx_eny_def_down'].map(id => [id, compiler.compileBuff(readBuff(id))]));
    const runtime = new CombatRuntime({ definitions: {
        entities: [{ id: 'operator', kind: 'Character', team: 'ally' },
            { id: 'enemy', kind: 'Enemy', team: 'enemy', attributes: {
                CrystVulnerableDmgIncrease: 0, PhysicalVulnerableDmgIncrease: 0
            } }], buffs
    } });
    runtime.execute({ type: 'ApplyBuff', buffId: parentId, target: 'Target',
        blackboard: { duration_spellvulnerable: 15, rate_spellvulnerable: 0.2 }
    }, { frame: 126, sourceId: 'operator', ownerId: 'operator', targetId: 'enemy' });
    runtime.runUntil(127);
    assert.equal(runtime.statusEffects.trace.some(e => e.stage === 'StatusEffectUnresolved'), false);
    const parent = runtime.statusEffects.list({ active: true, buffId: parentId })[0];
    const common = runtime.statusEffects.list({ active: true, buffId: commonId })[0];
    const child = runtime.statusEffects.list({ active: true, buffId: childId })[0];
    assert.ok(common, 'the real vulnerability must not expire at its application frame');
    assert.equal(parent.blackboard.real_duration, 15);
    assert.equal(common.expireFrame, 576);
    assert.equal(common.metadata.parentBuffInstanceId, parent.instanceId);
    assert.equal(child.metadata.parentBuffInstanceId, common.instanceId);
    assert.equal(runtime.context.getAttribute('enemy', 'CrystVulnerableDmgIncrease'), 0.2);
    assert.equal(runtime.context.getAttribute('enemy', 'PhysicalVulnerableDmgIncrease'), 0);
    runtime.runUntil(575);
    assert.equal(runtime.context.getAttribute('enemy', 'CrystVulnerableDmgIncrease'), 0.2);
    runtime.runUntil(576);
    assert.equal(runtime.context.getAttribute('enemy', 'CrystVulnerableDmgIncrease'), 0);
    assert.equal(runtime.statusEffects.has({ targetId: 'enemy', buffId: childId }), false);
});

test('Environment lifetime reads the callback instance and preserves paused remaining time', () => {
    const raw = readBuff('buff_chr_0027_tangtang_normalskill_spellvulnerable')
        .buffEventAction[0].actions[0].actionData[0];
    const compiled = new AkeActionCompiler().compileAction(raw, { scope: 'buff' });
    const runtime = new CombatRuntime({ definitions: {
        entities: [{ id: 'operator', kind: 'Character', team: 'ally' }],
        buffs: { 'buff.fixture': { lifeType: 'Limited', durationSeconds: 3 } }
    } });
    const context = { frame: 0, sourceId: 'operator', ownerId: 'operator', targetId: 'operator' };
    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.fixture' }, context);
    const instance = runtime.statusEffects.list({ active: true })[0];
    const remaining = frame => runtime.execute(compiled.actions[0], {
        ...context, frame, buffInstanceId: instance.instanceId
    }).after;
    runtime.runUntil(30);
    assert.equal(remaining(30), 2);
    runtime.statusEffects.setTimePaused({ instanceId: instance.instanceId, frame: 30, isPaused: true });
    runtime.runUntil(120);
    assert.equal(remaining(120), 2);
    runtime.statusEffects.setTimePaused({ instanceId: instance.instanceId, frame: 120, isPaused: false });
    runtime.runUntil(150);
    assert.equal(remaining(150), 1);
    runtime.runUntil(180);
    assert.equal(remaining(180), 0);
});

test('CreateBuffAction retains a runtime Blackboard Buff id and its static dependency', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { dynamicBuffIdResolver: true }
    });
    const compiled = compiler.compileActions([{
        $type: 'Beyond.Gameplay.Core.CreateBuffAction+Data, Gameplay.Beyond',
        buffs: [{
            buffId: '',
            readIdFromBlackboard: true,
            buffIdKey: 'child_buff_id',
            assignBlackboard: false,
            assignItems: []
        }],
        targetSettings: { targetSource: 'Owner' },
        asChildBuff: true,
        autoFinishByAction: true
    }], {
        blackboard: { child_buff_id: 'buff.child.default' },
        scope: 'buff'
    });

    assert.equal(compiled.status, 'executable');
    assert.deepEqual(compiled.actions[0].buffs[0], {
        buffId: 'buff.child.default',
        buffIdBlackboardKey: 'child_buff_id',
        assignBlackboard: false,
        assignments: []
    });
    assert.equal(compiled.actions[0].asChildBuff, true);
    assert.equal(compiled.cleanupActions[0].childOfCurrentBuff, true);
});

test('dynamic child Buff resolves its id and cascades only with its parent instance', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'operator', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                'buff.parent': {
                    lifeType: 'Infinity',
                    duringEnableActions: [{
                        type: 'ApplyBuff',
                        target: 'Owner',
                        asChildBuff: true,
                        buffs: [{
                            buffId: 'buff.child.default',
                            buffIdBlackboardKey: 'child_buff_id'
                        }]
                    }]
                },
                'buff.child.default': { lifeType: 'Infinity' },
                'buff.child.override': { lifeType: 'Infinity' }
            }
        }
    });
    const context = {
        frame: 0,
        sourceId: 'operator',
        ownerId: 'operator',
        targetId: 'enemy'
    };

    runtime.execute({
        type: 'ApplyBuff',
        buffId: 'buff.parent',
        blackboard: { child_buff_id: 'buff.child.override' }
    }, context);
    const parent = runtime.statusEffects.list({
        active: true, buffId: 'buff.parent'
    })[0];
    const child = runtime.statusEffects.list({
        active: true, buffId: 'buff.child.override'
    })[0];
    assert.equal(child.metadata.parentBuffInstanceId, parent.instanceId);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.child.default'
    }), false);

    runtime.statusEffects.finish({
        frame: 1,
        instanceId: parent.instanceId,
        reason: 'fixture-parent-finish'
    }, { ...context, frame: 1 });
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.child.override'
    }), false);
});
