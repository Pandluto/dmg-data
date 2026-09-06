import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const raw = JSON.parse(readFileSync(new URL(
    '../reference/public-data/akedata/Json/SkillData/chr_0027_tangtang_combo_skill_water.json',
    import.meta.url
), 'utf8'));
const compiler = new AkeActionCompiler();
const water = compiler.compileSkill(raw);
const wake = 'buff_chr_0027_tangtang_water_wake';

function setup() {
    const runtime = new CombatRuntime({ definitions: {
        entities: [
            { id: 'source', kind: 'Character', team: 'ally' },
            { id: 'one', kind: 'Object', ownerId: 'source', team: 'ally' },
            { id: 'two', kind: 'Object', ownerId: 'source', team: 'ally' },
            { id: 'enemy', kind: 'Enemy', team: 'enemy' }
        ],
        buffs: { [wake]: { lifeType: 'Infinity', stackingPolicy: 'Unique' } }
    } });
    // Exercise the actual serialized wait/return phases without unrelated
    // projectile and aura services: each water must wait on its own carrier.
    const program = { ...water, timeline: water.timeline.filter(group =>
        [5, 6, 7, 8, 9].includes(group.groupIndex)) };
    const scheduled = ['one', 'two'].map(ownerId => runtime.scheduleProgram(program, {
        frame: 0, sourceId: 'source', ownerId, targetId: 'enemy'
    }));
    return { runtime, scheduled };
}

test('real water conditional jumps wait for a later wake and remain isolated per entity', () => {
    const { runtime } = setup();
    runtime.runUntil(39);
    assert.equal(runtime.context.hasTag('one', 'ake-ability-entity-inactive'), false);
    assert.equal(runtime.context.hasTag('two', 'ake-ability-entity-inactive'), false);
    runtime.execute({ type: 'ApplyBuff', target: 'one', buffId: wake }, {
        frame: 40, sourceId: 'source', ownerId: 'source', targetId: 'one'
    });
    runtime.runUntil(40);
    assert.equal(runtime.context.hasTag('one', 'ake-ability-entity-inactive'), true);
    assert.equal(runtime.context.hasTag('two', 'ake-ability-entity-inactive'), false);
    const seeks = runtime.trace.filter(entry => entry.stage === 'SkillProgramSeeked');
    assert.equal(seeks.length, 1);
    assert.equal(seeks[0].frame, 40);
    assert.equal(seeks[0].destFrame, 1500);
    runtime.runUntil(900);
    assert.equal(runtime.context.hasTag('two', 'ake-ability-entity-inactive'), true);
    assert.equal(runtime.skillTimelineConditions.size, 0);
});

test('cancelled water condition cannot react to a future wake', () => {
    const { runtime, scheduled } = setup();
    runtime.runUntil(10);
    runtime.cancelProgramExecution(scheduled[0].executionId, 10, 'test-cancel');
    runtime.execute({ type: 'ApplyBuff', target: 'one', buffId: wake }, {
        frame: 20, sourceId: 'source', ownerId: 'source', targetId: 'one'
    });
    runtime.runUntil(20);
    assert.equal(runtime.trace.some(entry => entry.stage === 'SkillProgramSeeked'), false);
});
