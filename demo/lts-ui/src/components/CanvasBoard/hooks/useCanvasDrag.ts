/**
 * Canvas drag logic.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  SkillType,
  SkillButton,
  CanvasConfig,
  SkillButtonData,
  SandboxSkill,
  ForcedWaitConfig,
  SkillReleaseAnchor,
  TimelineModuleKind,
} from '../../../types';
import { generateId } from '../../../utils/helpers';
import { resolveSkillIconUrl } from '../../../utils/assetResolver';
import {
  findNearestGridLine,
  findNearestGridLineAnyCharacter,
  clientToGridCoords,
  gridToCanvasContentCoords,
  GRID_COLUMN_WIDTH,
  GRID_FIRST_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  clampGridNodeIndex,
  GRID_NODE_COUNT,
  GRID_TIMELINE_WIDTH,
  getGridGroupTop,
  getGridOperatorPairTopY,
  getGridNodeCenterX,
} from '../../../core/calculators/gridSnapLayout';
import { calculateNodeNumber } from '../../../utils/nodeNumbering';
import { SKILL_BUTTON_BASELINE_OFFSET_Y } from '../../../constants/canvas-layout';
import type { AkeRealtimeTimeline } from '../../../integrations/ake/akeRealtimeTimeline';
import { projectSharedTimelineFrame } from '../../../core/domain/sharedVariableRateTimeline';
import { debounceFramesForTickRate } from '../../../core/domain/combatActionTailPlanner';
import {
  attachLegacyLanePredecessors,
  buildReleaseSnapPoints,
  getReleaseDeletionBlockers,
  wouldCreateReleaseCycle,
  type ReleaseSnapPoint,
} from '../../../core/domain/releaseAnchorGraph';

interface DraggingState {
  id: string;
  characterId: string;
  characterName: string;
  skillType: SkillType;
  runtimeSkillId?: string;
  skillDisplayName?: string;
  skillIconUrl?: string;
  customHits?: SkillButton['customHits'];
  timelineModuleKind?: TimelineModuleKind;
  forcedWaitConfig?: ForcedWaitConfig;
  dragScope: 'character' | 'global';
  lineIndex: number;
  offsetX: number;
  offsetY: number;
  originalButton?: SkillButton;
}

export interface CanvasDropTarget {
  staffIndex: number;
  sourceGroupIndex: number;
  lineIndex: number;
  nodeIndex: number;
  markerX: number;
  frame: number;
  label: string;
  anchorId: string;
  anchor: SkillReleaseAnchor;
}

interface UseCanvasDragProps {
  disabled?: boolean;
  config: CanvasConfig;
  canvasWidth: number;
  staffCount: number;
  selectedCharacters: { id: string; name?: string }[];
  skillButtons: SkillButton[];
  akeRealtimeTimeline?: AkeRealtimeTimeline | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  dispatch: React.Dispatch<any>;
  addTimelineButton?: (buttonData: {
    characterId?: string;
    characterName: string;
    skillType: SkillType;
    staffIndex: number;
    nodeIndex: number;
    position: { x: number; y: number };
    runtimeSkillId?: string;
    skillDisplayName?: string;
    skillIconUrl?: string;
    customHits?: SkillButton['customHits'];
    releaseAnchor?: SkillReleaseAnchor;
    timelineModuleKind?: TimelineModuleKind;
    forcedWaitConfig?: ForcedWaitConfig;
  }, buttonId?: string) => void;
  updateSkillButtonPosition?: (
    staffIndex: number,
    buttonId: string,
    newPosition: { x: number; y: number },
    newNodeIndex: number,
    newReleaseAnchor?: SkillReleaseAnchor,
  ) => SkillButtonData | null;
  moveTimelineButtonToStaff?: (
    fromStaffIndex: number,
    toStaffIndex: number,
    buttonId: string,
    newPosition: { x: number; y: number },
    newNodeIndex: number,
    newReleaseAnchor?: SkillReleaseAnchor,
  ) => SkillButtonData | null;
  /** Called after a new sandbox button has been written to both projections. */
  onNewButtonCommitted?: (button: SkillButton) => void;
  onInteractionRejected?: (message: string) => void;
}

export interface UseCanvasDragReturn {
  draggingState: DraggingState | null;
  dropTarget: CanvasDropTarget | null;
  snapTargets: CanvasDropTarget[];
  mousePosition: { x: number; y: number };
  handleSandboxDragStart: (
    characterId: string,
    characterName: string,
    sandboxSkill: SandboxSkill,
    lineIndex: number,
    e: React.MouseEvent
  ) => void;
  handleButtonMouseDown: (e: React.MouseEvent, buttonId: string) => void;
}

function visualLocationForGlobalX(globalX: number): {
  staffIndex: number;
  markerX: number;
} {
  const safeX = Math.max(0, Number(globalX) || 0);
  const staffIndex = Math.floor(safeX / GRID_TIMELINE_WIDTH);
  const localX = safeX - staffIndex * GRID_TIMELINE_WIDTH;
  return {
    staffIndex,
    markerX: GRID_FIRST_COLUMN_WIDTH + localX,
  };
}

function nearestAvailableNode(
  preferredNodeIndex: number,
  occupied: ReadonlySet<number>,
): number | null {
  const preferred = clampGridNodeIndex(preferredNodeIndex);
  for (let distance = 0; distance < GRID_NODE_COUNT; distance += 1) {
    const right = preferred + distance;
    if (right < GRID_NODE_COUNT && !occupied.has(right)) return right;
    const left = preferred - distance;
    if (left >= 0 && !occupied.has(left)) return left;
  }
  return null;
}

function snapKindRank(kind: SkillReleaseAnchor['kind']): number {
  if (kind === 'damage-hit') return 0;
  if (kind === 'action-end') return 1;
  if (kind === 'group-start') return 2;
  return 3;
}

export function useCanvasDrag({
  disabled = false,
  config,
  canvasWidth,
  staffCount,
  selectedCharacters,
  skillButtons,
  akeRealtimeTimeline = null,
  canvasRef,
  dispatch,
  addTimelineButton,
  updateSkillButtonPosition,
  moveTimelineButtonToStaff,
  onNewButtonCommitted,
  onInteractionRejected,
}: UseCanvasDragProps): UseCanvasDragReturn {
  const [draggingState, setDraggingState] = useState<DraggingState | null>(null);
  const [dropTarget, setDropTarget] = useState<CanvasDropTarget | null>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  const skillButtonsRef = useRef(skillButtons);
  useEffect(() => {
    skillButtonsRef.current = skillButtons;
  }, [skillButtons]);

  const releaseSnapPoints = useMemo<ReleaseSnapPoint[]>(() => {
    const model = akeRealtimeTimeline?.sharedVariableRateTimeline ?? null;
    const buttonById = new Map(skillButtons.map(button => [button.id, button]));
    let points: ReleaseSnapPoint[] = [];
    let nextGroupIndex = 0;
    let newGroupGlobalX = 0;
    let newGroupFrame = 0;

    if (model && model.actions.length > 0 && akeRealtimeTimeline) {
      const sourceGroupIndexByGroupId = new Map<string, number>();
      model.actions.forEach((action) => {
        const payload = action.payload as { sourceGroupIndex?: number } | undefined;
        const sourceGroupIndex = Number(payload?.sourceGroupIndex);
        if (Number.isFinite(sourceGroupIndex)) {
          sourceGroupIndexByGroupId.set(action.groupId, Math.max(0, Math.round(sourceGroupIndex)));
        }
      });
      points = buildReleaseSnapPoints({
        actions: model.actions.map((action) => ({
          id: action.id,
          groupId: action.groupId,
          groupIndex: sourceGroupIndexByGroupId.get(action.groupId) ?? 0,
          startFrame: action.startFrame,
          endFrame: action.endFrame,
          startX: action.startX,
          endX: action.endX,
          label: buttonById.get(action.id)?.skillDisplayName
            ?? buttonById.get(action.id)?.skillType
            ?? action.id,
        })),
        hits: akeRealtimeTimeline.hits.map(hit => ({
          id: hit.id,
          commandId: hit.commandId,
          frame: hit.frame,
          offsetFrames: hit.offsetFrames,
        })),
        debounceFrames: debounceFramesForTickRate(akeRealtimeTimeline.tickRate),
        projectFrame: frame => projectSharedTimelineFrame(model, frame, 'after')
          ?? (frame >= model.endFrame ? model.width : null),
      });
      nextGroupIndex = Math.max(
        0,
        ...sourceGroupIndexByGroupId.values(),
      ) + 1;
      // A new group owns one explicit seal column before its shared start.
      newGroupGlobalX = model.width + GRID_COLUMN_WIDTH;
      newGroupFrame = model.endFrame;
    } else if (skillButtons.length > 0) {
      const combatButtons = skillButtons.filter(button => !button.timelineModuleKind);
      const fallbackActions = combatButtons
        .map((button) => {
          const localNodeIndex = clampGridNodeIndex(button.nodeIndex ?? 0);
          const globalStartX = button.staffIndex * GRID_TIMELINE_WIDTH
            + localNodeIndex * GRID_COLUMN_WIDTH;
          return {
            id: button.id,
            groupId: `release-group:${button.staffIndex}`,
            groupIndex: button.staffIndex,
            startFrame: button.staffIndex * GRID_NODE_COUNT * 15 + localNodeIndex * 15,
            endFrame: button.staffIndex * GRID_NODE_COUNT * 15 + (localNodeIndex + 1) * 15,
            startX: globalStartX,
            endX: globalStartX + GRID_COLUMN_WIDTH,
            label: button.skillDisplayName ?? button.skillType,
          };
        });
      points = buildReleaseSnapPoints({
        actions: fallbackActions,
        hits: [],
        debounceFrames: 6,
        projectFrame: frame => frame / 15 * GRID_COLUMN_WIDTH,
      });
      nextGroupIndex = combatButtons.length > 0
        ? Math.max(...combatButtons.map(button => button.staffIndex)) + 1
        : 0;
      newGroupGlobalX = nextGroupIndex * GRID_TIMELINE_WIDTH;
      newGroupFrame = nextGroupIndex * GRID_NODE_COUNT * 15;
    }

    points.push({
      id: `new-group:${nextGroupIndex}`,
      kind: 'group-start',
      frame: newGroupFrame,
      globalX: newGroupGlobalX,
      groupId: `release-group:${nextGroupIndex}`,
      groupIndex: nextGroupIndex,
      label: skillButtons.every(button => Boolean(button.timelineModuleKind))
        ? '首组起点'
        : `另开第 ${nextGroupIndex + 1} 组（自动封组）`,
      anchor: {
        schemaVersion: 1,
        kind: 'group-start',
        debounceFrames: 0,
      },
    });
    return points;
  }, [akeRealtimeTimeline, skillButtons]);

  const snapTargets = useMemo<CanvasDropTarget[]>(() => {
    if (!draggingState) return [];
    const graphNodes = attachLegacyLanePredecessors(skillButtons);
    const movingButtonId = draggingState.originalButton?.id ?? null;
    const allowedLineIndices = draggingState.dragScope === 'global'
      ? draggingState.originalButton
        ? [draggingState.originalButton.lineIndex]
        : selectedCharacters.map((_, index) => index)
      : selectedCharacters.flatMap((character, index) => (
        character.id === draggingState.characterId ? [index] : []
      ));
    const actionById = new Map(
      (akeRealtimeTimeline?.sharedVariableRateTimeline?.actions ?? []).map(action => [action.id, action]),
    );
    const sourceGroupIndices = [...new Set(
      (akeRealtimeTimeline?.sharedVariableRateTimeline?.actions ?? []).map((action) => {
        const payload = action.payload as { sourceGroupIndex?: number } | undefined;
        return Number(payload?.sourceGroupIndex) || 0;
      }),
    )].sort((left, right) => left - right);
    const nextSourceGroupIndex = (sourceGroupIndex: number) => {
      const position = sourceGroupIndices.indexOf(sourceGroupIndex);
      return position >= 0
        ? sourceGroupIndices[position + 1] ?? sourceGroupIndex + 1
        : sourceGroupIndex + 1;
    };
    const forcedWaitBoundaryGroup = (button: SkillButton): number | null => {
      if (button.timelineModuleKind !== 'forced-wait') return null;
      if (button.releaseAnchor?.kind === 'group-start') return button.staffIndex;
      const source = button.releaseAnchor?.sourceButtonId
        ? skillButtons.find(candidate => candidate.id === button.releaseAnchor?.sourceButtonId)
        : null;
      return source ? nextSourceGroupIndex(source.staffIndex) : null;
    };
    const occupiedForcedWaitBoundaries = new Set(
      skillButtons.flatMap(button => {
        if (button.id === movingButtonId) return [];
        const boundary = forcedWaitBoundaryGroup(button);
        return boundary === null ? [] : [boundary];
      }),
    );
    const sealedSourceGroups = new Set(skillButtons.flatMap((button) => {
      if (button.timelineModuleKind !== 'forced-wait'
        || button.releaseAnchor?.kind !== 'action-end') return [];
      const source = button.releaseAnchor.sourceButtonId
        ? skillButtons.find(candidate => candidate.id === button.releaseAnchor?.sourceButtonId)
        : null;
      return source ? [source.staffIndex] : [];
    }));
    const targets: CanvasDropTarget[] = [];

    for (const point of releaseSnapPoints) {
      if (!draggingState.timelineModuleKind
        && sealedSourceGroups.has(point.groupIndex)
        && !point.id.startsWith('new-group:')) {
        continue;
      }
      const sourceButtonId = point.anchor.sourceButtonId;
      if (movingButtonId && sourceButtonId
        && wouldCreateReleaseCycle(graphNodes, movingButtonId, sourceButtonId)) {
        continue;
      }
      if (draggingState.timelineModuleKind === 'forced-wait') {
        const sourceAction = sourceButtonId ? actionById.get(sourceButtonId) : null;
        const group = akeRealtimeTimeline?.sharedVariableRateTimeline?.groups.find(candidate => (
          candidate.id === point.groupId
        ));
        const isClosedTail = point.kind === 'action-end'
          && sourceAction?.endFrame === group?.endFrame;
        if (!isClosedTail && !point.id.startsWith('new-group:')) continue;
        const targetBoundaryGroup = point.kind === 'group-start'
          ? point.groupIndex
          : nextSourceGroupIndex(point.groupIndex);
        if (occupiedForcedWaitBoundaries.has(targetBoundaryGroup)) continue;
      }

      const visual = visualLocationForGlobalX(point.globalX);
      if (visual.staffIndex >= staffCount) continue;
      for (const lineIndex of allowedLineIndices) {
        const characterId = selectedCharacters[lineIndex]?.id;
        if (!characterId) continue;
        const sameFrameCollision = (akeRealtimeTimeline?.sharedVariableRateTimeline?.actions ?? [])
          .some(action => (
            action.id !== movingButtonId
            && action.laneId === characterId
            && action.startFrame === point.frame
            && action.groupId === point.groupId
          ));
        if (sameFrameCollision) continue;

        const occupied = new Set(skillButtons
          .filter(button => (
            button.id !== movingButtonId
            && button.staffIndex === point.groupIndex
            && button.lineIndex === lineIndex
          ))
          .map(button => clampGridNodeIndex(button.nodeIndex ?? 0)));
        const sourceButton = sourceButtonId ? skillButtons.find(button => button.id === sourceButtonId) : null;
        const preferredNodeIndex = point.kind === 'group-start'
          ? 0
          : clampGridNodeIndex(
            (sourceButton?.nodeIndex ?? Math.floor((visual.markerX - GRID_FIRST_COLUMN_WIDTH) / GRID_COLUMN_WIDTH))
              + (point.kind === 'action-start' ? 0 : 1),
          );
        const nodeIndex = nearestAvailableNode(preferredNodeIndex, occupied);
        if (nodeIndex === null) continue;
        targets.push({
          staffIndex: visual.staffIndex,
          sourceGroupIndex: point.groupIndex,
          lineIndex,
          nodeIndex,
          markerX: visual.markerX,
          frame: point.frame,
          label: point.label,
          anchorId: point.id,
          anchor: point.anchor,
        });
      }
    }

    const deduplicated = new Map<string, CanvasDropTarget>();
    targets
      .sort((left, right) => (
        snapKindRank(left.anchor.kind) - snapKindRank(right.anchor.kind)
        || left.anchorId.localeCompare(right.anchorId)
      ))
      .forEach((target) => {
        const key = `${target.staffIndex}:${target.lineIndex}:${Math.round(target.markerX)}`;
        if (!deduplicated.has(key)) deduplicated.set(key, target);
      });
    return [...deduplicated.values()];
  }, [
    akeRealtimeTimeline,
    draggingState,
    releaseSnapPoints,
    selectedCharacters,
    skillButtons,
    staffCount,
  ]);

  const handleSandboxDragStart = useCallback(
    (
      characterId: string,
      characterName: string,
      sandboxSkill: SandboxSkill,
      lineIndex: number,
      e: React.MouseEvent
    ) => {
      e.preventDefault();
      if (disabled) return;
      const offset = config.skillButtonSize / 2;

      setDraggingState({
        id: generateId(),
        characterId,
        characterName,
        skillType: sandboxSkill.buttonType,
        runtimeSkillId: sandboxSkill.id,
        skillDisplayName: sandboxSkill.displayName,
        skillIconUrl: sandboxSkill.iconUrl,
        customHits: sandboxSkill.customHits,
        timelineModuleKind: sandboxSkill.timelineModuleKind,
        forcedWaitConfig: sandboxSkill.forcedWaitConfig,
        dragScope: sandboxSkill.dragScope ?? 'character',
        lineIndex,
        offsetX: offset,
        offsetY: offset,
      });
      setMousePosition({ x: e.clientX, y: e.clientY });
    },
    [config, disabled]
  );

  const handleButtonMouseDown = useCallback(
    (e: React.MouseEvent, buttonId: string) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      e.stopPropagation();

      const button = skillButtons.find((b) => b.id === buttonId);
      if (!button) return;

      dispatch({ type: 'SELECT_SKILL_BUTTON', buttonId });
      if (button.basicAttackTailBundle) {
        // Confirmed cut bundles are immutable. The successor may be removed
        // from its context menu, which also restores the predecessor.
        e.preventDefault();
        return;
      }
      const graphNodes = attachLegacyLanePredecessors(skillButtons);
      const dependents = getReleaseDeletionBlockers(graphNodes, button.id);
      if (dependents.length > 0) {
        e.preventDefault();
        onInteractionRejected?.(
          `“${button.skillDisplayName ?? button.skillType}”后面还有 ${dependents.length} 个依赖动作；只能从分支末端移动。`,
        );
        return;
      }
      dispatch({ type: 'SET_DRAGGING', buttonId, isDragging: true });

      const canvasRect = canvasRef.current?.getBoundingClientRect();
      if (canvasRect) {
        setDraggingState({
          id: button.id,
          characterId: button.characterId,
          characterName: button.characterName,
          skillType: button.skillType,
          runtimeSkillId: button.runtimeSkillId,
          skillDisplayName: button.skillDisplayName,
          skillIconUrl: button.skillIconUrl,
          customHits: button.customHits,
          timelineModuleKind: button.timelineModuleKind,
          forcedWaitConfig: button.forcedWaitConfig,
          dragScope: button.timelineModuleKind ? 'global' : 'character',
          lineIndex: button.lineIndex,
          offsetX: config.skillButtonSize / 2,
          offsetY: config.skillButtonSize / 2,
          originalButton: button,
        });
        setMousePosition({ x: e.clientX, y: e.clientY });
      }
    },
    [disabled, skillButtons, config, dispatch, canvasRef, onInteractionRejected]
  );

  useEffect(() => {
    if (!disabled) return;
    skillButtonsRef.current.forEach((button) => {
      if (button.isDragging) {
        dispatch({ type: 'SET_DRAGGING', buttonId: button.id, isDragging: false });
      }
    });
    setDraggingState((current) => {
      if (current) {
        dispatch({ type: 'SET_DRAGGING', buttonId: current.id, isDragging: false });
      }
      return null;
    });
    setDropTarget(null);
  }, [disabled, dispatch]);

  useEffect(() => {
    if (!draggingState || disabled) return;

    const resolveTarget = (clientX: number, clientY: number): {
      target: CanvasDropTarget;
      lineY: number;
      gridStack: Element;
    } | null => {
      const canvasElement = canvasRef.current;
      const gridStack = canvasElement?.querySelector('.canvas-grid-stack');
      if (!canvasElement || !gridStack) return null;
      const canvasRect = canvasElement.getBoundingClientRect();
      if (clientX < canvasRect.left || clientX > canvasRect.right
        || clientY < canvasRect.top || clientY > canvasRect.bottom) return null;
      const gridStackRect = gridStack.getBoundingClientRect();
      const { gridX, gridY } = clientToGridCoords(clientX, clientY, canvasRect, gridStackRect);
      const timelineRight = GRID_FIRST_COLUMN_WIDTH + GRID_NODE_COUNT * GRID_COLUMN_WIDTH;
      if (gridX < GRID_FIRST_COLUMN_WIDTH || gridX > timelineRight) return null;
      const nearestLine = draggingState.dragScope === 'global'
        ? findNearestGridLineAnyCharacter(gridY, staffCount)
        : findNearestGridLine(
          gridY,
          staffCount,
          draggingState.characterId,
          selectedCharacters,
        );
      if (!nearestLine) return null;
      const pairTop = getGridGroupTop(nearestLine.staffIndex)
        + getGridOperatorPairTopY(nearestLine.lineIndex);
      if (gridY < pairTop || gridY > pairTop + GRID_ROW_HEIGHT * 2) return null;

      const candidates = snapTargets.filter(target => (
        target.staffIndex === nearestLine.staffIndex
        && target.lineIndex === nearestLine.lineIndex
      ));
      const nearest = candidates.sort((left, right) => (
        Math.abs(left.markerX - gridX) - Math.abs(right.markerX - gridX)
        || snapKindRank(left.anchor.kind) - snapKindRank(right.anchor.kind)
      ))[0];
      const magnetRadius = Math.max(44, Math.min(GRID_COLUMN_WIDTH * 0.8, config.snapThreshold * 6));
      if (!nearest || Math.abs(nearest.markerX - gridX) > magnetRadius) return null;
      return { target: nearest, lineY: nearestLine.lineY, gridStack };
    };

    const updateDropTarget = (clientX: number, clientY: number) => {
      const resolved = resolveTarget(clientX, clientY);
      const next = resolved?.target ?? null;
      setDropTarget(current => (
        current?.anchorId === next?.anchorId
          && current?.staffIndex === next?.staffIndex
          && current?.lineIndex === next?.lineIndex
          && current?.nodeIndex === next?.nodeIndex
          ? current
          : next
      ));
    };

    const handleMouseMove = (event: MouseEvent) => {
      setMousePosition({ x: event.clientX, y: event.clientY });
      updateDropTarget(event.clientX, event.clientY);
    };

    const handleMouseUp = (event: MouseEvent) => {
      try {
        const canvasElement = canvasRef.current;
        const resolved = resolveTarget(event.clientX, event.clientY);
        if (!canvasElement || !resolved) {
          if (draggingState.originalButton) {
            dispatch({ type: 'SET_DRAGGING', buttonId: draggingState.originalButton.id, isDragging: false });
          } else {
            onInteractionRejected?.('这里只是显示格，不是合法释放点；请放到高亮的组起点、技能尾部或伤害锚点。');
          }
          return;
        }

        const { target, lineY, gridStack } = resolved;
        const { lineIndex, nodeIndex, sourceGroupIndex } = target;
        const snappedPosition = gridToCanvasContentCoords(
          getGridNodeCenterX(nodeIndex),
          lineY + SKILL_BUTTON_BASELINE_OFFSET_Y,
          canvasElement,
          gridStack,
        );
        const persistenceNodeIndex = sourceGroupIndex * GRID_NODE_COUNT + nodeIndex;

        if (draggingState.originalButton) {
          const originalButton = draggingState.originalButton;
          const buttonId = originalButton.id;
          const oldPersistenceStaffIndex = originalButton.lineIndex;
          const newPersistenceStaffIndex = lineIndex;
          let serviceResult: SkillButtonData | null = null;
          if (oldPersistenceStaffIndex !== newPersistenceStaffIndex && moveTimelineButtonToStaff) {
            serviceResult = moveTimelineButtonToStaff(
              oldPersistenceStaffIndex,
              newPersistenceStaffIndex,
              buttonId,
              snappedPosition,
              persistenceNodeIndex,
              target.anchor,
            );
          } else if (updateSkillButtonPosition) {
            serviceResult = updateSkillButtonPosition(
              newPersistenceStaffIndex,
              buttonId,
              snappedPosition,
              persistenceNodeIndex,
              target.anchor,
            );
          }
          if (serviceResult) {
            dispatch({
              type: 'SET_SKILL_BUTTON_POSITION',
              buttonId,
              position: snappedPosition,
              lineIndex,
              staffIndex: sourceGroupIndex,
              nodeIndex,
              nodeNumber: calculateNodeNumber(nodeIndex),
              releaseAnchor: target.anchor,
            });
          } else {
            console.error('[useCanvasDrag] service returned null, skipping dispatch');
          }
          dispatch({ type: 'SET_DRAGGING', buttonId, isDragging: false });
          return;
        }

        const targetCharacter = selectedCharacters[lineIndex];
        if (!targetCharacter) return;
        const isGlobalTool = draggingState.dragScope === 'global';
        const characterId = isGlobalTool ? targetCharacter.id : draggingState.characterId;
        const characterName = isGlobalTool
          ? targetCharacter.name ?? targetCharacter.id
          : draggingState.characterName;
        const characterElement = (selectedCharacters as { id: string; element?: string }[]).find(
          character => character.id === characterId,
        )?.element;
        const newButton: SkillButton = {
          id: draggingState.id,
          characterId,
          characterName,
          skillType: draggingState.skillType,
          position: snappedPosition,
          staffIndex: sourceGroupIndex,
          lineIndex,
          nodeIndex,
          nodeNumber: calculateNodeNumber(nodeIndex),
          isDragging: false,
          isSelected: false,
          isFromSandbox: true,
          runtimeSkillId: draggingState.runtimeSkillId,
          skillDisplayName: draggingState.skillDisplayName,
          skillIconUrl: draggingState.timelineModuleKind
            ? undefined
            : draggingState.skillIconUrl ?? resolveSkillIconUrl(characterName, draggingState.skillType),
          customHits: draggingState.customHits,
          element: characterElement,
          releaseAnchor: target.anchor,
          timelineModuleKind: draggingState.timelineModuleKind,
          forcedWaitConfig: draggingState.forcedWaitConfig,
        };

        dispatch({ type: 'ADD_SKILL_BUTTON', button: newButton });
        let committed = true;
        try {
          addTimelineButton?.({
            characterId,
            characterName,
            skillType: draggingState.skillType,
            staffIndex: lineIndex,
            nodeIndex: persistenceNodeIndex,
            position: snappedPosition,
            runtimeSkillId: draggingState.runtimeSkillId,
            skillDisplayName: draggingState.skillDisplayName,
            skillIconUrl: draggingState.skillIconUrl,
            customHits: draggingState.customHits,
            releaseAnchor: target.anchor,
            timelineModuleKind: draggingState.timelineModuleKind,
            forcedWaitConfig: draggingState.forcedWaitConfig,
          }, draggingState.id);
        } catch (timelineError) {
          committed = false;
          console.error('[useCanvasDrag] addTimelineButton failed:', timelineError);
          dispatch({ type: 'REMOVE_SKILL_BUTTON', buttonId: newButton.id });
        }
        if (committed) onNewButtonCommitted?.(newButton);
      } catch (error) {
        console.error('[useCanvasDrag] handleMouseUp error:', error);
      } finally {
        setDropTarget(null);
        setDraggingState(null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    addTimelineButton,
    canvasRef,
    canvasWidth,
    config.snapThreshold,
    disabled,
    dispatch,
    draggingState,
    moveTimelineButtonToStaff,
    onInteractionRejected,
    onNewButtonCommitted,
    selectedCharacters,
    snapTargets,
    staffCount,
    updateSkillButtonPosition,
  ]);

  return {
    draggingState,
    dropTarget,
    snapTargets,
    mousePosition,
    handleSandboxDragStart,
    handleButtonMouseDown,
  };
}
