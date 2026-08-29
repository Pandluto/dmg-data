# 测试与 Calc oracle

本目录说明“一个结论由什么证据支持”。测试的责任不是制造完成感，而是把结构覆盖、运行时规则、外部行为和 UI 投影分开验证。

## 证据层级

| 层级 | 证据 | 适合回答的问题 |
| --- | --- | --- |
| L0 | 来源锁、原始 JSON、依赖闭包 | 输入是否固定，技能和 Buff 是否被找到 |
| L1 | parser/compiler 合同测试 | 原始动作是否被正确归一化或显式拒绝 |
| L2 | 状态机与伤害单元测试 | 一个通用原语的事务、顺序和不变量是否成立 |
| L3 | 生成审计与跨角色变形测试 | 全语料是否暴露未实现、需 provider 或证据不足的分支 |
| L4 | 角色机制场景 | 多个原语组合后是否形成预期事件链 |
| L5 | Calc fixture/oracle | 冻结输入下的外部可观察行为是否一致 |
| L6 | 前端合同与真实浏览器 | settled report 是否被忠实投影，交互是否可用 |

低层测试通过不能替代高层证据；Calc 对拍也不能证明未捕获场景。

## 常用命令

| 命令 | 范围 |
| --- | --- |
| `npm run check:docs` | 当前文档入口、相对链接和顶层归档纪律 |
| `npm test` | 根 parser、compiler、运行时、runner、状态机和 oracle 回归 |
| `npm run simulate:pelica` | 固定精确链的佩丽卡场景 |
| `npm run simulate:pelica-generic -- --no-write` | 通用单人链的佩丽卡装配与执行 |
| `npm run verify:cross-character` | 陈千语、狼卫冻结跨角色场景 |
| `npm run audit:ake-actions` | 全 SkillData/BuffData 动作编译覆盖 |
| `npm run audit:ake-ability-events` | ability listener 消费者与生产者覆盖 |
| `npm run audit:ake-operator-mechanisms` | 31 个角色的机制风险分类 |
| `npm --prefix demo/lts-ui run typecheck` | 前端 TypeScript 边界 |
| `npm --prefix demo/lts-ui test` | 前端与 LTS 继承合同 |
| `npm run demo:build` | AKE 工作台生产构建 |
| `npm run test:ria` | RIA schema、存储、recovery、REST/SSE、安全、真实 runtime/replay 合同 |
| `npm run ria:test -- --ria-case-id CASE --ria-session-id SESSION -- test/file.test.mjs` | opt-in Node test；失败时保留 interrupted investigation Run，退出码不变 |
| `npm run ria -- doctor --json` | 从原始档案重建索引并校验 sealed Run 内容哈希 |

`npm run check` 只组合当前文档检查和根测试；前端验证仍需按改动范围显式运行。

完整 LTS UI 套件包含 AKE adapter/provider/runtime ledger、RIA UI sink、Sites mobile-share Worker、共享变速领域模型和 Canvas 结算合同。聚焦测试仍适合快速定位，但交付验收必须同时运行上表中的完整 `npm --prefix demo/lts-ui test`、typecheck 与 Demo build。

## Calc fixture 范围

| fixture 族 | 已冻结的主要事实 |
| --- | --- |
| `pelica-heavy-combo-skill` | 请求/响应兼容、主场景 Hit 与总伤害 |
| `pelica-combo-boundaries` | 开窗、选择、同帧顺序、消费、过期和冷却抑制 |
| `pelica-resource-boundaries` | ATB/USP 获得、消费、封顶和恢复延迟 |
| `pelica-poise-boundaries` | Poise 阈值、节点、恢复、失衡区与处决 |
| `poise-guard-boundaries` | 快速破韧资格、插值、局部时间和到期边界 |
| `ake-interruption-probe` | 指令优先级、缓存、Jump、打断、投射物和脱手 Buff |
| `ake-cross-character-smoke` | 陈千语与狼卫的命令及逐 HP packet |
| `squad-resource-boundaries` | 共享 ATB、成员 USP 和同帧竞争 |

“逐包一致”至少比较帧、来源、技能身份、伤害类型、raw/final 数值和状态变化；只比较总伤害会掩盖顺序、来源和错误抵消。

## 生成审计快照

以下数字来自 2026-08-28 在 tracked 基线 `f9a2067` 的代码与当前工作区审计脚本上重新生成的 JSON；文件本身是权威，表格只是带日期的索引。

| 报告 | 快照 |
| --- | --- |
| `derived/cleanroom/ake-action-coverage.json` | 3,517 个文件、27,289 个动作出现；9,128 executable、11,075 metadata-only、7,086 unresolved；calculator-core executable route coverage 约 96.62% |
| `derived/cleanroom/ake-ability-event-audit.json` | 84 个事件键、1,072 个消费者组；30 类生产者完整，52 类缺少已知生产者，2 类含非法值 |
| `derived/cleanroom/ake-operator-mechanism-audit.json` | 31 个角色、3,030 条 finding；866 条 combat risk，其中 279 blocking、165 partial、422 evidence-missing |

动作覆盖刷新后不再把 `CastSkill` 列为阻塞来源类型；派生技能执行由专门测试验证。这个变化同时说明：旧审计不能在代码更新后继续当作当前结论。

## 生成物维护

修改下列内容后必须重新生成相关报告：

- parser、compiler 或 effect route；
- ability event 生产者/消费者；
- 角色装配、递归依赖或风险分类；
- `spec/engine-semantic-mappings.json`；
- 固定公开数据版本。

生成 JSON 不手改。审计变严造成 finding 增加不自动表示行为回归；审计减少也必须检查是否真的新增执行路径，而不是把节点降级成 metadata。

## 捕获新 oracle

只有明确需要扩展外部行为证据时才更新 Calc fixture：

1. 固定请求、响应、manifest、来源版本和捕获时间；
2. 从原始响应生成最小 oracle，不在运行时代码中读取答案；
3. 先写失败测试，再实现行为；
4. 保留版本不一致和未决参数，不用一个样本外推所有角色；
5. 在维护记录中说明新增了什么保证、仍不能保证什么。

历史探针的完整推导过程保存在 [初始研究档案](../archive/README.md)。
