# ADR-0004：来源驱动的通用运行时语义

**Status:** Accepted

## Context

AKE 的角色、技能与 Buff 由相同 action、condition、target、event 和 lifecycle 结构组合而成。若按角色或单个 JSON 路径修补，两个结构相同的样例可能进入不同规则；若只让编译器不报错，又会把 metadata、默认值或未触发 listener 误写成已实现行为。

公开 JSON 能证明字段和依赖，Calc fixture 能证明指定输入下的外部结果，本地代码与账本能证明当前实现。三类证据互不替代。随机、曲线、几何、环境和缺失文件也不能从名称推断。

## Decision

一项 AKE 战斗语义只有同时具备以下链路才进入通用运行时完成态：

```text
固定来源字段
  → 类型化 compiler IR
  → 可观察的运行时状态或 ledger edge
  → 来源对应的测试、oracle 或生成审计
```

相同结构必须经过同一 compiler 和 runtime primitive，不允许按角色 ID、展示名或单一 fixture 建立平行规则。条件先组成显式的 All/Any/Not/value graph，再选择动作；目标组、ability entity identity、可选 child program 和实体生命周期分别建模；事件只有绑定真实事务 edge 后才登记为已知 producer。

来源只证明结构而没有外部执行细节时，可以实现并标记为 source-derived，但不得宣称 Calc 精确。需要 RNG、曲线、世界查询、关卡环境或缺失上游正文的节点继续 fail closed，并保留 provider/evidence/upstream diagnostic。

## Consequences

- 新角色复用现有原语；角色机制只作为组合压力测试。
- “已有 switch case”“listener 可登记”“固定用例通过”都不能单独证明闭合。
- marker ability entity 即使没有 child SkillData 也可以存在；缺少 child 文件不会抹掉已经发生的父级状态变化。
- audit 数字可能因分类更诚实而上升；不能以归零 unresolved 为目标伪造外部规则。
- 语义变更必须同步当前架构、生成证据和必要的维护记录，避免实现与文档分叉。

## Evidence

- [战斗运行时](../combat-runtime.md)
- [当前边界](../known-boundaries.md)
- [通用运行时闭包研究](../../research/runtime-closure-20260903.md)
- [本次运行时收口记录](../../maintenance/runtime-generalization-20260903.md)
- [当前生成证据](../../evidence/current-snapshot.md)
