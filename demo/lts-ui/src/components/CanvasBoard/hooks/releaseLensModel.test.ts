import assert from 'node:assert/strict';
import { findSavedLensTarget, offsetReleaseLensPort, placeReleaseLens, releaseLensPage, selectReleaseLensPointer, type ReleaseLensPort, type ReleaseLensView } from './releaseLensModel';

function port(id: string, frame: number): ReleaseLensPort {
  return { eventFrame: frame, label: id, target: { staffIndex: 0, sourceGroupIndex: 0, lineIndex: 0,
    nodeIndex: 1, markerX: 50, frame: frame + 6, anchorId: id, label: id,
    anchor: { schemaVersion: 1, kind: 'damage-hit', sourceButtonId: 'source', sourceHitOffsetFrames: frame - 100, debounceFrames: 6 } } };
}
const hit = port('hit-2', 120);
const original = JSON.stringify(hit);
const adjusted = offsetReleaseLensPort(hit, 3).target;
assert.equal(adjusted?.frame, 123);
assert.equal(adjusted?.anchor.sourceHitOffsetFrames, 20);
assert.equal(adjusted?.anchor.debounceFrames, 3);
assert.equal(JSON.stringify(hit), original, 'a draft must not mutate saved candidates');
assert.equal(offsetReleaseLensPort(hit, 0).target?.frame, 120);
assert.equal(offsetReleaseLensPort(hit, -1).target, null);
assert.equal(offsetReleaseLensPort(hit, 1.5).target, null);

const precision: ReleaseLensPort = { ...port('precision',114), eventFrame: 114, minFrame: 114, maxFrameExclusive: 126,
  target: { ...hit.target, anchorId: 'precision', frame: 119, windowStartFrame: 114, windowEndFrameExclusive: 126,
    anchor: { schemaVersion: 1, kind: 'timed-input', sourceButtonId: 'source', sourceTimedInputId: 'shared',
      sourceTimedInputKind: 'precision', sourceTimedInputOffsetFrames: 57, debounceFrames: 0 } } };
assert.equal(offsetReleaseLensPort(precision, 5).target?.frame,119);
assert.equal(offsetReleaseLensPort(precision, 5).target?.anchor.sourceTimedInputOffsetFrames,52);
assert.equal(offsetReleaseLensPort(precision, 11).target?.frame,125);
assert.equal(offsetReleaseLensPort(precision, 12).target,null,'right endpoint is excluded');
const broad = { ...precision.target, anchorId: 'broad', frame:102, windowStartFrame:102, windowEndFrameExclusive:142,
  anchor: { ...precision.target.anchor, sourceTimedInputKind: 'broad' as const, sourceTimedInputOffsetFrames:40 } };
const legacy = { ...precision.target.anchor, sourceTimedInputKind: undefined };
assert.equal(findSavedLensTarget([broad, precision.target],legacy)?.anchorId,'precision','shared old window ID must not silently choose broad');
assert.equal(findSavedLensTarget([broad, precision.target],{...legacy,sourceTimedInputOffsetFrames:40})?.anchorId,'broad');
assert.equal(findSavedLensTarget([precision.target],{...precision.target.anchor,sourceTimedInputStartOffsetFrames:48}),undefined,'changed window identity must not silently replace a saved event');
assert.equal(findSavedLensTarget([precision.target],{...precision.target.anchor,sourceTimedInputOffsetFrames:40}),undefined,'an old input before a moved window must not be clamped to its start');
assert.equal(findSavedLensTarget([hit.target],{...hit.target.anchor,sourceHitOffsetFrames:99}),undefined,'missing hit is not replaced');

const rect = placeReleaseLens({left:980,top:660,width:30,height:30},{width:1024,height:768});
assert(rect.left>=12 && rect.left+rect.width<=1012 && rect.top+rect.height<=756);
const view: ReleaseLensView = { session: { sourceButtonId:'source', sourceName:'Source', rect:{left:20,top:20,width:520,height:276},
  sourceRect:{left:40,top:0,width:24,height:24}, ports:[port('first',120),port('same-frame',120),port('third',150)],hits:[],tickRate:30 },
  selectedId:'first',offsetFrames:6,target:hit.target,reason:null,note:'',editing:false };
const page=releaseLensPage(view);
assert.notEqual(page.positions[0].y,page.positions[1].y);
assert.equal(selectReleaseLensPointer(view,20+page.positions[1].x,20+page.positions[1].y)?.id,'same-frame');
for(let f=120;f<=page.to;f++) assert.equal(page.frameAt(page.x(f)),f,'dense display mapping preserves every integer frame');
assert.equal(releaseLensPage({...view,offsetFrames:3}).x(130),page.x(130),'offset changes do not move event targets');
