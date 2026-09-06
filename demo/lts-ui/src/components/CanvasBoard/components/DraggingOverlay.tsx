import { createPortal } from 'react-dom';
import { SkillType } from '../../../types';

interface DraggingOverlayProps {
  draggingState: { id: string; skillType: SkillType; skillDisplayName?: string } | null;
  mousePosition: { x: number; y: number };
  startFrame?: number | null;
  endFrame?: number | null;
  tickRate?: number;
}

const DRAG_SKILL_LABELS: Record<string, string> = {
  A: '普攻', B: '战技', E: '连携', Q: '终结', Dot: '持续',
};

/** One crisp payload beside the pointer. Timing marks belong to the snapped
 * target/lens, not another translucent ruler. Portal coordinates are viewport
 * coordinates, independent of canvas layout and reserved row heights. */
export function DraggingOverlay({ draggingState, mousePosition, startFrame = null,
  endFrame = null, tickRate = 30 }: DraggingOverlayProps) {
  if (!draggingState) return null;
  const rate = Math.max(1, tickRate);
  const title = draggingState.skillDisplayName ?? DRAG_SKILL_LABELS[draggingState.skillType] ?? draggingState.skillType;
  return createPortal(
    <div className="dragging-skill-button-preview" aria-hidden="true" data-skill-type={draggingState.skillType}
      style={{ left: Math.round(Math.max(4, Math.min(mousePosition.x + 14, innerWidth - 174))),
        top: Math.round(Math.max(4, Math.min(mousePosition.y + 16, innerHeight - 54))) }}>
      <span className="dragging-skill-token">{draggingState.skillType}</span>
      <div className="dragging-skill-caption">
        <strong>{title}</strong>
        <small>{startFrame === null ? '拖到接续点' : `${(startFrame / rate).toFixed(2)}s${endFrame === null ? '' : ` → ${(endFrame / rate).toFixed(2)}s`}`}</small>
      </div>
    </div>, document.body,
  );
}
