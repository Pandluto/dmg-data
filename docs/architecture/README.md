# 架构事实源

这里记录跨场景、跨模块并需要长期维护的当前系统事实。实现过程、外部研究和过期方案不在本目录继续累加。

## 当前系统

- [架构总览](./overview.md)：产品边界、分层和依赖方向。
- [当前系统与模块职责](./current-system.md)：代码组件、所有权和禁止的反向依赖。
- [文档与证据系统](./documentation-system.md)：事实层级、文档职责、生命周期、冲突裁决和数据升级事务。
- [数据来源与派生链](./data-lineage.md)：AKE、Calc、语义映射、fixture 与生成物的关系。
- [运行拓扑](./runtime-topology.md)：CLI、单人/小队运行器、开发服务器和生产静态服务。
- [战斗运行时](./combat-runtime.md)：事件、状态机、技能身份、伤害与账本。
- [共享变速时间轴](./shared-variable-rate-timeline.md)：真实帧、动作关系和视觉投影。
- [引擎与前端接线](./frontend-integration.md)：目录、预演、结算、ledger 与界面职责。
- [可重放调查档案](./replayable-investigation-archive.md)：Case/Session/Run、事实 sink、不可变存储、Schema、REST/SSE、重放与保留。
- [验证矩阵](./verification-matrix.md)：每类检查能证明什么、不能证明什么。
- [当前边界与未闭合项](./known-boundaries.md)：尚未获得证据或尚未完成的系统能力。

## 架构决策

[ADR 索引](./decisions/README.md)只保存继续约束本项目的跨模块决策。

## 相邻材料

- [Calc oracle 与测试方法](../testing/README.md)
- [当前 Spec](../specs/README.md)
- [当前生成证据](../evidence/README.md)
- [Endaxis 对照研究](../research/README.md)
- [文档与实现演变](../maintenance/documentation-reconstruction-20260903.md)
- [通用运行时语义收口](../maintenance/runtime-generalization-20260903.md)
- [历史档案](../archive/README.md)

架构页不使用源文件行号作为长期引用。需要定位实现时使用稳定文件、导出名、测试名或生成报告键；行号只适合一次性审查记录。
