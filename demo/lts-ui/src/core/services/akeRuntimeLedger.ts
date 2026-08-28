import type { FormulaViewModel, AppliedBuffTagViewModel } from '../calculators/skillDamage.types';
import type {
  AkeCommandSettlement,
  AkePanelAttackTrace,
  AkeRuntimeConsumedStatus,
  AkeRuntimeDamageFactor,
  AkeRuntimeHit,
  AkeRuntimeModifierContribution,
  AkeRuntimeStatusEvent,
  AkeTeamReport,
} from '../../integrations/ake/akeProvider';

const TEAM_COMBO_BUFF_ID = 'buff_common_affixes_combo_trigger';

type RuntimeStatusMetadata = {
  label: string;
  shortLabel: string;
  extraHitLabel?: string;
  hidden?: boolean;
  mainDisplay?: boolean;
  priority?: number;
  iconUrl?: string;
  iconId?: string;
  effectType?: string;
  applicationScope?: string;
};

const RUNTIME_STATUS_METADATA: Record<string, RuntimeStatusMetadata> = {
  [TEAM_COMBO_BUFF_ID]: {
    label: '连击',
    shortLabel: '连',
    mainDisplay: true,
    priority: 5,
    effectType: 'teamCombo',
    applicationScope: 'team',
  },
  buff_physical_no_guard: { label: '破防', shortLabel: '破', mainDisplay: true, priority: 0 },
  buff_physical_no_guard_fake: { label: '破防结算标记', shortLabel: '破', hidden: true },
  buff_physical_handle_cryst_break: { label: '结晶击碎监听', shortLabel: '晶', hidden: true },
  buff_physical_fracture: {
    label: '碎甲', shortLabel: '碎', extraHitLabel: '碎甲·物理异常伤害', mainDisplay: true, priority: 10,
  },
  buff_physical_do_fracture: { label: '碎甲触发', shortLabel: '碎', hidden: true },
  buff_physical_crushed: {
    label: '猛击', shortLabel: '猛', extraHitLabel: '猛击·物理异常伤害', priority: 40,
  },
  buff_physical_airborne: {
    label: '击飞', shortLabel: '飞', extraHitLabel: '击飞·物理异常伤害', priority: 20,
  },
  buff_physical_knockdown: {
    label: '倒地', shortLabel: '倒', extraHitLabel: '倒地·物理异常伤害', priority: 30,
  },
  buff_common_originum_frozen: {
    label: '源石结晶', shortLabel: '晶', extraHitLabel: '源石结晶击碎', priority: 60,
  },
  buff_common_enemy_spell_status_conduct: {
    label: '导电', shortLabel: '导', mainDisplay: true, priority: 70,
  },
  buff_common_enemy_spell_status_frozen: {
    label: '冻结', shortLabel: '冻', mainDisplay: true, priority: 80,
  },
  buff_common_enemy_spell_status_burning: {
    label: '燃烧', shortLabel: '燃', mainDisplay: true, priority: 81,
  },
  buff_common_enemy_spell_status_corrupt: {
    label: '腐蚀', shortLabel: '蚀', mainDisplay: true, priority: 82,
  },
  buff_common_poise_can_be_breaking_attacked: { label: '失衡', shortLabel: '衡', priority: 50 },
  buff_common_poise_break_damage_taken_scale: { label: '失衡易伤', shortLabel: '易', priority: 51 },
  buff_common_obtain_ultimate_sp: { label: '终结技能量恢复', shortLabel: '能', hidden: true },
};

const ATTRIBUTE_LABELS: Record<string, string> = {
  Atk: '攻击力',
  Str: '力量',
  Agi: '敏捷',
  Wisd: '智识',
  Will: '意志',
  CriticalRate: '暴击率',
  CriticalDamageIncrease: '暴击伤害',
  PhysicalDamageIncrease: '物理伤害加成',
  FireDamageIncrease: '灼热伤害加成',
  PulseDamageIncrease: '电磁伤害加成',
  CrystDamageIncrease: '寒冷伤害加成',
  NaturalDamageIncrease: '自然伤害加成',
  EtherDamageIncrease: '法术伤害加成',
  NormalAttackDamageIncrease: '普攻伤害加成',
  NormalSkillDamageIncrease: '战技伤害加成',
  ComboSkillDamageIncrease: '连携伤害加成',
  UltimateSkillDamageIncrease: '终结技伤害加成',
};

const DAMAGE_TYPE_LABELS: Record<string, string> = {
  Physical: '物理',
  Fire: '灼热',
  Pulse: '电磁',
  Cryst: '寒冷',
  Natural: '自然',
  Ether: '法术',
};

const COMMAND_TYPE_LABELS: Record<string, string> = {
  Attack: '普通攻击',
  NormalSkill: '战技',
  ComboSkill: '连携技',
  UltimateSkill: '终结技',
  BreakingAttack: '处决攻击',
};

export type AkeRuntimeStatusLabelMap = ReadonlyMap<string, string>;

export type AkeRuntimeStatusView = {
  key: string;
  buffId: string;
  title: string;
  detail: string;
  kind: string;
  groupLabel: string;
  groupOrder: number;
  priority: number;
  iconUrl?: string;
  iconAlt?: string;
};

export type AkeRuntimeCompactStatus = {
  key: string;
  buffId: string;
  label: string;
  title: string;
  tone: string;
  iconUrl?: string;
  displayName: string;
  stackCount: number;
  mainDisplay: boolean;
  priority: number;
  applicationScope?: string;
};

export type AkeRuntimeHitView = {
  key: string;
  title: string;
  meta: string;
  expected: string;
  crit: string;
  nonCrit: string;
  formula: FormulaViewModel;
  statuses: AkeRuntimeStatusView[];
  hit: AkeRuntimeHit;
};

export type AkeRuntimeCommandLedger = {
  command: AkeCommandSettlement;
  hits: AkeRuntimeHitView[];
  statuses: AkeRuntimeStatusView[];
  compactStatuses: AkeRuntimeCompactStatus[];
  summary: {
    title: string;
    expected: string;
    crit: string;
    nonCrit: string;
    formula: string;
    parts: Array<{ label: string; value: string }>;
  } | null;
};

export type RuntimeCommandViewState =
  | { kind: 'pending'; message: string; ledger: null }
  | { kind: 'stale'; message: string; ledger: null }
  | { kind: 'rejected'; message: string; ledger: null; command: AkeCommandSettlement }
  | { kind: 'partial'; message: string; ledger: AkeRuntimeCommandLedger; command: AkeCommandSettlement }
  | { kind: 'settled'; message: string; ledger: AkeRuntimeCommandLedger; command: AkeCommandSettlement }
  | { kind: 'manual-preview'; message: string; ledger: null };

/**
 * Main-axis badges are an after-command state snapshot.  Both transitions and
 * inherited primary states stay visible; their tone tells the renderer whether
 * this command changed the state or merely carried it forward.  Hiding the
 * latter makes persistent enemy state appear to vanish between buttons.
 */
export function selectAkeMainTimelineStatuses(
  ledger: AkeRuntimeCommandLedger | null | undefined,
): AkeRuntimeCompactStatus[] {
  return ledger?.compactStatuses.filter((status) => status.mainDisplay) ?? [];
}

type ActiveRuntimeStatus = {
  event: AkeRuntimeStatusEvent;
  stackCount: number;
};

let cachedLabelSource: object | null = null;
let cachedLabels: ReadonlyMap<string, string> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function trimNumber(value: number, digits = 3): string {
  const fixed = finite(value).toFixed(digits);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function fixedDamage(value: number): string {
  return finite(value).toFixed(0);
}

function percent(value: number, digits = 1): string {
  return `${(finite(value) * 100).toFixed(digits)}%`;
}

function fallbackStatusLabel(buffId: string): string {
  void buffId;
  return '未命名状态';
}

function dynamicRuntimeStatusMetadata(buffId: string): Partial<RuntimeStatusMetadata> | null {
  if (buffId.includes('energy_shard_attached_')) {
    if (buffId.includes('_fire')) return { label: '灼热附着', shortLabel: '灼', mainDisplay: true, priority: 81 };
    if (buffId.includes('_pulse')) return { label: '电磁附着', shortLabel: '电', mainDisplay: true, priority: 82 };
    if (buffId.includes('_cryst')) return { label: '寒冷附着', shortLabel: '寒', mainDisplay: true, priority: 83 };
    if (buffId.includes('_natural')) return { label: '自然附着', shortLabel: '自', mainDisplay: true, priority: 84 };
    return { label: '元素附着', shortLabel: '附', mainDisplay: true, priority: 85 };
  }
  const normalized = buffId.toLowerCase();
  if (/^buff_common_try_(?:fire|pulse|natural|cryst)_(?:fire|pulse|natural|cryst)_triggered$/.test(normalized)
    || /_(?:triggered_start|triggered_fx|triggered_wrapper)$/.test(normalized)) {
    return { label: '元素异常内部事件', shortLabel: '异', hidden: true };
  }
  const explicit = /^buff_common_(fire|pulse|natural|cryst)_\1_(?:burning|conduct|corrupt|frozen)_triggered$/.exec(normalized);
  const crossed = /^buff_common_(fire|pulse|natural|cryst)_(fire|pulse|natural|cryst)_triggered$/.exec(normalized);
  const reactionElement = explicit?.[1]
    ?? (crossed && crossed[1] !== crossed[2] ? crossed[1] : null);
  if (reactionElement === 'pulse') {
    return { label: '导电', shortLabel: '导', mainDisplay: true, priority: 70 };
  }
  if (reactionElement === 'fire' || normalized === 'buff_common_burning_status') {
    return { label: '燃烧', shortLabel: '燃', priority: 80 };
  }
  if (reactionElement === 'natural') return { label: '腐蚀', shortLabel: '蚀', priority: 80 };
  if (reactionElement === 'cryst') return { label: '冻结', shortLabel: '冻', priority: 80 };
  return null;
}

function runtimeStatusMetadata(
  buffId: string,
  labels: AkeRuntimeStatusLabelMap,
  event?: AkeRuntimeStatusEvent | null,
): RuntimeStatusMetadata {
  const builtIn = RUNTIME_STATUS_METADATA[buffId] ?? dynamicRuntimeStatusMetadata(buffId);
  const eventLabel = event?.displayName?.trim() || '';
  const catalogLabel = labels.get(buffId);
  const label = builtIn?.label || eventLabel || catalogLabel || fallbackStatusLabel(buffId);
  return {
    ...builtIn,
    label,
    shortLabel: builtIn?.shortLabel || event?.shortName?.trim() || label.slice(0, 1),
    hidden: event?.hidden ?? builtIn?.hidden,
    iconUrl: event?.iconUrl || builtIn?.iconUrl,
    iconId: event?.iconId || builtIn?.iconId,
    effectType: event?.effectType || builtIn?.effectType,
    applicationScope: event?.applicationScope || builtIn?.applicationScope,
  };
}

function isPrimaryRuntimeStatus(buffId: string, metadata: RuntimeStatusMetadata): boolean {
  if (metadata.mainDisplay) return true;
  const semanticText = [buffId, metadata.effectType, metadata.applicationScope, metadata.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return semanticText.includes('energy_shard_attached_')
    || semanticText.includes('element_attachment')
    || semanticText.includes('元素附着');
}

function runtimeStatusPriority(buffId: string, metadata: RuntimeStatusMetadata): number {
  if (typeof metadata.priority === 'number') return metadata.priority;
  const text = `${buffId} ${metadata.label}`;
  if (/破防|no_guard/.test(text)) return 0;
  if (/碎甲|fracture/.test(text)) return 10;
  if (/击飞|airborne/.test(text)) return 20;
  if (/倒地|knockdown/.test(text)) return 30;
  if (/猛击|crushed/.test(text)) return 40;
  if (/失衡|poise/.test(text)) return 50;
  if (/源石结晶|originum_frozen/.test(text)) return 60;
  if (/导电|conduct/.test(text)) return 70;
  if (/附着|burning|frozen|corrupt|energy_shard_attached/.test(text)) return 80;
  return 1000;
}

function isCriticalRuntimeStatus(buffId: string, metadata: RuntimeStatusMetadata): boolean {
  return runtimeStatusPriority(buffId, metadata) < 100;
}

function sourceGroupLabel(sourceName: string): string {
  if (sourceName.includes('敌方')) return '敌方减益';
  if (sourceName.includes('武器')) return '武器';
  if (sourceName.includes('三件套') || sourceName.includes('装备') || sourceName.includes('套装')) return '装备';
  if (sourceName.includes('天赋')) return '干员天赋';
  if (sourceName.includes('潜能')) return '干员潜能';
  if (sourceName.includes('自身') || sourceName.includes('攻击方')) return '干员自身';
  return sourceName || '其他来源';
}

function sourceGroupOrder(sourceName: string): number {
  const group = sourceGroupLabel(sourceName);
  if (group === '敌方减益') return 20;
  if (group === '干员自身' || group === '干员天赋' || group === '干员潜能') return 30;
  if (group === '武器') return 40;
  if (group === '装备') return 50;
  return 60;
}

/**
 * Builds a Buff-id label index from catalog data without knowing which actor
 * owns the effect. This is deliberately keyed only by source Buff identity;
 * character names never participate in runtime behavior.
 */
export function buildAkeRuntimeStatusLabelMap(source: unknown): ReadonlyMap<string, string> {
  if (isRecord(source) && cachedLabelSource === source && cachedLabels) return cachedLabels;
  const labels = new Map<string, string>();
  const visited = new WeakSet<object>();
  const registerLabel = (identifier: string, label: string) => {
    labels.set(identifier, label);
    const numericChild = identifier.replace(/(_\d+)_\d+$/, '$1');
    const companion = numericChild.replace(/_(?:aura|instance|trigger|tirgger)$/, '');
    for (const alias of [numericChild, companion]) {
      if (alias !== identifier && alias.startsWith('buff_') && !labels.has(alias)) {
        labels.set(alias, label);
      }
    }
  };
  const walk = (value: unknown, inheritedLabel = '') => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, inheritedLabel));
      return;
    }
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    const ownLabel = [value.displayName, value.name]
      .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    const label = ownLabel?.trim() || inheritedLabel;
    for (const identifier of [value.sourceBuffId, value.buffId]) {
      if (typeof identifier === 'string' && identifier.startsWith('buff_') && label) {
        registerLabel(identifier, label);
      }
    }
    if (typeof value.id === 'string' && value.id.startsWith('buff_') && label) {
      registerLabel(value.id, label);
    }
    Object.values(value).forEach((child) => walk(child, label));
  };
  walk(source);
  if (isRecord(source)) {
    cachedLabelSource = source;
    cachedLabels = labels;
  }
  return labels;
}

function statusInstanceKey(event: AkeRuntimeStatusEvent): string {
  return event.instanceId ?? [event.buffId, event.targetId, event.sourceId].join('|');
}

function isFinishStage(stage: string): boolean {
  return ['StatusEffectFinished', 'StatusEffectExpired', 'StatusEffectRemoved'].includes(stage);
}

function applyStatusEvent(state: Map<string, ActiveRuntimeStatus>, event: AkeRuntimeStatusEvent) {
  const key = statusInstanceKey(event);
  const after = finite(event.after ?? event.stackCount, 0);
  if (isFinishStage(event.stage) || after <= 0) {
    state.delete(key);
    return;
  }
  if (['StatusEffectApplied', 'StatusEffectRefreshed', 'StatusEffectStackRemoved'].includes(event.stage)) {
    state.set(key, { event, stackCount: after });
  }
}

function activeStatusesAt(events: AkeRuntimeStatusEvent[], frame: number, inclusive: boolean) {
  const state = new Map<string, ActiveRuntimeStatus>();
  events.forEach((event) => {
    if (event.frame < frame || (inclusive && event.frame === frame)) applyStatusEvent(state, event);
  });
  return state;
}

function activeStatusesBeforeHit(events: AkeRuntimeStatusEvent[], hit: AkeRuntimeHit) {
  const state = new Map<string, ActiveRuntimeStatus>();
  events.forEach((event) => {
    const isBeforeHit = event.frame < hit.frame
      || (event.frame === hit.frame
        && event.parentHitId === hit.hitId
        && event.hitEventPhase === 'before');
    if (isBeforeHit) applyStatusEvent(state, event);
  });
  return state;
}

function sortRuntimeStatusViews(statuses: AkeRuntimeStatusView[]): AkeRuntimeStatusView[] {
  return [...statuses].sort((left, right) => (
    left.groupOrder - right.groupOrder
    || left.priority - right.priority
    || left.title.localeCompare(right.title, 'zh-CN')
    || left.key.localeCompare(right.key)
  ));
}

function uniqueConsumedStatuses(hits: AkeRuntimeHit[]): AkeRuntimeConsumedStatus[] {
  const byIdentity = new Map<string, AkeRuntimeConsumedStatus>();
  hits.forEach((hit) => {
    (hit.consumedStatuses ?? []).forEach((snapshot) => {
      const identity = `${snapshot.key}|${snapshot.buffId}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, snapshot);
    });
  });
  return [...byIdentity.values()];
}

function teamComboStacksInState(
  state: Map<string, ActiveRuntimeStatus>,
  targetId: string | null,
): number {
  if (!targetId) return 0;
  return Math.min(4, [...state.values()]
    .filter((active) => (
      active.event.buffId === TEAM_COMBO_BUFF_ID
      && active.event.targetId === targetId
    ))
    .reduce((sum, active) => sum + active.stackCount, 0));
}

function runtimeActorName(report: AkeTeamReport, actorId: string | null): string | null {
  if (!actorId) return null;
  return report.characters.find((character) => (
    character.akeCharacterId === actorId
    || character.memberId === actorId
    || character.localCharacterId === actorId
  ))?.characterName ?? null;
}

function consumedStatusView(
  snapshot: AkeRuntimeConsumedStatus,
  report: AkeTeamReport,
  labels: AkeRuntimeStatusLabelMap,
  keyPrefix: string,
): AkeRuntimeStatusView {
  const metadata = runtimeStatusMetadata(snapshot.buffId, labels);
  const stacks = Math.max(0, finite(snapshot.consumedStacks, 0));
  const sources = (snapshot.sourceStacks ?? [])
    .filter((source) => finite(source.count, 0) > 0)
    .map((source, index) => (
      `${runtimeActorName(report, source.sourceId) ?? `队伍来源${index + 1}`} ${finite(source.count, 0)}层`
    ));
  return {
    key: `${keyPrefix}:${snapshot.castId}:${snapshot.key}`,
    buffId: snapshot.buffId,
    title: `${metadata.label} ×${stacks}`,
    detail: [
      '队伍共享',
      `本次动作开始时统一消耗 ${stacks} 层`,
      '全部 Hit 继承同一份快照',
      sources.length > 0 ? `来源：${sources.join(' / ')}` : '',
    ].filter(Boolean).join(' · '),
    kind: '本次技能消耗',
    groupLabel: '关键战斗状态',
    groupOrder: 0,
    priority: runtimeStatusPriority(snapshot.buffId, metadata),
    iconUrl: metadata.iconUrl,
    iconAlt: metadata.label,
  };
}

function pooledTeamComboView(input: {
  stacks: number;
  beforeStacks?: number;
  command: AkeCommandSettlement;
  tickRate: number;
  labels: AkeRuntimeStatusLabelMap;
  keyPrefix: string;
  moment: string;
}): AkeRuntimeStatusView {
  const metadata = runtimeStatusMetadata(TEAM_COMBO_BUFF_ID, input.labels);
  const frame = input.command.actualFrame ?? input.command.requestedFrame;
  const before = input.beforeStacks;
  const change = before === undefined || before === input.stacks
    ? `${input.stacks}层`
    : `${before} → ${input.stacks}层`;
  return {
    key: `${input.keyPrefix}:${input.command.castId ?? input.command.commandId}`,
    buffId: TEAM_COMBO_BUFF_ID,
    title: `${metadata.label} ×${input.stacks}`,
    detail: [
      '队伍共享',
      change,
      `F${frame} / ${(frame / input.tickRate).toFixed(2)}秒`,
    ].join(' · '),
    kind: input.moment,
    groupLabel: '关键战斗状态',
    groupOrder: 0,
    priority: runtimeStatusPriority(TEAM_COMBO_BUFF_ID, metadata),
    iconUrl: metadata.iconUrl,
    iconAlt: metadata.label,
  };
}

function scopeLabel(targetId: string | null, command: AkeCommandSettlement, enemyId: string): string {
  if (targetId === enemyId) return '敌方';
  if (targetId && targetId === command.characterId) return '自身';
  if (targetId) return '队伍';
  return '未指定目标';
}

function stageLabel(event: AkeRuntimeStatusEvent): string {
  if (event.stage === 'StatusEffectApplied') return '施加';
  if (event.stage === 'StatusEffectRefreshed') {
    return finite(event.after) > finite(event.before) ? '叠层并刷新' : '刷新';
  }
  if (event.stage === 'StatusEffectStackRemoved') return '消耗层数';
  if (event.reason === 'Expired' || event.stage === 'StatusEffectExpired') return '到期';
  return '移除';
}

function eventDetail(
  event: AkeRuntimeStatusEvent,
  command: AkeCommandSettlement,
  enemyId: string,
  tickRate: number,
): string {
  const before = finite(event.before, 0);
  const after = finite(event.after ?? event.stackCount, 0);
  const stack = before === after ? `${after}层` : `${before} → ${after}层`;
  const duration = event.durationFrames === null
    ? ''
    : `持续 ${(event.durationFrames / tickRate).toFixed(2)}秒`;
  const reason = event.reason && event.reason !== 'Finished' ? event.reason : '';
  return [
    `F${event.frame} / ${(event.frame / tickRate).toFixed(2)}秒`,
    scopeLabel(event.targetId, command, enemyId),
    stageLabel(event),
    stack,
    duration,
    reason,
  ].filter(Boolean).join(' · ');
}

function snapshotStatusView(
  keyPrefix: string,
  active: ActiveRuntimeStatus,
  command: AkeCommandSettlement,
  enemyId: string,
  tickRate: number,
  labels: AkeRuntimeStatusLabelMap,
  moment: '命中前' | '命中后',
): AkeRuntimeStatusView | null {
  const metadata = runtimeStatusMetadata(active.event.buffId, labels, active.event);
  if (metadata.hidden) return null;
  const scope = scopeLabel(active.event.targetId, command, enemyId);
  const priority = runtimeStatusPriority(active.event.buffId, metadata);
  const isCritical = isCriticalRuntimeStatus(active.event.buffId, metadata);
  const expires = active.event.expireFrame === null
    ? '持续生效'
    : `至 ${(active.event.expireFrame / tickRate).toFixed(2)}秒`;
  return {
    key: `${keyPrefix}:${statusInstanceKey(active.event)}`,
    buffId: active.event.buffId,
    title: `${metadata.label}${active.stackCount > 1 ? ` ×${active.stackCount}` : ''}`,
    detail: `${scope} · ${expires}`,
    kind: `${moment}·${scope}状态`,
    groupLabel: isCritical ? '关键战斗状态' : `${scope}持续状态`,
    groupOrder: isCritical ? 0 : moment === '命中前' ? 70 : 80,
    priority,
    iconUrl: metadata.iconUrl,
    iconAlt: metadata.label,
  };
}

function isPassiveRegistration(event: AkeRuntimeStatusEvent): boolean {
  return event.castId === null
    && event.durationFrames === null
    && event.expireFrame === null;
}

function transitionBelongsToCast(event: AkeRuntimeStatusEvent, castId: string): boolean {
  if (event.triggerCastId === castId || event.triggerRootCastId === castId) return true;
  return (event.castId === castId || event.rootCastId === castId)
    && ['StatusEffectApplied', 'StatusEffectRefreshed'].includes(event.stage);
}

function statusEventOrder(left: AkeRuntimeStatusEvent, right: AkeRuntimeStatusEvent): number {
  return left.frame - right.frame || left.traceIndex - right.traceIndex;
}

const ATTRIBUTE_BUFF_TYPES: Record<string, string> = {
  Atk: 'atkPercentBoost',
  Str: 'strengthBoost',
  Agi: 'agilityBoost',
  Wisd: 'intelligenceBoost',
  Will: 'willBoost',
  CriticalRate: 'critRateBoost',
  CriticalDamageIncrease: 'critDmgBonusBoost',
  PhysicalDamageIncrease: 'physicalDmgBonus',
  FireDamageIncrease: 'fireDmgBonus',
  PulseDamageIncrease: 'electricDmgBonus',
  CrystDamageIncrease: 'iceDmgBonus',
  NaturalDamageIncrease: 'natureDmgBonus',
  EtherDamageIncrease: 'magicDmgBonus',
  NormalAttackDamageIncrease: 'normalAttackDmgBonus',
  NormalSkillDamageIncrease: 'skillDmgBonus',
  ComboSkillDamageIncrease: 'chainSkillDmgBonus',
  UltimateSkillDamageIncrease: 'ultimateDmgBonus',
  PhysicalVulnerableDmgIncrease: 'physicalVulnerability',
  FireVulnerableDmgIncrease: 'fireVulnerability',
  PulseVulnerableDmgIncrease: 'electricVulnerability',
  CrystVulnerableDmgIncrease: 'iceVulnerability',
  NaturalVulnerableDmgIncrease: 'natureVulnerability',
  EtherVulnerableDmgIncrease: 'magicVulnerability',
  WeaknessDmgScalar: 'weakness',
  ShelterDmgScalar: 'damageReduction',
};

/**
 * AKE's attribute registry has several zones for the same named attribute.
 * They must not all be projected as `atkPercentBoost`: a BaseAddition is a
 * flat value, while BaseFinalMultiplier is a factor.  The timeline detail
 * view consumes this type to choose both its section and its unit.
 */
function runtimeContributionType(attribute: string, zone: string, fallback: string): string {
  if (attribute === 'Atk') {
    if (/^(?:Base)?(?:Final)?Addition$/.test(zone)) return 'flatAtk';
    if (/^(?:Base)?FinalMultiplier$/.test(zone)) return 'atkFinalMultiplier';
    if (/^(?:Base)?Multiplier$/.test(zone)) return 'atkPercentBoost';
  }
  return ATTRIBUTE_BUFF_TYPES[attribute] ?? fallback;
}

function isRuntimeFactorZone(zone: string): boolean {
  return /^(?:Base)?FinalMultiplier$/.test(zone);
}

const DAMAGE_TYPE_BUFF_PREFIX: Record<string, string> = {
  Physical: 'physical',
  Fire: 'fire',
  Pulse: 'electric',
  Cryst: 'ice',
  Natural: 'nature',
  Ether: 'magic',
};

const RUNTIME_SOURCE_LABELS: Record<string, string> = {
  BaseAttribute: '基础属性',
  Skill: '技能数据',
  WeaponPassive: '武器被动',
  Weapon: '武器属性',
  AttributeTalent: '属性天赋',
  Talent: '干员天赋',
  Potential: '干员潜能',
  EquipmentPassive: '装备被动',
  EquipmentSet: '三件套',
  Equipment: '装备属性',
  DerivedAbility: '能力换算',
  CharacterPassive: '干员被动',
};

function readableSourceToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  if (!token || /^(?:buff|chr|wpn|equip)_/i.test(token)) return '';
  const prefix = token.split(':', 1)[0];
  if (/^AKEDatabase:DerivedAbility(?::|$)/i.test(token)) return RUNTIME_SOURCE_LABELS.DerivedAbility;
  if (/^AKEDatabase:AttributeTalent(?::|$)/i.test(token)) return RUNTIME_SOURCE_LABELS.AttributeTalent;
  return RUNTIME_SOURCE_LABELS[prefix] ?? '';
}

function readableContributionName(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const candidate of [
    value.displayName,
    value.name,
    value.label,
    value.sourceLabel,
    value.rawSource,
  ]) {
    if (typeof candidate === 'string'
      && candidate.trim()
      && !/^(?:buff|chr|wpn|equip)_/i.test(candidate.trim())) {
      const sourceLabel = readableSourceToken(candidate);
      if (sourceLabel) return sourceLabel;
      // Internal ids are useful in diagnostics, but should not become the
      // visible buff label when the AKE source registry has no localized name.
      if (/^(?:ake-|abilityentity_|sk_)/i.test(candidate.trim())) continue;
      return candidate.trim();
    }
  }
  return '';
}

function contributionBuffTags(
  hit: AkeRuntimeHit,
  statusEvents: AkeRuntimeStatusEvent[],
  labels: AkeRuntimeStatusLabelMap,
): AppliedBuffTagViewModel[] {
  const activeStatusByInstanceId = activeStatusesAt(statusEvents, hit.frame, false);
  const sameFrameStatusByInstanceId = new Map<string, AkeRuntimeStatusEvent>();
  statusEvents.filter((event) => event.frame === hit.frame).forEach((event) => {
    if (event.instanceId && !isFinishStage(event.stage)) {
      sameFrameStatusByInstanceId.set(event.instanceId, event);
    }
  });
  const factorContributions = (hit.factors ?? []).flatMap((factor) => (
    (factor.contributions ?? []).map((contribution) => ({ contribution, factor }))
  ));
  const legacyFactor = (semanticKey: string, displayName: string) => ({
    semanticKey,
    displayName,
  });
  const contributions = factorContributions.length > 0 ? factorContributions : [
    ...(hit.modifierSnapshot.attackAttribute?.contributions ?? []).map((contribution) => ({
      contribution,
      factor: legacyFactor('attack', '攻击力'),
    })),
    ...(hit.modifierSnapshot.attackerZone?.contributions ?? []).map((contribution) => ({
      contribution,
      factor: legacyFactor('attacker-zone', '攻击方增伤区'),
    })),
    ...(hit.modifierSnapshot.defenderZone?.contributions ?? []).map((contribution) => ({
      contribution,
      factor: legacyFactor('defender-zone', '敌方伤害区'),
    })),
  ];
  const seen = new Set<string>();
  return contributions.flatMap(({ contribution, factor }, index) => {
    const resolvedValue = finite(
      contribution.resolvedValue ?? contribution.value ?? contribution.addition,
      0,
    );
    if (contribution.sourceCategory === 'BaseAttribute'
      || contribution.sourceCategory === 'Skill'
      || (contribution.sourceType === 'ConfiguredAttribute' && resolvedValue === 0)) return [];
    const activeStatus = contribution.buffInstanceId
      ? activeStatusByInstanceId.get(contribution.buffInstanceId) ?? null
      : null;
    const status = activeStatus?.event ?? (contribution.buffInstanceId
      ? sameFrameStatusByInstanceId.get(contribution.buffInstanceId) ?? null
      : null);
    const contributionStackCount = Number(contribution.stackCount);
    const statusStackCount = activeStatus?.stackCount
      ?? status?.after
      ?? status?.stackCount
      ?? (Number.isFinite(contributionStackCount) ? contributionStackCount : undefined)
      ?? undefined;
    const sourceKey = String(contribution.sourceKey ?? `runtime-zone-${index}`);
    const identityStatus = status ?? statusEvents.find((event) => (
      Boolean(contribution.buffId)
      && event.buffId === contribution.buffId
      && event.frame <= hit.frame
      && (contribution.ownerId == null || event.ownerId === contribution.ownerId)
      && (contribution.carrierId == null || event.carrierId === contribution.carrierId)
      && (contribution.targetId == null || event.targetId === contribution.targetId)
    )) ?? null;
    const sourceParts = sourceKey.split(':');
    const attribute = String(contribution.attribute
      || contribution.type
      || contribution.rawField
      || sourceParts[sourceParts.length - 1]
      || '');
    const contributionBuffId = typeof contribution.buffId === 'string'
      ? contribution.buffId
      : identityStatus?.buffId ?? null;
    const statusMetadata = contributionBuffId
      ? runtimeStatusMetadata(contributionBuffId, labels, identityStatus)
      : null;
    const sourceMetadataName = readableContributionName(contribution.sourceMetadata)
      || readableContributionName(contribution.metadata)
      || RUNTIME_SOURCE_LABELS[String(contribution.sourceType ?? '')]
      || RUNTIME_SOURCE_LABELS[String(contribution.sourceCategory ?? '')];
    const zone = String(contribution.zone ?? contribution.semanticKey ?? '');
    const label = statusMetadata?.label
      || sourceMetadataName
      || ATTRIBUTE_LABELS[attribute]
      || factor.displayName
      || '运行时加成';
    const side = contribution.side === 'Defender' ? 'Defender' : 'Attacker';
    const addition = resolvedValue;
    const damageTypePrefix = DAMAGE_TYPE_BUFF_PREFIX[String(hit.damageType)] ?? 'physical';
    const dedupeKey = String(contribution.contributionId
      ?? [factor.semanticKey, sourceKey, attribute, addition].join('|'));
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    const category = String(contribution.sourceCategory ?? contribution.sourceType ?? 'System');
    const sourceName = ({
      EnemyStatus: '敌方状态机', Talent: '干员天赋', Potential: '干员潜能',
      Weapon: '武器', Equipment: '装备', EquipmentSet: '三件套',
      TeamState: '队伍共享状态',
      Skill: '技能', StatusEffect: side === 'Defender' ? '敌方状态机' : '自身状态机',
      Loadout: '角色配置', Attribute: '运行时属性状态机',
    } as Record<string, string>)[category]
      ?? (side === 'Defender' ? '敌方状态机' : '运行时状态机');
    const isVulnerability = factor.semanticKey.endsWith('-vulnerability')
      || factor.semanticKey.endsWith('-vulnerable');
    const semanticType = isVulnerability
      ? `${damageTypePrefix}Vulnerability`
      : side === 'Defender' ? `${damageTypePrefix}Fragile` : 'allDmgBonus';
    const type = statusMetadata?.effectType
      ?? runtimeContributionType(attribute, zone, semanticType);
    const isMultiplier = isRuntimeFactorZone(zone);
    return [{
      id: dedupeKey || `${sourceKey}:${index}`,
      contributionId: contribution.contributionId ?? undefined,
      sourceKey,
      buffId: contribution.buffId ?? identityStatus?.buffId ?? undefined,
      buffInstanceId: contribution.buffInstanceId ?? identityStatus?.instanceId ?? undefined,
      label,
      displayLabel: label,
      sourceName,
      type,
      value: addition,
      effectiveValue: addition,
      multiplierCoefficient: isMultiplier ? addition : undefined,
      isMultiplier,
      stackCount: statusStackCount,
      maxStacks: undefined,
      isCountable: finite(statusStackCount, 1) > 1,
    }];
  });
}

function buildPanelAttackLines(
  panelAttack: number | undefined,
  trace: AkePanelAttackTrace | undefined,
): string[] {
  if (!trace) {
    return Number.isFinite(panelAttack) && Number(panelAttack) > 0
      ? [
        `最终面板攻击力: ${trimNumber(Number(panelAttack))}`,
        '配置计算链: 旧报告未包含攻击区快照，请重新计算时间轴',
      ]
      : ['面板攻击力: 当前报告未包含角色配置快照'];
  }

  const abilityLines = (kind: '主' | '副', ability: AkePanelAttackTrace['mainAbility']) => {
    if (!ability) return [];
    const additiveScale = (1 + ability.statScale) * (1 + ability.allStatScale);
    return [
      `${kind}能力（${ability.label}）原始值: ${trimNumber(ability.rawValue)}`,
      `${kind}能力加算: (1 + ${percent(ability.statScale)}) × (1 + ${percent(ability.allStatScale)}) = ×${trimNumber(additiveScale, 4)}`,
      `${kind}能力结算: ${trimNumber(ability.rawValue)} × ${trimNumber(additiveScale, 4)} = ${trimNumber(ability.valueBeforeRounding)}`,
      `${kind}能力取整: ${trimNumber(ability.valueBeforeRounding)} → ${trimNumber(ability.finalValue)}`,
      `${kind}能力攻击转换: ${trimNumber(ability.finalValue)} × ${trimNumber(ability.attackCoefficient, 3)} = ${trimNumber(ability.attackBonus, 4)}`,
    ];
  };

  return [
    `角色攻击: ${trimNumber(trace.characterAttack)}`,
    `武器攻击: ${trimNumber(trace.weaponAttack)}`,
    `攻击力百分比加成: ${percent(trace.attackPercent)}`,
    `固定攻击项: ${trimNumber(trace.flatAttack)}`,
    `攻击基础值: (${trimNumber(trace.characterAttack)} + ${trimNumber(trace.weaponAttack)}) × (1 + ${percent(trace.attackPercent)}) + ${trimNumber(trace.flatAttack)} = ${trimNumber(trace.baseAttack)}`,
    ...abilityLines('主', trace.mainAbility),
    ...abilityLines('副', trace.subAbility),
    `能力值总攻击加成: ${(trace.mainAbility?.attackBonus !== undefined || trace.subAbility?.attackBonus !== undefined)
      ? `${trimNumber(trace.mainAbility?.attackBonus ?? 0, 4)} + ${trimNumber(trace.subAbility?.attackBonus ?? 0, 4)} = `
      : ''}${trimNumber(trace.abilityBonus, 4)}`,
    `最终面板攻击力: ${trimNumber(trace.baseAttack)} × (1 + ${trimNumber(trace.abilityBonus, 4)}) = ${trimNumber(trace.panelAttack)}`,
  ];
}

function runtimeContributionLabel(contribution: AkeRuntimeModifierContribution): string {
  return readableContributionName(contribution.sourceMetadata)
    || readableContributionName(contribution.metadata)
    || RUNTIME_SOURCE_LABELS[String(contribution.sourceType ?? '')]
    || RUNTIME_SOURCE_LABELS[String(contribution.sourceCategory ?? '')]
    || ATTRIBUTE_LABELS[String(contribution.attribute ?? contribution.rawField ?? '')]
    || '运行时来源';
}

function runtimeContributionValue(contribution: AkeRuntimeModifierContribution): string {
  const value = finite(
    contribution.resolvedValue ?? contribution.value ?? contribution.addition,
    0,
  );
  const zone = String(contribution.zone ?? contribution.semanticKey ?? '');
  const attribute = String(contribution.attribute ?? contribution.rawField ?? '');
  if (contribution.rawField === 'scale'
    || String(contribution.semanticKey ?? '').includes('attack-scale')) {
    return `×${trimNumber(value, 4)}`;
  }
  if (/FinalMultiplier$/.test(zone)) return `×${trimNumber(value, 4)}`;
  if (/Multiplier$/.test(zone) || (attribute !== 'Atk' && Math.abs(value) <= 2)) {
    return `${value >= 0 ? '+' : ''}${percent(value)}`;
  }
  return `${value >= 0 ? '+' : ''}${trimNumber(value, 4)}`;
}

function factorRawText(rawValue: unknown): string {
  if (typeof rawValue === 'number') return trimNumber(rawValue, 4);
  if (Array.isArray(rawValue)) {
    const zones = rawValue.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = String(entry.zoneName ?? entry.name ?? '加成');
      const addition = finite(entry.addition ?? entry.value, 0);
      return [`${name} ${addition >= 0 ? '+' : ''}${percent(addition)}`];
    });
    return zones.length > 0 ? zones.join('，') : '无额外来源';
  }
  if (isRecord(rawValue)) {
    const fields = Object.entries(rawValue).flatMap(([key, value]) => (
      typeof value === 'number' && Number.isFinite(value)
        ? [`${key}=${trimNumber(value, 4)}`]
        : []
    ));
    return fields.length > 0 ? fields.join('，') : '运行时对象';
  }
  return rawValue == null ? '未提供' : String(rawValue);
}

function factorAuditLines(
  label: string,
  selected: AkeRuntimeDamageFactor | undefined,
  fallbackFormula?: string,
  visibleBuffs: AppliedBuffTagViewModel[] = [],
): string[] {
  if (!selected) {
    return [`${label}计算: ${fallbackFormula ?? '运行时未提供'}`];
  }
  const contributions = (selected.contributions ?? []).filter((contribution) => {
    if (contribution.sourceCategory === 'BaseAttribute') return false;
    const value = finite(
      contribution.resolvedValue ?? contribution.value ?? contribution.addition,
      0,
    );
    return contribution.sourceType !== 'ConfiguredAttribute' || Math.abs(value) > 1e-12;
  });
  const visibleLabelByContributionId = new Map(visibleBuffs.flatMap((buff) => (
    buff.contributionId ? [[buff.contributionId, buff.label] as const] : []
  )));
  return [
    `${label}原始值: ${factorRawText(selected.rawValue)}`,
    ...contributions.map((contribution, index) => (
      `${label}来源 ${index + 1} · ${visibleLabelByContributionId.get(String(contribution.contributionId ?? ''))
        ?? runtimeContributionLabel(contribution)}: ${runtimeContributionValue(contribution)}`
    )),
    `${label}最终系数: ×${trimNumber(selected.multiplier, 4)}`,
  ];
}

function nonCriticalFactorChain(factors: AkeRuntimeDamageFactor[]): string {
  const active = factors.filter((item) => item.affectsNonCritical !== false);
  if (active.length === 0) return '';
  return active.map((item) => (
    item.semanticKey === 'attack'
      ? '攻击力'
      : `${item.displayName} ×${trimNumber(item.multiplier, 4)}`
  )).join(' × ');
}

function buildRuntimeFormula(
  hit: AkeRuntimeHit,
  title: string,
  statusEvents: AkeRuntimeStatusEvent[],
  labels: AkeRuntimeStatusLabelMap,
  panelAttack?: number,
  panelAttackTrace?: AkePanelAttackTrace,
): FormulaViewModel {
  const operands = hit.operands ?? {};
  const factors = hit.factors ?? [];
  const factor = (semanticKey: string) => factors.find((item) => item.semanticKey === semanticKey);
  const atkScale = finite(factor('attack-scale')?.multiplier, finite(operands.atkScale, hit.atkScale));
  const defense = finite(operands.defense);
  const defEfficiency = finite(operands.defEfficiency, 0.01);
  const defScale = finite(factor('defense')?.multiplier, finite(operands.defScale, 1));
  const resistance = finite(operands.resistance);
  const resistanceScale = finite(factor('resistance')?.multiplier, finite(operands.resistanceScale, 1));
  const attackerScale = finite(factor('attacker-zone')?.multiplier, finite(operands.attackerZoneScale, 1));
  const defenderScale = finite(factor('defender-zone')?.multiplier, finite(operands.defenderZoneScale, 1));
  const configuredScale = finite(factor('configured-damage-bonus')?.multiplier, finite(operands.configuredDamageBonusScale, 1));
  const vulnerableFactor = factors.find((item) =>
    item.semanticKey.endsWith('-vulnerability') || item.semanticKey.endsWith('-vulnerable'));
  const damageTakenFactor = factor('damage-taken');
  const defenderFactor = factor('defender-zone');
  const criticalFactor = factor('critical');
  const expectedCriticalScale = finite(operands.expectedCriticalScale, 1);
  const allCriticalScale = finite(operands.allCriticalScale, 1);
  const criticalRate = finite(operands.criticalRate);
  const criticalDamageIncrease = finite(operands.criticalDamageIncrease);
  const attackerCombinedScale = attackerScale * configuredScale;
  const buffTags = contributionBuffTags(hit, statusEvents, labels);
  const attackLines = buildPanelAttackLines(panelAttack, panelAttackTrace);
  const unavailable = '运行时未提供';
  const rateFormula = (selected: typeof factors[number] | undefined) => selected
    ? `${factorRawText(selected.rawValue)} → ×${trimNumber(selected.multiplier, 4)} = ${trimNumber(selected.multiplier, 4)}`
    : unavailable;
  const fragileFormula = factor('defender-zone')
    ? `1 + ${percent(defenderScale - 1)} = ${trimNumber(defenderScale, 4)}`
    : operands.defenderZoneScale !== undefined
      ? `1 + ${percent(defenderScale - 1)} = ${trimNumber(defenderScale)}`
      : unavailable;
  const fullFactorChain = nonCriticalFactorChain(factors);
  const nonCritFormula = fullFactorChain
    ? `${fullFactorChain} = ${fixedDamage(hit.nonCriticalDamage)}`
    : `攻击力 × ${trimNumber(atkScale, 4)} × ${trimNumber(attackerCombinedScale, 4)} × ${trimNumber(defScale, 4)} × ${trimNumber(resistanceScale, 4)} × ${trimNumber(defenderScale, 4)} = ${fixedDamage(hit.nonCriticalDamage)}`;
  const factorValidation = hit.factorValidation;
  const validationText = factorValidation
    ? `${factorValidation.valid ? 'PASS' : 'FAIL'} · 重建 ${fixedDamage(factorValidation.reconstructedNonCritical)} · 目标 ${fixedDamage(factorValidation.expectedNonCritical)} · 差值 ${trimNumber(factorValidation.delta, 8)}`
    : '旧报告未提供乘区重建校验';
  const configuredFactor = factor('configured-damage-bonus');
  const attackerFactor = factor('attacker-zone');
  const comboFactor = factor('combo-damage');
  const imbalanceFactor = factor('imbalance-damage');
  const neutralComboFormula = '1 + 0.0% = 1';
  const neutralImbalanceFormula = '1 + 0.0% = 1';
  return {
    title: `${title} 运行时计算过程`,
    panelLines: [
      `ATK: ${Number.isFinite(panelAttack) && Number(panelAttack) > 0 ? trimNumber(Number(panelAttack)) : '—'}`,
      `暴击率: ${percent(criticalRate)}`,
      `暴击伤害: ${percent(criticalDamageIncrease)}`,
      `运行帧: F${hit.frame}`,
    ],
    attackLines,
    sectionLines: {
      attack: [
        ...attackLines,
        `当前 Hit 攻击区来源: ${buffTags.filter((buff) => ['flatAtk', 'atkPercentBoost', 'atkFinalMultiplier', 'mainStatBoost', 'subStatBoost', 'allStatBoost'].includes(buff.type ?? '')).length} 项（逐项见下方 Buff）`,
      ],
      multiplier: factorAuditLines('技能倍率', factor('attack-scale'), `${percent(atkScale)} = ×${trimNumber(atkScale, 4)}`, buffTags),
      crit: [
        `暴击率: ${percent(criticalRate)}`,
        `暴击伤害加成: ${percent(criticalDamageIncrease)}`,
        `暴击倍率: 1 + ${percent(criticalDamageIncrease)} = ${trimNumber(allCriticalScale, 4)}`,
        `期望暴击系数: 1 + ${percent(criticalRate)} × ${percent(criticalDamageIncrease)} = ${trimNumber(expectedCriticalScale, 4)}`,
        ...(criticalFactor?.contributions ?? [])
          .filter((contribution) => contribution.sourceCategory !== 'BaseAttribute')
          .map((contribution, index) => (
            `暴击来源 ${index + 1} · ${runtimeContributionLabel(contribution)}: ${runtimeContributionValue(contribution)}`
          )),
        `非暴击伤害: ${fixedDamage(hit.nonCriticalDamage)}`,
        `暴击伤害: ${fixedDamage(hit.criticalDamage)}（×${trimNumber(allCriticalScale, 4)}）`,
        `期望伤害: ${fixedDamage(hit.expectedDamage)}（×${trimNumber(expectedCriticalScale, 4)}）`,
      ],
      damageBonus: [
        ...factorAuditLines('攻击方增伤区', attackerFactor, `×${trimNumber(attackerScale, 4)}`, buffTags),
        ...factorAuditLines('配置增伤区', configuredFactor, `×${trimNumber(configuredScale, 4)}`, buffTags),
        `加成区合并: ${trimNumber(attackerScale, 4)} × ${trimNumber(configuredScale, 4)} = ${trimNumber(attackerCombinedScale, 4)}`,
      ],
      defense: [
        `敌方防御: ${trimNumber(defense)}`,
        `防御效率: ${trimNumber(defEfficiency, 4)}`,
        ...factorAuditLines('防御区', factor('defense'), `1 / (1 + ${trimNumber(defense)} × ${trimNumber(defEfficiency, 4)}) = ×${trimNumber(defScale, 4)}`, buffTags),
      ],
      resistance: [
        `有效抗性: ${trimNumber(resistance, 4)}%`,
        ...factorAuditLines('抗性区', factor('resistance'), `1 - ${trimNumber(resistance, 4)}% = ×${trimNumber(resistanceScale, 4)}`, buffTags),
      ],
      amplify: factorAuditLines('增幅区', damageTakenFactor, rateFormula(damageTakenFactor), buffTags),
      fragile: factorAuditLines('易伤区', defenderFactor, fragileFormula, buffTags),
      vulnerability: factorAuditLines('脆弱区', vulnerableFactor, rateFormula(vulnerableFactor), buffTags),
      combo: comboFactor
        ? factorAuditLines('连击区', comboFactor, rateFormula(comboFactor), buffTags)
        : ['连击伤害加成: 当前 Hit 无额外来源（按 0%）', `连击区计算: ${neutralComboFormula}`],
      imbalance: imbalanceFactor
        ? factorAuditLines('失衡区', imbalanceFactor, rateFormula(imbalanceFactor), buffTags)
        : ['失衡伤害加成: 当前 Hit 无额外来源（按 0%）', `失衡区计算: ${neutralImbalanceFormula}`],
      result: [
        `非暴击乘区顺序: ${fullFactorChain || '运行时未提供结构化因子'}`,
        `非暴击全链路: ${nonCritFormula}`,
        `乘区重建校验: ${validationText}`,
        `非暴击伤害: ${fixedDamage(hit.nonCriticalDamage)}`,
        `暴击伤害: ${fixedDamage(hit.criticalDamage)}`,
        `期望伤害: ${fixedDamage(hit.expectedDamage)}`,
      ],
    },
    buffTags,
    showNoBuff: buffTags.length === 0,
    baseMultiplierText: percent(atkScale, 2),
    multiplierFormulaText: `${percent(atkScale, 2)} = ${trimNumber(atkScale, 4)}`,
    formulaText: `${percent(atkScale, 2)} = ${trimNumber(atkScale, 4)}`,
    elementBonusText: factor('configured-damage-bonus')
      ? percent(finite(factor('configured-damage-bonus')?.rawValue), 1)
      : unavailable,
    skillBonusText: factor('attacker-zone')
      ? percent(attackerScale - 1, 1)
      : unavailable,
    allDamageBonusText: percent(attackerCombinedScale - 1),
    damageBonusRateText: trimNumber(attackerCombinedScale),
    damageBonusFormulaText: `${trimNumber(attackerScale)} × ${trimNumber(configuredScale)} = ${trimNumber(attackerCombinedScale)}`,
    resistanceEffectiveText: trimNumber(resistance, 1),
    resistanceFormulaText: `1 - ${trimNumber(resistance, 1)}% = ${trimNumber(resistanceScale)}`,
    amplifyFormulaText: rateFormula(factor('damage-taken')),
    fragileFormulaText: fragileFormula,
    vulnerabilityFormulaText: rateFormula(vulnerableFactor),
    comboFormulaText: comboFactor ? rateFormula(comboFactor) : neutralComboFormula,
    imbalanceFormulaText: imbalanceFactor ? rateFormula(imbalanceFactor) : neutralImbalanceFormula,
    defenseZoneText: `1 / (1 + ${trimNumber(defense)} × ${trimNumber(defEfficiency, 3)}) = ${trimNumber(defScale)}`,
    nonCritFormulaText: nonCritFormula,
    expectedText: `${fixedDamage(hit.expectedDamage)} (×${trimNumber(expectedCriticalScale, 4)})`,
    critText: `${fixedDamage(hit.criticalDamage)} (×${trimNumber(allCriticalScale, 4)})`,
    nonCritText: fixedDamage(hit.nonCriticalDamage),
  };
}

function transitionBelongsToHit(
  event: AkeRuntimeStatusEvent,
  hit: AkeRuntimeHit,
  _runtimeHits: AkeRuntimeHit[],
  castId: string,
): boolean {
  if (event.frame !== hit.frame || !transitionBelongsToCast(event, castId)) return false;
  return Boolean(hit.hitId) && event.parentHitId === hit.hitId;
}

function buildHitStatusViews(input: {
  hit: AkeRuntimeHit;
  runtimeHits: AkeRuntimeHit[];
  formula: FormulaViewModel;
  statusEvents: AkeRuntimeStatusEvent[];
  command: AkeCommandSettlement;
  enemyId: string;
  tickRate: number;
  labels: AkeRuntimeStatusLabelMap;
  castId: string;
  report: AkeTeamReport;
}): AkeRuntimeStatusView[] {
  const {
    hit,
    runtimeHits,
    formula,
    statusEvents,
    command,
    enemyId,
    tickRate,
    labels,
    castId,
    report,
  } = input;
  const statusesByKey = new Map<string, AkeRuntimeStatusView>();
  const appliedBuffsByIdentity = new Map<string, AppliedBuffTagViewModel>();
  formula.buffTags.forEach((buff) => {
    const identity = buff.buffInstanceId
      ? `instance:${buff.buffInstanceId}`
      : buff.sourceKey
        ? `source:${buff.sourceKey}`
        : buff.buffId ? `buff:${buff.buffId}` : `contribution:${buff.id}`;
    appliedBuffsByIdentity.set(identity, buff);
  });
  const matchedAppliedBuffIds = new Set<string>();
  const consumedBuffIds = new Set((hit.consumedStatuses ?? []).map((snapshot) => snapshot.buffId));

  (hit.consumedStatuses ?? []).forEach((snapshot) => {
    const view = consumedStatusView(snapshot, report, labels, 'ake-runtime-hit-consumed');
    statusesByKey.set(`consumed:${snapshot.key}`, view);
  });

  const activeBeforeHit = activeStatusesBeforeHit(statusEvents, hit);
  const activeComboStacks = teamComboStacksInState(activeBeforeHit, hit.sourceId);
  if (!consumedBuffIds.has(TEAM_COMBO_BUFF_ID) && activeComboStacks > 0) {
    statusesByKey.set('pooled:team-combo', pooledTeamComboView({
      stacks: activeComboStacks,
      command,
      tickRate,
      labels,
      keyPrefix: 'ake-runtime-hit-team-combo',
      moment: '当前 Hit 前队伍状态',
    }));
  }

  activeBeforeHit.forEach((active) => {
    if (active.event.targetId !== enemyId && active.event.targetId !== hit.sourceId) return;
    if (active.event.buffId === TEAM_COMBO_BUFF_ID) return;
    const metadata = runtimeStatusMetadata(active.event.buffId, labels, active.event);
    if (metadata.hidden) return;
    const matchedBuff = (active.event.instanceId
      ? appliedBuffsByIdentity.get(`instance:${active.event.instanceId}`)
      : undefined)
      ?? appliedBuffsByIdentity.get(`buff:${active.event.buffId}`);
    if (isPassiveRegistration(active.event) && !matchedBuff) return;
    const view = snapshotStatusView(
      'ake-runtime-hit-before', active, command, enemyId, tickRate, labels, '命中前',
    );
    if (!view) return;
    if (matchedBuff) {
      matchedAppliedBuffIds.add(matchedBuff.id);
      const source = sourceGroupLabel(matchedBuff.sourceName);
      const isCritical = isCriticalRuntimeStatus(active.event.buffId, metadata);
      view.kind = '当前 Hit 生效';
      view.groupLabel = isCritical ? '关键战斗状态' : `当前 Hit · ${source}`;
      view.groupOrder = isCritical ? 0 : sourceGroupOrder(matchedBuff.sourceName);
      view.detail = [view.detail, matchedBuff.sourceName, '实际进入本 Hit 计算'].filter(Boolean).join(' · ');
    }
    statusesByKey.set(statusInstanceKey(active.event), view);
  });

  formula.buffTags.forEach((buff, index) => {
    if (matchedAppliedBuffIds.has(buff.id)) return;
    if (buff.buffId === TEAM_COMBO_BUFF_ID) return;
    const syntheticMetadata: RuntimeStatusMetadata = {
      label: buff.label,
      shortLabel: buff.label.slice(0, 1),
    };
    const priority = runtimeStatusPriority(buff.id, syntheticMetadata);
    const isCritical = priority < 100;
    const source = sourceGroupLabel(buff.sourceName);
    statusesByKey.set(`applied:${buff.id}:${index}`, {
      key: `ake-runtime-hit-applied:${hit.hitIndex}:${buff.id}:${index}`,
      buffId: buff.id,
      title: `${buff.label}${finite(buff.stackCount, 1) > 1 ? ` ×${finite(buff.stackCount, 1)}` : ''}`,
      detail: [buff.sourceName, buff.type, '实际进入本 Hit 计算'].filter(Boolean).join(' · '),
      kind: '当前 Hit 生效',
      groupLabel: isCritical ? '关键战斗状态' : `当前 Hit · ${source}`,
      groupOrder: isCritical ? 0 : sourceGroupOrder(buff.sourceName),
      priority,
    });
  });

  statusEvents
    .filter((event) => transitionBelongsToHit(event, hit, runtimeHits, castId))
    .forEach((event) => {
      const metadata = runtimeStatusMetadata(event.buffId, labels, event);
      if (metadata.hidden) return;
      const after = finite(event.after ?? event.stackCount, 0);
      const priority = runtimeStatusPriority(event.buffId, metadata);
      const isCritical = isCriticalRuntimeStatus(event.buffId, metadata);
      const instanceKey = statusInstanceKey(event);
      const previous = statusesByKey.get(instanceKey);
      statusesByKey.set(instanceKey, {
        key: `ake-runtime-hit-transition:${hit.hitIndex}:${event.traceIndex}`,
        buffId: event.buffId,
        title: `${metadata.label}${after > 1 ? ` ×${after}` : ''}`,
        detail: [previous?.detail, eventDetail(event, command, enemyId, tickRate)]
          .filter(Boolean)
          .join(' · '),
        kind: `本 Hit ${stageLabel(event)}`,
        groupLabel: isCritical ? '关键战斗状态' : '本 Hit 状态变化',
        groupOrder: isCritical ? 0 : 65,
        priority,
        iconUrl: metadata.iconUrl ?? previous?.iconUrl,
        iconAlt: metadata.label,
      });
    });

  return sortRuntimeStatusViews([...statusesByKey.values()]);
}

function hitTitle(
  hit: AkeRuntimeHit,
  index: number,
  labels: AkeRuntimeStatusLabelMap,
  statusEvents: AkeRuntimeStatusEvent[],
): string {
  if (hit.displayName?.trim()) return hit.displayName.trim();
  if (hit.sourceBuffId) {
    const statusEvent = hit.sourceBuffInstanceId
      ? statusEvents.find((event) => event.instanceId === hit.sourceBuffInstanceId)
      : undefined;
    const metadata = runtimeStatusMetadata(hit.sourceBuffId, labels, statusEvent);
    return metadata.extraHitLabel ?? `${metadata.label}·额外伤害`;
  }
  if (hit.semanticHitType && hit.semanticHitType !== 'skill') {
    return `${hit.semanticHitType}·额外伤害`;
  }
  return `技能命中 ${index + 1}`;
}

function hitMeta(hit: AkeRuntimeHit, tickRate: number): string {
  const element = DAMAGE_TYPE_LABELS[String(hit.damageType)] ?? String(hit.damageType ?? '未知属性');
  const inputType = hit.inputCommandType ?? null;
  const effectiveType = hit.effectiveSkillType ?? null;
  const executionIdentity = inputType && effectiveType && inputType !== effectiveType
    ? `${COMMAND_TYPE_LABELS[inputType] ?? inputType}输入 → ${COMMAND_TYPE_LABELS[effectiveType] ?? effectiveType}结算`
    : null;
  return [
    `F${hit.frame} / ${(hit.frame / tickRate).toFixed(2)}秒`,
    element,
    `倍率 ${percent(hit.atkScale, 2)}`,
    executionIdentity,
    hit.sourceBuffId ? '状态机触发' : '技能本体',
  ].filter(Boolean).join(' · ');
}

export function buildAkeRuntimeCommandLedger(input: {
  report: AkeTeamReport | null | undefined;
  commandId: string;
  labels?: AkeRuntimeStatusLabelMap;
  skillName?: string;
}): AkeRuntimeCommandLedger | null {
  const report = input.report;
  if (!report) return null;
  const command = report.timeline.commands.find((candidate) => candidate.commandId === input.commandId);
  const castId = command?.castId ?? null;
  if (!command || !castId || !command.success) return null;
  const labels = input.labels ?? new Map<string, string>();
  const statusEvents = [...(report.statusEvents ?? [])].sort(statusEventOrder);
  const runtimeHits = (report.hits ?? [])
    .filter((hit) => (
      hit.castId === castId || hit.rootCastId === castId
    ) && hit.damageAttributeType === 'Hp')
    .sort((left, right) => left.frame - right.frame || left.hitIndex - right.hitIndex);
  const consumedStatuses = uniqueConsumedStatuses(runtimeHits);
  const consumedBuffIds = new Set(consumedStatuses.map((snapshot) => snapshot.buffId));
  const reportCharacter = report.characters.find((character) => (
    character.akeCharacterId === command.characterId
    || character.memberId === command.memberId
    || character.localCharacterId === command.characterId
  ));
  const panelAttack = reportCharacter?.loadout.panelAtk;
  const panelAttackTrace = reportCharacter?.loadout.panelAttackTrace;
  const hits = runtimeHits.map((hit, index) => {
    const title = hitTitle(hit, index, labels, statusEvents);
    const formula = buildRuntimeFormula(
      hit,
      title,
      statusEvents,
      labels,
      panelAttack,
      panelAttackTrace,
    );
    return {
      key: `ake-runtime-hit:${castId}:${hit.hitIndex}`,
      title,
      meta: hitMeta(hit, report.tickRate),
      expected: fixedDamage(hit.expectedDamage),
      crit: fixedDamage(hit.criticalDamage),
      nonCrit: fixedDamage(hit.nonCriticalDamage),
      formula,
      statuses: buildHitStatusViews({
        hit,
        runtimeHits,
        formula,
        statusEvents,
        command,
        enemyId: report.enemyId,
        tickRate: report.tickRate,
        labels,
        castId,
        report,
      }),
      hit,
    };
  });

  const actionStartFrame = command.actualFrame ?? command.requestedFrame;
  const actionEndFrame = Math.max(
    command.endFrame ?? actionStartFrame,
    ...runtimeHits.map((hit) => hit.frame),
  );
  const beforeState = activeStatusesAt(statusEvents, actionStartFrame, false);
  const afterState = activeStatusesAt(statusEvents, actionEndFrame, true);
  const transitions = statusEvents.filter((event) => transitionBelongsToCast(event, castId));
  const beforeComboStacks = teamComboStacksInState(beforeState, command.characterId);
  const afterComboStacks = teamComboStacksInState(afterState, command.characterId);
  const statuses: AkeRuntimeStatusView[] = [];

  beforeState.forEach((active) => {
    if (active.event.targetId !== report.enemyId
      && active.event.targetId !== command.characterId) return;
    if (active.event.buffId === TEAM_COMBO_BUFF_ID) return;
    if (isPassiveRegistration(active.event)) return;
    const view = snapshotStatusView(
      'ake-runtime-before', active, command, report.enemyId, report.tickRate, labels, '命中前',
    );
    if (view) statuses.push(view);
  });
  const transitionGroups = new Map<string, AkeRuntimeStatusEvent[]>();
  transitions.forEach((event) => {
    const instanceKey = statusInstanceKey(event);
    const group = transitionGroups.get(instanceKey) ?? [];
    group.push(event);
    transitionGroups.set(instanceKey, group);
  });
  transitionGroups.forEach((events) => {
    const firstEvent = events[0];
    const event = events[events.length - 1];
    if (event.buffId === TEAM_COMBO_BUFF_ID || consumedBuffIds.has(event.buffId)) return;
    const metadata = runtimeStatusMetadata(event.buffId, labels, event);
    if (metadata.hidden) return;
    const after = finite(event.after ?? event.stackCount, 0);
    const priority = runtimeStatusPriority(event.buffId, metadata);
    const isCritical = isCriticalRuntimeStatus(event.buffId, metadata);
    const scope = scopeLabel(event.targetId, command, report.enemyId);
    const changes = [...new Set(events.map(stageLabel))].join(' / ');
    const before = finite(firstEvent.before, 0);
    statuses.push({
      key: `ake-runtime-transition:${event.traceIndex}`,
      buffId: event.buffId,
      title: `${metadata.label}${after > 1 ? ` ×${after}` : ''}`,
      detail: [
        events.length > 1 ? `${events.length} 次变化` : '',
        `${before} → ${after}层`,
        eventDetail(event, command, report.enemyId, report.tickRate),
      ].filter(Boolean).join(' · '),
      kind: `${scope}·${changes}`,
      groupLabel: isCritical ? '关键战斗状态' : '本次技能状态变化',
      groupOrder: isCritical ? 0 : 65,
      priority,
      iconUrl: metadata.iconUrl,
      iconAlt: metadata.label,
    });
  });
  const transitionedInstances = new Set(transitions.map(statusInstanceKey));
  afterState.forEach((active) => {
    if (active.event.targetId !== report.enemyId
      && active.event.targetId !== command.characterId) return;
    if (active.event.buffId === TEAM_COMBO_BUFF_ID) return;
    if (isPassiveRegistration(active.event)) return;
    if (transitionedInstances.has(statusInstanceKey(active.event))) return;
    const view = snapshotStatusView(
      'ake-runtime-after', active, command, report.enemyId, report.tickRate, labels, '命中后',
    );
    if (view) statuses.push(view);
  });
  consumedStatuses.forEach((snapshot) => {
    statuses.push(consumedStatusView(snapshot, report, labels, 'ake-runtime-command-consumed'));
  });
  if (!consumedBuffIds.has(TEAM_COMBO_BUFF_ID) && (beforeComboStacks > 0 || afterComboStacks > 0)) {
    statuses.push(pooledTeamComboView({
      stacks: afterComboStacks || beforeComboStacks,
      beforeStacks: beforeComboStacks,
      command,
      tickRate: report.tickRate,
      labels,
      keyPrefix: 'ake-runtime-command-team-combo',
      moment: afterComboStacks > beforeComboStacks
        ? '本次技能叠层'
        : '队伍共享状态',
    }));
  }

  const compactStatusByInstance = new Map<string, AkeRuntimeCompactStatus>();
  transitions.forEach((event) => {
    if (event.buffId === TEAM_COMBO_BUFF_ID || consumedBuffIds.has(event.buffId)) return;
    const metadata = runtimeStatusMetadata(event.buffId, labels, event);
    if (metadata.hidden) return;
    const after = finite(event.after ?? event.stackCount, 0);
    compactStatusByInstance.set(statusInstanceKey(event), {
      key: `ake-runtime-transition:${event.traceIndex}`,
      buffId: event.buffId,
      label: after > 0 ? `${metadata.shortLabel}${after}` : `${metadata.shortLabel}消`,
      title: `${metadata.label} · ${eventDetail(event, command, report.enemyId, report.tickRate)}`,
      tone: after > 0 ? 'changed' : 'consumed',
      iconUrl: metadata.iconUrl,
      displayName: metadata.label,
      stackCount: after,
      mainDisplay: isPrimaryRuntimeStatus(event.buffId, metadata),
      priority: runtimeStatusPriority(event.buffId, metadata),
      applicationScope: metadata.applicationScope,
    });
  });
  afterState.forEach((active) => {
    const metadata = runtimeStatusMetadata(active.event.buffId, labels, active.event);
    if (active.event.buffId === TEAM_COMBO_BUFF_ID) return;
    if (metadata.hidden || active.event.targetId !== report.enemyId) return;
    const instanceKey = statusInstanceKey(active.event);
    if (compactStatusByInstance.has(instanceKey)) return;
    compactStatusByInstance.set(instanceKey, {
      key: `ake-runtime-snapshot:${statusInstanceKey(active.event)}`,
      buffId: active.event.buffId,
      label: `${metadata.shortLabel}${active.stackCount}`,
      title: `继承状态 · ${metadata.label} · 命中后 ${active.stackCount}层`,
      tone: 'active',
      iconUrl: metadata.iconUrl,
      displayName: metadata.label,
      stackCount: active.stackCount,
      mainDisplay: isPrimaryRuntimeStatus(active.event.buffId, metadata),
      priority: runtimeStatusPriority(active.event.buffId, metadata),
      applicationScope: metadata.applicationScope,
    });
  });
  consumedStatuses.forEach((snapshot) => {
    const metadata = runtimeStatusMetadata(snapshot.buffId, labels);
    const stacks = Math.max(0, finite(snapshot.consumedStacks, 0));
    const view = consumedStatusView(snapshot, report, labels, 'ake-runtime-compact-consumed');
    compactStatusByInstance.set(`consumed:${snapshot.key}`, {
      key: view.key,
      buffId: snapshot.buffId,
      label: `${metadata.shortLabel}${stacks}`,
      title: `${view.title} · ${view.detail}`,
      tone: 'consumed',
      iconUrl: metadata.iconUrl,
      displayName: metadata.label,
      stackCount: stacks,
      mainDisplay: true,
      priority: runtimeStatusPriority(snapshot.buffId, metadata),
      applicationScope: snapshot.applicationScope,
    });
  });
  if (!consumedBuffIds.has(TEAM_COMBO_BUFF_ID) && afterComboStacks > 0) {
    const metadata = runtimeStatusMetadata(TEAM_COMBO_BUFF_ID, labels);
    compactStatusByInstance.set('pooled:team-combo', {
      key: `ake-runtime-compact-team-combo:${castId}`,
      buffId: TEAM_COMBO_BUFF_ID,
      label: `${metadata.shortLabel}${afterComboStacks}`,
      title: `${afterComboStacks > beforeComboStacks ? '本次变化' : '继承状态'} · ${metadata.label} ×${afterComboStacks} · 队伍共享`,
      tone: afterComboStacks > beforeComboStacks ? 'changed' : 'active',
      iconUrl: metadata.iconUrl,
      displayName: metadata.label,
      stackCount: afterComboStacks,
      mainDisplay: true,
      priority: runtimeStatusPriority(TEAM_COMBO_BUFF_ID, metadata),
      applicationScope: 'team',
    });
  }
  const compactStatuses = [...compactStatusByInstance.values()].sort((left, right) => (
    left.priority - right.priority
    || left.displayName.localeCompare(right.displayName, 'zh-CN')
    || left.key.localeCompare(right.key)
  ));

  const summary = hits.length === 0 ? null : {
    title: `${input.skillName || COMMAND_TYPE_LABELS[command.commandType] || '技能'} · 运行时 ${hits.length} 个独立 Hit`,
    expected: fixedDamage(runtimeHits.reduce((sum, hit) => sum + hit.expectedDamage, 0)),
    crit: fixedDamage(runtimeHits.reduce((sum, hit) => sum + hit.criticalDamage, 0)),
    nonCrit: fixedDamage(runtimeHits.reduce((sum, hit) => sum + hit.nonCriticalDamage, 0)),
    formula: `${hits.map((hit) => `${hit.title} ${hit.nonCrit}`).join(' + ')} = ${fixedDamage(runtimeHits.reduce((sum, hit) => sum + hit.nonCriticalDamage, 0))}`,
    parts: hits.map((hit) => ({ label: hit.title, value: hit.nonCrit })),
  };

  return { command, hits, statuses: sortRuntimeStatusViews(statuses), compactStatuses, summary };
}

export function buildAkeRuntimeCommandViewState(input: {
  runtimeMode: boolean;
  report: AkeTeamReport | null | undefined;
  commandId: string;
  labels?: AkeRuntimeStatusLabelMap;
  skillName?: string;
}): RuntimeCommandViewState {
  if (!input.runtimeMode) {
    return { kind: 'manual-preview', message: '手动演示模式', ledger: null };
  }
  if (!input.report) {
    return { kind: 'pending', message: '等待当前排轴的运行时结算', ledger: null };
  }
  const command = input.report.timeline.commands.find((candidate) => (
    candidate.commandId === input.commandId
  ));
  if (!command) {
    return { kind: 'stale', message: '当前按钮不属于这份运行时账本', ledger: null };
  }
  if (!command.success) {
    return {
      kind: 'rejected',
      message: `运行时拒绝释放${command.reason ? `：${command.reason}` : ''}`,
      ledger: null,
      command,
    };
  }
  const ledger = buildAkeRuntimeCommandLedger(input);
  if (!ledger) {
    return {
      kind: 'partial',
      message: '技能已执行，但运行时命中账本不完整',
      ledger: {
        command,
        hits: [],
        statuses: [],
        compactStatuses: [],
        summary: null,
      },
      command,
    };
  }
  const affectedHits = (input.report.hits ?? []).filter((hit) => (
    (hit.castId === command.castId || hit.rootCastId === command.castId)
    && ((hit.diagnostics?.length ?? 0) > 0
      || hit.confidence === 'partial'
      || hit.factorValidation?.valid === false)
  ));
  const affectedDiagnostics = (input.report.diagnostics?.runtimeDiagnostics ?? []).filter(
    (diagnostic) => Boolean(command.castId) && diagnostic.castId === command.castId,
  );
  const affectedStatusDiagnostics = (input.report.statusEvents ?? []).filter((event) => (
    event.stage === 'StatusEffectUnresolved'
    && Boolean(command.castId)
    && (event.castId === command.castId
      || event.rootCastId === command.castId
      || event.triggerCastId === command.castId
      || event.triggerRootCastId === command.castId)
  ));
  const partialCount = affectedHits.length
    + affectedDiagnostics.length
    + affectedStatusDiagnostics.length;
  return partialCount > 0
    ? {
        kind: 'partial',
        message: `${partialCount} 项运行时结果未完全解析`,
        ledger,
        command,
      }
    : { kind: 'settled', message: '运行时结算完成', ledger, command };
}
