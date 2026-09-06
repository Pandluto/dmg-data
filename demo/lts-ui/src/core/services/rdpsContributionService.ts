/**
 * RDPS 归因引擎：无 Buff 的直接伤害归入实际出伤干员的 operator 域，
 * 分层 Shapley（Owen value）继续分配可归因 Buff 的边际贡献。归因世界
 * 固定关闭失衡（strict-imbalance policy），无 owner Buff 仅保留在 Owen
 * 基线中并最终进入 residual。所有 coalition 结果按 context fingerprint +
 * policyVersion + 来源 mask 缓存。
 */

import type { RdpsAttributionSummary, RdpsSourceKey } from './rdpsAttribution.types';
import { buildRdpsSourceKey, parseRdpsSourceKey } from './rdpsAttribution.types';
import { computeRdpsAttributionFromApplications, type RdpsAttributableApplication, type RdpsAttributionOptions } from './rdpsOwenAttribution';
export { computeRdpsAttributionFromApplications, computeOwenValues } from './rdpsOwenAttribution';
export type { RdpsAttributableApplication, RdpsAttributionOptions, RdpsAttributionEvaluationInput, OwenGroup } from './rdpsOwenAttribution';
import { buildAnomalyStateDerivedBuffs as buildDerived, buildAnomalyStateSnapshotBuffs as buildSnapshots } from './anomalyStateBuffs';
import type { ResolvedButtonInputs } from './damageReportService';
import { evaluateDamageReportContext } from './damageReportService';
import type { SkillButtonBuff } from '../../types/storage';
import { buffApplicationKeyOf } from './rdpsSourceResolutionContext';

const NO_SOURCE_KEYS = new Set<RdpsSourceKey>();

/** 默认来源键（与 evaluate 路径一致）。 */
function sourceKeyOf(buff: SkillButtonBuff): RdpsSourceKey | null {
  if (typeof buff.ownerCharacterId !== 'string' || !buff.ownerCharacterId.trim()) return null;
  const domain = buff.ownerBuffDomain;
  if (domain !== 'operator' && domain !== 'weapon' && domain !== 'equipment') return null;
  return buildRdpsSourceKey(buff.ownerCharacterId, domain);
}

/**
 * 收集全部可归因应用（普通 Buff、extra-hit、异常快照与连击）。来源判定必须
 * 与 evaluate 路径一致：优先消费运行时 sidecar，仅在 sidecar 没有可用结果时
 * 兼容显式 owner。旧数据不能因为 Buff 本体没有 owner 字段而漏出 Owen 世界。
 */
export function collectRdpsAttributableApplications(
  inputs: readonly ResolvedButtonInputs[],
): RdpsAttributableApplication[] {
  const applications: RdpsAttributableApplication[] = [];
  for (const input of inputs) {
    const derived = buildDerived(input.anomalyStatuses, input.button.skillType);
    const snapshots = buildSnapshots(input.anomalyStateSnapshots);
    for (const buff of [...input.allBuffs, ...derived, ...snapshots]) {
      const applicationKey = buffApplicationKeyOf(input.button.id, buff);
      const resolved = input.resolvedSourceSidecar.get(applicationKey);
      const sidecarKey = resolved?.method !== 'unresolved' && resolved?.characterId && resolved.domain
        ? buildRdpsSourceKey(resolved.characterId, resolved.domain)
        : null;
      const sourceKey = sidecarKey ?? sourceKeyOf(buff);
      if (sourceKey === null) continue;
      const parsed = parseRdpsSourceKey(sourceKey);
      if (!parsed) continue;
      applications.push({
        buff,
        applicationKey,
        sourceKey,
        characterId: parsed.characterId,
        domain: parsed.domain,
        sourceAssetName: resolved?.sourceAssetName,
      });
    }
  }
  return applications;
}

/**
 * 计算桌面伤害报表上下文的 RDPS 归因摘要。
 * @param inputs - resolveDamageReportContext 的输出。
 * @param options - policyVersion、contextFingerprint（coalition cache key 组成）与来源解析诊断。
 */
export function computeRdpsAttribution(
  inputs: readonly ResolvedButtonInputs[],
  options: RdpsAttributionOptions = {},
): RdpsAttributionSummary {
  const nameByCharacterId = new Map<string, string>(options.characterNameById ?? []);
  for (const input of inputs) {
    if (input.button.characterName && !nameByCharacterId.has(input.runtimeButton.characterId)) {
      nameByCharacterId.set(input.runtimeButton.characterId, input.button.characterName);
    }
  }
  const teamCharacterIds = options.teamCharacterIds
    ?? inputs.map((input) => input.runtimeButton.characterId).filter(Boolean);
  return computeRdpsAttributionFromApplications({
    applications: collectRdpsAttributableApplications(inputs),
    actualTotal: evaluateDamageReportContext(inputs, undefined).totalExpected,
    directDamageByCharacter: inputs.reduce((damageByCharacter, input) => {
      const characterId = input.runtimeButton.characterId;
      if (!characterId) return damageByCharacter;
      const directDamage = evaluateDamageReportContext([input], {
        enabledSourceKeys: NO_SOURCE_KEYS,
        unattributedBuffsEnabled: false,
        imbalanceEnabled: false,
      }).totalExpected;
      damageByCharacter.set(characterId, (damageByCharacter.get(characterId) ?? 0) + directDamage);
      return damageByCharacter;
    }, new Map<string, number>()),
    evaluateTotal: (enabledSourceKeys) => evaluateDamageReportContext(inputs, {
      enabledSourceKeys,
      imbalanceEnabled: false,
    }).totalExpected,
    excludedImbalanceEffectCount: inputs.reduce((count, input) => (
      count + buildDerived(input.anomalyStatuses, input.button.skillType)
        .filter((buff) => buff.type === 'imbalanceDmgBonus').length
    ), 0),
  }, {
    ...options,
    characterNameById: nameByCharacterId,
    teamCharacterIds,
    contextFingerprint: options.contextFingerprint ?? `${inputs.length}-buttons`,
  });
}
