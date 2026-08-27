# AKE / Calc Buff 行为复现基线

这个目录用于整理公开的 AKE 数据、AKE 解析器参考实现，以及对 Calc 公共接口的黑盒观察。当前已经有一个独立编写、可执行、可回归验证的佩丽卡最小战斗核心：四段普攻（第四段作为重击）→ 连携技 → 战技；连携触发已从角色特判改成数据驱动的通用规则执行器，并已加入失衡累计、失衡节点、失衡易伤、处决门控、处决技力返还、敌方局部时钟与快速破韧后的保护状态。

在精确佩丽卡链路之外，项目现在还包含一套独立的通用战斗运行时骨架：统一实体/事件上下文、条件与效果解释器、多时钟域、多实体/共享资源、HP/治疗/护盾、实体级 Buff、来源光环、元素积蓄/反应、控制韧性与处决量表已经接入同一个 `CombatRuntime`。这部分本轮只做轻量代码测试，尚未宣称达到全角色或全系统的 Calc 精确度。

公开 AKE 原始 Skill/Buff JSON 现在可经 `AkeActionCompiler` 编译到这套通用运行时；伤害、Buff 生命周期和时间轴、资源、光环、反应、韧性，以及潜能/天赋/装备被动已有可执行子集。公开表自动装配器与通用指令驱动已经能在不读取旧模拟结果的情况下重放完整佩丽卡主链，见 [公开数据自动装配与佩丽卡通用运行时回放](docs/11-automatic-assembly-and-generic-pelica-replay.md)。指令准入已经从角色/指令特判改成证据映射驱动，并输出逐次决策审计，见 [数据驱动的指令准入与优先级](docs/13-data-driven-command-admission.md)。全公开语料的逐动作编译审计见 [AKE 动作编译器、通用执行链与覆盖审计](docs/10-ake-runtime-compiler-and-coverage.md)。

## 边界

- 只同步公开 URL，不读取父目录中的 `local-20260809030612.json`。
- 不尝试取得未公开的 Calc 后端源码，不绕过鉴权，也不探测非公开接口。
- `reference/third-party/akedatabase/` 是强 copyleft 的第三方参考快照，不应直接复制进未来的闭源实现；上游 README 声明 AGPL-3.0，而当前 `LICENSE` 快照正文为 GPL-3.0，差异记录在 [NOTICE.md](NOTICE.md)。
- AKE 的无版本 `public/Json/*` 资产会随站点更新，因此必须以 `sources.lock.json` 中的 SHA-256 为准。
- `fixtures/calc/` 只在测试中作为黑盒 oracle；`src/` 运行时不会读取答案文件。

## 已复现结果

固定条件：佩丽卡 1 级、默认武器 `wpn_funnel_0002` 1 级、无装备/天赋/潜能，攻击 83.851；敌人 `eny_0007_mimicw` 1 级，HP 692、DEF 100。

- 6 次命令执行帧：`0, 15, 33, 59, 90, 120`；
- 9 次伤害帧：`8, 24, 27, 49, 52, 55, 86, 114, 133`；
- 第四段命中 frame 86 创建连携待触发状态，frame 90 消耗；
- 连携窗口实测为 `[86, 265)`：命中同帧 86 可施放，264 可施放，265 已超时；
- 同一连携技能可并存多条 pending，施放时选择最新一条；冷却期内的新命中不会创建 pending；
- 连携技冷却 600 tick，frame 114 创建持续 150 tick 的导电效果；
- 导电令后两次法术伤害进入 `1.12` 防守方乘区；
- 战技 frame 120 消耗 100 技力，frame 136 起按 `0.2666666805744171/帧` 恢复，最终技力为 `268.8000035881996`；
- 空 USP 用例中，连携命中获得 10、战技命中获得 `6.499999761581421`，最终 USP 为 `16.49999976158142`；
- 满 USP 可以施放大招并消耗 80；大招 frame 58 造成 `186.568475` 伤害，空 USP 时门控失败；
- 最终总伤害 `183.1976648`，敌人剩余 HP `508.8023352000001`；
- 上述伤害逐段与捕获的 Calc 输出严格相等。
- 失衡边界已验证：80 点恰好失衡、60 点以 65 点溢出失衡、失衡中伤害 ×1.3；
- `eny_0121_klbud` 在 frame 426 失衡，frame 485 处决造成 `218.0126` 并返还 25 ATB；同一失衡周期第二次处决失败；
- 140 点上限敌人的 50% 节点在累计跨过 70 时触发 75 tick 小失衡；
- 敌方恢复计时使用独立局部时钟：四个公开用例的墙钟恢复帧 `613 / 484 / 617 / 620` 已精确复现；
- 当前普通敌人签名的快速破韧保护已实测：48 个敌方局部 tick 内破韧，恢复时获得 90 tick 保护，削韧承伤倍率从 0.6 随耗时线性回升到 1；保护到期事件所在帧仍生效，下一帧失效；
- AKE 旧研究文档中的固定 50%/分级秒数表与当前 Calc 行为不一致，其他敌人等阶没有被静默套用普通敌人参数。

```text
AKE 原始 Skill/Buff JSON + SkillPatchTable + Calc 面板属性
              ↓ 独立子集解析器
       可审计的技能/BUFF 模型
              ↓ 事件队列 + 状态机 + 伤害公式
       pelica-simulation.json
              ↕ 仅在测试时比较
          Calc 黑盒 oracle
```

## 当前内容

```text
ake-calc-cleanroom/
├─ docs/                         调研结论与实现规格
├─ derived/                      由固定原始数据和固定分析器生成的后处理 JSON
├─ fixtures/                     已观测、可用于回归测试的行为
├─ spec/                         机器可读的语义映射与未决依赖
├─ reference/
│  ├─ public-data/               AKE 与 Calc 的公开数据快照
│  └─ third-party/akedatabase/   AKE 强 copyleft 源码参考快照
├─ scripts/
│  ├─ sync-public-data.ps1       同步固定来源并计算哈希
│  ├─ export-ake-analysis.mjs     生成 Buff/Skill 后处理 JSON
│  ├─ export-cleanroom-model.mjs  导出独立解析器的运行模型
│  ├─ sync-ake-runtime-corpus.mjs  同步公开 Buff/角色技能/装备被动语料
│  ├─ audit-ake-action-coverage.mjs 逐实例编译并生成动作覆盖报告
│  ├─ capture-calc-*.mjs          捕获/归一化公共 Calc 用例
│  └─ verify-snapshots.ps1       校验文件、JSON 与关键语义
├─ src/                           独立解析器、精确模拟器与通用战斗运行时
├─ test/                          Calc oracle 回归与通用模块轻量测试
├─ package.json                   一键命令
└─ sources.lock.json             同步后生成的来源与哈希锁文件
```

## 快速使用

本地交互 Demo 直接复用了 LTS 工作台的 React + TypeScript 源码，而不是重新仿写页面。原来的“选择干员 → 干员配置 → 排轴 → 伤害报表”组件、状态快照、角色/武器/装备数据库与面板计算链都保留；只在点击“计算伤害”的边界新增 AKE provider，并在原报告上增加可收起的 AKE 实际时序抽屉：

```powershell
npm run demo:install # 首次运行
npm run demo
```

浏览器打开 `http://127.0.0.1:43821`。这个端口与 LTS 的 `3030` 完全分离。当前界面支持最多四名干员；时间轴已采用“真实动作时序权威、视觉列按共享变速规则投影”的模型，不再把正常节点统一换算为固定 15 帧。只有动作资料无法解析时才允许产生带诊断的回退资料，不能把回退结果宣称为已验证。服务端直接调用 `AkeScenarioAssembler` 与 `AkeScenarioRunner`，前端不应复制战斗公式。四槽装备与武器的静态面板收益沿用 LTS 面板结果，攻击、暴击、物理/元素以及普通攻击、战技、连携技、终结技加成都进入 AKE 伤害乘区并显示在结算抽屉；尚未映射到 AKE 语义的条件型动态装备效果会明确保留为未接入项，不会伪造执行结果。

AKE 数据/API 接线位于 `demo/demo-service.mjs`，复用的 LTS 前端位于 `demo/lts-ui/`，唯一新增的前端计算适配层集中在 `demo/lts-ui/src/integrations/ake/`。

构建后可用 `npm run demo:serve` 从同一独立端口提供静态页面与 AKE API：

```powershell
npm run demo:build
npm run demo:serve
```

直接复算并查看结果：

```powershell
npm run simulate:pelica
npm run simulate:pelica-generic -- --no-write
npm run simulate:poise
npm run audit:ake-actions
npm test
```

通用层的入口是 `src/core/combat-runtime.mjs`，AKE 编译入口是 `src/core/ake-action-compiler.mjs`，公开数据自动装配和指令回放入口分别是 `src/core/ake-scenario-assembler.mjs`、`src/core/ake-scenario-runner.mjs`，指令准入入口是 `src/core/command-admission-provider.mjs`。运行时接受定义驱动的实体、资源、Buff、光环、反应、韧性和事件规则；可通过 `dispatch()` 发送事件，通过 `execute()` 单独执行效果，并用 `snapshot()` 获取各状态机的审计快照。最小接线见 [通用战斗运行时实施规格](docs/09-general-combat-runtime-implementation.md)。

当前测试还会逐项回放 9 个连携边界用例、10 个 ATB/USP 资源用例、9 个失衡/处决用例、8 个快速破韧保护用例，以及 10 条真实 AKE Skill/Buff/装备数据的通用执行链。需要主动重新采集公开接口结果时运行：

```powershell
npm run capture:combo-boundaries
npm run capture:resource-boundaries
npm run capture:poise-boundaries
npm run capture:poise-guard-boundaries
```

完整明细写到 `derived/cleanroom/pelica-simulation.json`；中间运行模型可用 `npm run derive:pelica` 生成。完整 JSON 也可直接输出：

```powershell
node ./src/cli.mjs pelica --json --no-write
```

要重新生成 AKE 网页分析器的对照结果与校验本地快照：

```powershell
npm run derive:ake
./scripts/verify-snapshots.ps1
```

需要主动刷新无版本资产时：

```powershell
./scripts/sync-public-data.ps1 -Refresh
npm run sync:ake-runtime-corpus
npm run audit:ake-actions
./scripts/verify-snapshots.ps1
```

`-Refresh` 会更新快照和哈希，更新后应检查数据版本与行为用例是否仍然一致。

## 当前锁定版本

- AKE TableCfg：`1.4.4@9433094-12`
- AKE Json 资产修订：`2026-08-22T05:51:44.260485+08:00`
- AKE 通用运行语料：3,389 文件，147,580,776 字节
- AKEDatabase 源码提交：`1bb9549705eba2601affed4cb8a7ea69ba13b150`
- Calc 公共 metadata 数据版本：`9163343-11`

AKE 与 Calc 当前并非相同数据版本。行为差异必须先做版本归因，再判断是解析缺失还是执行逻辑不同。

## 阅读顺序

1. [数据关系与查找路线](docs/01-data-lineage.md)
2. [Buff 状态机实现规格](docs/02-buff-state-machine.md)
3. [佩丽卡 Pulse 已验证链路](docs/03-verified-pelica-pulse.md)
4. [缺口与实现顺序](docs/04-gaps-and-roadmap.md)
5. [原始 JSON 与后处理 JSON](docs/05-raw-to-analysis.md)
6. [佩丽卡最小模拟器：状态与伤害闭环](docs/06-pelica-minimal-simulator.md)
7. [失衡、失衡节点与处决执行器](docs/07-poise-execution-engine.md)
8. [敌方局部时钟与快速破韧保护](docs/08-poise-local-clock-and-guard.md)
9. [通用战斗运行时实施规格与本轮结果](docs/09-general-combat-runtime-implementation.md)
10. [AKE 动作编译器、通用执行链与覆盖审计](docs/10-ake-runtime-compiler-and-coverage.md)
11. [公开数据自动装配与佩丽卡通用运行时回放](docs/11-automatic-assembly-and-generic-pelica-replay.md)
12. [Calc 轨道指令、打断与脱手效果差分实验](docs/12-calc-interruption-probe.md)
13. [数据驱动的指令准入与优先级](docs/13-data-driven-command-admission.md)
14. [Endaxis × cleanroom × dmg-end-field 对比研究](docs/14-endaxis-comparative-architecture-study.md)
15. [统一引擎、状态机、加载链路与事件账本升级方案](docs/15-unified-runtime-ledger-upgrade-plan.md)
16. [状态机、引擎与前端正确性专项研究](docs/16-state-engine-ui-correctness-research.md)

实现代码读取 [引擎语义映射](spec/engine-semantic-mappings.json)，并把 [未决依赖](spec/unresolved-dependencies.json) 当作显式错误或外部输入处理，不能静默猜值。精确层仍是固定单人、单目标用例的闭环；通用层是可组合代码骨架。两者都不等于已经完整复现整个游戏引擎。
