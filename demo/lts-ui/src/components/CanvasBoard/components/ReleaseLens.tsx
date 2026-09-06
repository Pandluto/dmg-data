import { useEffect, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  LENS_AXIS_Y,
  RELEASE_LENS_PAGE_SIZE,
  releaseLensPage,
  type ReleaseLensView,
} from '../hooks/releaseLensModel';
import './ReleaseLens.css';

type ReleaseLensProps = {
  view: ReleaseLensView | null;
  onSelect: (id: string) => void;
  onOffsetChange: (frames: number) => void;
  onCycle: (direction: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const SVG_TOP = 48;
const SVG_HEIGHT = 140;

function keepLensMouseDown(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function secondsLabel(frames: number, tickRate: number) {
  return (frames / tickRate).toFixed(3).replace(/\.?0+$/, '');
}

export function ReleaseLens({
  view,
  onSelect,
  onOffsetChange,
  onCycle,
  onConfirm,
  onCancel,
}: ReleaseLensProps) {
  const [offsetText, setOffsetText] = useState('');
  useEffect(() => { setOffsetText(String(view?.offsetFrames ?? '')); }, [view?.offsetFrames, view?.selectedId]);
  if (!view || !view.session.ports.length) return null;

  const { session } = view;
  const { rect, sourceRect } = session;
  const page = releaseLensPage(view);
  const selected = session.ports.find(port => port.target.anchorId === view.selectedId);
  const selectedFrame = selected ? selected.eventFrame + view.offsetFrames : null;
  const selectedX = selectedFrame === null ? null : page.x(selectedFrame);
  const axisY = LENS_AXIS_Y - SVG_TOP;
  const sourceCenterX = sourceRect.left + sourceRect.width / 2;
  const lensBelow = rect.top >= sourceRect.top + sourceRect.height;
  const sourceY = lensBelow ? sourceRect.top + sourceRect.height : sourceRect.top;
  const lensY = lensBelow ? rect.top : rect.top + rect.height;
  const lensX = Math.max(rect.left + 24, Math.min(rect.left + rect.width - 24, sourceCenterX));
  const visibleHits = session.hits.filter(hit => hit.frame >= page.from && hit.frame <= page.to);
  const feedback = [view.reason, view.note].filter(Boolean).join(' · ');

  return createPortal(
    <>
      <svg className="release-lens-connection" aria-hidden="true">
        <path d={`M ${sourceCenterX} ${sourceY} L ${lensX} ${lensY}`} />
        <rect
          x={sourceRect.left - 4}
          y={sourceRect.top - 4}
          width={sourceRect.width + 8}
          height={sourceRect.height + 8}
          rx="9"
        />
      </svg>
      <section
        className={`release-lens${view.reason ? ' release-lens-blocked' : ''}`}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        role="dialog"
        aria-modal="false"
        aria-label={`${session.sourceName}接续放大镜`}
        data-release-lens={view.editing ? 'editing' : 'dragging'}
        data-lens-source={session.sourceButtonId}
        data-lens-selected={view.selectedId}
        data-lens-frame={selectedFrame ?? undefined}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
      >
        <header className="release-lens-header">
          <span className="release-lens-source-icon">
            {session.sourceIconUrl ? (
              <img src={session.sourceIconUrl} alt="" draggable={false} />
            ) : (
              <span aria-hidden="true">{session.sourceName.slice(0, 1)}</span>
            )}
          </span>
          <div className="release-lens-source-text">
            <span className="release-lens-eyebrow" title={session.successorName}>{view.editing ? "接续草稿" : "拖动接续"} · {session.successorName ?? "选择接点"}</span>
            <strong title={session.sourceName}>{session.sourceName}</strong>
          </div>
          <span className="release-lens-legend"><span>│ 命中</span><span>◇ 接点</span></span>
        </header>

        <svg
          className="release-lens-axis"
          width={rect.width}
          height={SVG_HEIGHT}
          viewBox={`0 0 ${rect.width} ${SVG_HEIGHT}`}
          style={{ top: SVG_TOP }}
          aria-label="局部命中与接续点"
        >
          <line className="release-lens-axis-line" x1={46} x2={rect.width - 30} y1={axisY} y2={axisY} />
          {[page.from, page.to].map(frame => (
            <text key={frame} className="release-lens-time" x={page.x(frame)} y={axisY - 14} textAnchor="middle">F{frame}</text>
          ))}
          {visibleHits.map((hit, index) => (
            <line
              key={`${hit.frame}:${index}`}
              className={`release-lens-hit${hit.lingering ? ' release-lens-hit-tail' : ''}`}
              x1={page.x(hit.frame)}
              x2={page.x(hit.frame)}
              y1={axisY - 7}
              y2={axisY + 7}
            >
              <title>{hit.lingering ? '拖尾命中' : '命中'} · F{hit.frame}</title>
            </line>
          ))}
          {selected && selectedX !== null && (
            <g aria-hidden="true">
              <line className="release-lens-offset-line" x1={page.x(selected.eventFrame)} x2={selectedX} y1={axisY} y2={axisY} />
              <line className="release-lens-input-line" x1={selectedX} x2={selectedX} y1={axisY - 10} y2={axisY + 12} />
              <circle className="release-lens-input-dot" cx={selectedX} cy={axisY} r="3.5" />
            </g>
          )}
          {page.positions.map(({ port, x, y }) => {
            const active = port.target.anchorId === view.selectedId;
            const localY = y - SVG_TOP;
            const sharesFrame = page.ports.filter(candidate => candidate.eventFrame === port.eventFrame).length > 1;
            return (
              <g
                key={port.target.anchorId}
                className={`release-lens-port${active ? ' release-lens-port-selected' : ''}`}
                role="button"
                aria-label={`${port.label}，F${port.eventFrame}`}
                aria-pressed={active}
                tabIndex={0}
                data-lens-port={port.target.anchorId}
                onMouseDown={keepLensMouseDown}
                onClick={() => onSelect(port.target.anchorId)}
                onKeyDown={event => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(port.target.anchorId);
                  }
                }}
              >
                <title>{port.label} · F{port.eventFrame}</title>
                <line className="release-lens-port-stem" x1={x} x2={x} y1={axisY + 8} y2={localY - 7} />
                <rect
                  className="release-lens-port-target"
                  x={x - (sharesFrame ? 12 : 34)}
                  y={localY - 11}
                  width={sharesFrame ? 116 : 68}
                  height={sharesFrame ? 22 : 36}
                  rx="5"
                />
                <path className="release-lens-diamond" d={`M ${x} ${localY - 6} l 6 6 l -6 6 l -6 -6 Z`} />
                <text
                  className="release-lens-port-label"
                  x={sharesFrame ? x + 12 : x}
                  y={localY + (sharesFrame ? 4 : 21)}
                  textAnchor={sharesFrame ? 'start' : 'middle'}
                >{port.label}</text>
              </g>
            );
          })}
        </svg>

        <div className="release-lens-controls">
          <span className="release-lens-current" title={selected?.label}>{selected?.label ?? '选择接点'}</span>
          <div className="release-lens-offset" role="group" aria-label="接点后的延迟">
            <button type="button" aria-label="减少一帧" disabled={view.offsetFrames <= 0} onMouseDown={keepLensMouseDown} onClick={() => onOffsetChange(Math.max(0, view.offsetFrames - 1))}>−</button>
            <label>
              <input
                aria-label="延迟帧数"
                type="number"
                min="0"
                step="1"
                value={offsetText}
                onFocus={event => event.currentTarget.select()}
                onMouseDown={event => event.stopPropagation()}
                onBlur={() => setOffsetText(String(view.offsetFrames))}
                onChange={event => {
                  setOffsetText(event.currentTarget.value);
                  const frames = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(frames)) onOffsetChange(frames);
                }}
              />
              <span>帧</span>
            </label>
            <button type="button" aria-label="增加一帧" onMouseDown={keepLensMouseDown} onClick={() => onOffsetChange(view.offsetFrames + 1)}>+</button>
          </div>
          <span className="release-lens-seconds">+{secondsLabel(view.offsetFrames, session.tickRate)} 秒{selectedFrame !== null && <span> · F{selectedFrame}</span>}</span>
        </div>

        <div className="release-lens-feedback" title={feedback} aria-live="polite">
          {view.reason && <strong>{view.reason}</strong>}
          {view.reason && view.note && <span> · </span>}
          {view.note && <span>{view.note}</span>}
        </div>

        <footer className="release-lens-footer">
          {view.editing ? (
            <div className="release-lens-actions">
              <button type="button" onMouseDown={keepLensMouseDown} onClick={onCancel}>取消</button>
              <button type="button" className="release-lens-apply" disabled={!view.target || Boolean(view.reason)} onMouseDown={keepLensMouseDown} onClick={onConfirm}>应用接续</button>
            </div>
          ) : (
            <span className="release-lens-hint">松手接续 · ←→逐帧 · ↑↓接点 · Esc取消</span>
          )}
          {page.pageCount > 1 && (
            <div className="release-lens-pagination" role="group" aria-label="接点分页">
              <button type="button" aria-label="上一页接点" disabled={page.page === 0} onMouseDown={keepLensMouseDown} onClick={() => onCycle(-RELEASE_LENS_PAGE_SIZE)}>‹</button>
              <span>{page.page + 1}/{page.pageCount} · 滚轮切换</span>
              <button type="button" aria-label="下一页接点" disabled={page.page >= page.pageCount - 1} onMouseDown={keepLensMouseDown} onClick={() => onCycle(RELEASE_LENS_PAGE_SIZE)}>›</button>
            </div>
          )}
        </footer>
      </section>
    </>,
    document.body,
  );
}

export default ReleaseLens;
