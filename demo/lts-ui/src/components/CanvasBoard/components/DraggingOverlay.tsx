/**
 * 拖拽遮罩层（DraggingOverlay）
 *
 * 只负责拖动中的视觉预览，不参与吸附、落点和存储计算。
 */

import type { CSSProperties } from 'react';
import { SkillType } from '../../../types';

interface DraggingState {
  id: string;
  skillType: SkillType;
}

interface DraggingOverlayProps {
  /** 当前拖拽状态（null = 无拖拽，不渲染遮罩） */
  draggingState: DraggingState | null;
  /** 鼠标在页面上的坐标 */
  mousePosition: { x: number; y: number };
  /** 预演得到的真实起止帧；浮动标尺与落点后的标尺共用同一套秒数。 */
  startFrame?: number | null;
  endFrame?: number | null;
  tickRate?: number;
}

const DRAG_SKILL_LABELS: Record<string, string> = {
  A: '普攻',
  B: '战技',
  E: '连携',
  Q: '终结',
  Dot: '持续',
};

export function DraggingOverlay({
  draggingState,
  mousePosition,
  startFrame = null,
  endFrame = null,
  tickRate = 30,
}: DraggingOverlayProps) {
  if (!draggingState) return null;

  const previewSize = 24;
  const radius = previewSize / 2;
  const safeTickRate = Math.max(1, Number(tickRate) || 30);
  const formatFrame = (frame: number | null) => (
    frame === null ? '—' : `${(frame / safeTickRate).toFixed(2)}秒`
  );

  return (
    <div
      className="dragging-skill-button-preview"
      data-skill-type={draggingState.skillType}
      style={{
        left: mousePosition.x - 40,
        top: mousePosition.y - 45,
        width: 80,
        height: 60,
        '--drag-preview-size': `${previewSize}px`,
        '--drag-preview-radius': `${radius}px`,
      } as CSSProperties}
    >
      <div className="dragging-skill-button-anchor">
        <div className="dragging-skill-button-base">
          <b>{formatFrame(startFrame)}</b>
          <i>{formatFrame(endFrame)}</i>
        </div>
        <span className="dragging-skill-button-kind">
          {DRAG_SKILL_LABELS[draggingState.skillType] ?? draggingState.skillType}
        </span>
        <div className="dragging-skill-button-orb">
          <span>{draggingState.skillType}</span>
        </div>
      </div>
    </div>
  );
}
