# 佩丽卡最小模拟器：状态与伤害闭环

## 结论

当前代码已用公开输入独立复现这个固定流程：佩丽卡连续四段普攻，第四段命中触发连携，随后施放连携技并在允许窗口内接战技。模拟器没有导入 AKE 的 GPL 分析器，也不会在运行时读取 Calc 响应；Calc 完整响应只作为测试 oracle。

运行：

```powershell
npm run simulate:pelica
npm test
```

生成结果位于 `derived/cleanroom/pelica-simulation.json`，解析后的中间模型位于 `derived/cleanroom/pelica-model.json`。

基线默认关闭 Poise 记录，以保持最初 9 段 HP oracle 不变。完整失衡/处决流程用 `npm run simulate:poise` 运行，字段与边界详见 [失衡、失衡节点与处决执行器](07-poise-execution-engine.md)。

## 原始数据如何变成可执行模型

1. `CharGrowthTable` 给出佩丽卡的技能组与默认武器。
2. 每个 `SkillData` 给出时间轴、子弹体技能、动作窗口、Blackboard 引用和默认值。
3. `SkillPatchTable` 的等级 1 项覆盖默认 Blackboard。比如普通技能原始默认倍率不是最终等级 1 值，补丁覆盖后才得到 `atk_scale=1.78`。
4. Calc 的公共角色面板快照用于还原属性组件，攻击力按下式得到：

```text
((rawValue 30 + baseAddition 29) × 1 + baseFinalAddition 12) × 1.181
= 83.851
```

5. `src/core/ake-parser.mjs` 只解析本用例需要的动作子集，并保留每个 Blackboard 值来自默认 SkillData 还是等级补丁。
6. 原始 JSON 没有直接声明的引擎语义，必须由 `spec/engine-semantic-mappings.json` 显式提供。目前有三类：`Pulse → attached_pulse`、数据驱动的 `ComboTriggerRule`、导电设置第 1 列为 12%。连携规则描述事件、根技能/实际伤害技能、发生次数、目标绑定、冷却约束、pending 策略、选择策略和消费策略，模拟器不再包含佩丽卡技能 ID 特判。

这意味着 `derived/cleanroom/pelica-model.json` 是“可读且可执行的后处理 JSON”，但不是原始 JSON 的替代品。它仍保留来源路径、补丁血缘、动作帧和未显式静态引用的语义边。

## 状态机结果

| 输入帧 | 实际执行帧 | 技能 | 状态含义 |
|---:|---:|---|---|
| 0 | 0 | attack1 | 第一段立即执行 |
| 15 | 15 | attack2 | 第一段 exclusive 边界允许切换 |
| 30 | 33 | attack3 | 输入进入 30 tick 队列，等到允许帧 |
| 45 | 59 | attack4 | 同上；第四段是本用例的“重击” |
| 90 | 90 | combo_skill | frame 86 已创建 pending，因而通过门控 |
| 120 | 120 | normal_skill | 位于连携技相对帧 25–54 的接续窗口内 |

关键状态：

- attack4 的投射物在 frame 86 的 `BeforeHpDamage` 事件创建连携 pending，本次在 frame 90 消耗。
- 公开接口边界对照确认：frame 86 的伤害前事件先于同帧命令门控，因此同帧可施放；frame 264 仍可施放，frame 265 先超时再门控失败，即有效区间为 `[86, 265)`。
- 新一次 attack4 命中会追加 pending。两条并存时门控选择最新一条；连携成功施放会清除该角色此连携技能的全部 pending。若连携仍在冷却，新命中不会创建 pending。
- pending 保存技能拥有者与触发敌人两个实体标识；当前单敌人黑盒样例已验证绑定值，多敌人隔离由执行器单元测试覆盖，尚未做 CALC 多敌人对照。
- 连携技从 frame 90 起进入 600 tick 冷却，结束帧为 690。
- 战技在 frame 120 消耗 100 ATB，瞬时 `300 → 200`；这不是战斗结束值。
- 最后技能在 frame 274 自然结束，空闲退出计时后，战斗总时长为 393 tick。

## ATB 与 USP 资源闭环

资源不再由模拟器中的临时加减法维护，而是交给独立 `ResourceMachine`。公开数据与 10 组黑盒边界用例确认：

- ATB 上限为 300，接战后自然恢复速度为 8/秒。服务器逐帧量等于 `Math.fround(8/30)`，即 `0.2666666805744171`。
- 未发生消费时，第一次恢复在 frame 1。若在 frame `T` 消耗 ATB，则 `T+1` 到 `T+15` 不恢复，`T+16` 恢复；已有恢复与消费恰好同帧时，恢复先执行。
- 本基线 frame 120 扣至 200，frame 136 至 393 共恢复 258 次，最终 ATB 精确为 `268.8000035881996`。
- attack4 的原始 `ObtainCostAction` 在 frame 86 请求获得 15 ATB；满值用例实际获得 0，低值用例实际获得 15。
- 连携命中的原始 `ObtainCostAction` 在 frame 114 获得 10 USP。
- 战技在 frame 133 创建 `buff_common_obtain_ultimate_sp`；其 `ObtainUspInNormalSkill` 动作读取 `usp_everyone=6.5`、`usp_self=0`、`ratio=1`，运行时精确结果为 `6.499999761581421`。
- 大招原始 SkillData 与等级 1 Patch 给出 `UltimateSp` 消耗 80、冷却 300 tick、倍率 4.45；满 USP 用例可施放并在相对 frame 58 造成 `186.568475`，空 USP 用例失败。

空 USP 的完整“第四段 → 连携 → 战技”用例最终为 `16.49999976158142 USP`。所有逐帧恢复事件、扣费、封顶与前后值都由 `fixtures/calc/pelica-resource-boundaries.oracle.json` 回归，而运行时代码不读取该文件。

## BUFF 链路

连携子弹在 frame 114 命中前按原始动作顺序创建 BUFF：

```text
combo_skill_projhit
  → conduct_triggered (父，60 tick)
     → triggered_start (90 tick)
     → conduct_triggered_do (150 tick)
        ├─ ReadSkillSettingData("导电法术伤害提高", column=1) = 0.12
        ├─ final_spell_resistance_decrease = 0.12
        └─ triggered_fx (150 tick)
```

实际结束帧为父 175、提示 205、效果子 BUFF 与 FX 265。`conduct_triggered_do` 对 Pulse 等法术伤害在 Defender/NormalCalcZone 加 `0.12`，所以 frame 114 和 frame 133 的防守方乘区均为 `1.12`。

战技 frame 133 还会通过 `SpellInfliction(Pulse)` 附着 `buff_common_energy_shard_attached_pulse`，持续 600 tick。这个映射不是对应 SkillData 的显式 Buff ID，因此被单独标为引擎语义。

## 伤害结果

本用例暴击模式为 `None`。敌人 DEF=100、Pulse 抗性=0，因此基础防御乘区为：

```text
defScale = 1 / (1 + DEF × 0.01) = 0.5
finalDamage = ATK × atk_scale × attackerZone × defenderZone × sharedScale
```

| 帧 | 动作 | 倍率 | 原始伤害 | Defender 区 | 最终伤害 |
|---:|---|---:|---:|---:|---:|
| 8 | attack1 | 0.25 | 20.96275 | 1 | 10.481375 |
| 24 | attack2 | 0.15 | 12.57765 | 1 | 6.288825 |
| 27 | attack2 | 0.15 | 12.57765 | 1 | 6.288825 |
| 49 | attack3 | 0.12 | 10.06212 | 1 | 5.03106 |
| 52 | attack3 | 0.12 | 10.06212 | 1 | 5.03106 |
| 55 | attack3 | 0.12 | 10.06212 | 1 | 5.03106 |
| 86 | attack4 | 0.57 | 47.79507 | 1 | 23.897535 |
| 114 | combo_skill | 0.8 | 67.0808 | 1.12 | 37.565248 |
| 133 | normal_skill | 1.78 | 149.25478 | 1.12 | 83.5826768 |

合计 `183.1976648`，敌人 HP 从 692 降至 `508.8023352000001`。测试逐项比较命中帧、技能 ID、原始伤害、非暴击/暴击/期望伤害和最终伤害。

## 当前边界

- 这是固定角色、固定等级、固定武器、单敌人的最小执行子集，不是完整战斗引擎。
- 通用连携规则执行器已经完成，但目前只有佩丽卡规则拥有 CALC 黑盒证据；其他角色仍必须逐个补充规则与最小对照样例。
- ATB/USP 已闭合当前单角色用例；多角色共享 ATB、逐角色 USP 分配及潜能改变能量上限仍需单独对照。
- AKE 快照与 Calc metadata 版本不同；当前选中数据恰好能严格对齐，不代表所有角色和版本都能直接混用。
- 重复 Pulse 触发法术爆发仍依赖尚未找到的 `ReadSkillSettingData("法术爆发伤害倍率")`，未在这个用例中假造数值。
- 空间选目标、多目标、完整异常反应、装备/天赋/潜能和所有动作条件仍需各自最小对照用例。
- Poise 累计、节点、失衡易伤与处决核心已经闭合；局部 time-dilation 导致的恢复墙钟帧偏移仍未纳入事件时钟。
