import assert from 'node:assert/strict';

import { resolveAkeCalculationEndFrame } from './akeProvider';
import type { AkeRealtimeTimeline } from './akeRealtimeTimeline';

const timeline = {
  sharedVariableRateTimeline: {
    endFrame: 25,
    actions: [],
    waits: [{ endFrame: 478 }],
    laneWaits: [],
    operatorSwitches: [],
  },
} as unknown as Pick<AkeRealtimeTimeline, 'sharedVariableRateTimeline'>;

assert.equal(
  resolveAkeCalculationEndFrame(timeline),
  778,
  'a trailing fixed wait must remain inside the realtime settlement horizon',
);
