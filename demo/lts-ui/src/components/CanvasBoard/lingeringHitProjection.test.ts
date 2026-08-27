import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compactLingeringHitMarkers,
  isLowMultiplierHitMarker,
} from './lingeringHitProjection';

test('uses a dot only below the 80% multiplier boundary', () => {
  assert.equal(isLowMultiplierHitMarker(0.79), true);
  assert.equal(isLowMultiplierHitMarker(0.8), false);
  assert.equal(isLowMultiplierHitMarker(1), false);
  assert.equal(isLowMultiplierHitMarker(null), false);
});

test('keeps short lingering tails unchanged', () => {
  const candidates = [
    { id: 'direct', groupKey: 'skill', frame: 0, lingering: false },
    { id: 'dot-1', groupKey: 'skill', frame: 10, lingering: true },
    { id: 'dot-2', groupKey: 'skill', frame: 20, lingering: true },
    { id: 'dot-3', groupKey: 'skill', frame: 30, lingering: true },
  ];

  const result = compactLingeringHitMarkers(candidates, { threshold: 3, maxDots: 2 });

  assert.deepEqual(result.map((candidate) => candidate.id), candidates.map((candidate) => candidate.id));
  assert.equal(result.some((candidate) => candidate.compactLingering), false);
});

test('compacts only the long tail and preserves endpoints plus metadata', () => {
  const candidates = [
    { id: 'direct', groupKey: 'skill', frame: 0, lingering: false },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `dot-${index}`,
      groupKey: 'skill',
      frame: index + 1,
      lingering: true,
    })),
    { id: 'other', groupKey: 'other-skill', frame: 99, lingering: true },
  ];

  const result = compactLingeringHitMarkers(candidates, { threshold: 12, maxDots: 8 });
  const skillTail = result.filter((candidate) => candidate.groupKey === 'skill' && candidate.lingering);

  assert.equal(skillTail.length, 8);
  assert.equal(skillTail[0]?.id, 'dot-0');
  assert.equal(skillTail.at(-1)?.id, 'dot-19');
  assert.ok(skillTail.every((candidate) => candidate.compactLingering === true));
  assert.equal(skillTail[0]?.lingeringCount, 20);
  assert.equal(skillTail[0]?.lingeringStartFrame, 1);
  assert.equal(skillTail[0]?.lingeringEndFrame, 20);
  assert.equal(result.find((candidate) => candidate.id === 'direct')?.compactLingering, undefined);
  assert.equal(result.find((candidate) => candidate.id === 'other')?.compactLingering, undefined);
});
