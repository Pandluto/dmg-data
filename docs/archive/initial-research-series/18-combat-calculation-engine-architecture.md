# 计算引擎架构:从公开数据到每一个伤害数字

> 本文日期:2026-08-28
> 覆盖代码:`src/core/`(47 个文件、约 35,000 行)与 `src/scenarios/`、`src/cli.mjs`、`src/generic-cli.mjs`
> 前置阅读:[09 通用战斗运行时实施规格](09-general-combat-runtime-implementation.md)、[10 AKE 动作编译器与覆盖审计](10-ake-runtime-compiler-and-coverage.md)
> 本文回答一个问题:**一次技能输入,如何经过这套引擎,变成一个可审计、可与 Calc 对拍严格相等的伤害数字。**

## 0. 读法

全文按"一个 Hit 的生命周期"组织:

- §1–§3 是静态结构:分层、两条执行链、实体与时间模型;
- §4–§5 是解释器与状态机群,即"机制词汇表";
- §6 是全文核心:**伤害计算链**,从 `ResolveDamagePacket` 到乘区复算;
- §7–§8 是技能程序调度与指令层,即"谁在什么时候触发计算";
- §9–§11 是确定性、测试与当前边界。

只想看伤害公式的读者可以直接跳到 §6.4。

## 1. 分层总览

引擎是一条严格的单向链路,没有反向依赖:

```text
┌─────────────────────────────────────────────────────────────────┐
│ ① 数据层  AKE 公开表(TableCfg)+ Skill/Buff JSON + spec 语义映射 │
│           reference/public-data/ · sources.lock.json 哈希锁定    │
├─────────────────────────────────────────────────────────────────┤
│ ② 编译层  AkeActionCompiler:parse → classify → compile          │
│           产出纯数据 bundle(programs / buffs / loadoutEffects /  │
│           definitions),可序列化、可审计、三态标记                │
├─────────────────────────────────────────────────────────────────┤
│ ③ 运行时  CombatRuntime:事件规则分发 + EffectRuntime 解释器 +    │
│           约 20 个状态机(资源/Buff/光环/反应/韧性/失衡/连携/冷却) │
├─────────────────────────────────────────────────────────────────┤
│ ④ 结算层  AkeDamageResolver + damage.mjs 公式 +                  │
│           EffectSourceRegistry 乘区登记 → Hit + factor snapshot  │
├─────────────────────────────────────────────────────────────────┤
│ ⑤ 投影层  projectAkeTimeline / hit-profile-builder /             │
│           demo-service(仅供 UI,不回写引擎)                     │
└─────────────────────────────────────────────────────────────────┘
```

三条铁律贯穿所有层:

1. **代码只提供机制,数值永远来自数据。** `src/core/` 中不允许出现 `characterId === 'chr_xxxx'` 分支;角色差异全部落在编译产物与 `spec/engine-semantic-mappings.json` 的映射条目里。
2. **编译产物是纯数据。** program/buff definition 可 JSON 序列化,运行时不解析原始 AKE JSON。
3. **每个数值变化都留痕。** trace 记录 `before/requested/actual/discarded/after` 五元组,伤害附带 factor snapshot 且要求乘积可复算。

## 2. 两条执行链

项目刻意保留了两条独立链路,共享解析器但互不依赖:

| | 精确链(`npm run simulate:pelica`) | 通用链(`npm run simulate:pelica-generic`) |
| --- | --- | --- |
| 入口 | `src/cli.mjs` → `scenarios/pelica.mjs` | `src/generic-cli.mjs` → `AkeScenarioAssembler` |
| 引擎 | `core/simulator.mjs`(734 行,私有 EventQueue + 小型状态机) | `core/combat-runtime.mjs`(5,918 行,组合根) |
| 状态机 | `ResourceMachine`(186)/`BuffMachine`(257)/`PoiseMachine`(509) | `ResourceSystem`(1,098)/`StatusEffectSystem`(1,846)/`PoiseSystem`(399)+`ResilienceMachine`(802) |
| 角色范围 | 固定佩丽卡单角色单目标 | 31 名干员自动装配 |
| 验证口径 | 与 Calc oracle **逐帧逐段严格相等** | 逐干员审计 + 跨角色 oracle 对拍 |
| 产出 | `derived/cleanroom/pelica-simulation.json` | `pelica-generic-runtime-simulation.json` |

两者共用 `ake-parser.mjs`(归一化解析)与 `ComboTriggerMachine`(连携触发)。精确链是"已证明的锚点":通用链的任何重构,都以精确链的 oracle 不回退为约束([09 号文档](09-general-combat-runtime-implementation.md) §2.1)。doc 14/15/17 描述的统一升级方向是把精确链逐步吸收进通用链,但当前仍是两套代码。

## 3. 实体与时间模型

### 3.1 实体与归属四元组

`CombatContext`(`combat-context.mjs:83`)持有实体注册表:`{ id, kind(Character|Enemy|Summon|Object), team, ownerId, tags, metadata }`。`registerEntity`(`combat-runtime.mjs:379`)是装配总线,一次注册级联挂载:属性组件、黑板、时钟域、Vital、反应目标、韧性、失衡。

每个事件上下文(`combat-runtime.mjs` 冻结后传递)显式携带归属,这是全套引擎最核心的身份契约:

```js
{
  frame, eventType,
  sourceId,   // 实际动作发起实体
  ownerId,    // 效果/召唤物/光环的归属者
  targetId,   // 当前结算目标
  skillId, rootSkillId, castId, buffInstanceId,
  clockDomainId, blackboard, payload
}
```

`sourceId` 与 `ownerId` 不允许隐式相等([09] §2.2)。伤害侧还有第四个身份 `damageSourceId`(真正造成伤害的实体),乘区贡献记录统一携带 `sourceId/ownerId/carrierId/targetId/damageSourceId` 五元组(`effect-source-registry.mjs:548-574`)——doc 16 曾证实缺失这套身份会导致"来源分组名称启发式"和乘区归属丢失,这是它存在的直接原因。

### 3.2 多时钟域与 tick

- **tickRate = 30**(`combat-runtime.mjs:122`、`ake-scenario-assembler.mjs:394`),即 1 秒 = 30 tick。所有时间字段(冷却、持续时间、窗口)统一按秒 × tickRate 换算成帧。
- `ClockDomainManager`(`clock-domain-manager.mjs:150`)管理命名时钟域:全局 `global` + 每实体 `${id}:clock`。每个域一个 `LocalClock`,提供 `localFrameAt`(全局→局部帧映射)与 timer 调度。
- **暂停语义**:敌方破韧/处决触发的局部时钟暂停(由 `ake-time-dilation-resolver.mjs:224 applyAkeLocalClockTrigger` 应用)会同时冻结该实体的恢复计时、Buff 周期与技能程序,这是 Calc 四个恢复帧 oracle(`613/484/617/620`)能被复现的关键。

### 3.3 调度优先级

`schedule(frame, priority, run, label)` 按 `(frame, priority, sequence)` 排序执行(`combat-runtime.mjs:1391-1399`)。约定数值越小越先执行:

| priority | 用途 |
| ---: | --- |
| 1 | 技能 timeline group start;资源锁恢复 |
| 2 | 资源被动恢复 tick |
| 60 | 普通清理(cleanup) |
| 80 | 技能自然结束 |
| 89 | 局部时钟暂停触发(`combat-runtime.mjs:1921`) |
| 90 | 局部时钟 timer 触发 |
| 1000 | 空闲停战(`actionIdleExitFightFrames`) |

规则分发(`dispatch`,`combat-runtime.mjs:574`)与定时器队列是两个并行机制:前者按 `eventTypes` 过滤注册规则、按 `priority/sequence` 排序,嵌套 dispatch 受 `maxDerivedDepth`(默认 16)上限保护,超限显式抛错而不是静默截断。

## 4. 效果解释器:机制词汇表

`EffectRuntime`(`effect-runtime.mjs:227`)持有三张 handler 表(action/condition/common)。`CombatRuntime` 在 `#defaultHandlers`(`combat-runtime.mjs:2033`)注册约 **70 个 handler**:

- **条件类**(2035–2347):`BitMaskCompare`、`HasBuff`、`BuffStackCompare`、`PayloadCompare`、`ResourceCompare`、`HpCompare/HpRatioCompare`、`EntityAlive`、`DistanceCompare` 等,内置复合代数 `All/Any/Not/Compare/HasTag`;
- **动作类**(2348–5139):`Damage`、`ResolveDamagePacket`、`ApplyBuff/FinishBuff`、`ResourceChange`、`Heal/AddShield`、`ApplyPoiseDamage/ConsumePoiseExecution`、`ApplyInfliction/ForceEnemySpellStatus`、`LaunchSkillProgram`、`ScheduleIntervalActions`、`ResolveTimeDilation`、`SeekSkillTimeline/MarkSkillInterruptible/InterruptCurrentSkill`、`CreateAura/RefreshAuraTargets/RemoveAura`、`PauseClock/PauseOtherClockDomains`、`GrantTeamCombo`、`RegisterAbilityEventListener`、`FindTargets/PickTarget/ForEachTarget`、`ApplyEffectSource/RemoveEffectSource` 等。

两条纪律:未支持的 action/condition **显式失败并写 trace**,不静默通过([09] §3.1);每个 handler 执行产出统一信封的 trace(`effect-runtime.mjs:337` 起)。

## 5. 状态机群

运行时组合了约 20 个子系统,按职责分组:

| 域 | 模块(行数) | 核心职责 |
| --- | --- | --- |
| Buff | `status-effect-system.mjs`(1,846) | 实例=(buffId,target,source,owner,stack,blackboard);叠层策略 Refresh/Stack/Enhance/HighPriorityWithMaxStack;周期触发;`replaceBlackboard`;**离场显式区分 finish 与 consume**(doc 17 §15.6) |
| 光环 | `aura-machine.mjs`(488) | 按 `(auraId, sourceId, ownerId)` 实例化,目标进入/离开挂摘 Buff |
| 元素 | `reaction-machine.mjs`(656) | 五元素积蓄/阈值/消耗;`combat-status-resolver.mjs`(618)管理强制异常与战斗状态 |
| 控制 | `resilience-machine.mjs`(802) | 霸体等级、四类硬直(crush/fracture/knockdown/airborne)、处决量表 |
| 失衡 | `poise-system.mjs`(399)+`poise-machine.mjs`(509) | 韧性条、节点(knot)、破韧/恢复周期、快速破韧保护、处决门票;**与控制韧性是两套独立系统**(doc 17 §14) |
| 资源 | `resource-system.mjs`(1,098) | Shared/Entity 作用域池(队伍 ATB 共享、每角色 USP 独立);被动恢复(rate/quantization/firstTick/resumeDelay);suspend/suppress |
| 冷却 | `skill-cooldown-system.mjs`(550) | 状态键=**角色 × 公共技能组**(`cooldownGroupId`),普通/强化/替换形态共用;支持 set/reduce flat/percent-base/pause |
| 连携 | `combo-trigger-machine.mjs`(801) | pending 创建/消费/过期、触发窗、时间暂停租约、`OnRemoveAllPendingComboSkill` 边沿事件 |
| 订阅 | `ability-event-listener-registry.mjs`(328)+`ability-event-producers.mjs`(57) | 35 种运行时能力事件;生产者清单驱动 fail-closed 审计 |
| 形态 | `skill-form-state-registry.mjs`(183)+`ake-skill-state-variant.mjs`(142) | 技能槽 Override(SwitchModeAction/ChangeSkillAction 换槽) |

每个 Machine 只保存状态、验证输入、产出 trace;策略与规则在编译层;接线在 `CombatRuntime` 构造函数([09] §2.3 的"状态与策略分离")。

## 6. 伤害计算链(核心)

### 6.1 一个 Hit 的完整因果链

从技能时间轴上的一个 `DamageAction` 编译产物(运行时动作 `ResolveDamagePacket`,携带 `damageUnits[]`)开始,`combat-runtime.mjs:4654` 的执行顺序:

```text
① 发出 OnBeforeCalculateDamage 能力事件(监听器可改 blackboard)
② 逐 damageUnit:
   2a. 读取攻击方 Atk、防守方 Def(首个有限属性命中,ake-damage-resolver.mjs:342-355)
   2b. 查询 Attacker 乘区(effectSources.damageZone side=Attacker)
       + 合并面板属性增伤(attackerAttributeZone → NormalCalcZone)
       + 拆分连击区(ComboCalcZone)与基础区
   2c. 查询 Defender 乘区(side=Defender)
   2d. 读取抗性/易伤/虚弱/庇护/暴击属性(每个都带 attributeSnapshot 来源)
   2e. 调 calculateDamage 得到 nonCrit/crit/expected 三值 + operands
   2f. 组装 factors[](14 个语义乘区)与 factorValidation(乘积复算)
③ 发出 OnBeforeOutputDamage / OnBeforeTakeDamage
④ 生命结算:护盾吸收 → HP 扣减 → 死亡判定(vital-machine)
⑤ 发出 OnOutputDamage / OnTakeDamage / 暴击后事件
⑥ 若 HP 由正变零:OnOwnerHpZero(目标)→ OnAfterKillEntity(来源)
   (combat-runtime.mjs:5427 公共生命结算边界,doc 17 §13.4)
```

这条顺序本身就是被契约测试锁定的:直接 `Damage` 原语与完整 `ResolveDamagePacket` 必须共用同一通知 helper,避免两条入口出现两套死亡语义。

### 6.2 属性系统:八区组件

实体属性不是裸数字,而是结构化组件(`effect-source-registry.mjs:36-48`,求值器 `attribute.mjs:38`):

```js
{
  rawValue,        // 原始输入
  baseAddition, baseMultiplier,          // 基础区(加算/乘算)
  baseFinalAddition, baseFinalMultiplier,// 基础终区
  addition, multiplier,                  // 常规区
  finalAddition, finalMultiplier         // 终区
}
```

求值恒等式(`evaluateAttributeComponent`):**final = ((rawValue + baseAddition) × baseMultiplier + baseFinalAddition) × baseFinalMultiplier,再叠加常规区与终区**,同 zone 内加算叠加、乘区相乘。装备/天赋/潜能的静态面板修正在装配期折叠进组件(`registerAttributeComponents`),同时把来源存入 `baselineSources`(`preApplied: true`)供快照解释而不二次施加(`effect-source-registry.mjs:118-128`)。

### 6.3 乘区登记与查询:`EffectSourceRegistry`

这是"Buff 识别"与"进入公式"之间的唯一桥梁(解决 doc 16 EN-01"易伤存在但伤害不变"问题的架构答案):

- **登记** `apply()`(`effect-source-registry.mjs:221`):每个来源(武器/天赋/潜能/Buff 实例)携带 `modifiers[]`(八区属性修正,含 `rate-to-factor` 语义:rate 值自动转 1+rate)与 `damageModifiers[]`(伤害乘区修正:side=Attacker/Defender、damageTypes 过滤、conditions、processors(zoneName+addition))。登记后按受影响属性逐个 `#recompute` 并写回 `context.setAttribute`。
- **撤销** `remove()`:按 sourceKey/sourceId/ownerId/castId/buffInstanceId 选择性移除,同样重算。Buff 结束时由编译产物生成的 `RemoveEffectSource` 清理动作调用,保证"父 Buff 结束精确回滚"(腐蚀减抗的五抗回滚、虚弱/庇护的来源回滚都走这条路)。
- **查询** `damageZone()`(`:406`):给定 `(targetId, side, damageType, attackerId, defenderId)`,遍历所有活动 source 的 damageModifiers:激活目标按 side 解析 → damageTypes 过滤 → 逐条件求值(`conditionsExecutable` 为 false 直接跳过)→ 按 `zoneName` 聚合 addition,产出 `{ zones: [{zoneName, addition, scale: 1+addition}], scale: Π scale, contributions[] }`。每条 contribution 携带完整五元身份与 `appliedFrame/expireFrame`,这就是 UI 上"这个乘区数字来自哪个 Buff"的数据基础。
- **解释** `attributeSnapshot()`(`:500`):回答"这个属性值是哪些来源凑出来的"——基线来源 + 活动来源逐条列贡献,解决"陈千语叠攻 Buff 在面板公式内生效、但伤害乘区快照看不见"的归属断层(注释 `:494-499`)。

### 6.4 伤害公式本体

`damage.mjs:1 calculateDamage`,全部乘区与来源:

```js
finalDamage = attack                       // 攻击力(八区组件求值后)
  × atkScale                               // 技能倍率 scale × calculationMultiplier
  × attackerZoneScale                      // 攻击方增伤区(见 6.5)
  × defenderZoneScale                      // 防守方易伤区(Defender NormalCalcZone 等)
  × configuredDamageBonusScale             // 1 + Σ配置增伤(全伤/元素/法术/指令类)
  × defScale                               // 1 / (1 + defense × 0.01)
  × resistanceScale × damageTakenScalar    // max(0, 1 - resistance/100) × max(0, 承伤)
  × vulnerableDmgScale                     // max(0, 1 + 各系VulnerableDmgIncrease)
  × weaknessDmgScalar                      // max(0, WeaknessDmgScalar) —— 攻击方"虚弱"
  × shelterScale                           // max(0, 1 - ShelterDmgScalar) —— 防守方"庇护"
  × specialScale                           // 处决伤害倍率(仅 BreakingAttackCalculation)
  × selectedCriticalScale                  // 暴击:None=1 / All=1+爆伤 / Expect=1+爆击率×爆伤
```

几个容易读错的语义细节(都来自 `ake-damage-resolver.mjs` 的实现与注释):

1. **虚弱 vs 脆弱是两个方向的乘区**(`:500-505` 注释):`WeaknessDmgScalar` 从**攻击方**读取(降低携带者造成的伤害),`VulnerableDmgIncrease` 从**防守方**读取(提高承受)。中文都叫"虚弱/脆弱",数学位置完全不同。
2. **配置增伤**(`configuredDamageBonus`,`:297-318`)是 LTS 面板契约注入的静态区:`ConfiguredAllDamageBonus + 元素 bonus + 法术 bonus + 指令类 bonus`(如 `ConfiguredComboSkillDamageBonus`),底值 `max(0, 1 + total)`。
3. **抗性按百分比除以 100**,承伤是独立乘区,两者相乘(旧报告的 `damageTypeResistanceScale` 保留为别名,`:25`)。
4. `igniteDamageScalar`/`physicalInflictionDamageScalar` 当前恒为 1(`damage.mjs:29-30`),是为反应伤害预留的槽位,不是已实现语义。
5. **暴击三态**由场景参数 `criticalMode` 决定(None/All/Expect),非随机掷骰——引擎是确定性模拟器,期望值模式是默认的"对拍口径"。

### 6.5 攻击方乘区的三路合并

`attackerZone` 是三路数据的合流点(`ake-damage-resolver.mjs:415-450`):

1. **注册区**:`effectSources.damageZone(side=Attacker)`——活动 Buff/装备/天赋的 damageModifiers(如导电给四种法术伤害的敌方 `NormalCalcZone`、全队火伤加成);
2. **面板属性区**:`attackerAttributeZone()`(`:222-295`)把攻击者的 `XxxDamageIncrease`(元素)与 `XxxSkillDamageIncrease`(指令类)属性折算成 `NormalCalcZone` 贡献,并附带 `attributeSnapshot` 的精确来源行(聚合行标记 `omitFromContributionLedger`,不双计,`:135-139`);
3. **连击区**:`ComboCalcZone` 被单独拆出(`:443-450`),消耗的连击层数(`consumedStatusesForCast`)转成独立的 `combo-damage` factor——doc 17 第三轮冻结的"连击 ×N 独立乘区"契约。

### 6.6 factor snapshot 与复算校验

每个 Hp Hit 携带 14 个语义 factor(`ake-damage-resolver.mjs:579-703`):`attack / attack-scale / attacker-zone / combo-damage / configured-damage-bonus / defense / resistance / damage-taken / {element}-vulnerability / defender-zone / weakness / shelter / special / critical`。每个 factor 有 `semanticKey/displayName/operation(AddRate|Multiply)/rawValue/multiplier/contributions[]`,critical 标记 `affectsNonCritical: false`。

**可复算性是硬校验**(`:704-712`):

```js
reconstructedNonCritical = Π factors[affectsNonCritical !== false].multiplier
valid = |reconstructed - engine nonCriticalDamage| ≤ 1e-8
```

校验失败时 Hit 的 `confidence` 从 `verified` 降为 `partial`,并把未复算原因带进 diagnostics——UI 不允许展示一个无法用自身 factor 重建的伤害数字。packet 级部分失败(某些 damageUnit unresolved)会把 `AKE_DAMAGE_PACKET_PARTIAL` 诊断广播到同包所有 Hit(`:748-761`)。

### 6.7 非生命伤害:削韧与失衡

`damageAttributeType = Poise / Resilience` 的 damageUnit 走独立短路路径(`:365-393`):`amount = poiseValue × poiseValueScale × PoiseDamageOutputScalar(攻方) × PoiseDamageTakenScalar(守方)`,不进任何伤害乘区。落地后 `Poise` 只进 `PoiseSystem`(韧性条/节点/破韧/恢复/处决门票),`Resilience` 只进 `ResilienceMachine`(霸体/硬直/处决量表)——doc 17 §14 完成的双状态机分流,曾经两者混进同一个 `applyImpact` 导致失衡条方向反向。

## 7. 技能程序调度

编译产物 program 的结构:`{ skillId, blackboard, costValue/costType, cooldownSeconds/ticks, launches, castStartActions, timeline[] }`,timeline 每组 `{startFrame, endFrame, actions, cleanupActions, metadata, unresolved}`。

`scheduleProgram`(`combat-runtime.mjs:924`)按组调度 **cast-start / start / cleanup** 三阶段 timer 到技能所属时钟域。关键机制:

- **generation 失效**:每次调度带 generation 号,Seek 跳转或中断时旧回调作废,防止过期 timer 触发已废弃的组;
- **launches → 派生施放**:发射体/子技能经 `onDerivedSkillCast` 回调由 runner 归属到当前 cast(`ake-scenario-runner.mjs:611-660`),子 Hit 保留 `parentCastId` 而不靠 skillId 字符串猜父子(doc 17 §16.3 六字段身份契约);
- **中断**:`MarkCanInterrupt`(`markProgramInterruptible`,`:1299`)标记可中断窗口,`InterruptCurrentSkill`/`cancelProgramExecution`(`:1325/1370`)按 cast 清理;
- **Seek 跳转**:`seekProgram`(`:1248`)实现 JumpToAction,跳转后旧组 cleanup 按 generation 取消。

## 8. 指令层:每帧驱动循环

`AkeScenarioRunner.run({commands, endFrame})`(`ake-scenario-runner.mjs:201`)的单帧顺序:

```text
命令入队(commandQueueWindowFrames=30)
  → CommandAdmissionProvider.evaluate      // 数据驱动准入(优先级/可中断窗口/独占帧)
      ├─ 拒绝 → commandAdmissionTrace 记 reason + nextTimelineFrame 重试点
      └─ 通过 ↓
  → 资源 canPay → 冷却检查 → beginSkill
      ├─ 失败 → 记录失败原因(资源不足/冷却中/连携门控)
      └─ 成功:状态迁移 → scheduleProgram → 扣费 → 启动冷却
  → 帧内事件队列推进(runUntil)
  → finishCurrentSkill:SkillEnd 事件、attachedToCastId 的 Buff 清理、处决预约释放
  → 空闲 120 帧 → notifyFightExit(OnTrulyExitFight)
```

准入决策完全由 `spec/engine-semantic-mappings.json` 的 `CommandAdmissionRule`(每 commandType 一条:优先级数值 + admissionMode)与 `CommandAdmissionPolicy`(decisionOrder/retrySources)驱动,`command-admission-provider.mjs:183` 缺规则直接抛错,无角色/指令硬编码;43 条 Calc 打断观测直接对拍 admission trace(`test/calc-interruption-oracle.test.mjs`)。

## 9. 确定性与可审计性

- **无随机**:概率条件编译为 `Probablity` → 场景 seed 的确定性抽样(doc 17 G11);暴击用三态模式而非掷骰;
- **全序**:事件按 `(frame, priority, sequence)` 全序执行,嵌套 dispatch 受深度上限;
- **可回放**:同一 bundle + 同一 commands 必然产出同一 trace;
- **五元组留痕**:所有状态机 trace 记录 `before/requested/actual/discarded/after`;
- **oracle 锁定**:`fixtures/calc/*.oracle.json` 由 capture 脚本捕获并记 SHA-256,src 运行时被验证不读取答案文件(全 src 仅 `scenarios/pelica.mjs:368` 一处字符串引用,非文件读取)。

## 10. 测试体系

58 个测试文件、`node --test`,分两类:

1. **Calc oracle 回归**(逐字段对拍,浮点严格相等):佩丽卡 9 段伤害(`pelica.test.mjs`)、通用运行时 vs 失衡边界 oracle、43 条打断 admission 对拍、跨角色(狼卫/陈千语)面板与伤害包、资源边界、小队共享资源;
2. **引擎单元/行为测试**:编译器读**原始公开数据**(非答案)验证真实 SkillData 的霸体窗等;各状态机独立测试;跨角色变形测试(doc 17 L3:状态 ID 任意替换结果不变,防角色特例回归)。

## 11. 当前边界(引擎自身的已知不健全)

计算引擎的系统性缺口不在公式,而在"公式读不到状态"与"机制没有通用执行路径",详细审计见 [20 号文档](20-generic-engine-per-operator-integration.md) §5。摘要:

- **能力事件生产者缺口**:全语料 84 种事件值,仅 30 种有已证明生产者,`OnOwnerHpZero=105` 组已闭环但 `OnPoiseKnotBreak`、`OnEnterFight`、`OnReceiveHeal` 等仍缺——消费者可编译不等于事件可触发;
- **unresolved 分级**:7,100 个 unresolved 动作中 289 个 combat-blocking(会改变战斗结果但无实现)、422 个 evidence-missing(缺证据不许猜值);
- **空间假设**:1,771 个 spatial-assumption 动作(位移/半径/搜索)在固定木桩假设下降级执行;
- **双链未合并**:精确链与通用链仍是两套代码,通用链尚未对全部角色达到精确链的对拍精度;
- **精确链与空间**:无碰撞、寻路、击飞距离、Boss AI——引擎是"木桩对拍模拟器"不是完整游戏复现。

## 12. 快速索引

| 想看什么 | 去哪里 |
| --- | --- |
| 事件上下文与实体 | `combat-context.mjs:83`、`combat-runtime.mjs:379` |
| 规则分发 | `combat-runtime.mjs:554(registerRule)/574(dispatch)` |
| handler 全表 | `combat-runtime.mjs:2033(#defaultHandlers)` |
| 伤害包执行 | `combat-runtime.mjs:4654(ResolveDamagePacket)` |
| 伤害公式 | `damage.mjs:1`、`ake-damage-resolver.mjs:324` |
| 乘区登记/查询 | `effect-source-registry.mjs:221(apply)/406(damageZone)/500(attributeSnapshot)` |
| 时钟域 | `clock-domain-manager.mjs:150`、`local-clock.mjs:9` |
| 技能程序 | `combat-runtime.mjs:924(scheduleProgram)/1248(seek)` |
| 指令循环 | `ake-scenario-runner.mjs:201(run)` |
| 准入 | `command-admission-provider.mjs:183` |
| 连携 | `combo-trigger-machine.mjs`、语义映射 `ComboTriggerRule` |
| 失衡/处决 | `poise-system.mjs:40`、`poise-machine.mjs:63` |
