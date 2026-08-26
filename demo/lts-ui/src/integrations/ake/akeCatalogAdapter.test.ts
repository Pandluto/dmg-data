import assert from 'node:assert/strict';

import {
  buildAkeEquipmentLibrary,
  buildAkeOperatorLibrary,
  buildAkeWeaponLibrary,
  type AkeCatalog,
  type AkeTimingSkillProfile,
} from './akeCatalogAdapter';

const LEVEL_KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'M1', 'M2', 'M3'];

function levels(value: number): Record<string, number> {
  return Object.fromEntries(LEVEL_KEYS.map(level => [level, value]));
}

function profile(
  skillId: string,
  variantIndex: number,
  hitValues: number[],
  commandType = 'Attack'
): AkeTimingSkillProfile {
  return {
    commandType,
    skillId,
    variantIndex,
    durationFrames: 30,
    bodyEndOffset: 29,
    tailEndOffset: 29,
    exclusiveFrames: 30,
    cooldownFrames: 0,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [],
    interruptibleAt: [],
    hits: hitValues.map((value, index) => ({
      offsetFrames: index + 1,
      sourceSkillId: `${skillId}-hit`,
      rootSkillId: skillId,
      kind: 'projectile',
      hitCount: 1,
      damageTypes: ['Pulse'],
      damageType: 'Pulse',
      levels: levels(value),
      ...(commandType === 'NormalSkill' ? {
        hitBuffs: [{
          id: 'buff_common_energy_shard_attached_pulse',
          displayName: '电磁附着',
          target: 'target',
          targetLabel: '目标',
          kind: 'attachment',
        }],
      } : {}),
      multiplierDerivation: 'compiled-damage-packet',
    })),
    resourceEvents: [],
    recoveryPauses: [],
    derivation: 'compiled-fallback',
  };
}

const attackIds = ['attack1', 'attack2', 'attack3', 'attack4'];
const profiles = [
  profile('attack1', 0, [0.57]),
  profile('attack2', 1, [0.34, 0.34]),
  profile('attack3', 2, [0.28, 0.28, 0.28]),
  profile('attack4', 3, [1.27]),
  profile('normal-skill', 0, [4], 'NormalSkill'),
];

const catalog = {
  schemaVersion: 2,
  source: { provider: 'test' },
  characters: [{
    id: 'chr_0004_pelica',
    name: '佩丽卡',
    rarity: 6,
    profession: '术师',
    elementId: 'Pulse',
    weaponType: '施术单元',
    weaponTypeId: 2,
    defaultWeaponId: 'wpn_funnel_0002',
    iconUrl: '/pelica.png',
    attributes: {},
    loadoutEffects: {
      talent: [{
        effectId: 'pelica-talent',
        name: '天赋·歼灭协议',
        description: '对失衡敌人伤害 +30%',
        level: 2,
        effects: [{
          effectId: 'pelica-talent:imbalance',
          name: '天赋·歼灭协议',
          type: 'imbalanceDmgBonus',
          category: 'condition',
          value: 0.3,
          unit: 'percent',
          activation: { kind: 'targetImbalanced' },
          description: '对失衡敌人伤害 +30%',
        }],
      }],
      potential: [],
    },
    skills: [{
      groupId: 'pelica-attack',
      commandType: 'Attack',
      name: '普攻',
      description: '',
      iconUrl: '/attack.png',
      skillIds: attackIds,
    }, {
      groupId: 'pelica-normal-skill',
      commandType: 'NormalSkill',
      name: '战技',
      description: '',
      iconUrl: '/normal.png',
      skillIds: ['normal-skill'],
    }],
  }],
  weapons: [{
    id: 'wpn_test',
    name: '测试武器',
    description: '测试武器描述',
    rarity: 6,
    weaponType: '施术单元',
    weaponTypeId: 2,
    iconUrl: '/weapon.png',
    attackGrowth: { 90: 300 },
    skillPatches: [{
      id: 'sk_wpn_test',
      role: 'passive',
      name: '固有效果',
      tagId: 'force',
      levels: [1, 4].map((level) => ({
        level,
        name: '固有效果',
        tagId: 'force',
        descriptionTemplate: '攻击力提升',
        description: `攻击力+${level === 1 ? 12 : 24}%`,
        blackboard: {},
        effects: [{
          effectId: `weapon-atk-${level}`,
          sourceBuffId: 'weapon-atk',
          type: 'atkPercentBoost',
          value: level === 1 ? 0.12 : 0.24,
          unit: 'percent',
          category: 'passive',
        }],
      })),
    }],
  }],
  equipment: ['armor', 'glove', 'accessory'].map((part, index) => ({
    id: `equip-${part}`,
    name: `测试装备${index + 1}`,
    description: '',
    partName: (index === 0 ? '护甲' : index === 1 ? '护手' : '配件') as '护甲' | '护手' | '配件',
    suitId: 'suit-test',
    iconUrl: `/equip-${part}.png`,
    modifiers: [],
  })),
  suits: [{
    id: 'suit-test',
    name: '测试套装',
    equipmentIds: ['equip-armor', 'equip-glove', 'equip-accessory'],
    bonuses: [{
      count: 3,
      skillId: 'passive_equipsuit_test',
      skillLevel: 1,
      description: '3件套：战技伤害+20%。',
      effects: [{
        effectId: 'set-skill-damage',
        sourceBuffId: 'passive_equipsuit_test:card',
        type: 'skillDmgBonus',
        value: 0.2,
        unit: 'percent',
        category: 'passive',
      }, {
        effectId: 'set-physical-anomaly-extra-hit',
        sourceBuffId: 'buff_equipsuit_test',
        type: 'extraHit',
        value: 2.5,
        unit: 'multiplier',
        category: 'condition',
        effectKind: 'extraHit',
        extraHitConfig: {
          key: 'set-physical-anomaly-extra-hit',
          damageType: 'physical',
          skillType: '',
          baseMultiplier: 2.5,
          imbalanceValue: 10,
          cooldownSeconds: 15,
          trigger: 'physicalAbnormal',
        },
      }],
    }],
  }],
  timing: {
    schemaVersion: 1,
    tickRate: 30,
    nodeFrameScale: 15,
    source: { provider: 'test', generator: 'test', semantics: 'test' },
    sharedAtb: {
      initial: 300,
      max: 300,
      ratePerSecond: 8,
      firstTickFrame: 1,
      resumeDelayFramesAfterSpend: 16,
      quantization: 'float32',
    },
    characters: {
      chr_0004_pelica: {
        characterId: 'chr_0004_pelica',
        maxUltimateSp: 80,
        profiles,
      },
    },
  },
} as unknown as AkeCatalog;

const library = buildAkeOperatorLibrary(catalog) as Record<string, {
  buffs: {
    talent: { effects: Record<string, {
      type: string;
      value: number;
      activation?: { kind: string };
    }> };
  };
  skills: Record<string, {
    hitCount: number;
    hitMeta: Record<string, {
      displayName: string;
      element: string;
      levels: Record<string, number>;
      hitBuffs?: Array<{ id: string; displayName: string; target: string }>;
    }>;
  }>;
}>;
const pelica = library.chr_0004_pelica;
const attack = pelica.skills.attack1;
const normalSkill = pelica.skills['normal-skill'];

assert.equal(attack.hitCount, 7);
assert.deepEqual(Object.values(attack.hitMeta).map(hit => hit.levels.M3), [
  0.57, 0.34, 0.34, 0.28, 0.28, 0.28, 1.27,
]);
assert.deepEqual(Object.values(attack.hitMeta).map(hit => hit.displayName), [
  '第1段 · 第1击',
  '第2段 · 第1击',
  '第2段 · 第2击',
  '第3段 · 第1击',
  '第3段 · 第2击',
  '第3段 · 第3击',
  '第4段 · 第1击',
]);
assert.ok(Object.values(attack.hitMeta).every(hit => hit.element === 'electric'));
assert.equal(normalSkill.hitMeta.hit1.levels.M3, 4);
assert.deepEqual(normalSkill.hitMeta.hit1.hitBuffs, [{
  id: 'buff_common_energy_shard_attached_pulse',
  displayName: '电磁附着',
  target: 'target',
  targetLabel: '目标',
  kind: 'attachment',
}]);
assert.deepEqual(pelica.buffs.talent.effects['pelica-talent:imbalance'], {
  schemaVersion: 2,
  effectId: 'pelica-talent:imbalance',
  name: '天赋·歼灭协议',
  type: 'imbalanceDmgBonus',
  category: 'condition',
  value: 0.3,
  unit: 'percent',
  activation: { kind: 'targetImbalanced' },
  description: '对失衡敌人伤害 +30%',
  raw: '对失衡敌人伤害 +30%',
  valueMode: 'fixed',
  effectKind: 'modifier',
});

const weaponLibrary = buildAkeWeaponLibrary(catalog) as Record<string, {
  skills: { skill3: { effects: Record<string, { category: string; levels: Record<string, number> }> } };
}>;
assert.deepEqual(weaponLibrary['测试武器'].skills.skill3.effects['ake-1'].levels, {
  1: 0.12,
  4: 0.24,
});
assert.equal(weaponLibrary['测试武器'].skills.skill3.effects['ake-1'].category, 'passive');

const equipmentLibrary = buildAkeEquipmentLibrary(catalog) as {
  gearSets: Record<string, { threePieceBuffs?: Record<string, {
    typeKey: string;
    value: number;
    category: string;
    effectKind?: string;
    extraHitConfig?: { baseMultiplier: number; imbalanceValue: number; cooldownSeconds: number };
  }> }>;
};
const threePieceBuffs = Object.values(equipmentLibrary.gearSets['suit-test'].threePieceBuffs ?? {});
const threePieceBuff = threePieceBuffs[0];
assert.deepEqual({
  typeKey: threePieceBuff.typeKey,
  value: threePieceBuff.value,
  category: threePieceBuff.category,
}, {
  typeKey: 'skillDmgBonus',
  value: 0.2,
  category: 'passive',
});
assert.deepEqual({
  effectKind: threePieceBuffs[1].effectKind,
  typeKey: threePieceBuffs[1].typeKey,
  baseMultiplier: threePieceBuffs[1].extraHitConfig?.baseMultiplier,
  imbalanceValue: threePieceBuffs[1].extraHitConfig?.imbalanceValue,
  cooldownSeconds: threePieceBuffs[1].extraHitConfig?.cooldownSeconds,
}, {
  effectKind: 'extraHit',
  typeKey: 'extraHit',
  baseMultiplier: 2.5,
  imbalanceValue: 10,
  cooldownSeconds: 15,
});
