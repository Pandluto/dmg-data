# 验证矩阵

| 层级 | 命令或操作 | 证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 来源一致性 | `npm run check:consistency` | pins、逐文件哈希、语料哈希、资产索引和递归依赖闭包相互一致 | 游戏行为正确 |
| 当前证据 | `npm run docs:evidence:check` | 人类可读快照可由当前锁、目录和 audit 字节重建 | audit 分类本身正确 |
| 当前文档 | `npm run check:docs` | 证据新鲜、必要入口/Spec 结构/相对链接有效，编号旧文档未回流顶层 | 内容语义一定正确 |
| 根回归 | `npm test` | 编译器、运行时、状态机、runner 与冻结 oracle 的现有断言 | 未覆盖角色/组合正确 |
| 固定佩丽卡 | `npm run simulate:pelica` | 精确链仍可生成固定场景结果 | 通用链一致或全角色正确 |
| 通用佩丽卡 | `npm run simulate:pelica-generic -- --no-write` | 公开数据闭包到通用运行时可执行 | 全语料分支完整 |
| 跨角色 | `npm run verify:cross-character` | 陈千语、狼卫冻结场景逐包对拍 | 其他角色或其他输入 |
| 动作审计 | `npm run audit:ake-actions` | 全语料 action 的编译状态与 provider 缺口 | 实际事件一定可达 |
| 能力事件审计 | `npm run audit:ake-ability-events` | listener 消费者与已知生产者覆盖 | 生产者在所有场景都会触发 |
| 逐角色审计 | `npm run audit:ake-operator-mechanisms` | 每名角色的阻塞、部分、证据和空间风险 | 数值精度或 UI 正确 |
| 前端类型 | `npm --prefix demo/lts-ui run typecheck` | TypeScript 接口可编译 | 页面运行行为 |
| 前端测试 | `npm --prefix demo/lts-ui test` | LTS 与 AKE 适配的现有合同 | 浏览器布局与交互 |
| Demo 构建 | `npm run demo:build` | AKE Demo 可生产构建 | 真实操作可用 |
| 真实浏览器 | 启动 `npm run demo` 后操作 | 拖拽、等待、换人、结算、状态和详情的可见结果 | 未操作路径 |

`npm run check` 依次执行来源一致性、证据/文档检查和根回归。它是仓库基础门，不替代前端类型、前端测试、Demo 构建、RIA 专项或浏览器验收。

## Oracle 比较口径

不同 fixture 比较不同事实：

| fixture | 主要口径 |
| --- | --- |
| 佩丽卡主链 | 命令帧、逐 Hit、导电、ATB/USP 与总伤害 |
| 连携边界 | 窗口左右边界、多 pending、选择、消费和冷却抑制 |
| 资源边界 | 获得、消费、封顶、恢复延迟和同帧顺序 |
| Poise | 阈值、溢出、节点、失衡易伤、恢复和处决 |
| 快速破韧保护 | 敌人局部时间、资格窗、倍率插值和到期边界 |
| 打断探针 | 指令优先级、缓存、Jump、投射物取消和独立 Buff |
| 跨角色 smoke | 陈千语与狼卫的命令和逐 HP packet |
| 小队资源 | 共享 ATB、成员 USP 和同帧竞争 |

“逐包一致”至少比较帧、来源技能、伤害类型、raw/final 值，不能只比较总伤害。

## 变更对应验证

- 改 parser/compiler：根测试 + 动作审计 + 受影响角色场景。
- 改状态机/伤害：根测试 + 对应 oracle + factor validation。
- 改 runner/时间：命令、同帧顺序、打断、小队与时间轴投影。
- 改生成审计：重新生成并检查 diff，不手工同步统计。
- 改前端 adapter/ledger：前端聚焦测试 + typecheck + Demo build。
- 改时间轴交互：领域测试 + 真实浏览器验收。
- 改公开数据：固定 version/revision、重建语料/来源锁、全部生成物、oracle、前端目录和版本边界重新审查。
- 改 Spec/架构：文档检查 + 对应事实源；不能只让链接通过。

## 浏览器验收记录

涉及 UI 语义的变更至少记录：

- 当前 commit 和 execution digest；
- 队伍、敌人、按钮顺序和配置；
- 输入按钮、实际执行技能和有效结算类型；
- Hit 数、状态 before/delta/after、资源和最终状态；
- 可见标签是否与 report 一致；
- 控制台错误。

截图可以作为证据附件，但不能代替结构化运行时报告。
