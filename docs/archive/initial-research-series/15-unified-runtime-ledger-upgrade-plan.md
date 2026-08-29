# dmg-data 统一引擎与事件账本升级方案

> 方案日期：2026-08-27
> 方案范围：ake-calc-cleanroom 引擎、状态机、输入加载、运行报告和 dmg-end-field 交互壳
> 本文只定义升级路线与验收门槛，不包含本轮代码实现

## 1. 升级目标

本次升级不以“再补几个角色机制”为目标，而是把项目从拼接式 Demo 升级成一条可审计、可回放、可解释的统一战斗链。

目标链路只有一条：

    原始输入
      ↓
    Canonical Scenario
      ↓
    Normalized Combat IR
      ↓
    Strict Planner + Deterministic Runtime
      ↓
    Runtime Event Ledger
      ↓
    UI Read Models

升级完成后，需要同时满足：

1. 同一份 PLC 与同一份画布能生成相同的规范化场景；
2. 每个状态转换只有一个执行器；
3. 每个 Hit 的全部乘区、来源和状态切片由服务端一次性给出；
4. 主轴、技能详情、伤害报告和战斗日志读取同一份事件账本；
5. 缺失数据、默认值、推断和部分执行都必须显式可见；
6. 共享变速时间轴继续作为核心交互，不退回固定秒宽横轴；
7. 原 dmg-end-field 的成熟配置和报告体验继续保留。

## 2. 两份研究合并后的判断

新审计报告与 Endaxis 对比研究指向同一个根因：当前项目的问题不是公式数量不够，而是事实被拆成了多份。

目前至少存在以下并行真相：

- PLC 原始输入；
- 当前画布和 local storage 重建的输入；
- akeRealtimeTimeline 的预览状态；
- AkeActionCompiler 编译出的动作；
- CombatRuntime 的状态；
- 原始 Buff lifecycle；
- AkeDamageResolver 的有限乘区；
- akeRuntimeLedger 的二次映射；
- SkillButton 中的演示状态。

这些对象之间没有一个完整的身份、因果和来源契约，因此会出现：

- 页面能显示，但显示的不是刚导入的场景；
- Buff 已识别，但没有进入伤害；
- 伤害实际已变化，但详情没有来源；
- 状态转换计算了一次，预览又计算一次；
- 报告存在，但因为输入不匹配被 UI 静默丢弃；
- unresolved 只剩总数，无法知道具体影响哪个 Hit。

Endaxis 值得吸收的正是“类型化定义 → 事件模拟 → 统一日志 → 多视图投影”这一闭环。它的固定 60 FPS 横轴、诊断后继续模拟、人工 TypeScript 数据真相和现有源码都不属于本项目的升级方向。

## 3. 六项架构决策

### ADR-1：所有输入先进入 Canonical Scenario

PLC、当前画布、测试 fixture 和以后可能接入的其他分享格式，都不能直接调用 AKE provider。

每种来源只负责转换为同一个 CanonicalScenario。后续编译器和运行时不需要知道输入来自 PLC 还是 React 画布。

CanonicalScenario 至少包含：

    schemaVersion
    scenarioIdentity
    clock
    target
    globalRules
    actors
    loadouts
    commands
    sourceEvidence
    normalizationWarnings

每个 CanonicalAction 至少包含：

    actionId
    sourceTrackId
    actorId
    sourceTick
    runtimeFrame
    originalSkillId
    normalizedSkillId
    genericActionType
    normalizationStatus
    sourceOrder
    rawReference

normalizationStatus 只能是：

- exact：原始技能身份完整；
- inferred：按有证据的规则推断；
- generic：只能确认普攻、战技、连携或终结技类别；
- missing：无法确定；
- skipped：输入明确要求忽略；
- unsupported：身份已知，但当前引擎不支持。

generic 和 missing 不能伪装为 exact。

### ADR-2：采用三级指纹，不再只比角色 ID

单一 inputFingerprint 不足以区分原始文件、规范化语义和运行环境。建议建立：

| 指纹 | 内容 | 用途 |
| --- | --- | --- |
| sourceDigest | PLC 原始字节或画布持久化快照 | 证明输入来源没有改变 |
| scenarioDigest | 排序、正规化后的语义场景 | 判断两种导入路径是否表达同一场战斗 |
| executionDigest | scenarioDigest + AKE 数据哈希 + mapping 版本 + compiler/runtime 版本 | 判断某份报告是否仍可显示为当前有效结果 |

UI 只有在 executionDigest 完全一致时，才能显示“当前运行结果”。

如果不一致，应显示具体原因：

- 队伍变更；
- 敌人变更；
- 装备或技能等级变更；
- 命令时间变更；
- 数据版本变更；
- 引擎版本变更。

不能继续返回 null 或只写 console。

### ADR-3：状态转换必须是单一事务

猛击当前同时存在 ApplyCombatStatus shortcut 与原始 buff_physical_try_crushed lifecycle，两者必须收敛。

推荐方案不是删除原始数据，而是：

1. AkeActionCompiler 将原始 Buff 分支编译成 NormalizedCombatStatusDefinition；
2. CombatStatusResolver 只执行这一份定义；
3. 原始 try Buff 不再作为第二条并行执行路径；
4. 派生 Hit、状态消费、晶体破碎、打断等子动作仍来自原始数据编译结果；
5. 所有未支持子动作挂在同一事务的 unresolved 列表中。

统一事件建议为：

    CombatStatusResolution
      eventId
      commandId
      castId
      statusKey
      sourceId
      ownerId
      carrierId
      targetId
      damageSourceId
      before
      requested
      consumed
      applied
      finished
      after
      branch
      reactionHitIds
      unresolved

猛击的 apply 与 consume-and-react 只是同一状态机的两个分支，不能再由 preview、runtime 和 UI 分别判断。

### ADR-4：伤害乘区使用语义键，不使用中文标签猜测

建立 DamageFactorRegistry，负责：

    AKE raw attribute / processor
      → semantic factor key
      → composition rule
      → applicability
      → verification
      → UI label

第一批稳定 semantic key：

- attack；
- skillMultiplier；
- criticalExpectation；
- attackerDamageBonus；
- damageTaken；
- physicalVulnerability；
- defenderDamageZone；
- weakness；
- defense；
- resistance；
- amplify；
- link；
- imbalance；
- execution；
- special。

其中 physicalVulnerability 对应 PhysicalVulnerableDmgIncrease。Defender NormalCalcZone 在完成真实 fixture 校准前，先使用中性的 defenderDamageZone，不应直接猜成“脆弱”或“易伤”。

每个 DamageFactor 必须包含：

    key
    operation
    baseValue
    additiveValue
    scale
    appliedToFormula
    verification
    sources[]
    blockedReason

每个 source 必须包含：

    sourceId
    ownerId
    carrierId
    targetId
    damageSourceId
    buffId
    buffInstanceId
    rawSemantic
    contribution
    activeAtHit

UI 的中文名称来自统一映射表，数学路径不能由中文名称反推。

### ADR-5：运行时事件账本是唯一展示事实

报告升级为 schemaVersion 3。它不再只返回 compact hits 和 statusEvents，而是返回一份带因果关系的 RuntimeEventLedger。

账本至少包含：

- ScenarioAccepted / ScenarioRejected；
- CommandAdmitted / CommandRejected / CommandUnverified；
- ActionStarted / ActionBlockingEnded / ActionNaturallyEnded；
- HitEmitted / HitLanded / HitResolved；
- StatusApplied / StatusStacked / StatusRefreshed / StatusConsumed / StatusExpired；
- CombatStatusResolved；
- EffectSourceActivated / EffectSourceFiltered / EffectSourceUnresolved；
- ResourceSpent / ResourceGained / ResourceReserved；
- FormTransitioned；
- ComboWindowOpened / ComboWindowSelected / ComboWindowConsumed / ComboWindowExpired；
- RuntimeDiagnostic。

所有事件使用：

    eventId
    causationId
    correlationId
    scenarioDigest
    commandId
    castId
    frame
    clockDomain
    source / owner / carrier / target / damageSource

DamageHitResolved 必须直接携带完整 DamageBreakdown。前端可以格式化，不得重新计算最终伤害。

### ADR-6：实时预览复用同一内核，只允许结果等级不同

预览仍然需要，否则拖拽体验会变差。但预览不能拥有另一套状态规则。

正确方式：

- planner、preview 和完整模拟复用相同的 command admission、resource、cooldown、combo window 与 combat status reducer；
- preview 可以裁剪高成本的完整伤害明细；
- preview 结果标记为 predicted；
- server 完整结果标记为 executed；
- 不支持的预览只能标记 unverified，不能制造一个 fake active status；
- UI 不把 predicted 与 executed 状态混在同一个标签列表中。

## 4. 目标模块结构

建议新增或收敛为以下边界：

    src/
      importers/
        plc/
          plc-container-reader.mjs
          plc-scenario-importer.mjs
        canvas/
          canvas-scenario-importer.mjs
      contracts/
        canonical-scenario.mjs
        normalized-combat-ir.mjs
        runtime-event-ledger.mjs
        damage-factor-snapshot.mjs
      core/
        combat-status-resolver.mjs
        damage-factor-registry.mjs
        runtime-ledger-writer.mjs
        scenario-fingerprint.mjs
      projections/
        timeline-projection.mjs
        hit-detail-projection.mjs
        status-projection.mjs
        resource-projection.mjs
        diagnostic-projection.mjs

前端建议形成：

    demo/lts-ui/src/
      integrations/ake/
        akeScenarioClient.ts
        akeReportV3.ts
      read-models/ake/
        timelineReadModel.ts
        hitDetailReadModel.ts
        statusReadModel.ts
        diagnosticReadModel.ts
      components/CanvasBoard/
        继续保留现有产品组件

现有模块的去向：

| 当前模块 | 升级后职责 |
| --- | --- |
| akeProvider.ts | 只负责当前 UI → CanonicalScenario 客户端调用，不重建隐含默认值 |
| demo-service.mjs | 校验 canonical schema、执行编译和运行、返回 ledger v3 |
| ake-action-compiler.mjs | 原始 AKE → Normalized Combat IR |
| combat-runtime.mjs | 执行事件，不负责 UI 标签和输入默认值 |
| status-effect-system.mjs | Buff instance 生命周期与基础堆叠 |
| combat-status-resolver.mjs | 猛击、碎甲等跨状态事务 |
| ake-damage-resolver.mjs | 收集语义因子并生成 DamageBreakdown |
| akeRealtimeTimeline.ts | 逐步拆为 planner bridge 与 visual projection |
| akeRuntimeLedger.ts | 迁移为纯 report v3 → read model，不再拼公式或猜 Buff 类型 |
| SkillButton.tsx | 只渲染 read model，不判断运行时状态 |

## 5. 分阶段升级路线

### M0：冻结基线与修测试入口

目标：在改变行为前，先建立可信的回归门。

工作内容：

1. 分开根引擎 JavaScript 测试、前端 TypeScript 测试和端到端测试；
2. 修复 node --test 无法发现 TypeScript 测试的问题；
3. 把当前 59 个聚焦 AKE/runtime 测试加入独立脚本；
4. 保存三个垂直基线：
   - ATK 719 / 倍率 3.5 / DEF 100 / 暴击期望截图基线；
   - 大潘首次猛击；
   - 大潘已有破防后的猛击反应；
5. 保存 PLC 原始文件的 sourceDigest 和已解析元数据快照；
6. CI 分别报告 harness failure、compile failure、behavior failure。

退出条件：

- 根引擎测试入口可重复；
- 前端测试入口可重复；
- 测试框架失败不会被统计成伤害行为失败；
- 三个基线在升级前被固定。

这一阶段不修业务行为。

### M1：Canonical Scenario 与输入身份

目标：先保证比较的是同一场战斗。

工作内容：

1. 实现 PLC1 header + gzip payload reader；
2. 实现 PLC → CanonicalScenario importer；
3. 实现当前画布 → CanonicalScenario importer；
4. 保留 Rodin、enemyLevel、initialAtb、criticalMode、simulatePoise、四名角色、装备、潜能、技能等级和全部 140 actions；
5. action 按 sourceTick 排序，但保留 sourceOrder；
6. 缺失 skillId 逐条标记 exact/inferred/generic/missing；
7. 生成三级指纹；
8. server report 回传 normalized scenario summary 与 warnings；
9. UI 增加“当前结果/过期结果/输入不完整”提示。

退出条件：

- PLC 导入后仍是 4 tracks、140 actions、Rodin、initialAtb 200；
- 不再默认替换成 Mimic 或 ATB 300；
- 当前画布与 PLC 表达相同语义时 scenarioDigest 一致；
- report 不匹配时 UI 显示原因，而不是静默消失；
- 任一默认值都能在 diagnostics 中找到。

### M2：统一战斗状态事务

目标：消除猛击和物理状态的多重真相。

第一条垂直切片只做 crush/no_guard：

1. 将 buff_physical_try_crushed 编译成 NormalizedCombatStatusDefinition；
2. 新增 CombatStatusResolver；
3. 禁止同一次 CrushAction 同时走 shortcut 与 raw try Buff；
4. 输出 before/requested/consumed/applied/after；
5. 反应伤害生成独立 reactionHitId；
6. no_guard 的消费数量来自同一事务；
7. crystal break、interrupt、time stop 等未支持子动作挂在事务 diagnostics；
8. preview 调用同一个 reducer，不再合成第二份 no_guard。

crush 稳定后，再迁移：

- fracture；
- lift/knock-up；
- elemental attachment；
- electrification；
- corrosion；
- imbalance/down；
- crystal break。

退出条件：

- no_guard=0 + Crush 只产生 0→1，不产生反应 Hit；
- no_guard=1/2/3/4 + Crush 的消费和派生 Hit 可追踪；
- 每个派生 Hit 引用唯一 CombatStatusResolution.eventId；
- 同一 command 不出现重复状态应用；
- preview 与 executed 的分支一致。

### M3：语义伤害因子与完整 DamageBreakdown

目标：让“识别到 Buff”和“进入公式”成为同一个可审计过程。

工作内容：

1. 建立 DamageFactorRegistry；
2. 接入 PhysicalVulnerableDmgIncrease；
3. 为 Defender NormalCalcZone 保留独立因子；
4. 用真实 AKE fixture 校准 WeaknessDmgScalar / FinalMultiplier；
5. 将 attack、crit、defense、resistance、damage taken、vulnerability、weakness、zones 等统一生成 factors；
6. 每个 factor 输出 sources、activeAtHit、appliedToFormula、blockedReason；
7. calculateDamage 只消费已排序的 factor snapshot；
8. 运行后校验 factors 的乘积能够复算 nonCrit/crit/expected；
9. 删除 UI 中硬编码的 vulnerability 1.000。

退出条件：

- PhysicalVulnerable +20% 单独用例确实改变伤害；
- Defender zone 单独用例只改变自己的因子；
- Weakness 单独用例数值与真实 fixture 一致；
- 两个目标侧因子同时存在时独立相乘且来源不重复；
- UI 展示的每个数字都能定位到 server factor；
- 不再通过 side === Defender 猜中文 Buff 类型。

### M4：Runtime Event Ledger v3

目标：服务端输出足够完整的事实，让 UI 停止二次推理。

工作内容：

1. 定义 ledger v3 schema 与 JSON schema 校验；
2. 所有运行时事件分配 eventId、causationId 和 correlationId；
3. command、cast、status transaction、hit 和 factor 建立引用；
4. 每个 action/hit/status 输出 Applied、PartiallyApplied、Unresolved、Skipped 或 PreviewOnly；
5. unresolved 从总数展开到具体 source path 和受影响 Hit；
6. 报告携带三级指纹；
7. 提供 summary 与 analysis 两种 detailLevel；
8. 对大报告使用按 ID 去重的 source/status 表，避免每个 Hit 重复完整对象；
9. 提供 v2CompatProjection，只做结构转换，不允许重新计算数值。

退出条件：

- 点击猛击状态可以跳到派生 Hit；
- 点击 Hit 可以看到状态前后和全部来源；
- 任一未支持 SkillSetting 可以定位到 action → Buff → Hit；
- v2 与 v3 双跑期间，已支持基线的最终伤害一致；
- v3 能独立生成主轴、详情、报告和日志读取模型。

### M5：UI 收敛到只读投影

目标：保留 dmg-end-field 的交互优势，删除 UI 隐藏规则。

主界面只显示用户已经确定的关键状态：

- 破防层数与碎甲；
- 导电；
- 元素附着；
- 必要时失衡/倒地；
- 命令 invalid/unverified；
- predicted 与 executed 的差异。

双击技能后的中间区域：

- “命中状态”撑满原“已选 Buff”区域；
- 切换不同 hit 时，以该 hit 的时间切片显示 active、applied、refreshed、consumed、expired；
- 重要敌方状态优先；
- 其次按目标/自身、来源角色、装备、天赋、潜能分组；
- 每个 factor 显示值、来源、是否进入公式；
- 额外伤害、猛击、碎甲、晶体破碎和反应伤害作为独立 hit；
- PreviewOnly 与 RecognizedButNotApplied 明确使用不同视觉。

错误与过期状态：

- report 指纹不匹配时显示差异；
- 自动计算失败时在工作台显示错误；
- PartiallyApplied 不得显示为完整成功；
- unresolved 节点保留占位和原因；
- 不再只写 console.error。

退出条件：

- SkillButton 不再推导破防、导电或易伤；
- akeRuntimeLedger 不再硬编码任何伤害公式；
- preview-only 状态不会与 runtime active 状态混淆；
- 用户可以从公式因子追到 Buff、来源角色和原始数据路径；
- 主轴信息密度降低，但详情信息更完整。

### M6：共享变速轴与实时性能收尾

目标：统一引擎后不牺牲当前交互的实时性。

加载策略：

1. 原始 147 MB AKE 语料只在构建/同步阶段解析；
2. 生成按角色、武器、装备、敌人分块的编译索引；
3. 运行时只加载当前队伍依赖闭包；
4. 编译缓存 key 使用 data hash + loadout + mapping version；
5. 拖一个按钮不重新解析原始 JSON。

重算策略：

1. 从最早变更 frame 开始增量重放；
2. 在动作边界保存 runtime checkpoint；
3. 同一拖拽过程只保留最新 generation；
4. 旧请求使用 AbortController 取消；
5. UI reducer 不等待网络或运行时 Promise；
6. forced wait、lane wait、switch 和 seal group 都进入同一 planner；
7. 视觉投影保持纯函数。

共享变速轴继续遵守：

- 真实帧权威；
- 视觉列不是固定秒宽；
- 同列共享时间斜率；
- 技能圆点、起止光标、hit 与资源条从同一帧投影；
- 等待是显式事件；
- 无验证器时为 unverified；
- cohort 资源合并后统一校验。

退出条件：

- 加入、删除、拖拽一个动作不会重新解析全量语料；
- forced wait 不会卡死实时计算；
- 连续快速拖拽只提交最新结果；
- 同一事件在轴、详情和报告中的 frame 一致；
- 四人 140 action PLC 在可接受交互延迟内完成重算；
- Endaxis 的固定 px/s 模型没有被引入。

### M7：全量覆盖与旧链删除

目标：从 Demo 走到可持续演进。

工作内容：

1. 全干员每个动作做 parse → compile → simulate sweep；
2. 全武器、装备、套装、天赋、潜能做 effect coverage；
3. 增加异常检测：
   - NaN；
   - 无限事件；
   - 无来源状态；
   - 异常长持续时间；
   - 零伤害伪技能；
   - 有 Buff 无 factor；
   - 有 factor 无 source；
4. 建立选定角色循环 golden tests；
5. 精确 PLC 做最终端到端 golden；
6. 删除 report v2、fixed dummy 状态推断、UI 公式硬编码和不再使用的兼容入口；
7. 更新 README 与架构文档。

退出条件：

- 所有公开动作都有 Applied 或明确 unresolved；
- 没有静默空 Buff definition；
- 完整测试入口稳定；
- exact PLC 的输入、动作、命中、状态和伤害可以逐项审计；
- 旧的第二套数值真相已经删除，而不是长期隐藏在 feature flag 后。

## 6. 推荐实施顺序

严格依赖顺序：

    M0 测试基线
      ↓
    M1 输入身份
      ↓
    M2 状态事务
      ↓
    M3 伤害因子
      ↓
    M4 事件账本
      ↓
    M5 UI 收敛
      ↓
    M6 性能与共享轴
      ↓
    M7 覆盖与删除旧链

M2、M3 和 M4 的接口可以先共同设计，但行为实现不要并行散开。第一条完整垂直切片应当是：

    PLC/fixture 输入
      → 大潘 NormalSkill
      → 已有 no_guard
      → Combo 触发 Crush
      → CombatStatusResolution
      → 消费层数
      → secondary physical Hit
      → DamageFactorSnapshot
      → Ledger v3
      → 技能详情 UI

这条切片同时检验输入、状态、派生 Hit、伤害来源与 UI。它跑通后再扩到所有角色，比逐角色补 if 更可靠。

## 7. 建议拆分的变更包

为了降低回归风险，建议按以下独立变更包推进：

| 变更包 | 内容 | 不应包含 |
| --- | --- | --- |
| 01-test-baseline | 测试入口、基线 fixture、PLC digest | 行为修复 |
| 02-contracts | CanonicalScenario、Ledger v3、DamageFactor schema | UI 改版 |
| 03-plc-importer | PLC 与 Canvas importer、三级指纹 | 状态机修复 |
| 04-report-identity | server 回传 identity、UI 过期提示 | 伤害公式变更 |
| 05-combat-status | crush/no_guard 唯一事务 | 全角色特例 |
| 06-damage-factors | vulnerability/zone/weakness 与 breakdown | 页面布局重构 |
| 07-ledger-v3 | 事件因果、诊断、兼容投影 | 删除 v2 |
| 08-ui-read-models | 主轴与详情只读 v3 | 新状态推理 |
| 09-runtime-performance | 编译索引、缓存、checkpoint、取消旧请求 | 机制改动 |
| 10-coverage-cleanup | sweep、golden、删除旧链 | 新功能扩张 |

每个变更包都必须有独立测试和回滚边界。

## 8. 验收矩阵

新报告提出的 A–N 用例全部保留，并增加系统级门槛。

### 输入与身份

- PLC sourceDigest 稳定；
- scenarioDigest 对 action JSON 存储顺序不敏感，对时间/配置变化敏感；
- executionDigest 对 AKE 数据版本和 mapping 版本敏感；
- UI 不显示属于其他 digest 的 report；
- 默认 enemy、ATB、critical mode 和 poise 设置全部可见。

### 状态事务

- 首次猛击只上破防；
- 已有 1–4 层时消费数量准确；
- 派生 Hit 与状态 event 同一因果链；
- 同帧、刷新、过期、来源切换可追踪；
- 多角色面对同一敌人时共享目标状态；
- source/owner/carrier/target/damageSource 不混淆。

### 伤害因子

- ATK 719 基线仍得到 1258 / 1887 / 1289；
- PhysicalVulnerable +20% 能改变伤害并显示来源；
- Defender zone 与 Weakness 可单独测试；
- 两因子同时存在时独立组合；
- factor product 可复算 final damage；
- 未应用来源显示 blockedReason。

### UI

- 主轴只显示关键状态；
- 详情能按 hit 切换；
- 每个因子、状态和额外 Hit 可互相跳转；
- PreviewOnly、RecognizedButNotApplied、PartiallyApplied 与 Applied 视觉不同；
- report 过期与自动计算失败可见；
- UI 不含硬编码 1.000 公式。

### 端到端 PLC

- 四角色与 Rodin 完整保留；
- initialAtb=200；
- 140 actions 全部有 normalization status；
- 53 个缺失 skillId 不被伪装；
- action 时间排序正确且保留 sourceOrder；
- recordFullDamageEvent 和 recordFullBattleEvents 生效；
- 每个被跳过或部分执行的 action 有明确诊断；
- 可逐 Hit 与外部 Calc 同输入结果对拍。

## 9. 迁移与兼容策略

### 9.1 v2/v3 双跑只作为短期影子模式

升级期间可以让同一 canonical scenario 同时生成 v2 与 v3，用于比较：

- 命中数量；
- 总伤害；
- 状态数量；
- 命令成功/失败；
- 资源最终值。

但只允许 v3 成为新 UI 的数值事实。v2CompatProjection 只能把 v3 结构转成旧 ViewModel，不得再次计算伤害。

双跑必须有明确删除里程碑，不能演变成第三套永久逻辑。

### 9.2 保留原 dmg-end-field 产品壳

以下交互不应因引擎升级而推倒：

- 干员、武器、四件装备配置；
- 主轴按钮语法；
- 双击技能详情；
- Buff/伤害解释的整体信息架构；
- 工作节点、持久化、分享和 PWA；
- 当前共享变速轴视觉方向。

改变的是数据来源和读取模型，不是产品骨架。

### 9.3 手工覆盖进入 Patch 层

任何人工修正都必须记录：

- patchId；
- 目标 raw path；
- 适用数据版本；
- 修正原因；
- verification；
- 删除条件。

不能直接改同步的原始 JSON，也不能把临时角色特例放进 UI。

## 10. 性能预算与防卡死要求

这套升级会增加事件和来源信息，必须同时限定性能：

| 项目 | 预算原则 |
| --- | --- |
| 原始数据解析 | 构建/同步阶段完成，交互阶段禁止全量解析 |
| 单动作拖拽 | 只重放最早受影响 checkpoint 之后的事件 |
| UI 渲染 | 读取 memoized read model，不遍历 147 MB 数据 |
| report | 来源和状态表去重，Hit 只引用 ID |
| 旧请求 | 新 generation 出现后立即取消或丢弃 |
| forced wait | 纯 planner event，不触发递归 state update |
| 大 PLC | 按 action/cast/hit 建索引，详情按需读取 |

必须增加以下性能回归：

- 10、50、140 action 的重算；
- 单动作拖拽连续 30 次；
- forced wait 插入、修改、删除；
- 四名干员同帧 cohort；
- 120 秒轴打开技能详情；
- 大量 status events 下切换 hit。

## 11. 风险控制

### 风险 1：一次重写过大

缓解：用垂直切片和 v3 兼容投影迁移，不先重写整个 CanvasBoard。

### 风险 2：通用状态机过度抽象

缓解：先用 crush/no_guard 验证事务契约，再抽取 fracture、元素和失衡共性；不预先设计一个包办所有机制的万能 DSL。

### 风险 3：术语再次映射错误

缓解：semantic key 与中文 label 分离；未验证的 Defender zone 先显示中性名称和 raw source。

### 风险 4：报告体积过大

缓解：事件/source/status 规范化存储、ID 引用、summary/analysis 两档输出。

### 风险 5：实时体验下降

缓解：预编译索引、依赖闭包缓存、checkpoint 增量重放、请求取消和纯投影。

### 风险 6：Endaxis 代码许可不明确

缓解：只借鉴抽象设计与测试思想，不复制其代码或数据。

## 12. 明确禁止的做法

升级过程中禁止：

1. 为陈千语、管理员、大潘等逐个增加 UI 特判；
2. 在 React 组件里补伤害公式；
3. 通过 Buff 中文名猜乘区；
4. 继续静默使用 Mimic、ATB 300 或其他默认值；
5. 把 preview status 当成 runtime status；
6. Buff definition 缺失时返回无诊断空对象；
7. 只修最终数字，不输出来源；
8. 只修 UI 文案，resolver 仍不读取对应属性；
9. 只修 resolver，report 与 UI 仍拿不到 factor；
10. 长期保留 v2、v3 和 preview 三套状态真相；
11. 将 Endaxis 固定 60 FPS 横轴迁入当前画布；
12. 在 exact PLC 回放完成前宣称整套引擎已经复现 Calc。

## 13. 完成定义

项目只有同时达到以下条件，才能从“最佳 Demo”进入“可持续的完整模拟器”阶段：

- 任一输入都能生成可审计 CanonicalScenario；
- 任一运行报告都能证明自己属于哪个输入和数据版本；
- 任一 command 都有明确准入结果；
- 任一状态转换只有一个事件真相；
- 任一 Hit 都有完整 factor snapshot；
- 任一 factor 都有来源、应用状态和阻断原因；
- 任一 UI 数字都来自 report，而不是组件内推导；
- 任一 unresolved 都能定位到 action、Buff 或 Hit；
- 四人 PLC 能完整导入并逐项审计；
- 测试入口稳定并覆盖全语料；
- 旧的固定 dummy、硬编码公式和重复状态路径已删除；
- 共享变速时间轴仍保持真实帧权威和交互实时性。

## 14. 第一轮实际开发建议

如果下一轮开始落实，建议只做 M0 + M1，不同时触碰状态机和 UI 布局：

1. 修测试脚本分层；
2. 固定三个行为基线；
3. 定义 CanonicalScenario 与三级指纹；
4. 实现 PLC 和 Canvas 两个 importer；
5. server 回传 normalized input 与 warnings；
6. UI 增加 report identity/过期原因；
7. 用四人 PLC 验证 4 tracks、140 actions、Rodin 和 initialAtb 200。

完成这一步之后，我们才真正拥有“同一场战斗”的实验基线。第二轮再做 crush/no_guard 垂直切片，第三轮做伤害 factor 与 ledger v3。这个顺序能避免再次出现基础输入已经不同，却在后面反复修公式和标签的情况。

## 15. 研究来源

本方案综合：

- 用户提供的 dmg-data 引擎、状态机、UI 与加载链路研究报告；
- docs/14-endaxis-comparative-architecture-study.md；
- 当前 b97ff73 引擎与前端代码；
- 陈管潘循环轴 PLC 的已解析基线；
- 当前共享变速时间轴设计文档；
- Endaxis 的公开架构与测试模式。

本方案不复制 Endaxis 源码，也不把外部项目的具体公式当作 AKE 的事实来源。
