import assert from 'node:assert/strict';
import { adjustStateMarkerRows, layoutStateMarkers, markerRectsOverlap, stateBadgeRuns, stateMarkerIntervals, STATE_BADGE_GAP, STATE_BADGE_SIZE, type StateMarkerAnchor, type StateMarkerSpace } from './stateMarkerLayout';
const event = (key: string, frame: number, x: number, sequence = 0): StateMarkerAnchor => ({ key, frame, x, sequence, width: STATE_BADGE_SIZE });
const fixture = [event('fire-consumed',148,382,1),event('breach-3',148,382,3),
  event('fire-applied',541,825),event('breach-expired',748,846)];
const space: StateMarkerSpace = { left:40, top:50, width:1120, height:55, preferredTop:81,
  obstacles:[{left:356,top:78,width:80,height:27},{left:815,top:76,width:38,height:16}] };
const assertFits = (input: StateMarkerAnchor[], area = space) => {
  const result = layoutStateMarkers(input,area);
  assert.deepEqual(result.flatMap(group=>group.events).map(item=>item.key).sort(),input.map(item=>item.key).sort());
  result.forEach((group,i) => {
    assert.ok(group.overflow || (group.left>=area.left && group.left+group.width<=area.left+area.width));
    assert.ok(group.top>=area.top && group.top+group.height<=area.top+area.height);
    // A compact shelf may touch an obstacle/group edge, but rectangles must
    // never physically overlap when the normal four-pixel margin is full.
    assert.ok(area.obstacles.every(rect=>!markerRectsOverlap(group,rect)));
    assert.ok(result.slice(i+1).every(other=>!markerRectsOverlap(group,other)));
  });
  return result;
};
const placed = assertFits(fixture);
assert.ok(placed.some(group=>group.top!==space.preferredTop), 'find vertical whitespace around the crowded event');
assert.deepEqual(placed,layoutStateMarkers(fixture,space),'placement is deterministic');

const sparseSpace: StateMarkerSpace = { left:40, top:50, width:1120, height:55, preferredTop:50, obstacles:[] };
const rightUpper = assertFits([event('right-upper',10,500)], sparseSpace);
assert.equal(rightUpper.length,1);
assert.equal(rightUpper[0].left,490, 'keep the marker centered on the real event anchor');
assert.equal(rightUpper[0].top,sparseSpace.top, 'prefer the top of the current lane');
const sameFrame = assertFits([event('attach',20,500,1),event('breach',20,500,2)], sparseSpace);
assert.equal(sameFrame.length,1, 'same-frame state changes share one tray');
assert.equal(sameFrame[0].width,STATE_BADGE_SIZE * 2 + STATE_BADGE_GAP, 'same-frame badges use the compact tray gap');
assert.equal(sameFrame[0].left,479, 'same-frame tray remains centered on the event anchor');
assertFits([event('left-a',0,40),event('left-b',1,42),event('right-a',10,1159),event('right-b',11,1160)]);
const dense = assertFits(Array.from({length:100},(_,i)=>event(`dense-${i}`,148,400,i)));
assert.ok(dense.some(group=>group.collapsed));
const full = {...space,obstacles:[{left:40,top:50,width:1120,height:55}]};
const fallback = layoutStateMarkers(fixture,full);
assert.equal(fallback.length,1);
assert.ok(fallback[0].collapsed && fallback[0].left + fallback[0].width < full.left);
assert.equal(fallback[0].events.length,fixture.length);
const sealed = layoutStateMarkers([event('sealed-single',148,500)], {
  ...sparseSpace,
  obstacles:[{left:-100,top:50,width:1300,height:55}],
});
assert.deepEqual(sealed.flatMap(group => group.events).map(item => item.key), ['sealed-single']);
assert.equal(sealed.length,1, 'a fully sealed lane still retains one record');
assert.equal(sealed[0].collapsed,false, 'a single overflow record keeps its normal badge');
assert.ok(sealed[0].overflow, 'the retained single badge is explicitly marked as overflow');
const cardAdjustedBase = layoutStateMarkers([event('carded',10,500)], sparseSpace);
const cardAdjusted = adjustStateMarkerRows(cardAdjustedBase, sparseSpace,
  [{left:490,top:50,width:20,height:20}]);
assert.equal(cardAdjusted[0].left, cardAdjustedBase[0].left, 'reading card avoidance never changes x');
assert.notEqual(cardAdjusted[0].top, cardAdjustedBase[0].top, 'reading card avoidance may change y');
assert.ok(!markerRectsOverlap(cardAdjusted[0], {left:490,top:50,width:20,height:20}), 'adjusted marker clears the card');
assert.equal(layoutStateMarkers([],space).length,0);
const delayed = layoutStateMarkers([{...event('delayed',400,800)}],
  {...space,obstacles:[]})[0];
assert.equal(delayed.left,790,'delayed status stays at its event-time x, not the source skill button');
assert.equal(delayed.top,81,'badge uses the status lane rather than the skill icon layer');
assert.equal(delayed.events[0].x,800,'the leader retains the actual effect-time anchor');
const status = (key:string, before:number, after:number, sequence:number, frame=148, buffId='breach') => ({
  key, before, after, sequence, frame, buffId, commandId:'combo-2', scope:'enemy',
});
const records = [status('fire-clear',1,0,1,148,'fire'),status('breach-2',1,2,2),status('breach-3',2,3,3)];
assert.deepEqual(stateBadgeRuns(records).map(run=>run.map(e=>e.key)),[['fire-clear'],['breach-2','breach-3']]);
assert.equal(stateBadgeRuns([status('clear',4,0,1),status('apply',0,1,2)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),status('b',2,3,2,149)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),{...status('b',2,3,2),commandId:'different-cast'}]).length,1);
const intervalState = (key: string, frame: number, sequence: number, after: number, sourceId: string | null) => ({
  key, frame, sequence, after, before: after - 1, buffId: 'ice', scope: 'enemy', sourceId,
});
const intervals = stateMarkerIntervals([
  intervalState('f137', 137, 1, 3, 'actor-a'),
  intervalState('f194', 194, 2, 4, 'actor-b'),
  { ...intervalState('f206', 206, 3, 0, null), before: 4 },
], 240);
assert.deepEqual(intervals.map(interval => [interval.event.key, interval.fromFrame, interval.toFrame, interval.clipped]), [
  ['f137', 137, 194, false], ['f194', 194, 206, false],
], 'one global scope/buff stream closes across actor changes');
const clipped = stateMarkerIntervals([intervalState('last', 200, 1, 1, 'actor-a')], 220)[0];
assert.equal(clipped.toFrame,220);
assert.equal(clipped.clipped,true,'an unobserved end is marked as report-range clipping');
const expired = stateMarkerIntervals([{ ...intervalState('expires', 200, 1, 1, 'actor-a'), expireFrame: 215 }], 220)[0];
assert.equal(expired.toFrame,215);
assert.equal(expired.clipped,false,'an explicit expiry is a natural endpoint');
console.log('state badges: centered anchors, compact same-frame trays, vertical collisions, local overflow, transaction preservation and global intervals passed');

// Vertical space must win even when a horizontal neighbour is closer to the preferred row.
const verticalArea = {left:40, top:50, width:400, height:55, preferredTop:50,
  obstacles:[{left:190,top:50,width:20,height:20}]};
const verticalFirst = layoutStateMarkers([event('vertical-first',1,200)], verticalArea)[0];
assert.equal(verticalFirst.left + verticalFirst.width / 2,200);
const leftOnly = layoutStateMarkers([event('left-only',1,200)], {...verticalArea,
  obstacles:[{left:190,top:50,width:20,height:55}]} )[0];
assert.equal(leftOnly.left + leftOnly.width / 2,180, 'choose nearest left clearance, never the free right side');
const hiddenInk = {...sparseSpace, obstacles:[{left:480,top:74,width:60,height:31}]};
const readingOnlyInk = adjustStateMarkerRows(cardAdjustedBase,hiddenInk,[{left:490,top:50,width:20,height:30}]);
assert.equal(readingOnlyInk[0].left,cardAdjustedBase[0].left);
assert.ok(readingOnlyInk[0].top>=80, 'hidden ordinary text must not block a reading-only vertical shelf');
