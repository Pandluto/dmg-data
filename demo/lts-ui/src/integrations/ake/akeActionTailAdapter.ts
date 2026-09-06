import type { AkeTimingSkillProfile } from './akeCatalogAdapter';
import type {
  ActionCommitEvent,
  ActionTailTimingContract,
  CombatActionKind,
  TailSuccessorIntent,
} from '../../core/domain/combatActionTailPlanner';

const ACTION_KIND_BY_COMMAND: Record<string, CombatActionKind> = {
  Attack: 'basic-attack',
  NormalSkill: 'normal-skill',
  ComboSkill: 'combo-skill',
  UltimateSkill: 'ultimate-skill',
  Dodge: 'dodge',
  PerfectDodge: 'perfect-dodge',
};

function finiteFrame(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function actionKind(profile: AkeTimingSkillProfile): CombatActionKind {
  if (profile.attackMode === 'plunging-impact') return 'other';
  return ACTION_KIND_BY_COMMAND[profile.commandType] ?? 'other';
}

function eventId(prefix: string, index: number): string {
  return `${prefix}:${index + 1}`;
}

function hitEvents(profile: AkeTimingSkillProfile): ActionCommitEvent[] {
  const basicStages = profile.commandType === 'Attack' && profile.attackMode !== 'plunging-impact'
    ? profile.comboStageSkillIds?.length
      ? profile.comboStageSkillIds
      : [profile.skillId]
    : [];
  return profile.hits.map((hit, index) => {
    const launch = hit.launchOffsetFrames === null
      || hit.launchOffsetFrames === undefined
      ? null
      : finiteFrame(hit.launchOffsetFrames);
    const effect = finiteFrame(hit.offsetFrames);
    // Generated or cached timing data may know that a child SkillData was
    // involved without knowing the launch that caused this particular hit.
    // A launch after the observed effect is not causal evidence.  Quarantine
    // it instead of constructing an impossible commit contract that crashes
    // the whole timeline route.
    const causalLaunch = launch !== null && launch <= effect ? launch : null;
    const stageIndex = basicStages.indexOf(hit.rootSkillId);
    return {
      id: eventId(`${profile.skillId}:hit`, index),
      kind: causalLaunch !== null ? 'projectile-launch' : 'hit',
      commitOffsetFrames: causalLaunch ?? effect,
      effectOffsetFrames: effect,
      ...(stageIndex >= 0 ? { basicStageOrdinal: stageIndex + 1 } : {}),
    };
  });
}

function hasNonCausalLaunch(profile: AkeTimingSkillProfile): boolean {
  return profile.hits.some((hit) => {
    if (hit.launchOffsetFrames === null || hit.launchOffsetFrames === undefined) return false;
    return finiteFrame(hit.launchOffsetFrames) > finiteFrame(hit.offsetFrames);
  });
}

function resourceEvents(profile: AkeTimingSkillProfile): ActionCommitEvent[] {
  return profile.resourceEvents.map((event, index) => ({
    id: eventId(`${profile.skillId}:resource`, index),
    kind: 'resource',
    commitOffsetFrames: finiteFrame(event.offsetFrames),
    effectOffsetFrames: finiteFrame(event.offsetFrames),
  }));
}

function formEvents(profile: AkeTimingSkillProfile): ActionCommitEvent[] {
  return (profile.formEvents ?? []).map((event, index) => ({
    id: eventId(`${profile.skillId}:form`, index),
    kind: 'state-change',
    commitOffsetFrames: finiteFrame(event.offsetFrames),
    effectOffsetFrames: finiteFrame(event.offsetFrames),
    // A later scheduled removal is an effect tail, not a reason to keep the
    // casting animation blocked until that removal frame.
    mandatory: event.operation === 'apply',
  }));
}

export function akeProfileToActionTailContract(input: {
  actionId: string;
  profile: AkeTimingSkillProfile;
  startingBasicStageIndex?: number;
}): ActionTailTimingContract {
  const { profile } = input;
  const commits = [
    ...hitEvents(profile),
    ...resourceEvents(profile),
    ...formEvents(profile),
  ].sort((left, right) => (
    left.commitOffsetFrames - right.commitOffsetFrames
    || left.id.localeCompare(right.id)
  ));
  const naturalEnd = Math.max(1, finiteFrame(
    profile.bodyEndOffset,
    finiteFrame(profile.durationFrames, 1),
  ));
  const effectEnd = Math.max(
    0,
    ...commits.map(event => event.effectOffsetFrames ?? event.commitOffsetFrames),
  );
  const earliestKnownGate = Math.min(
    finiteFrame(profile.exclusiveFrames, naturalEnd),
    ...profile.interruptibleAt.map(frame => finiteFrame(frame, naturalEnd)),
    ...profile.allowNext.map(window => finiteFrame(window.startOffsetFrames, naturalEnd)),
  );
  const commitEvidence = profile.derivation === 'isolated-runtime-probe'
    && commits.length > 0
    && !hasNonCausalLaunch(profile)
    ? 'verified'
    : 'unverified';
  const kind = actionKind(profile);
  const basicStages = kind === 'basic-attack'
    ? profile.comboStageSkillIds?.length
      ? profile.comboStageSkillIds
      : [profile.skillId]
    : [];

  return {
    actionId: input.actionId,
    skillId: profile.skillId,
    kind,
    naturalEndOffsetFrames: naturalEnd,
    effectEndOffsetFrames: effectEnd,
    exclusiveEndOffsetFrames: finiteFrame(profile.exclusiveFrames, naturalEnd),
    priority: profile.priority,
    interruptibleAtOffsetFrames: profile.interruptibleAt.map(frame => finiteFrame(frame)),
    successorWindows: profile.allowNext.map(window => ({
      startOffsetFrames: finiteFrame(window.startOffsetFrames),
      endOffsetFrames: finiteFrame(window.endOffsetFrames),
      allowedActionIds: [...window.allowedSkillIds],
    })),
    commitEvents: commits,
    // A rendered A button is a composed sequence of verified attack stages.
    // Its explicit stage selection supplies the cancel boundary even though
    // the synthetic full-combo profile intentionally has no allow-next window.
    tailCancelable: kind !== 'ultimate-skill'
      && commitEvidence === 'verified'
      && (earliestKnownGate < naturalEnd || (kind === 'basic-attack' && basicStages.length > 0)),
    commitEvidence,
    ...(kind === 'basic-attack' && basicStages.length > 0 ? {
      basicCombo: {
        // Stable across separate A buttons so an unfinished cursor can resume
        // after a skill/dodge instead of becoming a new per-button combo.
        comboId: `basic-combo:${basicStages.join('>')}`,
        stageCount: basicStages.length,
        startingStageIndex: Math.max(0, Math.min(
          basicStages.length - 1,
          Math.round(input.startingBasicStageIndex ?? 0),
        )),
        renderedStageCount: basicStages.length,
      },
    } : {}),
  };
}

export function akeProfileToTailSuccessor(
  actionId: string,
  profile: AkeTimingSkillProfile,
): TailSuccessorIntent {
  return {
    actionId,
    skillId: profile.skillId,
    kind: actionKind(profile),
    priority: profile.priority,
    ...(['dodge', 'perfect-dodge'].includes(actionKind(profile)) ? {
      forceInterruptsKinds: [
        'basic-attack' as const,
        'normal-skill' as const,
        'combo-skill' as const,
        'dodge' as const,
        'perfect-dodge' as const,
        'basic-combo-reset' as const,
        'other' as const,
      ],
    } : {}),
  };
}
