# 敌方局部时钟与快速破韧保护

## 结论

当前公开 Calc 并不是用 `破韧墙钟帧 + poiseRecTime × 30` 直接恢复。恢复倒计时走敌方玩法局部时钟，命中停顿、破韧慢放和处决表现会让墙钟经过、局部计时不推进。恢复后还可能创建 `buff_common_poise_guard`，临时降低后续 Poise 伤害。

本地实现把两件事拆开：

```text
全局事件队列（命令/命中/动画帧）
        │
        ├─ DamageAction → HP / Poise 状态机
        │                    │
        │                    └─ 证据规则触发 pause
        │
        └──────────────→ Enemy LocalClock
                              │
                              └─ Poise recovery timer
                                      │
                                      └─ recover → 可选 PoiseGuard
```

## 原始 JSON 能直接告诉我们的内容

解析器会保留下列字段，而不把它们折叠成一个猜测值：

| 文件 | 原始动作 | 可确认信息 |
|---|---|---|
| `chr_0004_pelica_attack4_projhit.json` | `HitStopAction` | `OnlyTarget`、`char_normal_attack`、0.3 秒 |
| `chr_0004_pelica_combo_skill_projhit.json` | `HitStopAction` | `OnlyTarget`、同一曲线、0.2 秒 |
| `chr_0004_pelica_power_attack.json` | `HitStopAction` | `Both`、`common`、0.2 秒 |
| `chr_0004_pelica_combo_skill.json` | `TimeDilationAction` | Global 层、`ComboSkill` 曲线、0.833 秒描述符 |
| `chr_0004_pelica_ultimate_skill.json` | `UltimateTimeAction` | `timeScale=0` |
| 多个 HP/Poise DamageUnit | `enablePoiseBreakTimeDilation` | 命中允许触发破韧时间膨胀 |

这些字段说明“存在什么时间效果”，但没有公开曲线采样与运行时叠加器，不能直接推出恢复到底损失 7、11 还是别的帧数。因此 `spec/engine-semantic-mappings.json` 中的有效暂停值单独标注为 `confirmed-for-fixture`。

## 佩丽卡已闭合的局部暂停

| 触发 | 有效暂停 | 公开观察 |
|---|---:|---|
| 第四段投射命中造成破韧 | 7 tick | 426 名义应在 606 恢复，实际 613 |
| 战技造成破韧 | 11 tick | 293 名义应在 473 恢复，实际 484 |
| 破韧中战技 HP 命中 | 4 tick | 在前述 7 tick 基础上，恢复由 613 推到 617 |
| 处决 HP 命中 | 7 tick | 在前述 7 tick 基础上，恢复由 613 推到 620 |

`LocalClock` 只移动仍在运行的敌方局部计时器，不改写已经排好的技能命中帧。旧截止事件保留在队列中但用 generation 作废，新截止事件带着新的 deadline 重新调度，因而同帧顺序仍然确定。

## 当前 Calc 的快速破韧保护

受控实验使用 `eny_0021_agmelee`：`maxPoise=60`、恢复 6 秒、处决系数 1、处决返还 25 ATB。三个不同角色的大招各造成 25 Poise，避免重复角色 UUID 干扰。

公开 oracle：`fixtures/calc/poise-guard-boundaries.oracle.json`。

当前已确认的普通敌人签名规则是：

```text
elapsed = 破韧局部帧 - 本周期第一次正 Poise 伤害局部帧

若 elapsed < 48：
  poiseTakenScalar = 0.6 + elapsed / 48 × 0.4
  恢复时创建持续 90 tick 的 buff_common_poise_guard
否则：
  不创建保护
```

最快三次大招样本在墙钟 `51 → 93` 内破韧，但大招时停使敌方局部耗时为 0，Calc 给出 `0.5999999046325684`。把第三个大招延后后，观察到 `0.7333330512046814`；其对应的线性模型局部耗时为 16 tick。错开到资格窗口外则完全没有 `guardWindows`。

保护的生命周期有一个关键同帧边界：

| 帧 | Calc 结果 |
|---:|---|
| 280 | 恢复并 Started，报告 `durationFrames=90`、`endFrame=370` |
| 370 | 佩丽卡战技 10 Poise → 约 6 |
| 371 | Ended 事件所在帧，伤害事件优先，仍约 6 |
| 372 | 第一帧完全失效，恢复为 10 |

本地状态机用 `expireFrame = startFrame + durationTicks + 1` 和事件优先级复现这个边界。

## 与 AKE 旧研究文档的差异

公开研究文档描述的是按普通/高级/精英或 Boss/首领分级的固定 50% 惩罚和另一组秒数。当前 Calc 的普通敌人实测却是 48 局部 tick 资格窗、90 tick 保护、0.6 到 1 的线性倍率。两者至少在当前数据版本不能视为同一规则。

因此实现策略是：

- 保留旧文档作为历史公开参考；
- 当前 Calc profile 只绑定已观测的 `executionDamageScalar=1 + breakingAttackedAtbObtain=25` 签名；
- 其他等阶保持未解析，不复制普通敌人参数；
- 等拿到各等阶的公开边界样本，再新增 profile，而不是修改核心状态机。
