import { useMemo, useState } from 'react';
import type { ForcedWaitConfig } from '../../types';
import './ForcedWaitConfigDialog.css';

interface ForcedWaitConfigDialogProps {
  initialConfig?: ForcedWaitConfig;
  tickRate: number;
  onCancel: () => void;
  onConfirm: (config: ForcedWaitConfig) => void;
}

const WAIT_PRESETS = [0.1, 0.2, 0.5, 1, 2, 3, 5] as const;

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function ForcedWaitConfigDialog({
  initialConfig,
  tickRate,
  onCancel,
  onConfirm,
}: ForcedWaitConfigDialogProps) {
  const initialMode = initialConfig?.mode ?? 'seal-only';
  const [mode, setMode] = useState<ForcedWaitConfig['mode']>(initialMode);
  const [durationText, setDurationText] = useState(
    initialConfig?.mode === 'fixed-duration'
      ? String(initialConfig.durationSeconds)
      : '1',
  );
  const durationSeconds = Number(durationText);
  const validDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const durationFrames = useMemo(
    () => validDuration ? Math.max(1, Math.round(durationSeconds * tickRate)) : 0,
    [durationSeconds, tickRate, validDuration],
  );

  const confirm = () => {
    if (mode === 'seal-only') {
      onConfirm({ schemaVersion: 1, mode: 'seal-only' });
      return;
    }
    if (!validDuration) return;
    onConfirm({
      schemaVersion: 1,
      mode: 'fixed-duration',
      durationSeconds,
    });
  };

  return (
    <div className="forced-wait-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="forced-wait-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forced-wait-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <span>第五站位 / 时间控制</span>
          <h2 id="forced-wait-dialog-title">设置等待</h2>
          <p>这一整列会封住前一组，并只影响它后面的释放关系。</p>
        </header>

        <div className="forced-wait-mode-grid">
          <button
            type="button"
            className={mode === 'seal-only' ? 'is-selected' : ''}
            onClick={() => setMode('seal-only')}
          >
            <b>只封组</b>
            <span>占一列，真实时间推进 0 秒</span>
          </button>
          <button
            type="button"
            className={mode === 'fixed-duration' ? 'is-selected' : ''}
            onClick={() => setMode('fixed-duration')}
          >
            <b>普通等待</b>
            <span>推进全局时间并自然恢复共享技力</span>
          </button>
        </div>

        {mode === 'fixed-duration' ? (
          <div className="forced-wait-duration-editor">
            <label htmlFor="forced-wait-duration">等待秒数</label>
            <div>
              <input
                id="forced-wait-duration"
                type="number"
                min={1 / tickRate}
                step={1 / tickRate}
                value={durationText}
                onChange={event => setDurationText(event.target.value)}
                autoFocus
              />
              <span>秒</span>
            </div>
            <nav aria-label="常用等待时长">
              {WAIT_PRESETS.map(seconds => (
                <button
                  type="button"
                  key={seconds}
                  className={durationSeconds === seconds ? 'is-selected' : ''}
                  onClick={() => setDurationText(String(seconds))}
                >
                  {formatSeconds(seconds)}s
                </button>
              ))}
            </nav>
            <p className={validDuration ? '' : 'is-error'}>
              {validDuration
                ? `按 ${tickRate}Hz 状态机执行 ${durationFrames} 帧；列宽仍固定为一格。`
                : '请输入大于 0 的等待时间。'}
            </p>
          </div>
        ) : (
          <div className="forced-wait-seal-note">
            时间斜率为零，但这一列仍是不可穿透的分组边界。
          </div>
        )}

        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="is-primary"
            disabled={mode === 'fixed-duration' && !validDuration}
            onClick={confirm}
          >
            应用等待
          </button>
        </footer>
      </section>
    </div>
  );
}
