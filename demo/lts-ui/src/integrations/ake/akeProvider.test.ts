import assert from 'node:assert/strict';

import {
  resolveAkeCalculationEndFrame,
  resolveAkeWeaponSkillLevels,
} from './akeProvider';
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

assert.deepEqual(
  resolveAkeWeaponSkillLevels(
    [{ role: 'primary' }, { role: 'passive' }],
    { skill1: 9, skill2: 8, skill3: 4 },
  ),
  { skill1: 9, skill2: 4, skill3: 4 },
  'a two-slot AKE weapon must receive the editor passive level in physical slot 2',
);

assert.deepEqual(
  resolveAkeWeaponSkillLevels(
    [{ role: 'primary' }, { role: 'secondary' }, { role: 'passive' }],
    { skill1: 7, skill2: 6, skill3: 3 },
  ),
  { skill1: 7, skill2: 6, skill3: 3 },
  'a three-slot AKE weapon keeps the semantic editor order',
);
