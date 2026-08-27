function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function byFrame(left, right) {
    return finite(left.frame) - finite(right.frame)
        || finite(left.sequence) - finite(right.sequence);
}

function commandState({ queued, terminal }) {
    if (terminal?.type === 'CommandExpired') return 'expired';
    if (terminal?.type === 'CommandExecuted' && terminal.success === false) return 'failed';
    if (terminal?.type === 'CommandExecuted') {
        return queued ? 'queued-then-executed' : 'executed';
    }
    return queued ? 'queued' : 'pending';
}

function pairCastEnds(commands, centerTrace, durationFrames) {
    const endings = centerTrace
        .filter(event => event.to === 'Free')
        .map((event, index) => {
            const match = /^skill-end:(.+):(Completed|Interrupted|Cancelled)$/.exec(
                String(event.reason ?? '')
            );
            return {
                index,
                frame: finite(event.frame),
                memberId: event.memberId ?? null,
                characterId: event.characterId ?? null,
                commandId: event.commandId ?? null,
                castId: event.castId ?? null,
                skillId: match?.[1] ?? null,
                completion: match?.[2] ?? 'Unknown',
                used: false
            };
        });
    for (const command of commands) {
        if (!command.success || command.actualFrame === null) continue;
        const ending = endings.find(candidate => !candidate.used
            && candidate.frame >= command.actualFrame
            && (command.memberId === null || candidate.memberId === null
                || candidate.memberId === command.memberId)
            && (command.characterId === null || candidate.characterId === null
                || candidate.characterId === command.characterId)
            && (candidate.commandId !== null
                ? candidate.commandId === command.commandId
                : candidate.skillId === null || candidate.skillId === command.skillId));
        if (ending) ending.used = true;
        command.endFrame = ending?.frame ?? durationFrames;
        command.completion = ending?.completion ?? 'Open';
    }
}

function projectCommands(result, durationFrames) {
    const trace = [...(result.commandTrace ?? [])].sort(byFrame);
    const fallback = result.scenario?.commands ?? [];
    const submitted = trace.filter(entry => entry.type === 'CommandSubmitted');
    const inputs = submitted.length > 0 ? submitted : fallback.map((command, index) => ({
        type: 'CommandSubmitted',
        frame: command.frame,
        commandId: command.commandId ?? `command-${index + 1}`,
        commandType: command.commandType,
        memberId: command.memberId ?? command.uuid ?? null,
        characterId: command.characterId ?? command.casterCharId ?? null
    }));
    const commands = inputs.map((input, index) => {
        const commandId = input.commandId ?? `command-${index + 1}`;
        const related = trace.filter(entry => entry.commandId === commandId);
        const queuedEvent = related.find(entry => entry.type === 'CommandQueued') ?? null;
        const terminal = [...related].reverse().find(entry =>
            entry.type === 'CommandExecuted' || entry.type === 'CommandExpired'
        ) ?? null;
        const success = terminal?.type === 'CommandExecuted' && terminal.success !== false;
        const requestedFrame = finite(input.frame);
        const actualFrame = success ? finite(terminal.frame) : null;
        const hits = terminal?.castId
            ? (result.damageLog ?? []).filter(hit => hit.castId === terminal.castId)
            : [];
        return {
            id: commandId,
            commandId,
            commandType: input.commandType,
            memberId: terminal?.memberId ?? queuedEvent?.memberId ?? input.memberId ?? null,
            characterId: terminal?.characterId ?? queuedEvent?.characterId
                ?? input.characterId ?? null,
            requestedFrame,
            requestedSeconds: requestedFrame / finite(result.tickRate, 30),
            actualFrame,
            actualSeconds: actualFrame === null
                ? null
                : actualFrame / finite(result.tickRate, 30),
            delayFrames: actualFrame === null ? null : actualFrame - requestedFrame,
            queued: Boolean(queuedEvent),
            predictedFrame: queuedEvent?.executeFrame ?? null,
            state: commandState({ queued: queuedEvent, terminal }),
            success,
            reason: terminal?.reason ?? queuedEvent?.reason ?? null,
            skillId: terminal?.skillId ?? queuedEvent?.skillId ?? null,
            castId: terminal?.castId ?? null,
            hitCount: hits.filter(hit => hit.damageAttributeType === 'Hp').length,
            damage: hits.reduce((sum, hit) => sum + (
                hit.damageAttributeType === 'Hp' ? finite(hit.finalDamage) : 0
            ), 0),
            poiseDamage: hits.reduce((sum, hit) => sum + finite(hit.poiseDamage), 0),
            endFrame: null,
            completion: null
        };
    });
    pairCastEnds(commands, result.centerStateTrace ?? [], durationFrames);
    return commands;
}

function projectHitBursts(damageLog, tickRate) {
    const groups = new Map();
    for (const hit of [...(damageLog ?? [])].sort(byFrame)) {
        const key = [hit.frame, hit.castId, hit.rootSkillId ?? hit.skillId].join('|');
        if (!groups.has(key)) {
            groups.set(key, {
                id: `hit:${key}`,
                frame: finite(hit.frame),
                seconds: finite(hit.frame) / tickRate,
                castId: hit.castId ?? null,
                memberId: hit.memberId ?? null,
                characterId: hit.characterId ?? hit.sourceId ?? null,
                sourceId: hit.sourceId ?? hit.characterId ?? null,
                skillId: hit.skillId ?? null,
                rootSkillId: hit.rootSkillId ?? hit.skillId ?? null,
                damageTypes: [],
                damage: 0,
                poiseDamage: 0,
                hpHitCount: 0,
                poiseHitCount: 0,
                hits: []
            });
        }
        const group = groups.get(key);
        if (hit.damageType && !group.damageTypes.includes(hit.damageType)) {
            group.damageTypes.push(hit.damageType);
        }
        if (hit.damageAttributeType === 'Hp') {
            group.damage += finite(hit.finalDamage ?? hit.amount);
            group.hpHitCount += 1;
        }
        if (['Poise', 'Resilience'].includes(hit.damageAttributeType)) {
            group.poiseDamage += finite(hit.poiseDamage ?? hit.amount ?? hit.finalDamage);
            group.poiseHitCount += 1;
        }
        group.hits.push(clone(hit));
    }
    return [...groups.values()];
}

function resourceEventKind(event) {
    if (event.stage === 'ResourcePoolRegistered') return 'Initialize';
    if (event.stage === 'ResourceGainSuppressed') return 'GainSuppressed';
    if (event.stage === 'ResourceGainSuppressionStarted') return 'GainLockStart';
    if (event.stage === 'ResourceGainSuppressionEnded') return 'GainLockEnd';
    if (event.stage === 'ResourceRecoverySuspended') return 'RecoveryPauseStart';
    if (event.stage === 'ResourceRecoveryResumed') return 'RecoveryPauseEnd';
    if (event.stage === 'ResourceRecoverySuppressed') return 'RecoveryPausedTick';
    if (event.stage === 'ResourceSpent') return 'Spend';
    if (String(event.resourceGainMethod ?? '').toLowerCase() === 'return') return 'Return';
    if (event.reason === 'PassiveRecovery') return 'PassiveRecovery';
    if (event.stage === 'ResourceGained') return 'Gain';
    return event.stage;
}

function closeWindows(events, startStage, endStage, durationFrames, activeFrameKey = 'frame') {
    const open = new Map();
    const windows = [];
    for (const event of events) {
        const token = String(event.token ?? event.suppressionToken ?? 'anonymous');
        if (event.stage === startStage) {
            const startFrame = finite(event[activeFrameKey] ?? event.frame);
            open.set(token, {
                token,
                startFrame,
                eventFrame: finite(event.frame),
                tags: clone(event.tags ?? event.suppressionTags ?? []),
                reason: event.reason ?? null,
                castId: event.castId ?? null,
                skillId: event.skillId ?? null
            });
        } else if (event.stage === endStage && open.has(token)) {
            const window = open.get(token);
            open.delete(token);
            windows.push({ ...window, endFrame: finite(event.frame), open: false });
        }
    }
    for (const window of open.values()) {
        windows.push({ ...window, endFrame: durationFrames, open: true });
    }
    return windows.sort((left, right) => left.startFrame - right.startFrame);
}

function projectResourcePools(trace, finalPools, durationFrames, tickRate) {
    const ordered = trace.map((event, sequence) => ({ ...clone(event), sequence })).sort(byFrame);
    const definitions = new Map();
    for (const event of ordered) {
        if (!event.poolId) continue;
        const previous = definitions.get(event.poolId) ?? {};
        definitions.set(event.poolId, {
            ...previous,
            poolId: event.poolId,
            resourceType: event.resourceType ?? previous.resourceType,
            scope: event.scope ?? previous.scope,
            ownerId: event.ownerId ?? previous.ownerId ?? null,
            max: finite(event.cap, previous.max ?? 0)
        });
    }
    for (const [poolId, pool] of Object.entries(finalPools ?? {})) {
        definitions.set(poolId, {
            ...(definitions.get(poolId) ?? {}),
            poolId,
            resourceType: pool.resourceType,
            scope: pool.scope,
            ownerId: pool.ownerId ?? null,
            max: finite(pool.max)
        });
    }
    return [...definitions.values()].map(definition => {
        const events = ordered.filter(event => event.poolId === definition.poolId);
        const stateEvents = events.filter(event => [
            'ResourcePoolRegistered', 'ResourceGained', 'ResourceSpent'
        ].includes(event.stage));
        const points = stateEvents.map(event => ({
            frame: finite(event.frame),
            seconds: finite(event.frame) / tickRate,
            value: finite(event.after),
            ordinary: finite(event.ordinaryAfter, finite(event.after) - finite(event.returnedAfter)),
            returned: finite(event.returnedAfter),
            kind: resourceEventKind(event),
            reason: event.reason ?? null,
            sourceId: event.sourceId ?? null,
            ownerId: event.ownerId ?? definition.ownerId ?? null,
            commandId: event.commandId ?? null,
            castId: event.castId ?? null,
            skillId: event.skillId ?? null
        }));
        return {
            ...definition,
            initial: points[0]?.value ?? 0,
            final: points.at(-1)?.value ?? 0,
            points,
            events: events.map(event => ({
                frame: finite(event.frame),
                seconds: finite(event.frame) / tickRate,
                kind: resourceEventKind(event),
                stage: event.stage,
                before: Number.isFinite(Number(event.before)) ? Number(event.before) : null,
                requested: Number.isFinite(Number(event.requestedAmount ?? event.requested))
                    ? Number(event.requestedAmount ?? event.requested)
                    : null,
                actual: Number.isFinite(Number(event.actualAmount ?? event.actual))
                    ? Number(event.actualAmount ?? event.actual)
                    : null,
                after: Number.isFinite(Number(event.after)) ? Number(event.after) : null,
                returnedBefore: finite(event.returnedBefore),
                returnedAfter: finite(event.returnedAfter),
                returnedSpent: finite(event.returnedSpent),
                eligibleSpend: finite(event.eligibleSpend),
                reason: event.reason ?? null,
                sourceId: event.sourceId ?? null,
                commandId: event.commandId ?? null,
                castId: event.castId ?? null,
                skillId: event.skillId ?? null,
                tags: clone(event.resourceGainTags ?? event.tags ?? [])
            })),
            recoveryWindows: closeWindows(
                events,
                'ResourceRecoverySuspended',
                'ResourceRecoveryResumed',
                durationFrames,
                'activeFromFrame'
            ),
            gainLockWindows: closeWindows(
                events,
                'ResourceGainSuppressionStarted',
                'ResourceGainSuppressionEnded',
                durationFrames
            )
        };
    });
}

function projectCooldowns(trace, durationFrames, tickRate) {
    return (trace ?? []).map((event, index) => {
        const startFrame = finite(event.frame);
        const endFrame = finite(event.endFrame, startFrame + finite(event.durationTicks));
        return {
            id: `cooldown:${event.skillId}:${startFrame}:${index}`,
            memberId: event.memberId ?? null,
            characterId: event.characterId ?? null,
            skillId: event.skillId ?? null,
            startFrame,
            startSeconds: startFrame / tickRate,
            endFrame,
            endSeconds: endFrame / tickRate,
            durationFrames: endFrame - startFrame,
            visibleEndFrame: Math.min(durationFrames, endFrame),
            remainingFrames: Math.max(0, endFrame - durationFrames),
            stage: event.stage ?? 'Started',
            reason: event.reason ?? null
        };
    });
}

function projectComboWindows(trace, durationFrames, tickRate) {
    const ordered = [...(trace ?? [])].sort(byFrame);
    const terminalByPendingId = new Map();
    for (const event of ordered) {
        if (event.pendingId === null || event.pendingId === undefined) continue;
        if (['PENDING_CONSUMED', 'PENDING_EXPIRED'].includes(event.stage)) {
            terminalByPendingId.set(event.pendingId, event);
        }
    }
    return ordered
        .filter(event => ['PENDING_CREATED', 'PENDING_REFRESHED', 'PENDING_REPLACED']
            .includes(event.stage))
        .map(event => {
            const createdFrame = finite(event.frame);
            const expireFrame = createdFrame
                + Math.max(1, finite(event.pendingRemainingFrames, 1)) - 1;
            const terminal = terminalByPendingId.get(event.pendingId) ?? null;
            const state = terminal?.stage === 'PENDING_CONSUMED'
                ? 'consumed'
                : terminal?.stage === 'PENDING_EXPIRED' || expireFrame <= durationFrames
                    ? 'expired'
                    : 'active';
            return {
                id: `combo-window:${String(event.pendingId)}`,
                pendingId: event.pendingId,
                ruleId: event.ruleId ?? null,
                characterId: event.targetId ?? null,
                skillId: event.skillId ?? null,
                sourceCommandId: event.sourceCommandId ?? null,
                createdFrame,
                createdSeconds: createdFrame / tickRate,
                expireFrame,
                expireSeconds: expireFrame / tickRate,
                consumedFrame: terminal?.stage === 'PENDING_CONSUMED'
                    ? finite(terminal.frame)
                    : null,
                consumedCommandId: terminal?.commandId ?? null,
                state,
                reason: terminal?.reason ?? event.reason ?? null,
                triggerTargetId: event.triggerTargetId ?? null
            };
        });
}

function projectTimedInputWindows(windows, durationFrames, tickRate) {
    return (windows ?? []).map(window => {
        const startFrame = finite(
            window.activeStartFrame,
            finite(window.createdFrame) + finite(window.earlyDurationTicks)
        );
        const endFrameExclusive = finite(
            window.activeEndFrameExclusive,
            startFrame + finite(window.activeDurationTicks)
        );
        const resolvedFrame = window.resolvedFrame !== null
            && window.resolvedFrame !== undefined
            && Number.isFinite(Number(window.resolvedFrame))
            ? Number(window.resolvedFrame)
            : null;
        const state = resolvedFrame !== null
            ? 'resolved'
            : durationFrames >= endFrameExclusive
                ? 'missed'
                : durationFrames >= startFrame ? 'active' : 'upcoming';
        return {
            id: window.id,
            ownerId: window.ownerId ?? null,
            inputTypes: clone(window.inputTypes ?? []),
            createdFrame: finite(window.createdFrame),
            startFrame,
            startSeconds: startFrame / tickRate,
            endFrameExclusive,
            endSecondsExclusive: endFrameExclusive / tickRate,
            resolvedFrame,
            resolvedCommandId: window.resolvedCommandId ?? null,
            state,
            boundary: window.boundary ?? 'start-inclusive-end-exclusive',
            sourceBuffId: window.sourceBuffId ?? null,
            sourceSkillId: window.sourceSkillId ?? null,
            reason: window.reason ?? null
        };
    });
}

export function projectAkeTimeline(result) {
    if (!result || typeof result !== 'object') {
        throw new TypeError('projectAkeTimeline requires a scenario result object.');
    }
    const tickRate = finite(result.tickRate, 30);
    if (tickRate <= 0) throw new RangeError('Scenario tickRate must be positive.');
    const durationFrames = Math.max(0, finite(result.durationTicks ?? result.durationFrames));
    const commands = projectCommands(result, durationFrames);
    const casts = commands.filter(command => command.success).map(command => ({
        id: command.castId,
        castId: command.castId,
        commandId: command.commandId,
        commandType: command.commandType,
        memberId: command.memberId,
        characterId: command.characterId,
        skillId: command.skillId,
        requestedFrame: command.requestedFrame,
        startFrame: command.actualFrame,
        endFrame: command.endFrame,
        completion: command.completion,
        delayFrames: command.delayFrames
    }));
    const hitBursts = projectHitBursts(result.damageLog, tickRate);
    const resourcePools = projectResourcePools(
        result.resourceTrace ?? [],
        result.finalState?.resourcePools ?? {},
        durationFrames,
        tickRate
    );
    const cooldowns = projectCooldowns(result.cooldownTrace, durationFrames, tickRate);
    const comboWindows = projectComboWindows(result.comboTrace, durationFrames, tickRate);
    const timedInputWindows = projectTimedInputWindows(
        result.timedInputWindows,
        durationFrames,
        tickRate
    );
    const sharedAtb = resourcePools.find(pool =>
        pool.resourceType === 'Atb' && pool.scope === 'Shared'
    ) ?? null;
    const uspPools = resourcePools.filter(pool => pool.resourceType === 'UltimateSp');
    return {
        schemaVersion: 3,
        tickRate,
        durationFrames,
        durationSeconds: durationFrames / tickRate,
        commands,
        casts,
        hitBursts,
        resourcePools,
        sharedAtb,
        uspPools,
        cooldowns,
        comboWindows,
        timedInputWindows,
        lanes: [
            { id: 'inputs', kind: 'CommandInput', items: commands },
            { id: 'casts', kind: 'SkillCast', items: casts },
            { id: 'hits', kind: 'HitBurst', items: hitBursts },
            ...(sharedAtb ? [{ id: 'shared-atb', kind: 'SharedAtb', items: sharedAtb.points }] : []),
            ...uspPools.map(pool => ({
                id: `usp:${String(pool.ownerId ?? pool.poolId)}`,
                kind: 'UltimateSp',
                ownerId: pool.ownerId,
                items: pool.points
            })),
            { id: 'cooldowns', kind: 'Cooldown', items: cooldowns },
            ...(comboWindows.length > 0
                ? [{ id: 'combo-windows', kind: 'ComboWindow', items: comboWindows }]
                : []),
            ...(timedInputWindows.length > 0
                ? [{
                    id: 'timed-input-windows',
                    kind: 'TimedInputWindow',
                    items: timedInputWindows
                }]
                : [])
        ]
    };
}

export default projectAkeTimeline;
