function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function descriptorNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!isRecord(value)) return null;
    const direct = Number(value.value);
    return Number.isFinite(direct) ? direct : null;
}

function walkActions(actions, visit) {
    for (const action of actions ?? []) {
        if (!isRecord(action)) continue;
        visit(action);
        for (const key of ['actions', 'success', 'failure', 'children', 'steps']) {
            if (Array.isArray(action[key])) walkActions(action[key], visit);
        }
    }
}

function stateDescriptor(blackboardKey) {
    const normalized = String(blackboardKey ?? '').toLowerCase();
    if (normalized === 'entitybb_noguard_count') {
        return {
            stateKey: 'no-guard',
            statusBuffId: 'buff_physical_no_guard'
        };
    }
    const match = /^entitybb_(.+?)_count$/i.exec(String(blackboardKey ?? ''));
    if (!match) return null;
    return {
        stateKey: match[1]
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replaceAll('_', '-')
            .toLowerCase(),
        statusBuffId: null
    };
}

/**
 * Detects serialized AKE skills whose opening action selects a timeline branch
 * through short-lived `..._countN` marker Buffs. The contract is inferred from
 * the compiled actions themselves: no character id or skill id is consulted.
 */
export function extractAkeSkillStateVariantRules(program) {
    if (!isRecord(program) || !Array.isArray(program.timeline)) return [];
    const candidates = [];
    const openingActions = program.timeline
        .filter(group => Number(group?.startFrame ?? 0) === 0)
        .flatMap(group => group.actions ?? []);

    walkActions(openingActions, action => {
        if (action.type !== 'IfElseAction') return;
        const conditions = Array.isArray(action.conditions) ? action.conditions : [];
        const markerCondition = conditions.find(condition => (
            condition?.type === 'BuffStackCompare'
        ));
        if (!markerCondition) return;
        const markerBuffIds = [
            ...(typeof markerCondition.buffId === 'string' ? [markerCondition.buffId] : []),
            ...(Array.isArray(markerCondition.buffIds) ? markerCondition.buffIds : [])
        ];
        const marker = markerBuffIds.map(buffId => {
            const match = /^(.*?_count)(\d+)$/i.exec(String(buffId));
            return match ? {
                markerBuffId: String(buffId),
                markerPrefix: match[1].toLowerCase(),
                suffixValue: Number(match[2])
            } : null;
        }).find(Boolean);
        if (!marker) return;

        const assignments = [];
        walkActions(action.success, successAction => {
            if (successAction.type !== 'ModifyEntityBlackboard'
                || successAction.operation !== 'Assign') return;
            const value = descriptorNumber(successAction.value);
            const descriptor = stateDescriptor(successAction.key);
            if (!descriptor || value === null) return;
            assignments.push({
                ...descriptor,
                blackboardKey: successAction.key,
                value
            });
        });
        const assignment = assignments.find(entry => entry.value === marker.suffixValue)
            ?? assignments[0];
        if (!assignment) return;
        candidates.push({ ...marker, ...assignment });
    });

    const grouped = new Map();
    for (const candidate of candidates) {
        const key = [
            candidate.blackboardKey,
            candidate.markerPrefix,
            candidate.statusBuffId ?? ''
        ].join('\u0000');
        const branches = grouped.get(key) ?? [];
        if (!branches.some(branch => branch.value === candidate.value)) {
            branches.push({
                value: candidate.value,
                markerBuffId: candidate.markerBuffId
            });
        }
        grouped.set(key, branches);
    }

    return [...grouped.entries()].flatMap(([key, branches]) => {
        if (branches.length < 2) return [];
        const [blackboardKey] = key.split('\u0000');
        const descriptor = stateDescriptor(blackboardKey);
        if (!descriptor) return [];
        return [{
            blackboardKey,
            stateKey: descriptor.stateKey,
            statusBuffId: descriptor.statusBuffId,
            branches: branches.sort((left, right) => left.value - right.value)
        }];
    });
}

export function resolveAkeSkillStateVariantBranch(rule, value) {
    if (!rule || !Array.isArray(rule.branches) || rule.branches.length === 0) return null;
    const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
    return [...rule.branches]
        .sort((left, right) => (
            Math.abs(left.value - numeric) - Math.abs(right.value - numeric)
            || left.value - right.value
        ))[0] ?? null;
}

export function countAkeStatusStacks(statusEffects, targetId, buffId) {
    if (!statusEffects || !buffId) return 0;
    return statusEffects.list({
        active: true,
        targetId,
        buffId
    }).reduce((sum, instance) => sum + Number(instance.stackCount ?? 0), 0);
}

