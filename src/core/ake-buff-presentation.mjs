const PRESENTATION_OVERRIDES = Object.freeze({
    buff_physical_no_guard: {
        displayName: '破防', shortName: '破', applicationScope: 'enemy',
        iconId: 'icon_shadow_attribute_penetrate'
    },
    buff_physical_no_guard_fake: {
        displayName: '破防结算标记', shortName: '破', applicationScope: 'system', hidden: true
    },
    buff_physical_handle_cryst_break: {
        displayName: '结晶击碎监听', shortName: '晶', applicationScope: 'system', hidden: true
    },
    buff_physical_fracture: {
        displayName: '碎甲', shortName: '碎', applicationScope: 'enemy',
        iconId: 'icon_battle_fracture'
    },
    buff_physical_do_fracture: {
        displayName: '碎甲触发', shortName: '碎', applicationScope: 'system',
        iconId: 'icon_battle_fracture', hidden: true
    },
    buff_physical_crushed: {
        displayName: '猛击', shortName: '猛', applicationScope: 'enemy', iconId: 'knockback'
    },
    buff_physical_airborne: {
        displayName: '击飞', shortName: '飞', applicationScope: 'enemy', iconId: 'airborne'
    },
    buff_physical_knockdown: {
        displayName: '倒地', shortName: '倒', applicationScope: 'enemy', iconId: 'knockdown'
    },
    buff_common_originum_frozen: {
        displayName: '源石结晶', shortName: '晶', applicationScope: 'enemy',
        iconId: 'icon_skill_endmin_debuff'
    },
    buff_common_enemy_spell_status_conduct: {
        displayName: '导电', shortName: '导', applicationScope: 'enemy',
        iconId: 'icon_battle_conduct'
    },
    buff_common_enemy_spell_status_frozen: {
        displayName: '冻结', shortName: '冻', applicationScope: 'enemy',
        iconId: 'icon_battle_frozen'
    },
    buff_common_enemy_spell_status_burning: {
        displayName: '燃烧', shortName: '燃', applicationScope: 'enemy',
        iconId: 'icon_battle_burning'
    },
    buff_common_enemy_spell_status_corrupt: {
        displayName: '腐蚀', shortName: '蚀', applicationScope: 'enemy',
        iconId: 'icon_battle_corrupt'
    },
    buff_common_poise_can_be_breaking_attacked: {
        displayName: '失衡', shortName: '衡', applicationScope: 'enemy'
    },
    buff_common_poise_break_damage_taken_scale: {
        displayName: '失衡易伤', shortName: '易', applicationScope: 'enemy'
    },
    buff_common_obtain_ultimate_sp: {
        displayName: '终结技能量恢复', shortName: '能', applicationScope: 'system', hidden: true
    },
    buff_common_damage_immune_ult_skill: {
        displayName: '终结技期间伤害免疫', shortName: '免', applicationScope: 'self', hidden: true
    },
    buff_common_affixes_combo_trigger: {
        displayName: '连击', shortName: '连', applicationScope: 'team'
    },
    buff_common_affixes_skillimbue: {
        displayName: '连击增幅（本次技能）', shortName: '连', applicationScope: 'self', hidden: true
    },
    buff_common_affixes_skillimbue_atk: {
        displayName: '连击伤害增幅', shortName: '连', applicationScope: 'self', hidden: true
    }
});

const REACTION_PRESENTATION = Object.freeze({
    fire: {
        displayName: '燃烧', shortName: '燃', applicationScope: 'enemy',
        effectType: 'elementalAbnormal', iconId: 'icon_battle_burning'
    },
    pulse: {
        displayName: '导电', shortName: '导', applicationScope: 'enemy',
        effectType: 'elementalAbnormal', iconId: 'icon_battle_conduct'
    },
    natural: {
        displayName: '腐蚀', shortName: '蚀', applicationScope: 'enemy',
        effectType: 'elementalAbnormal', iconId: 'icon_battle_corrupt'
    },
    cryst: {
        displayName: '冻结', shortName: '冻', applicationScope: 'enemy',
        effectType: 'elementalAbnormal', iconId: 'icon_battle_frozen'
    }
});

function structuralPresentationOverride(buffId) {
    const normalized = String(buffId ?? '').toLowerCase();
    if (/(?:^|_)tut(?:orial)?(?:_|$)|_failure$/.test(normalized)) {
        return {
            displayName: '内部条件标记', shortName: '内',
            applicationScope: 'system', hidden: true
        };
    }
    if (/_smarttarget$/.test(normalized)) {
        return {
            displayName: '智能索敌状态', shortName: '索',
            applicationScope: 'system', hidden: true
        };
    }
    if (/_timer$/.test(normalized)) {
        return {
            displayName: '技能计时状态', shortName: '时',
            applicationScope: 'system', hidden: true
        };
    }
    if (/^buff_common_try_(?:fire|pulse|natural|cryst)_(?:fire|pulse|natural|cryst)_triggered$/.test(normalized)
        || /_(?:triggered_start|triggered_fx|triggered_wrapper)$/.test(normalized)) {
        return {
            displayName: '元素异常内部事件', shortName: '异',
            applicationScope: 'system', hidden: true
        };
    }

    const explicit = /^buff_common_(fire|pulse|natural|cryst)_\1_(burning|conduct|corrupt|frozen)_triggered$/.exec(normalized);
    if (explicit) return REACTION_PRESENTATION[explicit[1]] ?? null;

    const crossed = /^buff_common_(fire|pulse|natural|cryst)_(fire|pulse|natural|cryst)_triggered$/.exec(normalized);
    if (crossed && crossed[1] !== crossed[2]) {
        return REACTION_PRESENTATION[crossed[1]] ?? null;
    }
    if (normalized === 'buff_common_burning_status') return REACTION_PRESENTATION.fire;
    return null;
}

const TOKEN_LABELS = Object.freeze({
    talent: '天赋', potential: '潜能', weapon: '武器', equip: '装备', equipsuit: '套装',
    normal: '战技', combo: '连携技', ultimate: '终结技', attack: '攻击',
    atk: '攻击力', def: '防御力', damage: '伤害', dmg: '伤害', immune: '免疫',
    physical: '物理', fire: '灼热', pulse: '电磁', cryst: '寒冷', natural: '自然',
    vulnerable: '易伤', fragile: '易伤', heal: '治疗', shield: '护盾', speed: '速度',
    up: '提升', down: '降低', stack: '叠层', status: '状态', skill: '技能'
});

const COMPOUND_TOKEN_LABELS = Object.freeze({
    atkup: '攻击力提升', atkdown: '攻击力降低',
    defup: '防御力提升', defdown: '防御力降低',
    dmgup: '伤害提升', dmgdown: '伤害降低',
    normalskill: '战技', comboskill: '连携技', ultimateskill: '终结技'
});

const IGNORED_TOKENS = new Set([
    'buff', 'chr', 'common', 'enemy', 'self', 'aura', 'instance', 'trigger', 'tirgger',
    'triggered', 'listener', 'passive', 'handle', 'do', 'effect', 'event'
]);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || /^buff_|^chr_|^wpn_|^equip_/i.test(name)) return '';
    return name;
}

function aliasesFor(buffId) {
    const aliases = new Set([buffId]);
    let current = buffId;
    for (let index = 0; index < 3; index += 1) {
        const stripped = current
            .replace(/_(?:aura|instance|trigger|tirgger|triggered|listener)$/, '')
            .replace(/(_(?:talent|potential)_\d+)_\d+$/, '$1');
        if (stripped === current) break;
        aliases.add(stripped);
        current = stripped;
    }
    return [...aliases];
}

function semanticFallback(buffId, sourceSkillName = '') {
    const translated = String(buffId)
        .toLowerCase()
        .split('_')
        .filter(token => token && !/^\d+$/.test(token) && !IGNORED_TOKENS.has(token))
        .flatMap(token => {
            const label = TOKEN_LABELS[token] ?? COMPOUND_TOKEN_LABELS[token];
            return label ? [label] : [];
        })
        .filter((token, index, all) => all.indexOf(token) === index);
    if (translated.length > 0) return translated.join('·');
    return sourceSkillName ? `${sourceSkillName}·技能状态` : '未命名状态';
}

/**
 * Builds a single catalog-wide Buff identity index. Entries carry their real
 * effect type and application scope so the UI does not infer behavior from a
 * character name or from an English Buff id.
 */
export function buildAkeBuffPresentationIndex(catalog) {
    const entries = new Map();
    const skillNames = new Map();
    const visited = new WeakSet();
    const register = (buffId, presentation, priority) => {
        if (typeof buffId !== 'string' || !buffId.startsWith('buff_')) return;
        for (const alias of aliasesFor(buffId)) {
            const existing = entries.get(alias);
            if (!existing || priority > existing.priority) {
                entries.set(alias, { ...presentation, buffId: alias, priority });
            }
        }
    };
    for (const character of catalog?.characters ?? []) {
        for (const skill of character?.skills ?? []) {
            const skillName = cleanName(skill?.name);
            for (const skillId of skill?.skillIds ?? []) {
                if (typeof skillId === 'string' && skillName) skillNames.set(skillId, skillName);
            }
        }
    }
    const walk = (value, inherited = {}) => {
        if (Array.isArray(value)) {
            value.forEach(item => walk(item, inherited));
            return;
        }
        if (!isRecord(value) || visited.has(value)) return;
        visited.add(value);
        const ownName = cleanName(value.displayName) || cleanName(value.name);
        const presentation = {
            displayName: ownName || inherited.displayName || '',
            shortName: '',
            effectType: typeof value.type === 'string' ? value.type : inherited.effectType ?? null,
            applicationScope: typeof value.applicationScope === 'string'
                ? value.applicationScope
                : inherited.applicationScope ?? null,
            description: cleanName(value.description) || inherited.description || '',
            source: 'catalog'
        };
        const priority = ownName ? 80 : presentation.displayName ? 60 : 20;
        for (const buffId of [value.sourceBuffId, value.buffId, value.id]) {
            if (presentation.displayName) register(buffId, presentation, priority);
        }
        Object.values(value).forEach(child => walk(child, presentation));
    };
    walk(catalog, {});
    for (const [buffId, override] of Object.entries(PRESENTATION_OVERRIDES)) {
        register(buffId, { ...override, source: 'semantic-override' }, 1000);
    }
    return { entries, skillNames };
}

export function resolveAkeBuffPresentation({
    buffId,
    sourceSkillId = null,
    index,
    rawPresentation = null,
    dataOrigin = ''
}) {
    const catalog = index?.entries?.get(buffId) ?? null;
    const override = PRESENTATION_OVERRIDES[buffId]
        ?? structuralPresentationOverride(buffId)
        ?? null;
    const sourceSkillName = sourceSkillId ? index?.skillNames?.get(sourceSkillId) ?? '' : '';
    const displayName = override?.displayName
        || catalog?.displayName
        || semanticFallback(buffId, sourceSkillName);
    const iconId = override?.iconId || rawPresentation?.iconId || '';
    const normalizedOrigin = String(dataOrigin).replace(/\/+$/, '');
    const iconUrl = iconId
        ? rawPresentation?.iconId === iconId && rawPresentation?.iconUrl
            ? rawPresentation.iconUrl
            : `${normalizedOrigin}/public/images/assets/beyond/dynamicassets/gameplay/ui/sprites/bufficon/${iconId}.png`
        : '';
    return {
        buffId,
        displayName,
        shortName: override?.shortName || catalog?.shortName || displayName.slice(0, 1),
        effectType: override?.effectType ?? catalog?.effectType ?? null,
        applicationScope: override?.applicationScope ?? catalog?.applicationScope ?? null,
        description: catalog?.description ?? '',
        iconId,
        iconUrl,
        displayable: iconId.length > 0,
        displayChannels: rawPresentation?.displayChannels ?? [],
        abnormalColorType: rawPresentation?.abnormalColorType ?? null,
        hidden: override?.hidden === true,
        presentationSource: override ? 'semantic-override' : catalog ? 'catalog' : 'semantic-fallback'
    };
}

export { PRESENTATION_OVERRIDES as AKE_BUFF_PRESENTATION_OVERRIDES };
