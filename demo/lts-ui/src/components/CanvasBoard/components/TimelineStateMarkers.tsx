import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AkeCombatStateEvent } from '../../../core/services/akeRuntimeLedger';
import { normalizeAssetUrl } from '../../../utils/assetResolver';
import { layoutStateMarkers, stateBadgeRuns, STATE_BADGE_GAP, STATE_BADGE_SIZE, type MarkerRect } from '../stateMarkerLayout';
import { stateMarkerTone } from '../stateMarkerTone';
import './TimelineStateMarkers.css';

export type ProjectedStateMarker = {
  event: AkeCombatStateEvent; x: number; lineIndex: number; description: string;
};
interface Props {
  events: ProjectedStateMarker[];
  left: number;
  right: number;
  laneForLine: (line: number) => { top: number; bottom: number; anchorY: number };
  onInspectCommand?: (id: string) => void;
}
// Measure visible ink and controls, not the mostly empty 80 × 78 skill hitbox.
// RIA uses the selector on the layer to inspect the same obstacles.
const OBSTACLES = [
  '.ake-release-caption-lane > span',
  '.skill-button-orb', '.skill-button-temporal-kind', '.skill-button-release-relation',
  '.skill-button-tail-bundle-badge', '.skill-button-inspect-damage',
  '.ake-action-interval > i', '.ake-action-interval > i > b',
  '.ake-interaction-event-marker', '.ake-combo-trigger-marker', '.ake-combo-precision-window',
  '.ake-hit-marker', '.ake-hit-marker > span', '.ake-preview-hit-marker', '.ake-preview-hit-marker > *',
  '.ake-effect-tail > span', '.timeline-wait-segment', '.timeline-operator-switch-segment',
].join(',');
export function TimelineStateMarkers({ events, left, right, laneForLine, onInspectCommand }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [obstacles, setObstacles] = useState<MarkerRect[] | null>(null);
  const [sources, setSources] = useState<Record<string, MarkerRect>>({});
  const [detail, setDetail] = useState<{ keys: string[]; x: number; y: number } | null>(null);
  const detailEvents = detail ? events.filter(item => detail.keys.includes(item.event.key)) : [];
  const closeDetails = () => { setDetail(null); openerRef.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [detail]);
  useLayoutEffect(() => {
    const layer = layerRef.current, canvas = layer?.closest('.canvas-container');
    if (!layer || !canvas) return;
    let pending = 0;
    const measure = () => {
      pending = 0;
      const origin = layer.getBoundingClientRect();
      const scaleX = origin.width / layer.offsetWidth, scaleY = origin.height / layer.offsetHeight;
      if (!scaleX || !scaleY) return;
      const rects: MarkerRect[] = [];
      const sourceRects: Record<string, MarkerRect> = {};
      const localRect = (rect: DOMRect): MarkerRect => ({
        left: (rect.left - origin.left) / scaleX, top: (rect.top - origin.top) / scaleY,
        width: rect.width / scaleX, height: rect.height / scaleY,
      });
      canvas.querySelectorAll<HTMLElement>('[data-skill-button-id]').forEach(button => {
        const orb = button.querySelector('.skill-button-orb');
        if (!orb) return;
        const rect = button.getBoundingClientRect(), ink = orb.getBoundingClientRect();
        if (!rect.width || ink.top < origin.top || ink.bottom > origin.bottom) return;
        sourceRects[button.dataset.skillButtonId!] = { ...localRect(rect), top: localRect(ink).top };
      });
      canvas.querySelectorAll<HTMLElement>(OBSTACLES).forEach(element => {
        // The kind label has a wide layout box; only its text is visible ink.
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = element.matches('.skill-button-temporal-kind')
          ? range.getBoundingClientRect() : element.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < origin.top || rect.top > origin.bottom) return;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return;
        const round = (value: number) => Math.round(value * 100) / 100;
        rects.push({ left: round((rect.left - origin.left) / scaleX), top: round((rect.top - origin.top) / scaleY),
          width: round(rect.width / scaleX), height: round(rect.height / scaleY) });
      });
      setObstacles(previous => JSON.stringify(previous) === JSON.stringify(rects) ? previous : rects);
      setSources(previous => JSON.stringify(previous) === JSON.stringify(sourceRects) ? previous : sourceRects);
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    canvas.querySelectorAll(OBSTACLES).forEach(element => resize.observe(element));
    const changes = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element
        ? record.target : record.target.parentElement)?.closest('.ake-state-markers-layer'))) schedule();
    });
    changes.observe(canvas, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(pending); resize.disconnect(); changes.disconnect(); window.removeEventListener('resize', schedule); };
  });
  const lanes = new Map<number, ProjectedStateMarker[]>();
  events.forEach(item => { const lane = lanes.get(item.lineIndex) ?? []; lane.push(item); lanes.set(item.lineIndex, lane); });
  const openDetails = (keys: string[], element: HTMLElement) => {
    const rect = element.getBoundingClientRect(); openerRef.current = element;
    setDetail({ keys, x: Math.max(8, Math.min(rect.left, innerWidth - 388)),
      y: Math.max(8, Math.min(rect.bottom + 8, innerHeight - 270)) });
  };
  const stateIcon = (event: AkeCombatStateEvent) => event.iconUrl
    ? <span className="ake-state-icon-mask" aria-hidden="true"
      style={{ '--state-icon': `url(${JSON.stringify(normalizeAssetUrl(event.iconUrl))})` } as CSSProperties} />
    : <span className="ake-state-icon-fallback" aria-hidden="true">{(event.shortLabel ?? event.label).slice(0, 1)}</span>;
  const detailIcon = (event: AkeCombatStateEvent) => <span aria-hidden="true"
    className={`ake-state-event-marker${event.after === 0 ? ' is-cleared' : ''}`}
    data-state-tone={stateMarkerTone(event)}>{stateIcon(event)}</span>;
  return <>
    <div ref={layerRef} className="ake-state-markers-layer" data-state-obstacle-selector={OBSTACLES}>
    {obstacles && [...lanes].flatMap(([line, items]) => {
      const lane = laneForLine(line);
      const byKey = new Map(items.map(item => [item.event.key, item]));
      const badges = stateBadgeRuns(items.map(item => item.event)).map(run => {
        const last = run[run.length - 1], item = byKey.get(last.key)!;
        return { ...item, key: run[0].key, frame: last.frame, sequence: last.sequence, width: STATE_BADGE_SIZE,
          source: last.commandId ? sources[last.commandId] : undefined,
          records: run.map(event => byKey.get(event.key)!) };
      });
      return layoutStateMarkers(badges, { left, top: lane.top, width: right - left,
        height: lane.bottom - lane.top, preferredTop: lane.top,
        obstacles }).map(group => {
        const records = group.events.flatMap(item => item.records);
        let offset = 0;
        const leaders = group.events.map(item => {
          const center = group.collapsed ? group.width / 2 : offset + item.width / 2;
          offset += item.width + STATE_BADGE_GAP;
          return { item, center };
        });
        return <div key={group.events[0].key} className="ake-state-marker-group"
          style={{ left: group.left, top: group.top, width: group.width, height: group.height, gap: STATE_BADGE_GAP }}
          role="group" aria-label={`${records.length}项状态变化`}>
          <svg className="ake-state-marker-leaders" width={group.width} height={group.height} aria-hidden="true">
            {leaders.map(({ item, center }) => <g key={item.key}>
              <path d={`M ${center} ${group.height} V ${group.height + 3} L ${item.x - group.left} ${lane.anchorY - group.top}`} />
              <circle cx={item.x - group.left} cy={lane.anchorY - group.top} r={1.3} />
            </g>)}
          </svg>
          {group.collapsed ? <button type="button" className="ake-state-event-summary"
            style={{ width: group.width }} data-state-event-keys={JSON.stringify(records.map(item => item.event.key))}
            aria-label={`${records.length}项状态变化，点击展开逐条记录`}
            title={records.map(item => item.description).join('\n')}
            onClick={event => { event.stopPropagation(); openDetails(records.map(item => item.event.key), event.currentTarget); }}>
            +{records.length}
          </button> : group.events.map(item => {
            const description = item.records.map(record => record.description).join('\n');
            return <button key={item.key} type="button"
              className={`ake-state-event-marker${item.event.after === 0 ? ' is-cleared' : ''}`}
              data-state-tone={stateMarkerTone(item.event)}
              data-state-event-keys={JSON.stringify(item.records.map(record => record.event.key))}
              data-state-event-frame={item.event.frame} data-state-event-sequence={item.event.sequence}
              data-state-stacks={item.event.after} data-state-buff-id={item.event.buffId}
              data-state-anchor-x={item.x} data-state-anchor-y={lane.anchorY}
              title={description} aria-label={description}
              onClick={event => { event.stopPropagation(); openDetails(item.records.map(record => record.event.key), event.currentTarget); }}>
              {stateIcon(item.event)}
              <b aria-hidden="true">{item.event.after === 0 ? '×' : item.event.after ?? '?'}</b>
            </button>;
          })}
        </div>;
      });
    })}
    </div>
    {detail && detailEvents.length > 0 ? createPortal(
      <div className="ake-state-detail-dismiss" onMouseDown={event => { if (event.target === event.currentTarget) closeDetails(); }}>
        <div role="dialog" aria-label="状态变化记录" className="ake-state-detail" style={{ left: detail.x, top: detail.y }}>
          <header><strong>状态变化 · {detailEvents.length} 项</strong><button type="button" onClick={closeDetails} aria-label="关闭状态记录" autoFocus>×</button></header>
          <div>{detailEvents.map(item => <button key={item.event.key} type="button" onClick={() => {
            if (item.event.commandId) { onInspectCommand?.(item.event.commandId); closeDetails(); }
          }}>{detailIcon(item.event)}<span>{item.description}{item.event.commandId ? ' · 查看动作' : ''}</span></button>)}</div>
        </div>
      </div>, document.body,
    ) : null}
  </>;
}
