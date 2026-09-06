# RIA 快速开始

以下命令由 `test/ria-doc-examples.test.mjs`、REST/SSE 契约测试和真实 runtime replay 测试覆盖。所有服务默认只监听 `127.0.0.1`。

## 记录第一个 Run

在仓库根目录创建 Case 和 Session：

```bash
npm run ria -- case create --case-id combo-investigation --title "共享连击消费调查" --json
npm run ria -- session create --case-id combo-investigation --session-id session-before-fix --summary "冻结修复前行为" --json
npm run ria -- session append --case-id combo-investigation --session-id session-before-fix \
  --type thread-link --content "Codex 调查任务" \
  --thread-id TASK_ID --thread-source codex-desktop --json
npm run ria -- session append --case-id combo-investigation --session-id session-before-fix \
  --type decision --content "先冻结修复前 Run" --json
```

显式记录仓库内的小型真实 fixture：

```bash
npm run ria -- record \
  --case-id combo-investigation \
  --session-id session-before-fix \
  --run-id run-before-fix \
  --fixture fixtures/ria/pelica-normal-skill.json \
  --json
```

输出包含真实 `runId`、status、event count、content hash 和 normalized result hash。成功执行只有显式 `record/run` 才保存；通过 RIA 执行但失败的计算会自动保存为 `interrupted` Run。

## 启动结构化查询服务

```bash
npm run ria:server -- --port 43822
```

检查版本和能力：

```bash
curl -sS http://127.0.0.1:43822/api/ria/health
curl -sS http://127.0.0.1:43822/api/ria/capabilities
curl -sS http://127.0.0.1:43822/api/ria/openapi.json
```

列出证据：

```bash
curl -sS "http://127.0.0.1:43822/api/ria/cases"
curl -sS "http://127.0.0.1:43822/api/ria/cases/combo-investigation/sessions"
curl -sS "http://127.0.0.1:43822/api/ria/runs?caseId=combo-investigation"
curl -sS "http://127.0.0.1:43822/api/ria/runs/run-before-fix/manifest?caseId=combo-investigation"
```

## 实时订阅与断线续传

新订阅：

```bash
curl -N "http://127.0.0.1:43822/api/ria/runs/run-before-fix/stream?caseId=combo-investigation&afterSequence=0"
```

从已确认的 sequence 120 继续：

```bash
curl -N -H "Last-Event-ID: 120" \
  "http://127.0.0.1:43822/api/ria/runs/run-before-fix/stream?caseId=combo-investigation"
```

SSE 使用事件 sequence 作为 `id`。record/replay 在 Worker 中执行，并通过持久化 checkpoint 保证实际计算尚未完成时主线程已经可以发送多个 runtime event。sealed completed/partial Run 发送 `run-complete`，interrupted Run 发送 `run-interrupted`，随后关闭。正常写缓冲背压会等待 drain；超时的慢消费者才会关闭，客户端用最后确认的 `Last-Event-ID` 重连，不需要轮询图片。

## 四类直接证据查询

查询共享连击何时获得、刷新、消费或过期：

```bash
curl -sS \
  "http://127.0.0.1:43822/api/ria/runs/RUN_ID/events?caseId=CASE_ID&eventType=TeamComboGrant,TeamComboRefresh,TeamComboConsume,TeamComboExpire&afterSequence=0&limit=1000"
```

查询某个动作的输入类型和有效结算类型：

```bash
curl -sS \
  "http://127.0.0.1:43822/api/ria/runs/RUN_ID/events?caseId=CASE_ID&rootCastId=ROOT_CAST_ID&eventType=DamageHit&limit=1000"
```

返回事件的 `inputCommandType` 是按钮输入，`effectiveSkillType` 是结算身份；两者不会互相覆盖。

查询 root action 与 derived child cast：

```bash
curl -sS \
  "http://127.0.0.1:43822/api/ria/runs/RUN_ID/events?caseId=CASE_ID&rootCastId=ROOT_CAST_ID&childCastId=CHILD_CAST_ID&limit=1000"
```

查询第 210 帧的可证明状态和证据范围：

```bash
curl -sS \
  "http://127.0.0.1:43822/api/ria/runs/RUN_ID/state?caseId=CASE_ID&frame=210"
```

所有事件过滤可组合：`afterSequence`、`fromFrame`、`toFrame`、`eventType`、`actorId`、`targetId`、`rootCastId`、`childCastId` 和 `limit`。frame 上下界均包含，page 返回稳定的 `nextCursor / readCursor / nextAfterSequence / hasMore`，以及 byte/record 扫描诊断。下一页可直接传回 cursor：

```bash
curl -sS \
  "http://127.0.0.1:43822/api/ria/runs/RUN_ID/events?caseId=CASE_ID&cursor=OPAQUE_NEXT_CURSOR&limit=100"
```

## 重放与 first divergence

CLI 同步重放 sealed Run：

```bash
npm run ria -- replay \
  --case-id combo-investigation \
  --run-id run-before-fix \
  --replay-run-id run-before-fix-replay \
  --json
```

REST 接受异步受控 replay，只能读取已存 fixture 的白名单 adapter；请求体不接受 command/shell：

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"replayRunId":"run-before-fix-replay"}' \
  "http://127.0.0.1:43822/api/ria/runs/run-before-fix/replay?caseId=combo-investigation"
curl -sS "http://127.0.0.1:43822/api/ria/jobs/run-before-fix-replay"
```

比较修复前后：

```bash
npm run ria -- diff --left-run-id run-before-fix --right-run-id run-after-fix --json
curl -sS \
  "http://127.0.0.1:43822/api/ria/diff?leftRunId=run-before-fix&rightRunId=run-after-fix&leftCaseId=combo-investigation&rightCaseId=combo-investigation"
```

diff 分字段报告 fixture、executable、recorder、rules、data、Node/platform/arch、Git commit、tracked diff、status 和 untracked execution content 是否相同；任一执行环境字段不同，`environment.identical` 都是 false。随后返回 normalized event/result 的 `firstDivergence` 和前后上下文。时间戳、Run identity、event sequence 和 native event ID 等运行容器噪声不会制造假分歧。

## 从发现到关闭 Case

推荐流程：

1. 创建 Case；描述现象与证据边界。
2. 创建 before-fix Session，保存最小 fixture 和 sealed Run。
3. 用 REST/CLI 引用具体 sequence、Hit、root/child cast 写结论；聊天只保存决策摘要。
4. 修改现有 runtime，不在 RIA 中实现规则。
5. 创建 after-fix Session，使用相同 fixture 记录 Run。
6. 检查 fixture/environment equality、first divergence、断言和完整 `verify`。
7. 用 `finding` 关联 before/after Run，用 `commit-link` 关联实现提交，再追加关闭决策。
8. 关闭 Case，并把 before/after Run ID 写入 resolution。

```bash
npm run ria -- session append --case-id combo-investigation --session-id session-before-fix \
  --type finding --content "修复后不再串线" --run-id run-after-fix \
  --related-run-id run-before-fix --relation fix-verification --json
npm run ria -- session append --case-id combo-investigation --session-id session-before-fix \
  --type commit-link --content "实现提交" --commit GIT_COMMIT --json
npm run ria -- session entries --case-id combo-investigation \
  --session-id session-before-fix --limit 100 --json
```

```bash
npm run ria -- case close \
  --case-id combo-investigation \
  --resolution "run-before-fix → run-after-fix；first divergence 为 TeamComboConsume sequence 842" \
  --json
```

存在 unsealed Run 时 Case 不能关闭。Case 关闭后，Session create/append、record、run、replay 和 UI action 都返回 `RIA_CASE_CLOSED`；当前没有隐式 reopen。

## 浏览器开发者调试接口（自动连接）

运行 `npm run demo`，或 `npm run demo:build` 后运行 `npm run demo:serve`，在 Chrome 打开 `http://127.0.0.1:43821/#/timeline`。本机 AKE Demo 自动创建浏览器 Session；每次计算创建独立 Run。无需手工修改 sessionStorage，也无需另开 43822 服务。服务只接受 loopback 和同源访问。

能力发现与浏览器列表：

```bash
curl -sS http://127.0.0.1:43821/api/ria/live/capabilities
curl -sS http://127.0.0.1:43821/api/ria/live/sessions
```

每个浏览器 Session 都有独立的 `sessionId`、`caseId`、连接时间和状态。15 秒没有收到心跳会标为离线；后台标签页可能被 Chrome 节流，查看时应结合 `lastSeenAt`。只操作明确选中的 Session，不能默认把历史记录当作当前页面。

```bash
curl -sS "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/snapshot"
curl -sS "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/snapshot?section=planner"
curl -sS "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/events?kind=interaction&afterSequence=0&limit=100"
curl -sS "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/events?kind=network&runId=RUN_ID&limit=100"
```

快照包括六个部分：

| section | 内容 |
| --- | --- |
| `workbench` | 工作区、checkout、干员、技能按钮、配装和 Buff |
| `timeline` | 当前完整排轴输入、主控、输入身份 |
| `planner` | 请求/预演帧、释放判定、冷却、资源、连携窗口、吸附分组与坐标 |
| `calculation` | 当前 Run、结算摘要、命令和诊断 |
| `inspection` | 所选动作/事件、同帧顺序、活动状态、命中索引 |
| `ui` | 当前路由、焦点、可见控件、选中/禁用状态和位置 |

事件记录点击、双击、右键、选择、快捷键、拖动起终点与时长、应用状态操作、console、错误、请求响应状态。状态事件保存发生变化的快照部分，可还原一次移动前后的排轴。每条记录有服务端 `sequence` 和浏览器 `clientSequence`；重试批次不会重复记账。计算事件保留触发它的浏览器操作序号和独立 `runId`。

实时视图不复制巨大运行时报告。每个实时事件最多 128 KB、每个快照部分最多 512 KB，超过时明确返回 `truncated / originalBytes`；浏览器缓冲最多 2000 条，溢出会记录丢失数量。完整输入、结果、逐帧状态、伤害 factor 和因果事件保存在对应 Run，使用本指南前面的 `events / state / result / replay / diff` 接口。实时观察记录在 `artifacts/live/SESSION_ID/`，服务器重启后仍可查询；它们属于浏览器观察，不是 sealed 引擎事实。

让同一个 Chrome 页面定位动作、打开详情或重新计算：

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"op":"inspect-command","commandId":"BUTTON_ID"}' \
  "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/commands"
curl -sS "http://127.0.0.1:43821/api/ria/live/sessions/SESSION_ID/commands/COMMAND_ID"
```

支持 `inspect-command`、`open-details`、`set-panel`（`tools` / `combat`）、`recalculate`、`snapshot`、`workspace-snapshot` 和 `edit-timeline`。命令只作用于目标 Session，页面回传 `done / error`；`recalculate` 回执表示已安排重算，完成情况应继续查计算事件及 Run。接口不执行任意 JavaScript、shell 或绕过工作区规则修改业务数据。Chrome DevTools 也可用 `window.__AKE_DEBUG__.status()`、`.snapshot()` 和 `.flush()` 查看连接/上传错误、当前快照或主动上传。

`edit-timeline` 使用画布现有的工作台命令队列进行可复现实验，必须指定当前活动 `timelineId`，且画布已挂载。添加动作必须属于当前队伍与技能目录；回执包含实际按钮 ID 和落点。`staffIndex` 是从零开始的画布组号，`nodeIndex` 是组内节点号，角色行由 `characterId` 决定；持久化时转换为角色行和全局节点号。每个请求的队列 ID 和按钮 ID 固定，重试消费不会重复添加。移除只接受具体按钮 ID。请求、结果和随后的轴变化都会进入会话日志。

可选 `releaseAnchor` 使用现有关系轴模型（`group-start/action-start/action-end/damage-hit`），来源必须是当前轴上的已有动作。例如在普攻偏移 44 帧的真实命中后 1 帧插入战技：`{"schemaVersion":1,"kind":"damage-hit","sourceButtonId":"普攻按钮 ID","sourceHitId":"planner 中该命中的 ID","sourceHitOffsetFrames":44,"debounceFrames":1}`。命中锚点必须同时保留命中 ID 与偏移，以满足存档的关系完整性校验。节点坐标只负责画布布局，不能代替战斗释放关系。

```json
{ "op": "edit-timeline", "timelineId": "活动文档 ID", "edit": { "kind": "add", "characterId": "chr_0027_tangtang", "runtimeSkillId": "chr_0027_tangtang_normal_skill", "staffIndex": 1, "nodeIndex": 3 } }
```

```json
{ "op": "edit-timeline", "timelineId": "活动文档 ID", "edit": { "kind": "remove", "buttonId": "添加回执中的 buttonId" } }
```

### 存档与版本状态

`workspace-snapshot` 是只读命令，在选人、存档、配置和报表页面均可调用。
不传 `timelineId` 时返回活动工作副本；传入某个已存在文档 ID 时读取它的已保存 checkout。
返回完整 payload（队伍、武器装备、输入与释放锚点）、活动文档身份、SQLite checkout、文档列表和节点父子关系。
可比较返回的 `checkout` 与 `documentCheckout`，核对 renderer 与数据库是否指向同一版本。
单次命令结果上限 4 MiB；连续事件和 UI 快照仍使用各自的较小限额。

```json
{ "op": "workspace-snapshot", "timelineId": "已有文档 ID，可省略" }
```

### 图片加载与绘制耗时

`snapshot?section=ui` 包含当前图片的真实 `src`（使用 `currentSrc`）、解码状态、
自然/显示尺寸、`loadState`（`deferred/requested`）和最近的资源耗时。
`inViewport` 表示矩形与页面视口相交；滚动容器内是否开始加载以 `loadState` 和真实请求为准。
URL 去除查询串，data/blob 图片仅保留本地图片标记。

实时事件可查询 `network/ImageResourceLoaded`、`state/InteractionPainted` 和
`state/MainThreadLongTask`。资源事件保留 `durationMs/transferSize/encodedBodySize/responseStatus`；
绘制事件测量点击后两次 animation frame 的间隔，不表示所有异步图片已下载完成。
跨站图片未开放 Resource Timing 时字节数可能是 0，不能据此判断缓存命中。
复查加载问题时，在同一个 Chrome 页打开、关闭、重开选择器，再滚动到末尾，
对照真实请求、延迟加载状态和绘制事件；不要仅凭截图推断速度。

## 显式绑定单次 Run 与失败测试归档

自动记录之外，保留 `def.ria.active-run.v1` 的兼容入口，供明确指定 Case / Session / Run 的调查脚本使用。每次显式绑定必须使用新的 Run ID。provider 记录它实际提交的同一份 simulation input，并在 completed / failed 后 seal；seal 后不能继续追加 UI action。

opt-in Node test wrapper 不改变默认 `npm test`，也保持原 exit code。仅失败时自动创建 interrupted Run：

```bash
npm run ria:test -- \
  --ria-case-id combo-investigation \
  --ria-session-id session-before-fix \
  -- test/ake-team-combo-state.test.mjs
```

## 校验、恢复、保留与清理

```bash
npm run ria -- verify --run-id RUN_ID --case-id CASE_ID --json
npm run ria -- doctor --json
npm run ria -- rebuild-index --json
npm run ria -- prune --case-id CASE_ID --json
npm run ria -- prune --case-id CASE_ID --apply --json
```

- `verify` 校验 schema、sequence、identity、fixture hash、event hash、文件 hash 与 content hash；
- `doctor` 从原始目录重建 index，再校验全部 Run；
- unsealed crash Run 可由库的 `recoverRun` 恢复为 sealed `partial`，非法尾行会被截断并记录 discarded bytes；
- `prune` 默认只列候选；`--apply` 只移动 sealed Run 到可恢复 trash，不直接删除；
- 创建 Case 时可设 `--retention-days`、`--max-runs` 和 `--compression gzip`；
- `compression=none` 使用可重建稀疏 byte index；sealed gzip 查询会从压缩流起点顺序解压，capabilities 会明确报告这一性能差异；
- fixture、config、result 与 event 在持久化前递归脱敏，服务限制 1 MiB 请求体，单事件和单 Run 也有独立体积上限；Run 上限在落盘前检查，commands/events/snapshots/UI actions 共用额度。


### 交互重算与后台归档

浏览器的 `calculation.phase=completed` 表示当前版本结果已经交付；`recording=true`
表示结果对应一个正在记录的 Run，不表示已经封存。`elapsedMs` 测量从 Provider 发起到
报告发布的耗时。封存完成会单独产生 `calculation/RiaRunSealed` 事件；在此之前读取完整
`result` 归档可能尚不可用，实时 calculation/inspection 快照仍可查询。

自动浏览器计算复用预热工作线程，独立重建每次战斗状态。真实事件在有界缓冲区中保留，
结果先交付，随后按原顺序归档，超过缓冲窗口则恢复持久化背压，不进行第二次模拟。
显式记录/回放的实时 SSE checkpoint 契约不变。

追加终结技的复现输入：`fixtures/ria/wulfa-camille-appended-ultimate.json`。
预期卡缪两次连击获得发生在 F364/F427，洛茜 Q 跟随 E 的最后一击在 F433 释放并消费两层。
其 `releaseDependency` 可与 Run 中的 `CommandAnchored`/`ReleaseAnchorResolved` 对照。

### 报表归因观测

打开 Chrome 的伤害报表后，`GET /api/ria/live/sessions/SESSION_ID/snapshot?section=report` 返回当前存档/输入身份、RD 状态、干员和来源域汇总、逐项来源记录（包括连击 grant ID）、命中重构误差、失衡/未知来源余额及后台线程耗时。`RdpsCompleted` / `RdpsFailed` 同步进入会话事件。命中重构失败时停止出图，不能把不一致的结果标成完成。原始 Run 保持不变，归因固定本次实际命中和释放计划。


### 接续放大镜观察

Live snapshot 的 `releaseLens` section 在展开时提供来源按钮、候选版本、每个事件的语义标签/帧与窗口边界、选中关系、非负偏移、草稿帧、不可提交原因和待核验说明；关闭时为 `active: false`。这些是交互草稿，必须与 `timeline` 的已保存关系及 `calculation` 的 Run/结算状态分别读取。

`ReleaseLensOpened`、`ReleaseLensCancelled`、`ReleaseLensCommitted` 记录展开、取消和有效提交。核对一轮操作时先冻结输入与 Run，操作期间读取草稿，再比较保存输入和新的计算记录；不能仅凭菱形为高亮色断言机制已验证。不要为读取草稿主动发送重算命令，否则无法判断显示是否触发了计算。


`timeline-drag` 用于复现真实页面已有按钮的长按/拖动处理链。先读取 capabilities 与当前 `timeline` 身份，再以 `ui.controls.bounds` 或 `releaseLens.rect/sourceRect` 得到视口 client 坐标。命令接收当前 `timelineId`、已有 `buttonId`、`steps: [{clientX, clientY, holdMs}]` 和 `finish: "release" | "cancel"`。自动先长按 220 ms；最多 12 步，每步停留最多 1000 ms，总等待最多 5 秒；页面必须可见，同一连接不可重入。它不能创建任意选择器、执行 JavaScript 或绕过工作台准入。

命令明确标记 `synthetic: true`，证明的是当前 Chrome DOM 处理链，不能冒充原生鼠标手感。`DebugTimelineDragStep` 附当时的放大镜快照，避免短操作被普通快照采样间隔漏掉；结果返回 `releaseLensOpened` 与事件游标。完整结论仍须比对 `timeline` 保存关系和 `calculation` Run。先以 `finish: "cancel"` 核对草稿，再使用 `release`，验证完恢复原输入。

### 队列拖动与技能列表预览（2026-09-06）

`timeline-drag.buttonId` 可取原页面已存在的按钮 ID，或 `ui.controls[].dragSourceId` 中可见技能列表的 ID（形如 `palette-chr_0027_tangtang_normal_skill`）。已入队按钮会拒绝拖动；技能列表仍经过真实 DOM 处理器进行有界合成拖动。来源必须可见、未遮挡且仍属于当前页面，维持 5 秒上限和原存档身份校验。

`ui.controls[].dragDisabled` 区分禁止拖动与整个控件禁用。`ui.dragPreviews` 以及 `DebugTimelineDragStep.dragPreviews` 记录预览数量、文字、边界、透明度、滤镜、阴影、父节点与鼠标穿透状态。用这些事实检查重影和坐标偏移；合成事件不能代替原生鼠标手感验收。
