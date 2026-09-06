import type { SkillButtonData, TimelineData } from '../../types';
import { getTimelineDeleteBlockReason } from './timelineQueuePolicy';

export type TimelineBatchRemovalPlan =
  | {
      ok: true;
      selectedButtonIds: string[];
      removalOrder: string[];
      timelineData: TimelineData;
    }
  | {
      ok: false;
      selectedButtonIds: string[];
      blockedButtonId: string | null;
      reason: string;
      timelineData: TimelineData;
    };

function clearBasicAttackTailFields<T extends Pick<SkillButtonData, 'basicAttackStageCount' | 'basicAttackTailBundle'>>(
  button: T,
): T {
  const next = { ...button };
  delete next.basicAttackStageCount;
  delete next.basicAttackTailBundle;
  return next;
}

/**
 * Apply the same logical side effects as one legal remove, without touching
 * persistence. The batch planner uses this only on its private queue copy.
 */
export function simulateTimelineButtonRemoval(timelineData: TimelineData, buttonId: string): TimelineData {
  const button = timelineData.staffLines
    .flatMap((line) => line.buttons)
    .find((candidate) => candidate.id === buttonId);
  const tailPeerId = button?.basicAttackTailBundle
    ? button.basicAttackTailBundle.predecessorButtonId === buttonId
      ? button.basicAttackTailBundle.successorButtonId
      : button.basicAttackTailBundle.predecessorButtonId
    : null;

  return {
    ...timelineData,
    staffLines: timelineData.staffLines.map((line) => {
      const buttons = line.buttons
        .filter((candidate) => candidate.id !== buttonId)
        .map((candidate) => candidate.id === tailPeerId
          ? clearBasicAttackTailFields(candidate)
          : candidate);
      return {
        ...line,
        buttons,
        occupiedNodes: [...new Set(buttons.map((candidate) => candidate.nodeIndex))]
          .filter((nodeIndex) => Number.isFinite(nodeIndex) && nodeIndex >= 0)
          .sort((left, right) => left - right),
      };
    }),
  };
}

/**
 * Plan a batch as a sequence of ordinary legal tail removals.
 *
 * The order is deliberately discovered by repeatedly calling the existing
 * single-button policy on the latest simulated queue. This handles same-frame
 * actions, cross-character release dependencies, and basic-attack tail bundles
 * without replacing queue semantics with a pixel or array-order heuristic.
 */
export function planTimelineBatchRemoval(
  timelineData: TimelineData,
  buttonIds: readonly string[],
): TimelineBatchRemovalPlan {
  const selectedButtonIds = Array.from(new Set(buttonIds.filter((buttonId): buttonId is string => (
    typeof buttonId === 'string' && buttonId.length > 0
  ))));

  if (selectedButtonIds.length === 0) {
    return {
      ok: false,
      selectedButtonIds,
      blockedButtonId: null,
      reason: '请先框选要删除的动作。',
      timelineData,
    };
  }

  let simulatedTimeline = timelineData;
  const pending = new Set(selectedButtonIds);
  const removalOrder: string[] = [];

  while (pending.size > 0) {
    const removableButtonId = selectedButtonIds.find((buttonId) => (
      pending.has(buttonId)
      && getTimelineDeleteBlockReason(simulatedTimeline, buttonId) === null
    ));

    if (!removableButtonId) {
      const blockedButtonId = selectedButtonIds.find((buttonId) => pending.has(buttonId)) ?? null;
      const reason = blockedButtonId
        ? getTimelineDeleteBlockReason(simulatedTimeline, blockedButtonId)
          ?? '该动作当前无法批量删除。'
        : '所选动作当前无法批量删除。';
      return {
        ok: false,
        selectedButtonIds,
        blockedButtonId,
        reason,
        timelineData: simulatedTimeline,
      };
    }

    simulatedTimeline = simulateTimelineButtonRemoval(simulatedTimeline, removableButtonId);
    pending.delete(removableButtonId);
    removalOrder.push(removableButtonId);
  }

  return {
    ok: true,
    selectedButtonIds,
    removalOrder,
    timelineData: simulatedTimeline,
  };
}
