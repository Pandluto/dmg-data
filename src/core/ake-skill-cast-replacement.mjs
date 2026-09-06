/** Executes raw switchToBuffConfig.asSkillCast without taking the actor's
 * foreground skill slot. This lets an infusion coexist with an attack, and
 * an in-mode combo cast coexist with its ultimate, using the same data path. */
export function canReplaceAkeSkillCast(runtime, skill, context) {
    const replacement = skill?.castReplacement;
    return Boolean(replacement && replacement.conditions.every(condition =>
        runtime.effects.evaluate(condition, context)));
}

export function executeAkeSkillCastReplacement(runtime, skill, context) {
    const { frame, sourceId, commandId, castId, skillId, commandType } = context;
    const castContext = { ...context, rootCastId: castId, rootSkillId: skillId,
        inputSkillId: skillId, inputCommandType: commandType,
        effectiveSkillType: skill.effectiveSkillType ?? commandType,
        skillType: skill.effectiveSkillType ?? commandType,
        blackboard: structuredClone(skill.blackboard ?? {}) };
    runtime.registerCastLineage({ castId });
    const amount = Number(skill.costValue ?? 0);
    if (amount > 0) runtime.resources.spend({ frame,
        poolRef: skill.costType === 'Atb'
            ? { resourceType: 'Atb', scope: 'Shared', ownerId: null }
            : { resourceType: skill.costType, scope: 'Entity', ownerId: sourceId },
        amount, sourceId, ownerId: sourceId,
        targetId: skill.costType === 'Atb' ? null : sourceId,
        reason: 'CastCost', commandId, castId, skillId,
        resourceSourceType: 'Skill', resourceGainMethod: 'Spend' });
    if (Number(skill.cooldownTicks) > 0) runtime.cooldowns.start({ frame,
        actorId: sourceId, memberId: context.memberId, skillId,
        skillType: castContext.skillType, durationTicks: Number(skill.cooldownTicks),
        commandId, castId, reason: 'SkillCast' });
    runtime.execute({ type: 'TriggerStatusEvent', target: sourceId,
        eventType: 'OnBeforeCastSkill', reason: 'OnBeforeCastSkill' }, castContext);
    runtime.execute(skill.castReplacement.actions, castContext);
    return castContext;
}
