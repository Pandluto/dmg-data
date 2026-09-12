import type { SharedVariableRateTimelineModel, ScheduledTimelineOperatorSwitch } from './sharedVariableRateTimeline';
import type { TimelineData } from '../../types';
import { migrateTimelineOperationSequence } from './timelineOperationSequence';

/** 9ff9f94 compatibility only. Never use this query for a v1 admission. */
export function legacyControlledOperatorAt(initial: string | null | undefined,
  switches: readonly ScheduledTimelineOperatorSwitch[], frame: number, x: number): string | null {
  let controlled = initial?.trim() || null;
  for (const change of [...switches].sort((a, b) => a.startFrame - b.startFrame || a.endX - b.endX || a.id.localeCompare(b.id))) {
    if (change.startFrame < frame || (change.startFrame === frame && change.endX <= x)) controlled = change.targetLaneId;
  }
  return controlled;
}

/** Fixed legacy provider projection -> v0 API/runner stable tie breaks -> IDs.
 * The caller supplies the legacy planner with its fixed baseline parameters,
 * never the current visible/settled projection. Coordinates stop at this seam.
 */
export function migrateLegacyPlannedOperationOrder(data: TimelineData, plan: Pick<SharedVariableRateTimelineModel, 'actions' | 'operatorSwitches'>,
  memberIdByCharacterId: ReadonlyMap<string, string>): TimelineData {
  const buttons = data.staffLines.flatMap(line => line.buttons);
  const actions = new Map(plan.actions.map(action => [action.id, action]));
  const switches = new Map(plan.operatorSwitches.map(change => [change.id, change]));
  const switchIndex = new Map(plan.operatorSwitches.map((change, index) => [change.id, index]));
  // prepareMember's buttonsForCharacter sorted nodeIndex then ID before the API.
  const providerIndices = new Map([...buttons].sort((a, b) => a.nodeIndex - b.nodeIndex || a.id.localeCompare(b.id))
    .map((button, index) => [button.id, index]));
  const entries = buttons.map((button, index) => {
    const action = actions.get(button.id);
    const change = switches.get(button.id);
    return { id: button.id, index: action ? providerIndices.get(button.id)! : index, kind: change ? 'switch' : action ? 'command' : 'module',
      key: change?.endX ?? action?.startX ?? 0,
      frame: change?.startFrame ?? action?.startFrame ?? 0,
      member: memberIdByCharacterId.get(button.characterId ?? '') ?? '',
      switchIndex: switchIndex.get(button.id) ?? 0 };
  });
  entries.sort((a, b) => a.key - b.key
    || (a.kind === b.kind ? 0 : a.kind === 'switch' ? -1 : b.kind === 'switch' ? 1 : 0)
    || (a.kind === 'switch' && b.kind === 'switch' ? a.switchIndex - b.switchIndex : a.frame - b.frame
      || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0) || a.index - b.index));
  return migrateTimelineOperationSequence(data, entries.map(entry => entry.id));
}
