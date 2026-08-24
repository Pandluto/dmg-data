import { resolveAssignments, resolveValue } from './ake-parser.mjs';
import { BuffMachine } from './buff-machine.mjs';
import { ComboTriggerMachine } from './combo-trigger-machine.mjs';
import { calculateDamage } from './damage.mjs';
import { LocalClock } from './local-clock.mjs';
import { PoiseMachine } from './poise-machine.mjs';
import { ResourceMachine } from './resource-machine.mjs';

const EFFECT_TYPES = new Set([
    'LaunchProjectile',
    'DamageAction',
    'CreateBuffAction',
    'SpellInfliction',
    'ObtainCostAction'
]);

class EventQueue {
    constructor() {
        this.events = [];
        this.sequence = 0;
    }

    schedule(frame, priority, run, label = '') {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new Error(`Invalid event frame ${frame} for ${label}`);
        }
        this.events.push({ frame, priority, sequence: this.sequence++, run, label });
    }

    take() {
        this.events.sort((left, right) => left.frame - right.frame
            || left.priority - right.priority
            || left.sequence - right.sequence);
        return this.events.shift();
    }
}

function commandState(commandType) {
    return commandType === 'Attack' ? 'Attack' : 'Skill';
}

function targetForBuff(targetSource) {
    return targetSource === 'Target' ? 'enemy' : 'player';
}

function mappedSkill(skill, commandType) {
    for (const cache of skill?.comboMappings ?? []) {
        const mapping = cache.mappings.find(candidate => candidate.command === commandType);
        if (mapping) return mapping.skillId;
    }
    return null;
}

function firstAllowFrame(skill, nextSkillId) {
    const window = (skill?.allowNextWindows ?? [])
        .find(candidate => candidate.allowedSkillIds.includes(nextSkillId));
    return window?.startFrame ?? Number.POSITIVE_INFINITY;
}

function withinAllowWindow(skill, nextSkillId, relativeFrame) {
    return (skill?.allowNextWindows ?? []).some(window =>
        window.allowedSkillIds.includes(nextSkillId)
        && relativeFrame >= window.startFrame
        && relativeFrame <= window.endFrame
    );
}

export function simulateScenario(model) {
    const queue = new EventQueue();
    const commandTrace = [];
    const comboSkillTrace = [];
    const centerStateTrace = [];
    const cooldownTrace = [];
    const damageLog = [];
    const ignoredActions = [];
    const cooldowns = new Map();
    let targetHp = model.enemy.maxHp;
    let currentSkill = null;
    let centerState = 'Free';
    let nextCastToken = 1;
    let commandsSubmitted = 0;
    let fightStopped = false;
    let durationTicks = null;
    let fightStopScheduled = false;

    const schedule = (frame, priority, run, label) => queue.schedule(frame, priority, run, label);
    const enemyLocalClock = new LocalClock({ schedule, name: 'enemy-gameplay' });
    const resourceMachine = new ResourceMachine({
        definitions: {
            Atb: {
                initial: model.character.initialAtb,
                max: model.character.maxAtb,
                passiveRecovery: model.semanticRules.resourceRules.Atb.passiveRecovery
            },
            UltimateSp: {
                initial: model.character.initialUltimateSp,
                max: model.character.maxUltimateSp
            }
        },
        schedule,
        tickRate: model.tickRate
    });
    const resourceTrace = resourceMachine.trace;
    const comboTriggerMachine = new ComboTriggerMachine({
        rules: model.semanticRules.comboTriggerRules,
        schedule,
        trace: comboSkillTrace,
        getCooldownEnd: skillId => cooldowns.get(skillId) ?? 0
    });
    const buffMachine = new BuffMachine({
        definitions: model.buffs,
        schedule,
        tickRate: model.tickRate,
        skillSettings: model.semanticRules.skillSettings,
        targetAttributes: {
            PulseAbnormalDamageIncrease: 0
        },
        resourceActionRules: model.semanticRules.resourceRules.actions,
        onResourceAction: action => resourceMachine.gain(
            action.frame,
            action.resourceType,
            action.amount,
            action.reason,
            action.sourceSkillId
        )
    });
    const poiseMachine = new PoiseMachine({
        definition: {
            enabled: model.combatSetting.simulatePoise,
            maxPoise: model.enemy.maxPoise,
            recoverySeconds: model.enemy.poiseRecTime,
            executionDamageScalar: model.enemy.executionDamageScalar,
            executionAtbGain: model.enemy.breakingAttackedAtbObtain,
            knotPercentages: model.enemy.poiseKnotPctList,
            knotBuffIds: model.enemy.poiseKnotBuffList,
            knotDurationTicksByBuffId:
                model.semanticRules.poiseRules.knotDurationTicksByBuffId,
            brokenDamageScale: model.semanticRules.poiseRules.brokenDamageScale,
            breakDamageBuffId: model.semanticRules.poiseRules.breakDamageBuffId,
            executionGateBuffId: model.semanticRules.poiseRules.executionGateBuffId,
            recoveryTimingModel: model.semanticRules.poiseRules.recoveryTimingModel,
            rapidBreakPolicy: model.semanticRules.poiseRules.rapidBreakPolicy
        },
        schedule,
        localClock: enemyLocalClock,
        tickRate: model.tickRate,
        onKnot: knot => {
            if (!knot.buffId) return;
            buffMachine.apply({
                buffId: knot.buffId,
                frame: knot.frame,
                sourceSkillId: knot.sourceSkillId,
                target: 'enemy'
            });
        }
    });
    const poiseTrace = poiseMachine.trace;
    const localClockTrace = enemyLocalClock.trace;
    const appliedLocalPauseKeys = new Set();

    function pauseEnemyLocalClock(trigger, frame, sourceSkillId, rootSkillId) {
        const rules = model.semanticRules.poiseRules.localClockPauseRules ?? [];
        for (const rule of rules) {
            if (rule.selector?.trigger !== trigger) continue;
            if (rule.selector?.sourceSkillIds
                && !rule.selector.sourceSkillIds.includes(sourceSkillId)) continue;
            if (rule.selector?.rootSkillIds
                && !rule.selector.rootSkillIds.includes(rootSkillId)) continue;
            const key = `${rule.id}:${frame}:${sourceSkillId}:${rootSkillId}`;
            if (appliedLocalPauseKeys.has(key)) continue;
            appliedLocalPauseKeys.add(key);
            enemyLocalClock.pause({
                frame,
                durationTicks: Number(rule.effect.durationTicks),
                reason: trigger,
                sourceSkillId,
                rootSkillId,
                evidenceRuleId: rule.id
            });
        }
    }

    function transition(frame, to, reason) {
        if (centerState === to) return;
        centerStateTrace.push({ frame, from: centerState, to, reason });
        centerState = to;
    }

    function scheduleFightStop(frame, fromCompletedSkill = true) {
        if (fightStopScheduled) return;
        fightStopScheduled = true;
        const stopFrame = frame + model.combatSetting.actionIdleExitFightFrames
            - (fromCompletedSkill ? 1 : 0);
        schedule(stopFrame, 1000, () => {
            fightStopped = true;
            durationTicks = stopFrame;
        }, 'idle-fight-stop');
    }

    function finishCurrentSkill(frame, completion) {
        if (!currentSkill) return;
        const finished = currentSkill;
        transition(frame, 'Free', `skill-end:${finished.skillId}:${completion}`);
        currentSkill = null;
        if (completion === 'Completed' && commandsSubmitted === model.commands.length) {
            scheduleFightStop(frame, true);
        }
    }

    function applyCreateBuff(event, frame, blackboard, actionSkillId) {
        const target = targetForBuff(event.targetSource);
        const count = Math.max(0, Number(resolveValue(event.count, blackboard, 1)));
        for (let copy = 0; copy < count; copy += 1) {
            for (const buff of event.buffs) {
                const overrides = buff.assignBlackboard
                    ? resolveAssignments(buff.assignments, blackboard)
                    : {};
                buffMachine.apply({
                    buffId: buff.buffId,
                    frame,
                    sourceSkillId: actionSkillId,
                    overrides,
                    target
                });
            }
        }
    }

    function resolveDamage(event, frame, blackboard, actionSkillId, rootSkillId, sourceCastId) {
        for (const [damageUnitIndex, unit] of event.damageUnits.entries()) {
            if (unit.damageAttributeType === 'Poise') {
                if (!model.combatSetting.simulatePoise) continue;
                if (unit.poiseCalculationType !== 'DefiniteValueCalculation') {
                    ignoredActions.push({
                        frame,
                        type: 'PoiseDamage',
                        skillId: actionSkillId,
                        calculationType: unit.poiseCalculationType,
                        reason: 'unsupported-poise-calculation'
                    });
                    continue;
                }
                let basePoise = Number(resolveValue(unit.poiseValue, blackboard, 0));
                if (unit.poiseApplyScale) {
                    basePoise *= Number(resolveValue(unit.poiseValueScale, blackboard, 1));
                }
                const poiseResult = poiseMachine.applyDamage({
                    frame,
                    basePoise,
                    outputScalar: model.character.poiseDamageOutputScalar,
                    takenScalar: model.enemy.poiseDamageTakenScalar,
                    sourceSkillId: actionSkillId,
                    rootSkillId,
                    damageUnitIndex
                });
                damageLog.push({
                    frame,
                    sourceId: model.identity.characterId,
                    targetId: model.enemy.id,
                    skillId: actionSkillId,
                    rootSkillId,
                    damageType: unit.damageType,
                    damageAttributeType: 'Poise',
                    atkScale: 0,
                    rawDamage: 0,
                    finalDamage: 0,
                    poiseDamage: poiseResult.finalPoiseDamage,
                    actualPoiseDamage: poiseResult.actualPoiseDamage,
                    poiseOverflow: poiseResult.overflow,
                    isCritical: false,
                    nonCriticalDamage: 0,
                    criticalDamage: 0,
                    expectedDamage: 0,
                    targetHpBefore: targetHp,
                    targetHpAfter: targetHp,
                    damageUnitIndex,
                    poiseSnapshot: {
                        before: poiseResult.before,
                        after: poiseResult.after,
                        max: model.enemy.maxPoise,
                        broken: poiseResult.broken,
                        broke: poiseResult.broke
                    },
                    modifierSnapshot: {
                        poiseDamageOutputScalar: model.character.poiseDamageOutputScalar,
                        poiseDamageTakenScalar: model.enemy.poiseDamageTakenScalar,
                        poiseGuardTakenScalar: poiseResult.guardTakenScalar,
                        effectivePoiseDamageTakenScalar: poiseResult.effectiveTakenScalar
                    },
                    operands: {
                        basePoise,
                        poiseDamageOutputScalar: model.character.poiseDamageOutputScalar,
                        poiseDamageTakenScalar: model.enemy.poiseDamageTakenScalar,
                        poiseGuardTakenScalar: poiseResult.guardTakenScalar,
                        effectivePoiseDamageTakenScalar: poiseResult.effectiveTakenScalar
                    }
                });
                if (poiseResult.broke) {
                    pauseEnemyLocalClock('PoiseBreak', frame, actionSkillId, rootSkillId);
                }
                continue;
            }

            comboTriggerMachine.observe({
                eventType: 'BeforeHpDamage',
                frame,
                sourceId: model.identity.characterId,
                sourceSkillId: actionSkillId,
                rootSkillId,
                sourceCastId,
                targetId: model.enemy.id,
                damageAttributeType: 'Hp',
                damageUnitIndex
            }, {
                currentSkillId: currentSkill?.skillId ?? rootSkillId,
                currentPriority: currentSkill?.priority ?? 0
            });
            const atkScale = Number(resolveValue(unit.scale, blackboard, 0));
            const buffDefenderZone = buffMachine.defenderZoneScale(unit.damageType, frame);
            const poiseDefenderZone = poiseMachine.damageZone();
            const defenderZone = {
                scale: buffDefenderZone.scale * poiseDefenderZone.scale,
                zones: [...buffDefenderZone.zones, ...poiseDefenderZone.zones]
            };
            const targetWasBroken = poiseMachine.snapshot().broken;
            const executionHit = unit.calculationType
                === model.semanticRules.poiseRules.executionRule.selector.calculationType
                && rootSkillId === model.roles.breakingAttackId
                && poiseMachine.canExecute();
            const executionDamageScalar = executionHit
                ? model.enemy.executionDamageScalar
                : 1;
            const result = calculateDamage({
                attack: model.character.attack,
                atkScale,
                defense: model.enemy.defense,
                resistance: unit.damageType === 'Pulse' ? model.enemy.pulseResistance : 0,
                damageTakenScalar: model.enemy.damageTakenScalar,
                weaknessDmgScalar: model.enemy.weaknessDmgScalar,
                shelterDmgScalar: model.enemy.shelterDmgScalar,
                attackerZoneScale: 1,
                defenderZoneScale: defenderZone.scale,
                specialScale: executionDamageScalar,
                criticalMode: model.combatSetting.criticalMode,
                criticalRate: model.character.criticalRate,
                criticalDamageIncrease: model.character.criticalDamageIncrease
            });
            const targetHpBefore = targetHp;
            targetHp -= result.finalDamage;
            damageLog.push({
                frame,
                sourceId: model.identity.characterId,
                targetId: model.enemy.id,
                skillId: actionSkillId,
                rootSkillId,
                damageType: unit.damageType,
                damageAttributeType: 'Hp',
                atkScale,
                rawDamage: result.rawDamage,
                finalDamage: result.finalDamage,
                poiseDamage: 0,
                isCritical: result.isCritical,
                nonCriticalDamage: result.nonCriticalDamage,
                criticalDamage: result.criticalDamage,
                expectedDamage: result.expectedDamage,
                targetHpBefore,
                targetHpAfter: targetHp,
                damageUnitIndex,
                modifierSnapshot: {
                    attackerZoneScale: 1,
                    defenderZoneScale: defenderZone.scale,
                    defenderZones: defenderZone.zones,
                    executionDamageScalar
                },
                operands: result.operands
            });
            if (executionHit) {
                const execution = poiseMachine.consumeExecution({
                    frame,
                    sourceSkillId: actionSkillId,
                    rootSkillId
                });
                if (execution?.executionAtbGain > 0) {
                    resourceMachine.gain(
                        frame,
                        'Atb',
                        execution.executionAtbGain,
                        'BreakingAttack',
                        actionSkillId
                    );
                }
                pauseEnemyLocalClock('ExecutionHit', frame, actionSkillId, rootSkillId);
            } else if (targetWasBroken) {
                pauseEnemyLocalClock(
                    'HpDamageWhileBroken',
                    frame,
                    actionSkillId,
                    rootSkillId
                );
            }
        }
    }

    function executeEffect(event, context, frame, depth) {
        const { blackboard, actionSkillId, rootSkillId, sourceCastId } = context;
        switch (event.type) {
            case 'LaunchProjectile': {
                if (!event.childSkillId || event.childSkillId === actionSkillId) {
                    if (event.childSkillId === actionSkillId) {
                        ignoredActions.push({
                            frame,
                            type: event.type,
                            skillId: actionSkillId,
                            reason: 'self-referential projectile wrapper'
                        });
                    }
                    return;
                }
                if (depth >= 8) throw new Error(`Projectile nesting exceeded at ${actionSkillId}`);
                const child = model.skills.get(event.childSkillId);
                if (!child) throw new Error(`Missing child SkillData ${event.childSkillId}`);
                scheduleSkillEffects(child, frame, {
                    blackboard: { ...child.blackboard, ...blackboard },
                    actionSkillId: child.skillId,
                    rootSkillId,
                    sourceCastId,
                    activeToken: null
                }, depth + 1);
                break;
            }
            case 'CreateBuffAction':
                applyCreateBuff(event, frame, blackboard, actionSkillId);
                break;
            case 'SpellInfliction': {
                const buffId = model.semanticRules.spellInflictionBuffs[event.inflictionType];
                if (!buffId) {
                    ignoredActions.push({ frame, type: event.type, inflictionType: event.inflictionType });
                    return;
                }
                buffMachine.apply({
                    buffId,
                    frame,
                    sourceSkillId: actionSkillId,
                    target: 'enemy'
                });
                break;
            }
            case 'DamageAction':
                resolveDamage(event, frame, blackboard, actionSkillId, rootSkillId, sourceCastId);
                break;
            case 'ObtainCostAction': {
                const value = Number(resolveValue(event.value, blackboard, 0));
                const coefficient = Number(resolveValue(event.coefficient, blackboard, 1));
                resourceMachine.gain(
                    frame,
                    event.costType,
                    value * coefficient,
                    `${event.atbSourceType ?? 'Default'}:${event.gainMethod ?? 'Gain'}`,
                    actionSkillId
                );
                break;
            }
            default:
                break;
        }
    }

    function scheduleSkillEffects(skill, baseFrame, context, depth = 0) {
        const effects = skill.events
            .filter(event => EFFECT_TYPES.has(event.type))
            .sort((left, right) => left.startFrame - right.startFrame || left.order - right.order);
        for (const event of effects) {
            const frame = baseFrame + event.startFrame;
            schedule(frame, 1, () => {
                if (context.activeToken !== null
                    && currentSkill?.token !== context.activeToken) return;
                executeEffect(event, context, frame, depth);
            }, `${skill.skillId}:${event.type}`);
        }
    }

    function beginSkill(frame, commandType, skillId, skillSource) {
        const skill = model.skills.get(skillId);
        if (!skill) throw new Error(`Missing parsed SkillData ${skillId}`);
        const desiredState = commandState(commandType);
        const previous = currentSkill;

        if (previous && commandType === 'ComboSkill' && centerState !== desiredState) {
            transition(frame, desiredState, `command:${commandType}`);
        }
        if (previous) finishCurrentSkill(frame, 'Interrupted');
        if (!previous) transition(frame, desiredState, `command:${commandType}`);
        else transition(frame, desiredState, `skill-start:${skillId}`);

        const token = nextCastToken++;
        currentSkill = {
            token,
            skillId,
            skill,
            commandType,
            startFrame: frame,
            priority: commandType === 'ComboSkill' ? 5 : 0,
            blackboard: { ...skill.blackboard }
        };

        if (Number(skill.costValue) > 0) {
            resourceMachine.spend(
                frame,
                skill.costType,
                Number(skill.costValue),
                'CastCost',
                skillId
            );
        }
        if (skill.cooldownTicks > 0) {
            const endFrame = frame + skill.cooldownTicks;
            cooldowns.set(skillId, endFrame);
            cooldownTrace.push({ frame, stage: 'Started', skillId, durationTicks: skill.cooldownTicks, endFrame });
        }

        commandTrace.push({
            type: 'CommandExecuted',
            frame,
            commandType,
            skillId,
            success: true,
            skillSource
        });
        scheduleSkillEffects(skill, frame, {
            blackboard: currentSkill.blackboard,
            actionSkillId: skillId,
            rootSkillId: skillId,
            sourceCastId: token,
            activeToken: token
        });

        const endFrame = frame + Math.max(0, skill.durationFrames - 1);
        schedule(endFrame, 70, () => {
            if (currentSkill?.token === token) finishCurrentSkill(endFrame, 'Completed');
        }, `${skillId}:natural-end`);
    }

    function canPay(skill) {
        const costValue = Number(skill.costValue);
        return costValue <= 0 || resourceMachine.canPay(skill.costType, costValue);
    }

    function failCommand(command, frame, reason, skillId = null) {
        commandTrace.push({
            type: 'CommandExecuted',
            frame,
            commandType: command.commandType,
            skillId,
            success: false,
            reason
        });
    }

    function executeCommand(command, frame, fromQueue = false) {
        let skillId = null;
        let skillSource = fromQueue ? 'next-skill-request' : 'combo-mapping';
        let comboGate = null;

        if (command.commandType === 'Attack') {
            skillId = mappedSkill(currentSkill?.skill, 'Attack') ?? model.roles.normalAttackIds[0];
            if (currentSkill) {
                const relativeFrame = frame - currentSkill.startFrame;
                const earliestRelative = Math.min(
                    currentSkill.skill.exclusiveFrames,
                    firstAllowFrame(currentSkill.skill, skillId)
                );
                const earliestFrame = currentSkill.startFrame + earliestRelative;
                if (relativeFrame < earliestRelative) {
                    if (earliestFrame <= command.frame + model.combatSetting.commandQueueWindowFrames) {
                        commandTrace.push({
                            type: 'CommandQueued',
                            frame,
                            commandType: command.commandType,
                            executeFrame: earliestFrame,
                            reason: 'center-state-block:Attack->Attack'
                        });
                        schedule(earliestFrame, 10, () => executeCommand(command, earliestFrame, true), 'queued-attack');
                    } else {
                        failCommand(command, frame, 'QUEUE_WINDOW_EXCEEDED', skillId);
                    }
                    return;
                }
            }
        } else if (command.commandType === 'ComboSkill') {
            skillId = command.skillId ?? model.roles.comboSkillId;
            const cooldownEnd = cooldowns.get(skillId) ?? 0;
            comboGate = comboTriggerMachine.gate({
                frame,
                skillId,
                ownerId: model.identity.characterId,
                targetId: command.targetId ?? model.enemy.id,
                cooldownEnd,
                currentSkillId: currentSkill?.skillId ?? null,
                currentPriority: currentSkill?.priority ?? 0
            });
            if (!comboGate.ready) {
                failCommand(command, frame, 'COMBO_NOT_READY', skillId);
                return;
            }
        } else if (command.commandType === 'NormalSkill') {
            skillId = mappedSkill(currentSkill?.skill, 'NormalSkill') ?? model.roles.normalSkillId;
            if (currentSkill && mappedSkill(currentSkill.skill, 'NormalSkill') === skillId) {
                const relativeFrame = frame - currentSkill.startFrame;
                if (!withinAllowWindow(currentSkill.skill, skillId, relativeFrame)
                    && relativeFrame < currentSkill.skill.exclusiveFrames) {
                    failCommand(command, frame, 'SKILL_NOT_IN_ALLOW_WINDOW', skillId);
                    return;
                }
            }
        } else if (command.commandType === 'BreakingAttack') {
            skillId = command.skillId ?? model.roles.breakingAttackId;
            skillSource = 'poise-execution-gate';
            if (!poiseMachine.canExecute()) {
                failCommand(
                    command,
                    frame,
                    poiseMachine.snapshot().broken
                        ? 'EXECUTION_ALREADY_CONSUMED'
                        : 'TARGET_NOT_BROKEN',
                    skillId
                );
                return;
            }
        } else if (command.commandType === 'UltimateSkill') {
            skillId = command.skillId ?? model.roles.ultimateSkillId;
        } else {
            failCommand(command, frame, 'UNSUPPORTED_COMMAND');
            return;
        }

        const skill = model.skills.get(skillId);
        if (!canPay(skill)) {
            failCommand(command, frame, 'INSUFFICIENT_RESOURCE', skillId);
            return;
        }
        beginSkill(frame, command.commandType, skillId, skillSource);

        if (command.commandType === 'ComboSkill') {
            comboTriggerMachine.consume({
                frame,
                pendingId: comboGate.pending.id,
                currentSkillId: currentSkill.skillId,
                currentPriority: currentSkill.priority
            });
        }
    }

    for (const command of model.commands) {
        schedule(command.frame, 10, () => {
            commandsSubmitted += 1;
            commandTrace.push({
                type: 'CommandSubmitted',
                frame: command.frame,
                commandType: command.commandType,
                queueWindowFrames: model.combatSetting.commandQueueWindowFrames,
                targetId: command.targetId ?? model.enemy.id
            });
            executeCommand(command, command.frame);
            if (commandsSubmitted === model.commands.length && !currentSkill) {
                scheduleFightStop(command.frame, false);
            }
        }, `command:${command.commandType}`);
    }

    let processedEvents = 0;
    while (!fightStopped) {
        const event = queue.take();
        if (!event) throw new Error('Simulation queue ended before the fight stop condition.');
        event.run();
        processedEvents += 1;
        if (processedEvents > 100000) throw new Error('Simulation event limit exceeded.');
    }

    const totalDamage = damageLog.reduce((sum, hit) => sum + hit.finalDamage, 0);
    return {
        schemaVersion: 1,
        engine: 'ake-calc-cleanroom-minimal',
        calcDataVersion: model.calcDataVersion,
        tickRate: model.tickRate,
        scenario: {
            characterId: model.identity.characterId,
            characterName: model.identity.chineseName,
            weaponId: model.identity.defaultWeaponId,
            enemyId: model.enemy.id,
            commands: model.commands
        },
        commandTrace,
        comboSkillTrace,
        centerStateTrace,
        cooldownTrace,
        resourceTrace,
        poiseTrace,
        localClockTrace,
        buffTrace: buffMachine.trace,
        damageLog,
        damageSummary: {
            hitCount: damageLog.length,
            hpHitCount: damageLog.filter(hit => hit.damageAttributeType === 'Hp').length,
            poiseHitCount: damageLog.filter(hit => hit.damageAttributeType === 'Poise').length,
            totalPoiseDamage: damageLog.reduce((sum, hit) => sum + hit.poiseDamage, 0),
            totalDamage,
            damageByType: Object.fromEntries(
                [...new Set(damageLog.map(hit => hit.damageType))].map(type => [
                    type,
                    damageLog.filter(hit => hit.damageType === type)
                        .reduce((sum, hit) => sum + hit.finalDamage, 0)
                ])
            )
        },
        finalState: {
            targetHp,
            resources: resourceMachine.snapshot(),
            poise: poiseMachine.snapshot(),
            enemyLocalClock: enemyLocalClock.snapshot(),
            cooldowns: Object.fromEntries(cooldowns),
            pendingCombos: comboTriggerMachine.snapshot(durationTicks),
            activeBuffs: buffMachine.instances
                .filter(instance => instance.active && instance.startFrame <= durationTicks)
                .map(instance => ({
                    buffId: instance.buffId,
                    target: instance.target,
                    stackCount: instance.stackCount,
                    expireFrame: instance.expireFrame
                }))
        },
        ignoredActions,
        durationTicks
    };
}
