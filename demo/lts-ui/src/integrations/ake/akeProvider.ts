import type { RdpsAttributionSummary } from '../../core/services/rdpsAttribution.types';
import type { AkeRdpsAudit } from '../../../../../src/core/ake-rdps-context.mjs';
import { getTimelineSessionSnapshot } from '../../agentKernel/timelineRepository/timelineSession';
import { buildAkeExecutionDigest, resolveAkeCalculationEndFrame } from './akeExecutionIdentity';
export { resolveAkeCalculationEndFrame } from './akeExecutionIdentity';
import type { ConfigSnapshot } from '../../core/calculators/operatorPanelCalculator';
import { persistentLocalStorage } from '../../platform/storage/persistentStorage';
import type { Character, SkillButtonData, TimelineData } from '../../types';
import { getOperatorConfigPageCache, safeSessionStorage } from '../../utils/storage';
import { getInstalledAkeCatalog, type AkeCatalog } from './akeCatalogAdapter';
import {
  buildAkeRealtimeTimeline,
  type AkeRealtimeTimeline,
} from './akeRealtimeTimeline';
import { GRID_NODE_COUNT } from '../../core/calculators/gridSnapLayout';
import { resolveInitialControllerLaneId } from '../../core/domain/operatorControlTimeline';
import {
  configuredRiaUiActionSink,
  type RiaUiActionSink,
} from './riaUiActionSink';

export const AKE_REPORT_STORAGE_KEY = 'def.ake-demo.latest-report.v3';
export const AKE_REPORT_UPDATED_EVENT = 'def:ake-report-updated';
const WEAPON_LIBRARY_STORAGE_KEY = 'def.weapon-sheet.library.v1';
const DEFAULT_ENEMY_ID = 'eny_0007_mimicw';

/** Export semantic relationships without baking a preview frame into the input. */
export function resolveAkeReleaseDependency(
  button: Pick<SkillButtonData, 'releaseAnchor'>,
  preview: {
    commands: ReadonlyArray<{
      commandId: string;
      commandType: string;
      profile: { hits: ReadonlyArray<Pick<AkeRealtimeTimeline['commands'][number]['profile']['hits'][number],
        'kind' | 'releaseEligible' | 'offsetFrames' | 'sourceSkillId' | 'sourceTimelineFrame'>> };
    }>;
    sharedVariableRateTimeline: Pick<NonNullable<AkeRealtimeTimeline['sharedVariableRateTimeline']>,
      'operatorSwitches'> | null;
  },
) {
  const anchor = button.releaseAnchor;
  if (!anchor?.sourceButtonId || anchor.kind === 'group-start') return undefined;
  const source = preview.commands.find(command => command.commandId === anchor.sourceButtonId);
  const sourceSwitch = preview.sharedVariableRateTimeline?.operatorSwitches
    .find(change => change.id === anchor.sourceButtonId);
  if (!source && !sourceSwitch) return undefined;
  const delayFrames = Math.max(0, Math.round(anchor.debounceFrames ?? 0));
  const identity = { sourceCommandId: anchor.sourceButtonId, delayFrames };
  if (anchor.kind === 'action-start' || anchor.kind === 'action-end') {
    return { kind: anchor.kind, ...identity };
  }
  if (!source) return undefined;
  if (anchor.kind === 'timed-input') {
    const sourceOffsetFrames = anchor.sourceTimedInputOffsetFrames;
    if (!Number.isInteger(sourceOffsetFrames) || Number(sourceOffsetFrames) < 0) return undefined;
    return { kind: 'timed-input', ...identity, sourceOffsetFrames,
      ...(anchor.sourceTimedInputKind ? {
        windowKind: anchor.sourceTimedInputKind,
        sourceSkillId: anchor.sourceTimedInputSkillId,
        windowStartOffsetFrames: anchor.sourceTimedInputStartOffsetFrames,
        windowEndOffsetFramesExclusive: anchor.sourceTimedInputEndOffsetFramesExclusive,
      } : {}),
    };
  }
  if (anchor.kind !== 'damage-hit' || source.commandType === 'UltimateSkill') return undefined;
  // Keep the existing release policy: tails and unverified Q hit ports are not
  // opened by the magnifier. Stable skill/timeline coordinates survive reruns.
  const hit = source.profile.hits.find((candidate, index) => (
    (!anchor.sourceHitId || anchor.sourceHitId === `${source.commandId}:preview-hit:${index}`)
    && candidate.kind !== 'lingering' && candidate.releaseEligible !== false
    && Math.round(candidate.offsetFrames) === Math.round(anchor.sourceHitOffsetFrames ?? -1)
  ));
  return hit ? { kind: 'damage-hit', ...identity, sourceSkillId: hit.sourceSkillId,
    sourceTimelineFrame: Math.round(hit.sourceTimelineFrame ?? hit.offsetFrames) } : undefined;
}

const COMMAND_TYPE_BY_SKILL: Record<string, string> = {
  A: 'Attack',
  B: 'NormalSkill',
  E: 'ComboSkill',
  Q: 'UltimateSkill',
};

type WeaponLibraryItem = { id?: string; name?: string };

export type AkeCommandSettlement = {
  attackMode?: 'full-combo' | 'plunging-impact' | null;
  commandId: string;
  commandType: string;
  memberId: string | null;
  characterId: string | null;
  requestedFrame: number;
  requestedSeconds: number;
  actualFrame: number | null;
  actualSeconds: number | null;
  endFrame: number | null;
  completion?: string | null;
  delayFrames: number | null;
  state: string;
  status?: string;
  success: boolean;
  queued: boolean;
  reason: string | null;
  admissionReason?: string | null;
  skillId: string | null;
  castId?: string | null;
  executedSkillIds?: string[];
  effectiveSkillTypes?: string[];
  damage: number;
  poiseDamage: number;
  hitCount: number;
};

export type AkeRuntimeModifierContribution = {
  contributionId?: string | null;
  semanticKey?: string | null;
  buffInstanceId?: string | null;
  buffId?: string | null;
  sourceKey?: string | null;
  sourceType?: string | null;
  sourceCategory?: string | null;
  sourceId?: string | null;
  ownerId?: string | null;
  carrierId?: string | null;
  targetId?: string | null;
  damageSourceId?: string | null;
  sourceSkillId?: string | null;
  type?: string | null;
  operation?: string | null;
  rawField?: string | null;
  rawValue?: unknown;
  resolvedValue?: number | null;
  value?: number | null;
  scale?: number | null;
  [key: string]: unknown;
};

export type AkeRuntimeDamageFactor = {
  factorId: string;
  semanticKey: string;
  displayName: string;
  operation: string;
  rawValue: unknown;
  additive?: number | null;
  multiplier: number;
  finalValue: number;
  affectsNonCritical?: boolean;
  evidenceStatus?: string;
  contributions: AkeRuntimeModifierContribution[];
};

export type AkeRuntimeDiagnostic = {
  eventId?: string | null;
  sequence?: number | null;
  frame?: number | null;
  stage?: string | null;
  actionType?: string | null;
  status?: string | null;
  code?: string | null;
  sourceId?: string | null;
  ownerId?: string | null;
  carrierId?: string | null;
  targetId?: string | null;
  damageSourceId?: string | null;
  skillId?: string | null;
  castId?: string | null;
  transactionId?: string | null;
  parentEventId?: string | null;
};

export type AkeRuntimeZoneSnapshot = {
  scale?: number;
  zones?: Array<{
    zoneName?: string | null;
    addition?: number | null;
    scale?: number | null;
  }>;
  contributions?: AkeRuntimeModifierContribution[];
  [key: string]: unknown;
};

export type AkeRuntimeAttributeSnapshot = {
  targetId: string | null;
  attribute: string;
  baseValue?: number;
  baseValueBeforeActiveSources?: number;
  baseEvaluation?: {
    rawValue?: number;
    afterBase?: number;
    afterBaseFinal?: number;
    afterRuntime?: number;
    value?: number;
    [key: string]: unknown;
  };
  evaluation?: {
    rawValue?: number;
    afterBase?: number;
    afterBaseFinal?: number;
    afterRuntime?: number;
    value?: number;
    [key: string]: unknown;
  };
  contributions?: Array<AkeRuntimeModifierContribution & {
    attribute?: string | null;
    zone?: string | null;
    appliedFrame?: number | null;
  }>;
  [key: string]: unknown;
};

export type AkeRuntimeConsumedStatus = {
  key: string;
  stateType: string;
  buffId: string;
  applicationScope: string;
  frame: number;
  consumerId: string | null;
  targetId: string | null;
  skillId: string | null;
  rootSkillId: string | null;
  castId: string;
  rootCastId?: string | null;
  parentCastId?: string | null;
  inputSkillId?: string | null;
  inputCommandType?: string | null;
  executedSkillId?: string | null;
  effectiveSkillType?: string | null;
  commandType: string | null;
  skillType: string | null;
  consumedStacks: number;
  maxStacks: number;
  sourceStacks: Array<{ sourceId: string | null; count: number }>;
  grantIds: Array<string | number>;
  replicatedTargetIds: Array<string | number>;
};

export type AkeRuntimeHit = {
  /** Causal input is separate from the actor and cast that own the damage. */
  triggerCastId?: string | null;
  triggerRootCastId?: string | null;
  triggerSourceId?: string | null;
  triggerSkillId?: string | null;
  triggerFrame?: number | null;
  /** Last status-event sequence visible before damage calculation; not the hit sequence. */
  statusEventSequenceBeforeHit?: number | null;
  hitId?: string;
  sequence?: number;
  parentTransactionId?: string | null;
  parentEventId?: string | null;
  parentHitId?: string | null;
  hitEventPhase?: 'before' | 'after' | null;
  sourceMetadata?: Record<string, unknown>;
  hitIndex: number;
  traceIndex: number | null;
  frame: number;
  memberId: string | null;
  characterId: string | null;
  sourceId: string | null;
  ownerId: string | null;
  carrierId?: string | null;
  targetId: string | null;
  damageSourceId?: string | null;
  castId: string | null;
  rootCastId?: string | null;
  parentCastId?: string | null;
  inputSkillId?: string | null;
  inputCommandType?: string | null;
  effectiveSkillType?: string | null;
  skillId: string | null;
  rootSkillId: string | null;
  buffInstanceId: string | null;
  sourceBuffInstanceId?: string | null;
  sourceBuffId: string | null;
  semanticHitType?: string | null;
  displayName?: string | null;
  reason: string | null;
  sourcePath: string | null;
  damageUnitIndex: number | null;
  damageType: string | null;
  damageAttributeType: string | null;
  damageDecorateMask: number;
  damageTypeMask: number | string | null;
  atkScale: number;
  rawDamage: number;
  finalDamage: number;
  nonCriticalDamage: number;
  criticalDamage: number;
  expectedDamage: number;
  poiseDamage: number;
  targetHpBefore: number | null;
  targetHpAfter: number | null;
  modifierSnapshot: {
    attackAttribute?: AkeRuntimeAttributeSnapshot | null;
    attackerZone?: AkeRuntimeZoneSnapshot;
    defenderZone?: AkeRuntimeZoneSnapshot;
    configuredBonus?: number;
    configuredDamageBonusScale?: number;
    specialScale?: number;
    [key: string]: unknown;
  };
  operands: Record<string, number>;
  consumedStatuses?: AkeRuntimeConsumedStatus[];
  factors?: AkeRuntimeDamageFactor[];
  factorValidation?: {
    reconstructedNonCritical: number;
    expectedNonCritical: number;
    delta: number;
    valid: boolean;
  } | null;
  diagnostics?: Array<Record<string, unknown>>;
  confidence?: string;
};

export type AkePanelAbilityTrace = {
  label: string;
  rawValue: number;
  statScale: number;
  allStatScale: number;
  valueBeforeRounding: number;
  finalValue: number;
  attackCoefficient: number;
  attackBonus: number;
};

export type AkePanelAttackTrace = {
  characterAttack: number;
  weaponAttack: number;
  attackPercent: number;
  flatAttack: number;
  baseAttack: number;
  panelAttack: number;
  abilityBonus: number;
  mainAbility?: AkePanelAbilityTrace;
  subAbility?: AkePanelAbilityTrace;
};

export type AkeRuntimeStatusEvent = {
  eventId?: string | null;
  sequence?: number;
  traceIndex: number;
  frame: number;
  stage: string;
  instanceId: string | null;
  buffId: string;
  sourceId: string | null;
  ownerId: string | null;
  carrierId?: string | null;
  targetId: string | null;
  damageSourceId?: string | null;
  transactionId?: string | null;
  parentEventId?: string | null;
  parentHitId?: string | null;
  hitEventPhase?: 'before' | 'after' | null;
  sourceMetadata?: Record<string, unknown>;
  stackCount: number | null;
  before: number | null;
  requested: number | null;
  actual: number | null;
  consumedStacks?: number | null;
  consumption?: boolean;
  consumerId?: string | null;
  consumeKind?: string | null;
  triggerCommandType?: string | null;
  triggerSkillType?: string | null;
  bySource?: Array<{ sourceId?: string | null; ownerId?: string | null; count?: number }>;
  discarded: number | null;
  after: number | null;
  durationFrames: number | null;
  expireFrame: number | null;
  sourceSkillId: string | null;
  rootSkillId: string | null;
  castId: string | null;
  rootCastId?: string | null;
  parentCastId?: string | null;
  inputSkillId?: string | null;
  inputCommandType?: string | null;
  effectiveSkillType?: string | null;
  triggerSourceId: string | null;
  triggerOwnerId: string | null;
  triggerTargetId: string | null;
  triggerSkillId: string | null;
  triggerRootSkillId: string | null;
  triggerInputSkillId?: string | null;
  triggerCastId: string | null;
  triggerRootCastId?: string | null;
  triggerParentCastId?: string | null;
  triggerInputCommandType?: string | null;
  triggerEffectiveSkillType?: string | null;
  reason: string | null;
  displayName?: string | null;
  shortName?: string | null;
  effectType?: string | null;
  applicationScope?: string | null;
  description?: string | null;
  iconId?: string | null;
  iconUrl?: string | null;
  displayable?: boolean;
  displayChannels?: string[];
  abnormalColorType?: string | null;
  hidden?: boolean;
  presentationSource?: string | null;
};

export type AkeTeamComboLedgerEvent = {
  eventId: string;
  frame: number;
  sequence: number;
  type: 'grant' | 'consume' | 'refresh' | 'expire' | 'remove';
  buffId: string;
  sourceId: string | null;
  consumerId: string | null;
  inputSkillId: string | null;
  inputCommandType: string | null;
  executedSkillId: string | null;
  effectiveSkillType: string | null;
  castId: string | null;
  rootCastId: string | null;
  parentCastId: string | null;
  grantIds: Array<string | number>;
  instanceIds: Array<string | number>;
  targetIds: Array<string | number>;
  beforeStacks: number;
  deltaStacks: number;
  afterStacks: number;
  reason: string | null;
  sourceEventIds: string[];
  consumptionSnapshot: AkeRuntimeConsumedStatus | null;
};

export type AkeTeamComboLedger = {
  schemaVersion: 1;
  buffId: string;
  settlements: Array<{
    frame: number;
    sequence: number;
    memberId: string | null;
    characterId: string | null;
    commandId: string | null;
    rootCastId: string | null;
    castId: string | null;
    parentCastId: string | null;
    inputSkillId: string | null;
    inputCommandType: string | null;
    executedSkillId: string | null;
    effectiveSkillType: string | null;
    eligible: boolean;
    consumptionStatus: string;
    consumedStacks: number;
    grantIds: Array<string | number>;
  }>;
  events: AkeTeamComboLedgerEvent[];
  hits: Array<{
    hitId: string | null;
    frame: number;
    sequence: number;
    castId: string | null;
    rootCastId: string | null;
    parentCastId: string | null;
    inputSkillId: string | null;
    inputCommandType: string | null;
    executedSkillId: string | null;
    effectiveSkillType: string | null;
    damageAttributeType: string | null;
    consumptionSnapshots: AkeRuntimeConsumedStatus[];
  }>;
};

export type AkeTimelinePoint = {
  frame: number;
  seconds: number;
  value: number;
  ordinary: number;
  returned: number;
  kind: string;
  sourceId: string | null;
  commandId?: string | null;
  castId?: string | null;
  skillId?: string | null;
};

export type AkeTimelineHitBurst = {
  /** Indices into the report hits array; full hit payloads are sent once. */
  hitIndices?: number[];
  id: string;
  frame: number;
  seconds: number;
  memberId: string | null;
  characterId: string | null;
  damage: number;
  poiseDamage: number;
  hpHitCount: number;
  poiseHitCount: number;
  /** Maximum attack multiplier in this same-frame burst. */
  multiplier?: number | null;
  skillId: string | null;
};

export type AkeProjectedTimeline = {
  /** HTTP projection only; the core engine projection retains its full aliases. */
  transportProjection?: {
    schemaVersion: 1;
    canonicalHitPath: '/hits';
    burstHitReferences: 'hitIndices';
    omittedAliases: string[];
  };
  tickRate: number;
  durationFrames: number;
  durationSeconds: number;
  commands: AkeCommandSettlement[];
  casts: Array<Record<string, unknown>>;
  hitBursts: AkeTimelineHitBurst[];
  sharedAtb: null | {
    poolId: string;
    max: number;
    initial: number;
    final: number;
    points: AkeTimelinePoint[];
    events: Array<Record<string, unknown>>;
  };
  uspPools: Array<{
    poolId: string;
    ownerId: string | null;
    max: number;
    initial: number;
    final: number;
    points: AkeTimelinePoint[];
  }>;
  cooldowns: Array<Record<string, unknown>>;
  comboWindows?: Array<{
    id: string;
    pendingId: number | string;
    ruleId: string | null;
    characterId: string | null;
    skillId: string | null;
    sourceCommandId: string | null;
    createdFrame: number;
    expireFrame: number;
    consumedFrame: number | null;
    consumedCommandId: string | null;
    state: 'active' | 'ready' | 'consumed' | 'expired' | 'suppressed';
    reason: string | null;
  }>;
  timedInputWindows?: Array<{
    id: string;
    ownerId: string | null;
    inputTypes: string[];
    createdFrame: number;
    startFrame: number;
    endFrameExclusive: number;
    resolvedFrame: number | null;
    resolvedCommandId: string | null;
    state: 'upcoming' | 'active' | 'resolved' | 'missed';
    boundary: string;
    sourceCommandId: string | null;
    sourceBuffId: string | null;
    sourceSkillId: string | null;
    reason: string | null;
  }>;
};

type AkeSquadMemberResult = {
  memberId: string;
  characterId: string;
  name: string;
  iconUrl: string;
  loadout: {
    level: number;
    skillLevel: number;
    potentialLevel: number;
    weaponId: string;
    weaponName: string;
    weaponLevel: number;
    weaponPotential: number;
    equipment: Array<{
      equipmentId: string;
      enhance: number;
      name: string;
      partName: string;
      iconUrl: string;
    }>;
  };
  profile: {
    /** Runtime value after AKE static and dynamic source settlement. */
    atk: number;
    runtimeAtk?: number;
    runtimeAttackAttribute?: AkeRuntimeAttributeSnapshot | null;
    maxHp: number;
    maxUltimateSp: number;
  };
  commands: AkeCommandSettlement[];
  summary: {
    totalDamage: number;
    totalPoiseDamage: number;
    hitCount: number;
    successfulCommands: number;
    failedCommands: number;
  };
  diagnostics: {
    compilerUnresolvedCount: number;
    assembler: Array<Record<string, unknown>>;
  };
};

export type AkeControllerEvent = {
  stage: 'MainCharacterChanged' | 'MainCharacterSwitchUnresolved';
  frame: number;
  previousCharacterId: string | null;
  characterId: string;
  reason: string;
  switchId: string | null;
};

type AkeSquadSimulation = {
  schemaVersion: 2 | 3;
  workspaceId?: string;
  admissionStatus?: string;
  generatedAt: string;
  engine: string;
  tickRate: number;
  durationFrames: number;
  durationSeconds: number;
  members: AkeSquadMemberResult[];
  commands: AkeCommandSettlement[];
  hits: AkeRuntimeHit[];
  statusEvents: AkeRuntimeStatusEvent[];
  teamComboLedger?: AkeTeamComboLedger;
  controllerEvents?: AkeControllerEvent[];
  attributeSnapshots?: Record<string, Record<string, AkeRuntimeAttributeSnapshot>>;
  timeline: AkeProjectedTimeline;
  summary: {
    totalDamage: number;
    totalPoiseDamage: number;
    dps: number;
    hitCount: number;
    successfulCommands: number;
    failedCommands: number;
    delayedCommands: number;
  };
  finalState: {
    mainCharacterId?: string;
    sharedAtb: { current: number; max: number };
    ultimateSpByCharacterId: Record<string, number>;
    activeStatuses: Array<Record<string, unknown>>;
    resilience: Record<string, unknown>;
    poise: Record<string, unknown>;
  };
  diagnostics: {
    unresolvedEffectCount: number;
    compilerUnresolvedEffectCount: number;
    runtimeDiagnostics?: AkeRuntimeDiagnostic[];
  };
};

export type AkeCharacterReport = {
  localCharacterId: string;
  akeCharacterId: string | null;
  memberId: string;
  characterName: string;
  status: 'calculated' | 'no-commands' | 'unsupported' | 'error';
  error?: string;
  loadout: {
    level: number;
    skillLevel: number;
    weaponId: string;
    weaponName: string;
    weaponLevel: number;
    equipment: Array<{ slotKey: string; equipmentId: string; name: string }>;
    potentialEffectIds: string[];
    panelAtk: number;
    panelHp: number;
    /** Trusted LTS/DEF panel formula, kept apart from AKE hit-time operands. */
    panelAttackTrace?: AkePanelAttackTrace;
    /** The UI panel is a display projection; keep the engine value separate. */
    runtimeAtk?: number;
    runtimeAttackSources?: AkeRuntimeModifierContribution[];
    damageBonuses: Array<{ label: string; value: number }>;
  };
  skippedButtonIds: string[];
  simulation?: {
    tickRate: number;
    durationFrames: number;
    durationSeconds: number;
    commands: AkeCommandSettlement[];
    summary: AkeSquadMemberResult['summary'] & { dps: number };
    finalState: {
      resources: { Atb: number; UltimateSp: number };
      activeStatuses: Array<Record<string, unknown>>;
      resilience: Record<string, unknown>;
      poise: Record<string, unknown>;
    };
    diagnostics: {
      unresolvedEffectCount: number;
      compilerUnresolvedEffectCount: number;
    };
  };
};

export type AkeTeamReport = {
  rdps?: RdpsAttributionSummary;
  rdpsAudit?: AkeRdpsAudit & { elapsedMs: number };
  schemaVersion: 2 | 3;
  workspaceId?: string;
  admissionStatus?: string;
  generatedAt: string;
  engine: string;
  enemyId: string;
  timelineMode?: 'shared-variable-rate';
  nodeFrameScale: number;
  tickRate: number;
  durationFrames: number;
  requestedEndFrame?: number;
  executionDigest?: string;
  diagnostics?: {
    unresolvedEffectCount: number;
    compilerUnresolvedEffectCount: number;
    runtimeDiagnostics: AkeRuntimeDiagnostic[];
  };
  characters: AkeCharacterReport[];
  timeline: AkeProjectedTimeline;
  hits: AkeRuntimeHit[];
  statusEvents: AkeRuntimeStatusEvent[];
  teamComboLedger?: AkeTeamComboLedger;
  controllerEvents?: AkeControllerEvent[];
  summary: {
    totalDamage: number;
    totalPoiseDamage: number;
    dps: number;
    successfulCommands: number;
    failedCommands: number;
    delayedCommands: number;
    calculatedCharacters: number;
    unsupportedCharacters: number;
  };
  finalState: AkeSquadSimulation['finalState'];
};

type PreparedMember = {
  memberId: string;
  character: Character;
  akeCharacterId: string | null;
  buttons: SkillButtonData[];
  skippedButtonIds: string[];
  request: Record<string, unknown> | null;
  reportLoadout: AkeCharacterReport['loadout'];
};

function parseStoredRecord<T extends object>(key: string): T {
  const raw = persistentLocalStorage.getItem(key);
  if (!raw) return {} as T;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : {} as T;
  } catch {
    return {} as T;
  }
}

let catalogPromise: Promise<AkeCatalog> | null = null;

export function loadAkeCatalog(): Promise<AkeCatalog> {
  const installed = getInstalledAkeCatalog();
  if (installed) return Promise.resolve(installed);
  if (!catalogPromise) {
    catalogPromise = fetch('/api/ake/catalog', { cache: 'no-store' }).then(async response => {
      const payload = await response.json() as AkeCatalog & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    }).catch(error => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

function skillLevelNumber(value: string | undefined): number {
  const normalized = String(value ?? 'L1').toUpperCase();
  const level = /^L(\d+)$/.exec(normalized);
  if (level) return Math.max(1, Math.min(9, Number(level[1])));
  const mastery = /^M([1-3])$/.exec(normalized);
  if (mastery) return 9 + Number(mastery[1]);
  return 1;
}

function resolveSkillLevel(snapshot: ConfigSnapshot | undefined, buttons: SkillButtonData[]): number {
  const levels = buttons.flatMap(button => {
    const value = snapshot?.operator.skillConfig?.[button.skillType];
    return value ? [skillLevelNumber(value)] : [];
  });
  // The original LTS selection cards are already presented at the completed
  // Lv.90/M3 demo baseline. Merely not opening the config page must not turn a
  // team member into a Lv.1 AKE request.
  return levels.length > 0 ? Math.max(...levels) : 12;
}

function potentialCount(value: string | undefined, fallback = 1): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type LocalWeaponSkillLevels = {
  skill1: number;
  skill2: number;
  skill3: number;
};

/**
 * The config page presents weapon skills by semantic role:
 * primary / secondary / passive. AKE resolves levels by the physical order in
 * weaponSkillList, and some weapons omit the secondary entry entirely. Map the
 * editor roles back to those physical slots before sending the runtime request.
 */
export function resolveAkeWeaponSkillLevels(
  skillPatches: Array<{ role: string }>,
  localLevels: LocalWeaponSkillLevels,
): LocalWeaponSkillLevels {
  const resolved: LocalWeaponSkillLevels = { ...localLevels };
  const roleLevel = {
    primary: localLevels.skill1,
    secondary: localLevels.skill2,
    passive: localLevels.skill3,
  } as const;

  skillPatches.slice(0, 3).forEach((patch, index) => {
    const physicalSlot = `skill${index + 1}` as keyof LocalWeaponSkillLevels;
    const mappedLevel = roleLevel[patch.role as keyof typeof roleLevel];
    if (typeof mappedLevel === 'number') {
      resolved[physicalSlot] = mappedLevel;
    }
  });
  return resolved;
}

function configuredDamageBonuses(snapshot: ConfigSnapshot | undefined) {
  if (!snapshot) return [];
  const damage = snapshot.panel.display.damageBonus;
  return [
    ['全伤', damage.allDmgBonus], ['物理', damage.physicalDmgBonus],
    ['灼热', damage.fireDmgBonus], ['电磁', damage.electricDmgBonus],
    ['寒冷', damage.iceDmgBonus], ['自然', damage.natureDmgBonus],
    ['法术', damage.magicDmgBonus], ['普攻', damage.normalAttackDmgBonus],
    ['战技', damage.skillDmgBonus], ['连携', damage.chainSkillDmgBonus],
    ['终结', damage.ultimateDmgBonus],
  ].flatMap(([label, raw]) => {
    const value = Number(raw) || 0;
    return value === 0 ? [] : [{ label: String(label), value }];
  });
}

function buttonsForCharacter(timelineData: TimelineData, character: Character): SkillButtonData[] {
  return timelineData.staffLines
    .flatMap(line => line.buttons ?? [])
    .filter(button => button.characterId === character.id || button.characterName === character.name)
    .sort((left, right) => left.nodeIndex - right.nodeIndex || left.id.localeCompare(right.id));
}

function prepareMember(input: {
  timelineData: TimelineData;
  character: Character;
  catalog: AkeCatalog;
  snapshots: Record<string, ConfigSnapshot>;
  weaponLibrary: Record<string, WeaponLibraryItem>;
}): PreparedMember {
  const { timelineData, character, catalog, snapshots, weaponLibrary } = input;
  const snapshot = snapshots[character.id];
  const catalogCharacter = catalog.characters.find(item => item.id === character.id)
    ?? catalog.characters.find(item => item.name === character.name);
  const akeCharacterId = catalogCharacter?.id ?? null;
  const allButtons = buttonsForCharacter(timelineData, character);
  const buttons = allButtons.filter(button => COMMAND_TYPE_BY_SKILL[button.skillType]);
  const skippedButtonIds = allButtons.filter(button => !COMMAND_TYPE_BY_SKILL[button.skillType])
    .map(button => button.id);
  const snapshotWeaponName = snapshot?.weapon.name || snapshot?.weapon.id || '';
  const storedWeapon = weaponLibrary[snapshotWeaponName]
    ?? Object.values(weaponLibrary).find(item => (
      item.name === snapshotWeaponName || item.id === snapshot?.weapon.id
    ));
  const compatibleWeapons = catalog.weapons.filter(weapon => (
    weapon.weaponTypeId === catalogCharacter?.weaponTypeId
  ));
  const weapon = catalog.weapons.find(item => item.id === storedWeapon?.id)
    ?? catalog.weapons.find(item => item.name === snapshotWeaponName)
    ?? compatibleWeapons.find(item => item.id === catalogCharacter?.defaultWeaponId)
    ?? compatibleWeapons[0];
  const knownEquipmentIds = new Set(catalog.equipment.map(item => item.id));
  const equipment = (snapshot?.equipment.pieces ?? [])
    .filter(piece => knownEquipmentIds.has(piece.equipmentId)).slice(0, 4)
    .map(piece => ({
      equipmentId: piece.equipmentId,
      enhance: Math.max(0, Math.min(3, Math.max(
        0, ...piece.effects.map(effect => Number(effect.level) || 0),
      ))),
    }));
  const level = Math.max(1, Math.min(90, Number(snapshot?.operator.level) || 90));
  const skillLevel = resolveSkillLevel(snapshot, buttons);
  const characterPotentialLevel = Math.max(0, Math.min(
    5, Number(snapshot?.operator.potentialCount ?? 1) - 1,
  ));
  const weaponLevel = Math.max(1, Math.min(90, Number(snapshot?.weapon.config.level) || 90));
  const weaponPotential = Math.max(1, Math.min(
    9, potentialCount(snapshot?.weapon.config.potential, 1),
  ));
  const localWeaponSkillLevels = {
    skill1: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill1) || 9)),
    skill2: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill2) || 9)),
    skill3: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill3) || 4)),
  };
  const weaponSkillLevels = resolveAkeWeaponSkillLevels(
    weapon?.skillPatches ?? [],
    localWeaponSkillLevels,
  );
  const mainAbilityLabel = snapshot?.operator.mainStat
    || catalogCharacter?.mainAttributeLabel
    || '主能力';
  const subAbilityLabel = snapshot?.operator.subStat
    || catalogCharacter?.subAttributeLabel
    || '副能力';
  const reportLoadout: AkeCharacterReport['loadout'] = {
    level,
    skillLevel,
    weaponId: weapon?.id ?? '',
    weaponName: weapon?.name ?? '',
    weaponLevel,
    equipment: (snapshot?.equipment.pieces ?? []).map(piece => ({
      slotKey: piece.slotKey, equipmentId: piece.equipmentId, name: piece.name,
    })),
    potentialEffectIds: catalogCharacter?.potentials
      ?.filter(item => item.level <= characterPotentialLevel).map(item => item.effectId) ?? [],
    panelAtk: Number(snapshot?.panel.display.atk) || 0,
    panelHp: Number(snapshot?.panel.display.hp) || 0,
    panelAttackTrace: snapshot ? {
      characterAttack: snapshot.panel.calc.operatorAtk,
      weaponAttack: snapshot.panel.calc.weaponAtk,
      attackPercent: snapshot.panel.display.attackDetail.atkPercent,
      flatAttack: snapshot.panel.display.attackDetail.flatAtk,
      baseAttack: snapshot.panel.display.attackDetail.baseAtk,
      panelAttack: snapshot.panel.display.attackDetail.panelAtk,
      abilityBonus: snapshot.panel.display.abilityBonus,
      mainAbility: snapshot.panel.display.abilityDetail.rawMainStat !== 0
        || snapshot.panel.display.abilityDetail.mainStatBeforeRounding !== 0 ? {
        label: mainAbilityLabel,
        rawValue: snapshot.panel.display.abilityDetail.rawMainStat,
        statScale: snapshot.panel.display.abilityDetail.mainStatScale,
        allStatScale: snapshot.panel.display.abilityDetail.allStatScale,
        valueBeforeRounding: snapshot.panel.display.abilityDetail.mainStatBeforeRounding,
        finalValue: snapshot.panel.display.mainStatFinal,
        attackCoefficient: 0.005,
        attackBonus: snapshot.panel.display.abilityDetail.mainAtkBonus,
      } : undefined,
      subAbility: snapshot.panel.display.abilityDetail.rawSubStat !== 0
        || snapshot.panel.display.abilityDetail.subStatBeforeRounding !== 0 ? {
        label: subAbilityLabel,
        rawValue: snapshot.panel.display.abilityDetail.rawSubStat,
        statScale: snapshot.panel.display.abilityDetail.subStatScale,
        allStatScale: snapshot.panel.display.abilityDetail.allStatScale,
        valueBeforeRounding: snapshot.panel.display.abilityDetail.subStatBeforeRounding,
        finalValue: snapshot.panel.display.subStatFinal,
        attackCoefficient: 0.002,
        attackBonus: snapshot.panel.display.abilityDetail.subAtkBonus,
      } : undefined,
    } : undefined,
    runtimeAtk: 0,
    runtimeAttackSources: [],
    damageBonuses: configuredDamageBonuses(snapshot),
  };
  return {
    memberId: akeCharacterId ?? character.id,
    character,
    akeCharacterId,
    buttons,
    skippedButtonIds,
    request: akeCharacterId && weapon ? {
      memberId: akeCharacterId,
      characterId: akeCharacterId,
      level,
      skillLevel,
      potentialLevel: characterPotentialLevel,
      weaponId: weapon.id,
      weaponLevel,
      weaponPotential,
      weaponSkillLevels,
      equipment,
    } : null,
    reportLoadout,
  };
}

function errorReport(member: PreparedMember, error: string): AkeCharacterReport {
  return {
    localCharacterId: member.character.id,
    akeCharacterId: member.akeCharacterId,
    memberId: member.memberId,
    characterName: member.character.name,
    status: member.akeCharacterId ? 'error' : 'unsupported',
    error,
    loadout: member.reportLoadout,
    skippedButtonIds: member.skippedButtonIds,
  };
}

function characterReport(
  prepared: PreparedMember,
  member: AkeSquadMemberResult,
  squad: AkeSquadSimulation,
): AkeCharacterReport {
  return {
    localCharacterId: prepared.character.id,
    akeCharacterId: member.characterId,
    memberId: member.memberId,
    characterName: member.name,
    status: prepared.buttons.length === 0 ? 'no-commands' : 'calculated',
    loadout: {
      ...prepared.reportLoadout,
      weaponId: member.loadout.weaponId,
      weaponName: member.loadout.weaponName,
      weaponLevel: member.loadout.weaponLevel,
      equipment: member.loadout.equipment.map((equipment, index) => ({
        slotKey: prepared.reportLoadout.equipment[index]?.slotKey ?? equipment.partName,
        equipmentId: equipment.equipmentId,
        name: equipment.name,
      })),
      // Keep the rounded local panel and the AKE runtime value distinct. The
      // old mapping replaced the panel number with the runtime number, which
      // made a 3328 panel look like a 3323 calculation error and hid the
      // source chain entirely.
      panelAtk: prepared.reportLoadout.panelAtk,
      panelHp: prepared.reportLoadout.panelHp,
      runtimeAtk: Number(member.profile.runtimeAtk ?? member.profile.atk ?? 0),
      runtimeAttackSources: member.profile.runtimeAttackAttribute?.contributions ?? [],
    },
    skippedButtonIds: prepared.skippedButtonIds,
    simulation: {
      tickRate: squad.tickRate,
      durationFrames: squad.durationFrames,
      durationSeconds: squad.durationSeconds,
      commands: member.commands.map(command => ({ ...command, status: command.state })),
      summary: {
        ...member.summary,
        dps: squad.durationSeconds > 0 ? member.summary.totalDamage / squad.durationSeconds : 0,
      },
      finalState: {
        resources: {
          Atb: Number(squad.finalState.sharedAtb?.current ?? 0),
          UltimateSp: Number(squad.finalState.ultimateSpByCharacterId[member.characterId] ?? 0),
        },
        activeStatuses: squad.finalState.activeStatuses,
        resilience: squad.finalState.resilience,
        poise: squad.finalState.poise,
      },
      diagnostics: {
        unresolvedEffectCount: squad.diagnostics.unresolvedEffectCount,
        compilerUnresolvedEffectCount: member.diagnostics.compilerUnresolvedCount,
      },
    },
  };
}

let latestCalculationSequence = 0;
let latestTeamReport: AkeTeamReport | null = null;

export async function runAkeTeamCalculation(input: {
  timelineData: TimelineData;
  selectedCharacters: Character[];
  enemyId?: string;
  executionDigest?: string;
  signal?: AbortSignal;
  riaActionSink?: RiaUiActionSink | null;
}): Promise<AkeTeamReport> {
  const workspaceId = getTimelineSessionSnapshot().activeTimelineId;
  const sequence = ++latestCalculationSequence;
  const startedAt = performance.now();
  const isCurrent = () => sequence === latestCalculationSequence && !input.signal?.aborted
    && workspaceId === getTimelineSessionSnapshot().activeTimelineId;
  const ensureCurrent = () => {
    if (!isCurrent()) throw new DOMException('Calculation superseded by a newer timeline.', 'AbortError');
  };
  ensureCurrent();
  const enemyId = input.enemyId ?? DEFAULT_ENEMY_ID;
  const catalog = await loadAkeCatalog();
  ensureCurrent();
  const snapshots = getOperatorConfigPageCache();
  const weaponLibrary = parseStoredRecord<Record<string, WeaponLibraryItem>>(WEAPON_LIBRARY_STORAGE_KEY);
  const prepared = input.selectedCharacters.map(character => prepareMember({
    timelineData: input.timelineData, character, catalog, snapshots, weaponLibrary,
  }));
  const supported = prepared.filter(member => member.request);
  if (supported.length === 0) throw new Error('当前队伍没有可由 AKEDatabase 解析的干员。');
  const maximumNodeIndex = input.timelineData.staffLines
    .flatMap(line => line.buttons ?? [])
    .reduce((maximum, button) => Math.max(maximum, Number(button.nodeIndex) || 0), 0);
  const preview = buildAkeRealtimeTimeline({
    timelineData: input.timelineData,
    selectedCharacters: input.selectedCharacters,
    catalog,
    staffCount: Math.max(1, Math.floor(maximumNodeIndex / GRID_NODE_COUNT) + 1),
  });
  const plannedFrameByCommandId = new Map(preview.commands.map(command => (
    [command.commandId, command.requestedFrame]
  )));
  const plannedAttackModeByCommandId = new Map(preview.commands.map(command => (
    [command.commandId, command.profile.attackMode]
  )));
  const releaseDependencyFor = (button: SkillButtonData) => resolveAkeReleaseDependency(button, preview);
  const model = preview.sharedVariableRateTimeline;
  const scheduledActionById = new Map(model?.actions.map(action => [action.id, action]) ?? []);
  const controllerIdForLane = (laneId: string | null) => supported.find(member => (
    member.character.id === laneId || member.akeCharacterId === laneId
  ))?.akeCharacterId;
  const initialControllerCharacterId = controllerIdForLane(resolveInitialControllerLaneId(
    input.timelineData.initialControllerCharacterId, input.selectedCharacters.map(character => character.id),
  )) ?? supported[0].akeCharacterId;
  const operatorSwitches = (model?.operatorSwitches ?? []).map(change => {
    const characterId = controllerIdForLane(change.targetLaneId);
    if (!characterId) throw new Error('换人节点的目标干员无法对应到 AKE 队伍。');
    const button = input.timelineData.staffLines.flatMap(line => line.buttons)
      .find(button => button.id === change.id);
    return { switchId: change.id, characterId, frame: Math.round(change.endFrame),
      timelineOrder: change.endX, releaseDependency: button ? releaseDependencyFor(button) : undefined };
  });
  const commands = supported.flatMap(member => member.buttons.map(button => ({
    commandId: button.id,
    memberId: member.memberId,
    characterId: member.akeCharacterId,
    commandType: COMMAND_TYPE_BY_SKILL[button.skillType],
    frame: plannedFrameByCommandId.get(button.id) ?? 0,
    timelineOrder: scheduledActionById.get(button.id)?.startX,
    // A supplied landing action is a point in time, not an attack held in queue.
    queueMode: plannedAttackModeByCommandId.get(button.id) === 'plunging-impact'
      ? undefined : 'timeline-sequence' as const,
    releaseDependency: releaseDependencyFor(button),
    attackMode: button.skillType === 'A'
      ? plannedAttackModeByCommandId.get(button.id) ?? 'full-combo' : undefined,
  })));
  const requestedEndFrame = resolveAkeCalculationEndFrame(preview);
  const executionDigest = buildAkeExecutionDigest({ ...input, catalog, preview });
  const simulationInput = {
    enemyId,
    initialAtb: 300,
    initialControllerCharacterId,
    operatorSwitches,
    members: supported.map(member => member.request),
    commands,
    endFrame: requestedEndFrame,
  };
  const { liveRiaCalculationSink, recordRiaDebugEvent, publishRiaDebugSection } = await import('./riaLiveDebug');
  const configuredSink = input.riaActionSink ?? configuredRiaUiActionSink() ?? await liveRiaCalculationSink(isCurrent);
  if (!configuredSink) recordRiaDebugEvent('error', 'CalculationNotArchived', {
    reason: 'Browser debug session was unavailable; calculation continues without an archive.',
  });
  ensureCurrent();
  const riaContext = configuredSink?.context;
  let riaBound = false;
  if (riaContext) {
    try {
      const startResponse = await fetch('/api/ake/ria/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: input.signal,
        body: JSON.stringify({
          caseId: riaContext.caseId,
          sessionId: riaContext.sessionId,
          runId: riaContext.runId,
          executionDigest: executionDigest,
          input: simulationInput,
        }),
      });
      riaBound = startResponse.ok;
      if (!riaBound) recordRiaDebugEvent('error', 'RiaRunStartFailed', { status: startResponse.status }, { runId: riaContext.runId });
    } catch (error) {
      // Investigation recording is observational and cannot change calculation semantics.
      riaBound = false;
      recordRiaDebugEvent('error', 'RiaRunStartFailed', { error }, { runId: riaContext.runId });
    }
  }
  const riaActionSink = riaContext && !riaBound ? null : configuredSink;
  const debugCalculation = { caseId: riaContext?.caseId ?? null, runId: riaBound ? riaContext?.runId : null,
    recording: riaBound, executionDigest: executionDigest, sequence };
  if (isCurrent()) publishRiaDebugSection('calculation', { ...debugCalculation, phase: 'requested', commandCount: commands.length });
  const finalizeRiaRun = async () => {
    if (!riaBound || !riaContext) return;
    try {
      const response = await fetch('/api/ake/ria/seal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: riaContext.caseId, runId: riaContext.runId }),
      });
      if (!response.ok) throw new Error(`RIA seal HTTP ${response.status}`);
      recordRiaDebugEvent('calculation', 'RiaRunSealed', { elapsedMs: Math.round(performance.now() - startedAt) }, { runId: riaContext.runId });
    } catch (error) { recordRiaDebugEvent('error', 'RiaSealFailed', { error }, { runId: riaContext.runId }); }
  };
  const requestedRecording = riaActionSink?.record({
    actionType: 'AkeCalculationRequested',
    payload: {
      enemyId,
      commandCount: commands.length,
      selectedCharacterIds: supported.map(member => member.akeCharacterId),
      requestedEndFrame,
      executionDigest: executionDigest ?? null,
    },
  });
  let response: Response;
  let payload: AkeSquadSimulation & { error?: string };
  try {
    ensureCurrent();
    response = await fetch('/api/ake/squad/simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(riaBound && riaContext ? {
          'X-RIA-Case-ID': riaContext.caseId,
          'X-RIA-Run-ID': riaContext.runId,
        } : {}),
      },
      signal: input.signal,
      body: JSON.stringify(simulationInput),
    });
    payload = await response.json() as AkeSquadSimulation & { error?: string };
    ensureCurrent();
  } catch (error) {
    if (isCurrent()) publishRiaDebugSection('calculation', { ...debugCalculation, phase: 'failed', error: String(error) });
    const failedRecording = riaActionSink?.record({
      actionType: error instanceof DOMException && error.name === 'AbortError'
        ? 'AkeCalculationCancelled' : 'AkeCalculationFailed',
      payload: {
        status: null,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    void Promise.allSettled([requestedRecording, failedRecording]).then(finalizeRiaRun);
    throw error;
  }
  if (!response.ok) {
    if (isCurrent()) publishRiaDebugSection('calculation', { ...debugCalculation, phase: 'failed', status: response.status, error: payload.error });
    const failedRecording = riaActionSink?.record({
      actionType: 'AkeCalculationFailed',
      payload: { status: response.status, error: payload.error ?? null },
    });
    void Promise.allSettled([requestedRecording, failedRecording]).then(finalizeRiaRun);
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  const resultByCharacterId = new Map(payload.members.map(member => [member.characterId, member]));
  const characters = prepared.map(member => {
    if (!member.akeCharacterId) return errorReport(member, 'AKEDatabase 中没有该干员。');
    const result = resultByCharacterId.get(member.akeCharacterId);
    return result ? characterReport(member, result, payload)
      : errorReport(member, '共享运行时没有返回该队员。');
  });
  const report: AkeTeamReport = {
    schemaVersion: 3,
    workspaceId,
    admissionStatus: preview.sharedVariableRateTimeline?.admissionStatus,
    generatedAt: payload.generatedAt,
    engine: payload.engine,
    enemyId,
    timelineMode: 'shared-variable-rate',
    nodeFrameScale: 0,
    tickRate: payload.tickRate,
    durationFrames: payload.durationFrames,
    requestedEndFrame,
    executionDigest: executionDigest,
    diagnostics: {
      unresolvedEffectCount: payload.diagnostics.unresolvedEffectCount,
      compilerUnresolvedEffectCount: payload.diagnostics.compilerUnresolvedEffectCount,
      runtimeDiagnostics: payload.diagnostics.runtimeDiagnostics ?? [],
    },
    characters,
    timeline: payload.timeline,
    hits: payload.hits ?? [],
    statusEvents: payload.statusEvents ?? [],
    teamComboLedger: payload.teamComboLedger,
    controllerEvents: payload.controllerEvents ?? [],
    summary: {
      totalDamage: payload.summary.totalDamage,
      totalPoiseDamage: payload.summary.totalPoiseDamage,
      dps: payload.summary.dps,
      successfulCommands: payload.summary.successfulCommands,
      failedCommands: payload.summary.failedCommands,
      delayedCommands: payload.summary.delayedCommands,
      calculatedCharacters: characters.filter(character => (
        character.status === 'calculated' || character.status === 'no-commands'
      )).length,
      unsupportedCharacters: characters.filter(character => character.status === 'unsupported').length,
    },
    finalState: payload.finalState,
  };
  ensureCurrent();
  latestTeamReport = report;
  safeSessionStorage.setItem(AKE_REPORT_STORAGE_KEY, JSON.stringify(report));
  window.dispatchEvent(new CustomEvent(AKE_REPORT_UPDATED_EVENT, { detail: report }));
  const completedRecording = riaActionSink?.record({
    actionType: 'AkeCalculationCompleted',
    frame: payload.durationFrames,
    payload: {
      totalDamage: payload.summary.totalDamage,
      hitCount: payload.hits?.length ?? 0,
      successfulCommands: payload.summary.successfulCommands,
      failedCommands: payload.summary.failedCommands,
      executionDigest: executionDigest ?? null,
    },
  });
  void Promise.allSettled([requestedRecording, completedRecording]).then(finalizeRiaRun);
  publishRiaDebugSection('calculation', { ...debugCalculation, phase: 'completed', elapsedMs: Math.round(performance.now() - startedAt), summary: report.summary,
    diagnostics: report.diagnostics, commands: report.timeline.commands,
    controllerEvents: report.controllerEvents, mainCharacterId: report.finalState.mainCharacterId });
  return report;
}

export function readLatestAkeTeamReport(): AkeTeamReport | null {
  const workspaceId = getTimelineSessionSnapshot().activeTimelineId;
  if (latestTeamReport?.workspaceId === workspaceId) return latestTeamReport;
  const raw = safeSessionStorage.getItem(AKE_REPORT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AkeTeamReport>;
    return value.workspaceId === workspaceId && (value?.schemaVersion === 2 || value?.schemaVersion === 3)
      && Array.isArray(value.characters) && value.timeline
      ? {
          ...value,
          hits: Array.isArray(value.hits) ? value.hits : [],
          statusEvents: Array.isArray(value.statusEvents) ? value.statusEvents : [],
          teamComboLedger: value.teamComboLedger,
          finalState: {
            ...(value.finalState ?? {
              sharedAtb: { current: 0, max: 0 },
              ultimateSpByCharacterId: {},
              activeStatuses: [],
              resilience: {},
            }),
            poise: value.finalState?.poise ?? {},
          },
          diagnostics: value.diagnostics ?? {
            unresolvedEffectCount: 0,
            compilerUnresolvedEffectCount: 0,
            runtimeDiagnostics: [],
          },
        } as AkeTeamReport : null;
  } catch {
    return null;
  }
}
