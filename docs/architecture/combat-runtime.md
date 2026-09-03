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

## 条件与值图

AKE 条件不是一组互不相关的布尔 action。compiler 先解释 condition list，再生成运行时谓词：

- 连续条件组成 `All`；
- `NotNextCheckAction` 只否定同一列表中的下一个条件；
- `OrConditionAction` 的每个 wrapper 是一个分支，分支之间组成 `Any`；
- `IfElseAction`、伤害修正和 Buff 切换共用同一条件入口；
- Blackboard、payload、属性、状态层数、目标组、实体类型、职业、super armor、Poise、技能是否命中和 ability entity 剩余时间都作为显式值或谓词读取。

无法安全解释的条件生成 `AkeUnresolvedCondition` 并失败，不允许默认通过。`CheckCustomAbilityEvent` 读取真实事件 envelope；事件参数写回当前 listener 的 Blackboard，而不是全局临时变量。

## 目标组与 ability entity

目标引用可以是 source、owner、event target、显式目标或 context target group。组包含和计数读取完整集合；需要单个目标的 action 才按显式 index 选择。`MainCharacterValidator` 进入 finder IR，不在前端补筛选。

`SpawnAbilityEntity` 分开处理实体存在与 child program：

1. 先注册唯一实体 identity、owner/team、source/target、tag、cast lineage 和 metadata；
2. 空 `abilityEntitySkillId` 仍得到可引用的 marker entity；
3. 非空 child SkillData 存在时才调度派生程序；
4. duration、target、timeline end、source death 和显式 finish 都操作同一 entity handle；
5. 缺失 child 文件保留诊断，但不撤销已经注册的实体或中止父技能。

实体期限使用来源实体的时钟域。`CheckAbilityEntityCurDuration` 读取当前剩余秒数，因此刷新判断和真正到期使用同一个计时事实。

## 周期与取消

周期 action 同时受 source interval、per-target interval、duration、max execution 和 generation 控制。单目标场景的有效 cadence 取两个 interval 中更严格的值；刷新或取消使旧 generation 失效，不允许旧 timer 继续写状态。

通道、状态 tick、Buff timeline 和 ability entity 期限都使用时钟域调度。全局帧负责确定事件顺序，局部时钟负责暂停与恢复；表现暂停不能通过移动全局事件伪造。

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

`TimedGrowingEnhance` 使用同一 Buff 实例保存零层容器、当前层数、增长间隔、上限和 timer generation。直接加层按离散层数截断并受上限约束；归零后容器仍存在并可继续增长。该路径是由公开字段驱动的当前实现，外部起始时点、重置和离战精确行为仍受 [当前边界](./known-boundaries.md) 约束。

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
- 缺失 child SkillData 不得把父技能已经发生的状态、实体或事件回滚成不存在。
- 表现动作可以 metadata-only；战斗关键动作不能静默跳过。
- `unresolvedEffectCount = 0` 只说明已进入编译链的节点没有运行期 unresolved，不证明原始结构没有被遗漏；结构覆盖由独立 audit 负责。
- 命令成功但没有应有 Hit 时，前端显示 partial，而不是回退旧计算器制造数值。
