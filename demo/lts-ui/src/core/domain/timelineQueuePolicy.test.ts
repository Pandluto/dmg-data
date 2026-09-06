import assert from 'node:assert/strict';
import { getTimelineDeleteBlockReason } from './timelineQueuePolicy';

const source = { id: 'source', nodeIndex: 0 };
const early = { id: 'early', nodeIndex: 3, releaseAnchor: {
  schemaVersion: 1 as const, kind: 'action-start' as const, sourceButtonId: 'source', debounceFrames: 60,
} };
const late = { ...early, id: 'late', nodeIndex: 17 };
const timeline = { staffLines: [{ buttons: [source] }, { buttons: [late, early] }] };

// Real failure shape: both skills refer to the same start. The earlier one is
// a graph leaf, but is still in the middle of its operator's queue.
assert.match(getTimelineDeleteBlockReason(timeline, 'early') ?? '', /队列末尾/);
assert.equal(getTimelineDeleteBlockReason(timeline, 'late'), null);
assert.match(getTimelineDeleteBlockReason(timeline, 'source') ?? '', /依赖/);
const popped = { staffLines: [{ buttons: [source] }, { buttons: [early] }] };
assert.equal(getTimelineDeleteBlockReason(popped, 'early'), null);
assert.equal(getTimelineDeleteBlockReason({ staffLines: [{ buttons: [source] }] }, 'source'), null);
assert.match(getTimelineDeleteBlockReason(popped, 'missing') ?? '', /已不在/);

const bundle = { predecessorButtonId: 'source', successorButtonId: 'cut' };
assert.match(getTimelineDeleteBlockReason({ staffLines: [
  { buttons: [source] }, { buttons: [{ id: 'cut', nodeIndex: 0, basicAttackTailBundle: bundle }] },
] }, 'source') ?? '', /依赖/);
console.log('timeline queue tail deletion policy passed');
