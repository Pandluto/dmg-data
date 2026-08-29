# 引擎与前端对接架构:AKE 运行时 × LTS 水位轴工作台

> 本文日期:2026-08-28
> 覆盖代码:`demo/demo-service.mjs`(1,228 行)、`demo/server.mjs`(133 行)、`demo/lts-ui/src/integrations/ake/`(7 个文件,约 5,800 行)
> 前置阅读:[15 统一引擎与事件账本升级方案](15-unified-runtime-ledger-upgrade-plan.md)、[16 状态机、引擎与前端正确性专项研究](16-state-engine-ui-correctness-research.md)
> 本文回答一个问题:**前端(原 dmg-end-field 工作台)与 AKE 引擎的边界画在哪里,数据如何流动,为什么这样画。**

## 0. 读法

§1 是全文的纲:三条对接铁律。§2–§3 是服务端形态与 API 契约。§4 逐文件解剖前端适配层。§5 用一次完整的"计算伤害"旅程把链路串起来。§6–§9 是四个专题:预演、面板数值、共享变速水位轴、缓存失效。§10 是已知问题清单。

## 1. 对接铁律:谁算什么

demo 复用了 LTS(原 dmg-end-field,React 18 + TS + Vite + Tailwind + SQLite WASM)的完整产品壳:选择干员 → 干员配置 → 排轴画布 → 伤害报表。对接遵循三条边界(README.md:84、doc 15 ADR-5/6):

1. **战斗事实只有一个计算者:服务端引擎。** 前端不复制战斗公式、不重算伤害、不重建状态机。`demo-service.mjs:5-15` 直接导入根引擎的 `AkeScenarioAssembler`/`AkeSquadScenarioAssembler`/`runAkeScenario`/`runAkeSquadScenario`/`AkeDataRepository`/`projectAkeTimeline`。
2. **前端允许的本地计算只有两类**:①面板展示投影(LTS 自有的九字段面板链,只做显示对照);②实时预演(akeRealtimeTimeline,合法性门禁与视觉投影,结果明确标记为 predicted/unverified,不得冒充 executed)。
3. **Calc 只是开发期冻结边界的对照**,不是运行时依赖。线上链路的数值权威是 AKE 公开数据 + 本引擎。

这套边界是 doc 16 用七个探针换来的:此前前端存在四份并行真相(`fixedDummyStateMachine` 第二套数值引擎、`akeRuntimeLedger` 二次映射、`SkillButton` 静默回退旧计算器、预演状态冒充运行时),全部被收敛为"账本只读投影"。

## 2. 部署形态

| 形态 | 命令 | 服务方式 | 端口 |
| --- | --- | --- | --- |
| 开发 | `npm run demo` | `demo/lts-ui` 的 Vite dev server + `akeDemoMiddleware()`(`demo/lts-ui/vite.config.ts:58-111`)把 demo-service API 挂进 Vite | 43821 |
| 生产 | `npm run demo:build` + `npm run demo:serve` | `node demo/server.mjs`:静态页(`demo/lts-ui/dist`)+ AKE API 一体 | 43821(与 LTS 原端口 3030 分离) |

`demo-service.mjs` 是纯逻辑模块(不监听端口),两种形态复用同一份 API 实现。请求体上限 1MB(`server.mjs:45-58`);`DemoInputError` → 400,其余 → 500;未命中 API 的 GET/HEAD 回退 SPA `index.html`(`server.mjs:60-89`)。

## 3. 服务端 API 契约

| 方法与路径 | 处理函数 | 用途 |
| --- | --- | --- |
| GET `/api/health` | — | `{ ok, frontend:'lts-reuse', engine:'ake' }` |
| GET `/api/ake/catalog` | `getDemoCatalog()` | 干员/武器/装备/敌人目录 + timing 目录 |
| POST `/api/ake/squad/simulate` | `simulateSquadDemo()` | 1–4 人小队结算(前端实际使用) |
| POST `/api/ake/simulate` | `simulateDemo()` | 单角色旧接口(兼容保留) |

### 3.1 目录接口

`getDemoCatalog`(`demo-service.mjs:356-405`)返回 AKE catalog(`schemaVersion:2`、`tickRate:30`、`slotFrames:15`)+ timing 目录。timing 目录读 `derived/cleanroom/ake-timing-profiles.json` 经 `enrichAkeTimingWithHitMultipliers` 增补,并按文件 mtime/size/ino 签名缓存(`:362-384`)——重建后旧目录不会继续暴露过期 tick 数据。

### 3.2 小队结算接口(主链)

请求(`normalizeSquadRequest`,`:834` 起)核心字段:

- `members[]`(1–4):`characterId`、`level`、`skillLevels`、`weaponId`+`weaponSkillLevels`(编辑角色→物理槽位映射)、4 件 `equipment[]`(enhance 0–3)、`potentialLevel`;
- `commands[]`(≤320,必须绑定 `memberId`):`{memberId, frame, commandType}`;
- `endFrame`(上限 `MAX_TIMELINE_FRAME=108,000`,放宽原因是旧 1,800 帧守卫会让固定等待把 UI 卡死,`:30-33` 注释);
- `characterAttributes` / `equipmentPassives`:面板配置注入(见 §7)。

响应 `schemaVersion:3` 顶层结构(与 `runAkeSquadScenario` 输出对齐后经 `:1049-1228` 组装):

```text
profile          面板与配装摘要(含 panelAtk 与 runtimeAtk 显式分离)
skills           编译程序摘要(每个技能的编译状态/时间轴)
commands         settleCommands:requestedFrame vs actualFrame 对账、admissionReason
summary          totalDamage / DPS / durationSeconds(tickRate=30 换算)
finalState       HP、sharedAtb(全队共享 300 技力池)、各成员终极能量、poise 快照
resourceSeries   技力/能量时间序列
statusEvents     状态事件(带 Buff 语义展示名)
hits             每个 hit:伤害 + modifierSnapshot + operands + factors +
                 factorValidation + confidence
timeline         projectAkeTimeline 投影(命令/施放/伤害分段)
traces           commandTrace / admissionTrace / comboTrace 等
diagnostics      编译与运行时 unresolved、跳过原因
attributeSnapshots  面板属性来源
```

敌人 HP 固定 `1e12` 训练木桩,防止 `OnlyDead` 目标筛选分支干扰(`demo-service.mjs:25-28`)。

### 3.3 服务端缓存

bundle 按 assemble 参数签名缓存(`getBundle`,`:507-541`):同参数(角色/等级/武器/装备/潜能)的编译闭包只装配一次,命令变化不触发重编译。目录缓存见 §3.1;武器类型与干员匹配校验在 normalize 阶段完成。

## 4. 前端适配层逐文件

唯一新增前端计算层集中在 `demo/lts-ui/src/integrations/ake/`,共 7 个文件:

### 4.1 `akeCatalogAdapter.ts`(1,062 行)——目录接入

fetch `/api/ake/catalog` 后,用 `buildAkeOperatorLibrary/buildAkeWeaponLibrary/buildAkeEquipmentLibrary` 把 AKE catalog 转成 LTS 本地库写入 localStorage。缓存失效键 = **adapter 版本 @ catalog 版本 @ sharedRevision**(`:1043-1062`)——adapter 版本已从 v22 迭代到 v25,每次引擎侧目录 schema 变更(如连携规则 v5 加 eventTypes+conditions、comboPendingEvents v6)都强制旧浏览器丢弃缓存,防止旧结构被降格解释。

### 4.2 `akeProvider.ts`(1,035 行)——请求组装与报告

- **按钮映射**(`COMMAND_TYPE_BY_SKILL`,`:17-22`):LTS 的 `A/B/E/Q` → AKE 的 `Attack/NormalSkill/ComboSkill/UltimateSkill`;非映射按钮记入 `skippedButtonIds` 明示跳过,不静默丢弃。
- **prepareMember**(`:709-838`):从 LTS `TimelineData` 抽按钮序列、经 localStorage 武器库把 LTS 武器名映射到 AKE `weaponId`、等级/技能等级(未打开配置页时默认 12 级,因为 LTS 选人卡已是 Lv90/M3 基线,`:637-646`)、潜能、装备。
- **面板投影**:`panelAttackTrace`(`:783-813`)与 `damageBonuses`(`:686-700`,11 项:全伤/物理/灼热/电磁/寒冷/自然/法术/普攻/战技/连携/终结)。设计原则写在 `:873-880` 注释:**保留圆整后的本地面板与 AKE 运行时值分离**——旧映射曾用 runtime 数字覆盖面板数字,让 3328 的面板看起来像 3323 的计算误差。
- **runAkeTeamCalculation**(`:909-1004`):预演取每条指令的 `requestedFrame` → 推导 `endFrame`(投影末帧 + 300 尾帧,`:572-587`)→ POST → 组装 `AkeTeamReport`(每干员 `calculated/no-commands/unsupported/error` 四态)→ 存 sessionStorage(`def.ake-demo.latest-report.v3`)→ 派发 `def:ake-report-updated` 窗口事件。

### 4.3 `akeRealtimeTimeline.ts`(2,958 行)——前端预演模拟器

浏览器内对 AKE timing profile 做逐 tick 预演(`schemaVersion:2, source:'precompiled-local-preview'`):

- 维护 `ActorState`:USP、按 `cooldownGroupId` 的冷却(**不是** skillId,doc 17 §12.5 共享冷却投影)、技能形态 override、普攻段游标;
- 输出:带 `releaseVerdict(valid/queued/invalid/unverified)`、`admissionReason`、逐 hit `multiplier` 的 commands、`sharedAtb`、`ultimateSpPools`、`comboWindows`(含精准时机 `precisionWindow`)、`sharedVariableRateTimeline`、`comboPendingEvents`(v6:从隔离运行结果的 comboTrace 导出,含冷却旁路标记)。

CanvasBoard 用它做四件事:画布视觉投影、**释放门禁**(`akePlanAdmissionStatus` 非 valid 时禁用"计算伤害"按钮,`CanvasBoard/index.tsx:833-839, 4717-4725`)、普攻截断规划、endFrame 推导。

**预演与真实结算的边界**(doc 15 ADR-6):预演复用目录中的同一套 normalized 规则(冷却组、连携条件递归求值、形态事件),但它没有完整伤害明细,结果标记 predicted;服务端完整结果才是 executed;不支持的预演标 unverified,不制造 fake active status。已知残余差异:技能中途发生的 `SetSkillCdAtOnce` 动态冷却修改只以服务端 ledger 为准,预演不重放(doc 17 §12.5 结尾的收敛方向:让预演执行同一 normalized operation 或直接投影 runtime mutation)。

### 4.4 `akeRuntimeLedger.ts`——账本投影

doc 16 整改后已是纯投影:消费 report v3 的 hits/statusEvents/commands,持有 `pending/stale/rejected/partial/settled/manual-preview` 状态机判定报告有效性(executionDigest 口径),不再拼公式、不再猜 Buff 类型。

### 4.5 `akeActionTailAdapter.ts`(186 行)——动作接续契约

`akeProfileToActionTailContract` 把 AKE hit/resource/form 事件转成 `core/domain/combatActionTailPlanner.ts` 的动作接续契约,用于画布上"普攻被后续动作截断"的规划显示。

### 4.6 `AkeReportDrawer.tsx`(124 行)——AKE 实际时序抽屉

挂在伤害报表页(`DamageReportPptPage.tsx:43-44, 829-831, 924-942`)。内容:团队总伤害/韧性伤害/延迟输入/支持干员数;每干员配装摘要(面板 ATK 与配装)、DPS、逐指令列表(`F{requested} → F{actual}`、排队/过期/失败原因、`+delayF`、伤害、`reason/admissionReason`)、诊断行(编译未解析 N 项 / 运行时未解析 N 项 / 末态技力 / 终结技能量)。footer 明示:"本抽屉与主排轴使用同一次 AKE 小队结算;Calc 只作为开发期冻结边界的最终对照。"

### 4.7 旧链的处置

LTS 自带的旧伤害链(`skillButtonDamageCalculatorV2`/`buffPanelCalculator`/`buffZoneCalculator`)与 `fixedDummyStateMachine` 未删除,但执行权已被撤销(doc 16 §16):runtime 空值时不再静默回退旧计算器,而是显示错误;`SkillButton` 只渲染 read model。

## 5. 端到端数据流:一次"计算伤害"的旅程

```text
① 用户在 CanvasBoard 画布上排好 1–4 名干员的技能按钮
     │ (LTS TimelineData:按钮、时间、换人、等待列)
② 点击"计算伤害"
     │ 门禁:akeRealtimeTimeline 预演全部指令 releaseVerdict=valid
     │   → 否则按钮禁用,显示非法原因(不是算出假结果)
③ akeProvider.prepareMember 逐成员抽取配装
     │ LTS 按钮 → AKE commandType;LTS 武器名 → weaponId;
     │ ConfigSnapshot 面板数值 → 展示投影(不进请求)
④ 预演推导 endFrame(末帧+300)→ POST /api/ake/squad/simulate
⑤ 服务端:normalize → (缓存命中?) assemble → runAkeSquadScenario
     │ CombatRuntime 逐帧执行:准入→付费→施放→Hit→乘区→账本
⑥ 响应 report v3 → AkeTeamReport → sessionStorage + 窗口事件
⑦ 消费:主报表(总伤/DPS/占比) + AkeReportDrawer(逐指令时序)
     │ 画布:projectAkeTimeline 投影的施放段/hit 点/资源曲线
⑧ 用户拖动按钮 → 预演即时更新(validity 门禁) → 再次计算走 ③
```

关键点:**第 ⑧ 步的拖拽只触发预演重算(纯前端),完整结算只在用户点击计算时发生**——这是性能边界,与 doc 15 M6 的"拖一个按钮不重新解析语料"预算一致。

## 6. 预演 vs 结算:两套结果等级

| | 预演(akeRealtimeTimeline) | 结算(runAkeSquadScenario) |
| --- | --- | --- |
| 执行位置 | 浏览器 | 服务端 |
| 输入 | timing catalog(预编译 profile) | 完整 AKE bundle |
| 冷却/连携/形态 | 同一套 normalized 规则(目录 schema v5/v6) | 同一套规则 + 动态修改 |
| 伤害 | 无(仅 multiplier 标记) | 完整 factors + 复算校验 |
| 结果标记 | predicted / unverified | executed |
| 消费者 | 门禁、视觉投影、endFrame | 报告、抽屉、账本 |

规则同源由目录 schema 版本保证:生成器不解释角色机制,原样导出声明式 `eventTypes`/`conditions`/`comboPendingEvents`;未知条件或未知比较符在前端一律返回 false(fail closed,doc 17 §12.10)。

## 7. 面板数值与运行时数值分离

LTS 保留自己的面板计算链(`operatorPanelCalculator.ts` → `ConfigSnapshot`,九字段面板 + attackDetail/abilityDetail 全链),AKE 请求**只送 loadout**(等级/武器/装备/潜能),面板数值由服务端从 AKE 数据装配(`panelAtk`),LTS 面板结果作为展示投影并排显示(`runtimeAtk` 与 `panelAtk` 显式分离,`demo-service.mjs:1159-1168` 注释)。两套数字不一致时用户能看见差异,而不是被静默覆盖。条件型动态装备效果(无法映射到 AKE 语义的)明确保留为未接入项并显示,不伪造执行结果(README.md:84)。

## 8. 共享变速水位轴

水位轴(`core/domain/sharedVariableRateTimeline.ts`)是产品特色,对接中只做投影、永不改帧:

- **真实帧权威**:所有事件的 frame 来自引擎结算;
- **视觉列共享斜率**:列宽不是固定秒宽,同列动作共享时间斜率;
- **强事件边界**:cohort 边界由真实事件(施放开始/结束、hit)决定;
- 技能圆点、起止光标、hit 与资源条从同一帧投影(`akeRealtimeTimeline.sharedVariableRateTimeline` 与引擎 timeline 对齐);
- doc 15 M6 的约束:Endaxis 的固定 px/s 模型不引入;引擎升级不改变列宽/斜率/布局(doc 17 每节末尾都验证这一点)。

## 9. 缓存与失效总表

| 缓存 | 键 | 失效时机 |
| --- | --- | --- |
| 服务端 bundle | assemble 参数签名 | 进程内,参数变更自然失效 |
| 服务端 timing 目录 | mtime/size/ino 签名 | `npm run demo:build` 重建后自动失效 |
| 前端 AKE 本地库 | adapter 版本@catalog 版本@sharedRevision | 目录 schema 变更(adapter v22→v25) |
| 前端报告 | sessionStorage `def.ake-demo.latest-report.v3` | 新计算覆盖;`def:ake-report-updated` 通知 |
| LTS 配置页缓存 | sessionStorage OperatorConfigPageCache | 配置页编辑 |

## 10. 已知问题与收敛方向

对接层当前仍存在的问题(doc 15/16/17 记载,按优先级):

1. **预演与结算仍是两份执行**——规则同源但动态修改(技能中途 `SetSkillCdAtOnce`、runtime mutation)只在服务端生效。收敛方向:runtime 冷却 mutation ledger 直接流式投影给画布,或预演执行同一 normalized operation,删除轻量预演状态(doc 17 §12.5/§12.10 结尾)。
2. **报告身份(三级指纹)尚未落地**——doc 15 M1 的 `sourceDigest/scenarioDigest/executionDigest` 还未实现,输入变更后旧报告的失效判定依赖 `akeRuntimeLedger` 的状态机而非指纹比对。
3. **报告体积**——hits 携带完整 factors/contributions,大轴报告可观;doc 15 M4 规划的 summary/analysis 两档输出与 ID 去重尚未实现。
4. **主轴信息密度**——doc 15 M5 的"主轴只显示关键敌方状态、详情按 Hit 切片"的 UI 收敛是方向性规划,当前详情面板已完成 factor→来源→Buff 的跳转链,但布局改版未启动。
5. **PLC/画布双导入路径**——CanonicalScenario 统一输入是 M1 里程碑,当前画布是唯一入口。

这些问题都不改变一个事实:**对接边界的方向已经稳定**——前端做投影与交互,引擎做事实,账本做唯一展示事实。后续所有改进都在这条线内收敛。
