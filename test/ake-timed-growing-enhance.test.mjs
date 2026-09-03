import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseBuff } from '../src/core/ake-parser.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const raw = JSON.parse(readFileSync(new URL(
    '../reference/public-data/akedata/Json/BuffData/'
        + 'buff_chr_0034_typhoea_passive_arrowrecover_exitfight.json',
    import.meta.url
), 'utf8'));

function makeRuntime() {
    const definition = parseBuff(raw);
    return new CombatRuntime({
        definitions: {
            entities: [{
                id: 'typhoea',
                kind: 'Character',
                team: 'ally',
                clockDomainId: 'global'
            }],
            buffs: { [definition.buffId]: definition }
        }
    });
}

const context = {
    frame: 0,
    eventType: 'OnBuffStart',
    sourceId: 'typhoea',
    ownerId: 'typhoea',
    targetId: 'typhoea',
    clockDomainId: 'global'
};

test('real AKE TimedGrowingEnhance keeps a zero-layer container and regrows to its cap', () => {
    const runtime = makeRuntime();
    const buffId = raw.id;

    runtime.execute({ type: 'ApplyBuff', buffId }, context);
    runtime.execute({
        type: 'FinishBuff',
        buffId,
        target: 'Target',
        finishAll: false,
        stackCount: 1
    }, context);

    assert.equal(runtime.statusEffects.list({ active: true })[0].stackCount, 0);
    runtime.runUntil(89);
    assert.equal(runtime.statusEffects.list({ active: true })[0].stackCount, 0);
    runtime.runUntil(90);
    assert.equal(runtime.statusEffects.list({ active: true })[0].stackCount, 1);
    runtime.runUntil(360);

    const grown = runtime.statusEffects.list({ active: true })[0];
    assert.equal(grown.stackCount, 4);
    assert.equal(grown.maxStacks, 4);
    assert.equal(grown.nextGrowthFrame, null);
    assert.deepEqual(runtime.statusEffects.trace
        .filter(entry => entry.stage === 'StatusEffectStackGrown')
        .map(entry => [entry.frame, entry.before, entry.after]), [
        [90, 0, 1],
        [180, 1, 2],
        [270, 2, 3],
        [360, 3, 4]
    ]);
    assert.equal(runtime.statusEffects.trace.some(
        entry => entry.stage === 'StatusEffectFinished'
    ), false);
});

test('real AKE CreateBuff count fills TimedGrowingEnhance without duplicate timers', () => {
    const runtime = makeRuntime();
    const buffId = raw.id;

    runtime.execute({ type: 'ApplyBuff', buffId, count: 4 }, context);
    assert.equal(runtime.statusEffects.list({ active: true })[0].stackCount, 4);
    runtime.runUntil(360);

    assert.equal(runtime.statusEffects.list({ active: true })[0].stackCount, 4);
    assert.equal(runtime.statusEffects.trace.some(
        entry => entry.stage === 'StatusEffectStackGrown'
    ), false);
});

test('AKE float descriptors become bounded discrete CreateBuff counts', () => {
    const buffId = raw.id;
    const positive = makeRuntime();
    const negative = makeRuntime();

    positive.execute({ type: 'ApplyBuff', buffId, count: 1.9 }, context);
    negative.execute({ type: 'ApplyBuff', buffId, count: -0.5 }, context);

    assert.equal(positive.statusEffects.list({ active: true })[0].stackCount, 1);
    assert.deepEqual(negative.statusEffects.list({ active: true }), []);
});
