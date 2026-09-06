import type { Character, TimelineData } from '../../types';
import { GRID_NODE_COUNT } from '../../core/calculators/gridSnapLayout';
import { getOperatorConfigPageCache } from '../../utils/storage';
import { getInstalledAkeCatalog, type AkeCatalog } from './akeCatalogAdapter';
import { buildAkeRealtimeTimeline, type AkeRealtimeTimeline } from './akeRealtimeTimeline';

export function resolveAkeCalculationEndFrame(timeline: Pick<AkeRealtimeTimeline, 'sharedVariableRateTimeline'>): number {
  const model = timeline.sharedVariableRateTimeline;
  const end = Math.max(model?.endFrame ?? 0,
    ...(model?.actions.map(action => action.endFrame) ?? []),
    ...(model?.waits.map(wait => wait.endFrame) ?? []),
    ...(model?.laneWaits.map(wait => wait.endFrame) ?? []),
    ...(model?.operatorSwitches.map(item => item.endFrame) ?? []));
  return Math.max(360, Math.ceil(end) + 300);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'createdAt' && key !== 'updatedAt')
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

/** The cache key describes saved simulation inputs; UI revision counters are never inputs. */
export function buildAkeExecutionDigest(input: {
  timelineData: TimelineData; selectedCharacters: Character[]; catalog?: AkeCatalog | null;
  preview?: AkeRealtimeTimeline | null; enemyId?: string;
}): string {
  const catalog = input.catalog ?? getInstalledAkeCatalog();
  const lastNode = Math.max(0, ...input.timelineData.staffLines.flatMap(line => line.buttons.map(button => Number(button.nodeIndex) || 0)));
  const preview = input.preview ?? (catalog ? buildAkeRealtimeTimeline({ ...input, catalog,
    staffCount: Math.max(1, Math.floor(lastNode / GRID_NODE_COUNT) + 1) }) : null);
  const snapshots = getOperatorConfigPageCache();
  return JSON.stringify(stable({
    contract: 'ake-workspace-runtime-v7',
    catalog: { schemaVersion: catalog?.schemaVersion, ...catalog?.source },
    enemyId: input.enemyId ?? 'eny_0007_mimicw',
    characters: input.selectedCharacters.map(character => {
      const config = snapshots[character.id];
      return { id: character.id, config: config ? {
        level: config.operator.level, potentialCount: config.operator.potentialCount, skillConfig: config.operator.skillConfig,
        weapon: { id: config.weapon.id, name: config.weapon.name, config: config.weapon.config },
        equipment: config.equipment.pieces.map(piece => ({ slot: piece.slotKey, id: piece.equipmentId,
          levels: piece.effects.map(effect => effect.level) })),
        panel: { calc: config.panel.calc, display: config.panel.display },
      } : null };
    }),
    timelineData: { ...input.timelineData, reportNotes: undefined, staffLines: input.timelineData.staffLines.map(line => ({
      staffIndex: line.staffIndex, characterName: line.characterName,
      buttons: line.buttons.map(button => ({ id: button.id, characterId: button.characterId, skillType: button.skillType,
        basicAttackStageCount: button.basicAttackStageCount, runtimeSkillId: button.runtimeSkillId, nodeIndex: button.nodeIndex, staffIndex: button.staffIndex,
        releaseAnchor: button.releaseAnchor, timelineModuleKind: button.timelineModuleKind,
        forcedWaitConfig: button.forcedWaitConfig, laneWaitConfig: button.laneWaitConfig, operatorSwitchConfig: button.operatorSwitchConfig,
      })),
    })) },
    endFrame: preview ? resolveAkeCalculationEndFrame(preview) : null,
  }));
}
