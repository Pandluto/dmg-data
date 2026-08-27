import type { FormulaViewModel, AppliedBuffTagViewModel } from '../calculators/skillDamage.types';
import type {
  AkeCommandSettlement,
  AkeRuntimeHit,
  AkeRuntimeStatusEvent,
  AkeTeamReport,
} from '../../integrations/ake/akeProvider';

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
    iconUrl: event?.iconUrl || undefined,
    iconId: event?.iconId || undefined,
    effectType: event?.effectType || undefined,
    applicationScope: event?.applicationScope || undefined,
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
  if (event.triggerCastId === castId) return true;
  return event.castId === castId
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
};

const DAMAGE_TYPE_BUFF_PREFIX: Record<string, string> = {
  Physical: 'physical',
  Fire: 'fire',
  Pulse: 'electric',
  Cryst: 'ice',
  Natural: 'nature',
  Ether: 'magic',
};

function readableContributionName(value: unknown): string {
  if (!isRecord(value)) return '';
  for (const candidate of [value.displayName, value.name, value.label]) {
    if (typeof candidate === 'string'
      && candidate.trim()
      && !/^(?:buff|chr|wpn|equip)_/i.test(candidate.trim())) {
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
    const statusStackCount = activeStatus?.stackCount
      ?? status?.after
      ?? status?.stackCount
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
    const statusMetadata = identityStatus
      ? runtimeStatusMetadata(identityStatus.buffId, labels, identityStatus)
      : null;
    const sourceMetadataName = readableContributionName(contribution.sourceMetadata)
      || readableContributionName(contribution.metadata);
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
      Skill: '技能', StatusEffect: side === 'Defender' ? '敌方状态机' : '自身状态机',
      Loadout: '角色配置', Attribute: '运行时属性状态机',
    } as Record<string, string>)[category]
      ?? (side === 'Defender' ? '敌方状态机' : '运行时状态机');
    const semanticType = factor.semanticKey.endsWith('-vulnerable')
      ? `${damageTypePrefix}Fragile`
      : side === 'Defender' ? `${damageTypePrefix}Fragile` : 'allDmgBonus';
    return [{
      id: dedupeKey || `${sourceKey}:${index}`,
      contributionId: contribution.contributionId ?? undefined,
      sourceKey,
      buffId: contribution.buffId ?? identityStatus?.buffId ?? undefined,
      buffInstanceId: contribution.buffInstanceId ?? identityStatus?.instanceId ?? undefined,
      label,
      displayLabel: label,
      sourceName,
      type: statusMetadata?.effectType
        ?? ATTRIBUTE_BUFF_TYPES[attribute]
        ?? semanticType,
      value: addition,
      effectiveValue: addition,
      stackCount: statusStackCount,
      maxStacks: undefined,
      isCountable: finite(statusStackCount, 1) > 1,
    }];
  });
}

function buildRuntimeFormula(
  hit: AkeRuntimeHit,
  title: string,
  statusEvents: AkeRuntimeStatusEvent[],
  labels: AkeRuntimeStatusLabelMap,
): FormulaViewModel {
  const operands = hit.operands ?? {};
  const factors = hit.factors ?? [];
  const factor = (semanticKey: string) => factors.find((item) => item.semanticKey === semanticKey);
  const attack = finite(factor('attack')?.multiplier, finite(operands.attack));
  const atkScale = finite(factor('attack-scale')?.multiplier, finite(operands.atkScale, hit.atkScale));
  const defense = finite(operands.defense);
  const defEfficiency = finite(operands.defEfficiency, 0.01);
  const defScale = finite(factor('defense')?.multiplier, finite(operands.defScale, 1));
  const resistance = finite(operands.resistance);
  const resistanceScale = finite(factor('resistance')?.multiplier, finite(operands.resistanceScale, 1));
  const damageTakenScale = finite(factor('damage-taken')?.multiplier, finite(operands.damageTakenScalar, 1));
  const weaknessScale = finite(factor('weakness')?.multiplier, finite(operands.weaknessDmgScalar, 1));
  const shelterScale = finite(factor('shelter')?.multiplier, finite(operands.shelterScale, 1));
  const attackerScale = finite(factor('attacker-zone')?.multiplier, finite(operands.attackerZoneScale, 1));
  const defenderScale = finite(factor('defender-zone')?.multiplier, finite(operands.defenderZoneScale, 1));
  const configuredScale = finite(factor('configured-damage-bonus')?.multiplier, finite(operands.configuredDamageBonusScale, 1));
  const specialScale = finite(factor('special')?.multiplier, finite(operands.specialScale, 1));
  const vulnerableFactor = factors.find((item) => item.semanticKey.endsWith('-vulnerable'));
  const vulnerableScale = finite(vulnerableFactor?.multiplier, finite(operands.vulnerableDmgScale, 1));
  const expectedCriticalScale = finite(operands.expectedCriticalScale, 1);
  const allCriticalScale = finite(operands.allCriticalScale, 1);
  const criticalRate = finite(operands.criticalRate);
  const criticalDamageIncrease = finite(operands.criticalDamageIncrease);
  const attackAttribute = hit.modifierSnapshot.attackAttribute;
  const attackBase = finite(attackAttribute?.baseValue, attack);
  const attackSourceCount = attackAttribute?.contributions?.length ?? 0;
  const attackerCombinedScale = attackerScale * configuredScale;
  const buffTags = contributionBuffTags(hit, statusEvents, labels);
  const nonCritFactors = factors.length > 0
    ? factors.filter((item) => item.affectsNonCritical !== false).map((item) => item.multiplier)
    : [attack, atkScale, attackerScale, configuredScale, defScale, resistanceScale,
      damageTakenScale, vulnerableScale, defenderScale, weaknessScale, shelterScale, specialScale];
  const unavailable = '运行时未提供';
  const rateFormula = (selected: typeof factors[number] | undefined) => selected
    ? `${trimNumber(finite(selected.rawValue), 4)} → ×${trimNumber(selected.multiplier, 4)}`
    : unavailable;
  const fragileScale = vulnerableScale * defenderScale;
  const fragileFormula = vulnerableFactor || factor('defender-zone')
    ? `${trimNumber(vulnerableScale, 4)} × ${trimNumber(defenderScale, 4)} = ${trimNumber(fragileScale, 4)}`
    : operands.defenderZoneScale !== undefined
      ? `1 + ${percent(defenderScale - 1)} = ${trimNumber(defenderScale)}`
      : unavailable;
  return {
    title: `${title} 运行时计算过程`,
    panelLines: [
      `ATK: ${trimNumber(attack)}`,
      `暴击率: ${percent(criticalRate)}`,
      `暴击伤害: ${percent(criticalDamageIncrease)}`,
      `运行帧: F${hit.frame}`,
    ],
    attackLines: [
      ...(attackSourceCount > 0
        ? [`攻击力属性链: ${trimNumber(attackBase)} → ${trimNumber(attack)}（${attackSourceCount} 个运行时来源）`]
        : []),
      `运行时最终攻击力: ${trimNumber(attack)}`,
      `原始伤害: ${trimNumber(attack)} × ${trimNumber(atkScale, 4)} = ${trimNumber(hit.rawDamage)}`,
    ],
    buffTags,
    showNoBuff: buffTags.length === 0,
    baseMultiplierText: percent(atkScale, 2),
    multiplierFormulaText: `${percent(atkScale, 2)} = ${trimNumber(atkScale, 4)}`,
    formulaText: `${trimNumber(attack)} × ${trimNumber(atkScale, 4)} = ${trimNumber(hit.rawDamage)}`,
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
    vulnerabilityFormulaText: unavailable,
    comboFormulaText: rateFormula(factor('combo-damage')),
    imbalanceFormulaText: rateFormula(factor('imbalance-damage')),
    defenseZoneText: `1 / (1 + ${trimNumber(defense)} × ${trimNumber(defEfficiency, 3)}) = ${trimNumber(defScale)}`,
    nonCritFormulaText: `${nonCritFactors.map((factor) => trimNumber(factor, 4)).join(' × ')} = ${fixedDamage(hit.nonCriticalDamage)}`,
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

  activeStatusesBeforeHit(statusEvents, hit).forEach((active) => {
    if (active.event.targetId !== enemyId && active.event.targetId !== hit.sourceId) return;
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
  return [
    `F${hit.frame} / ${(hit.frame / tickRate).toFixed(2)}秒`,
    element,
    `倍率 ${percent(hit.atkScale, 2)}`,
    hit.sourceBuffId ? '状态机触发' : '技能本体',
  ].join(' · ');
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
    .filter((hit) => hit.castId === castId && hit.damageAttributeType === 'Hp')
    .sort((left, right) => left.frame - right.frame || left.hitIndex - right.hitIndex);
  const hits = runtimeHits.map((hit, index) => {
    const title = hitTitle(hit, index, labels, statusEvents);
    const formula = buildRuntimeFormula(hit, title, statusEvents, labels);
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
  const statuses: AkeRuntimeStatusView[] = [];

  beforeState.forEach((active) => {
    if (active.event.targetId !== report.enemyId
      && active.event.targetId !== command.characterId) return;
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
    if (isPassiveRegistration(active.event)) return;
    if (transitionedInstances.has(statusInstanceKey(active.event))) return;
    const view = snapshotStatusView(
      'ake-runtime-after', active, command, report.enemyId, report.tickRate, labels, '命中后',
    );
    if (view) statuses.push(view);
  });

  const compactStatusByInstance = new Map<string, AkeRuntimeCompactStatus>();
  transitions.forEach((event) => {
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
    if (metadata.hidden || active.event.targetId !== report.enemyId) return;
    const instanceKey = statusInstanceKey(active.event);
    if (compactStatusByInstance.has(instanceKey)) return;
    compactStatusByInstance.set(instanceKey, {
      key: `ake-runtime-snapshot:${statusInstanceKey(active.event)}`,
      buffId: active.event.buffId,
      label: `${metadata.shortLabel}${active.stackCount}`,
      title: `${metadata.label} · 命中后 ${active.stackCount}层`,
      tone: 'active',
      iconUrl: metadata.iconUrl,
      displayName: metadata.label,
      stackCount: active.stackCount,
      mainDisplay: isPrimaryRuntimeStatus(active.event.buffId, metadata),
      priority: runtimeStatusPriority(active.event.buffId, metadata),
      applicationScope: metadata.applicationScope,
    });
  });
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
    hit.castId === command.castId
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
    && (event.castId === command.castId || event.triggerCastId === command.castId)
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
