import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from './ake-action-compiler.mjs';
import { AkeLoadoutCompiler } from './ake-loadout-compiler.mjs';
import { evaluateAttributeComponent } from './attribute.mjs';

const modulePath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(modulePath), '..', '..');

const SKILL_GROUP_TYPES = Object.freeze({
    0: 'normalAttack',
    1: 'normalSkill',
    2: 'ultimateSkill',
    3: 'comboSkill'
});

const NAMED_PANEL_ATTRIBUTES = Object.freeze({
    0: 'Level',
    1: 'MaxHp',
    2: 'Atk',
    3: 'Def',
    9: 'CriticalRate',
    10: 'CriticalDamageIncrease',
    20: 'MaxPoise',
    21: 'PoiseRecoverySeconds',
    22: 'MaxUltimateSp',
    96: 'PulseResistance'
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

function panelAttributes(rawPanel) {
    const source = rawPanel?.data ?? rawPanel;
    if (!isRecord(source)) return { attributes: {}, calculations: {} };
    const attributes = {};
    const calculations = {};
    for (const [rawType, component] of Object.entries(source)) {
        if (!isRecord(component)) continue;
        const calculation = evaluateAttributeComponent(component);
        calculations[rawType] = calculation;
        attributes[`Attr${rawType}`] = calculation.value;
        const named = NAMED_PANEL_ATTRIBUTES[rawType];
        if (named) attributes[named] = calculation.value;
    }
    return { attributes, calculations };
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

/**
 * Joins the public AKE tables and frozen public Calc panel snapshots into one
 * auditable runtime bundle. It resolves file references only; unknown engine
 * semantics remain compiler diagnostics or explicit provider inputs.
 */
export class AkeScenarioAssembler {
    constructor({ projectRoot = defaultProjectRoot, tickRate = 30, maxDependencies = 4000 } = {}) {
        this.projectRoot = path.resolve(projectRoot);
        this.tickRate = nonNegativeNumber(tickRate, 'tickRate');
        if (this.tickRate === 0) throw new RangeError('tickRate must be positive.');
        this.maxDependencies = positiveInteger(maxDependencies, 'maxDependencies');
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
        const skillLevel = positiveInteger(options.skillLevel ?? 1, 'skillLevel');
        const weaponLevel = positiveInteger(options.weaponLevel ?? 1, 'weaponLevel');
        const diagnostics = [];

        const characterTableFile = this.#read([
            'reference', 'public-data', 'akedata', 'TableCfg', 'CharGrowthTable.json'
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
        const semanticFile = this.#read(['spec', 'engine-semantic-mappings.json']);
        const character = characterTableFile.value[characterId];
        if (!character) throw new Error(`Unknown character in CharGrowthTable: ${characterId}`);
        const enemyTemplate = enemyTableFile.value[enemyId];
        if (!enemyTemplate) throw new Error(`Unknown enemy in EnemyAttributeTemplateTable: ${enemyId}`);
        const roles = roleMap(character);
        const weaponId = identifier(
            options.weaponId ?? character.defaultWeaponId,
            'weaponId'
        );

        const characterApiFile = this.#read([
            'reference', 'public-data', 'calc', 'api', `character-${characterId}.json`
        ], { optional: true });
        const weaponApiFile = this.#read([
            'reference', 'public-data', 'calc', 'api', `weapon-${weaponId}.json`
        ], { optional: true });
        const characterPanelFile = this.#read([
            'reference', 'public-data', 'calc', 'api',
            `character-panel-${characterId}-level${level}.json`
        ], { optional: true });
        const enemyPanelFile = this.#read([
            'reference', 'public-data', 'calc', 'api', `enemy-${enemyId}-level${level}.json`
        ], { optional: true });
        const characterPanel = panelAttributes(characterPanelFile.value);
        const enemyPanel = panelAttributes(enemyPanelFile.value);
        if (!characterPanelFile.value) diagnostics.push({
            code: 'AKE_CHARACTER_PANEL_SNAPSHOT_MISSING',
            characterId,
            level,
            path: characterPanelFile.path
        });
        if (!enemyPanelFile.value) diagnostics.push({
            code: 'AKE_ENEMY_PANEL_SNAPSHOT_MISSING',
            enemyId,
            level,
            path: enemyPanelFile.path
        });

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
                ...(options.compilerCapabilities ?? {})
            }
        });
        const programs = new Map();
        const rawSkills = new Map();
        const sourcePaths = { skills: {}, buffs: {}, tables: {} };
        const referencedBuffIds = new Set(options.buffIds ?? []);
        const discoveredSkillIds = new Set();
        const initialSkillIds = options.skillIds ?? Object.values(roles.groups).flat();
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

        const loadoutCompiler = new AkeLoadoutCompiler();
        const loadoutEffects = [];
        for (const effectId of options.loadoutEffectIds ?? []) {
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
        for (const passive of options.equipmentPassives ?? []) {
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
            const effect = loadoutCompiler.compilePassiveSkill(passiveFile.value, {
                blackboard: passiveInput.blackboard ?? {},
                sourceType: passiveInput.sourceType ?? 'EquipmentPassive'
            });
            loadoutEffects.push(effect);
            collectReferences(effect, {
                buffIds: referencedBuffIds,
                skillIds: discoveredSkillIds
            });
        }

        const buffs = new Map();
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
                    diagnostics.push({
                        code: 'AKE_BUFF_DATA_MISSING',
                        buffId,
                        path: buffFile.path
                    });
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

        const independent = independentAttributes(enemyTemplate);
        const dependent = levelAttributes(enemyTemplate, level);
        const poiseMapping = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'EnemyPoiseTemplateRule'
        );
        const maxPoiseType = String(poiseMapping?.effect?.maxPoiseAttributeType ?? 20);
        const recoveryType = String(poiseMapping?.effect?.recoverySecondsAttributeType ?? 21);
        const executionType = String(
            poiseMapping?.effect?.executionDamageScalarAttributeType ?? 22
        );
        const characterAttributes = {
            ...characterPanel.attributes,
            Level: level,
            PoiseDamageOutputScalar: 1,
            PulseAbnormalDamageIncrease: 0,
            ...(options.characterAttributes ?? {})
        };
        const maxHp = nonNegativeNumber(
            options.enemyMaxHp ?? enemyPanel.attributes.MaxHp ?? dependent['1'],
            'enemy max HP'
        );
        const maxResilience = nonNegativeNumber(
            options.enemyMaxResilience
                ?? enemyPanel.attributes.MaxPoise
                ?? independent[maxPoiseType]
                ?? 0,
            'enemy max resilience'
        );
        const enemyAttributes = {
            ...enemyPanel.attributes,
            Level: level,
            Def: options.enemyDefense ?? enemyPanel.attributes.Def ?? dependent['3'] ?? 0,
            PulseResistance: options.pulseResistance
                ?? enemyPanel.attributes.PulseResistance
                ?? enemyTemplate.pulseResistance
                ?? 0,
            FireResistance: enemyTemplate.fireResistance ?? 0,
            CrystResistance: enemyTemplate.crystResistance ?? 0,
            DamageTakenScalar: 1,
            WeaknessDmgScalar: 1,
            ShelterDmgScalar: 0,
            PoiseDamageTakenScalar: 1,
            ExecutionDamageScalar: independent[executionType] ?? 1,
            ...(options.enemyAttributes ?? {})
        };
        const atbRule = (semanticFile.value.mappings ?? []).find(mapping =>
            mapping.actionType === 'ResourceRule'
            && mapping.selector?.resourceType === 'Atb'
        );
        const initialAtb = nonNegativeNumber(options.initialAtb ?? 300, 'initialAtb');
        const maxAtb = nonNegativeNumber(options.maxAtb ?? 300, 'maxAtb');
        const maxUltimateSp = nonNegativeNumber(
            options.maxUltimateSp ?? characterPanel.attributes.MaxUltimateSp ?? 80,
            'maxUltimateSp'
        );
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
                    attributes: characterAttributes,
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
                    vital: { maxHp, currentHp: maxHp },
                    resilience: {
                        maxResilience,
                        currentResilience: maxResilience,
                        recoveryPerTick: 0,
                        superArmorLevel: Number(enemyTemplate.initialSuperArmor ?? 0)
                    }
                }
            ],
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
            character: characterTableFile.path,
            skillPatch: skillPatchTableFile.path,
            enemy: enemyTableFile.path,
            potentialTalent: potentialTableFile.path,
            semanticMappings: semanticFile.path,
            characterApi: characterApiFile.path,
            weaponApi: weaponApiFile.path,
            characterPanel: characterPanelFile.path,
            enemyPanel: enemyPanelFile.path
        };
        const compilerUnresolved = [
            ...[...programs.values()].flatMap(program => program.compiler?.unresolved ?? []),
            ...[...buffs.values()].flatMap(buff => buff.compiler?.unresolved ?? [])
        ];
        return {
            schemaVersion: 1,
            tickRate: this.tickRate,
            identity: {
                characterId,
                englishName: character.engName,
                weaponId,
                weaponLevel,
                enemyId,
                level,
                skillLevel
            },
            roles,
            programs,
            rawSkills,
            buffs,
            rawBuffs,
            loadoutEffects,
            definitions,
            parameters: {
                characterAttributes: clone(characterAttributes),
                characterAttributeCalculations: clone(characterPanel.calculations),
                enemyAttributes: clone(enemyAttributes),
                enemyAttributeCalculations: clone(enemyPanel.calculations),
                enemyMaxHp: maxHp,
                enemyMaxResilience: maxResilience,
                enemyResilienceRecoverySeconds: independent[recoveryType] ?? null,
                weapon: clone(weaponApiFile.value?.data ?? null),
                character: clone(characterApiFile.value?.data ?? null)
            },
            semanticMappings: clone(semanticFile.value.mappings ?? []),
            sourcePaths,
            dependencySummary: {
                initialSkillIds: [...new Set(initialSkillIds)],
                discoveredSkillIds: [...discoveredSkillIds],
                programCount: programs.size,
                buffCount: buffs.size,
                loadoutEffectCount: loadoutEffects.length,
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
