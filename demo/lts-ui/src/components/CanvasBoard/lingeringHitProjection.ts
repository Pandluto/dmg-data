export type LingeringHitMarkerCandidate = {
  groupKey: string;
  frame: number;
  lingering: boolean;
};

export type LingeringHitMarkerMetadata = {
  compactLingering?: boolean;
  lingeringCount?: number;
  lingeringStartFrame?: number;
  lingeringEndFrame?: number;
};

/**
 * Low-scale hits are still present in the ledger, but a full diamond makes a
 * dense timeline read like a wall of damage. Keep the threshold in one place
 * so preview and settled projections use the same visual rule.
 */
export const LOW_MULTIPLIER_MARKER_THRESHOLD = 0.8;

export function isLowMultiplierHitMarker(multiplier: unknown): boolean {
  if (multiplier === null || multiplier === undefined || multiplier === '') return false;
  const value = Number(multiplier);
  return Number.isFinite(value) && value < LOW_MULTIPLIER_MARKER_THRESHOLD;
}

const DEFAULT_LINGERING_THRESHOLD = 12;
const DEFAULT_MAX_DOTS = 8;

function representativeIndices(count: number, maxDots: number): number[] {
  if (count <= maxDots) return Array.from({ length: count }, (_, index) => index);
  if (maxDots <= 2) return [0, count - 1];

  const indices = new Set<number>([0, count - 1]);
  const interiorDots = maxDots - 2;
  for (let index = 1; index <= interiorDots; index += 1) {
    const ratio = index / (interiorDots + 1);
    indices.add(Math.round(ratio * (count - 1)));
  }
  return [...indices].sort((left, right) => left - right);
}

/**
 * Reduce only the canvas representation of a long lingering tail.
 *
 * The returned candidates remain in chronological order.  Every original
 * record is still available to the runtime report/detail view; this helper
 * only chooses a handful of representatives for the dense canvas projection.
 */
export function compactLingeringHitMarkers<
  T extends LingeringHitMarkerCandidate,
>(
  candidates: readonly T[],
  options: {
    threshold?: number;
    maxDots?: number;
  } = {},
): Array<T & LingeringHitMarkerMetadata> {
  const threshold = Math.max(1, Math.floor(options.threshold ?? DEFAULT_LINGERING_THRESHOLD));
  const maxDots = Math.max(2, Math.floor(options.maxDots ?? DEFAULT_MAX_DOTS));
  const lingeringByGroup = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (!candidate.lingering) continue;
    const group = lingeringByGroup.get(candidate.groupKey) ?? [];
    group.push(candidate);
    lingeringByGroup.set(candidate.groupKey, group);
  }

  const keep = new Set<T>();
  const metadataByGroup = new Map<string, LingeringHitMarkerMetadata>();
  for (const [groupKey, group] of lingeringByGroup) {
    if (group.length <= threshold) {
      group.forEach(candidate => keep.add(candidate));
      continue;
    }
    const indices = representativeIndices(group.length, maxDots);
    indices.forEach(index => keep.add(group[index]));
    metadataByGroup.set(groupKey, {
      compactLingering: true,
      lingeringCount: group.length,
      lingeringStartFrame: group[0].frame,
      lingeringEndFrame: group[group.length - 1].frame,
    });
  }

  return candidates
    .filter(candidate => !candidate.lingering || keep.has(candidate))
    .map(candidate => ({
      ...candidate,
      ...(candidate.lingering
        ? metadataByGroup.get(candidate.groupKey)
        : undefined),
    }));
}
