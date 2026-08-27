import { LOCAL_LIBRARY_CHANGED_EVENT } from '../../constants/events';
import { persistentLocalStorage } from '../../platform/storage/persistentStorage';
import type { BuffExtraHitConfig } from '../../core/domain/buff';

const OPERATOR_LIBRARY_KEY = 'def.operator-editor.library.v1';
const WEAPON_LIBRARY_KEY = 'def.weapon-sheet.library.v1';
const EQUIPMENT_LIBRARY_KEY = 'def.equipment-sheet.library.v1';
const CATALOG_REVISION_KEY = 'def.ake-catalog.revision.v1';
// v25 picks up the owner pending-empty lifecycle, so chained form restoration
// follows the pending expiry boundary instead of the later fallback Buff timer.
// Existing browsers must discard v24 catalogs or retain the stale restore frame.
// v24 projects action-created chained combo pending from the settled runtime.
// Existing browsers must discard v23 catalogs because a changed ComboSkill
// form could otherwise appear while its matching release window is absent.
// v23 adds multi-event combo triggers plus their normalized runtime conditions.
// Existing browsers must discard v22 catalogs because omitting those fields
// makes compound AKE combo windows either impossible or falsely unconditional.
// v22 adds the authoritative AKE cooldown-group identity to every timing
// profile. Existing browsers must discard v21 catalogs because their live
// preview keyed cooldowns by concrete SkillData id, allowing an enhanced or
// alternate form to bypass the base skill's shared cooldown.
// v20 projects compiled skill-wide ApplyBuff/status actions onto their final
// real settlement hit, including leveled state-trigger values.  This forces
// existing browsers to discard catalogs where vulnerability, NoGuard, Crush
// and Originium were present in SkillData but absent from the visible hit.
// Keep this revision in sync with adapter output changes so an existing browser
// cannot retain a pre-state-machine catalog.
const CATALOG_ADAPTER_VERSION = 25;

const LEVEL_KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'M1', 'M2', 'M3'] as const;

type AkeSkill = {
  groupId: string;
  commandType: string;
  name: string;
  description: string;
  iconUrl: string;
  skillIds: string[];
};

export type AkeHitBuffProfile = {
  id: string;
  displayName: string;
  target: string;
  targetLabel?: string;
  kind?: 'status' | 'resource' | 'attachment' | string;
  statusKey?: string;
  statusValue?: number;
  statusValueLevels?: Record<string, number>;
  /** 状态动作在源 SkillData 内的真实帧；用于避免复制到每一个 Hit。 */
  offsetFrames?: number;
  effects?: Array<{
    id: string;
    sourceBuffId: string;
    type: string;
    value: number;
    unit?: 'flat' | 'percent' | string;
    category?: 'condition' | 'countable' | 'passive';
    maxStacks?: number;
    durationSeconds?: number;
  }>;
  description?: string;
};

export type AkeTimingHitProfile = {
  offsetFrames: number;
  launchOffsetFrames?: number | null;
  sourceSkillId: string;
  rootSkillId: string;
  kind: 'direct' | 'projectile' | 'lingering';
  hitCount: number;
  damageTypes: string[];
  damageType?: string | null;
  levels?: Record<string, number>;
  hitBuffs?: AkeHitBuffProfile[];
  multiplierDerivation?: 'compiled-damage-packet' | 'root-blackboard-fallback' | 'unverified' | string;
};

export type AkeTimingSkillProfile = {
  commandType: string;
  skillId: string;
  variantIndex: number;
  durationFrames: number;
  bodyEndOffset: number;
  tailEndOffset: number;
  exclusiveFrames: number;
  cooldownFrames: number;
  /** Stable actor-local cooldown group shared by base/alternate skill forms. */
  cooldownGroupId: string;
  /** Public AKE command group used by type-selected cooldown operations. */
  cooldownSkillType: string | null;
  costType: string | null;
  costValue: number;
  priority: number | null;
  allowNext: Array<{
    startOffsetFrames: number;
    endOffsetFrames: number;
    allowedSkillIds: string[];
  }>;
  commandMappings?: Array<{
    commandType: string;
    skillId: string;
  }>;
  formEvents?: Array<{
    offsetFrames: number;
    operation: 'apply' | 'remove';
    kind: 'override' | 'mode';
    stateKey: string;
    skillSlot?: string;
    targetSkillId?: string;
    modeId?: string;
  }>;
  comboPendingEvents?: AkeTimingComboPendingEvent[];
  /**
   * Runtime-derived position inside one linear ComboSkill intent chain.
   *
   * AKE stores every stage as a separate SkillData program.  The editor still
   * exposes one E intent, so this metadata describes the active form without
   * turning the later stage into a second palette skill.
   */
  comboStage?: {
    chainId: string;
    index: number;
    count: number;
    rootSkillId: string;
    previousSkillId: string | null;
    nextSkillId: string | null;
  };
  interruptibleAt: number[];
  statusEffects?: AkeHitBuffProfile[];
  hits: AkeTimingHitProfile[];
  resourceEvents: Array<{
    offsetFrames: number;
    resourceType: string;
    scope: string;
    target: 'self' | 'team' | 'other' | 'shared';
    gainMethod: string;
    amount: number;
    reason?: string | null;
  }>;
  recoveryPauses: Array<{ startOffsetFrames: number; endOffsetFrames: number }>;
  derivation: 'isolated-runtime-probe' | 'compiled-fallback';
  diagnostic?: string;
  /** Runtime-only metadata: the A/B/E/Q intent was resolved by this form source. */
  resolutionSource?: 'base-intent' | 'combo-mapping' | 'skill-form-override' | 'skill-mode';
  /** Runtime-only metadata for a basic attack expanded into its complete combo. */
  comboStageSkillIds?: string[];
};

export type AkeTimingComboPendingEvent = {
  offsetFrames: number;
  operation: 'trigger';
  ruleId: string;
  ownerCharacterId: string;
  triggerTargetId: string | null;
  skillSlot: string;
  targetSkillId: string;
  pendingDurationFrames: number;
  requireComboOffCooldown: boolean;
  bypassSkillCooldown: boolean;
  pendingPolicy: string;
  selectionPolicy: string;
  consumePolicy: string;
  sourceActionType: string;
  sourceActionPath?: string | null;
};

export type AkeTimingComboCondition = {
  type: string;
  conditions?: AkeTimingComboCondition[];
  children?: AkeTimingComboCondition[];
  items?: AkeTimingComboCondition[];
  condition?: AkeTimingComboCondition;
  child?: AkeTimingComboCondition;
  operand?: AkeTimingComboCondition;
  target?: string;
  entity?: string;
  buffIds?: string[];
  buffId?: string;
  countType?: string;
  operator?: string;
  value?: number;
  amount?: number;
};

export type AkeTimingComboTrigger = {
  id: string;
  eventType: string;
  eventTypes?: string[];
  rootSkillIds: string[];
  sourceSkillIds: string[];
  rootSkillRole?: string | null;
  statusBuffIds?: string[];
  sourceCommandTypes?: string[];
  requireSourceOtherThanOwner?: boolean;
  conditions?: AkeTimingComboCondition[];
  damageAttributeType: string | null;
  occurrence: string;
  comboSkillId: string;
  pendingDurationFrames: number;
  ownerBinding?: 'event-source' | 'fixed' | 'none' | string;
  ownerId?: string | null;
  requireComboOffCooldown: boolean;
  bypassSkillCooldown?: boolean;
  pendingPolicy: string;
  selectionPolicy: string;
  consumePolicy: string;
  confidence: string;
};

export type AkeTimingCatalog = {
  schemaVersion: number;
  tickRate: number;
  nodeFrameScale: number;
  source: {
    provider: string;
    sharedRevision?: string;
    generator: string;
    semantics: string;
  };
  sharedAtb: {
    initial: number;
    max: number;
    ratePerSecond: number;
    firstTickFrame: number;
    resumeDelayFramesAfterSpend: number;
    quantization: string;
  };
  characters: Record<string, {
    characterId: string;
    maxUltimateSp: number;
    initialUltimateSp?: number;
    comboTriggers?: AkeTimingComboTrigger[];
    profiles: AkeTimingSkillProfile[];
  }>;
};

type AkeCharacter = {
  id: string;
  name: string;
  englishName?: string;
  rarity: number;
  profession: string;
  elementId: string;
  weaponType: string;
  weaponTypeId: number;
  defaultWeaponId: string;
  mainAttributeLabel?: string;
  subAttributeLabel?: string;
  iconUrl: string;
  attributes: Record<string, Record<string, number>>;
  skills: AkeSkill[];
  potentials?: Array<{ level: number; effectId: string; name: string }>;
  loadoutEffects?: {
    talent?: AkeLoadoutEffect[];
    potential?: AkeLoadoutEffect[];
    skill?: AkeLoadoutEffect[];
  };
};

type AkeLoadoutBuffEffect = {
  effectId: string;
  name: string;
  type: string;
  category: 'condition' | 'countable' | 'passive';
  value: number;
  maxStacks?: number;
  unit?: 'flat' | 'percent' | string;
  activation?: {
    kind: 'targetImbalanced' | 'targetStatus' | 'targetAttachment' | 'targetHpBelow';
    status?: string;
    element?: string;
    value?: number;
  };
  durationSeconds?: number;
  effectKind?: 'modifier' | 'extraHit';
  extraHitConfig?: BuffExtraHitConfig;
  description?: string;
  raw?: string;
};

type AkeCatalogNumericEffect = {
  effectId: string;
  sourceBuffId: string;
  type: string;
  value: number;
  unit?: 'flat' | 'percent' | string;
  category: 'condition' | 'countable' | 'passive';
  maxStacks?: number;
  durationSeconds?: number;
  effectKind?: 'modifier' | 'extraHit';
  extraHitConfig?: BuffExtraHitConfig;
};

type AkeLoadoutEffect = {
  effectId: string;
  name: string;
  description: string;
  level: number;
  effects: AkeLoadoutBuffEffect[];
};

type AkeWeapon = {
  id: string;
  name: string;
  description: string;
  rarity: number;
  weaponType: string;
  weaponTypeId: number;
  iconUrl: string;
  attackGrowth: Record<string, number>;
  skillPatches: AkeWeaponSkillPatch[];
};

type AkeWeaponSkillLevel = {
  level: number;
  name: string;
  tagId: string;
  descriptionTemplate: string;
  description: string;
  blackboard: Record<string, number | string>;
  effects?: AkeCatalogNumericEffect[];
};

type AkeWeaponSkillPatch = {
  id: string;
  role: 'primary' | 'secondary' | 'passive';
  name: string;
  tagId: string;
  levels: AkeWeaponSkillLevel[];
};

type AkeEquipmentModifier = {
  attrIndex: number;
  attrType: number;
  attribute: string;
  sourceAttrTypes?: number[];
  compositeAttr?: string;
  modifierType?: number;
  modifyAttributeType?: number;
  values: number[];
};

type AkeEquipment = {
  id: string;
  name: string;
  description: string;
  partName: '护甲' | '护手' | '配件';
  suitId: string | null;
  iconUrl: string;
  baseModifier?: AkeEquipmentModifier | null;
  modifiers: AkeEquipmentModifier[];
};

type AkeSuit = {
  id: string;
  name: string;
  equipmentIds: string[];
  bonuses?: Array<{
    count: number;
    skillId: string;
    skillLevel: number;
    description?: string;
    effects?: AkeCatalogNumericEffect[];
  }>;
};

export type AkeCatalog = {
  schemaVersion: number;
  source: {
    provider: string;
    version?: string;
    sharedRevision?: string;
  };
  characters: AkeCharacter[];
  weapons: AkeWeapon[];
  equipment: AkeEquipment[];
  suits: AkeSuit[];
  timing?: AkeTimingCatalog;
};

let installedCatalog: AkeCatalog | null = null;

export function getInstalledAkeCatalog(): AkeCatalog | null {
  return installedCatalog;
}

function elementType(value: string): 'physical' | 'fire' | 'ice' | 'electric' | 'nature' {
  if (value === 'Fire') return 'fire';
  if (value === 'Cryst') return 'ice';
  if (value === 'Pulse') return 'electric';
  if (value === 'Natural') return 'nature';
  return 'physical';
}

function buttonType(commandType: string): 'A' | 'B' | 'E' | 'Q' | null {
  if (commandType === 'Attack') return 'A';
  if (commandType === 'NormalSkill') return 'B';
  if (commandType === 'ComboSkill') return 'E';
  if (commandType === 'UltimateSkill') return 'Q';
  return null;
}

function operatorAttributeLevels(character: AkeCharacter) {
  const levels = ['level1', 'level20', 'level40', 'level60', 'level80', 'level90'];
  const attributes = ['strength', 'agility', 'intelligence', 'will', 'atk', 'hp'];
  return Object.fromEntries(attributes.map(attribute => [
    attribute,
    Object.fromEntries(levels.map(level => [
      level,
      Number(character.attributes[level]?.[attribute] ?? 0),
    ])),
  ]));
}

function buildAkeOperatorBuffEffects(
  character: AkeCharacter,
  group: 'talent' | 'potential' | 'skill',
  additionalLoadouts: AkeLoadoutEffect[] = [],
) {
  const loadouts = [
    ...(character.loadoutEffects?.[group] ?? []),
    ...additionalLoadouts,
  ];
  return Object.fromEntries(loadouts.flatMap((loadout) => (
    loadout.effects.map((effect) => [effect.effectId, {
      schemaVersion: 2,
      effectId: effect.effectId,
      name: effect.name || loadout.name,
      type: effect.type,
      category: effect.category,
      value: effect.value,
      ...(typeof effect.maxStacks === 'number' ? { maxStacks: effect.maxStacks } : {}),
      ...(effect.unit ? { unit: effect.unit } : {}),
      ...(effect.activation ? { activation: effect.activation } : {}),
      ...(typeof effect.durationSeconds === 'number'
        ? { durationSeconds: effect.durationSeconds }
        : {}),
      description: effect.description || loadout.description,
      raw: effect.raw || loadout.description,
      valueMode: 'fixed',
      effectKind: effect.effectKind ?? 'modifier',
      ...(effect.effectKind === 'extraHit' && effect.extraHitConfig
        ? { extraHitConfig: effect.extraHitConfig }
        : {}),
    }])
  )));
}

function buildAkeTimingSkillLoadoutEffects(
  character: AkeCharacter,
  timingProfiles: AkeTimingSkillProfile[],
): AkeLoadoutEffect[] {
  return character.skills.flatMap((skill) => {
    const skillIds = new Set(skill.skillIds?.length > 0 ? skill.skillIds : [skill.groupId]);
    const profiles = timingProfiles.filter((profile) => (
      skillIds.has(profile.skillId) && profile.commandType === skill.commandType
    ));
    const seen = new Set<string>();
    const effects: AkeLoadoutBuffEffect[] = [];
    profiles.forEach((profile) => {
      const hitBuffs = mergeAkeHitBuffProfiles(
        profile.statusEffects,
        ...profile.hits.map((hit) => hit.hitBuffs),
      );
      hitBuffs.forEach((hitBuff) => {
        (hitBuff.effects ?? []).forEach((effect) => {
          const key = [
            effect.sourceBuffId,
            effect.type,
            effect.value,
            effect.category,
            effect.maxStacks ?? '',
            effect.durationSeconds ?? '',
          ].join('|');
          if (seen.has(key)) return;
          seen.add(key);
          const durationText = typeof effect.durationSeconds === 'number'
            ? `，持续 ${effect.durationSeconds} 秒`
            : '';
          effects.push({
            effectId: `skill:${skill.groupId}:${effect.sourceBuffId}:${effects.length + 1}`,
            name: `技能·${skill.name}·${akeEffectLabel(effect.type)}`,
            type: effect.type,
            category: effect.category ?? 'condition',
            value: effect.value,
            ...(typeof effect.maxStacks === 'number' ? { maxStacks: effect.maxStacks } : {}),
            ...(effect.unit ? { unit: effect.unit } : {}),
            ...(typeof effect.durationSeconds === 'number'
              ? { durationSeconds: effect.durationSeconds }
              : {}),
            description: `${skill.name}命中施加${hitBuff.displayName}：${akeEffectLabel(effect.type)}${durationText}`,
            raw: hitBuff.description
              || `AKE 命中动作 · ${hitBuff.targetLabel || hitBuff.target} · ${hitBuff.id}`,
          });
        });
      });
    });
    return effects.length > 0 ? [{
      effectId: `skill:${skill.groupId}`,
      name: `技能·${skill.name}`,
      description: skill.description,
      level: 12,
      effects,
    }] : [];
  });
}

function intentTimingProfiles(
  skill: AkeSkill,
  type: 'A' | 'B' | 'E' | 'Q',
  timingProfiles: AkeTimingSkillProfile[]
): AkeTimingSkillProfile[] {
  const ids = skill.skillIds?.length > 0 ? skill.skillIds : [skill.groupId];
  const matched = ids.flatMap(skillId => {
    const profile = timingProfiles.find(candidate => (
      candidate.skillId === skillId && candidate.commandType === skill.commandType
    ));
    return profile ? [profile] : [];
  });

  // One A button represents the complete basic-attack chain. Other buttons are
  // player intents whose enhanced forms remain selected by the runtime state
  // machine, so their editor template starts from the primary/base profile.
  return type === 'A' ? matched : matched.slice(0, 1);
}

function mergeAkeHitBuffProfiles(...groups: Array<AkeHitBuffProfile[] | undefined>): AkeHitBuffProfile[] {
  return [...new Map(groups
    .flatMap((group) => group ?? [])
    .map((effect) => [`${effect.id}\u0000${effect.target}`, effect])).values()];
}

function buildIntentHitMeta(
  skill: AkeSkill,
  type: 'A' | 'B' | 'E' | 'Q',
  timingProfiles: AkeTimingSkillProfile[],
  fallbackElement: ReturnType<typeof elementType>
) {
  const profiles = intentTimingProfiles(skill, type, timingProfiles);
  const expandedHits = profiles.flatMap((profile, profileIndex) => {
    let profileHitIndex = 0;
    return profile.hits.flatMap(hit => Array.from(
      { length: Math.max(1, hit.hitCount) },
      () => {
        profileHitIndex += 1;
        return { profileIndex, profileHitIndex, hit };
      }
    ));
  });
  const unprojectedStatusEffectsByProfile = profiles.map((profile) => {
    const projectedKeys = new Set(profile.hits.flatMap((hit) => (
      (hit.hitBuffs ?? []).map((effect) => `${effect.id}\u0000${effect.target}`)
    )));
    return mergeAkeHitBuffProfiles(profile.statusEffects)
      .filter((effect) => !projectedKeys.has(`${effect.id}\u0000${effect.target}`));
  });
  const expandedHitCountsByProfile = profiles.map((profile) => profile.hits.reduce(
    (count, hit) => count + Math.max(1, hit.hitCount),
    0,
  ));

  if (expandedHits.length === 0) {
    return {
      hitCount: 1,
      hitMeta: {
        hit1: {
          displayName: 'AKE 实际命中',
          element: fallbackElement,
          skillType: type,
          hitBuffs: mergeAkeHitBuffProfiles(...profiles.map((profile) => profile.statusEffects)),
          levels: Object.fromEntries(LEVEL_KEYS.map(level => [level, 0])),
        },
      },
    };
  }

  const showAttackStage = type === 'A' && profiles.length > 1;
  return {
    hitCount: expandedHits.length,
    hitMeta: Object.fromEntries(expandedHits.map((entry, index) => [
      `hit${index + 1}`,
      {
        displayName: showAttackStage
          ? `第${entry.profileIndex + 1}段 · 第${entry.profileHitIndex}击`
          : `第${index + 1}击`,
        element: entry.hit.damageType
          ? elementType(entry.hit.damageType)
          : fallbackElement,
        skillType: type,
        hitBuffs: mergeAkeHitBuffProfiles(
          entry.hit.hitBuffs,
          entry.profileHitIndex === expandedHitCountsByProfile[entry.profileIndex]
            ? unprojectedStatusEffectsByProfile[entry.profileIndex]
            : undefined,
        ),
        levels: Object.fromEntries(LEVEL_KEYS.map(level => [
          level,
          Number(entry.hit.levels?.[level] ?? 0),
        ])),
      },
    ])),
  };
}

export function buildAkeOperatorLibrary(catalog: AkeCatalog) {
  return Object.fromEntries(catalog.characters
    .filter(character => character.id !== 'chr_9000_endmin')
    .map((character) => {
    const timingProfiles = catalog.timing?.characters[character.id]?.profiles ?? [];
    const timingSkillLoadoutEffects = buildAkeTimingSkillLoadoutEffects(
      character,
      timingProfiles,
    );
    const skills = Object.fromEntries(character.skills.flatMap((skill) => {
      const type = buttonType(skill.commandType);
      if (!type) return [];
      const ids = skill.skillIds?.length > 0 ? skill.skillIds : [skill.groupId];
      // The editor exposes player intent (A/B/E/Q), not raw SkillData forms.
      // Combo stages and enhanced variants remain in the timing catalog and
      // are selected by the runtime state machine when the button executes.
      const skillId = ids[0];
      const resolvedHits = buildIntentHitMeta(
        skill,
        type,
        timingProfiles,
        elementType(character.elementId)
      );
      return [[skillId, {
        displayName: skill.name,
        buttonType: type,
        iconUrl: skill.iconUrl,
        hitCount: resolvedHits.hitCount,
        hitMeta: resolvedHits.hitMeta,
        description: skill.description,
      }]];
    }));
    return [character.id, {
      id: character.id,
      name: character.id === 'chr_0002_endminm'
        ? '管理员（男）'
        : character.id === 'chr_0003_endminf'
          ? '管理员（女）'
          : character.name,
      nameEn: character.englishName || character.id,
      avatarUrl: character.iconUrl,
      rarity: character.rarity,
      profession: character.profession,
      weapon: character.weaponType,
      defaultWeaponId: character.defaultWeaponId,
      element: elementType(character.elementId),
      mainStat: character.mainAttributeLabel || '',
      subStat: character.subAttributeLabel || '',
      level: 90,
      attributes: operatorAttributeLevels(character),
      skills,
      buffs: {
        talent: { effects: buildAkeOperatorBuffEffects(character, 'talent') },
        potential: { effects: buildAkeOperatorBuffEffects(character, 'potential') },
        skill: {
          effects: buildAkeOperatorBuffEffects(
            character,
            'skill',
            timingSkillLoadoutEffects,
          ),
        },
      },
      akeSource: catalog.source,
    }];
  }));
}

const PRIMARY_STAT_TYPE = new Map<string, string>([
  ['attr_main', '主能力提升'],
  ['attr_str', '力量提升'],
  ['attr_agi', '敏捷提升'],
  ['attr_wisd', '智识提升'],
  ['attr_will', '意志提升'],
]);

const SECONDARY_STAT_TYPE = new Map<string, string>([
  ['attr_atk', '攻击提升'],
  ['attr_hp', '生命提升'],
  ['attr_phydam', '物理伤害提升'],
  ['attr_firedam', '灼热伤害提升'],
  ['attr_pulsedam', '电磁伤害提升'],
  ['attr_icedam', '寒冷伤害提升'],
  ['attr_naturaldam', '自然伤害提升'],
  ['attr_crirate', '暴击率提升'],
  ['attr_physpell', '源石技艺提升'],
  ['attr_usp', '终结技充能效率提升'],
  ['attr_magicdam', '法术伤害提升'],
  ['attr_heal', '治疗效率提升'],
]);

function patchValue(level: AkeWeaponSkillLevel) {
  const value = Object.values(level.blackboard).find(entry => (
    typeof entry === 'number' && Number.isFinite(entry)
  ));
  return typeof value === 'number' ? value : undefined;
}

function patchLevels(patch: AkeWeaponSkillPatch | undefined) {
  return Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
    const level = patch?.levels.find(entry => entry.level === index + 1);
    return [String(index + 1), {
      value: level ? patchValue(level) : undefined,
      description: level?.description || '',
    }];
  }));
}

function passiveLevels(patch: AkeWeaponSkillPatch | undefined, fallback: string) {
  return Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
    const level = patch?.levels.find(entry => entry.level === index + 1);
    return [String(index + 1), {
      description: level?.description || fallback,
    }];
  }));
}

const AKE_EFFECT_LABELS: Record<string, string> = {
  atkPercentBoost: '攻击力提升',
  flatAtk: '固定攻击力',
  mainStatBoost: '主能力提升',
  subStatBoost: '副能力提升',
  strengthBoost: '力量提升',
  agilityBoost: '敏捷提升',
  intelligenceBoost: '智识提升',
  willBoost: '意志提升',
  critRateBoost: '暴击率提升',
  critDmgBonusBoost: '暴击伤害提升',
  physicalDmgBonus: '物理伤害提升',
  fireDmgBonus: '灼热伤害提升',
  electricDmgBonus: '电磁伤害提升',
  iceDmgBonus: '寒冷伤害提升',
  natureDmgBonus: '自然伤害提升',
  magicDmgBonus: '法术伤害提升',
  allDmgBonus: '全伤害提升',
  normalAttackDmgBonus: '普通攻击伤害提升',
  skillDmgBonus: '战技伤害提升',
  chainSkillDmgBonus: '连携技伤害提升',
  ultimateDmgBonus: '终结技伤害提升',
  allSkillDmgBonus: '所有技能伤害提升',
  imbalanceDmgBonus: '失衡目标伤害提升',
  imbalanceEfficiency: '失衡效率',
  extraHit: '物理异常追加伤害',
  physicalVulnerability: '物理脆弱',
  magicVulnerability: '法术脆弱',
  fireVulnerability: '灼热脆弱',
  electricVulnerability: '电磁脆弱',
  iceVulnerability: '寒冷脆弱',
  natureVulnerability: '自然脆弱',
  physicalResistanceIgnore: '物理抗性无视',
  fireResistanceIgnore: '灼热抗性无视',
  electricResistanceIgnore: '电磁抗性无视',
  iceResistanceIgnore: '寒冷抗性无视',
  natureResistanceIgnore: '自然抗性无视',
};

function akeEffectLabel(type: string): string {
  return AKE_EFFECT_LABELS[type] || type;
}

function weaponPassiveEffects(patch: AkeWeaponSkillPatch | undefined) {
  if (!patch) return {};
  const grouped = new Map<string, {
    effectId: string;
    effect: AkeCatalogNumericEffect;
    levels: Record<string, number>;
    descriptions: Record<string, string>;
  }>();
  patch.levels.forEach((level) => {
    (level.effects ?? []).forEach((effect) => {
      const key = `${effect.sourceBuffId}|${effect.type}|${effect.category}`;
      const current = grouped.get(key) ?? {
        effectId: `ake-${grouped.size + 1}`,
        effect,
        levels: {},
        descriptions: {},
      };
      current.levels[String(level.level)] = effect.value;
      current.descriptions[String(level.level)] = level.description;
      grouped.set(key, current);
    });
  });
  return Object.fromEntries([...grouped.values()].map(({ effectId, effect, levels, descriptions }) => [effectId, {
    schemaVersion: 2,
    effectId,
    name: `${patch.name}·${akeEffectLabel(effect.type)}`,
    type: effect.type,
    category: effect.category,
    levels,
    unit: effect.unit,
    ...(typeof effect.maxStacks === 'number' ? { maxStacks: effect.maxStacks } : {}),
    raw: descriptions,
    valueMode: 'fixed',
    effectKind: 'modifier',
  }]));
}

export function buildAkeWeaponLibrary(catalog: AkeCatalog) {
  return Object.fromEntries(catalog.weapons.map((weapon) => {
    const primary = weapon.skillPatches.find(skill => skill.role === 'primary');
    const secondary = weapon.skillPatches.find(skill => skill.role === 'secondary');
    const passive = weapon.skillPatches.find(skill => skill.role === 'passive');
    return [weapon.name, {
    id: weapon.id,
    name: weapon.name,
    rarity: weapon.rarity,
    type: weapon.weaponType,
    description: weapon.description,
    imgUrl: weapon.iconUrl,
    attackGrowth: weapon.attackGrowth,
    skills: {
      skill1: {
        name: primary?.name || '主能力词条',
        statType: PRIMARY_STAT_TYPE.get(primary?.tagId || '') || primary?.name || '主能力提升',
        levels: patchLevels(primary),
        effects: {},
      },
      skill2: {
        name: secondary?.name || '无第二词条',
        statType: secondary
          ? SECONDARY_STAT_TYPE.get(secondary.tagId) || secondary.name
          : '',
        levels: patchLevels(secondary),
        effects: {},
      },
      skill3: {
        name: passive?.name || weapon.name,
        levels: passiveLevels(passive, weapon.description || '无固有被动描述'),
        effects: weaponPassiveEffects(passive),
      },
    },
    akeSource: catalog.source,
    }];
  }));
}

type EquipmentEffectMeta = {
  label: string;
  typeKey: string;
  unit: 'flat' | 'percent';
  transform?: (value: number) => number;
};

const EQUIPMENT_TYPE = new Map<number, EquipmentEffectMeta>([
  [1, { label: '生命', typeKey: 'hpPercent', unit: 'percent' }],
  [2, { label: '攻击力', typeKey: 'atkPercentBoost', unit: 'percent' }],
  [9, { label: '暴击率', typeKey: 'critRateBoost', unit: 'percent' }],
  [17, { label: '普通攻击伤害', typeKey: 'normalAttackDmgBonus', unit: 'percent' }],
  [28, { label: '终结技伤害', typeKey: 'ultimateDmgBonus', unit: 'percent' }],
  [29, { label: '治疗效率', typeKey: 'healingBonus', unit: 'percent' }],
  [32, { label: '战技伤害', typeKey: 'skillDmgBonus', unit: 'percent' }],
  [33, { label: '连携技伤害', typeKey: 'chainSkillDmgBonus', unit: 'percent' }],
  [39, { label: '力量', typeKey: 'strengthBoost', unit: 'flat' }],
  [40, { label: '敏捷', typeKey: 'agilityBoost', unit: 'flat' }],
  [41, { label: '智识', typeKey: 'intelligenceBoost', unit: 'flat' }],
  [42, { label: '意志', typeKey: 'willBoost', unit: 'flat' }],
  [44, { label: '终结技充能效率', typeKey: 'ultimateChargeEfficiency', unit: 'percent' }],
  [50, { label: '物理伤害', typeKey: 'physicalDmgBonus', unit: 'percent' }],
  [51, { label: '灼热伤害', typeKey: 'fireDmgBonus', unit: 'percent' }],
  [52, { label: '电磁伤害', typeKey: 'electricDmgBonus', unit: 'percent' }],
  [53, { label: '寒冷伤害', typeKey: 'iceDmgBonus', unit: 'percent' }],
  [54, { label: '自然伤害', typeKey: 'natureDmgBonus', unit: 'percent' }],
  [61, { label: '失衡目标伤害', typeKey: 'imbalanceDmgBonus', unit: 'percent' }],
  [87, { label: '源石技艺强度', typeKey: 'sourceSkillBoost', unit: 'flat' }],
]);

const EQUIPMENT_COMPOSITE_TYPE = new Map<string, EquipmentEffectMeta>([
  ['Main', { label: '主能力', typeKey: 'mainStatBoost', unit: 'percent' }],
  ['Sub', { label: '副能力', typeKey: 'subStatBoost', unit: 'percent' }],
  ['AllSkillDamageIncrease', { label: '所有技能伤害', typeKey: 'allSkillDmgBonus', unit: 'percent' }],
  ['CrystAndPulseDamageIncrease', { label: '寒冷和电磁伤害', typeKey: 'iceElectricDmgBonus', unit: 'percent' }],
  ['FireAndNaturalDamageIncrease', { label: '灼热和自然伤害', typeKey: 'fireNatureDmgBonus', unit: 'percent' }],
  ['SpellDamageIncrease', { label: '法术伤害', typeKey: 'magicDmgBonus', unit: 'percent' }],
  ['AllDamageTakenScalar', {
    label: '全伤害减免',
    typeKey: 'damageReduction',
    unit: 'percent',
    transform: value => Math.max(0, 1 - value),
  }],
]);

function equipmentEffectMeta(modifier: AkeEquipmentModifier): EquipmentEffectMeta | null {
  const composite = modifier.compositeAttr
    ? EQUIPMENT_COMPOSITE_TYPE.get(modifier.compositeAttr)
    : undefined;
  if (composite) {
    if ((modifier.compositeAttr === 'Main' || modifier.compositeAttr === 'Sub')
      && modifier.modifierType !== 6) {
      return { ...composite, unit: 'flat' };
    }
    return composite;
  }
  const meta = EQUIPMENT_TYPE.get(modifier.attrType);
  if (!meta) return null;
  if ((modifier.attrType === 1 || modifier.attrType === 2) && modifier.modifierType === 7) {
    return {
      label: meta.label,
      typeKey: modifier.attrType === 1 ? 'flatHp' : 'flatAtk',
      unit: 'flat',
    };
  }
  return meta;
}

function equipmentEffects(equipment: AkeEquipment) {
  const visible = equipment.modifiers
    .map(modifier => ({ modifier, meta: equipmentEffectMeta(modifier) }))
    .filter((entry): entry is { modifier: AkeEquipmentModifier; meta: EquipmentEffectMeta } => Boolean(entry.meta))
    .slice(0, 3);
  return Object.fromEntries(visible.map(({ modifier, meta }, index) => {
    const lastValue = modifier.values[modifier.values.length - 1] ?? 0;
    const values = Array.from({ length: 4 }, (_, level) => Number(
      modifier.values[level] ?? lastValue
    )).map(value => meta.transform ? meta.transform(value) : value);
    const effectId = `effect${index + 1}`;
    return [effectId, {
      effectId,
      label: meta.label,
      typeKey: meta.typeKey,
      category: [39, 40, 41, 42].includes(modifier.attrType) || meta.unit === 'flat' && ['mainStatBoost', 'subStatBoost'].includes(meta.typeKey)
        ? 'ability'
        : 'buff',
      levels: Object.fromEntries(values.map((value, level) => [String(level), value])),
      unit: meta.unit,
      raw: `${meta.label}：${values.map(value => `+${value}`).join('/')}`,
    }];
  }));
}

function suitThreePieceBuffs(suit: AkeSuit) {
  let index = 0;
  return Object.fromEntries((suit.bonuses ?? [])
    .filter((bonus) => bonus.count >= 3)
    .flatMap((bonus) => (bonus.effects ?? []).map((effect) => {
      index += 1;
      const effectId = `ake-${bonus.skillId}-${index}`;
      const durationText = typeof effect.durationSeconds === 'number' && effect.durationSeconds > 0
        ? `（持续 ${effect.durationSeconds.toFixed(2)} 秒）`
        : '';
      const description = `${bonus.description || `${suit.name}三件套效果`}${durationText}`;
      const isExtraHit = effect.effectKind === 'extraHit' && Boolean(effect.extraHitConfig);
      return [effectId, {
        effectId,
        name: `${suit.name}·${akeEffectLabel(effect.type)}`,
        category: effect.category,
        typeKey: effect.type,
        value: effect.value,
        unit: effect.unit === 'flat' ? 'flat' : 'percent',
        description,
        raw: description,
        valueMode: 'fixed',
        ...(typeof effect.maxStacks === 'number' ? { maxStacks: effect.maxStacks } : {}),
        effectKind: isExtraHit ? 'extraHit' : 'modifier',
        ...(isExtraHit ? { extraHitConfig: effect.extraHitConfig } : {}),
      }];
    })));
}

export function buildAkeEquipmentLibrary(catalog: AkeCatalog) {
  const equipmentById = new Map(catalog.equipment.map(item => [item.id, item]));
  const knownSuitIds = new Set(catalog.suits.map(suit => suit.id));
  const looseSuitIds = new Set(catalog.equipment.flatMap(item => (
    item.suitId && !knownSuitIds.has(item.suitId) ? [item.suitId] : []
  )));
  const suits = [
    ...catalog.suits,
    ...[...looseSuitIds].map(id => ({
      id,
      name: id,
      equipmentIds: catalog.equipment.filter(item => item.suitId === id).map(item => item.id),
    })),
  ];
  return {
    gearSets: Object.fromEntries(suits.map(suit => [suit.id, {
      gearSetId: suit.id,
      name: suit.name,
      ...(Object.keys(suitThreePieceBuffs(suit)).length > 0
        ? { threePieceBuffs: suitThreePieceBuffs(suit) }
        : {}),
      equipments: Object.fromEntries(suit.equipmentIds.flatMap((equipmentId) => {
        const equipment = equipmentById.get(equipmentId);
        if (!equipment) return [];
        return [[equipment.id, {
          equipmentId: equipment.id,
          name: equipment.name,
          part: equipment.partName,
          imgUrl: equipment.iconUrl,
          fixedStat: equipment.baseModifier
            ? {
                label: equipment.baseModifier.attrType === 3 ? '防御力' : equipment.baseModifier.attribute,
                typeKey: equipment.baseModifier.attrType === 3 ? 'defense' : equipment.baseModifier.attribute,
                value: equipment.baseModifier.values[0] ?? 0,
                unit: 'flat',
                raw: `${equipment.baseModifier.attrType === 3 ? '防御力' : equipment.baseModifier.attribute}：+${equipment.baseModifier.values[0] ?? 0}`,
              }
            : { label: 'AKE 装备', raw: equipment.description },
          effects: equipmentEffects(equipment),
        }]];
      })),
    }])),
    updatedAt: catalog.source.sharedRevision || catalog.source.version || '',
  };
}

export async function installAkeCatalogData(): Promise<AkeCatalog> {
  if (installedCatalog) return installedCatalog;
  const response = await fetch('/api/ake/catalog', { cache: 'no-store' });
  const catalog = await response.json() as AkeCatalog & { error?: string };
  if (!response.ok) throw new Error(catalog.error || `AKE 目录载入失败：HTTP ${response.status}`);
  installedCatalog = catalog;
  const revision = [
    `adapter-${CATALOG_ADAPTER_VERSION}`,
    catalog.source.version,
    catalog.source.sharedRevision,
  ].filter(Boolean).join('@');
  if (persistentLocalStorage.getItem(CATALOG_REVISION_KEY) !== revision) {
    persistentLocalStorage.setItem(OPERATOR_LIBRARY_KEY, JSON.stringify(buildAkeOperatorLibrary(catalog)));
    persistentLocalStorage.setItem(WEAPON_LIBRARY_KEY, JSON.stringify(buildAkeWeaponLibrary(catalog)));
    persistentLocalStorage.setItem(EQUIPMENT_LIBRARY_KEY, JSON.stringify(buildAkeEquipmentLibrary(catalog)));
    persistentLocalStorage.setItem(CATALOG_REVISION_KEY, revision);
    window.dispatchEvent(new CustomEvent(LOCAL_LIBRARY_CHANGED_EVENT));
  }
  return catalog;
}
