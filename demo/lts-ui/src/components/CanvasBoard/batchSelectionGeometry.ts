export interface BatchSelectionPoint {
  x: number;
  y: number;
}

export interface BatchSelectionDraft extends BatchSelectionPoint {
  startX: number;
  startY: number;
}

export interface BatchSelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function normalizeBatchSelectionRect(draft: BatchSelectionDraft): BatchSelectionRect {
  const left = Math.min(draft.startX, draft.x);
  const top = Math.min(draft.startY, draft.y);
  return {
    left,
    top,
    width: Math.abs(draft.x - draft.startX),
    height: Math.abs(draft.y - draft.startY),
  };
}

export function getBatchSelectionPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  canvas: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollLeft' | 'scrollTop'>,
): BatchSelectionPoint {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left + canvas.scrollLeft,
    y: event.clientY - bounds.top + canvas.scrollTop,
  };
}

function pointIsInsideRect(point: BatchSelectionPoint, rect: BatchSelectionRect): boolean {
  return point.x >= rect.left
    && point.x <= rect.left + rect.width
    && point.y >= rect.top
    && point.y <= rect.top + rect.height;
}

function getOperationCenter(element: HTMLElement): BatchSelectionPoint | null {
  const centerElement = element.querySelector<HTMLElement>(
    '.skill-button-orb, .timeline-wait-track, .timeline-switch-track',
  ) ?? element;
  const bounds = centerElement.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
}

/**
 * Read operation centers from the visible viewport only. In particular, the
 * skill orb—not the wider hit box or a state badge—is the selection target.
 */
export function collectVisibleOperationCenters(
  canvas: HTMLElement,
  selectableButtonIds: ReadonlySet<string>,
): Map<string, BatchSelectionPoint> {
  const canvasBounds = canvas.getBoundingClientRect();
  const centers = new Map<string, BatchSelectionPoint>();
  const elements = canvas.querySelectorAll<HTMLElement>('[data-skill-button-id]');

  elements.forEach((element) => {
    const buttonId = element.dataset.skillButtonId;
    if (!buttonId || !selectableButtonIds.has(buttonId)) return;
    const center = getOperationCenter(element);
    if (!center) return;
    if (
      center.x < canvasBounds.left
      || center.x > canvasBounds.right
      || center.y < canvasBounds.top
      || center.y > canvasBounds.bottom
    ) {
      return;
    }
    centers.set(buttonId, {
      x: center.x - canvasBounds.left + canvas.scrollLeft,
      y: center.y - canvasBounds.top + canvas.scrollTop,
    });
  });

  return centers;
}

export function selectOperationIdsByCenter(
  rect: BatchSelectionRect,
  centers: ReadonlyMap<string, BatchSelectionPoint>,
): string[] {
  return Array.from(centers.entries())
    .filter(([, center]) => pointIsInsideRect(center, rect))
    .map(([buttonId]) => buttonId);
}
