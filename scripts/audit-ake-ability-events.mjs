#!/usr/bin/env node

import {
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    hasRuntimeAbilityEventProducer,
    runtimeAbilityEventProducer
} from '../src/core/ability-event-producers.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..');

function shortType(rawType) {
    return String(rawType ?? '').split(',')[0].split('+')[0].split('.').at(-1);
}

function pathPart(key) {
    return /^\d+$/.test(String(key)) ? `[${key}]` : `.${key}`;
}

function eventIdentity(value) {
    return typeof value === 'string' && value.length > 0
        ? value
        : `@invalid:${typeof value}:${JSON.stringify(value)}`;
}

function characterIds(raw) {
    return [...new Set(JSON.stringify(raw).match(/chr_\d{4}_[a-z0-9]+/g) ?? [])].sort();
}

function addConsumer(events, input) {
    const key = eventIdentity(input.eventType);
    if (!events.has(key)) {
        const valid = typeof input.eventType === 'string' && input.eventType.length > 0;
        events.set(key, {
            key,
            eventType: valid ? input.eventType : null,
            serializedValue: valid ? null : input.eventType ?? null,
            status: valid
                ? (hasRuntimeAbilityEventProducer(input.eventType)
                    ? 'complete'
                    : 'emitter-required')
                : 'invalid-type',
            producer: valid ? runtimeAbilityEventProducer(input.eventType) : null,
            consumerGroups: 0,
            byDataset: {},
            byChannel: {},
            sourceEntities: new Set(),
            characterIds: new Set(),
            samples: []
        });
    }
    const entry = events.get(key);
    entry.consumerGroups += 1;
    entry.byDataset[input.dataset] = (entry.byDataset[input.dataset] ?? 0) + 1;
    entry.byChannel[input.channel] = (entry.byChannel[input.channel] ?? 0) + 1;
    entry.sourceEntities.add(input.entityId);
    for (const characterId of input.characterIds) entry.characterIds.add(characterId);
    if (entry.samples.length < 4) entry.samples.push({
        dataset: input.dataset,
        channel: input.channel,
        entityId: input.entityId,
        file: input.file,
        path: input.path
    });
}

function collectNestedListeners(value, location, events) {
    if (Array.isArray(value)) {
        value.forEach((child, index) => collectNestedListeners(child, {
            ...location,
            path: `${location.path}[${index}]`
        }, events));
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (shortType(value.$type) === 'EventListenerAction') {
        for (const [groupIndex, group] of (value.abilityActionMap ?? []).entries()) {
            addConsumer(events, {
                ...location,
                channel: 'EventListenerAction',
                eventType: group?.abilityEvent,
                path: `${location.path}.abilityActionMap[${groupIndex}]`
            });
        }
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === 'abilityActionMap' && shortType(value.$type) === 'EventListenerAction') {
            continue;
        }
        collectNestedListeners(child, {
            ...location,
            path: `${location.path}${pathPart(key)}`
        }, events);
    }
}

function stableObject(input) {
    return Object.fromEntries(Object.entries(input).sort(([left], [right]) =>
        left.localeCompare(right)
    ));
}

export function buildAkeAbilityEventAudit({ projectRoot = defaultProjectRoot } = {}) {
    const events = new Map();
    for (const dataset of ['BuffData', 'SkillData']) {
        const directory = path.join(
            projectRoot,
            'reference',
            'public-data',
            'akedata',
            'Json',
            dataset
        );
        for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
            const raw = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
            const entityId = raw.id ?? raw.skillId ?? file.replace(/\.json$/, '');
            const location = {
                dataset,
                entityId,
                file: path.relative(projectRoot, path.join(directory, file)),
                characterIds: characterIds(raw),
                path: '$'
            };
            if (dataset === 'BuffData') {
                for (const [groupIndex, group] of (raw.abilityEventAction ?? []).entries()) {
                    addConsumer(events, {
                        ...location,
                        channel: 'BuffAbilityEventAction',
                        eventType: group?.abilityEvent,
                        path: `$.abilityEventAction[${groupIndex}]`
                    });
                }
            }
            if (dataset === 'SkillData') {
                for (const [groupIndex, group] of (
                    raw.actionGroupData?.passiveEventActions ?? []
                ).entries()) {
                    addConsumer(events, {
                        ...location,
                        channel: 'SkillPassiveEventAction',
                        eventType: group?.abilityEvent,
                        path: `$.actionGroupData.passiveEventActions[${groupIndex}]`
                    });
                }
            }
            collectNestedListeners(raw, location, events);
        }
    }

    const entries = [...events.values()].map(entry => ({
        ...entry,
        byDataset: stableObject(entry.byDataset),
        byChannel: stableObject(entry.byChannel),
        sourceEntityCount: entry.sourceEntities.size,
        sourceEntities: [...entry.sourceEntities].sort(),
        characterIds: [...entry.characterIds].sort()
    })).sort((left, right) => (
        left.status.localeCompare(right.status)
        || right.consumerGroups - left.consumerGroups
        || left.key.localeCompare(right.key)
    ));
    const groupsFor = status => entries
        .filter(entry => entry.status === status)
        .reduce((sum, entry) => sum + entry.consumerGroups, 0);
    const countBy = key => stableObject(Object.fromEntries(
        [...new Set(entries.flatMap(entry => Object.keys(entry[key])))].map(name => [
            name,
            entries.reduce((sum, entry) => sum + (entry[key][name] ?? 0), 0)
        ])
    ));

    return {
        schemaVersion: 1,
        scope: [
            'BuffData.abilityEventAction',
            'SkillData.actionGroupData.passiveEventActions',
            'EventListenerAction.abilityActionMap'
        ],
        summary: {
            eventKeys: entries.length,
            consumerGroups: entries.reduce((sum, entry) => sum + entry.consumerGroups, 0),
            completeEventTypes: entries.filter(entry => entry.status === 'complete').length,
            completeConsumerGroups: groupsFor('complete'),
            missingEmitterEventTypes: entries.filter(entry =>
                entry.status === 'emitter-required'
            ).length,
            missingEmitterConsumerGroups: groupsFor('emitter-required'),
            invalidEventValues: entries.filter(entry => entry.status === 'invalid-type').length,
            invalidConsumerGroups: groupsFor('invalid-type'),
            byDataset: countBy('byDataset'),
            byChannel: countBy('byChannel')
        },
        events: entries
    };
}

function writeAudit(projectRoot = defaultProjectRoot) {
    const output = path.join(projectRoot, 'derived', 'cleanroom', 'ake-ability-event-audit.json');
    mkdirSync(path.dirname(output), { recursive: true });
    const audit = buildAkeAbilityEventAudit({ projectRoot });
    writeFileSync(output, `${JSON.stringify(audit, null, 2)}\n`);
    return { output: path.relative(projectRoot, output), summary: audit.summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    console.log(JSON.stringify(writeAudit(), null, 2));
}
