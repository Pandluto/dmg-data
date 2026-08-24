#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const fixtureRoot = safePath(projectRoot, 'fixtures', 'calc');
const requestPath = safePath(fixtureRoot, 'pelica-heavy-combo-skill.request.json');
const responsePath = safePath(fixtureRoot, 'pelica-heavy-combo-skill.response.json');
const oraclePath = safePath(fixtureRoot, 'pelica-heavy-combo-skill.oracle.json');
const manifestPath = safePath(fixtureRoot, 'pelica-heavy-combo-skill.manifest.json');
const offline = process.argv.includes('--offline');

function safePath(root, ...parts) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, ...parts);
    const prefix = `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
        throw new Error(`Refusing path outside ${resolvedRoot}: ${resolved}`);
    }
    return resolved;
}

function projectPath(...parts) {
    return safePath(projectRoot, ...parts);
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

function compactDefined(source, keys) {
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

function buildRequest(enemyAttributeTable) {
    return {
        uuid: 'pelica-heavy-combo-skill-level1-v1',
        enemy: {
            uuid: 'eny_0007_mimicw',
            id: 'eny_0007_mimicw',
            level: 1,
            attributeTable: enemyAttributeTable
        },
        squad: [{
            uuid: 'pelica',
            id: 'chr_0004_pelica',
            level: 1,
            potential: 0,
            attrTalentLevel: 0,
            passiveSkillLevels: [0, 0],
            normalAttackLevel: 1,
            normalSkillLevel: 1,
            comboSkillLevel: 1,
            ultimateSkillLevel: 1,
            weapon: {
                id: 'wpn_funnel_0002',
                level: 1,
                skillLevels: [1, 1]
            },
            armorEquip: null,
            gloveEquip: null,
            kit1Equip: null,
            kit2Equip: null,
            tacticalItemId: null,
            tacticalItemCount: 0
        }],
        commandList: [
            { uuid: 'pelica', frame: 0, commandType: 'Attack' },
            { uuid: 'pelica', frame: 15, commandType: 'Attack' },
            { uuid: 'pelica', frame: 30, commandType: 'Attack' },
            { uuid: 'pelica', frame: 45, commandType: 'Attack' },
            { uuid: 'pelica', frame: 90, commandType: 'ComboSkill' },
            { uuid: 'pelica', frame: 120, commandType: 'NormalSkill' }
        ],
        preuseItemSpec: [],
        contingencyContractTagIds: [],
        combatSetting: {
            criticalMode: 'None',
            initialAtb: 300,
            startWithFullUsp: true,
            simulatePoise: false,
            recordFullDamageEvent: true,
            recordFullBattleEvents: true,
            actionIdleExitFightFrames: 120
        }
    };
}

function normalizeOracle(request, response, calcDataVersion) {
    const commandTraceKeys = [
        '$type', 'frame', 'commandType', 'skillId', 'success', 'reason',
        'priority', 'queueWindowFrames', 'targetEntityId', 'targetSource', 'skillSource'
    ];
    const comboTraceKeys = [
        'frame', 'stage', 'skillId', 'currentSkillId', 'currentPriority',
        'newPriority', 'allowedNext', 'result', 'reason', 'expiresAt', 'cooldownEndFrame'
    ];
    const centerStateKeys = ['frame', '$type', 'from', 'to', 'reason', 'skillId'];
    const damageKeys = [
        'frame', 'sourceId', 'sourceUuid', 'targetId', 'targetUuid', 'skillId',
        'damageType', 'rawDamage', 'finalDamage', 'poiseDamage', 'isCritical',
        'nonCriticalDamage', 'criticalDamage', 'expectedDamage', 'targetHpBefore',
        'targetHpAfter', 'damageUnitIndex', 'damageActionHash', 'damageActionTrace'
    ];
    const relevantComboStages = new Set([
        'PENDING_CREATED', 'COMMAND_GATE', 'PENDING_CONSUMED', 'PENDING_EXPIRED',
        'COOLDOWN_STARTED', 'COOLDOWN_BLOCKED'
    ]);

    return {
        schemaVersion: 1,
        source: 'Calc public POST /api/simulations black-box observation',
        calcDataVersion,
        tickRate: 30,
        scenario: {
            characterId: request.squad[0].id,
            characterLevel: request.squad[0].level,
            weaponId: request.squad[0].weapon.id,
            weaponLevel: request.squad[0].weapon.level,
            enemyId: request.enemy.id,
            enemyLevel: request.enemy.level,
            criticalMode: request.combatSetting.criticalMode,
            commands: request.commandList
        },
        commandTrace: response.commandTrace.map(trace => compactDefined(trace, commandTraceKeys)),
        comboSkillTrace: uniqueByJson(response.comboSkillTrace
            .filter(trace => relevantComboStages.has(trace.stage))
            .map(trace => compactDefined(trace, comboTraceKeys))),
        centerStateTrace: uniqueByJson(response.centerStateTrace
            .map(trace => compactDefined(trace, centerStateKeys))),
        damageLog: response.damageLog.map(entry => compactDefined(entry, damageKeys)),
        damageSummary: response.damageSummary,
        durationTicks: response.durationTicks
    };
}

const enemySnapshot = readJson(projectPath(
    'reference', 'public-data', 'calc', 'api', 'enemy-eny_0007_mimicw-level1.json'
));
const metadataSnapshot = readJson(projectPath(
    'reference', 'public-data', 'calc', 'api', 'metadata.json'
));
const request = buildRequest(enemySnapshot.data);
let response;

if (offline) {
    response = readJson(responsePath);
} else {
    const httpResponse = await fetch('https://calc.perlica.tech/api/simulations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
    });
    const responseText = await httpResponse.text();
    if (!httpResponse.ok) {
        throw new Error(`Calc simulation failed (${httpResponse.status}): ${responseText.slice(0, 2000)}`);
    }
    response = JSON.parse(responseText);
    response = response.data ?? response;
    writeJson(requestPath, request);
    writeJson(responsePath, response);
}

const oracle = normalizeOracle(request, response, metadataSnapshot.data.version);
writeJson(oraclePath, oracle);
writeJson(manifestPath, {
    schemaVersion: 1,
    source: {
        url: 'https://calc.perlica.tech/api/simulations',
        method: 'POST',
        authentication: 'none'
    },
    calcDataVersion: metadataSnapshot.data.version,
    responseRecordedAt: fs.statSync(responsePath).mtime.toISOString(),
    files: [requestPath, responsePath, oraclePath].map(fixtureRecord)
});

process.stdout.write(`Calc baseline: ${oracle.damageLog.length} damage events, total ${oracle.damageSummary.totalDamage}\n`);
process.stdout.write(`Request: ${path.relative(projectRoot, requestPath)}\n`);
process.stdout.write(`Response: ${path.relative(projectRoot, responsePath)}\n`);
process.stdout.write(`Oracle: ${path.relative(projectRoot, oraclePath)}\n`);
process.stdout.write(`Manifest: ${path.relative(projectRoot, manifestPath)}\n`);
