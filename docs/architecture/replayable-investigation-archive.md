# Replayable Investigation Archive 架构

Replayable Investigation Archive（RIA）把一次计算调查保存为可校验、可查询、可重放的证据，而不是把 `console.log`、聊天记录或截图当成事实。聊天可以引用 `caseId / sessionId / runId / sequence` 做决策记录，但档案中的 sealed Run 才是计算证据。

## 权威边界

RIA 不实现任何战斗规则。它观察现有事实源，并保存两类明确标注的数据：

| authority | 含义 | 例子 |
| --- | --- | --- |
| `runtime-fact` | 已由现有 runner、`CombatRuntime` 或状态机产生的事实 | resource transition、status transition、skill program、Damage Hit |
| `runtime-projection` | 对现有事实做无规则重判的因果投影 | 复制到多名队员的共享连击折叠为 logical grant/consume；逐 Hit 消费快照 |
| `ui-projection` | 只服务显示的推导 | 标签、分组或视图排序；不能成为伤害或 Buff 结论的唯一证据 |

证据来源仍遵守项目总边界：

- AKE 原始数据证明公开 ID、字段、动作树和 Buff 定义；
- Calc fixture / 黑盒对拍只证明冻结场景行为；
- Endaxis 只作为 reference/parity oracle，不冒充 AKE、Calc 或游戏官方事实；
- 缺失数据继续由 compiler/runtime diagnostics 和 `spec/unresolved-dependencies.json` 表达，RIA 不补猜。

## 接入位置

`CombatRuntime` 的可选 `traceSink` 在原有 trace 数组成功追加后收到只读 clone。当前观察 `runtime`、`effect`、`status`、`resource`、`cooldown`、`clock`、`vital`、`poise`、`reaction`、`resilience`、effect-source 与 skill-form 流。sink 的同步异常、异步失败或 backpressure 只进入记录诊断，绝不回传到战斗结算。

受控 record/replay 在 `worker_threads` 中调用固定的 `ake-squad-demo` adapter；主线程只接收结构化 trace/result IPC。Worker 每 64 条事实执行一次持久化 checkpoint，主线程在此前事实写入 append-only JSONL 后才放行下一窗口。因此 HTTP/SSE 事件循环在实际计算尚未完成时就能读取多个已持久化事件，同时形成有界 backpressure。客户端不能提供模块路径、脚本或 shell 字符串。

`AkeScenarioRunner` 与 `AkeSquadScenarioRunner` 只负责把 sink 传入同一个 `CombatRuntime`。`ResolveDamagePacket` 的既有 Hit 结果被展开为 `DamageHit` 事件，保留 operands、factors、factor validation、Hit 消费快照与 HP before/after；记录层不再运行伤害公式。

现有 `teamComboLedger` 仍是共享连击的中立因果投影。RIA 保存它的 logical grant/consume/refresh/expire、`inputCommandType / effectiveSkillType`、`rootCastId / childCastId` 和每个 Hit 的冻结消费快照。LTS UI 的 runtime ledger 与 RIA 因而读取同一份运行时因果结构，不根据动作前后净层数或截图猜来源。

## Case、Session 与 Run

- **Case**：一个问题从发现到验证修复并关闭的生命周期。Case 可以追加 Session 和 Run，关闭时不得存在 unsealed Run。
- **Session**：一次连续调查/开发会话；`entries.jsonl` 追加 `decision / finding / run-link / commit-link / thread-link / note`。每条包含 sequence、time、actor 与 content hash；thread/task 只关联决策，结论仍必须引用 Run 事件。
- **Run**：一次实际执行。创建后只允许追加 JSONL；seal 后应用层拒绝任何写入，哈希校验可以检测绕过应用层的修改。

Case 一旦关闭，library、CLI 与 REST 的 Session create/journal append、record/run/replay 和 UI action 写入统一返回 `RIA_CASE_CLOSED`。当前没有隐式 reopen，也没有绕过审计的恢复写路径。

默认目录：

```text
artifacts/
  index.json                         # 可删除、可重建，不是权威
  indexes/<case-id>/<run-id>/
    events.sparse.json               # sequence → byte offset 稀疏索引
  cases/<case-id>/
    case.json
    sessions/<session-id>/
      manifest.json
      entries.jsonl
    runs/<run-id>/
      manifest.json
      fixture.json
      commands.jsonl
      events.jsonl[.gz]
      state-snapshots.jsonl[.gz]
      assertions.json
      result.json
      ui-actions.jsonl[.gz]
      findings.md
      .active                        # 仅 recording 状态存在
  diffs/<left>--<right>.json         # 可重新生成的 normalized diff
  trash/<timestamp>/<case>/<run>/   # retention apply 后的可恢复移动
```

真实 `artifacts/cases/*`、diff、index 和 trash 默认被 Git 忽略。仓库只提交 `fixtures/ria/` 中的小型输入与 golden trace。

## Manifest 与完整性

每个 Run manifest 保存：

- `schemaVersion`、Case/Session/Run ID、`recording/completed/interrupted/partial` 与 `sealed`；
- started/ended time、seed 和经过脱敏的显式 config；
- fixture 的 canonical SHA-256；
- battle rule hash（`src/core`、`spec` 与 package）、data lock hash、完整执行闭包 `executableHash` 和记录闭包 `recorderHash`；执行闭包包含 adapter、demo service、runner/runtime、normalizer、schema、OpenAPI、package lock/config；
- Git commit、branch、dirty path 摘要、status hash、tracked diff hash；参与执行的 untracked 文件还保存逐文件 content hash 与 aggregate hash；
- Node、platform、architecture；
- 每个文件的 byte count、SHA-256、encoding 和整个文件表的 content hash；
- commands/events/snapshots/UI actions 计数、记录失败与 dropped fact 计数。

环境捕获不会读取或保存任意环境变量值。敏感 key（token、secret、password、authorization、cookie、credential、private key 等）递归替换为 `[REDACTED]`；项目外绝对路径替换为 `[REDACTED:ABSOLUTE_PATH]`。

当前写入器和导出的 Snapshot Schema 都拒绝 `runPath`。仓库里 2026-08-28 首次原型生成的 sealed Run 曾错误地把该绝对路径写入 snapshot；`doctor` 不改写已有内容，只对“sealed、缺少 `recorderHash`、且唯一多余字段恰为字符串 `runPath`”的档案启用窄兼容读取，并报告 `RIA_LEGACY_SNAPSHOT_RUN_PATH` warning。该兼容分支不会用于新 Run、REST 输入或普通 Schema 校验。

JSON/manifest 使用同目录临时文件、`fsync` 和 rename 原子替换。JSONL 使用单条 `O_APPEND`，每 64 条默认同步一次，并在 seal 前强制同步；崩溃最多留下不完整尾行。`maxRunBytes` 在写入前预留，commands/events/snapshots/UI actions 共用总额度；首次超限的记录不会落盘，后续记录全部拒绝。`recoverRun` 截断第一个无效记录之后的字节，把 Run seal 为 `partial` 并保存 recovery 明细。计算失败由执行包装器自动保存为 sealed `interrupted` Run。

## Event 与状态证明

每个 event 都有单调 `sequence`、逻辑 `frame/tick`、`eventType`、actor/target、cast lineage、输入/有效技能类型、authority/stream/native identity 和 `eventHash`。存在的 transition 数据按原事实保存：grant/consume/refresh/expire/remove/change、before/requested/delta/after、stack、来源和原因。

动作身份分为三组：primary action、`origin*`（Buff/effect 来源）和 `trigger* / consumer*`（触发或消费动作）。带 trigger 的状态事件，其 primary actor/skill/type/cast 必须全部等于 trigger 动作；历史 Buff 的 origin actor/skill/type/cast 独立保存。若跨来源事实没有足够字段证明完整 origin action，相关 origin skill/cast 保持 `null`，不把另一个动作的字段拼进去。状态快照只用 primary action 更新对应 root cast；消费另一来源的状态不能覆盖原 cast。team-combo projection 仍以 grant ID 保存 origin→consumer 因果关系。

`state-snapshots.jsonl` 不是第二套状态机。它只投影事件中已经存在的显式 `after`、Hit `targetHpAfter` 和 logical team-combo `afterStacks`。查询某帧时返回最后一个不晚于该帧的可证明状态，并给出：

```json
{
  "proof": {
    "exact": true,
    "snapshotSequence": 17,
    "snapshotFrame": 210,
    "eventSequenceFrom": 1,
    "eventSequenceTo": 8432
  }
}
```

未知字段保持未知；不会用 before/after 净值反推中间事件。因此同帧 `1 → 0 → 1` 会保留 consume 与 grant 两条事件，即使最终净值仍为 1。

## Schema 与协议

机器可读 JSON Schema 位于 `schemas/ria/`。运行时直接以 Ajv 2020-12 编译同一批 schema，而不是维护浅层手写副本；`npm run ria:schemas` 导出相同对象。服务也通过 `GET /api/ria/schema` 返回同一份 schema document。

OpenAPI 3.1 契约位于 `openapi/ria.openapi.json`，Case、Session、SessionEntry、RunManifest、Artifact、EventPage、StateProof、ReplayJob、Diff 与 Error 都有实际 response schema；常见 400/404/409/413/500 和 SSE payload 也在契约中。导出与服务启动路径由 Swagger Parser 加 Ajv 验证。完整 REST/SSE 使用方法见 [RIA 快速开始](../guides/ria-quickstart.md)。

## 查询、索引与实时流

`events.jsonl` 是权威。普通 Run 使用每 128 条一个 checkpoint 的稀疏 sequence→byte-offset 索引；`afterSequence` 或 opaque `cursor` 从最近 offset 开始流式解码，page diagnostics 返回 seek sequence、start/end offset、file bytes、bytes scanned 和 decoded record 数。索引删除后由 JSONL 重建。SSE 的同进程通知和跨进程 `fs.watch` 都调用相同游标查询，从最后 byte offset 继续，不重读文件头。

sealed gzip Run 采用明确的不同策略：每页从 gzip stream 起点顺序解压，capabilities/diagnostics 标记 `gzip-sequential-decompression`，不声称支持压缩字节随机 seek。需要大量随机查询的调查应使用默认 `compression=none`，关闭后再按保留策略压缩。

SSE 把 sequence 放入 `id`，支持 `Last-Event-ID`。服务先安装同进程订阅和跨进程文件 watcher，再做初读，并在 bootstrap 后无条件补读；因此不存在 read→subscribe 空窗，重复通知仍由 sequence 去重。正常 socket backpressure 会等待 `drain`；超过有界 drain timeout 才关闭慢消费者，调用者用最后确认的 ID 续传。completed/partial 发送 `run-complete`，failed/interrupted 发送 `run-interrupted`。OpenAPI 分别用 `SseReady`、`Event`、`SseTerminal`、`SseError` 描述实际 data payload，不使用宽泛 JsonValue。

LTS UI 通过 `riaUiActionSink.ts` 把实际计算请求、失败、完成写入 `ui-actions.jsonl`，只记录交互，不复制战斗规则。provider 以同一份 simulation input 建立 UI Run，页面报告直接等待该 Run 的 worker 结果；不再把 UI 动作附加到一份无关 replay。动作使用 43821 同源路由，completed/failed 写入后才 seal，晚到写入被拒绝。Node 测试可显式使用 `scripts/ria-node-test.mjs`；只有失败时创建 sealed interrupted failure Run，并保留命令、测试名、exit status 和输出尾部，原 test exit code 不变。

## 保留与压缩

Case policy 支持正整数 `retentionDays`、正整数 `maxRuns` 和 `compression: none|gzip`。gzip 只在 seal 前压缩 JSONL，manifest 对压缩后的权威字节计算哈希，API 对调用者透明解压。

`ria prune` 默认 dry-run。只有显式 `--apply` 才会把满足 policy 的 sealed Run 原子移动到 `artifacts/trash/`；不会直接删除，因此可以人工移回原 Case 的 `runs/` 后重建索引。活动或 unsealed Run 永远不会成为候选。

## 当前限制

- 当前受控 replay adapter 是 `ake-squad-demo`；没有把固定佩丽卡 legacy simulator 或任意第三方执行器加入白名单。
- 状态 API 只返回事件明确证明的字段，不保证每帧拥有完整世界快照。
- gzip sealed Run 的分页必须顺序解压；它适合归档保留，不适合高频随机翻页。压缩写入本身使用流式 pipeline、临时文件、fsync 和 rename，不把整个 JSONL 读入内存。
- 首次原型的 5 个本地 sealed Run 含已冻结的 legacy `runPath` 字段；不能在不破坏内容哈希的情况下清除。`doctor` 会以 warning 标出，新档案不会再写入该字段。
- sealed 是应用层不可变加内容寻址校验，不是 OS/WORM 存储；直接改磁盘会被 `verify` 检出，但操作系统仍允许拥有文件权限的用户修改。
