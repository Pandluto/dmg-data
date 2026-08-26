#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'calc');
const outputPath = path.join(fixtureRoot, 'squad-resource-boundaries.oracle.json');
const manifestPath = path.join(fixtureRoot, 'squad-resource-boundaries.manifest.json');
const endpoint = 'https://calc.perlica.tech/api/simulations';
const offline = process.argv.includes('--offline');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function command(uuid, frame, commandType) {
    return { uuid, frame, commandType };
}

function attackChain(uuid = 'pelica') {
    return [
        command(uuid, 0, 'Attack'),
        command(uuid, 15, 'Attack'),
        command(uuid, 30, 'Attack'),
        command(uuid, 45, 'Attack')
    ];
}

const pelicaBase = readJson('fixtures/calc/pelica-heavy-combo-skill.request.json');
const chenBase = readJson('fixtures/calc/ake-cross-character-chen-qianyu.request.json');
const baseMembers = {
    pelica: pelicaBase.squad[0],
    chen: chenBase.squad[0],
    aurora: {
        ...structuredClone(pelicaBase.squad[0]),
        uuid: 'aurora',
        id: 'chr_0014_aurora',
        weapon: { id: 'wpn_claym_0010', level: 1, skillLevels: [1, 1] }
    },
    liino: {
        ...structuredClone(pelicaBase.squad[0]),
        uuid: 'liino',
        id: 'chr_0035_liino',
        weapon: { id: 'wpn_lance_0009', level: 1, skillLevels: [1, 1] }
    }
};

const cases = [
    {
        id: 'shared-atb-teamwide-usp',
        initialAtb: 200,
        startWithFullUsp: false,
        commands: [
            command('pelica', 0, 'NormalSkill'),
            command('chen', 60, 'NormalSkill')
        ]
    },
    {
        id: 'shared-atb-insufficient-second-cast',
        initialAtb: 100,
        startWithFullUsp: false,
        commands: [
            command('pelica', 0, 'NormalSkill'),
            command('chen', 60, 'NormalSkill')
        ]
    },
    {
        id: 'queued-command-rechecks-resource-at-execution',
        initialAtb: 198,
        startWithFullUsp: false,
        commands: [
            command('pelica', 0, 'NormalSkill'),
            command('pelica', 1, 'NormalSkill'),
            command('chen', 180, 'Attack')
        ]
    },
    {
        id: 'same-frame-default-uuid-order',
        initialAtb: 100,
        startWithFullUsp: false,
        commands: [
            command('pelica', 0, 'NormalSkill'),
            command('chen', 0, 'NormalSkill')
        ]
    },
    {
        id: 'same-frame-renamed-uuid-order',
        initialAtb: 100,
        startWithFullUsp: false,
        memberUuids: { pelica: 'a', chen: 'z' },
        commands: [
            command('z', 0, 'NormalSkill'),
            command('a', 0, 'NormalSkill')
        ]
    },
    {
        id: 'hit-gain-passive-recovery-before-command-spend',
        initialAtb: 70,
        startWithFullUsp: false,
        commands: [
            ...attackChain(),
            command('pelica', 86, 'NormalSkill'),
            command('chen', 180, 'Attack')
        ]
    },
    {
        id: 'entity-usp-isolation',
        initialAtb: 300,
        startWithFullUsp: true,
        commands: [
            command('pelica', 0, 'UltimateSkill'),
            command('chen', 80, 'UltimateSkill')
        ]
    },
    {
        id: 'direct-usp-gain-stays-on-source',
        initialAtb: 300,
        startWithFullUsp: false,
        commands: [
            ...attackChain(),
            command('pelica', 90, 'ComboSkill'),
            command('chen', 180, 'Attack')
        ]
    },
    {
        id: 'returned-atb-reduces-teamwide-usp',
        squadKeys: ['aurora', 'pelica'],
        initialAtb: 200,
        startWithFullUsp: false,
        commands: [
            command('aurora', 0, 'NormalSkill'),
            command('pelica', 70, 'NormalSkill')
        ]
    },
    {
        id: 'returned-atb-is-consumed-first',
        squadKeys: ['aurora', 'liino'],
        initialAtb: 200,
        startWithFullUsp: false,
        commands: [
            command('aurora', 0, 'NormalSkill'),
            command('liino', 70, 'NormalSkill')
        ]
    },
    {
        id: 'ultimate-time-pauses-shared-recovery',
        squadKeys: ['pelica'],
        initialAtb: 0,
        startWithFullUsp: true,
        commands: [command('pelica', 0, 'UltimateSkill')]
    },
    {
        id: 'late-ultimate-preserves-next-recovery-tick',
        squadKeys: ['pelica'],
        initialAtb: 0,
        startWithFullUsp: true,
        commands: [command('pelica', 30, 'UltimateSkill')]
    }
];

function compact(source, keys) {
    return Object.fromEntries(keys
        .filter(key => source?.[key] !== undefined)
        .map(key => [key, source[key]]));
}

function requestFor(testCase) {
    const request = structuredClone(pelicaBase);
    const squadKeys = testCase.squadKeys ?? ['pelica', 'chen'];
    const aliases = testCase.memberUuids
        ?? Object.fromEntries(squadKeys.map(key => [key, key]));
    request.uuid = `squad-resource-${testCase.id}`;
    request.squad = squadKeys.map(key => ({
        ...structuredClone(baseMembers[key]),
        uuid: aliases[key]
    }));
    request.commandList = testCase.commands;
    request.combatSetting.initialAtb = testCase.initialAtb;
    request.combatSetting.startWithFullUsp = testCase.startWithFullUsp;
    request.combatSetting.recordFullDamageEvent = false;
    request.combatSetting.recordFullBattleEvents = true;
    return request;
}

function decodeResourceEvents(log) {
    const { events = [], strings = [] } = log ?? {};
    const modes = {
        0: 'Initialize',
        1: 'PassiveRecovery',
        2: 'Gain',
        3: 'Return',
        6: 'ReturnedAtbReplaced',
        4: 'Spend'
    };
    return events
        .filter(event => ['ATB', 'USP'].includes(strings[Number(event[9])]))
        .map(event => {
            const mode = Number(event[10]);
            const before = Number(event[14]);
            const after = Number(event[15]);
            return {
                eventId: Number(event[0]),
                frame: Number(event[1]),
                sourceId: strings[Number(event[4])] || null,
                targetId: strings[Number(event[5])] || null,
                resourceType: strings[Number(event[9])] === 'ATB' ? 'Atb' : 'UltimateSp',
                mode,
                kind: modes[mode] ?? `Unknown:${mode}`,
                requested: Number(event[11]),
                actual: after - before,
                before,
                after,
                overflow: Number(event[16])
            };
        });
}

function normalize(testCase, request, response) {
    const characters = response.snapshotCharacters ?? [];
    return {
        id: testCase.id,
        combatSetting: {
            initialAtb: testCase.initialAtb,
            startWithFullUsp: testCase.startWithFullUsp
        },
        squad: request.squad.map(member => ({ uuid: member.uuid, characterId: member.id })),
        commands: request.commandList,
        commandTrace: response.commandTrace.map(entry => compact(entry, [
            '$type', 'frame', 'commandType', 'casterCharId', 'skillId',
            'success', 'reason', 'skillSource'
        ])),
        snapshotCharacters: characters,
        snapshotColumns: [
            'frame',
            'Atb',
            'reserved',
            ...characters.map(character => `UltimateSp:${character.uuid}`),
            ...characters.map(character => `ComboSkillCooldown:${character.uuid}`)
        ],
        resourceEvents: decodeResourceEvents(response.battleEventLog),
        snapshots: response.snapshots,
        durationTicks: response.durationTicks
    };
}

let output;
if (offline) {
    output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
} else {
    const observations = [];
    for (const testCase of cases) {
        const request = requestFor(testCase);
        const httpResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request)
        });
        const responseText = await httpResponse.text();
        if (!httpResponse.ok) {
            throw new Error(`${testCase.id} failed (${httpResponse.status}): ${responseText.slice(0, 1200)}`);
        }
        const parsed = JSON.parse(responseText);
        observations.push(normalize(testCase, request, parsed.data ?? parsed));
        process.stdout.write(`Captured ${testCase.id}\n`);
    }
    output = {
        schemaVersion: 1,
        source: {
            description: 'Calc public simulation endpoint black-box squad resource observations',
            url: endpoint,
            method: 'POST',
            authentication: 'none'
        },
        recordedAt: new Date().toISOString(),
        calcDataVersion: readJson('reference/public-data/calc/api/metadata.json').data.version,
        tickRate: 30,
        cases: observations
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

const outputBytes = fs.readFileSync(outputPath);
const manifest = {
    schemaVersion: 1,
    source: output.source,
    recordedAt: output.recordedAt,
    calcDataVersion: output.calcDataVersion,
    files: [{
        path: path.relative(projectRoot, outputPath).split(path.sep).join('/'),
        bytes: outputBytes.length,
        sha256: crypto.createHash('sha256').update(outputBytes).digest('hex')
    }]
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${path.relative(projectRoot, outputPath)}\n`);
process.stdout.write(`Wrote ${path.relative(projectRoot, manifestPath)}\n`);
