import type {
  ActionTailTimingContract,
  BasicAttackCutOption,
} from '../../core/domain/combatActionTailPlanner';
import './BasicAttackCutDialog.css';

type BasicAttackCutDialogProps = {
  predecessorLabel: string;
  successorLabel: string;
  contract: ActionTailTimingContract;
  options: BasicAttackCutOption[];
  selectedStageCount: number;
  tickRate: number;
  onSelectedStageCountChange: (stageCount: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

function seconds(frames: number, tickRate: number): string {
  return `${(frames / tickRate).toFixed(2)}s`;
}

function percent(frame: number, naturalEnd: number): number {
  if (naturalEnd <= 0) return 0;
  return Math.max(0, Math.min(100, frame / naturalEnd * 100));
}

export function BasicAttackCutDialog({
  predecessorLabel,
  successorLabel,
  contract,
  options,
  selectedStageCount,
  tickRate,
  onSelectedStageCountChange,
  onCancel,
  onConfirm,
}: BasicAttackCutDialogProps) {
  const selected = options.find(option => option.stageCount === selectedStageCount)
    ?? options[options.length - 1];
  if (!selected) return null;

  const naturalEnd = contract.naturalEndOffsetFrames;
  const cutFrame = selected.transition.blockingEndOffsetFrames;
  const markers = contract.commitEvents
    .filter(event => event.basicStageOrdinal !== undefined)
    .map(event => ({
      id: event.id,
      stage: event.basicStageOrdinal as number,
      commitFrame: event.commitOffsetFrames,
      effectFrame: event.effectOffsetFrames ?? event.commitOffsetFrames,
    }));

  return (
    <div className="basic-cut-overlay" role="presentation" onMouseDown={onCancel}>
      <section
        className="basic-cut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="basic-cut-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="basic-cut-header">
          <div>
            <span className="basic-cut-eyebrow">普攻提前衔接</span>
            <h3 id="basic-cut-title">选择打出几段普攻</h3>
            <p>{predecessorLabel} → {successorLabel}</p>
          </div>
          <button type="button" className="basic-cut-close" onClick={onCancel} aria-label="取消拼接">×</button>
        </header>

        <div className="basic-cut-track-card">
          <div className="basic-cut-track-labels">
            <span>0.00s</span>
            <strong>第 {selected.stageCount} 段后衔接</strong>
            <span>{seconds(naturalEnd, tickRate)}</span>
          </div>
          <div className="basic-cut-track" aria-hidden="true">
            <span
              className="basic-cut-track-fill"
              style={{ width: `${percent(cutFrame, naturalEnd)}%` }}
            />
            {markers.map(marker => (
              <span
                key={marker.id}
                className={`basic-cut-hit${marker.stage <= selected.stageCount ? ' is-settled' : ' is-pruned'}`}
                style={{ left: `${percent(marker.effectFrame, naturalEnd)}%` }}
                title={`第 ${marker.stage} 段 · ${seconds(marker.effectFrame, tickRate)}`}
              >
                {marker.stage}
              </span>
            ))}
            <span
              className="basic-cut-cursor"
              style={{ left: `${percent(cutFrame, naturalEnd)}%` }}
            />
          </div>
          <input
            className="basic-cut-range"
            type="range"
            min={1}
            max={options.length}
            step={1}
            value={selected.stageCount}
            onChange={event => onSelectedStageCountChange(Number(event.target.value))}
            aria-label="选择普攻段数"
          />
          <div className="basic-cut-stage-labels" aria-hidden="true">
            {options.map(option => (
              <span key={option.stageCount}>{option.stageCount}</span>
            ))}
          </div>
        </div>

        <div className="basic-cut-summary">
          <div>
            <span>已结算</span>
            <strong>{selected.transition.settledEventIds.length} 个节点</strong>
          </div>
          <div>
            <span>后继起手</span>
            <strong>{seconds(cutFrame, tickRate)}</strong>
          </div>
          <div>
            <span>压缩后摇</span>
            <strong>{seconds(selected.transition.compressedFrames, tickRate)}</strong>
          </div>
        </div>

        <p className="basic-cut-note">
          战技、连携与闪避只中断当前动画，不重置未完成的普攻连段；终结技与封组会重置。
          确认后两项锁为一个拼接，若要修改，请右键删除后面的动作再重新吸附。
        </p>

        <footer className="basic-cut-actions">
          <button type="button" className="basic-cut-secondary" onClick={onCancel}>取消并移除后继</button>
          <button type="button" className="basic-cut-primary" onClick={onConfirm}>确认并锁定拼接</button>
        </footer>
      </section>
    </div>
  );
}
