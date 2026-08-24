#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const fixtureRoot = safePath(projectRoot, 'fixtures', 'calc');
const apiRoot = safePath(projectRoot, 'reference', 'public-data', 'calc', 'api');
const metadataPath = safePath(apiRoot, 'metadata.json');
const baseRequestPath = safePath(fixtureRoot, 'pelica-heavy-combo-skill.request.json');
const oraclePath = safePath(fixtureRoot, 'ake-cross-character-smoke.oracle.json');
const manifestPath = safePath(fixtureRoot, 'ake-cross-character-smoke.manifest.json');
const offline = process.argv.includes('--offline');
const apiBase = 'https://calc.perlica.tech/api';

const cases = Object.freeze([
    Object.freeze({
        key: 'chen-qianyu',
        uuid: 'chen',
        characterId: 'chr_0005_chen',
        weaponId: 'wpn_sword_0003',
        commands: Object.freeze([
            command(0, 'Attack'),
            command(10, 'Attack'),
            command(20, 'Attack'),
            command(30, 'Attack'),
            command(50, 'Attack'),
            command(100, 'NormalSkill'),
            command(260, 'UltimateSkill')
        ])
    }),
    Object.freeze({
        key: 'wulfgard',
        uuid: 'wulfgard',
        characterId: 'chr_0006_wolfgd',
        weaponId: 'wpn_pistol_0001',
        commands: Object.freeze([
            command(0, 'Attack'),
            command(10, 'Attack'),
            command(30, 'Attack'),
            command(60, 'Attack'),
            command(140, 'NormalSkill'),
            // Interrupt before the unresolved conditional JumpToAction branch.
            // A later focused oracle proves this is an element-tag-driven
            // timeline seek, not a hold/release input.
            command(250, 'UltimateSkill')
        ])
    })
]);

function command(frame, commandType) {
    return Object.freeze({ frame, commandType });
}

function safePath(root, ...parts) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, ...parts);
    const prefix = `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
        throw new Error(`Refusing path outside ${resolvedRoot}: ${resolved}`);
    }
    return resolved;
}

function readJson(absolutePath) {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function writeJson(absolutePath, value) {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureRecord(absolutePath) {
    const bytes = fs.readFileSync(absolutePath);
    return {
        path: path.relative(projectRoot, absolutePath).split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
}

function compact(source, keys) {
    return Object.fromEntries(keys
        .filter(key => source?.[key] !== undefined)
        .map(key => [key, source[key]]));
}

function panelValue(panel, attributeType) {
    const component = (panel?.data ?? panel)?.[String(attributeType)];
    if (!component) return null;
    const beforeFinal = (((Number(component.rawValue ?? 0) + Number(component.baseAddition ?? 0))
        * Number(component.baseMultiplier ?? 1)
        + Number(component.baseFinalAddition ?? 0))
        * Number(component.baseFinalMultiplier ?? 1)
        + Number(component.addition ?? 0));
    return (beforeFinal * Number(component.multiplier ?? 1)
        + Number(component.finalAddition ?? 0))
        * Number(component.finalMultiplier ?? 1);
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${options.method ?? 'GET'} ${url} failed (${response.status}): ${text.slice(0, 2000)}`);
    }
    return JSON.parse(text);
}

function characterInput(testCase) {
    return {
        uuid: testCase.uuid,
        id: testCase.characterId,
        level: 1,
        potential: 0,
        attrTalentLevel: 0,
        passiveSkillLevels: [0, 0],
        normalAttackLevel: 1,
        normalSkillLevel: 1,
        comboSkillLevel: 1,
        ultimateSkillLevel: 1,
        weapon: {
            id: testCase.weaponId,
            level: 1,
            skillLevels: [1, 1]
        },
        armorEquip: null,
        gloveEquip: null,
        kit1Equip: null,
        kit2Equip: null,
        tacticalItemId: null,
        tacticalItemCount: 0
    };
}

function buildSimulationRequest(testCase, baseRequest) {
    const request = structuredClone(baseRequest);
    request.uuid = `ake-cross-character-${testCase.key}-v1`;
    request.squad = [characterInput(testCase)];
    request.commandList = testCase.commands.map(entry => ({
        uuid: testCase.uuid,
        ...entry
    }));
    request.combatSetting.criticalMode = 'None';
    request.combatSetting.initialAtb = 300;
    request.combatSetting.startWithFullUsp = true;
    request.combatSetting.simulatePoise = false;
    request.combatSetting.recordFullDamageEvent = true;
    request.combatSetting.recordFullBattleEvents = true;
    request.combatSetting.actionIdleExitFightFrames = 120;
    return request;
}

function pathsFor(testCase) {
    return {
        character: safePath(apiRoot, `character-${testCase.characterId}.json`),
        weapon: safePath(apiRoot, `weapon-${testCase.weaponId}.json`),
        panel: safePath(apiRoot, `character-panel-${testCase.characterId}-level1.json`),
        request: safePath(fixtureRoot, `ake-cross-character-${testCase.key}.request.json`),
        response: safePath(fixtureRoot, `ake-cross-character-${testCase.key}.response.json`)
    };
}

function normalizeCase(testCase, request, response, panel) {
    const timelineBuffs = new Set([
        'buff_common_fire_fire_burning_triggered',
        'buff_common_burning_status',
        'buff_common_fire_triggered_start',
        'buff_common_fire_triggered_fx'
    ]);
    return {
        id: testCase.key,
        characterId: testCase.characterId,
        weaponId: testCase.weaponId,
        level: 1,
        panel: {
            Atk: panelValue(panel, 2),
            MaxUltimateSp: panelValue(panel, 22)
        },
        commands: request.commandList.map(entry => compact(entry, [
            'frame', 'commandType'
        ])),
        commandTrace: response.commandTrace
            .filter(entry => entry.$type === 'CommandExecutedTrace')
            .map(entry => compact(entry, [
                'frame', 'commandType', 'skillId', 'success', 'reason', 'skillSource'
            ])),
        damageLog: response.damageLog.map(entry => compact(entry, [
            'frame', 'skillId', 'damageType', 'rawDamage', 'finalDamage',
            'poiseDamage', 'damageUnitIndex', 'damageActionTrace'
        ])),
        statusTimeline: (response.timelineTrace ?? [])
            .filter(entry => timelineBuffs.has(entry.outputBuffId))
            .map(entry => compact(entry, [
                'frame', 'event', 'ownerId', 'targetId', 'sourceId',
                'skillId', 'outputBuffId'
            ])),
        damageSummary: response.damageSummary,
        durationTicks: response.durationTicks
    };
}

const baseRequest = readJson(baseRequestPath);
const calcDataVersion = readJson(metadataPath).data.version;
const observations = [];
const capturedFiles = [];

for (const testCase of cases) {
    const files = pathsFor(testCase);
    let request;
    let response;
    let panel;
    if (offline) {
        request = readJson(files.request);
        response = readJson(files.response);
        panel = readJson(files.panel);
    } else {
        request = buildSimulationRequest(testCase, baseRequest);
        const input = characterInput(testCase);
        const [character, weapon, panelResponse, simulationResponse] = await Promise.all([
            requestJson(`${apiBase}/openapi/characters/${testCase.characterId}`),
            requestJson(`${apiBase}/openapi/weapons/${testCase.weaponId}`),
            requestJson(`${apiBase}/openapi/characters/panel`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input)
            }),
            requestJson(`${apiBase}/simulations`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request)
            })
        ]);
        response = simulationResponse.data ?? simulationResponse;
        panel = panelResponse;
        writeJson(files.character, character);
        writeJson(files.weapon, weapon);
        writeJson(files.panel, panelResponse);
        writeJson(files.request, request);
        writeJson(files.response, response);
    }
    observations.push(normalizeCase(testCase, request, response, panel));
    capturedFiles.push(...Object.values(files));
    process.stdout.write(`Captured ${testCase.key}: ${response.damageLog.length} damage events\n`);
}

const oracle = {
    schemaVersion: 1,
    source: {
        description: 'Calc public OpenAPI panel and simulation black-box observations',
        simulationUrl: `${apiBase}/simulations`,
        panelUrl: `${apiBase}/openapi/characters/panel`,
        authentication: 'none'
    },
    recordedAt: new Date().toISOString(),
    calcDataVersion,
    tickRate: 30,
    enemyId: baseRequest.enemy.id,
    cases: observations
};
writeJson(oraclePath, oracle);
capturedFiles.push(oraclePath);
writeJson(manifestPath, {
    schemaVersion: 1,
    source: oracle.source,
    recordedAt: oracle.recordedAt,
    calcDataVersion,
    files: capturedFiles.map(fixtureRecord)
});

process.stdout.write(`Oracle: ${path.relative(projectRoot, oraclePath)}\n`);
process.stdout.write(`Manifest: ${path.relative(projectRoot, manifestPath)}\n`);
