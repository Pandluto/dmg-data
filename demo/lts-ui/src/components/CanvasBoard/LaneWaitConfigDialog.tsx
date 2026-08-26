import { useMemo, useState } from 'react';
import type { LaneWaitConfig } from '../../types';
import './ForcedWaitConfigDialog.css';

interface LaneWaitConfigDialogProps {
  initialConfig?: LaneWaitConfig;
  tickRate: number;
  onCancel: () => void;
  onConfirm: (config: LaneWaitConfig) => void;
}

const WAIT_PRESETS = [0.1, 0.2, 0.5, 1, 2, 3, 5] as const;

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function LaneWaitConfigDialog({
  initialConfig,
  tickRate,
  onCancel,
  onConfirm,
}: LaneWaitConfigDialogProps) {
  const initialMode = initialConfig?.mode ?? 'placeholder';
  const [mode, setMode] = useState<LaneWaitConfig['mode']>(initialMode);
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
    if (mode === 'placeholder') {
      onConfirm({ schemaVersion: 1, mode: 'placeholder' });
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
        aria-labelledby="lane-wait-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <span>单角色尾链 / 时间控制</span>
          <h2 id="lane-wait-dialog-title">设置普通等待</h2>
          <p>它只接入当前角色的尾链并影响后继动作，不封组，也不占用全局分隔列。</p>
        </header>

        <div className="forced-wait-mode-grid">
          <button
            type="button"
            className={mode === 'placeholder' ? 'is-selected' : ''}
            onClick={() => setMode('placeholder')}
          >
            <b>空白占位</b>
            <span>显示一格，真实时间推进 0 秒</span>
          </button>
          <button
            type="button"
            className={mode === 'fixed-duration' ? 'is-selected' : ''}
            onClick={() => setMode('fixed-duration')}
          >
            <b>固定等待</b>
            <span>只把当前角色后面的动作顺延</span>
          </button>
        </div>

        {mode === 'fixed-duration' ? (
          <div className="forced-wait-duration-editor">
            <label htmlFor="lane-wait-duration">等待秒数</label>
            <div>
              <input
                id="lane-wait-duration"
                type="number"
                min={1 / tickRate}
                step={1 / tickRate}
                value={durationText}
                onChange={event => setDurationText(event.target.value)}
                autoFocus
              />
              <span>秒</span>
            </div>
            <nav aria-label="常用普通等待时长">
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
                ? `按 ${tickRate}Hz 状态机执行 ${durationFrames} 帧；不会生成新的释放大组。`
                : '请输入大于 0 的等待时间。'}
            </p>
          </div>
        ) : (
          <div className="forced-wait-seal-note">
            这一格只是可配置的尾链占位；时间斜率为零，前后仍属于同一大组。
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
            应用普通等待
          </button>
        </footer>
      </section>
    </div>
  );
}
