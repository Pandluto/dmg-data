import assert from 'node:assert/strict';
import { layoutStateMarkers, type StateMarkerAnchor } from './stateMarkerLayout';
const event = (key: string, frame: number, x: number, sequence = 0): StateMarkerAnchor => ({ key, frame, x, sequence, width: 44 });
const fixture = [event('fire-consumed',148,382,1),event('breach-2',148,382,2),event('breach-3',148,382,3),
  event('fire-applied',541,825),event('breach-expired',748,846)];
const groups = layoutStateMarkers(fixture,40,1160);
assert.equal(groups.length,2);
assert.deepEqual(groups[0].events.map(item=>item.key),['fire-consumed','breach-2','breach-3']);
assert.deepEqual(groups[1].events.map(item=>item.frame),[541,748]);
assert.ok(groups.every(group=>!group.collapsed));
const assertFits = (input: StateMarkerAnchor[]) => {
  const result = layoutStateMarkers(input,40,1160);
  assert.deepEqual(result.flatMap(group=>group.events).map(item=>item.key).sort(),input.map(item=>item.key).sort());
  for (let i=0;i<result.length;i++) {
    assert.ok(result[i].left>=40 && result[i].left+result[i].width<=1160);
    if(i) assert.ok(result[i-1].left+result[i-1].width+3<=result[i].left);
  }
  return result;
};
assertFits(fixture);
assertFits([event('left-a',0,40),event('left-b',1,42),event('right-a',10,1159),event('right-b',11,1160)]);
const dense = assertFits(Array.from({length:100},(_,i)=>event(`dense-${i}`,i,40+i*11)));
assert.ok(dense.some(group=>group.collapsed));
assert.equal(layoutStateMarkers([],40,1160).length,0);
console.log('state marker same-frame, compressed-time, edge and dense layouts passed');
