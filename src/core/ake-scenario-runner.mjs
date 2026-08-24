import { createAkeDamageResolver } from './ake-damage-resolver.mjs';
import {
    applyAkeLocalClockTrigger,
    createAkeTimeDilationResolver
} from './ake-time-dilation-resolver.mjs';
import { ComboTriggerMachine } from './combo-trigger-machine.mjs';
import { CombatRuntime } from './combat-runtime.mjs';
import { CommandAdmissionProvider } from './command-admission-provider.mjs';

export const PELICA_BASELINE_COMMANDS = Object.freeze([
    Object.freeze({ frame: 0, commandType: 'Attack' }),
    Object.freeze({ frame: 15, commandType: 'Attack' }),
    Object.freeze({ frame: 30, commandType: 'Attack' }),
    Object.freeze({ frame: 45, commandType: 'Attack' }),
    Object.freeze({ frame: 90, commandType: 'ComboSkill' }),
    Object.freeze({ frame: 120, commandType: 'NormalSkill' })
]);

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

function poolRef(costType, characterId) {
    return costType === 'Atb'
        ? { resourceType: costType, scope: 'Shared', ownerId: null }
        : { resourceType: costType, scope: 'Entity', ownerId: characterId };
}

function normalizedCommands(commands) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array.');
    return commands.map((command, index) => {
        if (!isRecord(command)) throw new TypeError(`commands[${index}] must be an object.`);
        if (typeof command.commandType !== 'string' || command.commandType.length === 0) {
            throw new TypeError(`commands[${index}].commandType must be a non-empty string.`);
        }
        return {
            ...clone(command),
            frame: nonNegativeInteger(command.frame, `commands[${index}].frame`)
        };
    });
}

function damageLogFromTrace(trace) {
    const records = trace.filter(entry =>
        entry.stage === 'ActionDelegated' && entry.type === 'ResolveDamagePacket'
    );
    return records.flatMap(entry => {
        const resolvedHits = entry.result?.resolution?.hits ?? [];
        const appliedHits = entry.result?.hits ?? [];
        return resolvedHits.map((hit, index) => {
            const applied = appliedHits[index]?.result ?? null;
            return {
                frame: entry.frame,
                sourceId: entry.sourceId,
                ownerId: entry.ownerId,
                targetId: entry.targetId,
                skillId: entry.skillId,
                rootSkillId: entry.rootSkillId,
                castId: entry.castId,
                damageUnitIndex: hit.damageUnitIndex ?? index,
                damageType: hit.damageType,
                damageAttributeType: hit.damageAttributeType,
                atkScale: hit.operands?.atkScale ?? 0,
                rawDamage: hit.rawDamage ?? 0,
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
                application: clone(applied)
            };
        });
    });
}

function compactResources(snapshot) {
    return Object.fromEntries((snapshot?.pools ?? []).map(pool => [
        pool.resourceType,
        pool.current
    ]));
}

/**
 * Command/state adapter over CombatRuntime. The assembler supplies all public
 * SkillData/BuffData dependencies; this class supplies only the input-command
 * state machine that the exported action graph does not represent by itself.
 */
export class AkeScenarioRunner {
    constructor(bundle, {
        commandQueueWindowFrames = 30,
        actionIdleExitFightFrames = 120,
        damageResolver = createAkeDamageResolver(),
        timeDilationResolver = null,
        commandAdmissionProvider = null,
        maxDriverEvents = 100000,
        maxEventsPerRun = 10000
    } = {}) {
        if (!isRecord(bundle) || !(bundle.programs instanceof Map)) {
            throw new TypeError('AkeScenarioRunner requires an assembled AKE scenario bundle.');
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

    run({ commands = PELICA_BASELINE_COMMANDS, endFrame = null } = {}) {
        const submittedCommands = normalizedCommands(commands);
        const { bundle } = this;
        const characterId = bundle.identity.characterId;
        const enemyId = bundle.identity.enemyId;
        const actorClockDomainId = `${characterId}:clock`;
        const commandTrace = [];
        const commandAdmissionTrace = [];
        const centerStateTrace = [];
        const cooldownTrace = [];
        const comboTrace = [];
        const localClockTriggerTrace = [];
        const cooldowns = new Map();
        let currentSkill = null;
        let centerState = 'Free';
        let nextCastToken = 1;
        let commandsSeen = 0;
        let fightStopped = false;
        let durationTicks = null;
        let fightStopScheduled = false;
        let comboMachine = null;
        let nextQueuedCommandToken = 1;
        const queuedCommands = new Map();
        const seenClockTriggers = new Set();

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
            for (const hit of resolution?.hits ?? []) {
                if (hit.damageAttributeType !== 'Hp') continue;
                comboMachine.observe({
                    eventType: 'BeforeHpDamage',
                    frame: parameters.eventContext.frame,
                    sourceId: parameters.eventContext.sourceId,
                    sourceSkillId: parameters.eventContext.skillId,
                    rootSkillId: parameters.eventContext.rootSkillId,
                    sourceCastId: parameters.eventContext.castId,
                    targetId: parameters.eventContext.targetId,
                    damageAttributeType: 'Hp',
                    damageUnitIndex: hit.damageUnitIndex
                }, {
                    currentSkillId: currentSkill?.skillId
                        ?? parameters.eventContext.rootSkillId,
                    currentPriority: currentSkill?.priority ?? 0
                });
            }
            return resolution;
        };
        const runtime = new CombatRuntime({
            tickRate: bundle.tickRate,
            definitions: bundle.definitions,
            damageResolver: resolver,
            skillProgramResolver: ({ skillId }) => bundle.programs.get(skillId),
            timeDilationResolver: this.timeDilationResolver,
            maxEventsPerRun: this.maxEventsPerRun
        });
        comboMachine = new ComboTriggerMachine({
            rules: bundle.semanticMappings.filter(mapping =>
                mapping.actionType === 'ComboTriggerRule'
            ),
            schedule: runtime.schedule,
            trace: comboTrace,
            getCooldownEnd: skillId => cooldowns.get(skillId) ?? 0
        });
        this.lastRuntime = runtime;
        this.lastComboMachine = comboMachine;

        const transition = (frame, to, reason) => {
            if (centerState === to) return;
            centerStateTrace.push({ frame, from: centerState, to, reason });
            centerState = to;
        };
        const scheduleFightStop = (frame, fromCompletedSkill = true) => {
            if (fightStopScheduled || endFrame !== null || queuedCommands.size > 0) return;
            fightStopScheduled = true;
            const stopFrame = frame + this.actionIdleExitFightFrames
                - (fromCompletedSkill ? 1 : 0);
            runtime.schedule(stopFrame, 1000, () => {
                fightStopped = true;
                durationTicks = stopFrame;
            }, 'idle-fight-stop');
        };
        const cancelProgram = (active, frame, reason) => {
            if (active?.scheduled?.castId) {
                runtime.cancelCastPrograms(active.scheduled.castId, frame, reason);
            }
            if (active?.naturalEndTimerId) {
                runtime.clockDomains.cancelTimer(
                    actorClockDomainId,
                    active.naturalEndTimerId,
                    frame,
                    reason
                );
            }
        };
        const finishCurrentSkill = (frame, completion) => {
            if (!currentSkill) return;
            const finished = currentSkill;
            if (completion !== 'Completed') {
                cancelProgram(finished, frame, `Skill${completion}`);
            }
            transition(frame, 'Free', `skill-end:${finished.skillId}:${completion}`);
            currentSkill = null;
            if (completion === 'Completed' && commandsSeen === submittedCommands.length
                && queuedCommands.size === 0) {
                scheduleFightStop(frame, true);
            }
        };
        const canPay = (skill, frame) => {
            const amount = Number(skill.costValue ?? 0);
            return amount <= 0 || runtime.resources.canPay(
                poolRef(skill.costType, characterId),
                amount,
                frame
            );
        };
        const failCommand = (command, frame, reason, skillId = null) => {
            commandTrace.push({
                type: 'CommandExecuted',
                frame,
                commandType: command.commandType,
                skillId,
                success: false,
                reason
            });
        };
        const scheduleNaturalEnd = (active, frame, durationTicks, reason) => {
            if (active.naturalEndTimerId) {
                runtime.clockDomains.cancelTimer(
                    actorClockDomainId,
                    active.naturalEndTimerId,
                    frame,
                    `SkillNaturalEndRescheduled:${reason}`
                );
            }
            active.naturalEndGeneration += 1;
            const timerId = `command-skill:${active.token}:natural-end:${active.naturalEndGeneration}`;
            active.naturalEndTimerId = runtime.clockDomains.startTimer(
                actorClockDomainId,
                {
                    id: timerId,
                    frame,
                    durationTicks: Math.max(0, nonNegativeInteger(
                        Math.trunc(durationTicks),
                        'skill natural-end duration'
                    )),
                    priority: 80,
                    sourceId: characterId,
                    ownerId: characterId,
                    targetId: enemyId,
                    skillId: active.skillId,
                    rootSkillId: active.skillId,
                    reason: 'SkillNaturalEnd',
                    label: `${active.skillId}:natural-end`,
                    onComplete: completionFrame => {
                        if (currentSkill?.token === active.token) {
                            finishCurrentSkill(completionFrame, 'Completed');
                        }
                    }
                }
            );
        };
        const beginSkill = (frame, commandType, skillId, skillSource) => {
            const skill = bundle.programs.get(skillId);
            if (!skill) throw new Error(`Missing compiled SkillData ${skillId}.`);
            const commandProfile = this.commandAdmissionProvider.profile(commandType);
            const desiredState = commandProfile.centerState;
            const previous = currentSkill;
            if (previous && commandProfile.transitionBeforeInterrupt
                && centerState !== desiredState) {
                transition(frame, desiredState, `command:${commandType}`);
            }
            if (previous) finishCurrentSkill(frame, 'Interrupted');
            if (!previous) transition(frame, desiredState, `command:${commandType}`);
            else transition(frame, desiredState, `skill-start:${skillId}`);

            const token = nextCastToken++;
            const startLocalFrame = runtime.clockDomains.localFrameAt(
                actorClockDomainId,
                frame
            );
            const scheduled = runtime.scheduleProgram(skill, {
                frame,
                sourceId: characterId,
                ownerId: characterId,
                targetId: enemyId,
                skillId,
                rootSkillId: skillId,
                castId: `command-cast:${token}`,
                clockDomainId: actorClockDomainId,
                onTimelineSeek: seek => {
                    if (currentSkill?.token !== token) return;
                    currentSkill.timelineAnchorFrame = seek.destFrame;
                    currentSkill.timelineAnchorLocalFrame = runtime.clockDomains.localFrameAt(
                        actorClockDomainId,
                        seek.frame
                    );
                    scheduleNaturalEnd(
                        currentSkill,
                        seek.frame,
                        Number(skill.durationFrames ?? 0) - seek.destFrame,
                        `TimelineSeek:${seek.sourceTimelineFrame}->${seek.destFrame}`
                    );
                },
                onInterruptible: mark => {
                    if (currentSkill?.token !== token) return;
                    currentSkill.interruptible = true;
                    currentSkill.interruptibleFrame = mark.frame;
                }
            });
            currentSkill = {
                token,
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
                naturalEndGeneration: 0
            };

            const cost = Number(skill.costValue ?? 0);
            if (cost > 0) {
                runtime.resources.spend({
                    frame,
                    poolRef: poolRef(skill.costType, characterId),
                    amount: cost,
                    sourceId: characterId,
                    ownerId: characterId,
                    targetId: characterId,
                    reason: 'CastCost'
                });
            }
            if (Number(skill.cooldownTicks) > 0) {
                const end = frame + Number(skill.cooldownTicks);
                cooldowns.set(skillId, end);
                cooldownTrace.push({
                    frame,
                    stage: 'Started',
                    skillId,
                    durationTicks: skill.cooldownTicks,
                    endFrame: end
                });
            }
            commandTrace.push({
                type: 'CommandExecuted',
                frame,
                commandType,
                skillId,
                success: true,
                skillSource
            });

            scheduleNaturalEnd(
                currentSkill,
                frame,
                Math.max(0, Number(skill.durationFrames ?? 1) - 1),
                'InitialSchedule'
            );
        };

        const timelineFrameAt = (active, frame) => {
            const localFrame = runtime.clockDomains.localFrameAt(
                actorClockDomainId,
                frame
            );
            return active.timelineAnchorFrame
                + (localFrame - active.timelineAnchorLocalFrame);
        };
        const admission = (commandType, skillId, frame) => {
            const timelineFrame = currentSkill
                ? timelineFrameAt(currentSkill, frame)
                : 0;
            const decision = this.commandAdmissionProvider.evaluate({
                commandType,
                skillId,
                currentSkill,
                timelineFrame
            });
            commandAdmissionTrace.push({
                frame,
                ...clone(decision)
            });
            return decision.accepted ? null : decision;
        };
        const expireQueuedCommand = (queued, frame, reason = 'QUEUE_WINDOW_EXPIRED') => {
            if (!queued.active) return false;
            queued.active = false;
            queuedCommands.delete(queued.token);
            commandTrace.push({
                type: 'CommandExpired',
                frame,
                commandType: queued.command.commandType,
                skillId: queued.skillId,
                success: false,
                reason
            });
            if (commandsSeen === submittedCommands.length && !currentSkill) {
                scheduleFightStop(frame, false);
            }
            return true;
        };
        const queueCommand = (command, frame, skillId, gate) => {
            const token = nextQueuedCommandToken++;
            const queued = {
                token,
                command: clone(command),
                skillId,
                submittedFrame: command.frame,
                active: true,
                eligibilityTimerId: null
            };
            queuedCommands.set(token, queued);
            const localDelay = Math.max(0, Math.ceil(
                gate.nextTimelineFrame - gate.timelineFrame
            ));
            commandTrace.push({
                type: 'CommandQueued',
                frame,
                commandType: command.commandType,
                skillId,
                executeFrame: frame + localDelay,
                reason: 'CENTER_STATE_BLOCKED',
                admissionReason: gate.reason
            });
            runtime.schedule(
                command.frame + this.commandQueueWindowFrames,
                69,
                () => expireQueuedCommand(
                    queued,
                    command.frame + this.commandQueueWindowFrames
                ),
                `queued-command:${token}:expiry`
            );
            queued.eligibilityTimerId = runtime.clockDomains.startTimer(
                actorClockDomainId,
                {
                    id: `queued-command:${token}:eligibility`,
                    frame,
                    durationTicks: localDelay,
                    priority: 70,
                    sourceId: characterId,
                    ownerId: characterId,
                    targetId: enemyId,
                    skillId,
                    rootSkillId: currentSkill?.skillId ?? null,
                    reason: 'QueuedCommandEligibility',
                    label: `${command.commandType}:queued`,
                    onComplete: completionFrame => {
                        if (!queued.active) return;
                        if (completionFrame - queued.submittedFrame
                            >= this.commandQueueWindowFrames) {
                            expireQueuedCommand(queued, completionFrame);
                            return;
                        }
                        queued.active = false;
                        queuedCommands.delete(token);
                        executeCommand(
                            queued.command,
                            completionFrame,
                            true,
                            queued.skillId,
                            false
                        );
                    }
                }
            );
        };

        const executeCommand = (command, frame, fromQueue = false,
            forcedSkillId = null, allowQueue = true) => {
            let skillId = null;
            let skillSource = fromQueue ? 'next-skill-request' : 'combo-mapping';
            let comboGate = null;
            if (command.commandType === 'Attack') {
                skillId = forcedSkillId ?? mappedSkill(currentSkill?.skill, 'Attack')
                    ?? bundle.roles.normalAttackIds[0];
            } else if (command.commandType === 'ComboSkill') {
                skillId = forcedSkillId ?? command.skillId ?? bundle.roles.comboSkillId;
                const requiresPending = bundle.semanticMappings.some(mapping =>
                    mapping.actionType === 'ComboTriggerRule'
                    && mapping.effect?.comboSkillId === skillId
                );
                if (requiresPending) {
                    comboGate = comboMachine.gate({
                        frame,
                        skillId,
                        ownerId: characterId,
                        targetId: command.targetId ?? enemyId,
                        cooldownEnd: cooldowns.get(skillId) ?? 0,
                        currentSkillId: currentSkill?.skillId ?? null,
                        currentPriority: currentSkill?.priority ?? 0
                    });
                    if (!comboGate.ready) {
                        failCommand(command, frame, 'COMBO_NOT_READY', skillId);
                        return;
                    }
                }
            } else if (command.commandType === 'NormalSkill') {
                const mapped = mappedSkill(currentSkill?.skill, 'NormalSkill');
                skillId = forcedSkillId ?? mapped ?? bundle.roles.normalSkillId;
            } else if (command.commandType === 'UltimateSkill') {
                skillId = forcedSkillId ?? command.skillId ?? bundle.roles.ultimateSkillId;
            } else if (command.commandType === 'BreakingAttack') {
                skillId = forcedSkillId ?? command.skillId ?? bundle.roles.breakingAttackId;
                skillSource = 'execution-request';
            } else {
                failCommand(command, frame, 'UNSUPPORTED_COMMAND');
                return;
            }

            const admissionGate = admission(command.commandType, skillId, frame);
            if (admissionGate) {
                if (allowQueue) queueCommand(command, frame, skillId, admissionGate);
                else failCommand(command, frame, 'QUEUED_COMMAND_STILL_BLOCKED', skillId);
                return;
            }

            const skill = bundle.programs.get(skillId);
            if (!skill) throw new Error(`Missing compiled SkillData ${skillId}.`);
            if (!canPay(skill, frame)) {
                failCommand(command, frame, 'INSUFFICIENT_RESOURCE', skillId);
                return;
            }
            beginSkill(frame, command.commandType, skillId, skillSource);
            if (command.commandType === 'ComboSkill' && comboGate?.pending) {
                comboMachine.consume({
                    frame,
                    pendingId: comboGate.pending.id,
                    currentSkillId: currentSkill.skillId,
                    currentPriority: currentSkill.priority
                });
            }
        };

        for (const command of submittedCommands) {
            runtime.schedule(command.frame, 70, () => {
                commandsSeen += 1;
                commandTrace.push({
                    type: 'CommandSubmitted',
                    frame: command.frame,
                    commandType: command.commandType,
                    queueWindowFrames: this.commandQueueWindowFrames,
                    targetId: command.targetId ?? enemyId
                });
                executeCommand(command, command.frame);
                if (commandsSeen === submittedCommands.length && !currentSkill
                    && queuedCommands.size === 0) {
                    scheduleFightStop(command.frame, false);
                }
            }, `command:${command.commandType}`);
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
                    throw new Error('Scenario queue ended before the fight-stop condition.');
                }
                runtime.runUntil(next.frame);
                driverEvents += 1;
                if (driverEvents > this.maxDriverEvents) {
                    throw new Error(`Scenario driver event limit ${this.maxDriverEvents} exceeded.`);
                }
            }
        }

        const damageLog = damageLogFromTrace(runtime.effects.trace);
        const hpHits = damageLog.filter(hit => hit.damageAttributeType === 'Hp');
        const poiseHits = damageLog.filter(hit =>
            ['Poise', 'Resilience'].includes(hit.damageAttributeType)
        );
        const resourceSnapshot = runtime.resources.snapshot();
        const vital = runtime.vitals.get(enemyId, durationTicks);
        const unresolvedEffects = runtime.effects.trace.filter(entry =>
            entry.result?.status === 'Unresolved'
            || entry.result?.resolution?.status === 'Unresolved'
        );
        return {
            schemaVersion: 1,
            engine: 'ake-generic-combat-runtime',
            tickRate: bundle.tickRate,
            durationTicks,
            scenario: {
                ...clone(bundle.identity),
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
            damageLog,
            damageSummary: {
                hitCount: damageLog.length,
                hpHitCount: hpHits.length,
                poiseHitCount: poiseHits.length,
                totalPoiseDamage: poiseHits.reduce((sum, hit) => sum + hit.poiseDamage, 0),
                totalDamage: hpHits.reduce((sum, hit) => sum + hit.finalDamage, 0),
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
                resources: compactResources(resourceSnapshot),
                resourcePools: clone(resourceSnapshot.byPoolId),
                cooldowns: Object.fromEntries(cooldowns),
                pendingCombos: comboMachine.snapshot(durationTicks),
                statuses: runtime.statusEffects.list({ active: true }),
                resilience: runtime.resilience.snapshot(),
                clocks: runtime.clockDomains.snapshot()
            },
            diagnostics: {
                unresolvedEffectCount: unresolvedEffects.length,
                unresolvedEffects: clone(unresolvedEffects)
            }
        };
    }
}

export function runAkeScenario(bundle, options = {}) {
    const runnerOptions = options.runner ?? {};
    const runOptions = options.run ?? options;
    return new AkeScenarioRunner(bundle, runnerOptions).run(runOptions);
}

export default AkeScenarioRunner;
