import {
    canonicalize,
    hashJson,
    RIA_SCHEMA_VERSION,
    sanitizeForArchive
} from './common.mjs';
import { validateEvent, validateSnapshot } from './schemas.mjs';

function finiteFrame(value) {
    const number = Number(value ?? 0);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nullableDomainId(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return String(value).slice(0, 512);
}

function nullableText(value, maxLength = 512) {
    if (value === null || value === undefined || value === '') return null;
    return String(value).slice(0, maxLength);
}

function identityFromFact(fact) {
    const rawAction = {
        actorId: null,
        ownerId: nullableDomainId(fact.ownerId),
        carrierId: nullableDomainId(fact.carrierId),
        skillId: nullableDomainId(
            fact.actionSkillId ?? fact.executedSkillId ?? fact.sourceSkillId ?? fact.skillId
        ),
        rootSkillId: nullableDomainId(
            fact.actionRootSkillId ?? fact.rootSkillId ?? fact.inputSkillId
        ),
        inputSkillId: nullableDomainId(
            fact.actionInputSkillId ?? fact.inputSkillId ?? fact.rootSkillId
        ),
        executedSkillId: nullableDomainId(
            fact.actionExecutedSkillId
            ?? fact.executedSkillId
            ?? fact.sourceSkillId
            ?? fact.skillId
        ),
        inputCommandType: nullableText(
            fact.actionInputCommandType ?? fact.inputCommandType ?? fact.commandType,
            160
        ),
        effectiveSkillType: nullableText(
            fact.actionEffectiveSkillType ?? fact.effectiveSkillType ?? fact.skillType,
            160
        ),
        castId: nullableDomainId(fact.actionCastId ?? fact.castId),
        rootCastId: nullableDomainId(
            fact.actionRootCastId ?? fact.rootCastId ?? fact.actionCastId ?? fact.castId
        ),
        parentCastId: nullableDomainId(fact.actionParentCastId ?? fact.parentCastId)
    };
    const identityTokens = [
        rawAction.skillId,
        rawAction.rootSkillId,
        rawAction.inputSkillId,
        rawAction.executedSkillId
    ].filter(value => typeof value === 'string');
    const candidates = [...new Set([
        fact.actionActorId,
        fact.characterId,
        fact.actorId,
        fact.ownerId,
        fact.sourceId
    ].filter(value => value !== null && value !== undefined && value !== ''))];
    const affinity = actor => identityTokens.reduce((score, token) => (
        token === actor
        || token.startsWith(`${String(actor)}_`)
        || token.includes(`:${String(actor)}:`)
            ? score + 1
            : score
    ), 0);
    const ranked = candidates.map((actor, index) => ({ actor, index, score: affinity(actor) }))
        .sort((left, right) => right.score - left.score || left.index - right.index);
    const actionActorId = nullableDomainId(
        fact.actionActorId
        ?? (ranked[0]?.score > 0 ? ranked[0].actor : null)
        ?? fact.characterId
        ?? fact.actorId
        ?? fact.sourceId
        ?? fact.ownerId
        ?? fact.consumerId
    );
    const primaryAction = { ...rawAction, actorId: actionActorId };
    const triggerPresent = [
        fact.triggerSourceId,
        fact.triggerOwnerId,
        fact.triggerSkillId,
        fact.triggerInputSkillId,
        fact.triggerCastId,
        fact.triggerRootCastId
    ].some(value => value !== null && value !== undefined && value !== '');
    const triggerTokens = [
        fact.triggerSkillId,
        fact.triggerRootSkillId,
        fact.triggerInputSkillId
    ].filter(value => typeof value === 'string');
    const triggerCandidates = [...new Set([
        fact.triggerActionActorId,
        fact.consumerId,
        fact.triggerOwnerId,
        fact.triggerSourceId
    ].filter(value => value !== null && value !== undefined && value !== ''))];
    const rankedTriggerActors = triggerCandidates.map((actor, index) => ({
        actor,
        index,
        score: triggerTokens.reduce((score, token) => (
            token === actor
            || token.startsWith(`${String(actor)}_`)
            || token.includes(`:${String(actor)}:`)
                ? score + 1
                : score
        ), 0)
    })).sort((left, right) => right.score - left.score || left.index - right.index);
    const trigger = triggerPresent ? {
        actorId: nullableDomainId(
            fact.triggerActionActorId
            ?? (rankedTriggerActors[0]?.score > 0 ? rankedTriggerActors[0].actor : null)
            ?? fact.consumerId
            ?? fact.triggerSourceId
            ?? fact.triggerOwnerId
        ),
        ownerId: nullableDomainId(fact.triggerOwnerId ?? fact.triggerSourceId),
        carrierId: nullableDomainId(fact.triggerTargetId),
        skillId: nullableDomainId(fact.triggerSkillId),
        rootSkillId: nullableDomainId(
            fact.triggerRootSkillId ?? fact.triggerInputSkillId ?? fact.triggerSkillId
        ),
        inputSkillId: nullableDomainId(
            fact.triggerInputSkillId ?? fact.triggerRootSkillId ?? fact.triggerSkillId
        ),
        executedSkillId: nullableDomainId(fact.triggerSkillId),
        inputCommandType: nullableText(
            fact.triggerInputCommandType ?? fact.triggerCommandType,
            160
        ),
        effectiveSkillType: nullableText(
            fact.triggerEffectiveSkillType ?? fact.triggerSkillType,
            160
        ),
        castId: nullableDomainId(fact.triggerCastId),
        rootCastId: nullableDomainId(fact.triggerRootCastId ?? fact.triggerCastId),
        parentCastId: nullableDomainId(fact.triggerParentCastId)
    } : null;
    const originActorId = nullableDomainId(
        fact.originActorId ?? fact.sourceId ?? fact.damageSourceId ?? fact.ownerId
    );
    const originHasExplicitAction = [
        fact.originSkillId,
        fact.originRootSkillId,
        fact.originInputSkillId,
        fact.originExecutedSkillId,
        fact.originCastId,
        fact.originRootCastId
    ].some(value => value !== null && value !== undefined && value !== '');
    const originOwnsRawAction = originHasExplicitAction
        || originActorId === null
        || actionActorId === null
        || String(originActorId) === String(actionActorId);
    const origin = {
        actorId: originActorId,
        ownerId: nullableDomainId(fact.originOwnerId ?? fact.ownerId),
        carrierId: nullableDomainId(fact.originCarrierId ?? fact.carrierId),
        skillId: nullableDomainId(
            fact.originSkillId ?? (originOwnsRawAction ? rawAction.skillId : null)
        ),
        rootSkillId: nullableDomainId(
            fact.originRootSkillId ?? (originOwnsRawAction ? rawAction.rootSkillId : null)
        ),
        inputSkillId: nullableDomainId(
            fact.originInputSkillId ?? (originOwnsRawAction ? rawAction.inputSkillId : null)
        ),
        executedSkillId: nullableDomainId(
            fact.originExecutedSkillId ?? (originOwnsRawAction ? rawAction.executedSkillId : null)
        ),
        inputCommandType: nullableText(
            fact.originInputCommandType
            ?? (originOwnsRawAction ? rawAction.inputCommandType : null),
            160
        ),
        effectiveSkillType: nullableText(
            fact.originEffectiveSkillType
            ?? (originOwnsRawAction ? rawAction.effectiveSkillType : null),
            160
        ),
        castId: nullableDomainId(
            fact.originCastId ?? (originOwnsRawAction ? rawAction.castId : null)
        ),
        rootCastId: nullableDomainId(
            fact.originRootCastId ?? (originOwnsRawAction ? rawAction.rootCastId : null)
        ),
        parentCastId: nullableDomainId(
            fact.originParentCastId ?? (originOwnsRawAction ? rawAction.parentCastId : null)
        )
    };
    const consumer = fact.consumerId === null || fact.consumerId === undefined
        ? null
        : {
            actorId: nullableDomainId(fact.consumerId),
            skillId: trigger?.skillId ?? null,
            rootSkillId: trigger?.rootSkillId ?? null,
            inputSkillId: trigger?.inputSkillId ?? null,
            executedSkillId: trigger?.executedSkillId ?? null,
            inputCommandType: trigger?.inputCommandType ?? null,
            effectiveSkillType: trigger?.effectiveSkillType ?? null,
            castId: trigger?.castId ?? null,
            rootCastId: trigger?.rootCastId ?? null,
            parentCastId: trigger?.parentCastId ?? null
        };

    if (trigger) return { primaryRole: 'trigger', primary: trigger, origin, trigger, consumer };
    return {
        primaryRole: 'action',
        primary: primaryAction,
        origin,
        trigger: null,
        consumer
    };
}

function transitionKind(fact) {
    const stage = String(fact.stage ?? fact.type ?? '');
    const lower = stage.toLowerCase();
    if (fact.consumption === true || /consumed|consume/.test(lower)
        || /^TeamComboConsumedBy/.test(String(fact.reason ?? ''))) return 'consume';
    if (/applied|granted|grant/.test(lower)) return 'grant';
    if (/refresh/.test(lower)) return 'refresh';
    if (/expire/.test(lower)) return 'expire';
    if (/finish|removed|remove/.test(lower)) return 'remove';
    if ([fact.before, fact.after, fact.current, fact.actualDelta, fact.deltaStacks]
        .some(value => value !== null && value !== undefined)) return 'change';
    return null;
}

function numberOrNull(...values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function commonPayload(fact) {
    const before = numberOrNull(fact.beforeStacks, fact.before, fact.previous);
    const after = numberOrNull(fact.afterStacks, fact.after, fact.current, fact.stackCount);
    const delta = numberOrNull(
        fact.deltaStacks,
        fact.actualDelta,
        fact.actual,
        before !== null && after !== null ? after - before : null
    );
    const transition = transitionKind(fact);
    return {
        transition: transition === null ? null : {
            kind: transition,
            resourceType: fact.resourceType ?? null,
            buffId: fact.buffId ?? null,
            instanceId: fact.instanceId ?? fact.buffInstanceId ?? null,
            before,
            requested: numberOrNull(fact.requested, fact.requestedDelta),
            delta,
            after,
            grantIds: Array.isArray(fact.grantIds) ? [...fact.grantIds] : [],
            reason: fact.reason ?? null
        }
    };
}

function hitFacts(fact) {
    if (fact.stage !== 'ActionDelegated' || fact.type !== 'ResolveDamagePacket') return [];
    const resolved = fact.result?.resolution?.hits ?? [];
    const applied = fact.result?.hits ?? [];
    return resolved.map((hit, index) => {
        const application = applied[index]?.result ?? null;
        return {
            ...fact,
            eventId: hit.hitId ?? `${String(fact.eventId ?? 'effect')}:hit:${index + 1}`,
            sequence: hit.sequence ?? fact.sequence ?? null,
            stage: 'DamageHit',
            type: 'DamageHit',
            targetId: application?.targetId
                ?? application?.record?.targetId
                ?? fact.targetId
                ?? null,
            carrierId: hit.carrierId ?? fact.carrierId ?? fact.sourceId ?? null,
            damageSourceId: hit.damageSourceId ?? fact.damageSourceId ?? fact.sourceId ?? null,
            hit: {
                ...hit,
                targetHpBefore: application?.before ?? null,
                targetHpAfter: application?.after ?? null,
                application
            }
        };
    });
}

function eventTypeFor(source, fact) {
    if (source === 'ledger.team-combo') {
        return `TeamCombo${String(fact.type ?? 'event')
            .replace(/(^|[-_ ])([a-z])/g, (_match, _separator, letter) => letter.toUpperCase())}`;
    }
    if (source === 'ledger.team-combo-hit') return 'TeamComboHitConsumptionSnapshot';
    return String(fact.stage ?? fact.eventType ?? fact.type ?? 'RuntimeFact').slice(0, 160);
}

function authorityFor(source) {
    if (source.startsWith('ui.')) return 'ui-projection';
    if (source.startsWith('ledger.') || source.includes('projection')) return 'runtime-projection';
    return 'runtime-fact';
}

export class RiaEventNormalizer {
    constructor({ caseId, sessionId, runId, projectRoot = null, startSequence = 0 } = {}) {
        this.identity = { caseId, sessionId, runId };
        this.projectRoot = projectRoot;
        this.sequence = startSequence;
    }

    normalize(source, rawFact) {
        const fact = sanitizeForArchive(rawFact, { projectRoot: this.projectRoot });
        const allFacts = [fact, ...hitFacts(fact)];
        return allFacts.map(entry => this.#event(source, entry));
    }

    #event(source, fact) {
        const sequence = ++this.sequence;
        const frame = finiteFrame(fact.frame ?? fact.tick);
        const identities = identityFromFact(fact);
        const primary = identities.primary;
        const castId = primary.castId;
        const rootCastId = primary.rootCastId ?? castId;
        const parentCastId = primary.parentCastId;
        const childCastId = parentCastId === null ? null : castId;
        const event = {
            schemaVersion: RIA_SCHEMA_VERSION,
            ...this.identity,
            sequence,
            frame,
            tick: frame,
            eventType: eventTypeFor(source, fact),
            actorId: primary.actorId,
            ownerId: primary.ownerId,
            carrierId: primary.carrierId,
            targetId: nullableDomainId(fact.targetId),
            damageSourceId: nullableDomainId(fact.damageSourceId),
            commandId: nullableDomainId(fact.commandId),
            skillId: primary.skillId ?? primary.executedSkillId,
            inputSkillId: primary.inputSkillId,
            executedSkillId: primary.executedSkillId,
            inputCommandType: primary.inputCommandType,
            effectiveSkillType: primary.effectiveSkillType,
            castId,
            rootCastId,
            parentCastId,
            childCastId,
            primaryIdentityRole: identities.primaryRole,
            originActorId: identities.origin.actorId,
            originSkillId: identities.origin.skillId,
            originRootSkillId: identities.origin.rootSkillId,
            originInputSkillId: identities.origin.inputSkillId,
            originExecutedSkillId: identities.origin.executedSkillId,
            originInputCommandType: identities.origin.inputCommandType,
            originEffectiveSkillType: identities.origin.effectiveSkillType,
            originCastId: identities.origin.castId,
            originRootCastId: identities.origin.rootCastId,
            originParentCastId: identities.origin.parentCastId,
            triggerActorId: identities.trigger?.actorId ?? null,
            triggerSkillId: identities.trigger?.skillId ?? null,
            triggerRootSkillId: identities.trigger?.rootSkillId ?? null,
            triggerInputSkillId: identities.trigger?.inputSkillId ?? null,
            triggerExecutedSkillId: identities.trigger?.executedSkillId ?? null,
            triggerInputCommandType: identities.trigger?.inputCommandType ?? null,
            triggerEffectiveSkillType: identities.trigger?.effectiveSkillType ?? null,
            triggerCastId: identities.trigger?.castId ?? null,
            triggerRootCastId: identities.trigger?.rootCastId ?? null,
            triggerParentCastId: identities.trigger?.parentCastId ?? null,
            consumerActorId: identities.consumer?.actorId ?? null,
            consumerSkillId: identities.consumer?.skillId ?? null,
            consumerCastId: identities.consumer?.castId ?? null,
            consumerRootCastId: identities.consumer?.rootCastId ?? null,
            source: {
                authority: authorityFor(source),
                stream: source,
                nativeEventId: fact.eventId ?? fact.hit?.hitId ?? null,
                nativeSequence: numberOrNull(fact.sequence)
            },
            ...commonPayload(fact),
            data: fact
        };
        if (fact.hit) {
            const hit = fact.hit;
            event.damage = {
                hitId: hit.hitId ?? event.source.nativeEventId,
                damageAttributeType: hit.damageAttributeType ?? null,
                damageType: hit.damageType ?? null,
                rawDamage: numberOrNull(hit.rawDamage, hit.amount),
                finalDamage: numberOrNull(hit.finalDamage, hit.amount),
                poiseDamage: ['Poise', 'Resilience'].includes(hit.damageAttributeType)
                    ? numberOrNull(hit.amount, hit.finalDamage)
                    : 0,
                targetHpBefore: numberOrNull(hit.targetHpBefore),
                targetHpAfter: numberOrNull(hit.targetHpAfter),
                operands: hit.operands ?? {},
                factors: hit.factors ?? [],
                factorValidation: hit.factorValidation ?? null,
                consumedStatuses: hit.consumedStatuses ?? []
            };
        }
        event.eventHash = hashJson({ ...event, eventHash: undefined });
        validateEvent(event, sequence - 1);
        return event;
    }
}

export function reportProjectionFacts(report) {
    const facts = [];
    for (const command of report?.commands ?? []) {
        facts.push({ source: 'settled.command-projection', fact: {
            ...command,
            stage: 'CommandSettled'
        } });
    }
    for (const event of report?.teamComboLedger?.events ?? []) {
        facts.push({ source: 'ledger.team-combo', fact: event });
    }
    for (const hit of report?.teamComboLedger?.hits ?? []) {
        if ((hit.consumptionSnapshots ?? []).length === 0) continue;
        facts.push({ source: 'ledger.team-combo-hit', fact: hit });
    }
    facts.push({ source: 'settled.result-projection', fact: {
        frame: report?.durationFrames ?? report?.durationTicks ?? 0,
        stage: 'RunSettled',
        engine: report?.engine ?? null,
        tickRate: report?.tickRate ?? null,
        summary: report?.summary ?? report?.damageSummary ?? {},
        finalState: report?.finalState ?? {},
        diagnostics: report?.diagnostics ?? {}
    } });
    return facts;
}

function updateFactState(state, event) {
    const fact = event.data ?? {};
    if (event.source.stream === 'ledger.team-combo' && event.transition) {
        state.teamCombo = {
            stacks: event.transition.after,
            grantIds: event.transition.grantIds,
            lastTransition: event.transition.kind,
            rootCastId: event.rootCastId
        };
    }
    if (event.source.stream === 'resource') {
        const key = String(fact.poolId ?? fact.resourceType ?? fact.id ?? 'unknown');
        const after = numberOrNull(fact.after, fact.current);
        if (after !== null) {
            state.resources[key] = {
                resourceType: fact.resourceType ?? null,
                ownerId: fact.ownerId ?? null,
                value: after
            };
        }
    }
    if (event.source.stream === 'status') {
        const key = String(fact.instanceId ?? fact.buffInstanceId ?? [
            fact.buffId,
            fact.targetId
        ].join(':'));
        const kind = event.transition?.kind;
        if (['expire', 'remove', 'consume'].includes(kind)
            && numberOrNull(event.transition?.after) === 0) {
            delete state.statuses[key];
        } else if (fact.buffId) {
            state.statuses[key] = {
                buffId: fact.buffId,
                targetId: fact.targetId ?? null,
                stackCount: numberOrNull(
                    event.transition?.after,
                    fact.stackCount
                ),
                expireFrame: fact.expireFrame ?? null,
                active: !['expire', 'remove'].includes(kind)
            };
        }
    }
    if (event.eventType === 'DamageHit'
        && event.damage
        && event.damage.targetHpAfter !== null) {
        const targetId = String(event.targetId ?? 'unknown');
        state.targets[targetId] = {
            ...(state.targets[targetId] ?? {}),
            hp: event.damage.targetHpAfter,
            lastHitId: event.damage.hitId ?? null
        };
    }
    if (event.rootCastId && event.actorId) {
        const castKey = String(event.rootCastId);
        const previous = state.casts[castKey] ?? null;
        // A cast can only be updated by a coherent primary action identity.
        // Origin/trigger metadata from another action never changes ownership.
        if (previous?.actorId !== undefined && previous.actorId !== null
            && String(previous.actorId) !== String(event.actorId)) return;
        state.casts[castKey] = {
            rootCastId: event.rootCastId,
            lastCastId: event.castId,
            childCastId: event.childCastId,
            actorId: event.actorId,
            inputSkillId: event.inputSkillId,
            executedSkillId: event.executedSkillId,
            inputCommandType: event.inputCommandType,
            effectiveSkillType: event.effectiveSkillType,
            lastEventType: event.eventType,
            lastFrame: event.frame
        };
    }
}

export function buildStateSnapshots(events, identity) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const ordered = [...events].sort((left, right) => (
        left.frame - right.frame || left.sequence - right.sequence
    ));
    const state = { resources: {}, statuses: {}, targets: {}, casts: {}, teamCombo: null };
    const snapshots = [];
    let snapshotSequence = 0;
    let index = 0;
    while (index < ordered.length) {
        const frame = ordered[index].frame;
        let maxEvidence = 0;
        while (index < ordered.length && ordered[index].frame === frame) {
            updateFactState(state, ordered[index]);
            maxEvidence = Math.max(maxEvidence, ordered[index].sequence);
            index += 1;
        }
        const snapshot = {
            schemaVersion: RIA_SCHEMA_VERSION,
            ...identity,
            sequence: ++snapshotSequence,
            frame,
            state: structuredClone(state),
            evidence: {
                source: 'normalized-fact-projection',
                fromEventSequence: 1,
                toEventSequence: maxEvidence
            }
        };
        validateSnapshot(snapshot, snapshotSequence - 1);
        snapshots.push(snapshot);
    }
    return snapshots;
}

const VOLATILE_KEYS = new Set([
    'caseId', 'sessionId', 'runId', 'sequence', 'eventHash', 'generatedAt',
    'startedAt', 'endedAt', 'contentHash', 'nativeEventId', 'nativeSequence'
]);

export function normalizeForDiff(value) {
    const visit = entry => {
        if (Array.isArray(entry)) return entry.map(visit);
        if (!entry || typeof entry !== 'object') return entry;
        return Object.fromEntries(Object.keys(entry)
            .filter(key => !VOLATILE_KEYS.has(key))
            .sort()
            .map(key => [key, visit(entry[key])]));
    };
    return canonicalize(visit(value));
}

export function firstDivergence(leftEvents, rightEvents, { context = 3 } = {}) {
    const maximum = Math.max(leftEvents.length, rightEvents.length);
    for (let index = 0; index < maximum; index += 1) {
        const left = index < leftEvents.length ? normalizeForDiff(leftEvents[index]) : null;
        const right = index < rightEvents.length ? normalizeForDiff(rightEvents[index]) : null;
        if (hashJson(left) === hashJson(right)) continue;
        return {
            identical: false,
            index,
            left,
            right,
            context: {
                left: leftEvents.slice(Math.max(0, index - context), index + context + 1)
                    .map(normalizeForDiff),
                right: rightEvents.slice(Math.max(0, index - context), index + context + 1)
                    .map(normalizeForDiff)
            }
        };
    }
    return { identical: true, index: null, left: null, right: null, context: null };
}
