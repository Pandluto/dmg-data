import assert from 'node:assert/strict';
import type {
  AkeRealtimeCommand,
  AkeRealtimeHit,
  AkeRealtimeTimeline,
} from '../../integrations/ake/akeRealtimeTimeline';
import {
  comboTimedInputCandidates,
  hitsEligibleForReleaseSnap,
  isComboReleaseFrameAvailable,
} from './hooks/useCanvasDrag';
import { buildReleaseSnapPoints } from '../../core/domain/releaseAnchorGraph';

const hits = [
  { id: 'normal-hit', commandId: 'normal', frame: 10, kind: 'direct' },
  { id: 'projectile-hit', commandId: 'normal', frame: 11, kind: 'projectile' },
  {
    id: 'status-dot-hit',
    commandId: 'normal',
    frame: 12,
    kind: 'direct',
    releaseEligible: false,
  },
  { id: 'lingering-hit', commandId: 'normal', frame: 300, kind: 'lingering' },
  { id: 'ultimate-hit', commandId: 'ultimate', frame: 12, kind: 'direct' },
] as AkeRealtimeHit[];
const commands = [
  { commandId: 'normal', commandType: 'NormalSkill' },
  { commandId: 'ultimate', commandType: 'UltimateSkill' },
] as AkeRealtimeCommand[];

assert.deepEqual(
  hitsEligibleForReleaseSnap({ commands, hits }).map(hit => hit.id),
  ['normal-hit', 'projectile-hit'],
  'only committed non-ultimate impacts become combo/release snap points',
);
assert.equal(
  buildReleaseSnapPoints({
    actions: [{
      id: 'normal',
      groupId: 'group',
      groupIndex: 0,
      startFrame: 0,
      endFrame: 30,
      startX: 0,
      endX: 30,
    }],
    hits: [{
      id: 'status-dot-hit',
      commandId: 'normal',
      frame: 12,
      offsetFrames: 12,
      releaseEligible: false,
    }],
    debounceFrames: 0,
    projectFrame: frame => frame,
  }).some(point => point.kind === 'damage-hit'),
  false,
  'the snap graph also rejects a status-derived hit when called directly',
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

const stagedComboTimeline = {
  verifiedComboSkills: [
    { characterId: 'wulfa', skillId: 'wulfa-combo-stage-1' },
    { characterId: 'wulfa', skillId: 'wulfa-combo-stage-2' },
  ],
  comboWindows: [{
    id: 'stage-1-window',
    ruleId: 'external-trigger',
    characterId: 'wulfa',
    skillId: 'wulfa-combo-stage-1',
    sourceCommandId: 'source',
    createdFrame: 10,
    expireFrame: 190,
    consumedFrame: 20,
    consumedCommandId: 'stage-1-command',
    state: 'consumed',
    reason: 'CAST_SUCCESS',
  }, {
    id: 'stage-2-window',
    ruleId: 'stage-transition',
    characterId: 'wulfa',
    skillId: 'wulfa-combo-stage-2',
    sourceCommandId: 'stage-1-command',
    createdFrame: 57,
    expireFrame: 237,
    consumedFrame: null,
    consumedCommandId: null,
    state: 'ready',
    reason: 'TRIGGER_MATCHED',
  }],
} as Pick<AkeRealtimeTimeline, 'verifiedComboSkills' | 'comboWindows'>;

assert.equal(isComboReleaseFrameAvailable({
  timeline: stagedComboTimeline,
  characterId: 'wulfa',
  movingCommandId: null,
  frame: 80,
}), true, 'one E intent can use the active stage-2 window after its base stage window was consumed');
assert.equal(isComboReleaseFrameAvailable({
  timeline: stagedComboTimeline,
  characterId: 'wulfa',
  skillId: 'wulfa-combo-stage-1',
  movingCommandId: null,
  frame: 80,
}), false, 'an explicitly stage-bound query still cannot reuse the consumed first-stage window');

const preciseComboWindow = {
  id: 'rossi-combo-window',
  ruleId: 'rossi-stage-2',
  characterId: 'wulfa',
  skillId: 'wulfa-combo-stage-2',
  sourceCommandId: 'rossi-stage-1',
  createdFrame: 100,
  expireFrame: 220,
  consumedFrame: null,
  consumedCommandId: null,
  state: 'ready',
  reason: 'TRIGGER_MATCHED',
  precisionWindow: {
    startFrame: 115,
    endFrameExclusive: 127,
    resolvedFrame: null,
    resolvedCommandId: null,
    state: 'upcoming',
    boundary: 'start-inclusive-end-exclusive',
    sourceActionType: 'ShowComboRingQte',
    sourceBuffId: 'buff_qte',
  },
} as AkeRealtimeTimeline['comboWindows'][number];
const comboCandidates = comboTimedInputCandidates({
  comboWindows: [preciseComboWindow],
} as AkeRealtimeTimeline, null);
assert.deepEqual(
  comboCandidates.map(candidate => [candidate.label, candidate.startFrame, candidate.endFrameExclusive]),
  [['非精准连携', 100, 221], ['精准连携', 115, 127]],
  'a precise AKE combo must expose both the broad and precision release choices',
);
