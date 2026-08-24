(function (global) {
    'use strict';

    const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

    function isObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function firstDefined() {
        for (let index = 0; index < arguments.length; index += 1) {
            const value = arguments[index];
            if (value !== undefined && value !== null) return value;
        }
        return null;
    }

    function finiteNumber(value) {
        if (value === '' || value === null || value === undefined) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function formatActionType(type) {
        if (!type) return 'UnknownAction';
        const qualifiedName = String(type).split(',')[0].trim();
        const ownerName = qualifiedName.split('+')[0].trim();
        const parts = ownerName.split('.').filter(Boolean);
        let typeName = parts.pop() || ownerName;

        // Older exports encode nested Data classes with dots instead of '+'.
        if (typeName === 'Data') {
            typeName = parts.pop() || typeName;
        } else if (/ActionData$/i.test(typeName)) {
            const parentName = parts[parts.length - 1];
            typeName = parentName && /Action$/i.test(parentName)
                ? parentName
                : typeName.replace(/Data$/i, '');
        }
        return typeName.trim() || 'UnknownAction';
    }

    function blackboardScalar(entry) {
        if (!isObject(entry)) return entry;
        if (hasOwn(entry, 'valueStr') && entry.valueStr !== '') return entry.valueStr;
        if (hasOwn(entry, 'valueDouble')) return entry.valueDouble;
        if (hasOwn(entry, 'value')) return entry.value;
        return entry;
    }

    function normalizePatchInput(skillData, patchInput, warnings) {
        if (patchInput === undefined || patchInput === null) return null;

        let patches = [];
        if (Array.isArray(patchInput)) {
            patches = patchInput;
        } else if (isObject(patchInput)) {
            if (Array.isArray(patchInput.SkillPatchDataBundle)) {
                patches = patchInput.SkillPatchDataBundle;
            } else if (Array.isArray(patchInput.skillPatchDataBundle)) {
                patches = patchInput.skillPatchDataBundle;
            } else if (Array.isArray(patchInput.blackboard) || hasOwn(patchInput, 'level')) {
                patches = [patchInput];
            }
        }

        patches = patches.filter(isObject);
        if (!patches.length) {
            warnings.push({
                code: 'INVALID_PATCH_BUNDLE',
                message: 'SkillPatch input does not contain a usable level patch.'
            });
            return null;
        }

        const requestedLevel = finiteNumber(skillData?.level);
        let selected = requestedLevel === null
            ? null
            : patches.find(patch => finiteNumber(patch.level) === requestedLevel);

        if (!selected) {
            selected = patches[0];
            if (patches.length > 1 || (requestedLevel !== null && finiteNumber(selected.level) !== requestedLevel)) {
                warnings.push({
                    code: 'PATCH_LEVEL_FALLBACK',
                    message: requestedLevel === null
                        ? `No requested level was supplied; using patch level ${selected.level ?? '?'}.`
                        : `Patch level ${requestedLevel} was not found; using level ${selected.level ?? '?'}.`,
                    requestedLevel,
                    selectedLevel: finiteNumber(selected.level)
                });
            }
        }

        return selected;
    }

    function buildBlackboard(skillData, patchBundle) {
        const data = isObject(skillData) ? skillData : {};
        const warnings = [];
        const byKey = Object.create(null);

        const appendEntries = (items, source, level) => {
            if (!Array.isArray(items)) return;
            items.forEach((item, index) => {
                if (!isObject(item) || item.key === undefined || item.key === null || item.key === '') return;
                const key = String(item.key);
                const value = blackboardScalar(item);
                const previous = byKey[key];
                const history = previous ? previous.history.slice() : [];
                history.push({ source, level, value });

                if (previous && previous.source === source) {
                    warnings.push({
                        code: 'DUPLICATE_BLACKBOARD_KEY',
                        message: `Blackboard key "${key}" occurs more than once in ${source}.`,
                        key,
                        source,
                        index
                    });
                }

                byKey[key] = {
                    key,
                    value,
                    valueStr: item.valueStr ?? '',
                    isDynamic: !!item.isDynamic,
                    source,
                    level,
                    overridden: history.length > 1,
                    defaultValue: history[0]?.value,
                    history
                };
            });
        };

        appendEntries(data.blackboard, 'skill', finiteNumber(data.level));
        const selectedPatch = normalizePatchInput(data, patchBundle, warnings);
        if (selectedPatch) {
            appendEntries(selectedPatch.blackboard, 'patch', finiteNumber(selectedPatch.level));
        }

        const patch = selectedPatch ? {
            skillId: selectedPatch.skillId ?? '',
            level: finiteNumber(selectedPatch.level),
            coolDown: selectedPatch.coolDown ?? null,
            costType: selectedPatch.costType ?? null,
            costValue: selectedPatch.costValue ?? null,
            maxChargeTime: selectedPatch.maxChargeTime ?? null,
            iconId: selectedPatch.iconId ?? ''
        } : null;

        return {
            entries: Object.keys(byKey).map(key => byKey[key]),
            byKey,
            requestedLevel: finiteNumber(data.level),
            level: patch?.level ?? finiteNumber(data.level),
            patch,
            warnings
        };
    }

    function overlayBlackboard(blackboard, overlay, source) {
        if (!blackboard || !overlay) return blackboard;
        const pairs = overlay instanceof Map
            ? Array.from(overlay.entries())
            : Object.entries(overlay);
        pairs.forEach(([rawKey, rawValue]) => {
            const key = String(rawKey || '');
            if (!key) return;
            const resolution = isObject(rawValue) && hasOwn(rawValue, 'resolved')
                ? rawValue
                : {
                    value: blackboardScalar(rawValue),
                    resolved: true,
                    source: source || 'inherited'
                };
            const previous = blackboard.byKey[key];
            const history = previous ? previous.history.slice() : [];
            history.push({
                source: source || 'inherited',
                level: blackboard.level,
                value: resolution.resolved === false ? null : resolution.value
            });
            blackboard.byKey[key] = {
                key,
                value: resolution.resolved === false ? null : resolution.value,
                valueStr: '',
                isDynamic: true,
                source: source || 'inherited',
                level: blackboard.level,
                overridden: history.length > 1,
                defaultValue: history[0]?.value,
                history,
                resolved: resolution.resolved !== false,
                inheritedResolution: resolution
            };
        });
        blackboard.entries = Object.keys(blackboard.byKey).map(key => blackboard.byKey[key]);
        return blackboard;
    }

    function findBlackboardEntry(blackboard, key) {
        if (!blackboard || !key) return undefined;
        if (blackboard instanceof Map) return blackboard.get(key);
        if (Array.isArray(blackboard)) {
            return blackboard.find(entry => String(entry?.key ?? '') === key);
        }
        if (isObject(blackboard.byKey) && hasOwn(blackboard.byKey, key)) {
            return blackboard.byKey[key];
        }
        if (hasOwn(blackboard, key)) return blackboard[key];
        return undefined;
    }

    function resolveValue(value, blackboard) {
        const isReference = isObject(value)
            && hasOwn(value, 'useBlackboardKey')
            && hasOwn(value, 'blackboardKey')
            && hasOwn(value, 'value');

        if (!isReference) {
            return {
                value,
                usesBlackboard: false,
                blackboardKey: null,
                resolved: true,
                source: 'literal',
                fallbackValue: value
            };
        }

        const fallbackValue = value.value;
        const key = value.blackboardKey ? String(value.blackboardKey) : '';
        if (!value.useBlackboardKey || !key) {
            return {
                value: fallbackValue,
                usesBlackboard: false,
                blackboardKey: key || null,
                resolved: true,
                source: 'literal',
                fallbackValue
            };
        }

        const entry = findBlackboardEntry(blackboard, key);
        if (entry !== undefined) {
            return {
                value: blackboardScalar(entry),
                usesBlackboard: true,
                blackboardKey: key,
                resolved: true,
                source: entry?.source || 'blackboard',
                fallbackValue
            };
        }

        return {
            value: fallbackValue,
            usesBlackboard: true,
            blackboardKey: key,
            resolved: false,
            source: 'fallback',
            fallbackValue
        };
    }

    function isPresentationType(type) {
        const normalized = String(type || '').toLowerCase();
        if (/^(check|compare)/.test(normalized)
            || normalized.includes('effectfindtarget')
            || normalized.includes('raycasteffect')) return false;
        return normalized.includes('animation')
            || normalized.includes('animator')
            || normalized.includes('animevent')
            || normalized.includes('hurtanim')
            || normalized.includes('dashanim')
            || normalized.includes('dodgeanim')
            || normalized.includes('playanim')
            || normalized.includes('effect')
            || normalized.includes('playsound')
            || normalized.includes('voice')
            || normalized.includes('camera')
            || normalized.includes('warningaction')
            || normalized.includes('showhideactor')
            || normalized.includes('weaponvisible')
            || normalized.includes('weaponanimation')
            || normalized.includes('weaponmountpoint')
            || normalized.includes('hideui')
            || normalized.includes('showcomboskillui')
            || normalized.includes('forcehideheadbar')
            || normalized.includes('ultimateshow')
            || normalized.includes('togglemesh')
            || normalized.includes('debugprint')
            || normalized === 'logaction';
    }

    function isMovementType(type) {
        const normalized = String(type || '');
        if (/^JumpToAction$/i.test(normalized)) return false;
        return /^(Move|RootMotion|Teleport|JumpToTarget|SnapTo|SelfRotate|Pull|PushBack|SkillAIMove)/i.test(normalized)
            || /Move(To|Input|Direction|Location|Target|Slot)/i.test(normalized)
            || /RootMotion|Teleport/i.test(normalized);
    }

    function isActionNode(value) {
        return isObject(value) && !!value.$type
            && hasOwn(value, 'isEnable')
            && hasOwn(value, 'priorityLevel')
            && hasOwn(value, 'priorityOffset')
            && hasOwn(value, 'serverActionIndex');
    }

    function isNestedActionKey(key) {
        const normalized = String(key || '').toLowerCase();
        return normalized === 'action'
            || normalized === 'actiondata'
            || normalized === '_sequenceactiondata'
            || normalized === 'sequenceactiondata'
            || normalized === 'actionontick'
            || normalized === 'actioninaura'
            || normalized === 'actionwhenexitaura'
            || normalized === 'abilityactionmap'
            || normalized === 'actiononevent'
            || normalized === 'onendaction'
            || normalized === 'condition'
            || normalized === 'conditionlist'
            || normalized === 'options'
            || normalized === 'actions'
            || normalized.endsWith('actions')
            || normalized.includes('conditionaction')
            || normalized.includes('succeedaction')
            || normalized.includes('successaction')
            || normalized.includes('failaction')
            || normalized.includes('thenaction')
            || normalized.includes('elseaction');
    }

    function classifyAction(type) {
        const normalized = String(type || '').toLowerCase();
        if (isPresentationType(type)) return 'presentation';
        if (normalized.includes('damageaction') || normalized === 'waterdronehitaction') return 'damage';
        if (normalized.includes('heal') || normalized.includes('recoverpoise')) return 'recovery';
        if (normalized.includes('superarmor') || normalized.includes('armor')) return 'defense';
        if (normalized.includes('allownextskill') || normalized.includes('combocache')
            || normalized.includes('markcaninterrupt') || normalized.includes('markcandash')
            || normalized.includes('blockmoveinterrupt')) return 'cancel';
        if (normalized.includes('hitstop') || normalized.includes('timedilation')
            || normalized.includes('channeling') || normalized.includes('tickinterval')
            || normalized === 'jumptoaction' || normalized.includes('pausecomboskilltime')) return 'timing';
        if (normalized.includes('buff') || normalized.includes('aura') || normalized.includes('weakness')
            || normalized.includes('tagaction') || normalized.includes('dispel')) return 'buff';
        if (normalized.includes('projectile') || normalized.includes('castskill')
            || normalized.includes('spawnabilityentity') || normalized.includes('spawnenemy')) return 'spawn';
        if (normalized.includes('cost') || normalized.includes('atb') || normalized.includes('usp')
            || normalized.includes('resource')) return 'resource';
        if (normalized === 'interruptaction' || normalized.includes('crushaction')
            || normalized.includes('fractureaction') || normalized.includes('spellinfliction')
            || normalized.includes('blowoff') || normalized.includes('airborne')
            || normalized.includes('knockdown') || normalized.includes('takedown')
            || normalized.includes('launchupward') || normalized.includes('slowaction')) return 'control';
        if (isMovementType(type)) return 'movement';
        if (normalized.includes('condition') || normalized.includes('ifelse')
            || normalized.startsWith('check') || normalized.startsWith('compare')
            || normalized.includes('blackboard') || normalized.includes('calcbb')
            || normalized.startsWith('save') || normalized.startsWith('store')
            || normalized.includes('probablity') || normalized.includes('random')
            || normalized.includes('switchaction') || normalized.includes('foreach')
            || normalized.includes('repeataction') || normalized.includes('doonce')) return 'logic';
        if (normalized.includes('findtarget') || normalized.includes('picktarget')
            || normalized.includes('mergetarget') || normalized.includes('targetpostprocessor')
            || normalized.includes('converttotarget')) return 'targeting';
        return 'other';
    }

    function frameInfo(startFrame, endFrame) {
        const start = finiteNumber(startFrame);
        const end = finiteNumber(endFrame);
        return {
            startFrame: start,
            endFrame: end,
            durationFrames: start !== null && end !== null && end >= start ? end - start : null
        };
    }

    async function analyzeSkill(skillData, patchBundle, context) {
        const data = isObject(skillData) ? skillData : {};
        const metaContext = isObject(context) ? context : {};
        const requestedLevel = firstDefined(metaContext.level, metaContext.skillLevel, data.level);
        const blackboardData = buildBlackboard(
            requestedLevel === data.level ? data : Object.assign({}, data, { level: requestedLevel }),
            patchBundle
        );
        overlayBlackboard(blackboardData, metaContext._spatialInheritedBlackboard, 'inherited');
        const warnings = blackboardData.warnings.slice();
        const warningKeys = new Set(warnings.map(item => `${item.code}|${item.key || ''}|${item.message || ''}`));
        const windows = [];
        const hits = [];
        const events = [];
        const links = [];
        const linkKeys = new Set();
        const spatial = {
            unit: { distance: 'meter', angle: 'degree' },
            castLimits: [],
            selectionHints: [],
            targetSearches: [],
            impactVolumes: [],
            persistentFields: [],
            collisionVolumes: [],
            relations: [],
            warnings: [],
            externalVariants: [],
            pendingReferences: []
        };
        const spatialWarningKeys = new Set();
        const spatialMutations = [];
        const spawnReferences = [];
        const consumedSpatialKeys = new Set();
        const scopeId = String(metaContext._spatialScope || data.skillId || 'unknown');
        let spatialFactSerial = 0;

        const addSpatialWarning = (code, message, details) => {
            const key = `${code}|${details?.path || ''}|${details?.key || ''}|${message}`;
            if (spatialWarningKeys.has(key)) return;
            spatialWarningKeys.add(key);
            spatial.warnings.push(Object.assign({ code, message }, details || {}));
        };

        const normalizedNamedOperation = operation => {
            const value = String(operation ?? '').toLowerCase();
            if (value.includes('assign') || value === 'set') return 'Assign';
            if (value.includes('subtract') || value === 'sub') return 'Subtract';
            if (value.includes('multiply') || value === 'mul') return 'Multiply';
            if (value.includes('divide') || value === 'div') return 'Divide';
            if (value.includes('add') || value === 'plus') return 'Add';
            return operation ? String(operation) : 'Unknown';
        };

        const normalizedPotentialOperation = operation => {
            const value = String(operation ?? '').trim();
            if (value === '1') return 'Add';
            if (value === '2') return 'Multiply';
            if (value === '3') return 'Assign';
            return normalizedNamedOperation(operation);
        };

        const normalizedBlackboardOperation = operation => {
            const value = String(operation ?? '').trim();
            if (value === '0') return 'Assign';
            if (value === '1') return 'Add';
            if (value === '2') return 'Multiply';
            if (value === '3') return 'Divide';
            return normalizedNamedOperation(operation);
        };

        const collectExternalVariants = () => {
            const result = [];
            const table = metaContext.tables?.potentialTalents
                || metaContext.tables?.PotentialTalentEffectTable
                || metaContext.potentialTalents;
            const rows = Array.isArray(table)
                ? table.map((row, index) => [row?.id || String(index), row])
                : Object.entries(isObject(table) ? table : {});
            rows.forEach(([rowKey, row]) => {
                const modifiers = [];
                (Array.isArray(row?.dataList) ? row.dataList : []).forEach((item, itemIndex) => {
                    const modifier = item?.skillBbModifier;
                    if (!isObject(modifier) || String(modifier.skillId || '') !== String(data.skillId || '')) return;
                    const key = String(modifier.bbKey || '');
                    if (!key) return;
                    const value = modifier.stringValue !== undefined && modifier.stringValue !== ''
                        ? modifier.stringValue
                        : modifier.floatValue;
                    modifiers.push({
                        key,
                        operation: normalizedPotentialOperation(modifier.modifyType),
                        rawOperation: modifier.modifyType,
                        value,
                        path: `PotentialTalentEffectTable.${rowKey}.dataList[${itemIndex}].skillBbModifier`
                    });
                });
                if (modifiers.length) {
                    result.push({
                        id: String(row?.id || rowKey),
                        source: 'PotentialTalentEffectTable',
                        skillId: data.skillId ?? '',
                        condition: { type: 'external', source: 'potential', sourceId: String(row?.id || rowKey) },
                        modifiers
                    });
                }
            });

            (Array.isArray(metaContext.externalSpatialVariants) ? metaContext.externalSpatialVariants : [])
                .forEach((variant, index) => {
                    if (!isObject(variant)) return;
                    if (variant.skillId && String(variant.skillId) !== String(data.skillId || '')) return;
                    const modifiers = (Array.isArray(variant.modifiers) ? variant.modifiers : [variant])
                        .map((modifier, modifierIndex) => ({
                            key: String(modifier?.key ?? modifier?.bbKey ?? ''),
                            operation: modifier?.operation !== undefined
                                ? normalizedNamedOperation(modifier.operation)
                                : normalizedPotentialOperation(modifier?.modifyType),
                            rawOperation: modifier?.operation ?? modifier?.modifyType,
                            value: firstDefined(modifier?.value, modifier?.floatValue, modifier?.stringValue),
                            path: modifier?.path || `externalSpatialVariants[${index}].modifiers[${modifierIndex}]`
                        }))
                        .filter(modifier => modifier.key);
                    if (!modifiers.length) return;
                    result.push({
                        id: String(variant.id || `external-${index}`),
                        source: variant.source || 'context',
                        skillId: data.skillId ?? '',
                        condition: variant.condition || { type: 'external', source: variant.source || 'context', sourceId: String(variant.id || index) },
                        modifiers
                    });
                });
            return result;
        };

        const externalVariants = collectExternalVariants();

        const combineConditions = conditions => {
            const items = (Array.isArray(conditions) ? conditions : []).filter(Boolean);
            if (!items.length) return null;
            return items.length === 1 ? items[0] : { type: 'all', items };
        };

        const conditionItems = condition => {
            if (!condition) return [];
            if (Array.isArray(condition)) return condition.flatMap(conditionItems);
            if (condition.type === 'all' && Array.isArray(condition.items)) {
                return condition.items.flatMap(conditionItems);
            }
            return [condition];
        };

        const branchControllerKey = condition => (
            `${condition?.controllerScope || scopeId}|${condition?.controllerEventIndex}`
        );

        const branchConstraints = conditions => {
            const result = new Map();
            conditionItems(conditions).forEach(condition => {
                if (condition?.type !== 'branch' || condition.controllerEventIndex === undefined
                    || condition.controllerEventIndex === null || !condition.outcome) return;
                result.set(branchControllerKey(condition), String(condition.outcome));
            });
            return result;
        };

        const conditionsCompatible = (leftConditions, rightConditions) => {
            const left = branchConstraints(leftConditions);
            const right = branchConstraints(rightConditions);
            for (const [controller, outcome] of left) {
                if (right.has(controller) && right.get(controller) !== outcome) return false;
            }
            return true;
        };

        const conditionsImply = (actualConditions, requiredConditions) => {
            const requiredItems = conditionItems(requiredConditions);
            if (!requiredItems.length) return true;
            if (requiredItems.some(condition => condition?.type !== 'branch')) return false;
            const actual = branchConstraints(actualConditions);
            const required = branchConstraints(requiredItems);
            return [...required].every(([controller, outcome]) => actual.get(controller) === outcome);
        };

        const mergeConditionItems = (left, right) => {
            const merged = [];
            const seen = new Set();
            conditionItems(left).concat(conditionItems(right)).forEach(condition => {
                const key = JSON.stringify(condition);
                if (seen.has(key)) return;
                seen.add(key);
                merged.push(condition);
            });
            return merged;
        };

        const conditionSignature = conditions => conditionItems(conditions)
            .map(condition => JSON.stringify(condition))
            .sort()
            .join('|');

        const applyNumericOperation = (current, operand, operation) => {
            if (operation === 'Assign') return { value: operand, resolved: operand !== undefined && operand !== null };
            const left = finiteNumber(current);
            const right = finiteNumber(operand);
            if (left === null || right === null) return { value: null, resolved: false };
            if (operation === 'Add') return { value: left + right, resolved: true };
            if (operation === 'Subtract') return { value: left - right, resolved: true };
            if (operation === 'Multiply') return { value: left * right, resolved: true };
            if (operation === 'Divide') {
                return right === 0
                    ? { value: null, resolved: false, error: 'DIVIDE_BY_ZERO' }
                    : { value: left / right, resolved: true };
            }
            return { value: null, resolved: false };
        };

        const baseSpatialResolution = (rawValue, path, suppressWarning) => {
            const base = resolveValue(rawValue, blackboardData);
            const entry = base.usesBlackboard ? findBlackboardEntry(blackboardData, base.blackboardKey) : null;
            const inherited = isObject(entry?.inheritedResolution) ? entry.inheritedResolution : null;
            const resolved = inherited
                ? Object.assign({}, inherited, {
                    usesBlackboard: true,
                    blackboardKey: base.blackboardKey,
                    fallbackValue: base.fallbackValue,
                    source: inherited.source || 'inherited'
                })
                : Object.assign({}, base);
            if (resolved.resolved === false) {
                resolved.value = null;
                if (!suppressWarning) {
                    addSpatialWarning(
                        'SPATIAL_RUNTIME_VALUE',
                        `Spatial blackboard key "${resolved.blackboardKey}" requires a runtime value.`,
                        { key: resolved.blackboardKey, path }
                    );
                }
            }
            resolved.variants = Array.isArray(resolved.variants) ? resolved.variants.slice() : [];
            return resolved;
        };

        const resolveSpatialField = (rawValue, path, eventLimit, trackKey, factConditions, flowId) => {
            const result = baseSpatialResolution(rawValue, path, trackKey === false);
            const key = result.usesBlackboard && result.blackboardKey ? String(result.blackboardKey) : '';
            if (!key) return result;
            if (trackKey !== false) consumedSpatialKeys.add(key);
            const limit = Number.isFinite(Number(eventLimit)) ? Number(eventLimit) : Number.POSITIVE_INFINITY;
            const activeConditions = conditionItems(factConditions);
            let variants = result.variants
                .filter(variant => conditionsCompatible(variant.condition, activeConditions));

            externalVariants.forEach(external => {
                const modifiers = external.modifiers.filter(modifier => modifier.key === key);
                if (!modifiers.length) return;
                let externalState = Object.assign({}, result);
                delete externalState.variants;
                modifiers.forEach(modifier => {
                    const calculated = applyNumericOperation(
                        externalState.resolved === false ? null : externalState.value,
                        modifier.value,
                        modifier.operation
                    );
                    externalState = Object.assign(externalState, {
                        value: calculated.value,
                        resolved: calculated.resolved,
                        source: external.source,
                        operation: modifier.operation,
                        operationPath: modifier.path,
                        condition: external.condition,
                        error: calculated.error || null
                    });
                });
                variants.push(externalState);
            });

            const applicableMutations = spatialMutations
                .filter(mutation => mutation.key === key
                    && !!flowId
                    && mutation.flowId === flowId
                    && mutation.eventIndex <= limit
                    && conditionsCompatible(mutation.conditions, activeConditions));

            applicableMutations.forEach(mutation => {
                    const operand = mutation.operand;
                    if (operand.resolved === false) {
                        addSpatialWarning(
                            'SPATIAL_RUNTIME_OPERATION_VALUE',
                            `Spatial operation for "${key}" requires a runtime operand.`,
                            { key, path: mutation.path }
                        );
                    }
                    const apply = candidate => {
                        const calculated = applyNumericOperation(
                            candidate.resolved === false ? null : candidate.value,
                            operand.resolved === false ? null : operand.value,
                            mutation.operation
                        );
                        return Object.assign({}, candidate, {
                            value: calculated.value,
                            resolved: calculated.resolved,
                            source: 'computed',
                            operation: mutation.operation,
                            operationPath: mutation.path,
                            error: calculated.error || null
                        });
                    };
                    if (mutation.conditions.length && !conditionsImply(activeConditions, mutation.conditions)) {
                        const matchingVariants = variants.filter(variant => (
                            conditionsCompatible(variant.condition, mutation.conditions)
                            && conditionsImply(variant.condition, mutation.conditions)
                        ));
                        if (matchingVariants.length) {
                            variants = variants.map(variant => {
                                if (!matchingVariants.includes(variant)) return variant;
                                return Object.assign(apply(variant), {
                                    condition: variant.condition,
                                    source: 'action'
                                });
                            });
                        } else {
                            const requiredBranches = branchConstraints(mutation.conditions);
                            const candidateGroups = new Map();
                            [{ state: result, condition: null }]
                                .concat(variants.map(variant => ({ state: variant, condition: variant.condition })))
                                .filter(candidate => conditionsCompatible(candidate.condition, mutation.conditions))
                                .forEach(candidate => {
                                    const items = conditionItems(candidate.condition);
                                    const unrelated = items.filter(condition => (
                                        condition?.type !== 'branch'
                                        || !requiredBranches.has(branchControllerKey(condition))
                                    ));
                                    const groupKey = unrelated
                                        .map(condition => JSON.stringify(condition))
                                        .sort()
                                        .join('|');
                                    const score = [...branchConstraints(candidate.condition)]
                                        .filter(([controller, outcome]) => requiredBranches.get(controller) === outcome)
                                        .length;
                                    const previous = candidateGroups.get(groupKey);
                                    if (!previous || score > previous.score) {
                                        candidateGroups.set(groupKey, Object.assign({ score }, candidate));
                                    }
                                });
                            candidateGroups.forEach(candidate => {
                                const computed = apply(candidate.state);
                                variants.push(Object.assign(computed, {
                                    condition: combineConditions(mergeConditionItems(candidate.condition, mutation.conditions)),
                                    source: 'action'
                                }));
                            });
                        }
                    } else {
                        Object.assign(result, apply(result));
                        variants = variants.map(variant => (
                            conditionsCompatible(variant.condition, mutation.conditions)
                                ? apply(variant)
                                : variant
                        ));
                    }
            });

            const activeBranches = branchConstraints(activeConditions);
            const branchOutcomes = new Map();
            applicableMutations.forEach(mutation => {
                const mutationBranches = branchConstraints(mutation.conditions);
                if (mutationBranches.size !== activeBranches.size + 1) return;
                if (![...activeBranches].every(([controller, outcome]) => (
                    mutationBranches.get(controller) === outcome
                ))) return;
                const extra = [...mutationBranches]
                    .find(([controller]) => !activeBranches.has(controller));
                if (!extra) return;
                if (!branchOutcomes.has(extra[0])) branchOutcomes.set(extra[0], new Set());
                branchOutcomes.get(extra[0]).add(extra[1]);
            });
            const exhaustiveControllers = [...branchOutcomes]
                .filter(([, outcomes]) => outcomes.has('success') && outcomes.has('failure'))
                .map(([controller]) => controller);
            if (exhaustiveControllers.length) {
                result.value = null;
                result.resolved = false;
                result.source = 'conditional';
                result.scenarioOnly = true;
                variants = variants.filter(variant => {
                    const constraints = branchConstraints(variant.condition);
                    return exhaustiveControllers.every(controller => constraints.has(controller));
                });
            }

            const seenVariants = new Set();
            result.variants = variants.filter(variant => {
                const dedupe = JSON.stringify([
                    variant.value,
                    variant.resolved,
                    variant.operation,
                    variant.condition
                ]);
                if (seenVariants.has(dedupe)) return false;
                seenVariants.add(dedupe);
                return true;
            });
            return result;
        };

        const spatialDimension = (rawValue, path, unit, eventLimit, conditions, flowId) => Object.assign(
            resolveSpatialField(rawValue, path, eventLimit, undefined, conditions, flowId),
            { unit: unit || 'meter' }
        );

        const resolutionState = dimensions => {
            const values = Object.values(dimensions || {});
            if (values.some(value => value?.resolved === false && value?.scenarioOnly !== true)) return 'runtime';
            if (values.some(value => value?.scenarioOnly === true
                || (Array.isArray(value?.variants) && value.variants.length))) return 'conditional';
            return 'resolved';
        };

        const inheritedSpatialConditions = conditionItems(metaContext._spatialInheritedConditions);

        const addSpatialFact = (collection, fact) => {
            const item = Object.assign({
                id: `spatial:${scopeId}:${spatialFactSerial++}`,
                skillId: data.skillId ?? '',
                confidence: 'medium',
                conditions: [],
                timing: null,
                origin: metaContext._spatialOrigin || null
            }, fact || {});
            item.conditions = mergeConditionItems(inheritedSpatialConditions, item.conditions);
            item.resolution = item.resolution || resolutionState(item.geometry?.dimensions);
            collection.push(item);
            return item;
        };
        const spatialRelationKeys = new Set();

        const addSpatialRelation = relation => {
            if (!isObject(relation) || !relation.type || !relation.from || !relation.to) return;
            const key = `${relation.type}|${relation.from}|${relation.to}|${relation.status || ''}`;
            if (spatialRelationKeys.has(key)) return;
            spatialRelationKeys.add(key);
            spatial.relations.push(relation);
        };

        const eventSpatialMetadata = event => ({
            actionType: event.type,
            eventIndex: event.index,
            eventSource: event.source,
            flowId: event.flowId,
            groupIndex: event.groupIndex,
            abilityEvent: event.abilityEvent,
            path: event.path,
            conditions: Array.isArray(event.conditions) ? event.conditions.slice() : [],
            timing: Object.assign({ scope: 'skill-local' }, frameInfo(event.startFrame, event.endFrame))
        });

        const keyedValue = (value, key, enabled) => ({
            useBlackboardKey: !!enabled && !!key,
            value,
            blackboardKey: key || ''
        });

        const uiKeyedValue = (shape, name) => {
            const upper = `${name[0].toUpperCase()}${name.slice(1)}`;
            return keyedValue(shape?.[name], shape?.[`${name}Key`], shape?.[`use${upper}Key`]);
        };

        const vectorDimensions = (vector, path, prefix, unit, eventLimit, conditions, flowId) => {
            const result = {};
            ['x', 'y', 'z'].forEach(axis => {
                if (!isObject(vector) || !hasOwn(vector, axis)) return;
                result[prefix ? `${prefix}${axis.toUpperCase()}` : axis] = spatialDimension(
                    vector[axis], `${path}.${axis}`, unit, eventLimit, conditions, flowId
                );
            });
            return result;
        };

        const parseUiGeometry = (shapeData, path) => {
            if (!isObject(shapeData)) return null;
            const allowed = new Set(['Point', 'Circle', 'Sector', 'Arrow']);
            const shape = String(shapeData.shape || '');
            if (!allowed.has(shape)) {
                addSpatialWarning('SPATIAL_UNSUPPORTED_UI_SHAPE', `Unsupported UI range shape "${shape || '?'}".`, { path });
                return null;
            }
            const dimensions = {};
            if (shape === 'Circle' || shape === 'Sector') {
                dimensions.radius = spatialDimension(
                    uiKeyedValue(shapeData, 'radius'), `${path}.radius`, 'meter', -1
                );
            }
            if (shape === 'Sector') {
                dimensions.angle = spatialDimension(
                    uiKeyedValue(shapeData, 'angle'), `${path}.angle`, 'degree', -1
                );
            }
            if (shape === 'Arrow') {
                dimensions.width = spatialDimension(
                    uiKeyedValue(shapeData, 'width'), `${path}.width`, 'meter', -1
                );
                const extent = isObject(shapeData.extent) ? shapeData.extent : {};
                const useExtentKey = !!shapeData.useExtentKey;
                const extentX = finiteNumber(extent.x);
                const extentY = finiteNumber(extent.y);
                if (shapeData.fixedExtent || useExtentKey
                    || (extentX !== null && extentX !== 0)
                    || (extentY !== null && extentY !== 0)) {
                    dimensions.extentX = spatialDimension(
                        keyedValue(extent.x, shapeData.extentXKey, useExtentKey), `${path}.extent.x`, 'meter', -1
                    );
                    dimensions.extentZ = spatialDimension(
                        keyedValue(extent.y, shapeData.extentZKey, useExtentKey), `${path}.extent.y`, 'meter', -1
                    );
                }
            }

            const centerOffset = isObject(shapeData.centerOffset) ? shapeData.centerOffset : {};
            const anchor = {
                centerBaseIsEndPoint: !!shapeData.centerBaseIsEndPoint,
                restrictEndPointInRange: !!shapeData.restrictEndPointInRange,
                centerOffset: {
                    x: spatialDimension(
                        keyedValue(centerOffset.x, shapeData.centerOffsetXKey, shapeData.useCenterOffsetKey),
                        `${path}.centerOffset.x`, 'meter', -1
                    ),
                    z: spatialDimension(
                        keyedValue(centerOffset.y, shapeData.centerOffsetZKey, shapeData.useCenterOffsetKey),
                        `${path}.centerOffset.y`, 'meter', -1
                    )
                }
            };
            return { geometry: { space: 'ui-2d', shape, dimensions }, anchor };
        };

        const parseHitBoxGeometry = (shapeData, path, eventIndex, conditions, flowId) => {
            if (!isObject(shapeData)) return null;
            const shapeMap = { box: 'Box', capsule: 'Capsule', sphere: 'Sphere', point: 'Point' };
            const shape = shapeMap[String(shapeData.shapeType || '').toLowerCase()];
            if (!shape) {
                addSpatialWarning(
                    'SPATIAL_UNSUPPORTED_HITBOX_SHAPE',
                    `Unsupported hit-box shape "${shapeData.shapeType || '?'}".`,
                    { path }
                );
                return null;
            }
            const dimensions = {};
            if (shape === 'Box') {
                Object.assign(dimensions, vectorDimensions(shapeData.size, `${path}.size`, 'size', 'meter', eventIndex, conditions, flowId));
            } else if (shape === 'Capsule') {
                dimensions.radius = spatialDimension(shapeData.radius, `${path}.radius`, 'meter', eventIndex, conditions, flowId);
                dimensions.height = spatialDimension(shapeData.height, `${path}.height`, 'meter', eventIndex, conditions, flowId);
            } else if (shape === 'Sphere') {
                dimensions.radius = spatialDimension(shapeData.radius, `${path}.radius`, 'meter', eventIndex, conditions, flowId);
            }
            if (shapeData.limitAngle) {
                dimensions.angle = spatialDimension(shapeData.angle, `${path}.angle`, 'degree', eventIndex, conditions, flowId);
            }
            if (shapeData.limitHeight) {
                dimensions.maxHeight = spatialDimension(shapeData.maxHeight, `${path}.maxHeight`, 'meter', eventIndex, conditions, flowId);
            }
            const anchor = {
                positionRef: shapeData.positionRef ?? '',
                positionMountPoint: shapeData.posRefMP ?? '',
                directionRef: shapeData.directionRef ?? '',
                directionMountPoint: shapeData.dirRefMountPoint ?? '',
                castDirection: shapeData.castDirection ?? '',
                useDirection: !!shapeData.useDirection,
                centerOffset: vectorDimensions(shapeData.centerOffset, `${path}.centerOffset`, '', 'meter', eventIndex, conditions, flowId),
                eulerAngle: vectorDimensions(shapeData.eulerAngle, `${path}.eulerAngle`, '', 'degree', eventIndex, conditions, flowId)
            };
            return { geometry: { space: 'world-3d', shape, dimensions }, anchor };
        };

        const auraKeyedValue = (shape, name) => {
            const key = shape?.[`_${name}Key`];
            return keyedValue(shape?.[`_${name}`], key, !!key);
        };

        const parseAuraGeometry = (shapeData, path, eventIndex, conditions, flowId) => {
            if (!isObject(shapeData)) return null;
            const shapeMap = { box: 'Box', capsule: 'Capsule', sphere: 'Sphere', point: 'Point' };
            const shape = shapeMap[String(shapeData._shape ?? shapeData.shape ?? '').toLowerCase()];
            if (!shape) {
                addSpatialWarning(
                    'SPATIAL_UNSUPPORTED_AURA_SHAPE',
                    `Unsupported aura shape "${shapeData._shape ?? shapeData.shape ?? '?'}".`,
                    { path }
                );
                return null;
            }
            const dimensions = {};
            if (shape === 'Box') {
                const extent = isObject(shapeData._extent) ? shapeData._extent : {};
                ['x', 'y', 'z'].forEach(axis => {
                    const upper = axis.toUpperCase();
                    dimensions[`extent${upper}`] = spatialDimension(
                        keyedValue(extent[axis], shapeData[`_extent${upper}Key`], shapeData._useExtentKey),
                        `${path}._extent.${axis}`, 'meter', eventIndex, conditions, flowId
                    );
                });
            } else if (shape === 'Capsule') {
                dimensions.radius = spatialDimension(auraKeyedValue(shapeData, 'radius'), `${path}._radius`, 'meter', eventIndex, conditions, flowId);
                dimensions.height = spatialDimension(auraKeyedValue(shapeData, 'height'), `${path}._height`, 'meter', eventIndex, conditions, flowId);
            } else if (shape === 'Sphere') {
                dimensions.radius = spatialDimension(auraKeyedValue(shapeData, 'radius'), `${path}._radius`, 'meter', eventIndex, conditions, flowId);
            }
            const center = isObject(shapeData._center) ? shapeData._center : {};
            const centerOffset = {};
            ['x', 'y', 'z'].forEach(axis => {
                const upper = axis.toUpperCase();
                centerOffset[axis] = spatialDimension(
                    keyedValue(center[axis], shapeData[`_center${upper}Key`], shapeData._useCenterKey),
                    `${path}._center.${axis}`, 'meter', eventIndex, conditions, flowId
                );
            });
            return {
                geometry: { space: 'world-3d', shape, dimensions },
                anchor: { centerOffset }
            };
        };

        const addWarning = (code, message, details) => {
            const key = `${code}|${details?.path || ''}|${details?.key || ''}|${message}`;
            if (warningKeys.has(key)) return;
            warningKeys.add(key);
            warnings.push(Object.assign({ code, message }, details || {}));
        };

        const resolveField = (value, path) => {
            const resolved = resolveValue(value, blackboardData);
            if (resolved.usesBlackboard && !resolved.resolved) {
                addWarning(
                    'UNRESOLVED_BLACKBOARD_KEY',
                    `Blackboard key "${resolved.blackboardKey}" was not found; the embedded fallback is used.`,
                    { key: resolved.blackboardKey, path }
                );
            }
            return resolved;
        };

        const character = isObject(metaContext.character) ? metaContext.character : {};
        const group = isObject(metaContext.group) ? metaContext.group : {};
        const variant = isObject(metaContext.variant) ? metaContext.variant : {};
        const castData = isObject(data.castData) ? data.castData : {};
        const runtimeCost = isObject(castData.costData) ? castData.costData : {};
        const durationFrame = finiteNumber(data.durationFrame);

        const basic = {
            skillId: data.skillId ?? '',
            skillName: data.skillName ?? '',
            level: firstDefined(requestedLevel, blackboardData.level),
            runtimeLevel: finiteNumber(data.level),
            characterId: firstDefined(metaContext.characterId, metaContext.charId, character.id, character.charId),
            characterName: firstDefined(metaContext.characterName, character.name),
            skillGroupId: firstDefined(metaContext.skillGroupId, metaContext.groupId, group.id, group.skillGroupId),
            skillGroupName: firstDefined(metaContext.skillGroupName, metaContext.groupName, group.name),
            skillGroupType: firstDefined(metaContext.skillGroupType, metaContext.groupType, group.type, group.skillGroupType),
            variantId: firstDefined(metaContext.variantId, variant.id, data.skillId),
            variantName: firstDefined(metaContext.variantName, variant.name, data.skillName),
            castType: data.castType ?? '',
            skillSpecification: data.skillSpecification ?? '',
            durationFrame,
            durationSeconds: null,
            exclusiveFrame: finiteNumber(data.exclusiveFrame),
            offsetRecordFrame: finiteNumber(data.offsetRecordFrame),
            useAIExclusiveFrame: !!data.useAIExclusiveFrame,
            aiExclusiveFrame: finiteNumber(data.aiExclusiveFrame),
            dontInterruptCombo: !!data.dontInterruptCombo,
            timeBasis: {
                durationFrame: null,
                exclusiveFrame: null,
                actionGroupFrame: null,
                startCdFrame: 30
            },
            targeting: {
                attackRangeType: data.attackRangeType ?? '',
                selectStrategy: data.selectStrategy ?? '',
                smartTargetSelectStrategy: data.smartTargetSelectStrategy ?? '',
                checkCastDistanceType: castData.checkCastDistanceType ?? '',
                useCustomCastDistance: !!castData.useCustomCastDistance,
                castDistance: resolveField(castData.castDistance, 'castData.castDistance'),
                checkHeightDiff: !!castData.checkHeightDiff,
                heightDiffLimit: resolveField(castData.heightDiffLimit, 'castData.heightDiffLimit'),
                rotateType: castData.rotateType ?? '',
                castAngle: castData.castAngle ?? null
            },
            mobility: {
                canMove: !!data.canMove,
                canCastInAir: !!data.canCastInAir,
                canDummyCast: !!data.canDummyCast,
                rootMotionCliffCheck: !!data.rootMotionCliffCheck,
                characterReturnToIdle: !!data.characterReturnToIdle,
                dummyPositionOffset: data.dummyPositionOffset ?? null
            },
            runtimeCast: {
                cooldownTime: castData.cooldownTime ?? null,
                startCdFrame: finiteNumber(castData.startCdFrame),
                maxChargeTime: castData.maxChargeTime ?? null,
                costType: runtimeCost.costType ?? null,
                costValue: resolveField(runtimeCost.costValue, 'castData.costData.costValue'),
                atbValueThreshold: resolveField(runtimeCost.atbValueThreshold, 'castData.costData.atbValueThreshold')
            },
            patch: blackboardData.patch
        };

        const eventReference = event => ({
            eventIndex: event.index,
            type: event.type,
            source: event.source,
            abilityEvent: event.abilityEvent,
            groupIndex: event.groupIndex,
            startFrame: event.startFrame,
            endFrame: event.endFrame,
            durationFrames: event.durationFrames,
            branchPath: event.branchPath.slice(),
            path: event.path
        });

        const addWindow = (kind, event, details) => {
            windows.push(Object.assign({ kind }, eventReference(event), details || {}));
        };

        const addSkillWindow = (kind, startFrame, endFrame, details) => {
            const range = frameInfo(startFrame, endFrame);
            windows.push(Object.assign({
                kind,
                type: 'Skill',
                source: 'skill',
                abilityEvent: null,
                groupIndex: null,
                eventIndex: null,
                branchPath: [],
                path: kind
            }, range, details || {}));
        };

        if (basic.exclusiveFrame !== null && basic.exclusiveFrame > 0) {
            addSkillWindow('exclusive', 0, basic.exclusiveFrame);
        }
        if (basic.offsetRecordFrame !== null && basic.offsetRecordFrame > 0) {
            addSkillWindow('offsetRecord', basic.offsetRecordFrame, basic.offsetRecordFrame);
        }
        if (basic.runtimeCast.startCdFrame !== null && basic.runtimeCast.startCdFrame >= 0) {
            addSkillWindow('costCommit', basic.runtimeCast.startCdFrame, basic.runtimeCast.startCdFrame);
        }

        const addLink = (kind, id, relation, event, details) => {
            if (id === undefined || id === null || id === '') return;
            const normalizedId = String(id);
            const dedupeKey = `${kind}|${normalizedId}|${relation}|${event.path}`;
            if (linkKeys.has(dedupeKey)) return;
            linkKeys.add(dedupeKey);
            links.push(Object.assign({ kind, id: normalizedId, relation }, eventReference(event), details || {}));
        };

        const addResolvedLink = (kind, rawId, relation, event, path, details) => {
            const resolved = resolveField(rawId, path);
            addLink(kind, resolved.value, relation, event, Object.assign({ resolvedId: resolved }, details || {}));
            return resolved;
        };

        const resolvedFields = (action, keys, path) => {
            const result = {};
            keys.forEach(key => {
                if (hasOwn(action, key)) result[key] = resolveField(action[key], `${path}.${key}`);
            });
            return result;
        };

        const normalizeCostList = (list, path) => (Array.isArray(list) ? list : []).map((cost, index) => ({
            costType: cost?.costType ?? null,
            costValue: resolveField(cost?.costValue, `${path}[${index}].costValue`),
            atbValueThreshold: resolveField(cost?.atbValueThreshold, `${path}[${index}].atbValueThreshold`)
        }));

        const normalizeBuff = (buff, index, event, path) => {
            const values = Object.create(null);
            (Array.isArray(buff?.assignItems) ? buff.assignItems : []).forEach((item, itemIndex) => {
                const key = String(item?.targetKey ?? item?.inputValueKey ?? `value${itemIndex + 1}`);
                let rawValue;
                if (item?.useDirectValue) {
                    rawValue = item.directValueType === 'String' ? item.stringValue : item.numericValue;
                } else if (item?.inputValueKey) {
                    rawValue = {
                        useBlackboardKey: true,
                        value: item.numericValue ?? item.stringValue ?? null,
                        blackboardKey: item.inputValueKey
                    };
                } else {
                    rawValue = item?.numericValue ?? item?.stringValue ?? null;
                }
                values[key] = resolveField(rawValue, `${path}.assignItems[${itemIndex}]`);
            });

            let buffId = buff?.buffId ?? '';
            if (buff?.readIdFromBlackboard && buff?.buffIdKey) {
                buffId = resolveField({
                    useBlackboardKey: true,
                    value: buffId,
                    blackboardKey: buff.buffIdKey
                }, `${path}.buffIdKey`).value;
            }
            addLink('buff', buffId, 'createBuff', event, { buffIndex: index });
            return { buffId, values, raw: buff };
        };

        const summaryMetaKeys = new Set([
            '$type', 'isEnable', 'priorityLevel', 'priorityOffset', 'serverActionIndex'
        ]);
        const summaryPriority = [
            'skillId', 'castSkillId', 'targetSkillId', 'projectileId', 'abilityEntityId', 'enemyId',
            'buffId', 'buffIds', 'markerId', 'signalId', 'key', 'blackboardKey', 'bbKey', 'contextKey',
            'operation', 'operationType', 'calculateType', 'compare', 'compareType', 'value', 'valueA',
            'valueB', 'costType', 'costValue', 'coefficient', 'damageType', 'damageAttributeType',
            'healType', 'superArmorValue', 'impactResistance', 'overrideSuperArmorLimit', 'duration',
            'totalTime', 'triggerInterval', 'tickInterval', 'distance', 'moveDistance', 'horizontalSpeed',
            'verticalSpeed', 'height', 'targetGroupKey', 'targetSource', 'source', 'target', 'owner'
        ];
        const summaryPriorityIndex = new Map(summaryPriority.map((key, index) => [key.toLowerCase(), index]));
        const summaryFieldLimit = 32;

        const isBlackboardReference = value => isObject(value)
            && hasOwn(value, 'useBlackboardKey')
            && hasOwn(value, 'blackboardKey')
            && hasOwn(value, 'value');

        const countActionNodes = (value, depth) => {
            const currentDepth = Number(depth) || 0;
            if (!value || currentDepth > 24) return 0;
            if (Array.isArray(value)) {
                return value.reduce((total, child) => total + countActionNodes(child, currentDepth + 1), 0);
            }
            if (!isObject(value)) return 0;
            const ownCount = isActionNode(value) ? 1 : 0;
            return ownCount + Object.keys(value).reduce((total, key) => (
                total + countActionNodes(value[key], currentDepth + 1)
            ), 0);
        };

        const buildActionSummary = (action, path) => {
            const fields = [];
            let truncated = false;

            const append = (key, value, fieldPath) => {
                if (fields.length >= summaryFieldLimit) {
                    truncated = true;
                    return;
                }
                if (value === undefined || value === null || value === '') return;
                fields.push({ key: String(key || 'value').replace(/^_+/, ''), value, path: fieldPath });
            };

            const appendBlackboardPairs = (value, fieldPath) => {
                const consumed = new Set();
                Object.keys(value).forEach(flagKey => {
                    const match = /^use(.+)BlackboardKey$/i.exec(flagKey);
                    if (!match || value[flagKey] !== true) return;
                    const baseKey = `${match[1][0].toLowerCase()}${match[1].slice(1)}`;
                    const blackboardKeyField = `${baseKey}BlackboardKey`;
                    if (!hasOwn(value, baseKey) || !hasOwn(value, blackboardKeyField)) return;
                    append(baseKey, resolveField({
                        useBlackboardKey: true,
                        value: value[baseKey],
                        blackboardKey: value[blackboardKeyField]
                    }, `${fieldPath}.${baseKey}`), `${fieldPath}.${baseKey}`);
                    consumed.add(flagKey);
                    consumed.add(baseKey);
                    consumed.add(blackboardKeyField);
                });
                if (value.readIdFromBlackboard === true && value.buffIdKey && hasOwn(value, 'buffId')) {
                    append('buffId', resolveField({
                        useBlackboardKey: true,
                        value: value.buffId,
                        blackboardKey: value.buffIdKey
                    }, `${fieldPath}.buffId`), `${fieldPath}.buffId`);
                    consumed.add('readIdFromBlackboard');
                    consumed.add('buffId');
                    consumed.add('buffIdKey');
                }
                return consumed;
            };

            const orderedKeys = value => Object.keys(value)
                .filter(key => !summaryMetaKeys.has(key))
                .sort((left, right) => {
                    const leftRank = summaryPriorityIndex.get(left.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
                    const rightRank = summaryPriorityIndex.get(right.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
                    return leftRank - rightRank;
                });

            const visit = (value, key, fieldPath, depth) => {
                if (fields.length >= summaryFieldLimit) {
                    truncated = true;
                    return;
                }
                if (value === undefined || value === null || value === '') return;
                if (isBlackboardReference(value)) {
                    append(key, resolveField(value, fieldPath), fieldPath);
                    return;
                }
                if (Array.isArray(value)) {
                    if (!value.length) return;
                    if (value.every(child => !isObject(child) && !Array.isArray(child))) {
                        append(key, value, fieldPath);
                        return;
                    }
                    value.slice(0, 8).forEach((child, index) => (
                        visit(child, key, `${fieldPath}[${index}]`, depth + 1)
                    ));
                    if (value.length > 8) append(`${key}RemainingCount`, value.length - 8, fieldPath);
                    return;
                }
                if (!isObject(value)) {
                    append(key, value, fieldPath);
                    return;
                }
                if (isActionNode(value)) return;
                if (hasOwn(value, 'inputValueKey') && value.inputValueKey && value.useDirectValue !== true) {
                    const assignmentKey = value.targetKey || value.inputValueKey || key;
                    append(assignmentKey, resolveField({
                        useBlackboardKey: true,
                        value: value.numericValue ?? value.stringValue ?? null,
                        blackboardKey: value.inputValueKey
                    }, fieldPath), fieldPath);
                    return;
                }
                if (value.useDirectValue === true && (hasOwn(value, 'numericValue') || hasOwn(value, 'stringValue'))) {
                    append(value.targetKey || key, value.directValueType === 'String' ? value.stringValue : value.numericValue, fieldPath);
                    return;
                }
                if (depth >= 5) {
                    truncated = true;
                    return;
                }
                if (value.$type) {
                    append(`${key}Type`, formatActionType(value.$type), `${fieldPath}.$type`);
                }
                const consumedKeys = appendBlackboardPairs(value, fieldPath);
                orderedKeys(value).forEach(childKey => {
                    if (childKey === '$type' || consumedKeys.has(childKey)) return;
                    const child = value[childKey];
                    const nestedCount = isNestedActionKey(childKey) ? countActionNodes(child) : 0;
                    if (nestedCount) {
                        append(`${childKey}Count`, nestedCount, `${fieldPath}.${childKey}`);
                        return;
                    }
                    visit(child, childKey, `${fieldPath}.${childKey}`, depth + 1);
                });
            };

            const consumedKeys = appendBlackboardPairs(action, path);
            orderedKeys(action).forEach(key => {
                if (consumedKeys.has(key)) return;
                const value = action[key];
                const nestedCount = isNestedActionKey(key) ? countActionNodes(value) : 0;
                if (nestedCount) {
                    append(`${key}Count`, nestedCount, `${path}.${key}`);
                    return;
                }
                visit(value, key, `${path}.${key}`, 0);
            });
            return { fields, truncated };
        };

        const conditionValue = value => {
            const resolved = resolveValue(value, blackboardData);
            return Object.assign({}, resolved, {
                value: resolved.resolved === false ? null : resolved.value
            });
        };

        const describeConditionAction = (action, path) => {
            const type = formatActionType(action?.$type);
            const operator = firstDefined(
                action?.compare,
                action?.compareType,
                action?.operation,
                action?.operationType,
                action?.conditionType
            );
            const descriptor = {
                type: /compare|check/i.test(type) ? 'comparison' : 'condition-action',
                actionType: type,
                operator,
                path
            };
            if (hasOwn(action, 'valueA')) descriptor.left = conditionValue(action.valueA);
            if (hasOwn(action, 'valueB')) descriptor.right = conditionValue(action.valueB);
            if (!descriptor.left && hasOwn(action, 'value')) descriptor.value = conditionValue(action.value);
            if (hasOwn(action, 'distance')) descriptor.distance = conditionValue(action.distance);
            if (hasOwn(action, 'angle')) descriptor.angle = conditionValue(action.angle);
            if (action.key || action.blackboardKey || action.bbKey) {
                descriptor.key = String(action.key || action.blackboardKey || action.bbKey);
            }
            return descriptor;
        };

        const describeConditionContainer = (container, path) => {
            const descriptions = [];
            const seen = new WeakSet();
            const visit = (value, currentPath, depth) => {
                if (!value || depth > 16 || descriptions.length >= 32) return;
                if (Array.isArray(value)) {
                    value.forEach((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1));
                    return;
                }
                if (!isObject(value) || seen.has(value)) return;
                seen.add(value);
                if (isActionNode(value)) descriptions.push(describeConditionAction(value, currentPath));
                Object.keys(value).forEach(key => visit(value[key], `${currentPath}.${key}`, depth + 1));
            };
            visit(container, path, 0);
            if (!descriptions.length) return { type: 'condition', path };
            return descriptions.length === 1 ? descriptions[0] : { type: 'all', items: descriptions, path };
        };

        const handleAction = (action, event) => {
            const type = event.type;
            const normalized = type.toLowerCase();
            const path = event.path;

            if (normalized.includes('modifydynamicblackboard')) {
                const key = String(action.key || action.blackboardKey || action.bbKey || '');
                let rawOperand = action.value;
                if (action.directValue === false && action.inputValueKey) {
                    rawOperand = keyedValue(
                        action.value?.value ?? action.numericValue ?? null,
                        action.inputValueKey,
                        true
                    );
                }
                const operand = resolveSpatialField(
                    rawOperand,
                    `${path}.value`,
                    event.index - 1,
                    false,
                    event.conditions,
                    event.flowId
                );
                const operation = normalizedBlackboardOperation(action.operation ?? action.operationType);
                event.details = { key, operation, operand };
                if (key) {
                    spatialMutations.push({
                        key,
                        operation,
                        operand,
                        eventIndex: event.index,
                        flowId: event.flowId,
                        path,
                        conditions: event.conditions.slice()
                    });
                }
                if (!['Assign', 'Add', 'Subtract', 'Multiply', 'Divide'].includes(operation)) {
                    addSpatialWarning(
                        'SPATIAL_UNSUPPORTED_BLACKBOARD_OPERATION',
                        `Unsupported spatial blackboard operation "${operation}".`,
                        { key, path }
                    );
                }
                return;
            }

            if (normalized === 'findtargetaction' || normalized === 'continuousfindtargetaction') {
                const finder = action.selectorData?.finderData;
                const finderType = String(finder?.$type || '');
                const shapes = /hitboxfinder/i.test(finderType) && Array.isArray(finder?.shapeList)
                    ? finder.shapeList
                    : [];
                shapes.forEach((shapeData, shapeIndex) => {
                    const shapePath = `${path}.selectorData.finderData.shapeList[${shapeIndex}]`;
                    const parsed = parseHitBoxGeometry(
                        shapeData,
                        shapePath,
                        event.index,
                        event.conditions,
                        event.flowId
                    );
                    if (!parsed) return;
                    const fact = addSpatialFact(spatial.targetSearches, Object.assign(
                        eventSpatialMetadata(event),
                        parsed,
                        {
                            semantic: normalized === 'continuousfindtargetaction'
                                ? 'continuous-target-search'
                                : 'target-search',
                            confidence: 'medium',
                            targetGroupKey: action.targetGroupKey ?? '',
                            targetFaction: finder.factionTarget ?? '',
                            targetObjectType: finder.targetObjectType ?? '',
                            continuous: normalized === 'continuousfindtargetaction',
                            anchor: Object.assign({}, parsed.anchor, {
                                center: action.center ?? '',
                                centerContextKey: action.centerContextKey ?? '',
                                centerMountPoint: action.centerMountPoint ?? '',
                                centerToGround: !!action.centerToGround,
                                selectorOwner: action.selectorOwner ?? ''
                            })
                        }
                    ));
                    addSpatialRelation({
                        type: 'produces-target-group',
                        from: fact.id,
                        to: `target-group:${data.skillId || ''}:${fact.targetGroupKey || '(default)'}`
                    });
                });
                event.details = {
                    targetGroupKey: action.targetGroupKey ?? '',
                    finderType: /hitboxfinder/i.test(finderType) ? 'HitBoxFinder' : formatActionType(finderType),
                    spatialFactIds: spatial.targetSearches
                        .filter(fact => fact.eventIndex === event.index)
                        .map(fact => fact.id)
                };
                return;
            }

            if (normalized === 'auraaction') {
                const globalAura = String(action.auraType || '').toLowerCase() === 'globalaura';
                const parsed = globalAura
                    ? { geometry: { space: 'global', shape: 'Global', dimensions: {} }, anchor: {} }
                    : parseAuraGeometry(
                        action.shapeData,
                        `${path}.shapeData`,
                        event.index,
                        event.conditions,
                        event.flowId
                    );
                if (parsed) {
                    const fact = addSpatialFact(spatial.persistentFields, Object.assign(
                        eventSpatialMetadata(event),
                        parsed,
                        {
                            semantic: 'persistent-field',
                            confidence: globalAura || action.auraType === 'RangedAura' ? 'high' : 'medium',
                            auraType: action.auraType ?? '',
                            targetFaction: action.targetFilter?.factionTarget ?? '',
                            targetObjectType: action.targetObjectType ?? action.targetFilter?.targetObjectType ?? '',
                            anchor: Object.assign({}, parsed.anchor, {
                                center: action.auraRoot?.targetSource ?? '',
                                centerContextKey: action.auraRoot?.targetGroupKey ?? '',
                                centerToGround: !!action.auraRoot?.centerToGround,
                                fixedWhenStart: !!action.fixedWhenStart
                            })
                        }
                    ));
                    event.details = { auraType: action.auraType ?? '', spatialFactId: fact.id };
                } else {
                    event.details = { auraType: action.auraType ?? '', spatialFactId: null };
                }
                return;
            }

            if (normalized === 'createadditionalbattleshape') {
                const parsed = parseAuraGeometry(
                    action.shapeData,
                    `${path}.shapeData`,
                    event.index,
                    event.conditions,
                    event.flowId
                );
                if (parsed) {
                    const fact = addSpatialFact(spatial.collisionVolumes, Object.assign(
                        eventSpatialMetadata(event),
                        parsed,
                        {
                            semantic: 'collision-volume',
                            confidence: 'high',
                            duration: spatialDimension(
                                action.duration,
                                `${path}.duration`,
                                'second',
                                event.index,
                                event.conditions,
                                event.flowId
                            ),
                            followsPosition: !!action.followTargetPosition,
                            followsRotation: !!action.followTargetRotation,
                            anchor: Object.assign({}, parsed.anchor, {
                                center: action.targetSettings?.targetSource ?? '',
                                centerContextKey: action.targetSettings?.targetGroupKey ?? ''
                            })
                        }
                    ));
                    event.details = { spatialFactId: fact.id };
                }
                return;
            }

            if (normalized === 'damageaction' || normalized === 'channelingdamageaction') {
                const units = Array.isArray(action.damageUnits) ? action.damageUnits : [];
                event.details = { unitCount: units.length, targetGroupKey: action.targetSettings?.targetGroupKey ?? '' };
                addWindow('damage', event, event.details);
                if (!units.length) {
                    addWarning('EMPTY_DAMAGE_ACTION', 'DamageAction has no damageUnits.', { path });
                }
                units.forEach((unit, unitIndex) => {
                    const attribute = String(unit?.damageAttributeType ?? 'Unknown');
                    const hitKind = attribute.toLowerCase() === 'hp'
                        ? 'hp'
                        : (attribute.toLowerCase() === 'poise' ? 'poise' : 'other');
                    const atkCalculation = isObject(unit?.atkCalculation) ? unit.atkCalculation : null;
                    const effectiveAtkScale = !unit?.simpleCalculation && atkCalculation?.atkScale !== undefined
                        ? atkCalculation.atkScale
                        : unit?.atkScale;
                    const poiseValue = unit?.poiseCalculation?.value ?? unit?.poiseCalculation ?? null;
                    hits.push(Object.assign({
                        kind: hitKind,
                        unitIndex,
                        damageType: unit?.damageType ?? '',
                        damageAttributeType: attribute,
                        atkScale: resolveField(effectiveAtkScale, `${path}.damageUnits[${unitIndex}].${!unit?.simpleCalculation && atkCalculation?.atkScale !== undefined ? 'atkCalculation.atkScale' : 'atkScale'}`),
                        atkCalculationType: atkCalculation ? formatActionType(atkCalculation.$type) : '',
                        poiseValue: resolveField(poiseValue, `${path}.damageUnits[${unitIndex}].poiseCalculation.value`),
                        simpleCalculation: !!unit?.simpleCalculation,
                        ignoreDamageImmuneLevel: unit?.ignoreDamageImmuneLevel ?? null,
                        ignorePoiseImmune: !!unit?.ignorePoiseImmune,
                        reduceDamageForGuard: !!unit?.reduceDamageForGuard,
                        reduceDamageForGuardRatio: unit?.reduceDamageForGuardRatio ?? null,
                        gainCost: !!unit?.gainCost,
                        costDataList: normalizeCostList(unit?.costDataList, `${path}.damageUnits[${unitIndex}].costDataList`),
                        targetGroupKey: action.targetSettings?.targetGroupKey ?? '',
                        raw: unit
                    }, eventReference(event)));
                });
                return;
            }

            if (normalized.includes('setsuperarmor')) {
                const details = {
                    superArmorValue: resolveField(action.superArmorValue, `${path}.superArmorValue`),
                    impactResistance: resolveField(action.impactResistance, `${path}.impactResistance`),
                    targetGroupKey: action.targetSettings?.targetGroupKey ?? ''
                };
                event.details = details;
                addWindow('superArmor', event, details);
                return;
            }

            if (normalized.includes('allownextskill')) {
                const allowedSkillIds = Array.isArray(action.allowedSkillIdList) ? action.allowedSkillIdList.filter(Boolean) : [];
                event.details = { allowedSkillIds };
                addWindow('allowNextSkill', event, { allowedSkillIds });
                allowedSkillIds.forEach(skillId => addLink('skill', skillId, 'allowNextSkill', event));
                return;
            }

            if (normalized.includes('combocache')) {
                const mappings = (Array.isArray(action.mappingDataList) ? action.mappingDataList : []).map((mapping, index) => {
                    const skillId = mapping?.skillId ?? '';
                    addLink('skill', skillId, 'comboCache', event, { command: mapping?.cmdType ?? '', mappingIndex: index });
                    return {
                        command: mapping?.cmdType ?? '',
                        skillId,
                        cacheEndByAction: !!mapping?.cacheEndByAction,
                        overrideCacheTime: !!mapping?.overrideCacheTime,
                        cacheTime: resolveField(mapping?.cacheTime, `${path}.mappingDataList[${index}].cacheTime`)
                    };
                });
                event.details = { mappings };
                addWindow('comboCache', event, { mappings });
                return;
            }

            if (normalized.includes('markcaninterrupt')) {
                addWindow('canInterrupt', event);
                return;
            }
            if (normalized.includes('markcandash')) {
                addWindow('canDash', event);
                return;
            }
            if (normalized.includes('blockmoveinterrupt')) {
                addWindow('blockMoveInterrupt', event);
                return;
            }

            if (normalized.includes('hitstop')) {
                const details = {
                    affectType: action.affectType ?? '',
                    duration: resolveField(action.duration, `${path}.duration`),
                    curveKey: action.curveKey ?? '',
                    useDirectCurve: !!action.useDirectCurve
                };
                event.details = details;
                addWindow('hitStop', event, details);
                return;
            }

            if (normalized.includes('timedilation')) {
                const details = {
                    layer: action.layer ?? '',
                    duration: resolveField(action.duration, `${path}.duration`),
                    curveKey: action.curveKey ?? '',
                    useCurveKey: !!action.useCurveKey,
                    finishByAction: !!action.finishByAction
                };
                event.details = details;
                addWindow('timeDilation', event, details);
                return;
            }

            if ((normalized === 'createbuffaction' || normalized === 'addbuffaction') && Array.isArray(action.buffs)) {
                const buffs = (Array.isArray(action.buffs) ? action.buffs : []).map((buff, index) => (
                    normalizeBuff(buff, index, event, `${path}.buffs[${index}]`)
                ));
                event.details = {
                    count: resolveField(action.count, `${path}.count`),
                    buffs
                };
                buffs.forEach(buff => {
                    const buffId = String(buff.buffId || '').toLowerCase();
                    if (buffId.includes('superarmor')) {
                        addWindow('buffSuperArmor', event, { buffId: buff.buffId, values: buff.values });
                    }
                    if (buffId.includes('damage_immune') || buffId.includes('damageimmune')) {
                        addWindow('damageImmune', event, { buffId: buff.buffId, values: buff.values });
                    }
                });
                return;
            }

            if (normalized.includes('launchprojectile')) {
                const projectileId = addResolvedLink('projectile', action.projectileId, 'launch', event, `${path}.projectileId`);
                const skillFields = [
                    ['projectileSkillId', 'projectileHit', 'castSkillOnHit'],
                    ['skillIdOnBlock', 'projectileBlock', 'castSkillOnBlock'],
                    ['skillIdOnReach', 'projectileReach', 'castSkillOnReach'],
                    ['skillIdOnFinish', 'projectileFinish', 'castSkillOnFinish']
                ];
                const linkedSkills = {};
                skillFields.forEach(([key, relation, gateKey]) => {
                    if (!hasOwn(action, key)) return;
                    const resolvedId = resolveField(action[key], `${path}.${key}`);
                    linkedSkills[key] = resolvedId;
                    if (!hasOwn(action, gateKey) || action[gateKey] !== false) {
                        addLink('skill', resolvedId.value, relation, event, { resolvedId, gate: gateKey });
                    }
                });
                event.details = { projectileId, linkedSkills };
                return;
            }

            if (normalized.includes('castskill')) {
                const skillId = addResolvedLink('skill', action.skillId ?? action.castSkillId, 'castSkill', event, `${path}.skillId`);
                event.details = {
                    skillId,
                    skipApplyCost: !!action.skipApplyCost,
                    inheritSourceSkillCastId: !!action.inheritSourceSkillCastId
                };
                return;
            }

            if (normalized === 'spawnabilityentity') {
                const abilityEntityId = addResolvedLink(
                    'abilityEntity',
                    action.abilityEntityId ?? action.entityId,
                    normalized.includes('spawn') ? 'spawn' : 'abilityEntity',
                    event,
                    `${path}.abilityEntityId`
                );
                const abilityEntitySkillId = addResolvedLink(
                    'skill',
                    action.abilityEntitySkillId,
                    'abilityEntitySkill',
                    event,
                    `${path}.abilityEntitySkillId`
                );
                event.details = {
                    abilityEntityId,
                    abilityEntitySkillId,
                    duration: hasOwn(action, 'duration') ? resolveField(action.duration, `${path}.duration`) : null,
                    overrideDuration: !!action.overrideDuration,
                    assignBlackboard: !!action.assignBlackboard,
                    assignEntityBlackboard: !!action.assignEntityBlackboard,
                    assignItems: Array.isArray(action.assignItems)
                        ? action.assignItems
                        : (Array.isArray(action.assignPairs) ? action.assignPairs : [])
                };
                if (abilityEntitySkillId?.value) {
                    spawnReferences.push({
                        event,
                        childSkillId: String(abilityEntitySkillId.value),
                        assignBlackboard: !!action.assignBlackboard,
                        assignItems: event.details.assignItems,
                        raw: action
                    });
                }
                return;
            }

            if (normalized === 'interruptaction' || normalized === 'crushaction'
                || normalized === 'fractureaction' || normalized === 'spellinfliction'
                || normalized === 'spellinflictiononchar' || normalized === 'inversespellinfliction') {
                event.details = resolvedFields(action, [
                    'overrideSuperArmorLimit', 'immobilizedTime', 'blowOffDistance', 'distanceRandomRange',
                    'blowOffHeight', 'totalTime', 'damageMultiplier', 'duration', 'value'
                ], path);
                event.details.controlType = normalized === 'interruptaction'
                    ? 'interrupt'
                    : (normalized.includes('crush') ? 'crush' : (normalized.includes('fracture') ? 'fracture' : 'spellInfliction'));
                return;
            }

            if (isMovementType(type)) {
                event.details = resolvedFields(action, [
                    'distance', 'moveDistance', 'speed', 'duration', 'totalTime', 'height',
                    'destFrame', 'blowOffDistance', 'blowOffHeight'
                ], path);
                addWindow('movement', event, { movementType: type, values: event.details });
            }
        };

        const branchName = key => String(key || 'actions')
            .replace(/ActionData$/i, '')
            .replace(/Actions?$/i, '')
            || 'actions';

        const branchRelation = key => {
            const normalized = String(key || '').toLowerCase();
            if (normalized.includes('condition')) return 'condition';
            if (normalized.includes('succeed') || normalized.includes('success') || normalized.includes('then')) return 'success';
            if (normalized.includes('fail') || normalized.includes('else')) return 'failure';
            if (normalized.includes('tick')) return 'tick';
            if (normalized === 'actioninaura') return 'aura-enter';
            if (normalized === 'actionwhenexitaura') return 'aura-exit';
            if (normalized.includes('end')) return 'on-end';
            if (normalized === 'options') return 'switch-case';
            if (normalized === 'abilityactionmap' || normalized === 'actiononevent') return 'ability-event';
            return branchName(key);
        };

        const walkedObjects = new WeakSet();
        let walkedNodeCount = 0;

        const walkContainer = (container, inherited, path, depth) => {
            if (depth > 64) {
                addWarning('ACTION_DEPTH_LIMIT', 'Nested action traversal stopped at depth 64.', { path });
                return;
            }
            if (Array.isArray(container)) {
                container.forEach((item, index) => walkContainer(item, inherited, `${path}[${index}]`, depth + 1));
                return;
            }
            if (!isObject(container)) return;
            if (walkedObjects.has(container)) return;
            walkedObjects.add(container);
            walkedNodeCount += 1;
            if (walkedNodeCount > 200000) {
                addWarning('ACTION_NODE_LIMIT', 'Action traversal stopped after 200000 structured nodes.', { path });
                return;
            }

            const containerEnabled = inherited.enabled !== false && container.isEnable !== false;
            let parentEventIndex = inherited.parentEventIndex ?? null;
            if (isActionNode(container)) {
                const type = formatActionType(container.$type);
                const summary = buildActionSummary(container, path);
                const event = Object.assign({
                    index: events.length,
                    type,
                    rawType: container.$type,
                    category: classifyAction(type),
                    presentation: isPresentationType(type),
                    enabled: containerEnabled,
                    serverActionIndex: container.serverActionIndex ?? null,
                    priorityLevel: container.priorityLevel ?? null,
                    priorityOffset: container.priorityOffset ?? null,
                    parentEventIndex,
                    relation: inherited.relation || '',
                    summaryFields: summary.fields,
                    summaryTruncated: summary.truncated,
                    branchPath: inherited.branchPath.slice(),
                    conditions: (Array.isArray(inherited.conditions) ? inherited.conditions : []).slice(),
                    path,
                    raw: container
                }, frameInfo(inherited.startFrame, inherited.endFrame), {
                    source: inherited.source,
                    flowId: inherited.flowId,
                    abilityEvent: inherited.abilityEvent,
                    groupIndex: inherited.groupIndex,
                    sequenceIndex: inherited.sequenceIndex
                });
                events.push(event);
                if (event.enabled) handleAction(container, event);
                parentEventIndex = event.index;
            }

            Object.keys(container).forEach(key => {
                const child = container[key];
                if (!child || typeof child !== 'object') return;
                const isBranch = isNestedActionKey(key);
                const relation = isBranch ? branchRelation(key) : inherited.relation;
                let conditions = (Array.isArray(inherited.conditions) ? inherited.conditions : []).slice();
                const parentType = isActionNode(container) ? formatActionType(container.$type).toLowerCase() : '';
                if (parentType.includes('ifelse') && (relation === 'success' || relation === 'failure')) {
                    const conditionContainer = container.conditionAction || container.condition || container.conditions;
                    conditions.push({
                        type: 'branch',
                        outcome: relation,
                        controllerScope: scopeId,
                        controllerEventIndex: parentEventIndex,
                        expression: describeConditionContainer(conditionContainer, `${path}.conditionAction`)
                    });
                }
                walkContainer(child, Object.assign({}, inherited, {
                    parentEventIndex,
                    relation,
                    branchPath: isBranch ? inherited.branchPath.concat(branchName(key)) : inherited.branchPath,
                    conditions,
                    enabled: containerEnabled
                }), `${path}.${key}`, depth + 1);
            });
        };

        const actionGroupData = isObject(data.actionGroupData) ? data.actionGroupData : {};
        const timelineActions = Array.isArray(actionGroupData.timelineActions)
            ? actionGroupData.timelineActions
            : (Array.isArray(data.timelineActions) ? data.timelineActions : []);
        timelineActions.forEach((groupItem, groupIndex) => {
            const range = frameInfo(groupItem?._startFrame, groupItem?._endFrame);
            if (range.startFrame !== null && range.endFrame !== null && range.endFrame < range.startFrame) {
                addWarning('REVERSED_ACTION_GROUP', 'ActionGroup end frame is earlier than its start frame.', {
                    path: `actionGroupData.timelineActions[${groupIndex}]`,
                    startFrame: range.startFrame,
                    endFrame: range.endFrame
                });
            }
            walkContainer(groupItem, {
                source: 'timeline',
                flowId: `${scopeId}|timeline`,
                abilityEvent: null,
                groupIndex,
                sequenceIndex: 0,
                startFrame: groupItem?._startFrame,
                endFrame: groupItem?._endFrame,
                parentEventIndex: null,
                relation: '',
                branchPath: [],
                conditions: [],
                enabled: true
            }, `actionGroupData.timelineActions[${groupIndex}]`, 0);
        });

        const passiveEventActions = Array.isArray(actionGroupData.passiveEventActions)
            ? actionGroupData.passiveEventActions
            : (Array.isArray(data.passiveEventActions) ? data.passiveEventActions : []);
        passiveEventActions.forEach((passiveEvent, eventIndex) => {
            walkContainer(passiveEvent, {
                source: 'passive',
                flowId: `${scopeId}|passive|${String(passiveEvent?.abilityEvent || '(none)')}|${eventIndex}`,
                abilityEvent: passiveEvent?.abilityEvent ?? '',
                groupIndex: eventIndex,
                sequenceIndex: 0,
                startFrame: null,
                endFrame: null,
                parentEventIndex: null,
                relation: '',
                branchPath: [],
                conditions: [],
                enabled: true
            }, `actionGroupData.passiveEventActions[${eventIndex}]`, 0);
        });

        Object.keys(actionGroupData).forEach(key => {
            if (key === 'timelineActions' || key === 'passiveEventActions') return;
            walkContainer(actionGroupData[key], {
                source: 'config', flowId: `${scopeId}|config|actionGroupData.${key}`,
                abilityEvent: null, groupIndex: null, sequenceIndex: null,
                startFrame: null, endFrame: null, parentEventIndex: null, relation: branchRelation(key),
                branchPath: [branchName(key)], conditions: [], enabled: true
            }, `actionGroupData.${key}`, 0);
        });

        Object.keys(data).forEach(key => {
            if (key === 'actionGroupData' || key === 'timelineActions' || key === 'passiveEventActions') return;
            const source = /highlight/i.test(key) ? 'highlight' : (/switch.*condition/i.test(key) ? 'switch-condition' : 'config');
            walkContainer(data[key], {
                source, flowId: `${scopeId}|${source}|${key}`,
                abilityEvent: null, groupIndex: null, sequenceIndex: null,
                startFrame: null, endFrame: null, parentEventIndex: null, relation: branchRelation(key),
                branchPath: [branchName(key)], conditions: [], enabled: true
            }, key, 0);
        });

        const meaningfulDimension = dimension => {
            if (!dimension) return false;
            if (dimension.resolved === false) return true;
            if (Array.isArray(dimension.variants) && dimension.variants.length) return true;
            const numeric = finiteNumber(dimension.value);
            return numeric === null ? dimension.value !== null && dimension.value !== '' : numeric !== 0;
        };

        if (hasOwn(castData, 'castDistance')) {
            const distance = spatialDimension(castData.castDistance, 'castData.castDistance', 'meter', -1);
            if (meaningfulDimension(distance)) {
                addSpatialFact(spatial.castLimits, {
                    semantic: 'cast-limit',
                    confidence: castData.useCustomCastDistance ? 'high' : 'medium',
                    actionType: 'SkillCastData',
                    path: 'castData.castDistance',
                    conditions: [],
                    timing: null,
                    checkType: castData.checkCastDistanceType ?? '',
                    custom: !!castData.useCustomCastDistance,
                    geometry: {
                        space: 'scalar',
                        shape: 'Distance',
                        dimensions: { distance }
                    }
                });
            }
        }

        (Array.isArray(data.uiRangeHints) ? data.uiRangeHints : []).forEach((hint, hintIndex) => {
            const path = `uiRangeHints[${hintIndex}].shapeData`;
            const parsed = parseUiGeometry(hint?.shapeData, path);
            if (!parsed) return;
            addSpatialFact(spatial.selectionHints, Object.assign({}, parsed, {
                semantic: 'selection-hint',
                confidence: 'medium',
                actionType: 'UIRangeHint',
                path,
                targetFaction: hint?.targetFaction ?? '',
                selectAll: !!hint?.selectAll,
                timing: null,
                conditions: []
            }));
        });

        const targetGroupsForConsumer = event => {
            if (!['damage', 'recovery', 'defense', 'control', 'buff'].includes(event.category)) return [];
            const candidates = [
                event.raw?.targetSettings,
                event.raw?.targets,
                event.raw?.target,
                event.raw?.calculationTarget,
                event.raw?.effectTarget
            ];
            return [...new Set(candidates
                .map(candidate => candidate?.targetGroupKey)
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(String))];
        };

        spatial.targetSearches.forEach(search => {
            if (!search.targetGroupKey) return;
            const consumers = events.filter(event => (
                event.enabled !== false
                && event.index >= search.eventIndex
                && event.source === search.eventSource
                && event.groupIndex === search.groupIndex
                && conditionsCompatible(search.conditions, event.conditions)
                && targetGroupsForConsumer(event).includes(String(search.targetGroupKey))
            ));
            if (!consumers.length) return;
            const consumerGroups = new Map();
            consumers.forEach(consumer => {
                const conditions = mergeConditionItems(search.conditions, consumer.conditions);
                const signature = conditionSignature(conditions);
                if (!consumerGroups.has(signature)) consumerGroups.set(signature, { conditions, consumers: [] });
                consumerGroups.get(signature).consumers.push(consumer);
            });
            consumerGroups.forEach(grouped => {
                const impactData = Object.assign({}, search, {
                    semantic: 'impact-volume',
                    confidence: grouped.consumers.some(event => event.category === 'damage') ? 'high' : 'medium',
                    sourceFactId: search.id,
                    consumerEventIndexes: grouped.consumers.map(event => event.index),
                    conditions: grouped.conditions
                });
                delete impactData.id;
                const impact = addSpatialFact(spatial.impactVolumes, impactData);
                grouped.consumers.forEach(consumer => {
                    addSpatialRelation({
                        type: 'targets',
                        from: impact.id,
                        to: `event:${scopeId}:${consumer.index}`,
                        details: { actionType: consumer.type, category: consumer.category }
                    });
                });
            });
        });

        spatial.externalVariants = externalVariants
            .map(variant => Object.assign({}, variant, {
                modifiers: variant.modifiers.filter(modifier => consumedSpatialKeys.has(modifier.key))
            }))
            .filter(variant => variant.modifiers.length);

        const traversal = isObject(metaContext._spatialTraversal)
            ? metaContext._spatialTraversal
            : {
                stack: [String(data.skillId || scopeId)],
                depth: 0,
                budget: { count: 0, limit: 32 }
            };
        const loadSkillData = typeof metaContext.loadSkillData === 'function'
            ? metaContext.loadSkillData
            : null;

        const inheritedSnapshot = (eventIndex, assignItems, conditions, flowId) => {
            const snapshot = Object.create(null);
            Object.keys(blackboardData.byKey).forEach(key => {
                const entry = blackboardData.byKey[key];
                snapshot[key] = resolveSpatialField({
                    useBlackboardKey: true,
                    value: entry?.defaultValue ?? entry?.value ?? null,
                    blackboardKey: key
                }, `blackboard.${key}`, eventIndex, false, conditions, flowId);
            });
            (Array.isArray(assignItems) ? assignItems : []).forEach((item, index) => {
                const targetKey = String(item?.targetKey || '');
                if (!targetKey) return;
                if (item.useDirectValue) {
                    snapshot[targetKey] = {
                        value: item.directValueType === 'String' ? item.stringValue : item.numericValue,
                        resolved: true,
                        source: 'spawn-assignment',
                        usesBlackboard: false,
                        blackboardKey: null,
                        fallbackValue: null,
                        variants: []
                    };
                    return;
                }
                if (item.inputValueKey) {
                    snapshot[targetKey] = resolveSpatialField({
                        useBlackboardKey: true,
                        value: item.numericValue ?? item.stringValue ?? null,
                        blackboardKey: item.inputValueKey
                    }, `spawn.assignItems[${index}]`, eventIndex, false, conditions, flowId);
                }
            });
            return snapshot;
        };

        const mergeChildSpatial = childSpatial => {
            if (!isObject(childSpatial)) return;
            ['castLimits', 'selectionHints', 'targetSearches', 'impactVolumes', 'persistentFields', 'collisionVolumes']
                .forEach(key => spatial[key].push(...(Array.isArray(childSpatial[key]) ? childSpatial[key] : [])));
            (Array.isArray(childSpatial.relations) ? childSpatial.relations : []).forEach(addSpatialRelation);
            (Array.isArray(childSpatial.warnings) ? childSpatial.warnings : []).forEach(warning => {
                const warningKey = `${warning.code}|${warning.path || ''}|${warning.key || ''}|${warning.message || ''}`;
                if (spatialWarningKeys.has(warningKey)) return;
                spatialWarningKeys.add(warningKey);
                spatial.warnings.push(warning);
            });
            spatial.externalVariants.push(...(Array.isArray(childSpatial.externalVariants) ? childSpatial.externalVariants : []));
            spatial.pendingReferences.push(...(Array.isArray(childSpatial.pendingReferences) ? childSpatial.pendingReferences : []));
        };

        for (const reference of spawnReferences) {
            const childSkillId = reference.childSkillId;
            const eventNodeId = `event:${scopeId}:${reference.event.index}`;
            const skillNodeId = `skill:${childSkillId}`;
            const pending = {
                type: 'skill',
                skillId: childSkillId,
                relation: 'abilityEntitySkill',
                eventIndex: reference.event.index,
                path: reference.event.path,
                status: 'pending'
            };
            addSpatialRelation({
                type: 'spawns',
                from: eventNodeId,
                to: skillNodeId,
                status: 'pending',
                details: { abilityEntityId: reference.raw.abilityEntityId ?? '' }
            });
            if (reference.assignBlackboard) {
                addSpatialRelation({
                    type: 'inherits-blackboard',
                    from: `skill:${data.skillId || ''}`,
                    to: skillNodeId,
                    status: 'enabled',
                    details: {
                        assignBlackboard: true,
                        assignedKeys: reference.assignItems.map(item => item?.targetKey).filter(Boolean)
                    }
                });
            }

            if (!loadSkillData) {
                spatial.pendingReferences.push(pending);
                continue;
            }
            if ((Array.isArray(traversal.stack) ? traversal.stack : []).includes(childSkillId)) {
                pending.status = 'cycle';
                spatial.pendingReferences.push(pending);
                addSpatialWarning('SPATIAL_SKILL_CYCLE', `Spatial child-skill traversal stopped at cycle "${childSkillId}".`, {
                    path: reference.event.path,
                    skillId: childSkillId
                });
                continue;
            }
            if ((Number(traversal.depth) || 0) >= 8) {
                pending.status = 'depth-limit';
                spatial.pendingReferences.push(pending);
                addSpatialWarning('SPATIAL_SKILL_DEPTH_LIMIT', 'Spatial child-skill traversal stopped at depth 8.', {
                    path: reference.event.path,
                    skillId: childSkillId
                });
                continue;
            }
            const budget = isObject(traversal.budget) ? traversal.budget : { count: 0, limit: 32 };
            if (budget.count >= (finiteNumber(budget.limit) ?? 32)) {
                pending.status = 'budget-limit';
                spatial.pendingReferences.push(pending);
                addSpatialWarning('SPATIAL_SKILL_BUDGET_LIMIT', 'Spatial child-skill traversal stopped after 32 references.', {
                    path: reference.event.path,
                    skillId: childSkillId
                });
                continue;
            }

            try {
                budget.count += 1;
                const childData = await loadSkillData(childSkillId);
                if (!isObject(childData)) throw new Error('Child SkillData is empty.');
                const childScope = `${scopeId}>${reference.event.index}:${childSkillId}`;
                const spawnConditions = mergeConditionItems(
                    inheritedSpatialConditions,
                    reference.event.conditions
                );
                const inherited = inheritedSnapshot(
                    reference.event.index,
                    reference.assignItems,
                    spawnConditions,
                    reference.event.flowId
                );
                if (!reference.assignBlackboard) {
                    Object.keys(inherited).forEach(key => {
                        if (!reference.assignItems.some(item => String(item?.targetKey || '') === key)) delete inherited[key];
                    });
                }
                const childPatch = metaContext.tables?.patches?.[childSkillId] ?? null;
                const childResult = await analyzeSkill(childData, childPatch, Object.assign({}, metaContext, {
                    _spatialInheritedBlackboard: inherited,
                    _spatialInheritedConditions: spawnConditions,
                    _spatialScope: childScope,
                    _spatialOrigin: {
                        parentSkillId: data.skillId ?? '',
                        spawnEventIndex: reference.event.index,
                        spawnPath: reference.event.path
                    },
                    _spatialTraversal: {
                        stack: (Array.isArray(traversal.stack) ? traversal.stack : []).concat(childSkillId),
                        depth: (Number(traversal.depth) || 0) + 1,
                        budget
                    }
                }));
                pending.status = 'resolved';
                mergeChildSpatial(childResult?.spatial);
                spatial.relations.forEach(relation => {
                    if (relation.type === 'spawns' && relation.from === eventNodeId && relation.to === skillNodeId) {
                        relation.status = 'resolved';
                    }
                });
            } catch (error) {
                pending.status = 'load-failed';
                pending.message = error?.message || String(error);
                spatial.pendingReferences.push(pending);
                addSpatialWarning('SPATIAL_CHILD_SKILL_LOAD_FAILED', `Unable to load spatial child skill "${childSkillId}".`, {
                    path: reference.event.path,
                    skillId: childSkillId,
                    detail: pending.message
                });
            }
        }

        const dimensionOwners = new Map();
        ['castLimits', 'selectionHints', 'targetSearches', 'impactVolumes', 'persistentFields', 'collisionVolumes']
            .forEach(collection => {
                spatial[collection].forEach(fact => {
                    Object.entries(fact.geometry?.dimensions || {}).forEach(([dimension, value]) => {
                        if (!value?.usesBlackboard || !value.blackboardKey) return;
                        const key = `${fact.skillId}|${value.blackboardKey}`;
                        if (!dimensionOwners.has(key)) dimensionOwners.set(key, []);
                        dimensionOwners.get(key).push({ factId: fact.id, dimension });
                    });
                });
            });
        dimensionOwners.forEach((owners, key) => {
            for (let left = 0; left < owners.length; left += 1) {
                for (let right = left + 1; right < owners.length; right += 1) {
                    if (owners[left].factId === owners[right].factId) continue;
                    addSpatialRelation({
                        type: 'shares-value',
                        from: owners[left].factId,
                        to: owners[right].factId,
                        details: {
                            blackboardKey: key.split('|').slice(1).join('|'),
                            fromDimension: owners[left].dimension,
                            toDimension: owners[right].dimension
                        }
                    });
                }
            }
        });

        return {
            basic,
            windows,
            hits,
            events,
            links,
            blackboard: blackboardData,
            spatial,
            warnings
        };
    }

    global.AKEV3SkillData = Object.freeze({
        analyzeSkill,
        formatActionType,
        resolveValue,
        buildBlackboard
    });
})(window);
