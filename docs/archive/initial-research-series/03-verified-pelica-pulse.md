# 已验证用例：佩丽卡连续两次 Pulse

## 静态链路

```text
CharGrowthTable[chr_0004_pelica]
  → chr_0004_pelica_normal_skill
  → timeline SpellInfliction(Pulse)
  → [semantic/observed]
     buff_common_energy_shard_attached_pulse
       ├─ Limited: duration=20s
       ├─ EnhanceAndRefresh: maxStack=4
       └─ 再次收到 Pulse
          ├─ 创建 buff_common_pulse_pulse_triggered
          └─ 重新施加自身，层数增加并刷新持续时间

buff_common_pulse_pulse_triggered
  ├─ Limited: duration=10s
  ├─ triggerInterval=1s
  ├─ waitFirstTriggerInterval=true
  ├─ maxTriggerCnt=1
  └─ OnBuffTrigger
     ├─ TriggerSpellBurstEventAction
     ├─ ReadSkillSettingData("法术爆发伤害倍率")
     └─ DamageAction(atk_scale)
```

关键边界：SkillData 只写 `SpellInfliction(Pulse)`，没有写附着 Buff ID。因此 `Pulse → attached_pulse` 不是静态直接引用。

## Calc 黑盒观测

场景为佩丽卡在 frame 0 与 frame 100 各施放一次普通技能。归一化期望保存于 `fixtures/pelica-pulse.expected.json`。

当前 Calc 前端公开包显示 HTTP 模拟入口默认为 `POST /api/simulations`；前端会把角色、敌人、动作命令、预使用道具、合约标签和战斗设置组装为请求。旧的双 Pulse 用例仍只有归一化摘录；新的“第四段普攻 → 连携技 → 战技”用例已经把完整公开请求、响应与精简 oracle 固化在 `fixtures/calc/pelica-heavy-combo-skill.*.json`。

当前本地快照中的 Calc metadata 为 `9163343-11`，AKE TableCfg 为 `1.4.4@9433094-12`。这个用例验证的是两边共同呈现出的状态语义，不应把所有具体数值默认视为同版本严格对照。

观测结果：

- frame 13：附着 Buff Started，1 层，600 tick；
- frame 113：反应子 Buff Started，300 tick；
- frame 113：附着 Buff Refreshed，1 层变 2 层，重新获得 600 tick；
- frame 143：子 Buff 首次触发，距离创建正好 30 tick，并产生额外 Pulse 伤害。

这同时验证了生命周期、增强刷新、子 Buff 创建、首次等待和 30 tick/秒。

## 尚未静态闭合的依赖

子 Buff 通过 `ReadSkillSettingData("法术爆发伤害倍率")` 获得实际 `atk_scale`。BuffData 内的动态占位值不是最终倍率，因此需要找到 SkillSetting 数据源，或者把该读取暂时实现成显式外部依赖。
