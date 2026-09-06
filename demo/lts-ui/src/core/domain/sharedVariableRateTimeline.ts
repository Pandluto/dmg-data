/**
 * Pure domain model for the shared, variable-rate combat timeline.
 *
 * Contract:
 * - real combat frames are authoritative;
 * - skills in one lane form a tight tail-chain inside a release group;
 * - a full wait column seals the previous group and delays the next group;
 * - visual columns are derived from resolved frames and never determine them;
 * - release admission remains injectable so the real combat state machine stays
 *   the source of truth for resources, cooldowns, combo windows, and variants.
 */

export type TimelineFrame = number;

export type TimelineActionSpec = {
  id: string;
  /** Resolved blocking duration. Delayed hits/effect tails do not belong here. */
  durationFrames: number;
  /** A verified cast that applies its effect without taking the foreground action slot. */
  instantaneous?: boolean;
  /**
   * Explicit group-local release offset resolved from the anchor DAG. Omitted
   * values retain the legacy lane-tail chaining behavior.
   */
  startOffsetFrames?: number;
  sharedAtbCost?: number;
  payload?: unknown;
};

export type TimelineLaneSpec = {
  laneId: string;
  actions: TimelineActionSpec[];
};

/** A lane-local ordinary wait. It never separates release groups. */
export type TimelineLaneWaitSpec = {
  id: string;
  laneId: string;
  startOffsetFrames: number;
  durationFrames: number;
};

/** A zero-time control handoff rendered inside one release group. */
export type TimelineOperatorSwitchSpec = {
  id: string;
  /** The operator who must be controlled immediately before the handoff. */
  laneId: string;
  targetLaneId: string;
  startOffsetFrames: number;
};

export type SealOnlyWaitColumnSpec = {
  id: string;
  mode: 'seal-only';
};

export type FixedWaitColumnSpec = {
  id: string;
  mode: 'fixed-duration';
  durationFrames: number;
};

export type AtbTargetWaitColumnSpec = {
  id: string;
  mode: 'atb-target';
  targetAtb: number;
  /** Optional cached resolution. Omit to force resolution through the runtime adapter. */
  resolvedDurationFrames?: number;
};

export type NextGroupReadyWaitColumnSpec = {
  id: string;
  mode: 'next-group-ready';
  /** Optional cached resolution. Omit to force resolution through the runtime adapter. */
  resolvedDurationFrames?: number;
};

export type WaitColumnSpec =
  | SealOnlyWaitColumnSpec
  | FixedWaitColumnSpec
  | AtbTargetWaitColumnSpec
  | NextGroupReadyWaitColumnSpec;

export type TimelineReleaseGroupSpec = {
  id: string;
  lanes: TimelineLaneSpec[];
  laneWaits?: TimelineLaneWaitSpec[];
  operatorSwitches?: TimelineOperatorSwitchSpec[];
  /** Required for every group after the first. It is the explicit group seal. */
  separatorBefore?: WaitColumnSpec;
};

export type SharedVariableRateTimelineSpec = {
  tickRate: number;
  initialFrame?: number;
  columnWidth?: number;
  /** Width multiplier for positive segments where only existing actions continue. */
  continuationWidthRatio?: number;
  /** Optional fixed visual page width used to keep full operation columns intact. */
  visualPageWidth?: number;
  /** Optional full control column before the first release group. */
  initialWait?: SealOnlyWaitColumnSpec | FixedWaitColumnSpec;
  groups: TimelineReleaseGroupSpec[];
};

export type ScheduledTimelineAction = {
  id: string;
  groupId: string;
  laneId: string;
  laneActionIndex: number;
  stableSequence: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  sharedAtbCost: number;
  payload?: unknown;
  primaryColumnId: string;
  coveredColumnIds: string[];
  startX: number;
  endX: number;
};

export type ScheduledTimelineLane = {
  laneId: string;
  startFrame: number;
  endFrame: number;
  actionIds: string[];
};

export type ScheduledTimelineLaneWait = {
  id: string;
  groupId: string;
  laneId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  startX: number;
  endX: number;
  coveredColumnIds: string[];
};

export type ScheduledTimelineOperatorSwitch = {
  id: string;
  groupId: string;
  laneId: string;
  targetLaneId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: 0;
  startX: number;
  endX: number;
  coveredColumnIds: string[];
};

export type ActivityTimelineColumn = {
  id: string;
  kind: 'activity';
  groupId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  xStart: number;
  xEnd: number;
  activeActionIds: string[];
  startingActionIds: string[];
  endingActionIds: string[];
};

export type WaitTimelineColumn = {
  id: string;
  kind: 'wait';
  waitId: string;
  mode: WaitColumnSpec['mode'];
  previousGroupId: string;
  nextGroupId: string;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  xStart: number;
  xEnd: number;
  targetAtb: number | null;
  resolutionReason: string;
};

export type SharedTimelineColumn = ActivityTimelineColumn | WaitTimelineColumn;

export type ScheduledReleaseGroup = {
  id: string;
  groupIndex: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  xStart: number;
  xEnd: number;
  laneIds: string[];
  actionIds: string[];
  columnIds: string[];
  lanes: ScheduledTimelineLane[];
};

export type ReleaseCohortDraft = {
  id: string;
  frame: number;
  actionIds: string[];
  groupIds: string[];
  laneIds: string[];
  requiredSharedAtb: number;
};

export type ReleaseCohortDecision = {
  allowed: boolean;
  reason: string;
  availableSharedAtb?: number;
  /**
   * Runtime adapters may know that a cohort cannot yet be proved without
   * knowing that it is illegal.  `allowed` remains the backwards-compatible
   * default; an explicit status lets the canvas preserve that distinction.
   */
  status?: 'valid' | 'invalid' | 'unverified';
};

export type ScheduledReleaseCohort = ReleaseCohortDraft & {
  status: 'valid' | 'invalid' | 'unverified';
  reason: string;
  availableSharedAtb: number | null;
};

export type TimelineAdmissionStatus = ScheduledReleaseCohort['status'];

export type WaitResolutionRequest = {
  wait: AtbTargetWaitColumnSpec | NextGroupReadyWaitColumnSpec;
  boundaryFrame: number;
  previousGroup: ScheduledReleaseGroup;
  nextGroup: TimelineReleaseGroupSpec;
  nextGroupFirstActionIds: string[];
  nextGroupFirstSharedAtbCost: number;
};

export type WaitResolutionResult = {
  durationFrames: number;
  reason: string;
};

export type DynamicWaitResolver = (
  request: WaitResolutionRequest,
) => WaitResolutionResult | null;

export type ReleaseCohortValidatorContext = {
  cohortIndex: number;
  previousCohorts: readonly ScheduledReleaseCohort[];
  actionsById: ReadonlyMap<string, ScheduledTimelineAction>;
};

export type ReleaseCohortValidator = (
  cohort: ReleaseCohortDraft,
  context: ReleaseCohortValidatorContext,
) => ReleaseCohortDecision;

export type SharedVariableRateTimelineBuildOptions = {
  resolveDynamicWait?: DynamicWaitResolver;
  validateReleaseCohort?: ReleaseCohortValidator;
};

export type SharedVariableRateTimelineModel = {
  schemaVersion: 1;
  /** Version 1 intentionally implements the explainable event-sweep policy. */
  columnBoundaryPolicy: 'strong-event-boundaries';
  tickRate: number;
  columnWidth: number;
  continuationWidthRatio: number;
  visualPageWidth?: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  width: number;
  groups: ScheduledReleaseGroup[];
  waits: WaitTimelineColumn[];
  /** Ordinary waits stay inside a group and affect one lane successor only. */
  laneWaits: ScheduledTimelineLaneWait[];
  /** Operator switches occupy a visible group-local cell but advance zero frames. */
  operatorSwitches: ScheduledTimelineOperatorSwitch[];
  columns: SharedTimelineColumn[];
  actions: ScheduledTimelineAction[];
  cohorts: ScheduledReleaseCohort[];
  /** Unknown engine rules are not executable: only `valid` yields true. */
  admissionStatus: TimelineAdmissionStatus;
  isExecutable: boolean;
};

export type TimelineProjectionAffinity = 'before' | 'after' | 'center';

export class SharedVariableRateTimelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SharedVariableRateTimelineError';
    this.code = code;
  }
}

type PreliminaryAction = Omit<
  ScheduledTimelineAction,
  'primaryColumnId' | 'coveredColumnIds' | 'startX' | 'endX'
>;

type PreliminaryGroup = Omit<
  ScheduledReleaseGroup,
  'xStart' | 'xEnd' | 'columnIds'
> & {
  actions: PreliminaryAction[];
  laneWaits: Array<Omit<ScheduledTimelineLaneWait, 'startX' | 'endX' | 'coveredColumnIds'>>;
  operatorSwitches: Array<Omit<ScheduledTimelineOperatorSwitch, 'startX' | 'endX' | 'coveredColumnIds'>>;
  boundaries: number[];
};

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SharedVariableRateTimelineError('INVALID_ID', `${label} must be a non-empty string.`);
  }
  return value;
}

function requireIntegerFrame(
  value: number,
  label: string,
  options: { allowZero: boolean },
): number {
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new SharedVariableRateTimelineError(
      'INVALID_FRAME',
      `${label} must be an integer >= ${minimum}.`,
    );
  }
  return value;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new SharedVariableRateTimelineError(
      'INVALID_NUMBER',
      `${label} must be a finite number >= 0.`,
    );
  }
  return value;
}

function firstActions(group: TimelineReleaseGroupSpec): TimelineActionSpec[] {
  return group.lanes.flatMap((lane) => lane.actions.length > 0 ? [lane.actions[0]] : []);
}

function validateSpec(spec: SharedVariableRateTimelineSpec): void {
  requireIntegerFrame(spec.tickRate, 'tickRate', { allowZero: false });
  requireIntegerFrame(spec.initialFrame ?? 0, 'initialFrame', { allowZero: true });
  const columnWidth = spec.columnWidth ?? 1;
  if (!Number.isFinite(columnWidth) || columnWidth <= 0) {
    throw new SharedVariableRateTimelineError(
      'INVALID_COLUMN_WIDTH',
      'columnWidth must be a finite number > 0.',
    );
  }
  const continuationWidthRatio = spec.continuationWidthRatio ?? 1;
  if (!Number.isFinite(continuationWidthRatio)
    || continuationWidthRatio <= 0
    || continuationWidthRatio > 1) {
    throw new SharedVariableRateTimelineError(
      'INVALID_CONTINUATION_WIDTH_RATIO',
      'continuationWidthRatio must be a finite number > 0 and <= 1.',
    );
  }
  if (spec.visualPageWidth !== undefined
    && (!Number.isFinite(spec.visualPageWidth) || spec.visualPageWidth < columnWidth)) {
    throw new SharedVariableRateTimelineError(
      'INVALID_VISUAL_PAGE_WIDTH',
      'visualPageWidth must be a finite number >= columnWidth.',
    );
  }
  if (!Array.isArray(spec.groups) || spec.groups.length === 0) {
    throw new SharedVariableRateTimelineError('EMPTY_TIMELINE', 'At least one release group is required.');
  }

  const groupIds = new Set<string>();
  const waitIds = new Set<string>();
  const actionIds = new Set<string>();
  const switchIds = new Set<string>();

  if (spec.initialWait) {
    requireId(spec.initialWait.id, 'initialWait.id');
    waitIds.add(spec.initialWait.id);
    if (spec.initialWait.mode === 'fixed-duration') {
      requireIntegerFrame(
        spec.initialWait.durationFrames,
        `wait ${spec.initialWait.id} durationFrames`,
        { allowZero: true },
      );
    }
  }

  spec.groups.forEach((group, groupIndex) => {
    requireId(group.id, `groups[${groupIndex}].id`);
    if (groupIds.has(group.id)) {
      throw new SharedVariableRateTimelineError('DUPLICATE_GROUP_ID', `Duplicate group id: ${group.id}.`);
    }
    groupIds.add(group.id);

    if (groupIndex === 0 && group.separatorBefore) {
      throw new SharedVariableRateTimelineError(
        'FIRST_GROUP_HAS_SEPARATOR',
        'The first group cannot have separatorBefore.',
      );
    }
    if (groupIndex > 0 && !group.separatorBefore) {
      throw new SharedVariableRateTimelineError(
        'MISSING_WAIT_COLUMN',
        `Group ${group.id} must have a full wait column before it.`,
      );
    }
    if (group.separatorBefore) {
      const wait = group.separatorBefore;
      requireId(wait.id, `groups[${groupIndex}].separatorBefore.id`);
      if (waitIds.has(wait.id) || switchIds.has(wait.id)) {
        throw new SharedVariableRateTimelineError('DUPLICATE_WAIT_ID', `Duplicate wait id: ${wait.id}.`);
      }
      waitIds.add(wait.id);
      if (wait.mode === 'fixed-duration') {
        requireIntegerFrame(wait.durationFrames, `wait ${wait.id} durationFrames`, { allowZero: true });
      } else if (wait.mode === 'atb-target') {
        requireFiniteNonNegative(wait.targetAtb, `wait ${wait.id} targetAtb`);
        if (wait.resolvedDurationFrames !== undefined) {
          requireIntegerFrame(
            wait.resolvedDurationFrames,
            `wait ${wait.id} resolvedDurationFrames`,
            { allowZero: true },
          );
        }
      } else if (wait.mode === 'next-group-ready' && wait.resolvedDurationFrames !== undefined) {
        requireIntegerFrame(
          wait.resolvedDurationFrames,
          `wait ${wait.id} resolvedDurationFrames`,
          { allowZero: true },
        );
      }
    }

    const laneIds = new Set<string>();
    let actionCount = 0;
    group.lanes.forEach((lane, laneIndex) => {
      requireId(lane.laneId, `group ${group.id} lanes[${laneIndex}].laneId`);
      if (laneIds.has(lane.laneId)) {
        throw new SharedVariableRateTimelineError(
          'DUPLICATE_LANE_ID',
          `Duplicate lane ${lane.laneId} in group ${group.id}.`,
        );
      }
      laneIds.add(lane.laneId);
      lane.actions.forEach((action, actionIndex) => {
        actionCount += 1;
        requireId(action.id, `group ${group.id} lane ${lane.laneId} actions[${actionIndex}].id`);
        if (actionIds.has(action.id) || switchIds.has(action.id)) {
          throw new SharedVariableRateTimelineError(
            'DUPLICATE_ACTION_ID',
            `Duplicate action id: ${action.id}.`,
          );
        }
        actionIds.add(action.id);
        requireIntegerFrame(
          action.durationFrames,
          `action ${action.id} durationFrames`,
          { allowZero: action.instantaneous === true },
        );
        if (action.startOffsetFrames !== undefined) {
          requireIntegerFrame(
            action.startOffsetFrames,
            `action ${action.id} startOffsetFrames`,
            { allowZero: true },
          );
        }
        requireFiniteNonNegative(action.sharedAtbCost ?? 0, `action ${action.id} sharedAtbCost`);
      });
    });
    if (actionCount === 0) {
      throw new SharedVariableRateTimelineError(
        'EMPTY_GROUP',
        `Release group ${group.id} must contain at least one action.`,
      );
    }
    (group.laneWaits ?? []).forEach((wait, waitIndex) => {
      requireId(wait.id, `group ${group.id} laneWaits[${waitIndex}].id`);
      if (actionIds.has(wait.id) || waitIds.has(wait.id) || switchIds.has(wait.id)) {
        throw new SharedVariableRateTimelineError('DUPLICATE_WAIT_ID', `Duplicate lane wait id: ${wait.id}.`);
      }
      waitIds.add(wait.id);
      requireId(wait.laneId, `lane wait ${wait.id} laneId`);
      requireIntegerFrame(wait.startOffsetFrames, `lane wait ${wait.id} startOffsetFrames`, { allowZero: true });
      requireIntegerFrame(wait.durationFrames, `lane wait ${wait.id} durationFrames`, { allowZero: true });
    });
    (group.operatorSwitches ?? []).forEach((operatorSwitch, switchIndex) => {
      requireId(operatorSwitch.id, `group ${group.id} operatorSwitches[${switchIndex}].id`);
      if (
        actionIds.has(operatorSwitch.id)
        || waitIds.has(operatorSwitch.id)
        || switchIds.has(operatorSwitch.id)
      ) {
        throw new SharedVariableRateTimelineError(
          'DUPLICATE_OPERATOR_SWITCH_ID',
          `Duplicate operator switch id: ${operatorSwitch.id}.`,
        );
      }
      switchIds.add(operatorSwitch.id);
      requireId(operatorSwitch.laneId, `operator switch ${operatorSwitch.id} laneId`);
      requireId(operatorSwitch.targetLaneId, `operator switch ${operatorSwitch.id} targetLaneId`);
      if (operatorSwitch.laneId === operatorSwitch.targetLaneId) {
        throw new SharedVariableRateTimelineError(
          'OPERATOR_SWITCH_TO_SELF',
          `Operator switch ${operatorSwitch.id} must target another lane.`,
        );
      }
      requireIntegerFrame(
        operatorSwitch.startOffsetFrames,
        `operator switch ${operatorSwitch.id} startOffsetFrames`,
        { allowZero: true },
      );
    });
  });
}

function scheduleGroup(
  group: TimelineReleaseGroupSpec,
  groupIndex: number,
  startFrame: number,
  initialStableSequence: number,
): PreliminaryGroup {
  let stableSequence = initialStableSequence;
  const actions: PreliminaryAction[] = [];
  const laneWaits = (group.laneWaits ?? []).map(wait => ({
    id: wait.id,
    groupId: group.id,
    laneId: wait.laneId,
    startFrame: startFrame + wait.startOffsetFrames,
    endFrame: startFrame + wait.startOffsetFrames + wait.durationFrames,
    durationFrames: wait.durationFrames,
  }));
  const operatorSwitches = (group.operatorSwitches ?? []).map(operatorSwitch => ({
    id: operatorSwitch.id,
    groupId: group.id,
    laneId: operatorSwitch.laneId,
    targetLaneId: operatorSwitch.targetLaneId,
    startFrame: startFrame + operatorSwitch.startOffsetFrames,
    endFrame: startFrame + operatorSwitch.startOffsetFrames,
    durationFrames: 0 as const,
  }));
  const lanes: ScheduledTimelineLane[] = [];
  const boundaries = new Set<number>([startFrame]);
  laneWaits.forEach((wait) => {
    boundaries.add(wait.startFrame);
    boundaries.add(wait.endFrame);
  });
  operatorSwitches.forEach((operatorSwitch) => {
    boundaries.add(operatorSwitch.startFrame);
  });

  for (const lane of group.lanes) {
    let laneFrame = startFrame;
    let laneStartFrame = startFrame;
    const laneActionIds: string[] = [];
    lane.actions.forEach((action, laneActionIndex) => {
      const actionStart = action.startOffsetFrames === undefined
        ? laneFrame
        : startFrame + action.startOffsetFrames;
      const actionEnd = actionStart + action.durationFrames;
      const scheduled: PreliminaryAction = {
        id: action.id,
        groupId: group.id,
        laneId: lane.laneId,
        laneActionIndex,
        stableSequence: stableSequence++,
        startFrame: actionStart,
        endFrame: actionEnd,
        durationFrames: action.durationFrames,
        sharedAtbCost: action.sharedAtbCost ?? 0,
        payload: action.payload,
      };
      actions.push(scheduled);
      laneActionIds.push(action.id);
      boundaries.add(actionStart);
      boundaries.add(actionEnd);
      laneStartFrame = laneActionIndex === 0
        ? actionStart
        : Math.min(laneStartFrame, actionStart);
      laneFrame = Math.max(laneFrame, actionEnd);
    });
    lanes.push({
      laneId: lane.laneId,
      startFrame: laneStartFrame,
      endFrame: laneFrame,
      actionIds: laneActionIds,
    });
  }

  const endFrame = Math.max(
    startFrame,
    ...lanes.map((lane) => lane.endFrame),
    ...laneWaits.map(wait => wait.endFrame),
    ...operatorSwitches.map(operatorSwitch => operatorSwitch.startFrame),
  );
  boundaries.add(endFrame);
  return {
    id: group.id,
    groupIndex,
    startFrame,
    endFrame,
    durationFrames: endFrame - startFrame,
    laneIds: group.lanes.map((lane) => lane.laneId),
    actionIds: actions.map((action) => action.id),
    lanes,
    actions,
    laneWaits,
    operatorSwitches,
    boundaries: [...boundaries].sort((left, right) => left - right),
  };
}

function dynamicWaitResolution(
  wait: AtbTargetWaitColumnSpec | NextGroupReadyWaitColumnSpec,
  context: Omit<WaitResolutionRequest, 'wait'>,
  resolver: DynamicWaitResolver | undefined,
): WaitResolutionResult {
  if (wait.resolvedDurationFrames !== undefined) {
    return {
      durationFrames: wait.resolvedDurationFrames,
      reason: 'CACHED_RUNTIME_RESOLUTION',
    };
  }
  if (!resolver) {
    throw new SharedVariableRateTimelineError(
      'UNRESOLVED_DYNAMIC_WAIT',
      `Wait ${wait.id} (${wait.mode}) requires a runtime resolver.`,
    );
  }
  const result = resolver({ ...context, wait });
  if (!result) {
    throw new SharedVariableRateTimelineError(
      'DYNAMIC_WAIT_UNREACHABLE',
      `Wait ${wait.id} cannot reach its requested state.`,
    );
  }
  requireIntegerFrame(result.durationFrames, `wait ${wait.id} resolved duration`, { allowZero: true });
  return result;
}

function resolveWait(
  wait: WaitColumnSpec,
  previousGroup: ScheduledReleaseGroup,
  nextGroup: TimelineReleaseGroupSpec,
  resolver: DynamicWaitResolver | undefined,
): WaitResolutionResult {
  if (wait.mode === 'seal-only') {
    return { durationFrames: 0, reason: 'SEAL_ONLY' };
  }
  if (wait.mode === 'fixed-duration') {
    return { durationFrames: wait.durationFrames, reason: 'FIXED_DURATION' };
  }
  const nextFirst = firstActions(nextGroup);
  return dynamicWaitResolution(wait, {
    boundaryFrame: previousGroup.endFrame,
    previousGroup,
    nextGroup,
    nextGroupFirstActionIds: nextFirst.map((action) => action.id),
    nextGroupFirstSharedAtbCost: nextFirst.reduce(
      (total, action) => total + (action.sharedAtbCost ?? 0),
      0,
    ),
  }, resolver);
}

function makeActivityColumns(
  preliminary: PreliminaryGroup,
  xStart: number,
  columnWidth: number,
  continuationWidthRatio: number,
): ActivityTimelineColumn[] {
  const columns: ActivityTimelineColumn[] = [];
  let currentX = xStart;
  const zeroControlFrames = new Set([
    ...preliminary.actions.filter(action => action.durationFrames === 0).map(action => action.startFrame),
    ...preliminary.laneWaits
      .filter(wait => wait.durationFrames === 0)
      .map(wait => wait.startFrame),
    ...preliminary.operatorSwitches.map(operatorSwitch => operatorSwitch.startFrame),
  ]);
  const operationControlFrames = new Set(zeroControlFrames);
  const appendColumn = (
    column: Omit<ActivityTimelineColumn, 'xStart' | 'xEnd'>,
    width: number,
  ) => {
    const columnXStart = currentX;
    const columnXEnd = columnXStart + width;
    columns.push({
      ...column,
      xStart: columnXStart,
      xEnd: columnXEnd,
    });
    currentX = columnXEnd;
  };
  const pushZeroControlColumn = (frame: number) => {
    if (!zeroControlFrames.delete(frame)) return;
    const active = preliminary.actions.filter(action => (
      action.startFrame <= frame && action.endFrame >= frame
    ));
    appendColumn({
      id: `group:${preliminary.id}:control-zero:${frame}`,
      kind: 'activity',
      groupId: preliminary.id,
      startFrame: frame,
      endFrame: frame,
      durationFrames: 0,
      activeActionIds: active
        .sort((left, right) => left.stableSequence - right.stableSequence)
        .map(action => action.id),
      startingActionIds: [],
      endingActionIds: [],
    }, columnWidth);
  };
  for (let index = 0; index < preliminary.boundaries.length - 1; index += 1) {
    const startFrame = preliminary.boundaries[index];
    const endFrame = preliminary.boundaries[index + 1];
    pushZeroControlColumn(startFrame);
    if (endFrame <= startFrame) continue;
    const active = preliminary.actions.filter((action) => (
      action.startFrame < endFrame && action.endFrame > startFrame
    ));
    const startingActionIds = preliminary.actions
      .filter((action) => action.startFrame === startFrame)
      .sort((left, right) => left.stableSequence - right.stableSequence)
      .map((action) => action.id);
    const hasLaneWait = preliminary.laneWaits.some((wait) => (
      wait.startFrame === startFrame
      || (wait.startFrame < endFrame && wait.endFrame > startFrame)
    ));
    const hasOperatorControl = [...operationControlFrames].some((frame) => (
      frame >= startFrame && frame < endFrame
    ));
    const width = startingActionIds.length > 0 || hasLaneWait || hasOperatorControl
      ? columnWidth
      : columnWidth * continuationWidthRatio;
    appendColumn({
      id: `group:${preliminary.id}:column:${columns.length}`,
      kind: 'activity',
      groupId: preliminary.id,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
      activeActionIds: active
        .sort((left, right) => left.stableSequence - right.stableSequence)
        .map((action) => action.id),
      startingActionIds,
      endingActionIds: preliminary.actions
        .filter((action) => action.endFrame === endFrame)
        .sort((left, right) => left.stableSequence - right.stableSequence)
        .map((action) => action.id),
    }, width);
  }
  preliminary.boundaries.forEach(pushZeroControlColumn);
  return columns;
}

function materializeActions(
  preliminary: PreliminaryGroup,
  columns: ActivityTimelineColumn[],
): ScheduledTimelineAction[] {
  return preliminary.actions.map((action) => {
    const releaseAnchor = (action.payload as { releaseAnchor?: { sourceButtonId?: string } } | undefined)
      ?.releaseAnchor;
    const startsAfterZeroControl = [
      ...preliminary.laneWaits.filter(wait => wait.durationFrames === 0),
      ...preliminary.operatorSwitches,
    ].some(control => (
      control.endFrame === action.startFrame
      && control.id === releaseAnchor?.sourceButtonId
    ));
    const covered = columns.filter((column) => (
      column.durationFrames > 0
        ? column.startFrame < action.endFrame && column.endFrame > action.startFrame
        : (column.startFrame > action.startFrame && column.startFrame < action.endFrame)
          || (column.startFrame === action.startFrame && !startsAfterZeroControl)
    ));
    const primary = covered[0];
    const ending = covered[covered.length - 1];
    if (!primary || !ending || covered.length === 0) {
      throw new SharedVariableRateTimelineError(
        'ACTION_PROJECTION_FAILED',
        `Could not project action ${action.id} into group ${preliminary.id}.`,
      );
    }
    return {
      ...action,
      primaryColumnId: primary.id,
      coveredColumnIds: covered.map((column) => column.id),
      startX: primary.xStart,
      endX: ending.xEnd,
    };
  });
}

function materializeLaneWaits(
  preliminary: PreliminaryGroup,
  columns: ActivityTimelineColumn[],
): ScheduledTimelineLaneWait[] {
  return preliminary.laneWaits.map((wait) => {
    const covered = wait.durationFrames === 0
      ? columns.filter(column => (
        column.durationFrames === 0 && column.startFrame === wait.startFrame
      ))
      : columns.filter(column => (
        column.durationFrames > 0
        && column.startFrame < wait.endFrame
        && column.endFrame > wait.startFrame
      ));
    const first = covered[0];
    const last = covered[covered.length - 1];
    if (!first || !last) {
      throw new SharedVariableRateTimelineError(
        'LANE_WAIT_PROJECTION_FAILED',
        `Could not project ordinary wait ${wait.id} into group ${preliminary.id}.`,
      );
    }
    return {
      ...wait,
      startX: first.xStart,
      endX: last.xEnd,
      coveredColumnIds: covered.map(column => column.id),
    };
  });
}

function materializeOperatorSwitches(
  preliminary: PreliminaryGroup,
  columns: ActivityTimelineColumn[],
): ScheduledTimelineOperatorSwitch[] {
  return preliminary.operatorSwitches.map((operatorSwitch) => {
    const column = columns.find(candidate => (
      candidate.durationFrames === 0
      && candidate.startFrame === operatorSwitch.startFrame
    ));
    if (!column) {
      throw new SharedVariableRateTimelineError(
        'OPERATOR_SWITCH_PROJECTION_FAILED',
        `Could not project operator switch ${operatorSwitch.id} into group ${preliminary.id}.`,
      );
    }
    return {
      ...operatorSwitch,
      startX: column.xStart,
      endX: column.xEnd,
      coveredColumnIds: [column.id],
    };
  });
}

/**
 * Keep a complete operation column from straddling a visual page boundary.
 *
 * The page break is a display concern only. When a full column would start in
 * the final partial page slot, its preceding column absorbs the gap and every
 * later boundary moves by the same amount. Frame data and column identity are
 * therefore untouched, while the frame projector continues to use the same
 * per-column interpolation after the adjustment.
 */
function applyVisualPageBreaks(
  model: SharedVariableRateTimelineModel,
): SharedVariableRateTimelineModel {
  const pageWidth = model.visualPageWidth;
  if (pageWidth === undefined || model.columns.length === 0) return model;

  const epsilon = 1e-9;
  let shift = 0;
  const shiftedColumns = model.columns.map((column) => {
    const originalStart = column.xStart;
    const width = column.xEnd - column.xStart;
    let columnShift = shift;
    if (width + epsilon >= model.columnWidth) {
      const shiftedStart = originalStart + shift;
      const pageIndex = Math.floor((shiftedStart + epsilon) / pageWidth);
      const pageStart = pageIndex * pageWidth;
      const offset = shiftedStart - pageStart;
      const atPageStart = offset <= epsilon || pageWidth - offset <= epsilon;
      const remaining = pageWidth - offset;
      if (!atPageStart && remaining + epsilon < model.columnWidth) {
        const gap = Math.max(0, remaining);
        shift += gap;
        columnShift = shift;
      }
    }
    const shifted = {
      ...column,
      xStart: originalStart + columnShift,
      xEnd: column.xEnd + columnShift,
    };
    return shifted;
  });

  // A shift is discovered while visiting the column that starts the next page.
  // Extend the previous column's end by that same amount, preserving the
  // contiguous x boundary and giving the gap to the segment before the break.
  for (let index = 1; index < shiftedColumns.length; index += 1) {
    const previous = shiftedColumns[index - 1];
    const current = shiftedColumns[index];
    if (current.xStart > previous.xEnd + epsilon) {
      previous.xEnd = current.xStart;
    }
  }

  const boundaryMap = new Map<number, number>();
  model.columns.forEach((column, index) => {
    boundaryMap.set(column.xStart, shiftedColumns[index].xStart);
    boundaryMap.set(column.xEnd, shiftedColumns[index].xEnd);
  });
  const mapBoundary = (value: number): number => boundaryMap.get(value) ?? value;
  const groups = model.groups.map(group => ({
    ...group,
    xStart: mapBoundary(group.xStart),
    xEnd: mapBoundary(group.xEnd),
  }));
  const waits = model.waits.map(wait => ({
    ...wait,
    xStart: mapBoundary(wait.xStart),
    xEnd: mapBoundary(wait.xEnd),
  }));
  const actions = model.actions.map(action => ({
    ...action,
    startX: mapBoundary(action.startX),
    endX: mapBoundary(action.endX),
  }));
  const laneWaits = model.laneWaits.map(wait => ({
    ...wait,
    startX: mapBoundary(wait.startX),
    endX: mapBoundary(wait.endX),
  }));
  const operatorSwitches = model.operatorSwitches.map(operatorSwitch => ({
    ...operatorSwitch,
    startX: mapBoundary(operatorSwitch.startX),
    endX: mapBoundary(operatorSwitch.endX),
  }));

  return {
    ...model,
    groups,
    waits,
    columns: shiftedColumns,
    actions,
    laneWaits,
    operatorSwitches,
    width: shiftedColumns[shiftedColumns.length - 1].xEnd,
  };
}

function buildCohorts(
  actions: ScheduledTimelineAction[],
  validator: ReleaseCohortValidator | undefined,
): ScheduledReleaseCohort[] {
  const actionGroups = new Map<number, ScheduledTimelineAction[]>();
  actions.forEach((action) => {
    const entries = actionGroups.get(action.startFrame) ?? [];
    entries.push(action);
    actionGroups.set(action.startFrame, entries);
  });

  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const resolved: ScheduledReleaseCohort[] = [];
  [...actionGroups.entries()]
    .sort(([leftFrame], [rightFrame]) => leftFrame - rightFrame)
    .forEach(([frame, cohortActions], cohortIndex) => {
      const ordered = [...cohortActions].sort(
        (left, right) => left.stableSequence - right.stableSequence,
      );
      const draft: ReleaseCohortDraft = {
        id: `cohort:${frame}:${cohortIndex}`,
        frame,
        actionIds: ordered.map((action) => action.id),
        groupIds: [...new Set(ordered.map((action) => action.groupId))],
        laneIds: [...new Set(ordered.map((action) => action.laneId))],
        requiredSharedAtb: ordered.reduce((total, action) => total + action.sharedAtbCost, 0),
      };
      if (!validator) {
        resolved.push({
          ...draft,
          status: 'unverified',
          reason: 'NO_ADMISSION_VALIDATOR',
          availableSharedAtb: null,
        });
        return;
      }
      const decision = validator(draft, {
        cohortIndex,
        previousCohorts: resolved,
        actionsById,
      });
      const status = decision.status
        ?? (decision.allowed ? 'valid' : 'invalid');
      resolved.push({
        ...draft,
        status,
        reason: decision.reason,
        availableSharedAtb: decision.availableSharedAtb ?? null,
      });
    });
  return resolved;
}

function summarizeAdmissionStatus(
  cohorts: readonly ScheduledReleaseCohort[],
): TimelineAdmissionStatus {
  if (cohorts.some((cohort) => cohort.status === 'invalid')) return 'invalid';
  if (cohorts.some((cohort) => cohort.status === 'unverified')) return 'unverified';
  return 'valid';
}

export function buildSharedVariableRateTimeline(
  spec: SharedVariableRateTimelineSpec,
  options: SharedVariableRateTimelineBuildOptions = {},
): SharedVariableRateTimelineModel {
  validateSpec(spec);
  const columnWidth = spec.columnWidth ?? 1;
  const startFrame = spec.initialFrame ?? 0;
  const groups: ScheduledReleaseGroup[] = [];
  const waits: WaitTimelineColumn[] = [];
  const laneWaits: ScheduledTimelineLaneWait[] = [];
  const operatorSwitches: ScheduledTimelineOperatorSwitch[] = [];
  const columns: SharedTimelineColumn[] = [];
  const actions: ScheduledTimelineAction[] = [];
  let currentFrame = startFrame;
  let currentX = 0;
  let stableSequence = 0;

  if (spec.initialWait) {
    const waitSpec = spec.initialWait;
    const durationFrames = waitSpec.mode === 'fixed-duration'
      ? waitSpec.durationFrames
      : 0;
    const waitColumn: WaitTimelineColumn = {
      id: `wait:${waitSpec.id}`,
      kind: 'wait',
      waitId: waitSpec.id,
      mode: waitSpec.mode,
      previousGroupId: 'timeline-origin',
      nextGroupId: spec.groups[0].id,
      startFrame,
      endFrame: startFrame + durationFrames,
      durationFrames,
      xStart: 0,
      xEnd: columnWidth,
      targetAtb: null,
      resolutionReason: waitSpec.mode === 'fixed-duration'
        ? 'FIXED_DURATION'
        : 'SEAL_ONLY',
    };
    waits.push(waitColumn);
    columns.push(waitColumn);
    currentFrame = waitColumn.endFrame;
    currentX = columnWidth;
  }

  spec.groups.forEach((groupSpec, groupIndex) => {
    if (groupIndex > 0) {
      const previousGroup = groups[groupIndex - 1];
      const waitSpec = groupSpec.separatorBefore;
      if (!previousGroup || !waitSpec) {
        throw new SharedVariableRateTimelineError(
          'MISSING_WAIT_COLUMN',
          `Group ${groupSpec.id} has no resolved preceding wait column.`,
        );
      }
      const resolution = resolveWait(
        waitSpec,
        previousGroup,
        groupSpec,
        options.resolveDynamicWait,
      );
      const waitStart = previousGroup.endFrame;
      const waitEnd = waitStart + resolution.durationFrames;
      const waitColumn: WaitTimelineColumn = {
        id: `wait:${waitSpec.id}`,
        kind: 'wait',
        waitId: waitSpec.id,
        mode: waitSpec.mode,
        previousGroupId: previousGroup.id,
        nextGroupId: groupSpec.id,
        startFrame: waitStart,
        endFrame: waitEnd,
        durationFrames: resolution.durationFrames,
        xStart: currentX,
        xEnd: currentX + columnWidth,
        targetAtb: waitSpec.mode === 'atb-target' ? waitSpec.targetAtb : null,
        resolutionReason: resolution.reason,
      };
      waits.push(waitColumn);
      columns.push(waitColumn);
      currentFrame = waitEnd;
      currentX += columnWidth;
    }

    const preliminary = scheduleGroup(groupSpec, groupIndex, currentFrame, stableSequence);
    stableSequence += preliminary.actions.length;
    const activityColumns = makeActivityColumns(
      preliminary,
      currentX,
      columnWidth,
      spec.continuationWidthRatio ?? 1,
    );
    const materializedActions = materializeActions(preliminary, activityColumns);
    const materializedLaneWaits = materializeLaneWaits(preliminary, activityColumns);
    const materializedOperatorSwitches = materializeOperatorSwitches(preliminary, activityColumns);
    const scheduledGroup: ScheduledReleaseGroup = {
      id: preliminary.id,
      groupIndex: preliminary.groupIndex,
      startFrame: preliminary.startFrame,
      endFrame: preliminary.endFrame,
      durationFrames: preliminary.durationFrames,
      xStart: currentX,
      xEnd: activityColumns[activityColumns.length - 1]?.xEnd ?? currentX,
      laneIds: preliminary.laneIds,
      actionIds: preliminary.actionIds,
      columnIds: activityColumns.map((column) => column.id),
      lanes: preliminary.lanes,
    };
    groups.push(scheduledGroup);
    columns.push(...activityColumns);
    actions.push(...materializedActions);
    laneWaits.push(...materializedLaneWaits);
    operatorSwitches.push(...materializedOperatorSwitches);
    currentFrame = scheduledGroup.endFrame;
    currentX = scheduledGroup.xEnd;
  });

  const cohorts = buildCohorts(actions, options.validateReleaseCohort);
  const admissionStatus = summarizeAdmissionStatus(cohorts);
  const model: SharedVariableRateTimelineModel = {
    schemaVersion: 1,
    columnBoundaryPolicy: 'strong-event-boundaries',
    tickRate: spec.tickRate,
    columnWidth,
    continuationWidthRatio: spec.continuationWidthRatio ?? 1,
    ...(spec.visualPageWidth !== undefined ? { visualPageWidth: spec.visualPageWidth } : {}),
    startFrame,
    endFrame: currentFrame,
    durationFrames: currentFrame - startFrame,
    width: currentX,
    groups,
    waits,
    laneWaits,
    operatorSwitches,
    columns,
    actions,
    cohorts,
    admissionStatus,
    isExecutable: admissionStatus === 'valid',
  };
  return applyVisualPageBreaks(model);
}

/**
 * Projects a real frame onto the derived visual x axis.
 *
 * A zero-duration wait column deliberately gives one frame more than one x.
 * `before` selects the left edge, `after` the right edge, and `center` the
 * middle of the visual seal.
 */
export function projectSharedTimelineFrame(
  model: SharedVariableRateTimelineModel,
  frame: number,
  affinity: TimelineProjectionAffinity = 'after',
): number | null {
  if (!Number.isFinite(frame)) return null;
  const zeroColumns = model.columns.filter((column) => (
    column.durationFrames === 0 && column.startFrame === frame
  ));
  if (zeroColumns.length > 0) {
    const left = Math.min(...zeroColumns.map((column) => column.xStart));
    const right = Math.max(...zeroColumns.map((column) => column.xEnd));
    if (affinity === 'before') return left;
    if (affinity === 'center') return (left + right) / 2;
    return right;
  }

  const containing = model.columns.find((column) => (
    column.durationFrames > 0
    && frame >= column.startFrame
    && frame <= column.endFrame
  ));
  if (!containing) return null;
  const ratio = (frame - containing.startFrame) / containing.durationFrames;
  return containing.xStart + ratio * (containing.xEnd - containing.xStart);
}

export type EarliestFrameSearchInput = {
  fromFrame: number;
  throughFrame: number;
  isSatisfied: (frame: number) => boolean;
};

/** Searches an authoritative runtime predicate without approximating recovery math. */
export function findEarliestSatisfyingFrame(input: EarliestFrameSearchInput): number | null {
  requireIntegerFrame(input.fromFrame, 'fromFrame', { allowZero: true });
  requireIntegerFrame(input.throughFrame, 'throughFrame', { allowZero: true });
  if (input.throughFrame < input.fromFrame) {
    throw new SharedVariableRateTimelineError(
      'INVALID_SEARCH_RANGE',
      'throughFrame must be >= fromFrame.',
    );
  }
  for (let frame = input.fromFrame; frame <= input.throughFrame; frame += 1) {
    if (input.isSatisfied(frame)) return frame;
  }
  return null;
}
