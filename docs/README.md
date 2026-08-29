# 项目文档入口

当前文档沿用 `dmg-end-field` 的组织方式：入口保持简短，跨模块且长期有效的事实进入架构目录，测试证据、外部研究、维护过程和历史材料各自隔离。

## 从这里开始

- [架构总览](./architecture/overview.md)
- [当前系统与模块职责](./architecture/current-system.md)
- [数据来源与派生链](./architecture/data-lineage.md)
- [运行拓扑](./architecture/runtime-topology.md)
- [战斗运行时](./architecture/combat-runtime.md)
- [共享变速时间轴](./architecture/shared-variable-rate-timeline.md)
- [引擎与前端接线](./architecture/frontend-integration.md)
- [可重放调查档案](./architecture/replayable-investigation-archive.md)
- [RIA 快速开始](./guides/ria-quickstart.md)
- [验证矩阵](./architecture/verification-matrix.md)
- [当前边界与未闭合项](./architecture/known-boundaries.md)
- [测试与 Calc oracle](./testing/README.md)
- [Endaxis 对照研究](./research/README.md)
- [31 角色机制目录](./research/operator-mechanism-catalog.md)
- [开发指南](./guides/development.md)
- [文档重组记录](./maintenance/documentation-cleanup-20260828.md)
- [完整开发提交演变](./maintenance/development-history.md)
- [历史档案](./archive/README.md)

## 保留规则

1. `docs/architecture/` 只描述当前系统，不追加“本轮完成”“下一步计划”或一次性测试数量。
2. `docs/testing/` 说明稳定验证方法和 oracle 范围；单次执行日志不进入长期正文。
3. `docs/research/` 保存能继续帮助设计的外部对照，但不能替代 AKE/Calc 证据。
4. `docs/maintenance/` 记录清理、迁移、冲突处理和提交演变。
5. `docs/archive/` 中的文档不是当前事实源；其中有效结论必须已经回写到当前目录。
6. 代码行为、生成审计和 Markdown 冲突时，先复现实例并更新生成物，再修改当前架构页；不能只改一句“已完成”。

## 恢复历史材料

初始编号文档完整保存在 [文档档案](./archive/README.md)。它们原本对应 tracked 基线 `f9a2067` 及 2026-08-28 工作区中的三份未跟踪架构草稿；详细迁移表和恢复方式见 [文档重组记录](./maintenance/documentation-cleanup-20260828.md)。
