import { createPortal } from 'react-dom';
import type { MouseEvent } from 'react';

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
      style={{ left: position.x, top: position.y }}
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
