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

## LTS UI 与失败测试归档

把本次 UI 计算要创建的 Case、Session 和新 Run ID 写入浏览器 `sessionStorage`。不要提前对另一份 fixture 启动 replay：AKE provider 会先以它即将提交的**同一份 simulation input**创建 Run，再由该 Run 的 worker 产生页面实际使用的结果和事实事件，因此 UI action 不会挂到另一份独立计算上。

```js
sessionStorage.setItem('def.ria.active-run.v1', JSON.stringify({
  caseId: 'combo-investigation',
  sessionId: 'session-before-fix',
  runId: 'run-live-ui'
}));
```

`43821` 的 provider 使用同源 `/api/ria` 路由；Vite 只在本进程拥有该 UI Run 时接收动作，其他 RIA 读取代理到 loopback `43822`。无需跨端口 CORS；直接连接 `43822` 的兼容路径也只允许显式可信的 loopback UI origin，绝不返回 `*`。客户端 sink 串行发送、可 `flush()`，记录失败不改变计算语义。provider 在真实计算前写 requested，收到同一 Run 的结果后写 completed/failed，最后 seal。seal 后晚到动作返回 `RIA_RUN_SEALED`。

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
