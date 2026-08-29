import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import {
    buildAkeBuffPresentationIndex,
    resolveAkeBuffPresentation
} from '../src/core/ake-buff-presentation.mjs';
import { AkeDataRepository } from '../src/core/ake-data-repository.mjs';
import { enrichAkeTimingWithHitMultipliers } from '../src/core/ake-hit-profile-builder.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { runAkeScenario } from '../src/core/ake-scenario-runner.mjs';
import { runAkeSquadScenario } from '../src/core/ake-squad-scenario-runner.mjs';
import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(moduleDirectory, '..');
const timingProfileCache = new Map();
const timingProfileSourceSignature = new Map();

export const SLOT_FRAMES = 15;
export const TIMELINE_SLOTS = 40;

// The calculator targets a training dummy, not a killable encounter entity.
// Keeping the target alive prevents data branches such as `OnlyDead` from
// firing halfway through a rotation after an ordinary damage hit.
const CALCULATOR_DUMMY_MAX_HP = 1_000_000_000_000;

// A fixed wait is allowed to move later groups well past one minute.  The old
// 1,800-frame demo guard made those requests fail and left the UI displaying a
// stale report, which looked like realtime calculation had frozen.
const MAX_TIMELINE_FRAME = 108_000;

const COMMAND_TYPES = Object.freeze([
    'Attack',
    'ComboSkill',
    'NormalSkill',
    'UltimateSkill',
    'BreakingAttack'
]);

const SKILL_PRESENTATION = Object.freeze({
    Attack: {
        key: 'A',
        name: '普通攻击',
        shortName: '普攻',
        description: '连续输入会按公开动作映射自动衔接下一段。'
    },
    ComboSkill: {
        key: 'C',
        name: '连携技',
        shortName: '连携',
        description: '需要先满足公开数据中的连携触发条件。'
    },
    NormalSkill: {
        key: 'E',
        name: '战技',
        shortName: '战技',
        description: '消耗技力；实际释放时间受当前动作准入影响。'
    },
    UltimateSkill: {
        key: 'Q',
        name: '终结技',
        shortName: '终结技',
        description: '消耗终结技能量，并按公开数据记录冷却。'
    },
    BreakingAttack: {
        key: 'R',
        name: '处决攻击',
        shortName: '处决',
        description: '仅在目标失衡且处决门控开放时生效。'
    }
});

const operatorAsset = fileName => `/assets/images/img-operator/${fileName}`;
const skillAsset = (operatorName, fileName) =>
    `/assets/images/img-operator/skiil-icon/${operatorName}/${fileName}`;

const CHARACTERS = Object.freeze([
    {
        id: 'chr_0004_pelica',
        name: '佩丽卡',
        englishName: 'Perlica',
        monogram: '佩',
        profession: '术师',
        element: 'electric',
        elementLabel: '电',
        role: '术师 · 电',
        accent: '#64d8ff',
        avatarUrl: operatorAsset('佩丽卡.png'),
        skillIcons: {
            Attack: skillAsset('佩丽卡', 'icon_talent_pelica_01.png'),
            ComboSkill: skillAsset('佩丽卡', '佩丽卡连携技.png'),
            NormalSkill: skillAsset('佩丽卡', '佩丽卡战技.png'),
            UltimateSkill: skillAsset('佩丽卡', '佩丽卡终结技.png'),
            BreakingAttack: skillAsset('佩丽卡', 'icon_talent_pelica_02.png')
        },
        weaponId: 'wpn_funnel_0002',
        weaponType: '法术单元',
        initialUltimateSp: 80,
        preset: [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 45, commandType: 'Attack' },
            { frame: 90, commandType: 'ComboSkill' },
            { frame: 120, commandType: 'NormalSkill' }
        ]
    },
    {
        id: 'chr_0005_chen',
        name: '陈千语',
        englishName: 'Chen Qianyu',
        monogram: '陈',
        profession: '近卫',
        element: 'physical',
        elementLabel: '物理',
        role: '近卫 · 物理',
        accent: '#ffcc62',
        avatarUrl: operatorAsset('陈千语.png'),
        skillIcons: {
            Attack: skillAsset('陈千语', '陈千语普攻.webp'),
            ComboSkill: skillAsset('陈千语', '陈千语连携技.png'),
            NormalSkill: skillAsset('陈千语', '陈千语战技.png'),
            UltimateSkill: skillAsset('陈千语', '陈千语终结技.png'),
            BreakingAttack: skillAsset('陈千语', 'icon_talent_chen_02.png')
        },
        weaponId: 'wpn_sword_0003',
        weaponType: '单手剑',
        initialUltimateSp: 70,
        preset: [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 45, commandType: 'Attack' },
            { frame: 60, commandType: 'Attack' },
            { frame: 105, commandType: 'NormalSkill' },
            { frame: 270, commandType: 'UltimateSkill' }
        ]
    },
    {
        id: 'chr_0006_wolfgd',
        name: '狼卫',
        englishName: 'Wulfgard',
        monogram: '狼',
        profession: '术师',
        element: 'fire',
        elementLabel: '火',
        role: '术师 · 火',
        accent: '#ff876f',
        avatarUrl: operatorAsset('狼卫.png'),
        skillIcons: {
            Attack: skillAsset('狼卫', 'icon_skill_wolfgd_01_line.png'),
            ComboSkill: skillAsset('狼卫', '狼卫连携技.png'),
            NormalSkill: skillAsset('狼卫', '狼卫战技.png'),
            UltimateSkill: skillAsset('狼卫', '狼卫终结技.png'),
            BreakingAttack: skillAsset('狼卫', 'icon_skill_wolfgd_02.png')
        },
        weaponId: 'wpn_pistol_0001',
        weaponType: '手铳',
        initialUltimateSp: 90,
        preset: [
            { frame: 0, commandType: 'Attack' },
            { frame: 15, commandType: 'Attack' },
            { frame: 30, commandType: 'Attack' },
            { frame: 60, commandType: 'Attack' },
            { frame: 150, commandType: 'NormalSkill' },
            { frame: 270, commandType: 'UltimateSkill' }
        ]
    }
]);

const ENEMIES = Object.freeze([
    {
        id: 'eny_0007_mimicw',
        name: '拟态武装',
        note: '基准木桩 · 692 HP / 160 韧性'
    },
    {
        id: 'eny_0018_lbtough',
        name: '重装侵蚀体',
        note: '高生命 · 1108 HP / 320 韧性'
    },
    {
        id: 'eny_0018_lbtough_001',
        name: '重装侵蚀体（低韧）',
        note: '1108 HP / 140 韧性'
    },
    {
        id: 'eny_0021_agmelee',
        name: '近战侵蚀体',
        note: '轻型目标 · 138 HP / 60 韧性'
    },
    {
        id: 'eny_0121_klbud',
        name: '结晶芽',
        note: '处决演示 · 152 HP / 80 韧性'
    }
]);

const bundleCache = new Map();
const squadBundleCache = new Map();
const catalogCache = new Map();
const repositoryCache = new Map();
const buffPresentationIndexCache = new Map();

function demoRepository(projectRoot) {
    const resolvedRoot = path.resolve(projectRoot);
    if (!repositoryCache.has(resolvedRoot)) {
        repositoryCache.set(resolvedRoot, new AkeDataRepository({ projectRoot: resolvedRoot }));
    }
    return repositoryCache.get(resolvedRoot);
}

function buffPresentationIndex(projectRoot) {
    const resolvedRoot = path.resolve(projectRoot);
    if (!buffPresentationIndexCache.has(resolvedRoot)) {
        if (!catalogCache.has(resolvedRoot)) getDemoCatalog({ projectRoot: resolvedRoot });
        buffPresentationIndexCache.set(
            resolvedRoot,
            buildAkeBuffPresentationIndex(catalogCache.get(resolvedRoot))
        );
    }
    return buffPresentationIndexCache.get(resolvedRoot);
}

function runtimeBuffPresentation(projectRoot, buffId, sourceSkillId) {
    const repository = demoRepository(projectRoot);
    let rawPresentation = null;
    try {
        rawPresentation = repository.buffPresentation(buffId);
    } catch {
        // A synthetic or incomplete corpus Buff still receives a semantic name.
    }
    return resolveAkeBuffPresentation({
        buffId,
        sourceSkillId,
        index: buffPresentationIndex(projectRoot),
        rawPresentation,
        dataOrigin: repository.dataOrigin
    });
}

export class DemoInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DemoInputError';
    }
}

function finiteInteger(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new DemoInputError(`${label} 必须是 ${minimum}–${maximum} 之间的整数。`);
    }
    return number;
}

function finiteNumber(value, label, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new DemoInputError(`${label} 必须是 ${minimum}–${maximum} 之间的有限数值。`);
    }
    return number;
}

function optionalIdentifier(value, label, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value).trim();
    if (!/^[a-zA-Z0-9_.:-]{1,96}$/.test(text)) {
        throw new DemoInputError(`${label} 格式不正确。`);
    }
    return text;
}

function normalizeIdentifierList(value, label, maximum = 16) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum) {
        throw new DemoInputError(`${label} 必须是最多 ${maximum} 项的数组。`);
    }
    return [...new Set(value.map((item, index) => (
        optionalIdentifier(item, `${label}[${index}]`, '')
    )))].filter(Boolean);
}

function normalizeCharacterAttributes(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DemoInputError('characterAttributes 必须是对象。');
    }
    const ranges = {
        Atk: [0, 10_000_000],
        MaxHp: [0, 100_000_000],
        CriticalRate: [0, 1],
        CriticalDamageIncrease: [0, 10],
        PulseAbnormalDamageIncrease: [0, 100],
        PoiseDamageOutputScalar: [0, 100],
        ConfiguredAllDamageBonus: [-0.99, 100],
        ConfiguredPhysicalDamageBonus: [-0.99, 100],
        ConfiguredFireDamageBonus: [-0.99, 100],
        ConfiguredPulseDamageBonus: [-0.99, 100],
        ConfiguredCrystDamageBonus: [-0.99, 100],
        ConfiguredNaturalDamageBonus: [-0.99, 100],
        ConfiguredMagicDamageBonus: [-0.99, 100],
        ConfiguredNormalAttackDamageBonus: [-0.99, 100],
        ConfiguredNormalSkillDamageBonus: [-0.99, 100],
        ConfiguredComboSkillDamageBonus: [-0.99, 100],
        ConfiguredUltimateSkillDamageBonus: [-0.99, 100]
    };
    return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
        const range = ranges[key];
        if (!range) throw new DemoInputError(`不支持的角色面板字段：${key}`);
        return [key, finiteNumber(raw, `characterAttributes.${key}`, range[0], range[1])];
    }));
}

function normalizeEquipmentPassives(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) {
        throw new DemoInputError('equipmentPassives 必须是最多 8 项的数组。');
    }
    return value.map((item, index) => {
        if (typeof item === 'string') {
            return { skillId: optionalIdentifier(item, `equipmentPassives[${index}]`, '') };
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new DemoInputError(`equipmentPassives[${index}] 格式不正确。`);
        }
        const blackboard = item.blackboard === undefined ? {} : item.blackboard;
        if (!blackboard || typeof blackboard !== 'object' || Array.isArray(blackboard)) {
            throw new DemoInputError(`equipmentPassives[${index}].blackboard 必须是对象。`);
        }
        const normalizedBlackboard = Object.fromEntries(Object.entries(blackboard).map(([key, raw]) => [
            optionalIdentifier(key, `equipmentPassives[${index}].blackboard key`, ''),
            finiteNumber(raw, `equipmentPassives[${index}].blackboard.${key}`, -1_000_000, 1_000_000)
        ]));
        return {
            skillId: optionalIdentifier(item.skillId, `equipmentPassives[${index}].skillId`, ''),
            blackboard: normalizedBlackboard,
            sourceType: optionalIdentifier(item.sourceType, `equipmentPassives[${index}].sourceType`, 'EquipmentPassive')
        };
    });
}

function publicCharacter(character) {
    return {
        ...character,
        preset: character.preset.map((command, index) => ({
            ...command,
            commandId: `${character.id}:preset:${index + 1}`
        }))
    };
}

export function getDemoCatalog({ projectRoot = defaultProjectRoot } = {}) {
    const resolvedRoot = path.resolve(projectRoot);
    if (!catalogCache.has(resolvedRoot)) {
        catalogCache.set(resolvedRoot, demoRepository(resolvedRoot).catalog());
    }
    const akeCatalog = catalogCache.get(resolvedRoot);
    const timingPath = path.join(
        resolvedRoot, 'derived', 'cleanroom', 'ake-timing-profiles.json'
    );
    // The Vite middleware is a long-lived process, while the timing catalog is
    // a generated artifact that can be rebuilt during development.  Keying
    // the cache by the file signature prevents an old catalog from continuing
    // to expose every status tick as a release snap after a rebuild.  This is
    // deliberately server-side; the UI already requests the endpoint with
    // `cache: no-store`.
    const timingStat = fs.statSync(timingPath);
    const timingSignature = [
        timingStat.mtimeMs,
        timingStat.size,
        timingStat.ino ?? 0
    ].join(':');
    if (!timingProfileCache.has(resolvedRoot)
        || timingProfileSourceSignature.get(resolvedRoot) !== timingSignature) {
        timingProfileCache.set(resolvedRoot, enrichAkeTimingWithHitMultipliers({
            projectRoot: resolvedRoot,
            timing: JSON.parse(fs.readFileSync(timingPath, 'utf8'))
        }));
        timingProfileSourceSignature.set(resolvedRoot, timingSignature);
    }
    return {
        ...structuredClone(akeCatalog),
        schemaVersion: 2,
        tickRate: 30,
        slotFrames: SLOT_FRAMES,
        timelineSlots: TIMELINE_SLOTS,
        defaultCharacterId: akeCatalog.characters[0]?.id ?? CHARACTERS[0].id,
        defaultEnemyId: ENEMIES[0].id,
        timing: structuredClone(timingProfileCache.get(resolvedRoot)),
        enemies: structuredClone(ENEMIES),
        skills: COMMAND_TYPES.map(commandType => ({
            commandType,
            ...SKILL_PRESENTATION[commandType]
        })),
        caveats: [
            '全队在同一个 AKE CombatRuntime 中结算，并共用唯一的 300 点技力池。',
            '按钮表示输入意图；实际执行帧由动作准入、排队与资源共同决定。',
            '干员、武器、装备、套装与图片地址全部来自已钉住版本的 AKEDatabase。'
        ]
    };
}

function normalizeRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new DemoInputError('请求体必须是一个对象。');
    }
    const character = CHARACTERS.find(item => item.id === input.characterId);
    if (!character) throw new DemoInputError('未知角色。');
    const enemy = ENEMIES.find(item => item.id === input.enemyId);
    if (!enemy) throw new DemoInputError('未知敌人。');
    if (!Array.isArray(input.commands)) throw new DemoInputError('commands 必须是数组。');
    if (input.commands.length > 80) throw new DemoInputError('单次最多放置 80 个指令。');

    const seenIds = new Set();
    const commands = input.commands.map((command, index) => {
        if (!command || typeof command !== 'object' || Array.isArray(command)) {
            throw new DemoInputError(`第 ${index + 1} 个指令格式不正确。`);
        }
        if (!COMMAND_TYPES.includes(command.commandType)) {
            throw new DemoInputError(`第 ${index + 1} 个指令类型不受支持。`);
        }
        const frame = finiteInteger(command.frame, `第 ${index + 1} 个指令帧`, 0, 1800);
        const rawId = String(command.commandId ?? `command-${index + 1}`);
        const commandId = rawId.replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 96)
            || `command-${index + 1}`;
        if (seenIds.has(commandId)) throw new DemoInputError(`指令 ID 重复：${commandId}`);
        seenIds.add(commandId);
        return { frame, commandType: command.commandType, commandId, sourceOrder: index };
    }).sort((left, right) => left.frame - right.frame || left.sourceOrder - right.sourceOrder)
        .map(({ sourceOrder, ...command }) => command);

    const initialAtb = finiteInteger(input.initialAtb ?? 300, '初始技力', 0, 300);
    const initialUltimateSp = finiteInteger(
        input.initialUltimateSp ?? character.initialUltimateSp,
        '初始终结技能量',
        0,
        300
    );
    const lastFrame = commands.at(-1)?.frame ?? 0;
    const automaticEndFrame = Math.min(1800, Math.max(360, lastFrame + 300));
    const endFrame = input.endFrame === undefined
        ? automaticEndFrame
        : finiteInteger(input.endFrame, '结束帧', lastFrame, 1800);

    const level = finiteInteger(input.level ?? 1, '角色等级', 1, 90);
    const skillLevel = finiteInteger(input.skillLevel ?? 1, '技能等级', 1, 12);
    const weaponLevel = finiteInteger(input.weaponLevel ?? 1, '武器等级', 1, 90);
    const weaponId = optionalIdentifier(input.weaponId, '武器 ID', character.weaponId);
    const loadoutEffectIds = normalizeIdentifierList(input.loadoutEffectIds, 'loadoutEffectIds');
    const equipmentPassives = normalizeEquipmentPassives(input.equipmentPassives);
    const characterAttributes = normalizeCharacterAttributes(input.characterAttributes);

    return {
        character,
        enemy,
        commands,
        initialAtb,
        initialUltimateSp,
        endFrame,
        level,
        skillLevel,
        weaponId,
        weaponLevel,
        loadoutEffectIds,
        equipmentPassives,
        characterAttributes
    };
}

function compactProgram(program) {
    if (!program) return null;
    return {
        skillId: program.skillId,
        durationFrames: Number(program.durationFrames ?? 0),
        costType: program.costType ?? null,
        costValue: Number(program.costValue ?? 0),
        cooldownFrames: Number(program.cooldownTicks ?? 0),
        unresolvedEffectCount: program.compiler?.unresolved?.length ?? 0
    };
}

function commandSkills(bundle) {
    const single = (commandType, skillId) => ({
        commandType,
        ...SKILL_PRESENTATION[commandType],
        programs: skillId ? [compactProgram(bundle.programs.get(skillId))] : []
    });
    return [
        {
            commandType: 'Attack',
            ...SKILL_PRESENTATION.Attack,
            programs: bundle.roles.normalAttackIds
                .map(skillId => compactProgram(bundle.programs.get(skillId)))
                .filter(Boolean)
        },
        single('ComboSkill', bundle.roles.comboSkillId),
        single('NormalSkill', bundle.roles.normalSkillId),
        single('UltimateSkill', bundle.roles.ultimateSkillId),
        single('BreakingAttack', bundle.roles.breakingAttackId)
    ];
}

function getBundle(projectRoot, request) {
    const cacheKey = JSON.stringify([
        path.resolve(projectRoot),
        request.character.id,
        request.weaponId,
        request.enemy.id,
        request.initialAtb,
        request.initialUltimateSp,
        request.level,
        request.skillLevel,
        request.weaponLevel,
        request.loadoutEffectIds,
        request.equipmentPassives,
        request.characterAttributes,
        CALCULATOR_DUMMY_MAX_HP
    ]);
    if (!bundleCache.has(cacheKey)) {
        const assembler = new AkeScenarioAssembler({ projectRoot });
        bundleCache.set(cacheKey, assembler.assemble({
            characterId: request.character.id,
            weaponId: request.weaponId,
            level: request.level,
            skillLevel: request.skillLevel,
            weaponLevel: request.weaponLevel,
            enemyId: request.enemy.id,
            enemyMaxHp: CALCULATOR_DUMMY_MAX_HP,
            initialAtb: request.initialAtb,
            initialUltimateSp: request.initialUltimateSp,
            loadoutEffectIds: request.loadoutEffectIds,
            equipmentPassives: request.equipmentPassives,
            characterAttributes: request.characterAttributes
        }));
    }
    return bundleCache.get(cacheKey);
}

function resourceSeries(trace, durationTicks) {
    const events = [...trace].sort((left, right) => left.frame - right.frame);
    const current = { Atb: 0, UltimateSp: 0 };
    const series = [];
    let cursor = 0;
    for (let frame = 0; frame <= durationTicks; frame += SLOT_FRAMES) {
        while (cursor < events.length && events[cursor].frame <= frame) {
            const event = events[cursor];
            if (event.resourceType in current && Number.isFinite(Number(event.after))) {
                current[event.resourceType] = Number(event.after);
            }
            cursor += 1;
        }
        series.push({ frame, ...current });
    }
    if (series.at(-1)?.frame !== durationTicks) {
        while (cursor < events.length && events[cursor].frame <= durationTicks) {
            const event = events[cursor];
            if (event.resourceType in current && Number.isFinite(Number(event.after))) {
                current[event.resourceType] = Number(event.after);
            }
            cursor += 1;
        }
        series.push({ frame: durationTicks, ...current });
    }
    return series;
}

function meaningfulResourceEvents(trace) {
    return trace.filter(event => {
        if (event.stage === 'ResourcePoolRegistered') return true;
        return Math.abs(Number(event.actualDelta ?? 0)) > 1e-9
            && event.reason !== 'PassiveRecovery';
    }).slice(0, 120).map(event => ({
        frame: event.frame,
        stage: event.stage,
        resourceType: event.resourceType,
        before: Number(event.before ?? 0),
        delta: Number(event.actualDelta ?? event.actual ?? 0),
        after: Number(event.after ?? 0),
        reason: event.reason ?? null,
        sourceId: event.sourceId ?? null
    }));
}

function compactStatusEvents(trace, { projectRoot = defaultProjectRoot } = {}) {
    const lifecycleStages = new Set([
        'StatusEffectApplied',
        'StatusEffectRefreshed',
        'StatusEffectStackRemoved',
        'StatusEffectFinished',
        'StatusEffectExpired',
        'StatusEffectRemoved',
        'StatusEffectUnresolved'
    ]);
    return trace.map((event, traceIndex) => ({ event, traceIndex }))
        .filter(({ event }) => lifecycleStages.has(event.stage))
        .slice(0, 2400).map(({ event, traceIndex }) => {
        const presentation = runtimeBuffPresentation(
            projectRoot,
            event.buffId,
            event.sourceSkillId ?? event.triggerSkillId ?? null
        );
        return {
        traceIndex,
        eventId: event.eventId ?? null,
        sequence: event.sequence ?? traceIndex,
        frame: event.frame,
        stage: event.stage,
        instanceId: event.instanceId ?? null,
        buffId: event.buffId,
        sourceId: event.sourceId ?? null,
        ownerId: event.ownerId ?? null,
        carrierId: event.carrierId ?? event.targetId ?? null,
        targetId: event.targetId,
        damageSourceId: event.damageSourceId ?? event.sourceId ?? null,
        transactionId: event.transactionId ?? null,
        parentEventId: event.parentEventId ?? null,
        parentHitId: event.parentHitId ?? null,
        hitEventPhase: event.hitEventPhase ?? null,
        sourceMetadata: structuredClone(event.sourceMetadata ?? {}),
        stackCount: event.stackCount ?? null,
        before: event.before ?? null,
        requested: event.requested ?? null,
        actual: event.actual ?? null,
        consumedStacks: event.consumedStacks ?? null,
        consumption: Boolean(event.consumption),
        consumerId: event.consumerId ?? null,
        consumeKind: event.consumeKind ?? null,
        triggerCommandType: event.triggerCommandType ?? null,
        triggerSkillType: event.triggerSkillType ?? null,
        bySource: structuredClone(event.bySource ?? []),
        discarded: event.discarded ?? null,
        after: event.after ?? event.stackCount ?? null,
        durationFrames: event.durationTicks ?? null,
        expireFrame: event.expireFrame ?? null,
        sourceSkillId: event.sourceSkillId ?? null,
        rootSkillId: event.rootSkillId ?? null,
        castId: event.castId ?? null,
        rootCastId: event.rootCastId ?? event.castId ?? null,
        parentCastId: event.parentCastId ?? null,
        inputSkillId: event.inputSkillId ?? event.rootSkillId ?? null,
        inputCommandType: event.inputCommandType ?? event.commandType ?? null,
        effectiveSkillType: event.effectiveSkillType ?? event.skillType ?? null,
        triggerSourceId: event.triggerSourceId ?? null,
        triggerOwnerId: event.triggerOwnerId ?? null,
        triggerTargetId: event.triggerTargetId ?? null,
        triggerSkillId: event.triggerSkillId ?? null,
        triggerRootSkillId: event.triggerRootSkillId ?? null,
        triggerInputSkillId: event.triggerInputSkillId ?? null,
        triggerCastId: event.triggerCastId ?? null,
        triggerRootCastId: event.triggerRootCastId ?? event.triggerCastId ?? null,
        triggerParentCastId: event.triggerParentCastId ?? null,
        triggerInputCommandType: event.triggerInputCommandType
            ?? event.triggerCommandType
            ?? null,
        triggerEffectiveSkillType: event.triggerEffectiveSkillType
            ?? event.triggerSkillType
            ?? null,
        reason: event.reason ?? null,
        ...presentation
        };
    });
}

function compactHits(damageLog) {
    return damageLog.slice(0, 300).map(hit => ({
        frame: hit.frame,
        castId: hit.castId,
        skillId: hit.skillId,
        rootSkillId: hit.rootSkillId,
        damageType: hit.damageType,
        damageAttributeType: hit.damageAttributeType,
        rawDamage: Number(hit.rawDamage ?? 0),
        finalDamage: Number(hit.finalDamage ?? 0),
        poiseDamage: Number(hit.poiseDamage ?? 0),
        targetHpBefore: hit.targetHpBefore,
        targetHpAfter: hit.targetHpAfter,
        consumedStatuses: structuredClone(hit.consumedStatuses ?? [])
    }));
}

function settleCommands(commands, result) {
    return commands.map(command => {
        const traces = result.commandTrace.filter(entry => entry.commandId === command.commandId);
        const queued = traces.find(entry => entry.type === 'CommandQueued') ?? null;
        const terminal = [...traces].reverse().find(entry =>
            entry.type === 'CommandExecuted' || entry.type === 'CommandExpired'
        ) ?? null;
        const admissions = result.commandAdmissionTrace.filter(entry =>
            entry.commandId === command.commandId
        );
        const rejectedAdmission = admissions.find(entry => !entry.accepted) ?? null;
        const hits = terminal?.castId
            ? result.damageLog.filter(hit => (
                hit.castId === terminal.castId || hit.rootCastId === terminal.castId
            ))
            : [];
        const successful = terminal?.type === 'CommandExecuted' && terminal.success;
        const status = successful
            ? queued ? 'queued-then-executed' : 'executed'
            : terminal?.type === 'CommandExpired'
                ? 'expired'
                : 'failed';
        return {
            commandId: command.commandId,
            commandType: command.commandType,
            requestedFrame: command.frame,
            actualFrame: terminal?.frame ?? null,
            delayFrames: terminal ? terminal.frame - command.frame : null,
            status,
            success: Boolean(successful),
            queued: Boolean(queued),
            predictedQueueFrame: queued?.executeFrame ?? null,
            reason: terminal?.reason ?? queued?.reason ?? null,
            admissionReason: rejectedAdmission?.reason ?? admissions.at(-1)?.reason ?? null,
            skillId: terminal?.skillId ?? queued?.skillId ?? null,
            castId: terminal?.castId ?? null,
            executedSkillIds: [...new Set(hits.map(hit => hit.skillId).filter(Boolean))],
            effectiveSkillTypes: [...new Set(hits
                .map(hit => hit.effectiveSkillType)
                .filter(Boolean))],
            damage: hits.reduce((sum, hit) => sum + Number(hit.finalDamage ?? 0), 0),
            poiseDamage: hits.reduce((sum, hit) => sum + Number(hit.poiseDamage ?? 0), 0),
            hitCount: hits.length
        };
    });
}

export function simulateDemo(input, { projectRoot = defaultProjectRoot } = {}) {
    const request = normalizeRequest(input);
    const bundle = getBundle(projectRoot, request);
    const result = runAkeScenario(bundle, {
        commands: request.commands,
        endFrame: request.endFrame
    });
    const hits = compactHits(result.damageLog);
    const timeline = projectAkeTimeline(result);
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        tickRate: result.tickRate,
        durationFrames: result.durationTicks,
        durationSeconds: result.durationTicks / result.tickRate,
        character: publicCharacter(request.character),
        enemy: structuredClone(request.enemy),
        identity: structuredClone(bundle.identity),
        loadout: {
            weaponId: request.weaponId,
            weaponLevel: request.weaponLevel,
            potentialEffectIds: structuredClone(request.loadoutEffectIds),
            equipmentPassiveIds: request.equipmentPassives.map((item) => item.skillId),
            panelOverrides: structuredClone(request.characterAttributes),
            installedEffectCount: bundle.loadoutEffects.length
        },
        profile: {
            atk: Number(bundle.parameters.characterAttributes.Atk ?? 0),
            maxHp: Number(bundle.parameters.characterAttributes.MaxHp ?? 0),
            defense: Number(bundle.parameters.enemyAttributes.Def ?? 0),
            enemyMaxHp: Number(bundle.parameters.enemyMaxHp ?? 0),
            enemyMaxPoise: Number(bundle.parameters.enemyMaxResilience ?? 0),
            maxAtb: 300,
            maxUltimateSp: Number(
                bundle.definitions.resources.find(resource =>
                    resource.resourceType === 'UltimateSp')?.max ?? 0
            )
        },
        skills: commandSkills(bundle),
        commands: settleCommands(request.commands, result),
        summary: {
            ...structuredClone(result.damageSummary),
            dps: result.durationTicks > 0
                ? result.damageSummary.totalDamage / (result.durationTicks / result.tickRate)
                : 0,
            targetHp: result.finalState.targetHp,
            targetHpPercent: bundle.parameters.enemyMaxHp > 0
                ? result.finalState.targetHp / bundle.parameters.enemyMaxHp
                : 0,
            successfulCommands: result.commandTrace.filter(entry =>
                entry.type === 'CommandExecuted' && entry.success).length,
            failedCommands: result.commandTrace.filter(entry =>
                (entry.type === 'CommandExecuted' && !entry.success)
                || entry.type === 'CommandExpired').length
        },
        finalState: {
            resources: structuredClone(result.finalState.resources),
            cooldowns: structuredClone(result.finalState.cooldowns),
            activeStatuses: result.finalState.statuses.map(status => ({
                buffId: status.buffId,
                targetId: status.targetId,
                stackCount: status.stackCount,
                expireFrame: status.expireFrame
            })),
            resilience: structuredClone(result.finalState.resilience),
            poise: structuredClone(result.finalState.poise)
        },
        resourceSeries: resourceSeries(result.resourceTrace, result.durationTicks),
        resourceEvents: meaningfulResourceEvents(result.resourceTrace),
        statusEvents: compactStatusEvents(result.statusTrace, { projectRoot }),
        teamComboLedger: structuredClone(result.teamComboLedger),
        hits,
        timeline,
        traces: {
            commands: structuredClone(result.commandTrace),
            admissions: structuredClone(result.commandAdmissionTrace),
            cooldowns: structuredClone(result.cooldownTrace),
            centers: structuredClone(result.centerStateTrace),
            loadout: structuredClone(result.loadoutTrace ?? [])
        },
        diagnostics: {
            unresolvedEffectCount: result.diagnostics.unresolvedEffectCount,
            compilerUnresolvedEffectCount: bundle.compiler.unresolved.length,
            runtimeDiagnostics: result.diagnostics.unresolvedEffects.map(event => ({
                eventId: event.eventId ?? null,
                sequence: event.sequence ?? null,
                frame: event.frame ?? null,
                stage: event.stage ?? null,
                actionType: event.type ?? event.action?.type ?? null,
                status: event.result?.resolution?.status ?? event.result?.status ?? 'Unresolved',
                code: event.result?.code
                    ?? event.result?.reason
                    ?? event.result?.resolution?.unresolved?.[0]?.code
                    ?? null,
                sourceId: event.sourceId ?? null,
                ownerId: event.ownerId ?? null,
                carrierId: event.carrierId ?? event.targetId ?? null,
                targetId: event.targetId ?? null,
                damageSourceId: event.damageSourceId ?? event.sourceId ?? null,
                skillId: event.skillId ?? null,
                castId: event.castId ?? null,
                transactionId: event.transactionId ?? null,
                parentEventId: event.parentEventId ?? null
            })),
            dependencySummary: structuredClone(bundle.dependencySummary),
            assemblerDiagnostics: structuredClone(bundle.diagnostics)
        }
    };
}

function normalizeSquadRequest(input, projectRoot) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new DemoInputError('请求体必须是一个对象。');
    }
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 4) {
        throw new DemoInputError('members 必须包含 1–4 名干员。');
    }
    const catalog = getDemoCatalog({ projectRoot });
    const characterById = new Map(catalog.characters.map(character => [character.id, character]));
    const weaponById = new Map(catalog.weapons.map(weapon => [weapon.id, weapon]));
    const equipmentById = new Map(catalog.equipment.map(equipment => [equipment.id, equipment]));
    const seenMemberIds = new Set();
    const seenCharacterIds = new Set();
    const members = input.members.map((member, index) => {
        if (!member || typeof member !== 'object' || Array.isArray(member)) {
            throw new DemoInputError(`members[${index}] 格式不正确。`);
        }
        const characterId = optionalIdentifier(
            member.characterId,
            `members[${index}].characterId`,
            ''
        );
        const character = characterById.get(characterId);
        if (!character) throw new DemoInputError(`未知干员：${characterId}`);
        if (seenCharacterIds.has(characterId)) {
            throw new DemoInputError(`队伍不能重复选择干员：${character.name}`);
        }
        seenCharacterIds.add(characterId);
        const memberId = optionalIdentifier(
            member.memberId ?? member.uuid,
            `members[${index}].memberId`,
            characterId
        );
        if (seenMemberIds.has(memberId)) throw new DemoInputError(`队员 ID 重复：${memberId}`);
        seenMemberIds.add(memberId);
        const weaponId = optionalIdentifier(
            member.weaponId,
            `members[${index}].weaponId`,
            character.defaultWeaponId
        );
        const weapon = weaponById.get(weaponId);
        if (!weapon) throw new DemoInputError(`未知武器：${weaponId}`);
        if (weapon.weaponTypeId !== character.weaponTypeId) {
            throw new DemoInputError(`${character.name} 不能装备 ${weapon.name}。`);
        }
        const rawEquipment = member.equipment ?? member.equipmentIds ?? [];
        if (!Array.isArray(rawEquipment) || rawEquipment.length > 4) {
            throw new DemoInputError(`members[${index}].equipment 必须是最多 4 项的数组。`);
        }
        const equipment = rawEquipment.map((selection, equipmentIndex) => {
            const value = typeof selection === 'string'
                ? { equipmentId: selection, enhance: 3 }
                : selection;
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new DemoInputError(
                    `members[${index}].equipment[${equipmentIndex}] 格式不正确。`
                );
            }
            const equipmentId = optionalIdentifier(
                value.equipmentId ?? value.id,
                `members[${index}].equipment[${equipmentIndex}].equipmentId`,
                ''
            );
            if (!equipmentById.has(equipmentId)) {
                throw new DemoInputError(`未知装备：${equipmentId}`);
            }
            return {
                equipmentId,
                enhance: finiteInteger(
                    value.enhance ?? 3,
                    `members[${index}].equipment[${equipmentIndex}].enhance`,
                    0,
                    3
                )
            };
        });
        return {
            memberId,
            characterId,
            level: finiteInteger(member.level ?? 1, `members[${index}].level`, 1, 90),
            skillLevel: finiteInteger(
                member.skillLevel ?? 1,
                `members[${index}].skillLevel`,
                1,
                12
            ),
            potentialLevel: finiteInteger(
                member.potentialLevel ?? 0,
                `members[${index}].potentialLevel`,
                0,
                5
            ),
            weaponId,
            weaponLevel: finiteInteger(
                member.weaponLevel ?? 1,
                `members[${index}].weaponLevel`,
                1,
                weapon.maxLevel
            ),
            weaponPotential: finiteInteger(
                member.weaponPotential ?? 1,
                `members[${index}].weaponPotential`,
                1,
                9
            ),
            weaponSkillLevels: Object.fromEntries(
                ['skill1', 'skill2', 'skill3'].map(skillKey => [
                    skillKey,
                    finiteInteger(
                        member.weaponSkillLevels?.[skillKey]
                            ?? member.weaponPotential
                            ?? 1,
                        `members[${index}].weaponSkillLevels.${skillKey}`,
                        1,
                        9
                    )
                ])
            ),
            initialUltimateSp: finiteNumber(
                member.initialUltimateSp ?? character.maxUltimateSp,
                `members[${index}].initialUltimateSp`,
                0,
                Math.max(300, character.maxUltimateSp)
            ),
            equipment
        };
    });

    const enemy = catalog.enemies.find(item => item.id === input.enemyId)
        ?? catalog.enemies.find(item => item.id === catalog.defaultEnemyId);
    if (!enemy) throw new DemoInputError('未知敌人。');
    if (!Array.isArray(input.commands)) throw new DemoInputError('commands 必须是数组。');
    if (input.commands.length > 320) throw new DemoInputError('单次最多放置 320 个指令。');
    const seenCommandIds = new Set();
    const commands = input.commands.map((command, index) => {
        if (!command || typeof command !== 'object' || Array.isArray(command)) {
            throw new DemoInputError(`第 ${index + 1} 个指令格式不正确。`);
        }
        const memberId = optionalIdentifier(
            command.memberId ?? command.uuid,
            `commands[${index}].memberId`,
            ''
        );
        const member = members.find(candidate => candidate.memberId === memberId);
        if (!member) throw new DemoInputError(`第 ${index + 1} 个指令没有对应的队员。`);
        if (!COMMAND_TYPES.includes(command.commandType)) {
            throw new DemoInputError(`第 ${index + 1} 个指令类型不受支持。`);
        }
        const rawId = String(command.commandId ?? `${memberId}:command:${index + 1}`);
        const commandId = rawId.replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 96)
            || `${memberId}:command:${index + 1}`;
        if (seenCommandIds.has(commandId)) throw new DemoInputError(`指令 ID 重复：${commandId}`);
        seenCommandIds.add(commandId);
        return {
            commandId,
            memberId,
            characterId: member.characterId,
            commandType: command.commandType,
            frame: finiteInteger(
                command.frame,
                `第 ${index + 1} 个指令帧`,
                0,
                MAX_TIMELINE_FRAME
            ),
            queueMode: command.queueMode === 'timeline-sequence'
                ? 'timeline-sequence'
                : undefined,
            attackMode: command.commandType === 'Attack' && command.attackMode === 'full-combo'
                ? 'full-combo'
                : undefined,
            sourceOrder: index
        };
    }).sort((left, right) => left.frame - right.frame
        || left.memberId.localeCompare(right.memberId)
        || left.sourceOrder - right.sourceOrder)
        .map(({ sourceOrder, ...command }) => command);
    const lastFrame = commands.reduce((maximum, command) => Math.max(maximum, command.frame), 0);
    const automaticEndFrame = Math.min(
        MAX_TIMELINE_FRAME,
        Math.max(360, lastFrame + 300)
    );
    return {
        catalog,
        members,
        enemy,
        enemyLevel: finiteInteger(input.enemyLevel ?? 1, '敌人等级', 1, 999),
        initialAtb: finiteNumber(input.initialAtb ?? 300, '初始技力', 0, 300),
        commands,
        endFrame: input.endFrame === undefined
            ? automaticEndFrame
            : finiteInteger(input.endFrame, '结束帧', lastFrame, MAX_TIMELINE_FRAME)
    };
}

function getSquadBundle(projectRoot, request) {
    const cacheKey = JSON.stringify([
        path.resolve(projectRoot),
        request.enemy.id,
        request.enemyLevel,
        request.initialAtb,
        request.members,
        CALCULATOR_DUMMY_MAX_HP
    ]);
    if (!squadBundleCache.has(cacheKey)) {
        squadBundleCache.set(cacheKey, new AkeSquadScenarioAssembler({ projectRoot }).assemble({
            enemyId: request.enemy.id,
            enemyLevel: request.enemyLevel,
            enemyMaxHp: CALCULATOR_DUMMY_MAX_HP,
            initialAtb: request.initialAtb,
            members: request.members
        }));
    }
    return squadBundleCache.get(cacheKey);
}

function compactSquadHits(damageLog) {
    return damageLog.slice(0, 1200).map((hit, hitIndex) => ({
        hitIndex,
        hitId: hit.hitId ?? `legacy-hit:${hitIndex}`,
        sequence: hit.sequence ?? hitIndex,
        parentTransactionId: hit.parentTransactionId ?? null,
        parentEventId: hit.parentEventId ?? null,
        traceIndex: hit.traceIndex ?? null,
        frame: hit.frame,
        memberId: hit.memberId,
        characterId: hit.characterId,
        sourceId: hit.sourceId ?? hit.characterId ?? null,
        ownerId: hit.ownerId ?? null,
        carrierId: hit.carrierId ?? hit.sourceId ?? null,
        targetId: hit.targetId ?? null,
        damageSourceId: hit.damageSourceId ?? hit.sourceId ?? null,
        castId: hit.castId,
        rootCastId: hit.rootCastId ?? hit.castId,
        parentCastId: hit.parentCastId ?? null,
        inputSkillId: hit.inputSkillId ?? hit.rootSkillId ?? null,
        inputCommandType: hit.inputCommandType ?? null,
        effectiveSkillType: hit.effectiveSkillType ?? null,
        skillId: hit.skillId,
        rootSkillId: hit.rootSkillId,
        buffInstanceId: hit.buffInstanceId ?? null,
        sourceBuffInstanceId: hit.sourceBuffInstanceId ?? hit.buffInstanceId ?? null,
        sourceBuffId: hit.sourceBuffId ?? null,
        semanticHitType: hit.semanticHitType ?? 'skill',
        displayName: hit.displayName ?? null,
        reason: hit.reason ?? null,
        sourcePath: hit.sourcePath ?? null,
        damageUnitIndex: hit.damageUnitIndex ?? null,
        damageType: hit.damageType,
        damageAttributeType: hit.damageAttributeType,
        damageDecorateMask: Number(hit.damageDecorateMask ?? 0),
        damageTypeMask: hit.damageTypeMask ?? null,
        atkScale: Number(hit.atkScale ?? hit.operands?.atkScale ?? 0),
        rawDamage: Number(hit.rawDamage ?? 0),
        finalDamage: Number(hit.finalDamage ?? 0),
        nonCriticalDamage: Number(hit.nonCriticalDamage ?? hit.finalDamage ?? 0),
        criticalDamage: Number(hit.criticalDamage ?? hit.finalDamage ?? 0),
        expectedDamage: Number(hit.expectedDamage ?? hit.finalDamage ?? 0),
        poiseDamage: Number(hit.poiseDamage ?? 0),
        targetHpBefore: hit.targetHpBefore,
        targetHpAfter: hit.targetHpAfter,
        modifierSnapshot: structuredClone(hit.modifierSnapshot ?? {}),
        operands: structuredClone(hit.operands ?? {}),
        consumedStatuses: structuredClone(hit.consumedStatuses ?? []),
        factors: structuredClone(hit.factors ?? []),
        factorValidation: structuredClone(hit.factorValidation ?? null),
        diagnostics: structuredClone(hit.diagnostics ?? []),
        confidence: hit.confidence ?? 'partial'
    }));
}

export function simulateSquadDemo(input, {
    projectRoot = defaultProjectRoot,
    traceSink = null
} = {}) {
    const request = normalizeSquadRequest(input, projectRoot);
    const bundle = getSquadBundle(projectRoot, request);
    const result = runAkeSquadScenario(bundle, {
        runner: { traceSink },
        run: {
            commands: request.commands,
            endFrame: request.endFrame
        }
    });
    const timeline = projectAkeTimeline(result);
    const catalogCharacterById = new Map(
        request.catalog.characters.map(character => [character.id, character])
    );
    const catalogWeaponById = new Map(
        request.catalog.weapons.map(weapon => [weapon.id, weapon])
    );
    const catalogEquipmentById = new Map(
        request.catalog.equipment.map(equipment => [equipment.id, equipment])
    );
    const members = bundle.members.map(member => {
        const build = request.members.find(inputMember => inputMember.memberId === member.memberId);
        const character = catalogCharacterById.get(member.characterId);
        const weapon = catalogWeaponById.get(build.weaponId);
        const damage = result.damageSummary.byCharacterId[member.characterId] ?? {};
        const commands = timeline.commands.filter(command => command.memberId === member.memberId);
        const runtimeAttackAttribute = result.attributeSnapshots?.[member.characterId]?.Atk
            ?? null;
        const runtimeAtk = Number(
            runtimeAttackAttribute?.evaluation?.value
                ?? member.parameters.characterAttributes.Atk
                ?? 0
        );
        return {
            memberId: member.memberId,
            characterId: member.characterId,
            name: character?.name ?? member.identity.name,
            iconUrl: character?.iconUrl ?? '',
            identity: structuredClone(member.identity),
            loadout: {
                level: build.level,
                skillLevel: build.skillLevel,
                potentialLevel: build.potentialLevel,
                weaponId: build.weaponId,
                weaponName: weapon?.name ?? build.weaponId,
                weaponLevel: build.weaponLevel,
                weaponPotential: build.weaponPotential,
                weaponSkillLevels: structuredClone(build.weaponSkillLevels),
                equipment: build.equipment.map(selection => {
                    const equipment = catalogEquipmentById.get(selection.equipmentId);
                    return {
                        ...selection,
                        name: equipment?.name ?? selection.equipmentId,
                        partName: equipment?.partName ?? '',
                        iconUrl: equipment?.iconUrl ?? ''
                    };
                })
            },
            profile: {
                // `atk` is retained as the historical runtime baseline field;
                // the explicit names below make it impossible for the UI to
                // mistake it for the rounded operator panel value.
                atk: runtimeAtk,
                runtimeAtk,
                runtimeAttackAttribute: structuredClone(runtimeAttackAttribute),
                maxHp: Number(member.parameters.characterAttributes.MaxHp ?? 0),
                maxUltimateSp: Number(member.ultimateSp.max ?? 0)
            },
            commands,
            summary: {
                ...structuredClone(damage),
                successfulCommands: commands.filter(command => command.success).length,
                failedCommands: commands.filter(command => !command.success).length
            },
            diagnostics: {
                assembler: structuredClone(member.diagnostics),
                compilerUnresolvedCount: bundle.compiler.unresolved.filter(entry =>
                    entry.memberId === member.memberId
                ).length
            }
        };
    });
    return {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        engine: result.engine,
        tickRate: result.tickRate,
        durationFrames: result.durationTicks,
        durationSeconds: result.durationTicks / result.tickRate,
        enemy: structuredClone(request.enemy),
        members,
        commands: structuredClone(timeline.commands),
        attributeSnapshots: structuredClone(result.attributeSnapshots),
        hits: compactSquadHits(result.damageLog),
        timeline,
        summary: {
            ...structuredClone(result.damageSummary),
            dps: result.durationTicks > 0
                ? result.damageSummary.totalDamage / (result.durationTicks / result.tickRate)
                : 0,
            successfulCommands: timeline.commands.filter(command => command.success).length,
            failedCommands: timeline.commands.filter(command => !command.success).length,
            delayedCommands: timeline.commands.filter(command => Number(command.delayFrames) > 0).length
        },
        finalState: {
            sharedAtb: structuredClone(result.finalState.sharedAtb),
            ultimateSpByCharacterId: structuredClone(result.finalState.ultimateSpByCharacterId),
            cooldowns: structuredClone(result.finalState.cooldowns),
            targetHp: result.finalState.targetHp,
            activeStatuses: result.finalState.statuses.map(status => ({
                buffId: status.buffId,
                targetId: status.targetId,
                stackCount: status.stackCount,
                expireFrame: status.expireFrame
            })),
            resilience: structuredClone(result.finalState.resilience),
            poise: structuredClone(result.finalState.poise)
        },
        resourceEvents: meaningfulResourceEvents(result.resourceTrace),
        statusEvents: compactStatusEvents(result.statusTrace, { projectRoot }),
        teamComboLedger: structuredClone(result.teamComboLedger),
        diagnostics: {
            unresolvedEffectCount: result.diagnostics.unresolvedEffectCount,
            compilerUnresolvedEffectCount: bundle.compiler.unresolved.length,
            dependencySummary: structuredClone(bundle.dependencySummary),
            assemblerDiagnostics: structuredClone(bundle.diagnostics)
        }
    };
}
