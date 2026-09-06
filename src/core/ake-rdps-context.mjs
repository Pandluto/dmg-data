import { calculateDamage } from './damage.mjs';
import { evaluateAttributeComponent } from './attribute.mjs';

export const AKE_RDPS_POLICY = 'ake-rdps-v1-def-v3-frozen-hit-inputs';
const MULTIPLY_FIELDS = new Set(['baseFinalMultiplier', 'finalMultiplier']);
const ATTRIBUTE_INPUTS = {
    attack: 'attackAttribute', defense: 'defenseAttribute', resistance: 'resistanceAttribute',
    damageTakenScalar: 'damageTakenAttribute', vulnerableDmgIncrease: 'vulnerableAttribute',
    weaknessDmgScalar: 'weaknessAttribute', shelterDmgScalar: 'shelterAttribute',
    criticalRate: 'criticalRateAttribute', criticalDamageIncrease: 'criticalDamageAttribute'
};
const isImbalance = source => source.metadata?.rdpsExcludedReason === 'imbalance'
    || source.sourceMetadata?.rdpsExcludedReason === 'imbalance' || /PoiseBreak|DamageToBrokenUnitIncrease|imbalanceDmgBonus|targetImbalanced|IsPoiseZero/i
    .test(JSON.stringify([source.attribute, source.zoneName, source.buffId, source.conditions, source.metadata?.effectType]));
const staticPanel = source => source.baseline === true
    && ['Weapon', 'Equipment', 'DerivedAbility', 'Attribute', 'ConfiguredAttribute', 'Panel', 'Character'].includes(source.sourceType)
    && !source.sourceMetadata?.loadoutSourceKey;

/** Frozen realized hits, not a rescheduled combat simulation. No storage or runtime mutation. */
export function buildAkeRdpsContext({ hits, characters, enemyId, statusEvents = [] }) {
    const damageHits = hits.filter(hit => hit.damageAttributeType === 'Hp' && hit.targetId === enemyId);
    if (damageHits.some(hit => hit.modifierSnapshot?.rdpsInputs?.version !== 1)) {
        throw new Error('这份旧结算缺少 RD 输入快照，请重新计算当前排轴。');
    }
    const members = new Map();
    for (const character of characters) {
        for (const id of [character.localCharacterId, character.akeCharacterId, character.memberId]) if (id) members.set(id, character.localCharacterId);
    }
    const statuses = new Map(statusEvents.filter(event => event.instanceId).map(event => [event.instanceId, event]));
    const applications = new Map();
    const unknown = new Set();
    const excluded = new Set();
    const ledger = new Map();
    const describe = source => {
        const status = statuses.get(source.buffInstanceId ?? source.sourceBuffInstanceId);
        const metadata = { ...status?.sourceMetadata, ...source.metadata, ...source.sourceMetadata };
        const id = source.contributionId ?? source.sourceKey ?? source.instanceId ?? source.buffId ?? 'unresolved';
        if (isImbalance(source)) { excluded.add(id); return { kind: 'imbalance', id }; }
        if (staticPanel(source)) return { kind: 'static', id };
        const type = metadata.sourceType ?? source.sourceType ?? source.sourceCategory ?? '';
        const loadoutOwner = metadata.loadoutSourceKey?.split(':').at(-1);
        const characterId = members.get(loadoutOwner) ?? members.get(metadata.teamComboSourceId)
            ?? members.get(source.sourceId) ?? members.get(status?.sourceId);
        const domain = /Weapon/i.test(type) || source.sourceCategory === 'Weapon' ? 'weapon'
            : /Equipment|Suit/i.test(type) || /Equipment/.test(source.sourceCategory ?? '') ? 'equipment' : 'operator';
        const key = characterId ? `${characterId}::${domain}` : null;
        if (!key) unknown.add(id);
        else applications.set(id, { applicationKey: id, sourceKey: key, characterId, domain });
        ledger.set(id, { id, key, characterId, domain, sourceId: source.sourceId ?? null,
            buffId: source.buffId ?? null, sourceType: type, teamComboGrantId: metadata.teamComboGrantId ?? null });
        return { kind: key ? 'source' : 'unknown', key, id };
    };
    const enabled = (source, filter) => source.kind === 'static' || (source.kind === 'imbalance' ? filter.imbalance
        : source.kind === 'unknown' ? filter.unknown : filter.keys === null || filter.keys.has(source.key));
    const attribute = (snapshot, fallback) => {
        if (!snapshot) return () => fallback;
        const base = { ...snapshot.baseComponent };
        const modifiers = (snapshot.contributions ?? []).map(source => {
            const origin = describe(source);
            const field = source.zone[0].toLowerCase() + source.zone.slice(1);
            const value = Number(source.resolvedValue);
            if (!Number.isFinite(value)) throw new Error(`RD 属性输入不是有限值：${source.contributionId}`);
            if (source.baseline && origin.kind !== 'static') {
                if (MULTIPLY_FIELDS.has(field)) {
                    if (value === 0) throw new Error(`RD 无法还原零乘数的预计算面板：${source.contributionId}`);
                    base[field] /= value;
                } else base[field] -= value;
            }
            return { origin, field, value, baseline: source.baseline };
        });
        return filter => {
            const component = { ...base };
            for (const modifier of modifiers) {
                if (modifier.baseline && modifier.origin.kind === 'static') continue;
                if (!enabled(modifier.origin, filter)) continue;
                if (MULTIPLY_FIELDS.has(modifier.field)) component[modifier.field] *= modifier.value;
                else component[modifier.field] += modifier.value;
            }
            return evaluateAttributeComponent(component).value;
        };
    };
    const zone = snapshot => {
        const sources = (snapshot?.contributions ?? []).filter(source => source.contributesToZone !== false)
            .map(source => ({ origin: describe(source), zone: source.zoneName, addition: Number(source.addition) }));
        // A system zone can exist without an attributable source. Keep it explicit.
        for (const item of snapshot?.zones ?? []) {
            const remainder = item.addition - sources.filter(source => source.zone === item.zoneName).reduce((sum, source) => sum + source.addition, 0);
            if (Math.abs(remainder) > 1e-10) sources.push({ origin: describe({ ...item, sourceKey: `zone:${item.zoneName}` }), zone: item.zoneName, addition: remainder });
        }
        return (filter, normalAddition = 0) => {
            const additions = new Map([['NormalCalcZone', normalAddition]]);
            for (const source of sources) if (enabled(source.origin, filter)) additions.set(source.zone, (additions.get(source.zone) ?? 0) + source.addition);
            return [...additions.values()].reduce((scale, addition) => scale * (1 + addition), 1);
        };
    };
    const resolved = damageHits.map(hit => {
        const snapshot = hit.modifierSnapshot;
        const inputs = snapshot.rdpsInputs;
        const attributes = Object.entries(ATTRIBUTE_INPUTS).map(([operand, name]) => [operand, attribute(snapshot[name], hit.operands[operand])]);
        const attackerAttributes = inputs.attackerAttributes.map(entry => attribute(entry.snapshot, entry.value));
        const configuredAttributes = inputs.configuredAttributes.map(entry => attribute(entry.snapshot, entry.value));
        const attackerZone = zone(inputs.registeredAttackerZone);
        const defenderZone = zone(snapshot.defenderZone);
        const special = attribute(inputs.specialAttribute, hit.operands.specialScale);
        // Buff-generated damage is gated at its generator, before any hit evaluation.
        const statusId = hit.sourceBuffInstanceId ?? hit.buffInstanceId;
        const generator = hit.sourceBuffId ? describe({ ...statuses.get(statusId),
            instanceId: statusId, buffId: hit.sourceBuffId, sourceId: statuses.get(statusId)?.sourceId ?? hit.sourceId }) : null;
        const owner = members.get(hit.memberId) ?? members.get(hit.characterId) ?? members.get(hit.sourceId);
        return { hit, owner, evaluate(filter) {
            if (generator && !enabled(generator, filter)) return 0;
            const operands = { ...hit.operands, criticalMode: 'Expect' };
            for (const [key, evaluate] of attributes) operands[key] = evaluate(filter);
            operands.attackerZoneScale = attackerZone(filter, attackerAttributes.reduce((sum, evaluate) => sum + evaluate(filter), 0));
            operands.defenderZoneScale = defenderZone(filter);
            operands.configuredDamageBonusScale = Math.max(0, 1 + configuredAttributes.reduce((sum, evaluate) => sum + evaluate(filter), 0));
            operands.specialScale = special(filter);
            return calculateDamage(operands).expectedDamage;
        } };
    });
    const actualTotal = damageHits.reduce((sum, hit) => sum + hit.expectedDamage, 0);
    const full = { keys: null, unknown: true, imbalance: true };
    const empty = { keys: new Set(), unknown: false, imbalance: false };
    const directDamageByCharacter = new Map();
    let reconstructedTotal = 0;
    let maximumHitError = 0;
    for (const item of resolved) {
        const reconstructed = item.evaluate(full);
        if (!Number.isFinite(reconstructed) || !Number.isFinite(item.hit.expectedDamage)) {
            throw new Error(`RD 命中含非有限伤害值：${item.hit.hitId ?? item.hit.sourceId}`);
        }
        maximumHitError = Math.max(maximumHitError, Math.abs(reconstructed - item.hit.expectedDamage));
        reconstructedTotal += reconstructed;
        if (item.owner) directDamageByCharacter.set(item.owner, (directDamageByCharacter.get(item.owner) ?? 0) + item.evaluate(empty));
    }
    if (maximumHitError > Math.max(1e-7, actualTotal * 1e-10)) {
        throw new Error(`RD 输入重算与原命中不一致（最大误差 ${maximumHitError}），归因已停止。`);
    }
    const evaluateTotal = keys => resolved.reduce((sum, item) => sum + item.evaluate({ keys, unknown: true, imbalance: false }), 0);
    const allKeys = new Set([...applications.values()].map(application => application.sourceKey));
    const world = evaluateTotal(allKeys);
    const baseline = evaluateTotal(new Set());
    const direct = [...directDamageByCharacter.values()].reduce((a, b) => a + b, 0);
    return {
        applications: [...applications.values()], actualTotal, directDamageByCharacter, evaluateTotal,
        excludedImbalanceEffectCount: excluded.size,
        audit: { inputVersion: 1, hitCount: resolved.length, excludedHitCount: hits.length - resolved.length,
            reconstructedTotal, reconstructionError: Math.abs(reconstructedTotal - actualTotal), maximumHitError,
            excludedImbalanceDamage: actualTotal - world, unresolvedBaselineDamage: baseline - direct,
            unresolvedApplicationCount: unknown.size, unresolvedSourceIds: [...unknown], sourceLedger: [...ledger.values()] }
    };
}
