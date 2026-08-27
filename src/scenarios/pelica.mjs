import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBuff, parseSkill, resolveValue } from '../core/ake-parser.mjs';
import { evaluateAttributeComponent } from '../core/attribute.mjs';

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(modulePath), '..', '..');

function projectPath(...parts) {
    const resolved = path.resolve(projectRoot, ...parts);
    const prefix = `${projectRoot}${path.sep}`;
    if (resolved !== projectRoot && !resolved.startsWith(prefix)) {
        throw new Error(`Refusing path outside project: ${resolved}`);
    }
    return resolved;
}

function portablePath(absolutePath) {
    return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

function readJson(...parts) {
    return JSON.parse(fs.readFileSync(projectPath(...parts), 'utf8'));
}

function skillPath(skillId) {
    return projectPath(
        'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
    );
}

function buffPath(buffId) {
    return projectPath(
        'reference', 'public-data', 'akedata', 'Json', 'BuffData', `${buffId}.json`
    );
}

function groupByType(character, type) {
    const group = Object.values(character.skillGroupMap).find(entry => entry.skillGroupType === type);
    if (!group) throw new Error(`Missing skill group type ${type} for ${character.charId}`);
    return group;
}

export function buildPelicaScenarioModel(options = {}) {
    const tickRate = 30;
    const enemyId = options.enemyId ?? 'eny_0007_mimicw';
    const characterTable = readJson(
        'reference', 'public-data', 'akedata', 'TableCfg', 'CharGrowthTable.json'
    );
    const patchTable = readJson(
        'reference', 'public-data', 'akedata', 'TableCfg', 'SkillPatchTable.json'
    );
    const panelSnapshot = readJson(
        'reference', 'public-data', 'calc', 'api', 'character-panel-chr_0004_pelica-level1.json'
    ).data;
    const enemySnapshotFile = `enemy-${enemyId}-level1.json`;
    const enemySnapshot = readJson(
        'reference', 'public-data', 'calc', 'api', enemySnapshotFile
    ).data;
    const enemyAttributeTemplates = readJson(
        'reference', 'public-data', 'akedata', 'TableCfg', 'EnemyAttributeTemplateTable.json'
    );
    const enemyDisplayInfoTable = readJson(
        'reference', 'public-data', 'akedata', 'TableCfg', 'EnemyTemplateDisplayInfoTable.json'
    );
    const metadata = readJson(
        'reference', 'public-data', 'calc', 'api', 'metadata.json'
    ).data;
    const semanticMappings = readJson('spec', 'engine-semantic-mappings.json').mappings;
    const character = characterTable.chr_0004_pelica;
    const normalAttackGroup = groupByType(character, 0);
    const normalAttackIds = normalAttackGroup.skillIdList.slice(0, 4);
    const breakingAttackId = normalAttackGroup.skillIdList.find(skillId =>
        skillId.endsWith('_power_attack'));
    if (!breakingAttackId) throw new Error(`Missing breaking attack for ${character.charId}`);
    const normalSkillId = groupByType(character, 1).skillIdList[0];
    const ultimateSkillId = groupByType(character, 2).skillIdList[0];
    const comboSkillId = groupByType(character, 3).skillIdList[0];
    const initialSkillIds = [
        ...normalAttackIds,
        comboSkillId,
        normalSkillId,
        ultimateSkillId,
        breakingAttackId
    ];
    const skills = new Map();
    const sourcePaths = new Map();
    const pendingSkillIds = [...initialSkillIds];

    while (pendingSkillIds.length > 0) {
        const skillId = pendingSkillIds.shift();
        if (skills.has(skillId)) continue;
        const absolutePath = skillPath(skillId);
        const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        const parsed = parseSkill(raw, patchTable[skillId], { level: 1, tickRate });
        skills.set(skillId, parsed);
        sourcePaths.set(skillId, portablePath(absolutePath));
        for (const launch of parsed.launches) {
            if (launch.childSkillId) pendingSkillIds.push(launch.childSkillId);
        }
    }

    const poiseTemplateMapping = semanticMappings.find(mapping =>
        mapping.actionType === 'EnemyPoiseTemplateRule'
    );
    const poiseBreakMapping = semanticMappings.find(mapping =>
        mapping.actionType === 'PoiseBreakRule'
    );
    const executionMapping = semanticMappings.find(mapping =>
        mapping.actionType === 'ExecutionRule'
    );
    if (!poiseTemplateMapping || !poiseBreakMapping || !executionMapping) {
        throw new Error('Missing explicit poise/execution semantic mappings.');
    }
    const enemyAttributeTemplate = enemyAttributeTemplates[enemyId];
    if (!enemyAttributeTemplate) throw new Error(`Missing AKE enemy template ${enemyId}.`);
    const independentEnemyAttributes = Object.fromEntries(
        (enemyAttributeTemplate.levelIndependentAttributes?.attrs ?? [])
            .map(entry => [Number(entry.attrType), Number(entry.attrValue)])
    );
    const poiseTemplateRule = poiseTemplateMapping.effect;
    const maxPoise = independentEnemyAttributes[poiseTemplateRule.maxPoiseAttributeType];
    const poiseRecTime = independentEnemyAttributes[poiseTemplateRule.recoverySecondsAttributeType];
    const executionDamageScalar = independentEnemyAttributes[
        poiseTemplateRule.executionDamageScalarAttributeType
    ];
    const knotPercentages = enemyAttributeTemplate[poiseTemplateRule.knotPercentagesField] ?? [];
    const knotBuffIds = enemyAttributeTemplate[poiseTemplateRule.knotBuffIdsField] ?? [];
    const executionAtbGain = Number(
        enemyAttributeTemplate[poiseTemplateRule.executionAtbGainField] ?? 0
    );
    const rapidBreakMapping = semanticMappings.find(mapping =>
        mapping.actionType === 'RapidPoiseBreakRule'
        && Number(mapping.selector?.executionDamageScalar) === executionDamageScalar
        && Number(mapping.selector?.breakingAttackedAtbObtain) === executionAtbGain
    );
    const localClockPauseRules = semanticMappings
        .filter(mapping => mapping.actionType === 'LocalClockPauseRule')
        .map(mapping => ({
            id: mapping.id,
            selector: mapping.selector,
            effect: mapping.effect,
            confidence: mapping.confidence,
            evidence: mapping.evidence
        }));

    const buffIds = [...new Set([
        'buff_chr_0004_pelica_combo_skill_tutorial_marker',
        'buff_common_pulse_pulse_conduct_triggered',
        'buff_common_pulse_pulse_conduct_triggered_do',
        'buff_common_pulse_triggered_start',
        'buff_common_pulse_triggered_fx',
        'buff_common_energy_shard_attached_pulse',
        'buff_common_obtain_ultimate_sp',
        'buff_common_damage_immune_ult_skill',
        poiseBreakMapping.effect.breakDamageBuffId,
        poiseBreakMapping.effect.executionGateBuffId,
        rapidBreakMapping?.effect.buffId,
        ...[...skills.values()].flatMap(skill => skill.createBuffs
            .flatMap(action => action.buffs.map(buff => buff.buffId))),
        ...knotBuffIds
    ].filter(Boolean))];
    const buffs = new Map();
    const buffSourcePaths = new Map();
    for (const buffId of buffIds) {
        const absolutePath = buffPath(buffId);
        buffs.set(buffId, parseBuff(JSON.parse(fs.readFileSync(absolutePath, 'utf8')), { tickRate }));
        buffSourcePaths.set(buffId, portablePath(absolutePath));
    }
    const breakDamageBuff = buffs.get(poiseBreakMapping.effect.breakDamageBuffId);
    const breakDamageProcessor = breakDamageBuff?.damageModifiers
        .filter(modifier => modifier.side === 'Defender')
        .flatMap(modifier => modifier.processors)
        .find(processor => processor.zoneName === 'ProdCalcZone');
    if (!breakDamageProcessor) {
        throw new Error('Poise break damage buff has no defender ProdCalcZone processor.');
    }
    const brokenDamageAddition = Number(resolveValue(
        breakDamageProcessor.addition,
        breakDamageBuff.blackboard,
        0
    ));
    const knotDurationTicksByBuffId = Object.fromEntries(knotBuffIds.map(buffId => [
        buffId,
        buffs.get(buffId)?.durationTicks ?? 0
    ]));
    const poiseGuardBuff = rapidBreakMapping
        ? buffs.get(rapidBreakMapping.effect.buffId)
        : null;
    const poiseGuardModifier = poiseGuardBuff?.attributeModifiers.find(modifier =>
        modifier.attributeType === 'PoiseDamageTakenScalar'
        && modifier.formulaItem === 'FinalMultiplier'
    );
    if (rapidBreakMapping && poiseGuardModifier?.param?.blackboardKey !== 'poiseTakenScalar') {
        throw new Error('Rapid poise guard mapping does not match public BuffData.');
    }

    const attackCalculation = evaluateAttributeComponent(panelSnapshot['2']);
    const hpCalculation = evaluateAttributeComponent(enemySnapshot['1']);
    const defenseCalculation = evaluateAttributeComponent(enemySnapshot['3']);
    const pulseResistanceCalculation = evaluateAttributeComponent(enemySnapshot['96']);
    const criticalRateCalculation = evaluateAttributeComponent(panelSnapshot['9']);
    const criticalDamageCalculation = evaluateAttributeComponent(panelSnapshot['10']);
    const spellInflictionBuffs = Object.fromEntries(semanticMappings
        .filter(mapping => mapping.actionType === 'SpellInfliction'
            && mapping.effect?.operation === 'ApplyBuff')
        .map(mapping => [mapping.selector.inflictionType, mapping.effect.buffId]));
    const comboTriggerRules = semanticMappings.filter(mapping =>
        mapping.actionType === 'ComboTriggerRule'
        && mapping.selector?.rootSkillIds?.includes(normalAttackIds[3])
    );
    if (comboTriggerRules.length === 0) {
        throw new Error('Missing explicit Pelica combo-trigger semantic mapping.');
    }
    const atbResourceMapping = semanticMappings.find(mapping =>
        mapping.actionType === 'ResourceRule'
        && mapping.selector?.resourceType === 'Atb'
        && mapping.effect?.operation === 'PassiveRecovery'
    );
    if (!atbResourceMapping) throw new Error('Missing ATB passive-recovery semantic mapping.');
    const resourceActionRules = Object.fromEntries(semanticMappings
        .filter(mapping => mapping.actionType === 'ResourceActionRule')
        .map(mapping => [mapping.selector.actionType, {
            ...mapping.effect,
            evidence: mapping.evidence,
            confidence: mapping.confidence
        }]));
    const skillSettings = {};
    for (const mapping of semanticMappings.filter(mapping =>
        mapping.actionType === 'ReadSkillSettingData'
        && ['ReturnValue', 'ReturnTable'].includes(mapping.effect?.operation)
    )) {
        skillSettings[mapping.selector.lookupKey] ??= {};
        if (mapping.effect.operation === 'ReturnTable') {
            Object.assign(
                skillSettings[mapping.selector.lookupKey],
                mapping.effect.values ?? {}
            );
        } else {
            skillSettings[mapping.selector.lookupKey][
                mapping.selector.column ?? 1
            ] = mapping.effect.value;
        }
    }

    return {
        schemaVersion: 1,
        tickRate,
        calcDataVersion: metadata.version,
        identity: {
            characterId: character.charId,
            englishName: character.engName,
            chineseName: '佩丽卡',
            defaultWeaponId: character.defaultWeaponId,
            chineseNameEvidence: 'reference/third-party/akedatabase/research/endfield-data-mechanics-guide.md'
        },
        roles: {
            normalAttackIds,
            heavyAttackId: normalAttackIds[3],
            breakingAttackId,
            comboSkillId,
            normalSkillId,
            ultimateSkillId
        },
        character: {
            level: 1,
            potential: 0,
            skillLevel: 1,
            weaponId: character.defaultWeaponId,
            weaponLevel: 1,
            attack: attackCalculation.value,
            attackCalculation,
            criticalRate: criticalRateCalculation.value,
            criticalDamageIncrease: criticalDamageCalculation.value,
            poiseDamageOutputScalar: Number(options.poiseDamageOutputScalar ?? 1),
            initialAtb: 300,
            maxAtb: 300,
            initialUltimateSp: 80,
            maxUltimateSp: 80,
            panelSource: 'reference/public-data/calc/api/character-panel-chr_0004_pelica-level1.json'
        },
        enemy: {
            id: enemyId,
            level: 1,
            maxHp: Number(options.enemyMaxHp ?? hpCalculation.value),
            defense: defenseCalculation.value,
            pulseResistance: pulseResistanceCalculation.value,
            damageTakenScalar: 1,
            weaknessDmgScalar: 1,
            shelterDmgScalar: 0,
            maxPoise,
            poiseRecTime,
            poiseDamageTakenScalar: Number(options.poiseDamageTakenScalar ?? 1),
            executionDamageScalar,
            breakingAttackedAtbObtain: executionAtbGain,
            displayType: enemyDisplayInfoTable[enemyId]?.displayType ?? null,
            poiseKnotPctList: knotPercentages,
            poiseKnotBuffList: knotBuffIds,
            source: `reference/public-data/calc/api/${enemySnapshotFile}`,
            poiseSource:
                'reference/public-data/akedata/TableCfg/EnemyAttributeTemplateTable.json'
        },
        commands: (options.commands ?? [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 45, commandType: 'Attack' },
            { frame: 90, commandType: 'ComboSkill' },
            { frame: 120, commandType: 'NormalSkill' }
        ]).map(command => ({ ...command })),
        combatSetting: {
            criticalMode: 'None',
            commandQueueWindowFrames: 30,
            actionIdleExitFightFrames: 120,
            simulatePoise: false,
            ...options.combatSetting
        },
        semanticRules: {
            comboTriggerRules: comboTriggerRules.map(mapping => ({
                id: mapping.id,
                eventType: mapping.eventType,
                selector: mapping.selector,
                effect: mapping.effect,
                confidence: mapping.confidence,
                evidence: mapping.evidence,
                notes: mapping.notes
            })),
            resourceRules: {
                Atb: {
                    passiveRecovery: {
                        ratePerSecond: atbResourceMapping.effect.ratePerSecond,
                        quantization: atbResourceMapping.effect.quantization,
                        firstTickFrame: atbResourceMapping.effect.firstTickFrame,
                        resumeDelayTicksAfterSpend:
                            atbResourceMapping.effect.resumeDelayTicksAfterSpend
                    },
                    evidence: atbResourceMapping.evidence,
                    confidence: atbResourceMapping.confidence
                },
                actions: resourceActionRules
            },
            poiseRules: {
                damageRule: semanticMappings.find(mapping =>
                    mapping.actionType === 'PoiseDamageRule'
                ),
                templateRule: poiseTemplateMapping,
                executionRule: executionMapping,
                breakDamageBuffId: poiseBreakMapping.effect.breakDamageBuffId,
                executionGateBuffId: poiseBreakMapping.effect.executionGateBuffId,
                brokenDamageScale: 1 + brokenDamageAddition,
                recoveryTimingModel: poiseBreakMapping.effect.recoveryTimingModel,
                rapidBreakPolicy: rapidBreakMapping ? {
                    enabled: true,
                    profileId: rapidBreakMapping.id,
                    ...rapidBreakMapping.effect,
                    evidence: rapidBreakMapping.evidence
                } : { enabled: false },
                localClockPauseRules,
                knotDurationTicksByBuffId,
                evidence: poiseBreakMapping.evidence
            },
            spellInflictionBuffs,
            skillSettings,
            skillSettingEvidence: [
                'reference/third-party/akedatabase/research/endfield-data-mechanics-guide.md',
                'fixtures/calc/pelica-heavy-combo-skill.response.json battleEventLog damage operands'
            ]
        },
        sourcePaths: {
            characterTable: 'reference/public-data/akedata/TableCfg/CharGrowthTable.json',
            skillPatchTable: 'reference/public-data/akedata/TableCfg/SkillPatchTable.json',
            enemyAttributeTemplateTable:
                'reference/public-data/akedata/TableCfg/EnemyAttributeTemplateTable.json',
            enemyTemplateDisplayInfoTable:
                'reference/public-data/akedata/TableCfg/EnemyTemplateDisplayInfoTable.json',
            enemySnapshot: `reference/public-data/calc/api/${enemySnapshotFile}`,
            semanticMappings: 'spec/engine-semantic-mappings.json',
            skills: Object.fromEntries(sourcePaths),
            buffs: Object.fromEntries(buffSourcePaths)
        },
        skills,
        buffs
    };
}

export function serializablePelicaModel(model = buildPelicaScenarioModel()) {
    return {
        ...model,
        skills: Object.fromEntries(model.skills),
        buffs: Object.fromEntries(model.buffs)
    };
}
