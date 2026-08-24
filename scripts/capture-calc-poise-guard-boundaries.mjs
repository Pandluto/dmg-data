#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const fixtureRoot = path.join(projectRoot, 'fixtures', 'calc');
const outputPath = path.join(fixtureRoot, 'poise-guard-boundaries.oracle.json');
const manifestPath = path.join(fixtureRoot, 'poise-guard-boundaries.manifest.json');
const endpoint = 'https://calc.perlica.tech/api/simulations';
const baseRequest = JSON.parse(fs.readFileSync(
    path.join(fixtureRoot, 'pelica-heavy-combo-skill.request.json'),
    'utf8'
));
const enemy = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'reference',
    'public-data',
    'calc',
    'api',
    'enemy-eny_0021_agmelee-level1.json'
), 'utf8')).data;
const calcDataVersion = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'reference',
    'public-data',
    'calc',
    'api',
    'metadata.json'
), 'utf8')).data.version;

const characters = [
    character('endminm', 'chr_0002_endminm', 'wpn_sword_0003'),
    character('endminf', 'chr_0003_endminf', 'wpn_sword_0003'),
    character('azrila', 'chr_0009_azrila', 'wpn_claym_0010'),
    character('pelica', 'chr_0004_pelica', 'wpn_funnel_0002')
];
const cases = [
    { id: 'minimum-scalar-baseline' },
    { id: 'guard-inside-hit', followFrame: 300 },
    { id: 'guard-reported-end-frame-hit', followFrame: 357 },
    { id: 'guard-expiry-event-frame-hit', followFrame: 358 },
    { id: 'first-post-guard-hit', followFrame: 359 },
    { id: 'interpolated-scalar-third-ultimate-delayed', ultimateFrames: [0, 0, 105] },
    { id: 'interpolated-scalar-second-ultimate-delayed', ultimateFrames: [0, 105, 0] },
    { id: 'outside-qualification-window', ultimateFrames: [0, 105, 210] }
];

function character(uuid, id, weaponId) {
    return {
        uuid,
        id,
        level: 1,
        potential: 0,
        attrTalentLevel: 0,
        passiveSkillLevels: [0, 0],
        normalAttackLevel: 1,
        normalSkillLevel: 1,
        comboSkillLevel: 1,
        ultimateSkillLevel: 1,
        weapon: { id: weaponId, level: 1, skillLevels: [1, 1] },
        armorEquip: null,
        gloveEquip: null,
        kit1Equip: null,
        kit2Equip: null,
        tacticalItemId: null,
        tacticalItemCount: 0
    };
}

function rapidBreakCommands(frames = [0, 0, 0]) {
    return ['endminm', 'endminf', 'azrila'].map((uuid, index) => ({
        uuid,
        frame: frames[index],
        commandType: 'UltimateSkill'
    }));
}

function compactPoiseSamples(samples) {
    let previousState = null;
    return samples.filter(sample => {
        const state = sample.slice(1).join(':');
        if (state === previousState) return false;
        previousState = state;
        return true;
    });
}

function compactGuardWindow(window) {
    return {
        startFrame: window.startFrame,
        endFrame: window.endFrame,
        durationFrames: window.durationFrames,
        poiseTakenScalar: window.poiseTakenScalar
    };
}

function compactDamage(entry) {
    return {
        frame: entry.frame,
        sourceId: entry.sourceId,
        skillId: entry.skillId,
        poiseDamage: entry.poiseDamage
    };
}

const observations = [];
for (const testCase of cases) {
    const request = structuredClone(baseRequest);
    request.uuid = `poise-guard-${testCase.id}`;
    request.squad = characters;
    request.enemy = {
        uuid: 'eny_0021_agmelee',
        id: 'eny_0021_agmelee',
        level: 1,
        attributeTable: structuredClone(enemy)
    };
    request.enemy.attributeTable['1'].rawValue = 100000;
    request.commandList = rapidBreakCommands(testCase.ultimateFrames);
    if (testCase.followFrame !== undefined) {
        request.commandList.push({
            uuid: 'pelica',
            frame: testCase.followFrame,
            commandType: 'NormalSkill'
        });
    }
    request.combatSetting.simulatePoise = true;
    request.combatSetting.startWithFullUsp = true;
    request.combatSetting.initialAtb = 300;
    request.combatSetting.recordFullDamageEvent = false;
    request.combatSetting.recordFullBattleEvents = true;
    request.combatSetting.actionIdleExitFightFrames = 300;

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
    const response = JSON.parse(responseText).data;
    observations.push({
        id: testCase.id,
        commands: request.commandList,
        poiseDamageLog: response.damageLog
            .filter(entry => Number(entry.poiseDamage) > 0)
            .map(compactDamage),
        enemyPoise: {
            samples: compactPoiseSamples(response.enemyPoise.samples),
            guardWindows: response.enemyPoise.guardWindows.map(compactGuardWindow)
        },
        poiseGuardTrace: response.buffStackingGroupTrace
            .filter(trace => trace.buffId === 'buff_common_poise_guard')
            .map(trace => ({
                frame: trace.frame,
                stage: trace.stage,
                buffId: trace.buffId,
                durationTicks: trace.durationTicks
            })),
        durationTicks: response.durationTicks
    });
    process.stdout.write(`Captured ${testCase.id}\n`);
}

const output = {
    schemaVersion: 1,
    source: {
        description: 'Current Calc public simulation endpoint poise-guard boundary observations',
        url: endpoint,
        method: 'POST',
        authentication: 'none',
        enemyId: 'eny_0021_agmelee',
        enemySignature: {
            maxPoise: 60,
            poiseRecTime: 6,
            executionDamageScalar: 1,
            breakingAttackedAtbObtain: 25
        },
        participants: characters.map(entry => ({
            uuid: entry.uuid,
            id: entry.id,
            defaultWeaponId: entry.weapon.id
        }))
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
