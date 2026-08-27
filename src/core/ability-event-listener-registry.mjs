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

function optionalIdentifier(value, label) {
    if (value === null || value === undefined) return null;
    return identifier(value, label);
}

function finiteFrame(value, label, fallback = null) {
    if (value === null || value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative finite number.`);
    }
    return number;
}

function publicListener(listener) {
    return cloneValue(listener);
}

/**
 * Cast-scoped AKE ability-event subscriptions.
 *
 * BuffData listeners remain owned by StatusEffectSystem. This registry covers
 * EventListenerAction nodes whose lifetime is a SkillData timeline window.
 * Keeping them separate makes the owner boundary explicit while both kinds of
 * listener can consume the same runtime ability-event stream.
 */
export class AbilityEventListenerRegistry {
    constructor({
        executeActions,
        targetValidator = () => true,
        onBlackboardChange = null
    } = {}) {
        if (typeof executeActions !== 'function') {
            throw new TypeError('AbilityEventListenerRegistry requires executeActions.');
        }
        if (typeof targetValidator !== 'function') {
            throw new TypeError('targetValidator must be a function.');
        }
        if (onBlackboardChange !== null && typeof onBlackboardChange !== 'function') {
            throw new TypeError('onBlackboardChange must be a function or null.');
        }
        this.executeActions = executeActions;
        this.targetValidator = targetValidator;
        this.onBlackboardChange = onBlackboardChange;
        this.listeners = new Map();
        this.trace = [];
        this.nextSequence = 1;
    }

    register(input, eventContext = {}) {
        if (!isRecord(input)) {
            throw new TypeError('AbilityEventListenerRegistry.register requires an object.');
        }
        const listenerId = identifier(
            input.listenerId ?? input.sourceKey,
            'ability listener id'
        );
        const listenerTargetId = identifier(
            input.listenerTargetId,
            'ability listener target id'
        );
        if (!this.targetValidator(listenerTargetId)) {
            throw new Error(`Unknown ability listener target: ${String(listenerTargetId)}.`);
        }
        if (!Array.isArray(input.eventGroups) || input.eventGroups.length === 0) {
            throw new TypeError('Ability event listener requires non-empty eventGroups.');
        }
        const eventGroups = input.eventGroups.map((group, groupIndex) => {
            if (!isRecord(group) || !Array.isArray(group.actions)) {
                throw new TypeError(`Ability event group ${groupIndex} requires actions.`);
            }
            return {
                eventType: identifier(group.eventType, `ability event group ${groupIndex} type`),
                actions: cloneValue(group.actions),
                priority: Number.isFinite(Number(group.priority))
                    ? Number(group.priority)
                    : 0,
                sequence: groupIndex
            };
        });
        const existing = this.listeners.get(listenerId);
        if (existing?.active) {
            this.remove({ listenerId, reason: 'ListenerReplaced' }, eventContext);
        }
        const startFrame = finiteFrame(
            input.timelineStartFrame,
            'ability listener timelineStartFrame',
            0
        );
        const endFrame = finiteFrame(
            input.timelineEndFrame,
            'ability listener timelineEndFrame',
            null
        );
        if (endFrame !== null && endFrame < startFrame) {
            throw new RangeError('ability listener timelineEndFrame precedes its start.');
        }
        const listener = {
            listenerId,
            sourceKey: input.sourceKey ?? listenerId,
            listenerTargetId,
            sourceId: optionalIdentifier(input.sourceId, 'ability listener source id'),
            ownerId: optionalIdentifier(input.ownerId, 'ability listener owner id'),
            targetId: optionalIdentifier(input.targetId, 'ability listener action target id'),
            skillId: input.skillId ?? null,
            rootSkillId: input.rootSkillId ?? input.skillId ?? null,
            castId: input.castId ?? null,
            programExecutionId: input.programExecutionId ?? null,
            buffInstanceId: input.buffInstanceId ?? null,
            ownerLifetime: input.ownerLifetime ?? 'SkillTimeline',
            clockDomainId: input.clockDomainId ?? null,
            timelineStartFrame: startFrame,
            timelineEndFrame: endFrame,
            priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
            sequence: this.nextSequence++,
            eventGroups,
            blackboard: cloneValue(input.blackboard ?? {}),
            metadata: cloneValue(input.metadata ?? {}),
            registeredFrame: finiteFrame(
                input.frame ?? eventContext.frame,
                'ability listener registration frame',
                0
            ),
            active: true,
            removedFrame: null,
            removeReason: null
        };
        this.listeners.set(listenerId, listener);
        this.#record('AbilityEventListenerRegistered', listener, {
            ...eventContext,
            frame: listener.registeredFrame
        }, {
            eventTypes: eventGroups.map(group => group.eventType)
        });
        return publicListener(listener);
    }

    remove(input = {}, eventContext = {}) {
        if (!isRecord(input)) {
            throw new TypeError('AbilityEventListenerRegistry.remove requires an object.');
        }
        const frame = finiteFrame(
            input.frame ?? eventContext.frame,
            'ability listener removal frame',
            0
        );
        const matches = [...this.listeners.values()]
            .filter(listener => listener.active)
            .filter(listener => input.listenerId === undefined
                || listener.listenerId === input.listenerId)
            .filter(listener => input.sourceKey === undefined
                || listener.sourceKey === input.sourceKey)
            .filter(listener => input.castId === undefined
                || listener.castId === input.castId)
            .filter(listener => input.programExecutionId === undefined
                || listener.programExecutionId === input.programExecutionId)
            .filter(listener => input.buffInstanceId === undefined
                || listener.buffInstanceId === input.buffInstanceId);
        for (const listener of matches) {
            listener.active = false;
            listener.removedFrame = frame;
            listener.removeReason = input.reason ?? 'ListenerRemoved';
            this.#record('AbilityEventListenerRemoved', listener, {
                ...eventContext,
                frame
            }, {
                reason: listener.removeReason
            });
        }
        return matches.map(publicListener);
    }

    notify(eventContext = {}) {
        if (!isRecord(eventContext)) {
            throw new TypeError('AbilityEventListenerRegistry.notify requires an object.');
        }
        const eventType = identifier(eventContext.eventType, 'ability event type');
        const listenerTargetId = eventContext.listenerTargetId
            ?? eventContext.sourceId
            ?? eventContext.ownerId;
        if (listenerTargetId === null || listenerTargetId === undefined) return [];
        const candidates = [...this.listeners.values()]
            .filter(listener => listener.active
                && listener.listenerTargetId === listenerTargetId)
            .sort((left, right) => left.priority - right.priority
                || left.sequence - right.sequence);
        const results = [];
        for (const listener of candidates) {
            const groups = listener.eventGroups
                .filter(group => group.eventType === eventType)
                .sort((left, right) => left.priority - right.priority
                    || left.sequence - right.sequence);
            for (const group of groups) {
                if (!listener.active) break;
                const incomingPayload = cloneValue(eventContext.payload ?? {});
                const transaction = this.executeActions(group.actions, {
                    ...cloneValue(eventContext),
                    eventType,
                    sourceId: listener.sourceId,
                    ownerId: listener.ownerId,
                    targetId: listener.targetId,
                    skillId: listener.skillId,
                    rootSkillId: listener.rootSkillId,
                    castId: listener.castId,
                    programExecutionId: listener.programExecutionId,
                    buffInstanceId: listener.buffInstanceId,
                    clockDomainId: listener.clockDomainId,
                    blackboard: {
                        ...cloneValue(eventContext.blackboard ?? {}),
                        ...cloneValue(listener.blackboard)
                    },
                    payload: {
                        ...incomingPayload,
                        eventSourceId: eventContext.sourceId ?? null,
                        eventOwnerId: eventContext.ownerId ?? null,
                        eventTargetId: eventContext.targetId ?? null,
                        eventBuffInstanceId: eventContext.buffInstanceId ?? null,
                        listenerTargetId,
                        listenerId: listener.listenerId
                    }
                });
                if (isRecord(transaction?.eventContext?.blackboard)) {
                    listener.blackboard = cloneValue(transaction.eventContext.blackboard);
                    this.onBlackboardChange?.(
                        publicListener(listener),
                        cloneValue(eventContext)
                    );
                }
                this.#record('AbilityEventListenerHandled', listener, eventContext, {
                    eventType,
                    actionCount: group.actions.length
                });
                results.push({
                    listenerId: listener.listenerId,
                    listenerType: 'SkillTimeline',
                    eventType,
                    result: transaction?.result ?? transaction
                });
            }
        }
        return results;
    }

    reconcileProgramSeek({
        programExecutionId,
        destFrame,
        frame = 0,
        reason = 'TimelineSeek'
    } = {}, eventContext = {}) {
        identifier(programExecutionId, 'programExecutionId');
        const destination = finiteFrame(destFrame, 'destination timeline frame', 0);
        const matches = [...this.listeners.values()].filter(listener => listener.active
            && listener.programExecutionId === programExecutionId
            && (destination < listener.timelineStartFrame
                || (listener.timelineEndFrame !== null
                    && destination >= listener.timelineEndFrame)));
        const removed = [];
        for (const listener of matches) {
            removed.push(...this.remove({
                listenerId: listener.listenerId,
                frame,
                reason: `${reason}:${destination}`
            }, eventContext));
        }
        return removed;
    }

    list({
        active = undefined,
        castId = undefined,
        programExecutionId = undefined,
        buffInstanceId = undefined
    } = {}) {
        return [...this.listeners.values()]
            .filter(listener => active === undefined || listener.active === active)
            .filter(listener => castId === undefined || listener.castId === castId)
            .filter(listener => programExecutionId === undefined
                || listener.programExecutionId === programExecutionId)
            .filter(listener => buffInstanceId === undefined
                || listener.buffInstanceId === buffInstanceId)
            .map(publicListener);
    }

    snapshot() {
        return {
            listeners: this.list(),
            activeCount: this.list({ active: true }).length,
            trace: cloneValue(this.trace)
        };
    }

    #record(stage, listener, eventContext, extra = {}) {
        const record = {
            frame: eventContext.frame ?? listener.registeredFrame ?? 0,
            stage,
            listenerId: listener.listenerId,
            listenerTargetId: listener.listenerTargetId,
            sourceId: listener.sourceId,
            ownerId: listener.ownerId,
            targetId: listener.targetId,
            skillId: listener.skillId,
            castId: listener.castId,
            programExecutionId: listener.programExecutionId,
            buffInstanceId: listener.buffInstanceId,
            ownerLifetime: listener.ownerLifetime,
            ...cloneValue(extra)
        };
        this.trace.push(record);
        return cloneValue(record);
    }
}

export default AbilityEventListenerRegistry;
