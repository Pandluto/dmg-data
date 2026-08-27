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

export const AKE_REPORT_STORAGE_KEY = 'def.ake-demo.latest-report.v3';
export const AKE_REPORT_UPDATED_EVENT = 'def:ake-report-updated';
const WEAPON_LIBRARY_STORAGE_KEY = 'def.weapon-sheet.library.v1';
const DEFAULT_ENEMY_ID = 'eny_0007_mimicw';

const COMMAND_TYPE_BY_SKILL: Record<string, string> = {
  A: 'Attack',
  B: 'NormalSkill',
  E: 'ComboSkill',
  Q: 'UltimateSkill',
};

type WeaponLibraryItem = { id?: string; name?: string };

export type AkeCommandSettlement = {
  commandId: string;
  commandType: string;
  memberId: string | null;
  characterId: string | null;
  requestedFrame: number;
  requestedSeconds: number;
  actualFrame: number | null;
  actualSeconds: number | null;
  endFrame: number | null;
  delayFrames: number | null;
  state: string;
  status?: string;
  success: boolean;
  queued: boolean;
  reason: string | null;
  admissionReason?: string | null;
  skillId: string | null;
  castId?: string | null;
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
  evaluation?: {
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

export type AkeRuntimeHit = {
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
  bySource?: Array<{ sourceId?: string | null; ownerId?: string | null; count?: number }>;
  discarded: number | null;
  after: number | null;
  durationFrames: number | null;
  expireFrame: number | null;
  sourceSkillId: string | null;
  rootSkillId: string | null;
  castId: string | null;
  triggerSourceId: string | null;
  triggerOwnerId: string | null;
  triggerTargetId: string | null;
  triggerSkillId: string | null;
  triggerRootSkillId: string | null;
  triggerCastId: string | null;
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
  id: string;
  frame: number;
  seconds: number;
  memberId: string | null;
  characterId: string | null;
  damage: number;
  poiseDamage: number;
  hpHitCount: number;
  poiseHitCount: number;
  skillId: string | null;
};

export type AkeProjectedTimeline = {
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
    createdFrame: number;
    expireFrame: number;
    consumedFrame: number | null;
    consumedCommandId: string | null;
    state: 'active' | 'ready' | 'consumed' | 'expired' | 'suppressed';
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
  profile: { atk: number; maxHp: number; maxUltimateSp: number };
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

type AkeSquadSimulation = {
  schemaVersion: 2 | 3;
  generatedAt: string;
  engine: string;
  tickRate: number;
  durationFrames: number;
  durationSeconds: number;
  members: AkeSquadMemberResult[];
  commands: AkeCommandSettlement[];
  hits: AkeRuntimeHit[];
  statusEvents: AkeRuntimeStatusEvent[];
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
  schemaVersion: 2 | 3;
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

const AKE_SETTLEMENT_TAIL_FRAMES = 300;

/**
 * Give every projected action enough runtime tail to settle while retaining
 * fixed waits in the requested horizon.  Deriving this from the variable-rate
 * model avoids falling back to the last pre-wait command frame.
 */
export function resolveAkeCalculationEndFrame(
  timeline: Pick<AkeRealtimeTimeline, 'sharedVariableRateTimeline'>,
): number {
  const model = timeline.sharedVariableRateTimeline;
  const projectedEndFrame = Math.max(
    model?.endFrame ?? 0,
    ...(model?.actions.map(action => action.endFrame) ?? []),
    ...(model?.waits.map(wait => wait.endFrame) ?? []),
    ...(model?.laneWaits.map(wait => wait.endFrame) ?? []),
    ...(model?.operatorSwitches.map(operatorSwitch => operatorSwitch.endFrame) ?? []),
  );
  return Math.max(
    360,
    Math.ceil(projectedEndFrame) + AKE_SETTLEMENT_TAIL_FRAMES,
  );
}

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
  const weaponSkillLevels = {
    skill1: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill1) || 9)),
    skill2: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill2) || 9)),
    skill3: Math.max(1, Math.min(9, Number(snapshot?.weapon.config.skillLevels.skill3) || 4)),
  };
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
      equipment: member.loadout.equipment.map((equipment, index) => ({
        slotKey: prepared.reportLoadout.equipment[index]?.slotKey ?? equipment.partName,
        equipmentId: equipment.equipmentId,
        name: equipment.name,
      })),
      panelAtk: member.profile.atk,
      panelHp: member.profile.maxHp,
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

export async function runAkeTeamCalculation(input: {
  timelineData: TimelineData;
  selectedCharacters: Character[];
  enemyId?: string;
  executionDigest?: string;
  signal?: AbortSignal;
}): Promise<AkeTeamReport> {
  const enemyId = input.enemyId ?? DEFAULT_ENEMY_ID;
  const catalog = await loadAkeCatalog();
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
  const commands = supported.flatMap(member => member.buttons.map(button => ({
    commandId: button.id,
    memberId: member.memberId,
    characterId: member.akeCharacterId,
    commandType: COMMAND_TYPE_BY_SKILL[button.skillType],
    frame: plannedFrameByCommandId.get(button.id) ?? 0,
    attackMode: button.skillType === 'A' ? 'full-combo' : undefined,
  })));
  const requestedEndFrame = resolveAkeCalculationEndFrame(preview);
  const response = await fetch('/api/ake/squad/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify({
      enemyId,
      initialAtb: 300,
      members: supported.map(member => member.request),
      commands,
      endFrame: requestedEndFrame,
    }),
  });
  const payload = await response.json() as AkeSquadSimulation & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  const resultByCharacterId = new Map(payload.members.map(member => [member.characterId, member]));
  const characters = prepared.map(member => {
    if (!member.akeCharacterId) return errorReport(member, 'AKEDatabase 中没有该干员。');
    const result = resultByCharacterId.get(member.akeCharacterId);
    return result ? characterReport(member, result, payload)
      : errorReport(member, '共享运行时没有返回该队员。');
  });
  const report: AkeTeamReport = {
    schemaVersion: 3,
    generatedAt: payload.generatedAt,
    engine: payload.engine,
    enemyId,
    timelineMode: 'shared-variable-rate',
    nodeFrameScale: 0,
    tickRate: payload.tickRate,
    durationFrames: payload.durationFrames,
    requestedEndFrame,
    executionDigest: input.executionDigest,
    diagnostics: {
      unresolvedEffectCount: payload.diagnostics.unresolvedEffectCount,
      compilerUnresolvedEffectCount: payload.diagnostics.compilerUnresolvedEffectCount,
      runtimeDiagnostics: payload.diagnostics.runtimeDiagnostics ?? [],
    },
    characters,
    timeline: payload.timeline,
    hits: payload.hits ?? [],
    statusEvents: payload.statusEvents ?? [],
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
  safeSessionStorage.setItem(AKE_REPORT_STORAGE_KEY, JSON.stringify(report));
  window.dispatchEvent(new CustomEvent(AKE_REPORT_UPDATED_EVENT, { detail: report }));
  return report;
}

export function readLatestAkeTeamReport(): AkeTeamReport | null {
  const raw = safeSessionStorage.getItem(AKE_REPORT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AkeTeamReport>;
    return (value?.schemaVersion === 2 || value?.schemaVersion === 3)
      && Array.isArray(value.characters) && value.timeline
      ? {
          ...value,
          hits: Array.isArray(value.hits) ? value.hits : [],
          statusEvents: Array.isArray(value.statusEvents) ? value.statusEvents : [],
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
