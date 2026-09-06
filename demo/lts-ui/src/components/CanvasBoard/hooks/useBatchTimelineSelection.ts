import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  collectVisibleOperationCenters,
  getBatchSelectionPoint,
  normalizeBatchSelectionRect,
  selectOperationIdsByCenter,
  type BatchSelectionDraft,
  type BatchSelectionRect,
} from '../batchSelectionGeometry';

interface UseBatchTimelineSelectionOptions {
  active: boolean;
  canvasRef: RefObject<HTMLDivElement>;
  selectableButtonIds: readonly string[];
  resetKey: string;
  onExit: () => void;
  onSelectionCancel: () => void;
}

export const BATCH_SELECTION_CLICK_SLOP_PX = 4;

export function isBatchSelectionClick(
  start: { x: number; y: number } | null,
  end: { x: number; y: number },
): boolean {
  if (!start) return false;
  return Math.hypot(end.x - start.x, end.y - start.y) <= BATCH_SELECTION_CLICK_SLOP_PX;
}

export function shouldExitBatchTimelineOnEscape(
  selectedButtonCount: number,
  hasDraft: boolean,
): boolean {
  return selectedButtonCount === 0 && !hasDraft;
}

export function shouldResetBatchTimelineSelection(
  previousResetKey: string | null,
  nextResetKey: string,
): boolean {
  return previousResetKey !== nextResetKey;
}

export function useBatchTimelineSelection({
  active,
  canvasRef,
  selectableButtonIds,
  resetKey,
  onExit,
  onSelectionCancel,
}: UseBatchTimelineSelectionOptions) {
  const [selectedButtonIds, setSelectedButtonIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<BatchSelectionDraft | null>(null);
  const draftRef = useRef<BatchSelectionDraft | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const pointerCaptureTargetRef = useRef<HTMLDivElement | null>(null);
  const previousResetKeyRef = useRef<string | null>(null);
  const selectableButtonIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    selectableButtonIdsRef.current = new Set(selectableButtonIds);
    setSelectedButtonIds((current) => {
      const next = current.filter((buttonId) => selectableButtonIdsRef.current.has(buttonId));
      return next.length === current.length ? current : next;
    });
  }, [selectableButtonIds]);

  const clearSelection = useCallback(() => {
    setSelectedButtonIds([]);
  }, []);

  const releasePointerCapture = useCallback(() => {
    const target = pointerCaptureTargetRef.current;
    const pointerId = pointerIdRef.current;
    if (target && pointerId !== null) {
      try {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture?.(pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }
    }
    pointerCaptureTargetRef.current = null;
  }, []);

  const clearDraft = useCallback(() => {
    releasePointerCapture();
    pointerIdRef.current = null;
    pointerStartClientRef.current = null;
    draftRef.current = null;
    setDraft(null);
  }, [releasePointerCapture]);

  const cancelSelection = useCallback(() => {
    clearDraft();
    clearSelection();
    onSelectionCancel();
  }, [clearDraft, clearSelection, onSelectionCancel]);

  useEffect(() => {
    const resetKeyChanged = shouldResetBatchTimelineSelection(
      previousResetKeyRef.current,
      resetKey,
    );
    previousResetKeyRef.current = resetKey;
    clearDraft();
    if (!active || resetKeyChanged) {
      clearSelection();
    }
  }, [active, clearDraft, clearSelection, resetKey]);

  useEffect(() => {
    if (!active) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      const shouldExit = shouldExitBatchTimelineOnEscape(
        selectedButtonIds.length,
        draftRef.current !== null,
      );
      event.preventDefault();
      cancelSelection();
      if (shouldExit) onExit();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, cancelSelection, clearDraft, onExit, selectedButtonIds.length]);

  const finishSelection = useCallback((selectionDraft: BatchSelectionDraft) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      clearDraft();
      clearSelection();
      return;
    }

    const rect = normalizeBatchSelectionRect(selectionDraft);
    const centers = collectVisibleOperationCenters(canvas, selectableButtonIdsRef.current);
    setSelectedButtonIds(selectOperationIdsByCenter(rect, centers));
    clearDraft();
  }, [canvasRef, clearDraft, clearSelection]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    event.preventDefault();
    event.stopPropagation();
    pointerIdRef.current = event.pointerId;
    pointerStartClientRef.current = { x: event.clientX, y: event.clientY };
    const point = getBatchSelectionPoint(event, canvas);
    const nextDraft = {
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
    };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerCaptureTargetRef.current = event.currentTarget;
  }, [active, canvasRef]);

  useEffect(() => {
    if (!active || !draft) return undefined;

    const matchesPointer = (event: PointerEvent) => (
      pointerIdRef.current === null || event.pointerId === pointerIdRef.current
    );
    const handlePointerMove = (event: PointerEvent) => {
      if (!matchesPointer(event)) return;
      const canvas = canvasRef.current;
      if (!canvas || !draftRef.current) return;
      const point = getBatchSelectionPoint(event, canvas);
      const nextDraft = { ...draftRef.current, x: point.x, y: point.y };
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!matchesPointer(event) || !draftRef.current) return;
      const isClick = isBatchSelectionClick(pointerStartClientRef.current, {
        x: event.clientX,
        y: event.clientY,
      });
      if (isClick) {
        cancelSelection();
        return;
      }
      finishSelection(draftRef.current);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (!matchesPointer(event)) return;
      clearDraft();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [
    active,
    canvasRef,
    cancelSelection,
    draft,
    finishSelection,
  ]);

  const normalizedSelectionRect: BatchSelectionRect | null = draft
    ? normalizeBatchSelectionRect(draft)
    : null;
  const selectedButtonIdSet = useMemo(
    () => new Set(selectedButtonIds),
    [selectedButtonIds],
  );

  return {
    selectedButtonIds,
    selectedButtonIdSet,
    selectionRect: normalizedSelectionRect,
    handlePointerDown,
    handlePointerCancel: clearDraft,
    clearSelection,
    cancelSelection,
  };
}
