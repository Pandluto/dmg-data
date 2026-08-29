# 战斗运行时

## 基本模型

运行时使用 30 tick/秒和整数帧。所有效果都在显式事件上下文中执行：

```text
frame / eventType
sourceId / ownerId / carrierId / targetId / damageSourceId
inputSkillId / executedSkillId / effectiveSkillType
castId / rootCastId / parentCastId / buffInstanceId
clockDomainId / blackboard / payload
```

身份字段不能互相默认相等。召唤物、派生技能、敌方状态、队伍 Buff 和动作携带 Buff 都依赖这些区别。

## 指令到技能

runner 对每个输入依次处理：

1. 根据当前槽位、普攻序列和技能形态解析候选 `skillId`；
2. 检查资源、冷却、连携 pending 和处决门票等领域门控；
3. 由 `CommandAdmissionProvider` 比较优先级、AllowNext、可打断标记和独占期；
4. 立即执行、进入输入缓存、严格过期或拒绝；
5. 建立 root cast，执行 cast-start 动作并调度技能程序；
6. 中断时取消尚未提交的从属程序，已经创建的独立 Buff 按自身生命周期继续。

准入器只回答“候选技能能否替换当前技能”。资源不足、冷却、窗口和 Poise 门票分别由自己的状态机回答，不能塞回一个布尔判断。

同帧事件使用稳定的 `(frame, priority, sequence)` 顺序。实际优先级是代码契约；文档不复制完整数字表，避免调度修改后双写漂移。

## 技能程序与派生技能

`AkeActionCompiler` 输出纯数据程序：

- `castStartActions`：例如非空 `switchToBuffConfig`；
- `timeline[]`：每个时间组的开始、结束、动作、清理和 metadata；
- `effectiveSkillType`：由 AKE 技能规格决定的实际结算类型；
- `compiler.unresolved[]`：无法安全执行的节点和原因。

`CastSkill` 与 ability entity 都编译为 `LaunchSkillProgram`。派生程序继承根施放身份，同时有自己的 `executedSkillId` 和 `parentCastId`。取消根施放时，仍从属于该动作生命周期的派生程序会被取消；已经脱手的状态由其 carrier 和时钟继续管理。

## 状态事务

每个 Buff 实例至少区分：

```text
buffId + instanceId
source / owner / carrier / target
root cast / parent cast / source skill
stacking key / stack count / priority
start / expire / next trigger
local and inherited blackboard
exit reason
```

同一个 `buffId` 不是全局单例；相同 stacking key 也只是互斥或叠层槽，不等于相同 Buff 身份。

状态变化输出 `before / requested / actual / discarded / after`，并明确区分：

- apply；
- stack / enhance；
- refresh；
- extend；
- pause / resume；
- inherit / transfer；
- consume；
- expire；
- finish / dispel / replace。

消费发生前先执行守卫；被阻止的消费不应先删除状态。退出原因决定后续 listener，不能全部折叠成 `FinishBuff`。

## 敌方机制

`EnemyMechanicResolver` 把角色动作统一提交到同一敌方状态：

- 四种元素附着共用目标槽，按真实 Buff 定义叠层、刷新和触发反应；
- 同元素与跨元素事务保持后手来源和被消费层来源；
- 破防、击飞、倒地、猛击、碎甲等物理状态使用统一事务；
- 内部 try/fake/wrapper Buff 可以保留在 trace 中，但不能冒充最终 UI 状态。

Poise 由 `PoiseSystem` 单独管理。控制韧性由 `ResilienceMachine` 管理；二者名称相近但生命周期和数值不同。

## 共享队伍状态

共享 ATB 是队伍池，USP 是成员池。共享连击也是队伍状态：

1. AKE `ComboAction` 发放规范连击状态；
2. 全队显示聚合层数，最大四层；
3. 下一次合法战技或终结技开始时原子消费；
4. 消费结果固化到 root cast；
5. 同一 cast 的每个 Hit 读取同一不可变层数和来源快照；
6. 连携技本身不消费连击。

UI 不按队员副本重复显示共享状态，也不能从伤害倍率反推层数。

## 一个 Hit 的因果链

```text
DamageUnit
  → 分配 hitId / sequence
  → OnBeforeCalculateDamage / OnBeforeOutput* / OnBeforeTake*
  → 读取攻击、技能倍率、来源区、目标区、抗性与状态
  → calculateDamage
  → factor snapshot 与乘积校验
  → Poise 或 HP/护盾结算
  → OnOutput* / OnTake* / 暴击与生命事件
  → 写入不可变 Hit 和状态快照
```

HP Hit、Poise Hit、状态额外 Hit 和派生技能 Hit 都是独立事实。前端聚合可以合并显示，但不能在账本中丢掉身份。

## 伤害公式

当前 HP 伤害的结构为：

```text
attack × atkScale
× attackerZoneScale
× defenderZoneScale
× configuredDamageBonusScale
× defenseScale
× resistanceScale
× damageTakenScalar
× vulnerableDmgScale
× weaknessDmgScalar
× shelterScale
× specialScale
× selectedCriticalScale
```

关键方向：

- `WeaknessDmgScalar` 从攻击者读取，表示携带者造成伤害降低；
- `VulnerableDmgIncrease` 从防守者读取，表示承受对应类型伤害增加；
- `ShelterDmgScalar` 从防守者读取并转换为减伤；
- 共享连击使用独立 `ComboCalcZone` 展示，但数学乘积与攻击方总区恒等；
- 处决倍率只用于对应 calculation type；
- 暴击模式是确定性的 None / All / Expect，不做随机掷骰。

每个 Hit 保存 operands、语义 factors、来源 contributions 和 `factorValidation`。显示层只能格式化这些字段。

## 失败语义

- 缺少目标、属性、定义、SkillSetting、provider 或 calculation type 时返回明确诊断。
- 表现动作可以 metadata-only；战斗关键动作不能静默跳过。
- `unresolvedEffectCount = 0` 只说明已进入编译链的节点没有运行期 unresolved，不证明原始结构没有被遗漏；结构覆盖由独立 audit 负责。
- 命令成功但没有应有 Hit 时，前端显示 partial，而不是回退旧计算器制造数值。
