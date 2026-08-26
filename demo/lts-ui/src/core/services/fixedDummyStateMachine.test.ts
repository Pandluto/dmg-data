import assert from 'node:assert/strict';

import { calculateSkillButtonDamageV2 } from '../calculators/skillButtonDamageCalculatorV2';
import {
  buildFixedDummyHitContext,
  reduceFixedDummyState,
  type FixedDummyEvent,
} from './fixedDummyStateMachine';

const events: FixedDummyEvent[] = [{
  buttonId: 'attachment-source',
  nodeIndex: 0,
  hitElements: ['electric'],
  hitBuffs: [{
    id: 'buff_common_energy_shard_attached_pulse',
    displayName: '电磁附着',
    target: 'target',
    kind: 'attachment',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}, {
  buttonId: 'blue-state-source',
  nodeIndex: 1,
  hitElements: ['physical'],
  hitBuffs: [],
  anomalyCards: [{
    id: 'armor-break-card',
    key: 'armor-break',
    label: '碎甲',
    kind: 'damage',
    category: 'physical',
    level: 3,
    primaryText: '碎甲 Lv3',
    secondaryText: '',
    selectedBuffIds: [],
  }, {
    id: 'conductive-card',
    key: 'conductive',
    label: '导电',
    kind: 'damage',
    category: 'magic',
    level: 2,
    primaryText: '导电 Lv2',
    secondaryText: '',
    selectedBuffIds: [],
  }],
  stateSnapshots: [],
}, {
  buttonId: 'down-source',
  nodeIndex: 2,
  hitElements: ['physical'],
  hitBuffs: [{ id: 'control_knockdown', displayName: '倒地', target: 'target', kind: 'status' }],
  anomalyCards: [{
    id: 'imbalance-card',
    key: 'imbalance-state',
    label: '失衡',
    kind: 'state',
    category: 'physical',
    level: 1,
    primaryText: '失衡',
    secondaryText: '',
    selectedBuffIds: [],
  }],
  stateSnapshots: [{
    id: 9,
    key: 'corrosion',
    label: '腐蚀',
    level: 4,
    sourceButtonId: 'down-source',
    sourceCharacterId: 'source-operator',
    sourceCharacterName: '来源干员',
    sourceSkillStrengthSnapshot: 0,
    effectValue: 9,
    currentCorrosion: 9,
    primaryText: '腐蚀',
    secondaryText: '',
    createdAt: 1,
  }],
}, {
  buttonId: 'same-cohort-must-not-leak',
  nodeIndex: 3,
  hitElements: ['fire'],
  hitBuffs: [{
    id: 'buff_common_energy_shard_attached_fire',
    displayName: '灼热附着',
    target: 'target',
    kind: 'attachment',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}];

const state = reduceFixedDummyState(events, 3);
assert.deepEqual(state.attachments, ['electric'], 'only strictly earlier cohorts should change the dummy');
assert.equal(state.armorBreakLevel, 3);
assert.equal(state.armorBreakEffectValue, 0.2);
assert.equal(state.conductiveEffectValue, 0.16);
assert.equal(state.corrosionEffectValue, 9);
assert.equal(state.isImbalanced, true);
assert.equal(state.magicHitCount, 1);

const context = buildFixedDummyHitContext(state);
const input = {
  buttonId: 'target-button',
  characterId: 'target-operator',
  runtimeSkillId: 'target-skill',
  template: {
    characterId: 'target-operator',
    characterName: '目标干员',
    runtimeSkillId: 'target-skill',
    displayName: '双属性测试',
    buttonType: 'B' as const,
    hits: [{ key: 'physical', displayName: '物理', multiplier: 1, element: 'physical' as const, skillType: 'B' as const },
      { key: 'electric', displayName: '电磁', multiplier: 1, element: 'electric' as const, skillType: 'B' as const }],
  },
  buffs: context.modifierBuffs,
  displayOnlyBuffs: context.displayOnlyBuffs,
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
    imbalanceDmgBonus: 0.2,
    allDmgBonus: 0,
  },
  targetState: context.targetState,
};

const result = calculateSkillButtonDamageV2(input);
const physicalIds = new Set(result.hits[0].appliedBuffs.map((buff) => buff.id));
const electricIds = new Set(result.hits[1].appliedBuffs.map((buff) => buff.id));
assert.ok(physicalIds.has('fixed-dummy:armor-break'), 'armor break should hit physical damage');
assert.ok(!electricIds.has('fixed-dummy:armor-break'), 'armor break must not hit elemental damage');
assert.ok(!physicalIds.has('fixed-dummy:conductive'), 'conductive must not hit physical damage');
assert.ok(electricIds.has('fixed-dummy:conductive'), 'conductive should hit magic/electric damage');
assert.ok(physicalIds.has('fixed-dummy:corrosion') && electricIds.has('fixed-dummy:corrosion'), 'corrosion should hit every element');
assert.ok(physicalIds.has('fixed-dummy:attachment:electric') && electricIds.has('fixed-dummy:attachment:electric'), 'element attachment should remain visible as target state');
assert.equal(result.hits[0].zones.imbalanceDamageBonus, 0.5, 'downed dummy should activate panel imbalance bonus plus fixed 30% state');

const stableTarget = calculateSkillButtonDamageV2({
  ...input,
  buffs: [],
  displayOnlyBuffs: [],
  targetState: { ...context.targetState, isImbalanced: false },
});
assert.equal(stableTarget.hits[0].zones.imbalanceDamageBonus, 0, 'panel imbalance bonus must be gated by target state');

const akeStateEvents: FixedDummyEvent[] = [{
  buttonId: 'ake-state-source',
  characterId: 'source-operator',
  nodeIndex: 0,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'buff_target_physical_vulnerable',
    displayName: '物理脆弱',
    target: 'target',
    kind: 'status',
    effects: [{
      id: 'buff_target_physical_vulnerable:1',
      sourceBuffId: 'buff_target_physical_vulnerable',
      type: 'physicalVulnerability',
      value: 0.1,
      unit: 'percent',
      category: 'condition',
      durationSeconds: 16,
    }],
  }, {
    id: 'buff_team_damage_up',
    displayName: '全队增伤',
    target: 'team',
    kind: 'status',
    effects: [{
      id: 'buff_team_damage_up:1',
      sourceBuffId: 'buff_team_damage_up',
      type: 'allDmgBonus',
      value: 0.2,
      unit: 'percent',
      category: 'condition',
      durationSeconds: 8,
    }],
  }, {
    id: 'buff_self_skill_damage_up',
    displayName: '自身战技增伤',
    target: 'self',
    kind: 'status',
    effects: [{
      id: 'buff_self_skill_damage_up:1',
      sourceBuffId: 'buff_self_skill_damage_up',
      type: 'skillDmgBonus',
      value: 0.3,
      unit: 'percent',
      category: 'condition',
      durationSeconds: 5,
    }],
  }],
  anomalyCards: [],
  stateSnapshots: [],
}, {
  buttonId: 'same-node-state',
  characterId: 'source-operator',
  nodeIndex: 1,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'buff_same_node_must_not_leak',
    displayName: '同节点增伤',
    target: 'team',
    effects: [{
      id: 'buff_same_node_must_not_leak:1',
      sourceBuffId: 'buff_same_node_must_not_leak',
      type: 'allDmgBonus',
      value: 9,
    }],
  }],
  anomalyCards: [],
  stateSnapshots: [],
}];

const akeState = reduceFixedDummyState(akeStateEvents, 1);
const sourceContext = buildFixedDummyHitContext(akeState, 'source-operator');
const teammateContext = buildFixedDummyHitContext(akeState, 'teammate-operator');
const sourceBuffIds = new Set(sourceContext.modifierBuffs.map((buff) => buff.id));
const teammateBuffIds = new Set(teammateContext.modifierBuffs.map((buff) => buff.id));
const targetEffectId = 'ake-state:target:all:buff_target_physical_vulnerable:buff_target_physical_vulnerable:1';
const teamEffectId = 'ake-state:team:all:buff_team_damage_up:buff_team_damage_up:1';
const selfEffectId = 'ake-state:self:source-operator:buff_self_skill_damage_up:buff_self_skill_damage_up:1';
assert.ok(sourceBuffIds.has(targetEffectId) && teammateBuffIds.has(targetEffectId), 'target state should affect every operator');
assert.equal(
  sourceContext.modifierBuffs.find((buff) => buff.id === targetEffectId)?.displayName,
  '物理脆弱·物理脆弱',
  'persisted AKE hit Buff should expose the parsed effect type instead of an internal key',
);
assert.ok(sourceBuffIds.has(teamEffectId) && teammateBuffIds.has(teamEffectId), 'team state should affect every operator');
assert.ok(sourceBuffIds.has(selfEffectId), 'self state should return to its source operator');
assert.ok(!teammateBuffIds.has(selfEffectId), 'self state must not leak to another operator');
assert.ok([...sourceBuffIds].every((id) => !id.includes('same_node_must_not_leak')), 'same-node state must start after the applying node');

const sourceStateResult = calculateSkillButtonDamageV2({
  ...input,
  buffs: sourceContext.modifierBuffs,
  displayOnlyBuffs: sourceContext.displayOnlyBuffs,
  targetState: sourceContext.targetState,
});
const sourcePhysicalIds = new Set(sourceStateResult.hits[0].appliedBuffs.map((buff) => buff.id));
const sourceElectricIds = new Set(sourceStateResult.hits[1].appliedBuffs.map((buff) => buff.id));
assert.ok(sourcePhysicalIds.has(targetEffectId), 'AKE target physical vulnerability should hit later physical damage');
assert.ok(!sourceElectricIds.has(targetEffectId), 'AKE target physical vulnerability must not hit electric damage');
assert.ok(sourcePhysicalIds.has(teamEffectId) && sourceElectricIds.has(teamEffectId), 'AKE team all-damage state should hit every element');
assert.ok(sourcePhysicalIds.has(selfEffectId) && sourceElectricIds.has(selfEffectId), 'AKE self skill state should hit the source operator B skill');

const noGuardState = reduceFixedDummyState([{
  buttonId: 'no-guard-source',
  nodeIndex: 0,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'buff_physical_no_guard',
    displayName: 'No Guard',
    target: 'target',
    kind: 'status',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}], 1);
assert.equal(noGuardState.noGuardStacks, 1, 'AKE no_guard should accumulate the separate break-defense state');
assert.equal(noGuardState.armorBreakLevel, 0, 'break defense must not grant fracture damage before it is consumed');

const crushState = reduceFixedDummyState([{
  buttonId: 'first-crush',
  nodeIndex: 0,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'ake_status_physical_crush',
    displayName: '猛击',
    target: 'target',
    kind: 'status',
    statusKey: 'crush',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}, {
  buttonId: 'second-crush',
  nodeIndex: 1,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'ake_status_physical_crush',
    displayName: '猛击',
    target: 'target',
    kind: 'status',
    statusKey: 'crush',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}], 2);
assert.equal(crushState.noGuardStacks, 0, 'the second crush should consume accumulated break defense');
assert.equal(crushState.armorBreakLevel, 1, 'consumed break defense should enter fixed fracture Lv1');

const knockdownOnly = reduceFixedDummyState([{
  buttonId: 'knockdown-only',
  nodeIndex: 0,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'ake_status_physical_knockdown',
    displayName: '倒地',
    target: 'target',
    kind: 'status',
    statusKey: 'knockdown',
  }],
  anomalyCards: [],
  stateSnapshots: [],
}], 1);
assert.equal(knockdownOnly.isImbalanced, false, '倒地 and 失衡 remain distinct stable states');
assert.equal(knockdownOnly.noGuardStacks, 1, '倒地 should still advance the fixed physical break chain');

const poiseState = reduceFixedDummyState([{
  buttonId: 'poise-60',
  nodeIndex: 0,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'ake_status_poise_damage',
    displayName: '失衡值 60',
    target: 'target',
    kind: 'status',
    statusKey: 'poise-damage',
    statusValue: 60,
  }],
  anomalyCards: [],
  stateSnapshots: [],
}, {
  buttonId: 'poise-40',
  nodeIndex: 1,
  hitElements: ['physical'],
  hitBuffs: [{
    id: 'ake_status_poise_damage',
    displayName: '失衡值 40',
    target: 'target',
    kind: 'status',
    statusKey: 'poise-damage',
    statusValue: 40,
  }],
  anomalyCards: [],
  stateSnapshots: [],
}], 2);
assert.equal(poiseState.poiseDamage, 100);
assert.equal(poiseState.isImbalanced, true, 'fixed dummy should enter imbalance at its fixed poise cap');
