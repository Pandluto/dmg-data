# ADR-0002：显式保留双执行链

**Status:** Accepted

## Context

固定佩丽卡 simulator 对早期 Calc oracle 提供较强的窄场景保证；通用 assembler/runner/`CombatRuntime` 是产品主链并覆盖更多角色和机制。两者有相似模块，但状态所有者和已证明范围并未完全统一。

## Decision

在一份后续 Spec 完成行为映射、迁移和交叉验证以前，两条执行链保持显式名称和独立保证范围。新产品能力进入通用链；固定链继续作为已冻结 oracle 的回归锚点。任何文档、测试报告和 UI 结论都必须说明自己来自哪条链。

## Consequences

- 暂时承担少量重复实现和两套验证成本。
- 不允许因类名相似或结果偶然相等而宣称代码已经统一。
- 收敛必须证明所有固定 oracle 在新主链中保持，并单独删除旧链，不能逐步静默漂移。

## Evidence

- [架构总览](../overview.md)
- [运行拓扑](../runtime-topology.md)
- [测试与 Calc oracle](../../testing/README.md)
