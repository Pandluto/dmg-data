# Buff 状态机实现规格

## 实例状态

每个运行中的 Buff 至少保存：

```text
BuffInstance
├─ buffId
├─ owner / source / target
├─ sourceSkillCast
├─ startTick / expireTick / nextTriggerTick
├─ triggerCount
├─ stackCount / maxStackCount / stackingKey / priority
├─ localBlackboard
├─ inheritedBlackboard
└─ lifecycleState
```

不能只按 `buffId` 做全局单例。同一 Buff 可能因 owner、source、stackingKey 或运行时 Blackboard 不同而形成不同实例。

## 输入事件

- ApplyBuff
- OnBuffStart
- OnBuffAfterTryEnhanced / OnBuffEnhanceChanged
- OnBuffTrigger
- AbilityEvent
- IgniteEvent / SpellInfliction
- Finish / Expire / Dispel

## 守卫

条件节点包括 Check、Compare、TagQuery、上下文 Buff 查询和目标状态判断。守卫需要访问 owner、source、target、技能施放上下文与 Blackboard。静态发现一条 CreateBuff 边，不代表该转换在所有场景都会发生。

## 转换

- 创建新实例；
- 按 stacking group 拒绝、覆盖、增强或刷新；
- 修改层数与计时器；
- 创建或继承子 Buff；
- 延长、完成、驱散实例；
- 向全局系统或关卡脚本发送事件。

## 输出动作

- AttributeModifier / GlobalModifier
- DamageAction / HealAction
- Shield / Poise / Resource
- Spawn / Targeting / Movement / Control
- CreateBuff / FinishBuff / TriggerSpellBurstEvent

## Blackboard 数据流

实现时应保留每个值的来源：

```text
调用处或模式传入值
  → 父 Buff assignItems / inherited values
    → 当前实例 local values
      → BuffData 默认值或字段 fallback
```

最终优先级需要逐个动作验证，不能直接照搬 AKE 通用详情页的显示顺序。危机合约的 `attr=0.8` 和潜能的持续时间/倍率都是调用处覆盖默认值的典型情况。

## 时间

现有 Calc 观测符合 30 tick/秒：20 秒为 600 tick、10 秒为 300 tick、1 秒间隔为 30 tick。执行器内部应全部使用整数 tick，只在输入和输出边界换算秒。

## 事件队列

同 tick 多动作必须使用稳定顺序。建议事件记录至少包含：

```text
tick, sequence, eventType, buffId, owner, source,
stackBefore, stackAfter, blackboardSnapshot, jsonPath
```

这样才能解释 Calc 差异，而不是只比较最终伤害数字。

