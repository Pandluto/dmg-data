import { createAkeDamageResolver } from './ake-damage-resolver.mjs';
import {
    applyAkeLocalClockTrigger,
    createAkeTimeDilationResolver
} from './ake-time-dilation-resolver.mjs';
import { ComboTriggerMachine } from './combo-trigger-machine.mjs';
import { CombatRuntime } from './combat-runtime.mjs';
import { CommandAdmissionProvider } from './command-admission-provider.mjs';
import { LoadoutEffectManager } from './ake-loadout-compiler.mjs';

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

function mappedSkill(skill, commandType) {
    for (const cache of skill?.comboMappings ?? []) {
        const mapping = cache.mappings?.find(candidate => candidate.command === commandType);
        if (mapping?.skillId) return mapping.skillId;
    }
    return null;
}

function skillSlotForCommand(commandType) {
    return {
        Attack: 'NormalAttack',
        NormalSkill: 'NormalSkill',
        ComboSkill: 'ComboSkill',
        UltimateSkill: 'UltimateSkill'
    }[commandType] ?? null;
}

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

function normalizedCommands(commands, bundle) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array.');
    const membersById = new Map(bundle.members.map(member => [member.memberId, member]));
    const membersByCharacterId = new Map(bundle.members.map(member => [
        member.characterId,
        member
    ]));
    return commands.map((command, index) => {
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
            inputSequence: index
        };
    }).sort((left, right) => left.frame - right.frame
        || lexical(left.memberId, right.memberId)
        || left.inputSequence - right.inputSequence);
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
                hitId: hit.hitId ?? `legacy-hit:${traceIndex}:${index}`,
                sequence: hit.sequence ?? traceIndex,
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
        this.maxDriverEvents = positiveInteger(maxDriverEvents, 'maxDriverEvents');
        this.maxEventsPerRun = positiveInteger(maxEventsPerRun, 'maxEventsPerRun');
        this.lastRuntime = null;
        this.lastComboMachine = null;
    }

    run({ commands = [], endFrame = null } = {}) {
        const { bundle } = this;
        const submittedCommands = normalizedCommands(commands, bundle);
        const enemyId = bundle.identity.enemyId;
        const commandTrace = [];
        const commandAdmissionTrace = [];
        const centerStateTrace = [];
        const cooldownTrace = [];
        const comboTrace = [];
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
            cooldowns: new Map(),
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
                sourceCommandType: transition.commandType
                    ?? actor?.currentSkill?.commandType
                    ?? null,
                sourceCastId: transition.castId,
                targetId: transition.targetId,
                damageAttributeType: null
            }, {
                currentSkillId: actor?.currentSkill?.skillId ?? transition.rootSkillId,
                currentPriority: actor?.currentSkill?.priority ?? 0
            });
        };
        const resolver = parameters => {
            const resolution = this.damageResolver(parameters);
            const targetState = parameters.runtime.resilience.snapshot(
                parameters.eventContext.targetId
            );
            const hpHits = (resolution?.hits ?? []).filter(hit =>
                hit.damageAttributeType === 'Hp'
            );
            const poiseAmount = (resolution?.hits ?? [])
                .filter(hit => ['Poise', 'Resilience'].includes(hit.damageAttributeType))
                .reduce((sum, hit) => sum + Number(hit.amount ?? hit.finalDamage ?? 0), 0);
            let localClockTrigger = null;
            if ((parameters.action.damageUnits ?? []).some(unit =>
                unit.calculationType === 'BreakingAttackCalculation'
            ) && targetState.state !== 'Stable') {
                localClockTrigger = 'ExecutionHit';
            } else if (targetState.resilience > 0 && poiseAmount >= targetState.resilience) {
                localClockTrigger = 'PoiseBreak';
            } else if (hpHits.length > 0 && targetState.resilience <= 0) {
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
            const actor = stateForEvent(parameters.eventContext);
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
                    sourceCommandType: parameters.eventContext.commandType
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
            return resolution;
        };
        const runtime = new CombatRuntime({
            tickRate: bundle.tickRate,
            definitions: bundle.definitions,
            damageResolver: resolver,
            skillProgramResolver: ({ skillId, eventContext, runtime: activeRuntime }) => (
                activeRuntime.resolveSkillProgram(bundle.programs.get(skillId), {
                    ownerId: eventContext.ownerId ?? eventContext.sourceId,
                    skillId
                })
            ),
            timeDilationResolver: this.timeDilationResolver,
            skillInterruptResolver: request => resolveSkillInterrupt?.(request) ?? ({
                status: 'Ignored',
                reason: 'CommandStateNotReady'
            }),
            onStatusTransition: observeStatusTransitionForCombos,
            maxEventsPerRun: this.maxEventsPerRun
        });
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
                if (state.cooldowns.has(skillId)) return state.cooldowns.get(skillId);
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
            getCooldownEnd: cooldownEnd
        });
        this.lastRuntime = runtime;
        this.lastComboMachine = comboMachine;

        const queuedCommandCount = () => [...states.values()].reduce(
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
                commandType: finished.commandType,
                skillType: finished.commandType,
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
                commandType: finished.commandType,
                skillType: finished.commandType,
                clockDomainId: state.actorClockDomainId
            });
            state.currentSkill = null;
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
                if (previous) finishCurrentSkill(state, frame, 'Interrupted');
                if (!previous) transition(state, frame, desiredState, `command:${commandType}`);
                else transition(state, frame, desiredState, `skill-start:${skillId}`);
            }

            const token = state.nextCastToken++;
            const startLocalFrame = runtime.clockDomains.localFrameAt(
                state.actorClockDomainId,
                frame
            );
            const castId = options.castId ?? `command-cast:${state.memberId}:${token}`;
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
                mainCharacterId: state.characterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                commandType,
                skillType: commandType,
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
                mainCharacterId: state.characterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                commandType,
                skillType: commandType,
                castId,
                clockDomainId: state.actorClockDomainId,
                payload: { commandType, skillType: commandType }
            });
            const scheduled = runtime.scheduleProgram(skill, {
                frame,
                sourceId: state.characterId,
                ownerId: state.characterId,
                targetId: enemyId,
                mainCharacterId: state.characterId,
                memberId: state.memberId,
                commandId,
                skillId,
                rootSkillId: skillId,
                commandType,
                skillType: commandType,
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
                const cooldownEndFrame = frame + Number(skill.cooldownTicks);
                state.cooldowns.set(skillId, cooldownEndFrame);
                cooldownTrace.push({
                    frame,
                    stage: 'Started',
                    memberId: state.memberId,
                    characterId: state.characterId,
                    skillId,
                    durationTicks: skill.cooldownTicks,
                    endFrame: cooldownEndFrame
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
            return state.currentSkill;
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
        const admission = (state, commandType, skillId, frame, commandId = null) => {
            const timelineFrame = state.currentSkill
                ? timelineFrameAt(state, state.currentSkill, frame)
                : 0;
            const decision = this.commandAdmissionProvider.evaluate({
                commandType,
                skillId,
                currentSkill: state.currentSkill,
                timelineFrame
            });
            commandAdmissionTrace.push({
                frame,
                memberId: state.memberId,
                characterId: state.characterId,
                commandId,
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
                                : queued.skillId,
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
            // Timeline buttons represent the player's A/B/E/Q intent.  Their
            // cached skill id is only a display hint: queued commands must be
            // resolved again against the form state that is active when they
            // actually execute (for example an ultimate-enhanced normal skill).
            const explicitSkillId = forcedSkillId ?? (
                commandUsesSequenceQueue(command) ? null : command.skillId ?? null
            );
            const comboMappedSkillId = mappedSkill(
                state.currentSkill?.skill,
                command.commandType
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
            skillId = explicitSkillId
                ?? comboMappedSkillId
                ?? override?.targetSkillId
                ?? modeSkillId
                ?? baseRoleSkill(state.roles, command.commandType);
            skillSource = explicitSkillId
                ? (fromQueue ? 'next-skill-request' : 'explicit-request')
                : comboMappedSkillId
                    ? 'combo-mapping'
                    : override
                        ? 'skill-form-override'
                        : modeSkillId
                            ? 'skill-mode'
                            : 'character-template';

            if (command.commandType === 'ComboSkill') {
                const requiresPending = bundle.semanticMappings.some(mapping =>
                    mapping.actionType === 'ComboTriggerRule'
                    && mapping.effect?.comboSkillId === skillId
                );
                if (requiresPending) {
                    comboGate = comboMachine.gate({
                        frame,
                        skillId,
                        ownerId: state.characterId,
                        targetId: command.targetId ?? enemyId,
                        cooldownEnd: state.cooldowns.get(skillId) ?? 0,
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
            const admissionGate = admission(
                state,
                command.commandType,
                skillId,
                frame,
                command.commandId
            );
            if (admissionGate) {
                if (allowQueue) queueCommand(state, command, frame, skillId, admissionGate);
                else failCommand(
                    state,
                    command,
                    frame,
                    'QUEUED_COMMAND_STILL_BLOCKED',
                    skillId,
                    skillSource
                );
                return;
            }
            const skill = runtime.resolveSkillProgram(bundle.programs.get(skillId), {
                ownerId: state.characterId,
                skillId
            });
            if (!skill) throw new Error(`Missing compiled SkillData ${skillId}.`);
            const skillCooldownEnd = state.cooldowns.get(skillId) ?? 0;
            if (skillCooldownEnd > frame) {
                failCommand(state, command, frame, 'COOLDOWN_ACTIVE', skillId, skillSource);
                return;
            }
            if (!canPay(state, skill, frame)) {
                failCommand(state, command, frame, 'INSUFFICIENT_RESOURCE', skillId, skillSource);
                return;
            }
            if (command.commandType === 'Attack' && command.attackMode === 'full-combo') {
                beginFullAttackCombo(state, command, frame, skillId, skillSource);
            } else {
                beginSkill(
                    state,
                    frame,
                    command.commandType,
                    skillId,
                    skillSource,
                    command.commandId
                );
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

        for (const command of submittedCommands) {
            const state = states.get(command.characterId);
            runtime.schedule(command.frame, 70, () => {
                commandsSeen += 1;
                commandTrace.push({
                    type: 'CommandSubmitted',
                    frame: command.frame,
                    requestedFrame: command.requestedFrame,
                    memberId: state.memberId,
                    characterId: state.characterId,
                    commandId: command.commandId,
                    commandType: command.commandType,
                    queueWindowFrames: commandUsesSequenceQueue(command)
                        ? null
                        : this.commandQueueWindowFrames,
                    targetId: command.targetId ?? enemyId,
                    sameFrameOrderKey: state.memberId
                });
                executeCommand(state, command, command.frame);
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
            Object.fromEntries(state.cooldowns)
        ]));
        return {
            schemaVersion: 3,
            engine: 'ake-squad-combat-runtime',
            tickRate: bundle.tickRate,
            durationTicks,
            scenario: {
                ...clone(bundle.identity),
                members: bundle.members.map(member => ({
                    memberId: member.memberId,
                    uuid: member.memberId,
                    characterId: member.characterId,
                    name: member.identity.name,
                    weaponId: member.identity.weaponId
                })),
                commands: clone(submittedCommands)
            },
            commandTrace,
            commandAdmissionTrace,
            comboTrace,
            centerStateTrace,
            cooldownTrace,
            resourceTrace: clone(runtime.resources.trace),
            statusTrace: clone(runtime.statusEffects.trace),
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
