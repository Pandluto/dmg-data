import assert from 'node:assert/strict';

import { calculateSkillButtonDamageV2 } from './skillButtonDamageCalculatorV2';
import { buildSkillDamageModalViewModel } from './skillDamageModalViewModel';
import type { SkillDamageCalcInputV2 } from './skillDamage.types';

const input: SkillDamageCalcInputV2 = {
  buttonId: 'pelica-normal-skill-button',
  characterId: 'chr_0004_pelica',
  runtimeSkillId: 'chr_0004_pelica_normal_skill',
  template: {
    characterId: 'chr_0004_pelica',
    characterName: '佩丽卡',
    runtimeSkillId: 'chr_0004_pelica_normal_skill',
    displayName: '协议ω·雷击',
    buttonType: 'B',
    hits: [{
      key: 'hit1',
      displayName: '第1击',
      multiplier: 4,
      element: 'electric',
      skillType: 'B',
      hitBuffs: [{
        id: 'buff_common_energy_shard_attached_pulse',
        displayName: '电磁附着',
        target: 'target',
        targetLabel: '目标',
      }, {
        id: 'buff_common_obtain_ultimate_sp',
        displayName: '终结技能量恢复',
        target: 'self',
        targetLabel: '自身',
      }],
    }],
  },
  buffs: [],
  panel: { atk: 100, critRate: 0, critDmg: 0.5 },
  damageBonus: {
    physicalDmgBonus: 0,
    fireDmgBonus: 0,
    electricDmgBonus: 0,
    iceDmgBonus: 0,
    natureDmgBonus: 0,
    magicDmgBonus: 0,
    normalAttackDmgBonus: 0,
    dotDmgBonus: 0,
    skillDmgBonus: 0,
    chainSkillDmgBonus: 0,
    ultimateDmgBonus: 0,
    allSkillDmgBonus: 0,
    imbalanceDmgBonus: 0,
    allDmgBonus: 0,
  },
};

const result = calculateSkillButtonDamageV2(input);
assert.equal(result.hits[0].multiplier.afterMultiply, 4);
assert.equal(result.hits[0].nonCrit.final, 200);
assert.deepEqual(result.hits[0].appliedBuffs.map(buff => buff.displayName), [
  '电磁附着（目标）',
  '终结技能量恢复（自身）',
]);
assert.ok(result.hits[0].appliedBuffs.every((buff) => (
  buff.ownerCharacterId === 'chr_0004_pelica'
  && buff.ownerBuffDomain === 'operator'
  && buff.ownerBuffGroup === 'skill'
)), '真实技能命中 Buff 应保留干员/技能来源');

const viewModel = buildSkillDamageModalViewModel(
  input.template,
  result,
  0,
  input.panel,
);
assert.equal(viewModel.hitCards[0].buffCountText, '+2 Buff');
assert.equal(viewModel.hitCards[0].multiplierText, '400%');
assert.deepEqual(viewModel.activeHitDetail?.appliedBuffTags.map(buff => buff.label), [
  '电磁附着（目标）',
  '终结技能量恢复（自身）',
]);

const disabledEffectId = 'ake-hit-effect:hit1:buff_common_energy_shard_attached_pulse:0';
const tuned = calculateSkillButtonDamageV2({
  ...input,
  disabledBuffIdsByHitKey: { hit1: [disabledEffectId] },
});
assert.deepEqual(tuned.hits[0].appliedBuffs.map(buff => buff.displayName), [
  '终结技能量恢复（自身）',
]);
assert.equal(tuned.hits[0].nonCrit.final, result.hits[0].nonCrit.final);

const numericEffectResult = calculateSkillButtonDamageV2({
  ...input,
  template: {
    ...input.template,
    hits: [{
      ...input.template.hits[0],
      hitBuffs: [{
        id: 'buff_target_physical_vulnerable',
        displayName: '物理脆弱状态',
        target: 'target',
        targetLabel: '目标',
        effects: [{
          id: 'buff_target_physical_vulnerable:1',
          sourceBuffId: 'buff_target_physical_vulnerable',
          type: 'physicalVulnerability',
          value: 0.05,
          unit: 'percent',
          category: 'condition',
          durationSeconds: 16,
        }],
      }],
    }],
  },
});
assert.equal(
  numericEffectResult.hits[0].appliedBuffs[0].displayName,
  '物理脆弱状态（目标） · 物理脆弱 +5% / 16秒',
);
assert.match(
  numericEffectResult.hits[0].appliedBuffs[0].description || '',
  /解析效果：物理脆弱 \+5% \/ 16秒/,
);
assert.equal(
  numericEffectResult.hits[0].nonCrit.final,
  result.hits[0].nonCrit.final,
  '命中施加的蓝 Buff 只做当前击归因，不能让当前击自吃效果',
);
