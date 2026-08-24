#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const oracle = JSON.parse(fs.readFileSync(path.join(
    projectRoot,
    'fixtures',
    'calc',
    'ake-cross-character-smoke.oracle.json'
), 'utf8'));

function equalNumber(actual, expected, epsilon = 1e-10) {
    return Math.abs(actual - expected) <= epsilon;
}

function sameArray(left, right) {
    return left.length === right.length
        && left.every((value, index) => value === right[index]);
}

let failed = false;
const report = [];

for (const testCase of oracle.cases) {
    const bundle = new AkeScenarioAssembler({ projectRoot }).assemble({
        characterId: testCase.characterId,
        weaponId: testCase.weaponId,
        enemyId: oracle.enemyId
    });
    const result = new AkeScenarioRunner(bundle).run({
        commands: testCase.commands,
        endFrame: testCase.durationTicks
    });
    const commands = result.commandTrace.filter(entry =>
        entry.type === 'CommandExecuted' && entry.success
    );
    const hits = result.damageLog.filter(entry => entry.damageAttributeType === 'Hp');
    const commandFramesExact = sameArray(
        commands.map(entry => entry.frame),
        testCase.commandTrace.map(entry => entry.frame)
    );
    const hitFramesExact = sameArray(
        hits.map(entry => entry.frame),
        testCase.damageLog.map(entry => entry.frame)
    );
    const damagePacketsExact = hits.length === testCase.damageLog.length
        && hits.every((hit, index) => {
            const expected = testCase.damageLog[index];
            return hit.skillId === expected.skillId
                && hit.damageType === expected.damageType
                && equalNumber(hit.rawDamage, expected.rawDamage)
                && equalNumber(hit.finalDamage, expected.finalDamage);
        });
    const totalExact = equalNumber(
        result.damageSummary.totalDamage,
        testCase.damageSummary.totalDamage
    );
    const passed = commandFramesExact && hitFramesExact
        && damagePacketsExact && totalExact;
    failed ||= !passed;
    report.push({
        id: testCase.id,
        characterId: testCase.characterId,
        result: passed ? 'PASS' : 'FAIL',
        commands: `${commands.length}/${testCase.commandTrace.length}`,
        damagePackets: `${hits.length}/${testCase.damageLog.length}`,
        commandFramesExact,
        hitFramesExact,
        damagePacketsExact,
        localTotalDamage: result.damageSummary.totalDamage,
        calcTotalDamage: testCase.damageSummary.totalDamage,
        totalExact
    });
}

console.table(report);
if (failed) process.exitCode = 1;
