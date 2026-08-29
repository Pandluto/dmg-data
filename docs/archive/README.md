# 文档档案

这里保存 2026-08-25 至 2026-08-28 形成的初始编号研究系列。它们完整记录了假设、探针、阶段计划、实现过程和当时的统计，但不再是当前系统事实源。

## 初始研究系列

- [01 · 数据来源](./initial-research-series/01-data-lineage.md)
- [02 · Buff 状态机](./initial-research-series/02-buff-state-machine.md)
- [03 · 佩丽卡脉冲验证](./initial-research-series/03-verified-pelica-pulse.md)
- [04 · 缺口与路线](./initial-research-series/04-gaps-and-roadmap.md)
- [05 · 原始数据到分析](./initial-research-series/05-raw-to-analysis.md)
- [06 · 佩丽卡最小模拟器](./initial-research-series/06-pelica-minimal-simulator.md)
- [07 · Poise 与处决](./initial-research-series/07-poise-execution-engine.md)
- [08 · Poise 局部时钟与保护](./initial-research-series/08-poise-local-clock-and-guard.md)
- [09 · 通用 CombatRuntime](./initial-research-series/09-general-combat-runtime-implementation.md)
- [10 · AKE compiler 与覆盖](./initial-research-series/10-ake-runtime-compiler-and-coverage.md)
- [11 · 自动装配与通用佩丽卡](./initial-research-series/11-automatic-assembly-and-generic-pelica-replay.md)
- [12 · Calc 打断探针](./initial-research-series/12-calc-interruption-probe.md)
- [13 · 数据驱动指令准入](./initial-research-series/13-data-driven-command-admission.md)
- [14 · Endaxis 对照研究](./initial-research-series/14-endaxis-comparative-architecture-study.md)
- [15 · 统一运行时账本计划](./initial-research-series/15-unified-runtime-ledger-upgrade-plan.md)
- [16 · 状态引擎与 UI 正确性研究](./initial-research-series/16-state-engine-ui-correctness-research.md)
- [17 · Endaxis 机制通用化审计](./initial-research-series/17-endaxis-proprietary-mechanism-generalization-audit.md)
- [18 · 战斗计算引擎架构草稿](./initial-research-series/18-combat-calculation-engine-architecture.md)
- [19 · 引擎前端接线草稿](./initial-research-series/19-engine-frontend-integration.md)
- [20 · 逐角色通用引擎对接草稿](./initial-research-series/20-generic-engine-per-operator-integration.md)
- [跨角色验证记录](./initial-research-series/CROSS_CHARACTER_VALIDATION.md)
- [共享变速时间轴完整设计笔记](./initial-research-series/SHARED_VARIABLE_RATE_TIMELINE_DESIGN_NOTES.md)

## 使用规则

- 档案可以解释“为什么当时这样做”，不能证明“现在仍然如此”。
- 档案中的测试总数、覆盖率、行号、缺口和计划均按历史上下文阅读。
- 当前结论以 [架构事实源](../architecture/README.md) 为准；外部研究提炼见 [研究目录](../research/README.md)。
- 档案内部保留原始写法和链接，不为当前结构持续改写。

tracked 文档的 Git 基线为 `f9a2067`。18–20 三份草稿在整理开始时尚未跟踪，因此本次先原样保存到档案，避免它们在重排中丢失。逐文件迁移和冲突处置见 [文档重组记录](../maintenance/documentation-cleanup-20260828.md)。
