#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeScenarioAssembler } from './core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from './core/ake-scenario-runner.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const noWrite = args.includes('--no-write');
const bundle = new AkeScenarioAssembler({ projectRoot }).assemble({
    characterId: 'chr_0004_pelica',
    enemyId: 'eny_0007_mimicw'
});
const result = new AkeScenarioRunner(bundle).run();
const outputPath = path.join(
    projectRoot,
    'derived',
    'cleanroom',
    'pelica-generic-runtime-simulation.json'
);

if (!noWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
    console.log('佩丽卡公开数据自动装配 / 通用运行时回放完成');
    console.log(`  命令执行帧: ${result.commandTrace
        .filter(entry => entry.type === 'CommandExecuted' && entry.success)
        .map(entry => entry.frame).join(', ')}`);
    console.log(`  HP 命中: ${result.damageSummary.hpHitCount}`);
    console.log(`  韧性命中: ${result.damageSummary.poiseHitCount}`);
    console.log(`  总伤害: ${result.damageSummary.totalDamage}`);
    console.log(`  敌人 HP: ${result.finalState.targetHp}`);
    console.log(`  最终技力: ${result.finalState.resources.Atb}`);
    console.log(`  最终终结技能量: ${result.finalState.resources.UltimateSp}`);
    console.log(`  运行期未解析效果: ${result.diagnostics.unresolvedEffectCount}`);
    console.log(`  战斗时长: ${result.durationTicks} ticks`);
    if (!noWrite) console.log(`  明细: ${path.relative(projectRoot, outputPath)}`);
}
