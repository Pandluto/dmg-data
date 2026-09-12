import assert from 'node:assert/strict';
import type { TimelineData } from '../../types';
import { editTimelineOperationSequence, migrateTimelineOperationSequence, timelineOperationOrder, validateTimelineOperationSequence } from './timelineOperationSequence';

const empty: TimelineData = { version: '1.2.0', createdAt: 1, updatedAt: 2, staffLines: [] };
const legacy: TimelineData = { ...empty, staffLines: [{ staffIndex: 0, characterName: 'A', occupiedNodes: [0], buttons: [
  { id: 'skill', characterName: 'A', skillType: 'B', staffIndex: 0, nodeIndex: 0, nodeNumber: 'A1', position: { x: 80, y: 90 } },
  { id: 'switch', characterName: 'A', skillType: 'Dot', staffIndex: 0, nodeIndex: 1, nodeNumber: 'A2', position: { x: 160, y: 90 }, timelineModuleKind: 'operator-switch' },
] }] };
const original = JSON.stringify(legacy);
const migrated = migrateTimelineOperationSequence(legacy, ['switch', 'skill']);
assert.equal(JSON.stringify(legacy), original);
assert.equal(migrated.updatedAt, 2);
assert.equal(migrateTimelineOperationSequence(migrated), migrated);
assert.deepEqual([...timelineOperationOrder(migrated)], [['switch', 0], ['skill', 1]]);
assert.throws(() => migrateTimelineOperationSequence(legacy), /LEGACY_OPERATION_ORDER_REQUIRED/);
for (const ids of [['skill'], ['skill', 'skill'], ['skill', 'unknown']]) {
  assert.throws(() => validateTimelineOperationSequence({ ...migrated, operationSequence: { schemaVersion: 1, operationIds: ids } }), /INVALID_OPERATION_SEQUENCE/);
}
const deleted = editTimelineOperationSequence(migrated, { ...migrated, staffLines: [] }, { remove: ['skill', 'switch'] });
assert.deepEqual(deleted.operationSequence?.operationIds, []);
const restored = JSON.parse(JSON.stringify(migrated));
assert.deepEqual(validateTimelineOperationSequence(restored), migrated.operationSequence);
const appended = editTimelineOperationSequence(migrateTimelineOperationSequence(empty), legacy, { append: ['skill', 'switch'] });
assert.deepEqual(appended.operationSequence?.operationIds, ['skill', 'switch']);
assert.throws(() => editTimelineOperationSequence(migrated, migrated, { append: ['skill'] }), /INVALID_OPERATION_SEQUENCE_EDIT/);
console.log('timeline operation sequence: strict identity, immutable migration, edit and snapshot roundtrip passed');
