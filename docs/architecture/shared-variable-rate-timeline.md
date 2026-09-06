# 共享变速时间轴

## 核心结论

时间轴的权威是战斗帧和动作关系，不是格子宽度。视觉列由已经解析的强事件边界生成，因此同样宽的列可以代表不同持续时间，同一帧也可以因零时长控制事件拥有左右两个视觉位置。

```text
按钮关系 / 等待 / 换人
        ↓
释放锚点与组内 lane
        ↓
真实 startFrame / blocking endFrame
        ↓
强事件边界切列
        ↓
共享斜率的视觉投影
```

## 领域对象

| 对象 | 含义 |
| --- | --- |
| release group | 共享起点语境下的一组并行 lane |
| lane action | 同一 lane 内首尾相接或由显式锚点定位的动作 |
| full wait column | 封住前一组并延后下一组的整列控制事件 |
| lane wait | 只影响某个 lane 后继的普通等待，不分隔大组 |
| operator switch | 组内零时长控制权交接 |
| activity column | 由当前组真实帧边界切出的可视区间 |
| release cohort | 同一释放批次的原子准入候选 |

每个第二及后续 release group 必须有完整 wait column 作为强边界。普通等待不能假装成分组封条。

## 时间口径

一个技能至少有多种时间：

- requested frame：用户希望释放；
- admitted/actual frame：运行时真正接纳；
- Hit frames：各命中提交；
- blocking end：下一动作可开始的阻塞结束；
- natural end：根程序自然结束；
- effect tail：投射物、DoT 或 Buff 的后续事件。

按钮占格使用 blocking duration；延迟 Hit 和效果尾链继续投影，但不无条件拉长按钮或阻止下一输入。

## 等待模式

完整等待列支持：

| 模式 | 解析 |
| --- | --- |
| `seal-only` | 只建立组边界，不推进帧 |
| `fixed-duration` | 推进明确帧数 |
| `atb-target` | 由运行时求到目标 ATB 的最早帧 |
| `next-group-ready` | 由准入与资源状态求下一组可释放帧 |

动态等待必须通过注入的 resolver；无法达到目标时返回失败，不能用任意默认秒数。

## 释放锚点

当前按钮关系不是普通链表。普攻截段、派生按钮、等待、并行尾链和换人共同形成释放锚点图：

- 组内无显式 offset 时保持 lane tail-chain；
- 有 `releaseAnchor` 时从锚点关系解析 offset；
- 删除或移动必须处理依赖该锚点的后继；
- lingering Hit 不成为新的释放锚点；
- 同帧动作使用稳定顺序，不靠 DOM 顺序决定。

## 准入与投影分离

`sharedVariableRateTimeline.ts` 是纯领域投影模型。它允许注入 release cohort validator 和动态 wait resolver，但不拥有 ATB、冷却、连携或技能形态状态。

前端 `akeRealtimeTimeline.ts` 提供未结算时的规划反馈；服务端 settled timeline 来自真实 runner。两者都投影到相同视觉坐标，但结算存在时必须优先显示结算的命令、Hit 和窗口。

## 紧凑占位与状态显示

桌面 AKE 压缩按整项操作申请宽度，跨角色边界切出的多个正时长段共享一份操作空间，避免每段重复保留整格。封组等待和零时长控制仍保留可见占位；统一重映射动作、时间、资源与分页，不修改战斗帧。算法与长轴对照见 [按操作分配宽度](../maintenance/long-timeline-width-20260906.md)。

状态底端按真实生效帧投影，上方圆标另按负责动作申请水平槽；斜线连接两者。阅读模式保留同一横坐标，将全部状态移到白卡外的固定下方行，不显示引线。圆标位置表达归属，不能当作精确时间刻度；来源与触发身份、拥挤边界见 [状态时序 Spec](../specs/timeline-state-flow/spec.md)。

## 保持稳定的特色

- 真实帧权威；
- 同列共享斜率；
- 强边界分组；
- 零时长等待和换人仍占可见列；
- 技能按钮保持紧凑；
- Hit、状态、资源和冷却沿真实帧投影；
- 非因果 Hit、状态伤害和长尾 DoT 不参与释放吸附。

初始设计的完整推演过程保留在历史档案；本页只描述当前已落地模型。
