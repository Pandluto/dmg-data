import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const SKILL_DATA_URL = new URL(
    '../reference/public-data/akedata/Json/SkillData/',
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
const statusBuffIds = Object.freeze({
    Fire: 'buff_common_fire_fire_burning_triggered',
    Pulse: 'buff_common_pulse_pulse_conduct_triggered',
    Cryst: 'buff_common_cryst_cryst_frozen_triggered',
    Natural: 'buff_common_natural_natural_corrupt_triggered'
});

function findActions(value, typeName, found = []) {
    if (!value || typeof value !== 'object') return found;
    if (String(value.$type ?? '').includes(typeName)) found.push(value);
    for (const child of Object.values(value)) findActions(child, typeName, found);
    return found;
}

function createRuntime() {
    return new CombatRuntime({
        definitions: {
            entities: [
                { id: 'caster-a', kind: 'Character', team: 'ally' },
                { id: 'caster-b', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                ...Object.fromEntries(Object.values(attachmentBuffIds).map(buffId => [
                    buffId,
                    { buffId, stackingPolicy: 'AddStack', maxStacks: 4 }
                ])),
                ...Object.fromEntries(Object.values(statusBuffIds).map(buffId => [
                    buffId,
                    { buffId, stackingPolicy: 'Refresh' }
                ]))
            }
        }
    });
}

function context(sourceId, frame) {
    return {
        frame,
        eventType: 'SkillHit',
        sourceId,
        ownerId: sourceId,
        targetId: 'enemy',
        skillId: `skill:${sourceId}`,
        rootSkillId: `skill:${sourceId}`,
        castId: `cast:${sourceId}:${frame}`
    };
}

test('all public ForceSpellStatusAction nodes compile through one four-element primitive', () => {
    const compiler = new AkeActionCompiler({ semanticMappings });
    const compiled = [];
    for (const fileName of readdirSync(SKILL_DATA_URL).filter(name => name.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(fileName, SKILL_DATA_URL), 'utf8'));
        for (const action of findActions(raw, 'ForceSpellStatusAction')) {
            const result = compiler.compileAction(action, {
                path: `${fileName}:ForceSpellStatusAction`
            });
            assert.equal(result.status, 'executable', fileName);
            assert.deepEqual(result.unresolved, [], fileName);
            assert.equal(result.actions.length, 1, fileName);
            assert.equal(result.actions[0].type, 'ForceEnemySpellStatus');
            assert.equal(
                result.actions[0].statusBuffId,
                statusBuffIds[action.spellStatusType]
            );
            assert.deepEqual(result.actions[0].attachmentBuffIds, attachmentBuffIds);
            compiled.push({ fileName, raw: action, action: result.actions[0] });
        }
    }

    assert.equal(compiled.length, 7);
    assert.deepEqual(
        [...new Set(compiled.map(entry => entry.action.spellStatusType))].sort(),
        ['Cryst', 'Pulse']
    );
    assert.equal(
        compiled.some(entry => entry.fileName.includes('liino')
            && entry.raw.consumedLayer.value === 0),
        true
    );
});

test('all four operators close forced-status Buff dependencies from their real skill graphs', () => {
    const expected = {
        chr_0007_ikut: [
            statusBuffIds.Pulse,
            'buff_common_pulse_pulse_conduct_triggered_do'
        ],
        chr_0017_yvonne: [
            statusBuffIds.Cryst,
            'buff_common_cryst_cryst_frozen_triggered_do'
        ],
        chr_0024_deepfin: [
            statusBuffIds.Cryst,
            'buff_common_cryst_cryst_frozen_triggered_do'
        ],
        chr_0035_liino: [
            statusBuffIds.Pulse,
            'buff_common_pulse_pulse_conduct_triggered_do'
        ]
    };
    const assembler = new AkeScenarioAssembler();
    for (const [characterId, buffIds] of Object.entries(expected)) {
        const bundle = assembler.assemble({
            characterId,
            enemyId: 'eny_0007_mimicw'
        });
        assert.equal(bundle.dependencySummary.missingBuffCount, 0, characterId);
        for (const buffId of buffIds) {
            assert.equal(bundle.buffs.has(buffId), true, `${characterId}: ${buffId}`);
        }
    }
});

test('forced abnormal status consumes exact attachment layers with source ledger', () => {
    const runtime = createRuntime();
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: attachmentBuffIds.Cryst
    }, context('caster-a', 0));
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: attachmentBuffIds.Cryst
    }, context('caster-b', 1));
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: attachmentBuffIds.Cryst
    }, context('caster-b', 2));

    const result = runtime.execute({
        type: 'ForceEnemySpellStatus',
        sourceRef: 'Source',
        target: 'Target',
        spellStatusType: 'Cryst',
        statusBuffId: statusBuffIds.Cryst,
        attachmentBuffIds,
        count: 2,
        consumedLayer: 2,
        consumedType: 2
    }, context('caster-b', 3));

    assert.equal(result.status, 'Applied');
    assert.equal(result.branch, 'ForcedSpellStatusApplied');
    assert.equal(result.before, 3);
    assert.equal(result.after, 1);
    assert.equal(result.consumedStacks, 2);
    assert.deepEqual(result.bySource, [{
        sourceId: 'caster-b',
        ownerId: 'caster-b',
        count: 2
    }]);
    const attachment = runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: attachmentBuffIds.Cryst
    })[0];
    assert.equal(attachment.stackCount, 1);
    const frozen = runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: statusBuffIds.Cryst
    })[0];
    assert.deepEqual({
        sourceId: frozen.sourceId,
        count: frozen.blackboard.count,
        consumedLayer: frozen.blackboard.consumed_layer,
        consumedType: frozen.blackboard.consumed_type
    }, {
        sourceId: 'caster-b',
        count: 2,
        consumedLayer: 2,
        consumedType: 2
    });
});

test('the same forced-status transaction covers all four public AKE elements', () => {
    for (const [consumedType, spellStatusType] of [
        [0, 'Fire'],
        [1, 'Pulse'],
        [2, 'Cryst'],
        [3, 'Natural']
    ]) {
        const runtime = createRuntime();
        const result = runtime.execute({
            type: 'ForceEnemySpellStatus',
            sourceRef: 'Source',
            target: 'Target',
            spellStatusType,
            statusBuffId: statusBuffIds[spellStatusType],
            attachmentBuffIds,
            count: 1,
            consumedLayer: 0,
            consumedType
        }, context('caster-a', 0));
        assert.equal(result.status, 'Applied', spellStatusType);
        assert.equal(result.consumedElement, spellStatusType);
        assert.equal(runtime.statusEffects.has({
            targetId: 'enemy',
            buffId: statusBuffIds[spellStatusType]
        }), true, spellStatusType);
    }
});

test('zero-layer forced abnormal status is valid and invalid requests fail closed', () => {
    const runtime = createRuntime();
    const direct = runtime.execute({
        type: 'ForceEnemySpellStatus',
        sourceRef: 'Source',
        target: 'Target',
        spellStatusType: 'Pulse',
        statusBuffId: statusBuffIds.Pulse,
        attachmentBuffIds,
        count: 1,
        consumedLayer: 0,
        consumedType: 1
    }, context('caster-a', 0));
    assert.equal(direct.status, 'Applied');
    assert.equal(direct.before, 0);
    assert.equal(direct.after, 0);
    assert.equal(direct.consumedStacks, 0);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy',
        buffId: statusBuffIds.Pulse
    }), true);

    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: attachmentBuffIds.Cryst
    }, context('caster-a', 1));
    const invalid = runtime.execute({
        type: 'ForceEnemySpellStatus',
        sourceRef: 'Source',
        target: 'Target',
        spellStatusType: 'Cryst',
        statusBuffId: statusBuffIds.Cryst,
        attachmentBuffIds,
        count: 2,
        consumedLayer: 2,
        consumedType: 2
    }, context('caster-b', 2));
    assert.equal(invalid.status, 'Unresolved');
    assert.equal(invalid.code, 'FORCED_SPELL_STATUS_ATTACHMENT_INSUFFICIENT');
    assert.equal(runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: attachmentBuffIds.Cryst
    })[0].stackCount, 1);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy',
        buffId: statusBuffIds.Cryst
    }), false);
});
