#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'calc');
const baseRequestPath = path.join(fixtureRoot, 'pelica-heavy-combo-skill.request.json');
const metadataPath = path.join(
    projectRoot,
    'reference',
    'public-data',
    'calc',
    'api',
    'metadata.json'
);
const outputPath = path.join(fixtureRoot, 'pelica-resource-boundaries.oracle.json');
const manifestPath = path.join(fixtureRoot, 'pelica-resource-boundaries.manifest.json');
const endpoint = 'https://calc.perlica.tech/api/simulations';

const attackChain = [
    command(0, 'Attack'),
    command(15, 'Attack'),
    command(30, 'Attack'),
    command(45, 'Attack')
];
const baselineCommands = [
    ...attackChain,
    command(90, 'ComboSkill'),
    command(120, 'NormalSkill')
];
const cases = [
    resourceCase('baseline-full-resources', baselineCommands, 300, true),
    resourceCase('baseline-empty-usp', baselineCommands, 300, false),
    resourceCase('idle-recovery-from-zero', [command(0, 'Attack')], 0, false),
    resourceCase('attack4-gain-uncapped', attackChain, 0, false),
    resourceCase('near-atb-cap', [command(0, 'Attack')], 299.9, false),
    resourceCase('normal-skill-from-full-atb', [command(0, 'NormalSkill')], 300, false),
    resourceCase('normal-skill-from-exact-cost', [command(0, 'NormalSkill')], 100, false),
    resourceCase('second-normal-skill-resets-delay', [
        command(0, 'NormalSkill'),
        command(160, 'NormalSkill')
    ], 300, false),
    resourceCase('ultimate-from-full-usp', [command(0, 'UltimateSkill')], 300, true),
    resourceCase('ultimate-from-empty-usp', [command(0, 'UltimateSkill')], 300, false)
];

function command(frame, commandType) {
    return { uuid: 'pelica', frame, commandType };
}

function resourceCase(id, commands, initialAtb, startWithFullUsp) {
    return { id, commands, initialAtb, startWithFullUsp };
}

function compact(source, keys) {
    return Object.fromEntries(keys
        .filter(key => source?.[key] !== undefined)
        .map(key => [key, source[key]]));
}

function decodeResourceEvents(battleEventLog) {
    const { events, strings } = battleEventLog;
    const modeNames = {
        0: 'Initialize',
        1: 'PassiveRecovery',
        2: 'Gain',
        4: 'Spend'
    };
    return events
        .filter(event => ['ATB', 'USP'].includes(strings[Number(event[9])]))
        .map(event => {
            const mode = Number(event[10]);
            const before = Number(event[14]);
            const after = Number(event[15]);
            const requestedMagnitude = Number(event[11]);
            return {
                eventId: Number(event[0]),
                frame: Number(event[1]),
                resourceType: strings[Number(event[9])] === 'ATB' ? 'Atb' : 'UltimateSp',
                mode,
                kind: modeNames[mode] ?? `Unknown:${mode}`,
                requestedDelta: mode === 4 ? -requestedMagnitude : requestedMagnitude,
                actualDelta: after - before,
                baseValue: Number(event[13]),
                before,
                after,
                overflow: Number(event[16])
            };
        });
}

function normalizeCase(testCase, response) {
    return {
        id: testCase.id,
        combatSetting: {
            initialAtb: testCase.initialAtb,
            startWithFullUsp: testCase.startWithFullUsp
        },
        commands: testCase.commands,
        commandTrace: response.commandTrace
            .filter(trace => trace.$type === 'CommandExecutedTrace')
            .map(trace => compact(trace, [
                '$type', 'frame', 'commandType', 'skillId', 'success', 'reason'
            ])),
        resourceEvents: decodeResourceEvents(response.battleEventLog),
        snapshots: response.snapshots,
        damageLog: response.damageLog.map(entry => compact(entry, [
            'frame', 'skillId', 'damageType', 'rawDamage', 'finalDamage'
        ])),
        durationTicks: response.durationTicks
    };
}

const baseRequest = JSON.parse(fs.readFileSync(baseRequestPath, 'utf8'));
const calcDataVersion = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).data.version;
const observations = [];

for (const testCase of cases) {
    const request = structuredClone(baseRequest);
    request.uuid = `pelica-resource-${testCase.id}`;
    request.commandList = testCase.commands;
    request.combatSetting.initialAtb = testCase.initialAtb;
    request.combatSetting.startWithFullUsp = testCase.startWithFullUsp;
    request.combatSetting.recordFullDamageEvent = false;
    request.combatSetting.recordFullBattleEvents = true;

    const httpResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
        throw new Error(`${testCase.id} failed (${httpResponse.status}): ${responseText.slice(0, 1000)}`);
    }
    const parsed = JSON.parse(responseText);
    observations.push(normalizeCase(testCase, parsed.data ?? parsed));
    process.stdout.write(`Captured ${testCase.id}\n`);
}

const output = {
    schemaVersion: 1,
    source: {
        description: 'Calc public simulation endpoint black-box resource observations',
        url: endpoint,
        method: 'POST',
        authentication: 'none'
    },
    recordedAt: new Date().toISOString(),
    calcDataVersion,
    tickRate: 30,
    snapshotColumns: ['frame', 'Atb', 'reserved', 'UltimateSp', 'ComboSkillCooldown'],
    cases: observations
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const outputBytes = fs.readFileSync(outputPath);
fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    source: output.source,
    recordedAt: output.recordedAt,
    calcDataVersion,
    files: [{
        path: path.relative(projectRoot, outputPath).split(path.sep).join('/'),
        bytes: outputBytes.length,
        sha256: crypto.createHash('sha256').update(outputBytes).digest('hex')
    }]
}, null, 2)}\n`, 'utf8');

process.stdout.write(`Wrote ${path.relative(projectRoot, outputPath)}\n`);
process.stdout.write(`Wrote ${path.relative(projectRoot, manifestPath)}\n`);
