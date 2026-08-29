# 当前系统与模块职责

## 组件全景

| 组件 | 入口 | 责任 |
| --- | --- | --- |
| 来源锁 | `sources.lock.json` | 固定 AKE、Calc 与 AKEDatabase 参考版本及 SHA-256 |
| 公开数据仓库 | `reference/public-data/` | 保存运行时允许读取的 AKE 表、技能、Buff 和 Calc 面板/响应快照 |
| 第三方参考隔离区 | `reference/third-party/akedatabase/` | 只用于研究原始结构和展示分析，不进入 clean-room 运行时 |
| 机器语义 | `spec/engine-semantic-mappings.json` | 保存有证据的隐式映射、指令优先级、连携规则和窄范围黑盒参数 |
| 未决依赖 | `spec/unresolved-dependencies.json` | 记录缺失数据、外部 provider、部分确认与禁止猜测的边界 |
| 数据访问 | `AkeDataRepository` | 读取角色、武器、装备、敌人和技能资料，计算静态面板与展示目录 |
| 规范解析 | `ake-parser.mjs` | 把固定子集的 Skill/Buff 原始结构归一化 |
| 动作编译 | `AkeActionCompiler` | 把 AKE action/condition 编译成运行时动作、清理动作、metadata 或显式 unresolved |
| 配装编译 | `AkeLoadoutCompiler` | 把武器、潜能、天赋和装备被动转换成有来源的效果 |
| 单人装配 | `AkeScenarioAssembler` | 递归闭包一个角色、敌人、技能、Buff 与配装依赖 |
| 小队装配 | `AkeSquadScenarioAssembler` | 合并成员定义，建立共享敌人、共享 ATB 与成员 USP |
| 组合运行时 | `CombatRuntime` | 组织事件调度、效果解释、状态机、伤害 resolver 与 trace |
| 单人指令中心 | `AkeScenarioRunner` | 解析命令、准入、排队、打断、施放和战斗结束 |
| 小队指令中心 | `AkeSquadScenarioRunner` | 在共享资源、敌人和同帧顺序下执行多成员命令 |
| 时间轴投影 | `projectAkeTimeline` | 从已结算结果投影命令、施放、Hit burst、资源、冷却与窗口 |
| Demo 服务 | `demo/demo-service.mjs` | 把目录、装配、运行和投影组合成稳定 API 返回 |
| 前端目录适配 | `akeCatalogAdapter.ts` | 把 AKE 目录映射到 LTS 角色、武器、装备和技能选择界面 |
| 前端规划 | `akeRealtimeTimeline.ts` | 在提交结算前提供共享变速动作、资源和释放位置预演 |
| 前端结算适配 | `akeProvider.ts` | 组装小队请求、计算 execution digest、调用 API 并保存 report |
| 前端账本 | `akeRuntimeLedger.ts` | 把已结算 Hit、状态与乘区格式化为页面读取模型 |
| 调查档案 | `src/ria/` | 保存 Case/Session/不可变 Run，规范化事实事件并提供 replay/diff/verify |
| 调查 API | `src/ria/server.mjs` | 在 loopback 提供 REST、OpenAPI 与支持续传的 SSE |

## 运行时组合根

`CombatRuntime` 负责接线，不应吸收每种机制的全部状态。子系统按所有权拆分：

| 领域 | 状态所有者 | 关键边界 |
| --- | --- | --- |
| 实体与上下文 | `CombatContext` | source、owner、carrier、target、damageSource 与 cast 身份 |
| 条件与效果 | `EffectRuntime` | 规范动作分发、失败记录和派生深度限制 |
| 时间 | `ClockDomainManager` / `LocalClock` | 全局帧、角色/敌人局部时间、暂停和 timer |
| 资源 | `ResourceSystem` | 共享/实体池、获得、消费、恢复和暂停 |
| 生命 | `VitalMachine` | HP、治疗、护盾、归零与生命事件 |
| Buff | `StatusEffectSystem` | 实例、叠层、刷新、延长、暂停、继承、消费和退出原因 |
| 来源与属性 | `EffectSourceRegistry` | 可逆属性修正、伤害乘区、来源贡献与快照 |
| 元素/物理状态 | `EnemyMechanicResolver` | 附着、反应、异常、破防和控制状态事务 |
| 失衡 | `PoiseSystem` | 韧性条、节点、破韧、恢复和处决门票 |
| 控制韧性 | `ResilienceMachine` | 与 Poise 分离的硬直、霸体和控制状态 |
| 连携 | `ComboTriggerMachine` | pending、窗口、选择、消费、过期和暂停租约 |
| 共享连击 | `CombatRuntime` 的团队状态路径 | 发放、四层上限、合法 B/Q 消费与逐 Hit 快照 |
| 冷却 | `SkillCooldownSystem` | 角色 × 冷却组、设置、减少、暂停和恢复 |
| 技能形态 | `SkillFormStateRegistry` | Buff/模式驱动的槽位覆盖和优先级 |
| 能力事件 | `AbilityEventListenerRegistry` | listener 注册、过滤、生命周期和生产者审计 |

Poise 与控制韧性不是同一状态机；元素附着、物理状态和共享连击也不能因为 UI 都显示为图标而共用一个存储槽。

## 技能身份

输入按钮、实际执行程序和结算类型可能不同。运行时用下列字段避免把强化战技、派生技能和连携结算混为一谈：

| 字段 | 含义 |
| --- | --- |
| `inputCommandType` | 用户输入类别 |
| `inputSkillId` | 输入按钮解析出的技能 |
| `executedSkillId` | 当前实际执行的根或派生程序 |
| `effectiveSkillType` | 伤害、资源和共享连击应采用的结算类型 |
| `rootCastId` | 整次用户施放的根身份 |
| `parentCastId` | 派生技能的直接父施放 |

`switchToBuffConfig` 在施放开始时编译为条件化 Buff，`CastSkill` 通过通用 `LaunchSkillProgram` 路径执行。卡缪和梨诺共享同一编译路线；核心不包含角色 ID 分支。

共享连击在同帧 cast-start 解析完成后、首个 timeline Hit 之前按 `effectiveSkillType` 判定消费资格。消费证据以 `rootCastId` 为动作边界，并通过 cast 血缘投影到派生 child cast；`teamComboLedger` 用 `frame + sequence` 记录 grant/consume/refresh/expire 与每个 Hit 的冻结快照，UI 只读取这份因果账本，不用动作前后净层数反推来源。

## 两组相似但不同的模块

| 旧/专用模块 | 通用模块 | 当前处置 |
| --- | --- | --- |
| `ResourceMachine` | `ResourceSystem` | 前者只服务固定精确模拟；新能力进入后者 |
| `BuffMachine` | `StatusEffectSystem` | 前者保护佩丽卡 oracle；通用实例生命周期进入后者 |
| `PoiseMachine` | `PoiseSystem` | 后者为多目标包装并复用前者规则 |
| `simulator.mjs` | runner + `CombatRuntime` | 前者是回归锚点，后者是产品主链 |

新架构文档不得把两组模块合并描述成“已经统一”；迁移完成前，测试结果必须注明执行链。

## 生成物与事实所有权

- `derived/ake-analysis/` 来自第三方分析器，只说明其展示性解析结果。
- `derived/cleanroom/` 来自本项目代码，包含模拟结果、动作覆盖、事件覆盖和逐角色风险。
- 生成报告是某次代码与数据快照的结果，不是手工维护的永久数字；修改编译器或审计分类后必须重新生成。
- 架构正文解释字段语义和责任，具体统计直接读取生成 JSON。

## 禁止的反向依赖

- `src/` 不读取 `fixtures/calc/*oracle.json` 参与运行。
- `src/` 不导入 `reference/third-party/akedatabase/`。
- React 组件不解析 AKE 原始 JSON，不根据中文名或 ID 子串创造战斗状态。
- 前端 ledger 不重新计算伤害；它只格式化 report 的 factors 和 contributions。
- preview 不能覆盖匹配 execution digest 的 settled report。
- RIA 记录器不能修改、拦截或重新判定 runner/runtime 结果；记录失败只能降低 Run 档案状态。
- “全测试通过”“无 unresolved”或“31 名角色可执行”不能写成“全角色精确”。
