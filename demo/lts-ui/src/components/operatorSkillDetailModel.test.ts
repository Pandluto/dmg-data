import assert from 'node:assert/strict';

import type { Character, HitBuffEffect } from '../types';
import { buildSkillDetailGroups, visibleSkillHitBuffs } from './operatorSkillDetailModel';

const visibleBuff: HitBuffEffect = {
  id: 'buff-visible',
  displayName: '防御力提升',
  target: 'self',
  targetLabel: '自身',
  effects: [{
    id: 'buff-visible:1',
    sourceBuffId: 'buff-visible',
    type: 'damageReduction',
    value: 0.5,
    unit: 'percent',
  }],
};
const hiddenBuff: HitBuffEffect = {
  id: 'buff-internal-timer',
  displayName: '技能计时状态',
  target: 'self',
  hidden: true,
};

const character = {
  sandboxSkills: [{
    id: 'normal-skill',
    displayName: '战技',
    buttonType: 'B',
    hitCount: 2,
    source: 'official',
    customHits: [{
      key: 'hit1',
      displayName: '第一击',
      multiplier: 1,
      levels: { M3: 1.25 },
      element: 'fire',
      skillType: 'B',
      hitBuffs: [visibleBuff, hiddenBuff],
    }, {
      key: 'hit2',
      displayName: '第二击',
      multiplier: 2,
      element: 'fire',
      skillType: 'B',
      hitBuffs: [visibleBuff],
    }],
  }],
} as Partial<Character>;

const groups = buildSkillDetailGroups(character, 'B', 'M3');
assert.equal(groups.length, 1);
assert.equal(groups[0].hits.length, 2);
assert.equal(groups[0].hits[0].value, 1.25);
assert.deepEqual(groups[0].buffs.map((buff) => buff.id), ['buff-visible']);
assert.equal(groups[0].hiddenBuffCount, 1);
assert.deepEqual(visibleSkillHitBuffs([visibleBuff, hiddenBuff]), [visibleBuff]);
