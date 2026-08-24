import { resolveAssignments, resolveValue } from './ake-parser.mjs';

function compare(left, operator, right) {
    switch (operator) {
        case 'GT': return left > right;
        case 'GE': return left >= right;
        case 'LT': return left < right;
        case 'LE': return left <= right;
        case 'Equals':
        case 'EQ': return left === right;
        case 'NE': return left !== right;
        default: return false;
    }
}

export class BuffMachine {
    constructor({ definitions, schedule, tickRate = 30, skillSettings = {}, targetAttributes = {},
        resourceActionRules = {}, onResourceAction = () => {} }) {
        this.definitions = definitions;
        this.schedule = schedule;
        this.tickRate = tickRate;
        this.skillSettings = skillSettings;
        this.targetAttributes = targetAttributes;
        this.resourceActionRules = resourceActionRules;
        this.onResourceAction = onResourceAction;
        this.instances = [];
        this.trace = [];
        this.nextInstanceId = 1;
    }

    apply({ buffId, frame, sourceSkillId, sourceBlackboard = {}, overrides = {}, target = 'enemy', nested = false }) {
        const definition = this.definitions.get(buffId);
        if (!definition) {
            throw new Error(`Missing parsed BuffData for ${buffId}`);
        }
        const groupKey = definition.stacking.identifierType === 'StackingKey'
            ? (definition.stacking.stackingKey || buffId)
            : buffId;
        const existing = this.instances.find(instance => instance.active
            && instance.target === target
            && instance.groupKey === groupKey);
        const stackingType = definition.stacking.stackingType;

        if (existing && stackingType === 'EnhanceAndRefresh') {
            const previousStackCount = existing.stackCount;
            existing.stackCount = Math.min(definition.stacking.maxStackCount, existing.stackCount + 1);
            existing.generation += 1;
            existing.startFrame = frame;
            existing.expireFrame = this.computeExpireFrame(definition, frame, nested);
            this.scheduleExpiry(existing);
            this.trace.push(this.traceRecord(existing, 'Refreshed', {
                frame,
                previousStackCount
            }));
            return existing;
        }

        if (existing && stackingType === 'Unique') return existing;

        const blackboard = {
            ...definition.blackboard,
            ...sourceBlackboard,
            ...overrides
        };
        const durationSeconds = Number(resolveValue(definition.duration, blackboard, 0));
        const durationTicks = Math.round(durationSeconds * this.tickRate);
        const instance = {
            instanceId: this.nextInstanceId++,
            buffId,
            definition,
            groupKey,
            stackingKey: definition.stacking.stackingKey,
            stackingType,
            target,
            sourceSkillId,
            blackboard,
            startFrame: frame,
            durationSeconds,
            durationTicks,
            expireFrame: this.computeExpireFrame(definition, frame, nested, durationTicks),
            stackCount: 1,
            maxStackCount: definition.stacking.maxStackCount,
            generation: 1,
            active: true,
            nested
        };
        this.instances.push(instance);
        this.scheduleExpiry(instance);
        this.executeActions(definition.startActions, instance, frame);
        // Calc finalizes an outer buff after its OnBuffStart children. Keeping the
        // trace in that order also makes the raw parent -> generated child
        // relationship visible in the exported result.
        this.trace.push(this.traceRecord(instance, 'Started', { frame, previousStackCount: 0 }));
        return instance;
    }

    computeExpireFrame(definition, frame, nested, durationTicksOverride) {
        const durationTicks = durationTicksOverride
            ?? Math.round(Number(resolveValue(definition.duration, definition.blackboard, 0)) * this.tickRate);
        const createsChildOnStart = definition.startActions.some(action => action.type === 'CreateBuffAction');
        const lifecycleOffset = nested || createsChildOnStart ? 1 : 0;
        return frame + durationTicks + lifecycleOffset;
    }

    scheduleExpiry(instance) {
        const generation = instance.generation;
        this.schedule(instance.expireFrame, 90, () => {
            if (!instance.active || instance.generation !== generation) return;
            instance.active = false;
            this.trace.push(this.traceRecord(instance, 'Ended', {
                frame: instance.expireFrame,
                previousStackCount: instance.stackCount,
                stackCount: 0
            }));
        });
    }

    traceRecord(instance, stage, overrides = {}) {
        return {
            frame: overrides.frame ?? instance.startFrame,
            stage,
            buffId: instance.buffId,
            groupKey: instance.groupKey,
            stackingKey: instance.stackingKey,
            stackingType: instance.stackingType,
            target: instance.target,
            sourceSkillId: instance.sourceSkillId,
            stackCount: overrides.stackCount ?? instance.stackCount,
            previousStackCount: overrides.previousStackCount ?? instance.stackCount,
            maxStackCount: instance.maxStackCount,
            durationTicks: stage === 'Started' || stage === 'Refreshed' ? instance.durationTicks : undefined,
            expireFrame: stage === 'Started' || stage === 'Refreshed' ? instance.expireFrame : undefined,
            blackboard: stage === 'Started' ? { ...instance.blackboard } : undefined
        };
    }

    executeActions(actions, instance, frame) {
        for (const action of actions) this.executeAction(action, instance, frame);
    }

    executeAction(action, instance, frame) {
        switch (action.type) {
            case 'IfElseAction': {
                const passed = action.conditions.every(condition => this.evaluateCondition(condition, instance));
                this.executeActions(passed ? action.success : action.failure, instance, frame);
                break;
            }
            case 'ModifyDynamicBlackboard': {
                const value = Number(resolveValue(action.value, instance.blackboard, 0));
                if (action.operation === 'Assign') instance.blackboard[action.key] = value;
                if (action.operation === 'Multiply') {
                    instance.blackboard[action.key] = Number(instance.blackboard[action.key] ?? 0) * value;
                }
                if (action.operation === 'Add') {
                    instance.blackboard[action.key] = Number(instance.blackboard[action.key] ?? 0) + value;
                }
                break;
            }
            case 'ReadSkillSettingData':
                for (const read of action.reads) {
                    const column = Number(resolveValue(read.column, instance.blackboard, 1));
                    const table = this.skillSettings[read.dataKey];
                    const value = typeof table === 'function' ? table(column) : table?.[column];
                    if (value === undefined) {
                        throw new Error(`Missing external SkillSetting value: ${read.dataKey}[${column}]`);
                    }
                    instance.blackboard[read.storeKey] = value;
                }
                break;
            case 'StoreAttributeValue': {
                const attribute = Number(this.targetAttributes[action.attributeType] ?? 0);
                const divisor = Number(resolveValue(action.divisor, instance.blackboard, 1)) || 1;
                const multiplier = Number(resolveValue(action.multiplier, instance.blackboard, 1));
                const baseValue = Number(resolveValue(action.baseValue, instance.blackboard, 0));
                instance.blackboard[action.key] = baseValue + attribute / divisor * multiplier;
                break;
            }
            case 'CreateBuffAction':
                for (const buff of action.buffs) {
                    const overrides = buff.assignBlackboard
                        ? resolveAssignments(buff.assignments, instance.blackboard)
                        : {};
                    this.apply({
                        buffId: buff.buffId,
                        frame,
                        sourceSkillId: instance.sourceSkillId,
                        overrides,
                        target: instance.target,
                        nested: true
                    });
                }
                break;
            case 'ObtainUspInNormalSkill': {
                const rule = this.resourceActionRules[action.type];
                if (!rule) throw new Error(`Missing resource action rule: ${action.type}`);
                const coefficient = Number(resolveValue(action.coefficient, instance.blackboard, 1));
                const everyone = rule.includeEveryone
                    ? Number(instance.blackboard.usp_everyone ?? 0)
                    : 0;
                const self = rule.includeSelf
                    ? Number(instance.blackboard.usp_self ?? 0)
                    : 0;
                const rawAmount = (everyone + self) * coefficient;
                const amount = rule.quantization === 'percentage-float32'
                    ? Math.fround(rawAmount / 100) * 100
                    : rawAmount;
                this.onResourceAction({
                    frame,
                    resourceType: 'UltimateSp',
                    amount,
                    reason: action.type,
                    sourceSkillId: instance.sourceSkillId,
                    target: instance.target
                });
                break;
            }
            default:
                break;
        }
    }

    evaluateCondition(condition, instance) {
        if (condition.type === 'CompareFloat') {
            const left = Number(resolveValue(condition.left, instance.blackboard, 0));
            const right = Number(resolveValue(condition.right, instance.blackboard, 0));
            return compare(left, condition.operator, right);
        }
        return false;
    }

    defenderZoneScale(damageType, frame) {
        const additionsByZone = new Map();
        for (const instance of this.instances) {
            if (!instance.active || instance.startFrame > frame || instance.expireFrame <= frame) continue;
            for (const modifier of instance.definition.damageModifiers) {
                if (modifier.side !== 'Defender') continue;
                if (modifier.damageTypes.length > 0 && !modifier.damageTypes.includes(damageType)) continue;
                for (const processor of modifier.processors) {
                    const addition = Number(resolveValue(processor.addition, instance.blackboard, 0));
                    additionsByZone.set(
                        processor.zoneName,
                        (additionsByZone.get(processor.zoneName) ?? 0) + addition
                    );
                }
            }
        }
        const zones = [...additionsByZone].map(([zoneName, addition]) => ({
            zoneName,
            addition,
            scale: 1 + addition
        }));
        return {
            scale: zones.reduce((product, zone) => product * zone.scale, 1),
            zones
        };
    }
}
