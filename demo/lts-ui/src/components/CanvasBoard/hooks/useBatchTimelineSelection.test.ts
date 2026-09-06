import assert from 'node:assert/strict';
import { shouldResetBatchTimelineSelection } from './useBatchTimelineSelection';

assert.equal(shouldResetBatchTimelineSelection(null, 'timeline-a|team-a'), true);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-a|team-a'), false);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-b|team-a'), true);
assert.equal(shouldResetBatchTimelineSelection('timeline-a|team-a', 'timeline-a|team-b'), true);

console.log('Batch timeline selection reset key: PASS');
