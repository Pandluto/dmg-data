# 失衡、失衡节点与处决执行器

## 当前结论

公开 AKE 数据与 Calc 公共模拟接口已经足够闭合一个可运行的失衡/处决核心。这里的“失衡条（Poise）”与敌人的 `maxResilience` 位移韧性不是同一个系统：本实现只处理会进入失衡状态、开放处决并产生 30% 易伤的 Poise 状态机。

运行完整演示：

```powershell
npm run simulate:poise
```

输出写入 `derived/cleanroom/pelica-poise-execution-simulation.json`。测试 oracle 位于 `fixtures/calc/pelica-poise-boundaries.oracle.json`，运行时代码不读取它。

## 原始数据到运行模型

敌人基础规则来自 `EnemyAttributeTemplateTable.json`：

| 原始位置 | 后处理字段 | 含义 |
|---|---|---|
| `levelIndependentAttributes.attrs[attrType=20]` | `enemy.maxPoise` | 失衡值上限 |
| `attrType=21` | `enemy.poiseRecTime` | 名义失衡持续/恢复时间（秒） |
| `attrType=27` | `enemy.executionDamageScalar` | 处决特殊乘区 |
| `breakingAttackedAtbObtain` | `enemy.breakingAttackedAtbObtain` | 处决返还技力 |
| `poiseKnotPctList` | `enemy.poiseKnotPctList` | 失衡节点比例 |
| `poiseKnotBuffList` | `enemy.poiseKnotBuffList` | 节点触发 Buff |

佩丽卡技能的 Poise 值不是从 HP 倍率推算，而是同一个 `DamageAction` 内另一条 `damageAttributeType="Poise"` 的 `DamageUnit`：

```text
DamageAction
├─ DamageUnit[0]: damageAttributeType=Hp
│  └─ atkScale / atkCalculation → HP 伤害
└─ DamageUnit[1]: damageAttributeType=Poise
   └─ DefiniteValueCalculation.value → Blackboard[poise]
```

等级 1 Patch 合并后，本次流程中的基础失衡值为：第四段重击 15、连携 10、战技 10、终结技 20。解析器会同时保留 HP 和 Poise 单元，后处理字段 `poiseCalculationType`、`poiseValue` 仍能追溯到原始描述符。

## 状态机

```text
Normal(accumulated < max)
  ├─ Poise hit → accumulated += base × outputScalar × takenScalar
  ├─ 跨过 knot → KnotTriggered + 对应短踉跄 Buff（每周期一次）
  └─ accumulated >= max
        ↓
Broken
  ├─ 伤害防守区 ×1.3
  ├─ executionAvailable=true
  ├─ 后续 Poise 数字仍记录，但不再推进条
  ├─ BreakingAttack 命中 → 门票仅消费一次 + 敌人模板 ATB 返还
  └─ 名义恢复计时结束 → accumulated=0，重置节点和处决门票
```

越过上限时有两个不同值：

- `poiseDamage` 保留本次完整输出，和 Calc 伤害日志一致；
- `actualPoiseDamage` 只记录真正填入失衡条的部分，`poiseOverflow` 记录被上限截掉的部分。

例如 60 点上限已经累计 55，再命中 10 点时，日志仍显示 10，但状态变化是 `55 → 60`，实际 5、溢出 5。

## 已捕获的边界证据

`capture-calc-poise-boundaries.mjs` 使用公开、无鉴权的 `/api/simulations` 捕获九组受控实验：

| 用例 | Calc 观察 | 本地结果 |
|---|---|---|
| 关闭失衡模拟 | 不生成 Poise 日志 | 一致 |
| 80 上限、累计 65 | 处决命令失败 | 一致 |
| 80 上限、累计恰好 80 | frame 426 `OnPoiseZero` | 一致 |
| 60 上限、累计到 65 | frame 293 失衡 | 一致，实际 5/溢出 5 |
| 失衡中战技 | `74.62739 → 97.015607` | 一致，倍率 1.3 |
| 首次处决 | frame 485 成功并返 25 ATB | 一致 |
| 同周期第二次处决 | 命令失败 | 一致 |
| 140 上限、50% 节点 | frame 426 触发 75 tick 小失衡 | 一致 |
| 模板恢复 | 失衡 Buff 与处决窗口结束 | 局部计时及已捕获墙钟帧均一致 |

处决技能 `chr_0004_pelica_power_attack` 的等级 1 Patch 给出 400% 倍率，原始 HP 单元使用 `BreakingAttackCalculation`。对 `eny_0121_klbud`：

```text
rawDamage = 83.851 × 4 = 335.404
finalDamage = 335.404 × DEF区0.5 × 失衡易伤1.3 × 处决系数1
            = 218.0126
```

若敌人模板的处决系数为 1.5，同一计算路径会再乘 1.5；该值来自敌人而不是佩丽卡技能。

## 逻辑时间与墙钟帧

模板 `poiseRecTime=6` 表示 180 个逻辑 tick。Calc 的公开轨迹中，frame 426 失衡后可能在 613、617 或 620 才恢复；差出的 7–14 帧取决于期间命中、处决动画和表现层时间膨胀/停顿。

当前引擎已把这层差异实现为独立的 `LocalClock`：

- `nominalRecoveryFrame = breakFrame + poiseRecTime × 30`；
- 恢复倒计时挂在敌方局部时钟上；
- 命令、伤害事件与动画仍按全局墙钟帧调度；
- 只由有公开样本支持的 `LocalClockPauseRule` 延长局部计时器；
- trace 同时保留名义帧、每次暂停原因、旧/新截止帧和实际恢复帧。

佩丽卡当前四个公开用例已经逐帧闭合：第四段破韧 `426 → 613`，战技破韧 `293 → 484`，破韧中再命中战技 `426 → 617`，处决命中 `426 → 620`。原始动作中的 `HitStopAction`、`TimeDilationAction`、`UltimateTimeAction` 和 `enablePoiseBreakTimeDilation` 也被解析并保留；但曲线参数并不能直接等于恢复损失帧数，因此执行层使用黑盒样本校准出的有效局部暂停值。

快速破韧保护的当前 Calc 行为、旧研究文档差异和完整边界见 `08-poise-local-clock-and-guard.md`。

## 尚未并入本核心的相邻机制

- 快速打入失衡后的保护已对当前普通敌人签名实现；高级、精英/Boss、首领签名仍需分别采集，不能从普通敌人参数外推。
- `buff_common_resilience_decrease` 操作的是 Resilience 下降因子，不等同于 Poise 上限；位移、倒地、击飞与超级护甲需要独立执行器。
- 多敌人、目标切换和“第一位主控普攻自动改写为处决”的输入路由尚未做 Calc 多目标对照；公共模拟 API 当前用显式 `BreakingAttack` 命令表示处决。
- 长流程中重复法术附着可能产生额外法术爆发伤害；这属于尚未闭合的异常反应链，不影响这里已验证的失衡值、1.3 易伤与处决命中。
