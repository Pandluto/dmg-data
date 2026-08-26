import { cloneValue } from './combat-context.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(label + ' must be a non-empty string or finite number.');
    }
    return value;
}

function blackboardObject(entries = []) {
    return Object.fromEntries(entries.map(entry => [
        entry.key,
        entry.valueStr !== undefined && entry.valueStr !== ''
            ? entry.valueStr
            : (entry.value ?? entry.valueDouble)
    ]));
}

function descriptorValue(descriptor, blackboard, fallback = 0) {
    if (descriptor === undefined || descriptor === null) return fallback;
    if (typeof descriptor === 'number' || typeof descriptor === 'string') return descriptor;
    if (descriptor.useBlackboardKey && descriptor.blackboardKey) {
        return blackboard[descriptor.blackboardKey] ?? descriptor.value ?? fallback;
    }
    return descriptor.value ?? fallback;
}

function buffInput(buff, blackboard, sourcePath) {
    const assignments = buff.assignments ?? buff.assignItems ?? [];
    return {
        buffId: buff.buffId,
        blackboard: Object.fromEntries(assignments.map(item => [
            item.targetKey,
            item.useDirectValue ?? item.direct
                ? (item.directValueType === 'String'
                    ? item.stringValue
                    : (item.numericValue ?? item.directValue))
                : blackboard[item.inputValueKey ?? item.sourceKey]
        ])),
        sourcePath
    };
}

function comparisonOperator(value) {
    const aliases = {
        Equals: 'EQ', Equal: 'EQ', NotEqual: 'NE',
        Greater: 'GT', GreaterOrEqual: 'GE', Less: 'LT', LessOrEqual: 'LE'
    };
    return aliases[value] ?? value ?? 'EQ';
}

function serializedType(value) {
    return String(value?.$type ?? '').split(',')[0].split('+')[0].split('.').at(-1);
}

function inferSourceType(effectId) {
    const value = String(effectId).toLowerCase();
    if (value.includes('potential')) return 'Potential';
    if (value.includes('talent')) return 'Talent';
    if (value.includes('contract')) return 'Contract';
    if (value.includes('equip') || value.includes('weapon')) return 'Equipment';
    return 'Loadout';
}

/**
 * Converts PotentialTalentEffectTable rows into source-scoped runtime inputs.
 * Numeric enum fields are preserved when no explicit mapping was supplied.
 */
export class AkeLoadoutCompiler {
    constructor({ attributeTypeMappings = {}, modifierZoneMappings = {} } = {}) {
        if (!isRecord(attributeTypeMappings) || !isRecord(modifierZoneMappings)) {
            throw new TypeError('Loadout mappings must be objects.');
        }
        this.attributeTypeMappings = cloneValue(attributeTypeMappings);
        this.modifierZoneMappings = cloneValue(modifierZoneMappings);
    }

    compile(effectId, row) {
        identifier(effectId, 'effectId');
        if (!isRecord(row)) throw new TypeError('loadout effect row must be an object.');
        const result = {
            effectId,
            sourceType: inferSourceType(effectId),
            buffs: [],
            skills: [],
            attributeModifiers: [],
            skillBlackboardPatches: [],
            skillParameterPatches: [],
            activeConditions: [],
            toggleEffects: [],
            unresolved: []
        };
        for (const [index, entry] of (row.dataList ?? []).entries()) {
            if (!isRecord(entry)) {
                result.unresolved.push({
                    code: 'AKE_LOADOUT_ENTRY_INVALID',
                    path: 'dataList[' + index + ']'
                });
                continue;
            }
            if (Array.isArray(entry.activeCondition) && entry.activeCondition.length > 0) {
                result.activeConditions.push(cloneValue(entry.activeCondition));
                result.unresolved.push({
                    code: 'AKE_LOADOUT_ACTIVE_CONDITION_REQUIRES_PROVIDER',
                    path: 'dataList[' + index + '].activeCondition',
                    conditions: cloneValue(entry.activeCondition)
                });
            }
            if (entry.attachBuff?.buffId) {
                result.buffs.push({
                    buffId: entry.attachBuff.buffId,
                    blackboard: blackboardObject(entry.attachBuff.blackboard),
                    sourcePath: 'dataList[' + index + '].attachBuff'
                });
            }
            if (entry.attachSkill?.skillId) {
                result.skills.push({
                    skillId: entry.attachSkill.skillId,
                    skillPath: entry.attachSkill.skillPath || null,
                    blackboard: blackboardObject(entry.attachSkill.blackboard),
                    sourcePath: 'dataList[' + index + '].attachSkill'
                });
            }
            const attr = entry.attrModifier;
            if (attr && Number(attr.attrValue) !== 0) {
                const attribute = this.attributeTypeMappings[attr.attrType];
                const zone = this.modifierZoneMappings[attr.modifierType];
                if (attribute && zone) {
                    result.attributeModifiers.push({
                        attribute,
                        zone,
                        value: Number(attr.attrValue),
                        metadata: {
                            rawAttrType: attr.attrType,
                            rawModifierType: attr.modifierType,
                            rawModifyAttributeType: attr.modifyAttributeType
                        }
                    });
                } else {
                    result.unresolved.push({
                        code: 'AKE_LOADOUT_ATTRIBUTE_ENUM_UNMAPPED',
                        path: 'dataList[' + index + '].attrModifier',
                        raw: cloneValue(attr)
                    });
                }
            }
            const bb = entry.skillBbModifier;
            if (bb?.skillId && bb.bbKey) {
                result.skillBlackboardPatches.push({
                    skillId: bb.skillId,
                    key: bb.bbKey,
                    value: bb.stringValue || bb.floatValue,
                    operationCode: bb.modifyType,
                    sourcePath: 'dataList[' + index + '].skillBbModifier'
                });
            }
            const parameter = entry.skillParamModifier;
            if (parameter?.skillId) {
                result.skillParameterPatches.push({
                    skillId: parameter.skillId,
                    parameterTypeCode: parameter.paramType,
                    value: parameter.paramValue,
                    operationCode: parameter.modifyType,
                    sourcePath: 'dataList[' + index + '].skillParamModifier'
                });
            }
        }
        result.status = result.unresolved.length === 0 ? 'executable' : 'partially-unresolved';
        return result;
    }

    compilePassiveSkill(raw, {
        blackboard: blackboardOverrides = {},
        sourceType = 'Equipment'
    } = {}) {
        if (!isRecord(raw) || !raw.skillId) {
            throw new TypeError('compilePassiveSkill requires SkillData with skillId.');
        }
        const blackboard = {
            ...blackboardObject(raw.blackboard),
            ...cloneValue(blackboardOverrides)
        };
        const result = {
            effectId: raw.skillId,
            sourceType,
            blackboard,
            buffs: (raw.buffs ?? []).filter(buff => buff.buffId).map((buff, index) =>
                buffInput(buff, blackboard, `buffs[${index}]`)
            ),
            skills: [],
            attributeModifiers: [],
            skillBlackboardPatches: [],
            skillParameterPatches: [],
            activeConditions: [],
            toggleEffects: [],
            unresolved: []
        };
        for (const [index, modifier] of
            (raw.cardAttributeModifier?.attributeModifiers ?? []).entries()) {
            if (!modifier.attributeType || !modifier.formulaItem) {
                result.unresolved.push({
                    code: 'AKE_PASSIVE_ATTRIBUTE_MODIFIER_INVALID',
                    path: `cardAttributeModifier.attributeModifiers[${index}]`
                });
                continue;
            }
            result.attributeModifiers.push({
                attribute: modifier.attributeType,
                zone: modifier.formulaItem,
                value: Number(descriptorValue(modifier.param, blackboard, 0)),
                metadata: { modifyAttributeType: modifier.modifyAttributeType }
            });
        }
        for (const [toggleIndex, toggle] of (raw.toggleBuffs ?? []).entries()) {
            const conditions = [];
            for (const [conditionIndex, condition] of (toggle.conditions ?? []).entries()) {
                const type = serializedType(condition);
                if (type === 'CheckCurHpRatio') {
                    conditions.push({
                        type: 'HpRatioCompare',
                        target: 'Target',
                        operator: comparisonOperator(condition.compareType),
                        value: descriptorValue(condition.value, blackboard, 0)
                    });
                } else {
                    result.unresolved.push({
                        code: 'AKE_PASSIVE_TOGGLE_CONDITION_UNSUPPORTED',
                        path: `toggleBuffs[${toggleIndex}].conditions[${conditionIndex}]`,
                        sourceType: type || 'Unknown'
                    });
                }
            }
            result.toggleEffects.push({
                id: `${raw.skillId}:toggle:${toggleIndex}`,
                conditions,
                buffs: (toggle.buffs ?? []).filter(buff => buff.buffId).map((buff, buffIndex) =>
                    buffInput(
                        buff,
                        blackboard,
                        `toggleBuffs[${toggleIndex}].buffs[${buffIndex}]`
                    )
                )
            });
        }
        result.status = result.unresolved.length === 0 ? 'executable' : 'partially-unresolved';
        return result;
    }

    compileTable(table, effectIds = Object.keys(table ?? {})) {
        if (!isRecord(table)) throw new TypeError('PotentialTalentEffectTable must be an object.');
        if (!Array.isArray(effectIds)) throw new TypeError('effectIds must be an array.');
        return effectIds.map(effectId => {
            if (!table[effectId]) throw new Error('Unknown loadout effect: ' + effectId + '.');
            return this.compile(effectId, table[effectId]);
        });
    }
}

/**
 * Installs compiled loadout effects and remembers every concrete Buff instance
 * so uninstall is exact even when multiple sources attach the same Buff id.
 */
export class LoadoutEffectManager {
    constructor({ runtime } = {}) {
        if (!runtime?.statusEffects || !runtime?.effectSources) {
            throw new TypeError('LoadoutEffectManager requires a CombatRuntime.');
        }
        this.runtime = runtime;
        this.installations = new Map();
        this.trace = [];
    }

    install(effect, {
        frame = 0,
        ownerId,
        targetId = ownerId,
        sourceId = ownerId,
        clockDomainId = 'global'
    } = {}) {
        if (!isRecord(effect)) throw new TypeError('compiled loadout effect must be an object.');
        identifier(effect.effectId, 'effect.effectId');
        identifier(ownerId, 'ownerId');
        identifier(targetId, 'targetId');
        identifier(sourceId, 'sourceId');
        const key = effect.sourceType + ':' + effect.effectId + ':' + String(ownerId);
        if (this.installations.has(key)) throw new Error('Loadout effect is already installed: ' + key + '.');
        const context = {
            frame,
            eventType: 'LoadoutInstalled',
            sourceId,
            ownerId,
            targetId,
            clockDomainId,
            blackboard: cloneValue(effect.blackboard ?? {}),
            payload: { effectId: effect.effectId, sourceType: effect.sourceType }
        };
        const buffInstances = (effect.buffs ?? []).map(buff => this.runtime.execute({
            type: 'ApplyBuff',
            buffId: buff.buffId,
            blackboard: buff.blackboard,
            metadata: {
                loadoutSourceKey: key,
                effectId: effect.effectId,
                sourceType: effect.sourceType
            }
        }, context));
        let directSource = null;
        if ((effect.attributeModifiers ?? []).length > 0) {
            directSource = this.runtime.effectSources.apply({
                frame,
                sourceKey: key,
                sourceType: effect.sourceType,
                sourceId,
                ownerId,
                targetId,
                modifiers: effect.attributeModifiers,
                metadata: { effectId: effect.effectId }
            }, context);
        }
        const installation = {
            key,
            effect: cloneValue(effect),
            frame,
            sourceId,
            ownerId,
            targetId,
            clockDomainId,
            buffInstanceIds: buffInstances.map(instance => instance.instanceId),
            toggleStates: (effect.toggleEffects ?? []).map(toggle => ({
                id: toggle.id,
                active: false,
                buffInstanceIds: []
            })),
            directSourceApplied: directSource !== null,
            active: true
        };
        this.runtime.installSkillLoadoutPatches({
            sourceKey: key,
            ownerId,
            blackboardPatches: effect.skillBlackboardPatches ?? [],
            parameterPatches: effect.skillParameterPatches ?? []
        });
        this.installations.set(key, installation);
        this.trace.push({
            frame,
            stage: 'LoadoutEffectInstalled',
            key,
            effectId: effect.effectId,
            sourceType: effect.sourceType,
            sourceId,
            ownerId,
            targetId,
            buffInstanceIds: cloneValue(installation.buffInstanceIds)
        });
        this.refresh(key, frame);
        return cloneValue(installation);
    }

    refresh(key, frame = 0) {
        const installation = this.installations.get(key);
        if (!installation || !installation.active) {
            return { key, refreshed: false, transitions: [] };
        }
        const activeIds = new Set(this.runtime.statusEffects.list({ active: true })
            .map(instance => instance.instanceId));
        const context = {
            frame,
            eventType: 'LoadoutRefreshed',
            sourceId: installation.sourceId,
            ownerId: installation.ownerId,
            targetId: installation.targetId,
            clockDomainId: installation.clockDomainId,
            blackboard: cloneValue(installation.effect.blackboard ?? {}),
            payload: {
                effectId: installation.effect.effectId,
                sourceType: installation.effect.sourceType
            }
        };
        const transitions = [];
        for (const [index, toggle] of (installation.effect.toggleEffects ?? []).entries()) {
            const state = installation.toggleStates[index];
            state.active = state.active
                && state.buffInstanceIds.some(instanceId => activeIds.has(instanceId));
            const passed = (toggle.conditions ?? []).length === 0
                || this.runtime.effects.evaluate({
                    type: 'All',
                    conditions: toggle.conditions
                }, context);
            if (passed && !state.active) {
                const instances = (toggle.buffs ?? []).map(buff => this.runtime.execute({
                    type: 'ApplyBuff',
                    buffId: buff.buffId,
                    blackboard: buff.blackboard,
                    metadata: {
                        loadoutSourceKey: key,
                        loadoutToggleId: toggle.id,
                        effectId: installation.effect.effectId,
                        sourceType: installation.effect.sourceType
                    }
                }, context));
                state.active = true;
                state.buffInstanceIds = instances.map(instance => instance.instanceId);
                transitions.push({ toggleId: toggle.id, from: false, to: true });
            } else if (!passed && state.active) {
                this.runtime.statusEffects.finish({
                    frame,
                    metadata: {
                        loadoutSourceKey: key,
                        loadoutToggleId: toggle.id
                    },
                    reason: 'LoadoutToggleDisabled'
                }, context);
                state.active = false;
                state.buffInstanceIds = [];
                transitions.push({ toggleId: toggle.id, from: true, to: false });
            }
        }
        this.trace.push({
            frame,
            stage: 'LoadoutEffectRefreshed',
            key,
            effectId: installation.effect.effectId,
            targetId: installation.targetId,
            transitions: cloneValue(transitions)
        });
        return { key, refreshed: true, transitions };
    }

    uninstall(key, frame = 0) {
        const installation = this.installations.get(key);
        if (!installation || !installation.active) {
            return { key, removed: false, buffInstances: [], effectSources: [] };
        }
        const buffInstances = installation.buffInstanceIds.flatMap(instanceId =>
            this.runtime.statusEffects.finish({
                frame,
                instanceId,
                reason: 'LoadoutUninstalled'
            })
        );
        buffInstances.push(...this.runtime.statusEffects.finish({
            frame,
            metadata: { loadoutSourceKey: key },
            reason: 'LoadoutDerivedEffectRemoved'
        }));
        const effectSources = installation.directSourceApplied
            ? this.runtime.effectSources.remove({
                frame,
                sourceKey: key,
                reason: 'LoadoutUninstalled'
            }).removed
            : [];
        this.runtime.removeSkillLoadoutPatches(key);
        installation.active = false;
        for (const state of installation.toggleStates ?? []) {
            state.active = false;
            state.buffInstanceIds = [];
        }
        this.trace.push({
            frame,
            stage: 'LoadoutEffectUninstalled',
            key,
            effectId: installation.effect.effectId,
            sourceType: installation.effect.sourceType,
            sourceId: installation.sourceId,
            ownerId: installation.ownerId,
            targetId: installation.targetId,
            removedBuffInstances: buffInstances.length,
            removedEffectSources: effectSources.length
        });
        return {
            key,
            removed: true,
            buffInstances,
            effectSources
        };
    }

    snapshot() {
        return {
            installations: [...this.installations.values()].map(cloneValue),
            trace: this.trace.map(cloneValue)
        };
    }
}

export default AkeLoadoutCompiler;
