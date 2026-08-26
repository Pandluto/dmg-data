import { forwardRef, useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import type { MouseEvent } from 'react';
import { Character, SkillButton, CanvasConfig, SkillButtonSkillChangePayload, SkillButtonSkillOption } from '../../../types';
import { SkillButtonComponent } from '../SkillButton';
import { TimelineWaitSegment } from '../TimelineWaitSegment';
import type { TimelineData } from '../../../types';
import {
  getGridNodeCenterX,
  getGridLineCenterY,
  getGridMergedCellRect,
  getGridEnergyRowTopY,
  getGridGroupTop,
  getGridOperatorPairTopY,
  LINE_ROW_INDICES,
  GRID_FIRST_COLUMN_WIDTH,
  GRID_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  GRID_ENERGY_ROW_HEIGHT,
  GRID_NODE_COUNT,
  GRID_TIMELINE_WIDTH,
} from '../../../core/calculators/gridSnapLayout';
import { normalizeAssetUrl } from '../../../utils/assetResolver';
import { OptionalLiquidTideCanvasEffects } from '../../../platform/theme/OptionalLiquidTideEffects';
import type {
  AkeProjectedTimeline,
  AkeTimelinePoint,
} from '../../../integrations/ake/akeProvider';
import type {
  AkeRealtimeCommand,
  AkeRealtimeTimeline,
} from '../../../integrations/ake/akeRealtimeTimeline';
import {
  projectSharedTimelineFrame,
  type ScheduledTimelineAction,
  type SharedTimelineColumn,
} from '../../../core/domain/sharedVariableRateTimeline';
import type { CanvasDropTarget } from '../hooks/useCanvasDrag';

interface CanvasAreaProps {
  activeSkillButtonId?: string | null;
  config: CanvasConfig;
  staffCount: number;
  selectedCharacters: Character[];
  skillButtons: SkillButton[];
  onButtonMouseDown: (event: MouseEvent, buttonId: string) => void;
  onButtonContextMenu: (event: MouseEvent, buttonId: string) => void;
  onCanvasClick: () => void;
  onCanvasPlaceCopy: (e: MouseEvent) => void;
  timelineData?: TimelineData;
  contextMenuState?: { buttonId: string; position: { x: number; y: number } } | null;
  onConfirmRemove?: () => void;
  onCloseContextMenu?: () => void;
  onCopy?: () => void;
  onChangeSkillType?: (payload: SkillButtonSkillChangePayload) => void;
  onConfigureTimelineModule?: (button: SkillButton) => void;
  getSkillChangeOptions?: (button: SkillButton) => SkillButtonSkillOption[];
  isDraggingActive?: boolean;
  isBrowseMode?: boolean;
  isInspectMode?: boolean;
  isDragDisabled?: boolean;
  resistanceRevision?: number;
  akeTimeline?: AkeProjectedTimeline | null;
  akeRealtimeTimeline?: AkeRealtimeTimeline | null;
  dropTarget?: CanvasDropTarget | null;
  snapTargets?: CanvasDropTarget[];
}

// 表格行列标注：每个字母对应一个 80px 的单格逻辑节点。
const columnLabels = Array.from({ length: GRID_NODE_COUNT }, (_, index) => String.fromCharCode(65 + index));
const rowLabels = Array.from({ length: 8 }, (_, index) => String(index + 1));

export const CanvasArea = forwardRef<HTMLDivElement, CanvasAreaProps>(({
  activeSkillButtonId = null,
  config,
  staffCount,
  selectedCharacters,
  skillButtons,
  onButtonMouseDown,
  onButtonContextMenu,
  onCanvasPlaceCopy,
  timelineData,
  contextMenuState,
  onConfirmRemove,
  onCloseContextMenu,
  onCopy,
  onChangeSkillType,
  onConfigureTimelineModule,
  getSkillChangeOptions,
  isDraggingActive = false,
  isBrowseMode = false,
  isInspectMode = false,
  isDragDisabled = false,
  resistanceRevision = 0,
  akeTimeline = null,
  akeRealtimeTimeline = null,
  dropTarget = null,
  snapTargets = [],
}, canvasRef) => {
  const localCanvasRef = useRef<HTMLDivElement | null>(null);
  const setCanvasRef = useCallback((node: HTMLDivElement | null) => {
    localCanvasRef.current = node;
    if (typeof canvasRef === 'function') {
      canvasRef(node);
    } else if (canvasRef) {
      (canvasRef as MutableRefObject<HTMLDivElement | null>).current = node;
    }
  }, [canvasRef]);

  const glassElementSignature = useMemo(
    () => [
      isBrowseMode ? 'browse' : 'edit',
      isInspectMode ? 'inspect' : 'normal',
      ...skillButtons.map((button) => `${button.id}:${button.skillType}`),
    ].join('|'),
    [isBrowseMode, isInspectMode, skillButtons],
  );
  const glassRenderSignature = useMemo(
    () => [
      activeSkillButtonId ?? '',
      isDraggingActive ? 'dragging' : 'still',
      dropTarget ? `${dropTarget.staffIndex}:${dropTarget.lineIndex}:${dropTarget.nodeIndex}` : 'no-target',
      isBrowseMode ? 'browse' : 'edit',
      isInspectMode ? 'inspect' : 'normal',
      ...skillButtons.map((button) => [
        button.id,
        button.position.x,
        button.position.y,
        button.skillType,
        button.skillDisplayName ?? '',
        button.skillIconUrl ?? '',
      ].join(':')),
    ].join('|'),
    [activeSkillButtonId, dropTarget, isBrowseMode, isDraggingActive, isInspectMode, skillButtons],
  );

  const akeCommandById = useMemo(
    () => new Map((akeTimeline?.commands ?? []).map(command => [command.commandId, command])),
    [akeTimeline],
  );

  const akePreviewCommandById = useMemo(
    () => new Map((akeRealtimeTimeline?.commands ?? []).map(command => [command.commandId, command])),
    [akeRealtimeTimeline],
  );

  const variableTimeline = akeRealtimeTimeline?.sharedVariableRateTimeline ?? null;
  const variableActionById = useMemo(
    () => new Map((variableTimeline?.actions ?? []).map(action => [action.id, action])),
    [variableTimeline],
  );

  const visualPointForX = useCallback((globalX: number, edge: 'before' | 'after' = 'after') => {
    const safeX = Math.max(0, Number(globalX) || 0);
    const isBoundary = safeX > 0 && safeX % GRID_TIMELINE_WIDTH === 0;
    const pageIndex = isBoundary && edge === 'before'
      ? Math.max(0, safeX / GRID_TIMELINE_WIDTH - 1)
      : Math.floor(safeX / GRID_TIMELINE_WIDTH);
    const localX = isBoundary && edge === 'before'
      ? GRID_TIMELINE_WIDTH
      : safeX - pageIndex * GRID_TIMELINE_WIDTH;
    return {
      pageIndex,
      x: GRID_FIRST_COLUMN_WIDTH + localX,
      timelineX: localX,
    };
  }, []);

  const visualPointForFrame = useCallback((
    frame: number,
    affinity: 'before' | 'after' | 'center' = 'after',
  ) => {
    if (!variableTimeline) return null;
    const projectedX = projectSharedTimelineFrame(variableTimeline, frame, affinity);
    const globalX = projectedX ?? (
      frame > variableTimeline.endFrame ? variableTimeline.width
        : frame < variableTimeline.startFrame ? 0
          : null
    );
    if (globalX === null) return null;
    const edge = projectedX === null && frame > variableTimeline.endFrame
      ? 'before'
      : affinity === 'before' ? 'before' : 'after';
    return visualPointForX(globalX, edge);
  }, [variableTimeline, visualPointForX]);

  const visibleAtb = akeTimeline?.sharedAtb ?? akeRealtimeTimeline?.sharedAtb ?? null;
  const visibleAtbPoints = visibleAtb?.points ?? [];
  const visibleUspByCharacterId = useMemo(() => {
    const pools = new Map<string, {
      initial: number;
      max: number;
      final: number;
      points: AkeTimelinePoint[];
    }>();
    if (akeTimeline) {
      for (const pool of akeTimeline.uspPools) {
        const character = selectedCharacters.find(item => (
          item.id === pool.ownerId || pool.poolId.includes(item.id)
        ));
        if (!character) continue;
        pools.set(character.id, pool);
      }
      return pools;
    }
    for (const pool of akeRealtimeTimeline?.ultimateSpPools ?? []) {
      pools.set(pool.characterId, pool);
    }
    return pools;
  }, [akeRealtimeTimeline, akeTimeline, selectedCharacters]);

  const atbPointAt = useCallback((frame: number | null): AkeTimelinePoint | null => {
    if (frame === null || !visibleAtb) return null;
    let current: AkeTimelinePoint | null = null;
    for (const point of visibleAtbPoints) {
      if (point.frame > frame) break;
      current = point;
    }
    return current;
  }, [visibleAtb, visibleAtbPoints]);

  const atbPointForCommand = useCallback((command: AkeProjectedTimeline['commands'][number] | null) => {
    if (!command || !visibleAtb) return null;
    // Same-frame commands spend the same shared pool in deterministic order.
    // Use the resource event linked to this exact command so the two buttons
    // can show (for example) 200 then 100 instead of both showing the final 100.
    const linked = [...visibleAtbPoints].reverse().find(point => (
      point.commandId === command.commandId
    ));
    return linked ?? atbPointAt(command.actualFrame);
  }, [atbPointAt, visibleAtb, visibleAtbPoints]);

  const previewAtbPointForCommand = useCallback((command: AkeRealtimeCommand | null) => {
    if (!command || command.actualFrame === null || command.atbAfter === null) return null;
    return [...(akeRealtimeTimeline?.sharedAtb.points ?? [])].reverse().find(point => (
      point.commandId === command.commandId
    )) ?? atbPointAt(command.actualFrame);
  }, [akeRealtimeTimeline, atbPointAt]);

  const projectButtonToVariableTimeline = useCallback((
    button: SkillButton,
    action: ScheduledTimelineAction | undefined,
  ): SkillButton => {
    if (!action || button.isDragging) return button;
    const visualStart = visualPointForX(action.startX, 'after');
    const lineIndex = Math.max(0, Number(button.lineIndex) || 0);
    const sourceNodeIndex = Math.max(0, Math.min(
      GRID_NODE_COUNT - 1,
      Math.round(Number(button.nodeIndex) || 0),
    ));
    const gridOffsetX = button.position.x - getGridNodeCenterX(sourceNodeIndex);
    const gridOffsetY = button.position.y
      - getGridGroupTop(Math.max(0, Number(button.staffIndex) || 0))
      - getGridLineCenterY(lineIndex);
    return {
      ...button,
      staffIndex: visualStart.pageIndex,
      nodeIndex: Math.max(0, Math.min(
        GRID_NODE_COUNT - 1,
        Math.floor(visualStart.timelineX / GRID_COLUMN_WIDTH),
      )),
      position: {
        x: gridOffsetX + visualStart.x + GRID_COLUMN_WIDTH / 2,
        y: gridOffsetY + getGridGroupTop(visualStart.pageIndex) + getGridLineCenterY(lineIndex),
      },
    };
  }, [visualPointForX]);

  const resolveTimelineModuleAnchorFrame = useCallback((button: SkillButton): number | null => {
    if (!button.timelineModuleKind || !button.releaseAnchor || !variableTimeline) return null;
    const anchor = button.releaseAnchor;
    const sourceAction = anchor.sourceButtonId
      ? variableActionById.get(anchor.sourceButtonId)
      : null;
    let frame: number | null = null;
    if (anchor.kind === 'group-start') {
      const group = variableTimeline.groups.find(candidate => (
        variableTimeline.actions.some(action => {
          const payload = action.payload as { sourceGroupIndex?: number } | undefined;
          return action.groupId === candidate.id && payload?.sourceGroupIndex === button.staffIndex;
        })
      ));
      frame = group?.startFrame ?? variableTimeline.endFrame;
    } else if (sourceAction) {
      if (anchor.kind === 'action-start') {
        frame = sourceAction.startFrame + anchor.debounceFrames;
      } else if (anchor.kind === 'action-end') {
        frame = sourceAction.endFrame + anchor.debounceFrames;
      } else if (anchor.kind === 'damage-hit'
        && Number.isFinite(anchor.sourceHitOffsetFrames)) {
        frame = sourceAction.startFrame
          + Number(anchor.sourceHitOffsetFrames)
          + anchor.debounceFrames;
      }
    }
    return frame;
  }, [variableActionById, variableTimeline]);

  const projectTimelineModuleToAnchor = useCallback((button: SkillButton): SkillButton => {
    if (!button.timelineModuleKind || button.isDragging) return button;
    const frame = resolveTimelineModuleAnchorFrame(button);
    if (frame === null) return button;
    // A forced-wait carrier sits in the column beginning at the boundary. For
    // a zero-duration seal, `before` is its left edge; ordinary controls start
    // after the boundary like combat actions.
    const resolvedForcedWait = button.timelineModuleKind === 'forced-wait'
      ? variableTimeline?.waits.find(wait => wait.waitId === `forced-wait:${button.id}`) ?? null
      : null;
    const visualStart = resolvedForcedWait
      ? visualPointForX(resolvedForcedWait.xStart, 'after')
      : button.timelineModuleKind === 'forced-wait' && variableTimeline
        ? (() => {
          const globalX = projectSharedTimelineFrame(variableTimeline, frame, 'before');
          return globalX === null ? null : visualPointForX(globalX, 'after');
        })()
      : visualPointForFrame(frame, 'after');
    if (!visualStart) return button;
    const sourceNodeIndex = Math.max(0, Math.min(
      GRID_NODE_COUNT - 1,
      Math.round(Number(button.nodeIndex) || 0),
    ));
    const gridOffsetX = button.position.x - getGridNodeCenterX(sourceNodeIndex);
    const gridOffsetY = button.position.y
      - getGridGroupTop(Math.max(0, Number(button.staffIndex) || 0))
      - getGridLineCenterY(button.lineIndex);
    return {
      ...button,
      staffIndex: visualStart.pageIndex,
      nodeIndex: Math.max(0, Math.min(
        GRID_NODE_COUNT - 1,
        Math.floor(visualStart.timelineX / GRID_COLUMN_WIDTH),
      )),
      position: {
        x: gridOffsetX + visualStart.x + GRID_COLUMN_WIDTH / 2,
        y: gridOffsetY
          + getGridGroupTop(visualStart.pageIndex)
          + getGridLineCenterY(button.lineIndex),
      },
    };
  }, [resolveTimelineModuleAnchorFrame, variableTimeline, visualPointForFrame, visualPointForX]);

  const forcedWaitControlColumns = useMemo(() => skillButtons
    .filter(button => button.timelineModuleKind === 'forced-wait' && !button.isDragging)
    .flatMap((button) => {
      const resolvedWait = variableTimeline?.waits.find(
        wait => wait.waitId === `forced-wait:${button.id}`,
      );
      if (resolvedWait) {
        const visual = visualPointForX(resolvedWait.xStart, 'after');
        return [{
          buttonId: button.id,
          staffIndex: visual.pageIndex,
          left: visual.x,
          label: button.forcedWaitConfig?.mode === 'fixed-duration'
            ? `等待 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
            : '封组',
        }];
      }
      const frame = resolveTimelineModuleAnchorFrame(button);
      if (frame !== null && variableTimeline) {
        const globalX = projectSharedTimelineFrame(variableTimeline, frame, 'before');
        if (globalX !== null) {
          const visual = visualPointForX(globalX, 'after');
          return [{
            buttonId: button.id,
            staffIndex: visual.pageIndex,
            left: visual.x,
            label: button.forcedWaitConfig?.mode === 'fixed-duration'
              ? `等待 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
              : '封组',
          }];
        }
      }
      return [{
        buttonId: button.id,
        staffIndex: Math.max(0, Number(button.staffIndex) || 0),
        left: GRID_FIRST_COLUMN_WIDTH
          + Math.max(0, Math.min(GRID_NODE_COUNT - 1, Number(button.nodeIndex) || 0))
            * GRID_COLUMN_WIDTH,
        label: button.forcedWaitConfig?.mode === 'fixed-duration'
          ? `等待 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
          : '封组',
      }];
    }), [resolveTimelineModuleAnchorFrame, skillButtons, variableTimeline, visualPointForX]);

  const forcedWaitSegments = useMemo(() => skillButtons
    .filter(button => button.timelineModuleKind === 'forced-wait')
    .map((button) => {
      const displayButton = projectTimelineModuleToAnchor(button);
      const resolvedWait = variableTimeline?.waits.find(
        wait => wait.waitId === `forced-wait:${button.id}`,
      ) ?? null;
      const anchorFrame = resolveTimelineModuleAnchorFrame(button);
      const tickRate = variableTimeline?.tickRate
        ?? akeRealtimeTimeline?.tickRate
        ?? akeTimeline?.tickRate
        ?? 30;
      const startFrame = resolvedWait?.startFrame ?? anchorFrame;
      const fallbackDurationFrames = button.forcedWaitConfig?.mode === 'fixed-duration'
        ? Math.max(1, Math.round(button.forcedWaitConfig.durationSeconds * tickRate))
        : 0;
      const endFrame = resolvedWait?.endFrame
        ?? (startFrame === null ? null : startFrame + fallbackDurationFrames);
      return {
        button,
        displayButton,
        startFrame,
        endFrame,
        tickRate,
      };
    }), [
      akeRealtimeTimeline?.tickRate,
      akeTimeline?.tickRate,
      projectTimelineModuleToAnchor,
      resolveTimelineModuleAnchorFrame,
      skillButtons,
      variableTimeline,
    ]);

  const renderSkillButtons = () => {
    return skillButtons
      .filter(button => button.timelineModuleKind !== 'forced-wait')
      .map((button) => {
        const command = akeCommandById.get(button.id) ?? null;
        const previewCommand = akePreviewCommandById.get(button.id) ?? null;
        const displayButton = button.timelineModuleKind
          ? projectTimelineModuleToAnchor(button)
          : projectButtonToVariableTimeline(button, variableActionById.get(button.id));
        return (
        <SkillButtonComponent
          key={button.id}
          isDetailRouteActive={activeSkillButtonId === button.id}
          button={displayButton}
          size={config.skillButtonSize}
          onMouseDown={(event) => onButtonMouseDown(event, button.id)}
          onContextMenu={(event) => onButtonContextMenu(event, button.id)}
          isBrowseMode={isBrowseMode}
          isInspectMode={isInspectMode}
          isDragDisabled={isDragDisabled}
          resistanceRevision={resistanceRevision}
          timelineData={timelineData}
          contextMenuState={contextMenuState}
          onConfirmRemove={onConfirmRemove}
          onCloseContextMenu={onCloseContextMenu}
          onCopy={onCopy}
          onChangeSkillType={onChangeSkillType}
          onConfigureTimelineModule={onConfigureTimelineModule}
          skillChangeOptions={getSkillChangeOptions?.(button) ?? []}
          akeSettlement={command}
          akePreviewCommand={previewCommand}
          akeUsesSharedProjection={Boolean(variableTimeline)}
          akePreviewTickRate={akeRealtimeTimeline?.tickRate ?? akeTimeline?.tickRate ?? 30}
          akeAtbPoint={command
            ? atbPointForCommand(command)
            : previewAtbPointForCommand(previewCommand)}
          akeAtbMax={visibleAtb?.max ?? 300}
        />
        );
      });
  };

  const renderForcedWaitSegments = () => forcedWaitSegments.map(({
    button,
    displayButton,
    startFrame,
    endFrame,
    tickRate,
  }) => (
    <TimelineWaitSegment
      key={button.id}
      button={displayButton}
      left={displayButton.position.x - GRID_COLUMN_WIDTH / 2}
      top={displayButton.position.y - 15}
      width={GRID_COLUMN_WIDTH}
      startFrame={startFrame}
      endFrame={endFrame}
      tickRate={tickRate}
      isBrowseMode={isBrowseMode}
      isDragDisabled={isDragDisabled}
      onMouseDown={onButtonMouseDown}
      onContextMenu={onButtonContextMenu}
      onConfigure={onConfigureTimelineModule}
      contextMenuState={contextMenuState}
      onConfirmRemove={onConfirmRemove}
      onCloseContextMenu={onCloseContextMenu}
      onCopy={onCopy}
    />
  ));

  const renderAkeProjection = (staffIndex: number) => {
    if (!akeRealtimeTimeline || !visibleAtb || !variableTimeline) return null;
    const tickRate = variableTimeline.tickRate;
    const pageStartX = staffIndex * GRID_TIMELINE_WIDTH;
    const pageEndX = pageStartX + GRID_TIMELINE_WIDTH;
    const pageColumns = variableTimeline.columns.filter(column => (
      column.xStart >= pageStartX && column.xStart < pageEndX
    ));
    if (pageColumns.length === 0) return null;

    const seconds = (frame: number) => `${(frame / tickRate).toFixed(2)}秒`;
    const pointAt = <T extends AkeTimelinePoint,>(points: readonly T[], frame: number): T | null => {
      let current: T | null = null;
      for (const point of points) {
        if (point.frame > frame) break;
        current = point;
      }
      return current;
    };
    const boundarySamples = <T,>(read: (frame: number) => T) => {
      const samples: Array<{ x: number; value: T }> = [];
      pageColumns.forEach((column, index) => {
        if (index === 0) {
          samples.push({ x: column.xStart - pageStartX, value: read(column.startFrame) });
        }
        samples.push({ x: column.xEnd - pageStartX, value: read(column.endFrame) });
      });
      return samples;
    };
    const atbSamples = boundarySamples((frame) => {
      const point = atbPointAt(frame);
      return {
        total: point?.value ?? visibleAtb.initial ?? 0,
        ordinary: point?.ordinary ?? visibleAtb.initial ?? 0,
      };
    });
    const maximum = Math.max(1, Number(visibleAtb.max) || 300);
    const atbY = (value: number) => 26 - Math.max(0, Math.min(1, value / maximum)) * 21;
    const totalPolygon = [
      '0,27',
      ...atbSamples.map(sample => `${sample.x},${atbY(sample.value.total)}`),
      `${atbSamples[atbSamples.length - 1]?.x ?? 0},27`,
    ].join(' ');
    const ordinaryPolygon = [
      '0,27',
      ...atbSamples.map(sample => `${sample.x},${atbY(sample.value.ordinary)}`),
      `${atbSamples[atbSamples.length - 1]?.x ?? 0},27`,
    ].join(' ');
    const linePoints = atbSamples
      .map(sample => `${sample.x},${atbY(sample.value.total)}`)
      .join(' ');

    const projectedPreviewHits = (akeTimeline ? [] : akeRealtimeTimeline.hits)
      .map((hit) => {
        const action = variableActionById.get(hit.commandId);
        const command = akePreviewCommandById.get(hit.commandId);
        const bodyEndFrame = action?.endFrame ?? command?.endFrame ?? null;
        return {
          hit,
          bodyEndFrame,
          afterBody: bodyEndFrame !== null && hit.frame > bodyEndFrame,
          point: visualPointForFrame(hit.frame, 'after'),
        };
      })
      .filter(entry => entry.point?.pageIndex === staffIndex);
    const projectedSettledHits = (akeTimeline?.hitBursts ?? []).map((hit) => {
      const command = (akeTimeline?.commands ?? [])
        .filter(candidate => {
          const start = candidate.actualFrame ?? candidate.requestedFrame;
          const sameOwner = candidate.characterId === hit.characterId
            || (candidate.memberId !== null && candidate.memberId === hit.memberId);
          const sameSkill = !candidate.skillId || !hit.skillId || candidate.skillId === hit.skillId;
          return sameOwner && sameSkill && start <= hit.frame;
        })
        .sort((left, right) => {
          const leftStart = left.actualFrame ?? left.requestedFrame;
          const rightStart = right.actualFrame ?? right.requestedFrame;
          const leftContains = hit.frame <= (left.endFrame ?? leftStart) ? 1 : 0;
          const rightContains = hit.frame <= (right.endFrame ?? rightStart) ? 1 : 0;
          return rightContains - leftContains || rightStart - leftStart;
        })[0] ?? null;
      const previewAction = command ? variableActionById.get(command.commandId) : null;
      const bodyEndFrame = previewAction?.endFrame ?? command?.endFrame ?? null;
      return {
        hit,
        command,
        bodyEndFrame,
        afterBody: bodyEndFrame !== null && hit.frame > bodyEndFrame,
        point: visualPointForFrame(hit.frame, 'after'),
      };
    }).filter(entry => entry.point?.pageIndex === staffIndex);
    const resourceEvents = visibleAtbPoints
      .filter(point => point.commandId)
      .map(point => ({ event: point, point: visualPointForFrame(point.frame, 'after') }))
      .filter(entry => entry.point?.pageIndex === staffIndex);
    const comboWindows = akeRealtimeTimeline.comboWindows
      .map(window => ({ window, point: visualPointForFrame(window.createdFrame, 'after') }))
      .filter(entry => entry.point?.pageIndex === staffIndex);
    const actionsOnPage = variableTimeline.actions.filter(action => (
      action.startX < pageEndX && action.endX > pageStartX
    ));
    const effectTailsOnPage = variableTimeline.actions.flatMap((action) => {
      const command = akePreviewCommandById.get(action.id);
      const delayedHitFrames = (command?.hits ?? [])
        .map(hit => hit.frame)
        .filter(frame => frame > action.endFrame);
      if (delayedHitFrames.length === 0) return [];
      const effectEndFrame = Math.max(...delayedHitFrames);
      const projectedEffectEndX = projectSharedTimelineFrame(
        variableTimeline,
        effectEndFrame,
        'after',
      );
      // A tail after the final blocking action has no placement column of its
      // own. It is intentionally pinned to the canvas boundary and labelled;
      // it must never manufacture a new droppable cell.
      const effectEndX = projectedEffectEndX ?? variableTimeline.width;
      if (effectEndX < pageStartX || action.endX > pageEndX) return [];
      const left = Math.max(action.endX, pageStartX);
      const right = Math.min(Math.max(effectEndX, action.endX), pageEndX);
      const lineIndex = selectedCharacters.findIndex(character => character.id === action.laneId);
      if (lineIndex < 0) return [];
      return [{
        action,
        lineIndex,
        left,
        right,
        effectEndFrame,
        clippedAtCanvasEnd: projectedEffectEndX === null,
      }];
    });
    const waitsOnPage = pageColumns.filter(
      (column): column is Extract<SharedTimelineColumn, { kind: 'wait' }> => column.kind === 'wait',
    );

    return (
      <div className="ake-canvas-projection" aria-label={`共享变速时间投影 ${staffIndex + 1}`}>
        {pageColumns.map(column => (
          <span
            key={`rate:${column.id}`}
            className={`ake-variable-column-rate is-${column.kind}`}
            style={{ left: GRID_FIRST_COLUMN_WIDTH + column.xStart - pageStartX }}
            title={`${seconds(column.startFrame)}—${seconds(column.endFrame)} · ${column.durationFrames} 帧`}
          >
            {column.kind === 'wait'
              ? column.mode === 'seal-only' ? '封组 · 0秒' : `等待 · ${seconds(column.durationFrames)}`
              : seconds(column.durationFrames)}
          </span>
        ))}
        {waitsOnPage.map(wait => (
          <div
            key={wait.id}
            className={`ake-wait-column is-${wait.mode}`}
            style={{ left: GRID_FIRST_COLUMN_WIDTH + wait.xStart - pageStartX }}
            title={`${wait.resolutionReason} · ${seconds(wait.startFrame)}—${seconds(wait.endFrame)}`}
          >
            <span>{wait.mode === 'seal-only' ? '封组' : '等待'}</span>
          </div>
        ))}
        {actionsOnPage.map(action => {
          const lineIndex = selectedCharacters.findIndex(character => character.id === action.laneId);
          if (lineIndex < 0) return null;
          const left = Math.max(action.startX, pageStartX);
          const right = Math.min(action.endX, pageEndX);
          const command = akePreviewCommandById.get(action.id);
          const verdict = command?.releaseVerdict ?? 'unverified';
          const showStart = action.startX >= pageStartX && action.startX < pageEndX;
          const showEnd = action.endX > pageStartX && action.endX <= pageEndX;
          const joinedStart = variableTimeline.actions.some(other => (
            other.id !== action.id
            && other.laneId === action.laneId
            && other.endFrame === action.startFrame
          ));
          const joinedEnd = variableTimeline.actions.some(other => (
            other.id !== action.id
            && other.laneId === action.laneId
            && other.startFrame === action.endFrame
          ));
          return (
            <div
              key={`interval:${action.id}:${staffIndex}`}
              className={`ake-action-interval is-${verdict}${showStart ? ' has-start' : ' is-continuation'}${showEnd ? ' has-end' : ' continues'}`}
              style={{
                left: GRID_FIRST_COLUMN_WIDTH + left - pageStartX,
                top: getGridLineCenterY(lineIndex) - 10,
                width: Math.max(1, right - left),
              }}
              data-command-id={action.id}
              title={`${seconds(action.startFrame)}—${seconds(action.endFrame)} · ${action.durationFrames} 帧 · ${action.coveredColumnIds.length} 列`}
            >
              {showStart ? <i className={`is-start${joinedStart ? ' is-joined' : ''}`}><b>{seconds(action.startFrame)}</b></i> : null}
              {showEnd ? <i className={`is-end${joinedEnd ? ' is-joined' : ''}`}>{joinedEnd ? null : <b>{seconds(action.endFrame)}</b>}</i> : null}
            </div>
          );
        })}
        {effectTailsOnPage.map((tail) => (
          <div
            key={`effect-tail:${tail.action.id}:${staffIndex}`}
            className={`ake-effect-tail${tail.clippedAtCanvasEnd ? ' is-clipped' : ''}`}
            data-command-id={tail.action.id}
            style={{
              left: GRID_FIRST_COLUMN_WIDTH + tail.left - pageStartX,
              top: getGridLineCenterY(tail.lineIndex) + 12,
              width: Math.max(1, tail.right - tail.left),
            }}
            title={`技能本体 ${seconds(tail.action.endFrame)} 结束 · 后置结算持续至 ${seconds(tail.effectEndFrame)} · 不占技能格`}
          >
            <span>后置结算</span>
          </div>
        ))}
        {projectedPreviewHits.map(({ hit, bodyEndFrame, afterBody, point }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === hit.characterId);
          if (lineIndex < 0) return null;
          return (
            <div
              key={hit.id}
              className={`ake-preview-hit-marker is-${hit.kind}${afterBody ? ' is-after-body' : ''}`}
              data-command-id={hit.commandId}
              data-hit-frame={hit.frame}
              data-settlement-relation={afterBody ? 'after-body' : 'during-body'}
              style={{ left: point.x, top: getGridEnergyRowTopY(lineIndex) }}
              title={`${seconds(hit.frame)} · F${hit.frame} · ${afterBody ? `后置结算（本体止于 ${seconds(bodyEndFrame ?? hit.frame)}，不占技能格）` : hit.kind === 'projectile' ? '飞行落点' : hit.kind === 'lingering' ? '持续结算' : '直接结算'} · ${hit.hitCount} hit`}
            >
              {hit.launchFrame !== null && hit.frame > hit.launchFrame
                ? <em>+{((hit.frame - hit.launchFrame) / tickRate).toFixed(2)}秒</em>
                : null}
              {hit.hitCount > 1 ? <span>×{hit.hitCount}</span> : null}
            </div>
          );
        })}
        {projectedSettledHits.map(({ hit, command, bodyEndFrame, afterBody, point }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === hit.characterId);
          if (lineIndex < 0) return null;
          return (
            <div
              key={hit.id}
              className={`ake-hit-marker is-settled${afterBody ? ' is-after-body' : ''}`}
              data-command-id={command?.commandId ?? undefined}
              data-hit-frame={hit.frame}
              data-settlement-relation={afterBody ? 'after-body' : 'during-body'}
              style={{ left: point.x, top: getGridEnergyRowTopY(lineIndex) }}
              title={`${seconds(hit.frame)} · ${afterBody ? `后置结算（本体止于 ${seconds(bodyEndFrame ?? hit.frame)}） · ` : ''}${Math.round(hit.damage).toLocaleString('zh-CN')} 伤害 · ${hit.hpHitCount} hit`}
            >
              <span>{Math.round(hit.damage).toLocaleString('zh-CN')}</span>
            </div>
          );
        })}
        {comboWindows.map(({ window, point }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === window.characterId);
          if (lineIndex < 0) return null;
          const stateLabel = window.state === 'ready'
            ? '待释放'
            : window.state === 'consumed'
              ? `${seconds(window.consumedFrame ?? window.createdFrame)} 已消耗`
              : window.state === 'suppressed' ? '触发时冷却' : '已过期';
          return (
            <i
              key={window.id}
              className={`ake-combo-trigger-marker is-${window.state}`}
              style={{ left: point.x, top: getGridLineCenterY(lineIndex) - 23 }}
              title={`${seconds(window.createdFrame)} 连携触发 · 有效至 ${seconds(window.expireFrame)} · ${stateLabel}`}
            >E</i>
          );
        })}
        {selectedCharacters.map((character, lineIndex) => {
          const pool = visibleUspByCharacterId.get(character.id);
          if (!pool || pool.max <= 0) return null;
          const uspSamples = boundarySamples((frame) => pointAt(pool.points, frame)?.value ?? pool.initial);
          const uspY = (value: number) => GRID_ENERGY_ROW_HEIGHT - 0.5
            - Math.max(0, Math.min(1, value / pool.max)) * (GRID_ENERGY_ROW_HEIGHT - 2);
          const uspArea = [
            `0,${GRID_ENERGY_ROW_HEIGHT}`,
            ...uspSamples.map(sample => `${sample.x},${uspY(sample.value)}`),
            `${uspSamples[uspSamples.length - 1]?.x ?? 0},${GRID_ENERGY_ROW_HEIGHT}`,
          ].join(' ');
          const uspLine = uspSamples.map(sample => `${sample.x},${uspY(sample.value)}`).join(' ');
          const uspEvents = pool.points
            .filter(point => point.commandId)
            .map(point => ({ event: point, point: visualPointForFrame(point.frame, 'after') }))
            .filter(entry => entry.point?.pageIndex === staffIndex);
          const pageEndFrame = pageColumns[pageColumns.length - 1]?.endFrame
            ?? variableTimeline.endFrame;
          const pageValue = pointAt(pool.points, pageEndFrame)?.value ?? pool.initial;
          return (
            <div
              key={`usp:${character.id}:${staffIndex}`}
              className="ake-operator-usp-lane"
              style={{ top: getGridEnergyRowTopY(lineIndex) }}
              title={`${character.name} 自身能量 ${pageValue.toFixed(1)} / ${pool.max}`}
            >
              <span>U {Math.round(pageValue)}/{Math.round(pool.max)}</span>
              <svg viewBox={`0 0 ${GRID_TIMELINE_WIDTH} ${GRID_ENERGY_ROW_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                <polygon points={uspArea} />
                <polyline points={uspLine} />
              </svg>
              {uspEvents.map(({ event, point }, index) => {
                if (!point) return null;
                const realtimeEvent = event as AkeTimelinePoint & {
                  requestedDelta?: number;
                  actualDelta?: number;
                  reason?: string | null;
                };
                const delta = realtimeEvent.actualDelta;
                const deltaLabel = typeof delta === 'number'
                  ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`
                  : event.kind;
                return (
                  <i
                    key={`usp-event:${character.id}:${event.commandId}:${event.frame}:${index}`}
                    className={`is-${String(event.kind).toLowerCase()}`}
                    style={{ left: point.x }}
                    title={`${seconds(event.frame)} · ${deltaLabel} USP · ${realtimeEvent.reason ?? event.kind}`}
                  />
                );
              })}
            </div>
          );
        })}
        <div className="ake-shared-atb-lane">
          <span className="ake-shared-atb-label">
            共享技力 <b>{akeTimeline ? 'SETTLED' : 'LIVE'}</b>
          </span>
          <svg viewBox={`0 0 ${GRID_TIMELINE_WIDTH} 28`} preserveAspectRatio="none" aria-hidden="true">
            <polygon className="ake-atb-returned-area" points={totalPolygon} />
            <polygon className="ake-atb-ordinary-area" points={ordinaryPolygon} />
            <polyline className="ake-atb-total-line" points={linePoints} />
          </svg>
          {resourceEvents.map(({ event, point }, index) => point ? (
            <i
              key={`resource:${event.commandId}:${event.frame}:${index}`}
              className={`ake-atb-event is-${String(event.kind).toLowerCase()}`}
              style={{ left: point.x }}
              title={`${seconds(event.frame)} · ${event.kind} · ${Math.round(event.value)} ATB`}
            />
          ) : null)}
          <span className="ake-shared-atb-legend">
            <i className="is-ordinary" />普通 <i className="is-returned" />返还
          </span>
        </div>
        {staffIndex === 0 ? (
          <div className={`ake-live-scope-plate is-${variableTimeline.admissionStatus}`}>
            <b>共享变速 · 强边界</b>
            <span>{variableTimeline.columns.length} 列 · {seconds(variableTimeline.durationFrames)} · {variableTimeline.isExecutable ? '可执行' : variableTimeline.admissionStatus === 'unverified' ? '存在待核规则' : '存在无效批次'}</span>
          </div>
        ) : null}
      </div>
    );
  };

  const renderGridGroups = () => {
    return Array.from({ length: staffCount }, (_, index) => (
      <div key={`grid-row-${index}`} className="canvas-grid-row">
        <div className="canvas-grid-group">
          <div className="canvas-grid-header-bg" aria-hidden="true" />
          <div className="canvas-grid-background" aria-hidden="true" />
          {forcedWaitControlColumns
            .filter(column => column.staffIndex === index)
            .map(column => (
              <div
                key={`forced-wait-column:${column.buttonId}:${index}`}
                className="canvas-forced-wait-control-column"
                style={{ left: column.left }}
                title={`${column.label}：封住前组，并为后续动作提供等待边界`}
                aria-hidden="true"
              >
                <span>{column.label}</span>
              </div>
            ))}
          <div className="canvas-merged-drop-grid" aria-hidden="true">
            {LINE_ROW_INDICES.flatMap((_, lineIndex) => (
              Array.from({ length: GRID_NODE_COUNT }, (__, nodeIndex) => {
                const rect = getGridMergedCellRect(lineIndex, nodeIndex);
                const active = dropTarget?.staffIndex === index
                  && dropTarget.lineIndex === lineIndex
                  && dropTarget.nodeIndex === nodeIndex;
                return (
                  <span
                    key={`merged-cell-${index}-${lineIndex}-${nodeIndex}`}
                    className={`canvas-merged-drop-cell${active ? ' is-active' : ''}`}
                    data-line-index={lineIndex}
                    data-node-index={nodeIndex}
                    style={rect}
                  />
                );
              })
            ))}
            {snapTargets
              .filter(target => target.staffIndex === index)
              .map((target) => {
                const active = dropTarget?.anchorId === target.anchorId
                  && dropTarget.lineIndex === target.lineIndex
                  && dropTarget.staffIndex === target.staffIndex;
                return (
                  <span
                    key={`release-snap:${index}:${target.lineIndex}:${target.anchorId}`}
                    className={`canvas-release-snap-point is-${target.anchor.kind}${active ? ' is-active' : ''}`}
                    style={{
                      left: target.markerX - 7,
                      top: getGridOperatorPairTopY(target.lineIndex) + GRID_ROW_HEIGHT - 7,
                    }}
                    title={`${target.label} · ${(target.frame / (akeRealtimeTimeline?.tickRate ?? 30)).toFixed(2)}秒`}
                  />
                );
              })}
          </div>
          <div className="canvas-grid-labels" aria-hidden="true">
            <div className="canvas-grid-corner" />
            <div className="canvas-grid-column-labels">
              {columnLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className="canvas-grid-row-labels">
              {rowLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>
        </div>
        {renderStaffVisualGroup(index)}
        {renderAkeProjection(index)}
      </div>
    ));
  };

  // 渲染谱线视觉层 - 独立UI层覆盖在表格背景上方
  const renderStaffVisualGroup = (staffIndex: number) => {
    return (
      <div key={`staff-visual-${staffIndex}`} className="canvas-staff-visual-group" aria-hidden="true">
        {LINE_ROW_INDICES.map((_, lineIndex) => {
          const character = selectedCharacters[lineIndex];
          const lineCenterY = getGridLineCenterY(lineIndex);

          return (
            <div
              key={`staff-line-${staffIndex}-${lineIndex}`}
              className="canvas-staff-visual-line"
              data-line-index={lineIndex}
              style={{ top: lineCenterY }}
            >
              <div className="canvas-staff-line" />

              <div className="canvas-staff-line-label">
                {character?.avatarUrl && (
                  <img
                    className="canvas-staff-avatar"
                    src={normalizeAssetUrl(character.avatarUrl)}
                    alt={`${character?.name} avatar`}
                    onError={(event) => {
                      (event.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
              </div>

              <div className="canvas-damage-nodes">
                {Array.from({ length: GRID_NODE_COUNT }, (_, nodeIndex) => {
                  const nodeCenterX = getGridNodeCenterX(nodeIndex);
                  return (
                    <div
                      key={`node-${staffIndex}-${lineIndex}-${nodeIndex}`}
                      className="canvas-damage-node"
                    style={{ left: nodeCenterX - 1, top: GRID_ROW_HEIGHT - 3 }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="canvas-area">
      <div
        ref={setCanvasRef}
        className={`canvas-container${isDraggingActive ? ' is-dragging-active' : ''}`}
        onClick={onCanvasPlaceCopy}
      >
        <OptionalLiquidTideCanvasEffects
          rootRef={localCanvasRef}
          elementSignature={glassElementSignature}
          renderSignature={glassRenderSignature}
        />
        <img
          className="liquid-tide-capture-image"
          src="/assets/themes/liquid-tide/anmi-anniversary.jpg"
          alt=""
          aria-hidden="true"
          crossOrigin="anonymous"
          draggable={false}
        />
        <div className="liquid-tide-capture-overlay" aria-hidden="true" />
        <div className="canvas-grid-shell">
          <div className="canvas-grid-stack">
            <div className="canvas-left-top-spacer" aria-hidden="true" />
            {renderGridGroups()}
          </div>
        </div>
        {renderSkillButtons()}
        {renderForcedWaitSegments()}
      </div>
    </div>
  );
});
