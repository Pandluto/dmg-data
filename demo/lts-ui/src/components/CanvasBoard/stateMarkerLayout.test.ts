import assert from 'node:assert/strict';
import { layoutStateMarkers, markerRectsOverlap, stateBadgeRuns, stateMarkerIntervals,
  STATE_BADGE_SIZE, type StateMarkerAnchor, type StateMarkerSpace } from './stateMarkerLayout';
const event = (key:string, frame:number, x:number, ownerRight:number, ownerCommandId=key):StateMarkerAnchor =>
  ({key,frame,x,sequence:frame,width:STATE_BADGE_SIZE,ownerRight,ownerCommandId});
const space:StateMarkerSpace={left:40,top:50,width:700,height:55,preferredTop:50,
  obstacles:[{left:40,top:50,width:56,height:24},{left:210,top:50,width:56,height:24}]};
const input=[event('ice-1',23,76.8,96,'battle-1'),event('ice-2',126,215,266,'battle-2'),
  event('consumed',206,600,420,'combo')];
const groups=layoutStateMarkers(input,space);
assert.equal(groups.length,3);
for(const group of groups){
  assert.equal(group.top,50,'all statuses, including consumption, have one fixed height');
  assert.ok(group.left>=group.events[0].ownerRight!,'a status is after its responsible action');
  assert.ok(space.obstacles.every(o=>!markerRectsOverlap(group,o)));
}
assert.equal(groups[0].left,100,'first battle gets its right-side status slot');
assert.equal(groups[1].left,270,'second battle is not confused with the preceding combo');
assert.equal(groups[2].left,424,'consumption follows the consumer, not the earlier provider');
assert.equal(groups[2].events[0].x,600,'the lower time anchor survives a source-relative upper position');
assert.deepEqual(groups,layoutStateMarkers(input,space));
const crowded=layoutStateMarkers([input[0]],{...space,obstacles:[...space.obstacles,{left:100,top:50,width:30,height:20}]});
assert.equal(crowded[0].top,50,'horizontal obstruction cannot push the badge below');
assert.equal(crowded[0].left,134,'continue right at the same height');
const simultaneous=layoutStateMarkers([event('ice',1,100,96,'battle'),event('breach',1,100,96,'battle')],space);
assert.equal(simultaneous.length,1);
assert.equal(simultaneous[0].width,42,'same-owner same-frame status icons stay together');
const overflow=layoutStateMarkers(input,{...space,width:30});
assert.deepEqual(overflow.flatMap(g=>g.events).map(e=>e.key),input.map(e=>e.key));
assert.ok(overflow.every(g=>g.top===50),'even an explicit overflow cannot create a second height');
const status = (key:string, before:number, after:number, sequence:number, frame=148, buffId='breach') => ({
  key, before, after, sequence, frame, buffId, commandId:'combo-2', scope:'enemy',
});
const records = [status('fire-clear',1,0,1,148,'fire'),status('breach-2',1,2,2),status('breach-3',2,3,3)];
assert.deepEqual(stateBadgeRuns(records).map(run=>run.map(e=>e.key)),[['fire-clear'],['breach-2','breach-3']]);
assert.equal(stateBadgeRuns([status('clear',4,0,1),status('apply',0,1,2)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),status('b',2,3,2,149)]).length,2);
assert.equal(stateBadgeRuns([status('a',1,2,1),{...status('b',2,3,2),commandId:'different-cast'}]).length,2);
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
console.log('fixed status row: ownership, consumption, horizontal collision, chronology, overflow and lifetime semantics passed');

const captionOnly=layoutStateMarkers([input[0]],{...space,obstacles:[...space.obstacles,
  {left:90,top:30,width:160,height:18}]});
assert.equal(captionOnly[0].left,100,'the separate start-caption row cannot block fixed-height status slots');
const bounded=layoutStateMarkers([{...input[0],ownerLimit:115}],space);
assert.ok(bounded[0].overflow,'no room in the owner slot is explicit; do not pretend a following action owns it');
