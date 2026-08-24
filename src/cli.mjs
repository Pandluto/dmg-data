#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { simulateScenario } from './core/simulator.mjs';
import { buildPelicaScenarioModel } from './scenarios/pelica.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const scenarioName = args.find(argument => !argument.startsWith('--')) ?? 'pelica';
const jsonOnly = args.includes('--json');
const noWrite = args.includes('--no-write');

const scenarioOptions = scenarioName === 'pelica'
    ? {}
    : scenarioName === 'pelica-poise'
        ? {
            enemyId: 'eny_0121_klbud',
            enemyMaxHp: 100000,
            commands: [
                { frame: 0, commandType: 'Attack' },
                { frame: 15, commandType: 'Attack' },
                { frame: 30, commandType: 'Attack' },
                { frame: 45, commandType: 'Attack' },
                { frame: 90, commandType: 'ComboSkill' },
                { frame: 120, commandType: 'NormalSkill' },
                { frame: 150, commandType: 'UltimateSkill' },
                { frame: 280, commandType: 'NormalSkill' },
                { frame: 340, commandType: 'Attack' },
                { frame: 355, commandType: 'Attack' },
                { frame: 370, commandType: 'Attack' },
                { frame: 385, commandType: 'Attack' },
                { frame: 450, commandType: 'BreakingAttack' }
            ],
            combatSetting: {
                simulatePoise: true,
                actionIdleExitFightFrames: 180
            }
        }
        : null;
if (scenarioOptions === null) {
    throw new Error(`Unknown scenario '${scenarioName}'. Available: pelica, pelica-poise`);
}

const result = simulateScenario(buildPelicaScenarioModel(scenarioOptions));
const outputFile = scenarioName === 'pelica'
    ? 'pelica-simulation.json'
    : 'pelica-poise-execution-simulation.json';
const outputPath = path.join(projectRoot, 'derived', 'cleanroom', outputFile);

if (!noWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
    console.log(scenarioName === 'pelica'
        ? '佩丽卡最小战斗模拟完成'
        : '佩丽卡失衡/处决模拟完成');
    console.log(`  HP 命中: ${result.damageSummary.hpHitCount}`);
    console.log(`  失衡命中: ${result.damageSummary.poiseHitCount}`);
    console.log(`  累计失衡伤害: ${result.damageSummary.totalPoiseDamage}`);
    console.log(`  总伤害: ${result.damageSummary.totalDamage}`);
    console.log(`  敌人 HP: ${result.finalState.targetHp}`);
    console.log(`  最终技力: ${result.finalState.resources.Atb}`);
    console.log(`  最终终结技能量: ${result.finalState.resources.UltimateSp}`);
    console.log(`  最终失衡状态: ${result.finalState.poise.broken ? '失衡' : '正常'}`);
    console.log(`  战斗时长: ${result.durationTicks} ticks`);
    if (!noWrite) console.log(`  明细: ${path.relative(projectRoot, outputPath)}`);
}
