import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const enemyId = 'eny_0007_mimicw';
const buffDataUrl = new URL(
    '../reference/public-data/akedata/Json/BuffData/',
    import.meta.url
);
const semanticMappings = JSON.parse(readFileSync(new URL(
    '../spec/engine-semantic-mappings.json',
    import.meta.url
), 'utf8'));
const attachmentBuffIds = Object.freeze({
    Fire: 'buff_common_energy_shard_attached_fire',
    Pulse: 'buff_common_energy_shard_attached_pulse',
    Cryst: 'buff_common_energy_shard_attached_cryst',
    Natural: 'buff_common_energy_shard_attached_natural'
});
const settingTables = Object.freeze({
    '异常初始伤害倍率': [1.6, 2.4, 3.2, 4],
    '导电法术伤害提高': [0.12, 0.16, 0.2, 0.24],
    '导电持续时间': [12, 18, 24, 30],
    '冰冻持续时间': [6, 7, 8, 9],
    '燃烧每跳伤害': [0.24, 0.36, 0.48, 0.6],
    '腐蚀每跳减抗': [-0.0084, -0.0112, -0.014, -0.0168],
    '腐蚀减抗上限': [-0.12, -0.16, -0.2, -0.24],
    '腐蚀初始减抗': [-0.036, -0.048, -0.06, -0.072],
    '腐蚀持续时间': [15, 15, 15, 15],
    '法术爆发伤害倍率': [1.6, 1.6, 1.6, 1.6]
});
const settingKeys = new Set(Object.keys(settingTables));
const bundle = new AkeSquadScenarioAssembler().assemble({
    enemyId,
    members: [
        { memberId: 'tangtang', characterId: 'chr_0027_tangtang', level: 1 },
        { memberId: 'laevat', characterId: 'chr_0016_laevat', level: 1 }
    ]
});

function close(actual, expected, message = '') {
    assert.ok(
        Math.abs(Number(actual) - Number(expected)) < 1e-10,
        `${message}: expected ${expected}, received ${actual}`
    );
}

function findSettingActions(value, found = []) {
    if (!value || typeof value !== 'object') return found;
    if (String(value.$type ?? '').includes('ReadSkillSettingData')) {
        const relevant = (value.dataList ?? []).filter(read => settingKeys.has(read.dataKey));
        if (relevant.length > 0) found.push({ action: value, relevant });
    }
    for (const child of Object.values(value)) findSettingActions(child, found);
    return found;
}

function createReactionRuntime() {
    return new CombatRuntime({
        tickRate: bundle.tickRate,
        definitions: bundle.definitions,
        damageResolver: createAkeDamageResolver()
    });
}

function infliction(element) {
    return {
        type: 'ApplyEnemyInfliction',
        element,
        buffId: attachmentBuffIds[element],
        attachmentBuffIds,
        target: 'Target',
        reason: 'SpellInfliction'
    };
}

function context(sourceId, frame) {
    return {
        frame,
        sourceId,
        ownerId: sourceId,
        targetId: enemyId,
        skillId: `reaction-test:${sourceId}`,
        rootSkillId: `reaction-test:${sourceId}`,
        castId: `reaction-test:${sourceId}:${frame}`
    };
}

function triggerLevelTwoReaction(existingElement, incomingElement) {
    const runtime = createReactionRuntime();
    runtime.execute(
        infliction(existingElement),
        context('chr_0027_tangtang', 0)
    );
    runtime.execute(
        infliction(existingElement),
        context('chr_0027_tangtang', 1)
    );
    const result = runtime.execute(
        infliction(incomingElement),
        context('chr_0016_laevat', 2)
    );
    const buffId = `buff_common_${incomingElement.toLowerCase()}_${existingElement.toLowerCase()}_triggered`;
    const reaction = runtime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId
    })[0];
    return { runtime, result, reaction, buffId };
}

test('all public elemental SkillSetting reads close through ten generic tables', () => {
    const compiler = new AkeActionCompiler({ semanticMappings });
    let actionCount = 0;
    let readCount = 0;
    for (const fileName of readdirSync(buffDataUrl).filter(name => name.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(fileName, buffDataUrl), 'utf8'));
        for (const entry of findSettingActions(raw)) {
            const compiled = compiler.compileAction(entry.action, {
                path: `${fileName}:ReadSkillSettingData`
            });
            assert.equal(compiled.status, 'executable', fileName);
            assert.deepEqual(compiled.unresolved, [], fileName);
            assert.ok(compiled.actions.some(action =>
                action.type === 'ReadSkillSettingValues'
            ), fileName);
            assert.ok(entry.relevant.every(read =>
                read.enhanceAttributeSource?.targetSource === 'Source'
            ), `${fileName}: enhancement source must remain the inflictor`);
            actionCount += 1;
            readCount += entry.relevant.length;
        }
    }

    assert.equal(actionCount, 21);
    assert.equal(readCount, 47);
});

test('all four columns resolve exactly and Arts intensity uses separate damage/state formulas', () => {
    const compiler = new AkeActionCompiler({ semanticMappings });
    const compiled = compiler.compileAction({
        type: 'ReadSkillSettingData',
        reads: Object.keys(settingTables).map((dataKey, index) => ({
            dataKey,
            column: {
                useBlackboardKey: true,
                value: 1,
                blackboardKey: 'count'
            },
            storeKey: `value_${index}`
        }))
    });
    assert.equal(compiled.status, 'executable');
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'caster',
                    kind: 'Character',
                    team: 'ally',
                    attributes: { Level: 1, PhysicalAndSpellInflictionEnhance: 0 }
                },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ]
        }
    });

    for (let column = 1; column <= 4; column += 1) {
        const [resolution] = runtime.execute(compiled.actions, {
            sourceId: 'caster',
            ownerId: 'caster',
            targetId: 'enemy',
            blackboard: { count: column }
        });
        Object.entries(settingTables).forEach(([dataKey, values], index) => {
            close(resolution.after[`value_${index}`], values[column - 1], dataKey);
        });
    }

    runtime.context.setAttribute('caster', 'PhysicalAndSpellInflictionEnhance', 100);
    const [enhanced] = runtime.execute(compiled.actions, {
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'enemy',
        blackboard: { count: 1 }
    });
    close(enhanced.after.value_0, 3.2, 'abnormal damage uses 1 + strength / 100');
    close(enhanced.after.value_1, 0.18, 'Conduct uses 2S / (S + 300)');
    close(enhanced.after.value_5, -0.0126, 'corrosion tick uses state enhancement');
    close(enhanced.after.value_7, -0.054, 'corrosion initial uses state enhancement');
    close(enhanced.after.value_2, 12, 'duration is not enhanced');
    close(enhanced.after.value_9, 3.2, 'spell burst uses abnormal damage enhancement');
});

test('same-element bursts use one delayed generic path for all four elements', () => {
    for (const element of Object.keys(attachmentBuffIds)) {
        const runtime = createReactionRuntime();
        runtime.execute(
            infliction(element),
            context('chr_0016_laevat', 0)
        );
        const second = runtime.execute(
            infliction(element),
            context('chr_0016_laevat', 1)
        );
        assert.equal(second.branch, 'AttachmentEnhanced', element);
        const buffId = `buff_common_${element.toLowerCase()}_${element.toLowerCase()}_triggered`;
        runtime.runUntil(31);
        const burst = runtime.statusEffects.list({
            active: true,
            targetId: enemyId,
            buffId
        })[0];
        assert.ok(burst, buffId);
        close(burst.blackboard.atk_scale, 1.6, `${buffId}.atk_scale`);
        const hit = runtime.effects.trace
            .filter(event => event.type === 'ResolveDamagePacket'
                && event.buffInstanceId === burst.instanceId)
            .flatMap(event => event.result?.resolution?.hits ?? [])
            .find(candidate => candidate.damageType === element
                && candidate.damageAttributeType === 'Hp');
        assert.ok(hit, `${buffId}: missing burst hit`);
        close(hit.operands.atkScale, 1.6, `${buffId}: hit scale`);
        assert.ok(hit.finalDamage > 0, `${buffId}: burst hit must deal damage`);
    }
});

test('all four cross-element branches create a real initial hit from the same level table', () => {
    const cases = [
        ['Cryst', 'Fire', { burning_atk_scale: 0.36 }],
        ['Fire', 'Pulse', { spell_resistance_decrease: 0.16, conduct_duration: 18 }],
        ['Fire', 'Cryst', { frozen_duration: 7 }],
        ['Fire', 'Natural', {
            def_decrease_tick: -0.0112,
            max_def_decrease: -0.16,
            start_def_decrease: -0.048,
            corrupt_duration: 15
        }]
    ];
    for (const [existingElement, incomingElement, expectedBlackboard] of cases) {
        const { result, reaction, buffId } = triggerLevelTwoReaction(
            existingElement,
            incomingElement
        );
        assert.ok(reaction, buffId);
        assert.equal(reaction.sourceId, 'chr_0016_laevat');
        close(reaction.blackboard.atk_scale, 2.4, `${buffId}.atk_scale`);
        for (const [key, value] of Object.entries(expectedBlackboard)) {
            close(reaction.blackboard[key], value, `${buffId}.${key}`);
        }
        const initialHit = result.effectEvents
            .filter(event => event.type === 'ResolveDamagePacket')
            .flatMap(event => event.result?.resolution?.hits ?? [])
            .find(hit => hit.damageType === incomingElement
                && hit.damageAttributeType === 'Hp');
        assert.ok(initialHit, `${buffId}: missing initial reaction hit`);
        close(initialHit.operands.atkScale, 2.4, `${buffId}: hit scale`);
        assert.ok(initialHit.finalDamage > 0, `${buffId}: initial hit must deal damage`);
    }
});

test('Conduct, Freeze, and Burning values affect live runtime state instead of UI-only labels', () => {
    const conduct = triggerLevelTwoReaction('Fire', 'Pulse');
    for (const damageType of ['Fire', 'Pulse', 'Cryst', 'Natural']) {
        const zone = conduct.runtime.effectSources.damageZone({
            targetId: enemyId,
            attackerId: 'chr_0027_tangtang',
            defenderId: enemyId,
            side: 'Defender',
            damageType
        }, context('chr_0027_tangtang', 2));
        close(zone.scale, 1.16, `Conduct ${damageType}`);
    }
    close(conduct.runtime.effectSources.damageZone({
        targetId: enemyId,
        attackerId: 'chr_0027_tangtang',
        defenderId: enemyId,
        side: 'Defender',
        damageType: 'Physical'
    }).scale, 1, 'Conduct does not affect Physical');
    conduct.runtime.runUntil(542);
    assert.equal(conduct.runtime.statusEffects.has({
        targetId: enemyId,
        buffId: conduct.buffId
    }), false);

    const frozen = triggerLevelTwoReaction('Fire', 'Cryst');
    assert.equal(frozen.reaction.expireFrame, 212);
    frozen.runtime.runUntil(211);
    assert.equal(frozen.runtime.statusEffects.has({
        targetId: enemyId,
        buffId: frozen.buffId
    }), true);
    frozen.runtime.runUntil(212);
    assert.equal(frozen.runtime.statusEffects.has({
        targetId: enemyId,
        buffId: frozen.buffId
    }), false);

    const burning = triggerLevelTwoReaction('Cryst', 'Fire');
    burning.runtime.runUntil(31);
    const beforeTick = burning.runtime.vitals.get(enemyId).currentHp;
    burning.runtime.runUntil(32);
    const afterTick = burning.runtime.vitals.get(enemyId).currentHp;
    const attacker = burning.runtime.context.getAttribute('chr_0016_laevat', 'Atk');
    close(beforeTick - afterTick, attacker * 0.36 * 0.5, 'level-two Burning tick');
});

test('Corrosion ramps all resistances, clamps through the shared Buff, and rolls back', () => {
    const corrosion = triggerLevelTwoReaction('Fire', 'Natural');
    const resistanceTypes = [
        'PhysicalResistance', 'FireResistance', 'PulseResistance',
        'CrystResistance', 'NaturalResistance'
    ];
    const base = Object.fromEntries(resistanceTypes.map(attribute => [
        attribute,
        corrosion.runtime.context.getAttribute(enemyId, attribute) + 0.048
    ]));
    for (const attribute of resistanceTypes) {
        close(
            corrosion.runtime.context.getAttribute(enemyId, attribute),
            base[attribute] - 0.048,
            `${attribute}: initial corrosion`
        );
    }

    corrosion.runtime.runUntil(32);
    for (const attribute of resistanceTypes) {
        close(
            corrosion.runtime.context.getAttribute(enemyId, attribute),
            base[attribute] - 0.0592,
            `${attribute}: first corrosion tick`
        );
    }
    const ramped = corrosion.runtime.statusEffects.list({
        active: true,
        targetId: enemyId,
        buffId: corrosion.buffId
    })[0];
    close(ramped.blackboard.def_decrease, -0.0592);

    corrosion.runtime.runUntil(452);
    for (const attribute of resistanceTypes) {
        close(
            corrosion.runtime.context.getAttribute(enemyId, attribute),
            base[attribute],
            `${attribute}: corrosion rollback`
        );
    }
    assert.equal(corrosion.runtime.statusEffects.has({
        targetId: enemyId,
        buffId: corrosion.buffId
    }), false);
});
