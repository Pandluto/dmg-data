import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AkeDataRepository,
    akeDerivedAbilityModifiers,
    applyAkeAttributeModifiers,
    parseAkeJson,
    renderAkeSkillText
} from '../src/core/ake-data-repository.mjs';

test('AKEDatabase reader preserves Int64 text ids and hydrates the complete catalog', () => {
    assert.equal(parseAkeJson('{"name":{"id":7201533996830628902,"text":""}}').name.id,
        '7201533996830628902');
    assert.equal(renderAkeSkillText(
        '冷却缩减+{1-cooldown:0%}，降抗{-resist:0%}',
        { cooldown: 0.85, resist: -0.2 }
    ), '冷却缩减+15%，降抗20%');
    const repository = new AkeDataRepository();
    const catalog = repository.catalog();
    assert.equal(catalog.source.provider, 'AKEDatabase');
    assert.equal(catalog.source.version, '1.4.4@9433094-12');
    assert.equal(catalog.characters.length, 32);
    assert.equal(catalog.weapons.length, 77);
    assert.equal(catalog.equipment.length, 243);
    assert.equal(catalog.suits.length, 23);
    const pelica = catalog.characters.find(character => character.id === 'chr_0004_pelica');
    assert.equal(pelica.name, '佩丽卡');
    assert.equal(pelica.weaponTypeId, 2);
    assert.equal(pelica.defaultWeaponId, 'wpn_funnel_0002');
    assert.equal(pelica.maxUltimateSp, 80);
    assert.deepEqual(new Set(pelica.skills.map(skill => skill.commandType)), new Set([
        'Attack', 'NormalSkill', 'UltimateSkill', 'ComboSkill', 'BreakingAttack'
    ]));
    assert.match(pelica.iconUrl, /^https:\/\/data\.akedata\.wiki\/public\/images\//);
    const annihilationProtocol = pelica.loadoutEffects.talent
        .find(effect => effect.effectId === 'chr_0004_pelica_talent_1_2');
    assert.deepEqual(annihilationProtocol.effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category,
        activation: effect.activation
    })), [{
        type: 'imbalanceDmgBonus',
        value: 0.3,
        category: 'condition',
        activation: { kind: 'targetImbalanced' }
    }]);
    const supervision = pelica.loadoutEffects.potential
        .find(effect => effect.effectId === 'chr_0004_pelica_potential_3');
    assert.equal(supervision.name, '三潜·监督重任');
    assert.deepEqual(supervision.effects.map(effect => [
        effect.type,
        effect.value,
        effect.category,
        effect.maxStacks
    ]), [['atkPercentBoost', 0.2, 'countable', 2]]);
    const administrator = catalog.characters.find(character =>
        character.id === 'chr_0003_endminf');
    assert.deepEqual(administrator.loadoutEffects.talent.map(effect => effect.effectId), [
        'chr_9000_endmin_talent_1_2',
        'chr_9000_endmin_talent_2_2'
    ]);
    assert.deepEqual(administrator.loadoutEffects.talent.map(effect => (
        effect.effects.map(item => ({
            type: item.type,
            value: item.value,
            activation: item.activation
        }))
    )), [[{
        type: 'atkPercentBoost',
        value: 0.3,
        activation: undefined
    }], [{
        type: 'physicalFragile',
        value: 0.2,
        activation: { kind: 'targetStatus', status: 'originium-seal' }
    }]]);
    assert.match(administrator.loadoutEffects.talent[0].description, /攻击力\+30%/);
    const lifengSkillEffects = repository.catalogSkillEffects(
        'chr_0015_lifeng_normal_skill',
        { blackboard: repository.skillBlackboard('chr_0015_lifeng_normal_skill', 12) }
    );
    assert.deepEqual(lifengSkillEffects.map(effect => ({
        type: effect.type,
        value: effect.value,
        durationSeconds: effect.durationSeconds
    })), [{
        type: 'physicalVulnerability',
        value: 0.12,
        durationSeconds: 12
    }]);
    const mifu = catalog.characters.find(character => character.id === 'chr_0031_mifu');
    const mifuPotential = mifu.loadoutEffects.potential.find(effect =>
        effect.effectId === 'chr_0031_mifu_potential_1');
    assert.deepEqual(mifuPotential.effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        durationSeconds: effect.durationSeconds
    })), [{
        type: 'physicalVulnerability',
        value: 0.05,
        durationSeconds: 20
    }], 'potential group should contain only its +5% delta, not duplicate the skill base effect');
    const gemini = catalog.weapons.find(weapon => weapon.id === 'wpn_funnel_0002');
    assert.equal(gemini.skillPatches.find(skill => skill.role === 'primary').levels[8].description,
        '主能力值+79');
    const geminiPassive = gemini.skillPatches.find(skill => skill.role === 'passive').levels[3];
    assert.equal(geminiPassive.description,
        '攻击力+19。');
    assert.deepEqual(geminiPassive.effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category
    })), [{
        type: 'flatAtk',
        value: 19.2,
        category: 'passive'
    }]);
    const industrial = catalog.weapons.find(weapon => weapon.id === 'wpn_claym_0003');
    const industrialPassive = industrial.skillPatches.find(skill => skill.role === 'passive').levels[0];
    assert.deepEqual(industrialPassive.effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category,
        durationSeconds: effect.durationSeconds
    })), [{
        type: 'atkPercentBoost',
        value: 0.12,
        category: 'condition',
        durationSeconds: 20
    }]);
    const paradigm = catalog.weapons.find(weapon => weapon.id === 'wpn_claym_0004');
    assert.equal(paradigm.skillPatches.find(skill => skill.role === 'secondary').levels[8].description,
        '攻击力+39%');
    const bioSupportPlate = catalog.equipment.find(equipment =>
        equipment.id === 'item_equip_t4_suit_heal01_edc_03');
    assert.equal(bioSupportPlate.name, '生物辅助护板');
    assert.equal(bioSupportPlate.modifiers.length, 3);
    assert.deepEqual(
        bioSupportPlate.modifiers.map(modifier => [modifier.attrIndex, modifier.compositeAttr]),
        [[1, ''], [2, ''], [3, 'Main']]
    );
    assert.deepEqual(bioSupportPlate.modifiers[2].values, [
        0.2070178350109774,
        0.22771961851207514,
        0.24842140201317287,
        0.2691231855142706
    ]);
    const messenger = catalog.suits.find(suit => suit.id === 'suit_agi01');
    assert.deepEqual(messenger.bonuses[0].effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category
    })), [{
        type: 'agilityBoost',
        value: 50,
        category: 'passive'
    }, {
        type: 'physicalDmgBonus',
        value: 0.2,
        category: 'condition'
    }]);
    const pioneer = catalog.suits.find(suit => suit.id === 'suit_atb01');
    assert.deepEqual(pioneer.bonuses[0].effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category,
        durationSeconds: effect.durationSeconds
    })), [{
        type: 'allDmgBonus',
        value: 0.16,
        category: 'condition',
        durationSeconds: 15
    }]);
    const pointSword = catalog.suits.find(suit => suit.id === 'suit_phy01');
    assert.deepEqual(pointSword.bonuses[0].effects.map(effect => ({
        type: effect.type,
        value: effect.value,
        category: effect.category,
        effectKind: effect.effectKind,
        extraHitConfig: effect.extraHitConfig
    })), [{
        type: 'imbalanceEfficiency',
        value: 0.2,
        category: 'passive',
        effectKind: undefined,
        extraHitConfig: undefined
    }, {
        type: 'extraHit',
        value: 2.5,
        category: 'condition',
        effectKind: 'extraHit',
        extraHitConfig: {
            key: 'passive_equipsuit_physuit_01-physical-anomaly-extra-hit',
            damageType: 'physical',
            skillType: '',
            baseMultiplier: 2.5,
            imbalanceValue: 10,
            cooldownSeconds: 15,
            trigger: 'physicalAbnormal'
        }
    }]);
});

test('AKEDatabase build primitives select raw level rows, compatible weapons and four slots', () => {
    const repository = new AkeDataRepository();
    const chenTalentPresentation = repository.buffPresentation(
        'buff_chr_0005_chen_talent_0_1'
    );
    assert.equal(chenTalentPresentation.iconId, 'icon_battle_buff_atk_up');
    assert.equal(chenTalentPresentation.displayable, true);
    assert.deepEqual(chenTalentPresentation.displayChannels, ['showInSquadIcon']);
    const pelica = repository.characterAttributes('chr_0004_pelica', { level: 90 });
    assert.equal(pelica.breakStage, 4);
    assert.equal(pelica.attributes.Atk, 303);
    assert.equal(pelica.attributes.MaxHp, 5495);
    const weapon = repository.weaponAttributes('wpn_funnel_0002', {
        level: 90,
        potential: 1,
        mainAttrType: 41
    });
    assert.equal(weapon.baseAtk, 283);
    assert.deepEqual(weapon.modifiers.map(modifier => [modifier.attribute, modifier.value]), [
        ['Atk', 283],
        ['Wisd', 10]
    ]);
    assert.throws(() => repository.equipmentModifiers([
        'item_equip_t0_parts_tundra01_body_01',
        'item_equip_t0_parts_tundra01_body_02'
    ]), /exceeds 1 slot/);
});

test('AKEDatabase documented four-ability projection reproduces the level-one panel formula', () => {
    const repository = new AkeDataRepository();
    const character = repository.table('CharacterTable').chr_0004_pelica;
    const base = repository.characterAttributes('chr_0004_pelica', { level: 1 }).attributes;
    const weapon = repository.weaponAttributes('wpn_funnel_0002', {
        level: 1,
        potential: 1,
        mainAttrType: character.mainAttrType
    });
    const weaponPassive = {
        attribute: 'Atk', attrType: 2, modifierType: 7,
        zone: 'BaseFinalAddition', value: 12
    };
    const abilityAttributes = applyAkeAttributeModifiers(base, weapon.modifiers);
    const result = applyAkeAttributeModifiers(base, [
        ...weapon.modifiers,
        weaponPassive,
        ...akeDerivedAbilityModifiers(abilityAttributes, character)
    ]);
    assert.equal(result.MaxHp, 545);
    assert.equal(result.Atk, 83.851);
    assert.ok(Math.abs(result.HealTakenIncrease - 0.013) < 1e-12);
    assert.equal(result.PhysicalResistance, 100 - 100 / 1.009);
    assert.equal(result.PulseResistance, 100 - 100 / 1.031);
});
