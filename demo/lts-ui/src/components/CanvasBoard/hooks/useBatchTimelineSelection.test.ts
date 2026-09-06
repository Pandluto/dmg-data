import assert from 'node:assert/strict';
import {
  isBatchSelectionClick,
  shouldExitBatchTimelineOnEscape,
  shouldResetBatchTimelineSelection,
} from './useBatchTimelineSelection';

assert.equal(shouldResetBatchTimelineSelection(null, 'timeline-a|team-a'), true);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-a|team-a'), false);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-b|team-a'), true);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-a|team-b'), true);

assert.equal(isBatchSelectionClick({ x: 100, y: 100 }, { x: 104, y: 100 }), true);
assert.equal(isBatchSelectionClick({ x: 100, y: 100 }, { x: 105, y: 100 }), false);
assert.equal(isBatchSelectionClick({ x: 100, y: 100 }, { x: 102, y: 103 }), true);
assert.equal(shouldExitBatchTimelineOnEscape(1, false), false);
assert.equal(shouldExitBatchTimelineOnEscape(0, true), false);
assert.equal(shouldExitBatchTimelineOnEscape(0, false), true);

console.log('Batch timeline selection reset key: PASS');
