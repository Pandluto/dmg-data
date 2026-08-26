import type { DamageBonusSnapshot, SkillButtonBuff } from '../../types/storage';
import {
  calculateBuffTotals,
  calculateBuffedPanel,
  calculateElementDmgBonus,
  calculateResistanceZone,
  calculateSkillDmgBonus,
} from './buffCalculator';
import { calculateHitBuffZones, doesBuffTypeMatchHit } from './buffZoneCalculator';
import {
  doesBuffApplyToResolvedHit,
  isSingleHitMultiplierBonusBuff,
  resolveSingleHitMultiplierBonusTargets,
  type SingleHitBuffTargetByBuffId,
} from '../services/singleHitMultiplierBonus';
import { getBuffTypeLabel } from '../domain/buffTypeMetadata';
import type {
  DamageBreakdown,
  DamageZones,
  HitCalcResult,
  ResolvedHitTemplate,
  SkillDamageCalcInputV2,
  SkillDamageCalcResultV2,
  SkillDamagePanel,
} from './skillDamage.types';

function filterBuffsForHit(hit: ResolvedHitTemplate, buffs: SkillButtonBuff[]): SkillButtonBuff[] {
  const context = { element: hit.element, skillType: hit.skillType };
  return buffs.filter((buff) => (
    doesBuffApplyToResolvedHit(buff, hit)
    && doesBuffTypeMatchHit(buff.type, context)
  ));
}

function filterDisplayOnlyBuffsForHit(
  hit: ResolvedHitTemplate,
  buffs: SkillButtonBuff[],
): SkillButtonBuff[] {
  const context = { element: hit.element, skillType: hit.skillType };
  return buffs.filter((buff) => (
    doesBuffApplyToResolvedHit(buff, hit)
    // 无 type 的条目是元素附着/木桩状态等纯状态标签；有 type 的配置项
    // 必须遵守与数值 Buff 相同的逐 Hit 匹配规则。
    && (!buff.type || doesBuffTypeMatchHit(buff.type, context))
  ));
}

type ResolvedHitBuffNumericEffect = NonNullable<
  NonNullable<ResolvedHitTemplate['hitBuffs']>[number]['effects']
>[number];

function formatHitBuffEffectValue(effect: ResolvedHitBuffNumericEffect): string {
  const value = effect.unit === 'percent' ? effect.value * 100 : effect.value;
  const precision = Number.isInteger(value) ? 0 : 1;
  return `${value >= 0 ? '+' : ''}${value.toFixed(precision)}${effect.unit === 'percent' ? '%' : ''}`;
}

function formatHitBuffEffectSummary(effect: ResolvedHitBuffNumericEffect): string {
  const duration = typeof effect.durationSeconds === 'number' && effect.durationSeconds > 0
    ? ` / ${effect.durationSeconds.toFixed(Number.isInteger(effect.durationSeconds) ? 0 : 1)}秒`
    : '';
  const stacks = typeof effect.maxStacks === 'number' && effect.maxStacks > 1
    ? ` / 最多${effect.maxStacks}层`
    : '';
  return `${getBuffTypeLabel(effect.type)} ${formatHitBuffEffectValue(effect)}${duration}${stacks}`;
}

function buildHitEffectBuffs(
  hit: ResolvedHitTemplate,
  ownerCharacterId: string,
): SkillButtonBuff[] {
  return (hit.hitBuffs ?? []).map((effect, index) => {
    const targetLabel = effect.targetLabel || (
      effect.target === 'self'
        ? '自身'
        : effect.target === 'target'
          ? '目标'
          : effect.target === 'team'
            ? '队伍'
            : '未知目标'
    );
    const numericEffectSummary = (effect.effects ?? [])
      .map(formatHitBuffEffectSummary)
      .join('；');
    const effectLabel = `${effect.displayName}（${targetLabel}）${numericEffectSummary ? ` · ${numericEffectSummary}` : ''}`;
    return {
      schemaVersion: 2,
      id: `ake-hit-effect:${hit.key}:${effect.id}:${index}`,
      name: effect.id,
      displayName: effectLabel,
      sourceName: 'AKE 真实命中',
      type: 'akeHitEffect',
      description: [
        effect.description || `${effect.id} · 作用于${targetLabel}`,
        numericEffectSummary ? `解析效果：${numericEffectSummary}` : '',
      ].filter(Boolean).join('；'),
      source: 'ake-hit-effect',
      condition: '与该 DamageAction 同事件组触发',
      category: 'passive',
      ownerBuffDomain: 'operator',
      ownerCharacterId,
      ownerBuffGroup: 'skill',
      refCount: 1,
      displayOnly: true,
      target: { mode: 'damageKey', key: hit.key },
    };
  });
}

function buildPanelForHit(
  appliedBuffs: SkillButtonBuff[],
  input: SkillDamageCalcInputV2
): SkillDamagePanel {
  if (!input.panelBase) {
    return input.panel;
  }

  return calculateBuffedPanel(input.panelBase, appliedBuffs, input.buffStackCounts);
}

function calculateHitDamage(
  panelAtk: number,
  multiplierValue: number,
  critMultiplier: number,
  damageBonusRate: number,
  defenseZone: number,
  resistanceZone: number,
  amplifyRate: number,
  fragileRate: number,
  vulnerabilityRate: number,
  comboDamageBonus: number,
  imbalanceDamageBonus: number
): DamageBreakdown {
  const base = panelAtk * multiplierValue;
  const afterCrit = base * critMultiplier;
  const afterBonus = afterCrit * damageBonusRate;
  const afterDefense = afterBonus * defenseZone;
  const afterResistance = afterDefense * resistanceZone;
  const afterAmplify = afterResistance * (1 + amplifyRate);
  const afterFragile = afterAmplify * (1 + fragileRate);
  const afterVulnerability = afterFragile * (1 + vulnerabilityRate);
  const afterCombo = afterVulnerability * (1 + comboDamageBonus);
  const final = afterCombo * (1 + imbalanceDamageBonus);

  return {
    base,
    afterCrit,
    afterBonus,
    afterDefense,
    afterResistance,
    afterAmplify,
    afterFragile,
    afterVulnerability,
    final,
  };
}

function toDamageBonusRecord(damageBonus: DamageBonusSnapshot): Record<string, number> {
  return { ...damageBonus };
}

function calculateAllDamageBonus(
  damageBonus: DamageBonusSnapshot,
  buffs: ReturnType<typeof calculateBuffTotals>
): number {
  return (damageBonus.allDmgBonus || 0) + (buffs.allDmgBonus || 0);
}

function calculateHitZones(
  hit: ResolvedHitTemplate,
  damageBonus: DamageBonusSnapshot,
  buffs: ReturnType<typeof calculateBuffTotals>,
  targetResistance: SkillDamageCalcInputV2['targetResistance'],
  zoneResults: ReturnType<typeof calculateHitBuffZones>,
  targetState: SkillDamageCalcInputV2['targetState'],
): DamageZones {
  const parsedDamageBonus = toDamageBonusRecord(damageBonus);
  const elementBonus = calculateElementDmgBonus(hit.element, parsedDamageBonus, buffs);
  const skillBonus = calculateSkillDmgBonus(hit.skillType, parsedDamageBonus, buffs);
  const allDamageBonus = calculateAllDamageBonus(damageBonus, buffs);
  const damageBonusRate = zoneResults.damageBonus.finalValue;
  const resistance = calculateResistanceZone(hit.element, targetResistance, buffs);

  return {
    damageBonus: zoneResults.damageBonus,
    amplify: zoneResults.amplify,
    fragile: zoneResults.fragile,
    vulnerability: zoneResults.vulnerability,
    skillMultiplier: zoneResults.skillMultiplier,
    elementBonus,
    skillBonus,
    allDamageBonus,
    damageBonusRate,
    resistanceZone: resistance.resistanceZone,
    resistance,
    amplifyRate: zoneResults.amplify.finalValue - 1,
    fragileRate: zoneResults.fragile.finalValue - 1,
    vulnerabilityRate: zoneResults.vulnerability.finalValue - 1,
    comboDamageBonus: buffs.comboDamageBonus,
    imbalanceDamageBonus: buffs.imbalanceDamageBonus + (
      hit.element === 'physical' && (targetState?.isImbalanced ?? true)
        ? (damageBonus.imbalanceDmgBonus || 0)
        : 0
    ),
    defenseZone: 0.5,
  };
}

function calculateSingleHit(
  hit: ResolvedHitTemplate,
  buffs: SkillButtonBuff[],
  input: SkillDamageCalcInputV2,
  singleHitBuffTargets: SingleHitBuffTargetByBuffId,
): HitCalcResult {
  const isDisabled = input.disabledHitKeys?.includes(hit.key) ?? false;
  const disabledBuffIds = new Set(input.disabledBuffIdsByHitKey?.[hit.key] ?? []);
  const appliedModifierBuffs = filterBuffsForHit(hit, buffs).filter((buff) => (
    isSingleHitMultiplierBonusBuff(buff)
      ? singleHitBuffTargets[buff.id] === hit.key
      : !disabledBuffIds.has(buff.id)
  ));
  const effectiveBuffs = isDisabled ? [] : appliedModifierBuffs;
  const hitEffectBuffs = isDisabled
    ? []
    : buildHitEffectBuffs(hit, input.characterId)
      .filter((buff) => !disabledBuffIds.has(buff.id));
  const displayOnlyBuffs = isDisabled
    ? []
    : filterDisplayOnlyBuffsForHit(hit, input.displayOnlyBuffs ?? [])
      .filter((buff) => !disabledBuffIds.has(buff.id));
  const hitStackCounts = {
    ...(input.buffStackCounts ?? {}),
    ...(input.buffStackCountsByHitKey?.[hit.key] ?? {}),
  };
  const hitInput = { ...input, buffStackCounts: hitStackCounts };
  const panel = buildPanelForHit(effectiveBuffs, hitInput);
  const buffTotals = calculateBuffTotals(effectiveBuffs, hitStackCounts);
  const zoneResults = calculateHitBuffZones({
    context: { element: hit.element, skillType: hit.skillType },
    buffs: effectiveBuffs,
    stackCounts: hitStackCounts,
    damageBonus: input.damageBonus,
    baseSkillMultiplier: hit.multiplier,
  });
  const zones = calculateHitZones(
    hit,
    input.damageBonus,
    buffTotals,
    input.targetResistance,
    zoneResults,
    input.targetState,
  );
  const multiplier = {
    base: hit.multiplier,
    afterBonus: hit.multiplier + zoneResults.skillMultiplier.additiveTotal,
    afterMultiply: zoneResults.skillMultiplier.finalValue,
  };

  const critRate = panel.critRate;
  const critDmg = panel.critDmg;
  const critExpected = 1 + critRate * critDmg;

  return {
    hit,
    isDisabled,
    // Raw hit effects are display/tuning metadata. They are deliberately not
    // fed back into panel or multiplier zones, so status/resource actions do
    // not double-count as damage modifiers.
    appliedBuffs: [...effectiveBuffs, ...displayOnlyBuffs, ...hitEffectBuffs],
    panel,
    zones,
    buffContributions: zoneResults.contributions,
    multiplier,
    nonCrit: isDisabled
      ? createZeroDamageBreakdown()
      : calculateHitDamage(
        panel.atk,
        multiplier.afterMultiply,
        1,
        zones.damageBonusRate,
        zones.defenseZone,
        zones.resistanceZone,
        zones.amplifyRate,
        zones.fragileRate,
        zones.vulnerabilityRate,
        zones.comboDamageBonus,
        zones.imbalanceDamageBonus
      ),
    crit: isDisabled
      ? createZeroDamageBreakdown()
      : calculateHitDamage(
        panel.atk,
        multiplier.afterMultiply,
        1 + critDmg,
        zones.damageBonusRate,
        zones.defenseZone,
        zones.resistanceZone,
        zones.amplifyRate,
        zones.fragileRate,
        zones.vulnerabilityRate,
        zones.comboDamageBonus,
        zones.imbalanceDamageBonus
      ),
    expected: isDisabled
      ? createZeroDamageBreakdown()
      : calculateHitDamage(
        panel.atk,
        multiplier.afterMultiply,
        critExpected,
        zones.damageBonusRate,
        zones.defenseZone,
        zones.resistanceZone,
        zones.amplifyRate,
        zones.fragileRate,
        zones.vulnerabilityRate,
        zones.comboDamageBonus,
        zones.imbalanceDamageBonus
      ),
  };
}

function createZeroDamageBreakdown(): DamageBreakdown {
  return {
    base: 0,
    afterCrit: 0,
    afterBonus: 0,
    afterDefense: 0,
    afterResistance: 0,
    afterAmplify: 0,
    afterFragile: 0,
    afterVulnerability: 0,
    final: 0,
  };
}

export function calculateSkillButtonDamageV2(
  input: SkillDamageCalcInputV2
): SkillDamageCalcResultV2 {
  const singleHitBuffTargets = resolveSingleHitMultiplierBonusTargets(
    input.buffs,
    input.template.hits,
    input.disabledBuffIdsByHitKey,
    input.singleHitBuffTargetByBuffId,
  );
  const hits = input.template.hits.map((hit) => (
    calculateSingleHit(hit, input.buffs, input, singleHitBuffTargets)
  ));

  return {
    hits,
    summary: {
      totalExpected: hits.reduce((sum, hit) => sum + hit.expected.final, 0),
      totalCrit: hits.reduce((sum, hit) => sum + hit.crit.final, 0),
      totalNonCrit: hits.reduce((sum, hit) => sum + hit.nonCrit.final, 0),
    },
  };
}
