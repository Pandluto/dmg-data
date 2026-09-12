/** Plain ready queue. The existing preview supplies actual source events. */
export type ControlDependency = { sourceId: string; kind: 'action-start' | 'action-end' | 'damage-hit'; delayFrames: number; sourceOffsetFrames?: number; sourceHitId?: string };
export type ControlOperation<T> = { id: string; frame: number; operationOrder: number; targetLaneId?: string; dependency?: ControlDependency; value: T };
export type ControlDispatchPosition = { frame: number; dispatchOrdinal: number; controllerBefore: string | null; controllerAfter: string | null };
export type ControlSourceNotification = { sourceId: string; kind: ControlDependency['kind']; frame: number; sourceOffsetFrames?: number; sourceHitId?: string;
  phase?: 'before-ready' | 'inline' | 'after-ready' };
export type ControlDispatchTrace = { initialController: string | null; operations: ControlOperation<null>[]; steps: Array<
  { kind: 'source'; event: ControlSourceNotification } | { kind: 'take'; id: string; frame: number }
  | { kind: 'enqueue'; operation: ControlOperation<null>; frame: number }> };

export function createTimelineControlDispatcher<T>(operations: readonly ControlOperation<T>[], initial: string | null) {
  const pending = new Map(operations.filter(item => item.dependency).map(item => [item.id, item]));
  const ready: Array<{ operation: ControlOperation<T>; frame: number; sequence: number }> = [];
  const positions = new Map<string, ControlDispatchPosition>();
  let sequence = 0;
  let ordinal = 0;
  let controller = initial;
  const trace: ControlDispatchTrace = { initialController: initial,
    operations: operations.map(item => ({ ...item, value: null })), steps: [] };
  const enqueue = (operation: ControlOperation<T>, frame: number) => ready.push({ operation, frame, sequence: sequence++ });
  [...operations].filter(item => !item.dependency).sort((a, b) => a.frame - b.frame || a.operationOrder - b.operationOrder)
    .forEach(item => enqueue(item, item.frame));
  return {
    positions,
    trace,
    currentController: () => controller,
    enqueue(operation: ControlOperation<T>, frame: number) {
      trace.steps.push({ kind: 'enqueue', operation: { ...operation, value: null }, frame });
      enqueue(operation, frame);
    },
    peek() { return [...ready].sort((a, b) => a.frame - b.frame || a.sequence - b.sequence)[0]; },
    notifySource(event: ControlSourceNotification) {
      trace.steps.push({ kind: 'source', event });
      const batch = [...pending.values()].filter(item => item.dependency!.sourceId === event.sourceId
        && item.dependency!.kind === event.kind && (event.kind !== 'damage-hit'
          || (item.dependency!.sourceOffsetFrames === event.sourceOffsetFrames
            && (!item.dependency!.sourceHitId || item.dependency!.sourceHitId === event.sourceHitId))))
        .sort((a, b) => a.operationOrder - b.operationOrder);
      batch.forEach(item => { pending.delete(item.id); enqueue(item, event.frame + item.dependency!.delayFrames); });
    },
    take(frame: number) {
      ready.sort((a, b) => a.frame - b.frame || a.sequence - b.sequence);
      if (!ready.length || ready[0].frame > frame) return null;
      const token = ready.shift()!;
      trace.steps.push({ kind: 'take', id: token.operation.id, frame: token.frame });
      const before = controller;
      if (token.operation.targetLaneId) controller = token.operation.targetLaneId;
      positions.set(token.operation.id, { frame: token.frame, dispatchOrdinal: ordinal++, controllerBefore: before, controllerAfter: controller });
      return token.operation;
    },
    unresolvedOperationIds: () => [...pending.keys()],
  };
}

/** Replay only control tokens to place a non-mutating draft in the observed flow. */
export function probeTimelineControlPosition(trace: ControlDispatchTrace, candidate: ControlOperation<null>): ControlDispatchPosition | null {
  const existing = trace.operations.some(item => item.id === candidate.id);
  const replay = createTimelineControlDispatcher(existing
    ? trace.operations.map(item => item.id === candidate.id ? candidate : item)
    : [...trace.operations, candidate], trace.initialController);
  const takeCandidate = (frame: number, inclusive: boolean) => {
    const next = replay.peek();
    if (next?.operation.id === candidate.id && (next.frame < frame || (inclusive && next.frame === frame))) {
      replay.take(frame);
      return replay.positions.get(candidate.id)!;
    }
    return null;
  };
  for (const step of trace.steps) {
    const frame = step.kind === 'source' ? step.event.frame : step.frame;
    const early = takeCandidate(frame, step.kind === 'take' || (step.kind === 'source' && step.event.phase === 'after-ready'));
    if (early) return early;
    // An edited operation has not executed at its former position. Its old
    // callbacks/retries cannot serve as facts for the hypothetical candidate.
    if (existing && ((step.kind === 'source' && step.event.sourceId === candidate.id)
      || (step.kind === 'enqueue' && step.operation.id === candidate.id)
      || (step.kind === 'take' && step.id === candidate.id))) continue;
    if (step.kind === 'source') replay.notifySource(step.event);
    else if (step.kind === 'enqueue') replay.enqueue(step.operation, step.frame);
    else {
      const item = replay.take(step.frame);
      if (item?.id !== step.id) return null;
      if (item.id === candidate.id) return replay.positions.get(candidate.id)!;
    }
  }
  return takeCandidate(Number.MAX_SAFE_INTEGER, true);
}
