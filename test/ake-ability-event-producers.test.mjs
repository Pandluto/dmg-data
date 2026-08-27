import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
    hasRuntimeAbilityEventProducer,
    RUNTIME_ABILITY_EVENT_TYPES
} from '../src/core/ability-event-producers.mjs';
import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';

const BUFF_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/BuffData/',
    import.meta.url
);
const SKILL_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/',
    import.meta.url
);

function readJson(url) {
    return JSON.parse(readFileSync(url, 'utf8'));
}

test('public BuffData ability events are measured against concrete runtime producers', () => {
    const counts = new Map();
    for (const fileName of readdirSync(BUFF_DATA_URL).filter(name => name.endsWith('.json'))) {
        const raw = readJson(new URL(fileName, BUFF_DATA_URL));
        for (const group of raw.abilityEventAction ?? []) {
            const eventType = String(group.abilityEvent ?? '');
            counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
        }
    }
    const publicProducerEntries = [...counts].filter(([eventType]) =>
        hasRuntimeAbilityEventProducer(eventType)
    );

    assert.equal(counts.size, 82);
    assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 953);
    assert.equal(publicProducerEntries.length, 28);
    assert.equal(publicProducerEntries.reduce((sum, [, count]) => sum + count, 0), 804);
    assert.ok(RUNTIME_ABILITY_EVENT_TYPES.includes('OnRemoveAllPendingComboSkill'));
    assert.ok(RUNTIME_ABILITY_EVENT_TYPES.includes('OnPoiseZero'));
    assert.ok(RUNTIME_ABILITY_EVENT_TYPES.includes('OnPoiseRecover'));
    assert.ok(RUNTIME_ABILITY_EVENT_TYPES.includes('OnConsumeBuff'));
});

test('top-level Buff listeners fail closed on missing or malformed event producers', () => {
    const compiler = new AkeActionCompiler();
    const raw = readJson(new URL(
        'buff_chr_0028_wulfa_combo_usetimer.json',
        BUFF_DATA_URL
    ));
    const removeAllGroup = raw.abilityEventAction.find(group =>
        group.abilityEvent === 'OnRemoveAllPendingComboSkill'
    );
    const fixture = {
        ...raw,
        id: 'fixture_ability_event_producers',
        abilityEventAction: [
            removeAllGroup,
            { ...removeAllGroup, abilityEvent: 'OnOwnerDead' },
            { ...removeAllGroup, abilityEvent: 32 }
        ]
    };
    const definition = compiler.compileBuff(fixture);

    assert.equal(definition.abilityEventActions[0].unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
    ), false, 'the implemented pending-empty producer remains executable');
    assert.equal(definition.abilityEventActions[1].unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
        && gap.abilityEvent === 'OnOwnerDead'
    ), true);
    assert.equal(definition.abilityEventActions[2].unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_TYPE_REQUIRED'
        && gap.abilityEvent === 32
    ), true);
    assert.equal(definition.compiler.status, 'unresolved');
});

test('Skill passive consume listeners compile their layer conditions after producer registration', () => {
    const raw = readJson(new URL('sk_wpn_claym_0014.json', SKILL_DATA_URL));
    const passive = new AkeActionCompiler().compilePassiveEventActions(raw);
    const consume = passive.groups.find(group => group.eventType === 'OnConsumeBuff');

    assert.equal(consume.unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
    ), false);
    assert.deepEqual(consume.unresolved, []);
    assert.equal(passive.compiler.status, 'executable');
});
