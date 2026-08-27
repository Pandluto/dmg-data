# Endaxis × ake-calc-cleanroom × dmg-end-field 对比研究

> 研究日期：2026-08-27
> 研究性质：架构与产品对比，不包含功能代码修改
> 结论用途：决定后续引擎、数据层和时间轴交互的收敛方向

## 1. 结论先行

Endaxis 是一个成熟度很高的战斗轴编辑器与模拟器。它最值得借鉴的不是视觉布局，而是以下四件事已经形成了完整闭环：

1. 手工维护但类型完整的战斗定义；
2. 从编辑器动作编译到事件队列的确定性模拟；
3. 同一份模拟日志投影出伤害、Buff、技力、失衡、连携窗口等多个视图；
4. 覆盖全角色、武器、装备与关键公式的自动回归测试。

但是，Endaxis 不适合成为本项目的新底座，也不应该直接复制：

- 它使用传统的固定秒/帧横轴，时间与像素基本线性对应；本项目正在解决的是“真实时间不等距、事件列共享斜率、视觉压缩”的另一类交互问题。
- 它的技能合法性校验是诊断式的：条件不满足可以发出警告，但模拟仍继续执行；本项目的目标是严格的可执行轴，批次失败时整轴必须不可执行。
- 它以人工编写的 TypeScript 数据表作为主要事实来源；本项目需要保留 AKE 原始 JSON、Calc 黑盒用例、哈希与未决依赖，不能把人工转录重新变成唯一真相。
- 它在当前检出的提交中没有 `LICENSE` 或等价授权文件。公开可读不等于允许复制、修改或再分发；在作者补充许可之前，只能研究思想、观察行为并独立实现。

因此，三套项目的长期定位应当是：

| 项目 | 应保留的核心定位 |
| --- | --- |
| `dmg-end-field` | 成熟的产品外壳、角色配置工作流、Buff 编辑与伤害解释体验 |
| `ake-calc-cleanroom` | 原始数据证据链、严格释放合法性、通用状态机、真实命中与共享变速时间轴实验 |
| `Endaxis` | 架构参照、数据覆盖基准、测试用例设计参考、成熟编辑器能力清单 |

Endaxis 是很好的“对照组”和“完成度标尺”，不是要换掉现有路线的第四套产品。

## 2. 研究范围与固定版本

本次对比固定在以下本地版本，避免后续上游变化污染结论：

- Endaxis：`66bb80be8c07bf8b27c2606c220836f5537bf664`
- ake-calc-cleanroom：研究时工作区基于 `b97ff73`
- dmg-end-field：`codex/v1.8-lts-desktop-overlay` 分支的本地工作树，仅只读分析

Endaxis 本地路径：

```text
/Users/sailstellar/Documents/ChatGPT/dmg-data/Endaxis
```

原项目本地路径：

```text
/Users/sailstellar/Documents/coding/dmg-end-field
```

本次实际完成了以下核对：

- 阅读 Endaxis 的数据类型、角色定义、编译器、模拟引擎、触发器、状态管理、伤害公式、投影器和主要编辑器组件；
- 实际启动 Endaxis，并查看空白编辑器、干员选择、陈千语技能库、敌人面板、时间刻度和底部资源区域；
- 运行 Endaxis 全量测试、生产构建和 TypeScript 类型检查；
- 对照 cleanroom 的通用运行时、AKE 编译链、命令准入、形态状态机、连携状态机和共享变速时间轴；
- 对照原 dmg-end-field 的配置、Buff 模型、按钮轴、单次伤害解释、资源包与持久化工作流。

## 3. 客观验证结果

### 3.1 Endaxis

| 项目 | 结果 |
| --- | --- |
| `npm ci` | 成功 |
| `npm test -- --run` | 79 个测试文件、599 个测试全部通过 |
| `npm run build` | 成功 |
| `npm run type-check` | 失败，存在多处严格类型错误 |
| 依赖审计 | 11 个漏洞：1 low、1 moderate、8 high、1 critical |
| 最大主包 | 约 2.56 MB，gzip 后约 660 KB |
| 许可证 | 当前提交未发现 `LICENSE`、`COPYING` 或 `package.json` license 声明 |

测试结果说明它的功能回归基础确实成熟；类型检查失败、依赖漏洞、超大包和缺少许可证则说明“功能成熟”不能直接等同于“工程上可以原样接收”。

Endaxis 当前数据规模约为：

- 30 份干员定义；
- 77 份武器定义；
- 243 件装备；
- 24 个套装；
- 82 个敌人定义；
- `src` 下 TypeScript/Vue 约 13.5 万行；
- 模拟相关 TypeScript 约 3 万行。

明显的大文件包括：

- `src/stores/timelineStore.ts`：约 6,532 行；
- `src/components/TimelineGrid.vue`：约 6,111 行；
- `src/views/TimelineEditor.vue`：约 3,303 行；
- `src/components/ActionItem.vue`：约 1,343 行。

这证明它已经具备完整产品能力，也证明它存在明显的编辑器单体化问题。

### 3.2 ake-calc-cleanroom

当前 cleanroom 同时存在两套层次：

- 根目录的纯引擎与数据编译层；
- `demo/lts-ui` 中复用原项目 UI 后形成的实时轴与展示适配层。

规模上，根引擎约 2.5 万行 MJS，前端 TypeScript/TSX 约 11.9 万行。它的主要风险不是覆盖不足这么简单，而是旧 dmg 展示计算、新 AKE 运行时和新共享时间轴之间仍有重复推导与超大适配器。

### 3.3 dmg-end-field

原项目的产品工作流明显比两套模拟器更成熟：角色、武器、四件装备、面板属性、Buff 批量编辑、按钮排轴、伤害说明、持久化、分享、PWA、桌面容器和资源包都已经形成稳定体验。

但它的核心伤害链仍然是“用户选择一组可能生效的 Buff，再计算一个技能/命中的结果”，不是由真实命中事件自动驱动的战斗世界状态。因此它适合保留为交互外壳，不适合继续承担新引擎的事实来源。

## 4. Endaxis 的真实架构

### 4.1 数据不是普通 JSON，而是一套战斗 DSL

Endaxis 的核心价值集中在 `src/data/types.ts`。它实际上定义了一套可执行的战斗领域语言，而不仅是静态表格。

主要能力包括：

- `TriggerEvent`：命中、末段、重击、处决、技力恢复、状态施加/过期/消耗、动作开始、战斗开始等触发点；
- `EffectCondition`：敌我状态、生命值、失衡、连携冷却、终结技强化、技能冷却、动作连接消耗以及逻辑组合；
- `Effect`：状态、元素积蓄、反应、物理异常、额外伤害、持续伤害、技力、终结技能量、消耗与冷却；
- `PatchEffect`、`PatchHit`、`AppendEffect`、`PatchTick`：武器、天赋、潜能和装备对技能定义的补丁；
- `CombatSkillEntry`：分段、子技能、命中、触发器、被动效果、技力、终结技能量、强化、连携窗口和释放前提。

例如 `src/data/operators/chen-qianyu.ts` 不是只记录技能倍率，它同时描述：

- 普攻各段和各 hit 的时序；
- 普攻、连携、终结技命中如何给自己叠攻击层数；
- 战技如何施加物理异常；
- 敌人出现指定状态后如何开启 5 秒连携窗口。

`src/data/operators/perlica.ts` 则把末段触发连携窗口、连携施加导电反应等逻辑放进同一套定义。

这套做法的优点是：UI、技能库、引擎和测试共享同一份类型化事实。缺点是：事实主要依赖人工维护，原始数据来源、字段哈希和“当前无法确认”的边界不如 cleanroom 清晰。

### 4.2 数据收集与编译边界清楚

Endaxis 的大致流程是：

```text
干员 / 武器 / 装备 / 天赋 / 潜能定义
                 ↓
          data/collect.ts
                 ↓
      编辑器可放置的技能模型
                 ↓
       compileEndaxisScenario
                 ↓
         compileScenario
                 ↓
         compileTimeline
                 ↓
         SimulationEngine
```

其中：

- `src/data/collect.ts` 汇总当前队伍、武器、装备、天赋和潜能，并把补丁打到最终定义上；
- `src/stores/timeline/skillLibrary.ts` 把战斗定义转成可拖入时间轴的动作；
- `src/stores/timeline/resolveHits.ts` 解析技能等级、倍率、分段与命中；
- `src/simulation/compiler/compileTimeline.ts` 负责把编辑器动作转成实际模拟事件。

这一层次划分值得借鉴：编辑器数据不是直接喂给伤害公式，而是先编译成稳定的模拟场景。

### 4.3 模拟器是优先队列事件引擎

`src/simulation/engine/SimulationEngine.ts` 使用按时间排序的事件队列。事件处理器由 `src/simulation/engine/createEngine.ts` 注册，主要覆盖：

- 伤害命中；
- 动作开始与结束；
- 技力与终结技能量；
- 战斗开始；
- 连携冷却；
- 技力自然回复暂停；
- 失衡；
- 干员效果；
- 敌方效果、反应与持续伤害。

状态被拆为 Actor、Team、Enemy、OperatorEffect 等不同容器。`TriggerRegistry.ts` 再按照来源、技能类型、技能 ID、状态、时机和目标范围匹配触发器。

`HitHandler.ts` 的处理顺序很关键：

1. 读取命中当下的真实状态；
2. 执行伤害前效果；
3. 冲刷同帧强制消耗或新状态；
4. 重新计算攻击方和敌方属性；
5. 结算当前 hit；
6. 写入结构化伤害明细；
7. 执行伤害后效果与触发器。

这正是原 dmg-end-field 缺少、cleanroom 正在补齐的核心：Buff 不再是用户预先勾选的一组静态开关，而是当前 hit 到来时由状态机决定是否存在、剩余几层、属于谁、作用于谁。

### 4.4 敌方状态有明确的来源队列

`EnemyEffectHandler.ts` 处理元素积蓄、元素爆发、反应、物理异常、易伤、腐蚀和燃烧等状态。对于需要消费来源的机制，它维护明确的先进先出来源队列，并把额外伤害归因到真正的来源。

这是本项目非常值得吸收的思想：

- “破防有几层”不够；
- 还要知道每一层是谁、由哪个技能、在哪一个 hit 施加；
- 猛击、碎甲或其他消费发生时，必须能解释消费了哪一层、额外伤害归谁、剩余状态是什么。

cleanroom 已经在 `StatusEffectSystem` 和运行时上下文中保留 `source / owner / target / skill / cast / clock`，因此无需照抄 Endaxis 的实现，只需要把现有来源归因贯穿到所有物理异常与 UI 投影。

### 4.5 伤害公式输出结构化明细

`src/data/stats/computeDamage.ts` 不是只返回一个数字，而是把以下乘区与来源写成 `DamageBreakdown`：

```text
攻击力
× 技能倍率
× 伤害加成
× 外部加成
× 暴击期望
× 增幅
× 直接乘区
× 易伤/承伤
× 连携相关乘区
× 防御区
× 抗性区
× 失衡区
× 处决区
```

具体命名仍应以 AKE 原始语义和 Calc 观测结果为准，不能照搬 Endaxis 的术语；但“每个乘区都带来源列表”的结构非常适合解决当前 UI 中代码名、Buff 名、敌方 Debuff 和额外伤害解释不清的问题。

### 4.6 模拟事实与 UI 投影分离

Endaxis 没有让每个图表各自重算状态，而是从模拟日志投影出多个读取模型，例如：

- 技力曲线；
- 终结技能量曲线；
- 失衡曲线；
- 连携窗口；
- 敌方效果；
- 干员效果；
- 动作 Buff；
- 释放条件警告；
- 伤害归因和战斗日志。

这一点与 cleanroom 新增的 `akeRuntimeLedger.ts` 方向一致。正确的后续路线不是继续给 `SkillButton` 填更多临时字段，而是让按钮详情、hit 详情、主轴图标、伤害面板和日志都读取同一份事件账本的不同投影。

### 4.7 连携窗口被建模为普通状态

Endaxis 会把连携窗口编译成一个隐藏的普通状态，在触发事件时施加，超时后过期，连携动作开始时消费。随后 UI 再根据状态施加/过期日志投影出窗口条。

这个实现简单、统一，但并不完全适合本项目：

- cleanroom 的连携还涉及固定归属、动态归属、同帧 cohort、窗口选择策略、冷却和严格释放门控；
- 如果全部压成普通 Buff，容易丢掉“窗口候选”“选择哪个 pending”“消费策略”等领域语义。

因此应保留 `ComboTriggerMachine` 作为独立领域状态机，只把其生命周期事件投影成 UI 可见状态，不应为了代码统一而退化模型。

### 4.8 形态能力是通用定义，但仍有角色特例

Endaxis 支持 `forms`，可以根据属性条件把角色定义叠加成另一形态。这说明它没有把所有双形态都写死在组件里。

但当前数据中，真正使用 `forms` 的覆盖仍有限；代码还存在少量显式角色分支，例如莱万汀的终结技延长，以及洛茜完美时机状态的 UI 特判。

这给 cleanroom 的启示是：

- 通用 `SkillFormStateRegistry` 和状态驱动 `ChangeSkill / SwitchMode` 方向正确；
- 可以允许数据适配器描述特殊规则；
- 不应把干员 ID 分支扩散到运行时、投影器和组件三层。

### 4.9 Endaxis 前端成熟，但解决的是另一种轴

实际页面核对后，Endaxis 的编辑器结构清晰：

- 左侧：当前干员属性、武器、装备与技能库；
- 中间：四条干员轨道、传统横向时间尺、动作块和连接线；
- 右侧：当前技能属性；
- 底部：敌人状态、失衡、技力等资源曲线；
- 辅助区：分析、导出、显示、日志、资源监控和敌人配置。

它的可用性来源于完整工具链，不是某一个时间轴控件。用户可以选干员、拖技能、改属性、看资源、看警告、看日志、导出方案，形成完整编辑闭环。

但它仍是固定时间视觉模型：

- `src/utils/time.ts` 固定 `FPS = 60`；
- 所有时间会吸附到帧；
- 默认以约 50 px/s 映射时间，缩放范围约 15–1200 px/s；
- 普攻 3.327 秒、战技 0.83 秒等动作按真实持续时间占据对应的横向宽度；
- 战前准备区只是在视觉上做了折叠映射，并没有改变整个轴的时间语法。

这与 cleanroom 的共享变速轴有本质差别。cleanroom 需要的是：真实帧始终权威，但视觉列宽不等于真实持续时间；每列共享一个时间斜率，技能圆点、起止光标、hit 和能量条在事件列内部投影。

### 4.10 释放合法性是诊断，不是执行门禁

`evaluateSkillRequisites.ts` 明确把释放条件定位为诊断：不满足条件时记录问题，但为了兼容已有时间轴，模拟仍继续执行。`projectRequisiteWarnings.ts` 再把这些问题投影成 UI 警告。

这解释了一个重要差异：

- Endaxis 回答的是“如果按这条轴模拟，会发生什么，同时哪里看起来不合法”；
- cleanroom 要回答的是“这条轴是否真的能执行；如果不能，后续结果不能伪装成有效结果”。

对于本项目，必须继续坚持 strict 模式：

- 无验证器时为 `unverified`；
- 任一批次失败，整轴 `isExecutable = false`；
- 同帧 cohort 必须把资源成本合并后统一校验；
- UI 只显示预测结果时，必须明确标注无效或未验证，不能与有效结果混淆。

## 5. 三套系统逐层对比

| 维度 | Endaxis | ake-calc-cleanroom | dmg-end-field |
| --- | --- | --- | --- |
| 主要事实来源 | 人工类型化 TS 数据 | AKE 原始 JSON + 表 + Calc 用例 + 显式映射 | 用户/维护者手填角色、技能与 Buff |
| 数据可追溯性 | 代码审查可追踪，原始证据较弱 | 哈希、锁文件、公开快照、oracle 隔离较强 | 依赖维护者知识与版本管理 |
| 未确认语义 | 通常直接编码为定义 | `adapter-required / blocked / metadata-only / unverified` | 多数由用户启停或手工说明 |
| 动作模型 | 固定时间动作块 | 真实动作时序 + 共享变速视觉投影 | 栅格按钮与手工排轴 |
| 模拟模型 | 优先队列事件模拟 | 通用事件运行时 + AKE 编译器 + 严格准入 | 单次技能/命中伤害计算 |
| Buff 触发 | 命中时由触发器自动判定 | 目标也是命中时自动判定，仍在补全覆盖 | 主要由用户选择/启停 |
| 敌方状态 | 独立状态与来源队列 | 独立目标状态、来源/归属/时钟上下文 | 主要作为伤害输入或展示 Buff |
| 连携 | 隐藏状态 + 消费 + 冷却 | 独立通用状态机 + pending 选择策略 | 主要是按钮语义 |
| 技能形态 | 通用 form overlay，夹杂少量特例 | 通用 ChangeSkill/SwitchMode 注册表 | 依赖手工配置和 UI 选择 |
| 合法性 | 警告后继续模拟 | 严格 valid/invalid/unverified | 通常不判断真实释放可行性 |
| 伤害解释 | 结构化乘区与来源列表 | 运行时事件已有来源，UI 映射仍在收敛 | 单次报告解释成熟 |
| UI 投影 | 模拟日志投影出多种视图 | 已有统一 ledger 雏形，但仍有重复适配 | 各业务面板成熟，缺统一事件真相 |
| 数据编辑体验 | 代码内维护数据，编辑器内改队伍/装备 | 原始数据优先，覆盖层尚不完整 | 手工 Buff/配置编辑非常成熟 |
| 测试策略 | 全量角色 sweep + 公式 golden + 机制测试 | oracle 边界 + 通用单元测试 + 前端契约测试 | 产品工作流与领域测试较丰富 |
| 移动/分享 | 有查看与导出能力 | 继承原项目能力并处于适配中 | PWA、桌面、资源包和分享成熟 |

## 6. 应该借鉴什么

### P0：必须吸收

#### 6.1 建立稳定的“规范化战斗 IR”

AKE 原始 JSON 不应该直接渗入 React 组件；原 dmg 的手填 Buff 也不应该直接成为运行时事实。二者之间需要一层稳定、类型化、可审计的中间表示。

建议未来的单向链路为：

```text
AKE 原始数据 / Calc 行为样本 / 人工覆盖补丁
                         ↓
              Normalized Combat IR
                         ↓
              严格释放规划与事件编译
                         ↓
              Deterministic Runtime
                         ↓
                Runtime Event Ledger
               ↙          ↓          ↘
          主时间轴      技能详情      伤害/日志
```

这个 IR 可以借鉴 Endaxis `TriggerEvent / EffectCondition / Effect / Patch` 的覆盖能力，但字段必须来自 cleanroom 自己的语义映射，并保留：

- 原始文件与字段路径；
- 数据版本与哈希；
- 推导器版本；
- `verified / inferred / adapter-required / blocked`；
- 人工覆盖的原因和作用范围。

#### 6.2 让统一事件账本成为所有 UI 的唯一事实

当前 `demo/lts-ui/src/core/services/akeRuntimeLedger.ts` 已经朝这个方向迈出一步。后续需要明确禁止：

- SkillButton 自己推一次 Buff；
- 详情弹窗再推一次命中状态；
- 伤害面板从另一个计算器重算；
- 主轴标签按技能名猜破防、导电或附着。

统一账本至少需要输出：

- action committed / started / blocking ended / naturally ended；
- hit emitted / landed / missed；
- damage resolved，包含每个乘区与来源；
- status applied / stacked / refreshed / consumed / expired；
- resource spent / gained / reserved / rejected；
- form changed；
- combo window opened / selected / consumed / expired；
- command admitted / rejected / unverified。

主界面只投影关键状态；双击详情按当前 hit 的时间切片读取完整状态；伤害报告读取同一个 damage event，不再重算。

#### 6.3 增加全语料 runtime sweep

Endaxis 的 `runtimeSweep.test.ts`、`runtimeCoverage.test.ts` 和 `damageGolden.test.ts` 是非常值得借鉴的测试模式。

cleanroom 应建立三类自动检查：

1. 每个公开干员的每个可执行技能都能完成“解析 → 编译 → 调度 → 结算”；
2. 每个武器、装备、天赋和潜能的效果都至少能被编译，并明确报告未支持语义；
3. 选定的角色机制和公式建立 golden 用例，保证结果与 Calc 或已验证行为一致。

这些测试不要求每个动作都宣称 verified，但不允许静默丢失效果、产生 `NaN`、无限事件、异常长持续时间或无伤害伪动作。

#### 6.4 结构化伤害乘区和来源

每个 hit 的结果应直接携带：

- 基础面板来源；
- 技能倍率来源；
- 增伤、易伤、脆弱、抗性、减防等准确语义；
- 生效的 Buff/Debuff ID、中文名、图标和来源实体；
- 额外伤害、异常伤害、反应伤害的独立 hit；
- 状态消费前后快照；
- 被拒绝的候选效果及理由。

这样才能从结构上解决“现实静置到底是易伤还是脆弱”“猛击为什么没有独立 hit”“陈千语叠层为什么计算对但详情看不到”这类问题。

### P1：有选择地吸收

#### 6.5 编辑器工具，而不是 Endaxis 布局

可以借鉴的能力清单：

- 命中编辑器；
- 当前技能属性面板；
- 战斗日志与过滤；
- 资源监控；
- 敌方预设与自定义属性；
- 方案分析、导出和差异比较；
- 显示图层开关；
- 面向移动端的只读结果视图。

这些能力应该嵌入 dmg-end-field 的现有交互语言，而不是复制 Endaxis 的四栏暗色编辑器。

#### 6.6 数据补丁机制

Endaxis 用 Patch 修改 hit、tick 和 effect 的方式很适合武器、套装、潜能和天赋。但 cleanroom 的补丁必须是显式覆盖层：

- 不能修改原始快照；
- 必须记录适用版本；
- 必须记录目标路径和原因；
- 原始数据恢复可解析后，应能检测补丁是否已经过期。

## 7. 不应该照搬什么

### 7.1 不复制固定 60 FPS 的视觉时间轴

游戏数据内部可以有 tick/frame，视觉层却不应被固定 60 FPS 或固定 px/s 绑死。共享变速时间轴的核心决策继续保持：

- 真实帧权威；
- 视觉列是投影；
- 同列共享斜率；
- 技能按钮不按真实持续时间拉长；
- 起止光标、hit 和资源条表达真实时序；
- 等待、切人和封组是显式事件，不是空白像素。

### 7.2 不复制“非法但照算”的默认行为

可以提供一个单独的“假设推演/沙盒”模式，但默认轴必须严格。沙盒结果也必须带明显的非可执行标识，不可复用正常轴的绿色合法状态。

### 7.3 不把人工 TS 数据变成唯一真相

Endaxis 的人工数据很适合快速达到覆盖，但本项目已经付出了建立 cleanroom 证据链的成本。后续只能把人工内容放在可审计 patch 层，不能重新退回手填事实源。

### 7.4 不复制超大 Store 和超大组件

`timelineStore.ts`、`TimelineGrid.vue`、当前 cleanroom 的 `CanvasBoard/index.tsx` 与 `SkillButton.tsx` 都已经说明同一个问题：当调度、投影、拖拽、合法性、视觉和详情都集中在一个组件/Store 中，任何状态机修复都会变成 UI 回归风险。

后续应把边界固定为：

- domain：状态机与时间规则；
- compiler：原始数据到 IR、IR 到事件；
- runtime：只执行事件；
- projection：只生成读取模型；
- editor interaction：拖拽、选择、吸附；
- view：纯展示和轻量交互。

### 7.5 不扩散角色 ID 特判

角色特殊机制可以由数据适配器或受控插件描述，但 `if operatorId === ...` 不应出现在通用运行时、通用投影器和组件三层。所有临时特例都必须有：

- 对应未支持的通用语义；
- 删除条件；
- 覆盖测试；
- 不影响其他角色的作用域。

## 8. 推荐的目标架构

### 8.1 五层结构

```text
┌──────────────────────────────────────────────┐
│ 1. Evidence                                 │
│ AKE 原始快照 / Calc fixture / 哈希 / 版本锁  │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│ 2. Normalization                            │
│ Parser / Adapter / Patch / Provenance       │
│ 输出 Normalized Combat IR                   │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│ 3. Planning + Runtime                       │
│ 严格命令准入 / 共享时间 / 事件队列 / 状态机 │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│ 4. Ledger + Projection                      │
│ 不重算事实，只按时间切片生成多个读取模型     │
└──────────────────────┬───────────────────────┘
                       ↓
┌──────────────────────────────────────────────┐
│ 5. Product Shell                            │
│ dmg-end-field 配置、按钮轴、详情、报告、分享 │
└──────────────────────────────────────────────┘
```

### 8.2 当前模块与目标模块映射

| Endaxis 参照模块 | cleanroom 当前模块 | 后续决策 |
| --- | --- | --- |
| `data/types.ts` | AKE parser、`spec` 映射、前端领域类型 | 建立正式 Normalized Combat IR，不直接采用 Endaxis 类型 |
| `data/collect.ts` | `ake-scenario-assembler.mjs` | 扩展为队伍/loadout 编译器，保留来源证据 |
| `skillLibrary.ts` | AKE provider 与动作资料 | 技能库只读取 IR，不自行推导效果 |
| `compileTimeline.ts` | `akeRealtimeTimeline.ts` + action-tail planner | 严格时间规划与视觉投影分开 |
| `SimulationEngine.ts` | `combat-runtime.mjs` / scenario runner | 保留 cleanroom runtime，补全队伍级统一执行 |
| `TriggerRegistry.ts` | effect runtime + `combo-trigger-machine.mjs` | 统一触发 DSL，但保留独立领域状态机 |
| `HitHandler.ts` | AKE 命中/伤害执行链 | 建立唯一 Hit Settlement Pipeline |
| Enemy effects | status/reaction/poise 模块 | 补齐来源队列、消费与额外 hit 归因 |
| projection 系列 | `akeRuntimeLedger.ts` | 收敛成唯一投影入口 |
| `timelineStore.ts` | CanvasBoard + AKE adapters | 不复制；继续拆 Store、domain 和 view |
| fixed px/s grid | `sharedVariableRateTimeline.ts` | 保留 shared variable-rate 设计 |

## 9. 分阶段执行建议

### 阶段 A：先冻结契约，不改 UI

交付物：

- `NormalizedCombatDefinition` 契约；
- `RuntimeEventLedger` 契约；
- `DamageBreakdown` 契约；
- provenance 与 verification 状态；
- 一份从 AKE 原始技能到 UI hit 详情的端到端样例。

验收条件：同一事件无需 UI 二次推导，就能回答“谁在何时给谁施加了什么、当前 hit 吃到了什么、产生了哪些独立伤害”。

### 阶段 B：收敛时间与合法性真相

交付物：

- `sharedVariableRateTimeline.ts` 成为视觉列唯一时间来源；
- 根运行时成为状态与资源唯一事实来源；
- 移除固定 `0.5s/15 frame` 的常规节点假设；
- unresolved profile 只能产生明确诊断，不能静默固定时长；
- 强制等待、技力等待、切人、封组进入统一 planner。

验收条件：拖拽、自动吸附、强制等待和重新计算不会卡住 UI；同一动作在画布、详情和运行时有一致的起止时间。

### 阶段 C：统一命中与 Buff 状态机

交付物：

- damage-before / damage / damage-after 顺序固定；
- 干员、武器、三件套、蓝 Buff 和敌方状态都进入同一触发链；
- 破防、碎甲、猛击、物理异常、元素附着、导电、腐蚀、失衡和倒地都有来源、生命周期、消费和独立 hit；
- 双形态技能只通过通用状态变化选择实际 form。

验收条件：不增加角色 ID 特判，也能复现陈千语叠层、管理员强化战技、佩丽卡连携、庄方宜形态等机制。

### 阶段 D：建立 Endaxis 级覆盖检查

交付物：

- 全干员动作 sweep；
- 全武器/装备/天赋/潜能编译覆盖；
- 异常长持续时间、零伤害伪技能、缺命中、无限事件检测；
- 已验证角色循环的 golden 用例；
- 前端读取模型快照测试。

验收条件：每个未支持项都有稳定错误码和原始路径；任何丢失效果都不能仅靠人工点页面发现。

### 阶段 E：补成熟编辑器能力

在引擎与投影契约稳定后，再从 Endaxis 的能力清单中择取：

- hit 编辑器；
- 条件/状态日志过滤；
- 资源曲线；
- 方案差异分析；
- 敌人预设；
- 移动端只读分享。

这些能力应服从现有 dmg-end-field 交互框架，不能反过来把产品改造成 Endaxis 的固定横轴编辑器。

## 10. 当前最需要警惕的四个技术债

### 10.1 双重甚至三重计算真相

旧 dmg 计算器、根 AKE runtime、前端 AKE adapter 只要同时推导伤害或 Buff，就会出现“实际计算对、详情不对”或“主轴显示有、报告没有”。应尽快把所有 UI 计算降级为 ledger projection。

### 10.2 前端超大适配器

`akeRealtimeTimeline.ts` 已经承担动作资料、时间规划、连携窗口、资源预览和布局投影等多项职责。它应逐步拆为纯领域 planner、runtime bridge 和 visual projection，不能继续吸收角色机制。

### 10.3 文档与实现漂移

README 曾保留“每个节点固定 15 帧”的早期说明，而共享变速设计已经明确真实动作时序权威。所有仍把固定 0.5 秒当作常规动作时间的说明和 fallback 都应纳入审计。

### 10.4 许可证误判

Endaxis 当前没有明确许可文件。即使未来补充许可证，也必须单独评估是否兼容本项目的分发模式。在此之前，不把其代码或数据复制进 cleanroom，只允许：

- 观察公开界面行为；
- 比较抽象架构；
- 设计独立契约；
- 使用自己来源的数据重建功能；
- 把输出结果作为独立回归对照时，记录来源与版本。

## 11. 最终决策记录

1. **不迁移到 Endaxis。** 现有 cleanroom 的证据链、严格合法性和共享变速时间轴是更重要的差异化资产。
2. **不复制 Endaxis 前端。** 原 dmg-end-field 的交互框架继续作为产品基线。
3. **借鉴 Endaxis 的中间表示、事件模拟、统一投影、伤害归因和全量测试思路。** 实现必须独立编写，并保留 AKE/Calc 证据来源。
4. **把 Endaxis 作为完成度对照。** 每当新增干员机制、武器、套装、敌方状态或报告能力时，可用它检查“成熟项目通常覆盖了哪些层”，但不能把它当成语义权威。
5. **未来唯一事实链是：Evidence → Normalized IR → Strict Runtime → Ledger → Projection。** UI 不再拥有隐藏的第二套战斗规则。

## 12. 后续阅读入口

Endaxis 关键文件：

- `Endaxis/src/data/types.ts`
- `Endaxis/src/data/collect.ts`
- `Endaxis/src/data/operators/chen-qianyu.ts`
- `Endaxis/src/data/operators/perlica.ts`
- `Endaxis/src/simulation/compiler/compileTimeline.ts`
- `Endaxis/src/simulation/engine/SimulationEngine.ts`
- `Endaxis/src/simulation/engine/createEngine.ts`
- `Endaxis/src/simulation/engine/TriggerRegistry.ts`
- `Endaxis/src/simulation/events/HitHandler.ts`
- `Endaxis/src/data/stats/computeDamage.ts`
- `Endaxis/src/stores/timelineStore.ts`
- `Endaxis/src/components/TimelineGrid.vue`

cleanroom 对应入口：

- `src/core/combat-runtime.mjs`
- `src/core/ake-action-compiler.mjs`
- `src/core/ake-scenario-assembler.mjs`
- `src/core/ake-scenario-runner.mjs`
- `src/core/status-effect-system.mjs`
- `src/core/combo-trigger-machine.mjs`
- `src/core/skill-form-state-registry.mjs`
- `demo/lts-ui/src/core/domain/sharedVariableRateTimeline.ts`
- `demo/lts-ui/src/integrations/ake/akeRealtimeTimeline.ts`
- `demo/lts-ui/src/core/services/akeRuntimeLedger.ts`

原 dmg-end-field 对应入口：

- `src/core/domain/buff.ts`
- `src/core/services/skillButtonDamageCalculatorV2.ts`
- `src/components/OperatorConfig/`
- `src/components/CanvasBoard/`

本研究只形成方向和验收标准，不把 Endaxis 的任何源文件并入 cleanroom。
