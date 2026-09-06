import type { SkillReleaseAnchor } from '../../types';

/**
 * Release relationships form a directed acyclic graph (DAG): one action has at
 * most one inbound anchor, while a shared start/hit/tail may fan out to several
 * followers.  The graph is intentionally independent from canvas coordinates.
 */
export type ReleaseGraphNode = {
  id: string;
  durationFrames: number;
  defaultPredecessorId?: string;
  releaseAnchor?: SkillReleaseAnchor;
};

export type ReleaseAnchorGraphIssue = {
  code:
    | 'DANGLING_SOURCE'
    | 'SELF_REFERENCE'
    | 'CYCLE'
    | 'INVALID_HIT_OFFSET'
    | 'INVALID_TIMED_INPUT_OFFSET';
  buttonId: string;
  sourceButtonId?: string;
  message: string;
};

export type ReleaseStartOffsetSolution = {
  offsets: Map<string, number>;
  issues: ReleaseAnchorGraphIssue[];
};

export function attachLegacyLanePredecessors<T extends {
  id: string;
  staffIndex: number;
  lineIndex: number;
  nodeIndex?: number;
  releaseAnchor?: SkillReleaseAnchor;
}>(nodes: readonly T[]): Array<T & { defaultPredecessorId?: string }> {
  const predecessorById = new Map<string, string>();
  const lanes = new Map<string, T[]>();
  nodes.forEach((node) => {
    const key = `${node.staffIndex}\u0000${node.lineIndex}`;
    const entries = lanes.get(key) ?? [];
    entries.push(node);
    lanes.set(key, entries);
  });
  lanes.forEach((entries) => {
    entries.sort((left, right) => (
      (left.nodeIndex ?? 0) - (right.nodeIndex ?? 0)
      || left.id.localeCompare(right.id)
    ));
    entries.forEach((entry, index) => {
      const predecessor = entries[index - 1];
      if (predecessor) predecessorById.set(entry.id, predecessor.id);
    });
  });
  return nodes.map(node => ({
    ...node,
    ...(!node.releaseAnchor && predecessorById.has(node.id)
      ? { defaultPredecessorId: predecessorById.get(node.id) }
      : {}),
  }));
}

export type TimedReleaseAction = {
  id: string;
  groupId: string;
  groupIndex: number;
  startFrame: number;
  endFrame: number;
  startX: number;
  endX: number;
  label?: string;
};

export type TimedReleaseHit = {
  id: string;
  commandId: string;
  frame: number;
  offsetFrames: number;
  /** False for status/buff-derived damage that must not become an anchor. */
  releaseEligible?: boolean;
  label?: string;
};

export type TimedReleaseInputWindow = {
  id: string;
  sourceCommandId: string;
  startFrame: number;
  endFrameExclusive: number;
  /** Optional visual/default placement inside the executable interval. */
  preferredFrame?: number;
  /** Runtime window id used by the resolver; may differ from the display id. */
  sourceTimedInputId?: string;
  windowKind?: 'broad' | 'precision';
  sourceSkillId?: string;
  label?: string;
};

export type ReleaseSnapPoint = {
  id: string;
  kind: SkillReleaseAnchor['kind'];
  frame: number;
  globalX: number;
  groupId: string;
  groupIndex: number;
  label: string;
  anchor: SkillReleaseAnchor;
  sourceHitOrdinal?: number;
  windowStartFrame?: number;
  windowEndFrameExclusive?: number;
};

function safeFrame(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function directSource(anchor: SkillReleaseAnchor | undefined): string | null {
  if (!anchor || anchor.kind === 'group-start') return null;
  return anchor.sourceButtonId?.trim() || null;
}

export function getDirectReleaseDependents<T extends {
  id: string;
  releaseAnchor?: SkillReleaseAnchor;
  defaultPredecessorId?: string;
}>(nodes: readonly T[], sourceButtonId: string): T[] {
  return nodes.filter(node => (
    directSource(node.releaseAnchor)
      ?? (!node.releaseAnchor ? node.defaultPredecessorId ?? null : null)
  ) === sourceButtonId);
}

export function getReleaseDeletionBlockers<T extends {
  id: string;
  releaseAnchor?: SkillReleaseAnchor;
  defaultPredecessorId?: string;
}>(nodes: readonly T[], buttonId: string): T[] {
  return getDirectReleaseDependents(nodes, buttonId);
}

function adjacency<T extends {
  id: string;
  releaseAnchor?: SkillReleaseAnchor;
  defaultPredecessorId?: string;
}>(
  nodes: readonly T[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  nodes.forEach(node => result.set(node.id, []));
  nodes.forEach((node) => {
    const sourceId = directSource(node.releaseAnchor)
      ?? (!node.releaseAnchor ? node.defaultPredecessorId ?? null : null);
    if (!sourceId) return;
    const dependents = result.get(sourceId) ?? [];
    dependents.push(node.id);
    result.set(sourceId, dependents);
  });
  return result;
}

export function wouldCreateReleaseCycle<T extends {
  id: string;
  releaseAnchor?: SkillReleaseAnchor;
  defaultPredecessorId?: string;
}>(nodes: readonly T[], targetButtonId: string, proposedSourceButtonId: string): boolean {
  if (targetButtonId === proposedSourceButtonId) return true;
  const graph = adjacency(nodes);
  const pending = [targetButtonId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === proposedSourceButtonId) return true;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

/**
 * Resolve group-local start offsets. Legacy nodes without an explicit anchor
 * retain their lane predecessor, which keeps old saves deterministic.
 */
export function solveReleaseStartOffsets(
  nodes: readonly ReleaseGraphNode[],
): ReleaseStartOffsetSolution {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const issues: ReleaseAnchorGraphIssue[] = [];
  const issueKeys = new Set<string>();
  const offsets = new Map<string, number>();
  const fallbackOffsets = new Map<string, number>();
  const visiting = new Set<string>();

  const addIssue = (issue: ReleaseAnchorGraphIssue) => {
    const key = `${issue.code}:${issue.buttonId}:${issue.sourceButtonId ?? ''}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  const fallbackOffset = (node: ReleaseGraphNode, trail = new Set<string>()): number => {
    const cached = fallbackOffsets.get(node.id);
    if (cached !== undefined) return cached;
    const predecessorId = node.defaultPredecessorId;
    if (!predecessorId || trail.has(node.id)) {
      fallbackOffsets.set(node.id, 0);
      return 0;
    }
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      fallbackOffsets.set(node.id, 0);
      return 0;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(node.id);
    const value = fallbackOffset(predecessor, nextTrail) + safeFrame(predecessor.durationFrames);
    fallbackOffsets.set(node.id, value);
    return value;
  };

  const resolve = (node: ReleaseGraphNode): number => {
    const cached = offsets.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) {
      addIssue({
        code: 'CYCLE',
        buttonId: node.id,
        message: `Release dependency cycle reaches ${node.id}.`,
      });
      return fallbackOffset(node);
    }

    visiting.add(node.id);
    const anchor = node.releaseAnchor;
    let value: number;
    if (anchor?.kind === 'group-start') {
      value = 0;
    } else {
      const sourceId = directSource(anchor);
      if (sourceId === node.id) {
        addIssue({
          code: 'SELF_REFERENCE',
          buttonId: node.id,
          sourceButtonId: sourceId,
          message: `${node.id} cannot anchor to itself.`,
        });
        value = fallbackOffset(node);
      } else if (sourceId) {
        const source = byId.get(sourceId);
        if (!source) {
          addIssue({
            code: 'DANGLING_SOURCE',
            buttonId: node.id,
            sourceButtonId: sourceId,
            message: `${node.id} references missing release source ${sourceId}.`,
          });
          value = fallbackOffset(node);
        } else {
          const sourceStart = resolve(source);
          const debounce = safeFrame(anchor?.debounceFrames ?? 0);
          if (anchor?.kind === 'action-start') {
            value = sourceStart + debounce;
          } else if (anchor?.kind === 'action-end') {
            value = sourceStart + safeFrame(source.durationFrames) + debounce;
          } else if (anchor?.kind === 'damage-hit') {
            const hitOffset = anchor.sourceHitOffsetFrames;
            if (!Number.isFinite(hitOffset) || Number(hitOffset) < 0) {
              addIssue({
                code: 'INVALID_HIT_OFFSET',
                buttonId: node.id,
                sourceButtonId: sourceId,
                message: `${node.id} has no valid persisted damage-hit offset.`,
              });
              value = fallbackOffset(node);
            } else {
              value = sourceStart + safeFrame(Number(hitOffset)) + debounce;
            }
          } else if (anchor?.kind === 'timed-input') {
            const timedInputOffset = anchor.sourceTimedInputOffsetFrames;
            if (!Number.isFinite(timedInputOffset) || Number(timedInputOffset) < 0) {
              addIssue({
                code: 'INVALID_TIMED_INPUT_OFFSET',
                buttonId: node.id,
                sourceButtonId: sourceId,
                message: `${node.id} has no valid persisted timed-input offset.`,
              });
              value = fallbackOffset(node);
            } else {
              value = sourceStart + safeFrame(Number(timedInputOffset)) + debounce;
            }
          } else {
            value = fallbackOffset(node);
          }
        }
      } else if (node.defaultPredecessorId) {
        const predecessor = byId.get(node.defaultPredecessorId);
        value = predecessor
          ? resolve(predecessor) + safeFrame(predecessor.durationFrames)
          : fallbackOffset(node);
      } else {
        value = 0;
      }
    }
    visiting.delete(node.id);
    const normalized = safeFrame(value);
    offsets.set(node.id, normalized);
    return normalized;
  };

  nodes.forEach(resolve);
  return { offsets, issues };
}

/** Build the finite set of legal, explainable magnetic points for a drag. */
export function buildReleaseSnapPoints(input: {
  actions: readonly TimedReleaseAction[];
  hits: readonly TimedReleaseHit[];
  timedInputWindows?: readonly TimedReleaseInputWindow[];
  debounceFrames: number;
  projectFrame: (frame: number) => number | null;
}): ReleaseSnapPoint[] {
  const actionById = new Map(input.actions.map(action => [action.id, action]));
  const points: ReleaseSnapPoint[] = [];
  const seenGroupIds = new Set<string>();

  [...input.actions]
    .sort((left, right) => left.groupIndex - right.groupIndex || left.startFrame - right.startFrame)
    .forEach((action) => {
      if (!seenGroupIds.has(action.groupId)) {
        seenGroupIds.add(action.groupId);
        points.push({
          id: `group-start:${action.groupId}`,
          kind: 'group-start',
          frame: action.startFrame,
          globalX: action.startX,
          groupId: action.groupId,
          groupIndex: action.groupIndex,
          label: `第 ${action.groupIndex + 1} 组起点`,
          anchor: {
            schemaVersion: 1,
            kind: 'group-start',
            debounceFrames: 0,
          },
        });
      }
      points.push({
        id: `action-start:${action.id}`,
        kind: 'action-start',
        frame: action.startFrame,
        globalX: action.startX,
        groupId: action.groupId,
        groupIndex: action.groupIndex,
        label: `与 ${action.label ?? action.id} 同时起手`,
        anchor: {
          schemaVersion: 1,
          kind: 'action-start',
          sourceButtonId: action.id,
          debounceFrames: 0,
        },
      });
      points.push({
        id: `action-end:${action.id}`,
        kind: 'action-end',
        frame: action.endFrame,
        globalX: action.endX,
        groupId: action.groupId,
        groupIndex: action.groupIndex,
        label: `紧跟 ${action.label ?? action.id} 尾部`,
        anchor: {
          schemaVersion: 1,
          kind: 'action-end',
          sourceButtonId: action.id,
          debounceFrames: 0,
        },
      });
    });

  const hitOrdinals = new Map<string, number>();
  input.hits.forEach((hit) => {
    if (hit.releaseEligible === false) return;
    const action = actionById.get(hit.commandId);
    if (!action) return;
    const hitOrdinal = (hitOrdinals.get(hit.commandId) ?? 0) + 1;
    hitOrdinals.set(hit.commandId, hitOrdinal);
    const frame = safeFrame(hit.frame + input.debounceFrames);
    const globalX = input.projectFrame(frame);
    if (globalX === null) return;
    points.push({
      id: `damage-hit:${hit.id}`,
      kind: 'damage-hit',
      frame,
      globalX,
      groupId: action.groupId,
      groupIndex: action.groupIndex,
      label: `${action.label ?? action.id} 第 ${hitOrdinal} 击后 +${safeFrame(input.debounceFrames)}帧`,
      sourceHitOrdinal: hitOrdinal,
      anchor: {
        schemaVersion: 1,
        kind: 'damage-hit',
        sourceButtonId: action.id,
        sourceHitId: hit.id,
        sourceHitOffsetFrames: safeFrame(hit.offsetFrames),
        debounceFrames: safeFrame(input.debounceFrames),
      },
    });
  });

  (input.timedInputWindows ?? []).forEach((window) => {
    const action = actionById.get(window.sourceCommandId);
    if (!action) return;
    const startFrame = safeFrame(window.startFrame);
    const endFrameExclusive = safeFrame(window.endFrameExclusive);
    if (endFrameExclusive <= startFrame) return;
    // Use an explicit visual/default frame when supplied. The right boundary
    // is exclusive, so all candidates are clamped to [start, end - 1].
    const defaultFrame = Math.floor((startFrame + endFrameExclusive - 1) / 2);
    const frame = Math.min(
      endFrameExclusive - 1,
      Math.max(startFrame, safeFrame(window.preferredFrame ?? defaultFrame)),
    );
    const sourceOffsetFrames = frame - action.startFrame;
    if (sourceOffsetFrames < 0) return;
    const globalX = input.projectFrame(frame);
    if (globalX === null) return;
    points.push({
      id: `timed-input:${window.id}`,
      kind: 'timed-input',
      frame,
      globalX,
      groupId: action.groupId,
      groupIndex: action.groupIndex,
      label: `${action.label ?? action.id} · ${window.label ?? '精准输入'}`,
      windowStartFrame: startFrame,
      windowEndFrameExclusive: endFrameExclusive,
      anchor: {
        schemaVersion: 1,
        kind: 'timed-input',
        sourceButtonId: action.id,
        sourceTimedInputId: window.sourceTimedInputId ?? window.id,
        sourceTimedInputOffsetFrames: sourceOffsetFrames,
        sourceTimedInputKind: window.windowKind,
        sourceTimedInputSkillId: window.sourceSkillId,
        sourceTimedInputStartOffsetFrames: startFrame - action.startFrame,
        sourceTimedInputEndOffsetFramesExclusive: endFrameExclusive - action.startFrame,
        debounceFrames: 0,
      },
    });
  });

  return points.sort((left, right) => (
    left.globalX - right.globalX
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
  ));
}
