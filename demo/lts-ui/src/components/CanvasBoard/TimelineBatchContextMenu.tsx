import { createPortal } from 'react-dom';
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const TIMELINE_BATCH_CONTEXT_MENU_SIZE = {
  width: 132,
  height: 34,
} as const;

export function clampTimelineBatchContextMenuPosition(
  position: { x: number; y: number },
  viewport: { width: number; height: number },
  menuSize: { width: number; height: number } = TIMELINE_BATCH_CONTEXT_MENU_SIZE,
): { x: number; y: number } {
  const maxX = Math.max(0, viewport.width - menuSize.width);
  const maxY = Math.max(0, viewport.height - menuSize.height);
  return {
    x: Math.min(Math.max(position.x, 0), maxX),
    y: Math.min(Math.max(position.y, 0), maxY),
  };
}

export function stopTimelineBatchContextMenuPointerDown(
  event: Pick<ReactPointerEvent<HTMLDivElement>, 'stopPropagation'>,
): void {
  event.stopPropagation();
}

interface TimelineBatchContextMenuProps {
  count: number;
  position: { x: number; y: number };
  onDelete: () => void;
}

export function TimelineBatchContextMenu({
  count,
  position,
  onDelete,
}: TimelineBatchContextMenuProps) {
  if (typeof document === 'undefined') return null;

  const viewportPosition = clampTimelineBatchContextMenuPosition(
    position,
    typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight },
  );

  const runDelete = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onDelete();
  };

  return createPortal(
    <div
      className="skill-button-context-menu timeline-batch-context-menu"
      role="menu"
      aria-label="批量操作"
      style={{ left: viewportPosition.x, top: viewportPosition.y }}
      onPointerDown={stopTimelineBatchContextMenuPointerDown}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className="context-menu-item context-menu-item-danger"
        onClick={runDelete}
      >
        {`删除所选 ${count} 项`}
      </button>
    </div>,
    document.body,
  );
}
