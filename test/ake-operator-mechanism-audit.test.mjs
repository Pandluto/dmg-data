import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyAkeMechanismGap } from '../src/core/ake-mechanism-impact.mjs';
import { buildAkeOperatorMechanismAudit } from '../scripts/audit-ake-operator-mechanisms.mjs';

test('AKE mechanism impact classification separates presentation, spatial, and combat gaps', () => {
    assert.deepEqual(
        classifyAkeMechanismGap({
            sourceType: 'AddDynamicCcsAction', code: 'AKE_ACTION_UNSUPPORTED'
        }),
        {
            impact: 'presentation-only',
            priority: 'P3',
            capability: 'presentation',
            rationale: 'The action changes audiovisual or editor presentation, not fixed-dummy combat state.'
        }
    );
    assert.equal(classifyAkeMechanismGap({
        sourceType: 'SelfRotateAction', code: 'AKE_SPATIAL_PROVIDER_REQUIRED'
    }).impact, 'spatial-assumption');
    assert.deepEqual(
        classifyAkeMechanismGap({
            sourceType: 'SetSkillCdAtOnce', code: 'AKE_ACTION_UNSUPPORTED'
        }),
        {
            impact: 'combat-blocking',
            priority: 'P0',
            capability: 'cooldown-window',
            rationale: 'The action changes cooldown or combo-window admission state.'
        }
    );
    assert.equal(classifyAkeMechanismGap({
        sourceType: 'InheritBuffAction', code: 'AKE_ACTION_UNSUPPORTED'
    }).capability, 'status-lifecycle');
    assert.equal(classifyAkeMechanismGap({
        sourceType: 'BlowOffAction', code: 'AKE_SPATIAL_PROVIDER_REQUIRED'
    }).impact, 'combat-partial');
    assert.equal(classifyAkeMechanismGap({
        sourceType: 'ReadSkillSettingData', code: 'AKE_SKILL_SETTING_MISSING'
    }).impact, 'evidence-missing');
});

test('operator audit attaches every combat gap to AKE evidence and avoids operator-specific classifiers', () => {
    const report = buildAkeOperatorMechanismAudit({
        characterIds: ['chr_0028_wulfa', 'chr_0032_lizhiyan']
    });
    assert.equal(report.source.characterCatalogEntries, 32);
    assert.equal(report.auditedCharacterCount, 2);
    const rossi = report.characters.find(character => character.characterId === 'chr_0028_wulfa');
    const arcane = report.characters.find(character => character.characterId === 'chr_0032_lizhiyan');
    assert.ok(rossi.findings.some(finding =>
        finding.sourceType === 'RandomAction'
        && finding.impact === 'evidence-missing'
    ));
    assert.ok(rossi.findings.some(finding =>
        finding.sourceType === 'SetSkillCdAtOnce'
        && finding.capability === 'cooldown-window'
    ));
    assert.equal(rossi.findings.some(finding =>
        finding.sourceType === 'PauseBuffTime'
    ), false, 'implemented generic status time control must leave the unresolved audit');
    assert.ok(arcane.findings.some(finding =>
        ['CastSkill', 'SpawnAbilityEntity'].includes(finding.sourceType)
        && finding.capability === 'child-action'
    ));
    for (const finding of [...rossi.findings, ...arcane.findings]) {
        assert.ok(finding.entityId);
        assert.ok(finding.entityKind === 'SkillData' || finding.entityKind === 'BuffData');
        assert.ok(finding.sourcePath || finding.sourceType === 'MissingDependency');
        assert.ok(finding.jsonPath);
        assert.match(finding.priority, /^P[0-3]$/);
    }
});

test('committed operator mechanism audit covers every concrete catalog character', async () => {
    const report = JSON.parse(await readFile(new URL(
        '../derived/cleanroom/ake-operator-mechanism-audit.json',
        import.meta.url
    ), 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.source.characterCatalogEntries, 32);
    assert.deepEqual(report.source.excludedAbstractCharacters, ['chr_9000_endmin']);
    assert.equal(report.auditedCharacterCount, 31);
    assert.equal(new Set(report.characters.map(character => character.characterId)).size, 31);
    assert.ok(report.summary.byImpact['combat-blocking'] > 0);
    assert.ok(report.summary.byImpact['presentation-only'] > 0);
    const missingDependencies = report.characters.flatMap(character =>
        character.findings.filter(finding => finding.sourceType === 'MissingDependency')
    );
    assert.deepEqual(missingDependencies.map(finding => ({
        characterId: finding.characterId,
        entityId: finding.entityId,
        impact: finding.impact,
        capability: finding.capability
    })), [{
        characterId: 'chr_0030_zhuangfy',
        entityId: 'buff_chr_0030_zhuangfy_have_sword',
        impact: 'combat-blocking',
        capability: 'dependency-closure'
    }], 'missing AKE dependencies must remain explicit combat blockers in the artifact');
});
