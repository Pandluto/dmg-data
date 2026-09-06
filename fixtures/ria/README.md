# RIA 实验输入

整理日期：2026-09-06；整理基线：`680c0c8`（2026-09-06）。这里是引擎可重放输入，不是可导入前端的 SQLite / v2 存档文件，不包含完整节点树、画布与报告批注。

## 最近实验

| 输入 | 用途与限制 |
| --- | --- |
| [别礼／汤汤延迟附着九动作](lastrite-tangtang-status-provenance.json) | 本轮状态归属修复的原始 Run 输入，包含配装、释放依赖与原 commandId；四次主动战技，无显式下落，不是三战技最优结果 |
| [早期别礼／汤汤热启动爆发](lastrite-tangtang-hot-start-burst.json) | 早期完整配装候选，与上行指令和终点不同；不能用其输出替代当前九动作验收 |
| [洛茜／卡缪追加终结技](wulfa-camille-appended-ultimate.json) | 保留指定命中后 6 帧接洛茜 Q 的关系；该历史夹具 equipment 为空，不能冒充当前浏览器完整配装 |

其他目录内夹具继续用于各自 RIA 示例或机制复现，名称不表示全角色游戏规则已获验证。常规配装口径见 [默认实验配装](../../docs/knowledge/experiments/default-loadout.md)；内部武器潜能编码与用户口径分开核对，不为统一外观改写历史输入。

## 九动作输入来源

原文件逐字节复制自本地 sealed Run 的 `fixture.json`，未编辑参数：

- Case：`browser-case-20260906T120039199z-7b73b10a`。
- Run：`run-b4628211-d721-4919-8a9e-46296caad6eb`。
- 原执行提交：`6b75ec5c94a9c202bd7149dded04668408cf20f6`，manifest 记录 `dirty: false`。
- 文件 SHA-256：`b1ffb628c95d53b86d8b546503db401f091997df44945d31820ff25056ca7bb8`。
- 原观察：30 FPS，总伤害 `647779.4031308988`；F23/126/137/194 依次施冷，F206 消耗四层。源码版本变化后应重新核对，不能把历史读数当成无条件断言。

[状态来源知识](../../docs/knowledge/data/status-source-and-trigger.md) 保存事件因果链与反事实 Run；[状态 Spec](../../docs/specs/timeline-state-flow/spec.md) 保存 UI 合同。此输入只保留引擎复现能力，不能独立证明 DOM 布局或还原完整浏览器工作区。

按 [RIA 指南](../../docs/guides/ria-quickstart.md#记录第一个-run) 创建自己的 Case / Session，再将 `record --fixture` 指向本目录文件。重放产生新 Run，并记录新执行版本；不要覆盖旧 sealed Run。完整 Run、截图和本地 SQLite 不随这些小型夹具自动上传。
