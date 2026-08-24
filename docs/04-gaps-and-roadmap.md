# 缺口与实现顺序

## 已确认缺口

1. 当前公开索引列出的完整 `BuffData/` 已同步；索引仍没有单独的 `GlobalBuffData` 数据集，CcTag、等级事件和环境选择器的运行语义不能仅凭文件齐全推断。
2. `SpellInfliction` 等动作到实际 Buff 的引擎映射不在对应 SkillData 中。
3. `ReadSkillSettingData` 的完整运行时数据源尚未进入当前最小快照；当前仅显式补入已验证的导电列值，法术爆发倍率仍未闭合。
4. 单人单目标的同 tick 顺序已有实现和回归；复杂目标选择、空间判定与关卡信号仍需更多对照用例。
5. AKE 的公开解析器可以规范化和展示动作树，但不是运行时执行器。
6. 佩丽卡已捕获命中的敌方局部时钟修正已闭合；其他角色的 HitStop 曲线仍需要逐技能校准，不能只按动作描述的秒数换算。
7. 当前普通敌人签名的快速失衡保护已闭合；公开旧文档的固定 50% 分级表与当前 Calc 实测不同，高级、精英/Boss、首领 profile 仍缺少边界样本。
8. 通用效果、治疗、护盾、光环、反应与控制韧性已经有可执行骨架；AKE 动作编译器已覆盖核心动作的大部分执行路线，但空间 provider、时间曲线、完整 SkillSetting/DamageCalculation 参数和 Calc 边界仍未闭合。

## 当前实现进度

### 阶段 1：只读索引器（最小子集已完成）

- 加载 TableCfg、SkillData 与 BuffData；
- 输出实体节点、显式引用边、Blackboard 边及 JSON 路径；
- 实现循环检测和未解析依赖报告。

验收：可以自动重建佩丽卡 Skill → Pulse 动作，以及 attached Buff → triggered Buff 的显式部分。

### 阶段 2：Buff 最小执行器（导电链路已完成）

- 30 tick/秒事件队列；
- Limited/Infinity；
- Unique/Unlimited/EnhanceAndRefresh；
- Start/Trigger/Finish；
- Create/Refresh/Enhance/Finish Buff；
- 完整审计日志。

当前验收：可以得到 frame 114 的导电父/子 Buff、frame 144/175/205/265 的对应结束事件。

### 阶段 3：数值动作（佩丽卡固定用例已完成）

- Blackboard 数据流；
- 属性 modifier、DamageAction、HealAction；
- SkillPatch 与 SkillSetting 读取；
- 输出伤害分解审计。

当前验收：9 段伤害与 Calc oracle 逐段相等，总伤害 `183.1976648`。

### 阶段 3.5：ATB/USP 资源执行器（佩丽卡单角色已完成）

- ATB/USP 初始化、封顶、获得、消费与不足门控；
- ATB 每帧自然恢复、消费后恢复延迟与同帧优先级；
- `ObtainCostAction` 与 `ObtainUspInNormalSkill`；
- 大招消耗、冷却和伤害时间轴。

当前验收：10 个资源边界用例的全部非初始化资源事件与 Calc 完全相等，基线最终 ATB 为 `268.8000035881996`。

### 阶段 3.6：失衡/处决执行器（核心已完成）

- 从敌人模板读取上限、恢复秒数、处决倍率、处决 ATB 返还和失衡节点；
- 从 SkillData 的 Poise DamageUnit 读取基础值，并区分完整输出、实际填条和溢出；
- 失衡门控、30% 易伤、单次处决门票、处决特殊乘区和命中返还 ATB；
- 失衡期间的后续 Poise 仅记录不推进；恢复后清条、重置节点与门票；
- 50% 节点与 2.5 秒小失衡 Buff。

当前验收：9 个公开 Calc 用例验证关闭模拟、阈值前、恰好阈值、溢出阈值、失衡易伤、处决成功、重复处决拒绝、恢复和节点；玩法帧与数值一致。

### 阶段 3.7：敌方局部时钟与快速失衡保护（普通敌人签名已完成）

- 全局事件帧和敌方玩法局部时钟分离；
- 局部暂停可重排仍在运行的恢复计时器，并保留旧/新 deadline 审计；
- 解析并保留 HitStop、TimeDilation、UltimateTime 与破韧慢放开关；
- 当前普通敌人签名的 48 tick 资格窗、0.6→1 线性倍率和 90 tick 恢复后保护；
- 保护 Ended 同帧的伤害优先级边界。

当前验收：四种佩丽卡流程的实际恢复帧精确等于 Calc 的 `613 / 484 / 617 / 620`；8 个公开快速失衡用例覆盖最低倍率、插值倍率、窗口外、保护内、报告终点、Ended 同帧与下一帧。

### 阶段 3.8：通用战斗运行时（代码骨架已完成，深度 oracle 待下一轮）

- `CombatContext`：实体、标签、属性及 Source/Owner/Target/Cast 事件上下文；
- `EffectRuntime`：条件树、分支、序列及可注入动作 handler；
- `ClockDomainManager`：全局/角色/敌人等独立局部时钟、暂停与定时器；
- `ResourceSystem`：共享池、实体池、封顶、消费不足、转移和可选被动恢复；
- `VitalMachine`：HP、治疗封顶/溢出、来源护盾和吸收优先级；
- `StatusEffectSystem` 与 `AuraMachine`：显式来源/归属/目标、叠层、生命周期和光环目标绑定；
- `ReactionMachine`：分元素积蓄、阈值、消费、多次触发和局部时钟冷却；
- `ResilienceMachine`：独立于 Poise 的控制韧性、超级护甲/免疫、Stable/Staggered/Downed 与处决量表；
- `CombatRuntime`：规则分发、派生事件深度限制，以及上述模块的默认 handler 接线。

当前验收只使用轻量测试：模块状态转换和一条“条件 → 资源 → 光环 Buff → 元素反应 → 治疗/护盾 → 韧性”的组合链路通过。它证明接口能够共同执行，不代表参数已经由 Calc 逐项验证。

### 阶段 3.9：AKE 动作编译与真实数据接线（代码完成，精确 provider 待补）

- 同步当前公开索引中的完整 BuffData、角色 SkillData 和装备被动 SkillData，共 3,389 文件；
- `AkeActionCompiler` 把 Skill/Buff 时间轴、生命周期、条件、Buff、资源、伤害、光环、反应和 Resilience 动作编译到通用运行时；
- `AkeDamageResolver` 把支持的 DamageUnit 接入实时属性、来源化伤害乘区和现有伤害公式；
- `AkeLoadoutCompiler` 与 `LoadoutEffectManager` 安装、刷新和卸载潜能/天赋/装备被动来源；
- HitStop/TimeDilation、空间目标、Interval 和未知 selector 通过显式 adapter/unresolved 接口保留，不填猜测值；
- 动作覆盖审计逐实例实际调用编译器，并生成 `derived/cleanroom/ake-action-coverage.json`。

当前验收：全项目 95 条轻量与既有精确回归通过。伤害计算器核心类别共有 9,303 个动作实例，其中 5,144 个可直接完整执行、3,090 个已有执行动作但需外部适配器，执行路线覆盖 88.51%；该比例不代表适配器参数已经精确还原。真实数据简单用例包括佩丽卡 Skill 时间轴/潜能/命中伤害、周期治疗与 USP、Tag 驱散、全局光环、EnergyShard 反应、装备满血被动、Buff 内时间轴和 HitStop 适配接口；另有 43 条沃尔夫冈指令接纳、打断、跳转、投射物与 Buff 生命周期样本逐包一致。

### 阶段 4：语义映射与模式规则

- 连携触发规则执行器（佩丽卡已完成）：事件/技能选择器、每次施法去重、目标绑定、冷却抑制、多 pending、最新优先与消费清理；
- 元素附着/反应执行器已有通用实现；具体元素与 Buff/爆发链映射仍待验证；
- CcTag、等级事件和环境选择器的全局 Buff 语义桥接；
- 关卡事件和目标选择；
- 通过多组受控 Calc 黑盒差分做回归测试。

连携子阶段当前验收：9 个佩丽卡边界用例与 Calc 逐项一致，包括命中前一帧、命中同帧、命中后一帧、超时前后、重复触发、选择顺序与冷却期抑制。

## 完成标准

每条实现规则必须至少拥有：数据来源、固定版本/哈希、最小测试输入、期望事件日志，以及“直接数据”“推断”或“黑盒观测”的证据标签。
