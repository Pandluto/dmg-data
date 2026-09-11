# 排轴执行顺序分离：施工任务

对应 [Spec](spec.md)。基线 `9ff9f94`；共同规格提交 `11ef693b867b83fb733db9db69c186eb8500a702`；状态：2026-09-12 已派发 A/B，实现进行中。任务打勾必须有对应提交与证据，派发不算实现完成。

## 分工与运行约束

| 责任人 | 既有任务 | 独立工作树 | 分支 |
| --- | --- | --- | --- |
| A：前端逻辑顺序与持久化 | 实现排轴阅读模式，`01a07602-198b-7573-9b51-15b32989b99b` | `/Users/sailstellar/.codex/worktrees/a548/dmg-timeline-order-frontend` | `codex/timeline-order-frontend` |
| B：小队输入与运行时调度 | 实现排轴批量选择与队尾删除，`01a07602-7aae-7f53-9d87-d74acbf5c20b` | `/Users/sailstellar/.codex/worktrees/b014/dmg-timeline-order-runtime` | `codex/timeline-order-runtime` |
| 主任务：设计、协调、审查与隔离集成 | 提升项目 UI 与机制，`01a06f92-30c4-7c91-bffc-497fa9aa3564` | 主库只写文档；业务集成使用另一个独立工作树 | 完成后记录 |

保留两个任务现有 GPT-6 / low 配置，不改模型，不另建任务。A/B 都从包含本 Spec/tasks 的同一提交起步，不从各自旧阅读/批量分支继续施工。

**绝对不要打开、重启或自动运行浏览器，包括 headless；不要导航/刷新当前页面；不要启动/终止/重启开发服务；不要给活动 RIA Session 发 snapshot/edit/recalculate 等命令。** 现有 Node 服务供其他地方使用。允许独立工作树的一次性 Node/类型检查、不监听端口的 SSR 检查及本地夹具执行。不得运行 `npm run demo`、浏览器 E2E、会监听端口的 preview 或自动连接活动工作区的脚本。

主库 `/Users/sailstellar/Documents/ChatGPT/dmg-data/ake-calc-cleanroom` 不得被两个任务写入、切分支或修改 node_modules；独立工作树单独安装依赖，不能通过共享的可写 Vite 缓存扰动服务。禁止 push、部署、清理旧任务/工作树、重写已有提交和改动用户存档。

## 固定共享合同

- 持久化：`TimelineData.operationSequence?: { schemaVersion: 1; operationIds: string[] }`，A 所有。
- 小队请求：`operationOrderVersion: 1`；每个 command/switch 带 `operationOrder`，A 产生、B 校验消费。
- 新字段名、版本、唯一性/安全整数规则、空轴与 v0 兼容见 Spec。B 不依赖 A 的 TS helper，不让根引擎 import 前端。
- 新请求完全不发 `timelineOrder`；历史 v0 只在 B 的兼容分支保留。两个字段同时出现不能静默择一。
- 逻辑序号不是事件优先级；不改时间、依赖解析、资源/伤害/暂停机制。
- 旧迁移以固定基线 provider → demo 规范化 → v0 runner 的实际调度为权威；旧预演冲突单列记录，新预演对齐该合同。A/B 共同核对初始调度与同来源依赖扇出的相等键 fallback，不能为迁移改变 v0 结果。
- 因为用户正在使用服务，不以在线端点拒绝 v1 作为回退旧字段的理由。实现分支用离线入口检查，隔离集成后验证两端合同。

共享合同有遗漏时向主任务发具体冲突、源码位置和推荐调整；继续不依赖该问题的工作，不擅自换字段或扩大功能。

## 主任务先行

- [x] P-01 提交 Spec/tasks/索引，记录共同起点；创建两个新工作树，保留各任务旧工作树。
- [x] P-02 向两任务派发职责、绝对路径、限制、验收和回传方式；不覆盖现有模型设置。
- [x] P-03 确认两任务收到并开始工作；A 已回传旧预演/执行排序冲突，B 已回传初始及依赖候选 fallback 核对。两任务继续各自范围，迁移权威已按 ORDER-02 统一。

## A：前端逻辑输入、预演及存档

### A-01 梳理像素参与决策的完整路径

- [ ] 核对 `akeProvider.ts` 的两处 timelineOrder、`akeRealtimeTimeline.ts` 中 replacementApplies / validateDodgeControlModules，以及 `operatorControlTimeline.ts` 全部查询与校验。
- [ ] 核对 `useCanvasDrag.ts` 所有 controlledOperatorAt 调用，区分鼠标命中和语义准入；搜索潜在别名，不能只搜字段名后机械替换。
- [ ] 在自己的 `implementation-frontend.md` 记录“旧输入 → 逻辑解释 → 候选/预演 → provider → 摘要/存档”的调用入口，列出哪些旧节点字段仍有分组/队列语义。

交付条件：指出所有 AKE 准入路径的像素依赖及其替代数据，不更改与本轮无关的阅读样式。

### A-02 实现唯一的操作序列 Module

- [ ] 在 `demo/lts-ui/src/core/domain/timelineOperationSequence.ts`（及必要的独立 legacy Adapter）实现纯读取校验、旧序列转换、已知编辑的增删维护与 id→order 查询；可调整内部命名，外部数据合同不变。
- [ ] 在 `types/index.ts` 增加 Spec 的持久化字段；技能、切人、等待、闪避等 ID 全覆盖，同一列表里不得漏项、重项或出现未知 ID。
- [ ] 新建空序列、追加新 ID、删除合法集合、恢复原序列分别表达。读取损坏的 v1 拒绝；不能用通用 reconcile 掩盖持久化缺失。
- [ ] 对旧输入建立确定的兼容路径，包括零时长控制两侧及相等排序键；固定旧逻辑并产出序号，不能调用当前 Canvas 或动态显示参数来排序。
- [ ] 用旧 provider → demo → v0 runner 的实际调度核对迁移；不要采用旧预演的 characterId 排序作为兼容权威。与 B 对照两处 fallback，旧预演差异写入 implementation 文档；如静态序无法表达，回传最小反例和第一处分歧。
- [ ] 一次读取生成内存迁移副本，之后让该工作副本沿业务编辑保存新字段；不得随重绘重新从坐标推导。旧原对象和已保存节点不被直接改写。

交付条件：纯模块可从普通 JSON 输入生成确定序列；旧同帧切人/技能先后可对照，有歧义时给出具体迁移诊断。

### A-03 把逻辑序贯通预演和主控判断

- [ ] 利用 sharedVariableRateTimeline 的 schedule/preliminary 阶段提供真实帧、操作身份及逻辑序，materialize/压缩/分页只追加几何结果。不要复制完整求时器。
- [ ] 新 AKE 主控查询使用 `{frame, operationOrder, phase: 'before' | 'after'}` 或等价清楚的数据 Interface；覆盖查询切人自身、两个同帧切人、同帧普攻及瞬时 B 替代。
- [ ] AKE 预演准入不再读取 startX/endX/projectSharedTimelineFrame 的结果；多个待用输入同帧时也使用统一逻辑序。
- [ ] 拖入先命中语义候选，再给草稿生成逻辑位置；取消不改真实序列。保留原队尾限制和无浏览器原生拖动规则。
- [ ] 如旧 DEF/显示查询确实仍需要坐标，隔离命名和调用范围；不能通过保留一个默认坐标分支让 AKE 继续落回旧规则。

交付条件：改变显示宽度和元素位置不改变控制权、瞬时替代与可释放判断。

### A-04 维护写入、恢复和文件兼容

- [ ] 核对 `core/services/timelineService.ts` 中创建、增加、修改、尾删、批量删与拆段联动写入，在公共业务路径维护序列，避免在 repository 增加计算/渲染副作用。
- [ ] 核对实际 reducer / CanvasBoard 原子编辑和撤销路径是否绕过 service；必要时同步同一 helper，禁止多套排序。
- [ ] `platform/timeline/timelinePayloadCompatibility.ts` 硬重建 TimelineData 时保留字段；`utils/timelineSnapshotStorage.ts` 的导入导出/恢复、`integrations/ake/akeWorkspace.ts` 和 payload validator 如有白名单同步保留。
- [ ] 读取旧节点时保留旧节点，编辑/保存后才形成新工作副本版本；新旧 payload 均能 v2 文件往返。不改 SQLite 表、不重写旧 sealed Run。
- [ ] 在隔离内存/临时 SQLite 检查保存/打开、节点恢复、批量删除/撤销及空文档。禁止用户库和当前 RIA 会话。

交付条件：序号不是只活在 React 内存；保存、刷新加载所走的纯存储路径和撤销不会丢顺序。

### A-05 请求与有效输入身份

- [ ] `akeProvider.ts` 发出 operationOrderVersion=1，所有可执行 skill/switch 的 order 来自同一已校验序列，不发 timelineOrder；必要时抽纯请求构造 helper 便于离线核对。
- [ ] `akeExecutionIdentity.ts` 升级合同身份，使用规范化业务输入，保留真实分组/关系/队伍配置；排除 DOM、压缩/分页、位置、纯派生行号、时间戳和批注。
- [ ] 保持既有取消/过期响应和跨工作区报告隔离；新逻辑序变更应使旧报告失效。
- [ ] RIA 的前端输入观察如需补充，记录同一序列/版本；不复制或伪造引擎状态。

交付条件：同一业务输入多种显示得到相同请求与摘要；改变操作先后或依赖则不同。

### A-06 有针对性的检查和交付

- [ ] AC-01/02/03/06/07/08 的离线前端检查；围绕纯 Interface 保留必要反例。
- [ ] `npm --prefix demo/lts-ui run typecheck`；相关 `run-ts-test.mjs` 明确指定模块，不跑浏览器测试。
- [ ] `git diff --check`；审查未触碰 UI 样式、用户存档和主库。
- [ ] 在 `docs/specs/timeline-execution-order/implementation-frontend.md` 记录提交、检查、旧输入差异、尚未浏览器验收及对 B 的接线要求；提交自己范围并回传主任务。

**A 可写：** `demo/lts-ui/src/` 中上述逻辑/类型/存储/调用接线及对应定向检查、自己的 implementation-frontend.md。样式/图标/图片、引擎 src/core、demo/demo-service.mjs、源数据/生成数据、Spec/tasks 主文不可写。扩大到其他生产路径先向主任务说明具体必要性。

## B：根引擎与版本化输入

### B-01 集中解析新版操作顺序

- [ ] 在 `src/core/ake-operation-order.mjs` 或等价纯 Module 解析 v1/v0，形成可供 runner 调度使用的顺序查询。新旧合同分开，不能给旧输入默认追加版本。
- [ ] 校验 operationOrderVersion、命令/切人联合 ID 和联合序号；空列表合法；safe integer/重复/缺失/混用失败。
- [ ] v1 不因数组顺序和成员名变化而重排；同帧、同批次按显式序号。v0 保留现有默认技能=0、切人=-1及旧相等键/数组规则的实际行为，先读源码后固化。
- [ ] 向 A 和主任务提供 demo / runner 命令规范化、初始调度与依赖候选的缺省键及相等键规则；确认它们能否由同一个静态序列表达，不以旧预演排序替代。

交付条件：直接使用 runner 也受同一校验，不能只在 HTTP 入口保护。

### B-02 贯通服务输入与执行

- [ ] `demo/demo-service.mjs` 的小队输入规范化保留顶层版本和每个序号，API 输入错误保持可读；旧请求归一化逻辑不变。
- [ ] `runAkeSquadScenario` / `AkeSquadScenarioRunner.run` 接受新顶层字段并贯通，检查所有 service/worker/RIA 调用点，不能在重组对象时丢字段。
- [ ] 新输入不进入旧 memberId tie-break；保证直接调用、demo adapter 和记录后重放读到相同合同。
- [ ] 如 trace/report 需要附加 order/version，只加可追溯元数据，完整保留旧运行记录；按实际 schema 白名单同步，不重建无关产物。

交付条件：纯 demo service 路径和直接 runner 得到同一同帧顺序，不启动 HTTP 服务验证。

### B-03 替换调度比较键，保持事件因果

- [ ] 审查 `normalizedCommands`、`controlAndCommands`、`resolveReleaseDependencies`，v1 在各处使用同一序号合同；不要只改 initial sort。
- [ ] 按帧优先，已有事件相位优先；同来源、同刻到达的多个后继按序号，零偏移后继仍在来源事件之后。
- [ ] 多个来源事件在同帧先后发生时，不让尚未 ready 的后继抢先；不以全局排序重写 pendingEvents 既有优先级。
- [ ] 保留来源失败/未命中/循环/越界拒绝、动作队列与真实时钟语义。技能优先级、资源、伤害和控制规则本身不改。

交付条件：同帧切人先/后两种输入体现各自主控；后继身份明确且不会提前改变历史。

### B-04 历史兼容与两条真实轴

- [ ] 读取但不改写 `fixtures/ria/lastrite-tangtang-status-provenance.json` 和 `fixtures/ria/wulfa-camille-appended-ultimate.json`；用基线离线执行记录实际操作/命中/状态/资源摘要，不从旧文档抄期望假装实测。
- [ ] v0 基线与修改后保持一致。v1 对照使用明确序号另建输入；前端完整迁移由 A 提供后，再在隔离集成时确认相同序列。
- [ ] 前端旧预演与 v0 实际调度不一致时，以实际调度作迁移对照，并在实现记录中单列预演变化；不能为了兼容两种旧顺序悄悄修改 v0。
- [ ] 复用 `test/ake-controller-state.test.mjs` 的 before/after 同帧切人场景，扩充 v1 与乱序数组；复用释放依赖场景检查同来源扇出及零偏移。
- [ ] 只为新合同添加必要错误样本与接口往返检查，既有机制不扩大为全角色审计。

交付条件：不是总伤相等就通过；发现首个事件差异则说明原因并报告主任务。

### B-05 检查与交付

- [ ] 离线 Node 定向检查（顺序/控制/释放依赖与实际改动涉及的 demo/RIA 输入）；不跑全套长审计、不启动 RIA server、不调用活动服务。
- [ ] `git diff --check`，检查引擎无前端 import、无新像素字段。
- [ ] 在 `docs/specs/timeline-execution-order/implementation-runtime.md` 留输入合同、提交、执行差异、检查及已知边界；提交自己范围并回传主任务。

**B 可写：** `src/core/ake-operation-order.mjs`、`src/core/ake-squad-scenario-runner.mjs`、`demo/demo-service.mjs`、确有转发必要的 `src/ria/` / `demo/ake-*` 路径、相应 `test/` 与新增版本化小夹具、自己的 implementation-runtime.md。不得改前端 src、既有 fixture 原文、源数据/技能语义/生成报告或 Spec/tasks 主文。根层其他生产改动先向主任务说明。

## 主任务后续：审查与隔离集成

- [ ] I-01 收两任务提交/证明与偏离点，检查它们使用同一字段/版本；不要把旧分支所有历史改动一起合并。
- [ ] I-02 将 A/B 指定提交合到新的隔离集成工作树，保留现有服务器的主库业务代码原样；冲突按 Spec 裁决。
- [ ] I-03 检查 A 的真实请求经 B 的服务/runner/RIA 入口往返；重读原小型 fixture 和合成存档序列，完成 AC-01 至 AC-11 相关离线检查。
- [ ] I-04 扫描像素进入准入/输入的残留路径，区分合法渲染、明确 legacy 兼容与错误新路径；核对稳定排序字段进入摘要和存档。
- [ ] I-05 回填 Spec/tasks 的实现与证据，不将 AC-12 浏览器验收标成通过。向用户交付可合并提交、结论与未覆盖项；主库/服务接入按运行约束另行协调。

## 回传格式

给主任务 `01a06f92-30c4-7c91-bffc-497fa9aa3564` 发一条简洁消息：工作树与分支、提交 hash、实现合同、通过检查、发现的差异/阻塞、未运行项目（必须注明未浏览器验证）。完整细节写自己的 implementation 文档。该回传沿用用户授权的既有任务协作，不向外部消息应用发送信息。

主任务收到回传后再安排隔离集成，不要求实现任务持续轮询主任务。遇到另一个任务接口未完成时先完成自己的离线范围，不能临时启动主库服务来凑通路。
