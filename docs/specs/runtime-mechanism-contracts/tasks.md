# 三项通用机制修复：施工任务

对应 [Spec](spec.md)。状态：2026-09-12 实现、有限验收和主任务审查完成，本次合并交付主仓。勾选必须有实际代码或验证证据，派发不代表修复完成。

实际实施基线 `0619485d49a473bcf38d98439f5bba03db3ca11f`；已确认工作树 `/Users/sailstellar/.codex/worktrees/4c1f/dmg-data/mechanism-fix-source`，分支 `codex/runtime-mechanism-contracts`。源码实现提交 `7f7b6a1248d59c77dd9a7f7f83ee68839ab356d1`；交付与主任务复核见 [实施记录](implementation.md)。

## 分工与固定起点

| 责任 | 既有任务 | 工作范围 |
|---|---|---|
| 实施与最小验收 | 独立排轴机制测试：三队完整配装，`01a0914c-56cb-79a2-a78f-c04d3691e282` | 新修复工作树，三个机制顺序施工，独占代码写入 |
| 主任务 | 自主发现排轴系统 Bug，`01a0913c-0e27-7533-9f14-4c7a3f4d0774` | spec/tasks、交接、差异审查与必要的最终整合 |

沿用实施任务现有 GPT-6 / medium 配置，不再派多个任务同时修改核心。主仓为 `/Users/sailstellar/Documents/ChatGPT/dmg-data/ake-calc-cleanroom`；规划时主仓 HEAD 为 `07082c263d21e29ffc7493f74fcc6459a48cedcb`，工作区干净。实施从包含本 Spec/tasks 的新文档提交建立分支，准确提交号由交接消息提供，并写入实施记录。

建议修复分支 `codex/runtime-mechanism-contracts`，新工作树 `/Users/sailstellar/.codex/worktrees/4c1f/dmg-data/mechanism-fix-source`。已存在时先检查身份和状态，不覆盖。原 `/Users/sailstellar/.codex/worktrees/4c1f/dmg-data/audit-source` 固定在旧提交，保留只读以支持反证，不能直接在上面修。

### 证据输入

以下是本机取证路径，不要求其他机器具有相同目录；需要持续回归的三个小 fixture 应复制进本修复分支并记录来源，测试不可硬编码 audit-source 的绝对 import。

```text
/Users/sailstellar/Documents/ChatGPT/dmg-data/experiments/autonomous-mechanisms-20260912/
  ROOT-CAUSE-ANALYSIS.md
  REVIEW.md
  results/report.md
  results/findings/BUG-001.md
  results/findings/BUG-002.md
  results/findings/BUG-003.md
  results/repro/check.mjs
  results/repro/F-ultimate-cost-event.minimal.json
  results/repro/F-enhanced-attack-cooldown.minimal.json
  results/repro/F-independent-weapon-stacks.minimal.json
  results/repro/F-ultimate-cost-event.full.json
  results/repro/F-enhanced-attack-cooldown.full.json
  results/repro/F-independent-weapon-stacks.full.json
```

原 check.mjs 固定 import 旧 audit-source，只能证明旧版仍坏。新回归必须调用修复工作树自身的 `simulateSquadDemo`；不允许改原脚本指向修复版后再宣称旧证据已通过。

## 运行与协作约束

- 主仓及其他任务工作树不由实施任务修改。只写自己的修复工作树和本轮新增交付目录，不动旧 results、Run 或输入。
- 不打开/刷新浏览器，不启动/重启/终止开发服务，不连接活动 RIA Session。离线 Node 验证串行执行，不占用现有服务端口或可写 Vite 缓存。
- 依赖先检查；需要安装时仅在自己的新工作树内使用锁文件，不改共享 node_modules。
- 排轴逻辑序工作在独立分支进行，会同样涉及 `ake-squad-scenario-runner.mjs`。本轮只改其扣费调用等必要局部，不改排序、队列、控制权、释放依赖；不主动 cherry-pick 排轴改造提交。
- 不推送、不部署、不清理旧工作树、不修改用户存档。允许完成连贯修改后本地提交。
- 测试范围以上述 Spec 的预算为准。用户本轮的少量验证要求优先于默认全量检查习惯；若某检查新失败，只定位直接相关部分，不滚成大规模回归。

## 主任务先行

- [x] P-01 完成 Spec/tasks/索引，文档结构与链接、差异空白检查通过；本项随规格提交提供实施基线。
- [x] P-02 将固定基线、职责、测试预算和回传方式发给既有任务。
- [x] P-03 任务状态显示 active，实施任务已回传新工作树、分支和精确基线，确认实际开始。

## 实施任务

### M-01 建立三个可信失败回归

- [x] 读取原报告和最新更正，创建新工作树；核对含本 Spec 的提交及依赖。
- [x] 复制三个原始最小输入进入一处紧凑 fixture 文件/目录，记录来源；沿用相同配装、资源、命令和终点。
- [x] 用本工作树真实 `simulateSquadDemo` 按顺序做三个修复切片：先确认当前缺陷失败，再写该项修复并确认通过；不预先铺开大量测试。
- [x] 记录红灯信号：BUG-001 缺 Buff；BUG-002 F75 `COOLDOWN_ACTIVE`；BUG-003 F701 应两层实际三层。首次已知失败无需反复跑数轮。

完成条件：最终留下三个能证明原问题的主要回归，断言检查机制，不只检查无异常或总伤害。

### M-02 收拢技能扣费事务

- [x] 在 CombatRuntime 的合适公开接口内统一实际扣费与通知，保留资源返回值、施法上下文及已有资源副作用。
- [x] 接入单人 runner、小队 runner、派生施法、替代施法；核对是否还有同类业务入口直接绕过。用调用点审查确认，不为每个入口额外造一队角色。
- [x] 确保成功通知一次，失败/显式 skip 不虚报；最多补一个短通用正负对照。
- [x] 通过 BUG-001 的真实最小回归，检查熔铸火焰有效参数与来源。

建议主要文件：`src/core/combat-runtime.mjs`、`ake-scenario-runner.mjs`、`ake-squad-scenario-runner.mjs`、`ake-skill-cast-replacement.mjs`。

### M-03 修正冷却身份

- [x] 修正装配中的目录、真实技能类型和冷却绑定关系；在必要定义中明确来源，不加莱万汀判断。
- [x] 通过 BUG-002 最小回归，证明 F75 强化普攻实际执行并命中。
- [x] 复用 `test/ake-skill-cooldown.test.mjs` 中合法同组共享的定向用例，证明没有把所有强化技能都拆组；可使用 `--test-name-pattern`，无须扩展冷却全矩阵。

建议主要文件：`src/core/ake-scenario-assembler.mjs`；只有必要时才修改冷却状态机本身。

### M-04 表达并执行独立叠层寿命

- [x] 核对轻芒的原始 Buff、武器说明及有效参数，选择带来源的寿命声明；如果需要语义映射，记录具体证据，禁止在通用代码按 Buff/角色名称打补丁。
- [x] 为声明独立到期的状态维护逐层期限并汇总层数/属性；旧层到期不结束尚有效的新层，新层不刷新旧层。
- [x] 通过 BUG-003 一次最小运行检查 F701/F728/F761；保持实际 Q=F41，不能混用完整样本 Q=F118 的时钟。
- [x] 最多补一个短状态对照，证明整体刷新仍刷新、独立层能分别结束且实例清除后没有旧计时器回流。只有实现触及暂停/消费且出现具体疑点时才加对应小检查。

建议主要文件：`src/core/status-effect-system.mjs` 及必要的 parser/compiler/语义声明。说明哪些源声明应用了新策略，未证明的其他枚举不静默扩大。

### M-05 有限验收与交付

- [x] 三个最小回归通过；三个原完整输入各重放一次，只核对各自机制和新增诊断，不追加组合搜索。
- [x] 将修复版简明命令、期望/实际、源码/fixture 指纹记录到新交付文件；原 Run 不覆盖。截图因本轮不操作浏览器而跳过并记明即可。
- [x] 必要时更新当前架构的准确行为与直接受影响派生产物。只运行确受变更影响的生成器，不以清空未知项或刷新旧审计基线为本轮目标。
- [x] 在本目录新增 `implementation.md`，记录原因、方案、修改范围、运行过的检查、未覆盖部分、源码提交及可迁移的复跑命令。
- [x] 更新本任务勾选状态；运行文档链接/结构检查及 `git diff --check`；本地提交。
- [x] 向主任务 `01a0913c-0e27-7533-9f14-4c7a3f4d0774` 回传：分支/工作树、提交、三个修复结果、实际测试范围、文档路径，以及任何与逻辑序改造可能冲突的 hunk。不要在主仓自行合并。

## 主任务收尾

- [x] P-04 审查通用修复和测试，当前树相对 import、13 项来源/代码/fixture 指纹及三个原始最小输入均核对一致。
- [x] P-05 整合已验证提交；只有任务进度文档冲突，保留两边意图。业务代码与验收分支完全一致，使用文档检查与指纹核对，不重复业务回归。
- [x] P-06 更新 Spec、索引及实施记录，本次合并交付三个结果、提交和已记录限制。

发现范围外的新问题时写入 implementation 的待办，继续完成已授权三项；只有它直接阻止本次正确修复时才回传具体阻塞及最小解决建议。
