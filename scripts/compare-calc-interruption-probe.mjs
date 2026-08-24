#!/usr/bin/env node

import fs from 'node:fs';

import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';

const oracle = JSON.parse(fs.readFileSync(new URL(
    '../fixtures/calc/ake-interruption-probe.oracle.json',
    import.meta.url
), 'utf8'));
const requestedGroup = process.argv
    .find(argument => argument.startsWith('--group='))
    ?.slice('--group='.length) ?? 'all';
const requestedCase = process.argv
    .find(argument => argument.startsWith('--case='))
    ?.slice('--case='.length) ?? null;

function close(left, right, epsilon = 1e-10) {
    return Math.abs(Number(left) - Number(right)) <= epsilon;
}

function commandExecutionsFromCalc(observation) {
    return observation.commandTrace
        .filter(entry => entry.$type === 'CommandExecutedTrace' && entry.success)
        .map(entry => ({
            frame: entry.frame,
            commandType: entry.commandType,
            skillId: entry.skillId
        }));
}

function commandExecutionsFromLocal(result) {
    return result.commandTrace
        .filter(entry => entry.type === 'CommandExecuted' && entry.success)
        .map(entry => ({
            frame: entry.frame,
            commandType: entry.commandType,
            skillId: entry.skillId
        }));
}

function packetsFromLocal(result) {
    return result.damageLog
        .filter(entry => entry.damageAttributeType === 'Hp')
        .map(entry => ({
            frame: entry.frame,
            skillId: entry.skillId,
            damageType: entry.damageType,
            rawDamage: entry.rawDamage,
            finalDamage: entry.finalDamage
        }));
}

function packetsExact(local, calc) {
    return local.length === calc.length && local.every((entry, index) => {
        const expected = calc[index];
        return entry.frame === expected.frame
            && entry.skillId === expected.skillId
            && entry.damageType === expected.damageType
            && close(entry.rawDamage, expected.rawDamage)
            && close(entry.finalDamage, expected.finalDamage);
    });
}

const bundle = new AkeScenarioAssembler().assemble({
    characterId: oracle.characterId,
    weaponId: 'wpn_pistol_0001',
    enemyId: 'eny_0007_mimicw'
});
const selected = oracle.observations.filter(observation =>
    (requestedGroup === 'all' || observation.group === requestedGroup)
    && (requestedCase === null || observation.id === requestedCase)
);
if (selected.length === 0) {
    throw new Error(`No observation matched group=${requestedGroup} case=${requestedCase ?? '*'}.`);
}

const comparisons = selected.map(observation => {
    const result = new AkeScenarioRunner(bundle).run({
        commands: observation.commands,
        endFrame: observation.durationTicks
    });
    const calcCommands = commandExecutionsFromCalc(observation);
    const localCommands = commandExecutionsFromLocal(result);
    const localPackets = packetsFromLocal(result);
    const commandFramesExact = JSON.stringify(localCommands) === JSON.stringify(calcCommands);
    const damagePacketsExact = packetsExact(localPackets, observation.damageLog);
    const totalExact = close(result.damageSummary.totalDamage, observation.totalDamage);
    return {
        group: observation.group,
        id: observation.id,
        result: commandFramesExact && damagePacketsExact && totalExact ? 'PASS' : 'DIFF',
        commandFramesExact,
        damagePacketsExact,
        totalExact,
        calcCommands: calcCommands.map(entry => `${entry.commandType}@${entry.frame}`).join(','),
        localCommands: localCommands.map(entry => `${entry.commandType}@${entry.frame}`).join(','),
        calcPackets: observation.damageLog.length,
        localPackets: localPackets.length,
        calcTotal: observation.totalDamage,
        localTotal: result.damageSummary.totalDamage
    };
});

console.table(comparisons);
const groupSummary = [...new Set(comparisons.map(entry => entry.group))].map(group => {
    const entries = comparisons.filter(entry => entry.group === group);
    return {
        group,
        pass: entries.filter(entry => entry.result === 'PASS').length,
        total: entries.length,
        commandExact: entries.filter(entry => entry.commandFramesExact).length,
        packetExact: entries.filter(entry => entry.damagePacketsExact).length
    };
});
console.table(groupSummary);
if (comparisons.some(entry => entry.result !== 'PASS')) process.exitCode = 1;
