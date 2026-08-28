import assert from 'node:assert/strict';

import type { AkeRuntimeHit, AkeRuntimeStatusEvent, AkeTeamReport } from '../../integrations/ake/akeProvider';
import {
  buildAkeRuntimeCommandLedger,
  buildAkeRuntimeCommandViewState,
  buildAkeRuntimeStatusLabelMap,
  selectAkeMainTimelineStatuses,
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
}, {
  ...statusBase,
  traceIndex: 7,
  frame: 17,
  stage: 'StatusEffectApplied',
  instanceId: 'status:cross-conduct',
  buffId: 'buff_common_pulse_cryst_triggered',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: 'pulse cryst triggered',
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
    poise: {},
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

const attackZoneReport = structuredClone(report);
attackZoneReport.characters = [{
  localCharacterId: 'actor-a',
  akeCharacterId: 'actor-a',
  memberId: 'actor-a',
  characterName: '测试干员',
  status: 'calculated',
  loadout: {
    level: 90,
    skillLevel: 12,
    weaponId: 'weapon-test',
    weaponName: '测试武器',
    weaponLevel: 90,
    equipment: [],
    potentialEffectIds: [],
    panelAtk: 3328.938,
    panelHp: 0,
    panelAttackTrace: {
      characterAttack: 840,
      weaponAttack: 505,
      attackPercent: 0.256,
      flatAttack: 0,
      baseAttack: 1689.32,
      panelAttack: 3328.938,
      abilityBonus: 0.97056,
      mainAbility: {
        label: '智识',
        rawValue: 1024.4,
        statScale: 0,
        allStatScale: 0,
        valueBeforeRounding: 1024.4,
        finalValue: 1024,
        attackCoefficient: 0.005,
        attackBonus: 5.12,
      },
      subAbility: {
        label: '意志',
        rawValue: 229.8,
        statScale: 0,
        allStatScale: 0,
        valueBeforeRounding: 229.8,
        finalValue: 230,
        attackCoefficient: 0.002,
        attackBonus: 0.46,
      },
    },
    damageBonuses: [],
  },
  skippedButtonIds: [],
}];
attackZoneReport.hits = [runtimeHit(0, null, 1, false)];
attackZoneReport.hits[0].modifierSnapshot.attackAttribute = {
  targetId: 'actor-a',
  attribute: 'Atk',
  baseValue: 3323.737728,
  evaluation: { value: 3323.737728 },
  contributions: [
    {
      contributionId: 'weapon-flat',
      sourceKey: 'ake-baseline:actor-a:weapon',
      sourceType: 'Weapon',
      sourceCategory: 'Weapon',
      attribute: 'Atk',
      zone: 'BaseAddition',
      value: 505,
      resolvedValue: 505,
      metadata: { sourceLabel: 'Weapon' },
    },
    {
      contributionId: 'weapon-passive',
      sourceKey: 'ake-baseline:actor-a:weapon-passive',
      sourceType: 'WeaponPassive',
      sourceCategory: 'Weapon',
      attribute: 'Atk',
      zone: 'BaseMultiplier',
      value: 0.256,
      resolvedValue: 0.256,
      metadata: { sourceLabel: 'WeaponPassive' },
    },
    {
      contributionId: 'ability-derived',
      sourceKey: 'ake-baseline:actor-a:ability',
      sourceType: 'DerivedAbility',
      sourceCategory: 'System',
      attribute: 'Atk',
      zone: 'BaseFinalMultiplier',
      value: 3.196,
      resolvedValue: 3.196,
      metadata: { sourceLabel: 'AKEDatabase:DerivedAbility:Attack' },
    },
  ],
};
const attackZoneLedger = buildAkeRuntimeCommandLedger({
  report: attackZoneReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
const attackZoneTags = attackZoneLedger?.hits[0].formula.buffTags ?? [];
assert.ok(attackZoneTags.some((buff) => buff.type === 'flatAtk' && buff.effectiveValue === 505 && !buff.isMultiplier),
  'BaseAddition must remain a flat attack contribution');
assert.ok(attackZoneTags.some((buff) => buff.type === 'atkPercentBoost' && buff.effectiveValue === 0.256 && !buff.isMultiplier),
  'BaseMultiplier must remain an additive attack-rate contribution');
assert.ok(attackZoneTags.some((buff) => buff.type === 'atkFinalMultiplier' && buff.multiplierCoefficient === 3.196 && buff.isMultiplier),
  'BaseFinalMultiplier must remain a factor instead of a percent');
assert.ok(attackZoneTags.some((buff) => buff.label === '能力换算' && buff.type === 'atkFinalMultiplier'),
  'internal AKEDatabase derived-ability ids must resolve to a readable source label');
assert.ok(attackZoneLedger?.hits[0].formula.panelLines.includes('ATK: 3328.938'),
  'the attack section header must use the trusted LTS/DEF panel value');
assert.ok(attackZoneLedger?.hits[0].formula.attackLines?.some((line) => line.startsWith('角色攻击: 840')),
  'the hit detail must retain the character attack row');
assert.ok(attackZoneLedger?.hits[0].formula.attackLines?.some((line) => line.startsWith('武器攻击: 505')),
  'the hit detail must retain the weapon attack row');
assert.ok(attackZoneLedger?.hits[0].formula.attackLines?.some((line) => line.includes('主能力取整')),
  'the hit detail must retain the ability rounding row');
assert.ok(attackZoneLedger?.hits[0].formula.attackLines?.some((line) => line.includes('最终面板攻击力')),
  'the hit detail must retain the final panel attack formula');
assert.ok(!attackZoneLedger?.hits[0].formula.attackLines?.some((line) => line.includes('3323.737728')),
  'the unresolved runtime operand must not masquerade as panel attack');
assert.ok(!attackZoneLedger?.hits[0].formula.nonCritFormulaText.includes('1000'),
  'runtime result formula must not leak the unresolved attack operand');
assert.ok((attackZoneLedger?.hits[0].formula.sectionLines?.result?.length ?? 0) >= 6,
  'the runtime result zone must preserve the factor chain, validation, and all result rows');

const weaponBuffReport = structuredClone(report);
const weaponBuffHit = runtimeHit(0, null, 1, false);
weaponBuffHit.damageType = 'Fire';
const weaponBuffContribution = {
  contributionId: 'status:weapon-fire:FireDamageIncrease:damage-zone',
  semanticKey: 'damage-zone.FireDamageIncrease.BaseAddition',
  sourceKey: 'status:weapon-fire',
  sourceType: 'StatusEffect',
  sourceCategory: 'Weapon',
  sourceId: 'actor-a',
  ownerId: 'actor-a',
  carrierId: 'actor-a',
  targetId: 'actor-a',
  buffId: 'buff_weapon_fire_damage_up',
  buffInstanceId: 'status:weapon-fire',
  attribute: 'FireDamageIncrease',
  zone: 'BaseAddition',
  side: 'Attacker',
  zoneName: 'NormalCalcZone',
  operation: 'AddRate',
  rawValue: 0.06,
  resolvedValue: 0.06,
  addition: 0.06,
  sourceMetadata: { sourceType: 'WeaponPassive' },
};
weaponBuffHit.modifierSnapshot.attackerZone = {
  scale: 1.06,
  zones: [{ zoneName: 'NormalCalcZone', addition: 0.06, scale: 1.06 }],
  contributions: [weaponBuffContribution],
};
weaponBuffHit.operands.attackerZoneScale = 1.06;
weaponBuffHit.factors = [{
  factorId: 'damage-factor:attacker-zone',
  semanticKey: 'attacker-zone',
  displayName: '攻击方增伤区',
  operation: 'MultiplyZones',
  rawValue: [{ zoneName: 'NormalCalcZone', addition: 0.06, scale: 1.06 }],
  multiplier: 1.06,
  finalValue: 1.06,
  contributions: [weaponBuffContribution],
}];
weaponBuffReport.hits = [weaponBuffHit];
weaponBuffReport.statusEvents = [{
  ...statusBase,
  traceIndex: 20,
  frame: 12,
  stage: 'StatusEffectApplied',
  instanceId: 'status:weapon-fire',
  buffId: 'buff_weapon_fire_damage_up',
  targetId: 'actor-a',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '镀红祝福',
  effectType: 'fireDmgBonus',
  applicationScope: 'team',
}];
const weaponBuffLedger = buildAkeRuntimeCommandLedger({
  report: weaponBuffReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
const visibleWeaponBuff = weaponBuffLedger?.hits[0].formula.buffTags.find((buff) => (
  buff.buffId === 'buff_weapon_fire_damage_up'
));
assert.equal(visibleWeaponBuff?.label, '镀红祝福',
  'an applied weapon Buff must keep its player-facing identity in hit details');
assert.equal(visibleWeaponBuff?.type, 'fireDmgBonus');
assert.equal(visibleWeaponBuff?.effectiveValue, 0.06);
assert.ok(weaponBuffLedger?.hits[0].formula.sectionLines?.damageBonus?.some((line) => (
  line.includes('镀红祝福') && line.includes('6.0%')
)), 'the exact weapon Buff source must appear in the damage-bonus formula lines');

const comboReport = structuredClone(attackZoneReport);
comboReport.characters.push({
  ...structuredClone(comboReport.characters[0]),
  localCharacterId: 'combo-provider',
  akeCharacterId: 'combo-provider',
  memberId: 'combo-provider',
  characterName: '卡缪',
});
const comboHit = runtimeHit(0, null, 1, false);
comboHit.consumedStatuses = [{
  key: 'team-combo',
  stateType: 'combo',
  buffId: 'buff_common_affixes_combo_trigger',
  applicationScope: 'team',
  frame: 10,
  consumerId: 'actor-a',
  targetId: 'enemy-shared',
  skillId: 'skill-current',
  rootSkillId: 'skill-current',
  castId: 'cast:current',
  commandType: 'NormalSkill',
  skillType: 'NormalSkill',
  consumedStacks: 3,
  maxStacks: 4,
  sourceStacks: [{ sourceId: 'combo-provider', count: 2 }, { sourceId: 'actor-a', count: 1 }],
  grantIds: ['grant:camille', 'grant:actor'],
  replicatedTargetIds: ['actor-a', 'combo-provider'],
}];
const comboContribution = {
  contributionId: 'consumed-status:cast:current:team-combo',
  semanticKey: 'consumed-status.combo',
  sourceKey: 'consumed-status:cast:current:team-combo',
  sourceType: 'ConsumedStatus',
  sourceCategory: 'TeamState',
  sourceId: 'combo-provider',
  ownerId: 'actor-a',
  carrierId: 'actor-a',
  targetId: 'actor-a',
  buffId: 'buff_common_affixes_combo_trigger',
  side: 'Attacker',
  zoneName: 'ComboCalcZone',
  operation: 'AddRate',
  rawField: 'ComboCalcZone',
  rawValue: 0.6,
  resolvedValue: 0.6,
  addition: 0.6,
  stackCount: 3,
  sourceMetadata: { displayName: '连击', applicationScope: 'team' },
};
comboHit.factors = [{
  factorId: 'damage-factor:combo-damage',
  semanticKey: 'combo-damage',
  displayName: '连击区',
  operation: 'MultiplyZones',
  rawValue: [{ zoneName: 'ComboCalcZone', addition: 0.6, scale: 1.6 }],
  multiplier: 1.6,
  finalValue: 1.6,
  contributions: [comboContribution],
}];
comboReport.hits = [comboHit];
comboReport.statusEvents = [
  ...['actor-a', 'combo-provider'].flatMap((targetId, index) => ([{
    ...statusBase,
    traceIndex: 30 + index,
    frame: 0,
    stage: 'StatusEffectApplied',
    instanceId: `status:team-combo:${targetId}`,
    buffId: 'buff_common_affixes_combo_trigger',
    targetId,
    sourceId: 'combo-provider',
    ownerId: 'combo-provider',
    stackCount: 3,
    before: 0,
    after: 3,
    castId: 'cast:provider',
    displayName: '连击',
    shortName: '连',
    effectType: 'teamCombo',
    applicationScope: 'team',
  }, {
    ...statusBase,
    traceIndex: 32 + index,
    frame: 10,
    stage: 'StatusEffectFinished',
    instanceId: `status:team-combo:${targetId}`,
    buffId: 'buff_common_affixes_combo_trigger',
    targetId,
    sourceId: 'combo-provider',
    ownerId: 'combo-provider',
    stackCount: 0,
    before: 3,
    after: 0,
    castId: 'cast:provider',
    triggerCastId: 'cast:current',
    consumerId: 'actor-a',
    consumption: targetId === 'actor-a',
    consumeKind: 'Consume',
    triggerCommandType: 'NormalSkill',
    displayName: '连击',
    shortName: '连',
    effectType: 'teamCombo',
    applicationScope: 'team',
  }])) as AkeRuntimeStatusEvent[],
];
const comboLedger = buildAkeRuntimeCommandLedger({
  report: comboReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.ok(comboLedger);
assert.deepEqual(
  comboLedger.hits[0].statuses.filter((status) => status.buffId === 'buff_common_affixes_combo_trigger')
    .map((status) => [status.title, status.groupLabel]),
  [['连击 ×3', '关键战斗状态']],
  'replicated team instances must collapse into one critical combo state per Hit',
);
assert.match(
  comboLedger.hits[0].statuses.find((status) => status.buffId === 'buff_common_affixes_combo_trigger')?.detail ?? '',
  /卡缪 2层.*测试干员 1层/,
  'the consumed action snapshot must retain per-source attribution',
);
assert.equal(
  comboLedger.hits[0].formula.buffTags.filter((buff) => (
    buff.buffId === 'buff_common_affixes_combo_trigger'
  )).length,
  1,
  'the formula must expose the pooled combo contribution exactly once',
);
const comboBuffTag = comboLedger.hits[0].formula.buffTags.find((buff) => (
  buff.buffId === 'buff_common_affixes_combo_trigger'
));
assert.deepEqual(
  [comboBuffTag?.label, comboBuffTag?.sourceName, comboBuffTag?.type, comboBuffTag?.stackCount],
  ['连击', '队伍共享状态', 'teamCombo', 3],
  'the formula Buff row must preserve shared-state identity and consumed stack count',
);
assert.ok(comboLedger.hits[0].formula.sectionLines?.combo?.some((line) => (
  line.includes('连击') && line.includes('60.0%')
)), 'the combo zone must show its real stack-derived multiplier source');
assert.deepEqual(
  comboLedger.statuses.filter((status) => status.buffId === 'buff_common_affixes_combo_trigger')
    .map((status) => status.title),
  ['连击 ×3'],
  'the command ledger must not leak one copied combo row per teammate',
);
assert.deepEqual(
  comboLedger.compactStatuses.filter((status) => status.buffId === 'buff_common_affixes_combo_trigger')
    .map((status) => [status.label, status.stackCount, status.mainDisplay, status.applicationScope]),
  [['连3', 3, true, 'team']],
  'combo must be a pooled, team-scoped main-display state',
);

const activeComboReport = structuredClone(comboReport);
activeComboReport.timeline.commands[0].commandType = 'Attack';
activeComboReport.hits = [runtimeHit(0, null, 1, false)];
activeComboReport.statusEvents = comboReport.statusEvents.filter((event) => (
  event.stage === 'StatusEffectApplied'
));
const activeComboLedger = buildAkeRuntimeCommandLedger({
  report: activeComboReport,
  commandId: 'button-current',
  labels,
  skillName: '测试普攻',
});
assert.deepEqual(
  activeComboLedger?.hits[0].statuses.filter((status) => (
    status.buffId === 'buff_common_affixes_combo_trigger'
  )).map((status) => status.title),
  ['连击 ×3'],
  'a non-consuming action must see the current pooled team combo state once',
);
assert.deepEqual(
  activeComboLedger?.compactStatuses.filter((status) => (
    status.buffId === 'buff_common_affixes_combo_trigger'
  )).map((status) => [status.label, status.tone]),
  [['连3', 'active']],
  'an unconsumed combo pool remains a main-display active state',
);
assert.deepEqual(
  selectAkeMainTimelineStatuses(activeComboLedger).map((status) => status.buffId),
  ['buff_common_affixes_combo_trigger'],
  'the shared combo pool remains visible even when inherited by the current command',
);

const inheritedAttachmentReport = structuredClone(report);
inheritedAttachmentReport.statusEvents = [{
  ...statusBase,
  traceIndex: 0,
  frame: 0,
  stage: 'StatusEffectApplied',
  instanceId: 'status:inherited-fire',
  buffId: 'buff_common_energy_shard_attached_fire',
  before: 0,
  after: 1,
  castId: 'older-ultimate-cast',
}];
const inheritedAttachmentLedger = buildAkeRuntimeCommandLedger({
  report: inheritedAttachmentReport,
  commandId: 'button-current',
  labels,
  skillName: '强化战技',
});
assert.equal(
  inheritedAttachmentLedger?.compactStatuses.some((status) => (
    status.buffId === 'buff_common_energy_shard_attached_fire'
    && status.tone === 'active'
  )),
  true,
  'the detail ledger keeps inherited enemy attachment state for hit inspection',
);
assert.equal(
  selectAkeMainTimelineStatuses(inheritedAttachmentLedger).some((status) => (
    status.buffId === 'buff_common_energy_shard_attached_fire'
  )),
  false,
  'the main skill badge must not claim an inherited Fire attachment as this command effect',
);

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
assert.deepEqual(
  ledger.compactStatuses
    .filter((status) => status.buffId === 'buff_common_pulse_cryst_triggered')
    .map((status) => [status.displayName, status.mainDisplay]),
  [['导电', true]],
  'real cross-element reaction ids must project as the shared conductive enemy state',
);
assert.match(ledger.summary?.title ?? '', /^测试战技 · 运行时 3 个独立 Hit$/);
assert.equal(ledger.summary?.parts.length, 3);

assert.equal(buildAkeRuntimeCommandViewState({
  runtimeMode: false,
  report: null,
  commandId: 'button-current',
}).kind, 'manual-preview');
assert.equal(buildAkeRuntimeCommandViewState({
  runtimeMode: true,
  report: null,
  commandId: 'button-current',
}).kind, 'pending');
assert.equal(buildAkeRuntimeCommandViewState({
  runtimeMode: true,
  report,
  commandId: 'button-from-another-timeline',
}).kind, 'stale');

const rejectedReport = structuredClone(report);
rejectedReport.timeline.commands[0].success = false;
rejectedReport.timeline.commands[0].state = 'failed';
rejectedReport.timeline.commands[0].reason = 'ComboWindowExpired';
const rejected = buildAkeRuntimeCommandViewState({
  runtimeMode: true,
  report: rejectedReport,
  commandId: 'button-current',
});
assert.equal(rejected.kind, 'rejected');
assert.match(rejected.message, /ComboWindowExpired/);

assert.equal(buildAkeRuntimeCommandViewState({
  runtimeMode: true,
  report,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
}).kind, 'settled');

const sameNameReport = structuredClone(report);
sameNameReport.schemaVersion = 3;
sameNameReport.statusEvents.push({
  ...statusBase,
  traceIndex: 20,
  frame: 12,
  stage: 'StatusEffectApplied',
  instanceId: 'status:same-name-a',
  buffId: 'buff_same_name_a',
  targetId: 'actor-a',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '同名增益',
}, {
  ...statusBase,
  traceIndex: 21,
  frame: 12,
  stage: 'StatusEffectApplied',
  instanceId: 'status:same-name-b',
  buffId: 'buff_same_name_b',
  targetId: 'actor-a',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: '同名增益',
});
sameNameReport.hits[0].factors = [{
  factorId: 'damage-factor:same-name',
  semanticKey: 'attacker-zone',
  displayName: '攻击方增伤区',
  operation: 'AddRate',
  rawValue: 0.2,
  additive: 0.2,
  multiplier: 1.2,
  finalValue: 1.2,
  contributions: ['a', 'b'].map((suffix) => ({
    contributionId: `contribution:same-name-${suffix}`,
    semanticKey: 'damage-zone.NormalCalcZone',
    sourceKey: `status:same-name-${suffix}`,
    sourceType: 'StatusEffect',
    sourceCategory: suffix === 'a' ? 'Talent' : 'Weapon',
    sourceId: 'actor-a',
    ownerId: 'actor-a',
    carrierId: 'actor-a',
    targetId: 'actor-a',
    damageSourceId: 'actor-a',
    buffId: `buff_same_name_${suffix}`,
    buffInstanceId: `status:same-name-${suffix}`,
    rawValue: 0.1,
    resolvedValue: 0.1,
    value: 0.1,
  })),
}];
const sameNameLedger = buildAkeRuntimeCommandLedger({
  report: sameNameReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.equal(sameNameLedger?.hits[0].formula.buffTags.filter((buff) => (
  buff.label === '同名增益'
)).length, 2, 'same-label Buffs must remain distinct by contribution identity');

const shelterReport = structuredClone(report);
shelterReport.schemaVersion = 3;
shelterReport.hits = [runtimeHit(0, null, 1, false)];
shelterReport.statusEvents.push({
  ...statusBase,
  traceIndex: 22,
  frame: 12,
  stage: 'StatusEffectApplied',
  instanceId: 'status:shelter',
  buffId: 'buff_common_affixes_shelter',
  targetId: 'enemy-shared',
  before: 0,
  after: 1,
  castId: 'older-cast',
  displayName: '庇护',
});
shelterReport.hits[0].factors = [{
  factorId: 'damage-factor:shelter',
  semanticKey: 'shelter',
  displayName: '庇护减伤',
  operation: 'SubtractRate',
  rawValue: 0.25,
  additive: -0.25,
  multiplier: 0.75,
  finalValue: 0.75,
  contributions: [{
    contributionId: 'contribution:shelter',
    semanticKey: 'attribute.ShelterDmgScalar',
    sourceKey: 'status:shelter',
    sourceType: 'StatusEffect',
    sourceId: 'actor-a',
    ownerId: 'actor-a',
    carrierId: 'enemy-shared',
    targetId: 'enemy-shared',
    damageSourceId: 'actor-a',
    buffId: 'buff_common_affixes_shelter',
    buffInstanceId: 'status:shelter',
    attribute: 'ShelterDmgScalar',
    rawValue: 0.25,
    resolvedValue: 0.25,
    value: 0.25,
  }],
}];
const shelterLedger = buildAkeRuntimeCommandLedger({
  report: shelterReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.ok(shelterLedger?.hits[0].formula.buffTags.some((buff) => (
  buff.label === '庇护' && buff.type === 'damageReduction'
)), 'ShelterDmgScalar should project as an incoming damage-reduction Buff');

const sameFrameReport = structuredClone(report);
sameFrameReport.schemaVersion = 3;
sameFrameReport.hits = [runtimeHit(0, null, 1), runtimeHit(1, null, 1)];
sameFrameReport.hits[0].frame = 20;
sameFrameReport.hits[0].hitId = 'runtime-hit:same-frame-a';
sameFrameReport.hits[1].frame = 20;
sameFrameReport.hits[1].hitId = 'runtime-hit:same-frame-b';
sameFrameReport.statusEvents = ['a', 'b'].map((suffix, index) => ({
  ...statusBase,
  traceIndex: 30 + index,
  frame: 20,
  stage: 'StatusEffectApplied',
  instanceId: `status:transition-${suffix}`,
  buffId: `buff_transition_${suffix}`,
  targetId: 'enemy-shared',
  before: 0,
  after: 1,
  castId: 'cast:current',
  displayName: `命中状态${suffix.toUpperCase()}`,
  parentHitId: `runtime-hit:same-frame-${suffix}`,
  hitEventPhase: 'after' as const,
}));
const sameFrameLedger = buildAkeRuntimeCommandLedger({
  report: sameFrameReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.ok(sameFrameLedger?.hits[0].statuses.some((status) => status.title === '命中状态A'));
assert.ok(!sameFrameLedger?.hits[0].statuses.some((status) => status.title === '命中状态B'));
assert.ok(sameFrameLedger?.hits[1].statuses.some((status) => status.title === '命中状态B'));
assert.ok(!sameFrameLedger?.hits[1].statuses.some((status) => status.title === '命中状态A'));

const expiredReport = structuredClone(report);
expiredReport.schemaVersion = 3;
expiredReport.hits = [runtimeHit(0, null, 1)];
expiredReport.hits[0].frame = 300;
expiredReport.hits[0].hitId = 'runtime-hit:after-expiry';
expiredReport.statusEvents = [{
  ...statusBase,
  traceIndex: 40,
  frame: 0,
  stage: 'StatusEffectApplied',
  instanceId: 'status:short-lived',
  buffId: 'buff_short_lived',
  before: 0,
  after: 1,
  castId: 'older-cast',
  displayName: '短时易伤',
  durationFrames: 24,
  expireFrame: 24,
}, {
  ...statusBase,
  traceIndex: 41,
  frame: 24,
  stage: 'StatusEffectExpired',
  instanceId: 'status:short-lived',
  buffId: 'buff_short_lived',
  before: 1,
  after: 0,
  castId: 'older-cast',
  displayName: '短时易伤',
  durationFrames: 24,
  expireFrame: 24,
}];
const expiredLedger = buildAkeRuntimeCommandLedger({
  report: expiredReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.ok(!expiredLedger?.hits[0].statuses.some((status) => status.title.includes('短时易伤')),
  'expired runtime status must not remain active on a later Hit');

const poiseReport = structuredClone(report);
poiseReport.schemaVersion = 3;
poiseReport.statusEvents.push(...[
  ['buff_common_poise_can_be_breaking_attacked', 'status:poise-broken'],
  ['buff_common_poise_break_damage_taken_scale', 'status:poise-vulnerability'],
].map(([buffId, instanceId], index) => ({
  ...statusBase,
  traceIndex: 50 + index,
  frame: 14,
  stage: 'StatusEffectApplied',
  instanceId,
  buffId,
  before: 0,
  after: 1,
  castId: 'cast:current',
  sourceId: 'enemy-shared',
  ownerId: 'enemy-shared',
} as AkeRuntimeStatusEvent)));
const poiseLedger = buildAkeRuntimeCommandLedger({
  report: poiseReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.ok(poiseLedger?.statuses.some((status) => status.title === '失衡'));
assert.ok(poiseLedger?.statuses.some((status) => status.title === '失衡易伤'),
  'double-click ledger must expose both generic poise lifecycle statuses');

const partialReport = structuredClone(report);
partialReport.schemaVersion = 3;
partialReport.diagnostics = {
  unresolvedEffectCount: 1,
  compilerUnresolvedEffectCount: 0,
  runtimeDiagnostics: [{
    eventId: 'effect-event:partial',
    frame: 13,
    actionType: 'ResolveDamagePacket',
    status: 'PartiallyApplied',
    code: 'AKE_DAMAGE_PACKET_PARTIAL',
    castId: 'cast:current',
  }],
};
const partialState = buildAkeRuntimeCommandViewState({
  runtimeMode: true,
  report: partialReport,
  commandId: 'button-current',
  labels,
  skillName: '测试战技',
});
assert.equal(partialState.kind, 'partial');
assert.match(partialState.message, /未完全解析/);

const derivedCastReport = structuredClone(report);
const derivedHit = runtimeHit(0, null, 1.25, false);
derivedHit.castId = 'derived-cast:actor-a:combo:1';
derivedHit.rootCastId = 'cast:current';
derivedHit.parentCastId = 'cast:current';
derivedHit.inputSkillId = 'skill-enhanced-button';
derivedHit.inputCommandType = 'NormalSkill';
derivedHit.skillId = 'skill-derived-combo';
derivedHit.effectiveSkillType = 'ComboSkill';
derivedCastReport.hits = [derivedHit];
derivedCastReport.statusEvents = [{
  ...statusBase,
  traceIndex: 60,
  frame: 13,
  stage: 'StatusEffectApplied',
  instanceId: 'status:derived-combo',
  buffId: 'buff_derived_combo_state',
  before: 0,
  after: 1,
  castId: 'derived-cast:actor-a:combo:1',
  rootCastId: 'cast:current',
  parentCastId: 'cast:current',
  inputSkillId: 'skill-enhanced-button',
  inputCommandType: 'NormalSkill',
  effectiveSkillType: 'ComboSkill',
  displayName: '派生连携状态',
}];
const derivedCastLedger = buildAkeRuntimeCommandLedger({
  report: derivedCastReport,
  commandId: 'button-current',
  labels,
  skillName: '强化战技',
});
assert.equal(derivedCastLedger?.hits.length, 1,
  'a derived execution cast must remain attached to its root input button');
assert.match(derivedCastLedger?.hits[0].meta ?? '', /战技输入 → 连携技结算/);
assert.ok(derivedCastLedger?.statuses.some((status) => status.title === '派生连携状态'),
  'derived-cast status transitions must remain visible in the root button detail');
