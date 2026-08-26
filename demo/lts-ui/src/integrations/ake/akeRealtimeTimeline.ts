import type { Character, SkillButtonData, SkillReleaseAnchor, TimelineData } from '../../types';
import type {
  AkeCatalog,
  AkeTimingCatalog,
  AkeTimingComboTrigger,
  AkeTimingHitProfile,
  AkeTimingSkillProfile,
} from './akeCatalogAdapter';
import type { AkeCommandSettlement, AkeTimelinePoint } from './akeProvider';
import {
  GRID_COLUMN_WIDTH,
  GRID_NODE_COUNT,
} from '../../core/calculators/gridSnapLayout';
import {
  buildSharedVariableRateTimeline,
  projectSharedTimelineFrame,
  type ReleaseCohortDraft,
  type SharedVariableRateTimelineModel,
  type SharedVariableRateTimelineSpec,
} from '../../core/domain/sharedVariableRateTimeline';
import {
  debounceFramesForTickRate,
  resolveActionTailTransition,
} from '../../core/domain/combatActionTailPlanner';
import { solveReleaseStartOffsets } from '../../core/domain/releaseAnchorGraph';
import {
  controlledOperatorAt,
  isFrameInsideUltimate,
  validateOperatorControlTimeline,
} from '../../core/domain/operatorControlTimeline';
import {
  akeProfileToActionTailContract,
  akeProfileToTailSuccessor,
} from './akeActionTailAdapter';

const COMMAND_TYPE_BY_BUTTON: Record<string, string> = {
  A: 'Attack',
  B: 'NormalSkill',
  E: 'ComboSkill',
  Q: 'UltimateSkill',
};

const DEFAULT_TICK_RATE = 30;
const DEFAULT_NODE_FRAMES = 15;
const SKILL_SLOT_BY_COMMAND: Record<string, string> = {
  Attack: 'NormalAttack',
  NormalSkill: 'NormalSkill',
  ComboSkill: 'ComboSkill',
  UltimateSkill: 'UltimateSkill',
};

export type AkeRealtimeHit = {
  id: string;
  commandId: string;
  characterId: string;
  frame: number;
  offsetFrames: number;
  launchFrame: number | null;
  kind: AkeTimingHitProfile['kind'];
  hitCount: number;
  damageTypes: string[];
  sourceSkillId: string;
  rootSkillId: string;
};

export type AkeRealtimeEnergyPoint = AkeTimelinePoint & {
  requestedDelta: number;
  actualDelta: number;
  reason: string | null;
};

export type AkeRealtimeUltimateSpPool = {
  characterId: string;
  initial: number;
  max: number;
  final: number;
  points: AkeRealtimeEnergyPoint[];
};

export type AkeRealtimeComboWindow = {
  id: string;
  ruleId: string;
  characterId: string;
  skillId: string;
  sourceCommandId: string;
  createdFrame: number;
  expireFrame: number;
  consumedFrame: number | null;
  state: 'ready' | 'consumed' | 'expired' | 'suppressed';
  reason: string;
};

export type AkeRealtimeCommand = AkeCommandSettlement & {
  preview: true;
  profile: AkeTimingSkillProfile;
  naturalEndFrame: number | null;
  tailEndFrame: number | null;
  completion: 'open' | 'completed' | 'interrupted' | 'failed' | 'expired';
  admissionReason: string | null;
  atbBefore: number | null;
  atbAfter: number | null;
  atbEligibilityRatio: number;
  ultimateSpBefore: number | null;
  ultimateSpAfter: number | null;
  ultimateSpMax: number;
  cooldownEndFrame: number | null;
  releaseVerdict: 'valid' | 'queued' | 'invalid' | 'unverified';
  releaseReason: string;
  resourceLabel: string;
  hits: AkeRealtimeHit[];
  /** UI-confirmed number of rendered basic stages before the successor. */
  selectedBasicAttackStageCount: number | null;
};

export type AkeRealtimeTimeline = {
  schemaVersion: 2;
  source: 'precompiled-local-preview';
  tickRate: number;
  nodeFrameScale: number;
  durationFrames: number;
  commands: AkeRealtimeCommand[];
  hits: AkeRealtimeHit[];
  sharedAtb: {
    initial: number;
    max: number;
    final: number;
    points: AkeTimelinePoint[];
  };
  ultimateSpPools: AkeRealtimeUltimateSpPool[];
  comboWindows: AkeRealtimeComboWindow[];
  /** Authoritative relationship schedule and shared variable-rate projection. */
  sharedVariableRateTimeline: SharedVariableRateTimelineModel | null;
  planningIterations: number;
  diagnostics: string[];
};

type TimelineInput = {
  sequence: number;
  commandId: string;
  characterId: string;
  characterName: string;
  commandType: string;
  skillId: string | null;
  requestedFrame: number;
  sourceGroupIndex: number;
  sourceNodeIndex: number;
  basicAttackStageCount?: number;
  releaseAnchor?: SkillReleaseAnchor;
};

type ScheduledInput = {
  input: TimelineInput;
  command: AkeRealtimeCommand;
  profile: AkeTimingSkillProfile;
  expiresAt: number;
};

type ActorState = {
  active: AkeRealtimeCommand | null;
  ultimateSp: number;
  maxUltimateSp: number;
  initialUltimateSp: number;
  ultimateSpPoints: AkeRealtimeEnergyPoint[];
  cooldowns: Map<string, number>;
  skillOverrides: Map<string, {
    skillSlot: string;
    targetSkillId: string;
    sequence: number;
  }>;
  skillModes: Map<string, {
    modeId: string;
    sequence: number;
  }>;
  basicComboCursor: {
    nextSkillId: string;
    remainingStageCount: number;
  } | null;
};

type PendingFormEvent = {
  frame: number;
  commandId: string;
  characterId: string;
  event: NonNullable<AkeTimingSkillProfile['formEvents']>[number];
};

type PendingResourceEvent = {
  frame: number;
  commandId: string;
  sourceCharacterId: string;
  resourceType: string;
  target: 'self' | 'team' | 'other' | 'shared';
  amount: number;
  gainMethod: string;
  reason: string | null;
};

type PendingCombo = AkeRealtimeComboWindow & {
  rule: AkeTimingComboTrigger;
};

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fallbackProfile(commandType: string): AkeTimingSkillProfile {
  return {
    commandType,
    skillId: `unresolved:${commandType}`,
    variantIndex: 0,
    durationFrames: DEFAULT_NODE_FRAMES,
    bodyEndOffset: DEFAULT_NODE_FRAMES,
    tailEndOffset: DEFAULT_NODE_FRAMES,
    exclusiveFrames: DEFAULT_NODE_FRAMES,
    cooldownFrames: 0,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [],
    commandMappings: [],
    formEvents: [],
    interruptibleAt: [],
    hits: [],
    resourceEvents: [],
    recoveryPauses: [],
    derivation: 'compiled-fallback',
    diagnostic: 'AKE timing profile unavailable for this local operator.',
  };
}

function inputsFromTimeline(
  timelineData: TimelineData,
  characters: Character[],
  requestedFrames?: ReadonlyMap<string, number>,
): TimelineInput[] {
  const characterByName = new Map(characters.map(character => [character.name, character]));
  let sequence = 0;
  return timelineData.staffLines.flatMap(line => line.buttons.flatMap(button => {
    const commandType = COMMAND_TYPE_BY_BUTTON[button.skillType];
    if (!commandType) return [];
    const character = characters.find(item => item.id === button.characterId)
      ?? characterByName.get(button.characterName);
    if (!character) return [];
    const sourceNodeIndex = Math.max(0, Math.round(finite(button.nodeIndex)));
    return [{
      sequence: sequence++,
      commandId: button.id,
      characterId: character.id,
      characterName: character.name,
      commandType,
      skillId: button.runtimeSkillId ?? null,
      // Relationship planning owns combat time. Before a plan exists, every
      // intent is provisionally at the origin; display node spacing is never
      // interpreted as elapsed frames.
      requestedFrame: requestedFrames?.get(button.id) ?? 0,
      sourceGroupIndex: Math.floor(sourceNodeIndex / GRID_NODE_COUNT),
      sourceNodeIndex,
      basicAttackStageCount: button.basicAttackStageCount,
      releaseAnchor: button.releaseAnchor,
    }];
  })).sort((left, right) => (
    left.requestedFrame - right.requestedFrame
    || left.characterId.localeCompare(right.characterId)
    || left.sequence - right.sequence
  ));
}

function characterProfiles(timing: AkeTimingCatalog | undefined, characterId: string) {
  return timing?.characters[characterId]?.profiles ?? [];
}

function withResolution(
  profile: AkeTimingSkillProfile,
  resolutionSource: NonNullable<AkeTimingSkillProfile['resolutionSource']>,
): AkeTimingSkillProfile {
  return { ...profile, resolutionSource };
}

function attackTransitionOffset(
  profile: AkeTimingSkillProfile,
  nextSkillId: string | null,
): number {
  const starts = profile.allowNext
    .filter(window => nextSkillId === null || window.allowedSkillIds.includes(nextSkillId))
    .map(window => finite(window.startOffsetFrames, Number.POSITIVE_INFINITY));
  const start = Math.min(...starts);
  if (Number.isFinite(start)) return Math.max(1, Math.round(start));
  return Math.max(1, Math.round(finite(profile.exclusiveFrames, profile.bodyEndOffset)));
}

/**
 * A single A button means “finish this normal-attack combo”.  Raw AKE data
 * stores every stage as an independent SkillData program, so the local preview
 * folds the stage chain into one interruptible command while retaining each
 * stage's hit/resource/form events at its real frame.
 */
function composeFullAttackProfile(
  profiles: AkeTimingSkillProfile[],
  first: AkeTimingSkillProfile,
  maximumStageCount?: number,
): AkeTimingSkillProfile {
  const byId = new Map(profiles.map(profile => [profile.skillId, profile]));
  const chain: AkeTimingSkillProfile[] = [];
  const visited = new Set<string>();
  let current: AkeTimingSkillProfile | undefined = first;
  const stageLimit = maximumStageCount === undefined
    ? 12
    : Math.max(1, Math.round(maximumStageCount));
  while (current && !visited.has(current.skillId) && chain.length < stageLimit) {
    visited.add(current.skillId);
    chain.push(current);
    const nextSkillId = current.commandMappings?.find(mapping => (
      mapping.commandType === 'Attack'
    ))?.skillId;
    if (!nextSkillId || nextSkillId === first.skillId || visited.has(nextSkillId)) break;
    current = byId.get(nextSkillId);
  }
  const firstMappedSkillId = first.commandMappings?.find(mapping => (
    mapping.commandType === 'Attack'
  ))?.skillId;
  if (chain.length < 2 && (!firstMappedSkillId || firstMappedSkillId === first.skillId)) {
    return first;
  }

  const hits: AkeTimingHitProfile[] = [];
  const resourceEvents: AkeTimingSkillProfile['resourceEvents'] = [];
  const formEvents: NonNullable<AkeTimingSkillProfile['formEvents']> = [];
  const recoveryPauses: AkeTimingSkillProfile['recoveryPauses'] = [];
  const interruptibleAt: number[] = [];
  let stageStart = 0;

  chain.forEach((stage, stageIndex) => {
    const ordinaryHits = stage.hits.filter(hit => hit.kind !== 'lingering');
    if (ordinaryHits.length > 0) {
      const settlement = ordinaryHits.reduce((latest, hit) => (
        hit.offsetFrames >= latest.offsetFrames ? hit : latest
      ));
      const launches = ordinaryHits
        .map(hit => hit.launchOffsetFrames)
        .filter((value): value is number => value !== null && value !== undefined);
      hits.push({
        offsetFrames: stageStart + Math.max(...ordinaryHits.map(hit => hit.offsetFrames)),
        launchOffsetFrames: launches.length > 0
          ? stageStart + Math.min(...launches)
          : null,
        sourceSkillId: settlement.sourceSkillId,
        rootSkillId: stage.skillId,
        kind: ordinaryHits.some(hit => hit.kind === 'projectile') ? 'projectile' : 'direct',
        hitCount: ordinaryHits.reduce((sum, hit) => sum + hit.hitCount, 0),
        damageTypes: [...new Set(ordinaryHits.flatMap(hit => hit.damageTypes))],
      });
    }
    for (const hit of stage.hits.filter(candidate => candidate.kind === 'lingering')) {
      hits.push({
        ...hit,
        offsetFrames: stageStart + hit.offsetFrames,
        launchOffsetFrames: hit.launchOffsetFrames === null
          || hit.launchOffsetFrames === undefined
          ? hit.launchOffsetFrames
          : stageStart + hit.launchOffsetFrames,
      });
    }
    resourceEvents.push(...stage.resourceEvents.map(event => ({
      ...event,
      offsetFrames: stageStart + event.offsetFrames,
    })));
    formEvents.push(...(stage.formEvents ?? []).map(event => ({
      ...event,
      offsetFrames: stageStart + event.offsetFrames,
    })));
    recoveryPauses.push(...stage.recoveryPauses.map(pause => ({
      startOffsetFrames: stageStart + pause.startOffsetFrames,
      endOffsetFrames: stageStart + pause.endOffsetFrames,
    })));
    interruptibleAt.push(...stage.interruptibleAt.map(offset => stageStart + offset));
    const nextSkillId = chain[stageIndex + 1]?.skillId
      ?? stage.commandMappings?.find(mapping => mapping.commandType === 'Attack')?.skillId
      ?? first.skillId;
    stageStart += attackTransitionOffset(stage, nextSkillId);
  });

  const bodyEndOffset = stageStart;
  const tailEndOffset = Math.max(
    bodyEndOffset,
    ...hits.map(hit => hit.offsetFrames),
    ...resourceEvents.map(event => event.offsetFrames),
    ...recoveryPauses.map(pause => pause.endOffsetFrames),
  );
  return {
    ...first,
    durationFrames: bodyEndOffset + 1,
    bodyEndOffset,
    tailEndOffset,
    exclusiveFrames: bodyEndOffset,
    cooldownFrames: Math.max(...chain.map(stage => stage.cooldownFrames)),
    allowNext: [],
    commandMappings: [],
    formEvents,
    interruptibleAt: [...new Set(interruptibleAt)].sort((left, right) => left - right),
    hits: hits.sort((left, right) => left.offsetFrames - right.offsetFrames),
    resourceEvents: resourceEvents.sort((left, right) => left.offsetFrames - right.offsetFrames),
    recoveryPauses,
    comboStageSkillIds: chain.map(stage => stage.skillId),
  };
}

function resolveProfile(
  timing: AkeTimingCatalog | undefined,
  input: TimelineInput,
  actor: ActorState,
): AkeTimingSkillProfile {
  const profiles = characterProfiles(timing, input.characterId);
  const candidates = profiles.filter(profile => profile.commandType === input.commandType);
  const explicit = input.skillId
    ? candidates.find(profile => profile.skillId === input.skillId)
    : null;
  const resumedBasic = input.commandType === 'Attack' && actor.basicComboCursor
    ? candidates.find(profile => profile.skillId === actor.basicComboCursor?.nextSkillId)
    : null;
  if (resumedBasic) return withResolution(resumedBasic, 'base-intent');
  const mappedSkillId = actor.active?.profile.commandMappings?.find(mapping => (
    mapping.commandType === input.commandType
  ))?.skillId;
  const mapped = mappedSkillId
    ? candidates.find(profile => profile.skillId === mappedSkillId)
    : null;
  if (mapped) return withResolution(mapped, 'combo-mapping');
  const skillSlot = SKILL_SLOT_BY_COMMAND[input.commandType];
  const activeOverride = [...actor.skillOverrides.values()]
    .filter(override => override.skillSlot === skillSlot)
    .sort((left, right) => right.sequence - left.sequence)[0];
  const overridden = activeOverride
    ? candidates.find(profile => profile.skillId === activeOverride.targetSkillId)
    : null;
  if (overridden) return withResolution(overridden, 'skill-form-override');
  if (input.commandType === 'Attack' && actor.skillModes.size > 0) {
    const modes = [...actor.skillModes.values()]
      .sort((left, right) => right.sequence - left.sequence);
    for (const mode of modes) {
      const token = mode.modeId.toLowerCase()
        .replace(/mode$/i, '')
        .replace(/[^a-z0-9]+/g, '');
      const scored = candidates.map(profile => {
        const normalized = profile.skillId.toLowerCase().replace(/[^a-z0-9]+/g, '');
        let score = 0;
        if (token && normalized.includes(token)) score += 10;
        if (token.includes('ult') && normalized.includes('ult')) score += 8;
        if (/attack0*1_ult|ult_attack0*1/i.test(profile.skillId)) score += 4;
        return { profile, score };
      }).filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score
          || left.profile.variantIndex - right.profile.variantIndex);
      if (scored[0]) return withResolution(scored[0].profile, 'skill-mode');
    }
  }
  const base = explicit?.variantIndex === 0
    ? explicit
    : [...candidates].sort((left, right) => left.variantIndex - right.variantIndex)[0];
  return withResolution(base ?? fallbackProfile(input.commandType), 'base-intent');
}

function resolveIntentProfile(
  timing: AkeTimingCatalog | undefined,
  input: TimelineInput,
  actor: ActorState,
): AkeTimingSkillProfile {
  const resolved = resolveProfile(timing, input, actor);
  return input.commandType === 'Attack'
    ? composeFullAttackProfile(
      characterProfiles(timing, input.characterId),
      resolved,
      actor.basicComboCursor?.remainingStageCount,
    )
    : resolved;
}

function nextAdmission(
  active: AkeRealtimeCommand | null,
  profile: AkeTimingSkillProfile,
  requestedFrame: number,
): { frame: number; reason: string; queued: boolean } | null {
  if (!active || active.actualFrame === null || active.naturalEndFrame === null
    || requestedFrame >= active.naturalEndFrame) {
    return { frame: requestedFrame, reason: 'NO_ACTIVE_SKILL', queued: false };
  }
  if (active.commandType === 'UltimateSkill') {
    return {
      frame: active.naturalEndFrame,
      reason: 'ULTIMATE_NATURAL_END',
      queued: true,
    };
  }
  const currentPriority = active.profile.priority;
  if (profile.priority !== null && currentPriority !== null && profile.priority > currentPriority) {
    return { frame: requestedFrame, reason: 'HIGHER_PRIORITY', queued: false };
  }
  const elapsed = requestedFrame - active.actualFrame;
  const candidates: Array<{ frame: number; reason: string }> = [];
  for (const window of active.profile.allowNext) {
    if (!window.allowedSkillIds.includes(profile.skillId)) continue;
    if (elapsed >= window.startOffsetFrames && elapsed <= window.endOffsetFrames) {
      return { frame: requestedFrame, reason: 'ALLOWED_NEXT', queued: false };
    }
    if (elapsed < window.startOffsetFrames) {
      candidates.push({
        frame: active.actualFrame + window.startOffsetFrames,
        reason: 'ALLOWED_NEXT_WINDOW',
      });
    }
  }
  for (const offset of active.profile.interruptibleAt) {
    if (offset >= elapsed) {
      candidates.push({ frame: active.actualFrame + offset, reason: 'INTERRUPTIBLE_WINDOW' });
    }
  }
  candidates.push({
    frame: active.actualFrame + Math.max(0, active.profile.exclusiveFrames),
    reason: 'EXCLUSIVE_END',
  });
  if (active.naturalEndFrame >= requestedFrame) {
    candidates.push({ frame: active.naturalEndFrame, reason: 'NATURAL_END' });
  }
  const next = candidates
    .filter(candidate => candidate.frame >= requestedFrame)
    .sort((left, right) => left.frame - right.frame)[0];
  if (!next) return null;
  return { ...next, queued: next.frame > requestedFrame };
}

function makeCommand(
  input: TimelineInput,
  profile: AkeTimingSkillProfile,
  tickRate: number,
): AkeRealtimeCommand {
  return {
    preview: true,
    commandId: input.commandId,
    commandType: input.commandType,
    memberId: input.characterId,
    characterId: input.characterId,
    requestedFrame: input.requestedFrame,
    requestedSeconds: input.requestedFrame / tickRate,
    actualFrame: null,
    actualSeconds: null,
    endFrame: null,
    naturalEndFrame: null,
    tailEndFrame: null,
    delayFrames: null,
    state: 'preview-pending',
    status: 'preview-pending',
    success: false,
    queued: false,
    reason: null,
    admissionReason: null,
    skillId: profile.skillId,
    damage: 0,
    poiseDamage: 0,
    hitCount: profile.hits.reduce((sum, hit) => sum + hit.hitCount, 0),
    profile,
    completion: 'open',
    atbBefore: null,
    atbAfter: null,
    atbEligibilityRatio: 1,
    ultimateSpBefore: null,
    ultimateSpAfter: null,
    ultimateSpMax: 0,
    cooldownEndFrame: null,
    releaseVerdict: 'valid',
    releaseReason: 'PENDING',
    resourceLabel: profile.costValue > 0
      ? `${profile.costType === 'Atb' ? '共享技力' : profile.costType === 'UltimateSp' ? '自身能量' : profile.costType ?? '资源'} -${profile.costValue}`
      : '无消耗',
    hits: [],
    selectedBasicAttackStageCount: input.basicAttackStageCount ?? null,
  };
}

function refreshCommandProfile(
  command: AkeRealtimeCommand,
  profile: AkeTimingSkillProfile,
): void {
  command.profile = profile;
  command.skillId = profile.skillId;
  command.hitCount = profile.hits.reduce((sum, hit) => sum + hit.hitCount, 0);
  command.resourceLabel = profile.costValue > 0
    ? `${profile.costType === 'Atb' ? '共享技力' : profile.costType === 'UltimateSp' ? '自身能量' : profile.costType ?? '资源'} -${profile.costValue}`
    : '无消耗';
}

function hitFromProfile(
  command: AkeRealtimeCommand,
  hit: AkeTimingHitProfile,
  index: number,
): AkeRealtimeHit {
  const actualFrame = command.actualFrame ?? command.requestedFrame;
  return {
    id: `${command.commandId}:preview-hit:${index}`,
    commandId: command.commandId,
    characterId: command.characterId ?? '',
    frame: actualFrame + hit.offsetFrames,
    offsetFrames: hit.offsetFrames,
    launchFrame: hit.launchOffsetFrames === null || hit.launchOffsetFrames === undefined
      ? null
      : actualFrame + hit.launchOffsetFrames,
    kind: hit.kind,
    hitCount: hit.hitCount,
    damageTypes: [...hit.damageTypes],
    sourceSkillId: hit.sourceSkillId,
    rootSkillId: hit.rootSkillId,
  };
}

function pruneFutureCommandEvents(
  command: AkeRealtimeCommand,
  frame: number,
  pendingResources: Map<number, PendingResourceEvent[]>,
  pendingHits: Map<number, AkeRealtimeHit[]>,
  pendingForms: Map<number, PendingFormEvent[]>,
) {
  const survivesCancellation = (hit: AkeRealtimeHit) => (
    // Frame events settle before same-frame successor inputs in the preview
    // loop, so an impact exactly on the boundary has already happened.
    hit.frame <= frame
    || hit.kind === 'lingering'
    // Launch and impact are different causal moments. Once the projectile has
    // left the actor, cancelling animation recovery must not erase its later
    // impact from the shared timeline.
    || (hit.launchFrame !== null && hit.launchFrame <= frame)
  );
  command.hits = command.hits.filter(hit => (
    survivesCancellation(hit)
  ));
  command.tailEndFrame = Math.max(
    frame,
    ...command.hits
      .filter(hit => hit.frame >= frame)
      .map(hit => hit.frame),
  );
  for (const [eventFrame, events] of pendingResources) {
    if (eventFrame < frame) continue;
    const remaining = events.filter(event => event.commandId !== command.commandId);
    if (remaining.length > 0) pendingResources.set(eventFrame, remaining);
    else pendingResources.delete(eventFrame);
  }
  for (const [eventFrame, events] of pendingHits) {
    if (eventFrame < frame) continue;
    const remaining = events.filter(event => (
      event.commandId !== command.commandId || survivesCancellation(event)
    ));
    if (remaining.length > 0) pendingHits.set(eventFrame, remaining);
    else pendingHits.delete(eventFrame);
  }
  for (const [eventFrame, events] of pendingForms) {
    if (eventFrame < frame) continue;
    const remaining = events.filter(event => (
      event.commandId !== command.commandId || event.event.operation === 'remove'
    ));
    if (remaining.length > 0) pendingForms.set(eventFrame, remaining);
    else pendingForms.delete(eventFrame);
  }
}

function updateBasicComboCursorAfterInterruption(
  actor: ActorState,
  command: AkeRealtimeCommand,
  frame: number,
  successorCommandType: string | null,
): void {
  if (command.commandType !== 'Attack') return;
  if (successorCommandType === 'UltimateSkill' || successorCommandType === null) {
    actor.basicComboCursor = null;
    return;
  }
  const stages = command.profile.comboStageSkillIds ?? [command.profile.skillId];
  const inferredStageCount = new Set(command.hits
    .filter(hit => (
      hit.frame <= frame
      || (hit.launchFrame !== null && hit.launchFrame <= frame)
    ))
    .map(hit => hit.rootSkillId))
    .size;
  const completedStageCount = Math.max(0, Math.min(
    stages.length,
    command.selectedBasicAttackStageCount ?? inferredStageCount,
  ));
  actor.basicComboCursor = completedStageCount < stages.length
    ? {
      nextSkillId: stages[completedStageCount],
      remainingStageCount: stages.length - completedStageCount,
    }
    : null;
}

function clearNaturallyCompletedActive(actor: ActorState, frame: number): void {
  const active = actor.active;
  if (!active || active.naturalEndFrame === null || frame < active.naturalEndFrame) return;
  if (active.commandType === 'Attack') actor.basicComboCursor = null;
  actor.active = null;
}

type AkeRealtimeTimelineBuildInput = {
  timelineData: TimelineData;
  selectedCharacters: Character[];
  catalog: AkeCatalog | null;
  staffCount: number;
};

function simulateAkeRealtimeTimeline(
  input: AkeRealtimeTimelineBuildInput,
  requestedFrames?: ReadonlyMap<string, number>,
  plannedBlockingEndFrames?: ReadonlyMap<string, number>,
): AkeRealtimeTimeline {
  const timing = input.catalog?.timing;
  const tickRate = timing?.tickRate ?? DEFAULT_TICK_RATE;
  const nodeFrameScale = timing?.nodeFrameScale ?? DEFAULT_NODE_FRAMES;
  const atbConfig = timing?.sharedAtb ?? {
    initial: 300,
    max: 300,
    ratePerSecond: 8,
    firstTickFrame: 1,
    resumeDelayFramesAfterSpend: 16,
    quantization: 'float32',
  };
  const inputs = inputsFromTimeline(
    input.timelineData,
    input.selectedCharacters,
    requestedFrames,
  );
  const firstSourceGroupIndex = inputs.length > 0
    ? Math.min(...inputs.map(item => item.sourceGroupIndex))
    : 0;
  const appliedGroupComboResets = new Set<number>();
  const inputFrames = new Map<number, TimelineInput[]>();
  for (const commandInput of inputs) {
    const entries = inputFrames.get(commandInput.requestedFrame) ?? [];
    entries.push(commandInput);
    inputFrames.set(commandInput.requestedFrame, entries);
  }
  const queuedFrames = new Map<number, ScheduledInput[]>();
  const pendingResources = new Map<number, PendingResourceEvent[]>();
  const pendingHits = new Map<number, AkeRealtimeHit[]>();
  const pendingForms = new Map<number, PendingFormEvent[]>();
  const pauseWindows: Array<{ start: number; end: number; commandId: string }> = [];
  const actors = new Map<string, ActorState>();
  const commands: AkeRealtimeCommand[] = [];
  const commandById = new Map<string, AkeRealtimeCommand>();
  const diagnostics: string[] = [];
  const points: AkeTimelinePoint[] = [];
  const pendingCombos: PendingCombo[] = [];
  const comboWindows: AkeRealtimeComboWindow[] = [];
  const seenComboOccurrences = new Set<string>();
  let comboSequence = 0;
  let formSequence = 0;
  let ordinary = Math.max(0, Math.min(atbConfig.max, atbConfig.initial));
  let returned = 0;
  let recoveryResumeFrame = atbConfig.firstTickFrame;
  const quantize = atbConfig.quantization === 'float32'
    ? (value: number) => Math.fround(value)
    : (value: number) => value;
  const recoveryPerFrame = atbConfig.quantization === 'float32'
    ? Math.fround(atbConfig.ratePerSecond / tickRate)
    : atbConfig.ratePerSecond / tickRate;
  const maxRequestedFrame = Math.max(0, ...inputs.map(command => command.requestedFrame));
  const selectedCharacterIds = new Set(input.selectedCharacters.map(character => character.id));
  const maxProfileTail = Math.max(0, ...Object.entries(timing?.characters ?? {})
    .filter(([characterId]) => selectedCharacterIds.has(characterId))
    .flatMap(([, character]) => character.profiles.flatMap(profile => [
      profile.tailEndOffset,
      ...profile.hits.map(hit => hit.offsetFrames),
      ...profile.resourceEvents.map(event => event.offsetFrames),
      ...(profile.formEvents ?? []).map(event => event.offsetFrames),
    ])));
  const actorQueuedBudgets = new Map<string, number>();
  for (const commandInput of inputs) {
    const possibleProfiles = characterProfiles(timing, commandInput.characterId)
      .filter(profile => profile.commandType === commandInput.commandType);
    const actionBudget = Math.max(
      DEFAULT_NODE_FRAMES,
      ...possibleProfiles.map(profile => Math.max(
        profile.bodyEndOffset,
        profile.exclusiveFrames,
      )),
    );
    actorQueuedBudgets.set(
      commandInput.characterId,
      (actorQueuedBudgets.get(commandInput.characterId) ?? 0) + actionBudget,
    );
  }
  const maxActorQueuedBudget = Math.max(0, ...actorQueuedBudgets.values());
  const durationFrames = Math.max(
    input.staffCount * GRID_NODE_COUNT * nodeFrameScale,
    maxRequestedFrame + maxActorQueuedBudget + maxProfileTail,
  );

  for (const character of input.selectedCharacters) {
    const timingCharacter = timing?.characters[character.id];
    const maximum = Math.max(0, finite(timingCharacter?.maxUltimateSp));
    const configuredInitial = timingCharacter?.initialUltimateSp;
    const initial = Math.max(0, Math.min(
      maximum,
      finite(configuredInitial === undefined ? maximum : configuredInitial),
    ));
    actors.set(character.id, {
      active: null,
      ultimateSp: initial,
      maxUltimateSp: maximum,
      initialUltimateSp: initial,
      ultimateSpPoints: [{
        frame: 0,
        seconds: 0,
        value: initial,
        ordinary: initial,
        returned: 0,
        kind: 'Initialize',
        sourceId: character.id,
        commandId: null,
        requestedDelta: initial,
        actualDelta: initial,
        reason: 'Initialize',
      }],
      cooldowns: new Map(),
      skillOverrides: new Map(),
      skillModes: new Map(),
      basicComboCursor: null,
    });
  }

  const actorFor = (characterId: string): ActorState => {
    const existing = actors.get(characterId);
    if (existing) return existing;
    const created: ActorState = {
      active: null,
      ultimateSp: 0,
      maxUltimateSp: 0,
      initialUltimateSp: 0,
      ultimateSpPoints: [],
      cooldowns: new Map(),
      skillOverrides: new Map(),
      skillModes: new Map(),
      basicComboCursor: null,
    };
    actors.set(characterId, created);
    return created;
  };

  const applyFormEvent = (pending: PendingFormEvent) => {
    const actor = actorFor(pending.characterId);
    const scopedKey = `${pending.commandId}:${pending.event.stateKey}`;
    if (pending.event.operation === 'remove') {
      if (pending.event.kind === 'override') actor.skillOverrides.delete(scopedKey);
      else actor.skillModes.delete(scopedKey);
      return;
    }
    formSequence += 1;
    if (pending.event.kind === 'override'
      && pending.event.skillSlot
      && pending.event.targetSkillId) {
      actor.skillOverrides.set(scopedKey, {
        skillSlot: pending.event.skillSlot,
        targetSkillId: pending.event.targetSkillId,
        sequence: formSequence,
      });
    } else if (pending.event.kind === 'mode' && pending.event.modeId) {
      actor.skillModes.set(scopedKey, {
        modeId: pending.event.modeId,
        sequence: formSequence,
      });
    }
  };

  const point = (frame: number, kind: string, commandId: string | null = null) => {
    points.push({
      frame,
      seconds: frame / tickRate,
      value: ordinary + returned,
      ordinary,
      returned,
      kind,
      sourceId: null,
      commandId,
    });
  };
  point(0, 'Initialize');

  const addAtb = (amount: number, gainMethod: string) => {
    if (amount <= 0) return 0;
    const capacity = Math.max(0, atbConfig.max - ordinary - returned);
    const gained = quantize(Math.min(capacity, amount));
    if (gainMethod.toLowerCase() === 'return') returned = quantize(returned + gained);
    else ordinary = quantize(ordinary + gained);
    return gained;
  };

  const spendAtb = (amount: number) => {
    const returnedSpent = Math.min(returned, amount);
    const ordinarySpent = Math.max(0, amount - returnedSpent);
    returned = quantize(Math.max(0, returned - returnedSpent));
    ordinary = quantize(Math.max(0, ordinary - ordinarySpent));
    return {
      returnedSpent,
      eligibleSpend: ordinarySpent,
      ratio: amount > 0 ? Math.max(0, Math.min(1, ordinarySpent / amount)) : 1,
    };
  };

  const addUltimateSp = (
    targetId: string,
    amount: number,
    frame: number,
    sourceId: string,
    commandId: string,
    reason: string | null,
  ) => {
    const actor = actorFor(targetId);
    const requested = Math.max(0, finite(amount));
    const actual = quantize(Math.min(
      Math.max(0, actor.maxUltimateSp - actor.ultimateSp),
      requested,
    ));
    actor.ultimateSp = quantize(Math.min(actor.maxUltimateSp, actor.ultimateSp + actual));
    actor.ultimateSpPoints.push({
      frame,
      seconds: frame / tickRate,
      value: actor.ultimateSp,
      ordinary: actor.ultimateSp,
      returned: 0,
      kind: 'Gain',
      sourceId,
      commandId,
      requestedDelta: requested,
      actualDelta: actual,
      reason,
    });
  };

  const spendUltimateSp = (
    characterId: string,
    amount: number,
    frame: number,
    commandId: string,
  ) => {
    const actor = actorFor(characterId);
    const spent = quantize(Math.min(actor.ultimateSp, Math.max(0, amount)));
    actor.ultimateSp = quantize(Math.max(0, actor.ultimateSp - spent));
    actor.ultimateSpPoints.push({
      frame,
      seconds: frame / tickRate,
      value: actor.ultimateSp,
      ordinary: actor.ultimateSp,
      returned: 0,
      kind: 'Spend',
      sourceId: characterId,
      commandId,
      requestedDelta: -Math.max(0, amount),
      actualDelta: -spent,
      reason: 'SkillCost',
    });
  };

  const comboRulesFor = (characterId: string, skillId?: string) => (
    (timing?.characters[characterId]?.comboTriggers ?? []).filter(rule => (
      skillId === undefined || rule.comboSkillId === skillId
    ))
  );

  const expireCombos = (frame: number) => {
    for (const pending of pendingCombos) {
      if (pending.state === 'ready' && pending.expireFrame <= frame) {
        pending.state = 'expired';
        pending.reason = 'WINDOW_EXPIRED';
      }
    }
  };

  const createComboWindow = (
    rule: AkeTimingComboTrigger,
    hit: AkeRealtimeHit,
    frame: number,
  ) => {
    const actor = actorFor(hit.characterId);
    const cooldownEnd = actor.cooldowns.get(rule.comboSkillId) ?? 0;
    const id = `combo:${rule.id}:${comboSequence++}`;
    if (rule.requireComboOffCooldown && cooldownEnd > frame) {
      const suppressed: PendingCombo = {
        id,
        ruleId: rule.id,
        characterId: hit.characterId,
        skillId: rule.comboSkillId,
        sourceCommandId: hit.commandId,
        createdFrame: frame,
        expireFrame: frame,
        consumedFrame: null,
        state: 'suppressed',
        reason: 'COOLDOWN_ACTIVE_AT_TRIGGER',
        rule,
      };
      pendingCombos.push(suppressed);
      comboWindows.push(suppressed);
      return;
    }

    const matching = pendingCombos.filter(pending => (
      pending.state === 'ready'
      && pending.characterId === hit.characterId
      && pending.skillId === rule.comboSkillId
    ));
    if (rule.pendingPolicy === 'keep-existing' && matching.length > 0) return;
    if (rule.pendingPolicy === 'refresh-newest' && matching.length > 0) {
      const newest = [...matching].sort((left, right) => (
        right.createdFrame - left.createdFrame || right.id.localeCompare(left.id)
      ))[0];
      newest.createdFrame = frame;
      newest.expireFrame = frame + Math.max(1, rule.pendingDurationFrames) - 1;
      newest.reason = 'WINDOW_REFRESHED';
      return;
    }
    if (rule.pendingPolicy === 'replace-all') {
      for (const pending of matching) {
        pending.state = 'expired';
        pending.reason = 'WINDOW_REPLACED';
      }
    }
    const created: PendingCombo = {
      id,
      ruleId: rule.id,
      characterId: hit.characterId,
      skillId: rule.comboSkillId,
      sourceCommandId: hit.commandId,
      createdFrame: frame,
      expireFrame: frame + Math.max(1, rule.pendingDurationFrames) - 1,
      consumedFrame: null,
      state: 'ready',
      reason: 'TRIGGER_MATCHED',
      rule,
    };
    pendingCombos.push(created);
    comboWindows.push(created);
  };

  const observeHitForCombos = (hit: AkeRealtimeHit, frame: number) => {
    for (const rule of comboRulesFor(hit.characterId)) {
      if (hit.hitCount <= 0) continue;
      if (rule.rootSkillIds.length > 0 && !rule.rootSkillIds.includes(hit.rootSkillId)) continue;
      if (rule.sourceSkillIds.length > 0 && !rule.sourceSkillIds.includes(hit.sourceSkillId)) continue;
      const occurrenceKey = `${rule.id}:${hit.commandId}`;
      if (rule.occurrence === 'first-per-cast' && seenComboOccurrences.has(occurrenceKey)) continue;
      seenComboOccurrences.add(occurrenceKey);
      createComboWindow(rule, hit, frame);
    }
  };

  const selectComboPending = (
    characterId: string,
    skillId: string,
    rules: AkeTimingComboTrigger[],
    frame: number,
  ): PendingCombo | null => {
    const candidates = pendingCombos.filter(pending => (
      pending.state === 'ready'
      && pending.characterId === characterId
      && pending.skillId === skillId
      && pending.expireFrame >= frame
      && rules.some(rule => rule.id === pending.ruleId)
    ));
    const selection = candidates[0]?.rule.selectionPolicy ?? rules[0]?.selectionPolicy ?? 'newest';
    return candidates.sort((left, right) => {
      const direction = selection === 'oldest' ? 1 : -1;
      return direction * (
        left.createdFrame - right.createdFrame || left.id.localeCompare(right.id)
      );
    })[0] ?? null;
  };

  const consumeComboPending = (selected: PendingCombo, frame: number) => {
    const consumed = selected.rule.consumePolicy === 'all-for-owner-and-skill'
      ? pendingCombos.filter(pending => (
        pending.state === 'ready'
        && pending.characterId === selected.characterId
        && pending.skillId === selected.skillId
      ))
      : [selected];
    for (const pending of consumed) {
      pending.state = 'consumed';
      pending.consumedFrame = frame;
      pending.reason = 'CAST_SUCCESS';
    }
  };

  const applyResourceEvent = (event: PendingResourceEvent) => {
    const sourceCommand = commandById.get(event.commandId);
    if (event.resourceType === 'Atb') {
      addAtb(event.amount, event.gainMethod);
      point(event.frame, event.gainMethod === 'Return' ? 'Return' : 'Gain', event.commandId);
      return;
    }
    if (event.resourceType !== 'UltimateSp') {
      diagnostics.push(`${event.commandId}: unsupported preview resource ${event.resourceType}.`);
      return;
    }
    const eligibilityRatio = event.reason === 'ObtainUspInNormalSkill'
      ? sourceCommand?.atbEligibilityRatio ?? 1
      : 1;
    const amount = quantize(event.amount * eligibilityRatio);
    if (event.target === 'team') {
      for (const character of input.selectedCharacters) {
        addUltimateSp(
          character.id,
          amount,
          event.frame,
          event.sourceCharacterId,
          event.commandId,
          event.reason,
        );
      }
      return;
    }
    if (event.target === 'self') {
      addUltimateSp(
        event.sourceCharacterId,
        amount,
        event.frame,
        event.sourceCharacterId,
        event.commandId,
        event.reason,
      );
      return;
    }
    diagnostics.push(`${event.commandId}: unresolved UltimateSp target ${event.target}.`);
  };

  const startCommand = (
    scheduled: ScheduledInput,
    actor: ActorState,
    frame: number,
    admissionReason: string,
    wasQueued: boolean,
  ) => {
    const { command, profile } = scheduled;
    command.actualFrame = frame;
    command.actualSeconds = frame / tickRate;
    command.delayFrames = frame - command.requestedFrame;
    command.queued = wasQueued || frame > command.requestedFrame;
    command.admissionReason = admissionReason;
    command.atbBefore = ordinary + returned;
    command.ultimateSpBefore = actor.ultimateSp;
    command.ultimateSpMax = actor.maxUltimateSp;
    const comboRules = command.commandType === 'ComboSkill'
      ? comboRulesFor(command.characterId ?? '', profile.skillId)
      : [];
    const comboPending = comboRules.length > 0
      ? selectComboPending(command.characterId ?? '', profile.skillId, comboRules, frame)
      : null;
    const cooldownEnd = actor.cooldowns.get(profile.skillId) ?? 0;

    const fail = (state: string, reason: string, releaseReason = reason) => {
      command.state = state;
      command.status = state;
      command.reason = reason;
      command.releaseVerdict = 'invalid';
      command.releaseReason = releaseReason;
      command.completion = 'failed';
      command.atbAfter = ordinary + returned;
      command.ultimateSpAfter = actor.ultimateSp;
      point(frame, 'Rejected', command.commandId);
    };

    if (comboRules.length > 0 && !comboPending) {
      fail('preview-combo-not-ready', 'COMBO_NOT_READY', 'COMBO_TRIGGER_MISSING');
      return;
    }
    if (comboPending && cooldownEnd > frame) {
      fail('preview-cooldown', 'COMBO_NOT_READY', 'COMBO_COOLDOWN_ACTIVE');
      command.cooldownEndFrame = cooldownEnd;
      return;
    }
    if (cooldownEnd > frame) {
      fail('preview-cooldown', 'COOLDOWN_ACTIVE');
      command.cooldownEndFrame = cooldownEnd;
      return;
    }
    if (profile.costType === 'Atb' && profile.costValue > ordinary + returned + 1e-6) {
      fail('preview-insufficient', 'INSUFFICIENT_RESOURCE', 'INSUFFICIENT_ATB');
      return;
    }
    if (profile.costType === 'UltimateSp' && profile.costValue > actor.ultimateSp + 1e-6) {
      fail('preview-insufficient', 'INSUFFICIENT_RESOURCE', 'INSUFFICIENT_ULTIMATE_SP');
      return;
    }
    if (profile.costType === 'Atb' && profile.costValue > 0) {
      const spend = spendAtb(profile.costValue);
      command.atbEligibilityRatio = spend.ratio;
      recoveryResumeFrame = Math.max(
        recoveryResumeFrame,
        frame + atbConfig.resumeDelayFramesAfterSpend,
      );
    }
    if (profile.costType === 'UltimateSp' && profile.costValue > 0) {
      spendUltimateSp(command.characterId ?? '', profile.costValue, frame, command.commandId);
    }
    command.atbAfter = ordinary + returned;
    command.ultimateSpAfter = actor.ultimateSp;
    command.success = true;
    command.state = command.queued ? 'preview-queued-then-executed' : 'preview-executed';
    command.status = command.state;
    command.reason = null;
    const comboUnverified = command.commandType === 'ComboSkill' && comboRules.length === 0;
    command.releaseVerdict = comboUnverified
      ? 'unverified'
      : command.queued ? 'queued' : 'valid';
    command.releaseReason = comboUnverified
      ? 'COMBO_TRIGGER_UNVERIFIED'
      : command.queued ? `QUEUED_${admissionReason}` : 'CAST_ACCEPTED';
    command.naturalEndFrame = frame + Math.max(1, profile.bodyEndOffset);
    command.endFrame = command.naturalEndFrame;
    command.tailEndFrame = frame + Math.max(profile.bodyEndOffset, profile.tailEndOffset);
    command.completion = 'completed';
    command.hits = profile.hits.map((hit, index) => hitFromProfile(command, hit, index));

    if (actor.active && actor.active.commandType !== 'UltimateSkill'
      && actor.active.actualFrame !== null
      && actor.active.naturalEndFrame !== null
      && frame < actor.active.naturalEndFrame) {
      updateBasicComboCursorAfterInterruption(
        actor,
        actor.active,
        frame,
        command.commandType,
      );
      actor.active.endFrame = frame;
      actor.active.completion = 'interrupted';
      pruneFutureCommandEvents(
        actor.active,
        frame,
        pendingResources,
        pendingHits,
        pendingForms,
      );
    }
    if (command.commandType === 'UltimateSkill') actor.basicComboCursor = null;
    actor.active = command;

    if (profile.cooldownFrames > 0) {
      command.cooldownEndFrame = frame + profile.cooldownFrames;
      actor.cooldowns.set(profile.skillId, command.cooldownEndFrame);
    }
    if (comboPending) consumeComboPending(comboPending, frame);
    if (comboUnverified) {
      diagnostics.push(`${command.commandId}: combo trigger rule is not yet verified for ${profile.skillId}.`);
    }

    for (const hit of command.hits) {
      const entries = pendingHits.get(hit.frame) ?? [];
      entries.push(hit);
      pendingHits.set(hit.frame, entries);
    }

    for (const event of profile.resourceEvents) {
      if (event.amount <= 0) continue;
      const eventFrame = frame + event.offsetFrames;
      const pendingEvent: PendingResourceEvent = {
        frame: eventFrame,
        commandId: command.commandId,
        sourceCharacterId: command.characterId ?? '',
        resourceType: event.resourceType,
        target: event.target,
        amount: event.amount,
        gainMethod: event.gainMethod,
        reason: event.reason ?? null,
      };
      if (eventFrame === frame) {
        applyResourceEvent(pendingEvent);
      } else {
        const events = pendingResources.get(eventFrame) ?? [];
        events.push(pendingEvent);
        pendingResources.set(eventFrame, events);
      }
    }
    for (const event of profile.formEvents ?? []) {
      const pending: PendingFormEvent = {
        frame: frame + event.offsetFrames,
        commandId: command.commandId,
        characterId: command.characterId ?? '',
        event,
      };
      if (pending.frame === frame) {
        applyFormEvent(pending);
      } else {
        const events = pendingForms.get(pending.frame) ?? [];
        events.push(pending);
        pendingForms.set(pending.frame, events);
      }
    }
    for (const pause of profile.recoveryPauses) {
      pauseWindows.push({
        start: frame + pause.startOffsetFrames,
        end: frame + pause.endOffsetFrames,
        commandId: command.commandId,
      });
    }
    point(frame, profile.costValue > 0 ? 'Spend' : 'Cast', command.commandId);
    command.atbAfter = ordinary + returned;
    command.ultimateSpAfter = actor.ultimateSp;
  };

  const scheduleInput = (commandInput: TimelineInput, frame: number) => {
    const actor = actorFor(commandInput.characterId);
    clearNaturallyCompletedActive(actor, frame);
    const profile = resolveIntentProfile(timing, commandInput, actor);
    const command = makeCommand(commandInput, profile, tickRate);
    command.atbBefore = ordinary + returned;
    command.atbAfter = ordinary + returned;
    command.ultimateSpBefore = actor.ultimateSp;
    command.ultimateSpAfter = actor.ultimateSp;
    command.ultimateSpMax = actor.maxUltimateSp;
    commands.push(command);
    commandById.set(command.commandId, command);
    if (profile.diagnostic) diagnostics.push(`${commandInput.commandId}: ${profile.diagnostic}`);
    const admission = nextAdmission(actor.active, profile, frame);
    if (!admission) {
      command.state = 'preview-expired';
      command.status = 'preview-expired';
      command.reason = 'QUEUE_WINDOW_EXPIRED';
      command.releaseVerdict = 'invalid';
      command.releaseReason = 'QUEUE_WINDOW_EXPIRED';
      command.completion = 'expired';
      return;
    }
    const scheduled: ScheduledInput = {
      input: commandInput,
      command,
      profile,
      expiresAt: durationFrames,
    };
    if (admission.frame > frame) {
      command.actualFrame = admission.frame;
      command.actualSeconds = admission.frame / tickRate;
      command.delayFrames = admission.frame - command.requestedFrame;
      command.queued = true;
      command.state = 'preview-queued';
      command.status = 'preview-queued';
      command.admissionReason = admission.reason;
      command.releaseVerdict = 'queued';
      command.releaseReason = `QUEUED_${admission.reason}`;
      const queued = queuedFrames.get(admission.frame) ?? [];
      queued.push(scheduled);
      queuedFrames.set(admission.frame, queued);
      return;
    }
    startCommand(scheduled, actor, frame, admission.reason, false);
  };

  const executeQueued = (scheduled: ScheduledInput, frame: number) => {
    const actor = actorFor(scheduled.input.characterId);
    clearNaturallyCompletedActive(actor, frame);
    // A queued button is an intent, not a frozen raw SkillData id. Resolve it
    // again here so modes/overrides created while it waited can transform it.
    scheduled.profile = resolveIntentProfile(timing, scheduled.input, actor);
    refreshCommandProfile(scheduled.command, scheduled.profile);
    const admission = nextAdmission(actor.active, scheduled.profile, frame);
    if (!admission) {
      scheduled.command.actualFrame = null;
      scheduled.command.actualSeconds = null;
      scheduled.command.state = 'preview-expired';
      scheduled.command.status = 'preview-expired';
      scheduled.command.reason = 'QUEUE_WINDOW_EXPIRED';
      scheduled.command.releaseVerdict = 'invalid';
      scheduled.command.releaseReason = 'QUEUE_WINDOW_EXPIRED';
      scheduled.command.completion = 'expired';
      return;
    }
    if (admission.frame > frame && admission.frame <= scheduled.expiresAt) {
      scheduled.command.actualFrame = admission.frame;
      scheduled.command.actualSeconds = admission.frame / tickRate;
      scheduled.command.delayFrames = admission.frame - scheduled.command.requestedFrame;
      scheduled.command.admissionReason = admission.reason;
      const queued = queuedFrames.get(admission.frame) ?? [];
      queued.push(scheduled);
      queuedFrames.set(admission.frame, queued);
      return;
    }
    if (admission.frame > scheduled.expiresAt) {
      scheduled.command.actualFrame = null;
      scheduled.command.actualSeconds = null;
      scheduled.command.state = 'preview-expired';
      scheduled.command.status = 'preview-expired';
      scheduled.command.reason = 'TIMELINE_END';
      scheduled.command.releaseVerdict = 'invalid';
      scheduled.command.releaseReason = 'TIMELINE_END';
      scheduled.command.completion = 'expired';
      return;
    }
    startCommand(scheduled, actor, frame, admission.reason, true);
  };

  for (let frame = 0; frame <= durationFrames; frame += 1) {
    expireCombos(frame);
    for (const actor of actors.values()) {
      clearNaturallyCompletedActive(actor, frame);
    }
    for (const formEvent of pendingForms.get(frame) ?? []) applyFormEvent(formEvent);
    const resourceEvents = pendingResources.get(frame) ?? [];
    for (const event of resourceEvents) applyResourceEvent(event);
    const recoveryPaused = pauseWindows.some(window => frame >= window.start && frame < window.end);
    if (frame >= recoveryResumeFrame && !recoveryPaused && frame >= atbConfig.firstTickFrame) {
      addAtb(recoveryPerFrame, 'Gain');
    }
    for (const hit of pendingHits.get(frame) ?? []) observeHitForCombos(hit, frame);

    const frameEvents: Array<{
      kind: 'queued' | 'input';
      characterId: string;
      sequence: number;
      value: ScheduledInput | TimelineInput;
    }> = [
      ...(queuedFrames.get(frame) ?? []).map(value => ({
        kind: 'queued' as const,
        characterId: value.input.characterId,
        sequence: value.input.sequence,
        value,
      })),
      ...(inputFrames.get(frame) ?? []).map(value => ({
        kind: 'input' as const,
        characterId: value.characterId,
        sequence: value.sequence,
        value,
      })),
    ].sort((left, right) => (
      left.sequence - right.sequence
      || left.characterId.localeCompare(right.characterId)
      || (left.kind === 'queued' ? -1 : 1)
    ));
    for (const event of frameEvents) {
      const eventInput = event.kind === 'queued'
        ? (event.value as ScheduledInput).input
        : event.value as TimelineInput;
      if (eventInput.sourceGroupIndex > firstSourceGroupIndex
        && !appliedGroupComboResets.has(eventInput.sourceGroupIndex)) {
        for (const actor of actors.values()) actor.basicComboCursor = null;
        appliedGroupComboResets.add(eventInput.sourceGroupIndex);
      }
      if (event.kind === 'queued') executeQueued(event.value as ScheduledInput, frame);
      else scheduleInput(event.value as TimelineInput, frame);
    }
    // A full-column group seal is a real cancellation boundary even when no
    // successor starts on this actor at the same frame. Appended successors
    // normally replace the active command inside startCommand; this fallback
    // closes the body when the lane simply ends or the successor is rejected.
    for (const actor of actors.values()) {
      const active = actor.active;
      if (!active || active.actualFrame === null || active.naturalEndFrame === null) continue;
      if (active.commandType === 'UltimateSkill') continue;
      const plannedEnd = plannedBlockingEndFrames?.get(active.commandId);
      if (plannedEnd === undefined
        || frame < plannedEnd
        || plannedEnd >= active.naturalEndFrame) continue;
      active.endFrame = plannedEnd;
      active.completion = 'interrupted';
      pruneFutureCommandEvents(
        active,
        plannedEnd,
        pendingResources,
        pendingHits,
        pendingForms,
      );
      actor.basicComboCursor = null;
      actor.active = null;
    }
    if (resourceEvents.length > 0 || frameEvents.length > 0 || frame % nodeFrameScale === 0) {
      point(frame, resourceEvents.length > 0 ? 'Gain' : 'Sample');
    }
  }

  const hits = commands.flatMap(command => command.hits)
    .sort((left, right) => left.frame - right.frame || left.id.localeCompare(right.id));
  return {
    schemaVersion: 2,
    source: 'precompiled-local-preview',
    tickRate,
    nodeFrameScale,
    durationFrames,
    commands: commands.sort((left, right) => (
      left.requestedFrame - right.requestedFrame
      || String(left.characterId).localeCompare(String(right.characterId))
      || left.commandId.localeCompare(right.commandId)
    )),
    hits,
    sharedAtb: {
      initial: atbConfig.initial,
      max: atbConfig.max,
      final: ordinary + returned,
      points,
    },
    ultimateSpPools: input.selectedCharacters.map(character => {
      const actor = actorFor(character.id);
      return {
        characterId: character.id,
        initial: actor.initialUltimateSp,
        max: actor.maxUltimateSp,
        final: actor.ultimateSp,
        points: actor.ultimateSpPoints,
      };
    }),
    comboWindows,
    sharedVariableRateTimeline: null,
    planningIterations: 0,
    diagnostics,
  };
}

type TimelineActionFacts = {
  durationFrames: number;
  sharedAtbCost: number;
};

function planningActor(timing: AkeTimingCatalog | undefined, characterId: string): ActorState {
  const maximum = Math.max(0, finite(timing?.characters[characterId]?.maxUltimateSp));
  return {
    active: null,
    ultimateSp: maximum,
    maxUltimateSp: maximum,
    initialUltimateSp: maximum,
    ultimateSpPoints: [],
    cooldowns: new Map(),
    skillOverrides: new Map(),
    skillModes: new Map(),
    basicComboCursor: null,
  };
}

function factsFromProfile(
  profile: AkeTimingSkillProfile,
  durationFrames: number,
): TimelineActionFacts {
  return {
    durationFrames: Math.max(1, Math.round(durationFrames)),
    sharedAtbCost: profile.costType === 'Atb'
      ? Math.max(0, finite(profile.costValue))
      : 0,
  };
}

function initialTimelineActionProfiles(
  timing: AkeTimingCatalog | undefined,
  inputs: readonly TimelineInput[],
): Map<string, AkeTimingSkillProfile> {
  const actors = new Map<string, ActorState>();
  const profiles = new Map<string, AkeTimingSkillProfile>();
  for (const timelineInput of inputs) {
    const actor = actors.get(timelineInput.characterId)
      ?? planningActor(timing, timelineInput.characterId);
    actors.set(timelineInput.characterId, actor);
    profiles.set(
      timelineInput.commandId,
      resolveIntentProfile(timing, timelineInput, actor),
    );
  }
  return profiles;
}

function timelineActionProfilesFromSimulation(
  simulation: AkeRealtimeTimeline,
  fallback: ReadonlyMap<string, AkeTimingSkillProfile>,
): Map<string, AkeTimingSkillProfile> {
  const profiles = new Map(fallback);
  for (const command of simulation.commands) {
    profiles.set(command.commandId, command.profile);
  }
  return profiles;
}

/**
 * Resolves the real blocking body from lane relationships. A natural animation
 * end remains available on the profile, but a verified successor window may
 * shorten the blocking body after all mandatory commits plus the input buffer.
 */
function timelineActionFacts(
  inputs: readonly TimelineInput[],
  profiles: ReadonlyMap<string, AkeTimingSkillProfile>,
  tickRate: number,
  timelineModules: readonly SkillButtonData[] = [],
): Map<string, TimelineActionFacts> {
  const facts = new Map<string, TimelineActionFacts>();
  const lanes = new Map<string, TimelineInput[]>();
  for (const timelineInput of inputs) {
    const laneKey = `${timelineInput.sourceGroupIndex}\u0000${timelineInput.characterId}`;
    const entries = lanes.get(laneKey) ?? [];
    entries.push(timelineInput);
    lanes.set(laneKey, entries);
  }
  const debounceFrames = debounceFramesForTickRate(tickRate);
  const forcedCutByActionId = new Map<string, number>();
  timelineModules
    .filter(module => (
      ['operator-switch', 'dodge', 'perfect-dodge'].includes(module.timelineModuleKind ?? '')
      && module.releaseAnchor?.kind === 'damage-hit'
      && module.releaseAnchor.sourceButtonId
    ))
    .forEach((module) => {
      const sourceButtonId = module.releaseAnchor?.sourceButtonId;
      if (!sourceButtonId) return;
      const offset = Math.max(
        1,
        Math.round(module.releaseAnchor?.sourceHitOffsetFrames ?? 0)
          + Math.max(0, Math.round(module.releaseAnchor?.debounceFrames ?? 0)),
      );
      const previous = forcedCutByActionId.get(sourceButtonId);
      forcedCutByActionId.set(sourceButtonId, previous === undefined ? offset : Math.min(previous, offset));
    });
  for (const entries of lanes.values()) {
    const ordered = [...entries].sort((left, right) => (
      left.sourceNodeIndex - right.sourceNodeIndex
      || left.sequence - right.sequence
      || left.commandId.localeCompare(right.commandId)
    ));
    ordered.forEach((timelineInput, index) => {
      const profile = profiles.get(timelineInput.commandId)
        ?? fallbackProfile(timelineInput.commandType);
      const successorInput = ordered[index + 1] ?? null;
      const successorProfile = successorInput
        ? profiles.get(successorInput.commandId)
          ?? fallbackProfile(successorInput.commandType)
        : null;
      const contract = akeProfileToActionTailContract({
        actionId: timelineInput.commandId,
        profile,
      });
      const transition = resolveActionTailTransition({
        predecessor: contract,
        successor: successorInput && successorProfile
          ? akeProfileToTailSuccessor(successorInput.commandId, successorProfile)
          : null,
        boundary: successorInput ? 'append' : 'group-seal',
        debounceFrames,
        selectedBasicStageCount: successorInput
          ? timelineInput.basicAttackStageCount
          : undefined,
      });
      const forcedCut = forcedCutByActionId.get(timelineInput.commandId);
      const blockingEndOffsetFrames = profile.commandType !== 'UltimateSkill'
        && forcedCut !== undefined
        ? Math.min(transition.blockingEndOffsetFrames, forcedCut)
        : transition.blockingEndOffsetFrames;
      facts.set(
        timelineInput.commandId,
        factsFromProfile(profile, blockingEndOffsetFrames),
      );
    });
  }
  return facts;
}

function laneWaitDurationFrames(module: SkillButtonData, tickRate: number): number {
  const config = module.laneWaitConfig ?? { schemaVersion: 1 as const, mode: 'placeholder' as const };
  return config.mode === 'fixed-duration'
    ? Math.max(1, Math.round(config.durationSeconds * tickRate))
    : 0;
}

function timelineReleaseAnchorIssues(
  inputs: readonly TimelineInput[],
  timelineModules: readonly SkillButtonData[],
  tickRate: number,
) {
  const grouped = new Map<number, TimelineInput[]>();
  inputs.forEach((timelineInput) => {
    const entries = grouped.get(timelineInput.sourceGroupIndex) ?? [];
    entries.push(timelineInput);
    grouped.set(timelineInput.sourceGroupIndex, entries);
  });
  const laneControls = timelineModules.filter(module => (
    module.timelineModuleKind === 'lane-wait'
    || module.timelineModuleKind === 'operator-switch'
  ));
  return [...grouped.entries()].flatMap(([sourceGroupIndex, groupInputs]) => {
    const lanes = new Map<string, Array<{
      id: string;
      sourceNodeIndex: number;
      sequence: number;
      durationFrames: number;
      releaseAnchor?: SkillReleaseAnchor;
    }>>();
    groupInputs.forEach((timelineInput) => {
      const entries = lanes.get(timelineInput.characterId) ?? [];
      entries.push({
        id: timelineInput.commandId,
        sourceNodeIndex: timelineInput.sourceNodeIndex,
        sequence: timelineInput.sequence,
        durationFrames: DEFAULT_NODE_FRAMES,
        releaseAnchor: timelineInput.releaseAnchor,
      });
      lanes.set(timelineInput.characterId, entries);
    });
    laneControls
      .filter(module => Math.floor(module.nodeIndex / GRID_NODE_COUNT) === sourceGroupIndex)
      .forEach((module, index) => {
        const laneId = module.characterId ?? `line:${module.staffIndex}`;
        const entries = lanes.get(laneId) ?? [];
        entries.push({
          id: module.id,
          sourceNodeIndex: module.nodeIndex,
          sequence: groupInputs.length + index,
          durationFrames: module.timelineModuleKind === 'lane-wait'
            ? laneWaitDurationFrames(module, tickRate)
            : 0,
          releaseAnchor: module.releaseAnchor,
        });
        lanes.set(laneId, entries);
      });
    return solveReleaseStartOffsets(
      [...lanes.values()].flatMap((entries) => {
        const ordered = [...entries].sort((left, right) => (
          left.sourceNodeIndex - right.sourceNodeIndex
          || left.sequence - right.sequence
          || left.id.localeCompare(right.id)
        ));
        return ordered.map((entry, index) => ({
          id: entry.id,
          durationFrames: entry.durationFrames,
          defaultPredecessorId: ordered[index - 1]?.id,
          releaseAnchor: entry.releaseAnchor,
        }));
      }),
    ).issues;
  });
}

function makeSharedVariableRateTimelineSpec(input: {
  tickRate: number;
  timelineInputs: readonly TimelineInput[];
  timelineModules: readonly SkillButtonData[];
  factsByActionId: ReadonlyMap<string, TimelineActionFacts>;
}): SharedVariableRateTimelineSpec {
  const grouped = new Map<number, TimelineInput[]>();
  for (const timelineInput of input.timelineInputs) {
    const entries = grouped.get(timelineInput.sourceGroupIndex) ?? [];
    entries.push(timelineInput);
    grouped.set(timelineInput.sourceGroupIndex, entries);
  }
  const sourceGroups = [...grouped.entries()]
    .sort(([left], [right]) => left - right);
  const sourceGroupPosition = new Map(
    sourceGroups.map(([sourceGroupIndex], index) => [sourceGroupIndex, index]),
  );
  const sourceGroupByActionId = new Map(
    input.timelineInputs.map(timelineInput => [
      timelineInput.commandId,
      timelineInput.sourceGroupIndex,
    ]),
  );
  const forcedWaitByTargetGroup = new Map<number, SkillButtonData>();
  [...input.timelineModules]
    .filter(module => module.timelineModuleKind === 'forced-wait')
    .sort((left, right) => left.nodeIndex - right.nodeIndex || left.id.localeCompare(right.id))
    .forEach((module) => {
      const moduleGroupIndex = Math.floor(module.nodeIndex / GRID_NODE_COUNT);
      let targetGroupIndex: number | null = null;
      if (module.releaseAnchor?.kind === 'group-start') {
        targetGroupIndex = moduleGroupIndex;
      } else if (module.releaseAnchor?.sourceButtonId) {
        const sourceGroupIndex = sourceGroupByActionId.get(module.releaseAnchor.sourceButtonId);
        const sourcePosition = sourceGroupIndex === undefined
          ? undefined
          : sourceGroupPosition.get(sourceGroupIndex);
        targetGroupIndex = sourcePosition === undefined
          ? null
          : sourceGroups[sourcePosition + 1]?.[0] ?? null;
      }
      if (targetGroupIndex !== null
        && !forcedWaitByTargetGroup.has(targetGroupIndex)) {
        forcedWaitByTargetGroup.set(targetGroupIndex, module);
      }
    });
  const waitSpecForModule = (
    module: SkillButtonData,
  ): NonNullable<SharedVariableRateTimelineSpec['initialWait']> => {
    const config = module.forcedWaitConfig ?? { schemaVersion: 1, mode: 'seal-only' as const };
    if (config.mode === 'fixed-duration') {
      return {
        id: `forced-wait:${module.id}`,
        mode: 'fixed-duration',
        durationFrames: Math.max(1, Math.round(config.durationSeconds * input.tickRate)),
      };
    }
    return { id: `forced-wait:${module.id}`, mode: 'seal-only' };
  };
  const firstSourceGroupIndex = sourceGroups[0]?.[0] ?? null;
  const initialWaitModule = firstSourceGroupIndex === null
    ? null
    : forcedWaitByTargetGroup.get(firstSourceGroupIndex)
      ?? [...input.timelineModules]
        .filter(module => (
          module.timelineModuleKind === 'forced-wait'
          && module.releaseAnchor?.kind === 'group-start'
          && Math.floor(module.nodeIndex / GRID_NODE_COUNT) < firstSourceGroupIndex
        ))
        .sort((left, right) => right.nodeIndex - left.nodeIndex || left.id.localeCompare(right.id))[0]
      ?? null;

  return {
    tickRate: input.tickRate,
    columnWidth: GRID_COLUMN_WIDTH,
    ...(initialWaitModule
      ? { initialWait: waitSpecForModule(initialWaitModule) }
      : {}),
    groups: sourceGroups.map(([sourceGroupIndex, groupInputs], releaseGroupIndex) => {
      const laneInputs = new Map<string, TimelineInput[]>();
      for (const timelineInput of groupInputs) {
        const entries = laneInputs.get(timelineInput.characterId) ?? [];
        entries.push(timelineInput);
        laneInputs.set(timelineInput.characterId, entries);
      }
      const orderedEntriesByLane = new Map(
        [...laneInputs.entries()].map(([laneId, entries]) => [
          laneId,
          [...entries].sort((left, right) => (
            left.sourceNodeIndex - right.sourceNodeIndex
            || left.sequence - right.sequence
            || left.commandId.localeCompare(right.commandId)
          )),
        ]),
      );
      const groupLaneWaits = input.timelineModules.filter(module => (
        module.timelineModuleKind === 'lane-wait'
        && Math.floor(module.nodeIndex / GRID_NODE_COUNT) === sourceGroupIndex
      ));
      const groupOperatorSwitches = input.timelineModules.filter(module => (
        module.timelineModuleKind === 'operator-switch'
        && Math.floor(module.nodeIndex / GRID_NODE_COUNT) === sourceGroupIndex
      ));
      const releaseEntriesByLane = new Map<string, Array<{
        id: string;
        sourceNodeIndex: number;
        sequence: number;
        durationFrames: number;
        releaseAnchor?: SkillReleaseAnchor;
      }>>();
      groupInputs.forEach((timelineInput) => {
        const entries = releaseEntriesByLane.get(timelineInput.characterId) ?? [];
        entries.push({
          id: timelineInput.commandId,
          sourceNodeIndex: timelineInput.sourceNodeIndex,
          sequence: timelineInput.sequence,
          durationFrames: input.factsByActionId.get(timelineInput.commandId)?.durationFrames
            ?? DEFAULT_NODE_FRAMES,
          releaseAnchor: timelineInput.releaseAnchor,
        });
        releaseEntriesByLane.set(timelineInput.characterId, entries);
      });
      groupLaneWaits.forEach((module, index) => {
        const laneId = module.characterId ?? `line:${module.staffIndex}`;
        const entries = releaseEntriesByLane.get(laneId) ?? [];
        entries.push({
          id: module.id,
          sourceNodeIndex: module.nodeIndex,
          sequence: groupInputs.length + index,
          durationFrames: laneWaitDurationFrames(module, input.tickRate),
          releaseAnchor: module.releaseAnchor,
        });
        releaseEntriesByLane.set(laneId, entries);
      });
      groupOperatorSwitches.forEach((module, index) => {
        const laneId = module.characterId ?? `line:${module.staffIndex}`;
        const entries = releaseEntriesByLane.get(laneId) ?? [];
        entries.push({
          id: module.id,
          sourceNodeIndex: module.nodeIndex,
          sequence: groupInputs.length + groupLaneWaits.length + index,
          durationFrames: 0,
          releaseAnchor: module.releaseAnchor,
        });
        releaseEntriesByLane.set(laneId, entries);
      });
      const releaseNodes = [...releaseEntriesByLane.values()].flatMap(entries => {
        const ordered = [...entries].sort((left, right) => (
          left.sourceNodeIndex - right.sourceNodeIndex
          || left.sequence - right.sequence
          || left.id.localeCompare(right.id)
        ));
        return ordered.map((entry, index) => ({
          id: entry.id,
          durationFrames: entry.durationFrames,
          defaultPredecessorId: ordered[index - 1]?.id,
          releaseAnchor: entry.releaseAnchor,
        }));
      });
      const releaseOffsets = solveReleaseStartOffsets(releaseNodes).offsets;
      const lanes = [...laneInputs.entries()]
        .sort(([, leftEntries], [, rightEntries]) => (
          Math.min(...leftEntries.map(entry => entry.sequence))
          - Math.min(...rightEntries.map(entry => entry.sequence))
        ))
        .map(([laneId]) => ({
          laneId,
          actions: (orderedEntriesByLane.get(laneId) ?? [])
            .map((timelineInput) => {
              const facts = input.factsByActionId.get(timelineInput.commandId) ?? {
                durationFrames: DEFAULT_NODE_FRAMES,
                sharedAtbCost: 0,
              };
              return {
                id: timelineInput.commandId,
                durationFrames: facts.durationFrames,
                startOffsetFrames: releaseOffsets.get(timelineInput.commandId) ?? 0,
                sharedAtbCost: facts.sharedAtbCost,
                payload: {
                  characterId: timelineInput.characterId,
                  commandType: timelineInput.commandType,
                  skillType: Object.entries(COMMAND_TYPE_BY_BUTTON)
                    .find(([, commandType]) => commandType === timelineInput.commandType)?.[0],
                  sourceGroupIndex,
                  sourceNodeIndex: timelineInput.sourceNodeIndex,
                  releaseAnchor: timelineInput.releaseAnchor,
                },
              };
            }),
        }));
      return {
        id: `release-group:${sourceGroupIndex}`,
        separatorBefore: releaseGroupIndex === 0
          ? undefined
          : forcedWaitByTargetGroup.has(sourceGroupIndex)
            ? waitSpecForModule(forcedWaitByTargetGroup.get(sourceGroupIndex) as SkillButtonData)
            : { id: `legacy-seal:${sourceGroupIndex}`, mode: 'seal-only' as const },
        laneWaits: groupLaneWaits.map(module => ({
          id: module.id,
          laneId: module.characterId ?? `line:${module.staffIndex}`,
          startOffsetFrames: releaseOffsets.get(module.id) ?? 0,
          durationFrames: laneWaitDurationFrames(module, input.tickRate),
        })),
        operatorSwitches: groupOperatorSwitches.map(module => ({
          id: module.id,
          laneId: module.characterId ?? `line:${module.staffIndex}`,
          targetLaneId: module.operatorSwitchConfig?.targetCharacterId
            ?? `missing-switch-target:${module.id}`,
          startOffsetFrames: releaseOffsets.get(module.id) ?? 0,
        })),
        lanes,
      };
    }),
  };
}

function planSignature(model: SharedVariableRateTimelineModel): string {
  return model.actions.map(action => (
    `${action.id}:${action.startFrame}:${action.endFrame}:${action.durationFrames}`
  )).join('|');
}

function requestedFramesFromPlan(
  model: SharedVariableRateTimelineModel,
): Map<string, number> {
  return new Map(model.actions.map(action => [action.id, action.startFrame]));
}

function blockingEndFramesFromPlan(
  model: SharedVariableRateTimelineModel,
): Map<string, number> {
  return new Map(model.actions.map(action => [action.id, action.endFrame]));
}

function validateRuntimeCohort(
  cohort: ReleaseCohortDraft,
  simulation: AkeRealtimeTimeline,
) {
  const commandsById = new Map(simulation.commands.map(command => [command.commandId, command]));
  const commands = cohort.actionIds.map(actionId => commandsById.get(actionId));
  const missing = cohort.actionIds.filter((_, index) => !commands[index]);
  if (missing.length > 0) {
    return {
      allowed: false,
      status: 'invalid' as const,
      reason: `RUNTIME_COMMAND_MISSING:${missing.join(',')}`,
    };
  }
  const resolved = commands.filter((command): command is AkeRealtimeCommand => Boolean(command));
  const invalid = resolved.find(command => (
    !command.success
    || command.actualFrame !== cohort.frame
    || command.queued
    || command.releaseVerdict === 'invalid'
  ));
  const availableSharedAtb = Math.max(
    0,
    ...resolved.map(command => finite(command.atbBefore)),
  );
  if (invalid) {
    return {
      allowed: false,
      status: 'invalid' as const,
      reason: invalid.releaseReason || invalid.reason || 'RUNTIME_REJECTED',
      availableSharedAtb,
    };
  }
  const unverified = resolved.find(command => command.releaseVerdict === 'unverified');
  if (unverified) {
    return {
      allowed: false,
      status: 'unverified' as const,
      reason: unverified.releaseReason || 'RUNTIME_RULE_UNVERIFIED',
      availableSharedAtb,
    };
  }
  return {
    allowed: true,
    status: 'valid' as const,
    reason: 'RUNTIME_CONFIRMED',
    availableSharedAtb,
  };
}

function validateDodgeControlModules(
  modules: readonly SkillButtonData[],
  model: SharedVariableRateTimelineModel,
  initialControllerLaneId: string | undefined,
): Array<{ code: string; message: string }> {
  const actionsById = new Map(model.actions.map(action => [action.id, action]));
  const switchesById = new Map(model.operatorSwitches.map(operatorSwitch => [operatorSwitch.id, operatorSwitch]));
  return modules
    .filter(module => (
      module.timelineModuleKind === 'dodge'
      || module.timelineModuleKind === 'perfect-dodge'
    ))
    .flatMap((module) => {
      const anchor = module.releaseAnchor;
      if (!anchor) {
        return [{ code: 'DODGE_ANCHOR_MISSING', message: `${module.id}: 闪避缺少释放锚点。` }];
      }
      const sourceAction = anchor.sourceButtonId ? actionsById.get(anchor.sourceButtonId) : undefined;
      const sourceSwitch = anchor.sourceButtonId ? switchesById.get(anchor.sourceButtonId) : undefined;
      let frame: number | null = null;
      let x: number | null = null;
      if (anchor.kind === 'group-start') {
        const group = model.groups.find(candidate => model.actions.some(action => {
          const payload = action.payload as { sourceGroupIndex?: number } | undefined;
          return action.groupId === candidate.id
            && payload?.sourceGroupIndex === Math.floor(module.nodeIndex / GRID_NODE_COUNT);
        }));
        frame = group?.startFrame ?? null;
        x = group?.xStart ?? null;
      } else if (sourceAction) {
        if (anchor.kind === 'action-start') {
          frame = sourceAction.startFrame + anchor.debounceFrames;
          x = sourceAction.startX;
        } else if (anchor.kind === 'action-end') {
          frame = sourceAction.endFrame + anchor.debounceFrames;
          x = sourceAction.endX;
        } else if (Number.isFinite(anchor.sourceHitOffsetFrames)) {
          frame = sourceAction.startFrame
            + Number(anchor.sourceHitOffsetFrames)
            + anchor.debounceFrames;
          x = projectSharedTimelineFrame(model, frame, 'after');
        }
      } else if (sourceSwitch && anchor.kind === 'action-end') {
        frame = sourceSwitch.endFrame + anchor.debounceFrames;
        x = sourceSwitch.endX;
      }
      if (frame === null || x === null) {
        return [{ code: 'DODGE_ANCHOR_UNRESOLVED', message: `${module.id}: 无法解析闪避释放位置。` }];
      }
      const issues: Array<{ code: string; message: string }> = [];
      const controlled = controlledOperatorAt(
        initialControllerLaneId,
        model.operatorSwitches,
        frame,
        x,
      );
      const sourceLaneId = module.characterId ?? `line:${module.staffIndex}`;
      if (controlled !== sourceLaneId) {
        issues.push({
          code: 'DODGE_SOURCE_NOT_CONTROLLED',
          message: `${module.id}: 只有当前主控干员 ${controlled ?? '未知'} 可以闪避。`,
        });
      }
      if (isFrameInsideUltimate(model.actions, frame)) {
        issues.push({
          code: 'DODGE_DURING_ULTIMATE',
          message: `${module.id}: 终结技完整动画期间不能用闪避打断。`,
        });
      }
      return issues;
    });
}

/**
 * Resolves relationship time before asking the local AKE state machine to run.
 * Stateful skill forms can change blocking duration, so the planner and the
 * runtime are iterated with a small deterministic cap until both agree.
 */
export function buildAkeRealtimeTimeline(
  input: AkeRealtimeTimelineBuildInput,
): AkeRealtimeTimeline {
  const timing = input.catalog?.timing;
  const tickRate = timing?.tickRate ?? DEFAULT_TICK_RATE;
  const timelineInputs = inputsFromTimeline(
    input.timelineData,
    input.selectedCharacters,
  );
  const timelineModules = input.timelineData.staffLines.flatMap(line => (
    line.buttons.filter(button => button.timelineModuleKind)
  ));
  const unresolvedTimelineModules = timelineModules.filter(module => (
    module.timelineModuleKind !== 'forced-wait'
    && module.timelineModuleKind !== 'lane-wait'
    && module.timelineModuleKind !== 'operator-switch'
  ));
  if (timelineInputs.length === 0) {
    const emptySimulation = simulateAkeRealtimeTimeline(input);
    if (unresolvedTimelineModules.length === 0) return emptySimulation;
    return {
      ...emptySimulation,
      diagnostics: [
        ...emptySimulation.diagnostics,
        ...unresolvedTimelineModules.map(module => (
          `TIMELINE_MODULE_RUNTIME_REQUIRED: ${module.timelineModuleKind}:${module.id}`
        )),
      ],
    };
  }

  let profiles = initialTimelineActionProfiles(timing, timelineInputs);
  const releaseAnchorIssues = timelineReleaseAnchorIssues(timelineInputs, timelineModules, tickRate);
  let facts = timelineActionFacts(timelineInputs, profiles, tickRate, timelineModules);
  let spec = makeSharedVariableRateTimelineSpec({
    tickRate,
    timelineInputs,
    timelineModules,
    factsByActionId: facts,
  });
  let plan = buildSharedVariableRateTimeline(spec);
  let simulation: AkeRealtimeTimeline | null = null;
  let planningIterations = 0;
  let stabilized = false;
  const maximumIterations = 6;

  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    planningIterations = iteration;
    simulation = simulateAkeRealtimeTimeline(
      input,
      requestedFramesFromPlan(plan),
      blockingEndFramesFromPlan(plan),
    );
    profiles = timelineActionProfilesFromSimulation(simulation, profiles);
    facts = timelineActionFacts(timelineInputs, profiles, tickRate, timelineModules);
    const nextSpec = makeSharedVariableRateTimelineSpec({
      tickRate,
      timelineInputs,
      timelineModules,
      factsByActionId: facts,
    });
    const nextPlan = buildSharedVariableRateTimeline(nextSpec);
    if (planSignature(nextPlan) === planSignature(plan)) {
      spec = nextSpec;
      plan = nextPlan;
      stabilized = true;
      break;
    }
    spec = nextSpec;
    plan = nextPlan;
  }

  if (!simulation || !stabilized) {
    planningIterations += 1;
    simulation = simulateAkeRealtimeTimeline(
      input,
      requestedFramesFromPlan(plan),
      blockingEndFramesFromPlan(plan),
    );
  }

  const validatedPlan = buildSharedVariableRateTimeline(spec, {
    validateReleaseCohort: (cohort) => {
      const structuralIssue = releaseAnchorIssues.find(issue => (
        cohort.actionIds.includes(issue.buttonId)
        || Boolean(issue.sourceButtonId && cohort.actionIds.includes(issue.sourceButtonId))
      ));
      if (structuralIssue) {
        return {
          allowed: false,
          status: 'invalid' as const,
          reason: `RELEASE_ANCHOR_${structuralIssue.code}`,
        };
      }
      return validateRuntimeCohort(cohort, simulation as AkeRealtimeTimeline);
    },
  });
  const operatorControlIssues = validateOperatorControlTimeline(
    validatedPlan,
    input.selectedCharacters[0]?.id,
    new Set(input.selectedCharacters.map(character => character.id)),
  );
  const dodgeControlIssues = validateDodgeControlModules(
    timelineModules,
    validatedPlan,
    input.selectedCharacters[0]?.id,
  );
  const controlValidatedPlan = operatorControlIssues.length > 0 || dodgeControlIssues.length > 0
    ? {
      ...validatedPlan,
      admissionStatus: 'invalid' as const,
      isExecutable: false,
    }
    : validatedPlan;
  const diagnostics = [...simulation.diagnostics];
  diagnostics.push(...releaseAnchorIssues.map(issue => (
    `${issue.code}: ${issue.message}`
  )));
  diagnostics.push(...operatorControlIssues.map(issue => (
    `${issue.code}: ${issue.message}`
  )));
  diagnostics.push(...dodgeControlIssues.map(issue => (
    `${issue.code}: ${issue.message}`
  )));
  if (!stabilized) {
    diagnostics.push(
      `Variable-rate planner did not stabilize within ${maximumIterations} iterations; the final runtime verdict remains authoritative.`,
    );
  }
  const hasUnresolvedTimelineModules = unresolvedTimelineModules.length > 0;
  const exposedPlan = hasUnresolvedTimelineModules
    ? {
      ...controlValidatedPlan,
      admissionStatus: controlValidatedPlan.admissionStatus === 'invalid'
        ? 'invalid' as const
        : 'unverified' as const,
      isExecutable: false,
    }
    : controlValidatedPlan;
  diagnostics.push(...unresolvedTimelineModules.map(module => (
    `TIMELINE_MODULE_RUNTIME_REQUIRED: ${module.timelineModuleKind}:${module.id}`
  )));
  return {
    ...simulation,
    durationFrames: Math.max(simulation.durationFrames, exposedPlan.endFrame),
    sharedVariableRateTimeline: exposedPlan,
    planningIterations,
    diagnostics,
  };
}
