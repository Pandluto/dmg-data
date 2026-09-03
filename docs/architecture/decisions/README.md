# Architecture Decision Records

本目录只保存仍在约束项目的跨模块决策。实现细节、阶段计划和一次性调查不写 ADR。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](./0001-source-locked-generated-evidence.md) | 固定来源锁与生成证据是当前数字的唯一入口 | Accepted |
| [0002](./0002-explicit-dual-execution-chains.md) | 固定精确链与通用产品链在证据闭合前显式并存 | Accepted |
| [0003](./0003-ria-observes-runtime-facts.md) | RIA 只观察、保存和投影现有运行时事实 | Accepted |
| [0004](./0004-source-backed-runtime-semantics.md) | 运行时语义必须沿来源、IR、状态变化和证据闭合 | Accepted |

新增 ADR 使用四位编号，至少包含 Status、Context、Decision、Consequences 和 Evidence。替代旧决策时保留旧文件并标记 `Superseded by ADR-xxxx`。
