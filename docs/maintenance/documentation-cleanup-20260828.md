# 2026-08-28 文档重组记录

> 后续状态：本记录所述重组与 RIA 工作已经由提交 `0bea9f8` 入库。下文出现的“尚未提交”“当前工作区”保留 2026-08-28 当时语境，不再表示现在的仓库状态。

## 目标与基线

本轮目标是把仓库从“按开发日期不断追加研究报告”整理为与 `dmg-end-field` 一致的长期文档体系：入口短、当前事实唯一、研究与验证分层、历史完整可追溯。

整理开始时：

- 分支为 `main`，相对 `origin/main` ahead 28；
- tracked HEAD 为 `f9a20675bba97ac8d7adb9ee2473b5545be3e6e3`；
- `README.md` 有尚未提交的文档入口修改；
- `docs/18-*`、`19-*`、`20-*` 是尚未跟踪的用户草稿；
- 顶层共有 22 份旧文档，约 8,517 行，混合了事实、实验、计划、提交过程和已过期统计。

本轮没有修改战斗引擎或前端业务实现。为核对文档中的当前结论，重新运行了三类生成审计；其 JSON 变化单独保留在工作区。

## 新的信息架构

| 位置 | 唯一责任 |
| --- | --- |
| 根 `README.md` | 项目定位、边界、最短运行路径和文档入口 |
| `docs/README.md` | 文档地图与维护规则 |
| `docs/architecture/` | 当前跨模块事实、职责、边界和验证口径 |
| `docs/testing/` | 证据层级、oracle、命令和生成审计 |
| `docs/research/` | 仍有价值的外部设计对照与机制目录 |
| `docs/guides/` | 可执行的开发流程 |
| `docs/maintenance/` | 重组、迁移、冲突决策和提交演变 |
| `docs/archive/` | 不再作为当前事实使用的原始材料 |

没有新增 `AGENTS.md` 或合同目录。代理操作说明不是架构事实源，本阶段的核心是让代码事实、验证方法和文档责任闭合。

## 逐文件迁移

| 原文 | 当前承接位置 | 处置 |
| --- | --- | --- |
| 01 数据来源 | `architecture/data-lineage.md` | 重写为固定来源、证据能力和依赖链 |
| 02 Buff 状态机 | `architecture/combat-runtime.md` | 合并进统一状态事务 |
| 03 佩丽卡脉冲 | `testing/README.md` | 保留为 oracle 证据族，过程归档 |
| 04 缺口与路线 | `architecture/known-boundaries.md` | 只保留仍存在的边界，旧路线归档 |
| 05 原始到分析 | `architecture/data-lineage.md` | 与 01 去重 |
| 06 最小模拟器 | `architecture/runtime-topology.md`、`testing/README.md` | 区分固定精确链与通用链 |
| 07 Poise 处决 | `architecture/combat-runtime.md`、`testing/README.md` | 当前模型与 oracle 分开 |
| 08 Poise 局部时钟 | `architecture/combat-runtime.md`、`testing/README.md` | 当前责任与边界分开 |
| 09 通用运行时 | `architecture/current-system.md`、`combat-runtime.md` | 去掉实现日志，保留组件责任 |
| 10 compiler/覆盖 | `architecture/data-lineage.md`、`known-boundaries.md`、`testing/README.md` | 结构、风险和数字分层 |
| 11 自动装配 | `architecture/runtime-topology.md` | 合并当前单人/小队执行链 |
| 12 打断探针 | `architecture/combat-runtime.md`、`testing/README.md` | 规则与证据范围分开 |
| 13 指令准入 | `architecture/combat-runtime.md` | 合并 admission 领域职责 |
| 14 Endaxis 对照 | `research/endaxis-comparison.md` | 提炼稳定结论，历史测量归档 |
| 15 账本升级计划 | `architecture/overview.md`、`frontend-integration.md` | 已落地事实进入架构，计划留历史 |
| 16 正确性研究 | `architecture/frontend-integration.md`、`known-boundaries.md` | 合并责任/冲突，实施日志归档 |
| 17 机制审计 | `research/operator-mechanism-catalog.md`、`known-boundaries.md` | 机制目录与当前审计状态分开 |
| 18 架构草稿 | `architecture/` 全组 | 拆成可维护的短页 |
| 19 前端接线草稿 | `architecture/frontend-integration.md`、`runtime-topology.md` | 去重后重写 |
| 20 逐角色草稿 | `research/operator-mechanism-catalog.md` | 删除漂移状态，保留机制测试维度 |
| 跨角色验证 | `testing/README.md` | 作为独立 oracle 族 |
| 共享变速笔记 | `architecture/shared-variable-rate-timeline.md` | 当前模型短页；完整推演归档 |

所有原文正文均完整保存在 `docs/archive/initial-research-series/`，没有用摘要替换历史材料。19 份 tracked 旧文档中 17 份与 `f9a2067` 字节一致；01、02 只移除了文件尾的一个额外空行。三份未跟踪草稿未改写正文。

## 冲突分析与裁决

| 冲突 | 证据 | 当前裁决 |
| --- | --- | --- |
| 旧文档写死测试总数和 88.51% 覆盖 | 测试与 compiler 后续持续增加 | 当前架构不写总测试数；统计只进入带日期的测试快照 |
| 逐角色草稿称 `CastSkill`/`switchToBuffConfig` 未实现 | `1051dcf`、`d155afc` 及派生技能专项测试已经落地 | 当前文档写为通用 `LaunchSkillProgram` 路径；旧判断仅留档案 |
| 旧 operator audit 仍把 `CastSkill` 计为 blocker | 重新生成后 `bySourceType` 已无 `CastSkill` | 刷新 action/operator audit，禁止抄旧 JSON |
| 前端存在 preview 与 settled 两套结果 | provider 的 execution digest 与 ledger 已明确结算优先 | settled 匹配时是唯一数值权威；preview 只做未结算规划 |
| 文档把固定 simulator 与 `CombatRuntime` 写成同一引擎 | 代码仍有两套资源/Buff/部分 Poise 模块 | 明确为固定精确链和通用产品链，迁移前不声称统一 |
| “31 名角色可执行”被写成“逐角色正确” | 最新逐角色审计仍有 866 条 combat risk | 只声明装配/执行能力，精度按 fixture 和机制场景逐项证明 |
| `unresolvedEffectCount = 0` 被当作完整 | 卡缪历史案例曾成功但 0 Hit | 结构 audit、事件可达性、运行结果和 oracle 必须分别验证 |
| UI 从按钮名/Buff 名推演机制 | 派生技能和共享状态会破坏一一对应 | UI 只读 command/cast/Hit ledger，不拥有第二套战斗状态 |
| 源码行号成为长期事实引用 | 文件在两天内快速演变 | 当前页只引用稳定文件名、导出名、测试名和报告键 |
| 路线、完成日志和架构事实混在一页 | 旧文档随每次提交不断追加 | 当前事实、维护过程、外部研究和档案分目录 |

## 职责冲突分析

- 数据仓库只提供静态事实，不决定运行时语义；语义桥接属于 `spec/` 和 compiler。
- assembler 收集依赖，runner 决定命令，`CombatRuntime` 执行效果；三者不互相吞并。
- 状态、资源、冷却、Poise、控制韧性和连携各有所有者；UI 图标相似不等于可以共用状态槽。
- timeline projector 只投影已结算事实；realtime planner 可以预演，但不能覆盖 settled report。
- runtime ledger 格式化 factors 和 contributions，不重新计算伤害。
- 架构页解释长期语义；生成 JSON拥有数字型覆盖事实；维护页解释变化原因。

## 审计刷新

为验证旧文档冲突，本轮执行：

```bash
npm run audit:ake-actions
npm run audit:ake-ability-events
npm run audit:ake-operator-mechanisms
```

结果：

- action audit：3,517 文件、27,289 次动作；9,128 executable、11,075 metadata-only、7,086 unresolved；
- ability event audit：84 个事件键、1,072 个消费者组；文件内容未变化；
- operator audit：31 个角色、3,030 finding、866 combat risk；
- `CastSkill` 从阻塞来源类型中消失；派生技能相关 30 个聚焦测试全部通过。

相对 tracked 生成物，action audit 的 executable 从 9,114 变为 9,128、unresolved 从 7,100 变为 7,086；operator audit 的 finding 从 3,034 变为 3,030、combat risk 从 874 变为 866，其中 blocking 289 → 279、partial 163 → 165、spatial assumption 1,771 → 1,775。分类并非单调分数，必须连同具体 finding diff 阅读。

这些结果只证明当前生成脚本对当前语料的分类与专项合同，不扩大为全角色精确声明。

## 最终验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run check:docs` | 通过；21 个当前文档、87 个本地链接 |
| `npm test` | 通过；根引擎 290/290 |
| 派生技能聚焦测试 | 通过；30/30 |
| AKE 前端聚焦合同 | 通过；共享变速轴、runtime ledger、adapter、catalog、provider、realtime 和 Canvas 结算均执行完成 |
| `npm --prefix demo/lts-ui run typecheck` | 通过 |
| `npm run demo:build` | 通过；Vite 转换 399 个模块 |
| `npm --prefix demo/lts-ui test` | 未完成；当前 Demo 未包含 `worker/mobileShareApi`，套件在 `sitesMobileShareApi.test.ts` 中止 |

以上表格保存 2026-08-28 当时的验证记录。2026-08-29 的 RIA 验收工作补齐了 `worker/mobileShareApi.ts` 及其既有合同；当前验证状态以 [测试入口](../testing/README.md) 和最新命令结果为准，不再把该历史缺失列为当前边界。

## 可追溯性与恢复

tracked 旧文档可直接从基线恢复或比较：

```bash
git show f9a2067:docs/12-calc-interruption-probe.md
git diff --find-renames f9a2067 -- docs
```

18–20 三份原本未跟踪的草稿无法通过旧 Git 对象恢复，因此本轮优先完整归档。当前工作仍未代替用户提交；提交前可以从 `git status`、`git diff --find-renames` 和本记录核对每一项移动、重写与生成物变化。

## 完成标准

- 顶层不再存在编号旧文档；
- 每项当前事实只有一个主要落点；
- 所有旧文档都有归档和新位置映射；
- 冲突有代码、测试或生成审计支撑的裁决；
- 完整 Git 提交演变可查；
- 文档链接由仓库命令自动检查；
- 根测试、前端类型和 Demo 构建按最终工作区重新验证。
