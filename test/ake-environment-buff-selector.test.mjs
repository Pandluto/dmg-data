import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const BUFF_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/BuffData/',
    import.meta.url
);

function readBuff(fileName) {
    return JSON.parse(readFileSync(new URL(fileName, BUFF_DATA_URL), 'utf8'));
}

function findRawEnvironmentFinishActions(value, found = []) {
    if (!value || typeof value !== 'object') return found;
    if (String(value.$type ?? '').includes('FinishBuffAdvanced')
        && (value.checkType ?? value.buffSettings?.checkType) === 'Environment') {
        found.push(value);
    }
    for (const child of Object.values(value)) {
        findRawEnvironmentFinishActions(child, found);
    }
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

test('all reachable AKE Environment finish selectors bind to their callback Buff instance', () => {
    const compiler = new AkeActionCompiler();
    let rawCount = 0;
    let enabledCount = 0;
    let compiledCount = 0;
    for (const fileName of readdirSync(BUFF_DATA_URL).filter(name => name.endsWith('.json'))) {
        const raw = readBuff(fileName);
        const environmentActions = findRawEnvironmentFinishActions(raw);
        if (environmentActions.length === 0) continue;
        rawCount += environmentActions.length;
        enabledCount += environmentActions.filter(action => action.isEnable !== false).length;
        const compiled = compiler.compileBuff(raw);
        assert.equal(compiled.compiler.unresolved.some(item =>
            item.sourceType === 'FinishBuffAdvanced'
            && item.details?.checkType === 'Environment'
        ), false, `${raw.id} should resolve Environment from its Buff callback context`);
        compiledCount += findCompiledActions(compiled, 'FinishBuff')
            .filter(action => action.currentBuffInstance === true).length;
    }
    assert.equal(rawCount, 354);
    assert.equal(enabledCount, 353);
    assert.equal(compiledCount, 352);
    // One enabled training-only action is serialized inside an IfElse
    // conditionAction after a real condition. It remains an explicit
    // condition/action sequencing gap rather than being silently counted as
    // an Environment selector failure.
    const embedded = compiler.compileBuff(readBuff('buff_train_output_castskill.json'));
    assert.equal(embedded.compiler.unresolved.some(item =>
        item.code === 'AKE_CONDITION_UNSUPPORTED'
        && item.sourceType === 'FinishBuffAdvanced'
    ), true);
});

test('Environment ignores stale serialized ids and finishes only the executing instance', () => {
    const listenerBuffId = 'buff_chr_0017_yvonne_train_combo_check';
    const staleSerializedBuffId =
        'buff_chr_0017_yvonne_train_combo_end_with_frozen';
    const rawAction = findRawEnvironmentFinishActions(
        readBuff(`${listenerBuffId}.json`)
    )[0];
    assert.deepEqual(rawAction.buffSettings.buffIdList, [staleSerializedBuffId]);
    const compiled = new AkeActionCompiler().compileAction(rawAction, {
        scope: 'buff',
        path: 'fixture.environment-finish'
    });
    assert.equal(compiled.status, 'executable');
    assert.deepEqual(compiled.actions.map(action => ({
        type: action.type,
        currentBuffInstance: action.currentBuffInstance,
        buffId: action.buffId
    })), [{
        type: 'FinishBuff',
        currentBuffInstance: true,
        buffId: undefined
    }]);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'operator', kind: 'Character', team: 'ally' }],
            buffs: {
                [listenerBuffId]: {
                    lifeType: 'Infinity',
                    stackingPolicy: 'Independent',
                    abilityEventActions: [{
                        eventType: 'FinishFixture',
                        actions: compiled.actions
                    }]
                },
                [staleSerializedBuffId]: { lifeType: 'Infinity' }
            }
        }
    });
    const context = {
        frame: 0,
        sourceId: 'operator',
        ownerId: 'operator',
        targetId: 'operator'
    };
    runtime.execute({ type: 'ApplyBuff', target: 'Target', buffId: listenerBuffId }, context);
    runtime.execute({ type: 'ApplyBuff', target: 'Target', buffId: listenerBuffId }, context);
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: staleSerializedBuffId
    }, context);
    const listenerInstances = runtime.statusEffects.list({
        active: true,
        buffId: listenerBuffId
    });
    assert.equal(listenerInstances.length, 2);

    runtime.statusEffects.notifyAbilityEvent({
        ...context,
        frame: 1,
        eventType: 'FinishFixture',
        listenerTargetId: 'operator'
    });
    assert.equal(runtime.statusEffects.has({
        targetId: 'operator',
        buffId: listenerBuffId
    }), false);
    assert.equal(runtime.statusEffects.has({
        targetId: 'operator',
        buffId: staleSerializedBuffId
    }), true, 'Environment must not treat the editor residue id as its selector');
    const finishedIds = runtime.statusEffects.trace
        .filter(entry => entry.stage === 'StatusEffectFinished'
            && entry.reason === 'FinishBuffAdvanced')
        .map(entry => entry.instanceId)
        .sort();
    assert.deepEqual(finishedIds, listenerInstances.map(instance => instance.instanceId).sort());
});

test('Environment fails closed when invoked outside a Buff callback', () => {
    const rawAction = findRawEnvironmentFinishActions(
        readBuff('buff_chr_0009_azrila_normal_skill_gpsuccess.json')
    )[0];
    const compiled = new AkeActionCompiler().compileAction(rawAction, {
        scope: 'standalone',
        path: 'fixture.environment-without-buff-context'
    });
    assert.equal(compiled.status, 'unresolved');
    assert.equal(compiled.actions.length, 0);
    assert.equal(compiled.unresolved.some(item =>
        item.code === 'AKE_BUFF_SELECTOR_PROVIDER_REQUIRED'
        && item.checkType === 'Environment'
    ), true);
});
