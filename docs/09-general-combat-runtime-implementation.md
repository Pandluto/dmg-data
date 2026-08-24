# 通用战斗运行时：本轮实施规格

## 1. 本轮目标

本轮优先完成广覆盖、可组合的代码骨架，不进行大规模 CALC 黑盒边界采集。已有佩丽卡精确用例必须继续通过；新增模块只要求针对主要状态转换的轻量单元测试和一条主运行时冒烟链路。

需要落地的能力：

1. 统一实体、事件上下文及 `source / owner / target / cast` 归属；
2. 数据驱动的条件树和效果动作解释器；
3. 全局、角色、敌人及其他实体的时钟域；
4. 多实体/共享资源池；
5. HP、治疗、护盾和伤害吸收顺序；
6. Buff 光环的来源、目标进入/离开及来源清理；
7. 元素附着、积蓄、触发、消费和派生效果；
8. 独立于 Poise 的 Resilience、超级护甲与控制门控；
9. 一个统一 `CombatRuntime` 门面，将上述模块接成可运行系统。

高级、精英/Boss、首领的快速破韧参数本轮只保留可配置 profile 接口，不投入深度逐帧实验。空间碰撞、寻路、击飞距离和 Boss AI 不属于本轮。

## 2. 设计原则

### 2.1 现有精确核心不被替换

`simulator.mjs`、`BuffMachine`、`ResourceMachine`、`PoiseMachine` 与 `LocalClock` 已由公开 oracle 验证。本轮新增通用层，暂不大规模重写佩丽卡路径。整合时允许把统一上下文镜像接入现有模拟器，但不得改变现有命中帧和数值。

### 2.2 归属必须显式

每个运行事件使用同一上下文结构：

```js
{
  frame,
  eventType,
  sourceId,      // 实际动作发起实体
  ownerId,       // 效果、召唤物或光环的归属者
  targetId,      // 当前结算目标
  skillId,
  rootSkillId,
  castId,
  buffInstanceId,
  clockDomainId,
  blackboard,
  payload
}
```

`sourceId` 与 `ownerId` 不得默认相等；光环、召唤物、装备效果和派生 Buff 都依赖这一区分。上下文应可复制并局部覆盖，不能让子动作修改父上下文。

### 2.3 状态与策略分离

- Machine 保存状态、验证输入并产出 trace；
- EffectRuntime 解释条件与动作，并调用 Machine；
- CombatRuntime 负责模块注册、事件分发和处理器接线；
- 角色/装备/关卡专属规则进入定义或语义映射，不进入通用核心的 ID 分支。

### 2.4 所有变化可审计

每条 trace 至少包含：`frame, stage/type, sourceId, ownerId, targetId, reason/ruleId`，数值变化还需包含 `before, requested, actual, discarded, after`。本轮不要求 trace 与 CALC 格式完全一致，但必须足够解释本地结果。

## 3. 模块边界与文件所有权

并行实现期间，每组只编辑自己列出的文件，避免冲突。

### 3.1 实体与通用效果组

负责文件：

- `src/core/combat-context.mjs`
- `src/core/effect-runtime.mjs`
- `test/effect-runtime.test.mjs`

#### CombatContext

实体规范：

```js
{
  id,
  kind,          // Character | Enemy | Summon | Object
  team,
  ownerId,
  attributes,
  tags,
  metadata
}
```

最低 API：

- `registerEntity(definition)`：拒绝重复 ID；
- `hasEntity(id)` / `getEntity(id)` / `listEntities(filter)`；
- `addTag(id, tag)` / `removeTag(id, tag)` / `hasTag(id, tag)`；
- `getAttribute(id, key)` / `setAttribute(...)` / `modifyAttribute(...)`；
- `createEventContext(base, overrides)`：验证实体引用并返回隔离副本；
- `resolveEntityRef(ref, eventContext)`：支持 `Source / Owner / Target / Self / id`；
- `snapshot()`。

#### EffectRuntime

最低条件节点：

- `All`、`Any`、`Not`；
- `Compare`：常量、Blackboard、属性、资源或 payload 值；
- `HasTag`；
- `HasBuff`（委托 handler）；
- `ResourceCompare`（委托 handler）；
- `HpRatioCompare`（委托 handler）；
- `EventTypeIs`、`SkillTypeIs`；
- 未支持条件默认显式失败并写 trace，不得静默通过。

最低动作节点：

- `Sequence`、`IfElseAction`；
- `ModifyAttribute`、`ApplyTag`、`RemoveTag`；
- `ResourceChange`、`Heal`、`AddShield`；
- `ApplyBuff`、`FinishBuff`、`EmitEvent`；
- `ApplyInfliction`、`ApplyImpact`；
- 业务动作通过注入 handlers 委托，EffectRuntime 本身不依赖具体 Machine 类。

最低 API：

- `evaluate(condition, eventContext)`；
- `execute(actionOrArray, eventContext)`；
- `registerHandler(actionType, handler)`；
- `trace` / `snapshot()`。

## 4. 时间、资源与生命组

负责文件：

- `src/core/clock-domain-manager.mjs`
- `src/core/resource-system.mjs`
- `src/core/vital-machine.mjs`
- `test/runtime-state-machines.test.mjs`

### 4.1 ClockDomainManager

在现有 `LocalClock` 上提供多时钟域注册与路由：

- 内置 `global` 域；
- `registerDomain({ id, kind, ownerId })`；
- `localFrameAt(domainId, globalFrame)`；
- `startTimer(domainId, timerDefinition)`；
- `pause(domainId, pauseDefinition)`；
- `pauseMany(domainIds, pauseDefinition)`；
- `timer(domainId, timerId)` / `snapshot()` / 聚合 trace。

本轮只要求离散暂停模型。连续曲线 TimeDilation 可以记录 `requestedScale/duration`，但在没有曲线采样器时必须由调用者传入 `excludedTicks`，不得自行猜测。

### 4.2 ResourceSystem

支持共享池与实体池：

```js
{
  id,                 // squad:Atb / chr_0004:UltimateSp
  resourceType,
  scope,              // Shared | Entity
  ownerId,
  initial,
  max,
  passiveRecovery,
  clockDomainId
}
```

最低 API：`registerPool`、`get`、`canPay`、`gain`、`spend`、`transfer`、`resolvePool`、`snapshot`。必须记录封顶溢出、消费不足、来源/目标与 reason。已有 `ResourceMachine` 保持兼容；新系统可以组合或包装它，但不要破坏原测试。

### 4.3 VitalMachine

每个实体保存：

- `maxHp / currentHp`；
- 可选治疗封顶；
- 多个有来源的 ShieldInstance；
- `alive` 状态。

最低 API：

- `registerEntity`；
- `heal({ baseAmount, healingDoneScalar, healingTakenScalar })`；
- `addShield({ amount, sourceId, ownerId, buffId, priority, stackingKey })`；
- `damage({ amount, bypassShield, damageType })`；
- `removeShieldsBySource`；
- `hpRatio` / `snapshot`。

护盾默认按高 priority、再按早创建顺序吸收；同 stackingKey 默认替换，策略必须可配置。trace 区分吸收量、HP 实伤、治疗溢出与护盾溢出。

## 5. 光环、反应与韧性组

负责文件：

- `src/core/aura-machine.mjs`
- `src/core/reaction-machine.mjs`
- `src/core/resilience-machine.mjs`
- `test/advanced-mechanics.test.mjs`

### 5.1 AuraMachine

光环实例由 `(auraId, sourceId, ownerId)` 唯一标识；目标绑定由 `(instanceId, targetId)` 唯一标识。

最低 API：

- `createAura`；
- `refreshTargets({ frame, auraInstanceId, targetIds })`；
- `removeAura`、`removeBySource`、`removeByOwner`；
- 目标进入时调用 `onApplyTarget`，离开时调用 `onRemoveTarget`；
- `snapshot` 和完整 enter/leave/finish trace。

本轮目标列表由外部传入，不实现空间搜索。这样后续空间系统只需替换 target provider。

### 5.2 ReactionMachine

定义驱动：

```js
{
  element,
  threshold,
  maxBuildup,
  consumePolicy,
  reactionId,
  cooldownTicks,
  clockDomainResolver,
  onTriggerActions
}
```

最低 API：

- `registerTarget`；
- `applyInfliction`：积蓄、封顶、跨阈值触发、消费；
- `setAttachedState` / `clearAttachedState`；
- `canTrigger`、`snapshot`；
- `onReaction` 回调携带完整来源上下文和派生动作。

必须支持同目标不同元素独立积蓄、触发冷却、一次输入跨多个阈值的可配置策略。佩丽卡 Pulse/导电/法术爆发本轮只需用通用定义表达一条轻量示例，不追求完整数值 oracle。

### 5.3 ResilienceMachine

这是 Poise 之外的控制韧性系统，不得复用 `PoiseMachine` 状态字段。

实体定义至少包含：

```js
{
  maxResilience,
  recoveryPerTick,
  superArmorLevel,
  controlImmunityLevel,
  executionGaugeMax
}
```

最低 API：

- `applyImpact({ amount, controlType, controlLevel })`；
- `applyControl`：根据超级护甲/免疫级别返回 Applied、Reduced 或 Immune；
- `recover` / `tick`；
- `applyExecutionGauge` / `consumeExecutionGate`；
- `snapshot`。

本轮只实现数值条与状态门控：Stable、Staggered、Downed；不实现位移距离、刚体或动画。

## 6. 主 Agent 整合层

并行模块完成后，由主 Agent 独占编辑：

- `src/core/combat-runtime.mjs`
- `src/core/status-effect-system.mjs`
- `test/combat-runtime.test.mjs`
- `src/core/ake-parser.mjs`（只补通用动作规范化）
- `README.md`、`docs/04-gaps-and-roadmap.md`、本文件状态
- 必要时 `src/core/simulator.mjs`，仅作非破坏性接线

`CombatRuntime` 最低门面：

```js
new CombatRuntime({ schedule, tickRate, definitions })

runtime.registerEntity(...)
runtime.dispatch(eventContext)
runtime.execute(actions, eventContext)
runtime.snapshot()
runtime.trace
```

`StatusEffectSystem` 是通用实体级 Buff 适配层，必须显式保存
`buffId / sourceId / ownerId / targetId / sourceSkillId / castId / clockDomainId`，并支持按来源或归属者批量清理。现有 `BuffMachine` 继续服务已经精确验证的佩丽卡链；通用层不以破坏旧实现的方式强行替换它。光环只负责目标集合变化，通过 StatusEffectSystem 创建和结束目标 Buff。

默认 handler 路由：

| Effect action | 目标模块 |
|---|---|
| ModifyAttribute / Tag | CombatContext |
| ResourceChange | ResourceSystem |
| Heal / AddShield | VitalMachine |
| ApplyBuff / FinishBuff | 外部 Buff adapter；未注入时明确 Unsupported |
| ApplyInfliction | ReactionMachine |
| ApplyImpact | ResilienceMachine |
| EmitEvent | CombatRuntime 再分发 |

事件分发流程：

1. 验证并冻结输入上下文；
2. 写入 `EventDispatched`；
3. 通知按 eventType 注册的 rule；
4. EffectRuntime 执行动作；
5. 派生事件加入稳定队列或同步受控递归；
6. 超过最大派生深度时抛出显式错误；
7. 返回动作结果与统一快照。

## 7. 本轮简单测试范围

本轮只要求以下测试，不采集新的大规模精确 oracle：

1. Source 与 Owner 不同，目标解析正确；
2. 条件树通过/失败分别执行对应动作；
3. 两个独立局部时钟中，只暂停指定域；
4. 共享 ATB 与两个角色独立 USP 路由正确；
5. 治疗封顶、治疗溢出、两层护盾吸收顺序正确；
6. 光环进入、离开和来源删除清理正确；
7. 元素积蓄跨阈值只触发规定次数并消费；
8. 超级护甲/控制免疫和 Resilience 归零状态正确；
9. 一条 `CombatRuntime` 冒烟链：事件条件 → 消耗资源 → 施加光环/Buff adapter → 元素触发 → 治疗/护盾 → 韧性变化；
10. 既有精确回归继续通过。

不要求：当前 CALC 全角色精确对照、所有 AKE action type 覆盖、空间目标、连续 TimeDilation 曲线、敌人 AI 或界面。

## 8. 完成定义

本轮完成必须满足：

- 上述模块文件均存在且没有角色 ID 特判；
- 所有公开 API 有输入验证和 trace；
- 至少三个并行实现组的代码由主 Agent 审查并统一接入；
- 新增轻量测试通过；
- 原有测试不回退；
- 文档明确标注“代码骨架完成、深度 oracle 待下一轮”；
- 未确认参数仍保留为 definition/profile 输入，不硬编码成游戏真值。

## 9. 本轮实施结果

状态：**代码骨架完成，深度 oracle 待下一轮。**

实际落地文件：

- `combat-context.mjs` / `effect-runtime.mjs`：统一上下文与数据驱动解释器；
- `clock-domain-manager.mjs` / `resource-system.mjs` / `vital-machine.mjs`：时间、资源、生命和护盾；
- `status-effect-system.mjs` / `aura-machine.mjs`：实体 Buff 与来源光环；
- `reaction-machine.mjs` / `resilience-machine.mjs`：元素反应与控制韧性；
- `combat-runtime.mjs`：事件规则、默认 handler、派生事件和统一快照。

整合时额外关闭了三个接口缝隙：

1. Source 与 Owner 不再互相隐式回退，数字实体 ID 与字符串 ID 的约束保持一致；
2. 反应冷却可直接路由 `ClockDomainManager`，Buff 刷新/结束可取消旧局部定时器；
3. 光环生命周期保留 `skillId / rootSkillId / castId / clockDomainId`，目标 Buff 不丢施法归属。

默认效果路由在最低规格上增加了 `Damage`、光环创建/刷新/结束、控制施加、韧性恢复、处决量表和时钟暂停。未支持条件仍显式返回失败，派生事件超过深度上限会抛错。

轻量测试分为四组：实体/效果解释器、时间/资源/生命、光环/反应/韧性、`CombatRuntime` 组合链。原佩丽卡与 Poise 精确回归继续作为不回退约束；本轮没有新增大规模 Calc 黑盒采集，也没有为未知首领参数填入猜测值。

## 10. 后续 AKE 编译整合

在本规格的通用模块完成后，主整合层又增加了 AKE 动作编译器、来源化效果注册表、通用伤害 resolver、潜能/天赋/装备被动编译器，以及 Buff 内时间轴和显式时间曲线适配接口。当前全项目为 95 条测试通过；真实公开数据链、43 条打断/跳转精确样本与全语料覆盖口径详见 [AKE 动作编译器、通用执行链与覆盖审计](10-ake-runtime-compiler-and-coverage.md) 和 [Calc 轨道指令、打断与脱手效果差分实验](12-calc-interruption-probe.md)。
