import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const BUFF_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/BuffData/',
    import.meta.url
);

function collectLifecycleActions(value, eventType = null, found = []) {
    if (!value || typeof value !== 'object') return found;
    const nextEventType = typeof value.buffEvent === 'string'
        ? value.buffEvent
        : eventType;
    if (String(value.$type ?? '').includes('OnSpellAbnormalStartFinish')) {
        found.push({ action: value, eventType: nextEventType });
    }
    for (const child of Object.values(value)) {
        collectLifecycleActions(child, nextEventType, found);
    }
    return found;
}

test('all public spell-abnormal lifecycle actions compile to one normalized event ledger', () => {
    const compiler = new AkeActionCompiler();
    const rows = [];
    for (const fileName of readdirSync(BUFF_DATA_URL).filter(name => name.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(fileName, BUFF_DATA_URL), 'utf8'));
        for (const entry of collectLifecycleActions(raw)) {
            const compiled = compiler.compileAction(entry.action, {
                path: `${fileName}:OnSpellAbnormalStartFinish`
            });
            if (entry.action.isEnable === false) {
                assert.equal(compiled.status, 'metadata-only', fileName);
                assert.equal(compiled.actions.length, 0, fileName);
                rows.push({ fileName, ...entry });
                continue;
            }
            assert.equal(compiled.status, 'executable', fileName);
            assert.deepEqual(compiled.unresolved, [], fileName);
            assert.equal(compiled.actions.length, 1, fileName);
            assert.deepEqual(compiled.actions[0], {
                type: 'EmitEvent',
                eventType: entry.action.isStart
                    ? 'SpellAbnormalStarted'
                    : 'SpellAbnormalFinished',
                payload: {
                    abnormalType: entry.action.abnormalType,
                    isStart: entry.action.isStart
                },
                reason: 'OnSpellAbnormalStartFinish'
            });
            assert.equal(
                entry.eventType,
                entry.action.isStart ? 'OnBuffStart' : 'OnBuffFinish',
                fileName
            );
            rows.push({ fileName, ...entry });
        }
    }

    assert.equal(rows.length, 46);
    assert.equal(rows.filter(row => row.action.isEnable !== false).length, 42);
    assert.deepEqual(
        [...new Set(rows.map(row => row.action.abnormalType))].sort(),
        ['Burst', 'Cryst', 'Fire', 'Natural', 'Pulse']
    );
    for (const abnormalType of ['Burst', 'Cryst', 'Fire', 'Natural', 'Pulse']) {
        const matching = rows.filter(row => row.action.abnormalType === abnormalType
            && row.action.isEnable !== false);
        assert.equal(
            matching.filter(row => row.action.isStart).length,
            matching.filter(row => !row.action.isStart).length,
            abnormalType
        );
    }
});

test('normalized abnormal events preserve Buff attribution without creating parallel state', () => {
    const compiler = new AkeActionCompiler();
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'caster', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ]
        }
    });
    const context = {
        frame: 17,
        eventType: 'OnBuffStart',
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'enemy',
        skillId: 'skill:test',
        buffInstanceId: 'buff-instance:test'
    };
    for (const isStart of [true, false]) {
        const compiled = compiler.compileAction({
            type: 'OnSpellAbnormalStartFinish',
            isStart,
            abnormalType: 'Pulse'
        });
        const result = runtime.execute(compiled.actions[0], context);
        assert.equal(
            result.eventContext.eventType,
            isStart ? 'SpellAbnormalStarted' : 'SpellAbnormalFinished'
        );
        assert.deepEqual(result.eventContext.payload, {
            abnormalType: 'Pulse',
            isStart
        });
        assert.deepEqual({
            sourceId: result.eventContext.sourceId,
            ownerId: result.eventContext.ownerId,
            targetId: result.eventContext.targetId,
            buffInstanceId: result.eventContext.buffInstanceId
        }, {
            sourceId: 'caster',
            ownerId: 'caster',
            targetId: 'enemy',
            buffInstanceId: 'buff-instance:test'
        });
    }

    assert.equal(runtime.statusEffects.list({ active: true }).length, 0);
    assert.deepEqual(
        runtime.trace
            .filter(entry => entry.stage === 'EventDispatched')
            .map(entry => entry.reason),
        ['EventDispatched', 'EventDispatched']
    );
});

test('malformed abnormal lifecycle actions fail closed', () => {
    const compiler = new AkeActionCompiler();
    for (const action of [
        { type: 'OnSpellAbnormalStartFinish', abnormalType: 'Fire' },
        { type: 'OnSpellAbnormalStartFinish', isStart: true, abnormalType: 'Unknown' }
    ]) {
        const compiled = compiler.compileAction(action);
        assert.equal(compiled.status, 'unresolved');
        assert.equal(compiled.actions.length, 0);
        assert.equal(compiled.unresolved.length, 1);
    }
});
