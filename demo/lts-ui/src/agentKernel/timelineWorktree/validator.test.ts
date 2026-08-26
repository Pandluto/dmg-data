import assert from 'node:assert/strict';
import { validateTimelinePayload } from './validator';
import type { TimelineSnapshotPayload } from '../../utils/timelineSnapshotStorage';

function validPayload(): TimelineSnapshotPayload {
  const button = {
    id: 'button-1',
    characterId: 'operator-1',
    characterName: '干员一',
    skillType: 'B' as const,
    staffIndex: 0,
    lineIndex: 0,
    nodeIndex: 16,
    nodeNumber: 17,
    position: { x: 1, y: 2 },
  };
  return {
    selectedCharacters: ['operator-1'],
    timelineData: {
      version: '1', createdAt: 1, updatedAt: 1,
      staffLines: [{ staffIndex: 0, characterName: '干员一', occupiedNodes: [16], buttons: [{ ...button, buffIds: [] }] }],
    },
    skillButtonTable: { 'button-1': { ...button, selectedBuff: [] } },
    allBuffList: [],
    anomalyStateSnapshots: [],
    characterInputMap: {},
    characterComputedMap: {},
    characterDisplayCacheMap: {},
    operatorConfigPageCache: {},
  };
}

assert.deepEqual(validateTimelinePayload(validPayload()), { ok: true, issues: [] });

const incomplete = validPayload();
incomplete.timelineData.staffLines[0].buttons[0] = { id: 'button-1', nodeIndex: 0, skillKey: 'operator-1-B' } as never;
incomplete.skillButtonTable['button-1'] = { id: 'button-1', nodeIndex: 0, skillKey: 'operator-1-B', selectedBuff: [] } as never;
const incompleteCodes = validateTimelinePayload(incomplete).issues.map((issue) => issue.code);
assert(incompleteCodes.includes('invalid-button-character-id'));
assert(incompleteCodes.includes('invalid-button-skill-type'));

const divergent = validPayload();
divergent.timelineData.staffLines[0].buttons[0].skillType = 'Q';
assert(validateTimelinePayload(divergent).issues.some((issue) => issue.code === 'timeline-button-table-identity-mismatch'));

const anchored = validPayload();
const rootAnchor = { schemaVersion: 1 as const, kind: 'group-start' as const, debounceFrames: 0 };
anchored.skillButtonTable['button-1'].releaseAnchor = rootAnchor;
anchored.timelineData.staffLines[0].buttons[0].releaseAnchor = rootAnchor;
const follower = {
  id: 'button-2',
  characterId: 'operator-1',
  characterName: '干员一',
  skillType: 'B' as const,
  staffIndex: 0,
  lineIndex: 0,
  nodeIndex: 17,
  nodeNumber: 18,
  position: { x: 2, y: 2 },
  releaseAnchor: {
    schemaVersion: 1 as const,
    kind: 'action-end' as const,
    sourceButtonId: 'button-1',
    debounceFrames: 0,
  },
};
anchored.timelineData.staffLines[0].buttons.push({ ...follower, buffIds: [] });
anchored.timelineData.staffLines[0].occupiedNodes.push(17);
anchored.skillButtonTable['button-2'] = { ...follower, selectedBuff: [] };
assert.deepEqual(validateTimelinePayload(anchored), { ok: true, issues: [] });

const dangling = structuredClone(anchored);
dangling.skillButtonTable['button-2'].releaseAnchor!.sourceButtonId = 'missing';
dangling.timelineData.staffLines[0].buttons[1].releaseAnchor!.sourceButtonId = 'missing';
assert(validateTimelinePayload(dangling).issues.some(issue => issue.code === 'release-anchor-source-missing'));

const cyclic = structuredClone(anchored);
cyclic.skillButtonTable['button-1'].releaseAnchor = {
  schemaVersion: 1,
  kind: 'action-end',
  sourceButtonId: 'button-2',
  debounceFrames: 0,
};
cyclic.timelineData.staffLines[0].buttons[0].releaseAnchor = cyclic.skillButtonTable['button-1'].releaseAnchor;
assert(validateTimelinePayload(cyclic).issues.some(issue => issue.code === 'release-anchor-cycle'));

const invalidWait = validPayload();
invalidWait.skillButtonTable['button-1'].timelineModuleKind = 'forced-wait';
invalidWait.timelineData.staffLines[0].buttons[0].timelineModuleKind = 'forced-wait';
invalidWait.skillButtonTable['button-1'].forcedWaitConfig = {
  schemaVersion: 1,
  mode: 'fixed-duration',
  durationSeconds: -1,
};
invalidWait.timelineData.staffLines[0].buttons[0].forcedWaitConfig =
  invalidWait.skillButtonTable['button-1'].forcedWaitConfig;
assert(validateTimelinePayload(invalidWait).issues.some(issue => issue.code === 'invalid-forced-wait-config'));

const ordinaryWait = validPayload();
ordinaryWait.skillButtonTable['button-1'].timelineModuleKind = 'lane-wait';
ordinaryWait.timelineData.staffLines[0].buttons[0].timelineModuleKind = 'lane-wait';
ordinaryWait.skillButtonTable['button-1'].laneWaitConfig = {
  schemaVersion: 1,
  mode: 'placeholder',
};
ordinaryWait.timelineData.staffLines[0].buttons[0].laneWaitConfig =
  ordinaryWait.skillButtonTable['button-1'].laneWaitConfig;
assert.deepEqual(validateTimelinePayload(ordinaryWait), { ok: true, issues: [] });

const invalidOrdinaryWait = structuredClone(ordinaryWait);
invalidOrdinaryWait.skillButtonTable['button-1'].laneWaitConfig = {
  schemaVersion: 1,
  mode: 'fixed-duration',
  durationSeconds: -1,
};
invalidOrdinaryWait.timelineData.staffLines[0].buttons[0].laneWaitConfig =
  invalidOrdinaryWait.skillButtonTable['button-1'].laneWaitConfig;
assert(validateTimelinePayload(invalidOrdinaryWait).issues.some(
  issue => issue.code === 'invalid-lane-wait-config',
));

console.log('Timeline payload validator identity contract: PASS');
