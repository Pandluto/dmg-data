import assert from 'node:assert/strict';
import {
  collectVisibleOperationCenters,
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

const readingCard = {
  getBoundingClientRect: () => ({ left: 140, top: 240, right: 220, bottom: 270, width: 80, height: 30 }),
};
const readingButton = {
  dataset: { skillButtonId: 'reading-card' },
  querySelector: (selector: string) => {
    assert.match(selector, /skill-button-reading-card/);
    return readingCard;
  },
  getBoundingClientRect: () => ({ left: 100, top: 200, right: 300, bottom: 300, width: 200, height: 100 }),
};
const readingCanvas = {
  scrollLeft: 0,
  scrollTop: 0,
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 }),
  querySelectorAll: () => [readingButton],
};
assert.deepEqual(
  collectVisibleOperationCenters(
    readingCanvas as unknown as HTMLElement,
    new Set(['reading-card']),
  ).get('reading-card'),
  { x: 180, y: 255 },
  'reading selection uses the visible card center instead of the legacy orb position',
);

console.log('batch selection geometry passed');
