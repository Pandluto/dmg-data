const ADMISSION_MODES = new Set(['Priority', 'ExternalGate']);
const DECISION_STEPS = new Set([
    'HigherPriority',
    'AllowedNext',
    'CurrentCanBeInterrupted',
    'ExclusiveEnd'
]);
const RETRY_SOURCES = new Set([
    'AllowNextSkillAction',
    'MarkCanInterrupt',
    'ExclusiveFrame'
]);

const DEFAULT_POLICY = Object.freeze({
    decisionOrder: Object.freeze([
        'HigherPriority',
        'AllowedNext',
        'CurrentCanBeInterrupted',
        'ExclusiveEnd'
    ]),
    retrySources: Object.freeze([
        'AllowNextSkillAction',
        'MarkCanInterrupt',
        'ExclusiveFrame'
    ])
});

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function requiredString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function mappingList(semanticMappings) {
    const mappings = Array.isArray(semanticMappings)
        ? semanticMappings
        : semanticMappings?.mappings;
    if (!Array.isArray(mappings)) {
        throw new TypeError('semanticMappings must be an array or object with mappings.');
    }
    return mappings;
}

function selectedList(value, fallback, allowed, label) {
    const selected = value ?? fallback;
    if (!Array.isArray(selected) || selected.length === 0) {
        throw new TypeError(`${label} must be a non-empty array.`);
    }
    const normalized = selected.map((entry, index) =>
        requiredString(entry, `${label}[${index}]`)
    );
    for (const entry of normalized) {
        if (!allowed.has(entry)) {
            throw new RangeError(`${label} contains unsupported value ${entry}.`);
        }
    }
    return [...new Set(normalized)];
}

function normalizePolicy(rawPolicy = {}) {
    if (!isRecord(rawPolicy)) throw new TypeError('command admission policy must be an object.');
    return Object.freeze({
        decisionOrder: Object.freeze(selectedList(
            rawPolicy.decisionOrder,
            DEFAULT_POLICY.decisionOrder,
            DECISION_STEPS,
            'command admission decisionOrder'
        )),
        retrySources: Object.freeze(selectedList(
            rawPolicy.retrySources,
            DEFAULT_POLICY.retrySources,
            RETRY_SOURCES,
            'command admission retrySources'
        ))
    });
}

function normalizeRule(rawRule, index) {
    if (!isRecord(rawRule)) {
        throw new TypeError(`command admission rule ${index} must be an object.`);
    }
    const commandType = requiredString(
        rawRule.selector?.commandType,
        `command admission rule ${index} selector.commandType`
    );
    const effect = rawRule.effect ?? {};
    const admissionMode = effect.admissionMode ?? 'Priority';
    if (!ADMISSION_MODES.has(admissionMode)) {
        throw new RangeError(
            `command admission rule ${commandType} has unsupported admissionMode ${admissionMode}.`
        );
    }
    const rawPriority = effect.priority;
    const priority = rawPriority === null || rawPriority === undefined
        ? null
        : Number(rawPriority);
    if (admissionMode === 'Priority' && !Number.isFinite(priority)) {
        throw new TypeError(
            `command admission rule ${commandType} requires a finite priority.`
        );
    }
    if (priority !== null && !Number.isFinite(priority)) {
        throw new TypeError(`command admission rule ${commandType} priority must be finite or null.`);
    }
    return Object.freeze({
        id: rawRule.id ?? `command-admission:${commandType}`,
        commandType,
        centerState: requiredString(
            effect.centerState,
            `command admission rule ${commandType} effect.centerState`
        ),
        priority,
        admissionMode,
        transitionBeforeInterrupt: effect.transitionBeforeInterrupt === true
    });
}

function finiteFrame(value, fallback = Number.POSITIVE_INFINITY) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function nullableFiniteNumber(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function allowedAt(skill, nextSkillId, timelineFrame) {
    return (skill?.allowNextWindows ?? []).some(window =>
        window.allowedSkillIds?.includes(nextSkillId)
        && timelineFrame >= finiteFrame(window.startFrame)
        && timelineFrame <= finiteFrame(window.endFrame)
    );
}

function nextAllowFrame(skill, nextSkillId, timelineFrame) {
    const candidates = (skill?.allowNextWindows ?? [])
        .filter(window => window.allowedSkillIds?.includes(nextSkillId)
            && timelineFrame <= finiteFrame(window.endFrame))
        .map(window => Math.max(timelineFrame, finiteFrame(window.startFrame)))
        .filter(Number.isFinite);
    return candidates.length > 0 ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

function nextInterruptFrame(skill, timelineFrame) {
    const candidates = (skill?.interruptMarks ?? [])
        .map(mark => finiteFrame(mark.startFrame))
        .filter(frame => Number.isFinite(frame) && frame >= timelineFrame);
    return candidates.length > 0 ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

function exclusiveFrame(skill) {
    return Math.max(0, finiteFrame(skill?.exclusiveFrames, 0));
}

function acceptedBase(profile, input, currentPriority, timelineFrame) {
    return {
        accepted: true,
        commandType: profile.commandType,
        skillId: input.skillId,
        currentSkillId: input.currentSkill?.skillId ?? null,
        currentPriority,
        newPriority: profile.priority,
        timelineFrame
    };
}

/**
 * Evidence-configured command admission. It decides only whether an already
 * resolved skill command may replace the active skill. Resource, cooldown,
 * combo-pending and execution/poise gates remain separate domain checks.
 */
export class CommandAdmissionProvider {
    constructor({ semanticMappings = [], policy = null } = {}) {
        const mappings = mappingList(semanticMappings);
        const rawRules = mappings.filter(mapping =>
            mapping.actionType === 'CommandAdmissionRule'
        );
        if (rawRules.length === 0) {
            throw new Error('At least one CommandAdmissionRule mapping is required.');
        }
        this.rules = new Map();
        rawRules.map(normalizeRule).forEach(rule => {
            if (this.rules.has(rule.commandType)) {
                throw new Error(`Duplicate CommandAdmissionRule for ${rule.commandType}.`);
            }
            this.rules.set(rule.commandType, rule);
        });
        const mappedPolicies = mappings.filter(mapping =>
            mapping.actionType === 'CommandAdmissionPolicy'
        );
        if (mappedPolicies.length > 1) {
            throw new Error('Only one CommandAdmissionPolicy mapping is supported.');
        }
        this.policy = normalizePolicy(
            policy ?? mappedPolicies[0]?.effect ?? DEFAULT_POLICY
        );
    }

    has(commandType) {
        return this.rules.has(commandType);
    }

    profile(commandType) {
        const profile = this.rules.get(commandType);
        if (!profile) throw new Error(`Missing CommandAdmissionRule for ${commandType}.`);
        return clone(profile);
    }

    evaluate(input) {
        if (!isRecord(input)) throw new TypeError('command admission input must be an object.');
        const profile = this.rules.get(input.commandType);
        if (!profile) {
            throw new Error(`Missing CommandAdmissionRule for ${input.commandType}.`);
        }
        const timelineFrame = Math.max(0, finiteFrame(input.timelineFrame, 0));
        const current = input.currentSkill ?? null;
        if (!current) {
            return {
                ...acceptedBase(profile, input, null, timelineFrame),
                reason: 'NO_ACTIVE_SKILL'
            };
        }

        const currentProfile = this.rules.get(current.commandType);
        const currentPriority = nullableFiniteNumber(current.priority)
            ?? nullableFiniteNumber(currentProfile?.priority);
        if (profile.admissionMode === 'ExternalGate') {
            return {
                ...acceptedBase(profile, input, currentPriority, timelineFrame),
                reason: 'EXTERNAL_GATE'
            };
        }

        const skill = current.skill;
        const facts = {
            HigherPriority: currentPriority !== null
                && profile.priority > currentPriority,
            AllowedNext: allowedAt(skill, input.skillId, timelineFrame),
            CurrentCanBeInterrupted: current.interruptible === true,
            ExclusiveEnd: timelineFrame >= exclusiveFrame(skill)
        };
        const reasons = {
            HigherPriority: 'HIGHER_PRIORITY',
            AllowedNext: 'ALLOWED_NEXT',
            CurrentCanBeInterrupted: 'CURRENT_CAN_BE_INTERRUPTED',
            ExclusiveEnd: 'EXCLUSIVE_END'
        };
        for (const step of this.policy.decisionOrder) {
            if (facts[step]) {
                return {
                    ...acceptedBase(profile, input, currentPriority, timelineFrame),
                    reason: reasons[step]
                };
            }
        }

        const candidates = [];
        if (this.policy.retrySources.includes('ExclusiveFrame')) {
            candidates.push(exclusiveFrame(skill));
        }
        if (this.policy.retrySources.includes('AllowNextSkillAction')) {
            candidates.push(nextAllowFrame(skill, input.skillId, timelineFrame));
        }
        if (this.policy.retrySources.includes('MarkCanInterrupt')) {
            candidates.push(nextInterruptFrame(skill, timelineFrame));
        }
        const nextTimelineFrame = Math.min(...candidates.filter(candidate =>
            Number.isFinite(candidate) && candidate >= timelineFrame
        ));
        if (nextTimelineFrame <= timelineFrame) {
            return {
                ...acceptedBase(profile, input, currentPriority, timelineFrame),
                reason: 'RETRY_POINT_REACHED'
            };
        }
        return {
            accepted: false,
            reason: currentPriority === null
                ? 'CURRENT_PRIORITY_UNRESOLVED'
                : 'PRIORITY_BLOCK',
            commandType: profile.commandType,
            skillId: input.skillId,
            currentSkillId: current.skillId ?? null,
            currentPriority,
            newPriority: profile.priority,
            timelineFrame,
            nextTimelineFrame
        };
    }
}

export function createCommandAdmissionProvider(options = {}) {
    return new CommandAdmissionProvider(options);
}

export default CommandAdmissionProvider;
