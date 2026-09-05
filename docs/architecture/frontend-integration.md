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

## 局部接续放大镜

行为合同见 [局部接续放大镜 Spec](../specs/timeline-release-lens/spec.md)。`useCanvasDrag` 复用既有 `releaseAnchorGraph` 候选，把来源按钮矩形、候选、输入版本与时间事实冻结为一次拖动会话。`releaseLensModel` 负责局部坐标和整数帧偏移；`ReleaseLens` 只渲染命中刻线、语义菱形和草稿反馈。主轴共享水位投影不因展开而重排。

镜面每页最多三个语义入口，方向键/滚轮可访问其余入口，数量不固定为三个。命中编号在来源施放内计算；普通命中和拖尾刻线不会自动变成可释放入口。可用性复用主控、连携窗口和同帧占用规则，资源与未证实门槛保留提交后核验说明。

按住拖动时，靠近来源停留后打开镜面；在菱形附近选择建议间隔，在间隔中选择整数帧。左右方向键每次一帧。既有后继旁的短接续标记也能重新打开镜面，以按钮或输入框调整后应用。Escape、失焦、窗口尺寸变化和输入版本变化会取消草稿。草稿只发布 RIA 观察状态，不提交排轴或模拟；有效松手/应用沿既有工作台链进行一次编辑。

保存的 `releaseAnchor` 使用来源按钮身份、事件种类、命中局部偏移或输入窗口语义，以及非负帧延迟。Provider 和 squad runner 解析实际起手、命中、真实结束及输入窗口关系；关系不再以下一次预演帧作为实际输入下界。明确依赖不因动作占用而自动排队越过所选接点。窗口 v1 跟随来源实际起点加保存偏移，再核验本次实际窗口；窗口内部时序改变后若关系失效，会拒绝而非自动换点。未建立明确依赖的同帧命令排序、等待模块来源与角色机制覆盖仍保留既有边界。

“动作结束”包含实际中断结束，与 AllowNext 提前衔接窗口不同。旧窗口缺少普通/精准种类时，重新编辑按保存落点恢复包含它的最窄窗口；缺失的命中关系不能自动选另一个命中。已有明确后继的来源可以移动并带动后继，删除保护和依赖环检测继续生效。
