(function (global) {
    'use strict';

    const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const ACTION_META_KEYS = ['isEnable', 'priorityLevel', 'priorityOffset', 'serverActionIndex'];
    const MAX_WALK_DEPTH = 64;
    const MAX_WALK_NODES = 150000;
    const MAX_EVENTS = 50000;
    const MAX_SUMMARY_FIELDS = 32;
    const OPEN_ENDED_FRAME = 999999;

    const SUMMARY_META_KEYS = new Set([
        '$type', 'isEnable', 'priorityLevel', 'priorityOffset', 'serverActionIndex'
    ]);
    const SUMMARY_IGNORED_KEYS = new Set([
        'selectorData', 'validatorData', 'postProcessorData', 'directCurve', 'customImpulseShape',
        'hitEffect', 'effectData', 'hitSoundData', 'forceSyncAnimData'
    ]);
    const SUMMARY_PRIORITY = [
        'buffId', 'targetBuffId', 'buffIds', 'buffIdList', 'buffInput', 'skillId', 'castSkillId',
        'targetSkillId', 'abilityEntityId', 'projectileId', 'enemyId', 'effectActionCfg', 'effectName', '_soundEvent',
        'soundEvent', 'key', 'blackboardKey', 'bbKey', 'contextKey', 'stackCount', 'count',
        'operation', 'operationType', 'calculateType', 'compare', 'compareType', 'value', 'valueA',
        'valueB', 'formulaItem', 'param', 'addition', 'multiplier', 'coefficient', 'damageType',
        'damageAttributeType', 'healType', 'superArmorValue', 'impactResistance', 'duration',
        'totalTime', 'triggerInterval', 'tickInterval', 'distance', 'moveDistance', 'speed',
        'horizontalSpeed', 'verticalSpeed', 'height', 'targetGroupKey', 'targetSource', 'source',
        'target', 'owner', 'type', 'side', 'zoneName'
    ];
    const SUMMARY_PRIORITY_INDEX = new Map(
        SUMMARY_PRIORITY.map((key, index) => [key.toLowerCase(), index])
    );

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

    function isBlackboardReference(value) {
        return isObject(value)
            && hasOwn(value, 'useBlackboardKey')
            && hasOwn(value, 'blackboardKey')
            && hasOwn(value, 'value');
    }

    function lookupContainer(container, key) {
        if (!container || !key) return undefined;
        if (container instanceof Map) return container.has(key) ? container.get(key) : undefined;
        if (Array.isArray(container)) {
            return container.find(entry => String(entry?.key ?? '') === key);
        }
        if (isObject(container) && hasOwn(container, key)) return container[key];
        return undefined;
    }

    function findBlackboardEntry(blackboard, key) {
        if (!blackboard || !key) return null;
        const localContainer = isObject(blackboard) && isObject(blackboard.byKey)
            ? blackboard.byKey
            : blackboard;
        const local = lookupContainer(localContainer, key);
        if (local !== undefined) return { entry: local, scope: 'local-default' };

        const externalContainers = [];
        if (isObject(blackboard)) {
            externalContainers.push(
                blackboard.externalByKey,
                blackboard.runtimeByKey,
                blackboard.assignments,
                blackboard.external
            );
        }
        for (let index = 0; index < externalContainers.length; index += 1) {
            const external = lookupContainer(externalContainers[index], key);
            if (external !== undefined) return { entry: external, scope: 'external-key' };
        }
        return null;
    }

    function resolveValue(value, blackboard) {
        if (!isBlackboardReference(value)) {
            return {
                value,
                fallbackValue: value,
                usesBlackboard: false,
                blackboardKey: null,
                resolved: true,
                status: 'literal',
                source: 'literal',
                dynamic: false
            };
        }

        const fallbackValue = value.value;
        const useBlackboard = value.useBlackboardKey === true;
        const key = value.blackboardKey === undefined || value.blackboardKey === null
            ? ''
            : String(value.blackboardKey);
        if (!useBlackboard) {
            return {
                value: fallbackValue,
                fallbackValue,
                usesBlackboard: false,
                blackboardKey: key || null,
                resolved: true,
                status: 'literal',
                source: 'literal',
                dynamic: false
            };
        }
        if (!key) {
            return {
                value: fallbackValue,
                fallbackValue,
                usesBlackboard: true,
                blackboardKey: '',
                resolved: false,
                status: 'empty-key-fallback',
                source: 'empty-key-fallback',
                dynamic: true
            };
        }

        const found = findBlackboardEntry(blackboard, key);
        if (found) {
            const entry = found.entry;
            return {
                value: blackboardScalar(entry),
                fallbackValue,
                usesBlackboard: true,
                blackboardKey: key,
                resolved: true,
                status: found.scope,
                source: found.scope,
                dynamic: found.scope === 'external-key' || !!entry?.isDynamic
            };
        }
        return {
            value: fallbackValue,
            fallbackValue,
            usesBlackboard: true,
            blackboardKey: key,
            resolved: false,
            status: 'external-key',
            source: 'external-key',
            dynamic: true
        };
    }

    function isActionNode(value) {
        return isObject(value) && !!value.$type
            && ACTION_META_KEYS.every(key => hasOwn(value, key));
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
            || normalized.includes('vfx')
            || normalized.includes('playsound')
            || normalized.includes('soundaction')
            || normalized.includes('voice')
            || normalized.includes('camera')
            || normalized.includes('screenshake')
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
            || normalized.includes('materialaction')
            || normalized.includes('debugprint')
            || normalized === 'logaction';
    }

    function classifyAction(type) {
        const normalized = String(type || '').toLowerCase();
        if (isPresentationType(type)) return 'presentation';
        if (normalized.includes('damageaction') || normalized === 'waterdronehitaction') return 'damage';
        if (normalized.includes('heal') || normalized.includes('recoverpoise')) return 'recovery';
        if (normalized.includes('shelter') || normalized.includes('shield')
            || normalized.includes('superarmor') || normalized.includes('armor')) return 'defense';
        if (normalized.includes('buff') || normalized.includes('aura') || normalized.includes('dispel')
            || normalized.includes('vulnerable') || normalized.includes('weakness')) return 'buff';
        if (normalized.includes('pausebufftime') || normalized.includes('setbuffduration')
            || normalized.includes('savebufflifetime') || normalized.includes('hitstop')
            || normalized.includes('timedilation') || normalized.includes('tickinterval')) return 'timing';
        if (normalized.includes('attribute') || normalized.includes('modifier')) return 'modifier';
        if (normalized.includes('spellinfliction') || normalized.includes('interrupt')
            || normalized.includes('crush') || normalized.includes('fracture')
            || normalized.includes('airborne') || normalized.includes('knockdown')) return 'control';
        if (normalized.includes('atb') || normalized.includes('usp') || normalized.includes('cost')
            || normalized.includes('resource')) return 'resource';
        if (normalized.includes('projectile') || normalized.includes('castskill')
            || normalized.includes('spawnabilityentity') || normalized.includes('spawnenemy')) return 'spawn';
        if (normalized.includes('findtarget') || normalized.includes('picktarget')
            || normalized.includes('mergetarget') || normalized.includes('targetpostprocessor')) return 'targeting';
        if (normalized.includes('move') || normalized.includes('rootmotion')
            || normalized.includes('teleport') || normalized.includes('pushback')) return 'movement';
        if (normalized.includes('condition') || normalized.includes('ifelse')
            || normalized.startsWith('check') || normalized.startsWith('compare')
            || normalized.includes('blackboard') || normalized.startsWith('save')
            || normalized.startsWith('store') || normalized.includes('random')
            || normalized.includes('switchaction') || normalized.includes('foreach')
            || normalized.includes('repeataction') || normalized.includes('doonce')) return 'logic';
        if (normalized.includes('finish') || normalized.includes('trigger')
            || normalized.includes('start') || normalized.includes('enable')) return 'lifecycle';
        return 'other';
    }

    function branchName(key) {
        return String(key || 'actions')
            .replace(/ActionData$/i, '')
            .replace(/Actions?$/i, '')
            || 'actions';
    }

    function branchRelation(key) {
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
    }

    function frameInfo(startFrame, endFrame) {
        const start = finiteNumber(startFrame);
        const rawEnd = finiteNumber(endFrame);
        const openEnded = rawEnd !== null && rawEnd >= OPEN_ENDED_FRAME;
        const end = openEnded ? null : rawEnd;
        return {
            startFrame: start,
            endFrame: end,
            rawEndFrame: rawEnd,
            openEnded,
            durationFrames: start !== null && end !== null && end >= start ? end - start : null
        };
    }

    function normalizeIconPath(spritePath) {
        const normalized = String(spritePath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/\.png$/i, '');
        return normalized
            ? `/public/images/assets/beyond/dynamicassets/gameplay/ui/sprites/bufficon/${normalized}.png`
            : '';
    }

    function analyzeBuff(buffData, context) {
        const data = isObject(buffData) ? buffData : {};
        const metaContext = isObject(context) ? context : {};
        const warnings = [];
        const warningKeys = new Set();
        const dependencies = [];
        const dependencyKeys = new Set();
        const events = [];
        const eventGroups = [];
        const timelineGroups = [];
        const links = [];
        const linkKeys = new Set();

        const addWarning = (code, details) => {
            const path = details?.path || '';
            const key = `${code}|${path}|${details?.key || ''}`;
            if (warningKeys.has(key)) return;
            warningKeys.add(key);
            warnings.push(Object.assign({
                code,
                messageKey: `modules.buff.v3.warnings.${code}`
            }, details || {}));
        };

        const localByKey = Object.create(null);
        const blackboardEntries = [];
        (Array.isArray(data.blackboard) ? data.blackboard : []).forEach((entry, index) => {
            if (!isObject(entry) || entry.key === undefined || entry.key === null || entry.key === '') return;
            const key = String(entry.key);
            const value = blackboardScalar(entry);
            const previous = localByKey[key];
            const history = previous ? previous.history.slice() : [];
            history.push({ index, value, isDynamic: !!entry.isDynamic });
            if (previous) addWarning('duplicateBlackboardKey', { key, path: `blackboard[${index}]` });
            const normalized = {
                key,
                index,
                value,
                valueDouble: hasOwn(entry, 'valueDouble') ? entry.valueDouble : null,
                valueStr: entry.valueStr ?? '',
                isDynamic: !!entry.isDynamic,
                source: 'buff',
                status: 'local-default',
                overridden: history.length > 1,
                history
            };
            localByKey[key] = normalized;
        });
        Object.keys(localByKey).forEach(key => blackboardEntries.push(localByKey[key]));

        const externalByKey = Object.create(null);
        const appendExternal = source => {
            if (!source) return;
            const sourceValue = isObject(source) && isObject(source.byKey) ? source.byKey : source;
            if (sourceValue instanceof Map) {
                sourceValue.forEach((value, key) => { externalByKey[String(key)] = value; });
                return;
            }
            if (Array.isArray(sourceValue)) {
                sourceValue.forEach(entry => {
                    if (entry?.key !== undefined && entry?.key !== null && entry.key !== '') {
                        externalByKey[String(entry.key)] = entry;
                    }
                });
                return;
            }
            if (isObject(sourceValue)) {
                Object.keys(sourceValue).forEach(key => { externalByKey[key] = sourceValue[key]; });
            }
        };
        appendExternal(metaContext.blackboard);
        appendExternal(metaContext.externalBlackboard);
        appendExternal(metaContext.assignments);
        appendExternal(metaContext.runtimeBlackboard);

        const blackboard = {
            entries: blackboardEntries,
            byKey: localByKey,
            externalByKey,
            dependencies,
            localCount: blackboardEntries.length,
            externalCount: Object.keys(externalByKey).length
        };

        const resolveField = (value, path) => {
            const resolved = resolveValue(value, blackboard);
            if (resolved.usesBlackboard) {
                const dependencyKey = `${path}|${resolved.blackboardKey || ''}|${resolved.status}`;
                if (!dependencyKeys.has(dependencyKey)) {
                    dependencyKeys.add(dependencyKey);
                    dependencies.push({
                        path,
                        key: resolved.blackboardKey || '',
                        status: resolved.status,
                        resolved: resolved.resolved,
                        value: resolved.value,
                        fallbackValue: resolved.fallbackValue,
                        dynamic: resolved.dynamic
                    });
                }
            }
            return resolved;
        };

        const resolveFlaggedValue = (value, useKey, key, path) => resolveField({
            useBlackboardKey: useKey === true,
            value,
            blackboardKey: key || ''
        }, path);

        const orderedKeys = value => Object.keys(value)
            .filter(key => !SUMMARY_META_KEYS.has(key) && !SUMMARY_IGNORED_KEYS.has(key))
            .sort((left, right) => {
                const leftRank = SUMMARY_PRIORITY_INDEX.get(left.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
                const rightRank = SUMMARY_PRIORITY_INDEX.get(right.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
                return leftRank - rightRank;
            });

        const countActionNodes = value => {
            const seen = new WeakSet();
            let count = 0;
            let nodes = 0;
            const visit = (item, depth) => {
                if (!item || typeof item !== 'object' || depth > 24 || nodes > 5000) return;
                if (seen.has(item)) return;
                seen.add(item);
                nodes += 1;
                if (isActionNode(item)) count += 1;
                if (Array.isArray(item)) {
                    item.forEach(child => visit(child, depth + 1));
                } else {
                    Object.keys(item).forEach(key => visit(item[key], depth + 1));
                }
            };
            visit(value, 0);
            return count;
        };

        const buildSummaryFields = (value, path, limit) => {
            const fields = [];
            const seen = new WeakSet();
            const fieldLimit = Math.max(1, Math.min(finiteNumber(limit) || MAX_SUMMARY_FIELDS, 64));
            let truncated = false;

            const append = (key, fieldValue, fieldPath) => {
                if (fields.length >= fieldLimit) {
                    truncated = true;
                    return;
                }
                if (fieldValue === undefined || fieldValue === null || fieldValue === '') return;
                fields.push({
                    key: String(key || 'value').replace(/^_+/, ''),
                    value: fieldValue,
                    path: fieldPath
                });
            };

            const visit = (item, key, fieldPath, depth) => {
                if (fields.length >= fieldLimit) {
                    truncated = true;
                    return;
                }
                if (item === undefined || item === null || item === '') return;
                if (isBlackboardReference(item)) {
                    append(key, resolveField(item, fieldPath), fieldPath);
                    return;
                }
                if (Array.isArray(item)) {
                    if (!item.length) return;
                    if (item.every(child => child === null || ['string', 'number', 'boolean'].includes(typeof child))) {
                        append(key, item.slice(0, 12), fieldPath);
                        if (item.length > 12) append(`${key}RemainingCount`, item.length - 12, fieldPath);
                        return;
                    }
                    if (seen.has(item)) return;
                    seen.add(item);
                    item.slice(0, 10).forEach((child, index) => (
                        visit(child, key, `${fieldPath}[${index}]`, depth + 1)
                    ));
                    if (item.length > 10) append(`${key}RemainingCount`, item.length - 10, fieldPath);
                    return;
                }
                if (!isObject(item)) {
                    append(key, item, fieldPath);
                    return;
                }
                if (isActionNode(item)) return;
                if (seen.has(item)) return;
                seen.add(item);
                if (depth >= 5) {
                    truncated = true;
                    return;
                }
                if (item.$type) append(`${key}Type`, formatActionType(item.$type), `${fieldPath}.$type`);
                if (hasOwn(item, 'inputValueKey') && item.inputValueKey && item.useDirectValue !== true) {
                    append(item.targetKey || item.inputValueKey || key, resolveField({
                        useBlackboardKey: true,
                        value: item.numericValue ?? item.stringValue ?? null,
                        blackboardKey: item.inputValueKey
                    }, fieldPath), fieldPath);
                    return;
                }
                if (item.useDirectValue === true && (hasOwn(item, 'numericValue') || hasOwn(item, 'stringValue'))) {
                    append(
                        item.targetKey || key,
                        item.directValueType === 'String' ? item.stringValue : item.numericValue,
                        fieldPath
                    );
                    return;
                }
                orderedKeys(item).forEach(childKey => {
                    const child = item[childKey];
                    if (isObject(child) && (hasOwn(child, 'targetSource') || hasOwn(child, 'targetGroupKey'))
                        && /(target|source|owner|attacker|selector|calculation)/i.test(childKey)) {
                        append(`${childKey}Source`, child.targetSource ?? child.selectorOwner ?? '', `${fieldPath}.${childKey}.targetSource`);
                        append(`${childKey}Group`, child.targetGroupKey ?? '', `${fieldPath}.${childKey}.targetGroupKey`);
                        return;
                    }
                    const nestedActionCount = isNestedActionKey(childKey) ? countActionNodes(child) : 0;
                    if (nestedActionCount) {
                        append(`${childKey}Count`, nestedActionCount, `${fieldPath}.${childKey}`);
                        return;
                    }
                    visit(child, childKey, `${fieldPath}.${childKey}`, depth + 1);
                });
            };

            if (isObject(value)) {
                orderedKeys(value).forEach(key => visit(value[key], key, `${path}.${key}`, 0));
            } else {
                visit(value, 'value', path, 0);
            }
            return { fields, truncated };
        };

        const eventReference = event => ({
            eventIndex: event.index,
            type: event.type,
            source: event.source,
            eventKind: event.eventKind,
            eventName: event.eventName,
            groupIndex: event.groupIndex,
            sequenceIndex: event.sequenceIndex,
            path: event.path
        });

        const addLink = (kind, id, relation, event, path, resolvedId, details) => {
            const normalizedId = id === undefined || id === null ? '' : String(id);
            const blackboardKey = resolvedId?.blackboardKey || '';
            if (!normalizedId && !blackboardKey) return;
            if (kind === 'buff' && normalizedId && !/^buff_/i.test(normalizedId)) return;
            const eventIndex = event?.index ?? null;
            const dedupeKey = `${kind}|${normalizedId}|${blackboardKey}|${relation}|${path}|${eventIndex}`;
            if (linkKeys.has(dedupeKey)) return;
            linkKeys.add(dedupeKey);
            links.push(Object.assign({
                kind,
                id: normalizedId,
                relation,
                path,
                eventIndex,
                eventType: event?.type || '',
                source: event?.source || '',
                resolvedId: resolvedId || null,
                dynamic: !!resolvedId?.usesBlackboard && (!resolvedId.resolved || resolvedId.dynamic)
            }, details || {}));
        };

        const addBuffLinkValue = (rawValue, relation, event, path, parent) => {
            let value = rawValue;
            if (parent?.readIdFromBlackboard === true && parent.buffIdKey) {
                value = {
                    useBlackboardKey: true,
                    value: rawValue,
                    blackboardKey: parent.buffIdKey
                };
            }
            const resolved = resolveField(value, path);
            addLink('buff', resolved.value, relation, event, path, resolved);
        };

        const addTagLink = (tag, relation, event, path) => {
            const tagId = isObject(tag) ? firstDefined(tag.tagId, tag.id) : tag;
            if (tagId === undefined || tagId === null || tagId === '') return;
            addLink('tag', tagId, relation, event, path, null);
        };

        const relationForAction = type => {
            const normalized = String(type || '').toLowerCase();
            if (normalized.includes('aura')) return 'aura';
            if (normalized.includes('create') || normalized.includes('add') || normalized.includes('apply')) return 'create';
            if (normalized.includes('extend')) return 'extend';
            if (normalized.includes('inherit')) return 'inherit';
            if (normalized.includes('dispel')) return 'dispel';
            if (normalized.includes('finish') || normalized.includes('remove') || normalized.includes('clear')) return 'finish';
            if (normalized.startsWith('check') || normalized.includes('condition')) return 'condition';
            return 'reference';
        };

        const extractActionLinks = (action, event) => {
            const relation = relationForAction(event.type);
            const allowTagQuery = relation === 'finish' || relation === 'extend' || relation === 'inherit'
                || relation === 'dispel' || relation === 'condition';
            const seen = new WeakSet();
            let visited = 0;

            const visit = (value, key, path, parent, depth, insideBuffInput, insideTagQuery) => {
                if (depth > 16 || visited > 10000 || value === undefined || value === null) return;
                const normalizedKey = String(key || '').toLowerCase();
                const nextInsideBuffInput = insideBuffInput || normalizedKey === 'buffinput';
                const nextInsideTagQuery = insideTagQuery || normalizedKey === 'query' || normalizedKey === 'tags';

                if (normalizedKey === 'buffid' || normalizedKey === 'targetbuffid') {
                    addBuffLinkValue(value, relation, event, path, parent);
                    return;
                }
                if (normalizedKey === 'buffids' || normalizedKey === 'buffidlist') {
                    const values = Array.isArray(value) ? value : [value];
                    values.forEach((item, index) => addBuffLinkValue(item, relation, event, `${path}[${index}]`, parent));
                    return;
                }
                if (allowTagQuery && nextInsideTagQuery && normalizedKey === 'tagid') {
                    addTagLink(value, relation, event, path);
                    return;
                }
                if (nextInsideBuffInput && (typeof value === 'string' || isBlackboardReference(value))) {
                    addBuffLinkValue(value, relation === 'reference' ? 'buffInput' : relation, event, path, parent);
                    return;
                }
                if (Array.isArray(value)) {
                    if (seen.has(value)) return;
                    seen.add(value);
                    visited += 1;
                    value.forEach((item, index) => visit(
                        item,
                        key,
                        `${path}[${index}]`,
                        parent,
                        depth + 1,
                        nextInsideBuffInput,
                        nextInsideTagQuery
                    ));
                    return;
                }
                if (!isObject(value) || (value !== action && isActionNode(value))) return;
                if (seen.has(value)) return;
                seen.add(value);
                visited += 1;
                Object.keys(value).forEach(childKey => visit(
                    value[childKey],
                    childKey,
                    `${path}.${childKey}`,
                    value,
                    depth + 1,
                    nextInsideBuffInput,
                    nextInsideTagQuery
                ));
            };
            visit(action, '', event.path, null, 0, false, false);
        };

        const normalizeAssignment = (item, path) => {
            const key = String(item?.targetKey ?? item?.inputValueKey ?? '');
            let rawValue = null;
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
            return { key, value: resolveField(rawValue, path) };
        };

        const normalizeCreatedBuffs = (action, event) => {
            const entries = [];
            (Array.isArray(action.buffs) ? action.buffs : []).forEach((buff, index) => {
                const path = `${event.path}.buffs[${index}]`;
                let rawId = buff?.buffId ?? '';
                if (buff?.readIdFromBlackboard && buff?.buffIdKey) {
                    rawId = {
                        useBlackboardKey: true,
                        value: rawId,
                        blackboardKey: buff.buffIdKey
                    };
                }
                entries.push({
                    index,
                    buffId: resolveField(rawId, `${path}.buffId`),
                    assignBlackboard: !!buff?.assignBlackboard,
                    assignments: (Array.isArray(buff?.assignItems) ? buff.assignItems : []).map((item, itemIndex) => (
                        normalizeAssignment(item, `${path}.assignItems[${itemIndex}]`)
                    ))
                });
            });
            if (action.buffInput !== undefined && action.buffInput !== null) {
                const values = Array.isArray(action.buffInput) ? action.buffInput : [action.buffInput];
                values.forEach((item, index) => {
                    let rawId = item;
                    if (isObject(item) && hasOwn(item, 'buffId')) rawId = item.buffId;
                    if (typeof rawId === 'string' || isBlackboardReference(rawId)) {
                        entries.push({
                            index: entries.length,
                            buffId: resolveField(rawId, `${event.path}.buffInput[${index}]`),
                            assignBlackboard: false,
                            assignments: []
                        });
                    }
                });
            }
            return entries;
        };

        const handleAction = (action, event) => {
            const normalized = event.type.toLowerCase();
            const path = event.path;
            extractActionLinks(action, event);

            if (normalized === 'damageaction' || normalized === 'channelingdamageaction') {
                const units = (Array.isArray(action.damageUnits) ? action.damageUnits : []).map((unit, index) => {
                    const atkCalculation = isObject(unit?.atkCalculation) ? unit.atkCalculation : null;
                    const effectiveAtkScale = !unit?.simpleCalculation && atkCalculation?.atkScale !== undefined
                        ? atkCalculation.atkScale
                        : unit?.atkScale;
                    return {
                        index,
                        damageType: unit?.damageType ?? '',
                        damageAttributeType: unit?.damageAttributeType ?? '',
                        atkScale: resolveField(effectiveAtkScale, `${path}.damageUnits[${index}].atkScale`),
                        atkCalculationType: atkCalculation ? formatActionType(atkCalculation.$type) : '',
                        poiseValue: resolveField(
                            unit?.poiseCalculation?.value ?? unit?.poiseCalculation ?? null,
                            `${path}.damageUnits[${index}].poiseCalculation.value`
                        ),
                        simpleCalculation: !!unit?.simpleCalculation,
                        ignoreDamageImmuneLevel: unit?.ignoreDamageImmuneLevel ?? '',
                        ignorePoiseImmune: !!unit?.ignorePoiseImmune,
                        reduceDamageForGuard: !!unit?.reduceDamageForGuard,
                        reduceDamageForGuardRatio: finiteNumber(unit?.reduceDamageForGuardRatio)
                    };
                });
                event.details = {
                    targetGroupKey: action.targetSettings?.targetGroupKey ?? '',
                    units
                };
                if (!units.length) addWarning('emptyDamageAction', { path });
                return;
            }

            if (normalized.includes('createbuff') || normalized.includes('addbuff') || normalized.includes('aura')) {
                const buffs = normalizeCreatedBuffs(action, event);
                event.details = {
                    buffs,
                    count: hasOwn(action, 'count') ? resolveField(action.count, `${path}.count`) : null,
                    targetSource: action.targetSettings?.targetSource ?? '',
                    targetGroupKey: action.targetSettings?.targetGroupKey ?? '',
                    buffSource: action.buffSource ?? '',
                    autoFinishByAction: !!action.autoFinishByAction,
                    asChildBuff: !!action.asChildBuff
                };
                return;
            }

            if (normalized.includes('setsuperarmor')) {
                event.details = {
                    superArmorValue: resolveField(action.superArmorValue, `${path}.superArmorValue`),
                    impactResistance: resolveField(action.impactResistance, `${path}.impactResistance`),
                    targetGroupKey: action.targetSettings?.targetGroupKey ?? ''
                };
                return;
            }

            if (normalized.includes('hitstop') || normalized.includes('timedilation')
                || normalized.includes('pausebufftime') || normalized.includes('setbuffduration')
                || normalized.includes('savebufflifetime')) {
                const fields = {};
                ['duration', 'totalTime', 'triggerInterval', 'value', 'time', 'scale'].forEach(key => {
                    if (hasOwn(action, key)) fields[key] = resolveField(action[key], `${path}.${key}`);
                });
                event.details = fields;
            }
        };

        const walkedObjects = new WeakSet();
        let walkedNodeCount = 0;
        let traversalStopped = false;

        const walkContainer = (container, inherited, path, depth) => {
            if (traversalStopped || !container || typeof container !== 'object') return;
            if (depth > MAX_WALK_DEPTH) {
                addWarning('actionDepthLimit', { path, limit: MAX_WALK_DEPTH });
                return;
            }
            if (walkedObjects.has(container)) return;
            walkedObjects.add(container);
            walkedNodeCount += 1;
            if (walkedNodeCount > MAX_WALK_NODES) {
                traversalStopped = true;
                addWarning('actionNodeLimit', { path, limit: MAX_WALK_NODES });
                return;
            }
            if (Array.isArray(container)) {
                container.forEach((item, index) => walkContainer(item, inherited, `${path}[${index}]`, depth + 1));
                return;
            }

            let parentEventIndex = inherited.parentEventIndex ?? null;
            if (isActionNode(container)) {
                if (events.length >= MAX_EVENTS) {
                    traversalStopped = true;
                    addWarning('actionEventLimit', { path, limit: MAX_EVENTS });
                    return;
                }
                const type = formatActionType(container.$type);
                const summary = buildSummaryFields(container, path, MAX_SUMMARY_FIELDS);
                const range = frameInfo(inherited.startFrame, inherited.endFrame);
                const event = Object.assign({
                    index: events.length,
                    type,
                    rawType: String(container.$type),
                    category: classifyAction(type),
                    presentation: isPresentationType(type),
                    synthetic: false,
                    enabled: container.isEnable !== false,
                    serverActionIndex: container.serverActionIndex ?? null,
                    priorityLevel: container.priorityLevel ?? null,
                    priorityOffset: container.priorityOffset ?? null,
                    parentEventIndex,
                    relation: inherited.relation || '',
                    branchPath: inherited.branchPath.slice(),
                    source: inherited.source,
                    eventKind: inherited.eventKind,
                    eventName: inherited.eventName,
                    abilityEvent: inherited.eventKind === 'ability' ? inherited.eventName : null,
                    groupIndex: inherited.groupIndex,
                    sequenceIndex: inherited.sequenceIndex,
                    summaryFields: summary.fields,
                    summaryTruncated: summary.truncated,
                    details: null,
                    path
                }, range);
                events.push(event);
                handleAction(container, event);
                parentEventIndex = event.index;
            }

            Object.keys(container).forEach(key => {
                const child = container[key];
                if (!child || typeof child !== 'object') return;
                const isBranch = isNestedActionKey(key);
                walkContainer(child, Object.assign({}, inherited, {
                    parentEventIndex,
                    relation: isBranch ? branchRelation(key) : inherited.relation,
                    branchPath: isBranch ? inherited.branchPath.concat(branchName(key)) : inherited.branchPath
                }), `${path}.${key}`, depth + 1);
            });
        };

        const baseInherited = (source, eventKind, eventName, groupIndex, sequenceIndex, range) => ({
            source,
            eventKind,
            eventName,
            groupIndex,
            sequenceIndex,
            startFrame: range?.startFrame ?? null,
            endFrame: range?.rawEndFrame ?? range?.endFrame ?? null,
            parentEventIndex: null,
            relation: '',
            branchPath: []
        });

        const processEventCollection = (items, kind, eventField, source) => {
            (Array.isArray(items) ? items : []).forEach((item, groupIndex) => {
                const eventValue = item?.[eventField];
                const eventName = eventValue === undefined || eventValue === null ? '' : String(eventValue);
                const startEventIndex = events.length;
                const wrappers = Array.isArray(item?.actions) ? item.actions : [];
                wrappers.forEach((wrapper, sequenceIndex) => {
                    walkContainer(
                        wrapper,
                        baseInherited(source, kind, eventName, groupIndex, sequenceIndex),
                        `${eventField === 'buffEvent' ? 'buffEventAction' : (eventField === 'abilityEvent' ? 'abilityEventAction' : 'igniteEventAction')}[${groupIndex}].actions[${sequenceIndex}]`,
                        0
                    );
                });
                const actionIndices = [];
                for (let index = startEventIndex; index < events.length; index += 1) actionIndices.push(index);
                eventGroups.push({
                    kind,
                    source,
                    groupIndex,
                    eventName,
                    buffEvent: kind === 'buff' ? eventName : null,
                    abilityEvent: kind === 'ability' ? eventName : null,
                    igniteType: kind === 'ignite' ? eventName : null,
                    finishAfterIgnited: kind === 'ignite' ? !!item?.finishAfterIgnited : false,
                    wrapperCount: wrappers.length,
                    actionIndices,
                    actionCount: actionIndices.length,
                    presentationActionCount: actionIndices.filter(index => events[index]?.presentation).length
                });
            });
        };

        processEventCollection(data.buffEventAction, 'buff', 'buffEvent', 'buff-event');
        processEventCollection(data.abilityEventAction, 'ability', 'abilityEvent', 'ability-event');
        processEventCollection(data.igniteEventAction, 'ignite', 'igniteType', 'ignite-event');

        (Array.isArray(data.timelineActions) ? data.timelineActions : []).forEach((group, groupIndex) => {
            const range = frameInfo(group?._startFrame, group?._endFrame);
            if (!range.openEnded && range.startFrame !== null && range.endFrame !== null && range.endFrame < range.startFrame) {
                addWarning('reversedTimelineRange', {
                    path: `timelineActions[${groupIndex}]`,
                    startFrame: range.startFrame,
                    endFrame: range.endFrame
                });
            }
            const startEventIndex = events.length;
            walkContainer(
                group,
                baseInherited('timeline', 'timeline', '', groupIndex, 0, range),
                `timelineActions[${groupIndex}]`,
                0
            );
            const actionIndices = [];
            for (let index = startEventIndex; index < events.length; index += 1) actionIndices.push(index);
            timelineGroups.push(Object.assign({
                groupIndex,
                actionIndices,
                actionCount: actionIndices.length,
                presentationActionCount: actionIndices.filter(index => events[index]?.presentation).length
            }, range));
        });

        const normalizeCondition = (condition, source, kind, index, path) => {
            const startEventIndex = events.length;
            walkContainer(
                condition,
                baseInherited(source, kind, '', index, 0),
                path,
                0
            );
            const actionIndices = [];
            for (let eventIndex = startEventIndex; eventIndex < events.length; eventIndex += 1) {
                actionIndices.push(eventIndex);
            }
            return {
                onlyExecuteWhenSourceIsMainChar: !!condition?.onlyExecuteWhenSourceIsMainChar,
                onlyExecuteWhenSourceIsGuard: !!condition?.onlyExecuteWhenSourceIsGuard,
                actionIndices,
                actionCount: actionIndices.length
            };
        };

        const normalizeDescriptor = (descriptor, path) => {
            const summary = buildSummaryFields(descriptor, path, 24);
            const valueField = ['param', 'value', 'addition', 'baseMultiplier', 'multiplier', 'coefficient', 'scale']
                .find(key => hasOwn(descriptor || {}, key));
            const nestedModifierValue = !valueField && isObject(descriptor?.modifier) && hasOwn(descriptor.modifier, 'param')
                ? descriptor.modifier.param
                : undefined;
            return {
                type: descriptor?.$type ? formatActionType(descriptor.$type) : String(descriptor?.type ?? ''),
                side: descriptor?.side ?? descriptor?.modifyTargetSide ?? '',
                zoneName: descriptor?.zoneName ?? '',
                modifyType: descriptor?.modifyType ?? '',
                formulaItem: descriptor?.formulaItem ?? descriptor?.modifier?.formulaItem ?? '',
                attributeType: descriptor?.attributeType ?? descriptor?.modifier?.attributeType ?? '',
                value: valueField
                    ? resolveField(descriptor[valueField], `${path}.${valueField}`)
                    : (nestedModifierValue !== undefined
                        ? resolveField(nestedModifierValue, `${path}.modifier.param`)
                        : null),
                summaryFields: summary.fields,
                summaryTruncated: summary.truncated
            };
        };

        const normalizeModifierGroups = (items, kind, processorsKey) => (Array.isArray(items) ? items : []).map((item, index) => {
            const basePath = `${kind}Modifier[${index}]`;
            const processors = (Array.isArray(item?.[processorsKey]) ? item[processorsKey] : []).map((processor, processorIndex) => (
                normalizeDescriptor(processor, `${basePath}.${processorsKey}[${processorIndex}]`)
            ));
            return {
                index,
                type: kind,
                enableSide: item?.enableSide ?? '',
                target: item?.enableSide ?? '',
                condition: normalizeCondition(
                    item?.condition,
                    'modifier-condition',
                    `${kind}-modifier`,
                    index,
                    `${basePath}.condition`
                ),
                processors
            };
        });

        const attributeConfig = isObject(data.attributeModifier) ? data.attributeModifier : {};
        const attributes = (Array.isArray(attributeConfig.attributeModifiers) ? attributeConfig.attributeModifiers : []).map((item, index) => {
            const path = `attributeModifier.attributeModifiers[${index}]`;
            return {
                index,
                type: 'attribute',
                modifyAttributeType: item?.modifyAttributeType ?? '',
                attributeType: item?.attributeType ?? '',
                attrType: item?.attributeType ?? '',
                formulaItem: item?.formulaItem ?? '',
                formula: item?.formulaItem ?? '',
                param: resolveField(item?.param, `${path}.param`),
                value: resolveField(item?.param, `${path}.param`),
                target: item?.target ?? item?.modifyTargetSide ?? ''
            };
        });

        const damage = normalizeModifierGroups(data.damageModifier, 'damage', 'damageProcessors');
        const heal = normalizeModifierGroups(data.healModifier, 'heal', 'healProcessors');
        const poise = normalizeModifierGroups(data.poiseModifier, 'poise', 'poiseProcessors');
        const globalModifiers = (Array.isArray(data.globalModifier) ? data.globalModifier : []).map((item, index) => {
            const path = `globalModifier[${index}]`;
            const summary = buildSummaryFields(item, path, 20);
            return {
                index,
                type: item?.type ?? '',
                formulaItem: item?.formulaItem ?? '',
                formula: item?.formulaItem ?? '',
                param: resolveField(item?.param, `${path}.param`),
                value: resolveField(item?.param, `${path}.param`),
                applyToReturnAtbGain: !!item?.applyToReturnAtbGain,
                summaryFields: summary.fields,
                summaryTruncated: summary.truncated
            };
        });
        const shields = (Array.isArray(data.shieldConfigs) ? data.shieldConfigs : []).map((item, index) => {
            const path = `shieldConfigs[${index}]`;
            const calculation = isObject(item?.valueCalculation) ? item.valueCalculation : {};
            const calculationSummary = buildSummaryFields(calculation, `${path}.valueCalculation`, 20);
            return {
                index,
                infinityValue: !!item?.infinityValue,
                value: hasOwn(calculation, 'value')
                    ? resolveField(calculation.value, `${path}.valueCalculation.value`)
                    : null,
                calculation: {
                    type: calculation.$type ? formatActionType(calculation.$type) : '',
                    applyScale: !!calculation.applyScale,
                    valueScale: hasOwn(calculation, 'valueScale')
                        ? resolveField(calculation.valueScale, `${path}.valueCalculation.valueScale`)
                        : null,
                    summaryFields: calculationSummary.fields,
                    summaryTruncated: calculationSummary.truncated
                },
                absorbCnt: resolveField(item?.absorbCnt, `${path}.absorbCnt`),
                absorbAllDmgWhenConsume: !!item?.absorbAllDmgWhenConsume,
                removeBuffWhenConsume: !!item?.removeBuffWhenConsume,
                priority: item?.priority ?? '',
                damageAbsorptions: (Array.isArray(item?.damageAbsorptions) ? item.damageAbsorptions : []).map((entry, entryIndex) => (
                    normalizeDescriptor(entry, `${path}.damageAbsorptions[${entryIndex}]`)
                ))
            };
        });

        const stackingData = isObject(data.stackingSettings) ? data.stackingSettings : {};
        const stackEffects = (Array.isArray(stackingData.stackEffects) ? stackingData.stackEffects : []).map((stackEffect, stackIndex) => {
            const effects = (Array.isArray(stackEffect?.effectActions) ? stackEffect.effectActions : []).map((effect, effectIndex) => {
                const path = `stackingSettings.stackEffects[${stackIndex}].effectActions[${effectIndex}]`;
                const summary = buildSummaryFields(effect, path, 16);
                const effectName = effect?.effectActionCfg?.effectName ?? effect?.effectName ?? '';
                let eventIndex = null;
                if (isActionNode(effect)) {
                    const firstEventIndex = events.length;
                    walkContainer(
                        effect,
                        baseInherited('stacking', 'stacking', String(stackIndex + 1), stackIndex, effectIndex),
                        path,
                        0
                    );
                    if (events.length > firstEventIndex) eventIndex = firstEventIndex;
                } else if (!effect?.$type) {
                    eventIndex = events.length;
                    events.push({
                        index: eventIndex,
                        type: 'StackEffect',
                        rawType: '',
                        category: 'presentation',
                        presentation: true,
                        synthetic: true,
                        enabled: effect?.isEnable !== false,
                        serverActionIndex: effect?.serverActionIndex ?? null,
                        priorityLevel: effect?.priorityLevel ?? null,
                        priorityOffset: effect?.priorityOffset ?? null,
                        parentEventIndex: null,
                        relation: 'stack-effect',
                        branchPath: ['stackEffects'],
                        source: 'stacking',
                        eventKind: 'stacking',
                        eventName: String(stackIndex + 1),
                        abilityEvent: null,
                        groupIndex: stackIndex,
                        sequenceIndex: effectIndex,
                        summaryFields: summary.fields,
                        summaryTruncated: summary.truncated,
                        details: {
                            effectName,
                            fxType: effect?.effectActionCfg?.fxType ?? ''
                        },
                        path,
                        startFrame: null,
                        endFrame: null,
                        rawEndFrame: null,
                        openEnded: false,
                        durationFrames: null
                    });
                }
                return {
                    index: effectIndex,
                    eventIndex,
                    presentation: true,
                    enabled: effect?.isEnable !== false,
                    effectName,
                    fxType: effect?.effectActionCfg?.fxType ?? '',
                    summaryFields: summary.fields
                };
            });
            return {
                index: stackIndex,
                effectCount: effects.length,
                effects
            };
        });

        Object.keys(data).forEach(key => {
            walkContainer(
                data[key],
                baseInherited('config', 'config', '', null, null),
                key,
                0
            );
        });

        const normalizeTag = (tag, index, path) => ({
            index,
            tagId: isObject(tag) ? firstDefined(tag.tagId, tag.id, tag.tag) : tag,
            queryType: isObject(tag) ? (tag.queryType ?? '') : '',
            path
        });
        const iconConfig = isObject(data.iconConfig) ? data.iconConfig : {};
        const spritePath = iconConfig._spritePath ?? '';
        const identity = {
            id: data.id ?? '',
            hasIcon: !!data.hasIcon,
            spritePath,
            iconPath: data.hasIcon ? normalizeIconPath(spritePath) : '',
            iconConfig: {
                showInHeadBarCommon: !!iconConfig.showInHeadBarCommon,
                showInHeadBarAttached: !!iconConfig.showInHeadBarAttached,
                showInSquadIcon: !!iconConfig.showInSquadIcon,
                onlyShowForMainCharacter: !!iconConfig.onlyShowForMainCharacter,
                abnormalColorType: iconConfig.abnormalColorType ?? '',
                iconStyleInSquad: iconConfig.iconStyleInSquad ?? ''
            }
        };
        const core = {
            lifeType: data.lifeType ?? '',
            duration: resolveField(data.duration, 'duration'),
            triggerInterval: resolveField(data.triggerInterval, 'triggerInterval'),
            waitFirstTriggerInterval: !!data.waitFirstTriggerInterval,
            maxTriggerCnt: resolveField(data.maxTriggerCnt, 'maxTriggerCnt'),
            hasAddingCooldown: !!data.hasAddingCooldown,
            addingCooldown: resolveField(data.addingCooldown, 'addingCooldown'),
            ignoreCooldownWhenAdding: !!data.ignoreCooldownWhenAdding,
            ignoreTagImmune: !!data.ignoreTagImmune,
            useTimeDilationDt: !!data.useTimeDilationDt,
            onlyUseSelfTimeDilation: !!data.onlyUseSelfTimeDilation,
            finishOnRepatriate: !!data.finishOnRepatriate
        };
        const stacking = {
            identifierType: stackingData.identifierType ?? '',
            stackingType: stackingData.stackingType ?? '',
            stackingKey: stackingData.stackingKey ?? '',
            usePriorityKey: !!stackingData.usePriorityKey,
            priorityKey: stackingData.priorityKey ?? '',
            negatePriority: !!stackingData.negatePriority,
            priority: resolveFlaggedValue(
                stackingData.priority,
                stackingData.usePriorityKey,
                stackingData.priorityKey,
                'stackingSettings.priority'
            ),
            useMaxStackCntKey: !!stackingData.useMaxStackCntKey,
            maxStackCntKey: stackingData.maxStackCntKey ?? '',
            maxStackCnt: resolveFlaggedValue(
                stackingData.maxStackCnt,
                stackingData.useMaxStackCntKey,
                stackingData.maxStackCntKey,
                'stackingSettings.maxStackCnt'
            ),
            isNeedStackEffect: !!stackingData.isNeedStackEffect,
            stackEffects
        };
        const dispelData = isObject(data.dispelConfig) ? data.dispelConfig : {};
        const dispel = {
            canBeDispelled: !!dispelData.canBeDispelled,
            dispelledLevel: dispelData.dispelledLevel ?? ''
        };

        return {
            identity,
            core,
            stacking,
            dispel,
            modifiers: {
                isConvertedAttribute: !!attributeConfig.isConvertedAttribute,
                attributes,
                damage,
                heal,
                poise,
                global: globalModifiers,
                shields
            },
            tags: {
                apply: (Array.isArray(data.applyTags) ? data.applyTags : []).map((tag, index) => (
                    normalizeTag(tag, index, `applyTags[${index}]`)
                )),
                extendAfterTrigger: (Array.isArray(data.tagsAfterTriggerExtendBuffAction)
                    ? data.tagsAfterTriggerExtendBuffAction
                    : []).map((tag, index) => (
                    normalizeTag(tag, index, `tagsAfterTriggerExtendBuffAction[${index}]`)
                ))
            },
            eventGroups,
            timelineGroups,
            events,
            links,
            blackboard,
            warnings,
            stats: {
                eventCount: events.length,
                presentationEventCount: events.filter(event => event.presentation).length,
                linkCount: links.length,
                blackboardDependencyCount: dependencies.length,
                walkedNodeCount,
                traversalStopped
            }
        };
    }

    global.AKEV3BuffData = Object.freeze({
        analyzeBuff,
        resolveValue,
        formatActionType
    });
})(window);
