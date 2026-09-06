import assert from 'node:assert/strict';
import { layoutStateMarkers, markerRectsOverlap, stateBadgeRuns, STATE_BADGE_SIZE, type StateMarkerAnchor, type StateMarkerSpace } from './stateMarkerLayout';
const event = (key: string, frame: number, x: number, sequence = 0): StateMarkerAnchor => ({ key, frame, x, sequence, width: STATE_BADGE_SIZE });
const fixture = [event('fire-consumed',148,382,1),event('breach-3',148,382,3),
  event('fire-applied',541,825),event('breach-expired',748,846)];
const space: StateMarkerSpace = { left:40, top:50, width:1120, height:55, preferredTop:81,
  obstacles:[{left:356,top:78,width:80,height:27},{left:815,top:76,width:38,height:16}] };
const assertFits = (input: StateMarkerAnchor[], area = space) => {
  const result = layoutStateMarkers(input,area);
  assert.deepEqual(result.flatMap(group=>group.events).map(item=>item.key).sort(),input.map(item=>item.key).sort());
  result.forEach((group,i) => {
    assert.ok(group.left>=area.left && group.left+group.width<=area.left+area.width);
    assert.ok(group.top>=area.top && group.top+group.height<=area.top+area.height);
    assert.ok(area.obstacles.every(rect=>!markerRectsOverlap(group,rect,3.9)));
    assert.ok(result.slice(i+1).every(other=>!markerRectsOverlap(group,other,3.9)));
  });
  return result;
};
const placed = assertFits(fixture);
assert.ok(placed.some(group=>group.top!==space.preferredTop), 'find vertical whitespace around the crowded event');
assert.deepEqual(placed,layoutStateMarkers(fixture,space),'placement is deterministic');
assertFits([event('left-a',0,40),event('left-b',1,42),event('right-a',10,1159),event('right-b',11,1160)]);
const dense = assertFits(Array.from({length:100},(_,i)=>event(`dense-${i}`,148,400,i)));
assert.ok(dense.some(group=>group.collapsed));
const full = {...space,obstacles:[{left:40,top:50,width:1120,height:55}]};
const fallback = layoutStateMarkers(fixture,full);
assert.equal(fallback.length,1);
assert.ok(fallback[0].collapsed && fallback[0].left + fallback[0].width < full.left);
assert.equal(fallback[0].events.length,fixture.length);
assert.equal(layoutStateMarkers([],space).length,0);
const status = (key:string, before:number, after:number, sequence:number, frame=148, buffId='breach') => ({
  key, before, after, sequence, frame, buffId, commandId:'combo-2', scope:'enemy',
});
const records = [status('fire-clear',1,0,1,148,'fire'),status('breach-2',1,2,2),status('breach-3',2,3,3)];
assert.deepEqual(stateBadgeRuns(records).map(run=>run.map(e=>e.key)),[['fire-clear'],['breach-2','breach-3']]);
assert.equal(stateBadgeRuns([status('clear',4,0,1),status('apply',0,1,2)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),status('b',2,3,2,149)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),{...status('b',2,3,2),commandId:'different-cast'}]).length,2);
console.log('state badges: real collision anchors, whitespace, boundaries, dense fallback and transaction preservation passed');
