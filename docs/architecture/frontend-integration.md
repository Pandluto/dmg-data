# 引擎与前端接线

## 职责边界

| 层 | 可以做 | 不可以做 |
| --- | --- | --- |
| LTS 配置页 | 收集角色、等级、武器、装备与面板快照 | 把面板显示值冒充 Hit 时运行时属性 |
| catalog adapter | 映射 AKE 目录到现有选择界面 | 决定战斗状态或伤害 |
| realtime planner | 在无结算时预演释放位置、资源和窗口 | 覆盖匹配当前输入的 settled report |
| provider | 组装请求、调用 API、验证 digest、保存报告 | 在浏览器复制根伤害公式 |
| runtime ledger | 按 command/cast/Hit 格式化报告 | 按中文名、按钮顺序或旧 Buff 列表重新推演 |
| React 组件 | 展示、筛选、选择 Hit 和交互 | 创建第二套可写战斗状态 |

## 目录与 API

`akeCatalogAdapter.ts` 将 AKE 角色、武器、装备、敌人、技能角色和 timing profile 转成 LTS 可消费目录。目录接口是 `GET /api/ake/catalog`。

小队主链使用 `POST /api/ake/squad/simulate`。请求包含：

- enemy；
- 成员和配装；
- 共享 ATB 初值；
- 由共享变速模型解析的命令与请求帧；
- 计算终点。

返回 schema v3，包含成员、命令、Hit、状态事件、属性快照、timeline、诊断和 final state。

## 输入键与运行时命令

LTS 按钮键沿用产品约定：

| UI skillType | 运行时 commandType |
| --- | --- |
| `A` | `Attack` |
| `B` | `NormalSkill` |
| `E` | `ComboSkill` |
| `Q` | `UltimateSkill` |

按钮身份不等于最终结算身份。强化 B 可以实际执行派生连携程序；UI 应显示“战技输入”和“连携结算”两个事实，而不是把按钮改名后丢失输入来源。

## 预演与结算

前端保留两种结果等级：

1. **preview**：根据目录、timing profile 和当前按钮关系提供即时拖拽/等待反馈；
2. **settled**：根运行时实际执行后返回的命令、Hit、状态和资源。

页面为当前排轴生成 execution digest。只有 digest 匹配的 report 才能成为 settled 权威；输入变化后旧 report 立即变 stale。

结算 command view 的状态为：

| 状态 | 含义 |
| --- | --- |
| `manual-preview` | 非 AKE 运行时模式 |
| `pending` | 当前排轴尚无结算 |
| `stale` | report 不包含当前按钮或 digest 已变化 |
| `rejected` | 运行时明确拒绝命令 |
| `partial` | 技能执行但 Hit、factor、状态或诊断不完整 |
| `settled` | 当前命令存在完整可用账本 |

运行时失败时不得显示旧计算器的数值作为替代答案。

## 报告与账本

`akeProvider.ts` 保存原始报告，`akeRuntimeLedger.ts` 生成页面读取模型：

- 按 `commandId` 找到按钮结算；
- 按 `castId/rootCastId` 绑定派生 Hit；
- 每个 Hit 使用自己的 factor 和状态快照；
- 同名不同来源仍保留独立 contribution；
- 队伍共享连击在主轴聚合显示，消费后在当前 cast 显示 consumed；
- 关键状态与普通自身 Buff 分组，但不改变底层事件；
- callback settlement、DoT 和 status Hit 不冒充按钮主 Hit。

`AkeReportDrawer` 展示整队实际时序；`SkillButton` 的详情只读取对应 command ledger。

## 面板值与运行时值

LTS 面板攻击用于展示配置公式；AKE runtime attack 用于 Hit 结算。报告同时保留：

- panel attack；
- runtime attack；
- 角色、武器、能力和活动效果的来源贡献；
- 最终伤害 factors。

二者不同不自动表示错误。UI 必须标明口径，不能用 runtime 值覆盖面板值，也不能把面板舍入差异写成引擎误差。

## 仍然存在的前端债务

- realtime planner 仍是一套较大的前端规划实现；它与 settled runtime 的重合部分需要继续缩小。
- `fixedDummyStateMachine` 仍服务旧/演示链；AKE settled 模式已撤销其数值权威，但物理删除尚未完成。
- `CanvasBoard` 与 `SkillButton` 仍很大，交互、投影和展示边界需要后续拆分。
- 页面只能在真实浏览器中证明拖拽、详情、状态持久性和视觉含义；Node 合同测试不能代替可见验收。
