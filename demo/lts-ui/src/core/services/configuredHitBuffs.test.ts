import assert from 'node:assert/strict';

import { buildConfigSnapshot } from '../calculators/operatorPanelCalculator';
import { calculateSkillButtonDamageV2 } from '../calculators/skillButtonDamageCalculatorV2';
import { buildConfiguredHitBuffs } from './configuredHitBuffs';

const snapshot = buildConfigSnapshot({
  operator: {
    id: 'configured-operator',
    name: '配置干员',
    level: 90,
    potential: '满潜',
    mainStat: '力量',
    subStat: '敏捷',
    attributes: {
      level90: { atk: 100, hp: 1000, strength: 100, agility: 50, intelligence: 20, will: 20 },
    },
    buffs: {
      talent: { effects: {
        passiveDamage: {
          effectId: 'passive-damage',
          name: '干员常驻全伤',
          type: 'allDmgBonus',
          category: 'passive',
          value: 0.1,
        },
        conditionalDamage: {
          effectId: 'conditional-damage',
          name: '干员条件物伤',
          type: 'physicalDmgBonus',
          category: 'condition',
          value: 0.5,
          activation: { kind: 'targetImbalanced' },
        },
        sourceSkill: {
          effectId: 'source-skill',
          name: '源石技艺状态',
          type: 'sourceSkillBoost',
          category: 'passive',
          value: 30,
        },
      } },
      potential: { effects: {
        passiveMultiplier: {
          effectId: 'passive-multiplier',
          name: '潜能常驻倍率',
          type: 'multiplierBonus',
          category: 'passive',
          multiplier: { coefficient: 1.1 },
        },
      } },
      skill: { effects: {} },
    },
  },
  weapon: {
    id: 'configured-weapon',
    name: '配置武器',
    config: { level: 90, skillLevels: { skill1: 9, skill2: 9, skill3: 4 } },
    data: {
      attackGrowth: { 90: 100 },
      skills: {
        skill1: { name: '力量提升', statType: '力量提升', levels: { 9: { value: 50 } } },
        skill2: { name: '攻击提升', statType: '攻击提升', levels: { 9: { value: 0.2 } } },
        skill3: { effects: {
          passive: {
            name: '武器常驻战技伤害',
            type: 'skillDmgBonus',
            category: 'passive',
            levels: { 4: 0.3 },
          },
          conditional: {
            name: '武器条件寒冷伤害',
            type: 'iceDmgBonus',
            category: 'condition',
            levels: { 4: 0.8 },
          },
        } },
      },
    },
  },
  equipment: {
    pieces: [],
    setBuffs: [{
      gearSetId: 'configured-set',
      gearSetName: '配置套装',
      effectId: 'set-passive',
      label: '三件套常驻全技能伤害',
      typeKey: 'allSkillDmgBonus',
      level: '三件套',
      value: 0.2,
      category: 'passive',
    }, {
      gearSetId: 'configured-set',
      gearSetName: '配置套装',
      effectId: 'set-condition',
      label: '三件套条件法伤',
      typeKey: 'magicDmgBonus',
      level: '三件套',
      value: 0.9,
      category: 'condition',
    }, {
      gearSetId: 'configured-set',
      gearSetName: '配置套装',
      effectId: 'set-extra-hit',
      label: '三件套物理异常追加伤害',
      typeKey: 'extraHit',
      level: '三件套',
      value: 2.5,
      category: 'condition',
      effectKind: 'extraHit',
      extraHitConfig: {
        key: 'configured-set-extra-hit',
        damageType: 'physical',
        skillType: '',
        baseMultiplier: 2.5,
        imbalanceValue: 10,
        cooldownSeconds: 15,
        trigger: 'physicalAbnormal',
      },
    }],
  },
});

const bundle = buildConfiguredHitBuffs(snapshot);
const displayNames = bundle.displayOnlyBuffs.map((buff) => buff.displayName);
assert.ok(displayNames.includes('力量提升'), 'weapon skill1 should be attributed to every matching Hit');
assert.ok(displayNames.includes('攻击提升'), 'weapon skill2 should be attributed to every matching Hit');
assert.ok(displayNames.includes('武器常驻战技伤害'), 'weapon passive skill3 should be attributed');
assert.ok(displayNames.includes('三件套常驻全技能伤害'), 'three-piece passive should be attributed');
assert.ok(displayNames.includes('干员常驻全伤'), 'operator passive state should be attributed');
assert.ok(!displayNames.includes('武器条件寒冷伤害'), 'inactive weapon condition must not be auto-enabled');
assert.ok(!displayNames.includes('三件套条件法伤'), 'inactive set condition must not be auto-enabled');
assert.ok(!displayNames.includes('干员条件物伤'), 'inactive operator condition must not be auto-enabled');
assert.ok(!displayNames.includes('源石技艺状态'), 'source-skill state is not a normal damage Hit Buff');
assert.deepEqual(bundle.modifierBuffs.map((buff) => buff.displayName), ['潜能常驻倍率']);
assert.equal(bundle.extraHitBuffs.length, 0, 'configured extra hit must wait for its trigger event');
const activeConditionBundle = buildConfiguredHitBuffs(snapshot, { isImbalanced: true });
assert.ok(activeConditionBundle.modifierBuffs.some((buff) => (
  buff.displayName === '干员条件物伤'
  && buff.value === 0.5
  && buff.condition === '木桩/目标状态满足干员条件'
)), 'target state should automatically activate a structured operator condition');
const physicalAnomalyBundle = buildConfiguredHitBuffs(snapshot, { physicalAnomalyTriggered: true });
assert.deepEqual(
  physicalAnomalyBundle.extraHitBuffs.map((buff) => ({
    name: buff.displayName,
    multiplier: buff.extraHitConfig.baseMultiplier,
    imbalance: buff.extraHitConfig.imbalanceValue,
    cooldown: buff.extraHitConfig.cooldownSeconds,
  })),
  [{
    name: '三件套物理异常追加伤害',
    multiplier: 2.5,
    imbalance: 10,
    cooldown: 15,
  }],
  'equipped three-piece extra hit should enter the current physical-anomaly event',
);

const baseInput = {
  buttonId: 'configured-button',
  characterId: snapshot.operator.id,
  runtimeSkillId: 'configured-skill',
  template: {
    characterId: snapshot.operator.id,
    characterName: snapshot.operator.name,
    runtimeSkillId: 'configured-skill',
    displayName: '配置技能',
    buttonType: 'B' as const,
    hits: [{
      key: 'physical',
      displayName: '物理 Hit',
      multiplier: 1,
      element: 'physical' as const,
      skillType: 'B' as const,
    }, {
      key: 'electric',
      displayName: '电磁 Hit',
      multiplier: 1,
      element: 'electric' as const,
      skillType: 'B' as const,
    }],
  },
  panel: {
    atk: snapshot.panel.display.atk,
    critRate: 0,
    critDmg: 0.5,
  },
  damageBonus: snapshot.panel.calc.damageBonus,
};

const withoutDisplay = calculateSkillButtonDamageV2({
  ...baseInput,
  buffs: bundle.modifierBuffs,
});
const withDisplay = calculateSkillButtonDamageV2({
  ...baseInput,
  buffs: bundle.modifierBuffs,
  displayOnlyBuffs: bundle.displayOnlyBuffs,
});
assert.equal(withDisplay.summary.totalNonCrit, withoutDisplay.summary.totalNonCrit, 'display-only attribution must never double-count configured panel values');
assert.ok(withDisplay.hits[0].appliedBuffs.some((buff) => buff.displayName === '干员常驻全伤'));
assert.ok(withDisplay.hits[0].appliedBuffs.some((buff) => buff.displayName === '三件套常驻全技能伤害'));
assert.ok(withDisplay.hits[0].appliedBuffs.some((buff) => buff.displayName === '潜能常驻倍率'));
assert.ok(!withDisplay.hits[0].appliedBuffs.some((buff) => buff.displayName === '武器常驻战技伤害' && buff.type === 'iceDmgBonus'));
