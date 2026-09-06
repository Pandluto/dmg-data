import type { SkillReleaseAnchor } from '../../../types';
import type { CanvasDropTarget } from './useCanvasDrag';

export type LensRect = { left: number; top: number; width: number; height: number };
export type ReleaseLensPort = {
  target: CanvasDropTarget;
  eventFrame: number;
  label: string;
  minFrame?: number;
  maxFrameExclusive?: number;
};
export type ReleaseLensSession = {
  sourceButtonId: string;
  sourceName: string;
  successorName?: string;
  sourceIconUrl?: string;
  sourceRect: LensRect;
  rect: LensRect;
  ports: ReleaseLensPort[];
  hits: { frame: number; lingering: boolean }[];
  tickRate: number;
};
export type ReleaseLensView = {
  session: ReleaseLensSession;
  selectedId: string;
  offsetFrames: number;
  target: CanvasDropTarget | null;
  reason: string | null;
  note: string;
  editing: boolean;
};

export const RELEASE_LENS_PAGE_SIZE = 3;
export const LENS_AXIS_Y = 82;
export const LENS_PORT_Y = 112;
export const LENS_EDIT_BOTTOM = 180;

export function lensPortFrame(target: CanvasDropTarget): number {
  if (target.anchor.kind === 'timed-input' && target.windowStartFrame !== undefined) return target.windowStartFrame;
  return target.frame - target.anchor.debounceFrames;
}

export function releaseAnchorLabel(anchor: SkillReleaseAnchor): string {
  if (anchor.kind === 'action-start') return '同时起手';
  if (anchor.kind === 'action-end') return '动作结束后';
  if (anchor.kind === 'group-start') return '组起点';
  if (anchor.kind === 'timed-input') {
    return anchor.sourceTimedInputKind === 'broad' ? '普通连携窗' : '精准输入窗';
  }
  return '指定命中后';
}

export function lensPortLabel(target: CanvasDropTarget, ordinal: number): string {
  return target.anchor.kind === 'damage-hit' ? `第 ${ordinal} 击后` : releaseAnchorLabel(target.anchor);
}

export function matchesSavedLensAnchor(target: CanvasDropTarget, saved: SkillReleaseAnchor): boolean {
  const anchor = target.anchor;
  if (anchor.kind !== saved.kind || anchor.sourceButtonId !== saved.sourceButtonId) return false;
  if (saved.kind === 'damage-hit') return anchor.sourceHitOffsetFrames === saved.sourceHitOffsetFrames;
  if (saved.kind !== 'timed-input') return true;
  if (saved.sourceTimedInputKind && anchor.sourceTimedInputKind !== saved.sourceTimedInputKind) return false;
  if (saved.sourceTimedInputSkillId && anchor.sourceTimedInputSkillId !== saved.sourceTimedInputSkillId) return false;
  if (saved.sourceTimedInputStartOffsetFrames !== undefined
    && anchor.sourceTimedInputStartOffsetFrames !== saved.sourceTimedInputStartOffsetFrames) return false;
  if (saved.sourceTimedInputEndOffsetFramesExclusive !== undefined
    && anchor.sourceTimedInputEndOffsetFramesExclusive !== saved.sourceTimedInputEndOffsetFramesExclusive) return false;
  const sourceOffset = anchor.sourceTimedInputOffsetFrames;
  if (sourceOffset === undefined || saved.sourceTimedInputOffsetFrames === undefined) return false;
  const savedFrame = target.frame - sourceOffset - anchor.debounceFrames
    + saved.sourceTimedInputOffsetFrames + saved.debounceFrames;
  if (target.windowStartFrame !== undefined && target.windowEndFrameExclusive !== undefined) {
    return savedFrame >= target.windowStartFrame && savedFrame < target.windowEndFrameExclusive;
  }
  return sourceOffset === saved.sourceTimedInputOffsetFrames;
}

export function findSavedLensTarget(targets: CanvasDropTarget[], saved: SkillReleaseAnchor) {
  // Legacy window IDs were shared by broad and precision intervals. Recover the
  // narrowest interval containing the saved input, without moving that input.
  return targets.filter(target => matchesSavedLensAnchor(target, saved))
    .sort((a, b) => (a.windowEndFrameExclusive !== undefined ? a.windowEndFrameExclusive - (a.windowStartFrame ?? 0) : Infinity)
      - (b.windowEndFrameExclusive !== undefined ? b.windowEndFrameExclusive - (b.windowStartFrame ?? 0) : Infinity))[0];
}

export function placeReleaseLens(source: LensRect, viewport: { width: number; height: number }): LensRect {
  const width = Math.min(520, viewport.width - 24);
  const height = 276;
  // The source remains visible beside/under the lens. It does not move with the pointer.
  const left = Math.max(12, Math.min(viewport.width - width - 12, source.left + source.width / 2 - width / 2));
  const below = source.top + source.height + 14;
  const top = below + height <= viewport.height - 12 ? below : Math.max(12, source.top - height - 14);
  return { left, top, width, height };
}

export function containsLensPoint(rect: LensRect, x: number, y: number, margin = 0): boolean {
  return x >= rect.left - margin && x <= rect.left + rect.width + margin
    && y >= rect.top - margin && y <= rect.top + rect.height + margin;
}

export function releaseLensPage(view: ReleaseLensView) {
  const { session } = view;
  const index = Math.max(0, session.ports.findIndex(p => p.target.anchorId === view.selectedId));
  const page = Math.floor(index / RELEASE_LENS_PAGE_SIZE);
  const ports = session.ports.slice(page * RELEASE_LENS_PAGE_SIZE, (page + 1) * RELEASE_LENS_PAGE_SIZE);
  const from = Math.min(...ports.map(p => p.eventFrame));
  const final = ports[ports.length - 1];
  const next = session.ports[(page + 1) * RELEASE_LENS_PAGE_SIZE];
  const to = Math.max(from + 12, final.eventFrame + 12, next?.eventFrame ?? 0);
  const left = 46, right = session.rect.width - 30;
  const frames = [...new Set([...ports.flatMap(p => [p.eventFrame, Math.min(to, p.eventFrame + 12)]), to])].sort((a, b) => a - b);
  // Reserve room for the first few frames after each event, even when a long
  // recovery follows it. This mapping is independent of the selected delay.
  const x = (frame: number) => {
    if (frame <= from) return left;
    if (frame >= to) return right;
    const i = Math.max(0, frames.findIndex((_f, n) => n < frames.length - 1 && frame < frames[n + 1]));
    return left + ((i + (frame - frames[i]) / (frames[i + 1] - frames[i])) / (frames.length - 1)) * (right - left);
  };
  const frameAt = (position: number) => {
    const unit = Math.max(0, Math.min(frames.length - 1, (position - left) / (right - left) * (frames.length - 1)));
    const i = Math.min(frames.length - 2, Math.floor(unit));
    return Math.round(frames[i] + (unit - i) * (frames[i + 1] - frames[i]));
  };
  const positions = ports.map((p, index) => ({
    port: p, x: x(p.eventFrame),
    y: LENS_PORT_Y + ports.slice(0, index).filter(q => q.eventFrame === p.eventFrame).length * 24,
  }));
  return { ports, positions, page, pageCount: Math.ceil(session.ports.length / RELEASE_LENS_PAGE_SIZE), from, to, x, frameAt };
}

export function offsetReleaseLensPort(port: ReleaseLensPort, offsetFrames: number): { target: CanvasDropTarget | null; reason: string | null } {
  if (!Number.isInteger(offsetFrames) || offsetFrames < 0) return { target: null, reason: '延迟必须是非负整数帧' };
  const frame = port.eventFrame + offsetFrames;
  if ((port.minFrame !== undefined && frame < port.minFrame)
    || (port.maxFrameExclusive !== undefined && frame >= port.maxFrameExclusive)) {
    return { target: null, reason: `超出输入窗口 [F${port.minFrame}, F${port.maxFrameExclusive})` };
  }
  const anchor = { ...port.target.anchor, debounceFrames: offsetFrames };
  if (anchor.kind === 'timed-input') anchor.sourceTimedInputOffsetFrames = (anchor.sourceTimedInputOffsetFrames ?? 0) + port.eventFrame - port.target.frame;
  return { target: { ...port.target, frame, anchor,
    label: `${port.label} +${offsetFrames}帧` }, reason: null };
}

export function selectReleaseLensPointer(view: ReleaseLensView, clientX: number, clientY: number): { id: string; offset: number } | null {
  const { rect } = view.session;
  const x = clientX - rect.left, y = clientY - rect.top;
  if (x < 26 || x > rect.width - 12 || y < LENS_AXIS_Y - 20 || y > LENS_EDIT_BOTTOM) return null;
  const page = releaseLensPage(view);
  const nearest = [...page.positions].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
  if (Math.abs(nearest.x - x) <= 12) return { id: nearest.port.target.anchorId, offset: nearest.port.target.frame - nearest.port.eventFrame };
  const frame = page.frameAt(x);
  const previous = [...page.ports].reverse().find(p => p.eventFrame <= frame) ?? page.ports[0];
  return { id: previous.target.anchorId, offset: Math.max(0, frame - previous.eventFrame) };
}
