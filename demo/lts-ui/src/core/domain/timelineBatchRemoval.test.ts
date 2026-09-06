import assert from 'node:assert/strict';
import type { SkillButtonData, TimelineData } from '../../types';
import { planTimelineBatchRemoval } from './timelineBatchRemoval';

function button(
  id: string,
  nodeIndex: number,
  extra: Partial<SkillButtonData> = {},
): SkillButtonData {
  return {
    id,
    characterId: extra.characterId ?? 'operator-1',
    characterName: extra.characterName ?? '干员一',
    skillType: extra.skillType ?? 'A',
    staffIndex: extra.staffIndex ?? 0,
    lineIndex: extra.lineIndex ?? 0,
    nodeIndex,
    nodeNumber: nodeIndex + 1,
    position: { x: nodeIndex * 80, y: 100 },
    ...extra,
  };
}

function timeline(lines: SkillButtonData[][]): TimelineData {
  return {
    version: '1.2.0',
    createdAt: 1,
    updatedAt: 1,
    staffLines: lines.map((buttons, staffIndex) => ({
      staffIndex,
      characterName: staffIndex === 0 ? '干员一' : '干员二',
      occupiedNodes: buttons.map((item) => item.nodeIndex),
      buttons,
    })),
  };
}

const tail = timeline([[button('early', 1), button('late', 4)]]);
const tailPlan = planTimelineBatchRemoval(tail, ['early', 'late']);
assert.equal(tailPlan.ok, true);
if (tailPlan.ok) {
  assert.deepEqual(tailPlan.removalOrder, ['late', 'early']);
  assert.equal(tailPlan.timelineData.staffLines[0].buttons.length, 0);
}

const mixedMiddle = timeline([[button('middle', 2), button('unselected-tail', 5)]]);
const mixedPlan = planTimelineBatchRemoval(mixedMiddle, ['middle']);
assert.equal(mixedPlan.ok, false);
if (!mixedPlan.ok) {
  assert.match(mixedPlan.reason, /队列末尾/);
  assert.equal(mixedPlan.timelineData.staffLines[0].buttons.length, 2);
}

const source = button('source', 3);
const dependent = button('dependent', 0, {
  characterId: 'operator-2',
  characterName: '干员二',
  staffIndex: 1,
  lineIndex: 1,
  releaseAnchor: {
    schemaVersion: 1,
    kind: 'action-start',
    sourceButtonId: 'source',
    debounceFrames: 0,
  },
});
const crossCharacter = timeline([[source], [dependent]]);
const dependencyPlan = planTimelineBatchRemoval(crossCharacter, ['source']);
assert.equal(dependencyPlan.ok, false);
if (!dependencyPlan.ok) assert.match(dependencyPlan.reason, /依赖/);

const dependencyBatchPlan = planTimelineBatchRemoval(crossCharacter, ['source', 'dependent']);
assert.equal(dependencyBatchPlan.ok, true);
if (dependencyBatchPlan.ok) assert.deepEqual(dependencyBatchPlan.removalOrder, ['dependent', 'source']);

const sameFrame = timeline([[button('same-a', 4)], [button('same-b', 4, {
  characterId: 'operator-2',
  characterName: '干员二',
  staffIndex: 1,
  lineIndex: 1,
})]]);
const sameFramePlan = planTimelineBatchRemoval(sameFrame, ['same-a', 'same-b']);
assert.equal(sameFramePlan.ok, true);

const predecessor = button('basic-predecessor', 0);
const successor = button('basic-successor', 1, {
  basicAttackTailBundle: {
    id: 'bundle-1',
    predecessorButtonId: predecessor.id,
    successorButtonId: 'basic-successor',
    selectedStageCount: 2,
    blockingEndOffsetFrames: 12,
    immutable: true,
    editPolicy: 'delete-successor-to-recompute',
  },
});
const bundled = timeline([[
  { ...predecessor, basicAttackTailBundle: successor.basicAttackTailBundle, basicAttackStageCount: 2 },
  successor,
]]);
const predecessorOnlyPlan = planTimelineBatchRemoval(bundled, [predecessor.id]);
assert.equal(predecessorOnlyPlan.ok, false);
const bundlePlan = planTimelineBatchRemoval(bundled, [predecessor.id, successor.id]);
assert.equal(bundlePlan.ok, true);
if (bundlePlan.ok) assert.deepEqual(bundlePlan.removalOrder, [successor.id, predecessor.id]);

console.log('timeline batch removal policy passed');
