import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { enrichAkeTimingWithHitMultipliers } from '../src/core/ake-hit-profile-builder.mjs';

test('compiled AKE hit profiles resolve Pelica projectile inheritance and all skill levels', () => {
    const projectRoot = path.resolve(import.meta.dirname, '..');
    const timing = JSON.parse(fs.readFileSync(path.join(
        projectRoot,
        'derived',
        'cleanroom',
        'ake-timing-profiles.json'
    ), 'utf8'));
    timing.characters = {
        chr_0004_pelica: timing.characters.chr_0004_pelica
    };

    const enriched = enrichAkeTimingWithHitMultipliers({ projectRoot, timing });
    const profiles = enriched.characters.chr_0004_pelica.profiles;
    const attack2 = profiles.find(profile =>
        profile.skillId === 'chr_0004_pelica_attack2');
    const normalSkill = profiles.find(profile =>
        profile.skillId === 'chr_0004_pelica_normal_skill');
    const comboSkill = profiles.find(profile =>
        profile.skillId === 'chr_0004_pelica_combo_skill');
    const ultimate = profiles.find(profile =>
        profile.skillId === 'chr_0004_pelica_ultimate_skill');

    assert.deepEqual(attack2.hits.map(hit => hit.levels.M3), [0.34, 0.34]);
    assert.equal(attack2.hits[0].damageType, 'Pulse');
    assert.equal(attack2.hits[0].multiplierDerivation, 'compiled-damage-packet');
    assert.equal(normalSkill.hits[0].levels.L1, 1.78);
    assert.equal(normalSkill.hits[0].levels.M3, 4);
    assert.deepEqual(normalSkill.hits[0].hitBuffs.map(buff => ({
        id: buff.id,
        displayName: buff.displayName,
        target: buff.target
    })), [{
        id: 'buff_common_energy_shard_attached_pulse',
        displayName: '电磁附着',
        target: 'target'
    }, {
        id: 'buff_common_obtain_ultimate_sp',
        displayName: '终结技能量恢复',
        target: 'self'
    }, {
        id: 'ake_status_poise_damage',
        displayName: '失衡值',
        target: 'target'
    }]);
    assert.equal(comboSkill.hits[0].levels.L1, 0.8);
    assert.equal(comboSkill.hits[0].levels.M3, 1.8);
    assert.deepEqual(comboSkill.hits[0].hitBuffs.map(buff => buff.id), [
        'buff_common_pulse_pulse_conduct_triggered',
        'ake_status_poise_damage'
    ]);
    assert.equal(ultimate.hits[0].levels.L9, 8);
    assert.equal(ultimate.hits[0].levels.M3, 10);
});

test('compiled AKE hit profiles preserve target routing and numeric hit-applied buffs', () => {
    const projectRoot = path.resolve(import.meta.dirname, '..');
    const timing = JSON.parse(fs.readFileSync(path.join(
        projectRoot,
        'derived',
        'cleanroom',
        'ake-timing-profiles.json'
    ), 'utf8'));
    timing.characters = {
        chr_0031_mifu: timing.characters.chr_0031_mifu
    };

    const enriched = enrichAkeTimingWithHitMultipliers({ projectRoot, timing });
    const comboSkill = enriched.characters.chr_0031_mifu.profiles.find(profile =>
        profile.skillId === 'chr_0031_mifu_combo_skill');
    const vulnerable = comboSkill.hits
        .flatMap(hit => hit.hitBuffs ?? [])
        .find(buff => buff.id === 'buff_chr_0031_mifu_vulnerablephysic_comboskill');

    assert.equal(vulnerable.target, 'target');
    assert.equal(vulnerable.targetLabel, '目标');
    assert.deepEqual(vulnerable.effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        durationSeconds: effect.durationSeconds
    })), [{
        type: 'physicalVulnerability',
        value: 0.05,
        durationSeconds: 16
    }]);
});

test('forced spell statuses project to the same hit that executes the runtime action', () => {
    const projectRoot = path.resolve(import.meta.dirname, '..');
    const timing = JSON.parse(fs.readFileSync(path.join(
        projectRoot,
        'derived',
        'cleanroom',
        'ake-timing-profiles.json'
    ), 'utf8'));
    timing.characters = Object.fromEntries([
        'chr_0007_ikut',
        'chr_0024_deepfin',
        'chr_0035_liino'
    ].map(characterId => [characterId, timing.characters[characterId]]));

    const enriched = enrichAkeTimingWithHitMultipliers({ projectRoot, timing });
    const forcedStatuses = Object.fromEntries(Object.entries(enriched.characters)
        .map(([characterId, character]) => [
            characterId,
            character.profiles.flatMap(profile => profile.hits ?? [])
                .flatMap(hit => hit.hitBuffs ?? [])
                .filter(buff => ['conductive', 'freeze'].includes(buff.statusKey))
                .map(buff => ({ id: buff.id, statusKey: buff.statusKey }))
        ]));

    assert.deepEqual(forcedStatuses, {
        chr_0007_ikut: [{
            id: 'buff_common_pulse_pulse_conduct_triggered',
            statusKey: 'conductive'
        }],
        chr_0024_deepfin: [{
            id: 'buff_common_cryst_cryst_frozen_triggered',
            statusKey: 'freeze'
        }],
        chr_0035_liino: [{
            id: 'buff_common_pulse_pulse_conduct_triggered',
            statusKey: 'conductive'
        }]
    });
});

test('cross-operator audit keeps real multipliers, compact bodies and stable state markers', () => {
    const projectRoot = path.resolve(import.meta.dirname, '..');
    const timing = JSON.parse(fs.readFileSync(path.join(
        projectRoot,
        'derived',
        'cleanroom',
        'ake-timing-profiles.json'
    ), 'utf8'));
    const enriched = enrichAkeTimingWithHitMultipliers({ projectRoot, timing });
    const profile = (characterId, skillId) => enriched.characters[characterId].profiles
        .find(candidate => candidate.skillId === skillId);
    const statusKeys = value => new Set((value ?? []).map(effect => effect.statusKey ?? effect.id));

    const chenCombo = profile('chr_0005_chen', 'chr_0005_chen_combo_skill');
    assert.equal(chenCombo.bodyEndOffset, 40);
    assert.equal(chenCombo.hits[0].levels.M3, 2.7);
    assert.ok(statusKeys(chenCombo.hits[0].hitBuffs).has('airborne'));

    for (const characterId of ['chr_0002_endminm', 'chr_0003_endminf']) {
        const normal = profile(characterId, `${characterId}_normal_skill`);
        const combo = profile(characterId, `${characterId}_combo_skill`);
        const ultimate = profile(characterId, `${characterId}_ultimate_skill`);
        assert.equal(normal.hits[0].levels.M3, 3.5);
        assert.ok(statusKeys(normal.hits[0].hitBuffs).has('crush'));
        assert.equal(combo.hits[0].levels.M3, 1);
        assert.ok(statusKeys(combo.hits[0].hitBuffs).has('originium-seal'));
        const originiumSeal = combo.hits[0].hitBuffs.find(buff => buff.statusKey === 'originium-seal');
        assert.equal(originiumSeal?.statusValue, 1.78);
        assert.equal(
            originiumSeal?.statusValueLevels?.M3,
            4,
            'administrator combo should preserve the crystal M3 4.0 trigger atkScale after AKE level scaling'
        );
        assert.equal(ultimate.hits[0].levels.M3, 8);
    }

    const mifuThird = profile('chr_0031_mifu', 'chr_0031_mifu_normalskill_3');
    assert.deepEqual(mifuThird.hits.map(hit => hit.offsetFrames), [26]);
    assert.equal(mifuThird.hits[0].levels.M3, 6);

    const jueNormal = profile('chr_0032_lizhiyan', 'chr_0032_lizhiyan_normal_skill');
    const jueCombo = profile('chr_0032_lizhiyan', 'chr_0032_lizhiyan_combo_skill');
    const jueUltimate = profile('chr_0032_lizhiyan', 'chr_0032_lizhiyan_ultimate_skill');
    assert.equal(jueNormal.hits[0].levels.M3, 5);
    assert.ok(statusKeys(jueNormal.hits[0].hitBuffs).has('attachment-nature'));
    assert.equal(jueCombo.hits[0].levels.M3, 0.8);
    assert.ok(statusKeys(jueCombo.statusEffects)
        .has('buff_chr_0032_lizhiyan_combo_skill_seal_total'));
    assert.ok(statusKeys(jueUltimate.statusEffects).has('corrosion'));

    const liinoNormal = profile('chr_0035_liino', 'chr_0035_liino_normal_skill');
    assert.ok(liinoNormal.formEvents.some(event => (
        event.operation === 'apply'
        && event.skillSlot === 'NormalSkill'
        && event.targetSkillId === 'chr_0035_liino_normal_skill_end'
    )));
    assert.equal(liinoNormal.formEvents.some(event => (
        event.operation === 'remove' && event.offsetFrames === 0
    )), false, 'an indefinite form Buff must not become a synthetic frame-zero removal');

    const dapanUltimate = profile('chr_0018_dapan', 'chr_0018_dapan_ultimate_skill');
    const dapanKnockdownHits = dapanUltimate.hits
        .filter(hit => statusKeys(hit.hitBuffs).has('knockdown'));
    assert.deepEqual(
        dapanKnockdownHits.map(hit => hit.offsetFrames),
        [81],
        'the frame-80 KnockDownAction belongs only to its frame-81 settlement, not the preceding ticks'
    );

    const wulfaCombo3 = profile('chr_0028_wulfa', 'chr_0028_wulfa_combo_3_skill');
    assert.deepEqual(
        wulfaCombo3.hits
            .filter(hit => statusKeys(hit.hitBuffs).has('airborne'))
            .map(hit => hit.offsetFrames),
        [29],
        'a frame-29 AirborneAction must not be copied onto all nine damage hits'
    );

    const wulfaCombo2 = profile('chr_0028_wulfa', 'chr_0028_wulfa_combo_2_skill');
    const restoredCombo = wulfaCombo2.formEvents.filter(event => (
        event.offsetFrames === 216
        && event.skillSlot === 'ComboSkill'
        && event.targetSkillId === 'chr_0028_wulfa_combo_2_skill'
    ));
    assert.deepEqual(
        restoredCombo.map(event => event.operation),
        ['apply'],
        'the pending-empty event restores the infinite base override at the settled expiry edge'
    );
    assert.deepEqual(
        wulfaCombo2.comboPendingEvents.map(event => ({
            offsetFrames: event.offsetFrames,
            operation: event.operation,
            skillSlot: event.skillSlot,
            targetSkillId: event.targetSkillId,
            pendingDurationFrames: event.pendingDurationFrames,
            bypassSkillCooldown: event.bypassSkillCooldown,
            sourceActionType: event.sourceActionType
        })),
        [{
            offsetFrames: 37,
            operation: 'trigger',
            skillSlot: 'ComboSkill',
            targetSkillId: 'chr_0028_wulfa_combo_3_skill',
            pendingDurationFrames: 180,
            bypassSkillCooldown: true,
            sourceActionType: 'TriggerComboSkillAction'
        }],
        'the timing catalog projects the settled chained-combo pending transaction'
    );
    assert.deepEqual(wulfaCombo2.comboPendingEvents[0].precisionWindow, {
        startAfterTriggerFrames: 15,
        endAfterTriggerFramesExclusive: 27,
        activeDurationFrames: 12,
        boundary: 'start-inclusive-end-exclusive',
        sourceActionType: 'ShowComboRingQte',
        sourceBuffId: 'buff_chr_0028_wulfa_combo_2_qte_timerlistening'
    }, 'the precise QTE subwindow uses the settled level-patched Buff Blackboard');

    const catalogStatusKeys = new Set(Object.values(enriched.characters)
        .flatMap(character => character.profiles)
        .flatMap(candidate => [
            ...(candidate.statusEffects ?? []),
            ...candidate.hits.flatMap(hit => hit.hitBuffs ?? [])
        ])
        .map(effect => effect.statusKey)
        .filter(Boolean));
    for (const key of [
        'attachment-fire',
        'attachment-electric',
        'attachment-ice',
        'attachment-nature',
        'no-guard',
        'fracture',
        'conductive',
        'corrosion',
        'knockdown',
        'poise-damage'
    ]) {
        assert.ok(catalogStatusKeys.has(key), `catalog must expose stable ${key} markers`);
    }

    for (const character of Object.values(enriched.characters)) {
        for (const candidate of character.profiles) {
            assert.equal(candidate.derivation, 'isolated-runtime-probe',
                `${candidate.skillId} must not fall back to a guessed compiled timeline`);
            if (candidate.exclusiveFrames > 0) {
                assert.ok(candidate.bodyEndOffset <= candidate.exclusiveFrames,
                    `${candidate.skillId} body must not use its padded asset duration`);
            }
            for (const hit of candidate.hits) {
                assert.ok(hit.levels.M3 > 0,
                    `${candidate.skillId}@${hit.offsetFrames} must be a real positive HP hit`);
            }
        }
    }
});
