import type {
  ConfigSnapshot,
  EquipmentSetBuffInput,
  OperatorBuffEffectInput,
  OperatorBuffGroupKey,
  WeaponSkillDetail,
} from '../calculators/operatorPanelCalculator';
import { doesBuffTypeMatchHit } from '../calculators/buffZoneCalculator';
import type { SkillButtonBuff } from '../../types/storage';

export interface ConfiguredHitBuffBundle {
  /** 已经结算进 ConfigSnapshot 面板，只补逐 Hit 来源归因。 */
  displayOnlyBuffs: SkillButtonBuff[];
  /** 配置中不会进入面板的常驻乘算效果，必须在 Hit 计算时执行。 */
  modifierBuffs: SkillButtonBuff[];
  /** 已装备且当前事件满足触发条件的配置额外伤害段。 */
  extraHitBuffs: Array<SkillButtonBuff & {
    effectKind: 'extraHit';
    extraHitConfig: NonNullable<SkillButtonBuff['extraHitConfig']>;
  }>;
}

export interface ConfiguredHitBuffOptions {
  isImbalanced?: boolean;
  statuses?: string[];
  attachments?: string[];
  targetHpRatio?: number;
  physicalAnomalyTriggered?: boolean;
}

const ELEMENTS = ['physical', 'fire', 'electric', 'ice', 'nature'] as const;
const SKILL_TYPES = ['A', 'B', 'E', 'Q', 'Dot'] as const;

function normalizeType(type: string | undefined): string {
  if (type === 'atk') return 'flatAtk';
  if (type === 'multiplierMultiplier') return 'multiplierBonus';
  return type?.trim() ?? '';
}

function canAffectAnyDamageHit(type: string): boolean {
  return ELEMENTS.some((element) => SKILL_TYPES.some((skillType) => (
    doesBuffTypeMatchHit(type, { element, skillType })
  )));
}

function stableToken(value: string): string {
  return encodeURIComponent(value.trim() || 'unknown');
}

function buildBase(input: {
  id: string;
  name: string;
  sourceName: string;
  type: string;
  value?: number;
  description?: string;
  level?: string;
  ownerCharacterId: string;
  ownerBuffDomain: NonNullable<SkillButtonBuff['ownerBuffDomain']>;
  ownerBuffGroup: NonNullable<SkillButtonBuff['ownerBuffGroup']>;
  multiplier?: SkillButtonBuff['multiplier'];
  displayOnly: boolean;
  condition?: string;
}): SkillButtonBuff {
  return {
    schemaVersion: 2,
    id: input.id,
    name: input.id,
    displayName: input.name,
    sourceName: input.sourceName,
    level: input.level,
    type: input.type,
    value: input.value,
    description: input.description || input.name,
    source: 'configured-hit',
    condition: input.condition ?? (input.displayOnly ? '已结算进配置面板' : '配置常驻乘算'),
    category: 'passive',
    ownerCharacterId: input.ownerCharacterId,
    ownerBuffDomain: input.ownerBuffDomain,
    ownerBuffGroup: input.ownerBuffGroup,
    multiplier: input.multiplier,
    effectKind: 'modifier',
    displayOnly: input.displayOnly,
    refCount: 1,
    target: { mode: 'all' },
  };
}

function emptyBundle(): ConfiguredHitBuffBundle {
  return { displayOnlyBuffs: [], modifierBuffs: [], extraHitBuffs: [] };
}

function isConfiguredExtraHitTriggered(
  config: NonNullable<SkillButtonBuff['extraHitConfig']>,
  options: ConfiguredHitBuffOptions,
): boolean {
  return config.trigger === 'physicalAbnormal' && options.physicalAnomalyTriggered === true;
}

function buildConfiguredExtraHit(input: {
  id: string;
  name: string;
  sourceName: string;
  description?: string;
  level?: string;
  ownerCharacterId: string;
  ownerBuffDomain: NonNullable<SkillButtonBuff['ownerBuffDomain']>;
  ownerBuffGroup: NonNullable<SkillButtonBuff['ownerBuffGroup']>;
  extraHitConfig: NonNullable<SkillButtonBuff['extraHitConfig']>;
}): SkillButtonBuff & {
  effectKind: 'extraHit';
  extraHitConfig: NonNullable<SkillButtonBuff['extraHitConfig']>;
} {
  return {
    schemaVersion: 2,
    id: input.id,
    name: input.id,
    displayName: input.name,
    sourceName: input.sourceName,
    level: input.level,
    description: input.description || input.name,
    source: 'configured-hit',
    condition: '当前事件已触发物理异常',
    category: 'condition',
    ownerCharacterId: input.ownerCharacterId,
    ownerBuffDomain: input.ownerBuffDomain,
    ownerBuffGroup: input.ownerBuffGroup,
    effectKind: 'extraHit',
    extraHitConfig: input.extraHitConfig,
    refCount: 1,
    target: { mode: 'all' },
  };
}

const CHINESE_POTENTIAL_NUMBERS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function requiredPotentialCount(name: string): number | null {
  const normalized = name.replace(/\s+/g, '');
  const token = normalized.match(/潜能([1-6一二三四五六])/)?.[1]
    ?? normalized.match(/([1-6一二三四五六])潜/)?.[1];
  return token ? CHINESE_POTENTIAL_NUMBERS[token] ?? Number(token) : null;
}

function isOperatorConditionActive(
  effect: OperatorBuffEffectInput,
  options: ConfiguredHitBuffOptions,
): boolean {
  const activation = effect.activation;
  if (!activation) return false;
  if (activation.kind === 'targetImbalanced') return options.isImbalanced === true;
  if (activation.kind === 'targetStatus') {
    return Boolean(activation.status && options.statuses?.includes(activation.status));
  }
  if (activation.kind === 'targetAttachment') {
    return Boolean(activation.element && options.attachments?.includes(activation.element));
  }
  if (activation.kind === 'targetHpBelow') {
    return typeof activation.value === 'number'
      && typeof options.targetHpRatio === 'number'
      && options.targetHpRatio < activation.value;
  }
  return false;
}

function includeBakedType(type: string, options: ConfiguredHitBuffOptions): boolean {
  if (!type || !canAffectAnyDamageHit(type)) return false;
  // 面板中的“对失衡目标伤害”只有木桩真正处于失衡/倒地时才算命中。
  if (type === 'imbalanceDmgBonus') return options.isImbalanced === true;
  return true;
}

function buildWeaponBuffs(
  snapshot: ConfigSnapshot,
  options: ConfiguredHitBuffOptions,
): ConfiguredHitBuffBundle {
  const sourceName = snapshot.weapon.name || snapshot.weapon.id || snapshot.operator.name;
  const details: WeaponSkillDetail[] = [
    ...(snapshot.weapon.skills.skill1 ? [snapshot.weapon.skills.skill1] : []),
    ...(snapshot.weapon.skills.skill2 ? [snapshot.weapon.skills.skill2] : []),
    ...snapshot.weapon.skills.skill3.effects.filter((effect) => effect.category === 'passive'),
  ];

  return details.reduce<ConfiguredHitBuffBundle>((bundle, detail, index) => {
    if (detail.effectKind === 'extraHit') {
      if (detail.extraHitConfig && isConfiguredExtraHitTriggered(detail.extraHitConfig, options)) {
        const skillToken = `${detail.skillKey}:${detail.effectKey || index}`;
        bundle.extraHitBuffs.push(buildConfiguredExtraHit({
          id: `configured-hit:weapon:${stableToken(snapshot.operator.id)}:${stableToken(snapshot.weapon.id || sourceName)}:${stableToken(skillToken)}:extra-hit`,
          name: detail.label || `${sourceName} 追加伤害`,
          sourceName,
          description: typeof detail.raw === 'string' ? detail.raw : detail.label,
          level: `Lv${detail.level}`,
          ownerCharacterId: snapshot.operator.id,
          ownerBuffDomain: 'weapon',
          ownerBuffGroup: 'weaponSkill',
          extraHitConfig: detail.extraHitConfig,
        }));
      }
      return bundle;
    }
    const type = normalizeType(detail.typeKey);
    const isRuntimeMultiplier = Boolean(detail.multiplier);
    if ((!isRuntimeMultiplier && !includeBakedType(type, options)) || (isRuntimeMultiplier && !canAffectAnyDamageHit(type))) {
      return bundle;
    }
    const skillToken = `${detail.skillKey}:${detail.effectKey || index}`;
    const buff = buildBase({
      id: `configured-hit:weapon:${stableToken(snapshot.operator.id)}:${stableToken(snapshot.weapon.id || sourceName)}:${stableToken(skillToken)}`,
      name: detail.label || `${sourceName} ${detail.skillKey}`,
      sourceName,
      type,
      value: isRuntimeMultiplier ? undefined : detail.value,
      description: typeof detail.raw === 'string' ? detail.raw : detail.label,
      level: `Lv${detail.level}`,
      ownerCharacterId: snapshot.operator.id,
      ownerBuffDomain: 'weapon',
      ownerBuffGroup: 'weaponSkill',
      multiplier: detail.multiplier,
      displayOnly: !isRuntimeMultiplier,
    });
    (isRuntimeMultiplier ? bundle.modifierBuffs : bundle.displayOnlyBuffs).push(buff);
    return bundle;
  }, emptyBundle());
}

function buildEquipmentBuffs(
  snapshot: ConfigSnapshot,
  options: ConfiguredHitBuffOptions,
): ConfiguredHitBuffBundle {
  return snapshot.equipment.setBuffs.reduce<ConfiguredHitBuffBundle>((bundle, effect: EquipmentSetBuffInput, index) => {
    if (effect.effectKind === 'extraHit') {
      if (effect.extraHitConfig && isConfiguredExtraHitTriggered(effect.extraHitConfig, options)) {
        const sourceName = effect.gearSetName || effect.gearSetId || '三件套';
        bundle.extraHitBuffs.push(buildConfiguredExtraHit({
          id: `configured-hit:equipment:${stableToken(snapshot.operator.id)}:${stableToken(effect.gearSetId)}:${stableToken(effect.effectId || String(index))}:extra-hit`,
          name: effect.label || `${sourceName} 三件套追加伤害`,
          sourceName,
          description: effect.raw || effect.label,
          level: '三件套',
          ownerCharacterId: snapshot.operator.id,
          ownerBuffDomain: 'equipment',
          ownerBuffGroup: 'threePiece',
          extraHitConfig: effect.extraHitConfig,
        }));
      }
      return bundle;
    }
    if (!['positive', 'passive'].includes(effect.category || '')) {
      return bundle;
    }
    const type = normalizeType(effect.typeKey);
    const isRuntimeMultiplier = Boolean(effect.multiplier);
    if ((!isRuntimeMultiplier && !includeBakedType(type, options)) || (isRuntimeMultiplier && !canAffectAnyDamageHit(type))) {
      return bundle;
    }
    const sourceName = effect.gearSetName || effect.gearSetId || '三件套';
    const buff = buildBase({
      id: `configured-hit:equipment:${stableToken(snapshot.operator.id)}:${stableToken(effect.gearSetId)}:${stableToken(effect.effectId || String(index))}`,
      name: effect.label || `${sourceName} 三件套效果`,
      sourceName,
      type,
      value: isRuntimeMultiplier ? undefined : effect.value,
      description: effect.raw || effect.label,
      level: '三件套',
      ownerCharacterId: snapshot.operator.id,
      ownerBuffDomain: 'equipment',
      ownerBuffGroup: 'threePiece',
      multiplier: effect.multiplier,
      displayOnly: !isRuntimeMultiplier,
    });
    (isRuntimeMultiplier ? bundle.modifierBuffs : bundle.displayOnlyBuffs).push(buff);
    return bundle;
  }, emptyBundle());
}

function buildOperatorBuffs(
  snapshot: ConfigSnapshot,
  options: ConfiguredHitBuffOptions,
): ConfiguredHitBuffBundle {
  const sourceName = snapshot.operator.name || snapshot.operator.id;
  return (['talent', 'potential', 'skill'] as const).reduce<ConfiguredHitBuffBundle>((bundle, groupKey: OperatorBuffGroupKey) => {
    Object.entries(snapshot.operator.buffs[groupKey]?.effects || {}).forEach(([effectKey, effect]: [string, OperatorBuffEffectInput]) => {
      if (groupKey === 'potential') {
        const requiredCount = requiredPotentialCount(effect.name || effect.effectId);
        if (requiredCount !== null && snapshot.operator.potentialCount <= requiredCount) return;
      }
      if (effect.effectKind === 'extraHit') {
        if (effect.extraHitConfig && isConfiguredExtraHitTriggered(effect.extraHitConfig, options)) {
          bundle.extraHitBuffs.push(buildConfiguredExtraHit({
            id: `configured-hit:operator:${stableToken(snapshot.operator.id)}:${groupKey}:${stableToken(effect.effectId || effectKey)}:extra-hit`,
            name: effect.name || effectKey,
            sourceName,
            description: effect.description || effect.raw || effect.name,
            level: groupKey,
            ownerCharacterId: snapshot.operator.id,
            ownerBuffDomain: 'operator',
            ownerBuffGroup: groupKey,
            extraHitConfig: effect.extraHitConfig,
          }));
        }
        return;
      }
      if (effect.category === 'countable') return;
      const isActivatedCondition = effect.category === 'condition'
        && isOperatorConditionActive(effect, options);
      if (!['positive', 'passive'].includes(effect.category) && !isActivatedCondition) return;
      const type = normalizeType(effect.type);
      const hasCoefficientMultiplier = Boolean(effect.multiplier);
      const requiresRuntimeApplication = hasCoefficientMultiplier || isActivatedCondition;
      if ((!requiresRuntimeApplication && !includeBakedType(type, options)) || (requiresRuntimeApplication && !canAffectAnyDamageHit(type))) {
        return;
      }
      const buff = buildBase({
        id: `configured-hit:operator:${stableToken(snapshot.operator.id)}:${groupKey}:${stableToken(effect.effectId || effectKey)}`,
        name: effect.name || effectKey,
        sourceName,
        type,
        value: hasCoefficientMultiplier ? undefined : effect.value,
        description: effect.description || effect.raw || effect.name,
        level: groupKey,
        ownerCharacterId: snapshot.operator.id,
        ownerBuffDomain: 'operator',
        ownerBuffGroup: groupKey,
        multiplier: effect.multiplier,
        displayOnly: !requiresRuntimeApplication,
        condition: isActivatedCondition ? '木桩/目标状态满足干员条件' : undefined,
      });
      (requiresRuntimeApplication ? bundle.modifierBuffs : bundle.displayOnlyBuffs).push(buff);
    });
    return bundle;
  }, emptyBundle());
}

/**
 * 将配置快照拆成“已进面板的命中归因”和“仍需逐 Hit 执行的常驻乘算”。
 * 条件/计层效果仍由按钮 Buff 或木桩状态机提供，避免在条件不满足时擅自启用。
 */
export function buildConfiguredHitBuffs(
  snapshot: ConfigSnapshot | null | undefined,
  options: ConfiguredHitBuffOptions = {},
): ConfiguredHitBuffBundle {
  if (!snapshot) return emptyBundle();
  const bundles = [
    buildWeaponBuffs(snapshot, options),
    buildEquipmentBuffs(snapshot, options),
    buildOperatorBuffs(snapshot, options),
  ];
  return {
    displayOnlyBuffs: bundles.flatMap((bundle) => bundle.displayOnlyBuffs),
    modifierBuffs: bundles.flatMap((bundle) => bundle.modifierBuffs),
    extraHitBuffs: bundles.flatMap((bundle) => bundle.extraHitBuffs),
  };
}
