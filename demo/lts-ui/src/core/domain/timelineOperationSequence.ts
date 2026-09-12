import type { TimelineData } from '../../types';

export type TimelineOperationSequence = NonNullable<TimelineData['operationSequence']>;

export function timelineOperationIds(data: TimelineData): string[] {
  return data.staffLines.flatMap(line => line.buttons.map(button => button.id));
}

function uniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) {
      throw new Error(`INVALID_OPERATION_SEQUENCE: ${label} contains invalid or duplicate identity ${id}`);
    }
    seen.add(id);
  }
}

/** Strict read: declared v1 data is never repaired by appending unknown IDs. */
export function validateTimelineOperationSequence(data: TimelineData): TimelineOperationSequence {
  const sequence = data.operationSequence;
  if (!sequence || sequence.schemaVersion !== 1 || !Array.isArray(sequence.operationIds)) {
    throw new Error('INVALID_OPERATION_SEQUENCE: expected schemaVersion 1 and operationIds');
  }
  const actual = timelineOperationIds(data);
  uniqueIds(actual, 'timeline');
  uniqueIds(sequence.operationIds, 'sequence');
  const expected = new Set(actual);
  if (actual.length !== sequence.operationIds.length || sequence.operationIds.some(id => !expected.has(id))) {
    throw new Error('INVALID_OPERATION_SEQUENCE: sequence must contain every operation exactly once');
  }
  return sequence;
}

/** The legacy adapter must supply proven ordering, never the current projection. */
export function migrateTimelineOperationSequence(data: TimelineData, legacyOrder?: readonly string[]): TimelineData {
  if (data.operationSequence !== undefined) {
    validateTimelineOperationSequence(data);
    return data;
  }
  if (!legacyOrder && timelineOperationIds(data).length) {
    throw new Error('LEGACY_OPERATION_ORDER_REQUIRED: nonempty legacy timeline requires the legacy adapter');
  }
  const migrated: TimelineData = { ...data, operationSequence: { schemaVersion: 1, operationIds: [...(legacyOrder ?? [])] } };
  validateTimelineOperationSequence(migrated);
  return migrated;
}

/** Apply one known business edit to an already migrated snapshot. */
export function editTimelineOperationSequence(
  before: TimelineData,
  after: TimelineData,
  edit: { append?: readonly string[]; remove?: readonly string[] },
): TimelineData {
  const sequence = validateTimelineOperationSequence(before);
  const append = edit.append ?? [];
  const remove = edit.remove ?? [];
  uniqueIds(append, 'append');
  uniqueIds(remove, 'remove');
  const existing = new Set(sequence.operationIds);
  if (append.some(id => existing.has(id)) || remove.some(id => !existing.has(id))) {
    throw new Error('INVALID_OPERATION_SEQUENCE_EDIT: operation identity does not match edit');
  }
  const removed = new Set(remove);
  const result: TimelineData = { ...after, operationSequence: {
    schemaVersion: 1, operationIds: [...sequence.operationIds.filter(id => !removed.has(id)), ...append],
  } };
  validateTimelineOperationSequence(result);
  return result;
}

export function timelineOperationOrder(data: TimelineData): ReadonlyMap<string, number> {
  return new Map(validateTimelineOperationSequence(data).operationIds.map((id, order) => [id, order]));
}

export function requireTimelineOperationOrder(orders: ReadonlyMap<string, number>, id: string): number {
  const order = orders.get(id);
  if (order === undefined) throw new Error(`OPERATION_ORDER_MISSING: ${id}`);
  return order;
}

export function draftTimelineOperationOrder(sequence: TimelineOperationSequence | undefined, id: string): number {
  if (!sequence) throw new Error('OPERATION_SEQUENCE_REQUIRED_FOR_DRAFT');
  const existing = sequence.operationIds.indexOf(id);
  return existing < 0 ? sequence.operationIds.length : existing;
}
