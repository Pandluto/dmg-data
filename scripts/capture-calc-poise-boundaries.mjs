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
const akeEnemyAttributePath = path.join(
    projectRoot,
    'reference',
    'public-data',
    'akedata',
    'TableCfg',
    'EnemyAttributeTemplateTable.json'
);
const outputPath = path.join(fixtureRoot, 'pelica-poise-boundaries.oracle.json');
const manifestPath = path.join(fixtureRoot, 'pelica-poise-boundaries.manifest.json');
const endpoint = 'https://calc.perlica.tech/api/simulations';

const attackChain = [
    command(0, 'Attack'),
    command(15, 'Attack'),
    command(30, 'Attack'),
    command(45, 'Attack')
];
const shiftedAttackChain = firstFrame => [0, 15, 30, 45].map(offset =>
    command(firstFrame + offset, 'Attack'));
const preBreak65 = [
    ...attackChain,
    command(90, 'ComboSkill'),
    command(120, 'NormalSkill'),
    command(150, 'UltimateSkill'),
    command(280, 'NormalSkill')
];
const exact80 = [
    ...preBreak65,
    ...shiftedAttackChain(340)
];

const cases = [
    poiseCase('simulation-disabled', attackChain, {
        simulatePoise: false
    }),
    poiseCase('below-threshold-rejects-execution', [
        ...preBreak65,
        command(340, 'BreakingAttack')
    ], {
        enemyId: 'eny_0121_klbud'
    }),
    poiseCase('exact-threshold-breaks', exact80, {
        enemyId: 'eny_0121_klbud'
    }),
    poiseCase('overflow-threshold-breaks', preBreak65, {
        enemyId: 'eny_0021_agmelee'
    }),
    poiseCase('broken-target-damage-scale', [
        ...exact80,
        command(450, 'NormalSkill')
    ], { enemyId: 'eny_0121_klbud' }),
    poiseCase('execution-consumes-gate-and-refunds-atb', [
        ...exact80,
        command(450, 'BreakingAttack')
    ], { enemyId: 'eny_0121_klbud' }),
    poiseCase('execution-gate-is-single-use', [
        ...exact80,
        command(450, 'BreakingAttack'),
        command(590, 'BreakingAttack')
    ], { enemyId: 'eny_0121_klbud' }),
    poiseCase('poise-recovers-after-template-duration', exact80, {
        enemyId: 'eny_0121_klbud',
        actionIdleExitFightFrames: 500
    }),
    poiseCase('half-knot-applies-mini-break', exact80, {
        enemyId: 'eny_0018_lbtough_001',
        actionIdleExitFightFrames: 300
    })
];

const relevantPoiseBuffs = new Set([
    'buff_common_mini_poise_break',
    'buff_common_poise_break_damage_taken_scale',
    'buff_common_poise_can_be_breaking_attacked',
    'buff_common_recoverpoise'
]);
const relevantPoiseEvents = new Set([
    'OnBeforeOutputPoiseDamage',
    'OnBeforeTakePoiseDamage',
    'OnOutputPoiseDamage',
    'OnTakePoiseDamage',
    'OnPoiseZero',
    'OnPoiseRecover'
]);

function command(frame, commandType) {
    return { uuid: 'pelica', frame, commandType };
}

function poiseCase(id, commands, options = {}) {
    return { id, commands, ...options };
}

function compact(source, keys) {
    return Object.fromEntries(keys
        .filter(key => source?.[key] !== undefined)
        .map(key => [key, source[key]]));
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

function decodeBattleEvents(battleEventLog) {
    const { events = [], strings = [] } = battleEventLog ?? {};
    return events.flatMap(event => {
        const eventName = strings[Number(event[9])];
        if (!relevantPoiseEvents.has(eventName)) return [];
        return [{
            eventId: Number(event[0]),
            frame: Number(event[1]),
            eventName,
            sourceServerId: Number(event[4]),
            targetServerId: Number(event[5]),
            skillId: strings[Number(event[8])] || null,
            payload: event.slice(10)
        }];
    });
}

function decodeResourceEvents(battleEventLog) {
    const { events = [], strings = [] } = battleEventLog ?? {};
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
        })
        .filter(event => event.kind !== 'PassiveRecovery' || event.frame >= 80);
}

function normalizeCase(testCase, response) {
    const enemyId = testCase.enemyId ?? 'eny_0007_mimicw';
    const mechanics = enemyMechanics(enemyId);
    return {
        id: testCase.id,
        enemy: {
            id: enemyId,
            maxHp: 100000,
            ...mechanics
        },
        combatSetting: {
            simulatePoise: testCase.simulatePoise ?? true,
            initialAtb: testCase.initialAtb ?? 300
        },
        commands: testCase.commands,
        commandTrace: uniqueByJson(response.commandTrace
            .filter(trace => trace.$type === 'CommandExecutedTrace')
            .map(trace => compact(trace, [
                '$type', 'frame', 'commandType', 'skillId', 'success', 'reason'
            ]))),
        damageLog: response.damageLog.map(entry => compact(entry, [
            'frame', 'skillId', 'damageType', 'damageAttributeType',
            'rawDamage', 'finalDamage', 'poiseDamage'
        ])),
        poiseBuffTrace: response.buffStackingGroupTrace
            .filter(trace => relevantPoiseBuffs.has(trace.buffId))
            .map(trace => compact(trace, [
                'frame', 'stage', 'buffId', 'ownerId', 'sourceId', 'skillId',
                'stackCount', 'previousStackCount', 'durationTicks', 'reason'
            ])),
        poiseEvents: decodeBattleEvents(response.battleEventLog),
        resourceEvents: decodeResourceEvents(response.battleEventLog),
        durationTicks: response.durationTicks
    };
}

function setRawAttribute(attributeTable, key, value) {
    if (value === null || value === undefined) return;
    if (!attributeTable[key]) throw new Error(`Enemy attribute slot ${key} is absent.`);
    attributeTable[key].rawValue = value;
}

function enemyMechanics(enemyId) {
    const raw = akeEnemyAttributes[enemyId];
    if (!raw) throw new Error(`AKE enemy template ${enemyId} is absent.`);
    const attributes = Object.fromEntries((raw.levelIndependentAttributes?.attrs ?? [])
        .map(entry => [Number(entry.attrType), Number(entry.attrValue)]));
    return {
        maxPoise: attributes[20],
        poiseRecTime: attributes[21],
        executionDamageScalar: attributes[27],
        breakingAttackedAtbObtain: raw.breakingAttackedAtbObtain,
        poiseKnotPctList: raw.poiseKnotPctList ?? [],
        poiseKnotBuffList: raw.poiseKnotBuffList ?? []
    };
}

const baseRequest = JSON.parse(fs.readFileSync(baseRequestPath, 'utf8'));
const akeEnemyAttributes = JSON.parse(fs.readFileSync(akeEnemyAttributePath, 'utf8'));
const enemySnapshotFiles = {
    eny_0018_lbtough_001: 'enemy-eny_0018_lbtough_001-level1.json',
    eny_0021_agmelee: 'enemy-eny_0021_agmelee-level1.json',
    eny_0121_klbud: 'enemy-eny_0121_klbud-level1.json'
};
const enemySnapshots = Object.fromEntries(Object.entries(enemySnapshotFiles).map(([enemyId, file]) => [
    enemyId,
    JSON.parse(fs.readFileSync(path.join(
        projectRoot,
        'reference',
        'public-data',
        'calc',
        'api',
        file
    ), 'utf8')).data
]));
const calcDataVersion = JSON.parse(fs.readFileSync(metadataPath, 'utf8')).data.version;
const observations = [];

for (const testCase of cases) {
    const request = structuredClone(baseRequest);
    request.uuid = `pelica-poise-${testCase.id}`;
    request.commandList = testCase.commands;
    request.combatSetting.simulatePoise = testCase.simulatePoise ?? true;
    request.combatSetting.initialAtb = testCase.initialAtb ?? 300;
    request.combatSetting.actionIdleExitFightFrames = testCase.actionIdleExitFightFrames ?? 180;
    request.combatSetting.recordFullDamageEvent = false;
    request.combatSetting.recordFullBattleEvents = true;

    if (testCase.enemyId) {
        request.enemy = {
            uuid: testCase.enemyId,
            id: testCase.enemyId,
            level: 1,
            attributeTable: structuredClone(enemySnapshots[testCase.enemyId])
        };
    }
    setRawAttribute(request.enemy.attributeTable, '1', 100000);

    const httpResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
        throw new Error(
            `${testCase.id} failed (${httpResponse.status}): ${responseText.slice(0, 1000)}`
        );
    }
    const parsed = JSON.parse(responseText);
    observations.push(normalizeCase(testCase, parsed.data ?? parsed));
    process.stdout.write(`Captured ${testCase.id}\n`);
}

const output = {
    schemaVersion: 1,
    source: {
        description: 'Calc public simulation endpoint black-box poise/execution observations',
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
