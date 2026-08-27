import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const SKILL_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/',
    import.meta.url
);

function collectActions(value, sourceType, path = '$', found = []) {
    if (!value || typeof value !== 'object') return found;
    if (String(value.$type ?? '').includes(`${sourceType}+Data`)) {
        found.push({ action: value, path });
    }
    if (Array.isArray(value)) {
        value.forEach((child, index) =>
            collectActions(child, sourceType, `${path}[${index}]`, found)
        );
    } else {
        for (const [key, child] of Object.entries(value)) {
            collectActions(child, sourceType, `${path}.${key}`, found);
        }
    }
    return found;
}

function readSkill(skillId) {
    return JSON.parse(readFileSync(new URL(`${skillId}.json`, SKILL_DATA_URL), 'utf8'));
}

function zhuangFangyiTagProgram() {
    const compiledSkill = new AkeActionCompiler().compileSkill(
        readSkill('chr_0030_zhuangfy_ultimate_skill_end')
    );
    return {
        skillId: compiledSkill.skillId,
        blackboard: compiledSkill.blackboard,
        timeline: compiledSkill.timeline
            .filter(group => group.actions.some(action =>
                action.type === 'ApplyEffectSource'
                && action.sourceType === 'SkillActionTag'
            ))
            .map(group => ({
                groupIndex: group.groupIndex,
                startFrame: group.startFrame,
                endFrame: group.endFrame,
                actions: group.actions.filter(action =>
                    action.type === 'ApplyEffectSource'
                    && action.sourceType === 'SkillActionTag'
                ),
                cleanupActions: group.cleanupActions.filter(action =>
                    action.type === 'RemoveEffectSource'
                    && action.sourceType === 'SkillActionTag'
                )
            }))
    };
}

test('all public SkillData AddTagAction windows compile without operator exceptions', () => {
    const compiler = new AkeActionCompiler();
    const rows = [];
    for (const fileName of readdirSync(SKILL_DATA_URL).filter(name => name.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(fileName, SKILL_DATA_URL), 'utf8'));
        for (const entry of collectActions(raw, 'AddTagAction')) {
            const compiled = compiler.compileAction(entry.action, {
                scope: 'skill',
                path: `${fileName}:${entry.path}`
            });
            rows.push({ fileName, ...entry, compiled });
            if (entry.action.isEnable === false) {
                assert.equal(compiled.status, 'metadata-only', fileName);
                continue;
            }
            assert.equal(entry.action.useBlackboard, false, fileName);
            assert.equal(compiled.status, 'executable', fileName);
            assert.deepEqual(compiled.unresolved, [], fileName);
            assert.deepEqual(
                compiled.actions.map(action => action.type),
                ['ApplyEffectSource'],
                fileName
            );
            assert.deepEqual(
                compiled.cleanupActions.map(action => action.type),
                ['RemoveEffectSource'],
                fileName
            );
            assert.equal(compiled.actions[0].sourceType, 'SkillActionTag', fileName);
            assert.equal(compiled.actions[0].tags.length, entry.action.tags.length, fileName);
            assert.equal(compiled.actions[0].tags.every(tag => tag.startsWith('ake-tag:')), true);
        }
    }

    assert.equal(rows.length, 16);
    assert.equal(rows.filter(row => row.action.isEnable !== false).length, 15);
    assert.equal(rows.filter(row => row.action.isEnable !== false)
        .reduce((sum, row) => sum + row.compiled.actions[0].tags.length, 0), 22);
    assert.equal(new Set(rows.map(row => row.fileName)).size, 12);
});

test('skill tag windows are cast-scoped and cannot erase overlapping or Buff-owned tags', () => {
    const program = zhuangFangyiTagProgram();
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: 'zhuangfy',
                kind: 'Character',
                team: 'ally'
            }]
        }
    });
    const context = {
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy'
    };
    const sharedTag = 'ake-tag:-496376350';

    runtime.execute({
        type: 'ApplyEffectSource',
        target: 'Target',
        sourceKey: 'fixture:persistent-buff-tag',
        sourceType: 'StatusEffect',
        tags: [sharedTag]
    }, { ...context, frame: 0, buffInstanceId: 'fixture:buff' });
    runtime.scheduleProgram(program, { ...context, frame: 0, castId: 'cast:first' });
    runtime.scheduleProgram(program, { ...context, frame: 5, castId: 'cast:second' });

    runtime.runUntil(0);
    assert.equal(runtime.context.hasTag('zhuangfy', sharedTag), true);
    runtime.runUntil(5);
    assert.equal(runtime.context.hasTag('zhuangfy', sharedTag), true);
    runtime.runUntil(15);
    assert.equal(runtime.context.hasTag('zhuangfy', sharedTag), true,
        'the first cast cleanup must retain the second cast and Buff references');
    runtime.runUntil(20);
    assert.equal(runtime.context.hasTag('zhuangfy', sharedTag), true,
        'both skill windows ending must retain the Buff-owned reference');

    runtime.execute({
        type: 'RemoveEffectSource',
        sourceKey: 'fixture:persistent-buff-tag'
    }, { ...context, frame: 21, buffInstanceId: 'fixture:buff' });
    assert.equal(runtime.context.hasTag('zhuangfy', sharedTag), false);
});

test('skill cancellation and early lifetime finish both release cast-owned tags', () => {
    const program = zhuangFangyiTagProgram();
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'zhuangfy', kind: 'Character', team: 'ally' }]
        }
    });
    const context = {
        sourceId: 'zhuangfy',
        ownerId: 'zhuangfy',
        targetId: 'zhuangfy'
    };
    const tag = 'ake-tag:-496376350';

    const interrupted = runtime.scheduleProgram(program, {
        ...context,
        frame: 0,
        castId: 'cast:interrupted'
    });
    runtime.runUntil(0);
    assert.equal(runtime.context.hasTag('zhuangfy', tag), true);
    runtime.cancelProgramExecution(interrupted.executionId, 5, 'Interrupted');
    assert.equal(runtime.context.hasTag('zhuangfy', tag), false);

    runtime.scheduleProgram(program, {
        ...context,
        frame: 10,
        castId: 'cast:early-finish'
    });
    runtime.runUntil(10);
    assert.equal(runtime.context.hasTag('zhuangfy', tag), true);
    runtime.finishSkillActionLifetimes({
        frame: 11,
        actorId: 'zhuangfy',
        skillId: program.skillId,
        castId: 'cast:early-finish',
        reason: 'SkillInterrupted'
    }, { ...context, frame: 11, castId: 'cast:early-finish' });
    assert.equal(runtime.context.hasTag('zhuangfy', tag), false);
});

test('non-skill AddTagAction remains explicit until its owner lifetime is proven', () => {
    const raw = JSON.parse(readFileSync(new URL(
        '../reference/public-data/akedata/Json/BuffData/buff_common_ai_maker.json',
        import.meta.url
    ), 'utf8'));
    const action = collectActions(raw, 'AddTagAction')[0].action;
    const compiled = new AkeActionCompiler().compileAction(action, {
        scope: 'buff',
        path: 'buffEventAction[0]'
    });

    assert.equal(compiled.status, 'unresolved');
    assert.equal(compiled.actions.length, 0);
    assert.equal(compiled.unresolved.some(item =>
        item.code === 'AKE_TAG_ACTION_LIFETIME_REQUIRED'
    ), true);
});
