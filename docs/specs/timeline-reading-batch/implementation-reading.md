# READ-01 实现记录

## 状态

已完成实现，待主代理合并后用 Chrome/RIA 进行最终视觉验收。

## 实现范围

- 在 `CanvasArea` 内复用 AKE 主时间线状态事件，把事件按来源动作传给技能卡。
- 阅读模式将技能渲染为独立白底、黑色细框圆角卡片，保留技能图标、类型，以及来源动作产生的状态角标。
- 状态角标按 `commandId + scope + buffId + sourceId` 的展示语义筛选；同一来源同一状态只保留最后一条事件，归零显示 `×`。摘要函数不修改原始事务数组，详情面板仍消费完整事件历史。
- 阅读模式隐藏时间文字、刻线、命中/拖尾、伤害数字、AKE 投影、资源条、状态引线和编辑辅助层；等待、封组等待、切人保留简短白卡标识。
- 阅读模式点击技能或状态角标只触发查看，鼠标事件不会冒泡到画布编辑逻辑；拖拽、删除、右键编辑被禁用。

## 变更文件

- `demo/lts-ui/src/components/CanvasBoard/SkillButton.tsx`
- `demo/lts-ui/src/components/CanvasBoard/SkillButton.css`
- `demo/lts-ui/src/components/CanvasBoard/CanvasBoard.css`
- `demo/lts-ui/src/components/CanvasBoard/SkillSandbox.tsx`
- `demo/lts-ui/src/components/CanvasBoard/components/CanvasArea.tsx`
- `demo/lts-ui/src/components/CanvasBoard/TimelineWaitSegment.tsx`
- `demo/lts-ui/src/components/CanvasBoard/TimelineOperatorSwitchSegment.tsx`
- `demo/lts-ui/src/components/CanvasBoard/readingModeState.ts`
- `demo/lts-ui/src/components/CanvasBoard/readingModeState.test.ts`

## 验证

- `npm run typecheck`：通过。
- 定向 TypeScript 测试：阅读摘要、状态角标布局、状态色映射均通过。
- `git diff --check`：通过。

完整测试命令触发了仓库既有的 Vite SSR 导入问题：`buffTypeTerminology.test.ts` 无法解析 `./operatorDraftPageModel`；该失败不在本次变更路径内。
