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
  LaneWaitConfig,
  OperatorSwitchConfig,
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
  GRID_SKILL_BAY_HEIGHT,
  clampGridNodeIndex,
  GRID_NODE_COUNT,
  GRID_TIMELINE_WIDTH,
  getGridGroupTop,
  getGridLineCenterY,
  getGridOperatorPairTopY,
  getGridNodeCenterX,
} from '../../../core/calculators/gridSnapLayout';
import { calculateNodeNumber } from '../../../utils/nodeNumbering';
import { SKILL_BUTTON_BASELINE_OFFSET_Y } from '../../../constants/canvas-layout';
import type { AkeRealtimeTimeline } from '../../../integrations/ake/akeRealtimeTimeline';
import type { AkeProjectedTimeline } from '../../../integrations/ake/akeProvider';
import { projectSharedTimelineFrame } from '../../../core/domain/sharedVariableRateTimeline';
import { debounceFramesForTickRate } from '../../../core/domain/combatActionTailPlanner';
import {
  controlledOperatorAt,
  isFrameInsideUltimate,
  resolveInitialControllerLaneId,
} from '../../../core/domain/operatorControlTimeline';
import {
  attachLegacyLanePredecessors,
  buildReleaseSnapPoints,
  wouldCreateReleaseCycle,
  type ReleaseSnapPoint,
  type TimedReleaseInputWindow,
} from '../../../core/domain/releaseAnchorGraph';
import {
  containsLensPoint, lensPortFrame, lensPortLabel, offsetReleaseLensPort,
  placeReleaseLens, selectReleaseLensPointer, findSavedLensTarget,
  type ReleaseLensView, type LensRect,
} from './releaseLensModel';
import { publishRiaDebugSection, recordRiaDebugEvent } from '../../../integrations/ake/riaLiveDebug';

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
  laneWaitConfig?: LaneWaitConfig;
  operatorSwitchConfig?: OperatorSwitchConfig;
  dragScope: 'character' | 'global';
  lineIndex: number;
  offsetX: number;
  offsetY: number;
  originalButton?: SkillButton;
  editingAnchor?: boolean;
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
  sourceHitOrdinal?: number;
  windowStartFrame?: number;
  windowEndFrameExclusive?: number;
}

interface UseCanvasDragProps {
  disabled?: boolean;
  config: CanvasConfig;
  canvasWidth: number;
  staffCount: number;
  selectedCharacters: { id: string; name?: string }[];
  initialControllerCharacterId?: string | null;
  skillButtons: SkillButton[];
  akeRealtimeTimeline?: AkeRealtimeTimeline | null;
  /** Settled runtime projection; used when the preview has already advanced. */
  akeTimeline?: AkeProjectedTimeline | null;
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
    laneWaitConfig?: LaneWaitConfig;
    operatorSwitchConfig?: OperatorSwitchConfig;
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
  releaseLens: ReleaseLensView | null;
  editReleaseAnchor: (buttonId: string) => void;
  selectLensPort: (id: string) => void;
  changeLensOffset: (offset: number) => void;
  cycleLensPort: (direction: number) => void;
  confirmLens: () => void;
  cancelLens: () => void;
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
  if (kind === 'timed-input') return 0;
  if (kind === 'damage-hit') return 1;
  if (kind === 'action-end') return 2;
  if (kind === 'group-start') return 3;
  return 4;
}

type AkeSettledTimedInputWindow = NonNullable<
  AkeProjectedTimeline['timedInputWindows']
>[number];

/**
 * AKE exposes one pending combo interval and, for some skills, a narrower
 * precision interval inside it. They are two legal release choices, not two
 * labels for the same point. Keep both candidates in the anchor graph while
 * retaining the runtime window id for admission checks.
 */
export function comboTimedInputCandidates(
  realtime: AkeRealtimeTimeline | null,
  settled: AkeProjectedTimeline | null,
): TimedReleaseInputWindow[] {
  const realtimeCandidates = (realtime?.comboWindows ?? []).flatMap((window) => {
    if (!window.precisionWindow || !window.sourceCommandId) return [];
    const broadEndFrameExclusive = Math.max(
      window.createdFrame + 1,
      window.expireFrame + 1,
    );
    return [
      {
        id: `${window.id}:broad`,
        sourceCommandId: window.sourceCommandId,
        sourceTimedInputId: window.id,
        startFrame: window.createdFrame,
        endFrameExclusive: broadEndFrameExclusive,
        preferredFrame: window.createdFrame,
        label: '非精准连携',
        windowKind: 'broad' as const,
        sourceSkillId: realtime?.commands.find(command => command.commandId === window.sourceCommandId)?.profile.skillId,
      },
      {
        id: `${window.id}:precision`,
        sourceCommandId: window.sourceCommandId,
        sourceTimedInputId: window.id,
        startFrame: window.precisionWindow.startFrame,
        endFrameExclusive: window.precisionWindow.endFrameExclusive,
        label: '精准连携',
        windowKind: 'precision' as const,
        sourceSkillId: realtime?.commands.find(command => command.commandId === window.sourceCommandId)?.profile.skillId,
      },
    ];
  });
  if (realtimeCandidates.length > 0) return realtimeCandidates;

  // A settled report may be the first source available after a calculation;
  // older reports did not carry sourceCommandId, so retain a deterministic
  // command lookup fallback for those payloads.
  const settledComboWindows = settled?.comboWindows ?? [];
  const settledCommands = settled?.commands ?? [];
  return (settled?.timedInputWindows ?? []).flatMap((window: AkeSettledTimedInputWindow) => {
    if (!window.inputTypes.includes('ComboSkill')) return [];
    const matchingCombo = settledComboWindows.find(candidate => (
      candidate.characterId === window.ownerId
      && candidate.createdFrame === window.createdFrame
      && Boolean(candidate.sourceCommandId)
    ));
    const fallbackCommand = [...settledCommands]
      .filter(command => (
        command.characterId === window.ownerId
        && (!window.sourceSkillId || command.skillId === window.sourceSkillId)
        && command.actualFrame !== null
        && command.actualFrame <= window.createdFrame
      ))
      .sort((left, right) => (
        (right.actualFrame ?? -1) - (left.actualFrame ?? -1)
      ))[0];
    const sourceCommandId = window.sourceCommandId
      ?? matchingCombo?.sourceCommandId
      ?? fallbackCommand?.commandId
      ?? null;
    if (!sourceCommandId) return [];
    const broadEndFrameExclusive = Math.max(
      window.createdFrame + 1,
      matchingCombo ? matchingCombo.expireFrame + 1 : window.endFrameExclusive,
    );
    return [
      {
        id: `${window.id}:broad`,
        sourceCommandId,
        sourceTimedInputId: window.id,
        startFrame: window.createdFrame,
        endFrameExclusive: broadEndFrameExclusive,
        preferredFrame: window.createdFrame,
        label: '非精准连携',
        windowKind: 'broad' as const,
        sourceSkillId: window.sourceSkillId ?? undefined,
      },
      {
        id: `${window.id}:precision`,
        sourceCommandId,
        sourceTimedInputId: window.id,
        startFrame: window.startFrame,
        endFrameExclusive: window.endFrameExclusive,
        label: '精准连携',
        windowKind: 'precision' as const,
        sourceSkillId: window.sourceSkillId ?? undefined,
      },
    ];
  });
}

export function hitsEligibleForReleaseSnap(
  timeline: Pick<AkeRealtimeTimeline, 'commands' | 'hits'>,
): AkeRealtimeTimeline['hits'] {
  const commandTypeById = new Map(
    timeline.commands.map(command => [command.commandId, command.commandType]),
  );
  return timeline.hits.filter(hit => (
    commandTypeById.get(hit.commandId) !== 'UltimateSkill'
    // A lingering hit belongs to an already committed status/projectile tail.
    // It remains visible and damage-bearing, but cannot hold the next combat
    // action hostage or become a magnetic release anchor.  Rossi's long bleed
    // is the minimal public-data case: treating its final DoT tick as a skill
    // release point moved the following combo from ~3 s to ~27 s.
    && hit.kind !== 'lingering'
    // Status/buff damage can be emitted while the source action is still
    // active, so the coarse `kind` field is not sufficient by itself.
    && hit.releaseEligible !== false
  ));
}

export function isComboReleaseFrameAvailable({
  timeline,
  characterId,
  skillId,
  movingCommandId,
  frame,
}: {
  timeline: Pick<AkeRealtimeTimeline, 'verifiedComboSkills' | 'comboWindows'> | null;
  characterId: string;
  skillId?: string;
  movingCommandId: string | null;
  frame: number;
}): boolean {
  if (!timeline) return true;
  const isVerified = timeline.verifiedComboSkills.some(combo => (
    combo.characterId === characterId
    && (!skillId || combo.skillId === skillId)
  ));
  if (!isVerified) return true;
  return timeline.comboWindows.some(window => (
    window.characterId === characterId
    && (!skillId || window.skillId === skillId)
    && window.state !== 'suppressed'
    && (window.state !== 'consumed' || window.consumedCommandId === movingCommandId)
    && frame >= window.createdFrame
    && frame < window.expireFrame
  ));
}

export function useCanvasDrag({
  disabled = false,
  config,
  canvasWidth,
  staffCount,
  selectedCharacters,
  initialControllerCharacterId = null,
  skillButtons,
  akeRealtimeTimeline = null,
  akeTimeline = null,
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
  const [releaseLens, setReleaseLens] = useState<ReleaseLensView | null>(null);
  const lensRef = useRef<ReleaseLensView | null>(null);
  const lensActionsRef = useRef({ select: (_id: string) => {}, offset: (_offset: number) => {},
    cycle: (_direction: number) => {}, confirm: () => {}, cancel: () => {} });
  const frozenDragRef = useRef<{ id: string; targets: CanvasDropTarget[]; revision: string; timeline: AkeRealtimeTimeline | null;
    sources: { button: SkillButton; rect: LensRect }[] } | null>(null);

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
        hits: hitsEligibleForReleaseSnap(akeRealtimeTimeline)
          .map(hit => ({
            id: hit.id,
            commandId: hit.commandId,
            frame: hit.frame,
            offsetFrames: hit.offsetFrames,
            releaseEligible: hit.releaseEligible,
          })),
        timedInputWindows: comboTimedInputCandidates(akeRealtimeTimeline, akeTimeline),
        debounceFrames: debounceFramesForTickRate(akeRealtimeTimeline.tickRate),
        projectFrame: frame => projectSharedTimelineFrame(model, frame, 'after')
          ?? (frame >= model.endFrame ? model.width : null),
      });
      model.laneWaits.forEach((wait) => {
        const sourceGroupIndex = sourceGroupIndexByGroupId.get(wait.groupId) ?? 0;
        const sourceButton = buttonById.get(wait.id);
        points.push({
          id: `lane-wait-end:${wait.id}`,
          kind: 'action-end',
          frame: wait.endFrame,
          globalX: wait.endX,
          groupId: wait.groupId,
          groupIndex: sourceGroupIndex,
          label: `紧跟 ${sourceButton?.skillDisplayName ?? '普通等待'} 尾部`,
          anchor: {
            schemaVersion: 1,
            kind: 'action-end',
            sourceButtonId: wait.id,
            debounceFrames: 0,
          },
        });
      });
      model.operatorSwitches.forEach((operatorSwitch) => {
        const sourceGroupIndex = sourceGroupIndexByGroupId.get(operatorSwitch.groupId) ?? 0;
        const sourceButton = buttonById.get(operatorSwitch.id);
        points.push({
          id: `operator-switch-end:${operatorSwitch.id}`,
          kind: 'action-end',
          frame: operatorSwitch.endFrame,
          globalX: operatorSwitch.endX,
          groupId: operatorSwitch.groupId,
          groupIndex: sourceGroupIndex,
          label: `紧跟 ${sourceButton?.skillDisplayName ?? '切人'} 尾部`,
          anchor: {
            schemaVersion: 1,
            kind: 'action-end',
            sourceButtonId: operatorSwitch.id,
            debounceFrames: 0,
          },
        });
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
      skillButtons
        .filter(button => button.timelineModuleKind === 'lane-wait')
        .forEach((button) => {
          const groupIndex = Math.max(0, button.staffIndex);
          const localNodeIndex = clampGridNodeIndex(button.nodeIndex ?? 0);
          const startFrame = groupIndex * GRID_NODE_COUNT * 15 + localNodeIndex * 15;
          const durationFrames = button.laneWaitConfig?.mode === 'fixed-duration'
            ? Math.max(1, Math.round(button.laneWaitConfig.durationSeconds * 30))
            : 0;
          const globalX = groupIndex * GRID_TIMELINE_WIDTH
            + (localNodeIndex + 1) * GRID_COLUMN_WIDTH;
          points.push({
            id: `lane-wait-end:${button.id}`,
            kind: 'action-end',
            frame: startFrame + durationFrames,
            globalX,
            groupId: `release-group:${groupIndex}`,
            groupIndex,
            label: `紧跟 ${button.skillDisplayName ?? '普通等待'} 尾部`,
            anchor: {
              schemaVersion: 1,
              kind: 'action-end',
              sourceButtonId: button.id,
              debounceFrames: 0,
            },
          });
        });
      skillButtons
        .filter(button => button.timelineModuleKind === 'operator-switch')
        .forEach((button) => {
          const groupIndex = Math.max(0, button.staffIndex);
          const localNodeIndex = clampGridNodeIndex(button.nodeIndex ?? 0);
          points.push({
            id: `operator-switch-end:${button.id}`,
            kind: 'action-end',
            frame: groupIndex * GRID_NODE_COUNT * 15 + localNodeIndex * 15,
            globalX: groupIndex * GRID_TIMELINE_WIDTH
              + (localNodeIndex + 1) * GRID_COLUMN_WIDTH,
            groupId: `release-group:${groupIndex}`,
            groupIndex,
            label: `紧跟 ${button.skillDisplayName ?? '切人'} 尾部`,
            anchor: {
              schemaVersion: 1,
              kind: 'action-end',
              sourceButtonId: button.id,
              debounceFrames: 0,
            },
          });
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
  }, [akeRealtimeTimeline, akeTimeline, skillButtons]);

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
    const sourceLaneIdById = new Map<string, string>([
      ...(akeRealtimeTimeline?.sharedVariableRateTimeline?.actions ?? [])
        .map(action => [action.id, action.laneId] as [string, string]),
      ...(akeRealtimeTimeline?.sharedVariableRateTimeline?.laneWaits ?? [])
        .map(wait => [wait.id, wait.laneId] as [string, string]),
      ...(akeRealtimeTimeline?.sharedVariableRateTimeline?.operatorSwitches ?? [])
        .map(operatorSwitch => [operatorSwitch.id, operatorSwitch.laneId] as [string, string]),
      ...skillButtons
        .filter(button => (
          button.timelineModuleKind === 'lane-wait'
          || button.timelineModuleKind === 'operator-switch'
        ))
        .map(button => [button.id, button.characterId] as [string, string]),
    ]);
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
      if (point.kind === 'timed-input') {
        const sourceWindow = point.anchor.sourceTimedInputId
          ? akeRealtimeTimeline?.comboWindows.find(window => (
            window.id === point.anchor.sourceTimedInputId
          ))
          : null;
        const settledSourceWindow = point.anchor.sourceTimedInputId
          ? (akeTimeline?.timedInputWindows ?? []).find(window => (
            window.id === point.anchor.sourceTimedInputId
          ))
          : null;
        const sourceCharacterId = sourceWindow?.characterId
          ?? settledSourceWindow?.ownerId
          ?? null;
        if (draggingState.timelineModuleKind
          || draggingState.skillType !== 'E'
          || !sourceCharacterId
          || sourceCharacterId !== draggingState.characterId) {
          continue;
        }
      }
      // Verified combo skills only expose anchors inside a trigger window.
      // A consumed window remains available while moving the command that
      // consumed it, but cannot be reused by a second combo button.
      if (draggingState.skillType === 'E'
        && !draggingState.timelineModuleKind
        && !isComboReleaseFrameAvailable({
          timeline: akeRealtimeTimeline,
          characterId: draggingState.characterId,
          // E is one player intent.  Its runtime SkillData may already have
          // changed from stage 1 to stage 2, while the palette button keeps the
          // stable base id.  Gate against the character's active ComboSkill
          // window, then let the state machine resolve the concrete stage.
          movingCommandId: movingButtonId,
          frame: point.frame,
        })) {
        continue;
      }
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
      if (draggingState.timelineModuleKind === 'lane-wait') {
        if (point.id.startsWith('new-group:') && point.groupIndex > 0) continue;
        if (point.kind !== 'group-start' && point.kind !== 'action-end') continue;
      }
      if (draggingState.timelineModuleKind === 'operator-switch') {
        if (!['group-start', 'action-end', 'damage-hit'].includes(point.kind)) continue;
      }
      if (draggingState.timelineModuleKind === 'dodge'
        || draggingState.timelineModuleKind === 'perfect-dodge') {
        if (!['group-start', 'action-end', 'damage-hit'].includes(point.kind)) continue;
      }
      const variableModel = akeRealtimeTimeline?.sharedVariableRateTimeline ?? null;
      const controlRestricted = (
        draggingState.skillType === 'A' && !draggingState.timelineModuleKind
      )
        || ['dodge', 'perfect-dodge', 'operator-switch']
          .includes(draggingState.timelineModuleKind ?? '');
      if (['dodge', 'perfect-dodge', 'operator-switch'].includes(
        draggingState.timelineModuleKind ?? '',
      ) && variableModel && isFrameInsideUltimate(variableModel.actions, point.frame)) {
        continue;
      }
      const controlledCharacterId = controlledOperatorAt(
        resolveInitialControllerLaneId(
          initialControllerCharacterId,
          selectedCharacters.map(character => character.id),
        ),
        variableModel?.operatorSwitches ?? [],
        point.frame,
        point.globalX,
      );

      const visual = visualLocationForGlobalX(point.globalX);
      if (visual.staffIndex >= staffCount) continue;
      for (const lineIndex of allowedLineIndices) {
        const characterId = selectedCharacters[lineIndex]?.id;
        if (!characterId) continue;
        if (controlRestricted && characterId !== controlledCharacterId) continue;
        if (point.id.startsWith('lane-wait-end:')
          && sourceButtonId
          && sourceLaneIdById.get(sourceButtonId) !== characterId) {
          continue;
        }
        if (draggingState.timelineModuleKind === 'lane-wait'
          && point.kind === 'action-end'
          && sourceButtonId
          && sourceLaneIdById.get(sourceButtonId) !== characterId) {
          continue;
        }
        const sameFrameCollision = (akeRealtimeTimeline?.sharedVariableRateTimeline?.actions ?? [])
          .some(action => (
            action.id !== movingButtonId
            && action.laneId === characterId
            && action.startFrame === point.frame
            && action.groupId === point.groupId
          ));
        if (sameFrameCollision) continue;
        if (draggingState.timelineModuleKind === 'operator-switch') {
          const sameSwitchPosition = (variableModel?.operatorSwitches ?? []).some(operatorSwitch => (
            operatorSwitch.id !== movingButtonId
            && operatorSwitch.startFrame === point.frame
          ));
          if (sameSwitchPosition) continue;
        }

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
          sourceHitOrdinal: point.sourceHitOrdinal,
          windowStartFrame: point.windowStartFrame,
          windowEndFrameExclusive: point.windowEndFrameExclusive,
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
        // Broad and precision combo intervals can project to the same pixel
        // after variable-rate compression. Their anchor identity must survive
        // deduplication so the drop preview can expose both legal choices.
        const key = `${target.staffIndex}:${target.lineIndex}:${Math.round(target.markerX)}:${target.anchorId}`;
        if (!deduplicated.has(key)) deduplicated.set(key, target);
      });
    return [...deduplicated.values()];
  }, [
    akeRealtimeTimeline,
    akeTimeline,
    draggingState,
    initialControllerCharacterId,
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
      if (disabled || e.button !== 0) return;
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
        laneWaitConfig: sandboxSkill.laneWaitConfig,
        operatorSwitchConfig: sandboxSkill.operatorSwitchConfig,
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
      e.preventDefault();
      e.stopPropagation();
      if (disabled || e.button !== 0) return;
      // A placed action is a queue entry, not a free-positioned canvas object.
      // Sandbox insertion and explicit release-anchor editing have their own paths.
      if (skillButtons.some(button => button.id === buttonId)) {
        dispatch({ type: 'SELECT_SKILL_BUTTON', buttonId });
      }
    },
    [disabled, skillButtons, dispatch],
  );

  const editReleaseAnchor = useCallback((buttonId: string) => {
    const button = skillButtonsRef.current.find(candidate => candidate.id === buttonId);
    if (!button?.releaseAnchor?.sourceButtonId || button.basicAttackTailBundle || disabled) return;
    setDraggingState({ id: button.id, characterId: button.characterId, characterName: button.characterName,
      skillType: button.skillType, runtimeSkillId: button.runtimeSkillId, skillDisplayName: button.skillDisplayName,
      skillIconUrl: button.skillIconUrl, customHits: button.customHits, timelineModuleKind: button.timelineModuleKind,
      forcedWaitConfig: button.forcedWaitConfig, laneWaitConfig: button.laneWaitConfig,
      operatorSwitchConfig: button.operatorSwitchConfig, dragScope: button.timelineModuleKind ? 'global' : 'character',
      lineIndex: button.lineIndex, offsetX: config.skillButtonSize / 2, offsetY: config.skillButtonSize / 2,
      originalButton: button, editingAnchor: true });
  }, [config.skillButtonSize, disabled]);

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
    lensRef.current = null;
    setReleaseLens(null);
    frozenDragRef.current = null;
  }, [disabled, dispatch]);

  useEffect(() => {
    if (!draggingState || disabled) return;

    const inputRevision = (buttons: SkillButton[]) => JSON.stringify(buttons.map(button => [
      button.id, button.staffIndex, button.lineIndex, button.nodeIndex, button.runtimeSkillId,
      button.releaseAnchor, button.basicAttackStageCount, button.timelineModuleKind,
    ]));
    if (frozenDragRef.current?.id !== draggingState.id) {
      const sources = skillButtonsRef.current.filter(button => button.id !== draggingState.id).flatMap(button => {
        const element = canvasRef.current?.querySelector<HTMLElement>(`[data-skill-button-id="${CSS.escape(button.id)}"]`);
        const rect = (element?.querySelector('.skill-button-orb') ?? element)?.getBoundingClientRect();
        return rect ? [{ button, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }] : [];
      });
      frozenDragRef.current = { id: draggingState.id, targets: snapTargets, sources, timeline: akeRealtimeTimeline,
        revision: inputRevision(skillButtonsRef.current) };
    }
    const frozen = frozenDragRef.current;
    let hoverSourceId: string | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPointer = { x: mousePosition.x, y: mousePosition.y };
    let lastLensPointer = { x: Number.NaN, y: Number.NaN };
    const clearHover = () => { if (hoverTimer) clearTimeout(hoverTimer); hoverTimer = null; hoverSourceId = null; };
    const publishLens = (view: ReleaseLensView | null) => {
      lensRef.current = view;
      setReleaseLens(view);
      publishRiaDebugSection('releaseLens', view ? {
        sourceButtonId: view.session.sourceButtonId, sourceName: view.session.sourceName,
        rect: view.session.rect, sourceRect: view.session.sourceRect, tickRate: view.session.tickRate,
        candidateRevision: frozen.revision, draft: true,
        selectedAnchorId: view.selectedId, offsetFrames: view.offsetFrames, frame: view.target?.frame ?? null,
        anchor: view.target?.anchor ?? null, reason: view.reason, note: view.note, editing: view.editing,
        candidates: view.session.ports.map(port => ({ id: port.target.anchorId, label: port.label,
          frame: port.eventFrame, minFrame: port.minFrame, maxFrameExclusive: port.maxFrameExclusive,
          anchor: port.target.anchor })),
      } : { active: false });
    };
    const updateLensSelection = (id: string, offset: number) => {
      const current = lensRef.current;
      const port = current?.session.ports.find(candidate => candidate.target.anchorId === id);
      if (!current || !port) return;
      let { target, reason } = offsetReleaseLensPort(port, offset);
      if (target && draggingState.skillType === 'E' && !draggingState.timelineModuleKind
        && !isComboReleaseFrameAvailable({ timeline: frozen.timeline, characterId: draggingState.characterId,
          movingCommandId: draggingState.originalButton?.id ?? null, frame: target.frame })) {
        reason = '此时连携窗口不可用'; target = null;
      }
      const model = frozen.timeline?.sharedVariableRateTimeline;
      if (target && model) {
        const globalX = projectSharedTimelineFrame(model, target.frame, 'after');
        if (globalX !== null) target = { ...target, ...visualLocationForGlobalX(globalX) };
        const collision = model.actions.find(action => action.id !== draggingState.id
          && action.laneId === selectedCharacters[target!.lineIndex]?.id && action.startFrame === target!.frame);
        const duplicateSwitch = draggingState.timelineModuleKind === 'operator-switch'
          && model.operatorSwitches.some(item => item.id !== draggingState.id && item.startFrame === target!.frame);
        if (collision || duplicateSwitch) {
          reason = collision ? '该角色在这一帧已有动作起手；请调整延迟' : '这一帧已有切人操作';
          target = null;
        }
      }
      if (target && model) {
        const globalX = projectSharedTimelineFrame(model, target.frame, 'after');
        const restricted = (draggingState.skillType === 'A' && !draggingState.timelineModuleKind)
          || ['dodge', 'perfect-dodge', 'operator-switch'].includes(draggingState.timelineModuleKind ?? '');
        if (restricted && controlledOperatorAt(resolveInitialControllerLaneId(initialControllerCharacterId,
          selectedCharacters.map(character => character.id)), model.operatorSwitches, target.frame, globalX ?? 0)
          !== selectedCharacters[target.lineIndex]?.id) {
          reason = '该时刻的主控不匹配'; target = null;
        } else if (['dodge', 'perfect-dodge', 'operator-switch'].includes(draggingState.timelineModuleKind ?? '')
          && isFrameInsideUltimate(model.actions, target.frame)) {
          reason = '此时仍受终结技动作占用'; target = null;
        }
      }
      const source = frozen.sources.find(source => source.button.id === current.session.sourceButtonId)?.button;
      const command = frozen.timeline?.commands.find(command => command.commandId === source?.id);
      const note = command?.releaseVerdict === 'unverified'
        ? '来源连携门槛待核验；接点可规划不等于整段已验证'
        : source?.characterId !== draggingState.characterId
          ? '跨角色衔接；沿用当前主控，松手后核验资源与触发条件'
          : source?.skillType === 'A'
            ? '普攻仍按保留段数截段；已发出效果按其机制继续结算'
            : '同角色衔接；截段与效果存续在提交后按机制核验';
      publishLens({ ...current, selectedId: id, offsetFrames: offset, target, reason, note });
      setDropTarget(target);
    };
    const openLens = (source: typeof frozen.sources[number]) => {
      clearHover();
      const targets = frozen.targets.filter(target => target.anchor.sourceButtonId === source.button.id
        && target.lineIndex === (draggingState.dragScope === 'global' ? source.button.lineIndex
          : selectedCharacters.findIndex(character => character.id === draggingState.characterId)));
      const unique = [...new Map(targets.map(target => [target.anchorId, target])).values()]
        .sort((a, b) => lensPortFrame(a) - lensPortFrame(b) || snapKindRank(a.anchor.kind) - snapKindRank(b.anchor.kind));
      if (!unique.length) return;
      const saved = draggingState.originalButton?.releaseAnchor;
      const savedTarget = saved ? findSavedLensTarget(unique, saved) : undefined;
      // Editing an existing relation must never choose a different hit/window silently.
      if (draggingState.editingAnchor && !savedTarget) return;
      const chosen = savedTarget ?? unique.find(target => target.anchor.kind === 'damage-hit') ?? unique[0];
      const ports = unique.map(target => ({ target, eventFrame: lensPortFrame(target),
        label: lensPortLabel(target, target.sourceHitOrdinal ?? 1), minFrame: target.windowStartFrame,
        maxFrameExclusive: target.windowEndFrameExclusive }));
      const current: ReleaseLensView = { session: { sourceButtonId: source.button.id,
        successorName: `${draggingState.characterName} · ${draggingState.skillDisplayName ?? draggingState.skillType}`,
        sourceName: `${source.button.characterName} · ${source.button.skillDisplayName ?? source.button.skillType} · F${frozen.timeline?.sharedVariableRateTimeline?.actions.find(action => action.id === source.button.id)?.startFrame ?? "?"}`,
        sourceIconUrl: source.button.skillIconUrl, sourceRect: source.rect,
        rect: placeReleaseLens(source.rect, { width: window.innerWidth, height: window.innerHeight }),
        ports, tickRate: frozen.timeline?.tickRate ?? 30,
        hits: (frozen.timeline?.hits ?? []).filter(hit => hit.commandId === source.button.id)
          .map(hit => ({ frame: hit.frame, lingering: hit.kind === 'lingering' || hit.releaseEligible === false })),
      }, selectedId: chosen.anchorId, offsetFrames: chosen.frame - lensPortFrame(chosen), target: chosen,
      reason: null, note: '', editing: !!draggingState.editingAnchor };
      publishLens(current);
      const offset = saved && chosen.anchor.kind === saved.kind && saved.sourceButtonId === source.button.id
        ? saved.debounceFrames + (saved.kind === 'timed-input'
          ? (saved.sourceTimedInputOffsetFrames ?? 0) - (chosen.anchor.sourceTimedInputOffsetFrames ?? 0)
            + chosen.frame - lensPortFrame(chosen) : 0)
        : current.offsetFrames;
      updateLensSelection(chosen.anchorId, Math.max(0, offset));
      lastLensPointer = { ...lastPointer };
      recordRiaDebugEvent('interaction', 'ReleaseLensOpened', { sourceButtonId: source.button.id,
        candidateCount: ports.length, editing: !!draggingState.editingAnchor });
    };
    const cancel = () => {
      clearHover();
      if (draggingState.originalButton) dispatch({ type: 'SET_DRAGGING', buttonId: draggingState.id, isDragging: false });
      publishLens(null); setDropTarget(null); setDraggingState(null); frozenDragRef.current = null;
      recordRiaDebugEvent('interaction', 'ReleaseLensCancelled', { buttonId: draggingState.id });
    };
    const cycle = (direction: number) => {
      const view = lensRef.current;
      if (!view) return;
      const ports = view.session.ports;
      const index = ports.findIndex(port => port.target.anchorId === view.selectedId);
      const next = ports[(index + direction % ports.length + ports.length) % ports.length];
      updateLensSelection(next.target.anchorId, next.target.frame - next.eventFrame);
    };
    lensActionsRef.current = { select: id => { const port = lensRef.current?.session.ports.find(p => p.target.anchorId === id);
      if (port) updateLensSelection(id, port.target.frame - port.eventFrame); },
      offset: offset => { if (lensRef.current) updateLensSelection(lensRef.current.selectedId, offset); },
      cycle, cancel, confirm: () => {} };

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
      if (gridY < pairTop || gridY > pairTop + GRID_SKILL_BAY_HEIGHT) return null;

      const candidates = frozen.targets.filter(target => (
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
      // Recover when mouseup happened outside the window: the next move no
      // longer carries the left button. Explicit click-to-edit stays open.
      if (!draggingState.editingAnchor && !(event.buttons & 1)) { cancel(); return; }
      lastPointer = { x: event.clientX, y: event.clientY };
      setMousePosition({ x: event.clientX, y: event.clientY });
      const view = lensRef.current;
      if (draggingState.editingAnchor && !(event.buttons & 1)) return;
      if (view && containsLensPoint(view.session.rect, event.clientX, event.clientY, 16)) {
        clearHover();
        if (!Number.isFinite(lastLensPointer.x)
          || Math.hypot(lastLensPointer.x - event.clientX, lastLensPointer.y - event.clientY) >= 3) {
          const selection = selectReleaseLensPointer(view, event.clientX, event.clientY);
          if (selection && (selection.id !== view.selectedId || selection.offset !== view.offsetFrames)) {
            updateLensSelection(selection.id, selection.offset);
          }
          lastLensPointer = { ...lastPointer };
        }
        return;
      }
      if (draggingState.editingAnchor) return;
      if (view) {
        const source = view.session.sourceRect, lens = view.session.rect;
        const bridge = { left: Math.min(source.left, lens.left), top: Math.min(source.top, lens.top),
          width: Math.max(source.left + source.width, lens.left + lens.width) - Math.min(source.left, lens.left),
          height: Math.max(source.top + source.height, lens.top + lens.height) - Math.min(source.top, lens.top) };
        if (containsLensPoint(bridge, event.clientX, event.clientY, 20)) return;
        publishLens(null);
      }
      const source = frozen.sources.filter(source => containsLensPoint(source.rect, event.clientX, event.clientY, 38)
        && frozen.targets.some(target => target.anchor.sourceButtonId === source.button.id))
        .sort((a, b) => Math.hypot(event.clientX - a.rect.left - a.rect.width / 2, event.clientY - a.rect.top - a.rect.height / 2)
          - Math.hypot(event.clientX - b.rect.left - b.rect.width / 2, event.clientY - b.rect.top - b.rect.height / 2))[0];
      if (source && hoverSourceId !== source.button.id) {
        clearHover(); hoverSourceId = source.button.id;
        hoverTimer = setTimeout(() => openLens(source), 160);
      } else if (!source) clearHover();
      updateDropTarget(event.clientX, event.clientY);
    };

    const handleMouseUp = (event: Pick<MouseEvent, 'clientX' | 'clientY'>, force = false) => {
      if (draggingState.editingAnchor && !force) return;
      try {
        const canvasElement = canvasRef.current;
        const view = lensRef.current;
        if (frozen.revision !== inputRevision(skillButtonsRef.current)) {
          onInteractionRejected?.('排轴在编辑期间发生变化；已取消本次接续，请重新选择。');
          return;
        }
        // A visible lens owns this drag. A rejected draft cannot fall through
        // to a different background snap point when released near its source.
        if (view && !view.target) {
          onInteractionRejected?.(view.reason ?? '当前接点不可用'); return;
        }
        const gridStack = canvasElement?.querySelector('.canvas-grid-stack');
        const inLensRegion = view && (force
          || containsLensPoint(view.session.rect, event.clientX, event.clientY, 20)
          || containsLensPoint(view.session.sourceRect, event.clientX, event.clientY, 38));
        const resolved = view
          ? view.target && gridStack && inLensRegion
            ? { target: view.target, gridStack, lineY: getGridLineCenterY(view.target.lineIndex) } : null
          : resolveTarget(event.clientX, event.clientY);
        if (!canvasElement || !resolved) {
          if (draggingState.originalButton) {
            dispatch({ type: 'SET_DRAGGING', buttonId: draggingState.originalButton.id, isDragging: false });
          } else {
            onInteractionRejected?.('这里只是显示格，不是合法释放点；请放到高亮的组起点、技能尾部或伤害锚点。');
          }
          return;
        }

        const { target, gridStack: targetGridStack } = resolved;
        const { lineIndex, nodeIndex, sourceGroupIndex } = target;
        // Persist in the logical source-group coordinate system.  The visible
        // page may be a compressed projection of that group and can differ
        // from sourceGroupIndex after variable-rate waits.
        const snappedPosition = gridToCanvasContentCoords(
          getGridNodeCenterX(nodeIndex),
          getGridGroupTop(sourceGroupIndex)
            + getGridLineCenterY(lineIndex)
            + SKILL_BUTTON_BASELINE_OFFSET_Y,
          canvasElement,
          targetGridStack,
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
            recordRiaDebugEvent('interaction', 'ReleaseLensCommitted', { buttonId, frame: target.frame, anchor: target.anchor });
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
        const operatorSwitchConfig = draggingState.timelineModuleKind === 'operator-switch'
          ? draggingState.operatorSwitchConfig ?? (() => {
            if (selectedCharacters.length < 2) return undefined;
            const nextCharacter = selectedCharacters[(lineIndex + 1) % selectedCharacters.length];
            return nextCharacter
              ? { schemaVersion: 1 as const, targetCharacterId: nextCharacter.id }
              : undefined;
          })()
          : undefined;
        if (draggingState.timelineModuleKind === 'operator-switch' && !operatorSwitchConfig) {
          onInteractionRejected?.('至少选择两位干员后才能切人。');
          return;
        }
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
          laneWaitConfig: draggingState.laneWaitConfig,
          operatorSwitchConfig,
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
            laneWaitConfig: draggingState.laneWaitConfig,
            operatorSwitchConfig,
          }, draggingState.id);
        } catch (timelineError) {
          committed = false;
          console.error('[useCanvasDrag] addTimelineButton failed:', timelineError);
          dispatch({ type: 'REMOVE_SKILL_BUTTON', buttonId: newButton.id });
        }
        if (committed) {
          onNewButtonCommitted?.(newButton);
          recordRiaDebugEvent('interaction', 'ReleaseLensCommitted', { buttonId: newButton.id, frame: target.frame, anchor: target.anchor });
        }
      } catch (error) {
        console.error('[useCanvasDrag] handleMouseUp error:', error);
      } finally {
        clearHover();
        publishLens(null);
        frozenDragRef.current = null;
        if (draggingState.originalButton) dispatch({ type: 'SET_DRAGGING', buttonId: draggingState.id, isDragging: false });
        setDropTarget(null);
        setDraggingState(null);
      }
    };

    lensActionsRef.current.confirm = () => handleMouseUp({ clientX: lastPointer.x, clientY: lastPointer.y }, true);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      const view = lensRef.current;
      if (!view || (event.target instanceof HTMLInputElement)) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); updateLensSelection(view.selectedId,
          Math.max(0, view.offsetFrames + (event.key === 'ArrowLeft' ? -1 : 1)));
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); cycle(event.key === 'ArrowUp' ? -1 : 1);
      } else if (event.key === 'Enter' && draggingState.editingAnchor) {
        event.preventDefault(); lensActionsRef.current.confirm();
      }
    };
    const handleWheel = (event: WheelEvent) => {
      const view = lensRef.current;
      if (!view || !containsLensPoint(view.session.rect, event.clientX, event.clientY)) return;
      event.preventDefault();
      if (Math.abs(event.deltaY) > 2) cycle(event.deltaY > 0 ? 1 : -1);
    };
    if (draggingState.editingAnchor && !lensRef.current) {
      const source = frozen.sources.find(source => source.button.id === draggingState.originalButton?.releaseAnchor?.sourceButtonId);
      if (source) openLens(source);
      if (!lensRef.current) { onInteractionRejected?.('原接续点当前不可用；请重新拖动选择来源。'); cancel(); }
    }

    window.addEventListener('mousemove', handleMouseMove);
    const onMouseUp = (event: MouseEvent) => handleMouseUp(event);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      clearHover();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
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
    akeRealtimeTimeline,
    initialControllerCharacterId,
  ]);

  return {
    draggingState,
    dropTarget,
    snapTargets,
    mousePosition,
    handleSandboxDragStart,
    handleButtonMouseDown,
    releaseLens,
    editReleaseAnchor,
    selectLensPort: id => lensActionsRef.current.select(id),
    changeLensOffset: offset => lensActionsRef.current.offset(offset),
    cycleLensPort: direction => lensActionsRef.current.cycle(direction),
    confirmLens: () => lensActionsRef.current.confirm(),
    cancelLens: () => lensActionsRef.current.cancel(),
  };
}
