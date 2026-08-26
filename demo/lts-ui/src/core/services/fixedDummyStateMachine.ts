import type { ElementType, HitBuffEffect, TimelineData } from '../../types';
import type {
  AnomalyStateSnapshot,
  PersistedAnomalyCard,
  SkillButtonBuff,
  SkillButtonTable,
} from '../../types/storage';
import { getBuffTypeLabel } from '../domain/buffTypeMetadata';

const ARMOR_BREAK_RATE_BY_LEVEL = [0.12, 0.16, 0.2, 0.24] as const;
const CONDUCTIVE_RATE_BY_LEVEL = [0.12, 0.16, 0.2, 0.24] as const;
const CORROSION_POINTS_BY_LEVEL = [3.6, 4.8, 6, 7.2] as const;
const FIXED_IMBALANCE_RATE = 0.3;
const FIXED_DUMMY_MAX_POISE = 100;

export interface FixedDummyEvent {
  buttonId: string;
  characterId?: string;
  nodeIndex: number;
  hitElements: ElementType[];
  hitBuffs: HitBuffEffect[];
  anomalyCards: PersistedAnomalyCard[];
  stateSnapshots: AnomalyStateSnapshot[];
}

export interface FixedActiveHitBuffEffect {
  key: string;
  parentBuffId: string;
  displayName: string;
  target: 'target' | 'team' | 'self';
  ownerCharacterId?: string;
  type: string;
  value: number;
  unit?: string;
  category?: string;
  maxStacks?: number;
  durationSeconds?: number;
  sourceButtonId: string;
}

export interface FixedDummyState {
  attachments: ElementType[];
  statuses: string[];
  noGuardStacks: number;
  armorBreakLevel: number;
  armorBreakEffectValue: number;
  conductiveLevel: number;
  conductiveEffectValue: number;
  corrosionLevel: number;
  corrosionEffectValue: number;
  poiseDamage: number;
  maxPoise: number;
  isImbalanced: boolean;
  magicHitCount: number;
  sourceButtonIds: string[];
  targetEffects: FixedActiveHitBuffEffect[];
  teamEffects: FixedActiveHitBuffEffect[];
  selfEffectsByCharacterId: Record<string, FixedActiveHitBuffEffect[]>;
}

export interface FixedDummyHitContext {
  state: FixedDummyState;
  modifierBuffs: SkillButtonBuff[];
  displayOnlyBuffs: SkillButtonBuff[];
  targetState: {
    isImbalanced: boolean;
    armorBreakLevel: number;
    attachments: ElementType[];
  };
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(Math.max(Math.floor(level), 1), 4);
}

function fixedArmorBreakValue(level: number): number {
  return ARMOR_BREAK_RATE_BY_LEVEL[clampLevel(level) - 1] ?? ARMOR_BREAK_RATE_BY_LEVEL[0];
}

function attachmentElement(effect: HitBuffEffect): ElementType | null {
  const text = `${effect.id} ${effect.displayName}`.toLowerCase();
  const isAttachment = effect.kind === 'attachment'
    || text.includes('attached')
    || text.includes('attachment')
    || text.includes('附着');
  if (!isAttachment) return null;
  if (text.includes('fire') || text.includes('灼热')) return 'fire';
  if (text.includes('natural') || text.includes('nature') || text.includes('自然')) return 'nature';
  if (text.includes('cryst') || text.includes('ice') || text.includes('cold') || text.includes('寒冷')) return 'ice';
  if (text.includes('pulse') || text.includes('electric') || text.includes('lightning') || text.includes('电磁')) return 'electric';
  return null;
}

function statusKeyFromHitBuff(effect: HitBuffEffect): string | null {
  if (effect.statusKey) return effect.statusKey;
  const text = `${effect.id} ${effect.displayName}`.toLowerCase();
  if (text.includes('no_guard')
    || text.includes('noguard')
    || text.includes('no guard')
    || text.includes('破防')) {
    return 'no-guard';
  }
  if (text.includes('armorbreak') || text.includes('armor_break') || text.includes('fracture') || text.includes('碎甲')) return 'fracture';
  if (text.includes('crush') || text.includes('猛击')) return 'crush';
  if (text.includes('knockdown') || text.includes('downed') || text.includes('倒地')) return 'knockdown';
  if (text.includes('airborne') || text.includes('launch') || text.includes('击飞')) return 'airborne';
  if (text.includes('poise_damage') || text.includes('失衡值')) return 'poise-damage';
  if (text.includes('poise_break') || text.includes('失衡')) return 'imbalance';
  if (text.includes('conduct') || text.includes('导电')) return 'conductive';
  if (text.includes('corrosion') || text.includes('corrupt') || text.includes('腐蚀')) return 'corrosion';
  if (text.includes('burn') || text.includes('燃烧')) return 'burn';
  if (text.includes('freeze') || text.includes('frozen') || text.includes('冻结')) return 'freeze';
  return null;
}

function emptyState(): FixedDummyState {
  return {
    attachments: [],
    statuses: [],
    noGuardStacks: 0,
    armorBreakLevel: 0,
    armorBreakEffectValue: 0,
    conductiveLevel: 0,
    conductiveEffectValue: 0,
    corrosionLevel: 0,
    corrosionEffectValue: 0,
    poiseDamage: 0,
    maxPoise: FIXED_DUMMY_MAX_POISE,
    isImbalanced: false,
    magicHitCount: 0,
    sourceButtonIds: [],
    targetEffects: [],
    teamEffects: [],
    selfEffectsByCharacterId: {},
  };
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function normalizeHitBuffTarget(target: string): 'target' | 'team' | 'self' | null {
  const normalized = target.trim().toLowerCase();
  if (normalized === 'target') return 'target';
  if (normalized === 'team' || normalized === 'squad') return 'team';
  if (normalized === 'self' || normalized === 'source' || normalized === 'owner') return 'self';
  return null;
}

function replaceActiveEffect(
  effects: FixedActiveHitBuffEffect[],
  effect: FixedActiveHitBuffEffect,
): void {
  const index = effects.findIndex((candidate) => candidate.key === effect.key);
  if (index >= 0) {
    effects[index] = effect;
    return;
  }
  effects.push(effect);
}

function persistHitBuffEffects(
  state: FixedDummyState,
  event: FixedDummyEvent,
  hitBuff: HitBuffEffect,
): void {
  const target = normalizeHitBuffTarget(hitBuff.target);
  if (!target) return;

  for (const effect of hitBuff.effects ?? []) {
    if (!effect.type || !Number.isFinite(effect.value) || effect.value === 0) continue;
    if (target === 'self' && !event.characterId) continue;
    const ownerCharacterId = target === 'self' ? event.characterId : undefined;
    const activeEffect: FixedActiveHitBuffEffect = {
      key: [target, ownerCharacterId ?? 'all', hitBuff.id, effect.id].join(':'),
      parentBuffId: hitBuff.id,
      displayName: hitBuff.displayName,
      target,
      ownerCharacterId,
      type: effect.type,
      value: effect.value,
      unit: effect.unit,
      category: effect.category,
      maxStacks: effect.maxStacks,
      durationSeconds: effect.durationSeconds,
      sourceButtonId: event.buttonId,
    };
    if (target === 'target') {
      replaceActiveEffect(state.targetEffects, activeEffect);
    } else if (target === 'team') {
      replaceActiveEffect(state.teamEffects, activeEffect);
    } else if (ownerCharacterId) {
      const selfEffects = state.selfEffectsByCharacterId[ownerCharacterId] ?? [];
      replaceActiveEffect(selfEffects, activeEffect);
      state.selfEffectsByCharacterId[ownerCharacterId] = selfEffects;
    }
  }
}

function applyStatus(
  state: FixedDummyState,
  key: string,
  level = 1,
  effectValue?: number,
): void {
  if (key !== 'poise-damage') addUnique(state.statuses, key);
  if (key === 'no-guard') {
    state.noGuardStacks = Math.min(4, state.noGuardStacks + clampLevel(level));
  }
  if (key === 'crush') {
    if (state.noGuardStacks > 0) {
      const consumedStacks = state.noGuardStacks;
      state.noGuardStacks = 0;
      applyStatus(state, 'fracture', consumedStacks);
    } else {
      applyStatus(state, 'no-guard', 1);
    }
  }
  if (key === 'fracture' || key === 'armor-break') {
    const nextLevel = clampLevel(state.noGuardStacks > 0 ? state.noGuardStacks : level);
    const nextValue = typeof effectValue === 'number' && Number.isFinite(effectValue)
      ? effectValue
      : fixedArmorBreakValue(nextLevel);
    if (nextLevel > state.armorBreakLevel || nextValue > state.armorBreakEffectValue) {
      state.armorBreakLevel = Math.max(state.armorBreakLevel, nextLevel);
      state.armorBreakEffectValue = Math.max(state.armorBreakEffectValue, nextValue);
    }
    state.noGuardStacks = 0;
    addUnique(state.statuses, 'fracture');
  }
  if (key === 'conductive') {
    const nextLevel = clampLevel(level);
    const nextValue = typeof effectValue === 'number' && Number.isFinite(effectValue)
      ? effectValue
      : CONDUCTIVE_RATE_BY_LEVEL[nextLevel - 1] ?? CONDUCTIVE_RATE_BY_LEVEL[0];
    state.conductiveLevel = Math.max(state.conductiveLevel, nextLevel);
    state.conductiveEffectValue = Math.max(state.conductiveEffectValue, nextValue);
  }
  if (key === 'corrosion') {
    const nextLevel = clampLevel(level);
    const nextValue = typeof effectValue === 'number' && Number.isFinite(effectValue)
      ? effectValue
      : CORROSION_POINTS_BY_LEVEL[nextLevel - 1] ?? CORROSION_POINTS_BY_LEVEL[0];
    state.corrosionLevel = Math.max(state.corrosionLevel, nextLevel);
    state.corrosionEffectValue = Math.max(state.corrosionEffectValue, nextValue);
  }
  if (key === 'knockdown' || key === 'airborne' || key === 'launch') {
    state.noGuardStacks = Math.min(4, state.noGuardStacks + 1);
  }
  if (key === 'poise-damage' && typeof effectValue === 'number' && effectValue > 0) {
    state.poiseDamage = Math.min(state.maxPoise, state.poiseDamage + effectValue);
    if (state.poiseDamage >= state.maxPoise) {
      state.isImbalanced = true;
      addUnique(state.statuses, 'imbalance');
    }
  }
  if (key === 'imbalance' || key === 'imbalance-state') {
    state.isImbalanced = true;
    addUnique(state.statuses, 'imbalance');
  }
}

export function reduceFixedDummyState(
  events: FixedDummyEvent[],
  currentNodeIndex: number,
): FixedDummyState {
  const state = emptyState();
  events
    .filter((event) => Number.isFinite(event.nodeIndex) && event.nodeIndex < currentNodeIndex)
    .sort((left, right) => left.nodeIndex - right.nodeIndex)
    .forEach((event) => {
      addUnique(state.sourceButtonIds, event.buttonId);
      state.magicHitCount += event.hitElements.filter((element) => element !== 'physical').length;

      event.hitBuffs.forEach((effect) => {
        if (normalizeHitBuffTarget(effect.target) === 'target') {
          const attachment = attachmentElement(effect);
          if (attachment) addUnique(state.attachments, attachment);
          const statusKey = statusKeyFromHitBuff(effect);
          if (statusKey) applyStatus(state, statusKey, 1, effect.statusValue);
        }
        persistHitBuffEffects(state, event, effect);
      });

      event.anomalyCards.forEach((card) => {
        if (card.key === 'combo-state') return;
        applyStatus(
          state,
          card.key === 'armor-break' ? 'fracture' : card.key,
          card.level,
        );
      });

      event.stateSnapshots.forEach((snapshot) => {
        applyStatus(
          state,
          snapshot.key,
          snapshot.level,
          snapshot.key === 'corrosion'
            ? snapshot.currentCorrosion ?? snapshot.effectValue
            : snapshot.effectValue,
        );
      });
    });
  return state;
}

function statusLabel(key: string): string {
  return ({
    'no-guard': '破防',
    crush: '猛击',
    fracture: '碎甲',
    knockdown: '倒地',
    airborne: '击飞',
    'poise-damage': '失衡值',
    imbalance: '失衡',
    conductive: '导电',
    corrosion: '腐蚀',
    burn: '燃烧',
    freeze: '冻结',
  } as Record<string, string>)[key] ?? key;
}

function attachmentLabel(element: ElementType): string {
  return ({
    physical: '物理',
    fire: '灼热',
    electric: '电磁',
    ice: '寒冷',
    nature: '自然',
  } as const)[element];
}

function canAffectDamageHit(type: string): boolean {
  const panelTypes = new Set([
    'atkPercentBoost',
    'flatAtk',
    'mainStat',
    'subStat',
    'mainStatBoost',
    'subStatBoost',
    'allStatBoost',
    'strengthBoost',
    'agilityBoost',
    'intelligenceBoost',
    'willBoost',
    'critRateBoost',
    'critDmgBonusBoost',
  ]);
  return panelTypes.has(type)
    || /(DmgBonus|Fragile|Vulnerability|Amplify|Corrosion|ResistanceIgnore)$/.test(type)
    || type === 'comboDamageBonus'
    || type === 'imbalanceDmgBonus'
    || type === 'multiplierBonus'
    || type === 'multiplierMultiplier';
}

function canTargetEffectModifyAttacker(type: string): boolean {
  return /(Fragile|Vulnerability|Corrosion|ResistanceIgnore)$/.test(type)
    || type === 'imbalanceDmgBonus';
}

function formatActiveEffectValue(effect: FixedActiveHitBuffEffect): string {
  const value = effect.unit === 'percent' ? effect.value * 100 : effect.value;
  const precision = Number.isInteger(value) ? 0 : 1;
  return `${value >= 0 ? '+' : ''}${value.toFixed(precision)}${effect.unit === 'percent' ? '%' : ''}`;
}

function activeEffectToBuff(effect: FixedActiveHitBuffEffect): SkillButtonBuff {
  const ownerLabel = effect.target === 'target'
    ? '木桩'
    : effect.target === 'team'
      ? '全队'
      : '自身';
  const durationText = typeof effect.durationSeconds === 'number'
    ? `；AKE 持续时间 ${effect.durationSeconds.toFixed(2)} 秒`
    : '';
  const typeLabel = getBuffTypeLabel(effect.type);
  return {
    schemaVersion: 2,
    id: `ake-state:${effect.key}`,
    name: `ake-state:${effect.key}`,
    displayName: `${effect.displayName}·${typeLabel}`,
    sourceName: `AKE 命中状态（${ownerLabel}）`,
    type: effect.type,
    value: effect.value,
    description: `前序 Hit 施加 ${effect.displayName}：${typeLabel} ${formatActiveEffectValue(effect)}${durationText}`,
    source: 'ake_state_machine',
    condition: '前序事件已命中；当前木桩模型固定持续到排轴结束',
    // 状态已经由一次真实命中施加。即使原 Buff 可叠层，这里也只记录当前
    // 简化状态的一份有效值，避免计算器在没有显式层数时自动取满层。
    category: 'passive',
    ownerCharacterId: effect.ownerCharacterId,
    refCount: 1,
    target: { mode: 'all' },
  };
}

export function buildFixedDummyHitContext(
  state: FixedDummyState,
  currentCharacterId?: string,
): FixedDummyHitContext {
  const modifierBuffs: SkillButtonBuff[] = [];
  if (state.armorBreakLevel > 0 && state.armorBreakEffectValue > 0) {
    modifierBuffs.push({
      schemaVersion: 2,
      id: 'fixed-dummy:armor-break',
      name: 'fixed-dummy:armor-break',
      displayName: `木桩·碎甲 Lv${state.armorBreakLevel}`,
      sourceName: '木桩固定状态',
      type: 'physicalFragile',
      value: state.armorBreakEffectValue,
      description: `固定碎甲档位：物伤易伤 +${(state.armorBreakEffectValue * 100).toFixed(1)}%`,
      source: 'fixed_dummy_state',
      condition: '前序事件已施加碎甲/破防',
      category: 'passive',
      refCount: 1,
      target: { mode: 'all' },
    });
  }
  if (state.isImbalanced) {
    modifierBuffs.push({
      schemaVersion: 2,
      id: 'fixed-dummy:imbalance',
      name: 'fixed-dummy:imbalance',
      displayName: '木桩·倒地/失衡',
      sourceName: '木桩固定状态',
      type: 'imbalanceDmgBonus',
      value: FIXED_IMBALANCE_RATE,
      description: '木桩处于倒地/失衡状态，固定进入 30% 失衡区',
      source: 'fixed_dummy_state',
      condition: '前序事件已造成倒地/失衡',
      category: 'passive',
      refCount: 1,
      target: { mode: 'all' },
    });
  }
  if (state.conductiveLevel > 0 && state.conductiveEffectValue > 0) {
    modifierBuffs.push({
      schemaVersion: 2,
      id: 'fixed-dummy:conductive',
      name: 'fixed-dummy:conductive',
      displayName: `木桩·导电 Lv${state.conductiveLevel}`,
      sourceName: '木桩固定状态',
      type: 'magicFragile',
      value: state.conductiveEffectValue,
      description: `固定导电档位：法术易伤 +${(state.conductiveEffectValue * 100).toFixed(1)}%`,
      source: 'fixed_dummy_state',
      condition: '前序事件已施加导电',
      category: 'passive',
      refCount: 1,
      target: { mode: 'all' },
    });
  }
  if (state.corrosionLevel > 0 && state.corrosionEffectValue > 0) {
    modifierBuffs.push({
      schemaVersion: 2,
      id: 'fixed-dummy:corrosion',
      name: 'fixed-dummy:corrosion',
      displayName: `木桩·腐蚀 Lv${state.corrosionLevel}`,
      sourceName: '木桩固定状态',
      type: 'allCorrosion',
      value: state.corrosionEffectValue,
      description: `固定腐蚀档位：全属性降抗 ${state.corrosionEffectValue.toFixed(2)} 点`,
      source: 'fixed_dummy_state',
      condition: '前序事件已施加腐蚀',
      category: 'passive',
      refCount: 1,
      target: { mode: 'all' },
    });
  }

  const activeEffects = [
    ...state.targetEffects,
    ...state.teamEffects,
    ...(currentCharacterId ? state.selfEffectsByCharacterId[currentCharacterId] ?? [] : []),
  ];
  const seenActiveEffectIds = new Set<string>();
  const activeModifierBuffs: SkillButtonBuff[] = [];
  const activeDisplayOnlyBuffs: SkillButtonBuff[] = [];
  activeEffects.forEach((effect) => {
    const buff = activeEffectToBuff(effect);
    if (seenActiveEffectIds.has(buff.id)) return;
    seenActiveEffectIds.add(buff.id);
    if (canAffectDamageHit(effect.type)
      && (effect.target !== 'target' || canTargetEffectModifyAttacker(effect.type))) {
      activeModifierBuffs.push(buff);
    } else {
      activeDisplayOnlyBuffs.push({ ...buff, displayOnly: true });
    }
  });
  modifierBuffs.push(...activeModifierBuffs);

  const displayOnlyBuffs: SkillButtonBuff[] = [
    ...activeDisplayOnlyBuffs,
    ...(state.poiseDamage > 0 && !state.isImbalanced ? [{
      schemaVersion: 2 as const,
      id: 'fixed-dummy:status:poise-progress',
      name: 'fixed-dummy:status:poise-progress',
      displayName: `木桩·失衡值 ${state.poiseDamage}/${state.maxPoise}`,
      sourceName: '木桩固定状态',
      description: `前序命中已累计 ${state.poiseDamage} 点失衡值；达到 ${state.maxPoise} 时进入失衡。`,
      source: 'fixed_dummy_state',
      condition: '固定木桩暂不进行随时间恢复',
      category: 'passive' as const,
      displayOnly: true,
      refCount: 1,
      target: { mode: 'all' as const },
    }] : []),
    ...(state.noGuardStacks > 0 ? [{
      schemaVersion: 2 as const,
      id: 'fixed-dummy:status:no-guard',
      name: 'fixed-dummy:status:no-guard',
      displayName: `木桩·破防 ${state.noGuardStacks} 层`,
      sourceName: '木桩固定状态',
      description: `前序物理异常已累计 ${state.noGuardStacks} 层破防；破防本身不等同于碎甲易伤。`,
      source: 'fixed_dummy_state',
      condition: '状态持续到后续猛击/碎甲动作消费（临时固定规则）',
      category: 'passive' as const,
      displayOnly: true,
      refCount: 1,
      target: { mode: 'all' as const },
    }] : []),
    ...state.attachments.map((element): SkillButtonBuff => ({
      schemaVersion: 2,
      id: `fixed-dummy:attachment:${element}`,
      name: `fixed-dummy:attachment:${element}`,
      displayName: `木桩·${attachmentLabel(element)}附着`,
      sourceName: '木桩固定状态',
      description: `前序 Hit 已向木桩施加${attachmentLabel(element)}附着`,
      source: 'fixed_dummy_state',
      condition: '状态持续到排轴结束（临时固定规则）',
      category: 'passive',
      displayOnly: true,
      refCount: 1,
      target: { mode: 'all' },
    })),
    ...state.statuses
      .filter((key) => !['armor-break', 'fracture', 'no-guard', 'conductive', 'corrosion', 'imbalance', 'imbalance-state'].includes(key))
      .map((key): SkillButtonBuff => ({
        schemaVersion: 2,
        id: `fixed-dummy:status:${key}`,
        name: `fixed-dummy:status:${key}`,
        displayName: `木桩·${statusLabel(key)}`,
        sourceName: '木桩固定状态',
        description: `前序事件已向木桩施加${statusLabel(key)}`,
        source: 'fixed_dummy_state',
        condition: '状态持续到排轴结束（临时固定规则）',
        category: 'passive',
        displayOnly: true,
        refCount: 1,
        target: { mode: 'all' },
      })),
  ];

  return {
    state,
    modifierBuffs,
    displayOnlyBuffs,
    targetState: {
      isImbalanced: state.isImbalanced,
      armorBreakLevel: state.armorBreakLevel,
      attachments: [...state.attachments],
    },
  };
}

export function buildFixedDummyContextForButton(input: {
  timelineData: TimelineData | null | undefined;
  buttonTable: SkillButtonTable;
  currentButtonId: string;
  currentNodeIndex: number;
  resolveStateSnapshots: (ids: number[]) => AnomalyStateSnapshot[];
}): FixedDummyHitContext {
  const allTimelineButtons = (input.timelineData?.staffLines ?? [])
    .flatMap((staffLine) => staffLine.buttons);
  const currentTimelineButton = allTimelineButtons
    .find((timelineButton) => timelineButton.id === input.currentButtonId);
  const currentCharacterId = input.buttonTable[input.currentButtonId]?.characterId
    ?? currentTimelineButton?.characterId;
  const events: FixedDummyEvent[] = (input.timelineData?.staffLines ?? [])
    .flatMap((staffLine) => staffLine.buttons)
    .filter((timelineButton) => timelineButton.id !== input.currentButtonId)
    .map((timelineButton) => {
      const persisted = input.buttonTable[timelineButton.id];
      const hits = timelineButton.customHits ?? persisted?.customHits ?? [];
      const anomalyConfig = persisted?.anomalyConfig;
      return {
        buttonId: timelineButton.id,
        characterId: persisted?.characterId ?? timelineButton.characterId,
        nodeIndex: timelineButton.nodeIndex,
        hitElements: hits.map((hit) => hit.element),
        hitBuffs: hits.flatMap((hit) => hit.hitBuffs ?? []),
        anomalyCards: [
          ...(anomalyConfig?.selectedStatuses ?? []),
          ...(anomalyConfig?.selectedDamages ?? []),
        ],
        stateSnapshots: input.resolveStateSnapshots(anomalyConfig?.selectedStateSnapshotIds ?? []),
      };
    });
  return buildFixedDummyHitContext(
    reduceFixedDummyState(events, input.currentNodeIndex),
    currentCharacterId,
  );
}
