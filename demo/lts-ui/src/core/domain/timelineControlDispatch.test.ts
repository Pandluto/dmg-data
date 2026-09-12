import assert from 'node:assert/strict';
import { createTimelineControlDispatcher, probeTimelineControlPosition, type ControlOperation } from './timelineControlDispatch';

const operation = (id: string, operationOrder: number, extra: Partial<ControlOperation<string>> = {}): ControlOperation<string> => ({ id, operationOrder, frame: 20, value: id, ...extra });
for (const throughSkill of [false, true]) {
  const dispatcher = createTimelineControlDispatcher([
    operation('C', 1, { dependency: { sourceId: throughSkill ? 'S' : 'X', kind: throughSkill ? 'action-start' : 'action-end', delayFrames: 0 } }),
    operation('X', throughSkill ? 5 : 7, { targetLaneId: 'c' }),
    ...(throughSkill ? [operation('S', 7)] : []),
  ], 'p');
  const executed: string[] = [];
  let item;
  while ((item = dispatcher.take(20))) {
    executed.push(item.id);
    dispatcher.notifySource({ sourceId: item.id, kind: 'action-start', frame: 20 });
    if (item.id === 'X') dispatcher.notifySource({ sourceId: item.id, kind: 'action-end', frame: 20 });
  }
  assert.deepEqual(executed, throughSkill ? ['X', 'S', 'C'] : ['X', 'C']);
  assert.equal(dispatcher.positions.get('C')?.controllerBefore, 'c');
}
const batches = createTimelineControlDispatcher([
  operation('first-source', 5), operation('second-source', 7),
  operation('later-low-order', 0, { dependency: { sourceId: 'second-source', kind: 'action-start', delayFrames: 0 } }),
  operation('earlier-high-order', 9, { dependency: { sourceId: 'first-source', kind: 'action-start', delayFrames: 0 } }),
], 'p');
const actual: string[] = [];
let item;
while ((item = batches.take(20))) { actual.push(item.id); batches.notifySource({ sourceId: item.id, kind: 'action-start', frame: 20 }); }
assert.deepEqual(actual, ['first-source', 'second-source', 'earlier-high-order', 'later-low-order']);
console.log('control dispatcher: causal switches, independent switch visibility and ready batch FIFO passed');

{
  const flow = createTimelineControlDispatcher([
    operation('edit', 0, { frame: 10 }),
    operation('switch', 1, { targetLaneId: 'c' }),
  ], 'p');
  flow.take(10);
  flow.notifySource({ sourceId: 'edit', kind: 'action-start', frame: 10 });
  flow.take(20);
  flow.notifySource({ sourceId: 'switch', kind: 'action-end', frame: 20 });
  const edited = probeTimelineControlPosition(flow.trace, { ...operation('edit', 0), value: null,
    dependency: { sourceId: 'switch', kind: 'action-end', delayFrames: 0 } });
  assert.equal(edited?.frame, 20);
  assert.equal(edited?.controllerBefore, 'c', 'edited ID uses its new anchor, not its old dispatch');
}
