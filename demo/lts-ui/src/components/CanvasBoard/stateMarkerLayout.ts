export type MarkerRect = { left: number; top: number; width: number; height: number };

/** A state marker keeps its event-time anchor. Source actions are semantic data
 * for the inspector only; they must never influence this geometry. */
export type StateMarkerAnchor = {
  key: string;
  x: number;
  width: number;
  frame: number;
  sequence: number;
};

export type StateMarkerGroup<T extends StateMarkerAnchor> = MarkerRect & {
  events: T[];
  collapsed: boolean;
  /** Set only when several nearby time anchors were folded into one range. */
  range?: { fromFrame: number; toFrame: number };
  /** A reserved left gutter used only when the state lane has no legal slot. */
  overflow?: boolean;
};

export type StateMarkerSpace = MarkerRect & {
  preferredTop: number;
  obstacles: readonly MarkerRect[];
  /** Optional caller cap. The canvas leaves this unset so a local left slot
   * can be used no matter how far an obstacle extends. */
  maxHorizontalShift?: number;
};

export type StateMarkerIntervalInput = {
  key?: string;
  frame: number;
  sequence: number;
  buffId: string;
  scope: string;
  after: number | null;
  expireFrame?: number | null;
};

export type StateMarkerInterval<T extends StateMarkerIntervalInput> = {
  event: T;
  fromFrame: number;
  toFrame: number;
  clipped: boolean;
};

export const STATE_BADGE_SIZE = 20;
/** Gap between badges that share one exact-time marker tray. */
export const STATE_BADGE_GAP = 2;
const OBSTACLE_GAP = 4;

export function markerRectsOverlap(a: MarkerRect, b: MarkerRect, gap = 0): boolean {
  return a.left < b.left + b.width + gap && a.left + a.width + gap > b.left
    && a.top < b.top + b.height + gap && a.top + a.height + gap > b.top;
}

/**
 * Build one lifetime interval for each active state change.
 *
 * The stream key deliberately excludes source and actor. A refresh by another
 * actor is the next change to the same global pool and therefore closes the
 * previous interval, even when its terminal event has no actor id.
 */
export function stateMarkerIntervals<T extends StateMarkerIntervalInput>(
  events: readonly T[],
  reportEndFrame: number,
): StateMarkerInterval<T>[] {
  const streams = new Map<string, T[]>();
  events.forEach((event) => {
    const key = `${event.scope}\u0000${event.buffId}`;
    const stream = streams.get(key) ?? [];
    stream.push(event);
    streams.set(key, stream);
  });

  const intervals: StateMarkerInterval<T>[] = [];
  streams.forEach((stream) => {
    const ordered = [...stream].sort((left, right) => (
      left.frame - right.frame
      || left.sequence - right.sequence
      || (left.key ?? '').localeCompare(right.key ?? '')
    ));
    ordered.forEach((event, index) => {
      if (event.after === null || event.after <= 0) return;
      const next = ordered[index + 1];
      const hasExplicitExpiry = typeof event.expireFrame === 'number'
        && Number.isFinite(event.expireFrame);
      const explicitExpiry = hasExplicitExpiry
        ? Math.max(event.frame, Number(event.expireFrame))
        : null;
      const reportEnd = Number.isFinite(reportEndFrame)
        ? Math.max(event.frame, reportEndFrame)
        : event.frame;
      const toFrame = Math.min(
        next?.frame ?? reportEnd,
        explicitExpiry ?? reportEnd,
        reportEnd,
      );
      if (toFrame <= event.frame) return;
      intervals.push({
        event,
        fromFrame: event.frame,
        toFrame,
        // An interval without an observed next state ends at the calculated
        // report range unless the runtime supplied a natural expiry boundary.
        clipped: toFrame === reportEnd
          && (!next || next.frame > reportEnd)
          && (explicitExpiry === null || explicitExpiry > reportEnd),
      });
    });
  });
  return intervals.sort((left, right) => (
    left.fromFrame - right.fromFrame
    || left.event.sequence - right.event.sequence
    || (left.event.key ?? '').localeCompare(right.event.key ?? '')
  ));
}

/** Only collapse a continuous, increasing stack run for one status and exact
 * frame. Consumption/reapplication and events at different frames remain
 * distinct. The returned runs retain every original transaction for details.
 */
export function stateBadgeRuns<T extends {
  frame: number; sequence: number; buffId: string; before: number | null; after: number | null;
  commandId: string | null; scope: string; key?: string;
}>(events: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (const event of [...events].sort((a, b) => (
    a.frame - b.frame || a.sequence - b.sequence || (a.key ?? '').localeCompare(b.key ?? '')
  ))) {
    const run = runs[runs.length - 1], previous = run?.[run.length - 1];
    if (previous && previous.frame === event.frame && previous.buffId === event.buffId
      && previous.scope === event.scope && previous.after === event.before
      && previous.before !== null && event.after !== null
      && event.before !== null && event.before > 0 && event.after > event.before
      && previous.after !== null && previous.after > previous.before) run.push(event);
    else runs.push([event]);
  }
  return runs;
}

/**
 * Place markers at their event-time x coordinate. Collision resolution uses
 * vertical rows first; x is only clamped at the lane edges. If a local lane is
 * too dense, a collapsed group retains that exact-time record set instead of
 * being silently attached to a nearby action.
 */
export function layoutStateMarkers<T extends StateMarkerAnchor>(
  events: readonly T[], space: StateMarkerSpace,
): StateMarkerGroup<T>[] {
  const groups: StateMarkerGroup<T>[] = [];
  const bounds = space;
  const height = Math.min(STATE_BADGE_SIZE, Math.max(0, bounds.height));
  if (height <= 0 || bounds.width <= 0) return groups;
  const obstacles = space.obstacles.filter(rect => markerRectsOverlap(bounds, rect, OBSTACLE_GAP));
  const maxTop = bounds.top + bounds.height - height;

  const clampTop = (top: number) => Math.max(bounds.top, Math.min(maxTop, top));
  const rowTops = (
    occupied: readonly MarkerRect[] = [...obstacles, ...groups],
    gap = OBSTACLE_GAP,
  ) => {
    const rows = new Set<number>([clampTop(space.preferredTop), bounds.top, maxTop]);
    for (let top = bounds.top; top <= maxTop + .01; top += STATE_BADGE_SIZE + STATE_BADGE_GAP) {
      rows.add(clampTop(top));
    }
    // Every obstacle edge is a potential legal vertical shelf. Fixed rows
    // alone miss the narrow gap between controls and the lower state band.
    occupied.forEach(rect => {
      rows.add(clampTop(rect.top - height - gap));
      rows.add(clampTop(rect.top + rect.height + gap));
    });
    return [...rows].sort((left, right) => (
      Math.abs(left - space.preferredTop) - Math.abs(right - space.preferredTop)
      || left - right
    ));
  };
  const findSpace = (
    items: T[],
    collapsed: boolean,
    existingGroups: readonly StateMarkerGroup<T>[] = groups,
  ): StateMarkerGroup<T> | null => {
    const width = collapsed ? STATE_BADGE_SIZE
      : items.reduce((sum, item) => sum + item.width, 0) + STATE_BADGE_GAP * (items.length - 1);
    if (width > bounds.width) return null;
    const anchor = items.reduce((sum, item) => sum + item.x, 0) / items.length;
    const occupied = [...obstacles, ...existingGroups];
    const laneCenterMin = bounds.left + width / 2;
    const laneCenterMax = bounds.left + bounds.width - width / 2;
    const previousAnchor = [...events]
      .map(event => event.x)
      .filter(x => x < anchor - .01)
      .sort((left, right) => left - right)
      .pop();
    // An event at the lane edge cannot keep its mathematical center once a
    // 20px badge is attached. Clamp only that unavoidable edge case; normal
    // anchors remain untouched and therefore still win the exact-x pass.
    const anchorCenter = Math.max(laneCenterMin, Math.min(laneCenterMax, anchor));
    const explicitAllowance = typeof space.maxHorizontalShift === 'number'
      && Number.isFinite(space.maxHorizontalShift)
      ? Math.max(0, space.maxHorizontalShift)
      : Infinity;
    // Preserve event order within a lane. A moved marker may approach the
    // previous time anchor, but it cannot cross it; overlap with an already
    // placed group is checked independently below.
    const centerMin = Math.max(
      laneCenterMin,
      anchorCenter - explicitAllowance,
      previousAnchor === undefined
        ? -Infinity
        : Math.min(laneCenterMax, Math.max(laneCenterMin, previousAnchor)),
    );
    const centerMax = laneCenterMax;
    const candidate = (center: number, gap: number): StateMarkerGroup<T> | null => {
      if (center < centerMin - .01 || center > centerMax + .01) return null;
      const left = center - width / 2;
      for (const top of rowTops(occupied, gap)) {
        const next = { left, top, width, height, events: [...items], collapsed };
        if (!occupied.some(rect => markerRectsOverlap(next, rect, gap))) return next;
      }
      return null;
    };
    const gaps = [OBSTACLE_GAP, 0];
    // Dictionary order: keep the real event x and try every vertical shelf
    // before considering any horizontal dodge. The second pass permits a
    // touching (but non-overlapping) shelf when the four-pixel visual margin
    // would otherwise hide an otherwise readable 20px badge.
    for (const gap of gaps) {
      const exact = candidate(anchorCenter, gap);
      if (exact) return exact;
    }

    // Search only to the left, in increasing displacement. Integer samples
    // make the nearest empty pixel deterministic; obstacle edges are added so
    // a fractional DOM boundary is also considered exactly.
    const displacements = new Set<number>();
    const maxDisplacement = anchorCenter - centerMin;
    for (let displacement = 1; displacement <= maxDisplacement + .01; displacement += 1) {
      displacements.add(Number(displacement.toFixed(4)));
    }
    occupied.forEach(rect => {
      for (const gap of gaps) {
        const leftOfRect = rect.left - gap - width / 2;
        const rightOfRect = rect.left + rect.width + gap + width / 2;
        [leftOfRect, rightOfRect].forEach(center => {
          const displacement = anchorCenter - center;
          if (displacement > .01 && displacement <= maxDisplacement + .01) displacements.add(displacement);
        });
      }
    });
    for (const displacement of [...displacements].sort((left, right) => left - right)) {
      const center = anchorCenter - displacement;
      for (const gap of gaps) {
        const left = candidate(center, gap);
        if (left) return left;
      }
    }
    return null;
  };

  // Same-frame records at the same projected x share a compact tray. The
  // source command is intentionally absent from this key.
  const clusters: T[][] = [];
  for (const event of [...events].sort((a, b) => (
    a.x - b.x || a.frame - b.frame || a.sequence - b.sequence || a.key.localeCompare(b.key)
  ))) {
    const previous = clusters[clusters.length - 1];
    if (previous && previous[0].frame === event.frame && Math.abs(previous[0].x - event.x) < .01) {
      previous.push(event);
    } else {
      clusters.push([event]);
    }
  }

  for (const items of clusters) {
    const expanded = items.length <= 6 ? findSpace(items, false) : null;
    const placed = expanded ?? findSpace(items, true);
    if (placed) {
      groups.push(placed);
      continue;
    }

    // Preserve chronology and the local anchor when every vertical slot is
    // occupied. Fold only nearby groups into an explicit time-range summary;
    // never reuse a distant skill's rectangle or silently change ownership.
    const nearby = [...groups]
      .map(group => ({ group, distance: Math.abs(group.left + group.width / 2 - items[0].x) }))
      .filter(({ distance }) => distance <= STATE_BADGE_SIZE * 2 + OBSTACLE_GAP)
      .sort((left, right) => left.distance - right.distance);
    const mergedGroups: StateMarkerGroup<T>[] = [];
    const summaryItems = [...items];
    let summary: StateMarkerGroup<T> | null = null;
    for (const { group } of nearby) {
      mergedGroups.push(group);
      summaryItems.push(...group.events);
      summary = findSpace(summaryItems, true, groups.filter(groupItem => !mergedGroups.includes(groupItem)));
      if (summary) break;
    }
    if (summary) {
      summary.range = {
        fromFrame: Math.min(...summaryItems.map(item => item.frame)),
        toFrame: Math.max(...summaryItems.map(item => item.frame)),
      };
      for (const group of mergedGroups) groups.splice(groups.indexOf(group), 1);
      summary.events = summaryItems.sort((left, right) => (
        left.frame - right.frame || left.sequence - right.sequence || left.key.localeCompare(right.key)
      ));
      groups.push(summary);
      continue;
    }

    // If obstacles fill every legal row and there is no local group to fold,
    // use a reserved gutter outside the timeline lane. Keep the gutter to the
    // left of every measured obstacle, not just the nominal lane boundary.
    const width = STATE_BADGE_SIZE;
    const overflowRightEdge = Math.min(bounds.left, ...obstacles.map(rect => rect.left));
    const overflowLeft = overflowRightEdge - width - OBSTACLE_GAP;
    const existingOverflow = groups.find(group => group.overflow);
    if (existingOverflow) {
      existingOverflow.events.push(...items);
      existingOverflow.events.sort((left, right) => (
        left.frame - right.frame || left.sequence - right.sequence || left.key.localeCompare(right.key)
      ));
      existingOverflow.range = {
        fromFrame: Math.min(...existingOverflow.events.map(item => item.frame)),
        toFrame: Math.max(...existingOverflow.events.map(item => item.frame)),
      };
      continue;
    }
    // Existing groups are inside the lane and cannot collide with this gutter;
    // excluding them here prevents a full set of occupied y rows from hiding
    // the only remaining disclosure slot.
    const overflowTop = rowTops(obstacles).find(top => {
      const candidate = { left: overflowLeft, top, width, height };
      return !obstacles.some(rect => markerRectsOverlap(candidate, rect, OBSTACLE_GAP));
    });
    // A pathological obstacle can cover every y shelf. The checked gutter is
    // still the least misleading place to retain the records; never drop the
    // event set merely because no vertical shelf was enumerable.
    const retainedTop = overflowTop ?? clampTop(space.preferredTop);
    groups.push({
      left: overflowLeft,
      top: retainedTop,
      width,
      height,
      events: [...items],
      collapsed: items.length > 1,
      overflow: true,
      range: items.length > 1
        ? { fromFrame: Math.min(...items.map(item => item.frame)), toFrame: Math.max(...items.map(item => item.frame)) }
        : undefined,
    });
  }
  return groups;
}

/**
 * Reading cards are presentation-only obstacles. They may change the y shelf
 * of an already projected marker, but they must never cause a second x layout
 * pass: the ordinary groups are the shared time geometry for both modes.
 */
export function adjustStateMarkerRows<T extends StateMarkerAnchor>(
  groups: readonly StateMarkerGroup<T>[],
  space: StateMarkerSpace,
  extraObstacles: readonly MarkerRect[],
): StateMarkerGroup<T>[] {
  if (groups.length === 0 || extraObstacles.length === 0 || space.height <= 0) return [...groups];
  const height = Math.min(STATE_BADGE_SIZE, Math.max(0, space.height));
  const maxTop = space.top + space.height - height;
  const clampTop = (top: number) => Math.max(space.top, Math.min(maxTop, top));
  // The first pass has already cleared ordinary obstacles. In reading mode
  // those nodes are deliberately hidden but retain their DOM rectangles for
  // shared x measurement; they must not block this y-only card adjustment.
  const allObstacles = [...extraObstacles];
  const rowTops = (occupied: readonly MarkerRect[], gap: number) => {
    const rows = new Set<number>([clampTop(space.preferredTop), space.top, maxTop]);
    for (let top = space.top; top <= maxTop + .01; top += STATE_BADGE_SIZE + STATE_BADGE_GAP) {
      rows.add(clampTop(top));
    }
    occupied.forEach(rect => {
      rows.add(clampTop(rect.top - height - gap));
      rows.add(clampTop(rect.top + rect.height + gap));
    });
    return [...rows].sort((left, right) => (
      Math.abs(left - space.preferredTop) - Math.abs(right - space.preferredTop)
      || left - right
    ));
  };
  const needsRow = (group: StateMarkerGroup<T>) => extraObstacles.some(obstacle => markerRectsOverlap(group, obstacle));
  const fixed = groups.filter(group => !needsRow(group));
  const moved = new Map<StateMarkerGroup<T>, StateMarkerGroup<T>>();
  groups.filter(needsRow).forEach(group => {
    const occupied = [...allObstacles, ...fixed, ...moved.values()];
    let adjusted: StateMarkerGroup<T> | null = null;
    for (const gap of [OBSTACLE_GAP, 0]) {
      for (const top of rowTops(occupied, gap)) {
        const candidate = { ...group, top };
        if (!occupied.some(rect => markerRectsOverlap(candidate, rect, gap))) {
          adjusted = candidate;
          break;
        }
      }
      if (adjusted) break;
    }
    // No y shelf can exist when the card covers the entire lane. Keep the
    // ordinary x and y rather than silently moving the marker to another
    // action; the state record remains inspectable in this pathological case.
    moved.set(group, adjusted ?? { ...group });
  });
  return groups.map(group => moved.get(group) ?? { ...group });
}
