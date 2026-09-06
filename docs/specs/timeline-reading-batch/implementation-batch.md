# BATCH-01/02 implementation notes

本文件记录批量排轴实现，不修改 `spec.md` 正文。

## 实现边界

- `SkillSandbox` 在阅读入口旁增加批量 SVG 入口；开启批量时自动保留阅读卡片，退出批量不关闭阅读视图；书本关闭阅读时同步退出批量。
- `useBatchTimelineSelection` 在批量状态下（包括阅读状态）只在画布上接管 pointer 事件。`batchSelectionGeometry` 从可见阅读卡片、技能圆心、等待轨道或切人轨道取中心，状态角标不会成为独立选择目标。
- 框选在当前可见画布坐标内替换选择；空白点击、Escape、pointercancel、队伍/存档身份变化都会清理选择。框选层位于操作层之上，避免触发拖拽、接续放大镜和普通右键菜单。
- `planTimelineBatchRemoval` 在内存队列副本上反复调用 `getTimelineDeleteBlockReason`，只模拟合法尾部移除；失败时不触碰存储。
- `removeSkillButtons` 在预检通过后一次替换技能表、一次批量清理 Buff 引用、一次保存队列，React 侧用一次 `REMOVE_SKILL_BUTTONS` 更新运行时按钮。普攻拆段对端按单项删除语义清理。
- 批量删除保留一个带版本指纹的删除前快照，并在画布提供「撤销本次批量删除」。任何后续队列、按钮表、Buff 表、队伍或存档变化都会使入口失效；撤销只在指纹仍匹配时恢复，避免覆盖新编辑。

## 验证

- `npm run typecheck`
- `node scripts/run-ts-test.mjs /src/core/domain/timelineQueuePolicy.test.ts /src/core/domain/timelineBatchRemoval.test.ts /src/components/CanvasBoard/batchSelectionGeometry.test.ts /src/components/CanvasBoard/TimelineInteractionToolbox.test.tsx`

覆盖合法队尾、混入中间项、跨角色显式依赖、同帧动作、普攻拆段尾链和中心几何边界。当前 checkout 未控制用户 Chrome，也未修改用户存档或部署。
