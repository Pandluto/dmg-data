import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from './ake-action-compiler.mjs';
import {
    AKE_ATTRIBUTE_NAMES,
    AKE_MODIFIER_ZONES,
    AkeDataRepository,
    akeDerivedAbilityModifiers,
    applyAkeAttributeModifiers,
    buildAkeAttributeComponents,
    evaluateAkeAttributeComponents
} from './ake-data-repository.mjs';
import { AkeLoadoutCompiler } from './ake-loadout-compiler.mjs';

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(modulePath), '..', '..');

const SKILL_GROUP_TYPES = Object.freeze({
    0: 'normalAttack',
    1: 'normalSkill',
    2: 'ultimateSkill',
    3: 'comboSkill'
});

const BUILTIN_DERIVED_BUFF_IDS = new Set([
    'buff_wpn_passive_spirit_01'
]);

const PHYSICAL_STATUS_ACTION_BUFFS = Object.freeze({
    CrushAction: 'buff_physical_try_crushed',
    FractureAction: 'buff_physical_fracture',
    KnockDownAction: 'buff_physical_try_knockdown',
    AirborneAction: 'buff_physical_try_airborne'
});

const COOLDOWN_SKILL_TYPES = Object.freeze({
    normalAttack: 'NormalAttack',
    normalSkill: 'NormalSkill',
    ultimateSkill: 'UltimateSkill',
    comboSkill: 'ComboSkill'
});

const SKILL_SPECIFICATION_TYPES = Object.freeze({
    CharacterNormalAttack: 'NormalAttack',
    CharacterPowerAttack: 'NormalAttack',
    CharacterPlungingAttack: 'NormalAttack',
    CharacterDashAttack: 'NormalAttack',
    CharacterNormalSkill: 'NormalSkill',
    CharacterUltimateSkill: 'UltimateSkill',
    CharacterComboSkill: 'ComboSkill'
});

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function identifier(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        throw new TypeError(`${label} must be a positive integer.`);
    }
    return number;
}

function nonNegativeNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative finite number.`);
    }
    return number;
}

function valueAtLevel(entries, level, levelKey = 'level') {
    if (!Array.isArray(entries)) return null;
    return entries.find(entry => Number(entry?.[levelKey]) === level)
        ?? entries[level - 1]
        ?? null;
}

function collectReferences(root, { buffIds, skillIds }) {
    const seen = new Set();
    const visit = (value, key = '') => {
        if (value === null || value === undefined) return;
        if (typeof value === 'string') {
            if (/buff/i.test(key) && /^(?:buff_|global_buff_)/.test(value)) buffIds.add(value);
            if (/^(?:skillId|childSkillId|projectileSkillId|abilityEntitySkillId|rootSkillId|sourceSkillId|allowedSkillIds?)$/i
                .test(key)
                && /^(?:chr_|enemy_|eny_|skill_)/.test(value)) {
                skillIds.add(value);
            }
            return;
        }
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, key));
            return;
        }
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    };
    visit(root);
}

function compiledProjectileIds(program) {
    return (program.timeline ?? []).flatMap(group => group.metadata ?? [])
        .filter(item => item.type === 'LaunchProjectile' && item.childSkillId)
        .map(item => item.childSkillId);
}

function intrinsicPassiveSkillIds(projectRoot, characterId) {
    const directory = path.join(
        projectRoot,
        'reference', 'public-data', 'akedata', 'Json', 'SkillData'
    );
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile()
            && entry.name.startsWith(`${characterId}_`)
            && entry.name.endsWith('.json'))
        .flatMap(entry => {
            const raw = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
            const hasRuntimeEffect = (raw.buffs ?? []).some(buff => buff?.buffId)
                || (raw.actionGroupData?.passiveEventActions ?? []).length > 0
                || (raw.cardAttributeModifier?.attributeModifiers ?? []).length > 0
                || (raw.toggleBuffs ?? []).length > 0;
            return raw.castType === 'Passive' && hasRuntimeEffect
                ? [raw.skillId]
                : [];
        });
}

function talentAttachmentReferences(table, effectIds) {
    const skills = new Set();
    const buffs = new Set();
    for (const effectId of effectIds) {
        for (const entry of table?.[effectId]?.dataList ?? []) {
            if (entry.attachSkill?.skillId) skills.add(entry.attachSkill.skillId);
            if (entry.attachBuff?.buffId) buffs.add(entry.attachBuff.buffId);
            if (entry.skillBbModifier?.skillId) skills.add(entry.skillBbModifier.skillId);
            if (entry.skillParamModifier?.skillId) skills.add(entry.skillParamModifier.skillId);
        }
    }
    return { skills, buffs };
}

function talentBlackboardForSkill(table, effectIds, skillId, attachedBuffIds = []) {
    const buffIds = new Set(attachedBuffIds);
    const candidates = effectIds.flatMap(effectId => {
        const row = table?.[effectId];
        if (!row) return [];
        return (row?.dataList ?? []).flatMap(entry => {
            const attachment = entry.attachSkill?.skillId === skillId
                ? entry.attachSkill
                : buffIds.has(entry.attachBuff?.buffId)
                    ? entry.attachBuff
                    : null;
            if (!attachment) return [];
            const blackboard = Object.fromEntries((attachment.blackboard ?? []).map(item => [
                item.key,
                item.valueStr !== undefined && item.valueStr !== ''
                    ? item.valueStr
                    : item.value
            ]));
            return Object.keys(blackboard).length > 0 ? [{ effectId, blackboard }] : [];
        });
    });
    candidates.sort((left, right) => {
        const score = candidate => Object.values(candidate.blackboard)
            .reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0);
        return Object.keys(right.blackboard).length - Object.keys(left.blackboard).length
            || score(right) - score(left)
            || left.effectId.localeCompare(right.effectId);
    });
    return clone(candidates[0]?.blackboard ?? {});
}

function characterLoadoutOwnerId(characterId, characterPotentialTable) {
    const match = String(
        characterPotentialTable?.[characterId]?.firstItemId ?? ''
    ).match(/^item_charpotentialup_(chr_[A-Za-z0-9_]+)$/);
    return match?.[1] ?? characterId;
}

function activeTalentEffectIds({
    characterId,
    characterGrowthTable,
    characterPotentialTable,
    rank,
    breakStage
}) {
    const ownerId = characterLoadoutOwnerId(characterId, characterPotentialTable);
    const ownerGrowth = characterGrowthTable?.[ownerId]
        ?? characterGrowthTable?.[characterId]
        ?? {};
    const selected = new Map();
    for (const node of Object.values(ownerGrowth.talentNodeMap ?? {})) {
        const passive = node?.passiveSkillNodeInfo;
        if (!passive?.talentEffectId) continue;
        const level = Number(passive.level);
        const requiredBreakStage = Number(passive.breakStage ?? 0);
        if (!Number.isFinite(level) || level > rank) continue;
        if (Number.isFinite(Number(breakStage)) && requiredBreakStage > Number(breakStage)) {
            continue;
        }
        const index = Number(passive.index);
        const previous = selected.get(index);
        if (!previous
            || level > Number(previous.level)
            || (level === Number(previous.level)
                && requiredBreakStage > Number(previous.breakStage ?? 0))) {
            selected.set(index, passive);
        }
    }
    return [...selected.values()]
        .sort((left, right) => Number(left.index) - Number(right.index))
        .map(node => node.talentEffectId);
}

function availableAttributeTalentNodes(characterGrowth, breakStage) {
    return Object.values(characterGrowth?.talentNodeMap ?? {})
        .filter(node => Number(node?.nodeType) === 3)
        .filter(node => Number(node.attributeNodeInfo?.breakStage ?? 0) <= Number(breakStage))
        .sort((left, right) =>
            Number(left.attributeNodeInfo?.breakStage ?? 0)
                - Number(right.attributeNodeInfo?.breakStage ?? 0)
            || String(left.nodeId).localeCompare(String(right.nodeId))
        );
}

function attributeTalentModifiers(nodes) {
    return nodes.flatMap(node => (
        node.attributeNodeInfo?.attributeModifiers ?? []
    ).map(modifier => {
        const attrType = Number(modifier.attrType);
        const modifierType = Number(modifier.modifierType);
        return {
            attribute: AKE_ATTRIBUTE_NAMES[attrType] ?? `Attr${attrType}`,
            attrType,
            modifierType,
            zone: AKE_MODIFIER_ZONES[modifierType] ?? null,
            value: Number(modifier.attrValue ?? 0),
            source: `AttributeTalent:${node.nodeId}`
        };
    }));
}

function attachedSkillBuffs(raw) {
    return (raw?.buffs ?? []).filter(buff => buff?.buffId).map(buff => ({
        buffId: buff.buffId,
        assignBlackboard: Boolean(buff.assignBlackboard),
        assignments: (buff.assignItems ?? []).map(item => ({
            targetKey: item.targetKey,
            sourceKey: item.inputValueKey ?? item.sourceKey ?? null,
            direct: Boolean(item.useDirectValue ?? item.direct),
            directValue: item.directValue ?? (item.directValueType === 'String'
                ? item.stringValue
                : item.numericValue)
        }))
    }));
}

function roleMap(character) {
    const groups = Object.fromEntries(Object.values(SKILL_GROUP_TYPES).map(name => [name, []]));
    for (const group of Object.values(character.skillGroupMap ?? {})) {
        const name = SKILL_GROUP_TYPES[group.skillGroupType];
        if (name) groups[name].push(...(group.skillIdList ?? []));
    }
    const normalChainIds = groups.normalAttack.filter(skillId => /_attack\d+$/.test(skillId));
    return {
        groups,
        normalAttackIds: normalChainIds,
        heavyAttackId: normalChainIds.at(-1) ?? null,
        breakingAttackId: groups.normalAttack.find(skillId => /_power_attack$/.test(skillId)) ?? null,
        comboSkillId: groups.comboSkill[0] ?? null,
        normalSkillId: groups.normalSkill[0] ?? null,
        ultimateSkillId: groups.ultimateSkill[0] ?? null
    };
}

function skillCooldownDefinitions(characterId, roles, programs) {
    const catalog = new Map();
    for (const [role, skillIds] of Object.entries(roles.groups ?? {})) {
        const skillType = COOLDOWN_SKILL_TYPES[role];
        if (!skillType) continue;
        const groupId = `${characterId}:${skillType}`;
        for (const skillId of skillIds) catalog.set(skillId, { skillType, groupId });
    }
    const ownPrefix = `${characterId}_`;
    return [...programs.entries()]
        .filter(([skillId]) => String(skillId).startsWith(ownPrefix))
        .map(([skillId, program]) => {
            const inferredType = SKILL_SPECIFICATION_TYPES[program.skillSpecification] ?? null;
            const binding = catalog.get(skillId) ?? (inferredType ? {
                skillType: inferredType,
                // Child/alternate SkillData inherits the public command
                // group's cooldown even when it is absent from skillIdList.
                groupId: `${characterId}:${inferredType}`
            } : {
                skillType: null,
                groupId: skillId
            });
            return {
                actorId: characterId,
                skillId,
                skillType: binding.skillType,
                groupId: binding.groupId,
                baseDurationTicks: Number(program.cooldownTicks ?? 0),
                metadata: {
                    skillSpecification: program.skillSpecification ?? null
                }
            };
        });
}

function independentAttributes(enemyTemplate) {
    return Object.fromEntries((enemyTemplate?.levelIndependentAttributes?.attrs ?? [])
        .map(entry => [String(entry.attrType), Number(entry.attrValue)]));
}

function levelAttributes(enemyTemplate, level) {
    const selected = valueAtLevel(enemyTemplate?.levelDependentAttributes, level, 'unusedLevel')
        ?? enemyTemplate?.levelDependentAttributes?.find(entry =>
            entry?.attrs?.some(attr => Number(attr.attrType) === 0
                && Number(attr.attrValue) === level)
        );
    return Object.fromEntries((selected?.attrs ?? [])
        .map(entry => [String(entry.attrType), Number(entry.attrValue)]));
}

function namedAttributes(rawAttributes) {
    const result = {};
    for (const [rawType, value] of Object.entries(rawAttributes ?? {})) {
        const type = Number(rawType);
        result[`Attr${type}`] = Number(value);
        const name = AKE_ATTRIBUTE_NAMES[type];
        if (name) result[name] = Number(value);
    }
    return result;
}

/**
 * Resolve entity-level Blackboard values that are omitted from the exported
 * SkillData but are required by an AKE selector branch.  These are data
 * mappings, not engine branches: a mapping may scope a default to the
 * character and/or to the compiled skills that prove the value is relevant.
 * Explicit caller values win over inferred defaults.
 */
function entityBlackboardDefaults(mappings, programs, characterId, overrides = {}) {
    const defaults = {};
    for (const mapping of mappings ?? []) {
        if (mapping?.actionType !== 'EntityBlackboardDefault') continue;
        const selector = mapping.selector ?? {};
        const characterIds = Array.isArray(selector.characterIds)
            ? selector.characterIds
            : selector.characterId ? [selector.characterId] : [];
        if (characterIds.length > 0 && !characterIds.includes(characterId)) continue;
        const skillIds = Array.isArray(selector.skillIds)
            ? selector.skillIds
            : selector.skillId ? [selector.skillId] : [];
        if (skillIds.length > 0 && !skillIds.some(skillId => programs.has(skillId))) continue;
        const key = selector.blackboardKey ?? mapping.effect?.blackboardKey;
        if (typeof key !== 'string' || key.length === 0) continue;
        const value = mapping.effect?.value ?? mapping.effect?.initialValue;
        if (value === undefined) continue;
        if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
            defaults[key] = clone(value);
        }
    }
    return {
        ...defaults,
        ...(isRecord(overrides) ? clone(overrides) : {})
    };
}

/**
 * Joins version-pinned AKEDatabase tables and exported action JSON into one
 * auditable runtime bundle. Calc snapshots are deliberately not data inputs;
 * they are retained only as independent behavior oracles in comparison tests.
 */
export class AkeScenarioAssembler {
    constructor({ projectRoot = defaultProjectRoot, tickRate = 30, maxDependencies = 4000 } = {}) {
        this.projectRoot = path.resolve(projectRoot);
        this.tickRate = nonNegativeNumber(tickRate, 'tickRate');
        if (this.tickRate === 0) throw new RangeError('tickRate must be positive.');
        this.maxDependencies = positiveInteger(maxDependencies, 'maxDependencies');
        this.data = new AkeDataRepository({ projectRoot: this.projectRoot });
    }

    #resolve(...parts) {
        const target = path.resolve(this.projectRoot, ...parts);
        const prefix = `${this.projectRoot}${path.sep}`;
        if (target !== this.projectRoot && !target.startsWith(prefix)) {
            throw new Error(`Refusing path outside project: ${target}`);
        }
        return target;
    }

    #portable(absolutePath) {
        return path.relative(this.projectRoot, absolutePath).split(path.sep).join('/');
    }

    #read(parts, { optional = false } = {}) {
        const absolutePath = this.#resolve(...parts);
        if (!fs.existsSync(absolutePath)) {
            if (optional) return { value: null, path: this.#portable(absolutePath) };
            throw new Error(`Missing public data file: ${this.#portable(absolutePath)}`);
        }
        return {
            value: JSON.parse(fs.readFileSync(absolutePath, 'utf8')),
            path: this.#portable(absolutePath)
        };
    }

    assemble(options = {}) {
        if (!isRecord(options)) throw new TypeError('assemble options must be an object.');
        const characterId = identifier(options.characterId, 'characterId');
        const enemyId = identifier(options.enemyId, 'enemyId');
        const level = positiveInteger(options.level ?? 1, 'level');
        const enemyLevel = positiveInteger(options.enemyLevel ?? level, 'enemyLevel');
        const skillLevel = positiveInteger(options.skillLevel ?? 1, 'skillLevel');
        const weaponLevel = positiveInteger(options.weaponLevel ?? 1, 'weaponLevel');
        const talentRank = positiveInteger(options.talentRank ?? 2, 'talentRank');
        const diagnostics = [];

        const characterGrowthTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'CharGrowthTable.json'
        ]);
        const characterBaseTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'CharacterTable.json'
        ]);
        const characterPotentialTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'CharacterPotentialTable.json'
        ]);
        const skillPatchTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'SkillPatchTable.json'
        ]);
        const enemyTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'EnemyAttributeTemplateTable.json'
        ]);
        const potentialTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'PotentialTalentEffectTable.json'
        ]);
        const weaponTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'WeaponBasicTable.json'
        ]);
        const weaponUpgradeTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'WeaponUpgradeTemplateTable.json'
        ]);
        const equipmentTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'EquipTable.json'
        ]);
        const equipmentSuitTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'EquipSuitTable.json'
        ]);
        const itemTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'ItemTable.json'
        ]);
        const semanticFile = this.#read(['spec', 'engine-semantic-mappings.json']);
        const characterGrowth = characterGrowthTableFile.value[characterId];
        const character = characterBaseTableFile.value[characterId];
        if (!characterGrowth || !character) {
            throw new Error(`Unknown character in AKEDatabase tables: ${characterId}`);
        }
        const enemyTemplate = enemyTableFile.value[enemyId];
        if (!enemyTemplate) throw new Error(`Unknown enemy in EnemyAttributeTemplateTable: ${enemyId}`);
        const roles = roleMap(characterGrowth);
        const weaponId = identifier(
            options.weaponId ?? characterGrowth.defaultWeaponId,
            'weaponId'
        );
        const weapon = weaponTableFile.value[weaponId];
        if (!weapon) throw new Error(`Unknown weapon in WeaponBasicTable: ${weaponId}`);
        if (Number(weapon.weaponType) !== Number(characterGrowth.weaponType)) {
            throw new Error(
                `Weapon ${weaponId} type ${weapon.weaponType} is incompatible with ${characterId} type ${characterGrowth.weaponType}.`
            );
        }
        const weaponPotential = positiveInteger(options.weaponPotential ?? 1, 'weaponPotential');
        const characterLevel = this.data.characterAttributes(characterId, {
            level,
            ...(options.breakStage === undefined ? {} : { breakStage: options.breakStage })
        });
        const eligibleAttributeTalentNodes = availableAttributeTalentNodes(
            characterGrowth,
            characterLevel.breakStage
        );
        const attributeTalentLevel = Number(
            options.attributeTalentLevel ?? eligibleAttributeTalentNodes.length
        );
        if (!Number.isInteger(attributeTalentLevel)
            || attributeTalentLevel < 0
            || attributeTalentLevel > eligibleAttributeTalentNodes.length) {
            throw new TypeError(
                `attributeTalentLevel must be an integer from 0 to ${eligibleAttributeTalentNodes.length}.`
            );
        }
        const selectedAttributeTalentNodes = eligibleAttributeTalentNodes.slice(
            0,
            attributeTalentLevel
        );
        const selectedAttributeTalentModifiers = attributeTalentModifiers(
            selectedAttributeTalentNodes
        );
        const automaticTalentIds = options.includeTalents === false
            ? []
            : activeTalentEffectIds({
                characterId,
                characterGrowthTable: characterGrowthTableFile.value,
                characterPotentialTable: characterPotentialTableFile.value,
                rank: talentRank,
                breakStage: characterLevel.breakStage
            });
        const selectedTalentEffectIds = [...new Set([
            ...automaticTalentIds,
            ...(options.talentEffectIds ?? [])
        ])];
        const weaponBuild = this.data.weaponAttributes(weaponId, {
            level: weaponLevel,
            potential: weaponPotential,
            skillLevels: options.weaponSkillLevels ?? {},
            mainAttrType: character.mainAttrType
        });
        const equipmentSelections = options.equipment ?? options.equipmentIds ?? [];
        const equipmentModifiers = this.data.equipmentModifiers(equipmentSelections);

        const compiler = new AkeActionCompiler({
            tickRate: this.tickRate,
            semanticMappings: semanticFile.value,
            // This assembler always constructs a single explicit combat
            // target.  AKE's Context/smart_target selector therefore has an
            // exact local binding instead of needing a spatial provider.
            targetMappings: {
                Context: 'Target',
                ...(options.targetMappings ?? {})
            },
            capabilities: {
                damageResolver: true,
                skillProgramResolver: true,
                timeDilationResolver: true,
                dynamicBuffIdResolver: true,
                // The assembled scenario contains one explicit hostile target.
                // Ranged AuraAction membership can therefore bind to the live
                // event target without inventing an AoE radius or fan-out.
                singleTargetSpatialBinding: true,
                ...(options.compilerCapabilities ?? {})
            }
        });
        const programs = new Map();
        const rawSkills = new Map();
        const sourcePaths = { skills: {}, buffs: {}, tables: {} };
        const referencedBuffIds = new Set(options.buffIds ?? []);
        const discoveredSkillIds = new Set();
        const allTalentEffectIds = Object.keys(potentialTableFile.value)
            .filter(effectId => /_talent_/i.test(effectId));
        const allTalentReferences = talentAttachmentReferences(
            potentialTableFile.value,
            allTalentEffectIds
        );
        const activeTalentReferences = talentAttachmentReferences(
            potentialTableFile.value,
            selectedTalentEffectIds
        );
        const intrinsicPassiveIds = options.includeIntrinsicPassives === false
            ? []
            : intrinsicPassiveSkillIds(this.projectRoot, characterId).filter(skillId => {
                const raw = this.#read([
                    'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
                ], { optional: true }).value;
                const attachedBuffIds = (raw?.buffs ?? [])
                    .map(buff => buff?.buffId)
                    .filter(Boolean);
                const isTalentPassive = /_talent_/i.test(skillId)
                    || allTalentReferences.skills.has(skillId)
                    || attachedBuffIds.some(buffId => allTalentReferences.buffs.has(buffId));
                if (!isTalentPassive) return true;
                return activeTalentReferences.skills.has(skillId)
                    || attachedBuffIds.some(buffId => activeTalentReferences.buffs.has(buffId));
            });
        const intrinsicPassiveBlackboards = new Map(intrinsicPassiveIds.map(skillId => {
            const raw = this.#read([
                'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
            ], { optional: true }).value;
            return [
                skillId,
                talentBlackboardForSkill(
                    potentialTableFile.value,
                    selectedTalentEffectIds,
                    skillId,
                    (raw?.buffs ?? []).map(buff => buff?.buffId).filter(Boolean)
                )
            ];
        }));
        const initialSkillIds = [
            ...(options.skillIds ?? Object.values(roles.groups).flat()),
            ...intrinsicPassiveIds
        ];
        const pendingSkillIds = [...new Set(initialSkillIds)];
        const attemptedSkillIds = new Set();
        const drainSkills = () => {
            while (pendingSkillIds.length > 0) {
                if (programs.size >= this.maxDependencies) {
                    throw new Error(`Skill dependency limit ${this.maxDependencies} exceeded.`);
                }
                const skillId = pendingSkillIds.shift();
                if (programs.has(skillId) || attemptedSkillIds.has(skillId)) continue;
                attemptedSkillIds.add(skillId);
                const skillFile = this.#read([
                    'reference', 'public-data', 'akedata', 'Json', 'SkillData', `${skillId}.json`
                ], { optional: true });
                if (!skillFile.value) {
                    diagnostics.push({
                        code: 'AKE_SKILL_DATA_MISSING',
                        skillId,
                        path: skillFile.path
                    });
                    continue;
                }
                const program = compiler.compileSkill(
                    skillFile.value,
                    skillPatchTableFile.value[skillId],
                    { level: skillLevel, tickRate: this.tickRate }
                );
                programs.set(skillId, program);
                rawSkills.set(skillId, skillFile.value);
                sourcePaths.skills[skillId] = skillFile.path;
                const serializedSkill = JSON.stringify(skillFile.value);
                for (const [actionType, buffId] of Object.entries(
                    PHYSICAL_STATUS_ACTION_BUFFS
                )) {
                    if (serializedSkill.includes(`${actionType}+`)) {
                        referencedBuffIds.add(buffId);
                    }
                }
                const localBuffIds = new Set();
                const localSkillIds = new Set();
                collectReferences(skillFile.value, {
                    buffIds: localBuffIds,
                    skillIds: localSkillIds
                });
                collectReferences(program, {
                    buffIds: localBuffIds,
                    skillIds: localSkillIds
                });
                localBuffIds.forEach(id => referencedBuffIds.add(id));
                compiledProjectileIds(program).forEach(id => localSkillIds.add(id));
                for (const childSkillId of localSkillIds) {
                    if (childSkillId !== skillId && !programs.has(childSkillId)) {
                        pendingSkillIds.push(childSkillId);
                        discoveredSkillIds.add(childSkillId);
                    }
                }
            }
        };
        drainSkills();

        for (const mapping of semanticFile.value.mappings ?? []) {
            if (mapping.effect?.operation === 'ApplyBuff' && mapping.effect.buffId) {
                referencedBuffIds.add(mapping.effect.buffId);
            }
            for (const field of ['breakDamageBuffId', 'executionGateBuffId', 'buffId']) {
                if (/^(?:buff_|global_buff_)/.test(mapping.effect?.[field] ?? '')) {
                    referencedBuffIds.add(mapping.effect[field]);
                }
            }
        }
        for (const buffId of enemyTemplate.poiseKnotBuffList ?? []) {
            if (/^(?:buff_|global_buff_)/.test(buffId ?? '')) referencedBuffIds.add(buffId);
        }

        const loadoutCompiler = new AkeLoadoutCompiler({
            attributeTypeMappings: Object.fromEntries(
                AKE_ATTRIBUTE_NAMES.map((name, attrType) => [attrType, name])
            ),
            modifierZoneMappings: AKE_MODIFIER_ZONES
        });
        const loadoutEffects = [];
        const potentialLevel = Number(options.potentialLevel ?? 0);
        if (!Number.isInteger(potentialLevel) || potentialLevel < 0 || potentialLevel > 5) {
            throw new TypeError('potentialLevel must be an integer from 0 to 5.');
        }
        const automaticPotentialIds = (characterPotentialTableFile.value[characterId]
            ?.potentialUnlockBundle ?? [])
            .filter(entry => Number(entry.level) <= potentialLevel)
            .map(entry => entry.potentialEffectId);
        const requestedEffectIds = [...new Set([
            ...automaticTalentIds,
            ...automaticPotentialIds,
            ...(options.talentEffectIds ?? []),
            ...(options.loadoutEffectIds ?? [])
        ])];
        for (const effectId of requestedEffectIds) {
            const rawEffect = potentialTableFile.value[effectId];
            if (!rawEffect) {
                diagnostics.push({ code: 'AKE_LOADOUT_EFFECT_MISSING', effectId });
                continue;
            }
            const effect = loadoutCompiler.compile(effectId, rawEffect);
            loadoutEffects.push(effect);
            collectReferences(effect, {
                buffIds: referencedBuffIds,
                skillIds: discoveredSkillIds
            });
        }

        const modifiersByEquipment = new Map();
        for (const modifier of equipmentModifiers) {
            if (!modifier.zone) {
                diagnostics.push({
                    code: 'AKE_EQUIPMENT_MODIFIER_ENUM_UNMAPPED',
                    equipmentId: modifier.source,
                    attrType: modifier.attrType,
                    modifierType: modifier.modifierType
                });
                continue;
            }
            if (!modifiersByEquipment.has(modifier.source)) {
                modifiersByEquipment.set(modifier.source, []);
            }
            modifiersByEquipment.get(modifier.source).push({
                attribute: modifier.attribute,
                zone: modifier.zone,
                value: modifier.value,
                metadata: {
                    rawAttrType: modifier.attrType,
                    rawModifierType: modifier.modifierType,
                    partType: modifier.partType,
                    enhance: modifier.enhance
                }
            });
        }
        for (const [equipmentId, attributeModifiers] of modifiersByEquipment) {
            loadoutEffects.push({
                effectId: equipmentId,
                sourceType: 'Equipment',
                buffs: [],
                skills: [],
                attributeModifiers,
                skillBlackboardPatches: [],
                skillParameterPatches: [],
                activeConditions: [],
                toggleEffects: [],
                unresolved: [],
                status: 'executable'
            });
        }

        const selectedEquipmentIds = equipmentSelections.map(selection =>
            typeof selection === 'string' ? selection : selection.equipmentId ?? selection.id
        );
        const automaticPassives = [];
        const passiveListenerDefinitions = new Map();
        if (weaponBuild.passiveSkillId) {
            automaticPassives.push({
                skillId: weaponBuild.passiveSkillId,
                blackboard: weaponBuild.passiveBlackboard,
                sourceType: 'WeaponPassive'
            });
        }
        const suitCounts = new Map();
        for (const equipmentId of selectedEquipmentIds) {
            const suitId = equipmentTableFile.value[equipmentId]?.suitID;
            if (suitId) suitCounts.set(suitId, (suitCounts.get(suitId) ?? 0) + 1);
        }
        for (const [suitId, count] of suitCounts) {
            for (const bonus of equipmentSuitTableFile.value[suitId]?.list ?? []) {
                if (count < Number(bonus.equipCnt ?? 0) || !bonus.skillID) continue;
                automaticPassives.push({
                    skillId: bonus.skillID,
                    blackboard: this.data.skillBlackboard(bonus.skillID, bonus.skillLv ?? 1),
                    sourceType: 'EquipmentSet'
                });
            }
        }
        const passiveInputs = [
            ...automaticPassives,
            ...(options.equipmentPassives ?? [])
        ];
        for (const passive of passiveInputs) {
            const passiveInput = typeof passive === 'string' ? { skillId: passive } : passive;
            const passiveFile = this.#read([
                'reference', 'public-data', 'akedata', 'Json', 'SkillData',
                `${passiveInput.skillId}.json`
            ], { optional: true });
            if (!passiveFile.value) {
                diagnostics.push({
                    code: 'AKE_EQUIPMENT_PASSIVE_MISSING',
                    skillId: passiveInput.skillId,
                    path: passiveFile.path
                });
                continue;
            }
            sourcePaths.skills[passiveInput.skillId] = passiveFile.path;
            const effect = loadoutCompiler.compilePassiveSkill(passiveFile.value, {
                blackboard: passiveInput.blackboard ?? {},
                sourceType: passiveInput.sourceType ?? 'EquipmentPassive'
            });
            const passiveEvents = compiler.compilePassiveEventActions(passiveFile.value, {
                blackboard: effect.blackboard
            });
            if (passiveEvents.groups.some(group => group.actions.length > 0)) {
                const blackboardToken = encodeURIComponent(JSON.stringify(
                    Object.entries(passiveEvents.blackboard).sort(([left], [right]) =>
                        left.localeCompare(right)
                    )
                ));
                const listenerId = `ake-passive-listener:${passiveInput.skillId}:${blackboardToken}`;
                passiveListenerDefinitions.set(listenerId, {
                    buffId: listenerId,
                    blackboard: clone(passiveEvents.blackboard),
                    lifeType: 'Infinity',
                    stacking: {
                        identifierType: 'Id',
                        stackingType: 'Unique',
                        stackingKey: listenerId,
                        maxStackCount: 1
                    },
                    abilityEventActions: clone(passiveEvents.groups),
                    compiler: clone(passiveEvents.compiler)
                });
                effect.buffs.push({
                    buffId: listenerId,
                    blackboard: clone(passiveEvents.blackboard),
                    sourcePath: 'actionGroupData.passiveEventActions'
                });
                collectReferences(passiveEvents.groups, {
                    buffIds: referencedBuffIds,
                    skillIds: discoveredSkillIds
                });
            }
            loadoutEffects.push(effect);
            collectReferences(effect, {
                buffIds: referencedBuffIds,
                skillIds: discoveredSkillIds
            });
        }

        const buffs = new Map(passiveListenerDefinitions);
        const rawBuffs = new Map();
        const pendingBuffIds = [];
        const attemptedBuffIds = new Set();
        const drainBuffs = () => {
            while (pendingBuffIds.length > 0) {
                if (programs.size + buffs.size >= this.maxDependencies) {
                    throw new Error(`Runtime dependency limit ${this.maxDependencies} exceeded.`);
                }
                const buffId = pendingBuffIds.shift();
                if (buffs.has(buffId) || attemptedBuffIds.has(buffId)) continue;
                attemptedBuffIds.add(buffId);
                const buffFile = this.#read([
                    'reference', 'public-data', 'akedata', 'Json', 'BuffData', `${buffId}.json`
                ], { optional: true });
                if (!buffFile.value) {
                    if (!BUILTIN_DERIVED_BUFF_IDS.has(buffId)) {
                        diagnostics.push({
                            code: 'AKE_BUFF_DATA_MISSING',
                            buffId,
                            path: buffFile.path
                        });
                    }
                    continue;
                }
                const definition = compiler.compileBuff(buffFile.value);
                buffs.set(buffId, definition);
                rawBuffs.set(buffId, buffFile.value);
                sourcePaths.buffs[buffId] = buffFile.path;
                const childBuffIds = new Set();
                collectReferences(buffFile.value, {
                    buffIds: childBuffIds,
                    skillIds: discoveredSkillIds
                });
                collectReferences(definition, {
                    buffIds: childBuffIds,
                    skillIds: discoveredSkillIds
                });
                for (const childBuffId of childBuffIds) {
                    if (childBuffId !== buffId && !buffs.has(childBuffId)) {
                        pendingBuffIds.push(childBuffId);
                    }
                }
            }
        };
        // Skills, Buffs, potentials and equipment passives can reference one
        // another. Alternate both queues until the public-file dependency
        // graph reaches a fixed point instead of stopping after one direction.
        while (true) {
            for (const skillId of discoveredSkillIds) {
                if (!programs.has(skillId) && !attemptedSkillIds.has(skillId)
                    && !pendingSkillIds.includes(skillId)) {
                    pendingSkillIds.push(skillId);
                }
            }
            for (const buffId of referencedBuffIds) {
                if (!buffs.has(buffId) && !attemptedBuffIds.has(buffId)
                    && !pendingBuffIds.includes(buffId)) {
                    pendingBuffIds.push(buffId);
                }
            }
            if (pendingSkillIds.length === 0 && pendingBuffIds.length === 0) break;
            drainSkills();
            for (const buffId of referencedBuffIds) {
                if (!buffs.has(buffId) && !attemptedBuffIds.has(buffId)
                    && !pendingBuffIds.includes(buffId)) {
                    pendingBuffIds.push(buffId);
                }
            }
            drainBuffs();
        }

        const runtimeEntityBlackboard = entityBlackboardDefaults(
            semanticFile.value.mappings ?? [],
            programs,
            characterId,
            options.entityBlackboard ?? options.entityBlackboardDefaults ?? {}
        );

        // Some built-in engine Buffs are referenced by exported weapon skills
        // but are absent from AKEDatabase's BuffData corpus. Keep the direct
        // exported attribute modifiers executable and remove only unavailable
        // attachments so runtime setup cannot silently bind a nonexistent id.
        for (const effect of loadoutEffects) {
            effect.buffs = (effect.buffs ?? []).filter(buff => {
                if (buffs.has(buff.buffId)) return true;
                if (!BUILTIN_DERIVED_BUFF_IDS.has(buff.buffId)) {
                    diagnostics.push({
                        code: 'AKE_LOADOUT_BUFF_UNAVAILABLE',
                        effectId: effect.effectId,
                        buffId: buff.buffId
                    });
                }
                return false;
            });
            effect.toggleEffects = (effect.toggleEffects ?? []).map(toggle => ({
                ...toggle,
                buffs: (toggle.buffs ?? []).filter(buff => {
                    if (buffs.has(buff.buffId)) return true;
                    if (!BUILTIN_DERIVED_BUFF_IDS.has(buff.buffId)) {
                        diagnostics.push({
                            code: 'AKE_LOADOUT_BUFF_UNAVAILABLE',
                            effectId: effect.effectId,
                            toggleId: toggle.id,
                            buffId: buff.buffId
                        });
                    }
                    return false;
                })
            }));
        }

        const modifierTypeByZone = Object.fromEntries(
            Object.entries(AKE_MODIFIER_ZONES).map(([type, zone]) => [zone, Number(type)])
        );
        const preAppliedLoadoutModifiers = [];
        for (const effect of loadoutEffects) {
            const direct = (effect.attributeModifiers ?? []).map(modifier => ({
                ...clone(modifier),
                attrType: AKE_ATTRIBUTE_NAMES.indexOf(modifier.attribute),
                modifierType: modifierTypeByZone[modifier.zone],
                source: `${effect.sourceType}:${effect.effectId}`
            }));
            preAppliedLoadoutModifiers.push(...direct);
            effect.preAppliedAttributeModifiers = clone(effect.attributeModifiers ?? []);
            // Loadout is installed at frame zero and never removed in a
            // scenario. Pre-applying its direct attribute layer lets the
            // dependent four-ability projection use the correct values once,
            // while dynamic Buff attachments stay in the runtime.
            effect.attributeModifiers = [];
        }
        const preDerivedAttributeModifiers = [
            ...weaponBuild.modifiers,
            ...selectedAttributeTalentModifiers,
            ...preAppliedLoadoutModifiers
        ];
        const abilityInputAttributes = applyAkeAttributeModifiers(
            characterLevel.attributes,
            preDerivedAttributeModifiers
        );
        const derivedAbilityModifiers = akeDerivedAbilityModifiers(
            abilityInputAttributes,
            character
        );
        const characterAttributeComponents = buildAkeAttributeComponents(
            characterLevel.attributes,
            [...preDerivedAttributeModifiers, ...derivedAbilityModifiers]
        );
        const resolvedCharacterAttributes = evaluateAkeAttributeComponents(
            characterAttributeComponents
        );

        const independent = independentAttributes(enemyTemplate);
        const dependent = levelAttributes(enemyTemplate, enemyLevel);
        const poiseMapping = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'EnemyPoiseTemplateRule'
        );
        const poiseBreakMapping = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'PoiseBreakRule'
        );
        const maxPoiseType = String(poiseMapping?.effect?.maxPoiseAttributeType ?? 20);
        const recoveryType = String(poiseMapping?.effect?.recoverySecondsAttributeType ?? 21);
        const executionType = String(
            poiseMapping?.effect?.executionDamageScalarAttributeType ?? 22
        );
        const ultimatePatch = valueAtLevel(
            skillPatchTableFile.value[roles.ultimateSkillId]?.SkillPatchDataBundle,
            skillLevel
        );
        const maxUltimateSp = nonNegativeNumber(
            options.maxUltimateSp ?? ultimatePatch?.costValue ?? 0,
            'maxUltimateSp'
        );
        const characterAttributes = {
            ...resolvedCharacterAttributes,
            Level: level,
            Attr22: maxUltimateSp,
            MaxUltimateSp: maxUltimateSp,
            PoiseDamageOutputScalar: 1,
            PulseAbnormalDamageIncrease: 0,
            ...(options.characterAttributes ?? {})
        };
        const runtimeCharacterAttributeComponents = clone(characterAttributeComponents);
        const componentOverrides = {
            Level: level,
            Attr22: maxUltimateSp,
            MaxUltimateSp: maxUltimateSp,
            PoiseDamageOutputScalar: 1,
            PulseAbnormalDamageIncrease: 0,
            ...(options.characterAttributes ?? {})
        };
        for (const [attribute, value] of Object.entries(componentOverrides)) {
            runtimeCharacterAttributeComponents[attribute] =
                buildAkeAttributeComponents({ [attribute]: value })[attribute];
        }
        const maxHp = nonNegativeNumber(
            options.enemyMaxHp ?? dependent['1'],
            'enemy max HP'
        );
        const maxResilience = nonNegativeNumber(
            options.enemyMaxResilience
                ?? independent[maxPoiseType]
                ?? 0,
            'enemy max resilience'
        );
        const poiseRecoverySeconds = nonNegativeNumber(
            options.enemyPoiseRecoverySeconds
                ?? independent[recoveryType]
                ?? 0,
            'enemy poise recovery seconds'
        );
        const executionDamageScalar = Number(independent[executionType] ?? 1);
        const executionAtbGain = Number(enemyTemplate.breakingAttackedAtbObtain ?? 0);
        const rapidBreakMapping = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'RapidPoiseBreakRule'
            && Number(mapping.selector?.executionDamageScalar) === executionDamageScalar
            && Number(mapping.selector?.breakingAttackedAtbObtain) === executionAtbGain
        );
        const breakDamageBuffId = poiseBreakMapping?.effect?.breakDamageBuffId ?? null;
        const breakDamageBuff = breakDamageBuffId === null
            ? null
            : buffs.get(breakDamageBuffId);
        const breakDamageProcessor = breakDamageBuff?.damageModifiers
            ?.filter(modifier => modifier.side === 'Defender')
            .flatMap(modifier => modifier.processors ?? [])
            .find(processor => processor.zoneName === 'ProdCalcZone');
        const breakAdditionDescriptor = breakDamageProcessor?.addition;
        const brokenDamageAddition = breakAdditionDescriptor?.useBlackboardKey
            ? Number(breakDamageBuff?.blackboard?.[breakAdditionDescriptor.blackboardKey] ?? 0)
            : Number(breakAdditionDescriptor?.value ?? 0);
        const knotBuffIds = clone(enemyTemplate.poiseKnotBuffList ?? []);
        const knotDurationTicksByBuffId = Object.fromEntries(knotBuffIds.map(buffId => [
            buffId,
            Number(buffs.get(buffId)?.durationTicks ?? 0)
        ]));
        const enemyAttributes = {
            ...namedAttributes(independent),
            ...namedAttributes(dependent),
            Level: enemyLevel,
            Def: options.enemyDefense ?? dependent['3'] ?? 0,
            PulseResistance: options.pulseResistance
                ?? enemyTemplate.pulseResistance
                ?? 0,
            FireResistance: enemyTemplate.fireResistance ?? 0,
            CrystResistance: enemyTemplate.crystResistance ?? 0,
            DamageTakenScalar: 1,
            WeaknessDmgScalar: 1,
            ShelterDmgScalar: 0,
            PoiseDamageTakenScalar: 1,
            ExecutionDamageScalar: executionDamageScalar,
            BreakingAttackedAtbObtain: executionAtbGain,
            ...(options.enemyAttributes ?? {})
        };
        const enemyAttributeComponents = buildAkeAttributeComponents(enemyAttributes);
        const atbRule = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'ResourceRule'
            && mapping.selector?.resourceType === 'Atb'
        );
        const initialAtb = nonNegativeNumber(options.initialAtb ?? 300, 'initialAtb');
        const maxAtb = nonNegativeNumber(options.maxAtb ?? 300, 'maxAtb');
        const initialUltimateSp = nonNegativeNumber(
            options.initialUltimateSp ?? maxUltimateSp,
            'initialUltimateSp'
        );
        const definitions = {
            entities: [
                {
                    id: characterId,
                    kind: 'Character',
                    team: 'ally',
                    clockDomainId: `${characterId}:clock`,
                    metadata: { isMainCharacter: true },
                    ...(Object.keys(runtimeEntityBlackboard).length > 0
                        ? { blackboard: clone(runtimeEntityBlackboard) }
                        : {}),
                    attributes: characterAttributes,
                    attributeComponents: runtimeCharacterAttributeComponents,
                    vital: characterAttributes.MaxHp
                        ? {
                            maxHp: characterAttributes.MaxHp,
                            currentHp: characterAttributes.MaxHp
                        }
                        : undefined,
                    resilience: {
                        maxResilience: 100,
                        currentResilience: 100,
                        superArmorLevel: 0
                    }
                },
                {
                    id: enemyId,
                    kind: 'Enemy',
                    team: 'enemy',
                    clockDomainId: `${enemyId}:clock`,
                    attributes: enemyAttributes,
                    attributeComponents: enemyAttributeComponents,
                    vital: { maxHp, currentHp: maxHp },
                    resilience: {
                        maxResilience,
                        currentResilience: maxResilience,
                        recoveryPerTick: 0,
                        superArmorLevel: Number(enemyTemplate.initialSuperArmor ?? 0)
                    },
                    poise: {
                        enabled: maxResilience > 0,
                        maxPoise: maxResilience,
                        recoverySeconds: poiseRecoverySeconds,
                        executionDamageScalar,
                        executionAtbGain,
                        knotPercentages: clone(enemyTemplate.poiseKnotPctList ?? []),
                        knotBuffIds,
                        knotDurationTicksByBuffId,
                        brokenDamageScale: 1 + brokenDamageAddition,
                        breakDamageBuffId,
                        executionGateBuffId:
                            poiseBreakMapping?.effect?.executionGateBuffId ?? null,
                        recoveryTimingModel:
                            poiseBreakMapping?.effect?.recoveryTimingModel,
                        rapidBreakPolicy: rapidBreakMapping
                            ? {
                                enabled: true,
                                profileId: rapidBreakMapping.id,
                                ...clone(rapidBreakMapping.effect)
                            }
                            : { enabled: false }
                    }
                }
            ],
            skillCooldowns: skillCooldownDefinitions(characterId, roles, programs),
            resources: [
                {
                    id: 'squad:Atb',
                    resourceType: 'Atb',
                    scope: 'Shared',
                    ownerId: null,
                    initial: initialAtb,
                    max: maxAtb,
                    passiveRecovery: atbRule?.effect ?? null,
                    clockDomainId: 'global'
                },
                {
                    id: `${characterId}:UltimateSp`,
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    ownerId: characterId,
                    initial: initialUltimateSp,
                    max: maxUltimateSp,
                    clockDomainId: `${characterId}:clock`
                }
            ],
            buffs: Object.fromEntries(buffs)
        };

        sourcePaths.tables = {
            character: characterBaseTableFile.path,
            characterGrowth: characterGrowthTableFile.path,
            characterPotential: characterPotentialTableFile.path,
            skillPatch: skillPatchTableFile.path,
            enemy: enemyTableFile.path,
            potentialTalent: potentialTableFile.path,
            weapon: weaponTableFile.path,
            weaponUpgrade: weaponUpgradeTableFile.path,
            equipment: equipmentTableFile.path,
            equipmentSuit: equipmentSuitTableFile.path,
            item: itemTableFile.path,
            semanticMappings: semanticFile.path,
            tableCorpusManifest: 'reference/public-data/akedata/table-corpus.manifest.json'
        };
        const compilerUnresolved = [
            ...[...programs.values()].flatMap(program => program.compiler?.unresolved ?? []),
            ...[...buffs.values()].flatMap(buff => buff.compiler?.unresolved ?? [])
        ];
        const intrinsicPassives = intrinsicPassiveIds.flatMap(skillId => {
            const raw = rawSkills.get(skillId);
            const program = programs.get(skillId);
            const attachedBuffs = attachedSkillBuffs(raw);
            return program && attachedBuffs.length > 0 ? [{
                skillId,
                castType: raw.castType,
                blackboard: {
                    ...clone(program.blackboard ?? {}),
                    ...clone(intrinsicPassiveBlackboards.get(skillId) ?? {})
                },
                buffs: attachedBuffs
            }] : [];
        });
        return {
            schemaVersion: 1,
            tickRate: this.tickRate,
            identity: {
                characterId,
                name: this.data.text(character.name, characterId),
                englishName: this.data.text(character.engName),
                weaponId,
                weaponLevel,
                weaponPotential,
                weaponSkillLevels: clone(weaponBuild.skillLevels),
                enemyId,
                enemyLevel,
                level,
                breakStage: characterLevel.breakStage,
                skillLevel,
                talentRank,
                attributeTalentLevel
            },
            roles,
            programs,
            rawSkills,
            buffs,
            rawBuffs,
            loadoutEffects,
            intrinsicPassives,
            definitions,
            parameters: {
                characterAttributes: clone(characterAttributes),
                characterAttributeCalculations: {
                    source: 'AKEDatabase.CharacterTable',
                    level,
                    breakStage: characterLevel.breakStage,
                    weaponModifiers: clone(weaponBuild.modifiers),
                    attributeTalentLevel,
                    attributeTalentNodes: clone(selectedAttributeTalentNodes.map(node => ({
                        nodeId: node.nodeId,
                        breakStage: node.attributeNodeInfo?.breakStage ?? 0
                    }))),
                    attributeTalentModifiers: clone(selectedAttributeTalentModifiers),
                    equipmentModifiers: clone(equipmentModifiers),
                    preAppliedLoadoutModifiers: clone(preAppliedLoadoutModifiers),
                    derivedAbilityModifiers: clone(derivedAbilityModifiers),
                    components: clone(runtimeCharacterAttributeComponents),
                    mechanicsReference:
                        'reference/third-party/akedatabase/research/endfield-data-mechanics-guide.md'
                },
                entityBlackboardDefaults: clone(runtimeEntityBlackboard),
                enemyAttributes: clone(enemyAttributes),
                enemyAttributeCalculations: {
                    source: 'AKEDatabase.EnemyAttributeTemplateTable',
                    level: enemyLevel,
                    independent: clone(independent),
                    dependent: clone(dependent)
                },
                enemyMaxHp: maxHp,
                enemyMaxResilience: maxResilience,
                enemyResilienceRecoverySeconds: poiseRecoverySeconds,
                enemyMaxPoise: maxResilience,
                enemyPoiseRecoverySeconds: poiseRecoverySeconds,
                weapon: {
                    ...clone(weapon),
                    build: clone(weaponBuild)
                },
                equipment: clone(equipmentSelections),
                potentialLevel,
                character: {
                    ...clone(character),
                    growth: clone(characterGrowth)
                },
                source: clone(this.data.corpusManifest().sourceVersion)
            },
            semanticMappings: clone(semanticFile.value.mappings ?? []),
            sourcePaths,
            dependencySummary: {
                initialSkillIds: [...new Set(initialSkillIds)],
                discoveredSkillIds: [...discoveredSkillIds],
                programCount: programs.size,
                buffCount: buffs.size,
                loadoutEffectCount: loadoutEffects.length,
                intrinsicPassiveCount: intrinsicPassives.length,
                missingSkillCount: diagnostics.filter(item =>
                    item.code === 'AKE_SKILL_DATA_MISSING').length,
                missingBuffCount: diagnostics.filter(item =>
                    item.code === 'AKE_BUFF_DATA_MISSING').length
            },
            compiler: {
                unresolved: compilerUnresolved,
                unresolvedCodes: Object.fromEntries([...new Set(compilerUnresolved.map(item =>
                    item.code
                ))].map(code => [
                    code,
                    compilerUnresolved.filter(item => item.code === code).length
                ]))
            },
            diagnostics
        };
    }
}

export function serializableAkeScenario(bundle) {
    if (!isRecord(bundle)) throw new TypeError('bundle must be an assembled scenario object.');
    return {
        ...clone({
            ...bundle,
            programs: undefined,
            rawSkills: undefined,
            buffs: undefined,
            rawBuffs: undefined
        }),
        programs: Object.fromEntries(bundle.programs ?? []),
        buffs: Object.fromEntries(bundle.buffs ?? [])
    };
}

export default AkeScenarioAssembler;
