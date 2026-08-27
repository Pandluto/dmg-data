import { cloneValue } from './combat-context.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
    return number;
}

function nonNegative(value, label) {
    const number = finite(value, label);
    if (number < 0) throw new RangeError(`${label} must be non-negative.`);
    return number;
}

function nonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return number;
}

function identifier(value, label, { allowNull = false } = {}) {
    if (allowNull && (value === null || value === undefined)) return null;
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.trim().length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function definitionsArray(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return [...value.values()];
    if (isRecord(value)) return Object.values(value);
    throw new TypeError('skill cooldown definitions must be an array, Map or object.');
}

function normalizedSkillTypes(value) {
    const source = Array.isArray(value) ? value : [value];
    return [...new Set(source.flatMap(entry => String(entry ?? '')
        .split(/[|,]/g)
        .map(type => type.trim())
        .filter(type => type.length > 0 && type !== 'None')))];
}

function skillKey(actorId, skillId) {
    return JSON.stringify([actorId, skillId]);
}

function groupKey(actorId, groupId) {
    return JSON.stringify([actorId, groupId]);
}

/**
 * Shared AKE skill-cooldown state.
 *
 * Cooldowns are owned by a character skill group rather than a rendered
 * button.  Alternate and enhanced skill ids therefore read and mutate the
 * same state, while explicit skill-id selectors still resolve through the
 * public AKE catalog.  The class contains no operator-specific branches.
 */
export class SkillCooldownSystem {
    constructor({ tickRate = 30, skills = [] } = {}) {
        this.tickRate = finite(tickRate, 'tickRate');
        if (this.tickRate <= 0) throw new RangeError('tickRate must be positive.');
        this.skills = new Map();
        this.groups = new Map();
        this.states = new Map();
        this.intervalRecords = [];
        this.trace = [];
        this.nextSequence = 1;
        for (const definition of definitionsArray(skills)) this.registerSkill(definition);
    }

    registerSkill(definition = {}) {
        if (!isRecord(definition)) throw new TypeError('skill definition must be an object.');
        const actorId = identifier(definition.actorId ?? definition.ownerId, 'skill actorId');
        const skillId = identifier(definition.skillId ?? definition.id, 'skillId');
        const skillType = identifier(
            definition.skillType ?? definition.commandType,
            'skillType',
            { allowNull: true }
        );
        const groupId = identifier(
            definition.groupId ?? definition.cooldownGroupId ?? skillId,
            'cooldown groupId'
        );
        const baseDurationTicks = nonNegativeInteger(
            definition.baseDurationTicks
                ?? definition.cooldownTicks
                ?? Math.round(nonNegative(
                    definition.baseDurationSeconds ?? definition.cooldownSeconds ?? 0,
                    'base cooldown seconds'
                ) * this.tickRate),
            'baseDurationTicks'
        );
        const key = skillKey(actorId, skillId);
        const previous = this.skills.get(key);
        const normalized = {
            actorId,
            skillId,
            skillType,
            groupId,
            baseDurationTicks,
            metadata: cloneValue(definition.metadata ?? {})
        };
        if (previous) {
            if (previous.groupId !== groupId || previous.skillType !== skillType) {
                throw new Error(
                    `Conflicting cooldown definition for ${String(actorId)}:${String(skillId)}.`
                );
            }
            // Runtime-resolved loadout patches may supply a more recent base
            // duration without changing the public group identity.
            previous.baseDurationTicks = baseDurationTicks;
            previous.metadata = cloneValue(normalized.metadata);
            this.#refreshGroup(previous);
            return cloneValue(previous);
        }
        this.skills.set(key, normalized);
        this.#refreshGroup(normalized);
        return cloneValue(normalized);
    }

    hasSkill(actorId, skillId) {
        return this.skills.has(skillKey(actorId, skillId));
    }

    definition(actorId, skillId) {
        const value = this.skills.get(skillKey(actorId, skillId));
        return value ? cloneValue(value) : null;
    }

    start(input = {}, eventContext = {}) {
        if (!isRecord(input)) throw new TypeError('cooldown start requires an object.');
        const frame = nonNegativeInteger(
            input.frame ?? eventContext.frame ?? 0,
            'cooldown start frame'
        );
        const actorId = identifier(
            input.actorId ?? input.ownerId ?? eventContext.ownerId ?? eventContext.sourceId,
            'cooldown actorId'
        );
        const skillId = identifier(input.skillId ?? eventContext.skillId, 'cooldown skillId');
        let definition = this.skills.get(skillKey(actorId, skillId));
        if (!definition) {
            definition = this.registerSkill({
                actorId,
                skillId,
                skillType: input.skillType ?? eventContext.skillType ?? null,
                groupId: input.groupId ?? skillId,
                baseDurationTicks: input.durationTicks ?? input.cooldownTicks ?? 0
            });
            definition = this.skills.get(skillKey(actorId, skillId));
        }
        const durationTicks = nonNegativeInteger(
            input.durationTicks ?? input.cooldownTicks ?? definition.baseDurationTicks,
            'cooldown durationTicks'
        );
        if (durationTicks === 0) {
            const record = this.#record({
                frame,
                stage: 'CooldownStartIgnored',
                actorId,
                skillId,
                skillType: definition.skillType,
                groupId: definition.groupId,
                reason: input.reason ?? 'ZeroDuration'
            });
            return { status: 'Ignored', reason: 'ZeroDuration', trace: cloneValue(record) };
        }
        // The cast-time value is authoritative after static loadout patches.
        definition.baseDurationTicks = durationTicks;
        this.#refreshGroup(definition);
        const key = groupKey(actorId, definition.groupId);
        const previous = this.states.get(key) ?? null;
        if (previous && previous.endFrame > frame) {
            const previousEndFrame = previous.endFrame;
            this.#setStateEnd(previous, frame);
            this.#record({
                frame,
                stage: 'CooldownReplaced',
                actorId,
                skillId: previous.skillId,
                skillType: previous.skillType,
                groupId: previous.groupId,
                beforeEndFrame: previousEndFrame,
                afterEndFrame: frame,
                reason: input.reason ?? 'CooldownRestarted'
            });
        }
        const state = this.#createState({
            frame,
            actorId,
            skillId,
            skillType: definition.skillType,
            groupId: definition.groupId,
            baseDurationTicks: durationTicks,
            endFrame: frame + durationTicks,
            stage: 'Started',
            memberId: input.memberId ?? eventContext.memberId ?? null,
            commandId: input.commandId ?? eventContext.commandId ?? null,
            castId: input.castId ?? eventContext.castId ?? null,
            reason: input.reason ?? 'SkillCast'
        });
        this.states.set(key, state);
        this.#record({
            frame,
            stage: 'CooldownStarted',
            actorId,
            skillId,
            skillType: definition.skillType,
            groupId: definition.groupId,
            baseDurationTicks: durationTicks,
            endFrame: state.endFrame,
            castId: state.castId,
            commandId: state.commandId,
            reason: state.reason
        });
        return cloneValue(state);
    }

    modify(input = {}, eventContext = {}) {
        if (!isRecord(input)) throw new TypeError('cooldown modification requires an object.');
        const frame = nonNegativeInteger(
            input.frame ?? eventContext.frame ?? 0,
            'cooldown modification frame'
        );
        const actorId = identifier(
            input.actorId ?? input.targetId ?? eventContext.targetId,
            'cooldown target actorId'
        );
        const operation = String(input.operation ?? input.functionType ?? 'Set');
        if (!['Set', 'Reduce'].includes(operation)) {
            throw new Error(`Unsupported cooldown operation: ${operation}.`);
        }
        const value = nonNegative(input.value ?? 0, 'cooldown modification value');
        const isPercentage = Boolean(input.isPercentage);
        const selector = isRecord(input.selector) ? input.selector : input;
        const groups = this.#resolveGroups(actorId, selector);
        if (groups.length === 0) {
            const record = this.#record({
                frame,
                stage: 'CooldownModificationIgnored',
                actorId,
                operation,
                selector: cloneValue(selector),
                value,
                isPercentage,
                reason: 'NoMatchingSkill'
            });
            return { status: 'Ignored', reason: 'NoMatchingSkill', results: [], trace: record };
        }
        const results = groups.map(group => this.#modifyGroup({
            frame,
            actorId,
            operation,
            value,
            isPercentage,
            selector,
            group,
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            castId: input.castId ?? eventContext.castId ?? null,
            commandId: input.commandId ?? eventContext.commandId ?? null,
            reason: input.reason ?? eventContext.reason ?? 'ModifySkillCooldown'
        }));
        return {
            status: results.some(result => result.status === 'Applied') ? 'Applied' : 'Ignored',
            actorId,
            operation,
            selector: cloneValue(selector),
            results: cloneValue(results)
        };
    }

    getEndFrame(actorId, skillId) {
        const definition = this.skills.get(skillKey(actorId, skillId));
        if (!definition) return 0;
        return this.states.get(groupKey(actorId, definition.groupId))?.endFrame ?? 0;
    }

    getEndFrameByType(actorId, skillType) {
        const groups = this.#resolveGroups(actorId, { skillTypes: [skillType] });
        return groups.reduce((maximum, group) => Math.max(
            maximum,
            this.states.get(groupKey(actorId, group.groupId))?.endFrame ?? 0
        ), 0);
    }

    endFramesForActor(actorId, { registeredSkills = false } = {}) {
        identifier(actorId, 'cooldown actorId');
        if (registeredSkills) {
            return Object.fromEntries([...this.skills.values()]
                .filter(definition => definition.actorId === actorId)
                .map(definition => [
                    definition.skillId,
                    this.getEndFrame(actorId, definition.skillId)
                ]));
        }
        return Object.fromEntries([...this.states.values()]
            .filter(state => state.actorId === actorId)
            .map(state => [state.skillId, state.endFrame]));
    }

    intervals() {
        return this.intervalRecords
            .filter(interval => interval.endFrame > interval.startFrame)
            .map(cloneValue);
    }

    snapshot(frame = null) {
        const atFrame = frame === null ? null : nonNegativeInteger(frame, 'snapshot frame');
        return {
            tickRate: this.tickRate,
            definitions: [...this.skills.values()].map(cloneValue),
            states: [...this.states.values()].map(state => ({
                ...cloneValue(state),
                active: atFrame === null ? null : state.endFrame > atFrame,
                remainingTicks: atFrame === null
                    ? null
                    : Math.max(0, state.endFrame - atFrame)
            })),
            intervals: this.intervals(),
            trace: this.trace.map(cloneValue)
        };
    }

    #refreshGroup(definition) {
        const key = groupKey(definition.actorId, definition.groupId);
        const group = this.groups.get(key) ?? {
            actorId: definition.actorId,
            groupId: definition.groupId,
            skillTypes: [],
            skillIds: [],
            baseDurationTicks: 0
        };
        if (!group.skillIds.includes(definition.skillId)) group.skillIds.push(definition.skillId);
        if (definition.skillType !== null && !group.skillTypes.includes(definition.skillType)) {
            group.skillTypes.push(definition.skillType);
        }
        group.baseDurationTicks = Math.max(
            ...group.skillIds.map(skillId => this.skills.get(
                skillKey(definition.actorId, skillId)
            )?.baseDurationTicks ?? 0)
        );
        this.groups.set(key, group);
    }

    #resolveGroups(actorId, selector) {
        const explicitSkillId = selector.skillId ?? selector.id ?? null;
        if (explicitSkillId !== null && explicitSkillId !== undefined
            && String(explicitSkillId).length > 0) {
            const definition = this.skills.get(skillKey(actorId, explicitSkillId));
            if (!definition) return [];
            return [this.groups.get(groupKey(actorId, definition.groupId))].filter(Boolean);
        }
        const types = normalizedSkillTypes(
            selector.skillTypes ?? selector.skillTypeMask ?? selector.skillType
        );
        if (types.length === 0) return [];
        return [...this.groups.values()].filter(group =>
            group.actorId === actorId
            && group.skillTypes.some(type => types.includes(type))
        );
    }

    #modifyGroup(input) {
        const key = groupKey(input.actorId, input.group.groupId);
        let state = this.states.get(key) ?? null;
        const active = Boolean(state && state.endFrame > input.frame);
        const baseDurationTicks = active
            ? state.baseDurationTicks
            : input.group.baseDurationTicks;
        if (input.isPercentage && baseDurationTicks <= 0 && input.value > 0) {
            const trace = this.#record({
                ...input,
                stage: 'CooldownModificationIgnored',
                groupId: input.group.groupId,
                skillType: input.group.skillTypes[0] ?? null,
                reason: 'BaseCooldownUnknown'
            });
            return { status: 'Ignored', reason: 'BaseCooldownUnknown', trace };
        }
        if (input.operation === 'Reduce' && !active) {
            const trace = this.#record({
                ...input,
                stage: 'CooldownModificationIgnored',
                groupId: input.group.groupId,
                skillType: input.group.skillTypes[0] ?? null,
                reason: 'NoActiveCooldown'
            });
            return { status: 'Ignored', reason: 'NoActiveCooldown', trace };
        }
        const requestedTicks = input.isPercentage
            ? Math.max(0, Math.round(baseDurationTicks * input.value))
            : Math.max(0, Math.round(input.value * this.tickRate));
        const beforeEndFrame = active ? state.endFrame : input.frame;
        const beforeRemainingTicks = Math.max(0, beforeEndFrame - input.frame);
        let afterRemainingTicks;
        let actualTicks;
        let discardedTicks;
        if (input.operation === 'Reduce') {
            actualTicks = Math.min(beforeRemainingTicks, requestedTicks);
            discardedTicks = requestedTicks - actualTicks;
            afterRemainingTicks = beforeRemainingTicks - actualTicks;
        } else {
            afterRemainingTicks = requestedTicks;
            actualTicks = requestedTicks;
            discardedTicks = 0;
        }
        const afterEndFrame = input.frame + afterRemainingTicks;
        if (!state && afterRemainingTicks > 0) {
            const representative = input.group.skillIds[0];
            state = this.#createState({
                frame: input.frame,
                actorId: input.actorId,
                skillId: representative,
                skillType: input.group.skillTypes[0] ?? null,
                groupId: input.group.groupId,
                baseDurationTicks,
                endFrame: afterEndFrame,
                stage: 'Set',
                commandId: input.commandId,
                castId: input.castId,
                reason: input.reason
            });
            this.states.set(key, state);
        } else if (state) {
            this.#setStateEnd(state, afterEndFrame);
        }
        const trace = this.#record({
            frame: input.frame,
            stage: 'CooldownModified',
            actorId: input.actorId,
            sourceId: input.sourceId,
            ownerId: input.ownerId,
            skillId: state?.skillId ?? input.group.skillIds[0] ?? null,
            skillType: state?.skillType ?? input.group.skillTypes[0] ?? null,
            groupId: input.group.groupId,
            operation: input.operation,
            selector: cloneValue(input.selector),
            value: input.value,
            isPercentage: input.isPercentage,
            percentageBasis: input.isPercentage ? 'BaseCooldown' : null,
            baseDurationTicks,
            beforeEndFrame,
            beforeRemainingTicks,
            requestedTicks,
            actualTicks,
            discardedTicks,
            afterEndFrame,
            afterRemainingTicks,
            castId: input.castId,
            commandId: input.commandId,
            reason: input.reason
        });
        return {
            status: 'Applied',
            actorId: input.actorId,
            skillId: trace.skillId,
            skillType: trace.skillType,
            groupId: input.group.groupId,
            operation: input.operation,
            beforeEndFrame,
            afterEndFrame,
            requestedTicks,
            actualTicks,
            discardedTicks,
            trace
        };
    }

    #createState(input) {
        const sequence = this.nextSequence++;
        const interval = {
            sequence,
            frame: input.frame,
            startFrame: input.frame,
            stage: input.stage,
            memberId: input.memberId ?? null,
            characterId: input.actorId,
            actorId: input.actorId,
            skillId: input.skillId,
            skillType: input.skillType,
            groupId: input.groupId,
            baseDurationTicks: input.baseDurationTicks,
            durationTicks: input.endFrame - input.frame,
            endFrame: input.endFrame,
            commandId: input.commandId ?? null,
            castId: input.castId ?? null,
            reason: input.reason ?? null
        };
        this.intervalRecords.push(interval);
        return {
            ...cloneValue(interval),
            intervalSequence: sequence
        };
    }

    #setStateEnd(state, endFrame) {
        const normalized = Math.max(state.startFrame, nonNegativeInteger(
            endFrame,
            'cooldown endFrame'
        ));
        state.endFrame = normalized;
        state.durationTicks = normalized - state.startFrame;
        const interval = this.intervalRecords.find(candidate =>
            candidate.sequence === state.intervalSequence
        );
        if (interval) {
            interval.endFrame = normalized;
            interval.durationTicks = normalized - interval.startFrame;
        }
    }

    #record(input) {
        const {
            selector,
            group,
            ...record
        } = input;
        const normalized = {
            frame: nonNegativeInteger(record.frame ?? 0, 'cooldown trace frame'),
            stage: record.stage ?? 'CooldownEvent',
            type: record.stage ?? 'CooldownEvent',
            actorId: record.actorId ?? null,
            characterId: record.actorId ?? null,
            sourceId: record.sourceId ?? null,
            ownerId: record.ownerId ?? null,
            skillId: record.skillId ?? null,
            skillType: record.skillType ?? null,
            groupId: record.groupId ?? null,
            reason: record.reason ?? null,
            ...(selector === undefined ? {} : { selector: cloneValue(selector) }),
            ...cloneValue(record)
        };
        this.trace.push(normalized);
        return cloneValue(normalized);
    }
}

export default SkillCooldownSystem;
