# 三项运行时机制修复实施记录

状态：2026-09-12 实现及有限验收完成，待主任务审查与整合。对应 [Spec](spec.md) 与 [tasks](tasks.md)。

基线 `0619485d49a473bcf38d98439f5bba03db3ca11f`；分支 `codex/runtime-mechanism-contracts`；工作树 `/Users/sailstellar/.codex/worktrees/4c1f/dmg-data/mechanism-fix-source`。源码提交随本记录一并提交，可用 `git log -1 --format=%H -- src/core/status-effect-system.mjs` 取得；逐文件 SHA-256 见 [指纹](../../../artifacts/mechanism-fix/fingerprints.json)。原 audit-source、results、最小/完整输入及封存 RIA 均未修改。

## 实现与依据

1. COST：四个技能业务入口曾直接修改资源，漏过成功扣费事件。统一到 `CombatRuntime.applySkillCost`，保留资源记录返回值与施法上下文；成功、实际非零的扣费通知一次。单人 runner、小队 runner、派生 CastSkill 与替代施法已接入，原 skip/admission 分支不变。剩余直接 `resources.spend` 是此事务自身及 ClearResource；后者原本已有通知，通用 ResourceChange 同样已有通知，无需重复发布。
2. IDENTITY：装配原先优先目录分组，导致目录内强化普攻继承终结技组。现在优先真实 SkillData 类型，目录仅作回退，metadata 记录两种来源。相同角色、相同实际类型的程序仍共享冷却。没有角色分支或修改冷却状态机。
3. STACK：新 `StatusStackLifetimeRule` 经 compiler 进入 `stacking.lifetimePolicy`，通用状态机为声明独立寿命的共享叠层维护层 ID、来源、期限和计时器。到期调用既有移层/结束生命周期，重算属性；消费撤销对应层，清除取消全部计时器。暂停和 expiry hold 引用同一组层时钟。

独立寿命只声明于 `buff_wpn_sword_0019_up`：固定原始 Buff 表明叠层上限与属性，`I18nTextTable_CN` 的 `-8975329607564179893` 明确每层独立持续。源路径在映射内可审计，通用代码不含该 Buff ID。其他同枚举状态不扩大推定。满层时丢弃新层并记录 discarded，旧期限不变；满层替换细则仍未知。显式消费沿用既有 LIFO 规则，未声称来源证明该次序。不同来源层的不同数值参数仍沿用现有实例黑板合同，本次不泛化为逐层不同倍率。

## 验证证据

| 检查 | 旧版红灯 | 修复后 |
| --- | --- | --- |
| COST 最小 | 成功费用事件 0，应为 1 | 一次扣费、一次事件、一次 Buff，普攻加成 1.2，F600 到期 |
| IDENTITY 最小 | F75 Attack 失败 | F75 强化普攻成功且产生 NormalAttack 命中 |
| STACK 最小 | F701 仍三层 | 实际 Q=F41；F701/F728/F761 为 2/1/0 层；火伤贡献 .168/.084/0 |
| 通用费用对照 | — | 成功非零一次；零额与失败均不通知 |
| 通用状态对照 | — | 共享刷新、独立到期、暂停恢复、部分移层、清除后不复活 |
| 既有共享冷却定向用例 | — | 组共享、角色隔离、比例缩短通过 |

红灯日志 [费用](../../../artifacts/mechanism-fix/cost-red.txt)、[身份](../../../artifacts/mechanism-fix/identity-red.txt)、[层数](../../../artifacts/mechanism-fix/stack-red.txt)。最终 [五个新增测试](../../../artifacts/mechanism-fix/final-minimal.txt) 全通过；[既有冷却](../../../artifacts/mechanism-fix/shared-cooldown.txt) 通过。施工中修正过测试代码自身的错误字段访问，非额外产品缺陷；完善属性断言与生命周期实现后重跑本小测试文件。没有扩成角色矩阵。

[完整输入重放](../../../artifacts/mechanism-fix/full-replays.jsonl)：三个原完整输入各运行一次，均通过；终结技 Buff 在 F0 授予，强化攻击 F75 成功，轻芒完整样本 F778/F805/F838 为 2/1/0。各次运行 assemblerDiagnostics 为空、运行时 unresolvedEffectCount=0、missingSkill/BuffCount=0；compilerUnresolvedEffectCount 仍为 296，未宣称清零或额外验证这些节点。

暂停/部分移层的短检查放在唯一一个通用状态用例内，因为新增层计时器必须由同一暂停引用和消费路径撤销；没有新增队伍模拟。截图按本轮禁止操作浏览器的约束跳过。未运行 141 输入矩阵、全量 Node 测试、前端/E2E、压力测试或活动 RIA；未启动服务、安装依赖、推送或部署。

## 复跑与派生产物

在任意本分支 checkout 根目录运行：

```bash
node --test test/runtime-mechanism-contracts.test.mjs
node --test --test-name-pattern='cooldown state is group-shared' test/ake-skill-cooldown.test.mjs
node scripts/replay-runtime-mechanism-contracts.mjs /path/to/original/results/repro
```

三个持续回归 fixture 相对导入当前树，原始指纹与 provenance 见 [fixtures](../../../fixtures/runtime-mechanism-contracts/README.md)。完整重放脚本只接受输入目录参数，源码 import 固定相对于脚本，不指向旧 audit-source。

[当前架构](../../architecture/combat-runtime.md) 已同步。未运行全库生成器：action coverage 生成器仅分类/编译 action 节点，本次未增减 action IR、未知节点分类或公共导出；新增的是 compileBuff 的显式寿命字段。timing profile 的动画/准入时间没有变化，不因扣费及 Buff 寿命改动重建全角色时间表。当前小范围证据由本次测试日志、完整重放与源码指纹直接提供，旧生成审计基线不刷新。

## 整合边界

小队 runner 只有原基线约 L1186 的实际扣费调用与事件上下文 hunk（现约 L1186–1215）。不涉及排序、队列、控制权、释放依赖；主任务与逻辑序改造整合时保留其合同，只接入这段事务。其余改动在 runtime、单人/替代入口、assembler、compiler、状态机及来源映射。工作树由实施任务独占，未在主仓合并。
