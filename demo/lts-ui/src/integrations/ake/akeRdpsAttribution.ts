import { buildAkeRdpsContext, AKE_RDPS_POLICY } from '../../../../../src/core/ake-rdps-context.mjs';
import { computeRdpsAttributionFromApplications } from '../../core/services/rdpsOwenAttribution';
import type { AkeTeamReport } from './akeProvider';
export function calculateAkeRdps(report: AkeTeamReport) {
  const startedAt = performance.now();
  const context = buildAkeRdpsContext(report);
  const summary = computeRdpsAttributionFromApplications(context, {
    policyVersion: AKE_RDPS_POLICY,
    contextFingerprint: `${report.workspaceId}|${report.executionDigest}|${report.generatedAt}`,
    characterNameById: new Map(report.characters.map(character => [character.localCharacterId, character.characterName])),
    teamCharacterIds: report.characters.map(character => character.localCharacterId),
    resolutionDiagnostics: { resolvedExplicitDefinitionCount: context.applications.length,
      unresolvedDefinitionCount: context.audit.unresolvedSourceIds.length,
      unresolvedApplicationCount: context.audit.unresolvedApplicationCount },
  });
  // Independently account for imbalance and unknown effects, rather than forcing a zero residual error.
  const residual = context.audit.excludedImbalanceDamage + context.audit.unresolvedBaselineDamage;
  summary.accountingError = Math.abs(summary.actualTotal - summary.attributedTotal - residual);
  if (summary.accountingError > 1e-6 || summary.owenEfficiencyError > 1e-6 || summary.hierarchyError > 1e-6) {
    throw new Error('RD 来源、层级或未归因余额未通过核对，归因已停止。');
  }
  return { summary, audit: { ...context.audit, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 } };
}
