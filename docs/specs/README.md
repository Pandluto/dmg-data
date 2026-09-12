# Spec 总索引

本目录保存仍会约束项目行为、数据更新和文档治理的规格。Spec 说明“必须成立什么”；当前实现事实见 [架构目录](../architecture/README.md)，可复算结果见 [当前证据](../evidence/README.md)。

## 当前 Spec

- [排轴执行顺序与渲染分离](./timeline-execution-order/spec.md)：时间、因果与同帧操作序号独立于像素；已集成本地 `codex/ui-0912` 预览分支，保留结算后控制流与历史 UI 存档验收边界；详见 [任务表](./timeline-execution-order/tasks.md)。

- [排轴状态来源与时序](./timeline-state-flow/spec.md)：区分效果来源、触发动作与生效时刻；普通和阅读视图独立显示状态变化与持续。

- [排轴阅读与批量模式](./timeline-reading-batch/spec.md)：书本组合摘要、单技能卡片与合法队尾的原子批量删除；已整合；阅读中框选、合法队尾删除与撤销已通过完整应用隔离 Chrome 验证。

- [文档与证据系统](./documentation-and-evidence-system/spec.md)：唯一事实层级、来源升级事务、文档生命周期和验收门。
- [排轴局部接续放大镜](./timeline-release-lens/spec.md)：原画布局部放大、语义吸附、逐帧余量与可持久化接续关系；首版已接入工作台，规格记录已验证行为与剩余原生交互验收。

## 文件约定

1. 每项长期需求使用 `docs/specs/<spec-id>/spec.md`，不在 `docs/` 顶层创建散落的 `*-spec.md`。
2. 活跃实施可以在同目录增加 `tasks.md`；任务完成后，只有仍能约束维护的内容继续保留。
3. Spec 至少包含状态、Problem Statement、Solution、User Stories、Implementation Decisions、Testing Decisions、Out of Scope 与 Further Notes。
4. Spec 不复制会漂移的覆盖数字、提交清单和源码行号；这些内容分别进入生成证据、维护记录和 Git。
5. 被替代的 Spec 必须标记 `Superseded` 并链接后继；不允许静默保留两份互相冲突的现行要求。
