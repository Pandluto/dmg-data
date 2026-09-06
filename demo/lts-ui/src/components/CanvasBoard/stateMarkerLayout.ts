export type StateMarkerAnchor = { key: string; x: number; width: number; frame: number; sequence: number };
export type StateMarkerGroup<T extends StateMarkerAnchor> = {
  events: T[]; left: number; width: number; collapsed: boolean;
};

/** Pack nearby callouts horizontally. Anchors and event order never change.
 * A dense collision group folds into a disclosure instead of spilling into the
 * next operator's lane. Every original event remains in the group.
 */
export function layoutStateMarkers<T extends StateMarkerAnchor>(
  events: readonly T[], left: number, right: number, gap = 3, maxExpandedWidth = 180,
): StateMarkerGroup<T>[] {
  const available = Math.max(1, right - left);
  const makeGroup = (items: T[]): StateMarkerGroup<T> => {
    const widthNeeded = items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1);
    const collapsed = widthNeeded > Math.min(maxExpandedWidth, available);
    const width = collapsed ? Math.min(80, available) : widthNeeded;
    const anchor = (Math.min(...items.map(item => item.x)) + Math.max(...items.map(item => item.x))) / 2;
    return { events: items, width, collapsed, left: Math.max(left, Math.min(right - width, anchor - width / 2)) };
  };
  let groups = [...events].sort((a, b) => a.x - b.x || a.frame - b.frame || a.sequence - b.sequence)
    .map(event => makeGroup([event]));
  // Each merge reduces group count. Revisit earlier neighbours because a
  // centred merged group can extend left as well as right.
  for (let index = 1; index < groups.length;) {
    const previous = groups[index - 1], current = groups[index];
    if (previous.left + previous.width + gap > current.left) {
      const items = [...previous.events, ...current.events]
        .sort((a, b) => a.frame - b.frame || a.sequence - b.sequence);
      groups.splice(index - 1, 2, makeGroup(items));
      index = Math.max(1, index - 1);
    } else index += 1;
  }
  return groups;
}
