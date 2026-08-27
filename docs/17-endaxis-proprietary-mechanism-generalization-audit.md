# Endaxis 专有机制归纳与 AKE 通用引擎升级研究

> 研究日期：2026-08-27（Asia/Shanghai）  
> cleanroom 研究基线：`622c937f`  
> Endaxis 对照基线：`66bb80be8c07bf8b27c2606c220836f5537bf664`  
> AKE 数据基线：仓库内 `reference/public-data/akedata` 及 `reference/third-party/akedatabase`  
> 研究范围：状态机、计算引擎、运行时账本和 UI 正确性  
> 明确保留：共享变速、强边界分组、水位和时间投影交互；本文不把 Endaxis 的固定帧率/固定像素轴移植进来

## 0. 结论先行

Endaxis 并不是“完全不含角色特例的通用引擎”。它的主体确实是一套组合式 DSL：事件、条件、状态、伤害、资源、冷却、形态和 patch 可以组合；但角色数据中仍有大量手工机制描述，运行时与 UI 也残留少量角色 ID 判断、固定状态别名和显示特例。

这恰好提供了比“照抄角色实现”更有价值的研究材料：把 30 名干员看似不同的专有机制拆开后，绝大多数可以归入 12 类通用能力。我们不应建立 30 套角色状态机，而应建立一条由 AKE 原始证据驱动的统一链路：

```text
AKE SkillData / BuffData / TableCfg
  -> 证据闭包与语义分级
  -> Normalized Mechanic IR
  -> 确定性事件调度 + 唯一 Runtime State
  -> 状态/伤害/资源事务
  -> Runtime Ledger
  -> 水位轴和技能详情的只读投影
```

本轮最重要的判断有六点：

1. **“通用”不等于所有原始动作都由一个大函数猜语义。** 通用的含义是：同一种 AKE 原始能力只编译一次，同一种运行时事务只执行一次，角色只提供数据和组合关系。
2. **当前全库 `unresolved` 数量不能代表角色正确率。** 镜头、移动、特效、曲线和战斗关键动作被混在同一个桶中；总覆盖率很高或测试全绿，都可能掩盖某名干员的关键状态完全没有执行。
3. **Endaxis 的角色实现应被当成“机制假设目录”，不是权威数值源。** AKE JSON 是结构证据，Calc 黑盒是行为对照，Endaxis 只能帮助发现应当存在的状态转移和测试维度。
4. **角色专有名词必须在编译层消失。** “雷枪”“水涡”“源石结晶”“熔火”等最终都应落成通用状态实例、来源关系、消费规则、额外 Hit 或形态选择；运行时不得判断 `characterId`。
5. **UI 不能再补做状态机。** 主轴、详情、命中状态、伤害公式必须读取同一账本。只有显示映射可以认识角色名或图标，数值与合法性不得由组件重算。
6. **共享变速水位轴不需要推翻。** 它是投影层特色；真正需要替换的是它下面不一致的预览状态和 fallback 计算，而不是圆圈、光标、强边界或水位布局。

## 1. 研究问题与证据纪律

### 1.1 本文回答什么

本文逐项回答：

- Endaxis 中哪些机制只是通用 DSL 的组合；
- 哪些机制仍泄漏为角色专有代码；
- 对应的 AKE 原始动作、条件、Buff 生命周期和技能分支是什么；
- cleanroom 当前已经具备什么、缺什么；
- 如何用静态闭包、运行时事务、跨角色变形测试和 UI 投影测试证明它做对了。

### 1.2 四级证据

| 等级 | 来源 | 可以冻结的结论 | 不可直接冻结的结论 |
| --- | --- | --- | --- |
| E1 | AKE 原始 JSON/TableCfg | ID 引用、动作结构、条件树、Buff 生命周期、堆叠方式、数值字段 | Calc 的隐藏后处理与最终乘区 |
| E2 | Calc 同版本黑盒对拍 | 给定输入的最终状态、合法性、Hit 与数值 | 内部源码和字段命名 |
| E3 | Endaxis 源码与测试 | 一种成熟实现如何表达机制、哪些边界值得测试 | AKE/Calc 权威语义与数值 |
| E4 | cleanroom 可执行探针 | 当前项目真实执行、丢失、重复或错误投影了什么 | 游戏本身一定如此 |

冻结规则：

- 结构首先服从 E1；
- 行为与数值由 E1 + E2 校准；
- E3 只用于发现机制维度、设计 IR 和补测试；
- E4 只说明本项目当前状况。

### 1.3 许可证边界

固定的 Endaxis 对照提交中未发现可据以复制实现的许可证声明。因此本项目只研究其公开的架构概念、机制分类和可观察测试边界，不复制代码、数据表或角色数值；实现仍由 AKE 原始证据和 cleanroom 自己的契约完成。

## 2. Endaxis 到底有多“通用”

### 2.1 通用部分

`src/data/types.ts` 已经把大部分机制组织为可组合描述：

- 事件：`onHit`、`onFinalStrike`、`onFinisher`、`onDive`、`onSpRecovery`、状态施加/过期/消费、动作开始、动作期间、战斗开始；
- 条件：敌我状态、HP、失衡、技能/终结技冷却、连携窗口、形态增强、逻辑非/或；
- 效果：状态、元素附着、爆发/反应、物理状态、额外 Hit、DoT、SP/终结技能量、消费、派生、一次性、冷却变更；
- patch：修改 Hit、修改效果、追加效果、修改 Tick；
- 形态：按属性或状态选择技能 overlay；
- 生命周期：堆叠策略、刷新、独立层、来源目标、快照、ICD 和共享 ICD。

所以 Endaxis 能覆盖多数干员，并不是因为它为每名干员写了一个 `switch`，而是角色配置把这些原语组合起来。

### 2.2 仍然存在的专有泄漏

源码对照确认至少有以下泄漏：

| 泄漏位置 | 现象 | 对通用引擎的启示 |
| --- | --- | --- |
| `src/stores/timelineStore.ts` | 单独注册 `laevatain` 增强期延长器 | 技能接续延长必须成为数据驱动的状态持续时间事务 |
| `src/simulation/engine/SimulationEngine.ts` | 直接判断终结技角色是否为 `laevatain` | 时间冻结/终结技窗口不能由角色 ID 分支 |
| 多个 Timeline 组件 | 固定识别 `rossi-combo-perfect-timing-satisfied` | “完美时机”应是通用窗口/命中标签，组件只读语义标签 |
| `src/editor/hits/statusOptions.ts` | 手工维护雷枪、水涡、源石结晶等状态别名 | 名称/icon 映射可以专有，但状态行为不能专有 |
| 部分关卡/条件配置 | 固定引用管理员结晶、汤汤状态 ID | 业务配置可以引用状态 ID；核心引擎不得理解其角色含义 |

结论不是 Endaxis “没有价值”，而是它恰好证明了两个层次必须分离：

```text
允许专有：数据 ID、中文名、图标、技能描述、角色配置组合
禁止专有：状态推进、消费、伤害、资源、冷却、命中结算、合法性和 UI 公式
```

## 3. 31 名干员专有机制归纳

下表不是照搬 Endaxis 的角色数据，而是把其实现暴露出来的测试维度归并为 cleanroom 需要验证的能力。`当前重点缺口` 依据本仓库 AKE 闭包与编译器审计，不表示该角色的所有数值都已经确认。

| Endaxis 标识 / AKE ID | 专有表现 | 应归入的通用能力 | 当前重点缺口与测试 |
| --- | --- | --- | --- |
| Endministrator / `chr_0002_endminm`、`chr_0003_endminf` | 源石结晶、强化战技、结晶消费与击碎额外 Hit | 状态堆叠、消费量读取、技能形态 overlay、派生 Hit | `SetSkillCdAtOnce`；验证结晶施加、强化选择、猛击和击碎是三个独立账本事件 |
| Perlica / `chr_0004_pelica` | 末段命中开启连携、导电 | 末段事件、元素状态、限时 admission window | 验证窗口从真实 Hit commit 开启，过期后不能释放；导电来源属于同一敌方状态 |
| Chen Qianyu / `chr_0005_chen` | 多段普攻、攻击叠层、物理击飞连携 | 多段 Hit、逐 Hit 自身堆叠、物理状态、连携观察器 | 验证七段技能前五段逐层生效；一次战技不能被 UI 重放成两层破防 |
| Wulfgard / `chr_0006_wolfgd` | 燃烧/灼热、追加射击、冷却重置 | 元素附着与反应、子 Hit、冷却事务 | `SetSkillCdAtOnce`；验证追加 Hit 的 source、时间和状态快照 |
| Arclight / `chr_0007_ikut` | 追踪状态、追加命中、强制导电 | 事件订阅、标记状态、子 Hit、强制元素状态 | 验证标记只由匹配 Hit 触发且有 ICD/来源去重；强制导电按公开枚举进入公共异常事务 |
| Ember / `chr_0009_azrila` | 动作期间保护、治疗、倒地 | `duringAction` 生命周期、护盾/治疗、物理状态 | 验证动作结束清理与倒地失败原因，不由 UI 猜测 |
| Xaihi / `chr_0011_seraph` | 辅助晶体、双元素增幅、队伍消费 | owner/controlled 目标、队伍状态、元素筛选、消费 | `DispelAction`、`EnhancedAction`；验证队友伤害读取敌方而非施法者私有状态 |
| Avywenna / `chr_0012_avywen` | 雷枪/强化雷枪、返回、按消费层缩放 | 来源实体、独立状态层、消费读数、倍率/失衡缩放 | ability entity 与 source attribution；验证返回不是重复施加 |
| Gilberta / `chr_0013_aglina` | 队伍光环、终结技法术脆弱、附着层 | recipient scope、敌方 debuff、堆叠/刷新 | 脆弱必须进入目标乘区，并被所有队友后续 Hit 读取 |
| Snowshine / `chr_0014_aurora` | 元素附着与保护 | 附着、`Shelter`/伤害减免状态 | `ShelterAction`；验证状态启停和伤害因子来源 |
| Lifeng / `chr_0015_lifeng` | 消耗接续、派生增益、击倒 | `actionLinkConsumed`、source link、派生值、物理状态 | action link 事务；验证消费发生在同一 admission/commit 边界 |
| Laevatain / `chr_0016_laevat` | 终结技增强窗口、强化普攻/战技、熔火消费 | 形态状态机、状态时间暂停/延长、技能替换、消费 | `PauseBuffTime`、概率分支；不得保留角色 ID 的时间延长特例 |
| Yvonne / `chr_0017_yvonne` | 强化形态、末段强化、冻结消费 | 形态 overlay、继承状态、强制元素状态、patch Tick | `InheritBuffAction`、`ForceSpellStatusAction`；验证末段才消费/触发 |
| Da Pan / `chr_0018_dapan` | 猛击、击倒、击飞、物理易伤 | 统一物理状态事务和敌方 debuff | 验证破防消费、异常伤害、碎甲状态分别有独立事件，不按角色特判 |
| Akekuri / `chr_0019_karin` | 连携窗口、持续时间延长 | admission window、状态持续时间变更 | `ExtendBuff` 类语义；验证刷新与延长不是重新施加两次 |
| Catcher / `chr_0020_meurs` | 按护盾缩放的追加 Hit、倒地/虚弱 | 动态派生值、命中快照、子 Hit、物理状态 | `WeakAction`、`ShelterAction`；验证虚弱降低携带者造成的伤害，护盾读取命中瞬间快照 |
| Estella / `chr_0021_whiten` | 寒冷免疫标记、连携物理脆弱 | 免疫/过滤器、敌方 debuff | 验证免疫是拒绝原因，脆弱是敌方状态而非队伍光环 |
| Fluorite / `chr_0022_bounda` | 炸弹状态，过期爆炸与消费爆炸不同 | 状态退出原因、一次性派生 Hit、冷却减少 | `DoOnce`/`SlowAction`；验证 expire、consume 互斥且只爆一次 |
| Antal / `chr_0023_antal` | 专注、替换堆叠、元素增幅 | replace stacking、派生属性、敌方脆弱 | `VulnerableAction`、`EnhancedAction`；验证作用域和乘区 |
| Alesh / `chr_0024_deepfin` | 子技能、强化连携、SP 获取 | 子动作、资源事务、形态选择、连携窗口 | `ForceSpellStatusAction`；验证资源先后顺序及窗口 cohort |
| Ardelia / `chr_0025_ardelia` | 物理/法术脆弱、腐蚀、Tick 修改 | 类型过滤脆弱、反应状态、patch Tick | `VulnerableAction`；验证同一 debuff 对全队匹配伤害类型生效 |
| Last Rite / `chr_0026_lastrite` | 施法状态、低温灌注、幻影追加 Hit | cast lifecycle、状态消费、team target、子 Hit | 验证施法取消/结束清理与幻影 source attribution |
| Tangtang / `chr_0027_tangtang` | 水涡、水龙卷、凝视、DoT、下落事件 | 独立状态源、DoT 调度、消费层、`onDive` | `DoOnceAction`、`SlowAction`；重点校准两次战技分别施加几层寒冷，不能用图标数猜 |
| Rossi / `chr_0028_wulfa` | DoT、物理易伤、完美接续窗口、两段连携 | 确定性随机、窗口标签、快照 DoT、冷却/状态暂停 | `RandomAction`、`SetSkillCdAtOnce`、`PauseBuffTime`；完美时机不得由 UI 固定 ID 推断 |
| Pogranichnik / `chr_0029_pograni` | SP 阈值追踪、士气、破防 | 资源阈值订阅、replace stacking、team scope、物理状态 | 验证阈值跨越只触发一次，破防与资源事件共用时间顺序 |
| Zhuang Fangyi / `chr_0030_zhuangfy` | 强化普攻/战技/连携、独立剑层、剩余冷却缩减 | 形态 overlay、independent stacking、action snapshot、按剩余值冷却事务 | `TogglableAction`、`ExtendBuffAction`、ability entity；验证切形态不重置错误状态 |
| Mifu / `chr_0031_mifu` | 三段战技、失衡目标分支、猛击视作反应 | 条件形态选择、目标状态、反应别名、护盾/脆弱 | `PauseBuffTime`、`TakeDownAction`、目标 provider；验证第三段由状态自动选择 |
| Arcane / `chr_0032_lizhiyan` | 双形态、属性比较、终结技冷却、收尾触发簇击 | selector/form、冷却条件、owner 消费、消费层读取、子动作簇 | `CastSkill`、ability entity、`VulnerableAction`；“诀”不是独立引擎，只是原语组合压力测试 |
| Camille / `chr_0033_camille` | 追击状态、末段触发伤害、自身/队伍分离 Buff | final-hit 事件、triggered damage、recipient scope | 验证 team/self 两份来源不合并且末段只触发一次 |
| Liino / `chr_0035_liino` | 战斗开始状态、技能冷却、受控目标、倒计时伤害/治疗、姿态、零消费强制导电 | `onBattleStart`、冷却就绪、controlled target、事件监听、继承 Buff、非技能动作、强制元素状态 | `AddTagAction`、`EventListenerAction`、`ChannelingCasting`；强制导电必须允许 `consumedLayer=0`，其余仍需要完整生命周期场景测试 |

### 3.1 表格揭示出的真实规律

角色名词很多，但真正独立的运行时语义很少：

- 雷枪、水涡、结晶、熔火、追踪器都是有来源、层数、持续时间和退出原因的状态实例；
- 强化战技、三段战技、双形态都属于同一个形态选择与技能 overlay；
- 追加射击、结晶击碎、簇击、炸弹爆炸、幻影都是子 Hit/子动作；
- 完美接续、连携窗口、资源阈值都属于时间化 admission requisite；
- 冻结消费、结晶消费、熔火消费、水涡消费都属于带读数的状态消费事务；
- 冷却清零、减少固定值、按剩余比例减少都属于同一冷却事务的不同 operation。

只要 IR 与运行时能完整表达这些原语，角色差异就应留在数据图中，而不是进入核心分支。

## 4. 建议冻结的 12 类通用能力

| # | 通用能力 | 最小 IR | 必须输出的账本事实 |
| --- | --- | --- | --- |
| G1 | 事件订阅与过滤 | event type、source/owner/target、hit selector、ICD、once | 订阅注册、匹配/拒绝、触发 source event |
| G2 | 条件代数 | compare、and/or/not、状态/资源/冷却/标签/目标条件 | 每个条件的输入快照、结果与失败原因 |
| G3 | 状态生命周期 | apply、refresh、replace、independent、extend、pause、inherit、expire、consume | 前后层数、剩余时间、退出原因、来源/承载者 |
| G4 | 形态与技能 overlay | selector、priority、replacement、sub-action | 选择候选、命中条件、最终 resolved skill/form |
| G5 | 子动作与子 Hit | parent event、delay、hit profile、snapshot policy | parent/child ID、实际 commit、独立 damage report |
| G6 | DoT/周期调度 | interval、count/duration、refresh policy、snapshot | 每个 Tick 的时间、快照策略、取消/刷新原因 |
| G7 | 资源事务 | resource、delta/set、recipient、cap、cohort | before/delta/after、来源、同帧合并结果 |
| G8 | 冷却事务 | start/set/reduce flat/reduce percent/remaining/reset/pause | before/operation/after、作用技能、来源 |
| G9 | admission window | open/close、trigger event、consumer、consume policy | 开窗、过期、消费、非法释放原因 |
| G10 | 目标与作用域 | source/owner/carrier/target/team/teamExcludeSelf/controlled | 实际收件者集合与筛选理由 |
| G11 | 确定性随机 | choice set、weight、seed、roll identity | seed、候选、抽样值、选中分支，可重放 |
| G12 | patch/派生值 | patch target、operation、phase、read source | patch 前后值、读取快照、来源链 |

这些能力必须共享三条不变量：

1. 所有写操作都发生在明确事件相位：`admit -> start -> hit -> effect -> damage -> consume -> commit -> cleanup`；
2. 所有状态都有 `sourceActorId`、`ownerActorId`、`carrierId`、`targetId`，不得用一个模糊 `actorId` 代替；
3. 所有 UI 可见结果都来自账本，不允许组件根据 ID、中文名或前序按钮再次推演。

## 5. cleanroom 当前疏漏为何没有被测试发现

### 5.1 总覆盖率掩盖局部关键缺口

当前 `derived/cleanroom/ake-action-coverage.json` 的全库统计为：

- 3389 个 SkillData/BuffData 文件；
- 27129 次动作出现；
- 163 种动作类型；
- compiler complete 5229；
- metadata-only 11259；
- unresolved 10641。

其中 calculator core 的 executable route coverage 约为 88.5%。这个数字不能回答“汤汤战技附着是否正确”或“诀的双形态是否正确”，因为：

- 一个角色只要有一个关键 `InheritBuffAction` 未执行，就可能整套形态错误；
- 数百个镜头/曲线动作被标成 unresolved，不影响伤害却淹没真正 blocker；
- 测试若只断言“生成了 Hit”或“没有抛异常”，不会发现少施加一层状态；
- metadata 路由可以让编译流程完成，但不代表战斗语义完成。

### 5.2 `unresolved` 需要按影响重新分级

建议把当前单一状态拆为：

| 分类 | 例子 | 执行策略 |
| --- | --- | --- |
| `presentation-only` | 相机、特效、音效、朝向、表现曲线 | 记录 metadata，不阻塞战斗 |
| `spatial-assumption` | 位移、半径、锥角、目标搜索 | 在固定木桩假设下显式降级，并记录 assumption |
| `combat-supported` | 已完整编译和执行的伤害/Buff/资源动作 | 正常执行 |
| `combat-partial` | 只执行了动作一部分或缺 provider | 场景标记 unverified；禁止宣称正确 |
| `combat-blocking` | 会改变状态、形态、冷却、命中或伤害但无实现 | 对相应技能 fail closed |
| `evidence-missing` | 字段语义无法由 AKE 决定 | 建立 Calc 探针，不猜默认值 |

### 5.3 已定位的角色关键动作缺口

| 原始能力 | 代表角色 | 为什么是通用 P0/P1 |
| --- | --- | --- |
| `PauseBuffTime` | 莱万汀、洛茜、米芙 | 不支持会令形态/窗口提前过期或永久延长 |
| `ExtendBuffAction` | 庄方宜 | 刷新、延长和重施加如果混用会重复 proc |
| `InheritBuffAction` | 伊冯、黎诺等 | 子实体/形态无法继承来源状态，命中语义断裂 |
| `SetSkillCdAtOnce` | 管理员、狼卫、洛茜 | 冷却合法性与 UI 等待会偏离真实状态 |
| `VulnerableAction` | 安塔尔、艾尔黛拉、诀 | 敌方脆弱不进入统一伤害乘区 |
| `ForceSpellStatusAction` | 弧光、伊冯、阿列什、梨诺 | 元素状态分支可能完全不触发；零消费直接异常与按层消费不能混为普通附着 |
| `EventListenerAction` | 黎诺等 | 依赖事件的倒计时/姿态不会推进 |
| `RandomAction` | 洛茜、庄方宜 | 不做确定性抽样就不可复现；直接跳过则 Hit 数错误 |
| `SpawnAbilityEntity` / `CastSkill` | 雷枪、诀、庄方宜等 | 子实体命中、延迟和来源关系丢失 |
| `TogglableAction` / tag 操作 | 庄方宜、黎诺 | 形态开关与技能替换失真 |

### 5.4 已知噪声不能再占用同等优先级

`AddDynamicCcs`、表现曲线求值、移动/镜头/角度等大量动作对通用木桩伤害通常不是直接 blocker。它们应保留来源和 spatial assumption，但不能与改变 Buff 时间、状态消费、冷却或额外 Hit 的动作排在同一优先级。

## 6. 建议的 Normalized Mechanic IR

不建议继续让每种 AKE `$type` 直接穿透运行时。编译器应先收敛到稳定 IR：

```ts
type MechanicOperation =
  | StatusOperation
  | DamageOperation
  | ResourceOperation
  | CooldownOperation
  | FormOperation
  | WindowOperation
  | SubscriptionOperation
  | SpawnOperation
  | PatchOperation;

interface MechanicNode {
  id: string;
  sourceEvidence: {
    dataset: 'SkillData' | 'BuffData' | 'TableCfg';
    entityId: string;
    jsonPath: string;
    rawType: string;
  };
  phase: 'admission' | 'start' | 'hit' | 'effect' | 'damage' | 'commit' | 'cleanup';
  recipients: RecipientSelector;
  conditions: ConditionExpr[];
  operation: MechanicOperation;
  verification: 'verified' | 'assumed-spatial' | 'partial' | 'blocked';
}
```

### 6.1 状态事务必须显式表达退出原因

```ts
interface StatusOperation {
  kind: 'status';
  mode: 'apply' | 'refresh' | 'replace' | 'extend' | 'pause'
    | 'resume' | 'inherit' | 'consume' | 'expire' | 'remove';
  statusId: string;
  stacks?: ValueExpr;
  duration?: ValueExpr;
  stackPolicy?: 'replace' | 'refresh' | 'add' | 'independent';
  exitReason?: 'consumed' | 'expired' | 'dispelled' | 'replaced' | 'interrupted';
}
```

这能统一炸弹“过期爆炸”和“消费爆炸”、水涡消费、结晶击碎、熔火消费，而不需要每个状态写一个回调特例。

### 6.2 子 Hit 必须是独立事务

猛击异常伤害、结晶击碎、雷枪、幻影、追加射击和 DoT Tick 都不能塞进主 Hit 的一个标签中。每个子 Hit 至少携带：

- `eventId` 与 `parentEventId`；
- `sourceActorId`、`ownerActorId`、`targetId`；
- 实际 `scheduledFrame` 与 `commitFrame`；
- `damageKind`、倍率来源和状态快照策略；
- 触发它的状态消费/事件 ID。

这样 UI 才能显示“强化战技主 Hit + 猛击异常 Hit + 结晶击碎 Hit”三个独立结果，而不是一个总数。

### 6.3 冷却与资源应使用同帧 cohort

同帧多个技能/效果要先收集 delta，再整体校验和提交。冷却也必须提供统一 operation：

```text
start(duration)
set(absolute)
reduce(flat)
reduce(percentOfBase)
reduce(percentOfRemaining)
reset()
pause()/resume()
```

不能再让 `SetSkillCdAtOnce`、固定减冷却和庄方宜“按剩余冷却缩减”分别进入角色分支。

## 7. 运行时账本与 UI 契约

### 7.1 唯一事实账本

每次执行至少输出：

```text
COMMAND_ADMITTED / COMMAND_REJECTED
ACTION_STARTED / FORM_RESOLVED
WINDOW_OPENED / WINDOW_CONSUMED / WINDOW_EXPIRED
HIT_SCHEDULED / HIT_COMMITTED
STATUS_APPLIED / REFRESHED / EXTENDED / CONSUMED / EXPIRED
RESOURCE_CHANGED / COOLDOWN_CHANGED
DAMAGE_RESOLVED
ACTION_FINISHED / ACTION_INTERRUPTED
```

每条事件都包含 `frame`、`eventId`、因果父事件、来源证据和执行前后快照的必要字段。

### 7.2 水位轴只负责投影

共享变速轴继续保留：

- cohort 强边界；
- 每列统一时间斜率；
- 多角色并行水位；
- 光标、圆形技能按钮、真实 Hit 点；
- 等待列和技力水位。

但它只接受运行时事实：

| 轴上元素 | 唯一数据来源 |
| --- | --- |
| 技能左右光标 | `ACTION_STARTED/FINISHED` |
| 伤害菱形 | `HIT_COMMITTED + DAMAGE_RESOLVED` |
| 破防/元素 icon | 对应 frame 的 `STATUS_*` 读模型 |
| 技力水位 | `RESOURCE_CHANGED` |
| 强制等待 | runtime scheduler 的显式 wait command |
| 红色非法 | `COMMAND_REJECTED.reason` |

UI 不再根据技能名、前序按钮或固定木桩副本重建状态。

### 7.3 详情面板按 Hit 切片

点中某个 Hit 时，展示的“命中状态”应是：

1. Hit commit 前的有效状态；
2. 本 Hit 新施加/刷新/消费的状态；
3. 本 Hit 读取的伤害因子与来源；
4. 由本 Hit 派生的子 Hit；
5. commit 后状态。

它不是整条技能的 Buff 合集，也不是手动启停卡片的结果。

## 8. 测试体系：为什么以后不能再“同一套代码验证自己”

### 8.1 L0：AKE 证据闭包审计

对每名可用干员输出：

- 入口技能/天赋/潜能/装备引用；
- 递归 SkillData/BuffData 闭包；
- 每个原始动作的 JSON path；
- 战斗影响分类；
- 编译/运行支持状态；
- 缺失 provider、缺失依赖和证据未知项。

验收不是“全库覆盖 88%”，而是每个角色的关键路径不存在未声明 blocker。

### 8.2 L1：编译器契约测试

每种 AKE 原始能力用最小 fixture 验证：

- 输入字段如何进入 IR；
- condition 与 recipient 是否保真；
- 不支持字段是否 fail closed；
- presentation/spatial 是否只降级为明确 metadata/assumption。

### 8.3 L2：运行时状态转移测试

每个 G1–G12 原语独立验证：

- apply/refresh/consume/expire 各发生一次；
- source/owner/carrier/target 不串位；
- 同帧 cohort 原子提交；
- 子 Hit 因果链、快照和延迟正确；
- 非法命令不改变任何状态。

### 8.4 L3：跨角色变形测试

这是阻止角色特例回归的核心：

- 把状态 ID 从“结晶”替换为任意 ID，消费/击碎结果不变；
- 把施法者换成另一名干员，敌方脆弱仍被全队后续匹配 Hit 读取；
- 同一物理状态由陈千语、管理员或大潘触发，状态事务结构一致；
- 同一寒冷附着由汤汤或其他来源施加，层数规则取决于 AKE 数据而非角色名；
- 形态 selector 换一组属性阈值，运行时不需要新增分支。

### 8.5 L4：角色机制场景

每名干员至少有：

- 单技能最小场景；
- 关键状态产生—刷新—消费—过期场景；
- 与另一名干员共享敌方状态的交叉场景；
- 非法释放场景；
- 详情账本快照。

角色场景只验证数据组合，不允许在 fixture 外注入角色专有代码。

### 8.6 L5：Calc/外部 oracle 对拍

对不确定语义做单变量实验：

- 固定等级、装备、敌人和技能，只改变一项状态；
- 同时记录 Hit 数、时间、层数、持续时间、消费和最终伤害；
- 将原始观察保存在 fixture，测试读取 fixture，不在断言里重新执行同一算法。

### 8.7 L6：UI 只读投影测试

- 给定账本 fixture，主轴 icon、Hit、状态和详情固定；
- 删除 runtime report 时显示“未结算/不可验证”，不得回退出一套假伤害；
- 任意角色 ID 替换不改变通用事件的布局语义；
- 共享变速坐标只改变投影位置，不改变 frame、状态或伤害。

## 9. 实施顺序与独立提交边界

### 阶段 A：建立可审计地基

1. 新增逐干员机制闭包审计；
2. 将 unresolved 分成 presentation、spatial、partial、blocking、evidence-missing；
3. 生成机器可读报告，并给测试提供固定入口；
4. 禁止关键 blocker 被总覆盖率或 metadata 成功掩盖。

独立提交：`feat(audit): add per-operator AKE mechanism coverage`

### 阶段 B：状态生命周期通用化

按原始证据实现：

- inherit；
- extend；
- pause/resume；
- exit reason；
- independent/replace/refresh 的一致事务。

优先覆盖莱万汀、伊冯、洛茜、庄方宜，但实现与测试不得判断这些角色 ID。

### 阶段 C：易伤、脆弱、保护与伤害因子统一

- `VulnerableAction`（脆弱）、Defender `NormalCalcZone`（易伤）、`WeakAction`（虚弱）和 `ShelterAction` 分别进入独立状态与 damage factor；
- 全队后续 Hit 从敌人实时状态读取；
- 账本输出乘区名称、数学值、来源和适用过滤器；
- 删除 UI 中文名推断乘区。

### 阶段 D：冷却与资源事务

- 实现 set/reset/flat/percent-base/percent-remaining/pause；
- 同帧 cohort 一次结算；
- admission、等待与水位读取同一状态。

### 阶段 E：子实体、子动作、DoT 与确定性随机

- ability entity 与 `CastSkill` 统一为可调度 child action；
- 所有额外伤害独立成 Hit；
- DoT 支持快照/实时、刷新和取消；
- `RandomAction` 使用场景 seed，账本可重放。

### 阶段 F：形态与事件监听

- 统一 tag、toggle、selector、skill replacement；
- 统一 battle start、action link、final hit、during action 等订阅；
- 删除已知角色 ID 运行时特例。

### 阶段 G：UI 收口

- 主轴只保留关键敌方状态 icon；
- 详情按 Hit 展示状态前后与伤害来源；
- 未验证/阻塞/空间假设明确显示；
- 移除 fixed dummy 参与真实伤害与合法性的路径；
- 保留共享变速水位轴全部交互特色。

## 10. 每阶段验收门槛

每次提交必须满足：

1. 新增能力有 AKE 原始 fixture 或明确的 evidence-missing 标记；
2. 核心实现中没有新 `characterId/operatorId/skillId` 专有分支；
3. 至少一个通用原语测试和两个不同角色的组合测试；
4. 非法/不支持语义 fail closed，不产出伪伤害；
5. 账本能解释状态前后、来源、时间和派生 Hit；
6. UI 不新增第二份状态推演；
7. 共享变速水位轴的坐标契约测试继续通过；
8. 全量测试、严格类型检查与 demo build 通过；
9. 研究、审计工具、每类引擎能力、UI 收口分别独立提交，便于回退和复核。

## 11. 第一批落地任务

本文之后立即执行：

1. 实现 `audit:ake-operator-mechanisms`，输出逐干员、逐文件、逐 JSON path 的战斗影响报告；
2. 将动作分级规则做成代码与测试，而不是写死在本文；
3. 用报告选择第一批共性最高且会改变战斗结果的能力；
4. 第一批优先实现状态持续时间事务和冷却事务中的一个完整垂直切片；
5. 从 AKE fixture 到 runtime ledger 再到 UI read model 建立端到端回归；
6. 每一步独立提交，并在提交说明中列出仍未验证的机制，不再用“全测试通过”等同“全干员正确”。

最终目标不是做出一张看起来像 Calc 或 Endaxis 的轴，而是让任意新 AKE 干员在不新增核心特例的前提下，通过原始数据闭包自动获得：正确形态、正确状态、正确 Hit、正确伤害、正确合法性和可解释的前端展示。

## 12. 2026-08-27 第一轮落地记录

本轮严格按“原始数据证据 → 通用编译原语 → runtime 事务 → 账本/UI 投影 → 逐干员审计”推进，没有修改共享变速水位轴的布局或坐标模型：

1. 已建立 31 名具体干员的逐路径机制审计；当前报告共 3088 条 finding，其中 349 条 combat-blocking、160 条 combat-partial、422 条 evidence-missing、1767 条 spatial-assumption、390 条 presentation-only；
2. `PauseBuffTime` 已进入统一 Buff 生命周期，暂停时同时冻结到期、周期触发和 Buff 时间线，恢复后从剩余本地时间继续；
3. Blackboard 动态子 Buff、fallback dependency 与 `asChildBuff` 父子所有权已统一，父实例结束只级联回滚自己的子实例；
4. `VulnerableAction` 已映射为 AKE 的“脆弱”，Defender `NormalCalcZone` 保留为“易伤”，两者进入独立公式区；
5. `WeakAction` 的五份公开数据已全部走公共 `buff_common_affixes_weak`：正数减伤幅度转换为有符号 `FinalMultiplier`，并从伤害来源实体读取，因此只降低携带者造成的伤害；父 Buff 结束后自动回滚；
6. `ShelterAction` 的七份公开数据已全部走公共 `buff_common_affixes_shelter`，从受击者实时读取 `ShelterDmgScalar`，只降低携带者承受的伤害，并随父 Buff 精确回滚；
7. `ExtendBuffAction` 的六处公开机制已实现为引用计数的“到期计时租约”：只延后 Buff 到期，不冻结周期动作或内部时间线；重叠技能分别持有/释放租约，并在首次触发时激活 `tagsAfterTriggerExtendBuffAction`；
8. `InheritBuffAction` 的 52 处公开动作已进入统一的技能动作所有权租约：`CreateBuffAction` 创建租约，后续白名单技能接管同一个 Buff 实例并重写下一跳，旧动作的迟到 cleanup 因租约不匹配而无权误删；未接管或进入非白名单技能时 fail closed；BuffData 内原有父子 cleanup 不受影响；
9. `FinishBuffAdvanced` 的 `Environment` 选择器已从 354 处全库 BuffData 反证为“当前回调 Buff 实例”，不再误判为外部 provider；运行时按 `buffInstanceId` 精确结束，忽略该模式下残留的编辑器 ID，避免误删同 ID 并发实例或错误目标 Buff；逐干员报告中的九处相关 blocker 已消除；
10. `ForceSpellStatusAction` 的七处公开动作已编译为统一 `ForceEnemySpellStatus` 事务：`consumedType` 使用公共元素枚举（`0=Fire`、`1=Pulse`、`2=Cryst`、`3=Natural`），`spellStatusType` 选择燃烧/导电/冻结/腐蚀入口，`consumedLayer` 精确消费旧附着层；梨诺的零层消费因此可以直接制造导电，伊冯、弧光、阿列什则沿同一事务按层消费；
11. 强制异常事务在修改状态前校验数值范围、Buff 映射、依赖定义和可消费层数；不足时 fail closed，不先删附着。消费账本保留每层来源，异常 Buff 继承当前技能来源，命中详情从同一个编译动作投影状态，不建立 UI 私有推演；
12. `VulnerableAction`、`WeakAction`、`ShelterAction`、`ExtendBuffAction`、`InheritBuffAction`、`ForceSpellStatusAction` 与逐干员可达的 `FinishBuffAdvanced` 已不再出现在 unresolved source type 中；本轮新增能力没有角色 ID、技能 ID 或队伍模板分支；
13. 全量 BuffData 中 46 处 `OnSpellAbnormalStartFinish` 声明（42 处启用、4 处原始数据明确禁用）只有一种稳定结构：`OnBuffStart/isStart=true` 与 `OnBuffFinish/isStart=false` 成对出现，覆盖 Fire、Pulse、Cryst、Natural 与 Burst。启用动作现已编译为 `SpellAbnormalStarted/Finished` 统一账本事件，保留 source/owner/target/Buff instance 归因；禁用动作继续不执行；实际 Buff 实例仍是唯一状态事实，没有再造一套平行元素状态机；
14. 核心测试、相关前端契约、TypeScript 严格检查和 AKE demo 构建继续作为提交门禁。

349 条 blocker 明确说明当前结果只是第一轮可审计收敛，不代表全干员机制已经闭包。全库仍有一个启用的训练动作被序列化在 `IfElse.conditionAction` 的条件之后，当前继续以 condition/action sequencing gap 明示，不能冒充已执行。`ForceSpellStatusAction` 与异常生命周期通知已闭合，但普通元素反应链仍受动态 `ReadSkillSettingData` 表值阻塞，不能把强制异常通过等同于四元素系统全部完成。下一阶段先闭合四级异常数值表与术式强度修正，再进入事件订阅和派生命中闭包。“按护盾值派生额外伤害”仍属于独立的命中快照问题，不能因为 `ShelterAction` 已执行就宣称完成。
