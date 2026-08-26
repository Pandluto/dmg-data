/**
 * Pure scheduling model for action settlement, cancellable recovery and the
 * normal-attack combo cursor.
 *
 * The model intentionally separates four clocks that legacy timeline code
 * often collapsed into one duration:
 *
 * 1. commit offset: the event must happen before cancelling the action;
 * 2. effect offset: an already committed projectile/effect may land later;
 * 3. blocking end: the next action may start here;
 * 4. natural end: the un-cancelled animation/body would finish here.
 */

export type CombatActionKind =
  | 'basic-attack'
  | 'normal-skill'
  | 'combo-skill'
  | 'ultimate-skill'
  | 'dodge'
  | 'perfect-dodge'
  | 'basic-combo-reset'
  | 'other';

export type ActionCommitEventKind =
  | 'hit'
  | 'projectile-launch'
  | 'resource'
  | 'state-change';

export type ActionCommitEvent = {
  id: string;
  kind: ActionCommitEventKind;
  /** The action cannot be cancelled before this causal event has happened. */
  commitOffsetFrames: number;
  /** The visible/effect result may happen after the action has been cancelled. */
  effectOffsetFrames?: number;
  mandatory?: boolean;
  /** One-based stage number inside the rendered basic-attack segment. */
  basicStageOrdinal?: number;
};

export type ActionSuccessorWindow = {
  startOffsetFrames: number;
  endOffsetFrames: number;
  allowedActionIds?: string[];
  allowedKinds?: CombatActionKind[];
};

export type BasicAttackComboContract = {
  comboId: string;
  stageCount: number;
  /** Zero-based stage that the rendered attack segment starts from. */
  startingStageIndex: number;
  /** Number of stages currently rendered on the slider. */
  renderedStageCount: number;
};

export type ActionTailTimingContract = {
  actionId: string;
  skillId?: string;
  kind: CombatActionKind;
  /** Relative frame at which an un-cancelled blocking body ends. */
  naturalEndOffsetFrames: number;
  /** Last known effect frame; unlike natural end, this is not animation recovery. */
  effectEndOffsetFrames?: number;
  /** After this offset a normal-priority successor may replace the action. */
  exclusiveEndOffsetFrames: number;
  priority: number | null;
  interruptibleAtOffsetFrames: number[];
  successorWindows: ActionSuccessorWindow[];
  commitEvents: ActionCommitEvent[];
  /** False means the natural body is authoritative and must not be shortened. */
  tailCancelable: boolean;
  /** Unknown commit semantics must never be treated as safe auto-compression. */
  commitEvidence: 'verified' | 'unverified';
  basicCombo?: BasicAttackComboContract;
};

export type TailSuccessorIntent = {
  actionId: string;
  skillId?: string;
  kind: CombatActionKind;
  priority: number | null;
  /** Used by dodge-like modules whose interruption gate is resolved externally. */
  forceInterruptsKinds?: CombatActionKind[];
};

export type BasicComboCursor = {
  comboId: string;
  stageCount: number;
  nextStageIndex: number;
};

export type TailTransitionStatus =
  | 'compressed'
  | 'natural'
  | 'selection-required'
  | 'unverified';

export type TailTransitionReason =
  | 'BASIC_STAGE_BOUNDARY'
  | 'HIGHER_PRIORITY'
  | 'FORCED_KIND_INTERRUPT'
  | 'ALLOWED_SUCCESSOR_WINDOW'
  | 'INTERRUPTIBLE_MARK'
  | 'EXCLUSIVE_END'
  | 'GROUP_SEAL_WINDOW'
  | 'GROUP_SEAL_INTERRUPTIBLE_MARK'
  | 'GROUP_SEAL_EXCLUSIVE_END'
  | 'NATURAL_END'
  | 'BASIC_STAGE_SELECTION_REQUIRED'
  | 'COMMIT_EVIDENCE_UNVERIFIED'
  | 'TAIL_NOT_CANCELABLE';

export type TailTransitionResolution = {
  status: TailTransitionStatus;
  reason: TailTransitionReason;
  blockingEndOffsetFrames: number;
  naturalEndOffsetFrames: number;
  effectEndOffsetFrames: number;
  debounceFrames: number;
  commitFloorOffsetFrames: number;
  compressedFrames: number;
  selectedBasicStageCount: number | null;
  settledEventIds: string[];
  prunedEventIds: string[];
  comboCursorAfter: BasicComboCursor | null;
};

export type ResolveTailTransitionInput = {
  predecessor: ActionTailTimingContract;
  successor: TailSuccessorIntent | null;
  boundary: 'append' | 'group-seal';
  debounceFrames: number;
  /** Required when appending after a multi-stage basic attack. */
  selectedBasicStageCount?: number;
};

export type BasicAttackCutOption = {
  stageCount: number;
  transition: TailTransitionResolution;
};

export type LockedTailTransitionBundle = {
  id: string;
  predecessorActionId: string;
  successorActionId: string;
  selectedBasicStageCount: number | null;
  blockingEndOffsetFrames: number;
  immutable: true;
  editPolicy: 'delete-successor-to-recompute';
};

export type DodgeModuleSpec = {
  id: string;
  kind: 'dodge' | 'perfect-dodge';
  durationFrames: number;
  /** Perfect-dodge gain stays unresolved until the runtime confirms the trigger. */
  sharedAtbGain: number | null;
  resourceVerdict: 'runtime-required' | 'not-applicable';
};

export class CombatActionTailPlannerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CombatActionTailPlannerError';
    this.code = code;
  }
}

type Candidate = {
  offsetFrames: number;
  reason: TailTransitionReason;
  rank: number;
};

function integerAtLeast(value: number, minimum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new CombatActionTailPlannerError(
      'INVALID_FRAME',
      `${label} must be an integer >= ${minimum}.`,
    );
  }
  return value;
}

function nonEmptyId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CombatActionTailPlannerError('INVALID_ID', `${label} must be non-empty.`);
  }
  return value;
}

function validateContract(contract: ActionTailTimingContract): void {
  nonEmptyId(contract.actionId, 'actionId');
  integerAtLeast(contract.naturalEndOffsetFrames, 1, 'naturalEndOffsetFrames');
  integerAtLeast(contract.exclusiveEndOffsetFrames, 0, 'exclusiveEndOffsetFrames');
  if (contract.effectEndOffsetFrames !== undefined) {
    integerAtLeast(contract.effectEndOffsetFrames, 0, 'effectEndOffsetFrames');
  }
  if (contract.priority !== null && !Number.isFinite(contract.priority)) {
    throw new CombatActionTailPlannerError('INVALID_PRIORITY', 'priority must be finite or null.');
  }
  contract.interruptibleAtOffsetFrames.forEach((frame, index) => {
    integerAtLeast(frame, 0, `interruptibleAtOffsetFrames[${index}]`);
  });
  contract.successorWindows.forEach((window, index) => {
    integerAtLeast(window.startOffsetFrames, 0, `successorWindows[${index}].start`);
    integerAtLeast(window.endOffsetFrames, 0, `successorWindows[${index}].end`);
    if (window.endOffsetFrames < window.startOffsetFrames) {
      throw new CombatActionTailPlannerError(
        'INVALID_SUCCESSOR_WINDOW',
        `successorWindows[${index}] ends before it starts.`,
      );
    }
  });
  const eventIds = new Set<string>();
  contract.commitEvents.forEach((event, index) => {
    nonEmptyId(event.id, `commitEvents[${index}].id`);
    if (eventIds.has(event.id)) {
      throw new CombatActionTailPlannerError('DUPLICATE_EVENT_ID', `Duplicate event ${event.id}.`);
    }
    eventIds.add(event.id);
    integerAtLeast(event.commitOffsetFrames, 0, `commitEvents[${index}].commitOffsetFrames`);
    if (event.effectOffsetFrames !== undefined) {
      integerAtLeast(event.effectOffsetFrames, 0, `commitEvents[${index}].effectOffsetFrames`);
      if (event.effectOffsetFrames < event.commitOffsetFrames) {
        throw new CombatActionTailPlannerError(
          'EFFECT_BEFORE_COMMIT',
          `Event ${event.id} has an effect before its commit.`,
        );
      }
    }
    if (event.basicStageOrdinal !== undefined) {
      integerAtLeast(event.basicStageOrdinal, 1, `commitEvents[${index}].basicStageOrdinal`);
    }
  });
  if (contract.kind === 'basic-attack') {
    const combo = contract.basicCombo;
    if (!combo) {
      throw new CombatActionTailPlannerError(
        'MISSING_BASIC_COMBO',
        `Basic attack ${contract.actionId} requires basicCombo metadata.`,
      );
    }
    nonEmptyId(combo.comboId, 'basicCombo.comboId');
    integerAtLeast(combo.stageCount, 1, 'basicCombo.stageCount');
    integerAtLeast(combo.startingStageIndex, 0, 'basicCombo.startingStageIndex');
    integerAtLeast(combo.renderedStageCount, 1, 'basicCombo.renderedStageCount');
    if (combo.startingStageIndex >= combo.stageCount) {
      throw new CombatActionTailPlannerError(
        'INVALID_BASIC_CURSOR',
        'basicCombo.startingStageIndex must be below stageCount.',
      );
    }
    if (combo.renderedStageCount > combo.stageCount) {
      throw new CombatActionTailPlannerError(
        'INVALID_BASIC_STAGE_COUNT',
        'basicCombo.renderedStageCount cannot exceed stageCount.',
      );
    }
    for (const event of contract.commitEvents) {
      if (event.basicStageOrdinal !== undefined
        && event.basicStageOrdinal > combo.renderedStageCount) {
        throw new CombatActionTailPlannerError(
          'INVALID_BASIC_EVENT_STAGE',
          `Event ${event.id} points beyond the rendered basic segment.`,
        );
      }
    }
  }
}

function matchesWindow(window: ActionSuccessorWindow, successor: TailSuccessorIntent): boolean {
  const idMatched = !window.allowedActionIds || window.allowedActionIds.length === 0
    || window.allowedActionIds.includes(successor.skillId ?? successor.actionId);
  const kindMatched = !window.allowedKinds || window.allowedKinds.length === 0
    || window.allowedKinds.includes(successor.kind);
  return idMatched && kindMatched;
}

function basicStageSelection(
  contract: ActionTailTimingContract,
  boundary: ResolveTailTransitionInput['boundary'],
  selected: number | undefined,
): number | null | 'required' {
  if (contract.kind !== 'basic-attack') return null;
  const combo = contract.basicCombo;
  if (!combo) return null;
  if (selected === undefined) {
    return boundary === 'append' ? 'required' : combo.renderedStageCount;
  }
  integerAtLeast(selected, 1, 'selectedBasicStageCount');
  if (selected > combo.renderedStageCount) {
    throw new CombatActionTailPlannerError(
      'INVALID_BASIC_STAGE_SELECTION',
      `selectedBasicStageCount cannot exceed ${combo.renderedStageCount}.`,
    );
  }
  return selected;
}

function selectedEvents(
  contract: ActionTailTimingContract,
  selectedBasicStageCount: number | null,
): { settled: ActionCommitEvent[]; pruned: ActionCommitEvent[] } {
  if (selectedBasicStageCount === null) {
    return { settled: [...contract.commitEvents], pruned: [] };
  }
  const selectedStageEvents = contract.commitEvents.filter(event => (
    event.basicStageOrdinal !== undefined
    && event.basicStageOrdinal <= selectedBasicStageCount
  ));
  const selectedStageLimit = Math.max(
    0,
    ...selectedStageEvents.map(event => event.commitOffsetFrames),
  );
  const settled = contract.commitEvents.filter(event => (
    event.basicStageOrdinal !== undefined
      ? event.basicStageOrdinal <= selectedBasicStageCount
      : event.commitOffsetFrames <= selectedStageLimit
  ));
  const settledIds = new Set(settled.map(event => event.id));
  return {
    settled,
    pruned: contract.commitEvents.filter(event => !settledIds.has(event.id)),
  };
}

function cursorAfter(
  contract: ActionTailTimingContract,
  selectedBasicStageCount: number | null,
  boundary: ResolveTailTransitionInput['boundary'],
  successor: TailSuccessorIntent | null,
): BasicComboCursor | null {
  if (contract.kind !== 'basic-attack' || !contract.basicCombo) return null;
  const combo = contract.basicCombo;
  const completed = selectedBasicStageCount ?? combo.renderedStageCount;
  const cursor: BasicComboCursor = {
    comboId: combo.comboId,
    stageCount: combo.stageCount,
    nextStageIndex: (combo.startingStageIndex + completed) % combo.stageCount,
  };
  if (boundary === 'group-seal' || successor?.kind === 'ultimate-skill'
    || successor?.kind === 'basic-combo-reset') {
    return { ...cursor, nextStageIndex: 0 };
  }
  return cursor;
}

function effectEnd(
  contract: ActionTailTimingContract,
  settled: readonly ActionCommitEvent[],
  allEventsSelected: boolean,
): number {
  const eventEnd = Math.max(0, ...settled.map(event => (
    event.effectOffsetFrames ?? event.commitOffsetFrames
  )));
  if (!allEventsSelected) return eventEnd;
  return Math.max(eventEnd, contract.effectEndOffsetFrames ?? 0);
}

function naturalResolution(
  contract: ActionTailTimingContract,
  input: ResolveTailTransitionInput,
  selectedBasicStageCount: number | null,
  reason: TailTransitionReason,
  status: TailTransitionStatus,
): TailTransitionResolution {
  const events = selectedEvents(contract, selectedBasicStageCount);
  const allSelected = events.pruned.length === 0;
  const mandatory = events.settled.filter(event => event.mandatory !== false);
  const lastCommit = Math.max(0, ...mandatory.map(event => event.commitOffsetFrames));
  return {
    status,
    reason,
    blockingEndOffsetFrames: contract.naturalEndOffsetFrames,
    naturalEndOffsetFrames: contract.naturalEndOffsetFrames,
    effectEndOffsetFrames: effectEnd(contract, events.settled, allSelected),
    debounceFrames: input.debounceFrames,
    commitFloorOffsetFrames: Math.min(
      contract.naturalEndOffsetFrames,
      lastCommit + input.debounceFrames,
    ),
    compressedFrames: 0,
    selectedBasicStageCount,
    settledEventIds: events.settled.map(event => event.id),
    prunedEventIds: events.pruned.map(event => event.id),
    comboCursorAfter: cursorAfter(
      contract,
      selectedBasicStageCount,
      input.boundary,
      input.successor,
    ),
  };
}

function addWindowCandidate(
  candidates: Candidate[],
  window: ActionSuccessorWindow,
  floor: number,
  reason: TailTransitionReason,
  rank: number,
): void {
  const offsetFrames = Math.max(floor, window.startOffsetFrames);
  if (offsetFrames <= window.endOffsetFrames) {
    candidates.push({ offsetFrames, reason, rank });
  }
}

export function resolveActionTailTransition(
  input: ResolveTailTransitionInput,
): TailTransitionResolution {
  validateContract(input.predecessor);
  integerAtLeast(input.debounceFrames, 0, 'debounceFrames');
  if (input.boundary === 'append' && !input.successor) {
    throw new CombatActionTailPlannerError(
      'MISSING_SUCCESSOR',
      'An append transition requires a successor.',
    );
  }

  const contract = input.predecessor;
  const stageSelection = basicStageSelection(
    contract,
    input.boundary,
    input.selectedBasicStageCount,
  );
  if (stageSelection === 'required') {
    return naturalResolution(
      contract,
      input,
      null,
      'BASIC_STAGE_SELECTION_REQUIRED',
      'selection-required',
    );
  }
  const selectedBasicStageCount = stageSelection;
  if (contract.commitEvidence === 'unverified') {
    return naturalResolution(
      contract,
      input,
      selectedBasicStageCount,
      'COMMIT_EVIDENCE_UNVERIFIED',
      'unverified',
    );
  }
  if (!contract.tailCancelable) {
    return naturalResolution(
      contract,
      input,
      selectedBasicStageCount,
      'TAIL_NOT_CANCELABLE',
      'natural',
    );
  }

  const events = selectedEvents(contract, selectedBasicStageCount);
  const mandatory = events.settled.filter(event => event.mandatory !== false);
  const lastCommit = Math.max(0, ...mandatory.map(event => event.commitOffsetFrames));
  const floor = Math.min(
    contract.naturalEndOffsetFrames,
    lastCommit + input.debounceFrames,
  );
  const candidates: Candidate[] = [{
    offsetFrames: contract.naturalEndOffsetFrames,
    reason: 'NATURAL_END',
    rank: 99,
  }];

  if (input.boundary === 'append' && input.successor) {
    const successor = input.successor;
    // A partial stage selection is an explicit cut boundary. A completed
    // A -> A segment is different: it must use the final stage's native
    // successor window/exclusive boundary, otherwise the next full combo is
    // pulled back to the last-hit debounce floor and disagrees with preview.
    const isCompletedBasicRestart = contract.kind === 'basic-attack'
      && successor.kind === 'basic-attack'
      && selectedBasicStageCount === contract.basicCombo?.renderedStageCount;
    if (contract.kind === 'basic-attack'
      && selectedBasicStageCount !== null
      && !isCompletedBasicRestart) {
      candidates.push({
        offsetFrames: floor,
        reason: 'BASIC_STAGE_BOUNDARY',
        rank: 0,
      });
    }
    if (successor.forceInterruptsKinds?.includes(contract.kind)) {
      candidates.push({ offsetFrames: floor, reason: 'FORCED_KIND_INTERRUPT', rank: 1 });
    }
    if (successor.priority !== null && contract.priority !== null
      && successor.priority > contract.priority) {
      candidates.push({ offsetFrames: floor, reason: 'HIGHER_PRIORITY', rank: 2 });
    }
    contract.successorWindows
      .filter(window => matchesWindow(window, successor))
      .forEach(window => addWindowCandidate(
        candidates,
        window,
        floor,
        'ALLOWED_SUCCESSOR_WINDOW',
        3,
      ));
    contract.interruptibleAtOffsetFrames
      .filter(offset => offset >= floor)
      .forEach(offsetFrames => candidates.push({
        offsetFrames,
        reason: 'INTERRUPTIBLE_MARK',
        rank: 4,
      }));
    candidates.push({
      offsetFrames: Math.max(floor, contract.exclusiveEndOffsetFrames),
      reason: 'EXCLUSIVE_END',
      rank: 5,
    });
  } else {
    contract.successorWindows.forEach(window => addWindowCandidate(
      candidates,
      window,
      floor,
      'GROUP_SEAL_WINDOW',
      0,
    ));
    contract.interruptibleAtOffsetFrames
      .filter(offset => offset >= floor)
      .forEach(offsetFrames => candidates.push({
        offsetFrames,
        reason: 'GROUP_SEAL_INTERRUPTIBLE_MARK',
        rank: 1,
      }));
    candidates.push({
      offsetFrames: Math.max(floor, contract.exclusiveEndOffsetFrames),
      reason: 'GROUP_SEAL_EXCLUSIVE_END',
      rank: 2,
    });
  }

  const chosen = candidates
    .filter(candidate => candidate.offsetFrames >= floor
      && candidate.offsetFrames <= contract.naturalEndOffsetFrames)
    .sort((left, right) => (
      left.offsetFrames - right.offsetFrames
      || left.rank - right.rank
      || left.reason.localeCompare(right.reason)
    ))[0] ?? candidates[0];
  const blockingEnd = Math.min(contract.naturalEndOffsetFrames, chosen.offsetFrames);
  const actuallySettled = events.settled.filter(event => event.commitOffsetFrames <= blockingEnd);
  const settledIds = new Set(actuallySettled.map(event => event.id));
  const pruned = contract.commitEvents.filter(event => !settledIds.has(event.id));
  const allSelected = pruned.length === 0;

  return {
    status: blockingEnd < contract.naturalEndOffsetFrames ? 'compressed' : 'natural',
    reason: chosen.reason,
    blockingEndOffsetFrames: blockingEnd,
    naturalEndOffsetFrames: contract.naturalEndOffsetFrames,
    effectEndOffsetFrames: effectEnd(contract, actuallySettled, allSelected),
    debounceFrames: input.debounceFrames,
    commitFloorOffsetFrames: floor,
    compressedFrames: contract.naturalEndOffsetFrames - blockingEnd,
    selectedBasicStageCount,
    settledEventIds: actuallySettled.map(event => event.id),
    prunedEventIds: pruned.map(event => event.id),
    comboCursorAfter: cursorAfter(
      contract,
      selectedBasicStageCount,
      input.boundary,
      input.successor,
    ),
  };
}

export function buildBasicAttackCutOptions(
  input: Omit<ResolveTailTransitionInput, 'selectedBasicStageCount'>,
): BasicAttackCutOption[] {
  validateContract(input.predecessor);
  if (input.predecessor.kind !== 'basic-attack' || !input.predecessor.basicCombo) {
    throw new CombatActionTailPlannerError(
      'NOT_BASIC_ATTACK',
      'Basic attack cut options require a basic-attack predecessor.',
    );
  }
  if (input.boundary !== 'append' || !input.successor) {
    throw new CombatActionTailPlannerError(
      'CUT_OPTIONS_REQUIRE_SUCCESSOR',
      'The slider requires an appended successor.',
    );
  }
  return Array.from(
    { length: input.predecessor.basicCombo.renderedStageCount },
    (_, index) => {
      const stageCount = index + 1;
      return {
        stageCount,
        transition: resolveActionTailTransition({
          ...input,
          selectedBasicStageCount: stageCount,
        }),
      };
    },
  );
}

export function lockTailTransitionBundle(input: {
  id: string;
  predecessorActionId: string;
  successorActionId: string;
  transition: TailTransitionResolution;
}): LockedTailTransitionBundle {
  nonEmptyId(input.id, 'bundle id');
  nonEmptyId(input.predecessorActionId, 'predecessorActionId');
  nonEmptyId(input.successorActionId, 'successorActionId');
  if (input.transition.status === 'selection-required'
    || input.transition.status === 'unverified') {
    throw new CombatActionTailPlannerError(
      'UNRESOLVED_TRANSITION',
      'Only a resolved transition can become an immutable bundle.',
    );
  }
  return {
    id: input.id,
    predecessorActionId: input.predecessorActionId,
    successorActionId: input.successorActionId,
    selectedBasicStageCount: input.transition.selectedBasicStageCount,
    blockingEndOffsetFrames: input.transition.blockingEndOffsetFrames,
    immutable: true,
    editPolicy: 'delete-successor-to-recompute',
  };
}

export function applyComboContinuity(
  cursor: BasicComboCursor | null,
  action: {
    kind: CombatActionKind | 'group-seal';
    completedBasicStageCount?: number;
  },
): BasicComboCursor | null {
  if (!cursor) return null;
  if (action.kind === 'group-seal' || action.kind === 'ultimate-skill'
    || action.kind === 'basic-combo-reset') {
    return { ...cursor, nextStageIndex: 0 };
  }
  if (action.kind !== 'basic-attack') return cursor;
  const completed = integerAtLeast(
    action.completedBasicStageCount ?? 0,
    0,
    'completedBasicStageCount',
  );
  return {
    ...cursor,
    nextStageIndex: (cursor.nextStageIndex + completed) % cursor.stageCount,
  };
}

export function debounceFramesForTickRate(tickRate: number, seconds = 0.2): number {
  integerAtLeast(tickRate, 1, 'tickRate');
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new CombatActionTailPlannerError(
      'INVALID_DEBOUNCE_SECONDS',
      'seconds must be finite and >= 0.',
    );
  }
  return Math.max(0, Math.round(tickRate * seconds));
}

export function createDodgeModuleSpec(input: {
  id: string;
  kind: 'dodge' | 'perfect-dodge';
  durationFrames: number;
  sharedAtbGain?: number | null;
}): DodgeModuleSpec {
  nonEmptyId(input.id, 'dodge id');
  integerAtLeast(input.durationFrames, 1, 'dodge durationFrames');
  if (input.sharedAtbGain !== undefined && input.sharedAtbGain !== null
    && (!Number.isFinite(input.sharedAtbGain) || input.sharedAtbGain < 0)) {
    throw new CombatActionTailPlannerError(
      'INVALID_DODGE_ATB_GAIN',
      'sharedAtbGain must be finite and >= 0.',
    );
  }
  return {
    id: input.id,
    kind: input.kind,
    durationFrames: input.durationFrames,
    sharedAtbGain: input.kind === 'perfect-dodge'
      ? input.sharedAtbGain ?? null
      : null,
    resourceVerdict: input.kind === 'perfect-dodge'
      ? 'runtime-required'
      : 'not-applicable',
  };
}
