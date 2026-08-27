import type { Character, HitBuffEffect, HitSkillType } from '../types';

export type OperatorSkillKey = 'A' | 'B' | 'E' | 'Q' | 'Dot';

export type SkillHitDetail = {
  key: string;
  displayName: string;
  value: number | string;
  element: string;
  skillType: HitSkillType;
  hitBuffs: HitBuffEffect[];
};

export type SkillDetailGroup = {
  id: string;
  displayName: string;
  buttonType: OperatorSkillKey;
  iconUrl?: string;
  hits: SkillHitDetail[];
  buffs: HitBuffEffect[];
  hiddenBuffCount: number;
};

function hitBuffIdentity(buff: HitBuffEffect): string {
  return [buff.id, buff.target, buff.statusKey ?? ''].join('\u0000');
}

export function visibleSkillHitBuffs(buffs: readonly HitBuffEffect[]): HitBuffEffect[] {
  return buffs.filter((buff) => buff.hidden !== true);
}

function summarizeSkillHitBuffs(hits: readonly SkillHitDetail[]) {
  const all = [...new Map(hits
    .flatMap((hit) => hit.hitBuffs)
    .map((buff) => [hitBuffIdentity(buff), buff])).values()];
  const buffs = visibleSkillHitBuffs(all);
  return {
    buffs,
    hiddenBuffCount: all.length - buffs.length,
  };
}

function resolveHitValue(
  hit: { multiplier?: number; levels?: Record<string, number> },
  levelKey: string,
): number | string {
  const leveledValue = hit.levels?.[levelKey];
  if (typeof leveledValue === 'number') return leveledValue;
  if (typeof hit.multiplier === 'number') return hit.multiplier;
  return '-';
}

function buildFallbackSkillDetails(
  skillKey: OperatorSkillKey,
  skill: Character['skills'][keyof Character['skills']] | undefined,
  levelKey: string,
): SkillDetailGroup[] {
  if (!skill) return [];

  const multiplier = skill.multipliers[levelKey] ?? skill.multipliers.M3 ?? {};
  const hits = Object.entries(multiplier)
    .filter(([, value]) => typeof value === 'number')
    .map(([hitKey, value]) => ({
      key: hitKey,
      displayName: hitKey,
      value: value ?? '-',
      element: 'unknown',
      skillType: skillKey,
      hitBuffs: [],
    }));

  return [{
    id: skillKey,
    displayName: skill.name || skillKey,
    buttonType: skillKey,
    hits,
    buffs: [],
    hiddenBuffCount: 0,
  }];
}

export function buildSkillDetailGroups(
  character: Partial<Character>,
  skillKey: OperatorSkillKey,
  levelKey: string,
): SkillDetailGroup[] {
  const sandboxSkills = character.sandboxSkills ?? [];
  const sandboxGroups = sandboxSkills
    .filter((skill) => skill.buttonType === skillKey)
    .map((skill) => {
      const hits = (skill.customHits ?? []).map((hit) => ({
        key: hit.key,
        displayName: hit.displayName || hit.key,
        value: resolveHitValue(hit, levelKey),
        element: hit.element,
        skillType: hit.skillType,
        hitBuffs: hit.hitBuffs ?? [],
      }));
      return {
        id: skill.id,
        displayName: skill.displayName || skill.id,
        buttonType: skillKey,
        iconUrl: skill.iconUrl,
        hits,
        ...summarizeSkillHitBuffs(hits),
      };
    });

  if (sandboxGroups.length > 0) return sandboxGroups;

  const fallbackByKey: Record<OperatorSkillKey, Character['skills'][keyof Character['skills']] | undefined> = {
    A: character.skills?.normalAttack,
    B: character.skills?.skill,
    E: character.skills?.chainSkill,
    Q: character.skills?.ultimate,
    Dot: undefined,
  };
  return buildFallbackSkillDetails(skillKey, fallbackByKey[skillKey], levelKey);
}
