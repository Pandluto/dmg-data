import type { SkillReleaseAnchor } from '../../types';

type QueueButton = {
  id: string;
  /** Persisted, global logical node; never a projected pixel or local column. */
  nodeIndex: number;
  releaseAnchor?: SkillReleaseAnchor;
  basicAttackTailBundle?: { predecessorButtonId: string; successorButtonId: string };
};
type QueueTimeline = { staffLines: readonly { buttons: readonly QueueButton[] }[] };

/** Each operator queue unwinds from its tail, including across visual wraps.
 * Explicit release dependencies can also prevent deleting another lane's tail.
 * A graph leaf is insufficient: several successive skills may share one source.
 */
export function getTimelineDeleteBlockReason(timeline: QueueTimeline, buttonId: string): string | null {
  const line = timeline.staffLines.find(candidate => candidate.buttons.some(button => button.id === buttonId));
  const button = line?.buttons.find(candidate => candidate.id === buttonId);
  if (!line || !button) return '该动作已不在当前队列中。';
  if (line.buttons.some(candidate => candidate.id !== buttonId && candidate.nodeIndex >= button.nodeIndex)) {
    return '只能从本角色队列末尾逐个删除，请先删除后面的动作。';
  }
  const follower = timeline.staffLines.flatMap(candidate => candidate.buttons).find(candidate => (
    candidate.id !== buttonId && (
      (candidate.releaseAnchor?.kind !== 'group-start' && candidate.releaseAnchor?.sourceButtonId === buttonId)
      || (candidate.basicAttackTailBundle?.predecessorButtonId === buttonId
        && candidate.basicAttackTailBundle.successorButtonId === candidate.id)
    )
  ));
  return follower ? '仍有其他动作依赖此接续点，请先从后面删除依赖动作。' : null;
}
