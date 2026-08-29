# 数据驱动的指令准入与优先级

## 结果

`AkeScenarioRunner` 不再用 `if (commandType === ...)` 猜测打断优先级。
`CommandAdmissionProvider` 从 `spec/engine-semantic-mappings.json` 读取指令档位、
中心状态和判定顺序，再结合当前 SkillData 已编译出的时间轴窗口作决定。

冻结的 Calc `INTERRUPT_CHECK` 记录确认了四档数值：

| 指令 | 中心状态 | 优先级 | 证据状态 |
| --- | --- | ---: | --- |
| `Attack` | `Attack` | 0 | 陈千语、佩丽卡、沃尔夫冈均有记录 |
| `NormalSkill` | `Skill` | 2 | 陈千语、沃尔夫冈均有记录 |
| `ComboSkill` | `Skill` | 5 | 佩丽卡有记录 |
| `UltimateSkill` | `Skill` | 7 | 沃尔夫冈有记录 |
| `BreakingAttack` | `Skill` | 未知 | 仅确认由处决/破韧门控，没有优先级记录 |

`BreakingAttack` 因此使用 `ExternalGate`，数值保持 `null`；代码不会把未经观测的
优先级伪装成已确认结论。它和正在释放的其它技能如何竞争，仍需新的边界样本。

## 判定链

对已经解析出 `skillId` 的输入，准入器依次检查：

1. 没有当前技能：立即接纳；
2. 新指令优先级更高：立即打断，原因 `HIGHER_PRIORITY`；
3. 当前 SkillData 的 `AllowNextSkillAction` 正在允许该 `skillId`：立即接纳；
4. 当前时间轴已执行 `MarkCanInterrupt`：立即接纳；
5. 已到当前技能 `exclusiveFrame`：立即接纳；
6. 否则排队，下一资格点取未来 AllowNext、MarkCanInterrupt 和 exclusiveFrame
   三者中的最早帧。

第三项是按具体 `skillId` 匹配，不是“所有技能都能接”；第四项则已经通用化，
不再只对普攻输入生效。输入缓存仍由运行器执行严格的 30 墙钟帧过期规则，
所以资格点与过期点同帧时先过期。

资源是否足够、连携 pending 是否存在、冷却是否结束和处决门票是否有效，不属于
“谁能打断谁”的问题，继续由各自的状态机单独判定。

## 可审计输出

每次首次输入和排队重试都会写入 `commandAdmissionTrace`。例如沃尔夫冈战技
第 30 帧输入普攻：

```json
{
  "frame": 30,
  "accepted": false,
  "reason": "PRIORITY_BLOCK",
  "commandType": "Attack",
  "skillId": "chr_0006_wolfgd_attack1",
  "currentSkillId": "chr_0006_wolfgd_normal_skill",
  "currentPriority": 2,
  "newPriority": 0,
  "timelineFrame": 30,
  "nextTimelineFrame": 48
}
```

角色局部时间轴到 48、`MarkCanInterrupt` 生效后，重试记录变为：

```json
{
  "frame": 48,
  "accepted": true,
  "reason": "CURRENT_CAN_BE_INTERRUPTED",
  "currentPriority": 2,
  "newPriority": 0,
  "timelineFrame": 48
}
```

这让“为什么技能在这一帧被打断”成为运行结果的一部分，不必再从最终伤害倒推。

## 代码入口与验证

- 规则实现：`src/core/command-admission-provider.mjs`
- 运行器接线：`src/core/ake-scenario-runner.mjs`
- 数据规则：`spec/engine-semantic-mappings.json`
- 独立规则测试：`test/command-admission-provider.test.mjs`
- Calc 回归：`test/calc-interruption-oracle.test.mjs`

当前 43 个沃尔夫冈差分用例仍然同时满足成功指令帧、每个 HP 伤害包和总伤害
完全一致。三个角色的现有跨角色回归也保持一致。这里验证的是冻结样本覆盖到的
单角色、单目标指令语义；空间、换人和多人同时输入不在本轮范围内。
