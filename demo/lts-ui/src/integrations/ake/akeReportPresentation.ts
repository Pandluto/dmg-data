import type { Character, SkillType } from '../../types';
import type { TimelineSnapshotPayload } from '../../utils/timelineSnapshotStorage';
import type { MobileDamageReport, MobileDraft, MobileOperatorConfig, MobileTimelineSlot } from '../../mobile/model';
import { MOBILE_EQUIPMENT_SLOT_KEYS } from '../../mobile/model';
import { createDefaultMobileOperatorConfig } from '../../mobile/mobileDraft';
import { normalizeOperatorEquipmentLibrary } from '../../core/services/operatorEquipmentLibrary';
import { compareTimelineChronology } from '../../core/domain/timelineChronology';
import { buildAkeEquipmentLibrary, type AkeCatalog } from './akeCatalogAdapter';
import { buildAkeWorkbenchDamageSnapshot, resolveHitCharacter, isAkeOutgoingDamageHit } from './akeReportModel';
import type { AkeTeamReport } from './akeProvider';

export const AKE_RDPS_UNAVAILABLE = 'RD 归因尚未完成，请等待当前结算或重新计算。';

/** Adapt settled AKE facts to DEF's existing presentation contract. No DEF calculation runs here. */
export function buildAkeReportPresentation(report: AkeTeamReport, payload: TimelineSnapshotPayload, operators: Character[], catalog: AkeCatalog) {
  const weapons = Object.fromEntries(catalog.weapons.map(weapon => [weapon.id, { id: weapon.id, name: weapon.name, imgUrl: weapon.iconUrl }]));
  const equipment = normalizeOperatorEquipmentLibrary(buildAkeEquipmentLibrary(catalog));
  const operatorSnapshots = Object.fromEntries(operators.flatMap(operator => {
    const snapshot = payload.operatorConfigPageCache[operator.id] ?? payload.operatorConfigPageCache[operator.name];
    return snapshot ? [[operator.id, snapshot]] : [];
  }));
  const operatorConfigs: Record<string, MobileOperatorConfig> = Object.fromEntries(operators.map(operator => {
    const defaults = createDefaultMobileOperatorConfig(operator);
    const snapshot = operatorSnapshots[operator.id];
    if (!snapshot) {
      // An untouched config still runs with the API's default weapon. Show
      // that settled loadout without creating or changing the user's draft.
      const settled = report.characters.find(character => character.localCharacterId === operator.id
        || character.akeCharacterId === operator.id)?.loadout;
      return [operator.id, { ...defaults, weapon: { ...defaults.weapon,
        weaponId: settled?.weaponId ?? defaults.weapon.weaponId,
        level: settled?.weaponLevel ?? defaults.weapon.level } }];
    }
    const selections = { ...defaults.equipment };
    for (const slot of MOBILE_EQUIPMENT_SLOT_KEYS) {
      const piece = snapshot.equipment.pieces.find(piece => piece.slotKey === slot);
      if (piece) selections[slot] = { equipmentId: piece.equipmentId,
        effectLevels: Object.fromEntries(piece.effects.map(effect => [effect.effectId, effect.level])) };
    }
    return [operator.id, { ...defaults, level: Number(snapshot.operator.level), potential: snapshot.operator.potential,
      mainStatFlatBonus: snapshot.operator.mainStatFlatBonus, subStatFlatBonus: snapshot.operator.subStatFlatBonus,
      skillLevels: { ...defaults.skillLevels, ...snapshot.operator.skillConfig }, equipment: selections,
      weapon: { weaponId: catalog.weapons.find(weapon => weapon.id === snapshot.weapon.id || weapon.name === snapshot.weapon.name)?.id || snapshot.weapon.id || '',
        level: Number(snapshot.weapon.config.level), potential: snapshot.weapon.config.potential, skillLevels: { ...snapshot.weapon.config.skillLevels } } }];
  }));
  const inputs = payload.timelineData.staffLines.flatMap(line => line.buttons).sort(compareTimelineChronology);
  const inputById = new Map(inputs.map(button => [button.id, button]));
  const commands = new Map(report.timeline.commands.map(command => [command.commandId, command]));
  const slots: MobileTimelineSlot[] = inputs.flatMap(button => {
    const operator = operators.find(operator => operator.id === button.characterId || operator.name === button.characterName);
    if (!operator) return [];
    const skill = operator.sandboxSkills?.find(skill => skill.id === button.runtimeSkillId);
    const command = commands.get(button.id);
    const time = command?.actualFrame;
    const timing = command ? time == null ? '未执行' : `${(time / report.tickRate).toFixed(2)} s${command.delayFrames ? ` · 延后 ${(command.delayFrames / report.tickRate).toFixed(2)} s` : ''}` : '';
    return [{ id: button.id, action: { id: button.id, operatorId: operator.id, skillType: button.skillType as SkillType,
      runtimeSkillId: button.runtimeSkillId || '', skillName: button.skillDisplayName || skill?.displayName || button.skillType,
      skillIconUrl: button.skillIconUrl || skill?.iconUrl, reportTimingLabel: timing,
      buffs: [], buffStackCounts: {}, buffStackCountsByHitKey: {}, globallyDisabledBuffIds: [], disabledBuffIdsByHitKey: {}, disabledHitKeys: [], targetResistance: {} } }];
  });
  const snapshot = buildAkeWorkbenchDamageSnapshot(report);
  snapshot.rdps = report.rdps;
  for (const row of snapshot.buttons) {
    const input = inputById.get(row.id);
    if (input) row.skillName = input.skillDisplayName || operators.find(operator => operator.id === row.characterId)
      ?.sandboxSkills?.find(skill => skill.id === input.runtimeSkillId)?.displayName || input.skillType;
  }
  const byOwner = new Map<string, number>();
  const byFrame = new Map<number, number>();
  const bySkill = new Map<string, { id: string; label: string; expected: number }>();
  const damageHits = report.hits.filter(hit => isAkeOutgoingDamageHit(report, hit));
  for (const hit of damageHits) {
    const ownerId = resolveHitCharacter(report, hit)?.localCharacterId ?? 'unknown';
    byOwner.set(ownerId, (byOwner.get(ownerId) ?? 0) + hit.expectedDamage);
    byFrame.set(hit.frame, (byFrame.get(hit.frame) ?? 0) + hit.expectedDamage);
  }
  for (const row of snapshot.buttons) {
    const key = `${row.characterId}:${row.skillName}`;
    const item = bySkill.get(key) ?? { id: key, label: `${row.characterName} · ${row.skillName}`, expected: 0 };
    item.expected += row.expected; bySkill.set(key, item);
  }
  let cumulative = 0;
  const cumulativeDamage = [{ position: 0, value: 0, label: '0.00 s' }, ...[...byFrame].sort(([a], [b]) => a - b)
    .map(([frame, amount]) => ({ position: frame / report.tickRate, value: cumulative += amount, label: `${(frame / report.tickRate).toFixed(2)} s` }))];
  const duration = Math.max(report.durationFrames / report.tickRate, cumulativeDamage[cumulativeDamage.length - 1].position);
  if (cumulativeDamage[cumulativeDamage.length - 1].position < duration) cumulativeDamage.push({ position: duration, value: cumulative, label: `${duration.toFixed(2)} s` });
  const share = (value: number) => snapshot.totalExpected ? value / snapshot.totalExpected : 0;
  const damageReport: MobileDamageReport = {
    totalExpected: snapshot.totalExpected, totalCrit: damageHits.reduce((sum, hit) => sum + hit.criticalDamage, 0),
    totalNonCrit: snapshot.totalNonCrit, slotCount: inputs.length,
    byOperator: [...byOwner].map(([id, expected]) => ({ id, label: operators.find(operator => operator.id === id)?.name ?? '其他来源', expected, share: share(expected) }))
      .sort((a, b) => b.expected - a.expected),
    bySkill: [...bySkill.values()].filter(row => row.expected > 0).map(row => ({ ...row, share: share(row.expected) }))
      .sort((a, b) => b.expected - a.expected),
    cumulativeDamage, cumulativeAxisLabel: `${duration.toFixed(2)} s · ${damageHits.length} 次伤害命中`,
    rdps: report.rdps, rdpsUnavailableReason: AKE_RDPS_UNAVAILABLE,
  };
  const draft: MobileDraft = { schemaVersion: 1, selectedOperatorIds: operators.map(operator => operator.id), operatorConfigs,
    slots, reportNotes: { ...payload.timelineData.reportNotes }, activePage: 'report', activeOperatorId: operators[0]?.id ?? '', updatedAt: payload.timelineData.updatedAt };
  return { snapshot, report: damageReport, operators, operatorConfigs, operatorSnapshots, weapons, equipment, slots, draft };
}
