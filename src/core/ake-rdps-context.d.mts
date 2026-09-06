export const AKE_RDPS_POLICY: string;
export interface AkeRdpsAudit {
  inputVersion: number; hitCount: number; excludedHitCount: number; reconstructedTotal: number;
  reconstructionError: number; maximumHitError: number; excludedImbalanceDamage: number;
  unresolvedBaselineDamage: number; unresolvedApplicationCount: number; unresolvedSourceIds: string[];
  sourceLedger: Array<{ id: string; key: string | null; characterId?: string; domain: string; sourceId: string | null; buffId: string | null; sourceType: string; teamComboGrantId: string | null }>;
}
export function buildAkeRdpsContext(input: { hits: unknown[]; characters: unknown[]; enemyId: string; statusEvents?: unknown[] }): {
  applications: Array<{ applicationKey: string; sourceKey: string; characterId: string; domain: 'operator' | 'weapon' | 'equipment' }>;
  actualTotal: number; directDamageByCharacter: Map<string, number>;
  evaluateTotal(keys: ReadonlySet<string>): number; excludedImbalanceEffectCount: number; audit: AkeRdpsAudit;
};
