import { useCallback, useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SkillButton } from '../../types';

interface TimelineWaitSegmentProps {
  button: SkillButton;
  left: number;
  top: number;
  width: number;
  startFrame: number | null;
  endFrame: number | null;
  tickRate: number;
  isBrowseMode?: boolean;
  isDragDisabled?: boolean;
  onMouseDown: (event: MouseEvent, buttonId: string) => void;
  onContextMenu: (event: MouseEvent, buttonId: string) => void;
  onConfigure?: (button: SkillButton) => void;
  contextMenuState?: { buttonId: string; position: { x: number; y: number } } | null;
  onConfirmRemove?: () => void;
  onCloseContextMenu?: () => void;
  onCopy?: () => void;
}

interface TimelineWaitContextMenuProps {
  position: { x: number; y: number };
  onConfigure: () => void;
  onCopy?: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

function formatSeconds(frame: number | null, tickRate: number): string {
  if (frame === null || !Number.isFinite(frame)) return '—';
  return `${(frame / Math.max(1, tickRate)).toFixed(2)}秒`;
}

function formatDuration(seconds: number): string {
  if (Number.isInteger(seconds)) return `${seconds}秒`;
  return `${seconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}秒`;
}

export function TimelineWaitContextMenu({
  position,
  onConfigure,
  onCopy,
  onRemove,
  onCancel,
}: TimelineWaitContextMenuProps) {
  const run = (callback: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    callback();
  };

  return (
    <div
      className="skill-button-context-menu timeline-wait-context-menu"
      role="menu"
      aria-label="等待操作"
      style={{ left: position.x, top: position.y }}
      onMouseDown={event => event.stopPropagation()}
    >
      <button type="button" role="menuitem" className="context-menu-item" onClick={run(onConfigure)}>
        修改等待
      </button>
      {onCopy ? (
        <button type="button" role="menuitem" className="context-menu-item" onClick={run(onCopy)}>
          复制
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item context-menu-item-danger"
        onClick={run(onRemove)}
      >
        删除
      </button>
      <button type="button" role="menuitem" className="context-menu-item" onClick={run(onCancel)}>
        取消
      </button>
    </div>
  );
}

/**
 * 等待不是技能按钮。它在画布上始终是一个真实的时间区间：两端光标
 * 表示全局时间边界，中间轨道只是这一列的交互把手。
 */
export function TimelineWaitSegment({
  button,
  left,
  top,
  width,
  startFrame,
  endFrame,
  tickRate,
  isBrowseMode = false,
  isDragDisabled = false,
  onMouseDown,
  onContextMenu,
  onConfigure,
  contextMenuState = null,
  onConfirmRemove,
  onCloseContextMenu,
  onCopy,
}: TimelineWaitSegmentProps) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInteractionDisabled = isBrowseMode || isDragDisabled || Boolean(button.isLocked);
  const config = button.forcedWaitConfig ?? { schemaVersion: 1 as const, mode: 'seal-only' as const };
  const isFixedDuration = config.mode === 'fixed-duration';
  const label = isFixedDuration ? '普通等待' : '封组等待';
  const detail = isFixedDuration ? formatDuration(config.durationSeconds) : '0秒';
  const shouldRenderContextMenu = !isBrowseMode
    && contextMenuState?.buttonId === button.id
    && typeof document !== 'undefined';

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const handleMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isInteractionDisabled) return;

    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      onMouseDown(event, button.id);
    }, 200);

    const handleMouseUp = () => {
      clearLongPress();
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mouseup', handleMouseUp);
  }, [button.id, clearLongPress, isInteractionDisabled, onMouseDown]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearLongPress();
    if (!isBrowseMode) onConfigure?.(button);
  }, [button, clearLongPress, isBrowseMode, onConfigure]);

  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearLongPress();
    if (!isBrowseMode) onContextMenu(event, button.id);
  }, [button.id, clearLongPress, isBrowseMode, onContextMenu]);

  return (
    <>
      <div
        className={`timeline-wait-segment is-${config.mode}${button.isSelected ? ' selected' : ''}${button.isDragging ? ' dragging' : ''}${isInteractionDisabled ? ' is-disabled' : ''}`}
        data-skill-button-id={button.id}
        data-timeline-module="forced-wait"
        data-wait-mode={config.mode}
        role="button"
        tabIndex={isBrowseMode ? -1 : 0}
        aria-label={`${label}，${formatSeconds(startFrame, tickRate)}到${formatSeconds(endFrame, tickRate)}`}
        aria-disabled={isInteractionDisabled}
        title={`${label} · ${formatSeconds(startFrame, tickRate)}—${formatSeconds(endFrame, tickRate)}；双击设置，长按拖动`}
        style={{ left, top, width } as CSSProperties}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !isBrowseMode) {
            event.preventDefault();
            onConfigure?.(button);
          }
        }}
      >
        <i className="timeline-wait-cursor is-start" aria-hidden="true">
          <b>{formatSeconds(startFrame, tickRate)}</b>
        </i>
        <span className="timeline-wait-track">
          <b>{label}</b>
          <small>{detail}</small>
        </span>
        <i className="timeline-wait-cursor is-end" aria-hidden="true">
          <b>{formatSeconds(endFrame, tickRate)}</b>
        </i>
      </div>
      {shouldRenderContextMenu ? createPortal(
        <TimelineWaitContextMenu
          position={contextMenuState.position}
          onConfigure={() => {
            onCloseContextMenu?.();
            onConfigure?.(button);
          }}
          onCopy={onCopy ? () => onCopy() : undefined}
          onRemove={() => onConfirmRemove?.()}
          onCancel={() => onCloseContextMenu?.()}
        />,
        document.body,
      ) : null}
    </>
  );
}
