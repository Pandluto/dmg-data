export const PLUNGING_IMPACT_MODE = 'plunging-impact';

export function isPlungingImpactInput(command) {
    return command.commandType === 'Attack' && command.attackMode === PLUNGING_IMPACT_MODE;
}

// The original normal-attack group contains both flight and landing assets.
// Only a typed, unambiguous landing member is a tactical input capability.
export function plungingAttackEndCapability(roles, programs) {
    const candidates = (roles.groups?.normalAttack ?? []).filter(skillId =>
        programs.get(skillId)?.skillSpecification === 'CharacterPlungingAttack'
        && /(?:^|_)end$/.test(skillId));
    return candidates.length === 1 ? candidates[0] : null;
}

export function plungingImpactInputRejection({ roles, actorId, mainCharacterId }) {
    if (actorId !== mainCharacterId) return 'PLUNGING_IMPACT_REQUIRES_MAIN_CHARACTER';
    if (!roles.plungingAttackEndId) return 'PLUNGING_ATTACK_UNAVAILABLE';
    return null;
}
