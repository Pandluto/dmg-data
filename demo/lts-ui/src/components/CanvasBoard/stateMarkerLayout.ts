export type MarkerRect = { left: number; top: number; width: number; height: number };
export type StateMarkerAnchor = { key: string; x: number; width: number; frame: number; sequence: number; source?: MarkerRect };
export type StateMarkerGroup<T extends StateMarkerAnchor> = MarkerRect & {
  events: T[]; collapsed: boolean;
};
export type StateMarkerSpace = MarkerRect & { preferredTop: number; obstacles: readonly MarkerRect[] };
export const STATE_BADGE_SIZE = 20;
/** Gap between badges that share one exact-time marker tray. */
export const STATE_BADGE_GAP = 2;
const OBSTACLE_GAP = 4;
const RIGHT_OF_ANCHOR_OFFSET = 6;

export function markerRectsOverlap(a: MarkerRect, b: MarkerRect, gap = 0): boolean {
  return a.left < b.left + b.width + gap && a.left + a.width + gap > b.left
    && a.top < b.top + b.height + gap && a.top + a.height + gap > b.top;
}

/** Only collapse a continuous, increasing stack run for one status and cast.
 * Consumption/reapplication and events at different frames remain distinct.
 * The returned runs retain every original transaction for the detail view.
 */
export function stateBadgeRuns<T extends {
  frame: number; sequence: number; buffId: string; before: number | null; after: number | null;
  commandId: string | null; scope: string;
}>(events: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (const event of [...events].sort((a, b) => a.frame - b.frame || a.sequence - b.sequence)) {
    const run = runs[runs.length - 1], previous = run?.[run.length - 1];
    if (previous && previous.frame === event.frame && previous.buffId === event.buffId
      && previous.scope === event.scope && previous.commandId === event.commandId
      && previous.after === event.before && previous.before !== null && event.after !== null
      && event.before !== null && event.before > 0 && event.after > event.before
      && previous.after !== null && previous.after > previous.before) run.push(event);
    else runs.push([event]);
  }
  return runs;
}

/** Place a callout in measured whitespace, preferring a short leader near its
 * timeline anchor. Search obstacle edges and vertical gaps, not a fixed row.
 * Dense content folds into a nearby disclosure; it never hides source events.
 */
export function layoutStateMarkers<T extends StateMarkerAnchor>(
  events: readonly T[], space: StateMarkerSpace,
): StateMarkerGroup<T>[] {
  const groups: StateMarkerGroup<T>[] = [];
  const bounds = space;
  const height = Math.min(STATE_BADGE_SIZE, bounds.height);
  const obstacles = space.obstacles.filter(rect => markerRectsOverlap(bounds, rect, OBSTACLE_GAP));
  const findSpace = (items: T[], collapsed: boolean): StateMarkerGroup<T> | null => {
    const width = collapsed ? STATE_BADGE_SIZE
      : items.reduce((sum, item) => sum + item.width, 0) + STATE_BADGE_GAP * (items.length - 1);
    if (width > bounds.width || height <= 0) return null;
    const anchor = items.reduce((sum, item) => sum + item.x, 0) / items.length;
    const source = items[0].source;
    const minX = Math.max(bounds.left, source?.left ?? bounds.left);
    const maxX = Math.min(bounds.left + bounds.width, source ? source.left + source.width : Infinity) - width;
    if (maxX < minX) return null;
    const clampX = (x: number) => Math.max(minX, Math.min(maxX, x));
    const clampY = (y: number) => Math.max(bounds.top, Math.min(bounds.top + bounds.height - height, y));
    const occupied = [...obstacles, ...groups];
    const preferredLeft = source ? maxX : clampX(anchor + RIGHT_OF_ANCHOR_OFFSET);
    const preferredTop = clampY(source?.top ?? space.preferredTop);
    // Put a tray just above/right of the source time first. The centered
    // candidate remains useful when the preferred side is occupied or clipped.
    const xs = new Set([preferredLeft, clampX(anchor - width / 2), minX, maxX]);
    const ys = new Set([preferredTop, bounds.top, bounds.top + bounds.height - height]);
    for (const rect of occupied) {
      xs.add(clampX(rect.left - width - OBSTACLE_GAP)); xs.add(clampX(rect.left + rect.width + OBSTACLE_GAP));
      ys.add(clampY(rect.top - height - OBSTACLE_GAP)); ys.add(clampY(rect.top + rect.height + OBSTACLE_GAP));
    }
    let best: StateMarkerGroup<T> | null = null, bestCost = Infinity;
    for (const top of ys) for (const left of xs) {
      const candidate = { left, top, width, height, events: items, collapsed };
      const distanceToPreferred = Math.abs(left - preferredLeft);
      const distanceToAnchor = source ? 0 : Math.abs(left + width / 2 - anchor);
      // Keep a modest bias against sending a callout left of its source when
      // both sides are otherwise comparable. Distance still dominates, so a
      // nearby left patch wins over an implausibly distant right edge.
      const leftPenalty = !source && left < anchor ? 4 : 0;
      const cost = distanceToPreferred + distanceToAnchor * .25
        + leftPenalty + Math.abs(top - preferredTop) * 1.4;
      if (cost >= bestCost || occupied.some(rect => markerRectsOverlap(candidate, rect, OBSTACLE_GAP - .01))) continue;
      best = candidate; bestCost = cost;
    }
    return best;
  };
  // Pack exact-time neighbours first, so leaders at one time share a small tray.
  const clusters: T[][] = [];
  for (const event of [...events].sort((a, b) => a.x - b.x || a.frame - b.frame || a.sequence - b.sequence)) {
    const previous = clusters[clusters.length - 1];
    if (previous && previous[0].x === event.x && previous[0].frame === event.frame
      && previous[0].source === event.source) previous.push(event);
    else clusters.push([event]);
  }
  for (const items of clusters) {
    const expanded = items.length <= 6 ? findSpace(items, false) : null;
    const placed = expanded ?? findSpace(items, true);
    if (placed) { groups.push(placed); continue; }
    if (groups.length) {
      // No empty patch remains: reuse the nearest existing control, preserving
      // its already safe rectangle and exposing all records in its disclosure.
      const nearest = groups.reduce((a, b) => Math.abs(a.left + a.width / 2 - items[0].x)
        <= Math.abs(b.left + b.width / 2 - items[0].x) ? a : b);
      nearest.events.push(...items);
      nearest.events.sort((a, b) => a.frame - b.frame || a.sequence - b.sequence);
      nearest.collapsed = true;
      nearest.width = STATE_BADGE_SIZE;
    } else {
      // The lane itself is full. A reserved narrow gutter remains available to
      // the caller; this flag asks it to put one disclosure there.
      groups.push({ events: items, left: bounds.left - STATE_BADGE_SIZE - OBSTACLE_GAP,
        top: bounds.top, width: STATE_BADGE_SIZE, height, collapsed: true });
    }
  }
  return groups;
}
