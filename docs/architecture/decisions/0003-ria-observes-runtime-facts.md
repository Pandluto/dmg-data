# ADR-0003：RIA 只观察运行时事实

**Status:** Accepted

## Context

计算调查需要比截图和临时日志更完整的持久证据，但如果记录器重新计算状态或解释规则，就会出现第二套战斗引擎，并可能让“日志看起来正确”掩盖真实运行时错误。

## Decision

RIA 只保存现有 runner、`CombatRuntime` 和状态机已经产生的事实，以及不改变规则的因果/UI 投影。sink 失败、存储失败或慢消费者不能反馈到战斗结算。replay 只能调用固定白名单 adapter，不能接收任意模块或命令。sealed Run 由内容哈希验证，不允许应用层改写。

## Consequences

- RIA 可以证明“运行时当时输出了什么”，不能单独证明规则与游戏相同。
- 新事实必须先由运行时输出，再由记录层规范化；不得只在 RIA 中补字段推断。
- 记录失败会降低档案状态，但不会改变业务结果。

## Evidence

- [RIA 架构](../replayable-investigation-archive.md)
- [RIA 快速开始](../../guides/ria-quickstart.md)
- [验证矩阵](../verification-matrix.md)
