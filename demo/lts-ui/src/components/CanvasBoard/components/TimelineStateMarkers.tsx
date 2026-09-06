import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AkeCombatStateEvent } from '../../../core/services/akeRuntimeLedger';
import { normalizeAssetUrl } from '../../../utils/assetResolver';
import {
  layoutStateMarkers,
  stateBadgeRuns,
  STATE_BADGE_GAP,
  STATE_BADGE_SIZE,
  type MarkerRect,
} from '../stateMarkerLayout';
import { stateMarkerTone } from '../stateMarkerTone';
import './TimelineStateMarkers.css';

export type ProjectedStateMarker = {
  event: AkeCombatStateEvent;
  x: number;
  lineIndex: number;
  description: string;
  fromFrame?: number;
  toFrame?: number;
  clipped?: boolean;
};

interface Props {
  events: ProjectedStateMarker[];
  isBrowseMode: boolean;
  left: number;
  right: number;
  laneForLine: (line: number) => { top: number; bottom: number; anchorY: number };
  onInspectCommand?: (id: string) => void;
}

// Measure the ordinary timeline geometry in the current canvas. The reading
// card is presentation-only; its preserved hidden anchor supplies the same
// obstacle rects in both modes.
const OBSTACLES = [
  '.ake-release-caption-lane > span',
  '.skill-button-orb', '.skill-button-temporal-kind', '.skill-button-release-relation',
  '.skill-button-tail-bundle-badge', '.skill-button-inspect-damage',
  '.ake-action-interval > i', '.ake-action-interval > i > b',
  '.ake-interaction-event-marker', '.ake-combo-trigger-marker', '.ake-combo-precision-window',
  '.ake-hit-marker', '.ake-hit-marker > span', '.ake-preview-hit-marker', '.ake-preview-hit-marker > *',
  '.ake-effect-tail > span', '.timeline-wait-segment', '.timeline-operator-switch-segment',
].join(',');

const isReadingCardElement = (element: Element) => Boolean(element.closest('.skill-button-reading-card'));
const isReadingHiddenElement = (element: Element) => Boolean(
  element.closest('[data-ake-reading-hidden="true"]'),
);

export function TimelineStateMarkers({
  events,
  isBrowseMode,
  left,
  right,
  laneForLine,
  onInspectCommand,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [obstacles, setObstacles] = useState<MarkerRect[] | null>(null);
  const [owners, setOwners] = useState<Record<string, {left:number;right:number;top:number}>>({});
  const [detail, setDetail] = useState<{ keys: string[]; x: number; y: number } | null>(null);
  const detailEvents = detail ? events.filter(item => detail.keys.includes(item.event.key)) : [];
  const closeDetails = () => { setDetail(null); openerRef.current?.focus({ preventScroll: true }); };

  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); }
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [detail]);

  useLayoutEffect(() => {
    const layer = layerRef.current, canvas = layer?.closest('.canvas-container');
    if (!layer || !canvas) return;
    let pending = 0;
    const obstacleElements = () => [...canvas.querySelectorAll<HTMLElement>(OBSTACLES)]
      .filter(element => !isReadingCardElement(element));
    const measure = () => {
      pending = 0;
      const origin = layer.getBoundingClientRect();
      const scaleX = origin.width / layer.offsetWidth, scaleY = origin.height / layer.offsetHeight;
      if (!scaleX || !scaleY) return;
      const rects: MarkerRect[] = [];
      const ownerEdges: Record<string, {left:number;right:number;top:number}> = {};
      obstacleElements().forEach(element => {
        const readingHidden = isReadingHiddenElement(element);
        const retainedBrowseProjection = canvas.classList.contains('is-browse-mode')
          && Boolean(element.closest('.ake-canvas-projection'));
        const owner = element.closest<HTMLElement>('[data-skill-button-id]');
        const ownerStyle = owner ? getComputedStyle(owner) : null;
        if (ownerStyle?.display === 'none' || ownerStyle?.opacity === '0'
          || (!readingHidden && ownerStyle?.visibility === 'hidden')) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < origin.top || rect.top > origin.bottom) return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.opacity === '0') return;
        if (!readingHidden && !retainedBrowseProjection && style.visibility === 'hidden') return;
        // The kind label has a wide layout box; only its visible text is ink.
        const visibleRect = element.matches('.skill-button-temporal-kind')
          ? (() => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); })()
          : rect;
        if (!visibleRect.width || !visibleRect.height) return;
        const round = (value: number) => Math.round(value * 100) / 100;
        // Wait/switch cards grow in reading mode; their ordinary obstacle
        // height stays fixed by the component's CSS geometry contract.
        const ordinaryHeight = Number.parseFloat(style.getPropertyValue('--state-obstacle-height'));
        if (owner && element.matches('.skill-button-orb, .skill-button-temporal-kind')) {
          const id=owner.dataset.skillButtonId!;
          const previous=ownerEdges[id];
          ownerEdges[id]={
            left:Math.min(previous?.left ?? Infinity,(visibleRect.left-origin.left)/scaleX),
            right:Math.max(previous?.right ?? -Infinity,(visibleRect.right-origin.left)/scaleX),
            top:Math.min(previous?.top ?? Infinity,(visibleRect.top-origin.top)/scaleY),
          };
        }
        rects.push({ left: round((visibleRect.left - origin.left) / scaleX), top: round((visibleRect.top - origin.top) / scaleY),
          width: round(visibleRect.width / scaleX), height: Number.isFinite(ordinaryHeight)
            ? ordinaryHeight : round(visibleRect.height / scaleY) });
      });
      setObstacles(previous => JSON.stringify(previous) === JSON.stringify(rects) ? previous : rects);
      setOwners(previous => JSON.stringify(previous) === JSON.stringify(ownerEdges) ? previous : ownerEdges);
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    obstacleElements().forEach(element => resize.observe(element));
    const changes = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element
        ? record.target : record.target.parentElement)?.closest('.ake-state-markers-layer'))) schedule();
    });
    changes.observe(canvas, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(pending);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
    };
  });

  const lanes = new Map<number, ProjectedStateMarker[]>();
  events.forEach(item => {
    const lane = lanes.get(item.lineIndex) ?? [];
    lane.push(item);
    lanes.set(item.lineIndex, lane);
  });
  const openDetails = (keys: string[], element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    openerRef.current = element;
    setDetail({ keys, x: Math.max(8, Math.min(rect.left, innerWidth - 388)),
      y: Math.max(8, Math.min(rect.bottom + 8, innerHeight - 270)) });
  };
  const stateIcon = (event: AkeCombatStateEvent) => event.iconUrl
    ? <span className="ake-state-icon-mask" aria-hidden="true"
      style={{ '--state-icon': `url(${JSON.stringify(normalizeAssetUrl(event.iconUrl))})` } as CSSProperties} />
    : <span className="ake-state-icon-fallback" aria-hidden="true">{(event.shortLabel ?? event.label).slice(0, 1)}</span>;
  const detailIcon = (event: AkeCombatStateEvent) => <span aria-hidden="true"
    className={`ake-state-event-marker${event.after === 0 ? ' is-cleared' : ''}`}
    data-state-tone={stateMarkerTone(event)} data-state-event-frame={event.frame}
    data-state-source-command-id={event.sourceCommandId ?? undefined}
    data-state-trigger-command-id={event.triggerCommandId ?? undefined}>{stateIcon(event)}</span>;
  const rangeOf = (records: ProjectedStateMarker[]) => ({
    fromFrame: Math.min(...records.map(record => record.event.frame)),
    toFrame: Math.max(...records.map(record => record.event.frame)),
  });

  return <>
    <div ref={layerRef} className="ake-state-markers-layer" data-state-obstacle-selector={OBSTACLES}>
      {obstacles && [...lanes].flatMap(([line, items]) => {
        const lane = laneForLine(line);
        const byKey = new Map(items.map(item => [item.event.key, item]));
        const badges = stateBadgeRuns(items.map(item => item.event)).map(run => {
          const last = run[run.length - 1];
          const item = byKey.get(last.key)!;
          const owner=last.commandId ? owners[last.commandId] : undefined;
          const nextLeft=owner ? Math.min(...Object.values(owners)
            .filter(other=>Math.abs(other.top-owner.top)<10 && other.left>owner.right)
            .map(other=>other.left-4)) : Infinity;
          return {
            ...item,
            key: run[0].key,
            frame: last.frame,
            sequence: last.sequence,
            width: STATE_BADGE_SIZE,
            ownerCommandId: last.commandId ?? undefined,
            ownerRight: owner?.right,
            ownerLimit: Number.isFinite(nextLeft) ? nextLeft : undefined,
            records: run.map(event => byKey.get(event.key)!),
          };
        });
        const markerSpace = {
          left,
          top: lane.top,
          width: right - left,
          height: lane.bottom - lane.top,
          preferredTop: lane.top,
          obstacles,
        };
        return layoutStateMarkers(badges, markerSpace).map(ordinaryGroup => {
          const group = isBrowseMode
            ? { ...ordinaryGroup, top: lane.bottom - STATE_BADGE_SIZE - 3 }
            : ordinaryGroup;
          const records = group.events.flatMap(item => item.records);
          const range = rangeOf(records);
          const first = group.events[0];
          const sourceCommandIds = [...new Set(records
            .map(item => item.event.sourceCommandId)
            .filter((id): id is string => Boolean(id)))];
          const triggerCommandIds = [...new Set(records
            .map(item => item.event.triggerCommandId)
            .filter((id): id is string => Boolean(id)))];
          const summarySourceCommandId = sourceCommandIds.length === 1 ? sourceCommandIds[0] : undefined;
          const summaryTriggerCommandId = triggerCommandIds.length === 1 ? triggerCommandIds[0] : undefined;
          const summaryStacks = new Set(records.map(item => item.event.after));
          const summaryBuffIds = new Set(records.map(item => item.event.buffId));
          const isRangeSummary = Boolean(group.range);
          let markerOffset = 0;
          const markerCenters = group.events.map(item => {
            const center = markerOffset + item.width / 2;
            markerOffset += item.width + STATE_BADGE_GAP;
            return { item, center };
          });
          const showLeaders = !group.range && !group.overflow;
          return <div key={`${line}:${group.events[0].key}`} className={`ake-state-marker-group${isRangeSummary ? ' is-range-summary' : ''}${group.overflow ? ' is-overflow' : ''}`}
            style={{ left: group.left, top: group.top, width: group.width, height: group.height, gap: STATE_BADGE_GAP }}
            role="group" aria-label={`${records.length}项状态变化`}>
            {showLeaders ? <svg className="ake-state-marker-leaders" width={group.width} height={group.height} aria-hidden="true">
              {markerCenters.map(({ item, center }) => <g key={item.key}>
                <path d={`M ${item.x - group.left} ${lane.anchorY - group.top} V ${group.height + 3} H ${center} V ${group.height}`} />
                <circle cx={item.x - group.left} cy={lane.anchorY - group.top} r={1.3} />
              </g>)}
            </svg> : null}
            {group.collapsed ? <button type="button" className="ake-state-event-summary"
              style={{ width: group.width }} data-state-event-keys={JSON.stringify(records.map(item => item.event.key))}
              data-state-event-frame={first.event.frame} data-state-source-command-id={summarySourceCommandId}
              data-state-trigger-command-id={summaryTriggerCommandId}
              data-state-source-command-ids={JSON.stringify(sourceCommandIds)}
              data-state-trigger-command-ids={JSON.stringify(triggerCommandIds)}
              data-state-stacks={summaryStacks.size === 1 ? first.event.after ?? undefined : undefined}
              data-state-buff-id={summaryBuffIds.size === 1 ? first.event.buffId : undefined}
              data-state-anchor-x={first.x}
              data-state-line-index={line}
              data-state-from-frame={group.range?.fromFrame ?? range.fromFrame} data-state-to-frame={group.range?.toFrame ?? range.toFrame}
              aria-label={`${records.length}项状态变化，F${range.fromFrame}至F${range.toFrame}，点击展开逐条记录`}
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
                data-state-placement-command-id={item.ownerCommandId}
                data-state-owner-right={item.ownerRight}
                data-state-source-command-id={item.event.sourceCommandId ?? undefined}
                data-state-trigger-command-id={item.event.triggerCommandId ?? undefined}
                data-state-source-command-ids={JSON.stringify([item.event.sourceCommandId].filter((id): id is string => Boolean(id)))}
                data-state-trigger-command-ids={JSON.stringify([item.event.triggerCommandId].filter((id): id is string => Boolean(id)))}
                data-state-stacks={item.event.after ?? undefined} data-state-buff-id={item.event.buffId}
                data-state-anchor-x={item.x} data-state-anchor-y={lane.anchorY}
                data-state-line-index={line}
                data-state-from-frame={item.fromFrame} data-state-to-frame={item.toFrame}
                data-state-clipped={item.clipped || undefined}
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
