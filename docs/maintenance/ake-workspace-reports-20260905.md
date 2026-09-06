# AKE 存档、版本历史与桌面报表适配

## 数据边界

官方干员、武器、装备来自 AKE catalog，界面只读。干员等级、潜能、技能等级、武器与装备仍在队伍配置页修改。
`akeWorkspace.ts` 负责存档的新建、保存、打开、文件导入与导出。存档保存用户输入及配置，不保存可编辑的官方目录。
沿用现有 SQLite 文档/节点表和 v2 便携容器，避免改名或重建数据库损坏已有数据；payload 增加 AKE 数据版本元信息。
旧存档无版本元信息时明确显示为旧存档，仍通过既有兼容转换读取。

## 修正的存档行为

- 首页成为存档管理：命名空存档、保存、直接打开、导入与下载完整文件。
- 命名空存档首次选择队伍时填入同一文档；改变阵容不再删除原临时文档。
- 换档、新建、导入和恢复节点前保存当前改动。保存统一规范化 timeline/table 镜像并建立 checkpoint，避免保存后再次执行整套 renderer checkout。
- SQLite 写入失败保留待写内容；重试不会覆盖其后产生的新编辑。
- 文件导出保留节点父子关系、提交和当前版本指针；只有工作节点、没有初始 snapshot 的旧文档也可导出。
- 启动时在 SQLite hydration 后恢复活动文档身份，直接打开报表/存档页也能取得正确文档名称。
- 树面板不再二次写入 checkout 时间戳。选择节点只查看；关闭窗口不恢复，点击“恢复所选版本”才应用。
- 当前版本与所选版本分别展示。详情读取该版本的真实配装，以及队伍、输入、释放关系、主控和配装差异。

## 报表

原项目位于 `/Users/sailstellar/Documents/coding/dmg-end-field`。本次重新核对其 `docs/architecture/data-lifecycle.md`、`docs/specs/ai-timeline-worktree/spec.md`、`docs/specs/mobile-portrait-workbench/mobile-workbench-runtime.md` 和 `docs/specs/rdps-attribution-phase2/spec.md`。
报表保留原 `DamageReportPptPage` 分页模板与 `MobileReportPage` 三联一图流，包括配装卡、四车道、批注、原图表和 PNG 导出/预览/列高平衡。适配入口为 `akeReportPresentation.ts`；不调用 DEF calculator。
另做的独立 AKE 报表、SVG/PDF 流程和侧栏图表已撤除。

主口径沿用原报表的期望伤害，非暴击、暴击分别汇总；不把 finalDamage 当作期望。
累计曲线按实际命中帧聚合，同帧命中一起累计；横轴包括等待、队列和结算尾段。四车道显示实际释放时间及延迟。
角色伤害归属首先使用引擎 memberId/characterId，不能把敌方 DoT 承载者或 ability entity 的 ownerId 当作角色。
使用原导出器生成 3840px 宽三联 PNG；批注保存到 timelineData.reportNotes，随节点和存档恢复，且不使计算缓存失效。
未验证的释放规则、失败/跳过的输入或未解析效果保留“部分结算”状态，并写入 PNG。
原图 3/图 4 已接入 AKE RD。原 DEF 的 Owen 引擎原样抽取为 `rdpsOwenAttribution.ts`，旧 DEF 服务和 AKE 适配共用它；没有重新实现图表。
`ake-damage-resolver.mjs` 冻结每次命中的九段属性组件、已解析效果来源、属性增伤、注册乘区和特殊结算输入。`ake-rdps-context.mjs` 在来源开关之后调用同一 `evaluateAttributeComponent` / `calculateDamage`，不按最终乘区比例分摊。
完整静态面板（含武器与装备静态数值）保留在直接伤害，归入实际出伤干员本体；被动效果进入 operator/weapon/equipment。跨队武器按 loadoutSourceKey 的持有人归属，不按受益者归属。连击逐层保留 teamComboGrantId 与施加者。Buff 生成的持续/追加伤害在生成器层关闭。
严格关闭失衡来源；无法确认的来源保留在 Owen 基线，直接伤害基线则关闭。独立记录失衡差额与未知来源差额，核对总账、Owen 效率和域层级；负贡献保留符号。旧结果没有输入快照或逐次重算不能还原时停止归因，不能输出伪造的完整结果。
归因冻结本次已经执行的命中、释放顺序和触发条件，不通过关闭增益重新安排技能释放或重放资源调度。引擎尚未实现的规则仍遵循“部分结算”标记。
归因只在报表后台 Worker 中运行，不加入拖拽/松开按钮后的实时重算；页面等待四图就绪后开放 PNG 导出。缓存绑定存档、输入和本次生成时间。直接打开报表或刷新后，自动计算缺失的当前结果。

`akeExecutionIdentity.ts` 从实际输入生成稳定身份，排除 UI revision 和时间戳。
报告同时绑定 workspaceId；空存档、切换文档、输入变化时旧报告不能继续充当当前结果。
计算发布还检查活动存档，跨存档的迟到响应被丢弃。报告与预演仍是派生数据，不写回释放计划。

## 入口清理

删除干员编辑页及其专用持久化、编辑模型、分享导入和图片选项代码。
保留运行时目录适配器与仍被共享的 Buff 模型。旧编辑路由展示官方只读资料。
移除批量 Buff 编辑入口和旧编辑页预加载，主入口固定桌面；仅复用 MobileReportPage 的既有一图流模板，不接入移动选人、排轴或 MobileBootstrap。
旧资料移除/资源发包入口在 AKE 模式隐藏，完整 SQLite 备份入口保留。

## 实际验收

在用户可见的 Google Chrome 中完成：命名空存档 → 选择洛茜 → 排轴 → 保存；文档身份不变。
然后打开原“洛茜·卡缪排轴”，显式恢复原节点。RIA 回读确认 renderer 与 SQLite checkout 的 targetId/updatedAt 完全一致。
与修改前快照逐字段比对，原队伍、全部配装字段、8 个按钮和释放锚点保持一致。

原轴对敌输出：期望 **268187.2896942909**、非暴击 **230881.64652018918**、暴击 **332347.279588412**。191 次对敌 Hp 命中；20 次目标为己方的 Hp 事件和 143 次 Poise 事件保留在引擎日志，不计入对敌报表。此前 274410.9154679683 的期望数混入了己方目标事件，已修正。MainTargetFinder 字段不能脱离 targetSource 的实际选择模式来判断目标错误，本次没有据此改动目标解析。
普通出伤、技能汇总、累计曲线、分页和一图流使用同一份对敌期望命中。原轴 RD 为洛茜 200625.339130459、卡缪 67561.950563832；其中卡缪武器 15169.387761262 的增益归回卡缪。当前只穿单件静态装备，没有装备被动边际贡献，装备域为零，静态面板仍包含该装备。
当前卡缪连携仍含未验证规则，展示部分结算，不将其标成完整验证通过。
Chrome 实际归因约 **12.5 ms**、12 次来源组合评估；191 次命中重构误差全部为零，总账误差约 3.64e-11。
Chrome 已通过原导出链生成 **3840×2053 PNG**（`终末地战术报告-20260905-1609.png`）；与本地 2026-08-23 DEF 一图流对照，保留原配装卡、四车道和列高平衡，四张图与技能明细全部入图。
新增只读调试命令 `workspace-snapshot` 可在选人、存档和报表页读取完整输入及版本身份。

另用原轴真实快照和实际表结构，在隔离的 Node SQLite 数据库完成保存/打开/文件往返、节点父子关系、旧版本恢复、失败写入重试验证。
稳定输入身份从约 156 KB 缩减至约 9.5 KB，释放锚点改变会失效，时间戳变化不影响身份；RIA planner 不再因重复大体积身份字段截断。

定向验证：存档 JSON 边界、session 身份、选人策略、保存顺序、配置差异、失败写入、伤害来源归属与同帧累计，以及 RIA live API。
执行 TypeScript typecheck 和 `npm --prefix demo/lts-ui run demo:build`。未发布线上版本。

## RD 调试与回归依据

RIA Live 增加 `report` section，包含计算阶段、存档与输入身份、完整 RD 来源/域汇总、44 条来源记录、连击 grant ID、逐次重构误差、独立差额和耗时。通过 `/api/ria/live/sessions/SESSION_ID/snapshot?section=report` 读取；完成/失败同时进入事件日志。

`node --test test/ake-rdps-context.test.mjs test/ake-damage-factor-fixtures.test.mjs` 对照实际 CombatRuntime 计算：8 个开关组合覆盖非线性攻击组件、静态装备、装备暴击/增伤、跨队武器、减抗；另核对负贡献、未知来源、失衡和追加伤害生成器、己方目标/韧性过滤、旧输入与失配拒绝。
原 `rdpsContributionService.test.ts` 通过，抽取没有改变原数学算法。实际原轴通过隔离 SQLite 往返、配装/节点/批注恢复与两套报表总量核对；typecheck 与生产构建通过。
