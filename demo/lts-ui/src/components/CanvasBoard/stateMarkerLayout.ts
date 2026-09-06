export type MarkerRect = { left: number; top: number; width: number; height: number };

/** The event-time anchor belongs to the leader foot. The responsible action
 * defines the separate upper badge slot; neither coordinate rewrites time. */
export type StateMarkerAnchor = {
  key: string;
  x: number;
  width: number;
  frame: number;
  sequence: number;
  /** Responsible action: provider for a grant, consumer for a removal. */
  ownerCommandId?: string;
  /** Right edge of that action’s visible ordinary icon/type label. */
  ownerRight?: number;
  /** Start of the next action’s visible ink, already excluding its gap. */
  ownerLimit?: number;
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
      && previous.scope === event.scope && previous.commandId === event.commandId && previous.after === event.before
      && previous.before !== null && event.after !== null
      && event.before !== null && event.before > 0 && event.after > event.before
      && previous.after !== null && previous.after > previous.before) run.push(event);
    else runs.push([event]);
  }
  return runs;
}

/**
 * The lower leader anchor is event time; the upper row communicates ownership.
 * Every badge has the same y. Reserve a slot after its responsible action,
 * then scan right through occupied ink while retaining event order. Never
 * solve horizontal crowding by moving one status to a different height.
 */
export function layoutStateMarkers<T extends StateMarkerAnchor>(
  events: readonly T[], space: StateMarkerSpace,
): StateMarkerGroup<T>[] {
  if (space.height < STATE_BADGE_SIZE || space.width <= 0) return [];
  const top = space.preferredTop;
  const end = space.left + space.width;
  const obstacles = space.obstacles.filter(rect => (
    rect.top < top + STATE_BADGE_SIZE
    && rect.top + rect.height > top
  ));
  const clusters: T[][] = [];
  for (const event of [...events].sort((a,b) => a.frame-b.frame || a.sequence-b.sequence || a.key.localeCompare(b.key))) {
    const last = clusters[clusters.length-1];
    if (last && last[0].frame === event.frame && last[0].ownerCommandId === event.ownerCommandId
      && Math.abs(last[0].x-event.x)<.01) last.push(event);
    else clusters.push([event]);
  }
  const groups: StateMarkerGroup<T>[] = [];
  let cursor = space.left;
  const findSlot = (items: T[], collapsed: boolean): StateMarkerGroup<T> | null => {
    const width = collapsed ? STATE_BADGE_SIZE
      : items.reduce((sum,item)=>sum+item.width,0)+STATE_BADGE_GAP*(items.length-1);
    const ownerEdges = items.flatMap(item=>Number.isFinite(item.ownerRight) ? [item.ownerRight!] : []);
    const preferred = ownerEdges.length ? Math.max(...ownerEdges)+OBSTACLE_GAP
      : items[0].x-width/2;
    const ownerLimits=items.flatMap(item=>Number.isFinite(item.ownerLimit)?[item.ownerLimit!]:[]);
    const slotEnd=Math.min(end,...ownerLimits);
    let left = Math.max(space.left,cursor,preferred);
    // Each pass clears at least one obstacle’s right edge, so this terminates
    // without a pixel-by-pixel search across the canvas.
    while (left+width <= slotEnd+.01) {
      const candidate = {left,top,width,height:STATE_BADGE_SIZE,events:[...items],collapsed};
      const hits = obstacles.filter(rect=>markerRectsOverlap(candidate,rect,OBSTACLE_GAP));
      if (!hits.length) return candidate;
      left = Math.max(...hits.map(rect=>rect.left+rect.width+OBSTACLE_GAP));
    }
    return null;
  };
  for (const items of clusters) {
    const group = (items.length<=6 ? findSlot(items,false) : null) ?? findSlot(items,true);
    if (group) {
      groups.push(group);
      cursor=group.left+group.width+STATE_BADGE_GAP;
      continue;
    }
    // Explicit overflow disclosure is outside the action flow. It never
    // impersonates an earlier action’s badge, and retains every transaction.
    let overflow=groups.find(group=>group.overflow);
    if (!overflow) {
      overflow={left:space.left-STATE_BADGE_SIZE-OBSTACLE_GAP,top,width:STATE_BADGE_SIZE,
        height:STATE_BADGE_SIZE,events:[],collapsed:true,overflow:true};
      groups.push(overflow);
    }
    overflow.events.push(...items);
    overflow.range={fromFrame:Math.min(...overflow.events.map(item=>item.frame)),
      toFrame:Math.max(...overflow.events.map(item=>item.frame))};
  }
  return groups;
}
