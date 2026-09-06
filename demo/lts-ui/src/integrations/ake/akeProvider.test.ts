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

// The browser keeps a semantic source across projection changes. Neither the
// runtime window's ordinal id nor a preview action-end frame is an execution key.
const releasePreview = {
  commands: [{ commandId: 'source', commandType: 'ComboSkill', profile: {
    hits: [{ kind: 'direct', offsetFrames: 47, sourceSkillId: 'combo', sourceTimelineFrame: 47 }],
  } }],
  sharedVariableRateTimeline: null,
};
const { resolveAkeReleaseDependency } = await import('./akeProvider');
assert.deepEqual(resolveAkeReleaseDependency({ releaseAnchor: {
  schemaVersion: 1, kind: 'action-end', sourceButtonId: 'source', debounceFrames: 3,
} }, releasePreview), { kind: 'action-end', sourceCommandId: 'source', delayFrames: 3 });
assert.deepEqual(resolveAkeReleaseDependency({ releaseAnchor: {
  schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'source',
  sourceHitId: 'source:preview-hit:0', sourceHitOffsetFrames: 47, debounceFrames: 6,
} }, releasePreview), { kind: 'damage-hit', sourceCommandId: 'source', delayFrames: 6,
  sourceSkillId: 'combo', sourceTimelineFrame: 47 });
const precisionAnchor = { schemaVersion: 1 as const, kind: 'timed-input' as const,
  sourceButtonId: 'source', sourceTimedInputId: 'observed-window:17',
  sourceTimedInputOffsetFrames: 57, debounceFrames: 0,
  sourceTimedInputKind: 'precision' as const, sourceTimedInputSkillId: 'combo',
  sourceTimedInputStartOffsetFrames: 52, sourceTimedInputEndOffsetFramesExclusive: 64 };
const precisionDependency = resolveAkeReleaseDependency({ releaseAnchor: precisionAnchor }, releasePreview);
assert.deepEqual(precisionDependency, { kind: 'timed-input', sourceCommandId: 'source',
  delayFrames: 0, sourceOffsetFrames: 57, windowKind: 'precision', sourceSkillId: 'combo',
  windowStartOffsetFrames: 52, windowEndOffsetFramesExclusive: 64 });
assert.deepEqual(resolveAkeReleaseDependency({ releaseAnchor: {
  ...precisionAnchor, sourceTimedInputId: 'observed-window:99',
} }, releasePreview), precisionDependency, 'a different run window ordinal cannot move the input');
assert.equal(resolveAkeReleaseDependency({ releaseAnchor: {
  schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'source',
  sourceHitOffsetFrames: 47, debounceFrames: 0,
} }, { ...releasePreview, commands: [{ ...releasePreview.commands[0], commandType: 'UltimateSkill' }] }), undefined,
'adding the lens must not open all ultimate damage ticks as release ports');
