import { combatTriggerAttribution } from './combat-trigger-attribution.mjs';
import { parseAkeOperationOrder } from './ake-operation-order.mjs';
import { isPlungingImpactInput, plungingImpactInputRejection } from './ake-attack-input.mjs';
import { canReplaceAkeSkillCast, executeAkeSkillCastReplacement } from './ake-skill-cast-replacement.mjs';
import { createAkeDamageResolver } from './ake-damage-resolver.mjs';
import {
    applyAkeLocalClockTrigger,
    createAkeTimeDilationResolver
} from './ake-time-dilation-resolver.mjs';
import { ComboTriggerMachine } from './combo-trigger-machine.mjs';
import { CombatRuntime } from './combat-runtime.mjs';
import { CommandAdmissionProvider } from './command-admission-provider.mjs';
import { LoadoutEffectManager } from './ake-loadout-compiler.mjs';
import { normalizeTeamComboEventLedger } from './team-combo-event-ledger.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function nonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return number;
}

function positiveInteger(value, label) {
    const number = nonNegativeInteger(value, label);
    if (number === 0) throw new RangeError(`${label} must be positive.`);
    return number;
}

function mappedSkills(skill, commandType) {
    const skillIds = [];
    for (const cache of skill?.comboMappings ?? []) {
        for (const mapping of cache.mappings ?? []) {
            if (mapping.command !== commandType
                || !mapping.skillId
                || skillIds.includes(mapping.skillId)) continue;
            skillIds.push(mapping.skillId);
        }
    }
    return skillIds;
}

function mappedSkill(skill, commandType, preferredSkillIds = []) {
    const skillIds = mappedSkills(skill, commandType);
    const preferred = preferredSkillIds.find(skillId => (
        skillId && skillIds.includes(skillId)
    ));
    return preferred ?? skillIds[0] ?? null;
}

function skillSlotForCommand(commandType) {
    return {
        Attack: 'NormalAttack',
        NormalSkill: 'NormalSkill',
        ComboSkill: 'ComboSkill',
        UltimateSkill: 'UltimateSkill'
    }[commandType] ?? null;
}

// Attribute snapshots are part of the settlement contract rather than a UI
// convenience.  AKE folds weapon/talent/static layers into the character
// component before the run and applies dynamic Buff layers during the run;
// exposing the same snapshot at the end lets consumers distinguish those two
// sources instead of treating the runtime number as an unexplained scalar.
const RUNTIME_ATTRIBUTE_SNAPSHOT_FIELDS = Object.freeze([
    'Atk', 'MaxHp', 'Str', 'Agi', 'Wisd', 'Will'
]);

function baseRoleSkill(roles, commandType) {
    switch (commandType) {
        case 'Attack': return roles.normalAttackIds?.[0] ?? null;
        case 'NormalSkill': return roles.normalSkillId ?? null;
        case 'ComboSkill': return roles.comboSkillId ?? null;
        case 'UltimateSkill': return roles.ultimateSkillId ?? null;
        case 'BreakingAttack': return roles.breakingAttackId ?? null;
        default: return null;
    }
}

function modeAttackSkill(roles, programs, modes) {
    if (!Array.isArray(modes) || modes.length === 0) return null;
    const baseAttackIds = new Set(roles.normalAttackIds ?? []);
    const candidates = Object.values(roles.groups ?? {}).flat()
        .filter(skillId => programs.has(skillId) && !baseAttackIds.has(skillId))
        .filter(skillId => /(?:^|_)attack0*1(?:_|$)/i.test(skillId));
    for (const mode of modes) {
        const modeToken = String(mode.modeId ?? '')
            .toLowerCase()
            .replace(/mode$/i, '')
            .replace(/[^a-z0-9]+/g, '');
        const scored = candidates.map(skillId => {
            const normalized = skillId.toLowerCase().replace(/[^a-z0-9]+/g, '');
            let score = 1;
            if (modeToken && normalized.includes(modeToken)) score += 10;
            if (modeToken.includes('ult') && normalized.includes('ult')) score += 8;
            if (/attack0*1_ult|ult_attack0*1/i.test(skillId)) score += 4;
            return { skillId, score };
        }).sort((left, right) => right.score - left.score
            || lexical(left.skillId, right.skillId));
        if (scored[0]?.score > 1) return scored[0].skillId;
    }
    return null;
}

function fullAttackChain(startSkillId, programs) {
    if (!startSkillId || !programs.has(startSkillId)) return [];
    const chain = [];
    const visited = new Set();
    let skillId = startSkillId;
    while (skillId && programs.has(skillId) && !visited.has(skillId) && chain.length < 12) {
        visited.add(skillId);
        chain.push(skillId);
        const nextSkillId = mappedSkill(programs.get(skillId), 'Attack');
        if (!nextSkillId || nextSkillId === startSkillId || visited.has(nextSkillId)) break;
        skillId = nextSkillId;
    }
    return chain;
}

function attackTransitionOffset(skill, nextSkillId = null) {
    const matchingWindows = (skill?.allowNextWindows ?? []).filter(window => (
        nextSkillId === null || window.allowedSkillIds?.includes(nextSkillId)
    ));
    const windowStart = Math.min(...matchingWindows
        .map(window => Number(window.startFrame))
        .filter(Number.isFinite));
    if (Number.isFinite(windowStart)) return Math.max(1, Math.trunc(windowStart));
    const exclusive = Number(skill?.exclusiveFrames);
    if (Number.isFinite(exclusive) && exclusive > 0) return Math.trunc(exclusive);
    return Math.max(1, Math.trunc(Number(skill?.durationFrames ?? 1)) - 1);
}

function skillNaturalEndOffset(skill) {
    const exclusive = Number(skill?.exclusiveFrames);
    if (Number.isFinite(exclusive) && exclusive > 0) {
        return Math.max(1, Math.trunc(exclusive));
    }
    return Math.max(1, Math.trunc(Number(skill?.durationFrames ?? 1)) - 1);
}

function commandUsesSequenceQueue(command) {
    return command?.queueMode === 'timeline-sequence';
}

function poolRef(costType, characterId) {
    return costType === 'Atb'
        ? { resourceType: costType, scope: 'Shared', ownerId: null }
        : { resourceType: costType, scope: 'Entity', ownerId: characterId };
}

function commandIdentifier(command) {
    return command.commandId ?? command.id ?? null;
}

function lexical(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedCommands(commands, bundle, operationOrder) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array.');
    const membersById = new Map(bundle.members.map(member => [member.memberId, member]));
    const membersByCharacterId = new Map(bundle.members.map(member => [
        member.characterId,
        member
    ]));
    const normalized = commands.map((command, index) => {
        if (!isRecord(command)) throw new TypeError(`commands[${index}] must be an object.`);
        if (typeof command.commandType !== 'string' || command.commandType.length === 0) {
            throw new TypeError(`commands[${index}].commandType must be a non-empty string.`);
        }
        const requestedMemberId = command.memberId ?? command.uuid ?? command.casterId ?? null;
        const requestedCharacterId = command.characterId ?? command.casterCharId ?? null;
        let member = requestedMemberId === null ? null : membersById.get(requestedMemberId);
        if (!member && requestedCharacterId !== null) {
            member = membersByCharacterId.get(requestedCharacterId);
        }
        if (!member && requestedMemberId === null && requestedCharacterId === null
            && bundle.members.length === 1) {
            member = bundle.members[0];
        }
        if (!member) {
            throw new Error(
                `commands[${index}] does not resolve to a squad member (${String(requestedMemberId ?? requestedCharacterId)}).`
            );
        }
        if (requestedCharacterId !== null && member.characterId !== requestedCharacterId) {
            throw new Error(`commands[${index}] memberId and characterId refer to different members.`);
        }
        const frame = nonNegativeInteger(command.frame, `commands[${index}].frame`);
        return {
            ...clone(command),
            frame,
            requestedFrame: frame,
            memberId: member.memberId,
            uuid: member.memberId,
            characterId: member.characterId,
            commandId: commandIdentifier(command) ?? `${member.memberId}:command:${index + 1}`,
            inputSequence: operationOrder.isV1 ? command.operationOrder : index
        };
    }).sort((left, right) => left.frame - right.frame
        || (operationOrder.isV1 ? operationOrder.compare(left, right)
            : lexical(left.memberId, right.memberId) || left.inputSequence - right.inputSequence));
    return normalized;
}

function validateReleaseDependencies(commands, switches) {
    const nodes = [...commands.map(command => ({ ...command, id: command.commandId })),
        ...switches.map(change => ({ ...change, id: change.switchId }))];
    const byId = new Map(nodes.map(node => [node.id, node]));
    if (byId.size !== nodes.length) throw new TypeError('Duplicate command or switch identity.');
    for (const node of nodes) {
        const dependency = node.releaseDependency;
        if (!dependency) continue;
        if (!['action-start', 'action-end', 'damage-hit', 'timed-input'].includes(dependency.kind)
            || !byId.has(dependency.sourceCommandId)) {
            throw new TypeError(`Invalid release dependency for ${node.id}.`);
        }
        nonNegativeInteger(dependency.delayFrames, 'release dependency delay');
        if (dependency.kind === 'damage-hit') {
            if (typeof dependency.sourceSkillId !== 'string') throw new TypeError('Missing release source skill.');
            nonNegativeInteger(dependency.sourceTimelineFrame, 'release dependency source frame');
        }
        if (dependency.kind === 'timed-input') {
            if (node.switchId) throw new TypeError('A controller switch cannot consume a timed input window.');
            nonNegativeInteger(dependency.sourceOffsetFrames, 'release input offset');
            if (dependency.windowKind !== undefined) {
                if (!['broad', 'precision'].includes(dependency.windowKind)) throw new TypeError('Invalid release window kind.');
                const start = nonNegativeInteger(dependency.windowStartOffsetFrames, 'release window start');
                const end = nonNegativeInteger(dependency.windowEndOffsetFramesExclusive, 'release window end');
                if (end <= start) throw new TypeError('Empty release input window.');
            }
        }
        const visited = new Set([node.id]);
        let source = dependency.sourceCommandId;
        while (source) {
            if (visited.has(source)) throw new TypeError('Release dependency cycle.');
            visited.add(source);
            source = byId.get(source)?.releaseDependency?.sourceCommandId;
        }
    }
}

function damageLogFromTrace(trace, memberIdByCharacterId, statusTrace = []) {
    const buffIdByInstanceId = new Map(statusTrace.flatMap(entry => (
        entry.instanceId && entry.buffId ? [[entry.instanceId, entry.buffId]] : []
    )));
    const records = trace.map((entry, traceIndex) => ({ entry, traceIndex })).filter(({ entry }) =>
        entry.stage === 'ActionDelegated' && entry.type === 'ResolveDamagePacket'
    );
    return records.flatMap(({ entry, traceIndex }) => {
        const resolvedHits = entry.result?.resolution?.hits ?? [];
        const appliedHits = entry.result?.hits ?? [];
        return resolvedHits.map((hit, index) => {
            const applied = appliedHits[index]?.result ?? null;
            return {
                traceIndex,
                ...combatTriggerAttribution(entry),
                hitId: hit.hitId ?? `legacy-hit:${traceIndex}:${index}`,
                sequence: hit.sequence ?? traceIndex,
                statusEventSequenceBeforeHit: hit.statusEventSequenceBeforeHit ?? null,
                parentTransactionId: hit.parentTransactionId
                    ?? entry.transactionId
                    ?? null,
                parentEventId: hit.parentEventId ?? entry.parentEventId ?? null,
                frame: entry.frame,
                memberId: memberIdByCharacterId[entry.sourceId] ?? null,
                characterId: entry.sourceId,
                sourceId: entry.sourceId,
                ownerId: entry.ownerId,
                carrierId: hit.carrierId ?? entry.carrierId ?? entry.sourceId,
                damageSourceId: hit.damageSourceId
                    ?? entry.damageSourceId
                    ?? entry.sourceId,
                targetId: applied?.targetId
                    ?? applied?.record?.targetId
                    ?? entry.targetId,
                skillId: entry.skillId,
                rootSkillId: entry.rootSkillId,
                castId: entry.castId,
                rootCastId: entry.rootCastId ?? entry.castId,
                parentCastId: entry.parentCastId ?? null,
                inputSkillId: entry.inputSkillId ?? entry.rootSkillId,
                inputCommandType: entry.inputCommandType ?? null,
                effectiveSkillType: entry.effectiveSkillType ?? null,
                buffInstanceId: entry.buffInstanceId ?? null,
                sourceBuffInstanceId: hit.sourceBuffInstanceId
                    ?? entry.buffInstanceId
                    ?? null,
                sourceBuffId: hit.sourceBuffId
                    ?? buffIdByInstanceId.get(entry.buffInstanceId)
                    ?? null,
                semanticHitType: hit.semanticHitType ?? 'skill',
                displayName: hit.displayName ?? null,
                reason: entry.reason ?? entry.action?.reason ?? null,
                sourcePath: entry.action?.sourcePath ?? null,
                damageUnitIndex: hit.damageUnitIndex ?? index,
                damageType: hit.damageType,
                damageAttributeType: hit.damageAttributeType,
                damageDecorateMask: Number(hit.damageDecorateMask ?? 0),
                damageTypeMask: hit.damageTypeMask ?? null,
                atkScale: hit.operands?.atkScale ?? 0,
                rawDamage: hit.rawDamage ?? 0,
                nonCriticalDamage: hit.nonCriticalDamage ?? hit.finalDamage ?? hit.amount ?? 0,
                criticalDamage: hit.criticalDamage ?? hit.finalDamage ?? hit.amount ?? 0,
                expectedDamage: hit.expectedDamage ?? hit.finalDamage ?? hit.amount ?? 0,
                finalDamage: hit.damageAttributeType === 'Hp'
                    ? Number(hit.finalDamage ?? hit.amount ?? 0)
                    : 0,
                poiseDamage: ['Poise', 'Resilience'].includes(hit.damageAttributeType)
                    ? Number(hit.amount ?? hit.finalDamage ?? 0)
                    : 0,
                targetHpBefore: applied?.before ?? null,
                targetHpAfter: applied?.after ?? null,
                modifierSnapshot: clone(hit.modifierSnapshot ?? {}),
                operands: clone(hit.operands ?? {}),
                consumedStatuses: clone(hit.consumedStatuses ?? []),
                factors: clone(hit.factors ?? []),
                factorValidation: clone(hit.factorValidation ?? null),
                diagnostics: clone(hit.diagnostics ?? []),
                confidence: hit.confidence ?? (entry.result?.resolution?.status === 'Applied'
                    ? 'verified'
                    : 'partial'),
                application: clone(applied)
            };
        });
    });
}

function summaryByCharacter(hits, characterIds) {
    return Object.fromEntries(characterIds.map(characterId => {
        const selected = hits.filter(hit => hit.sourceId === characterId);
        return [characterId, {
            hitCount: selected.length,
            hpHitCount: selected.filter(hit => hit.damageAttributeType === 'Hp').length,
            poiseHitCount: selected.filter(hit =>
                ['Poise', 'Resilience'].includes(hit.damageAttributeType)).length,
            totalDamage: selected.reduce((sum, hit) =>
                sum + (hit.damageAttributeType === 'Hp' ? hit.finalDamage : 0), 0),
            totalPoiseDamage: selected.reduce((sum, hit) => sum + hit.poiseDamage, 0)
        }];
    }));
}

/**
 * Runs every squad member inside one CombatRuntime. Actor animation/admission
 * state stays per character; ATB, enemy state, Buffs and the event queue are
 * genuinely shared. Same-frame commands follow Calc's observed lexical UUID
 * order, independent of array insertion order.
 */
export class AkeSquadScenarioRunner {
    constructor(bundle, {
        commandQueueWindowFrames = 30,
        actionIdleExitFightFrames = 120,
        damageResolver = createAkeDamageResolver(),
        timeDilationResolver = null,
        commandAdmissionProvider = null,
        traceSink = null,
        maxDriverEvents = 100000,
        maxEventsPerRun = 10000
    } = {}) {
        if (!isRecord(bundle) || !(bundle.programs instanceof Map)
            || !Array.isArray(bundle.members) || bundle.members.length === 0) {
            throw new TypeError('AkeSquadScenarioRunner requires an assembled squad bundle.');
        }
        if (typeof damageResolver !== 'function') {
            throw new TypeError('damageResolver must be a function.');
        }
        if (timeDilationResolver !== null && typeof timeDilationResolver !== 'function') {
            throw new TypeError('timeDilationResolver must be a function or null.');
        }
        if (commandAdmissionProvider !== null
            && (typeof commandAdmissionProvider.profile !== 'function'
                || typeof commandAdmissionProvider.evaluate !== 'function')) {
            throw new TypeError(
                'commandAdmissionProvider must expose profile() and evaluate(), or be null.'
            );
        }
        if (traceSink !== null && typeof traceSink !== 'function') {
            throw new TypeError('traceSink must be a function or null.');
        }
        this.bundle = bundle;
        this.commandQueueWindowFrames = nonNegativeInteger(
            commandQueueWindowFrames,
            'commandQueueWindowFrames'
        );
        this.actionIdleExitFightFrames = positiveInteger(
            actionIdleExitFightFrames,
            'actionIdleExitFightFrames'
        );
        this.damageResolver = damageResolver;
        this.timeDilationResolver = timeDilationResolver
            ?? createAkeTimeDilationResolver({
                semanticMappings: bundle.semanticMappings ?? []
            });
        this.commandAdmissionProvider = commandAdmissionProvider
            ?? new CommandAdmissionProvider({
                semanticMappings: bundle.semanticMappings ?? []
            });
        this.traceSink = traceSink;
        this.maxDriverEvents = positiveInteger(maxDriverEvents, 'maxDriverEvents');
        this.maxEventsPerRun = positiveInteger(maxEventsPerRun, 'maxEventsPerRun');
        this.lastRuntime = null;
        this.lastComboMachine = null;
    }

    run({ commands = [], endFrame = null, initialControllerCharacterId = null, operatorSwitches = [], operationOrderVersion } = {}) {
        const { bundle } = this;
        const operationOrder = parseAkeOperationOrder({ commands, operatorSwitches, operationOrderVersion });
        const submittedCommands = normalizedCommands(commands, bundle, operationOrder);
        const resolveController = (id) => {
            const member = bundle.members.find(member => member.characterId === id || member.memberId === id);
            if (!member) throw new TypeError(`Controller is not a squad member: ${id}`);
            return member.characterId;
        };
        const initialController = resolveController(initialControllerCharacterId ?? bundle.members[0].characterId);
        if (!Array.isArray(operatorSwitches)) throw new TypeError('operatorSwitches must be an array.');
        const switches = operatorSwitches.map((entry, index) => ({
            ...clone(entry),
            switchId: entry.switchId ?? entry.id ?? `controller-switch:${index + 1}`,
            characterId: resolveController(entry.characterId ?? entry.memberId),
            frame: nonNegativeInteger(entry.frame, `operatorSwitches[${index}].frame`),
            ...(operationOrder.isV1 ? {} : {
                timelineOrder: Number.isFinite(entry.timelineOrder) ? entry.timelineOrder : -1,
            }),
        }));
        if (operationOrder.isV1) switches.sort((left, right) => left.frame - right.frame
            || operationOrder.compare(left, right));
        if (endFrame === null && switches.length) {
            throw new TypeError('A scenario with controller switches requires an explicit endFrame.');
        }
        for (const entry of switches) {
            if (!entry.releaseDependency && endFrame !== null && entry.frame > endFrame) {
                throw new TypeError('Controller switch exceeds endFrame.');
            }
        }
        validateReleaseDependencies(submittedCommands, switches);
        const controllerTrace = [];
        if (endFrame === null && submittedCommands.some(command => command.releaseDependency)) {
            throw new TypeError('A scenario with release dependencies requires an explicit endFrame.');
        }
        const enemyId = bundle.identity.enemyId;
        const commandTrace = [];
        const commandAdmissionTrace = [];
        const centerStateTrace = [];
        const comboTrace = [];
        const teamComboSettlementTrace = [];
        const localClockTriggerTrace = [];
        const seenClockTriggers = new Set();
        const states = new Map(bundle.members.map(member => [member.characterId, {
            member,
            characterId: member.characterId,
            memberId: member.memberId,
            actorClockDomainId: `${member.characterId}:clock`,
            roles: member.roles,
            currentSkill: null,
            centerState: 'Free',
            nextCastToken: 1,
            nextQueuedCommandToken: 1,
            queuedCommands: new Map()
        }]));
        let commandsSeen = 0;
        let fightStopped = false;
        let durationTicks = null;
        let fightStopScheduled = false;
        let comboMachine = null;
        let resolveSkillInterrupt = null;
        let resolveDerivedSkillCast = null;
        let resolveReleaseDependencies = null;

        const stateForEvent = eventContext => states.get(eventContext.sourceId)
            ?? states.get(eventContext.ownerId)
            ?? null;
        const rootSkillRolesFor = (actor, rootSkillId) => (
            actor?.roles?.heavyAttackId === rootSkillId ? ['heavy-attack'] : []
        );
        const observeStatusTransitionForCombos = transition => {
            if (!comboMachine) return;
            const actor = stateForEvent(transition);
            comboMachine.observe({
                eventType: transition.stage,
                frame: transition.frame,
                buffId: transition.buffId,
                sourceId: transition.sourceId,
                sourceSkillId: transition.sourceSkillId,
                rootSkillId: transition.rootSkillId,
                rootSkillRoles: rootSkillRolesFor(actor, transition.rootSkillId),
                sourceCommandType: transition.effectiveSkillType
                    ?? transition.skillType
                    ?? transition.commandType
                    ?? actor?.currentSkill?.commandType
                    ?? null,
                sourceCastId: transition.castId,
                targetId: transition.targetId,
                damageAttributeType: null,
                payload: { before: transition.before, after: transition.after,
                    actual: transition.actual, stackCount: transition.stackCount }
            }, {
                currentSkillId: actor?.currentSkill?.skillId ?? transition.rootSkillId,
                currentPriority: actor?.currentSkill?.priority ?? 0
            });
        };
        const resolver = parameters => {
            const actor = stateForEvent(parameters.eventContext);
            const targetId = parameters.eventContext.targetId;
            const targetState = parameters.runtime.poise.hasEntity(
                targetId
            )
                ? parameters.runtime.poise.snapshot(targetId)
                : null;
            const executionPacket = parameters.eventContext.rootSkillId
                === actor?.roles?.breakingAttackId
                && (parameters.action.damageUnits ?? []).some(unit =>
                    unit.calculationType === 'BreakingAttackCalculation'
                );
            const resolution = this.damageResolver(parameters);
            const execution = executionPacket && targetState?.broken
                ? parameters.runtime.execute({
                    type: 'ConsumePoiseExecution',
                    target: 'Target',
                    reservationId: parameters.eventContext.castId
                }, parameters.eventContext)
                : null;
            const hpHits = (resolution?.hits ?? []).filter(hit =>
                hit.damageAttributeType === 'Hp'
            );
            const poiseAmount = (resolution?.hits ?? [])
                .filter(hit => hit.damageAttributeType === 'Poise')
                .reduce((sum, hit) => sum + Number(hit.amount ?? hit.finalDamage ?? 0), 0);
            let localClockTrigger = null;
            let deferPoiseBreakTrigger = false;
            if (execution !== null) {
                localClockTrigger = 'ExecutionHit';
            } else if (targetState && !targetState.broken
                && poiseAmount >= targetState.remaining) {
                deferPoiseBreakTrigger = true;
            } else if (hpHits.length > 0 && targetState?.broken) {
                localClockTrigger = 'HpDamageWhileBroken';
            }
            if (localClockTrigger) {
                applyAkeLocalClockTrigger({
                    trigger: localClockTrigger,
                    eventContext: parameters.eventContext,
                    runtime: parameters.runtime,
                    semanticMappings: bundle.semanticMappings,
                    seen: seenClockTriggers,
                    trace: localClockTriggerTrace
                });
            }
            if (deferPoiseBreakTrigger) {
                const breakContext = clone(parameters.eventContext);
                parameters.runtime.schedule(
                    parameters.eventContext.frame,
                    90,
                    () => {
                        const committed = parameters.runtime.poise.snapshot(targetId);
                        if (!targetState.broken
                            && committed.broken
                            && committed.cycle === targetState.cycle) {
                            applyAkeLocalClockTrigger({
                                trigger: 'PoiseBreak',
                                eventContext: breakContext,
                                runtime: parameters.runtime,
                                semanticMappings: bundle.semanticMappings,
                                seen: seenClockTriggers,
                                trace: localClockTriggerTrace
                            });
                        }
                    },
                    'ake-poise-break-local-clock-trigger'
                );
            }
            for (const hit of resolution?.hits ?? []) {
                if (hit.damageAttributeType !== 'Hp') continue;
                comboMachine.observe({
                    eventType: 'BeforeHpDamage',
                    frame: parameters.eventContext.frame,
                    sourceId: parameters.eventContext.sourceId,
                    sourceSkillId: parameters.eventContext.skillId,
                    rootSkillId: parameters.eventContext.rootSkillId,
                    rootSkillRoles: rootSkillRolesFor(
                        actor,
                        parameters.eventContext.rootSkillId
                    ),
                    sourceCommandType: parameters.eventContext.effectiveSkillType
                        ?? parameters.eventContext.skillType
                        ?? parameters.eventContext.commandType
                        ?? actor?.currentSkill?.commandType
                        ?? null,
                    sourceCastId: parameters.eventContext.castId,
                    targetId: parameters.eventContext.targetId,
                    damageAttributeType: 'Hp',
                    damageUnitIndex: hit.damageUnitIndex
                }, {
                    currentSkillId: actor?.currentSkill?.skillId
                        ?? parameters.eventContext.rootSkillId,
                    currentPriority: actor?.currentSkill?.priority ?? 0
                });
            }
            if (hpHits.length > 0 && !parameters.eventContext.buffInstanceId) {
                resolveReleaseDependencies?.('damage-hit', parameters.eventContext);
            }
            return resolution;
        };
        const runtime = new CombatRuntime({
            tickRate: bundle.tickRate,
            definitions: bundle.definitions,
            damageResolver: resolver,
            skillProgramResolver: ({ skillId, eventContext, runtime: activeRuntime }) => {
                const program = bundle.programs.get(skillId);
                return program ? activeRuntime.resolveSkillProgram(program, {
                    ownerId: eventContext.ownerId ?? eventContext.sourceId,
                    skillId
                }) : null;
            },
            timeDilationResolver: this.timeDilationResolver,
            skillInterruptResolver: request => resolveSkillInterrupt?.(request) ?? ({
                status: 'Ignored',
                reason: 'CommandStateNotReady'
            }),
            onDerivedSkillCast: request => resolveDerivedSkillCast?.(request) ?? ({
                status: 'Ignored',
                reason: 'CommandStateNotReady'
            }),
            comboPendingTimeResolver: request => comboMachine?.resolveTimeControl(request) ?? ({
                status: 'Unresolved',
                reason: 'ComboTriggerMachineNotReady'
            }),
            comboPendingTriggerResolver: request => {
                if (!comboMachine) {
                    return {
                        status: 'Unresolved',
                        reason: 'ComboTriggerMachineNotReady'
                    };
                }
                const ownerState = states.get(request.ownerId);
                if (!ownerState) {
                    return {
                        status: 'Unresolved',
                        reason: 'ComboPendingOwnerUnknown'
                    };
                }
                const skillSlot = request.skillSlot ?? 'ComboSkill';
                const override = runtime.skillForms.resolveOverride({
                    targetId: request.ownerId,
                    skillSlot
                });
                const skillId = override?.targetSkillId
                    ?? baseRoleSkill(ownerState.roles, 'ComboSkill');
                if (!skillId) {
                    return {
                        status: 'Unresolved',
                        reason: 'ComboPendingSkillSlotUnresolved'
                    };
                }
                return comboMachine.trigger({
                    ...request,
                    skillId,
                    ruleId: request.triggerId
                }, {
                    currentSkillId: ownerState.currentSkill?.skillId
                        ?? request.rootSkillId,
                    currentPriority: ownerState.currentSkill?.priority ?? 0,
                    sourceActionType: request.metadata?.akeSourceAction ?? null,
                    sourceActionPath: request.metadata?.akeSourcePath ?? null
                });
            },
            onStatusTransition: observeStatusTransitionForCombos,
            onCombatEvent: event => {
                if (!comboMachine) return;
                const actor = stateForEvent(event);
                comboMachine.observe({ ...event, sourceSkillId: event.skillId,
                    sourceCastId: event.castId,
                    sourceCommandType: event.effectiveSkillType ?? event.skillType
                        ?? event.commandType ?? actor?.currentSkill?.commandType,
                    rootSkillRoles: rootSkillRolesFor(actor, event.rootSkillId)
                }, { currentSkillId: actor?.currentSkill?.skillId ?? event.skillId,
                    currentPriority: actor?.currentSkill?.priority ?? 0 });
            },
            traceSink: this.traceSink,
            maxEventsPerRun: this.maxEventsPerRun
        });
        controllerTrace.push(runtime.setMainCharacter(initialController, { frame: 0, reason: 'InitialController' }));
        const loadoutManager = new LoadoutEffectManager({ runtime });
        const loadoutInstallations = bundle.members.flatMap(member =>
            (member.loadoutEffects ?? []).map(effect => loadoutManager.install(effect, {
                frame: 0,
                ownerId: member.characterId,
                targetId: member.characterId,
                sourceId: member.characterId,
                clockDomainId: `${member.characterId}:clock`
            }))
        );
        const intrinsicPassiveInstallations = bundle.members.flatMap(member =>
            (member.intrinsicPassives ?? []).map(passive => ({
                memberId: member.memberId,
                characterId: member.characterId,
                skillId: passive.skillId,
                result: runtime.execute({
                    type: 'ApplyBuff',
                    target: member.characterId,
                    buffs: passive.buffs,
                    inheritEventBlackboard: false,
                    reason: 'IntrinsicPassive'
                }, {
                    frame: 0,
                    eventType: 'IntrinsicPassiveInstalled',
                    sourceId: member.characterId,
                    ownerId: member.characterId,
                    targetId: member.characterId,
                    skillId: passive.skillId,
                    rootSkillId: passive.skillId,
                    clockDomainId: `${member.characterId}:clock`,
                    blackboard: clone(passive.blackboard ?? {})
                })
            }))
        );
        const cooldownEnd = skillId => {
            for (const state of states.values()) {
                if (runtime.cooldowns.hasSkill(state.characterId, skillId)) {
                    return runtime.cooldowns.getEndFrame(state.characterId, skillId);
                }
            }
            return 0;
        };
        comboMachine = new ComboTriggerMachine({
            rules: bundle.semanticMappings.filter(mapping =>
                mapping.actionType === 'ComboTriggerRule'
                && (mapping.effect?.ownerBinding !== 'fixed'
                    || states.has(mapping.effect?.ownerId))
            ),
            schedule: runtime.schedule,
            trace: comboTrace,
            getCooldownEnd: cooldownEnd,
            evaluateCondition: (condition, eventContext) =>
                runtime.effects.evaluate(condition, eventContext),
            onPendingSetEmpty: event => runtime.notifyAbilityEvent({
                ...event,
                payload: {
                    reason: event.reason,
                    removedPending: event.removedPending
                }
            })
        });
        this.lastRuntime = runtime;
        this.lastComboMachine = comboMachine;

        const controllerAnchorWaits = new Map(switches.filter(entry => entry.releaseDependency)
            .map(entry => [entry.switchId, { change: entry, matched: false }]));
        const anchorWaits = new Map(submittedCommands.filter(command => command.releaseDependency)
            .map(command => [command.commandId, { command, matched: false }]));
        const queuedCommandCount = () => anchorWaits.size + [...states.values()].reduce(
            (sum, state) => sum + state.queuedCommands.size,
            0
        );
        const everyActorIdle = () => [...states.values()].every(state => !state.currentSkill);
        const scheduleFightStop = (frame, fromCompletedSkill = true) => {
            if (fightStopScheduled || endFrame !== null || queuedCommandCount() > 0
                || !everyActorIdle() || commandsSeen !== submittedCommands.length) return;
            fightStopScheduled = true;
            const stopFrame = frame + this.actionIdleExitFightFrames
                - (fromCompletedSkill ? 1 : 0);
            runtime.schedule(stopFrame, 1000, () => {
                runtime.notifyFightExit({
                    frame: stopFrame,
                    actorIds: [...states.values()].map(state => state.characterId),
                    targetId: enemyId,
                    reason: 'IdleFightStop'
                });
                fightStopped = true;
                durationTicks = stopFrame;
            }, 'idle-fight-stop');
        };
        const transition = (state, frame, to, reason) => {
            if (state.centerState === to) return;
            centerStateTrace.push({
                frame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId: state.currentSkill?.commandId ?? null,
                castId: state.currentSkill?.castId ?? null,
                from: state.centerState,
                to,
                reason
            });
            state.centerState = to;
        };
        const cancelProgram = (state, active, frame, reason) => {
            if (active?.scheduled?.castId) {
                runtime.cancelCastPrograms(active.scheduled.castId, frame, reason);
            }
            for (const derived of active?.derivedCasts ?? []) {
                if (derived.childCastId) {
                    runtime.cancelCastPrograms(derived.childCastId, frame, reason);
                }
            }
            if (active?.naturalEndTimerId) {
                runtime.clockDomains.cancelTimer(
                    state.actorClockDomainId,
                    active.naturalEndTimerId,
                    frame,
                    reason
                );
            }
            if (active?.attackChainTimerId) {
                runtime.clockDomains.cancelTimer(
                    state.actorClockDomainId,
                    active.attackChainTimerId,
                    frame,
                    reason
                );
            }
        };
        const finishCurrentSkill = (state, frame, completion) => {
            if (!state.currentSkill) return;
            const finished = state.currentSkill;
            transition(state, frame, 'Free', `skill-end:${finished.skillId}:${completion}`);
            runtime.finishSkillActionLifetimes({
                frame,
                actorId: state.characterId,
                skillId: finished.skillId,
                castId: finished.castId,
                reason: `Skill${completion}`
            }, {
                frame,
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                skillId: finished.skillId,
                rootSkillId: finished.skillId,
                castId: finished.castId,
                rootCastId: finished.castId,
                inputSkillId: finished.inputSkillId ?? finished.skillId,
                inputCommandType: finished.commandType,
                effectiveSkillType: finished.effectiveSkillType ?? finished.commandType,
                commandType: finished.commandType,
                skillType: finished.effectiveSkillType ?? finished.commandType,
                clockDomainId: state.actorClockDomainId
            });
            if (completion !== 'Completed') {
                cancelProgram(state, finished, frame, `Skill${completion}`);
            }
            runtime.statusEffects.finish({
                frame,
                metadata: { attachedToCastId: finished.castId },
                reason: `Skill${completion}`
            }, {
                frame,
                eventType: 'OnAfterCastSkill',
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                skillId: finished.skillId,
                rootSkillId: finished.skillId,
                castId: finished.castId,
                rootCastId: finished.castId,
                inputSkillId: finished.inputSkillId ?? finished.skillId,
                inputCommandType: finished.commandType,
                effectiveSkillType: finished.effectiveSkillType ?? finished.commandType,
                commandType: finished.commandType,
                skillType: finished.effectiveSkillType ?? finished.commandType,
                clockDomainId: state.actorClockDomainId
            });
            if (finished.commandType === 'BreakingAttack') {
                runtime.poise.releaseExecutionReservation({
                    targetId: enemyId,
                    reservationId: finished.castId,
                    frame,
                    reason: `Skill${completion}`
                });
            }
            state.currentSkill = null;
            resolveReleaseDependencies?.('action-end', { frame, commandId: finished.commandId,
                castId: finished.castId, skillId: finished.skillId, completion });
            if (completion === 'Completed') scheduleFightStop(frame, true);
        };
        resolveSkillInterrupt = request => {
            const state = stateForEvent(request.eventContext);
            if (!state?.currentSkill) {
                return { status: 'Ignored', reason: 'NoActiveSkill' };
            }
            const skillId = state.currentSkill.skillId;
            finishCurrentSkill(state, request.eventContext.frame, 'Interrupted');
            return {
                status: 'Interrupted',
                memberId: state.memberId,
                characterId: state.characterId,
                skillId,
                frame: request.eventContext.frame
            };
        };
        const failCommand = (state, command, frame, reason, skillId = null,
            skillSource = null) => {
            commandTrace.push({
                type: 'CommandExecuted',
                frame,
                requestedFrame: command.requestedFrame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId: command.commandId,
                commandType: command.commandType,
                skillId,
                success: false,
                reason,
                skillSource
            });
        };
        const canPay = (state, skill, frame) => {
            const amount = Number(skill.costValue ?? 0);
            return amount <= 0 || runtime.resources.canPay(
                poolRef(skill.costType, state.characterId),
                amount,
                frame
            );
        };
        const scheduleNaturalEnd = (state, active, frame, durationTicks, reason) => {
            if (active.naturalEndTimerId) {
                runtime.clockDomains.cancelTimer(
                    state.actorClockDomainId,
                    active.naturalEndTimerId,
                    frame,
                    `SkillNaturalEndRescheduled:${reason}`
                );
            }
            active.naturalEndGeneration += 1;
            active.plannedNaturalEndFrame = frame + Math.max(0, Math.trunc(durationTicks));
            active.plannedNaturalEndLocalFrame = runtime.clockDomains.localFrameAt(
                state.actorClockDomainId, frame
            ) + Math.max(0, Math.trunc(durationTicks));
            const timerId = `command-skill:${state.memberId}:${active.token}:natural-end:${active.naturalEndGeneration}`;
            active.naturalEndTimerId = runtime.clockDomains.startTimer(
                state.actorClockDomainId,
                {
                    id: timerId,
                    frame,
                    durationTicks: Math.max(0, nonNegativeInteger(
                        Math.trunc(durationTicks),
                        'skill natural-end duration'
                    )),
                    priority: 80,
                    sourceId: state.characterId,
                    ownerId: state.characterId,
                    targetId: enemyId,
                    skillId: active.skillId,
                    rootSkillId: active.skillId,
                    reason: 'SkillNaturalEnd',
                    label: `${active.skillId}:natural-end`,
                    onComplete: completionFrame => {
                        if (state.currentSkill?.token === active.token) {
                            finishCurrentSkill(state, completionFrame, 'Completed');
                        }
                    }
                }
            );
        };
        resolveDerivedSkillCast = request => {
            const state = states.get(request.casterId) ?? null;
            const active = state?.currentSkill ?? null;
            if (!state || !active) {
                return { status: 'Ignored', reason: 'NoActiveCommandSkill' };
            }
            if (request.rootCastId !== active.castId
                && request.parentCastId !== active.castId) {
                return {
                    status: 'Ignored',
                    reason: 'DerivedSkillRootCastMismatch',
                    activeCastId: active.castId,
                    rootCastId: request.rootCastId,
                    parentCastId: request.parentCastId
                };
            }
            const derived = {
                childCastId: request.childCastId,
                parentCastId: request.parentCastId,
                inputSkillId: request.inputSkillId,
                executedSkillId: request.executedSkillId,
                effectiveSkillType: request.effectiveSkillType,
                launchFrame: request.launchFrame,
                scheduled: clone(request.scheduled)
            };
            active.derivedCasts.push(derived);
            active.executedSkillId = request.executedSkillId;
            active.effectiveSkillType = request.effectiveSkillType;
            active.controlExecutionId = request.scheduled.executionId;
            if (request.effectiveSkillType) {
                const controlType = request.effectiveSkillType === 'NormalAttack'
                    ? 'Attack' : request.effectiveSkillType;
                active.priority = this.commandAdmissionProvider.profile(controlType).priority;
            }
            if (!active.teamComboSettlementResolved) {
                active.settlementCastId = request.childCastId;
                active.settlementParentCastId = request.parentCastId;
            }
            const derivedEndFrame = request.launchFrame
                + skillNaturalEndOffset(request.program);
            if (derivedEndFrame > (active.plannedNaturalEndFrame ?? active.startFrame)) {
                scheduleNaturalEnd(
                    state,
                    active,
                    request.launchFrame,
                    skillNaturalEndOffset(request.program),
                    `DerivedSkill:${String(request.executedSkillId)}`
                );
            }
            return {
                status: 'Attached',
                memberId: state.memberId,
                characterId: state.characterId,
                rootCastId: active.castId,
                childCastId: request.childCastId,
                executedSkillId: request.executedSkillId,
                effectiveSkillType: request.effectiveSkillType,
                naturalEndFrame: active.plannedNaturalEndFrame
            };
        };
        const beginSkill = (state, frame, commandType, skillId, skillSource,
            commandId = null, options = {}) => {
            const skill = runtime.resolveSkillProgram(bundle.programs.get(skillId), {
                ownerId: state.characterId,
                skillId
            });
            if (!skill) throw new Error(`Missing compiled SkillData ${skillId}.`);
            const commandProfile = this.commandAdmissionProvider.profile(commandType);
            const desiredState = commandProfile.centerState;
            const previous = state.currentSkill;
            if (previous && options.chainContinuation) {
                cancelProgram(state, previous, frame, 'FullAttackComboNextStage');
            } else {
                if (previous && commandProfile.transitionBeforeInterrupt
                    && state.centerState !== desiredState) {
                    transition(state, frame, desiredState, `command:${commandType}`);
                }
                if (previous) finishCurrentSkill(state, frame,
                    runtime.clockDomains.localFrameAt(state.actorClockDomainId, frame)
                        >= previous.plannedNaturalEndLocalFrame ? 'Completed' : 'Interrupted');
                if (!previous) transition(state, frame, desiredState, `command:${commandType}`);
                else transition(state, frame, desiredState, `skill-start:${skillId}`);
            }

            const token = state.nextCastToken++;
            const startLocalFrame = runtime.clockDomains.localFrameAt(
                state.actorClockDomainId,
                frame
            );
            const castId = options.castId ?? `command-cast:${state.memberId}:${token}`;
            if (commandType === 'BreakingAttack') {
                const reservation = runtime.poise.reserveExecution({
                    targetId: enemyId,
                    reservationId: castId,
                    frame,
                    sourceId: state.characterId,
                    ownerId: state.characterId,
                    skillId,
                    rootSkillId: skillId,
                    castId,
                    commandId
                });
                if (reservation === null) {
                    throw new Error('BreakingAttack lost its poise execution gate before cast start.');
                }
            }
            runtime.beginSkillActionLifetimes({
                frame,
                actorId: state.characterId,
                skillId,
                castId,
                reason: 'CommandSkillStarted'
            }, {
                frame,
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                mainCharacterId: runtime.mainCharacterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                rootCastId: castId,
                inputSkillId: skillId,
                inputCommandType: commandType,
                effectiveSkillType: skill.effectiveSkillType ?? commandType,
                commandType,
                skillType: skill.effectiveSkillType ?? commandType,
                castId,
                clockDomainId: state.actorClockDomainId
            });
            runtime.execute({
                type: 'TriggerStatusEvent',
                target: state.characterId,
                eventType: 'OnBeforeCastSkill',
                reason: 'OnBeforeCastSkill'
            }, {
                frame,
                eventType: 'OnBeforeCastSkill',
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                mainCharacterId: runtime.mainCharacterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                rootCastId: castId,
                inputSkillId: skillId,
                inputCommandType: commandType,
                effectiveSkillType: skill.effectiveSkillType ?? commandType,
                commandType,
                skillType: skill.effectiveSkillType ?? commandType,
                castId,
                clockDomainId: state.actorClockDomainId,
                payload: { commandType, skillType: commandType }
            });
            const scheduled = runtime.scheduleProgram(skill, {
                frame,
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                mainCharacterId: runtime.mainCharacterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                rootCastId: castId,
                inputSkillId: skillId,
                inputCommandType: commandType,
                effectiveSkillType: skill.effectiveSkillType ?? commandType,
                commandType,
                skillType: skill.effectiveSkillType ?? commandType,
                castId,
                clockDomainId: state.actorClockDomainId,
                skillActionLifetimesResolved: true,
                onTimelineSeek: seek => {
                    if (state.currentSkill?.token !== token) return;
                    state.currentSkill.timelineAnchorFrame = seek.destFrame;
                    state.currentSkill.timelineAnchorLocalFrame = runtime.clockDomains.localFrameAt(
                        state.actorClockDomainId,
                        seek.frame
                    );
                    scheduleNaturalEnd(
                        state,
                        state.currentSkill,
                        seek.frame,
                        Math.max(0, skillNaturalEndOffset(skill) - seek.destFrame),
                        `TimelineSeek:${seek.sourceTimelineFrame}->${seek.destFrame}`
                    );
                },
                onInterruptible: mark => {
                    if (state.currentSkill?.token !== token) return;
                    state.currentSkill.interruptible = true;
                    state.currentSkill.interruptibleFrame = mark.frame;
                }
            });
            state.currentSkill = {
                token,
                commandId,
                castId,
                skillId,
                inputSkillId: skillId,
                executedSkillId: skillId,
                effectiveSkillType: skill.effectiveSkillType ?? commandType,
                settlementCastId: castId,
                settlementParentCastId: null,
                teamComboSettlementResolved: false,
                skill,
                commandType,
                startFrame: frame,
                startLocalFrame,
                timelineAnchorFrame: 0,
                timelineAnchorLocalFrame: startLocalFrame,
                interruptible: false,
                interruptibleFrame: null,
                priority: commandProfile.priority,
                scheduled,
                naturalEndTimerId: null,
                naturalEndGeneration: 0,
                plannedNaturalEndFrame: null,
                derivedCasts: [],
                attackChainId: options.attackChainId ?? null,
                attackStageIndex: options.attackStageIndex ?? null,
                attackChainTimerId: null
            };

            const cost = Number(skill.costValue ?? 0);
            if (cost > 0) {
                runtime.resources.spend({
                    frame,
                    poolRef: poolRef(skill.costType, state.characterId),
                    amount: cost,
                    sourceId: state.characterId,
                    ownerId: state.characterId,
                    targetId: skill.costType === 'Atb' ? null : state.characterId,
                    reason: 'CastCost',
                    commandId,
                    castId,
                    skillId,
                    resourceSourceType: 'Skill',
                    resourceGainMethod: 'Spend'
                });
            }
            if (Number(skill.cooldownTicks) > 0) {
                runtime.cooldowns.start({
                    frame,
                    memberId: state.memberId,
                    actorId: state.characterId,
                    skillId,
                    skillType: commandType === 'Attack' ? 'NormalAttack' : commandType,
                    durationTicks: Number(skill.cooldownTicks),
                    commandId,
                    castId,
                    reason: 'SkillCast'
                });
            }
            if (options.traceCommand !== false) {
                commandTrace.push({
                    type: 'CommandExecuted',
                    frame,
                    requestedFrame: submittedCommands.find(command =>
                        command.commandId === commandId)?.requestedFrame ?? frame,
                    memberId: state.memberId,
                    characterId: state.characterId,
                    commandId,
                    castId,
                    commandType,
                    skillId,
                    success: true,
                    skillSource
                });
            }
            scheduleNaturalEnd(
                state,
                state.currentSkill,
                frame,
                Math.max(0, Number(
                    options.naturalEndTicks ?? skillNaturalEndOffset(skill)
                )),
                'InitialSchedule'
            );
            if (options.traceCommand !== false) {
                resolveReleaseDependencies?.('action-start', { frame, commandId,
                    castId, skillId, characterId: state.characterId });
            }
            return state.currentSkill;
        };

        // Command callbacks run at priority 70, while cast-start actions run at
        // priority 0 and damage timeline groups at priority 1.  Resolve the
        // action's settlement identity between those phases so a same-frame
        // CastSkill wrapper can attach its real child program before shared
        // combo eligibility is decided, while ordinary B/Q still consume at
        // action start before any Hit is evaluated.
        const scheduleTeamComboSettlement = (state, active, frame) => {
            runtime.schedule(frame, 0.5, () => {
                if (active.teamComboSettlementResolved) return;
                active.teamComboSettlementResolved = true;
                const effectiveSkillType = active.effectiveSkillType
                    ?? active.commandType;
                const settlementCastId = active.settlementCastId ?? active.castId;
                const settlementParentCastId = active.settlementParentCastId ?? null;
                const eligible = ['NormalSkill', 'UltimateSkill'].includes(
                    effectiveSkillType
                );
                const settlement = {
                    frame,
                    sequence: teamComboSettlementTrace.length + 1,
                    memberId: state.memberId,
                    characterId: state.characterId,
                    commandId: active.commandId,
                    rootCastId: active.castId,
                    castId: settlementCastId,
                    parentCastId: settlementParentCastId,
                    inputSkillId: active.inputSkillId,
                    inputCommandType: active.commandType,
                    executedSkillId: active.executedSkillId,
                    effectiveSkillType,
                    eligible,
                    consumptionStatus: 'Ineligible',
                    consumedStacks: 0,
                    grantIds: []
                };
                if (eligible) {
                    const consumed = runtime.consumeTeamComboState({
                        frame,
                        consumerId: state.characterId,
                        targetId: enemyId,
                        inputCommandType: active.commandType,
                        commandType: active.commandType,
                        effectiveSkillType,
                        skillType: effectiveSkillType,
                        inputSkillId: active.inputSkillId,
                        executedSkillId: active.executedSkillId,
                        skillId: active.executedSkillId,
                        rootSkillId: active.inputSkillId,
                        castId: settlementCastId,
                        rootCastId: active.castId,
                        parentCastId: settlementParentCastId,
                        reason: 'TeamComboConsumedByEffectiveSkill'
                    });
                    settlement.consumptionStatus = consumed.status;
                    settlement.consumedStacks = consumed.consumedStacks;
                    settlement.grantIds = clone(consumed.grantIds ?? []);
                }
                teamComboSettlementTrace.push(settlement);
            }, `team-combo-settlement:${state.memberId}:${String(active.commandId)}`);
        };

        const beginFullAttackCombo = (state, command, frame, skillId, skillSource) => {
            const chain = fullAttackChain(skillId, bundle.programs);
            if (chain.length < 2) {
                beginSkill(
                    state,
                    frame,
                    command.commandType,
                    skillId,
                    skillSource,
                    command.commandId
                );
                return;
            }
            const chainId = `${state.memberId}:${command.commandId}:full-attack:${frame}`;
            const sharedCastId = `command-cast:${state.memberId}:${state.nextCastToken}`;
            const startStage = (stageIndex, stageFrame, traceCommand, chainContinuation) => {
                const stageSkillId = chain[stageIndex];
                const stageSkill = runtime.resolveSkillProgram(
                    bundle.programs.get(stageSkillId),
                    { ownerId: state.characterId, skillId: stageSkillId }
                );
                const nextSkillId = chain[stageIndex + 1] ?? null;
                const naturalEndTicks = attackTransitionOffset(
                    stageSkill,
                    nextSkillId ?? chain[0]
                );
                const active = beginSkill(
                    state,
                    stageFrame,
                    'Attack',
                    stageSkillId,
                    traceCommand ? skillSource : 'full-attack-combo-stage',
                    command.commandId,
                    {
                        traceCommand,
                        chainContinuation,
                        castId: sharedCastId,
                        attackChainId: chainId,
                        attackStageIndex: stageIndex,
                        naturalEndTicks
                    }
                );
                if (!nextSkillId) return;
                const timerId = `full-attack:${state.memberId}:${command.commandId}:stage:${stageIndex + 1}`;
                active.attackChainTimerId = runtime.clockDomains.startTimer(
                    state.actorClockDomainId,
                    {
                        id: timerId,
                        frame: stageFrame,
                        durationTicks: naturalEndTicks,
                        priority: 70,
                        sourceId: state.characterId,
                        ownerId: state.characterId,
                        targetId: enemyId,
                        skillId: stageSkillId,
                        rootSkillId: chain[0],
                        reason: 'FullAttackComboNextStage',
                        label: `${command.commandId}:attack-stage-${stageIndex + 2}`,
                        onComplete: completionFrame => {
                            const current = state.currentSkill;
                            if (current?.attackChainId !== chainId
                                || current.attackStageIndex !== stageIndex) return;
                            startStage(stageIndex + 1, completionFrame, false, true);
                        }
                    }
                );
            };
            startStage(0, frame, true, false);
        };
        const timelineFrameAt = (state, active, frame) => {
            const localFrame = runtime.clockDomains.localFrameAt(
                state.actorClockDomainId,
                frame
            );
            return active.timelineAnchorFrame
                + (localFrame - active.timelineAnchorLocalFrame);
        };
        const currentSkillControl = (state, frame) => {
            const active = state.currentSkill;
            if (!active) return null;
            const control = active.controlExecutionId
                ? runtime.getSkillProgramControl(active.controlExecutionId, frame) : null;
            return control ? { ...active, ...control } : {
                ...active, timelineFrame: timelineFrameAt(state, active, frame)
            };
        };
        runtime.currentSkillResolver = ({ targetId, frame }) => {
            const state = states.get(targetId);
            const active = state?.currentSkill;
            // Commands run before natural-end callbacks on the same frame.
            // A completed occupation must not satisfy "currently casting".
            if (!active || runtime.clockDomains.localFrameAt(state.actorClockDomainId, frame)
                >= active.plannedNaturalEndLocalFrame) return null;
            return currentSkillControl(state, frame);
        };
        const admission = (state, commandType, skillId, frame, commandId = null) => {
            const control = currentSkillControl(state, frame);
            const decision = this.commandAdmissionProvider.evaluate({
                commandType,
                skillId,
                currentSkill: control,
                timelineFrame: control?.timelineFrame ?? 0
            });
            commandAdmissionTrace.push({
                frame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId,
                currentInputSkillId: state.currentSkill?.inputSkillId ?? null,
                currentInputCommandType: state.currentSkill?.commandType ?? null,
                currentCastId: control?.castId ?? null,
                ...clone(decision)
            });
            return decision.accepted ? null : decision;
        };
        const expireQueuedCommand = (state, queued, frame,
            reason = 'QUEUE_WINDOW_EXPIRED') => {
            if (!queued.active) return false;
            queued.active = false;
            state.queuedCommands.delete(queued.token);
            commandTrace.push({
                type: 'CommandExpired',
                frame,
                requestedFrame: queued.command.requestedFrame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId: queued.command.commandId,
                commandType: queued.command.commandType,
                skillId: queued.skillId,
                success: false,
                reason
            });
            scheduleFightStop(frame, false);
            return true;
        };
        let executeCommand;
        const queueCommand = (state, command, frame, skillId, gate) => {
            const token = state.nextQueuedCommandToken++;
            const queued = {
                token,
                command: clone(command),
                skillId,
                submittedFrame: command.requestedFrame,
                queueWindowFrames: commandUsesSequenceQueue(command)
                    ? null
                    : this.commandQueueWindowFrames,
                active: true,
                eligibilityTimerId: null
            };
            state.queuedCommands.set(token, queued);
            const localDelay = Math.max(0, Math.ceil(
                gate.nextTimelineFrame - gate.timelineFrame
            ));
            commandTrace.push({
                type: 'CommandQueued',
                frame,
                requestedFrame: command.requestedFrame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId: command.commandId,
                commandType: command.commandType,
                skillId,
                executeFrame: frame + localDelay,
                reason: 'CENTER_STATE_BLOCKED',
                admissionReason: gate.reason
            });
            if (queued.queueWindowFrames !== null) {
                runtime.schedule(
                    command.requestedFrame + queued.queueWindowFrames,
                    69,
                    () => expireQueuedCommand(
                        state,
                        queued,
                        command.requestedFrame + queued.queueWindowFrames
                    ),
                    `queued-command:${state.memberId}:${token}:expiry`
                );
            }
            queued.eligibilityTimerId = runtime.clockDomains.startTimer(
                state.actorClockDomainId,
                {
                    id: `queued-command:${state.memberId}:${token}:eligibility`,
                    frame,
                    durationTicks: localDelay,
                    priority: 70,
                    sourceId: state.characterId,
                    ownerId: state.characterId,
                    targetId: enemyId,
                    skillId,
                    rootSkillId: state.currentSkill?.skillId ?? null,
                    reason: 'QueuedCommandEligibility',
                    label: `${command.commandType}:queued`,
                    onComplete: completionFrame => {
                        if (!queued.active) return;
                        if (queued.queueWindowFrames !== null
                            && completionFrame - queued.submittedFrame
                            >= queued.queueWindowFrames) {
                            expireQueuedCommand(state, queued, completionFrame);
                            return;
                        }
                        queued.active = false;
                        state.queuedCommands.delete(token);
                        executeCommand(
                            state,
                            queued.command,
                            completionFrame,
                            true,
                            commandUsesSequenceQueue(queued.command)
                                ? null
                                : queued.command.skillId ?? null,
                            true
                        );
                    }
                }
            );
        };

        executeCommand = (state, command, frame, fromQueue = false,
            forcedSkillId = null, allowQueue = true) => {
            let skillId = null;
            let skillSource = null;
            let comboGate = null;
            const plungingImpact = isPlungingImpactInput(command);
            if (plungingImpact) {
                const rejection = plungingImpactInputRejection({ roles: state.roles,
                    actorId: state.characterId, mainCharacterId: runtime.mainCharacterId });
                if (rejection) { failCommand(state, command, frame, rejection); return; }
            }
            // Timeline buttons represent the player's A/B/E/Q intent.  Their
            // cached skill id is only a display hint: queued commands must be
            // resolved again against the form state that is active when they
            // actually execute (for example an ultimate-enhanced normal skill).
            const explicitSkillId = plungingImpact ? state.roles.plungingAttackEndId : forcedSkillId ?? (
                commandUsesSequenceQueue(command) ? null : command.skillId ?? null
            );
            const skillSlot = skillSlotForCommand(command.commandType);
            const override = skillSlot ? runtime.skillForms.resolveOverride({
                targetId: state.characterId,
                skillSlot
            }) : null;
            const modeSkillId = command.commandType === 'Attack'
                ? modeAttackSkill(
                    state.roles,
                    bundle.programs,
                    runtime.skillForms.activeModes(state.characterId)
                )
                : null;
            // ComboCacheAction can register more than one concrete skill for
            // the same input button.  It is a cache of legal successors, not
            // an instruction to always choose the first serialized entry.
            // Resolve the current form/mode inside that candidate set before
            // falling back to the first mapping.  This keeps the input button
            // (B/E/Q/A) separate from the skill that actually settles.
            const comboMappedSkillId = mappedSkill(
                currentSkillControl(state, frame)?.skill,
                command.commandType,
                [override?.targetSkillId, modeSkillId]
            );
            const comboMappingSource = comboMappedSkillId === override?.targetSkillId
                ? 'skill-form-override'
                : comboMappedSkillId === modeSkillId
                    ? 'skill-mode'
                    : 'combo-mapping';
            skillId = explicitSkillId
                ?? comboMappedSkillId
                ?? override?.targetSkillId
                ?? modeSkillId
                ?? baseRoleSkill(state.roles, command.commandType);
            skillSource = plungingImpact ? 'plunging-impact-capability' : explicitSkillId
                ? (fromQueue ? 'next-skill-request' : 'explicit-request')
                : comboMappedSkillId
                    ? comboMappingSource
                    : override
                        ? 'skill-form-override'
                        : modeSkillId
                            ? 'skill-mode'
                            : 'character-template';

            if (command.commandType === 'ComboSkill') {
                const requiresPending = comboMachine.isManagedSkill({
                    ownerId: state.characterId,
                    skillId
                });
                if (requiresPending) {
                    comboGate = comboMachine.gate({
                        frame,
                        skillId,
                        ownerId: state.characterId,
                        targetId: command.targetId ?? enemyId,
                        cooldownEnd: runtime.cooldowns.getEndFrame(
                            state.characterId,
                            skillId
                        ),
                        currentSkillId: state.currentSkill?.skillId ?? null,
                        currentPriority: state.currentSkill?.priority ?? 0,
                        commandId: command.commandId
                    });
                    if (!comboGate.ready) {
                        failCommand(state, command, frame, 'COMBO_NOT_READY', skillId, skillSource);
                        return;
                    }
                }
            } else if (![
                'Attack', 'NormalSkill', 'UltimateSkill', 'BreakingAttack'
            ].includes(command.commandType)) {
                failCommand(state, command, frame, 'UNSUPPORTED_COMMAND');
                return;
            }
            if (command.commandType === 'BreakingAttack' && !explicitSkillId) {
                skillSource = 'execution-request';
            }
            if (!skillId) {
                failCommand(state, command, frame, 'SKILL_ROLE_UNAVAILABLE');
                return;
            }
            if (command.commandType === 'BreakingAttack') {
                const hasPoise = runtime.poise.hasEntity(enemyId);
                const poiseState = hasPoise ? runtime.poise.snapshot(enemyId) : null;
                if (!hasPoise || !runtime.poise.canExecute(enemyId)) {
                    failCommand(
                        state,
                        command,
                        frame,
                        poiseState?.broken
                            ? (poiseState.executionReservation
                                ? 'EXECUTION_RESERVED'
                                : 'EXECUTION_ALREADY_CONSUMED')
                            : 'TARGET_NOT_BROKEN',
                        skillId,
                        'poise-execution-gate'
                    );
                    return;
                }
                skillSource = 'poise-execution-gate';
            }
            const skill = runtime.resolveSkillProgram(bundle.programs.get(skillId), {
                ownerId: state.characterId,
                skillId
            });
            if (!skill) throw new Error(`Missing compiled SkillData ${skillId}.`);
            const replacementContext = { frame, sourceId: state.characterId,
                ownerId: state.characterId, targetId: enemyId, memberId: state.memberId,
                commandId: command.commandId, skillId, commandType: command.commandType,
                clockDomainId: state.actorClockDomainId, blackboard: clone(skill.blackboard ?? {}) };
            const replacesCast = canReplaceAkeSkillCast(runtime, skill, replacementContext);
            const admissionGate = replacesCast ? null : admission(
                state,
                command.commandType,
                skillId,
                frame,
                command.commandId
            );
            if (admissionGate) {
                if (plungingImpact) failCommand(state, command, frame, 'PLUNGING_IMPACT_BLOCKED', skillId, skillSource);
                else if (allowQueue) queueCommand(state, command, frame, skillId, admissionGate);
                else failCommand(
                    state,
                    command,
                    frame,
                    command.releaseDependency ? 'RELEASE_ANCHOR_BLOCKED' : 'QUEUED_COMMAND_STILL_BLOCKED',
                    skillId,
                    skillSource
                );
                return;
            }

            const skillCooldownEnd = runtime.cooldowns.getEndFrame(
                state.characterId,
                skillId
            );
            if (skillCooldownEnd > frame && !comboGate?.pending?.bypassSkillCooldown) {
                failCommand(state, command, frame, 'COOLDOWN_ACTIVE', skillId, skillSource);
                return;
            }
            if (!canPay(state, skill, frame)) {
                failCommand(state, command, frame, 'INSUFFICIENT_RESOURCE', skillId, skillSource);
                return;
            }
            runtime.resolveTimedInput({
                frame,
                actorId: state.characterId,
                inputType: command.commandType,
                skillId,
                commandId: command.commandId
            });
            if (replacesCast) {
                const castId = `command-cast:${state.memberId}:${state.nextCastToken++}`;
                executeAkeSkillCastReplacement(runtime, skill, { ...replacementContext, castId });
                commandTrace.push({ type: 'CommandExecuted', frame,
                    requestedFrame: command.requestedFrame, memberId: state.memberId,
                    characterId: state.characterId, commandId: command.commandId, castId,
                    commandType: command.commandType, skillId, skillSource: 'switch-to-buff',
                    success: true, endFrame: frame, completion: 'Completed',
                    preservedCastId: state.currentSkill?.castId ?? null });
                resolveReleaseDependencies?.('action-start', { frame, commandId: command.commandId, castId, skillId });
                resolveReleaseDependencies?.('action-end', { frame, commandId: command.commandId, castId, skillId });
                scheduleTeamComboSettlement(state, { castId, commandId: command.commandId,
                    commandType: command.commandType, inputSkillId: skillId, executedSkillId: skillId,
                    effectiveSkillType: skill.effectiveSkillType ?? command.commandType }, frame);
                if (command.commandType === 'ComboSkill' && comboGate?.pending) {
                    comboMachine.consume({ frame, pendingId: comboGate.pending.id,
                        currentSkillId: skillId, currentPriority: state.currentSkill?.priority ?? 0,
                        commandId: command.commandId, castId });
                }
                return;
            }
            if (command.commandType === 'Attack' && command.attackMode === 'full-combo') {
                beginFullAttackCombo(state, command, frame, skillId, skillSource);
            } else {
                const active = beginSkill(
                    state,
                    frame,
                    command.commandType,
                    skillId,
                    skillSource,
                    command.commandId
                );
                scheduleTeamComboSettlement(state, active, frame);
            }
            if (command.commandType === 'ComboSkill' && comboGate?.pending) {
                comboMachine.consume({
                    frame,
                    pendingId: comboGate.pending.id,
                    currentSkillId: state.currentSkill.skillId,
                    currentPriority: state.currentSkill.priority,
                    commandId: command.commandId,
                    castId: state.currentSkill.castId
                });
            }
        };

        const applyControllerSwitch = (change, frame) => {
            controllerTrace.push(runtime.setMainCharacter(change.characterId,
                { frame, switchId: change.switchId, reason: 'TimelineOperatorSwitch' }));
            const context = { frame, commandId: change.switchId };
            resolveReleaseDependencies?.('action-start', context);
            resolveReleaseDependencies?.('action-end', context);
        };
        const validateTimedInputDependency = (command, dependency, context, frame) => {
            // Legacy anchors only stored an offset from source start. Preserve
            // that relation, but do not invent precision guarantees for them.
            if (!dependency.windowKind) return null;
            const offset = frame - context.frame;
            if (offset < dependency.windowStartOffsetFrames
                || offset >= dependency.windowEndOffsetFramesExclusive) return 'RELEASE_WINDOW_EXPIRED';
            if (dependency.windowKind === 'precision') {
                const windows = runtime.timedInputWindowSnapshot(frame).filter(window => (
                    (window.sourceCommandId === dependency.sourceCommandId
                        || (!window.sourceCommandId && window.castId === context.castId))
                    && window.ownerId === command.characterId
                    && (!dependency.sourceSkillId || window.sourceSkillId === dependency.sourceSkillId)
                    && window.inputTypes.includes(command.commandType)
                ));
                return windows.some(window => window.state === 'open' && window.sourceActive
                    && window.inActiveInterval) ? null : 'RELEASE_WINDOW_NOT_ACTIVE';
            }
            return comboMachine.snapshot(frame).some(window => (
                window.sourceCastId === context.castId
                && window.ownerId === command.characterId
                && window.remainingFrames > 0
            )) ? null : 'RELEASE_WINDOW_NOT_ACTIVE';
        };
        resolveReleaseDependencies = (kind, context) => {
            const candidates = [
                ...controllerAnchorWaits.values(), ...anchorWaits.values(),
            ].sort((left, right) => operationOrder.isV1
                ? operationOrder.compare(left.change ?? left.command, right.change ?? right.command) : (
                (left.change?.timelineOrder ?? left.command?.timelineOrder ?? 0)
                - (right.change?.timelineOrder ?? right.command?.timelineOrder ?? 0)
            ));
            for (const waiting of candidates) {
                const node = waiting.command ?? waiting.change;
                const dependency = node.releaseDependency;
                const expectedKind = dependency.kind === 'timed-input' ? 'action-start' : dependency.kind;
                if (waiting.matched || expectedKind !== kind
                    || dependency.sourceCommandId !== context.commandId) continue;
                if (kind === 'damage-hit' && (dependency.sourceSkillId !== context.skillId
                    || dependency.sourceTimelineFrame !== context.timelineFrame)) continue;
                waiting.matched = true;
                const frame = context.frame + dependency.delayFrames
                    + (dependency.kind === 'timed-input' ? dependency.sourceOffsetFrames : 0);
                const id = waiting.command?.commandId ?? waiting.change.switchId;
                runtime.schedule(frame, 70, () => {
                    if (waiting.change) {
                        controllerAnchorWaits.delete(id);
                        applyControllerSwitch(waiting.change, frame);
                        return;
                    }
                    anchorWaits.delete(id);
                    const state = states.get(node.characterId);
                    commandTrace.push({ type: 'ReleaseAnchorResolved', frame, commandId: id,
                        sourceCommandId: dependency.sourceCommandId, anchorKind: dependency.kind,
                        sourceFrame: context.frame,
                        ...(kind === 'damage-hit' ? { sourceHitFrame: context.frame,
                            sourceTimelineFrame: context.timelineFrame } : {}),
                        sourceCastId: context.castId ?? null });
                    const rejection = dependency.kind === 'timed-input'
                        ? validateTimedInputDependency(node, dependency, context, frame) : null;
                    if (rejection) failCommand(state, node, frame, rejection);
                    else executeCommand(state, node, frame, false, null, false);
                    scheduleFightStop(frame, false);
                }, `release-anchor:${id}`);
            }
        };

        // Time and event priority remain primary. v0 retains its historical
        // switch-first defaults; v1 uses the explicit shared operation order.
        const controlAndCommands = [
            ...submittedCommands.map(command => ({ kind: 'command', value: command,
                frame: command.frame, order: operationOrder.isV1 ? command.operationOrder
                    : Number.isFinite(command.timelineOrder) ? command.timelineOrder : 0 })),
            ...switches.map(entry => ({ kind: 'switch', value: entry, frame: entry.frame,
                order: operationOrder.isV1 ? entry.operationOrder : entry.timelineOrder })),
        ].sort((left, right) => left.frame - right.frame || left.order - right.order
            || (left.kind === right.kind ? 0 : left.kind === 'switch' ? -1 : 1));
        for (const entry of controlAndCommands) {
            if (entry.kind === 'switch') {
                const change = entry.value;
                if (!change.releaseDependency) runtime.schedule(change.frame, 70, () => {
                    applyControllerSwitch(change, change.frame);
                }, `controller-switch:${change.switchId}`);
                continue;
            }
            const command = entry.value;
            const state = states.get(command.characterId);
            // Relations are registered at run start; their preview frame is
            // only an observation and must not delay a source moved earlier.
            const submissionFrame = command.releaseDependency ? 0 : command.frame;
            runtime.schedule(submissionFrame, 70, () => {
                commandsSeen += 1;
                commandTrace.push({
                    type: 'CommandSubmitted',
                    frame: command.frame,
                    requestedFrame: command.requestedFrame,
                    memberId: state.memberId,
                    characterId: state.characterId,
                    commandId: command.commandId,
                    commandType: command.commandType,
                    ...(command.attackMode ? { attackMode: command.attackMode } : {}),
                    queueWindowFrames: commandUsesSequenceQueue(command)
                        ? null
                        : this.commandQueueWindowFrames,
                    targetId: command.targetId ?? enemyId,
                    sameFrameOrderKey: operationOrder.isV1 ? command.operationOrder : state.memberId,
                    ...(operationOrder.isV1 ? {
                        operationOrderVersion: 1,
                        operationOrder: command.operationOrder,
                    } : {}),
                });
                if (!command.releaseDependency) executeCommand(state, command, command.frame);
                else commandTrace.push({ type: 'CommandAnchored', frame: submissionFrame,
                    commandId: command.commandId, memberId: state.memberId,
                    characterId: state.characterId, commandType: command.commandType,
                    reason: 'RELEASE_ANCHOR_PENDING', releaseDependency: clone(command.releaseDependency) });
                scheduleFightStop(command.frame, false);
            }, `command:${state.memberId}:${command.commandType}`);
        }

        if (endFrame !== null) {
            durationTicks = nonNegativeInteger(endFrame, 'endFrame');
            runtime.runUntil(durationTicks);
        } else if (submittedCommands.length === 0) {
            durationTicks = 0;
            runtime.runUntil(0);
        } else {
            let driverEvents = 0;
            while (!fightStopped) {
                runtime.pendingEvents.sort((left, right) => left.frame - right.frame
                    || left.priority - right.priority || left.sequence - right.sequence);
                const next = runtime.pendingEvents[0];
                if (!next) {
                    throw new Error('Squad scenario queue ended before the fight-stop condition.');
                }
                runtime.runUntil(next.frame);
                driverEvents += 1;
                if (driverEvents > this.maxDriverEvents) {
                    throw new Error(`Scenario driver event limit ${this.maxDriverEvents} exceeded.`);
                }
            }
        }

        for (const { command } of anchorWaits.values()) {
            failCommand(states.get(command.characterId), command, durationTicks,
                'RELEASE_ANCHOR_NOT_REACHED');
        }
        for (const { change } of controllerAnchorWaits.values()) {
            const failure = { stage: 'MainCharacterSwitchUnresolved', frame: durationTicks,
                previousCharacterId: runtime.mainCharacterId, characterId: change.characterId,
                switchId: change.switchId, reason: 'RELEASE_ANCHOR_NOT_REACHED' };
            controllerTrace.push(failure);
            runtime.effects.trace.push({ frame: durationTicks, actionType: 'OperatorSwitch',
                result: { status: 'Unresolved', ...failure } });
        }
        const damageLog = damageLogFromTrace(
            runtime.effects.trace,
            bundle.memberIdByCharacterId,
            runtime.statusEffects.trace
        );
        const hpHits = damageLog.filter(hit => hit.damageAttributeType === 'Hp');
        const poiseHits = damageLog.filter(hit =>
            ['Poise', 'Resilience'].includes(hit.damageAttributeType)
        );
        const resourceSnapshot = runtime.resources.snapshot();
        const vital = runtime.vitals.get(enemyId, durationTicks);
        const unresolvedStatuses = new Set([
            'Unresolved', 'PartiallyApplied', 'Unsupported'
        ]);
        const unresolvedEffects = runtime.effects.trace.filter(entry =>
            unresolvedStatuses.has(entry.result?.status)
            || unresolvedStatuses.has(entry.result?.resolution?.status)
        );
        const sharedAtbPool = resourceSnapshot.byPoolId['squad:Atb']
            ?? resourceSnapshot.pools.find(pool =>
                pool.resourceType === 'Atb' && pool.scope === 'Shared');
        const ultimateSpByCharacterId = Object.fromEntries(bundle.members.map(member => {
            const pool = resourceSnapshot.byPoolId[`${member.characterId}:UltimateSp`]
                ?? resourceSnapshot.pools.find(candidate =>
                    candidate.resourceType === 'UltimateSp'
                    && candidate.ownerId === member.characterId);
            return [member.characterId, pool?.current ?? 0];
        }));
        const cooldownsByCharacterId = Object.fromEntries([...states.values()].map(state => [
            state.characterId,
            runtime.cooldowns.endFramesForActor(state.characterId)
        ]));
        const attributeSnapshots = Object.fromEntries(bundle.members.map(member => [
            member.characterId,
            Object.fromEntries(RUNTIME_ATTRIBUTE_SNAPSHOT_FIELDS.map(attribute => [
                attribute,
                runtime.effectSources.attributeSnapshot({
                    targetId: member.characterId,
                    attribute
                }, {
                    frame: durationTicks,
                    eventType: 'ScenarioSettled',
                    sourceId: member.characterId,
                    ownerId: member.characterId,
                    targetId: member.characterId,
                    clockDomainId: `${member.characterId}:clock`
                })
            ]))
        ]));
        const teamComboLedger = normalizeTeamComboEventLedger({
            statusTrace: runtime.statusEffects.trace,
            damageLog,
            settlements: teamComboSettlementTrace
        });
        return {
            schemaVersion: 3,
            engine: 'ake-squad-combat-runtime',
            tickRate: bundle.tickRate,
            durationTicks,
            scenario: {
                ...clone(bundle.identity),
                ...(operationOrder.isV1 ? { operationOrderVersion: 1 } : {}),
                members: bundle.members.map(member => ({
                    memberId: member.memberId,
                    uuid: member.memberId,
                    characterId: member.characterId,
                    name: member.identity.name,
                    weaponId: member.identity.weaponId
                })),
                commands: clone(submittedCommands),
                initialControllerCharacterId: initialController,
                operatorSwitches: clone(switches)
            },
            commandTrace,
            controllerTrace,
            commandAdmissionTrace,
            comboTrace,
            teamComboSettlementTrace,
            centerStateTrace,
            cooldownTrace: runtime.cooldowns.intervals(),
            cooldownMutationTrace: clone(runtime.cooldowns.trace),
            resourceTrace: clone(runtime.resources.trace),
            statusTrace: clone(runtime.statusEffects.trace),
            teamComboLedger,
            attributeSnapshots,
            timedInputWindows: runtime.timedInputWindowSnapshot(durationTicks),
            clockTrace: clone(runtime.clockDomains.trace),
            localClockTriggerTrace,
            loadoutTrace: clone(loadoutManager.trace),
            damageLog,
            damageSummary: {
                hitCount: damageLog.length,
                hpHitCount: hpHits.length,
                poiseHitCount: poiseHits.length,
                totalPoiseDamage: poiseHits.reduce((sum, hit) => sum + hit.poiseDamage, 0),
                totalDamage: hpHits.reduce((sum, hit) => sum + hit.finalDamage, 0),
                byCharacterId: summaryByCharacter(
                    damageLog,
                    bundle.members.map(member => member.characterId)
                ),
                damageByType: Object.fromEntries([...new Set(hpHits.map(hit => hit.damageType))]
                    .map(type => [
                        type,
                        hpHits.filter(hit => hit.damageType === type)
                            .reduce((sum, hit) => sum + hit.finalDamage, 0)
                    ]))
            },
            finalState: {
                mainCharacterId: runtime.mainCharacterId,
                targetHp: vital.currentHp,
                targetVital: vital,
                resources: {
                    Atb: sharedAtbPool?.current ?? 0,
                    UltimateSp: ultimateSpByCharacterId
                },
                sharedAtb: clone(sharedAtbPool),
                ultimateSpByCharacterId,
                resourcePools: clone(resourceSnapshot.byPoolId),
                cooldowns: cooldownsByCharacterId,
                pendingCombos: comboMachine.snapshot(durationTicks),
                actorStates: Object.fromEntries([...states.values()].map(state => [
                    state.characterId,
                    {
                        memberId: state.memberId,
                        centerState: state.centerState,
                        currentSkill: state.currentSkill ? {
                            commandId: state.currentSkill.commandId,
                            castId: state.currentSkill.castId,
                            skillId: state.currentSkill.skillId,
                            commandType: state.currentSkill.commandType,
                            startFrame: state.currentSkill.startFrame
                        } : null
                    }
                ])),
                statuses: runtime.statusEffects.list({ active: true }),
                resilience: runtime.resilience.snapshot(),
                poise: runtime.poise.snapshot(),
                clocks: runtime.clockDomains.snapshot(),
                loadout: {
                    installations: loadoutInstallations,
                    active: loadoutManager.snapshot().installations
                },
                intrinsicPassives: clone(intrinsicPassiveInstallations)
            },
            diagnostics: {
                unresolvedEffectCount: unresolvedEffects.length,
                unresolvedEffects: clone(unresolvedEffects)
            }
        };
    }
}

export function runAkeSquadScenario(bundle, options = {}) {
    const runnerOptions = options.runner ?? {};
    const runOptions = options.run ?? options;
    return new AkeSquadScenarioRunner(bundle, runnerOptions).run(runOptions);
}

export default AkeSquadScenarioRunner;
