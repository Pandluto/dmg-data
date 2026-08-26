import type {
  ElementType,
  HitBuffEffect,
  HitSkillType,
  SkillButton as SkillButtonType,
} from '../../types';
import type { ResolvedHitTemplate, ResolvedSkillDamageTemplate } from '../calculators/skillDamage.types';
import type { RuntimeOperatorTemplateSkill } from '../templates/operatorTemplate';
import { getCharacterInput, getRuntimeOperatorTemplateById } from '../../utils/storage';

type LeveledHit = {
  multiplier: number;
  levels?: Record<string, number>;
};

export interface AkeResolvedDamageProfileInput {
  skillId: string;
  hits: Array<{
    damageType?: string | null;
    damageTypes?: string[];
    levels?: Record<string, number>;
    hitBuffs?: HitBuffEffect[];
  }>;
  statusEffects?: HitBuffEffect[];
}

function resolveSkillLevelMode(button: SkillButtonType): string {
  return getCharacterInput(button.characterId)?.skillLevels?.[button.skillType] ?? 'M3';
}

function resolveHitMultiplier(hit: LeveledHit, levelKey: string): number {
  return hit.levels?.[levelKey] ?? hit.multiplier;
}

function elementFromAkeDamageType(
  damageType: string | null | undefined,
  fallback: ElementType,
): ElementType {
  const normalized = String(damageType ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'fire' || normalized.includes('fire')) return 'fire';
  if (normalized === 'cryst' || normalized === 'ice' || normalized.includes('cold')) return 'ice';
  if (normalized === 'pulse' || normalized === 'electric' || normalized.includes('lightning')) return 'electric';
  if (normalized === 'natural' || normalized === 'nature') return 'nature';
  return 'physical';
}

function hitBuffAtLevel(effect: HitBuffEffect, levelKey: string): HitBuffEffect {
  const leveledValue = effect.statusValueLevels?.[levelKey];
  return typeof leveledValue === 'number' && Number.isFinite(leveledValue)
    ? { ...effect, statusValue: leveledValue }
    : effect;
}

/**
 * Converts the profile selected by the realtime AKE state machine into the
 * calculator's actual hit template.  The button's persisted template is only a
 * display fallback; runtime hit multipliers and hit Buffs remain authoritative.
 */
export function resolveAkePreviewSkillDamageTemplate(
  button: SkillButtonType,
  profile: AkeResolvedDamageProfileInput | null | undefined,
  levelKey: string,
  fallback: ResolvedSkillDamageTemplate | null = null,
): ResolvedSkillDamageTemplate | null {
  if (!profile || profile.hits.length === 0) return fallback;

  const projectedStatusIds = new Set(
    profile.hits.flatMap((hit) => (hit.hitBuffs ?? []).map((effect) => effect.id)),
  );
  const unprojectedStatusEffects = (profile.statusEffects ?? [])
    .filter((effect) => !projectedStatusIds.has(effect.id));

  return {
    characterId: button.characterId,
    characterName: button.characterName,
    runtimeSkillId: profile.skillId,
    displayName: fallback?.displayName ?? button.skillDisplayName ?? button.skillType,
    buttonType: button.skillType,
    hits: profile.hits.map((hit, index): ResolvedHitTemplate => {
      const fallbackHit = fallback?.hits[index];
      const resolvedMultiplier = hit.levels?.[levelKey];
      const primaryDamageType = hit.damageType ?? hit.damageTypes?.[0] ?? null;
      const hitBuffs = [
        ...(hit.hitBuffs ?? []),
        ...(index === profile.hits.length - 1 ? unprojectedStatusEffects : []),
      ].map((effect) => hitBuffAtLevel(effect, levelKey));
      return {
        key: fallbackHit?.key ?? `hit${index + 1}`,
        displayName: fallbackHit?.displayName ?? `第${index + 1}击`,
        multiplier: typeof resolvedMultiplier === 'number' && Number.isFinite(resolvedMultiplier)
          ? resolvedMultiplier
          : fallbackHit?.multiplier ?? 0,
        element: elementFromAkeDamageType(
          primaryDamageType,
          (fallbackHit?.element ?? button.element ?? 'physical') as ElementType,
        ),
        skillType: button.skillType as HitSkillType,
        hitBuffs,
      };
    }),
  };
}

function normalizeHits(
  button: SkillButtonType,
  runtimeSkillId: string,
  displayName: string,
  hits: Array<{
    key: string;
    displayName: string;
    multiplier: number;
    levels?: Record<string, number>;
    element: SkillButtonType['element'];
    skillType: HitSkillType;
    hitBuffs?: ResolvedHitTemplate['hitBuffs'];
  }>,
  levelKey = resolveSkillLevelMode(button)
): ResolvedSkillDamageTemplate {
  return {
    characterId: button.characterId,
    characterName: button.characterName,
    runtimeSkillId,
    displayName,
    buttonType: button.skillType,
    hits: hits.map((hit): ResolvedHitTemplate => ({
      key: hit.key,
      displayName: hit.displayName,
      multiplier: resolveHitMultiplier(hit, levelKey),
      element: (hit.element ?? button.element ?? 'physical') as ResolvedHitTemplate['element'],
      skillType: hit.skillType,
      hitBuffs: hit.hitBuffs,
    })),
  };
}

function isTypedRuntimeSkillId(runtimeSkillId: string | undefined): boolean {
  return /^skill-(A|B|E|Q|Dot)-\d+$/.test(runtimeSkillId ?? '') || /^official-(A|B|E|Q|Dot)$/.test(runtimeSkillId ?? '');
}

function resolveLegacyRuntimeSkill(
  button: SkillButtonType,
  skills: RuntimeOperatorTemplateSkill[]
): RuntimeOperatorTemplateSkill | null {
  const runtimeSkillId = button.runtimeSkillId;
  if (!runtimeSkillId || isTypedRuntimeSkillId(runtimeSkillId)) {
    return null;
  }

  const legacyIndexMatch = runtimeSkillId.match(/^skill-(\d+)$/);
  if (legacyIndexMatch) {
    const legacyIndex = Number(legacyIndexMatch[1]);
    const sameTypeSkills = skills.filter((skill) => skill.buttonType === button.skillType);
    const candidate = Number.isInteger(legacyIndex) && legacyIndex > 0 ? sameTypeSkills[legacyIndex - 1] : undefined;
    if (candidate) {
      return candidate;
    }
  }

  const sameTypeSkills = skills.filter((skill) => skill.buttonType === button.skillType);
  if (sameTypeSkills.length === 1) {
    return sameTypeSkills[0];
  }

  return null;
}

export function resolveRuntimeTemplateSkill(
  button: SkillButtonType
): RuntimeOperatorTemplateSkill | null {
  if (button.timelineModuleKind) return null;
  const template = getRuntimeOperatorTemplateById(button.characterId);
  if (!template) {
    return null;
  }

  let runtimeSkill = template.skills.find((skill) => skill.id === button.runtimeSkillId);

  if (!runtimeSkill) {
    const legacyRuntimeSkill = resolveLegacyRuntimeSkill(button, template.skills);
    if (legacyRuntimeSkill) {
      runtimeSkill = legacyRuntimeSkill;
    } else if (button.runtimeSkillId) {
      console.warn(
        `[resolveSkillDamageTemplate] runtimeSkillId 未命中，fallback 到 buttonType:\n` +
        `  button.id=${button.id}\n` +
        `  characterId=${button.characterId}\n` +
        `  runtimeSkillId=${button.runtimeSkillId}\n` +
        `  skillType=${button.skillType}\n` +
        `  template.skills=[${template.skills.map(skill => skill.id).join(', ')}]`
      );
    }
    if (!runtimeSkill) {
      runtimeSkill = template.skills.find((skill) => skill.buttonType === button.skillType);
    }
  }

  return runtimeSkill ?? null;
}

export function resolveSkillDamageTemplate(
  button: SkillButtonType
): ResolvedSkillDamageTemplate | null {
  // Wait/switch/dodge nodes participate in scheduling only. Treating their
  // synthetic runtimeSkillId as an operator skill caused needless fallback
  // resolution on every realtime recompute and contributed to the old forced
  // wait UI stalls.
  if (button.timelineModuleKind) return null;
  const runtimeSkillId = button.runtimeSkillId ?? `${button.characterId}-${button.skillType}`;
  const displayName = button.skillDisplayName ?? button.skillType;

  const runtimeSkill = resolveRuntimeTemplateSkill(button);
  if (runtimeSkill) {
    return normalizeHits(
      button,
      runtimeSkill.id,
      runtimeSkill.displayName || displayName,
      runtimeSkill.hits.map((hit) => ({
        key: hit.key,
        displayName: hit.displayName,
        multiplier: hit.multiplier,
        levels: hit.levels,
        element: hit.element,
        skillType: hit.skillType,
        hitBuffs: hit.hitBuffs,
      }))
    );
  }

  if (button.customHits && button.customHits.length > 0) {
    return normalizeHits(button, runtimeSkillId, displayName, button.customHits);
  }

  console.warn(
    `[resolveSkillDamageTemplate] 未能解析技能模板:\n` +
    `  button.id=${button.id}\n` +
    `  characterId=${button.characterId}\n` +
    `  runtimeSkillId=${button.runtimeSkillId ?? 'N/A'}\n` +
    `  skillType=${button.skillType}`
  );
  return null;
}
