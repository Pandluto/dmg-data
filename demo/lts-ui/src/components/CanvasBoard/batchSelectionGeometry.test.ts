import assert from 'node:assert/strict';
import {
  normalizeBatchSelectionRect,
  selectOperationIdsByCenter,
} from './batchSelectionGeometry';

const rect = normalizeBatchSelectionRect({ startX: 80, startY: 60, x: 20, y: 10 });
assert.deepEqual(rect, { left: 20, top: 10, width: 60, height: 50 });

const selected = selectOperationIdsByCenter(rect, new Map([
  ['inside', { x: 20, y: 10 }],
  ['outside', { x: 81, y: 10 }],
  ['other', { x: 80, y: 60 }],
]));
assert.deepEqual(selected, ['inside', 'other']);

console.log('batch selection geometry passed');
