import assert from 'node:assert/strict';
import { buildAkeReportModel, akeHitCharacterName } from './akeReportModel';
import type { AkeTeamReport } from './akeProvider';

// A DoT can be owned by its enemy carrier, and a skill can hit through an ability entity.
const report = {
  enemyId: 'enemy', tickRate: 30, durationFrames: 300, admissionStatus: 'valid',
  summary: { totalDamage: 60, failedCommands: 0, unsupportedCharacters: 0 },
  characters: [
    { localCharacterId: 'wulfa', akeCharacterId: 'wulfa', memberId: 'wulfa', characterName: '洛茜', status: 'calculated', skippedButtonIds: [] },
    { localCharacterId: 'camille', akeCharacterId: 'camille', memberId: 'camille', characterName: '卡缪', status: 'calculated', skippedButtonIds: [] },
  ],
  hits: [
    { damageAttributeType: 'Hp', targetId: 'enemy', frame: 60, hitIndex: 2, finalDamage: 30, memberId: 'wulfa', ownerId: 'enemy' },
    { damageAttributeType: 'Hp', targetId: 'enemy', frame: 30, hitIndex: 1, finalDamage: 20, memberId: 'camille', ownerId: 'ability-entity' },
    { damageAttributeType: 'Hp', targetId: 'enemy', frame: 30, hitIndex: 0, finalDamage: 10, memberId: 'wulfa', ownerId: 'wulfa' },
  ],
} as unknown as AkeTeamReport;
const all = buildAkeReportModel(report);
assert.deepEqual(all.distribution.map(item => item.damage), [40, 20]);
assert.equal(all.hitDamageDelta, 0);
assert.deepEqual(all.curve, [{ frame: 0, damage: 0 }, { frame: 30, damage: 30 }, { frame: 60, damage: 60 }, { frame: 300, damage: 60 }]);
assert.equal(all.durationSeconds, 10);
const selected = buildAkeReportModel(report, 'wulfa');
assert.equal(selected.total, 40);
assert.equal(selected.hits.length, 2);
assert.equal(akeHitCharacterName(report, report.hits[0]), '洛茜');
assert.equal(all.partial, false);
assert.equal(buildAkeReportModel({ ...report, admissionStatus: 'unverified' }).partial, true);
assert.equal(buildAkeReportModel({ ...report, hits: [] }).total, 0);
console.log('PASS AKE report: DoT/entity ownership, same-frame hit accumulation, filtering and partial-result status');

const withOtherEvents = { ...report, hits: [...report.hits, { ...report.hits[0], finalDamage: 999, targetId: 'wulfa' }, { ...report.hits[0], finalDamage: 200, damageAttributeType: 'Resilience' }] };
assert.equal(buildAkeReportModel(withOtherEvents).total, 60);
assert.deepEqual(buildAkeReportModel(withOtherEvents).distribution.map(row => row.damage), [40, 20]);
