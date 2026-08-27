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
const ORIGINIUM_SHATTER_MULTIPLIER_PERCENT = 400;

type FixedDummyPhysicalTriggerStatusKey = 'crush' | 'fracture' | 'knockdown' | 'airborne';

/**
 * Runtime-resolved AKE hit input.  This deliberately stays structurally small so
 * the fixed dummy does not depend on the realtime timeline implementation.
 */
export interface FixedDummyResolvedEvent {
  buttonId: string;
  executionFrame?: number | null;
  isExecutable?: boolean;
  /** A precise chained physical stage emits one additional NoGuard attempt. */
  precisionBonusNoGuardLayers?: number;
  hits: Array<{
    frame?: number | null;
    offsetFrames?: number | null;
    damageType?: string | null;
    damageTypes?: string[];
    hitBuffs?: HitBuffEffect[];
  }>;
  statusEffects?: HitBuffEffect[];
}

export interface FixedDummyEvent {
  buttonId: string;
  characterId?: string;
  nodeIndex: number;
  /** Extra physical status transaction granted by a precise combo stage. */
  precisionBonusNoGuardLayers?: number;
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
  sourceCharacterId?: string;
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
  originiumShatterMultiplierPercent: number;
  poiseDamage: number;
  maxPoise: number;
  isImbalanced: boolean;
  magicHitCount: number;
  sourceButtonIds: string[];
  targetEffects: FixedActiveHitBuffEffect[];
  teamEffects: FixedActiveHitBuffEffect[];
  selfEffectsByCharacterId: Record<string, FixedActiveHitBuffEffect[]>;
}

export interface FixedDummyMechanicDamage extends PersistedAnomalyCard {
  /** AKE 命中状态机产出的真实伤害段，不受前端演示开关支配。 */
  isMandatoryMechanic: true;
  sourceStatusKey: FixedDummyPhysicalTriggerStatusKey | 'originium-seal';
  consumedNoGuardStacks: number;
  /** 仅该机制伤害自身生效的内建状态，例如碎甲伤害会吃到刚建立的碎甲区。 */
  intrinsicModifierBuffs: SkillButtonBuff[];
}

export interface FixedDummyStateTransition {
  key: string;
  label: string;
  beforeText: string;
  afterText: string;
  change: 'applied' | 'increased' | 'consumed' | 'removed' | 'changed';
  detail: string;
}

export interface FixedDummyStateBadge {
  key: string;
  shortLabel: string;
  label: string;
  detail: string;
  tone: 'physical' | 'magic' | 'attachment' | 'debuff' | 'state';
}

export interface FixedDummyHitContext {
  /** 当前按钮命中前的木桩状态；伤害区仍必须使用这一份。 */
  state: FixedDummyState;
  /** 当前按钮所有真实命中结算后的木桩状态，仅用于结果与后续按钮。 */
  afterState: FixedDummyState;
  stateTransitions: FixedDummyStateTransition[];
  afterStateBadges: FixedDummyStateBadge[];
  modifierBuffs: SkillButtonBuff[];
  displayOnlyBuffs: SkillButtonBuff[];
  mechanicAnomalyDamages: FixedDummyMechanicDamage[];
  targetState: {
    isImbalanced: boolean;
    armorBreakLevel: number;
    attachments: ElementType[];
  };
  afterTargetState: {
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

function elementFromAkeDamageType(value: string | null | undefined): ElementType | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'fire' || normalized.includes('fire')) return 'fire';
  if (normalized === 'cryst' || normalized === 'ice' || normalized.includes('cold')) return 'ice';
  if (normalized === 'pulse' || normalized === 'electric' || normalized.includes('lightning')) return 'electric';
  if (normalized === 'natural' || normalized === 'nature') return 'nature';
  return 'physical';
}

function dedupeResolvedHitBuffs(effects: readonly HitBuffEffect[]): HitBuffEffect[] {
  const seen = new Set<string>();
  return effects.filter((effect) => {
    const key = [
      effect.id,
      effect.target,
      effect.statusKey ?? '',
      Number.isFinite(effect.offsetFrames) ? effect.offsetFrames : 'unframed',
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    originiumShatterMultiplierPercent: 0,
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

/** Fresh calculator-dummy state for realtime schedulers and UI projections. */
export function createFixedDummyState(): FixedDummyState {
  return emptyState();
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function removeValue<T>(values: T[], value: T): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function cloneFixedDummyState(state: FixedDummyState): FixedDummyState {
  return {
    ...state,
    attachments: [...state.attachments],
    statuses: [...state.statuses],
    sourceButtonIds: [...state.sourceButtonIds],
    targetEffects: state.targetEffects.map((effect) => ({ ...effect })),
    teamEffects: state.teamEffects.map((effect) => ({ ...effect })),
    selfEffectsByCharacterId: Object.fromEntries(
      Object.entries(state.selfEffectsByCharacterId)
        .map(([characterId, effects]) => [
          characterId,
          effects.map((effect) => ({ ...effect })),
        ]),
    ),
  };
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
    const sourceCharacterId = event.characterId || undefined;
    const ownerCharacterId = target === 'self' ? sourceCharacterId : undefined;
    const activeEffect: FixedActiveHitBuffEffect = {
      key: [target, ownerCharacterId ?? 'all', hitBuff.id, effect.id].join(':'),
      parentBuffId: hitBuff.id,
      displayName: hitBuff.displayName,
      target,
      sourceCharacterId,
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

function applyStateStatus(
  state: FixedDummyState,
  key: string,
  level = 1,
  effectValue?: number,
): void {
  if (key === 'no-guard') {
    state.noGuardStacks = Math.min(4, state.noGuardStacks + clampLevel(level));
    addUnique(state.statuses, 'no-guard');
    return;
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
    removeValue(state.statuses, 'no-guard');
    addUnique(state.statuses, 'fracture');
    return;
  }
  if (key === 'conductive') {
    const nextLevel = clampLevel(level);
    const nextValue = typeof effectValue === 'number' && Number.isFinite(effectValue)
      ? effectValue
      : CONDUCTIVE_RATE_BY_LEVEL[nextLevel - 1] ?? CONDUCTIVE_RATE_BY_LEVEL[0];
    state.conductiveLevel = Math.max(state.conductiveLevel, nextLevel);
    state.conductiveEffectValue = Math.max(state.conductiveEffectValue, nextValue);
    addUnique(state.statuses, 'conductive');
    return;
  }
  if (key === 'corrosion') {
    const nextLevel = clampLevel(level);
    const nextValue = typeof effectValue === 'number' && Number.isFinite(effectValue)
      ? effectValue
      : CORROSION_POINTS_BY_LEVEL[nextLevel - 1] ?? CORROSION_POINTS_BY_LEVEL[0];
    state.corrosionLevel = Math.max(state.corrosionLevel, nextLevel);
    state.corrosionEffectValue = Math.max(state.corrosionEffectValue, nextValue);
    addUnique(state.statuses, 'corrosion');
    return;
  }
  if (key === 'originium-seal') {
    const atkScale = typeof effectValue === 'number' && Number.isFinite(effectValue) && effectValue > 0
      ? effectValue
      : ORIGINIUM_SHATTER_MULTIPLIER_PERCENT / 100;
    state.originiumShatterMultiplierPercent = atkScale * 100;
    addUnique(state.statuses, 'originium-seal');
    return;
  }
  if (key === 'knockdown' || key === 'airborne' || key === 'launch') {
    addUnique(state.statuses, key === 'launch' ? 'airborne' : key);
    return;
  }
  if (key === 'poise-damage' && typeof effectValue === 'number' && effectValue > 0) {
    state.poiseDamage = Math.min(state.maxPoise, state.poiseDamage + effectValue);
    if (state.poiseDamage >= state.maxPoise) {
      state.isImbalanced = true;
      addUnique(state.statuses, 'imbalance');
    }
    return;
  }
  if (key === 'imbalance' || key === 'imbalance-state') {
    state.isImbalanced = true;
    addUnique(state.statuses, 'imbalance');
    return;
  }
  addUnique(state.statuses, key);
}

function mechanicBaseMultiplierPercent(key: FixedDummyMechanicDamage['key'], level: number): number {
  if (key === 'smash') return 150 * (1 + level);
  if (key === 'armor-break') return 50 * (1 + level);
  return 120;
}

function buildMechanicDamage(
  event: FixedDummyEvent,
  statusKey: FixedDummyPhysicalTriggerStatusKey,
  consumedNoGuardStacks: number,
  occurrence: number,
): FixedDummyMechanicDamage {
  const key = statusKey === 'crush'
    ? 'smash'
    : statusKey === 'fracture'
      ? 'armor-break'
      : statusKey === 'airborne'
        ? 'launch'
        : 'knockdown';
  const label = key === 'smash'
    ? '猛击'
    : key === 'armor-break'
      ? '碎甲'
      : key === 'launch'
        ? '击飞'
        : '倒地';
  const level = key === 'smash' || key === 'armor-break'
    ? clampLevel(consumedNoGuardStacks)
    : 1;
  const id = `ake-mechanic:${event.buttonId}:${key}:${occurrence}`;
  const intrinsicModifierBuffs: SkillButtonBuff[] = key === 'armor-break'
    ? [{
        schemaVersion: 2,
        id: `${id}:intrinsic-fracture`,
        name: `${id}:intrinsic-fracture`,
        displayName: `碎甲内建物伤易伤 Lv${level}`,
        sourceName: 'AKE 真实状态机',
        type: 'physicalFragile',
        value: fixedArmorBreakValue(level),
        description: '碎甲先建立对应档位的物理伤害提高，再结算自身物理异常伤害。',
        source: 'ake_mechanic',
        condition: '碎甲真实命中内建效果；不受前端 Buff 启停控制',
        category: 'passive',
        ownerCharacterId: event.characterId,
        refCount: 1,
        target: { mode: 'all' },
      }]
    : [];

  return {
    id,
    key,
    label,
    kind: 'damage',
    category: 'physical',
    level,
    sourceCharacterId: event.characterId,
    sourceName: event.characterId,
    primaryText: `AKE 真实机制 · ${label}${key === 'smash' || key === 'armor-break' ? ` Lv${level}` : ''}`,
    secondaryText: `${mechanicBaseMultiplierPercent(key, level)}% 物理异常 hit`,
    tertiaryText: `完整消费 ${consumedNoGuardStacks} 层破防；真实命中不受 Buff 演示开关影响`,
    selectedBuffIds: [],
    isMandatoryMechanic: true,
    sourceStatusKey: statusKey,
    consumedNoGuardStacks,
    intrinsicModifierBuffs,
  };
}

function buildOriginiumShatterDamage(
  event: FixedDummyEvent,
  occurrence: number,
  baseMultiplierPercent: number,
): FixedDummyMechanicDamage {
  const id = `ake-mechanic:${event.buttonId}:originium-shatter:${occurrence}`;
  return {
    id,
    key: 'originium-shatter',
    label: '源石结晶击碎',
    kind: 'damage',
    category: 'physical',
    level: 0,
    sourceCharacterId: event.characterId,
    sourceName: event.characterId,
    primaryText: 'AKE 真实机制 · 源石结晶击碎',
    secondaryText: `${baseMultiplierPercent}% 物理额外 hit`,
    tertiaryText: '物理状态或破防触发结晶 Ignite；结晶被完整消费，真实命中不受 Buff 演示开关影响',
    selectedBuffIds: [],
    isMandatoryMechanic: true,
    sourceStatusKey: 'originium-seal',
    consumedNoGuardStacks: 0,
    intrinsicModifierBuffs: [],
    baseMultiplierPercent,
    usesRawAtkScale: true,
  };
}

function shatterOriginiumSeal(
  state: FixedDummyState,
  event: FixedDummyEvent,
  mechanicDamages: FixedDummyMechanicDamage[],
): void {
  if (!state.statuses.includes('originium-seal')) return;
  const baseMultiplierPercent = state.originiumShatterMultiplierPercent
    || ORIGINIUM_SHATTER_MULTIPLIER_PERCENT;
  removeValue(state.statuses, 'originium-seal');
  state.originiumShatterMultiplierPercent = 0;
  mechanicDamages.push(buildOriginiumShatterDamage(
    event,
    mechanicDamages.filter((damage) => damage.sourceStatusKey === 'originium-seal').length + 1,
    baseMultiplierPercent,
  ));
}

function applyPhysicalTrigger(
  state: FixedDummyState,
  event: FixedDummyEvent,
  statusKey: FixedDummyPhysicalTriggerStatusKey,
  mechanicDamages: FixedDummyMechanicDamage[],
): void {
  if (statusKey === 'knockdown' || statusKey === 'airborne') {
    // 固定木桩按首领/不可控目标处理。每次击飞或倒地尝试都会走失败
    // 分支并增加一层破防；已有破防也不能把下一次尝试误判为成功控制。
    // 这正是“陈战技 + 陈连携 = 2 层破防”的 CaLC 行为。
    applyStateStatus(state, 'no-guard', 1);
    shatterOriginiumSeal(state, event, mechanicDamages);
    return;
  }
  if (state.noGuardStacks <= 0) {
    // TryCrushed 的失败分支挂一层破防；碎甲必须已有破防才成立。
    if (statusKey !== 'fracture') {
      applyStateStatus(state, 'no-guard', 1);
      // 源石结晶同时监听 NoGuard；失败动作产生破防时同样会击碎结晶。
      shatterOriginiumSeal(state, event, mechanicDamages);
    }
    return;
  }

  const consumedNoGuardStacks = state.noGuardStacks;
  state.noGuardStacks = 0;
  removeValue(state.statuses, 'no-guard');
  if (statusKey === 'fracture') {
    applyStateStatus(state, 'fracture', consumedNoGuardStacks);
  }
  mechanicDamages.push(buildMechanicDamage(
    event,
    statusKey,
    consumedNoGuardStacks,
    mechanicDamages.filter((damage) => damage.sourceStatusKey === statusKey).length + 1,
  ));
  // buff_common_originum_frozen 的 PhysicalStatus ignite 与物理异常伤害
  // 是两个独立 DamageAction，因此必须再产出一张独立命中卡。
  shatterOriginiumSeal(state, event, mechanicDamages);
}

function transitionChange(before: number, after: number): FixedDummyStateTransition['change'] {
  if (before === 0 && after > 0) return 'applied';
  if (after === 0 && before > 0) return 'consumed';
  return after > before ? 'increased' : 'changed';
}

export function buildFixedDummyStateTransitions(
  before: FixedDummyState,
  after: FixedDummyState,
  mechanicDamages: readonly FixedDummyMechanicDamage[] = [],
): FixedDummyStateTransition[] {
  const transitions: FixedDummyStateTransition[] = [];
  const pushLevel = (
    key: string,
    label: string,
    beforeValue: number,
    afterValue: number,
    suffix: string,
  ) => {
    if (beforeValue === afterValue) return;
    const mechanic = mechanicDamages.find((damage) => (
      (key === 'no-guard' && damage.consumedNoGuardStacks > 0)
      || (key === 'armor-break' && damage.key === 'armor-break')
    ));
    const mechanicText = mechanic
      ? `；${mechanic.primaryText}${mechanic.consumedNoGuardStacks > 0 ? `完整消费 ${mechanic.consumedNoGuardStacks} 层破防` : ''}`
      : '';
    transitions.push({
      key,
      label,
      beforeText: `${beforeValue}${suffix}`,
      afterText: `${afterValue}${suffix}`,
      change: transitionChange(beforeValue, afterValue),
      detail: `${label} ${beforeValue}${suffix} → ${afterValue}${suffix}${mechanicText}`,
    });
  };

  pushLevel('no-guard', '破防', before.noGuardStacks, after.noGuardStacks, '层');
  pushLevel('armor-break', '碎甲', before.armorBreakLevel, after.armorBreakLevel, '级');
  pushLevel('conductive', '导电', before.conductiveLevel, after.conductiveLevel, '级');
  pushLevel('corrosion', '腐蚀', before.corrosionLevel, after.corrosionLevel, '级');
  pushLevel('poise', '失衡值', before.poiseDamage, after.poiseDamage, '');

  if (before.isImbalanced !== after.isImbalanced) {
    transitions.push({
      key: 'imbalance',
      label: '失衡',
      beforeText: before.isImbalanced ? '是' : '否',
      afterText: after.isImbalanced ? '是' : '否',
      change: after.isImbalanced ? 'applied' : 'removed',
      detail: `失衡 ${before.isImbalanced ? '已生效' : '未生效'} → ${after.isImbalanced ? '已生效' : '已解除'}`,
    });
  }

  const beforeAttachments = new Set(before.attachments);
  const afterAttachments = new Set(after.attachments);
  for (const element of afterAttachments) {
    if (beforeAttachments.has(element)) continue;
    transitions.push({
      key: `attachment:${element}`,
      label: `${attachmentLabel(element)}附着`,
      beforeText: '无',
      afterText: '已附着',
      change: 'applied',
      detail: `${attachmentLabel(element)}附着 无 → 已附着`,
    });
  }
  for (const element of beforeAttachments) {
    if (afterAttachments.has(element)) continue;
    transitions.push({
      key: `attachment:${element}`,
      label: `${attachmentLabel(element)}附着`,
      beforeText: '已附着',
      afterText: '已移除',
      change: 'removed',
      detail: `${attachmentLabel(element)}附着 已附着 → 已移除`,
    });
  }

  const handledStatuses = new Set([
    'no-guard', 'fracture', 'armor-break', 'conductive', 'corrosion',
    'imbalance', 'imbalance-state',
  ]);
  for (const key of after.statuses) {
    if (handledStatuses.has(key) || before.statuses.includes(key)) continue;
    transitions.push({
      key: `status:${key}`,
      label: statusLabel(key),
      beforeText: '无',
      afterText: '已生效',
      change: 'applied',
      detail: `${statusLabel(key)} 无 → 已生效`,
    });
  }
  for (const key of before.statuses) {
    if (handledStatuses.has(key) || after.statuses.includes(key)) continue;
    transitions.push({
      key: `status:${key}`,
      label: statusLabel(key),
      beforeText: '已生效',
      afterText: '已移除',
      change: 'removed',
      detail: `${statusLabel(key)} 已生效 → 已移除`,
    });
  }
  return transitions;
}

export function buildFixedDummyStateBadges(state: FixedDummyState): FixedDummyStateBadge[] {
  const badges: FixedDummyStateBadge[] = [];
  if (state.noGuardStacks > 0) badges.push({
    key: 'no-guard',
    shortLabel: `破${state.noGuardStacks}`,
    label: `破防 ${state.noGuardStacks} 层`,
    detail: `攻击后木桩保留 ${state.noGuardStacks} 层破防`,
    tone: 'physical',
  });
  if (state.armorBreakLevel > 0) badges.push({
    key: 'armor-break',
    shortLabel: `碎${state.armorBreakLevel}`,
    label: `碎甲 Lv${state.armorBreakLevel}`,
    detail: `物伤易伤 +${(state.armorBreakEffectValue * 100).toFixed(1)}%`,
    tone: 'physical',
  });
  if (state.conductiveLevel > 0) badges.push({
    key: 'conductive',
    shortLabel: `导${state.conductiveLevel}`,
    label: `导电 Lv${state.conductiveLevel}`,
    detail: `法术易伤 +${(state.conductiveEffectValue * 100).toFixed(1)}%`,
    tone: 'magic',
  });
  if (state.corrosionLevel > 0) badges.push({
    key: 'corrosion',
    shortLabel: `蚀${state.corrosionLevel}`,
    label: `腐蚀 Lv${state.corrosionLevel}`,
    detail: `全属性降抗 ${state.corrosionEffectValue.toFixed(2)} 点`,
    tone: 'magic',
  });
  if (state.isImbalanced) badges.push({
    key: 'imbalance',
    shortLabel: '失衡',
    label: '倒地/失衡',
    detail: '木桩已进入固定失衡伤害区',
    tone: 'state',
  });
  if (state.statuses.includes('originium-seal')) badges.push({
    key: 'originium-seal',
    shortLabel: '晶',
    label: '源石结晶封印',
    detail: `下一次对应物理状态触发 ${state.originiumShatterMultiplierPercent || ORIGINIUM_SHATTER_MULTIPLIER_PERCENT}% 额外物理 hit`,
    tone: 'state',
  });
  state.attachments.forEach((element) => badges.push({
    key: `attachment:${element}`,
    shortLabel: `${attachmentLabel(element).slice(0, 1)}附`,
    label: `${attachmentLabel(element)}附着`,
    detail: `攻击后木桩保留${attachmentLabel(element)}附着`,
    tone: 'attachment',
  }));
  state.targetEffects.forEach((effect) => badges.push({
    key: `target-effect:${effect.key}`,
    shortLabel: `${getBuffTypeLabel(effect.type).slice(0, 2)}${effect.unit === 'percent' ? `${Math.round(effect.value * 100)}%` : ''}`,
    label: `${effect.displayName}·${getBuffTypeLabel(effect.type)}`,
    detail: `${getBuffTypeLabel(effect.type)} ${formatActiveEffectValue(effect)}；由 ${effect.sourceButtonId} 的真实命中施加`,
    tone: 'debuff',
  }));
  return badges;
}

function applyExplicitAnomalyCard(state: FixedDummyState, card: PersistedAnomalyCard): void {
  if (card.key === 'combo-state') return;
  if (card.kind === 'damage' && card.key === 'smash') {
    state.noGuardStacks = 0;
    removeValue(state.statuses, 'no-guard');
    return;
  }
  if (card.kind === 'damage' && (card.key === 'knockdown' || card.key === 'launch')) {
    state.noGuardStacks = 0;
    removeValue(state.statuses, 'no-guard');
    applyStateStatus(state, card.key);
    return;
  }
  applyStateStatus(
    state,
    card.key === 'armor-break' ? 'fracture' : card.key,
    card.level,
  );
}

function applyFixedDummyEventToState(
  state: FixedDummyState,
  event: FixedDummyEvent,
  mechanicDamages: FixedDummyMechanicDamage[],
): void {
  addUnique(state.sourceButtonIds, event.buttonId);
  state.magicHitCount += event.hitElements.filter((element) => element !== 'physical').length;
  const appliedPhysicalTriggerEvents = new Set<string>();

  event.hitBuffs.forEach((effect) => {
    if (normalizeHitBuffTarget(effect.target) === 'target') {
      const attachment = attachmentElement(effect);
      if (attachment) addUnique(state.attachments, attachment);
      const statusKey = statusKeyFromHitBuff(effect);
      const physicalStatusKey = statusKey === 'armor-break'
        ? 'fracture'
        : statusKey === 'launch'
          ? 'airborne'
          : statusKey;
      if (physicalStatusKey === 'crush'
        || physicalStatusKey === 'fracture'
        || physicalStatusKey === 'knockdown'
        || physicalStatusKey === 'airborne') {
        const frameToken = Number.isFinite(effect.offsetFrames)
          ? String(effect.offsetFrames)
          : 'legacy-unframed';
        const triggerEventKey = `${physicalStatusKey}:${frameToken}`;
        // v15 及更早的浏览器缓存会把同一个 skill-wide 状态复制到每段 Hit。
        // 对无帧旧数据按状态去重；v16 数据则凭真实帧保留多次独立触发。
        if (!appliedPhysicalTriggerEvents.has(triggerEventKey)) {
          appliedPhysicalTriggerEvents.add(triggerEventKey);
          applyPhysicalTrigger(state, event, physicalStatusKey, mechanicDamages);
        }
      } else if (statusKey) {
        applyStateStatus(state, statusKey, 1, effect.statusValue);
        if (statusKey === 'no-guard') {
          shatterOriginiumSeal(state, event, mechanicDamages);
        }
      }
    }
    persistHitBuffEffects(state, event, effect);
  });

  event.anomalyCards.forEach((card) => applyExplicitAnomalyCard(state, card));
  event.stateSnapshots.forEach((snapshot) => {
    applyStateStatus(
      state,
      snapshot.key,
      snapshot.level,
      snapshot.key === 'corrosion'
        ? snapshot.currentCorrosion ?? snapshot.effectValue
        : snapshot.effectValue,
    );
  });

  // The runtime's precise combo branch is a second physical-status
  // transaction, not a UI-only annotation. Keep it separate from the normal
  // hit-buff loop so a skill-wide status copied to several hits cannot multiply
  // the bonus. The caller attaches this field to the final resolved hit only.
  const precisionBonus = Math.max(
    0,
    Math.floor(Number(event.precisionBonusNoGuardLayers ?? 0)),
  );
  for (let index = 0; index < precisionBonus; index += 1) {
    applyStateStatus(state, 'no-guard', 1);
  }
}

export function resolveFixedDummyEvent(
  previousState: FixedDummyState,
  event: FixedDummyEvent,
): { state: FixedDummyState; mechanicAnomalyDamages: FixedDummyMechanicDamage[] } {
  const state = cloneFixedDummyState(previousState);
  const mechanicAnomalyDamages: FixedDummyMechanicDamage[] = [];
  applyFixedDummyEventToState(state, event, mechanicAnomalyDamages);
  return { state, mechanicAnomalyDamages };
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
      applyFixedDummyEventToState(state, event, []);
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
    'originium-seal': '源石结晶封印',
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
    ownerCharacterId: effect.sourceCharacterId ?? effect.ownerCharacterId,
    ...(effect.sourceCharacterId || effect.ownerCharacterId ? {
      ownerBuffDomain: 'operator' as const,
      ownerBuffGroup: 'skill' as const,
    } : {}),
    refCount: 1,
    target: { mode: 'all' },
  };
}

export function buildFixedDummyHitContext(
  state: FixedDummyState,
  currentCharacterId?: string,
  mechanicAnomalyDamages: FixedDummyMechanicDamage[] = [],
  afterState: FixedDummyState = state,
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
      condition: '前序事件已消费破防并进入碎甲状态',
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
    afterState,
    stateTransitions: buildFixedDummyStateTransitions(state, afterState, mechanicAnomalyDamages),
    afterStateBadges: buildFixedDummyStateBadges(afterState),
    modifierBuffs,
    displayOnlyBuffs,
    mechanicAnomalyDamages,
    targetState: {
      isImbalanced: state.isImbalanced,
      armorBreakLevel: state.armorBreakLevel,
      attachments: [...state.attachments],
    },
    afterTargetState: {
      isImbalanced: afterState.isImbalanced,
      armorBreakLevel: afterState.armorBreakLevel,
      attachments: [...afterState.attachments],
    },
  };
}

export function buildFixedDummyContextForButton(input: {
  timelineData: TimelineData | null | undefined;
  buttonTable: SkillButtonTable;
  currentButtonId: string;
  currentNodeIndex: number;
  resolveStateSnapshots: (ids: number[]) => AnomalyStateSnapshot[];
  resolvedEvents?: readonly FixedDummyResolvedEvent[];
}): FixedDummyHitContext {
  const allTimelineButtons = (input.timelineData?.staffLines ?? [])
    .flatMap((staffLine) => staffLine.buttons);
  const currentTimelineButton = allTimelineButtons
    .find((timelineButton) => timelineButton.id === input.currentButtonId);
  const currentCharacterId = input.buttonTable[input.currentButtonId]?.characterId
    ?? currentTimelineButton?.characterId;
  const resolvedEventByButtonId = new Map(
    (input.resolvedEvents ?? []).map((event) => [event.buttonId, event]),
  );
  const events: FixedDummyEvent[] = allTimelineButtons
    .flatMap((timelineButton): FixedDummyEvent[] => {
      const persisted = input.buttonTable[timelineButton.id];
      const runtimeEvent = resolvedEventByButtonId.get(timelineButton.id);
      if (runtimeEvent && runtimeEvent.isExecutable === false) return [];
      const hits = timelineButton.customHits ?? persisted?.customHits ?? [];
      const runtimeHitElements = runtimeEvent?.hits.flatMap((hit) => {
        const primary = elementFromAkeDamageType(hit.damageType);
        if (primary) return [primary];
        return (hit.damageTypes ?? [])
          .map(elementFromAkeDamageType)
          .filter((element): element is ElementType => element !== null);
      }) ?? [];
      const runtimeHitBuffs = runtimeEvent
        ? dedupeResolvedHitBuffs([
            ...runtimeEvent.hits.flatMap((hit) => hit.hitBuffs ?? []),
            ...(runtimeEvent.statusEffects ?? []),
          ])
        : null;
      const anomalyConfig = persisted?.anomalyConfig;
      const baseEvent = {
        buttonId: timelineButton.id,
        characterId: persisted?.characterId ?? timelineButton.characterId,
        anomalyCards: [
          ...(anomalyConfig?.selectedStatuses ?? []),
          ...(anomalyConfig?.selectedDamages ?? []),
        ],
        stateSnapshots: input.resolveStateSnapshots(anomalyConfig?.selectedStateSnapshotIds ?? []),
      };
      if (!runtimeEvent) {
        return [{
          ...baseEvent,
          nodeIndex: timelineButton.nodeIndex,
          hitElements: hits.map((hit) => hit.element),
          hitBuffs: hits.flatMap((hit) => hit.hitBuffs ?? []),
        }];
      }
      if (runtimeEvent.hits.length === 0) {
        return [{
          ...baseEvent,
          nodeIndex: runtimeEvent.executionFrame ?? timelineButton.nodeIndex,
          hitElements: runtimeHitElements,
          hitBuffs: runtimeHitBuffs ?? [],
          precisionBonusNoGuardLayers: runtimeEvent.precisionBonusNoGuardLayers,
        }];
      }
      const projectedStatusKeys = new Set(runtimeEvent.hits.flatMap((hit) => (
        (hit.hitBuffs ?? []).map((effect) => `${effect.id}\u0000${effect.target}`)
      )));
      const unprojectedStatuses = (runtimeEvent.statusEffects ?? []).filter((effect) => (
        !projectedStatusKeys.has(`${effect.id}\u0000${effect.target}`)
      ));
      return runtimeEvent.hits.map((hit, hitIndex) => {
        const primary = elementFromAkeDamageType(hit.damageType);
        const hitElements = primary
          ? [primary]
          : (hit.damageTypes ?? [])
            .map(elementFromAkeDamageType)
            .filter((element): element is ElementType => element !== null);
        const isFinalHit = hitIndex === runtimeEvent.hits.length - 1;
        return {
          ...baseEvent,
          nodeIndex: hit.frame
            ?? ((runtimeEvent.executionFrame ?? timelineButton.nodeIndex) + (hit.offsetFrames ?? 0)),
          hitElements,
          hitBuffs: dedupeResolvedHitBuffs([
            ...(hit.hitBuffs ?? []),
            ...(isFinalHit ? unprojectedStatuses : []),
          ]),
          precisionBonusNoGuardLayers: isFinalHit
            ? runtimeEvent.precisionBonusNoGuardLayers
            : undefined,
          anomalyCards: isFinalHit ? baseEvent.anomalyCards : [],
          stateSnapshots: isFinalHit ? baseEvent.stateSnapshots : [],
        };
      });
    });
  const currentRuntimeEvent = resolvedEventByButtonId.get(input.currentButtonId);
  const currentNodeIndex = currentRuntimeEvent?.executionFrame
    ?? currentTimelineButton?.nodeIndex
    ?? input.currentNodeIndex;
  const currentEvents = events
    .filter((event) => event.buttonId === input.currentButtonId)
    .sort((left, right) => left.nodeIndex - right.nodeIndex);
  const currentStartFrame = currentEvents[0]?.nodeIndex ?? currentNodeIndex;
  const priorState = reduceFixedDummyState(
    events.filter((event) => event.buttonId !== input.currentButtonId),
    currentStartFrame,
  );
  const currentResolution = currentEvents.reduce((resolution, event) => {
    const next = resolveFixedDummyEvent(resolution.state, event);
    return {
      state: next.state,
      mechanicAnomalyDamages: [
        ...resolution.mechanicAnomalyDamages,
        ...next.mechanicAnomalyDamages,
      ],
    };
  }, {
    state: cloneFixedDummyState(priorState),
    mechanicAnomalyDamages: [] as FixedDummyMechanicDamage[],
  });
  return buildFixedDummyHitContext(
    priorState,
    currentCharacterId,
    currentResolution.mechanicAnomalyDamages,
    currentResolution.state,
  );
}
