import { TimelineStateMarkers } from './TimelineStateMarkers';
import { getTimelineDeleteBlockReason } from '../../../core/domain/timelineQueuePolicy';
import { forwardRef, useCallback, useMemo, useRef, type MutableRefObject, type CSSProperties } from 'react';
import type { MouseEvent } from 'react';
import { Character, SkillButton, CanvasConfig, SkillButtonSkillChangePayload, SkillButtonSkillOption } from '../../../types';
import { SkillButtonComponent } from '../SkillButton';
import { TimelineWaitSegment } from '../TimelineWaitSegment';
import { TimelineOperatorSwitchSegment } from '../TimelineOperatorSwitchSegment';
import type { TimelineData } from '../../../types';
import {
  getGridNodeCenterX,
  getGridLineCenterY,
  getGridMergedCellRect,
  getNormalizedGridLineOffsetY,
  getGridEnergyRowTopY,
  getGridReleaseRowTopY,
  getGridGroupTop,
  getGridOperatorPairTopY,
  LINE_ROW_INDICES,
  GRID_FIRST_COLUMN_WIDTH,
  GRID_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  GRID_ENERGY_ROW_HEIGHT,
  GRID_NODE_COUNT,
  GRID_RELEASE_ROW_HEIGHT,
  GRID_OPERATOR_SLOT_HEIGHT,
  GRID_GROUP_HEIGHT,
  GRID_TIMELINE_WIDTH,
} from '../../../core/calculators/gridSnapLayout';
import { normalizeAssetUrl } from '../../../utils/assetResolver';
import { OptionalLiquidTideCanvasEffects } from '../../../platform/theme/OptionalLiquidTideEffects';
import type {
  AkeProjectedTimeline,
  AkeTeamReport,
  AkeTimelinePoint,
} from '../../../integrations/ake/akeProvider';
import type {
  AkeRealtimeCommand,
  AkeRealtimeTimeline,
} from '../../../integrations/ake/akeRealtimeTimeline';
import {
  clipSharedTimelineColumnsToPage,
  projectSharedTimelineFrame,
  type ScheduledTimelineAction,
  type SharedTimelinePageColumn,
  type SharedTimelineColumn,
} from '../../../core/domain/sharedVariableRateTimeline';
import { resolveInitialControllerLaneId } from '../../../core/domain/operatorControlTimeline';
import {
  buildAkeMainTimelineStateEvents,
  buildAkeCombatInteractions,
} from '../../../core/services/akeRuntimeLedger';
import { akeSkillTypeLabel } from '../../../core/services/akeCombatInspection';
import {
  compactLingeringHitMarkers,
  isLowMultiplierHitMarker,
} from '../lingeringHitProjection';
import type { CanvasDropTarget } from '../hooks/useCanvasDrag';

interface CanvasAreaProps {
  activeSkillButtonId?: string | null;
  inspectedCommandId?: string | null;
  onInspectCommand?: (id: string) => void;
  onEditReleaseAnchor?: (id: string) => void;
  config: CanvasConfig;
  staffCount: number;
  selectedCharacters: Character[];
  initialControllerCharacterId?: string | null;
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
  onConfigureInitialController?: () => void;
  getSkillChangeOptions?: (button: SkillButton) => SkillButtonSkillOption[];
  isDraggingActive?: boolean;
  isBrowseMode?: boolean;
  isInspectMode?: boolean;
  isDragDisabled?: boolean;
  resistanceRevision?: number;
  akeTimeline?: AkeProjectedTimeline | null;
  akeRuntimeReport?: AkeTeamReport | null;
  akeRealtimeTimeline?: AkeRealtimeTimeline | null;
  dropTarget?: CanvasDropTarget | null;
  snapTargets?: CanvasDropTarget[];
}

// 表格行列标注：每个字母对应一个 80px 的单格逻辑节点。
const columnLabels = Array.from({ length: GRID_NODE_COUNT }, (_, index) => String.fromCharCode(65 + index));
const rowLabels = Array.from({ length: 8 }, (_, index) => String(index + 1));

export const CanvasArea = forwardRef<HTMLDivElement, CanvasAreaProps>(({
  activeSkillButtonId = null,
  inspectedCommandId = null,
  onInspectCommand,
  onEditReleaseAnchor,
  config,
  staffCount,
  selectedCharacters,
  initialControllerCharacterId = null,
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
  onConfigureInitialController,
  getSkillChangeOptions,
  isDraggingActive = false,
  isBrowseMode = false,
  isInspectMode = false,
  isDragDisabled = false,
  resistanceRevision = 0,
  akeTimeline = null,
  akeRuntimeReport = null,
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
  const visualPageWidth = variableTimeline?.visualPageWidth ?? GRID_TIMELINE_WIDTH;
  const interactions = useMemo(() => akeRuntimeReport ? buildAkeCombatInteractions(akeRuntimeReport) : [], [akeRuntimeReport]);
  const stateEvents = useMemo(() => akeRuntimeReport ? buildAkeMainTimelineStateEvents(akeRuntimeReport) : [], [akeRuntimeReport]);
  const resolvedInitialControllerCharacterId = resolveInitialControllerLaneId(
    initialControllerCharacterId,
    selectedCharacters.map(character => character.id),
  );
  const variableActionById = useMemo(
    () => new Map((variableTimeline?.actions ?? []).map(action => [action.id, action])),
    [variableTimeline],
  );

  const visualPointForX = useCallback((globalX: number, edge: 'before' | 'after' = 'after') => {
    const safeX = Math.max(0, Number(globalX) || 0);
    const isBoundary = safeX > 0 && safeX % visualPageWidth === 0;
    const pageIndex = isBoundary && edge === 'before'
      ? Math.max(0, safeX / visualPageWidth - 1)
      : Math.floor(safeX / visualPageWidth);
    const localX = isBoundary && edge === 'before'
      ? visualPageWidth
      : safeX - pageIndex * visualPageWidth;
    return {
      pageIndex,
      x: GRID_FIRST_COLUMN_WIDTH + localX,
      timelineX: localX,
    };
  }, [visualPageWidth]);

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
    const gridOffsetY = getNormalizedGridLineOffsetY(
      button.position.y,
      button.staffIndex,
      lineIndex,
    );
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
    const resolvedForcedWait = button.timelineModuleKind === 'forced-wait'
      ? variableTimeline?.waits.find(wait => wait.waitId === `forced-wait:${button.id}`) ?? null
      : null;
    const resolvedLaneWait = button.timelineModuleKind === 'lane-wait'
      ? variableTimeline?.laneWaits.find(wait => wait.id === button.id) ?? null
      : null;
    const resolvedOperatorSwitch = button.timelineModuleKind === 'operator-switch'
      ? variableTimeline?.operatorSwitches.find(operatorSwitch => operatorSwitch.id === button.id) ?? null
      : null;
    // Both wait carriers begin at the left edge of their projected interval.
    // Only a forced wait owns a full-column group boundary; an ordinary wait
    // remains inside its lane and therefore uses the lane-wait projection.
    const visualStart = resolvedForcedWait
      ? visualPointForX(resolvedForcedWait.xStart, 'after')
      : resolvedLaneWait
        ? visualPointForX(resolvedLaneWait.startX, 'after')
        : resolvedOperatorSwitch
          ? visualPointForX(resolvedOperatorSwitch.startX, 'after')
        : frame !== null && button.timelineModuleKind === 'forced-wait' && variableTimeline
        ? (() => {
          const globalX = projectSharedTimelineFrame(variableTimeline, frame, 'before');
          return globalX === null ? null : visualPointForX(globalX, 'after');
        })()
        : frame !== null ? visualPointForFrame(frame, 'after') : null;
    if (!visualStart) return button;
    const sourceNodeIndex = Math.max(0, Math.min(
      GRID_NODE_COUNT - 1,
      Math.round(Number(button.nodeIndex) || 0),
    ));
    const gridOffsetX = button.position.x - getGridNodeCenterX(sourceNodeIndex);
    const gridOffsetY = getNormalizedGridLineOffsetY(
      button.position.y,
      button.staffIndex,
      button.lineIndex,
    );
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
            ? `强制 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
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
              ? `强制 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
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
          ? `强制 ${button.forcedWaitConfig.durationSeconds.toFixed(2)}秒`
          : '封组',
      }];
    }), [resolveTimelineModuleAnchorFrame, skillButtons, variableTimeline, visualPointForX]);

  const waitSegments = useMemo(() => skillButtons
    .filter(button => (
      button.timelineModuleKind === 'forced-wait'
      || button.timelineModuleKind === 'lane-wait'
    ))
    .map((button) => {
      const displayButton = projectTimelineModuleToAnchor(button);
      const resolvedForcedWait = variableTimeline?.waits.find(
        wait => wait.waitId === `forced-wait:${button.id}`,
      ) ?? null;
      const resolvedLaneWait = variableTimeline?.laneWaits.find(
        wait => wait.id === button.id,
      ) ?? null;
      const anchorFrame = resolveTimelineModuleAnchorFrame(button);
      const tickRate = variableTimeline?.tickRate
        ?? akeRealtimeTimeline?.tickRate
        ?? akeTimeline?.tickRate
        ?? 30;
      const startFrame = resolvedForcedWait?.startFrame
        ?? resolvedLaneWait?.startFrame
        ?? anchorFrame;
      const fallbackDurationFrames = button.timelineModuleKind === 'lane-wait'
        ? button.laneWaitConfig?.mode === 'fixed-duration'
          ? Math.max(1, Math.round(button.laneWaitConfig.durationSeconds * tickRate))
          : 0
        : button.forcedWaitConfig?.mode === 'fixed-duration'
          ? Math.max(1, Math.round(button.forcedWaitConfig.durationSeconds * tickRate))
          : 0;
      const endFrame = resolvedForcedWait?.endFrame
        ?? resolvedLaneWait?.endFrame
        ?? (startFrame === null ? null : startFrame + fallbackDurationFrames);
      const width = resolvedLaneWait
        ? Math.max(GRID_COLUMN_WIDTH, resolvedLaneWait.endX - resolvedLaneWait.startX)
        : GRID_COLUMN_WIDTH;
      return {
        button,
        displayButton,
        startFrame,
        endFrame,
        tickRate,
        width,
      };
    }), [
      akeRealtimeTimeline?.tickRate,
      akeTimeline?.tickRate,
      projectTimelineModuleToAnchor,
      resolveTimelineModuleAnchorFrame,
      skillButtons,
      variableTimeline,
    ]);

  const operatorSwitchSegments = useMemo(() => skillButtons
    .filter(button => button.timelineModuleKind === 'operator-switch')
    .map((button) => {
      const displayButton = projectTimelineModuleToAnchor(button);
      const resolved = variableTimeline?.operatorSwitches.find(
        operatorSwitch => operatorSwitch.id === button.id,
      ) ?? null;
      const target = selectedCharacters.find(
        character => character.id === button.operatorSwitchConfig?.targetCharacterId,
      );
      return {
        button,
        displayButton,
        targetName: target?.name ?? '未选择',
        frame: resolved?.startFrame ?? resolveTimelineModuleAnchorFrame(button),
        tickRate: variableTimeline?.tickRate
          ?? akeRealtimeTimeline?.tickRate
          ?? akeTimeline?.tickRate
          ?? 30,
        width: resolved
          ? Math.max(GRID_COLUMN_WIDTH, resolved.endX - resolved.startX)
          : GRID_COLUMN_WIDTH,
      };
    }), [
      akeRealtimeTimeline?.tickRate,
      akeTimeline?.tickRate,
      projectTimelineModuleToAnchor,
      resolveTimelineModuleAnchorFrame,
      selectedCharacters,
      skillButtons,
      variableTimeline,
    ]);

  const renderSkillButtons = () => {
    return skillButtons
      .filter(button => (
        button.timelineModuleKind !== 'forced-wait'
        && button.timelineModuleKind !== 'lane-wait'
        && button.timelineModuleKind !== 'operator-switch'
      ))
      .map((button) => {
        const command = akeCommandById.get(button.id) ?? null;
        const previewCommand = akePreviewCommandById.get(button.id) ?? null;
        const displayButton = button.timelineModuleKind
          ? projectTimelineModuleToAnchor(button)
          : projectButtonToVariableTimeline(button, variableActionById.get(button.id));
        const releaseRelation = (() => {
            const anchor = button.releaseAnchor;
            if (!anchor?.sourceButtonId) return null;
            const hits = akeRealtimeTimeline?.hits.filter(hit => hit.commandId === anchor.sourceButtonId
              && hit.releaseEligible !== false && hit.kind !== 'lingering') ?? [];
            const ordinal = hits.findIndex(hit => hit.offsetFrames === anchor.sourceHitOffsetFrames) + 1;
            const basis = anchor.kind === 'damage-hit' ? `${ordinal > 0 ? ordinal : '指定'}击后`
              : anchor.kind === 'action-end' ? '结束后' : anchor.kind === 'action-start' ? '同时起手'
                : anchor.sourceTimedInputKind === 'broad' ? '普通窗' : '精准窗';
            const source = skillButtons.find(item => item.id === anchor.sourceButtonId);
            const delay = anchor.debounceFrames ? ` +${Number((anchor.debounceFrames / (akeRealtimeTimeline?.tickRate ?? 30)).toFixed(3))}s` : '';
            const action = variableActionById.get(anchor.sourceButtonId);
            return {
              label: `◇ ${source?.characterName ?? '?'} ${basis}${delay}`,
              compactLabel: `◇ ${basis === '同时起手' ? '起手' : basis === '结束后' ? '结束' : basis}${delay}`,
              title: source ? `接 ${source.characterName} · ${source.skillDisplayName ?? source.skillType}${action ? ` · F${action.startFrame}` : ''} · ${basis}${delay}；点击编辑接续` : '来源不可用；点击核对接续',
            };
        })();
        return (
        <SkillButtonComponent
          key={button.id}
          isDetailRouteActive={activeSkillButtonId === button.id}
          isCombatInspected={inspectedCommandId === button.id}
          onInspect={onInspectCommand ? () => onInspectCommand(button.id) : undefined}
          onEditReleaseAnchor={onEditReleaseAnchor && button.releaseAnchor?.sourceButtonId && !button.basicAttackTailBundle
            ? () => onEditReleaseAnchor(button.id) : undefined}
          releaseRelationTitle={releaseRelation?.title}
          releaseRelationLabel={releaseRelation?.label}
          releaseRelationCompactLabel={releaseRelation?.compactLabel}
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
          akeRuntimeReport={akeRuntimeReport}
          readingStateEvents={stateEvents}
          akePreviewCommand={previewCommand}
          akePreviewCommands={akeRealtimeTimeline?.commands}
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

  const renderWaitSegments = () => waitSegments.map(({
    button,
    displayButton,
    startFrame,
    endFrame,
    tickRate,
    width,
  }) => (
    <TimelineWaitSegment
      key={button.id}
      button={displayButton}
      left={displayButton.position.x - GRID_COLUMN_WIDTH / 2}
      top={displayButton.position.y - 15}
      width={width}
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
            removeBlockedReason={timelineData ? getTimelineDeleteBlockReason(timelineData, button.id) : null}
      onCloseContextMenu={onCloseContextMenu}
      onCopy={onCopy}
    />
  ));

  const renderOperatorSwitchSegments = () => operatorSwitchSegments.map(({
    button,
    displayButton,
    targetName,
    frame,
    tickRate,
    width,
  }) => (
    <TimelineOperatorSwitchSegment
      key={button.id}
      button={displayButton}
      targetName={targetName}
      left={displayButton.position.x - GRID_COLUMN_WIDTH / 2}
      top={displayButton.position.y - 15}
      width={width}
      frame={frame}
      tickRate={tickRate}
      isBrowseMode={isBrowseMode}
      isDragDisabled={isDragDisabled}
      onMouseDown={onButtonMouseDown}
      onContextMenu={onButtonContextMenu}
      onConfigure={onConfigureTimelineModule}
      contextMenuState={contextMenuState}
      onConfirmRemove={onConfirmRemove}
            removeBlockedReason={timelineData ? getTimelineDeleteBlockReason(timelineData, button.id) : null}
      onCloseContextMenu={onCloseContextMenu}
    />
  ));

  const renderAkeProjection = (staffIndex: number) => {
    if (!akeRealtimeTimeline || !visibleAtb || !variableTimeline) return null;
    const tickRate = variableTimeline.tickRate;
    const pageStartX = staffIndex * visualPageWidth;
    const pageEndX = pageStartX + visualPageWidth;
    const pageColumnSegments = clipSharedTimelineColumnsToPage(
      variableTimeline.columns,
      pageStartX,
      pageEndX,
    );
    if (pageColumnSegments.length === 0) return null;

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
      pageColumnSegments.forEach((segment, index) => {
        if (index === 0) {
          samples.push({
            x: segment.visibleStartX - pageStartX,
            value: read(segment.startFrame),
          });
        }
        samples.push({
          x: segment.visibleEndX - pageStartX,
          value: read(segment.endFrame),
        });
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

    const projectedPreviewHits = compactLingeringHitMarkers((akeTimeline ? [] : akeRealtimeTimeline.hits)
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
      .filter(entry => entry.point !== null)
      .map(entry => ({
        ...entry,
        groupKey: entry.hit.commandId,
        frame: entry.hit.frame,
        lingering: entry.hit.kind === 'lingering',
      }))
    ).filter(entry => entry.point?.pageIndex === staffIndex);
    const projectedSettledHits = compactLingeringHitMarkers((akeTimeline?.hitBursts ?? []).map((hit) => {
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
    }).filter(entry => entry.point !== null).map(entry => ({
      ...entry,
      groupKey: entry.command?.commandId
        ?? `${entry.hit.characterId}:${entry.hit.skillId ?? 'unknown'}`,
      frame: entry.hit.frame,
      // Settled bursts do not carry the preview `kind`; a long post-body
      // sequence is the authoritative presentation signal for a lingering
      // tail.  Short post-body projectiles remain untouched by the threshold.
      lingering: entry.afterBody,
    }))).filter(entry => entry.point?.pageIndex === staffIndex);
    const resourceEvents = visibleAtbPoints
      .filter(point => point.commandId)
      .map(point => ({ event: point, point: visualPointForFrame(point.frame, 'after') }))
      .filter(entry => entry.point?.pageIndex === staffIndex);
    // A settled report is authoritative. Preview windows are shown only while
    // the current execution digest has not produced a settled ledger yet.
    const comboWindows = (akeTimeline?.comboWindows ?? akeRealtimeTimeline.comboWindows)
      .map(window => ({ window, point: visualPointForFrame(window.createdFrame, 'after') }))
      .filter(entry => entry.point?.pageIndex === staffIndex);
    const precisionWindows = (akeTimeline
      ? (akeTimeline.timedInputWindows ?? []).map(window => ({
        ...window,
        characterId: window.ownerId,
      }))
      : akeRealtimeTimeline.comboWindows.flatMap(window => (
        window.precisionWindow ? [{
          id: `${window.id}:precision`,
          characterId: window.characterId,
          ...window.precisionWindow,
        }] : []
      )))
      .flatMap((window) => {
        const startGlobalX = projectSharedTimelineFrame(
          variableTimeline,
          window.startFrame,
          'after',
        );
        const endGlobalX = projectSharedTimelineFrame(
          variableTimeline,
          window.endFrameExclusive,
          'before',
        );
        if (startGlobalX === null || endGlobalX === null
          || endGlobalX <= pageStartX || startGlobalX >= pageEndX) return [];
        const segmentStart = Math.max(pageStartX, startGlobalX);
        const segmentEnd = Math.min(pageEndX, endGlobalX);
        return [{
          window,
          left: GRID_FIRST_COLUMN_WIDTH + segmentStart - pageStartX,
          width: Math.max(4, segmentEnd - segmentStart),
        }];
      });
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
    const waitsOnPage = pageColumnSegments.filter((segment): segment is SharedTimelinePageColumn & {
      column: Extract<SharedTimelineColumn, { kind: 'wait' }>;
    } => segment.column.kind === 'wait');
    const visualWidthInBaseColumns = Number(
      (variableTimeline.width / variableTimeline.columnWidth).toFixed(1),
    );

    return (
      <div className="ake-canvas-projection" aria-label={`共享变速时间投影 ${staffIndex + 1}`}>
        {selectedCharacters.map((character, lineIndex) => (
          <div key={`release-row:${character.id}`} className="ake-release-caption-lane"
            data-release-row={lineIndex} aria-label={`${character.name}起手标记行`}
            style={{ top: getGridReleaseRowTopY(lineIndex), height: GRID_RELEASE_ROW_HEIGHT }}>
            <span>起手</span>
          </div>
        ))}
        {pageColumnSegments.map((segment) => {
          const { column, visibleStartX, visibleEndX, startFrame, endFrame } = segment;
          const visibleWidth = visibleEndX - visibleStartX;
          return (
            <span
              key={`rate:${column.id}`}
              className={`ake-variable-column-rate is-${column.kind}`}
              style={{
                left: GRID_FIRST_COLUMN_WIDTH + visibleStartX - pageStartX,
                width: Math.max(1, visibleWidth),
              }}
              title={`${seconds(column.startFrame)}—${seconds(column.endFrame)} · ${column.durationFrames} 帧`}
            >
              {visibleWidth >= 40
                ? column.kind === 'wait'
                  ? column.mode === 'seal-only' ? '封组 · 0秒' : `等待 · ${seconds(endFrame - startFrame)}`
                  : seconds(endFrame - startFrame)
                : null}
            </span>
          );
        })}
        {waitsOnPage.map(wait => (
          <div
            key={wait.column.id}
            className={`ake-wait-column is-${wait.column.mode}`}
            style={{
              left: GRID_FIRST_COLUMN_WIDTH + wait.visibleStartX - pageStartX,
              width: Math.max(1, wait.visibleEndX - wait.visibleStartX),
            }}
            title={`${wait.column.resolutionReason} · ${seconds(wait.column.startFrame)}—${seconds(wait.column.endFrame)}`}
          >
            <span>{wait.column.mode === 'seal-only' ? '封组' : '等待'}</span>
          </div>
        ))}
        {interactions.map(interaction => {
          const point = visualPointForFrame(interaction.frame, 'after');
          if (!point || point.pageIndex !== staffIndex) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === interaction.triggerActorId);
          if (lineIndex < 0) return null;
          const trigger = akeRuntimeReport?.timeline.commands.find(command => command.commandId === interaction.triggerCommandId);
          const effect = akeRuntimeReport?.timeline.commands.find(command => command.commandId === interaction.effectCommandId);
          const name = selectedCharacters.find(character => character.id === interaction.effectActorId)?.name ?? '关联动作';
          const label = `${trigger?.attackMode === 'plunging-impact' ? '下落' : '触发'} → ${name}${akeSkillTypeLabel(effect?.commandType ?? '')}`;
          const description = `${label} · F${interaction.frame} · ${interaction.hitCount} 次派生命中，伤害归属${name}`;
          const alignEnd = point.x > GRID_FIRST_COLUMN_WIDTH + visualPageWidth - 150;
          return <button key={interaction.key} type="button" className={`ake-interaction-event-marker${alignEnd ? ' is-end-aligned' : ''}`}
            style={{left: point.x, top: getGridLineCenterY(lineIndex) - 10}}
            data-trigger-frame={interaction.frame} data-trigger-command-id={interaction.triggerCommandId}
            data-effect-command-id={interaction.effectCommandId} title={description} aria-label={description}
            onClick={event => { event.stopPropagation(); onInspectCommand?.(interaction.triggerCommandId); }}>
            {label}
          </button>;
        })}
        <TimelineStateMarkers left={GRID_FIRST_COLUMN_WIDTH} right={GRID_FIRST_COLUMN_WIDTH + visualPageWidth}
          laneForLine={line => ({ top: getGridReleaseRowTopY(line) + GRID_RELEASE_ROW_HEIGHT + 2,
            bottom: getGridEnergyRowTopY(line) - 3, anchorY: getGridEnergyRowTopY(line) })} onInspectCommand={onInspectCommand}
          events={stateEvents.flatMap(event => {
            const point = visualPointForFrame(event.frame, 'after');
            const lineIndex = selectedCharacters.findIndex(character => character.id === (event.actorId ?? event.sourceId));
            if (!point || point.pageIndex !== staffIndex || lineIndex < 0) return [];
            const actor = selectedCharacters.find(character => character.id === event.actorId)?.name;
            const description = `${event.label} · ${event.change} ${event.before ?? '?'}→${event.after ?? '?'}层 · ${seconds(event.frame)} / F${event.frame}${actor ? ` · ${actor}` : ''}`;
            return [{ event, x: point.x, lineIndex, description }];
          })} />
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
              title={`${seconds(action.startFrame)}—${seconds(action.endFrame)} · ${action.durationFrames} 帧 · 覆盖 ${action.coveredColumnIds.length} 时段`}
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
        {projectedPreviewHits.map(({ hit, bodyEndFrame, afterBody, point, compactLingering, lingeringCount, lingeringStartFrame, lingeringEndFrame }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === hit.characterId);
          if (lineIndex < 0) return null;
          const lingeringDescription = compactLingering
            ? `后置持续结算（已压缩显示：${lingeringCount ?? hit.hitCount} 个结算点，${seconds(lingeringStartFrame ?? hit.frame)}～${seconds(lingeringEndFrame ?? hit.frame)}）`
            : '持续结算';
          return (
            <div
              key={hit.id}
              className={`ake-preview-hit-marker is-${hit.kind}${afterBody ? ' is-after-body' : ''}${compactLingering ? ' is-compact' : ''}${isLowMultiplierHitMarker(hit.multiplier) ? ' is-low-multiplier' : ''}`}
              data-command-id={hit.commandId}
              data-hit-frame={hit.frame}
              data-settlement-relation={afterBody ? 'after-body' : 'during-body'}
              style={{ left: point.x, top: getGridEnergyRowTopY(lineIndex) }}
              title={`${seconds(hit.frame)} · F${hit.frame} · ${afterBody ? `后置结算（本体止于 ${seconds(bodyEndFrame ?? hit.frame)}，不占技能格）` : hit.kind === 'projectile' ? '飞行落点' : hit.kind === 'lingering' ? lingeringDescription : '直接结算'} · ${hit.hitCount} hit`}
            >
              {hit.launchFrame !== null && hit.frame > hit.launchFrame
                ? <em>+{((hit.frame - hit.launchFrame) / tickRate).toFixed(2)}秒</em>
                : null}
              {hit.hitCount > 1 ? <span>×{hit.hitCount}</span> : null}
            </div>
          );
        })}
        {projectedSettledHits.map(({ hit, command, bodyEndFrame, afterBody, point, compactLingering, lingeringCount, lingeringStartFrame, lingeringEndFrame }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === hit.characterId);
          if (lineIndex < 0) return null;
          const lingeringDescription = compactLingering
            ? `后置持续结算（已压缩显示：${lingeringCount ?? hit.hpHitCount} 个结算点，${seconds(lingeringStartFrame ?? hit.frame)}～${seconds(lingeringEndFrame ?? hit.frame)}）`
            : null;
          return (
            <div
              key={hit.id}
              className={`ake-hit-marker is-settled${afterBody ? ' is-after-body' : ''}${compactLingering ? ' is-compact' : ''}${isLowMultiplierHitMarker(hit.multiplier) ? ' is-low-multiplier' : ''}`}
              data-command-id={command?.commandId ?? undefined}
              data-hit-frame={hit.frame}
              data-settlement-relation={afterBody ? 'after-body' : 'during-body'}
              style={{ left: point.x, top: getGridEnergyRowTopY(lineIndex) }}
              title={`${seconds(hit.frame)} · ${lingeringDescription ?? (afterBody ? `后置结算（本体止于 ${seconds(bodyEndFrame ?? hit.frame)}）` : '伤害结算')} · ${Math.round(hit.damage).toLocaleString('zh-CN')} 伤害 · ${hit.hpHitCount} hit`}
            >
              <span>{Math.round(hit.damage).toLocaleString('zh-CN')}</span>
            </div>
          );
        })}
        {comboWindows.map(({ window, point }) => {
          if (!point) return null;
          const lineIndex = selectedCharacters.findIndex(character => character.id === window.characterId);
          if (lineIndex < 0) return null;
          const stateLabel = window.state === 'ready' || window.state === 'active'
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
        {precisionWindows.map(({ window, left, width }) => {
          const lineIndex = selectedCharacters.findIndex(character => (
            character.id === window.characterId
          ));
          if (lineIndex < 0) return null;
          const stateLabel = window.state === 'resolved'
            ? `${seconds(window.resolvedFrame ?? window.startFrame)} 命中精准`
            : window.state === 'missed' ? '未命中精准' : '精准时段';
          return (
            <div
              key={window.id}
              className={`ake-combo-precision-window is-${window.state}`}
              style={{
                left,
                width,
                top: getGridLineCenterY(lineIndex) - 7,
              }}
              title={`精准时段 ${seconds(window.startFrame)}～${seconds(window.endFrameExclusive)}（末端不含） · ${stateLabel}`}
            >
              <span>精准</span>
            </div>
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
          const pageEndFrame = pageColumnSegments[pageColumnSegments.length - 1]?.endFrame
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
              <svg viewBox={`0 0 ${visualPageWidth} ${GRID_ENERGY_ROW_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
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
          <svg viewBox={`0 0 ${visualPageWidth} 28`} preserveAspectRatio="none" aria-hidden="true">
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
            <span>{variableTimeline.columns.length} 时段 · 占宽 {visualWidthInBaseColumns} 格 · {seconds(variableTimeline.durationFrames)} · {variableTimeline.isExecutable ? '可执行' : variableTimeline.admissionStatus === 'unverified' ? '存在待核规则' : '存在无效批次'}</span>
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
      <div
        key={`staff-visual-${staffIndex}`}
        className="canvas-staff-visual-group"
        aria-hidden={staffIndex === 0 ? undefined : true}
      >
        {staffIndex === 0 && selectedCharacters.length > 0 ? (
          <button
            type="button"
            className="canvas-initial-controller-picker"
            aria-label="选择初始主控干员"
            title="选择初始主控干员"
            disabled={isBrowseMode || !onConfigureInitialController}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onConfigureInitialController?.();
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.5 4h8V1.5L14.5 8l-5 6.5V12h-8z" />
            </svg>
            <span>主控</span>
          </button>
        ) : null}
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

              {staffIndex === 0
              && character?.id === resolvedInitialControllerCharacterId ? (
                <button
                  type="button"
                  className="canvas-controlled-operator-marker"
                  aria-label={`${character.name} 为初始主控干员；点击更换`}
                  title={`${character.name} · 初始主控；点击更换`}
                  disabled={isBrowseMode || !onConfigureInitialController}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onConfigureInitialController?.();
                  }}
                >
                  <svg viewBox="0 0 25 16" aria-hidden="true">
                    <path d="M1 3.5h15.5V1l7 7-7 7v-2.5H1z" />
                    <circle cx="7" cy="8" r="2.2" />
                  </svg>
                </button>
              ) : null}

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
        className={`canvas-container${isDraggingActive ? ' is-dragging-active' : ''}${isBrowseMode ? ' is-browse-mode' : ''}`}
        style={{
          '--grid-release-row-height': `${GRID_RELEASE_ROW_HEIGHT}px`,
          '--grid-operator-slot-height': `${GRID_OPERATOR_SLOT_HEIGHT}px`,
          '--grid-group-height': `${GRID_GROUP_HEIGHT}px`,
        } as CSSProperties}
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
        {renderWaitSegments()}
        {renderOperatorSwitchSegments()}
      </div>
    </div>
  );
});
