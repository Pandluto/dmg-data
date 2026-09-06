import type { DamageReportSnapshot } from '../../core/services/damageReportService';
import type { AkeRuntimeHit, AkeTeamReport } from './akeProvider';

/** Poise events carry numeric damage operands, but they are not HP damage. */
export function isAkeHealthDamageHit(hit: AkeRuntimeHit): boolean {
  return hit.damageAttributeType === 'Hp';
}

export function isAkeOutgoingDamageHit(report: AkeTeamReport, hit: AkeRuntimeHit): boolean {
  return isAkeHealthDamageHit(hit) && hit.targetId === report.enemyId;
}

export function buildAkeReportModel(report: AkeTeamReport, characterId = '') {
  const hits = report.hits.filter(hit => !characterId || resolveHitCharacter(report, hit)?.localCharacterId === characterId)
    .map((hit, index) => ({ ...hit, rowId: hit.hitId ?? `${hit.frame}-${hit.hitIndex}-${index}` }))
    .sort((a, b) => a.frame - b.frame || (a.sequence ?? a.hitIndex) - (b.sequence ?? b.hitIndex));
  const byOwner = new Map<string, number>();
  for (const hit of report.hits.filter(hit => isAkeOutgoingDamageHit(report, hit))) {
    const owner = resolveHitCharacter(report, hit)?.localCharacterId ?? '';
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + hit.finalDamage);
  }
  const distribution = report.characters.map(character => ({ id: character.localCharacterId, name: character.characterName,
    damage: byOwner.get(character.localCharacterId) ?? 0 }));
  const attributed = distribution.reduce((sum, item) => sum + item.damage, 0);
  const allHitDamage = report.hits.filter(hit => isAkeOutgoingDamageHit(report, hit)).reduce((sum, hit) => sum + hit.finalDamage, 0);
  if (Math.abs(allHitDamage - attributed) > .001) distribution.push({ id: 'unattributed', name: '其他伤害来源', damage: allHitDamage - attributed });
  const rawHpDamage = report.hits.filter(isAkeHealthDamageHit).reduce((sum, hit) => sum + hit.finalDamage, 0);
  const frameTotals = new Map<number, number>();
  for (const hit of hits.filter(hit => isAkeOutgoingDamageHit(report, hit))) frameTotals.set(hit.frame, (frameTotals.get(hit.frame) ?? 0) + hit.finalDamage);
  let cumulative = 0;
  const curve = [{ frame: 0, damage: 0 }, ...[...frameTotals].map(([frame, damage]) => ({ frame, damage: cumulative += damage }))];
  const endFrame = Math.max(report.durationFrames, hits[hits.length - 1]?.frame ?? 0, 1);
  if (curve[curve.length - 1].frame < endFrame) curve.push({ frame: endFrame, damage: cumulative });
  const partial = report.admissionStatus !== 'valid' || report.summary.failedCommands > 0
    || report.summary.unsupportedCharacters > 0 || report.characters.some(character => character.status === 'error' || character.skippedButtonIds.length > 0)
    || (report.diagnostics?.unresolvedEffectCount ?? 0) > 0 || (report.diagnostics?.compilerUnresolvedEffectCount ?? 0) > 0;
  return { hits, curve, distribution, endFrame, total: cumulative, partial,
    durationSeconds: endFrame / report.tickRate, hitDamageDelta: rawHpDamage - report.summary.totalDamage, excludedHpDamage: rawHpDamage - allHitDamage };
}

export function resolveHitCharacter(report: AkeTeamReport, hit: AkeRuntimeHit) {
  // memberId/characterId are engine attribution. ownerId can be an enemy carrying a DoT or an ability entity.
  for (const id of [hit.memberId, hit.characterId, hit.sourceId, hit.ownerId]) {
    if (!id) continue;
    const character = report.characters.find(character => [character.memberId, character.akeCharacterId, character.localCharacterId].includes(id));
    if (character) return character;
  }
  return undefined;
}

export function akeHitCharacterName(report: AkeTeamReport, hit: AkeRuntimeHit) {
  return resolveHitCharacter(report, hit)?.characterName ?? '其他来源';
}

/** Compatibility projection for the workbench command API, from settled AKE facts only. */
export function buildAkeWorkbenchDamageSnapshot(report: AkeTeamReport | null): DamageReportSnapshot {
  const empty: DamageReportSnapshot = { generatedAt: 0, totalDamage: 0, totalExpected: 0, totalNonCrit: 0, buttonCount: 0, buttons: [], characters: [] };
  if (!report) return empty;
  const buttons = report.characters.flatMap(character => (character.simulation?.commands ?? []).map(command => {
    return { id: command.commandId, characterId: character.localCharacterId, characterName: character.characterName,
      groupLabel: 'AKE', orderLabel: `F${command.actualFrame ?? command.requestedFrame}`, skillName: command.skillId ?? command.commandType,
      skillType: command.commandType, damage: 0, expected: 0, nonCrit: 0, share: 0, hits: [] };
  }));
  const byId = new Map(buttons.map(button => [button.id, button]));
  const byCast = new Map(report.characters.flatMap(character => (character.simulation?.commands ?? [])
    .flatMap(command => command.castId ? [[command.castId, command.commandId] as const] : [])));
  // Every settled hit belongs to exactly one display row, including deferred DoTs
  // and passive entities that have no input command. Never duplicate cast totals.
  for (const hit of report.hits.filter(hit => isAkeOutgoingDamageHit(report, hit))) {
    const owner = resolveHitCharacter(report, hit);
    const commandId = byCast.get(hit.rootCastId ?? '') ?? byCast.get(hit.castId ?? '');
    let row = commandId ? byId.get(commandId) : undefined;
    if (!row || row.characterId !== owner?.localCharacterId) {
      const id = `event:${owner?.localCharacterId ?? 'unknown'}:${hit.rootSkillId ?? hit.skillId ?? hit.sourceBuffId ?? 'other'}`;
      row = byId.get(id);
      if (!row) {
        row = { id, characterId: owner?.localCharacterId ?? 'unknown', characterName: owner?.characterName ?? '其他来源',
          groupLabel: '派生伤害', orderLabel: `F${hit.frame}`, skillName: hit.displayName || '持续 / 派生伤害',
          skillType: hit.effectiveSkillType ?? 'Dot', damage: 0, expected: 0, nonCrit: 0, share: 0, hits: [] };
        byId.set(id, row); buttons.push(row);
      }
    }
    row.damage += hit.finalDamage;
    row.expected += hit.expectedDamage;
    row.nonCrit += hit.nonCriticalDamage;
  }
  const damageHits = report.hits.filter(hit => isAkeOutgoingDamageHit(report, hit));
  const totalExpected = damageHits.reduce((sum, hit) => sum + hit.expectedDamage, 0);
  buttons.forEach(button => { button.share = totalExpected ? button.expected / totalExpected : 0; });
  return { ...empty, generatedAt: Date.parse(report.generatedAt), totalDamage: damageHits.reduce((sum, hit) => sum + hit.finalDamage, 0),
    totalExpected,
    totalNonCrit: damageHits.reduce((sum, hit) => sum + hit.nonCriticalDamage, 0),
    buttonCount: report.summary.successfulCommands + report.summary.failedCommands, buttons,
    characters: report.characters.map(character => ({ characterId: character.localCharacterId, characterName: character.characterName,
      weaponName: character.loadout.weaponName, weaponPotentialMode: '', level: character.loadout.level,
      skillLevels: [], attributeLines: [], equipmentLines: character.loadout.equipment.map(piece => piece.name), skills: [] })) };
}
