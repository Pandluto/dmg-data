import assert from 'node:assert/strict';
import type { AkeRealtimeCommand, AkeRealtimeHit } from '../../integrations/ake/akeRealtimeTimeline';
import { hitsEligibleForReleaseSnap } from './hooks/useCanvasDrag';

const hits = [
  { id: 'normal-hit', commandId: 'normal', frame: 10 },
  { id: 'ultimate-hit', commandId: 'ultimate', frame: 12 },
] as AkeRealtimeHit[];
const commands = [
  { commandId: 'normal', commandType: 'NormalSkill' },
  { commandId: 'ultimate', commandType: 'UltimateSkill' },
] as AkeRealtimeCommand[];

assert.deepEqual(
  hitsEligibleForReleaseSnap({ commands, hits }).map(hit => hit.id),
  ['normal-hit'],
  'ultimate damage settlements never become combo/release snap points',
);
