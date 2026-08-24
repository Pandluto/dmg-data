#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'calc');
const baseRequestPath = path.join(
    fixtureRoot,
    'ake-cross-character-wulfgard.request.json'
);
const metadataPath = path.join(
    projectRoot,
    'reference', 'public-data', 'calc', 'api', 'metadata.json'
);
const oraclePath = path.join(fixtureRoot, 'ake-interruption-probe.oracle.json');
const manifestPath = path.join(fixtureRoot, 'ake-interruption-probe.manifest.json');
const apiUrl = 'https://calc.perlica.tech/api/simulations';
const capture = process.argv.includes('--capture');
const requestedGroup = process.argv
    .find(argument => argument.startsWith('--group='))
    ?.slice('--group='.length) ?? 'all';
const requestedCase = process.argv
    .find(argument => argument.startsWith('--case='))
    ?.slice('--case='.length) ?? null;

const NORMAL_SKILL = 'chr_0006_wolfgd_normal_skill';
const ULTIMATE_SKILL = 'chr_0006_wolfgd_ultimate_skill';
const BURNING_BUFF = 'buff_common_burning_status';

function command(frame, commandType) {
    return { uuid: 'wulfgard', frame, commandType };
}

function caseDefinition(group, id, commands) {
    return Object.freeze({ group, id, commands: Object.freeze(commands) });
}

const boundaryFrames = [5, 6, 7, 15, 16, 17, 22, 23, 24, 140, 141, 142, 143];
const cases = [
    caseDefinition('boundary', 'normal-only', [command(0, 'NormalSkill')]),
    ...boundaryFrames.map(frame => caseDefinition(
        'boundary',
        `normal-to-ultimate-${frame}`,
        [command(0, 'NormalSkill'), command(frame, 'UltimateSkill')]
    )),
    ...['Attack', 'NormalSkill', 'ComboSkill', 'UltimateSkill'].map(commandType =>
        caseDefinition(
            'admission',
            `normal-to-${commandType.toLowerCase()}-30`,
            [command(0, 'NormalSkill'), command(30, commandType)]
        )),
    ...[17, 18, 19, 47, 48, 49].map(frame => caseDefinition(
        'admission',
        `normal-to-attack-${frame}`,
        [command(0, 'NormalSkill'), command(frame, 'Attack')]
    )),
    caseDefinition('lifetime', 'ultimate-only', [command(0, 'UltimateSkill')]),
    ...[46, 47, 48, 75, 76, 77, 167, 168, 169].map(frame => caseDefinition(
        'lifetime',
        `ultimate-to-normal-${frame}`,
        [command(0, 'UltimateSkill'), command(frame, 'NormalSkill')]
    )),
    ...[47, 76, 77].map(frame => caseDefinition(
        'lifetime',
        `ultimate-to-attack-${frame}`,
        [command(0, 'UltimateSkill'), command(frame, 'Attack')]
    )),
    ...[5, 6, 7, 12, 13, 14].map(frame => caseDefinition(
        'projectile',
        `attack-to-ultimate-${frame}`,
        [command(0, 'Attack'), command(frame, 'UltimateSkill')]
    ))
];

function selectedCases() {
    const groupSelected = requestedGroup === 'all'
        ? cases
        : cases.filter(entry => entry.group === requestedGroup);
    const selected = requestedCase === null
        ? groupSelected
        : groupSelected.filter(entry => entry.id === requestedCase);
    if (selected.length === 0) {
        throw new Error(`No probe matched group=${requestedGroup} case=${requestedCase ?? '*'}.`);
    }
    return selected;
}

function readJson(absolutePath) {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function clone(value) {
    return structuredClone(value);
}

function responseData(response) {
    return response?.data ?? response;
}

async function simulate(definition, baseRequest) {
    const request = clone(baseRequest);
    request.uuid = `ake-interruption-probe-${definition.id}`;
    request.commandList = definition.commands.map(clone);
    request.combatSetting.criticalMode = 'None';
    request.combatSetting.initialAtb = 300;
    request.combatSetting.startWithFullUsp = true;
    request.combatSetting.simulatePoise = false;
    request.combatSetting.recordFullDamageEvent = true;
    request.combatSetting.recordFullBattleEvents = true;
    request.combatSetting.actionIdleExitFightFrames = 120;

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`POST ${apiUrl} failed for ${definition.id} (${response.status}): ${text.slice(0, 2000)}`);
    }
    return { request, response: responseData(JSON.parse(text)) };
}

function compactCommandTrace(entry) {
    return Object.fromEntries([
        '$type', 'frame', 'commandType', 'skillId', 'success', 'reason',
        'skillSource', 'executeFrame'
    ].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}

function compactCenterTrace(entry) {
    return Object.fromEntries([
        'frame', 'from', 'to', 'reason'
    ].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}

function compactDamage(entry) {
    return Object.fromEntries([
        'frame', 'skillId', 'damageType', 'rawDamage', 'finalDamage'
    ].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}

function compactBuffEvent(entry) {
    return Object.fromEntries([
        'frame', 'event', 'ownerId', 'targetId', 'sourceId', 'skillId',
        'skillCastId', 'outputBuffId'
    ].filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}

function normalize(definition, request, response) {
    const damageLog = (response.damageLog ?? []).map(compactDamage);
    const burningEvents = (response.timelineTrace ?? [])
        .filter(entry => entry.outputBuffId === BURNING_BUFF)
        .map(compactBuffEvent);
    const burningDamageFrames = damageLog
        .filter(entry => entry.skillId === ULTIMATE_SKILL
            && Math.abs(Number(entry.rawDamage) - 19.73232) <= 1e-8)
        .map(entry => entry.frame);
    return {
        group: definition.group,
        id: definition.id,
        commands: request.commandList.map(entry => ({
            frame: entry.frame,
            commandType: entry.commandType
        })),
        commandTrace: (response.commandTrace ?? [])
            .filter(entry => entry.$type !== 'CommandSubmittedTrace')
            .map(compactCommandTrace),
        centerStateTrace: (response.centerStateTrace ?? []).map(compactCenterTrace),
        normalSkillDamageFrames: damageLog
            .filter(entry => String(entry.skillId).startsWith(NORMAL_SKILL))
            .map(entry => entry.frame),
        ultimateSkillDamageFrames: damageLog
            .filter(entry => String(entry.skillId).startsWith(ULTIMATE_SKILL))
            .map(entry => entry.frame),
        burningDamageFrames,
        burningEvents,
        damageLog,
        totalDamage: response.damageSummary?.totalDamage ?? 0,
        durationTicks: response.durationTicks,
        interruptionVocabulary: (response.battleEventLog?.strings ?? [])
            .filter(value => [
                'INTERRUPT_CHECK', 'PRIORITY_BLOCK', 'ALLOWED_NEXT',
                'HIGHER_PRIORITY', 'OnInterruptActionSuccess'
            ].includes(value))
    };
}

function printSummary(observations) {
    console.table(observations.map(entry => ({
        group: entry.group,
        id: entry.id,
        outcomes: entry.commandTrace.map(trace =>
            `${trace.$type}:${trace.commandType}@${trace.frame}`
            + `${trace.executeFrame === undefined ? '' : `->${trace.executeFrame}`}`
            + `:${trace.success === false ? trace.reason : 'OK'}`
        ).join(' | '),
        normalHits: entry.normalSkillDamageFrames.join(','),
        ultimateHits: entry.ultimateSkillDamageFrames.join(','),
        burnTicks: entry.burningDamageFrames.join(','),
        duration: entry.durationTicks,
        totalDamage: entry.totalDamage
    })));
}

function sha256(absolutePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function writeCapture(observations) {
    const recordedAt = new Date().toISOString();
    const calcDataVersion = readJson(metadataPath).data.version;
    let mergedObservations = observations;
    if (requestedGroup !== 'all' && fs.existsSync(oraclePath)) {
        const previous = readJson(oraclePath).observations ?? [];
        const byId = new Map(previous.map(entry => [entry.id, entry]));
        observations.forEach(entry => byId.set(entry.id, entry));
        mergedObservations = cases
            .map(entry => byId.get(entry.id))
            .filter(Boolean);
    }
    const oracle = {
        schemaVersion: 1,
        source: {
            description: 'Calc public simulation black-box interruption observations',
            simulationUrl: apiUrl,
            authentication: 'none'
        },
        recordedAt,
        calcDataVersion,
        tickRate: 30,
        characterId: 'chr_0006_wolfgd',
        observations: mergedObservations
    };
    fs.writeFileSync(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`, 'utf8');
    const manifest = {
        schemaVersion: 1,
        source: oracle.source,
        recordedAt,
        calcDataVersion,
        files: [{
            path: path.relative(projectRoot, oraclePath).split(path.sep).join('/'),
            bytes: fs.statSync(oraclePath).size,
            sha256: sha256(oraclePath)
        }]
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`Oracle: ${path.relative(projectRoot, oraclePath)}\n`);
    process.stdout.write(`Manifest: ${path.relative(projectRoot, manifestPath)}\n`);
}

const baseRequest = readJson(baseRequestPath);
const observations = [];
for (const definition of selectedCases()) {
    const { request, response } = await simulate(definition, baseRequest);
    const observation = normalize(definition, request, response);
    observations.push(observation);
    process.stdout.write(`Probed ${definition.id}\n`);
}

printSummary(observations);
if (capture) writeCapture(observations);
