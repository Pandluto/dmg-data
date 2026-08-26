import type {
  ScheduledTimelineAction,
  ScheduledTimelineOperatorSwitch,
  SharedVariableRateTimelineModel,
} from './sharedVariableRateTimeline';

export type OperatorControlIssueCode =
  | 'MISSING_INITIAL_CONTROLLER'
  | 'SWITCH_SOURCE_NOT_CONTROLLED'
  | 'SWITCH_TARGET_INVALID'
  | 'SWITCH_DURING_ULTIMATE'
  | 'DUPLICATE_SWITCH_POSITION'
  | 'BASIC_ATTACK_SOURCE_NOT_CONTROLLED';

export type OperatorControlIssue = {
  code: OperatorControlIssueCode;
  message: string;
  actionId?: string;
  switchId?: string;
};

type TimelineActionPayload = {
  commandType?: string;
  skillType?: string;
};

function actionPayload(action: ScheduledTimelineAction): TimelineActionPayload {
  return (action.payload ?? {}) as TimelineActionPayload;
}

export function isUltimateTimelineAction(action: ScheduledTimelineAction): boolean {
  const payload = actionPayload(action);
  return payload.commandType === 'UltimateSkill' || payload.skillType === 'Q';
}

export function isBasicAttackTimelineAction(action: ScheduledTimelineAction): boolean {
  const payload = actionPayload(action);
  return payload.commandType === 'Attack' || payload.skillType === 'A';
}

function orderedSwitches(
  switches: readonly ScheduledTimelineOperatorSwitch[],
): ScheduledTimelineOperatorSwitch[] {
  return [...switches].sort((left, right) => (
    left.startFrame - right.startFrame
    || left.endX - right.endX
    || left.id.localeCompare(right.id)
  ));
}

/**
 * Migrates old timelines to the first selected operator while honoring an
 * explicit, still-selected controller whenever one is persisted.
 */
export function resolveInitialControllerLaneId(
  configuredLaneId: string | null | undefined,
  selectedLaneIds: readonly (string | null | undefined)[],
): string | null {
  const validLaneIds = selectedLaneIds
    .map(laneId => laneId?.trim() ?? '')
    .filter(Boolean);
  const configured = configuredLaneId?.trim() ?? '';
  if (configured && validLaneIds.includes(configured)) return configured;
  return validLaneIds[0] ?? null;
}

/**
 * Resolves control at one real/visual position. A zero-time switch takes effect
 * at its right edge, so actions before and after it may share the same frame.
 */
export function controlledOperatorAt(
  initialControllerLaneId: string | null | undefined,
  switches: readonly ScheduledTimelineOperatorSwitch[],
  frame: number,
  x: number,
): string | null {
  let controlled = initialControllerLaneId?.trim() || null;
  for (const operatorSwitch of orderedSwitches(switches)) {
    const hasTakenEffect = operatorSwitch.startFrame < frame
      || (operatorSwitch.startFrame === frame && operatorSwitch.endX <= x);
    if (hasTakenEffect) controlled = operatorSwitch.targetLaneId;
  }
  return controlled;
}

export function isFrameInsideUltimate(
  actions: readonly ScheduledTimelineAction[],
  frame: number,
): boolean {
  return actions.some(action => (
    isUltimateTimelineAction(action)
    && frame >= action.startFrame
    && frame < action.endFrame
  ));
}

/** Final, pixel-independent admission guard for control-only interactions. */
export function validateOperatorControlTimeline(
  model: SharedVariableRateTimelineModel,
  initialControllerLaneId: string | null | undefined,
  validLaneIds?: ReadonlySet<string>,
): OperatorControlIssue[] {
  const issues: OperatorControlIssue[] = [];
  if (!initialControllerLaneId?.trim()) {
    issues.push({
      code: 'MISSING_INITIAL_CONTROLLER',
      message: '时间轴没有初始主控干员。',
    });
    return issues;
  }

  const switches = orderedSwitches(model.operatorSwitches);
  const occupiedPositions = new Set<string>();
  switches.forEach((operatorSwitch) => {
    const positionKey = `${operatorSwitch.startFrame}:${operatorSwitch.startX}`;
    if (occupiedPositions.has(positionKey)) {
      issues.push({
        code: 'DUPLICATE_SWITCH_POSITION',
        switchId: operatorSwitch.id,
        message: '同一个吸附位置只能放置一次切人。',
      });
    }
    occupiedPositions.add(positionKey);

    const controlledBefore = controlledOperatorAt(
      initialControllerLaneId,
      switches.filter(candidate => candidate.id !== operatorSwitch.id),
      operatorSwitch.startFrame,
      operatorSwitch.startX,
    );
    if (controlledBefore !== operatorSwitch.laneId) {
      issues.push({
        code: 'SWITCH_SOURCE_NOT_CONTROLLED',
        switchId: operatorSwitch.id,
        message: `切人必须由当前主控干员 ${controlledBefore ?? '未知'} 发起。`,
      });
    }
    if (!operatorSwitch.targetLaneId
      || operatorSwitch.targetLaneId === operatorSwitch.laneId
      || (validLaneIds && !validLaneIds.has(operatorSwitch.targetLaneId))) {
      issues.push({
        code: 'SWITCH_TARGET_INVALID',
        switchId: operatorSwitch.id,
        message: '切人目标必须是另一位干员。',
      });
    }
    if (isFrameInsideUltimate(model.actions, operatorSwitch.startFrame)) {
      issues.push({
        code: 'SWITCH_DURING_ULTIMATE',
        switchId: operatorSwitch.id,
        message: '终结技完整动画期间不允许切人。',
      });
    }
  });

  model.actions.forEach((action) => {
    if (!isBasicAttackTimelineAction(action)) return;
    const controlled = controlledOperatorAt(
      initialControllerLaneId,
      switches,
      action.startFrame,
      action.startX,
    );
    if (controlled !== action.laneId) {
      issues.push({
        code: 'BASIC_ATTACK_SOURCE_NOT_CONTROLLED',
        actionId: action.id,
        message: `只有当前主控干员 ${controlled ?? '未知'} 可以普攻。`,
      });
    }
  });

  return issues;
}
