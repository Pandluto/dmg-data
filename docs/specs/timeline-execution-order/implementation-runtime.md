# 小队操作顺序：运行时实施记录

日期：2026-09-12。负责 B-01 至 B-05。

- 工作树：`/Users/sailstellar/.codex/worktrees/b014/dmg-timeline-order-runtime`
- 分支：`codex/timeline-order-runtime`
- 共同起点：`11ef693b867b83fb733db9db69c186eb8500a702`
- 实现及定向测试提交：`f304315`。本记录另行提交。
- 已只读核对主任务 `600c38b` 的兼容权威补充；工作分支未重写基线。

## 输入及调用合同

`src/core/ake-operation-order.mjs` 集中校验顶层 `operationOrderVersion: 1`，以及 commands / operatorSwitches 联合的身份和序号。`operationOrder` 必须是非负安全整数，允许空档；空轴合法。缺失、重复、非法序号、未知版本、v1 带 timelineOrder、无版本带 operationOrder 都明确失败。直接 runner 和 demo adapter 使用同一校验；demo 转成可读的 DemoInputError。

v1 要求显式非空 commandId / switchId。demo 保留这些身份，不执行旧 ID 字符替换/截断或按数组位置补 ID。v0 的旧身份规范化仍保留。输入不被修改，原 fixture 不重写。

调用链：`simulateSquadDemo → normalizeSquadRequest → runAkeSquadScenario → AkeSquadScenarioRunner.run`。规范化保留版本和每项序号，v1 命令按 frame / operationOrder 排序。runner 的 normalizedCommands、初始 controlAndCommands、resolveReleaseDependencies 使用同一已校验序号。inputSequence 在 v1 使用逻辑序号，使直接 runner 的规范化记录也不受传输数组排列影响；v0 保持原 index。

runner 的 `scenario` 保留顶层版本及 commands / operatorSwitches 每项序号。demo v1 报告新增 `operationOrderVersion` 和按序号排列的 `operationOrders` 身份表；旧报告不增加字段。该表用于追溯，未替代前端有效输入摘要。

审查补修：v1 `CommandSubmitted.sameFrameOrderKey` 改为实际 operationOrder，并附 operationOrderVersion / operationOrder；v0 保留原 memberId 字符串且不新增字段。真实 runner trace 回归覆盖两版本。这是 trace 元数据修正，不改变调度或战斗事实；补修后顺序测试文件为 5 个测试。

## 调度边界

真实 frame 仍优先，所有现有事件优先级和运行时调度器不变。初始已 ready 同帧输入按序号安排；同一次来源事件唤醒的后继按序号安排，零偏移仍排在来源事件之后。多个来源逐次发生时，各自唤醒的批次保留原事件到达顺序，不对 pendingEvents 进行全局重排。

实际覆盖了同帧切人在瞬时战技前/后的不同主控结果、同来源 action-start 和真实 damage-hit 的技能/切人扇出、同帧但不同来源的后继批次，以及低序号后继等待更晚来源。没有修改技能、伤害、资源、时钟、准入、取消或依赖有效性规则。

## v0 精确 fallback

迁移兼容权威为固定基线 provider → demo → runner 的实际调度；旧前端预演的 characterId 排序不是本包兼容目标。已向 A 和主任务回传以下规则：

1. demo 命令先按 frame、`memberId.localeCompare`、原数组 index。runner 再按 frame、lexical(memberId)、收到的 inputSequence。switches 保持数组顺序。
2. runner 对 switch 的缺省/非有限 timelineOrder 归为 -1；command 的初始调度对缺省/非有限值归 0。demo 旧接口仍只接受原有有限数值范围。
3. controlAndCommands 按 frame、timelineOrder；相等键时 switch 先于 command，同类保持规范化后的稳定顺序。
4. controllerAnchorWaits 按 switches 顺序建立，anchorWaits 按 normalizedCommands 顺序建立。依赖候选先拼 switches 再 commands，按 timelineOrder 稳定排序；command 缺省 0，switch 已归 -1。相等键仍 switch 先，同类保留上述插入序（其中 command 含预演 frame 排序）。

对所核对的合法有限旧 API 输入，这两处相等键规则一致；没有发现需改变 v0 才能表达的反例。不能把这项结论理解成允许全局序号跨越时间或因果。直接 runner 历史上宽松接受的非法旧数值也未改写为 v1。

## 历史轴实测

修改生产代码前实际执行两条原 fixture，在本机临时文件保留七类完整事实；新增回归保存其 SHA-256。比较命令、主控、全部命中、状态事件、资源事件、终态和连携账本。程序化 v1 副本明确按旧排序规则产生序号，不修改原 JSON，也不声称替代 A 的实际存档迁移。

| 原 fixture | 命令 | 命中 | 状态事件 | 资源事件 | v0 基线 / v1 / 数组反转 |
| --- | ---: | ---: | ---: | ---: | --- |
| lastrite-tangtang-status-provenance | 9 | 184 | 162 | 12 | 七类事实全部一致 |
| wulfa-camille-appended-ultimate | 8 | 114 | 127 | 13 | 七类事实全部一致 |

第一处分歧检查均返回 null。测试比较完整事实，不只总伤；失败时报告首个字段路径。基线合并哈希：

- 九动作：`5fd5e94948922e629fd9034b0858e37f6a2765261bd16b2384a1403fae7732ff`
- 洛茜/卡缪：`9f0286860556732f497088cf27f37e9491d8c228d6a25c4ddd3ef8899641d212`

## 检查与已知失败

以下四个文件共 21 个定向测试均已离线通过（分批执行，无监听端口）：

```sh
node --test test/ake-operation-order.test.mjs test/ake-operation-order-fixtures.test.mjs test/ake-controller-state.test.mjs test/ake-release-dependencies.test.mjs
```

覆盖 parser / 直接 runner / convenience runner / demo 的输入错误、空轴、安全整数、跨类型重复身份和序号、同帧切人前后、扇出、因果、循环、数组反转，以及两条真实轴。三个生产模块 `node --check` 和 `git diff --check` 通过。根依赖以 `npm ci --ignore-scripts --no-audit --no-fund` 安装到本工作树，未使用主库或共享可写 node_modules。

额外执行 `test/ake-squad-scenario.test.mjs`：16 通过、1 条既有失败。失败是 `generic runtime keeps main, status-triggered and anomaly damage as independent formula hits`（行 571），admin-b 对应 Hp 命中预期 3、实际 0。用 `git show 11ef693:src/core/ake-squad-scenario-runner.mjs` 的原 runner 在内存加载，同一输入实际也为 0；原/新完整 runner 结果哈希均为 `31dada3591f3c0a3b79b040c789708ab379f4b9f1dc57ff12810bc7933787306`。因此记录为基线失败，未修改期望或伤害逻辑。

## Worker、RIA 与待集成项

源码核对 `src/ria/execute.mjs` 将完整 fixture.input structuredClone 后传给 worker，`fixture-worker.mjs` 将完整 data.input 交给 simulateSquadDemo，结果完整传回；demo/ake-api 同样将完整输入交给 service，RIA 输入 hash 包含新字段。fixture schema 接受普通 JSON 对象，没有丢字段的白名单。因此无需改动 Worker/RIA 生产代码或 schema。

A 的真实持久化迁移、有效摘要及请求构造尚待主任务隔离集成核对。当前实际服务未接入本分支，不能把在线端点现状当作本包合同验证。全程未打开或运行浏览器（含 headless），未导航/刷新页面、调用活动 RIA、启动/重启/终止开发服务、监听 HTTP 端口或改动主库。未浏览器验收；未 push、部署或合并主库。
