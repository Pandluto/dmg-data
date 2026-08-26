import assert from 'node:assert/strict';
import type {
  AkeRealtimeCommand,
  AkeRealtimeHit,
  AkeRealtimeTimeline,
} from '../../integrations/ake/akeRealtimeTimeline';
import {
  hitsEligibleForReleaseSnap,
  isComboReleaseFrameAvailable,
} from './hooks/useCanvasDrag';

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

const comboTimeline = {
  verifiedComboSkills: [{ characterId: 'pelica', skillId: 'pelica-combo' }],
  comboWindows: [{
    id: 'window',
    ruleId: 'pelica-heavy',
    characterId: 'pelica',
    skillId: 'pelica-combo',
    sourceCommandId: 'zhuang-heavy',
    createdFrame: 93,
    expireFrame: 273,
    consumedFrame: null,
    consumedCommandId: null,
    state: 'expired',
    reason: 'WINDOW_EXPIRED',
  }],
} as Pick<AkeRealtimeTimeline, 'verifiedComboSkills' | 'comboWindows'>;

assert.equal(isComboReleaseFrameAvailable({
  timeline: comboTimeline,
  characterId: 'pelica',
  skillId: 'pelica-combo',
  movingCommandId: null,
  frame: 100,
}), true, 'historically expired windows still expose anchors that were legal inside their interval');
assert.equal(isComboReleaseFrameAvailable({
  timeline: comboTimeline,
  characterId: 'pelica',
  skillId: 'pelica-combo',
  movingCommandId: null,
  frame: 273,
}), false, 'the expiry frame itself is not a legal combo release point');
assert.equal(isComboReleaseFrameAvailable({
  timeline: comboTimeline,
  characterId: 'unverified-operator',
  skillId: 'unknown-combo',
  movingCommandId: null,
  frame: 0,
}), true, 'unverified combo skills remain editable instead of being falsely hard-gated');

comboTimeline.comboWindows[0].state = 'consumed';
comboTimeline.comboWindows[0].consumedCommandId = 'existing-combo';
assert.equal(isComboReleaseFrameAvailable({
  timeline: comboTimeline,
  characterId: 'pelica',
  skillId: 'pelica-combo',
  movingCommandId: 'existing-combo',
  frame: 100,
}), true, 'moving the consuming command can keep its own trigger window');
assert.equal(isComboReleaseFrameAvailable({
  timeline: comboTimeline,
  characterId: 'pelica',
  skillId: 'pelica-combo',
  movingCommandId: null,
  frame: 100,
}), false, 'a second combo command cannot reuse a consumed window');
