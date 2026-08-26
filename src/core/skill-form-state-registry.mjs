import { cloneValue } from './combat-context.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label) {
    if ((typeof value !== 'string' && typeof value !== 'number')
        || (typeof value === 'string' && value.length === 0)
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`${label} must be a non-empty string or finite number.`);
    }
    return value;
}

function priorityValue(level, offset = 0) {
    const named = {
        Lowest: -200,
        Low: -100,
        Default: 0,
        High: 100,
        Highest: 200
    }[String(level ?? 'Default')] ?? 0;
    const numericOffset = Number(offset ?? 0);
    if (!Number.isFinite(numericOffset)) throw new TypeError('priorityOffset must be finite.');
    return named + numericOffset;
}

function sourceMapKey(kind, sourceKey) {
    return `${kind}\u0000${typeof sourceKey}\u0000${String(sourceKey)}`;
}

/**
 * Reversible state for AKE ChangeSkillAction and SwitchModeAction.  The
 * registry deliberately knows nothing about individual characters: callers
 * resolve a command slot from active overrides/modes and the character role
 * table supplies the concrete fallback skill.
 */
export class SkillFormStateRegistry {
    constructor({ targetValidator = null } = {}) {
        if (targetValidator !== null && typeof targetValidator !== 'function') {
            throw new TypeError('targetValidator must be a function or null.');
        }
        this.targetValidator = targetValidator;
        this.entries = new Map();
        this.nextSequence = 1;
        this.trace = [];
    }

    applyOverride(input = {}, eventContext = {}) {
        if (!isRecord(input)) throw new TypeError('applyOverride requires an object.');
        return this.#apply('SkillOverride', {
            ...input,
            skillSlot: identifier(input.skillSlot, 'skillSlot'),
            targetSkillId: identifier(input.targetSkillId ?? input.skillId, 'targetSkillId')
        }, eventContext);
    }

    applyMode(input = {}, eventContext = {}) {
        if (!isRecord(input)) throw new TypeError('applyMode requires an object.');
        return this.#apply('SkillMode', {
            ...input,
            modeId: identifier(input.modeId, 'modeId')
        }, eventContext);
    }

    removeOverride(selector = {}, eventContext = {}) {
        return this.#remove('SkillOverride', selector, eventContext);
    }

    removeMode(selector = {}, eventContext = {}) {
        return this.#remove('SkillMode', selector, eventContext);
    }

    resolveOverride({ targetId, skillSlot } = {}) {
        identifier(targetId, 'targetId');
        identifier(skillSlot, 'skillSlot');
        return this.#ranked('SkillOverride', targetId)
            .find(entry => entry.skillSlot === skillSlot) ?? null;
    }

    activeModes(targetId) {
        identifier(targetId, 'targetId');
        return this.#ranked('SkillMode', targetId);
    }

    snapshot() {
        const entries = [...this.entries.values()]
            .sort((left, right) => left.sequence - right.sequence)
            .map(cloneValue);
        return {
            overrides: entries.filter(entry => entry.kind === 'SkillOverride'),
            modes: entries.filter(entry => entry.kind === 'SkillMode'),
            trace: this.trace.map(cloneValue)
        };
    }

    #apply(kind, input, eventContext) {
        const sourceKey = identifier(
            input.sourceKey ?? input.buffInstanceId ?? eventContext.buffInstanceId,
            'sourceKey'
        );
        const targetId = identifier(input.targetId ?? eventContext.targetId, 'targetId');
        if (this.targetValidator && !this.targetValidator(targetId)) {
            throw new Error(`Unknown skill-form target: ${String(targetId)}.`);
        }
        const mapKey = sourceMapKey(kind, sourceKey);
        const previous = this.entries.get(mapKey) ?? null;
        const entry = {
            kind,
            sourceKey,
            targetId,
            sourceId: input.sourceId ?? eventContext.sourceId ?? null,
            ownerId: input.ownerId ?? eventContext.ownerId ?? null,
            buffInstanceId: input.buffInstanceId ?? eventContext.buffInstanceId ?? null,
            appliedFrame: Number(input.frame ?? eventContext.frame ?? 0),
            priorityLevel: input.priorityLevel ?? 'Default',
            priorityOffset: Number(input.priorityOffset ?? 0),
            priority: priorityValue(input.priorityLevel, input.priorityOffset),
            sequence: this.nextSequence++,
            ...(kind === 'SkillOverride' ? {
                skillSlot: input.skillSlot,
                targetSkillId: input.targetSkillId,
                revertedSkillId: input.revertedSkillId ?? null,
                inheritOriginSkillCdProgress: Boolean(input.inheritOriginSkillCdProgress),
                overrideCacheTime: Boolean(input.overrideCacheTime),
                cacheTime: cloneValue(input.cacheTime ?? null),
                lifeTimeType: input.lifeTimeType ?? 'FinishByAction'
            } : {
                modeId: input.modeId,
                resetOnEnd: input.resetOnEnd !== false
            }),
            metadata: cloneValue(input.metadata ?? {})
        };
        this.entries.set(mapKey, entry);
        this.trace.push({
            frame: entry.appliedFrame,
            stage: `${kind}Applied`,
            type: `${kind}Applied`,
            sourceKey,
            targetId,
            before: cloneValue(previous),
            after: cloneValue(entry)
        });
        return cloneValue(entry);
    }

    #remove(kind, selector, eventContext) {
        if (!isRecord(selector)) throw new TypeError(`remove ${kind} selector must be an object.`);
        const matches = [...this.entries.entries()].filter(([, entry]) =>
            entry.kind === kind
            && (selector.sourceKey === undefined || entry.sourceKey === selector.sourceKey)
            && (selector.targetId === undefined || entry.targetId === selector.targetId)
            && (selector.buffInstanceId === undefined
                || entry.buffInstanceId === selector.buffInstanceId)
            && (selector.sequence === undefined || entry.sequence === selector.sequence)
            && (selector.skillSlot === undefined || entry.skillSlot === selector.skillSlot)
            && (selector.modeId === undefined || entry.modeId === selector.modeId)
        );
        for (const [mapKey] of matches) this.entries.delete(mapKey);
        const frame = Number(selector.frame ?? eventContext.frame ?? 0);
        this.trace.push({
            frame,
            stage: `${kind}Removed`,
            type: `${kind}Removed`,
            sourceKey: selector.sourceKey ?? null,
            targetId: selector.targetId ?? eventContext.targetId ?? null,
            removed: matches.map(([, entry]) => cloneValue(entry))
        });
        return matches.map(([, entry]) => cloneValue(entry));
    }

    #ranked(kind, targetId) {
        return [...this.entries.values()]
            .filter(entry => entry.kind === kind && entry.targetId === targetId)
            .sort((left, right) => right.priority - left.priority
                || right.appliedFrame - left.appliedFrame
                || right.sequence - left.sequence)
            .map(cloneValue);
    }
}

export default SkillFormStateRegistry;
