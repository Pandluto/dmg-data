# 完整开发提交演变

本页逐条索引从初始提交到文档/RIA 基线 `0bea9f8` 的全部 115 个提交。日期和主题直接来自 Git；阶段标题只帮助阅读，不替代提交本身。该基线之后的提交以 Git 为唯一完整事实源，带日期的变化原因另见 [维护索引](./README.md)；本页不通过自指条目伪装覆盖仍在形成的提交。

## 阶段 1 · clean-room 研究基线

固定公开来源、佩丽卡最小行为、资源、Poise、局部时钟与早期通用运行时的初始仓库快照。

- 2026-08-25 00:25 · `fee33ff` · Initial clean-room combat engine research snapshot
## 阶段 2 · 共享变速时间轴

建立变量速率编辑、等待强边界、组内换人和初始控制者选择。

- 2026-08-26 13:02 · `f61fbb4` · feat(timeline): add variable-rate editor and wait controls
- 2026-08-26 13:19 · `2a1b3cb` · fix(timeline): restore wait context actions
- 2026-08-26 14:05 · `38058f7` · fix(timeline): separate ordinary waits from group seals
- 2026-08-26 15:10 · `98d9d11` · feat(timeline): add controlled operator switching
- 2026-08-26 15:32 · `f612aca` · fix(timeline): make initial controller selectable
## 阶段 3 · 实时运行时与前端账本接线

把通用运行时接入 LTS 工作台，收敛敌方状态，并阻止非因果 Hit 参与释放投影。

- 2026-08-27 00:32 · `b97ff73` · feat: complete realtime combat simulation integration
- 2026-08-27 09:36 · `2c3a714` · fix: unify combat state and runtime ledger
- 2026-08-27 11:47 · `0a54e3b` · fix: unify elemental and physical enemy mechanics
- 2026-08-27 13:43 · `622c937` · fix(timeline): reject noncausal AKE hit commits
## 阶段 4 · 通用机制、事件审计与状态事务

用逐角色 audit 驱动 Buff 生命周期、伤害乘区、元素/物理状态、事件生产者、Poise、冷却、连携和消费守卫通用化。

- 2026-08-27 13:52 · `c6fd193` · docs: generalize Endaxis mechanics for AKE runtime
- 2026-08-27 13:56 · `f7d422a` · feat(audit): add per-operator AKE mechanism coverage
- 2026-08-27 14:01 · `9b82971` · feat(runtime): support generic AKE buff time pause
- 2026-08-27 14:10 · `a608215` · feat(runtime): resolve dynamic child buff lifecycles
- 2026-08-27 14:14 · `71c4ded` · feat(engine): execute generic AKE vulnerability actions
- 2026-08-27 14:21 · `c03b490` · fix(engine): separate weakness vulnerability and fragile zones
- 2026-08-27 14:25 · `a0b00a6` · feat(engine): execute generic AKE weakness actions
- 2026-08-27 14:29 · `61e754c` · feat(engine): execute generic AKE shelter actions
- 2026-08-27 14:38 · `07608e4` · feat(runtime): execute AKE buff expiry extension leases
- 2026-08-27 14:49 · `ec91c0e` · feat(runtime): transfer AKE action-owned buffs across skills
- 2026-08-27 14:54 · `ed4be1f` · feat(runtime): resolve AKE environment buff selectors
- 2026-08-27 15:09 · `3932bc3` · feat(engine): execute generic AKE forced spell statuses
- 2026-08-27 15:18 · `b92fc2d` · feat(engine): emit generic AKE abnormal lifecycle events
- 2026-08-27 15:28 · `e0b0610` · feat(engine): close generic AKE elemental reactions
- 2026-08-27 15:38 · `c632661` · feat(engine): execute AKE skill tag windows
- 2026-08-27 15:48 · `17f3a57` · feat(engine): execute AKE skill event listeners
- 2026-08-27 15:54 · `2818107` · feat(engine): emit AKE listener lifecycle events
- 2026-08-27 15:59 · `fe47ec3` · feat(engine): bind AKE buff event listeners
- 2026-08-27 16:12 · `59f3098` · feat(engine): execute AKE cooldown transactions
- 2026-08-27 16:20 · `4bb6bc8` · feat(ui): share AKE cooldown groups in timeline preview
- 2026-08-27 16:25 · `fe8bac5` · feat(engine): execute AKE internal cooldown gates
- 2026-08-27 16:34 · `e757155` · feat(engine): pause AKE combo pending windows
- 2026-08-27 16:43 · `8778007` · docs(engine): map AKE combo trigger evidence gap
- 2026-08-27 16:46 · `4e61fa5` · feat(engine): evaluate compound AKE combo triggers
- 2026-08-27 16:54 · `4aa51e5` · feat(ui): project compound AKE combo triggers
- 2026-08-27 17:01 · `828f17a` · fix(timing): preserve infinite form restores
- 2026-08-27 17:07 · `f10146a` · docs(engine): define action-driven combo pending
- 2026-08-27 17:08 · `3039ae7` · feat(engine): execute action-driven combo stages
- 2026-08-27 17:16 · `65beb42` · docs(ui): define chained combo projection
- 2026-08-27 17:17 · `d54caf5` · feat(ui): project action-driven combo stages
- 2026-08-27 17:18 · `ef1c6eb` · docs(audit): record combo action coverage
- 2026-08-27 17:19 · `5e431cd` · chore(audit): close combo trigger action gaps
- 2026-08-27 17:21 · `15da838` · docs(engine): define empty combo lifecycle event
- 2026-08-27 17:24 · `9fb42e9` · feat(engine): emit empty combo lifecycle events
- 2026-08-27 17:26 · `956ac63` · fix(ui): align combo restore with pending expiry
- 2026-08-27 17:27 · `8d83f7a` · docs(audit): close combo pending lifecycle
- 2026-08-27 17:29 · `c1a8710` · docs(audit): inventory ability event producers
- 2026-08-27 17:31 · `313571c` · feat(audit): fail closed on missing ability emitters
- 2026-08-27 17:33 · `19955c0` · chore(audit): expose unreachable ability listeners
- 2026-08-27 17:36 · `da35b9c` · docs(engine): separate hp-zero from death commit
- 2026-08-27 17:41 · `eb6123b` · feat(engine): emit owner hp-zero lifecycle
- 2026-08-27 17:41 · `24ad676` · docs(audit): close owner hp-zero producer
- 2026-08-27 17:44 · `8b8489b` · docs(engine): separate poise from control resilience
- 2026-08-27 17:45 · `2f659e4` · feat(engine): expose poise lifecycle edges
- 2026-08-27 17:47 · `440d4e6` · feat(engine): add multi-target poise system
- 2026-08-27 17:56 · `9067935` · feat(engine): route AKE poise lifecycle
- 2026-08-27 18:01 · `89df5b3` · feat(engine): project poise break buffs
- 2026-08-27 18:03 · `085c748` · feat(ui): expose runtime poise state
- 2026-08-27 18:11 · `0cdef6b` · feat(engine): enforce poise execution gate
- 2026-08-27 18:14 · `422ab2c` · fix(engine): bind poise recovery to enemy clock
- 2026-08-27 18:15 · `b9111f8` · docs(audit): close poise lifecycle migration
- 2026-08-27 18:22 · `5cb59ab` · docs(engine): define buff consumption lifecycle
- 2026-08-27 18:24 · `7ee73b1` · feat(engine): model explicit buff consumption
- 2026-08-27 18:26 · `45ab5c8` · feat(engine): emit consumed buff events
- 2026-08-27 18:30 · `c6b3001` · feat(engine): execute consumed buff listeners
- 2026-08-27 18:30 · `fd2a233` · audit(engine): close buff consumption event coverage
- 2026-08-27 18:33 · `d173297` · docs(engine): define buff consumption guards
- 2026-08-27 18:36 · `23caae7` · feat(engine): enforce buff consumption guards
- 2026-08-27 18:37 · `51eb963` · docs(audit): close buff consumption lifecycle
## 阶段 5 · 精确窗口、状态伤害与投影边界

收敛分段连携窗口、附件消费、周期伤害和释放锚点，区分动作 Hit 与长尾状态 Hit。

- 2026-08-27 19:00 · `7a80c0f` · fix(ui): admit staged combo intent windows
- 2026-08-27 19:10 · `ac6cfc0` · feat(engine): model precise combo input windows
- 2026-08-27 19:58 · `2c60c99` · feat(ui): expose precise staged combo windows
- 2026-08-27 20:52 · `9e6ced5` · fix(ui): keep lingering hits out of release anchors
- 2026-08-27 21:10 · `de3a0ce` · fix(engine): consume standalone timed status events
- 2026-08-27 21:36 · `ac8ba6e` · fix(engine-ui): consume Wulfa attachments and compact long dots
- 2026-08-27 21:40 · `6a00289` · test(engine): cover multi-layer attachment consumption
- 2026-08-27 22:24 · `4ae9250` · fix(engine): preserve physical layers after attachment consume
- 2026-08-27 22:55 · `d754432` · fix(ake): expose precise combo anchors and no-guard layers
- 2026-08-27 23:08 · `7965424` · fix(ui): render low multiplier hits as dots
- 2026-08-27 23:27 · `e0e756a` · fix(timeline): exclude status damage from release snaps
- 2026-08-27 23:39 · `07e96df` · fix(ake): classify periodic status hits outside release snaps
## 阶段 6 · 属性来源、伤害解释与共享连击

贯通运行时属性来源、逐 Hit Buff、共享队伍连击和 ability entity 生命周期。

- 2026-08-28 00:39 · `5e74439` · fix: trace AKE runtime attributes and team buffs
- 2026-08-28 00:42 · `ec75897` · fix: expose AKE runtime attack in config panel
- 2026-08-28 01:02 · `9dae353` · fix: preserve runtime attack zone semantics
- 2026-08-28 01:06 · `3b9e7e0` · fix: expose runtime attribute calculation stages
- 2026-08-28 01:12 · `f0448f7` · fix: expose panel and runtime attack in hit detail
- 2026-08-28 01:35 · `5efd76e` · fix(ui): remove ambiguous runtime attack displays
- 2026-08-28 01:49 · `ae6bcc6` · fix(ui): restore detailed runtime damage zones
- 2026-08-28 01:53 · `b5fdfbe` · fix(engine): map weapon skill levels by semantic role
- 2026-08-28 01:55 · `e5ee4fa` · fix(ui): expose hit buffs in operator skill details
- 2026-08-28 02:03 · `bb6a04c` · feat(engine): model shared team combo state
- 2026-08-28 02:09 · `d05a8e3` · fix(engine): emit spell infliction weapon events
- 2026-08-28 02:16 · `cd74ac0` · fix(parser): expose final-zone buff effects
- 2026-08-28 02:18 · `6bb9536` · fix(adapter): separate action hits from callback settlements
- 2026-08-28 02:22 · `3a5b1e6` · fix(ui): surface skill hit states without callback noise
- 2026-08-28 02:35 · `1ef988c` · fix(engine): apply shared combo to real damage
- 2026-08-28 02:43 · `8d42547` · fix(ui): project unlocked talent states into details
- 2026-08-28 02:45 · `3adeacf` · fix(parser): distinguish refresh from stack buffs
- 2026-08-28 02:46 · `7cfdf9d` · fix(adapter): invalidate stale refresh metadata
- 2026-08-28 02:49 · `81f8d5e` · test(engine): refresh damage-event audit baselines
- 2026-08-28 02:56 · `a7b751e` · fix(engine): bind skill affixes to cast lifetime
- 2026-08-28 03:04 · `63e7adc` · fix(ui): preserve runtime buff damage provenance
- 2026-08-28 10:54 · `23d3cce` · docs(engine): compare shared combo state model
- 2026-08-28 11:03 · `773b175` · fix(engine): snapshot shared combo consumption per hit
- 2026-08-28 11:15 · `ad510c4` · fix(ui): expose pooled combo as critical hit state
- 2026-08-28 11:50 · `fbae90d` · fix(engine): isolate ability entity action lifetimes
## 阶段 7 · 派生技能与输入/结算身份

建立派生技能图和六字段身份，支持强化输入实际按连携结算，并把结果绑定回原始按钮。

- 2026-08-28 13:03 · `7707efd` · docs(engine): define derived skill identity contract
- 2026-08-28 13:16 · `1051dcf` · feat(engine): compile derived skill cast graph
- 2026-08-28 13:54 · `d155afc` · fix(engine): execute derived skill casts generically
- 2026-08-28 14:00 · `65e3279` · fix(ui): bind derived hits to input buttons
- 2026-08-28 15:03 · `cc0d2a2` · fix(engine): separate enhanced input from combo settlement
- 2026-08-28 16:23 · `a579b59` · fix(engine): resolve buffered inputs against active forms
- 2026-08-28 16:29 · `9002b15` · fix(ui): retain inherited combat states on timeline
- 2026-08-28 16:34 · `f9a2067` · fix(ui): name transformed settlement in skill details

## 阶段 8 · 文档事实源与可重放调查档案

完成当前文档重组，并加入 Case/Session/不可变 Run、结构化事实、REST/SSE、replay/diff 与保留策略。

- 2026-08-29 12:23 · `0bea9f8` · feat(ria): add replayable investigation archive

## 查阅方式

查看任一提交的完整改动：

```bash
git show <commit>
```

查看一个文件跨提交的演变：

```bash
git log --follow -- <path>
```

本索引保留基线前的全部提交，不用最终架构文档覆盖中间失败、修正和责任迁移。基线后的精确提交继续使用 `git log`；当前系统结论仍以 [架构事实源](../architecture/README.md) 为准。
