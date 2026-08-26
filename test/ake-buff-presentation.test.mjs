import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAkeBuffPresentationIndex,
    resolveAkeBuffPresentation
} from '../src/core/ake-buff-presentation.mjs';

const index = buildAkeBuffPresentationIndex({
    characters: [{
        id: 'chr_0005_chen',
        name: '陈千语',
        skills: [{
            name: '冽风霜',
            skillIds: ['chr_0005_chen_ultimate_skill']
        }],
        loadoutEffects: {
            talent: [{
                name: '天赋·斩锋',
                effects: [{
                    sourceBuffId: 'buff_chr_0005_chen_talent_0_1',
                    name: '天赋·斩锋',
                    type: 'atkPercentBoost',
                    applicationScope: 'self',
                    description: '技能命中后叠加攻击力。'
                }]
            }]
        }
    }]
});

test('catalog Buff presentation keeps Chinese identity, effect type, scope and raw icon', () => {
    const presentation = resolveAkeBuffPresentation({
        buffId: 'buff_chr_0005_chen_talent_0_1',
        index,
        rawPresentation: {
            iconId: 'icon_battle_buff_atk_up',
            iconUrl: 'https://example.test/icon_battle_buff_atk_up.png',
            displayChannels: ['showInSquadIcon'],
            abnormalColorType: 'Physical'
        },
        dataOrigin: 'https://data.akedata.wiki'
    });
    assert.equal(presentation.displayName, '天赋·斩锋');
    assert.equal(presentation.effectType, 'atkPercentBoost');
    assert.equal(presentation.applicationScope, 'self');
    assert.equal(presentation.iconId, 'icon_battle_buff_atk_up');
    assert.equal(presentation.iconUrl, 'https://example.test/icon_battle_buff_atk_up.png');
});

test('semantic status table supplies the actual game icon when the root Buff has none', () => {
    const presentation = resolveAkeBuffPresentation({
        buffId: 'buff_common_enemy_spell_status_conduct',
        index,
        rawPresentation: { iconId: '', iconUrl: '', displayChannels: [] },
        dataOrigin: 'https://data.akedata.wiki'
    });
    assert.equal(presentation.displayName, '导电');
    assert.equal(presentation.applicationScope, 'enemy');
    assert.equal(presentation.iconId, 'icon_battle_conduct');
    assert.match(presentation.iconUrl, /bufficon\/icon_battle_conduct\.png$/);
});

test('unmapped internal Buffs use their source skill name instead of leaking code ids', () => {
    const presentation = resolveAkeBuffPresentation({
        buffId: 'buff_chr_0005_chen_unknown_listener',
        sourceSkillId: 'chr_0005_chen_ultimate_skill',
        index,
        dataOrigin: 'https://data.akedata.wiki'
    });
    assert.equal(presentation.displayName, '冽风霜·技能状态');
    assert.doesNotMatch(presentation.displayName, /buff_|chr_/);
});

