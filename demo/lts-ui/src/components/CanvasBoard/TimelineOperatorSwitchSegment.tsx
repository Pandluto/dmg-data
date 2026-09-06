import { useCallback, useEffect, useRef, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SkillButton } from '../../types';
import { TimelineWaitContextMenu } from './TimelineWaitSegment';

interface TimelineOperatorSwitchSegmentProps {
  button: SkillButton;
  targetName: string;
  left: number;
  top: number;
  width: number;
  frame: number | null;
  tickRate: number;
  isBrowseMode?: boolean;
  isDragDisabled?: boolean;
  onMouseDown: (event: MouseEvent, buttonId: string) => void;
  onContextMenu: (event: MouseEvent, buttonId: string) => void;
  onConfigure?: (button: SkillButton) => void;
  contextMenuState?: { buttonId: string; position: { x: number; y: number } } | null;
  onConfirmRemove?: () => void;
  removeBlockedReason?: string | null;
  onCloseContextMenu?: () => void;
  onCopy?: () => void;
}

function formatSeconds(frame: number | null, tickRate: number): string {
  if (frame === null || !Number.isFinite(frame)) return '—';
  return `${(frame / Math.max(1, tickRate)).toFixed(2)}秒`;
}

export function TimelineOperatorSwitchSegment({
  button,
  targetName,
  left,
  top,
  width,
  frame,
  tickRate,
  isBrowseMode = false,
  isDragDisabled = false,
  onMouseDown,
  onContextMenu,
  onConfigure,
  contextMenuState = null,
  onConfirmRemove,
  removeBlockedReason,
  onCloseContextMenu,
  onCopy,
}: TimelineOperatorSwitchSegmentProps) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInteractionDisabled = isBrowseMode || isDragDisabled || Boolean(button.isLocked);
  const shouldRenderContextMenu = !isBrowseMode
    && contextMenuState?.buttonId === button.id
    && typeof document !== 'undefined';

  const clearLongPress = useCallback(() => {
    if (!longPressTimerRef.current) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
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

  return (
    <>
      <div
        className={`timeline-operator-switch-segment${button.isSelected ? ' selected' : ''}${button.isDragging ? ' dragging' : ''}${isInteractionDisabled ? ' is-drag-disabled' : ''}${isBrowseMode ? ' is-browse-mode' : ''}`}
        data-skill-button-id={button.id}
        data-timeline-module="operator-switch"
        role="button"
        tabIndex={isBrowseMode ? -1 : 0}
        aria-label={`切至${targetName}，${formatSeconds(frame, tickRate)}`}
        data-drag-disabled={isInteractionDisabled || undefined}
        draggable={false}
        title={`切至 ${targetName} · ${formatSeconds(frame, tickRate)}；双击修改；队列内不可拖动`}
        style={{ left, top, width } as CSSProperties}
        onMouseDown={handleMouseDown}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearLongPress();
          if (!isBrowseMode) onConfigure?.(button);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearLongPress();
          if (!isBrowseMode) onContextMenu(event, button.id);
        }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !isBrowseMode) {
            event.preventDefault();
            onConfigure?.(button);
          }
        }}
      >
        <i className="timeline-switch-cursor is-start"><b>{formatSeconds(frame, tickRate)}</b></i>
        <span className="timeline-switch-track">
          <svg viewBox="0 0 24 16" aria-hidden="true">
            <path d="M2 5h14l-3-3m3 3-3 3M22 11H8l3-3m-3 3 3 3" />
          </svg>
          <b>切至 {targetName}</b>
          <small>0秒 · 强制打断</small>
        </span>
        <i className="timeline-switch-cursor is-end"><b>{formatSeconds(frame, tickRate)}</b></i>
      </div>
      {shouldRenderContextMenu ? createPortal(
        <TimelineWaitContextMenu
          position={contextMenuState.position}
          configureLabel="修改切人目标"
          onConfigure={() => {
            onCloseContextMenu?.();
            onConfigure?.(button);
          }}
          onCopy={onCopy}
          onRemove={() => onConfirmRemove?.()}
          removeBlockedReason={removeBlockedReason}
          onCancel={() => onCloseContextMenu?.()}
        />,
        document.body,
      ) : null}
    </>
  );
}
