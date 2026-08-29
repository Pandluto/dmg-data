# 公开数据自动装配与佩丽卡通用运行时回放

## 本轮目标

这一阶段不再由手写模型直接告诉引擎“frame 8 造成多少伤害”，而是从公开文件自动完成：

1. 角色、武器、敌人面板和 SkillPatch 参数装配；
2. 根技能 → 投射物子技能 → Buff 子依赖的递归闭包；
3. 输入命令排队、普攻派生、连携 pending / 冷却 / 消耗；
4. 编译后的技能时间轴、伤害、Buff、ATB、USP 和局部时钟执行；
5. 生成逐帧、逐来源、逐状态的审计结果。

旧的 `simulator.mjs` 仍作为佩丽卡精确层保留。新链路使用 `CombatRuntime`，两者没有互相替换，也没有让通用层读取旧模拟结果或 Calc oracle。

## 数据装配

入口是 `src/core/ake-scenario-assembler.mjs`。装配器读取：

- `CharGrowthTable.json`：角色技能组、默认武器；
- `SkillPatchTable.json`：等级 Blackboard，例如 `0.25 / 0.8 / 1.78`；
- `EnemyAttributeTemplateTable.json`：韧性、恢复、处决系数等模板字段；
- Calc 公开面板快照：攻击、HP、DEF、抗性；
- 公开 `SkillData/*.json` 与 `BuffData/*.json`；
- `engine-semantic-mappings.json` 中有证据的执行规则。

依赖解析不是固定的佩丽卡文件清单。装配器交替排空 Skill 和 Buff 队列，直到达到固定点：

```text
角色技能组
   ↓
根 SkillData ──LaunchProjectile──> 子 SkillData
   │                                  │
   └──────── CreateBuff / 映射 ──────┘
                     ↓
                  BuffData ──CreateBuff──> 子 BuffData
                     │
                     └──可能再引用 Skill / Buff──> 回到队列
```

潜能、装备被动提供的依赖也进入同一闭包。文件不存在时会产生 `AKE_SKILL_DATA_MISSING` 或 `AKE_BUFF_DATA_MISSING`，不会静默制造空定义。当前佩丽卡用例装配出 15 个 Skill program、30 个 Buff definition，缺失依赖为 0。

## 指令与状态机

`src/core/ake-scenario-runner.mjs` 只补足原始动作图没有直接表示的输入状态机：

- `Attack` 从当前技能 `ComboCacheAction` 找下一段普攻；
- 在独占期内提交的攻击按 30 帧输入队列窗口缓存；
- `AllowNextSkillAction` 与 `exclusiveFrames` 共同确定最早执行帧；
- 第四段首个 HP 命中通过通用 `ComboTriggerMachine` 创建 pending；
- `ComboSkill` 检查目标绑定、pending、冷却并在成功施放后消费；
- `NormalSkill`、`UltimateSkill` 执行资源门控和施放成本；
- 技能被新指令打断时，尚未执行的根 program timer 按来源取消。

技能时间轴事件优先级被明确分层：

```text
技能时间轴增益 / 命中  →  被动资源 tick  →  输入命令与施放成本
```

这解释并复现了两个看似冲突的同帧现象：frame 86 的第四段 ATB 增益发生在该帧被动恢复之前，而 frame 120 的被动恢复检查发生在战技消耗之前。

## Buff 归属修正

AKE Buff 生命周期中的 `ActionOwner` 是“当前承载 Buff 的实体”，不等同于效果最初的归属者。导电父 Buff 施加给敌人后，其 `Owner` 子 Buff 也必须落在敌人身上；最初施加者仍保存在 `statusOwnerId` 和来源字段中供归因、清理和审计使用。

另一个关键点是叠层匹配必须同时满足 `buffId`。导电触发 Buff 与导电持续 Buff 都使用 `pulse_triggered` 叠层键，但它们是两个可以共存的定义；仅按叠层键匹配会把子 Buff 错误刷新进父实例，导致 12% 导电乘区丢失。

## 资源与通用条件

本轮增加了 `CheckMainCharacterCondition`、单实体 `CheckEntityNum` 和 `CheckTagMatch` 的安全编译路线。前两项使真实 SkillData 中的资源动作可以执行：

| 帧 | 来源 | 资源动作 | 空资源实际值 |
|---:|---|---:|---:|
| 86 | 第四段命中 | ATB +15 | +15 |
| 114 | 连携命中 | USP +10 | +10 |
| 120 | 战技施放 | ATB -100 | -100 |
| 133 | 战技命中 | USP +6.499999761581421 | +6.499999761581421 |

`ResourceSystem` 还修正了消耗后的恢复暂停：暂停区间里的 tick 是“跳过”，不是“延迟后补发”。否则 frame 136 会一次补发 16 次恢复。修正后满资源基线在 frame 393 的 ATB 为 `268.8000035881996`。

## 时间系统的证据边界

`ake-time-dilation-resolver.mjs` 将两类情况分开：

- 普通 `HitStopAction` / `TimeDilationAction`：保留时长、曲线键和影响对象以供审计；没有曲线证据时不擅自把名义时长换成暂停 tick；
- `LocalClockPauseRule`：仅当实际伤害结果满足 `PoiseBreak`、`HpDamageWhileBroken` 或 `ExecutionHit` 时，按语义映射暂停敌人的独立时钟域。

因此，普通佩丽卡基线不会因展示性减速而改变已经确认的命中帧；把敌人韧性设为 15 时，第四段在 frame 86 破韧，并只给敌方时钟增加已确认的 7 个暂停 tick。

## 对齐结果

通用运行时现在从六条输入命令自动得到：

| 项目 | 结果 |
|---|---|
| 命令执行帧 | `0, 15, 33, 59, 90, 120` |
| HP 命中帧 | `8, 24, 27, 49, 52, 55, 86, 114, 133` |
| 连携 pending | frame 86 创建、frame 90 消费 |
| 导电防守乘区 | 后两次 Pulse 伤害 `1.12` |
| 总伤害 | `183.1976648` |
| 敌人最终 HP | `508.8023352000001` |
| 最终 ATB | `268.8000035881996` |
| 空 USP 最终值 | `16.49999976158142` |
| 运行期未解析效果 | `0` |
| 自动战斗结束帧 | `393` |

通用层同时执行了三条韧性 DamageUnit；旧的基线精确层默认关闭失衡模拟，所以它的 `hitCount` 仍只统计 9 条 HP 命中。两边的 HP 伤害链和资源结果一致。

## 运行与验证

```powershell
npm run simulate:pelica-generic -- --no-write
node --test test/ake-scenario-runner.test.mjs
```

不带 `--no-write` 时，结果写入 `derived/cleanroom/pelica-generic-runtime-simulation.json`。核心文件：

- `src/core/ake-scenario-assembler.mjs`：公开表与依赖闭包；
- `src/core/ake-scenario-runner.mjs`：输入命令和技能中心状态；
- `src/core/ake-action-compiler.mjs`：AKE action / condition 编译；
- `src/core/combat-runtime.mjs`：通用效果与状态机编排；
- `src/core/ake-time-dilation-resolver.mjs`：时间动作证据边界；
- `test/ake-scenario-runner.test.mjs`：本轮轻量回归。

## 尚未完成

“运行期未解析效果为 0”只表示这条佩丽卡主链实际走到的效果都有执行路线，不代表 3,389 文件的所有分支已完成。编译审计仍明确保留：

- 空间选择、距离、方向、目标组和真实投射物飞行；
- 其他角色的 HitStop 曲线积分；
- 未映射的 SkillSetting 列；
- 剩余玩法 Action / Condition；
- 多角色共享 ATB、各自 USP 与队友/召唤物归属的整体场景；
- 通用韧性层的恢复周期、节点、处决门控与快速破韧保护的完整整合。

这些缺口不会用佩丽卡常量或默认 `true` 掩盖。
