#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const baseRequestPath = path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-heavy-combo-skill.request.json'
);
const metadataPath = path.join(
    projectRoot,
    'reference',
    'public-data',
    'calc',
    'api',
    'metadata.json'
);
const outputPath = path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-combo-boundaries.oracle.json'
);
const manifestPath = path.join(
    projectRoot,
    'fixtures',
    'calc',
    'pelica-combo-boundaries.manifest.json'
);
const endpoint = 'https://calc.perlica.tech/api/simulations';

const attackChain = [
    { uuid: 'pelica', frame: 0, commandType: 'Attack' },
    { uuid: 'pelica', frame: 15, commandType: 'Attack' },
    { uuid: 'pelica', frame: 30, commandType: 'Attack' },
    { uuid: 'pelica', frame: 45, commandType: 'Attack' }
];

const cases = [
    { id: 'before-hit', commands: [...attackChain, combo(85)] },
    { id: 'same-frame-as-hit', commands: [...attackChain, combo(86)] },
    { id: 'first-frame-after-hit', commands: [...attackChain, combo(87)] },
    { id: 'expiry-minus-one', commands: [...attackChain, combo(264)] },
    { id: 'reported-expiry-frame', commands: [...attackChain, combo(265)] },
    { id: 'after-expiry', commands: [...attackChain, combo(266)] },
    {
        id: 'second-trigger-while-pending',
        commands: [
            ...attackChain,
            ...shiftedAttackChain(140),
            combo(270)
        ]
    },
    {
        id: 'two-pending-consume-selection',
        commands: [
            ...attackChain,
            ...shiftedAttackChain(140),
            combo(230)
        ]
    },
    {
        id: 'second-trigger-during-cooldown',
        commands: [
            ...attackChain,
            combo(90),
            ...shiftedAttackChain(210),
            combo(310)
        ]
    }
];

function combo(frame) {
    return { uuid: 'pelica', frame, commandType: 'ComboSkill' };
}

function shiftedAttackChain(firstFrame) {
    return [0, 15, 30, 45].map(offset => ({
        uuid: 'pelica',
        frame: firstFrame + offset,
        commandType: 'Attack'
    }));
}

function uniqueByJson(values) {
    const seen = new Set();
    return values.filter(value => {
        const key = JSON.stringify(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function compact(source, keys) {
    return Object.fromEntries(keys
        .filter(key => source?.[key] !== undefined)
        .map(key => [key, source[key]]));
}

function normalizeCase(testCase, response) {
    const comboStages = new Set([
        'PENDING_CREATED',
        'COMMAND_GATE',
        'PENDING_CONSUMED',
        'PENDING_EXPIRED',
        'COOLDOWN_STARTED',
        'COOLDOWN_BLOCKED'
    ]);
    const commandKeys = [
        '$type', 'frame', 'commandType', 'skillId', 'success', 'reason',
        'targetEntityId', 'targetSource', 'skillSource'
    ];
    const comboKeys = [
        'frame', 'stage', 'skillId', 'currentSkillId', 'currentPriority',
        'result', 'reason', 'pendingRemainingFrames', 'pendingCanCast',
        'expiresAt', 'cooldownEndFrame', 'targetId', 'targetUuid',
        'triggerId', 'triggerUuid'
    ];

    return {
        id: testCase.id,
        commands: testCase.commands,
        commandTrace: uniqueByJson(response.commandTrace
            .filter(trace => trace.$type === 'CommandExecutedTrace')
            .map(trace => compact(trace, commandKeys))),
        comboSkillTrace: uniqueByJson(response.comboSkillTrace
            .filter(trace => comboStages.has(trace.stage))
            .map(trace => compact(trace, comboKeys))),
        damageLog: response.damageLog.map(entry => compact(entry, [
            'frame', 'skillId', 'damageType', 'finalDamage'
        ])),
        durationTicks: response.durationTicks
    };
}

const baseRequest = JSON.parse(fs.readFileSync(baseRequestPath, 'utf8'));
const calcDataVersion = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).data.version;
const observations = [];

for (const testCase of cases) {
    const request = structuredClone(baseRequest);
    request.uuid = `pelica-combo-boundary-${testCase.id}`;
    request.commandList = testCase.commands;
    request.combatSetting.recordFullDamageEvent = false;
    request.combatSetting.recordFullBattleEvents = false;

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
        description: 'Calc public simulation endpoint black-box boundary observations',
        url: endpoint,
        method: 'POST',
        authentication: 'none'
    },
    recordedAt: new Date().toISOString(),
    calcDataVersion,
    tickRate: 30,
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
