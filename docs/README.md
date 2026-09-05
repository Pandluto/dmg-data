# 项目文档入口

这里采用与 DEF 相同的短入口和稳定目录，同时增加本项目必需的生成证据层。先按问题选择入口，再下钻细节；历史文档不参与当前验收。

## 按问题阅读

| 想回答的问题 | 入口 |
| --- | --- |
| 特殊术语是什么意思，某位角色或解包数据已有何结论 | [知识库路由](./knowledge/README.md) |
| Agent 如何开展实验、分工、记录发现和提出优化 | [开发约定](../AGENTS.md)、[实验与自迭代](./guides/agent-development.md) |
| 项目现在由哪些组件组成 | [架构事实源](./architecture/README.md) |
| 一项能力必须满足什么 | [当前 Spec](./specs/README.md) |
| 为什么采用某个跨模块选择 | [ADR 索引](./architecture/decisions/README.md) |
| 当前版本、数量、覆盖和缺失项是什么 | [当前证据快照](./evidence/current-snapshot.md) |
| 一个结论需要什么验证 | [测试与 Calc oracle](./testing/README.md) |
| 如何开发、更新数据或使用 RIA | [操作指南](./guides/README.md) |
| 外部项目提供了什么参考 | [外部研究](./research/README.md) |
| 一次升级或清理为什么发生 | [维护记录](./maintenance/README.md) |
| 如何恢复旧研究 | [历史档案](./archive/README.md) |

## 核心入口

- [架构总览](./architecture/overview.md)
- [当前系统与模块职责](./architecture/current-system.md)
- [文档与证据系统](./architecture/documentation-system.md)
- [数据来源与派生链](./architecture/data-lineage.md)
- [运行拓扑](./architecture/runtime-topology.md)
- [战斗运行时](./architecture/combat-runtime.md)
- [共享变速时间轴](./architecture/shared-variable-rate-timeline.md)
- [引擎与前端接线](./architecture/frontend-integration.md)
- [可重放调查档案](./architecture/replayable-investigation-archive.md)
- [验证矩阵](./architecture/verification-matrix.md)
- [当前边界与未闭合项](./architecture/known-boundaries.md)

## 权威顺序

公开输入以原始快照与来源锁为准；当前行为以可执行代码和结构化 report 为准；目标行为以 Accepted Spec/ADR 为准；证明范围以测试、oracle 和生成审计为准；当前数字只看生成证据；变化原因看维护记录与 Git。

详细的冲突裁决、文档类型、生命周期和完成条件见 [文档与证据系统](./architecture/documentation-system.md)。

## 保留规则

1. 架构只写现在成立的事实，不追加阶段日志和待办。
2. Spec 不复制当前统计；数字只由 evidence generator 维护。
3. 测试页说明方法和证据等级，不保存会漂移的通过总数。
4. 研究只提供设计维度，不替代 AKE、Calc 或本项目运行证据。
5. 维护页可以保存带日期的差异，不能成为长期架构入口。
6. 档案保持原文并明确降权；有效结论必须回写当前目录。
7. 代码、生成物和文字冲突时先复现实例，再依照事实层级裁决，不能只改一句“已完成”。

## 历史恢复

初始编号文档完整保存在 [文档档案](./archive/README.md)。2026-08-28 的逐文件迁移表见 [首次重组记录](./maintenance/documentation-cleanup-20260828.md)，Spec/ADR/evidence 补全与冲突清单见 [2026-09-03 补全记录](./maintenance/documentation-reconstruction-20260903.md)，同日的来源驱动运行时收口见 [通用运行时语义收口](./maintenance/runtime-generalization-20260903.md)。
