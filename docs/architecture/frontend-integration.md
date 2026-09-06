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

排轴节点提交 `queueMode: timeline-sequence`：请求帧表示最早希望执行的位置，动作占用时持续等待并重新解析释放时的技能形态。原始按键模拟仍使用 30 帧输入缓存；不能把排轴节点静默转换成一次按键后过期。运行时契约版本进入 execution digest，准入语义更新后旧报告失效并重算。

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

## 排轴中的战斗检查

AKE 模式下，单击技能会在侧栏显示本次动作，双击继续打开完整命中与乘区详情。侧栏分别显示按钮输入、实际结算类型、请求与释放帧，以及本次动作引起的关键状态变化。排轴被阻断时，底部按钮打开具体原因，并可定位到技能或打开对应时间操作的配置。

状态历程按 `frame + sequence` 展示敌方关键状态与队伍共享连击；点击事件读取该事件之后的状态，保留同帧多次变化。共享连击只使用逻辑 ledger，不统计每个队员的状态镜像。消费动作和原始提供动作分别关联；自然到期不会被归为来源技能再次触发。

检查侧栏只读取匹配当前 execution digest 的报告。结算更新、失败与重试均可见；规划不合法时，已经执行的动作标为部分结果，不能据此宣称整条排轴可执行。检查不依赖 RIA 归档接口，也不创建可写的战斗状态。

## 面板值与运行时值

LTS 面板攻击用于展示配置公式；AKE runtime attack 用于 Hit 结算。报告同时保留：

- panel attack；
- runtime attack；
- 角色、武器、能力和活动效果的来源贡献；
- 最终伤害 factors。

二者不同不自动表示错误。UI 必须标明口径，不能用 runtime 值覆盖面板值，也不能把面板舍入差异写成引擎误差。

## 配置与选人图片

AKE 官方目录图片由 `demo/lts-ui/scripts/build-ake-ui-images.mjs` 生成随应用发布的 WebP；
运行 `npm --prefix demo/lts-ui run images:ake` 更新。完整校验账本在
`scripts/ake-image-manifest.json`，浏览器只打包精简的 `akeImageManifest.json`。
默认复用数据版本相同且 SHA-256 正确的文件，`-- --refresh` 强制重新下载。
目录更新后应重新生成资源，并将资源、运行时映射和账本一起提交。

原尺寸图片无损编码；选择器另有 128px 缩略图，通过 `srcSet/sizes` 适配显示密度。
官方 URL 与已经解析的哈希路径必须直接命中同一个资源，不能再进入历史文件名模糊匹配，
否则哈希可能被当成扩展名去掉，图片重新落到旧 PNG。自定义 BLOB、其他外链仍沿用原解析行为。

武器、装备与选人列表使用 `LazyAssetImage`：文本和布局先显示，图片进入滚动可见区域后请求；
武器/装备入口聚焦或指向时最多预热前 12 项。已加载资源复用浏览器缓存，解码异步执行。
带内容哈希的图标在 Vite 和构建服务器均返回一年 `immutable` 缓存，支持 HEAD/ETag。
上游缺失图片由生成账本明确记录，选择器显示文字占位。

## 仍然存在的前端债务

- realtime planner 仍是一套较大的前端规划实现；它与 settled runtime 的重合部分需要继续缩小。
- `fixedDummyStateMachine` 仍服务旧/演示链；AKE settled 模式已撤销其数值权威，但物理删除尚未完成。
- `CanvasBoard` 与 `SkillButton` 仍很大，交互、投影和展示边界需要后续拆分。
- 页面只能在真实浏览器中证明拖拽、详情、状态持久性和视觉含义；Node 合同测试不能代替可见验收。


### 命中锚点与实际结算投影

排轴中的 `damage-hit` 关系不能只提交预演帧。Provider 保留可释放命中的
`releaseDependency`（来源 command、实际命中 skill、技能局部帧与 debounce），
由共享运行时在真实直接伤害发生后调度后继输入。排队、技能变形及终结技暂停均不能
把后继输入提前到来源命中之前。旧的持续伤害锚点仍按既有规则修复，不作为释放边界。
带依赖的场景必须提供 `endFrame`；来源没有到达指定命中时返回
`RELEASE_ANCHOR_NOT_REACHED`，不可回退为预演帧执行。

`CommandAnchored` 与 `ReleaseAnchorResolved` 保留等待与解除等待的来源。
报告与画布使用同一份实际起止帧；显示投影不会写回输入计划，避免反馈重算。
原始释放关系进入 execution digest（workspace runtime v6），即便两种关系暂时得到同一预演帧，
更换关系仍会使旧报告失效。

计算具有递增版本，AbortSignal 或过期版本都阻止结果发布与调试状态覆盖。
RIA 自动记录采用预热工作线程复用不可变数据/编译缓存，每次运行创建独立战斗状态。
结果交付不等待事件写盘、断言哈希、快照构建和封存；这些继续使用同次执行产生的真实
事件完成归档，`RiaRunSealed` 单独通知。显式记录和回放保留原有持久化 checkpoint 行为。


## AKE 存档与报表边界

`integrations/ake/akeWorkspace.ts` 提供新建、保存、打开和完整文件往返，统一使用 SQLite 文档/工作节点和当前版本指针。
官方目录只读；用户存档持有队伍配置和排轴输入。新建和切换前保留当前改动，保存不重新恢复画布。
节点选择与恢复分离，恢复命令独占 checkout 身份的持久化。

`akeExecutionIdentity.ts` 为同一组保存输入生成稳定身份，报告还必须匹配活动 workspaceId。
报表复用 DEF 原有 `DamageReportPptPage` 分页模板和 `MobileReportPage` 三联一图流/PNG 导出器；`akeReportPresentation` 只适配数据，不重新设计展示层，也不调用 DEF calculator。
主口径沿用期望伤害，非暴击与暴击另列；DoT 和技能实体按引擎 memberId 归属干员，实际命中帧决定曲线横轴。部分结算标记进入导出图片。
原图 3/图 4 使用原 DEF Owen 数学模块 `rdpsOwenAttribution`。AKE 命中解析器冻结计算输入，`ake-rdps-context` 按来源过滤后重用引擎属性和伤害公式；`akeRdps.worker` 在报表后台完成归因。固定实际命中和释放计划，完整静态面板归本体，武器/装备被动按实际施加者归属，生成器随来源关闭，严格排除失衡并独立核对未知来源余额。报表只统计敌方 Hp 命中，Poise/Resilience 和己方 Hp 事件保留在原始调试日志。
归因完成后才允许整图导出；RIA Live 的 `report` section 提供来源记录、逐次重构与层级核对、残差分解和耗时。输入失配或过期报告不冒充当前结果。
批注进入 timelineData.reportNotes，随 SQLite 存档和节点恢复；批注不属于计算身份。
本阶段只维护桌面入口；复用 MobileReportPage 的既有图片模板不启动 MobileBootstrap、移动选人或移动排轴流程。
详见 [存档与报表适配记录](../maintenance/ake-workspace-reports-20260905.md)。


## 局部接续放大镜

行为合同见 [局部接续放大镜 Spec](../specs/timeline-release-lens/spec.md)。`useCanvasDrag` 复用既有 `releaseAnchorGraph` 候选，把来源按钮矩形、候选、输入版本与时间事实冻结为一次拖动会话。`releaseLensModel` 负责局部坐标和整数帧偏移；`ReleaseLens` 只渲染命中刻线、语义菱形和草稿反馈。主轴共享水位投影不因展开而重排。

镜面每页最多三个语义入口，方向键/滚轮可访问其余入口，数量不固定为三个。命中编号在来源施放内计算；普通命中和拖尾刻线不会自动变成可释放入口。可用性复用主控、连携窗口和同帧占用规则，资源与未证实门槛保留提交后核验说明。

按住拖动时，靠近来源停留后打开镜面；在菱形附近选择建议间隔，在间隔中选择整数帧。左右方向键每次一帧。既有后继旁的短接续标记也能重新打开镜面，以按钮或输入框调整后应用。Escape、失焦、窗口尺寸变化和输入版本变化会取消草稿。草稿只发布 RIA 观察状态，不提交排轴或模拟；有效松手/应用沿既有工作台链进行一次编辑。

保存的 `releaseAnchor` 使用来源按钮身份、事件种类、命中局部偏移或输入窗口语义，以及非负帧延迟。Provider 和 squad runner 解析实际起手、命中、真实结束及输入窗口关系；关系不再以下一次预演帧作为实际输入下界。明确依赖不因动作占用而自动排队越过所选接点。窗口 v1 跟随来源实际起点加保存偏移，再核验本次实际窗口；窗口内部时序改变后若关系失效，会拒绝而非自动换点。未建立明确依赖的同帧命令排序、等待模块来源与角色机制覆盖仍保留既有边界。

“动作结束”包含实际中断结束，与 AllowNext 提前衔接窗口不同。旧窗口缺少普通/精准种类时，重新编辑按保存落点恢复包含它的最窄窗口；缺失的命中关系不能自动选另一个命中。已有明确后继的来源可以移动并带动后继，删除保护和依赖环检测继续生效。
