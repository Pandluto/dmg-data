import assert from 'node:assert/strict';

import type { AkeRuntimeHit, AkeRuntimeStatusEvent, AkeTeamReport } from '../../integrations/ake/akeProvider';
import {
  buildAkeRuntimeCommandLedger,
  buildAkeRuntimeStatusLabelMap,
} from './akeRuntimeLedger';

const statusBase = {
  sourceId: 'actor-a',
  ownerId: 'actor-a',
  targetId: 'enemy-shared',
  stackCount: 1,
  requested: 1,
  actual: 1,
  discarded: 0,
  durationFrames: 90,
  expireFrame: 90,
  sourceSkillId: 'skill-source',
  rootSkillId: 'skill-source',
  triggerSourceId: null,
  triggerOwnerId: null,
  triggerTargetId: null,
  triggerSkillId: null,
  triggerRootSkillId: null,
  triggerCastId: null,
  reason: null,
} satisfies Omit<AkeRuntimeStatusEvent,
  'traceIndex' | 'frame' | 'stage' | 'instanceId' | 'buffId' | 'before' | 'after' | 'castId'>;

const statusEvents: AkeRuntimeStatusEvent[] = [{
  ...statusBase,
  traceIndex: 0,
  frame: 0,
  stage: 'StatusEffectApplied',
  instanceId: 'status:seal',
  buffId: 'buff_common_originum_frozen',
  before: 0,
  after: 1,
  castId: 'older-cast',
}, {
  ...statusBase,
  traceIndex: 4,
  frame: 11,
  stage: 'StatusEffectApplied',
  instanceId: 'status:no-guard',
  buffId: 'buff_physical_no_guard',
  before: 0,
  after: 2,
  stackCount: 2,
  castId: 'cast:current',
}, {
  ...statusBase,
  traceIndex: 1,
  frame: 12,
  stage: 'StatusEffectApplied',
  instanceId: 'status:self-stack',
  buffId: 'buff_actor_talent_child',
  targetId: 'actor-a',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '天赋·通用叠层',
  shortName: '叠',
  effectType: 'atkPercentBoost',
  applicationScope: 'self',
  iconId: 'icon_battle_buff_atk_up',
  iconUrl: 'https://data.akedata.wiki/buff-atk.png',
}, {
  ...statusBase,
  traceIndex: 2,
  frame: 13,
  stage: 'StatusEffectRefreshed',
  instanceId: 'status:self-stack',
  buffId: 'buff_actor_talent_child',
  targetId: 'actor-a',
  stackCount: 2,
  before: 1,
  after: 2,
  castId: 'cast:current',
  displayName: '天赋·通用叠层',
  shortName: '叠',
  effectType: 'atkPercentBoost',
  applicationScope: 'self',
  iconId: 'icon_battle_buff_atk_up',
  iconUrl: 'https://data.akedata.wiki/buff-atk.png',
}, {
  ...statusBase,
  traceIndex: 3,
  frame: 14,
  stage: 'StatusEffectFinished',
  instanceId: 'status:seal',
  buffId: 'buff_common_originum_frozen',
  before: 1,
  after: 0,
  castId: 'older-cast',
  triggerCastId: 'cast:current',
  triggerSourceId: 'actor-a',
  reason: 'IgniteEvent:PhysicalStatus',
}, {
  ...statusBase,
  traceIndex: 5,
  frame: 15,
  stage: 'StatusEffectApplied',
  instanceId: 'status:conduct',
  buffId: 'buff_common_enemy_spell_status_conduct',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '电磁',
}, {
  ...statusBase,
  traceIndex: 6,
  frame: 16,
  stage: 'StatusEffectApplied',
  instanceId: 'status:pulse-attachment',
  buffId: 'buff_test_energy_shard_attached_pulse',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '电磁',
}];

function runtimeHit(
  hitIndex: number,
  sourceBuffId: string | null,
  atkScale: number,
  includeTalentContribution = true,
): AkeRuntimeHit {
  const attack = 1000;
  const nonCriticalDamage = attack * atkScale * 0.5 * 1.2;
  return {
    hitIndex,
    traceIndex: hitIndex,
    frame: 13,
    memberId: 'actor-a',
    characterId: 'actor-a',
    sourceId: 'actor-a',
    ownerId: 'actor-a',
    targetId: 'enemy-shared',
    castId: 'cast:current',
    skillId: 'skill-current',
    rootSkillId: 'skill-current',
    buffInstanceId: sourceBuffId ? `status:extra:${hitIndex}` : null,
    sourceBuffId,
    reason: 'DamageAction',
    sourcePath: sourceBuffId ? 'igniteEventAction[0]' : 'timelineActions[0]',
    damageUnitIndex: hitIndex,
    damageType: 'Physical',
    damageAttributeType: 'Hp',
    damageDecorateMask: 0,
    damageTypeMask: null,
    atkScale,
    rawDamage: attack * atkScale,
    finalDamage: nonCriticalDamage * 1.025,
    nonCriticalDamage,
    criticalDamage: nonCriticalDamage * 1.5,
    expectedDamage: nonCriticalDamage * 1.025,
    poiseDamage: 0,
    targetHpBefore: 100000,
    targetHpAfter: 100000 - nonCriticalDamage,
    modifierSnapshot: {
      attackAttribute: {
        targetId: 'actor-a',
        attribute: 'Atk',
        baseValue: 840,
        evaluation: { value: attack },
        contributions: includeTalentContribution ? [{
          sourceKey: 'status:self-stack',
          sourceType: 'StatusEffect',
          buffInstanceId: 'status:self-stack',
          targetId: 'actor-a',
          attribute: 'Atk',
          zone: 'Multiplier',
          value: 0.08,
        }] : [],
      },
      attackerZone: { scale: 1, contributions: [] },
      defenderZone: {
        scale: 1.2,
        contributions: [{
          sourceKey: 'status:seal',
          sourceType: 'StatusEffect',
          buffInstanceId: 'status:seal',
          side: 'Defender',
          zoneName: 'NormalCalcZone',
          addition: 0.2,
        }],
      },
      configuredBonus: 0,
      configuredDamageBonusScale: 1,
      specialScale: 1,
    },
    operands: {
      attack,
      atkScale,
      defense: 100,
      defEfficiency: 0.01,
      defScale: 0.5,
      resistance: 0,
      damageTakenScalar: 1,
      damageTypeResistanceScale: 1,
      weaknessDmgScalar: 1,
      shelterScale: 1,
      igniteDamageScalar: 1,
      physicalInflictionDamageScalar: 1,
      attackerZoneScale: 1,
      defenderZoneScale: 1.2,
      configuredDamageBonusScale: 1,
      specialScale: 1,
      criticalRate: 0.05,
      criticalDamageIncrease: 0.5,
      allCriticalScale: 1.5,
      expectedCriticalScale: 1.025,
    },
  };
}

const report = {
  schemaVersion: 2,
  generatedAt: '2026-08-26T00:00:00.000Z',
  engine: 'generic-runtime',
  enemyId: 'enemy-shared',
  nodeFrameScale: 0,
  tickRate: 30,
  durationFrames: 100,
  characters: [],
  hits: [
    runtimeHit(0, null, 2),
    runtimeHit(1, 'buff_common_originum_frozen', 4, false),
    runtimeHit(2, 'buff_physical_crushed', 3.5),
  ],
  statusEvents,
  timeline: {
    tickRate: 30,
    durationFrames: 100,
    durationSeconds: 100 / 30,
    commands: [{
      commandId: 'button-current',
      commandType: 'NormalSkill',
      memberId: 'actor-a',
      characterId: 'actor-a',
      requestedFrame: 10,
      requestedSeconds: 1 / 3,
      actualFrame: 10,
      actualSeconds: 1 / 3,
      endFrame: 20,
      delayFrames: 0,
      state: 'executed',
      success: true,
      queued: false,
      reason: null,
      skillId: 'skill-current',
      castId: 'cast:current',
      damage: 0,
      poiseDamage: 0,
      hitCount: 3,
    }],
    casts: [],
    hitBursts: [],
    sharedAtb: null,
    uspPools: [],
    cooldowns: [],
  },
  summary: {
    totalDamage: 0,
    totalPoiseDamage: 0,
    dps: 0,
    successfulCommands: 1,
    failedCommands: 0,
    delayedCommands: 0,
    calculatedCharacters: 1,
    unsupportedCharacters: 0,
  },
  finalState: {
    sharedAtb: { current: 0, max: 300 },
    ultimateSpByCharacterId: {},
    activeStatuses: [],
    resilience: {},
  },
} as AkeTeamReport;

const labels = buildAkeRuntimeStatusLabelMap({
  characters: [{
    name: '测试干员',
    loadoutEffects: [{
      name: '通用叠层天赋',
      effects: [{ sourceBuffId: 'buff_actor_talent_child' }],
    }],
  }],
});
const ledger = buildAkeRuntimeCommandLedger({
  report,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});

assert.ok(ledger);
assert.equal(ledger.hits.length, 3, 'runtime must preserve all independent HP hits');
assert.equal(ledger.hits[1].title, '源石结晶击碎');
assert.equal(ledger.hits[2].title, '猛击·物理异常伤害');
assert.equal(ledger.hits[0].formula.fragileFormulaText, '1 + 20.0% = 1.2');
assert.ok(ledger.hits[0].formula.buffTags.some((buff) => (
  buff.label === '源石结晶' && buff.type === 'physicalFragile'
)));
assert.ok(ledger.hits[0].formula.buffTags.some((buff) => (
  buff.label === '天赋·通用叠层'
  && buff.type === 'atkPercentBoost'
  && buff.stackCount === 1
)));
assert.ok(ledger.hits[0].formula.attackLines?.some((line) => line.includes('840 → 1000')));
assert.ok(ledger.statuses.some((status) => (
  status.title === '天赋·通用叠层 ×2'
  && status.kind.includes('叠层并刷新')
)));
assert.ok(ledger.statuses.some((status) => (
  status.title === '源石结晶'
  && status.kind.includes('移除')
)));
assert.ok(ledger.hits[0].statuses.some((status) => (
  status.title.startsWith('天赋·通用叠层')
  && status.kind === '当前 Hit 生效'
)));
assert.ok(!ledger.hits[1].statuses.some((status) => (
  status.title.startsWith('天赋·通用叠层')
  && status.kind === '当前 Hit 生效'
)), 'each Hit must expose only the Buff contributions captured by its own runtime snapshot');
assert.ok(ledger.hits[0].statuses[0].groupLabel === '关键战斗状态', 'critical states sort first');
assert.ok(ledger.compactStatuses.some((status) => (
  status.label === '叠2' && status.iconUrl?.includes('buff-atk.png')
)));
assert.equal(
  ledger.compactStatuses.find((status) => status.buffId === 'buff_actor_talent_child')?.mainDisplay,
  false,
  'ordinary self Buffs stay out of the compact main timeline',
);
assert.equal(
  ledger.compactStatuses.find((status) => status.buffId === 'buff_physical_no_guard')?.mainDisplay,
  true,
  'armor-break state remains visible in the compact main timeline',
);
assert.equal(
  ledger.compactStatuses.find((status) => status.buffId === 'buff_common_enemy_spell_status_conduct')?.displayName,
  '导电',
  'confirmed mechanic labels must override ambiguous raw catalog names',
);
assert.equal(
  ledger.compactStatuses.find((status) => status.buffId === 'buff_test_energy_shard_attached_pulse')?.displayName,
  '电磁附着',
  'elemental attachments stay distinct from conductive status',
);
assert.match(ledger.summary?.title ?? '', /^测试战技 · 运行时 3 个独立 Hit$/);
assert.equal(ledger.summary?.parts.length, 3);
