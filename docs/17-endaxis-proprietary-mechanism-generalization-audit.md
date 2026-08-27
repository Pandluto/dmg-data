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
| Snowshine / `chr_0014_aurora` | 元素附着与保护 | 附着、`Shelter`/伤害减免状态 | `ShelterAction` 已闭合；Buff 生命周期内的 `AddTagAction` 仍需绑定准确 owner lifetime |
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
| Liino / `chr_0035_liino` | 战斗开始状态、技能冷却、受控目标、倒计时伤害/治疗、姿态、零消费强制导电 | `onBattleStart`、冷却就绪、controlled target、事件监听、继承 Buff、非技能动作、强制元素状态 | 技能时间窗 `AddTagAction` 已闭合；Buff/Event tag lifetime、`EventListenerAction`、`ChannelingCasting` 仍需完整生命周期场景测试；强制导电允许 `consumedLayer=0` |

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

1. 已建立 31 名具体干员的逐路径机制审计；当前报告共 3048 条 finding，其中 304 条 combat-blocking、161 条 combat-partial、422 条 evidence-missing、1771 条 spatial-assumption、390 条 presentation-only；
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
14. 普通元素链的 21 处 `ReadSkillSettingData` 动作、47 个字段读取已收敛到 10 张公共表：反应初始伤害、法术爆发、燃烧 Tick、导电数值/持续时间、冻结持续时间、腐蚀初始/每跳/上限/持续时间。动态列优先读取整表，不再被第一列常量短路；异常伤害与异常状态分别使用独立的源石技艺强度公式；
15. 真实 Buff 图的四元素矩阵已经验证：同元素爆发均以 1.6 倍率延迟结算；二层跨元素初始 Hit 均以 2.4 倍率结算；导电只进入四种法术伤害的敌方 `NormalCalcZone`，冻结按 7 秒到期，燃烧以 0.36 倍率周期结算，腐蚀从 -0.048 全抗开始、每秒追加 -0.0112、由 `RefreshBuffAttrModifierValue` 实时刷新并在 15 秒结束后完整回滚；
16. 共享依赖审计因此再消除 40 条元素 `ReadSkillSettingData` 缺口：shared finding 从 241 降至 201，shared evidence-missing 从 85 降至 45；完成元素链时逐干员主报告仍有 349 条 combat-blocking，不能用元素链通过掩盖其他机制；
17. SkillData 中 16 处 `AddTagAction`（15 处启用、1 处原始数据禁用）均位于明确的 timeline group 内，覆盖 12 份技能文件和 22 个静态 tag。启用动作现按 group 起始帧建立 `SkillActionTag` effect source、按结束帧释放；source key 绑定 cast，正常结束、提前结束和 program cancel 都按 cast 回收，底层 tag 引用计数保证重叠释放与 Buff 自带同名 tag 不会互相误删。逐干员报告因此消除 14 条战斗阻塞，当前降为 335 条；剩余 4 条均来自 BuffData，而不是角色技能时间窗；
18. 全库动作审计现在保留数据集作用域：SkillData 以 `skill` 生命周期编译，BuffData 以 `buff` 生命周期编译，不再用脱离上下文的 standalone 结果误判生命周期动作。31 处 BuffData `AddTagAction` 仍明确报告 `AKE_TAG_ACTION_LIFETIME_REQUIRED`，等待 Buff/Event listener owner lifetime 证据，未借技能组结束语义错误清理；
19. SkillData 的 `EventListenerAction` 已进入独立的施放级订阅注册表：订阅以 timeline group 为窗口、以 cast/path 为身份，保留施法 source/owner/target 与自己的 Blackboard；事件中的实际 source/owner/target 另存为 event attribution，因而子动作的 `Target` 可以解析到真实事件目标。正常 group cleanup、时间轴跳出窗口、program cancel 与技能提前结束均主动注销；
20. 现有 BuffData ability listener 与技能时间窗 listener 已共用同一个 runtime ability-event 入口，但仍保留不同 owner lifetime。17 处 SkillData 声明中已有 16 处能注册；陈千语监听内的 `SetSkillCdAtOnce` 已进入公共冷却事务，当前只剩狼卫的一处空 `FinishBuffAdvanced` 选择器继续 fail closed；订阅基础设施提交时，缺少生产者的事件仍报告 `AKE_ABILITY_EVENT_EMITTER_REQUIRED`，没有拿“订阅已注册”冒充“事件可触发”；
21. SkillData listener 使用的八类事件现在都有公共生产者：已有的受伤前、Buff 加入后、Buff 输出，加上物理状态事务提交前的 `OnBeforeOutputAirborne`、Buff apply 前的 `OnBeforeAddedBuff`、生命值由正数降为零时的 `OnAfterKillEntity`、每个 cast 恰好一次且发生在订阅清理前的 `OnSkillEnd`、场景空闲退出事务发出的 `OnTrulyExitFight`。直接 Damage 与 ResolveDamagePacket 的击杀都走同一生命值边界；Aura Buff 也补齐加入前事件；逐干员 blocker 因此由 330 降至 323；
22. BuffData 的三处 `EventListenerAction` 现以精确 `buffInstanceId` 拥有订阅：并发同名 Buff 不共享 listener id，回调 Blackboard 写回监听者 Buff 实例，`OnFinishedBuff` 从统一状态结束事务广播，owner Buff 结束后无论正常 cleanup 是否存在都会注销自己的订阅。伊冯击杀恢复标记因此不再是静态 metadata，逐干员 blocker 降至 322；两个训练监听的表现 signal 仍按 presentation-only 处理；
23. 核心测试、相关前端契约、TypeScript 严格检查和 AKE demo 构建继续作为提交门禁；
24. 全库 40 处 `SetSkillCdAtOnce` 已收敛为一个角色无关的 `ModifySkillCooldown` 事务，覆盖 Set/Reduce、固定秒数/基础冷却比例、指定 skill id/skill type 四个维度。冷却事实从单人和小队 runner 的局部 Map 提升到共享 `SkillCooldownSystem`，按“角色 × 公共技能组”拥有状态；强化/替换 skill id 因此与原按钮共用冷却。连携触发、command admission、最终状态和 UI cooldown interval 读取同一 end frame；陈千语 `OnBeforeOutputAirborne` 的比例减冷却现可在事件帧修改正在运行的连携冷却。逐干员 blocker 由 322 降至 304，报告中不再存在 `SetSkillCdAtOnce` finding。
25. 全库成对出现的 14 处 `CheckGlobalCDTimerAction` 与 14 处 `AddGlobalCDTimer` 已收敛到公共 timed-marker 事务：键为“目标实体 × 原始 buffId 桶”，结束帧使用全局战斗时间，Blackboard/固定秒数统一解析；逐干员 blocker 由 304 降至 298。动作覆盖审计现区分 runtime action 与 runtime condition，避免把可执行的条件节点继续误报为 `AKE_ACTION_UNSUPPORTED`。
26. 唯一一处 `PauseComboSkillTime` 已按 AKE 原始生命周期收敛为连携待释放时间的暂停租约：租约以角色/全体范围、timeline path 与 cast 标识，不消耗暂停期间的剩余 Tick；正常组结束释放，技能中断或 program cancel 也按 cast 兜底释放。逐干员 blocker 由 298 降至 297，`cooldown-window` 类 finding 已清零。
27. 连携规则目录 schema v5 现保留 `eventTypes` 与递归 `conditions`，核心和实时画布使用同一份 normalized rule。洛茜“破防与任一元素附着同时存在”的两种状态到达顺序均由公共 `BuffStackCompare` 条件开窗；条件缺失、类型未知或目标作用域无法解析时 fail closed。前端目录缓存升至 v23，避免旧浏览器把复合规则降格成无条件触发。

297 条 blocker 明确说明当前结果只是第一轮可审计收敛，不代表全干员机制已经闭包。全库仍有一个启用的训练动作被序列化在 `IfElse.conditionAction` 的条件之后，当前继续以 condition/action sequencing gap 明示，不能冒充已执行。强制异常、异常生命周期、同元素爆发、普通四元素反应、技能时间窗 tag、技能/Buff 事件订阅生命周期、对应事件生产者、技能组冷却、internal cooldown 与连携窗口暂停的公共数据链已经闭合；狼卫空 selector 等子动作仍未闭合。未见于当前 AKE 动作的 remaining-basis 冷却操作不得借已实现的 base-basis 百分比猜补。仍未证实的 `弭弗特殊猛击` 数值继续保持 evidence-missing，而不是借元素表猜值。“按护盾值派生额外伤害”仍属于独立的命中快照问题，不能因为 `ShelterAction` 已执行就宣称完成。

### 12.1 普通元素链的证据矩阵

| 公共读取 | 1～4 级基础值 | 强度规则 | 运行时验收 |
| --- | --- | --- | --- |
| 异常初始伤害倍率 | 1.6 / 2.4 / 3.2 / 4.0 | 异常伤害 | 四种跨元素初始 Hit 独立结算 |
| 法术爆发伤害倍率 | 1.6（各级相同） | 异常伤害 | Fire/Pulse/Cryst/Natural 共用延迟爆发路径 |
| 燃烧每跳伤害 | 0.24 / 0.36 / 0.48 / 0.60 | 异常伤害 | 二级燃烧每秒按 0.36 结算 |
| 导电法术伤害提高 | 0.12 / 0.16 / 0.20 / 0.24 | 异常状态 | 四种法术伤害生效，物理不生效 |
| 导电持续时间 | 12 / 18 / 24 / 30 秒 | 不增强 | 二级状态 18 秒到期 |
| 冰冻持续时间 | 6 / 7 / 8 / 9 秒 | 不增强 | 二级状态在第 210 本地 Tick 边界结束 |
| 腐蚀初始减抗 | -0.036 / -0.048 / -0.060 / -0.072 | 异常状态 | 同一敌人的五种抗性同步改变 |
| 腐蚀每跳减抗 | -0.0084 / -0.0112 / -0.0140 / -0.0168 | 异常状态 | 周期 Blackboard 与 effect source 同步刷新 |
| 腐蚀减抗上限 | -0.12 / -0.16 / -0.20 / -0.24 | 异常状态 | 公共条件/Blackboard 限幅，不写角色分支 |
| 腐蚀持续时间 | 15 秒 | 不增强 | 到期移除同一 source，五抗精确回滚 |

这里的“异常伤害”按角色等级系数与 `1 + strength / 100` 结算；“异常状态”按 `1 + 2 × strength / (strength + 300)` 结算。两者不能混用，也不能由 UI 重新计算。默认情况下，`ForceSpellStatusAction` 只进入异常状态，不补发跨元素初始 Hit；这与普通反应路径继续保持隔离。

### 12.2 技能临时标签的生命周期证据

| 证据面 | 观察 | 冻结的通用语义 |
| --- | --- | --- |
| SkillData 形状 | 16 处声明全部在 timeline group；15 处启用；均为静态 tag | 起始帧 apply、结束帧 release，不需要角色 ID |
| 目标选择 | `tagOwner.targetSource` 只使用 Source/Owner | 继续走公共 entity ref，不把 tag 挂到 UI 当前选中角色 |
| 同名 tag | 技能 tag 与 Buff `applyTags` 可使用同一 tag id | 使用 effect-source 引用计数，任一来源结束不得删除其他来源 |
| 并发施放 | 同一技能可在前一次窗口结束前再次进入 | source key 必须绑定 cast，而不是只绑定 skill/path |
| 中断/取消 | program cancel 会取消尚未到达的 group cleanup | cast 结束路径主动释放 `SkillActionTag` source，不能等待原计时器 |
| BuffData 形状 | 31 处声明分布在 Buff lifecycle、Buff timeline 和 ability event | 在 owner lifetime 未统一前保持 unresolved，禁止套用 SkillData group end |

这一步只关闭了“技能时间组拥有的临时标签”。它没有声称 BuffData 的 tag 都应随 Buff 结束，也没有把 `EventListenerAction` 当成简单 tag 开关。后者的 `abilityActionMap` 携带条件树、冷却修改、Buff 创建/结束、跳转等子动作，必须先建立订阅注册、事件匹配和注销边界，再接入现有 ability-event 总线。

### 12.3 `abilityActionMap` 的原始证据与通用订阅边界

全库共有 20 处 `EventListenerAction`，每一处都使用同一种 `abilityActionMap[] -> actions[].actionData[]` 结构，而不是某个干员专用格式。17 处位于 SkillData 的明确 timeline group，3 处位于 BuffData：

| 数据域 | 事件 | 声明数 | 当前通用边界 |
| --- | --- | ---: | --- |
| SkillData | `OnBeforeTakeDamage` | 3 | 已有伤害前事件生产者，技能窗口内可执行条件与子动作 |
| SkillData | `OnAddedBuff` | 7 | 已有 Buff 成功施加后的生产者，保留事件 Buff 与事件目标 |
| SkillData | `OnOutputBuff` | 1 | 已有输出 Buff 生产者；汤汤可在监听内按状态条件跳转原技能时间轴 |
| SkillData | `OnBeforeOutputAirborne` | 1 | 公共物理状态事务在击飞尝试提交前发出；事件目标为被击飞单位 |
| SkillData | `OnAfterKillEntity` | 3 | ResolveDamagePacket 与直接 Damage 均只在 HP 首次由正数降为零时发出，并携带原 Hit mask |
| SkillData | `OnSkillEnd` | 1 | 每个 cast 去重一次，在技能订阅、tag 和动作租约清理前发出 |
| SkillData | `OnBeforeAddedBuff` | 1 | 普通 ApplyBuff 与 Aura apply 都在 `StatusEffectSystem.apply` 前发出 |
| SkillData | `OnTrulyExitFight` | 2 | 单人/小队 runner 均从空闲退出事务发出，不依赖 UI 卸载 |
| BuffData | `OnAfterKillEntity` / `OnAddedBuff` / `OnFinishedBuff` | 各 1 | 以 `buffInstanceId` 拥有订阅和 Blackboard；状态结束事务发出 finished event 并精确注销 owner listener |

订阅事务冻结以下身份语义：

1. `listenerTargetId` 决定哪一个实体的事件可以命中订阅，不允许四人共享敌人时用“当前 UI 角色”替代；
2. 子动作的 `ActionSource`、`ActionOwner` 和默认动作目标来自注册时的技能上下文；传入事件的 source/owner/target 通过 `eventSourceId`、`eventOwnerId`、`eventTargetId` 保留；
3. 在 ability callback 中，AKE selector 的 `Target` 解析为 `eventTargetId`，因此“监听自己的输出、给命中的敌人挂 Buff”不会错误挂回施法者；
4. listener Blackboard 的同名键优先于无关事件携带的临时 Blackboard，并在多次命中间持续；
5. timeline end 为右开边界；跳帧到窗口外必须立即注销，不能等待已经被取消的 cleanup timer；
6. 订阅 ID 必须包含 cast，重叠施放不能互相覆盖或提前清理。

Endaxis 的 `src/simulation/engine/TriggerRegistry.ts` 证明“集中事件注册表 + 明确事件处理器”比把触发逻辑分散到每名角色更稳定，但它的 `onFinalStrike`、`onActionStart`、`onBattleStart` 等 trigger vocabulary 是其手写模型。这里借用的是架构分层，不复制它的角色规则：事件名称、子动作、时间窗和条件仍全部来自 AKE 原始 `abilityActionMap`，缺生产者时由审计阻塞，不从 Endaxis 猜补数据。

### 12.4 `SetSkillCdAtOnce` 的原始矩阵与共享冷却事实

全库 40 处动作使用完全相同的 12 字段结构，分布为 SkillData 9 处、BuffData 31 处。没有任何一个字段需要角色 ID 才能解释：

| operation | 数值模式 | 选择器 | 数量 | 冻结语义 |
| --- | --- | --- | ---: | --- |
| Reduce | percentage | skill type | 2 | `baseCooldown × ratio`，再按当前剩余值截断 |
| Reduce | percentage | skill id | 2 | 同上，但先把 skill id 解析到其公共技能组 |
| Reduce | fixed | skill id | 6 | 按秒转 Tick，从当前 end frame 扣除并截断到事件帧 |
| Set | percentage | skill id | 6 | 把剩余冷却设为 `baseCooldown × ratio` |
| Set | fixed | skill type | 4 | 把该类型技能组的剩余冷却设为指定秒数 |
| Set | fixed | skill id | 20 | 把 skill id 所属技能组的剩余冷却设为指定秒数 |

这组语义由三类证据交叉约束：AKE 原始 `functionType/isPercentage/useSkillType` 字段；大潘 `cd_reduce=0.5` 与中文说明“恢复 50% 冷却时间”；梨诺 `set_cd=3` 与技能结束后的 3 秒战技冷却。Endaxis 的 `applyCooldownReduction` 也将默认百分比基准放在基础冷却上，但它把连携与其他技能拆成两条手写路径，只能作为语义旁证，不能直接复制为本项目结构。

运行时冻结以下边界：

1. 状态键是 `actorId + cooldownGroupId`，不是 UI 当前按钮或单个形态 skill id；同一技能组的普通/强化/替换形态读写同一 end frame；
2. catalog 由 AKE `skillGroupMap` 与 `skillSpecification` 生成；未出现在主 skillIdList、但属于同角色同 specification 的 child/alternate SkillData 仍回到公共组；
3. 百分比值使用 AKE 的 0～1 ratio，不把 0.5 二次解释成 0.5%；固定值统一按秒乘 tickRate；
4. Reduce 只修改活动冷却；无活动冷却时明确 ignored。Set 可以从 ready 状态建立冷却，也可以清零或延长现有冷却；
5. 每次修改记录 before/end、base、requested、actual、discarded 与 percentage basis；清零时多余减量进入 discarded，不产生负冷却；
6. runner 的连携窗口创建、技能释放合法性、最终状态和 cooldown interval 全部读取该状态机，避免“计算已经减 CD、按钮仍显示旧 CD”或反向情况；
7. 多角色以 actorId 隔离；相同 skill id 不会跨角色串冷却。

这个切片只定义 AKE `SetSkillCdAtOnce` 已出现的语义；`GlobalCDTimer` 与 `PauseComboSkillTime` 随后分别在 12.6、12.7 按自己的原始字段和生命周期实现，没有塞进技能冷却事务。确有原始证据时的 remaining-basis 百分比仍应作为独立 operation 增量实现，不能从 base-basis 猜补。

### 12.5 实时画布的共享冷却投影

核心状态机完成后，实时画布仍曾保留一份旧 `Map<skillId, endFrame>`。这不是样式问题，而是第二份相互矛盾的合法性模型：基础技能开始冷却后，强化或替换 SkillData 会因 id 不同而绕过冷却；连携窗口在触发帧也只检查规则中那个具体 id，无法看见同组其他形态已经启动的冷却。

时序目录 schema v4 现在把 assembler 从 AKE `skillGroupMap + skillSpecification` 归一得到的 `cooldownGroupId/cooldownSkillType` 写入每个 profile。实时画布只用 `cooldownGroupId` 建立、读取和检查冷却；连携触发检查也先把 `comboSkillId` 解析回同一个组。目录适配器版本升至 v22，强制已有浏览器丢弃缺少共享组的旧缓存。回归测试以不包含角色特例的“基础形态施放后切到强化形态”验证：形态解析仍选中强化 SkillData，但释放被同组 end frame 拒绝。

这一步没有改变共享变速水位轴的列宽、投影斜率、关系求解或节点布局。当前前端离线预演只闭合“冷却开始与同组合法性”；技能中途发生的 `SetSkillCdAtOnce` 动态修改仍以服务端 runtime ledger 为最终事实，不能把默认配装的隔离探针结果静态烘焙成所有配装都适用的 UI 事件。后续应将 runtime 冷却 mutation ledger 直接投影给画布，或让预演执行同一 normalized operation，而不是再维护一套简化公式。

全量重建同时暴露了旧生成物掩盖的逐 Hit 回归：大潘终结技现在保留 43～50 帧的八次前置伤害与 81 帧结算，AKE 原始 `KnockDownAction` 位于 80 帧动作组，因此倒地只属于 81 帧 Hit。契约测试已从“首个 Hit 有倒地”改为断言“只有 81 帧 Hit 有倒地”，避免多段技能恢复真实命中后把状态错误复制到开头或全部 Hit。

### 12.6 `GlobalCDTimer` 的实体内触发冷却

这里的 “Global CD” 不是战技/连携/终结技的技能组冷却，而是天赋、武器和套装 proc 的 internal cooldown。原始数据闭包共有 14 对检查/启动动作：SkillData 8 对、BuffData 6 对；目标为 Owner 6 处、Source 8 处；12 处从 Blackboard 的 `talent_shield_cd`、`cd` 或 `duration` 读取秒数，另外 2 处使用固定 0.1 秒。每一对都用同一个 `buffId` 作为桶名，检查位于效果分支之前，启动位于成功动作之后。

据此冻结以下通用语义：

1. `CheckGlobalCDTimerAction` 在“目标实体 × buffId 桶”不存在或已经到期时为真；不能只按 buffId 做全队共享锁；
2. `AddGlobalCDTimer` 从当前事件帧开始或刷新该桶，持续时间按秒乘 tickRate；0 秒不阻塞同帧后续检查；
3. 到期边界为右开区间：`frame < endFrame` 仍冷却，`frame === endFrame` 已可触发；
4. 该计时器使用全局战斗时间，不随角色局部时停/变速拉长；它与 `SkillCooldownSystem` 分离，不能出现在技能按钮冷却条上；
5. 编译器用 `ake-global-cd:<buffId>` 命名空间复用 `CreateTimedMarker/TimedMarkerExists`，因此继续使用已有状态账本和快照，不建立角色专用 Map；
6. 实际 fixture 同时覆盖弭弗技能内护盾门与物理套装触发门，并验证角色隔离、Blackboard 秒数和严格到期边界。

Endaxis 的 `internalCooldown/sharedIcdKey` 说明成熟模拟器同样需要把 proc 冷却从技能冷却中分离，但其桶名和触发配置来自手填数据。本项目只借鉴这种分层，桶身份、目标和持续时间仍全部来自 AKE 原始动作；没有把 Endaxis 的专有规则复制进运行时。

### 12.7 `PauseComboSkillTime` 的动作生命周期租约

公开 AKE 数据中只有一处 `PauseComboSkillTime`，位于洛茜（`chr_0028_wulfa`）重击的 0～65 帧 timeline group。单看动作名不足以决定它是“暂停技能 CD”“暂停角色本地时钟”还是“暂停待释放连携”，因此实现前额外交叉检查了同一动作组和三份 BuffData：

| 证据 | 原始行为 | 对通用语义的约束 |
| --- | --- | --- |
| 重击动作组 | 先检查 `buff_chr_0028_wulfa_combo_2_qte_timerlistening`，再执行 `PauseComboSkillTime(isAll=false, Owner)` | 只在二段连携监听存在时暂停 Owner 的待释放连携时间，不是技能组 CD |
| 同组 resume Buff | 创建 `buff_chr_0028_wulfa_powerattack_resumecombo`，且 `autoFinishByAction=true` | 暂停边界由当前动作生命周期拥有，不能永久写入角色状态 |
| listening Buff | `OnBeforeCastSkill(power_attack)` 执行 `PauseBuffTime(true)`；resume Buff 结束后执行 `PauseBuffTime(false)` | 连携监听 Buff 的剩余时间与 pending window 必须在同一重击区间一起冻结/恢复 |
| use-timer Buff | 使用相同的 pause/resume 事件对，并在结束时恢复二段连携技能与冷却 | pending window 与 AKE 的二段连携可用计时是同一个生命周期问题 |
| Endaxis 洛茜实现 | 源码明确保留“二段连携窗口对应关系” TODO | 只能作为未闭合反证，不能复制它的手写窗口规则冒充 AKE 语义 |

据此冻结以下运行时边界：

1. 暂停对象是 `ComboTriggerMachine` 中的 pending entries；普通技能冷却、internal cooldown、角色局部时钟和敌方状态时间均不受影响；
2. 每个 pause 使用独立 lease，身份由 timeline path 与 cast 组成；重叠动作必须全部释放后时间才继续；
3. `isAll=false` 只匹配目标角色；状态机也保留 `isAll=true` 的全体范围语义，但当前数据集没有以它扩展角色规则；
4. 暂停期间新创建且属于该范围的 pending 同样立即冻结，防止依赖同帧执行顺序产生不同结果；
5. 恢复时只把实际冻结的 wall Tick 加回原到期帧；到期继续使用右开边界，不能多送或少送一帧；
6. timeline group cleanup 正常释放 lease；技能中断、动作提前结束和 program cancel 另按 cast 释放，避免 cleanup timer 被取消后窗口永久冻结；
7. trace 明确输出 `PENDING_TIME_PAUSED` / `PENDING_TIME_RESUMED`、lease 与剩余帧，UI 只能投影这一事实，不能按按钮宽度猜持续时间。

原语回归使用任意 owner/skill 的数据驱动规则验证暂停与严格到期边界；真实回归直接读取洛茜原始 `PauseComboSkillTime` 结构，验证编译出的 start/cleanup 租约以及中断兜底。核心实现没有判断洛茜、重击或二段连携 ID。

### 12.8 连携触发条件不在 SkillData 动作树中的证据断层

逐个对照 31 个可用角色条目后，可以确认 AKE 的连携机制分成两个数据面，而不是一棵可以从 SkillData 独立闭包的动作树：

| 数据面 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| `CharGrowthTable.skillGroupMap` 与中文文本 | 每名干员的开窗条件、公开技能形态和描述中的状态阈值 | 条件使用的内部事件枚举、窗口精确边界、同帧优先级 |
| `SkillData` / `BuffData` | 开窗后的伤害、Buff、换段、QTE、暂停、清理和冷却事务 | 大多数干员“何时创建初始 pending”的全局注册表 |
| Calc 黑盒边界 | 实际 pending 起止、同帧释放、刷新/替换和冷却抑制 | 未探测角色的内部实现 |
| Endaxis `comboWindow` | 一套成熟项目手填了哪些触发维度 | AKE 权威事件名、数值和窗口边界 |

AKE 文本中的触发条件可以归并为少量公共事件，而不是 31 种角色引擎：

| 公共事件族 | AKE 代表 | 需要的通用条件 |
| --- | --- | --- |
| 重击/处决提交 | 佩丽卡、艾维文娜、黎风、伊冯、艾尔黛拉、庄方宜 | 命中角色、目标状态、末段/处决标签 |
| 敌方状态施加或达到层数 | 陈千语、秋栗、狼卫、安塔尔、汤汤、洁尔佩塔、莱万汀、别礼、大潘、弭弗、洛茜、诀 | 状态族、层数比较、目标同时持有的其他状态 |
| 敌方状态消费 | 边境、弧光、阿列什、卡米尔、梨诺 | 被消费状态族、消费量、姿态条件 |
| 其他干员技能命中 | 管理员 | 技能类型、施法者不等于 pending owner |
| 主控受击/生命阈值 | 艾米尔、昼雪、别礼 | 受击事件、受击后 HP、敌方蓄力事件 |
| 自身资源/实体生命周期 | 赛希 | 支援实体次数耗尽或状态消费 |
| 属性形态 | 诀 | 同一状态事件在不同 form 下使用不同阈值与冷却组 |

因此，“纯通用”不能解释成“完全不要逐角色规则数据”。正确边界是：事件生产者、条件代数、pending 生命周期、冷却、选择与消费策略只实现一次；每名干员只提供声明式规则和证据。运行时出现 `if (characterId === ...)` 是错误，但规则的 `ownerId`、状态 ID 和技能 ID 本来就是合法数据。

本轮实现前，`spec/engine-semantic-mappings.json` 只有佩丽卡、陈千语和男女管理员共 4 条 `ComboTriggerRule`。这解释了为什么已有状态事务本身可能正确，画布仍会把大量连携判为“没有合法释放空间”：不是水位投影错误，而是 pending 从未被创建。测试只覆盖这 4 条规则时全部通过，也不能证明其他干员正确。

下一步冻结以下实现纪律：

1. `ComboTriggerRule` 复用公共条件代数，至少支持目标 Buff 层数、任一/全部状态族、否定、HP、技能类型和 source/owner 身份比较；
2. 条件在事件提交后的同一运行时快照上求值，不能由 UI 根据图标或中文名推测；
3. 每条角色规则必须记录 E1 文本、可用的 E1 原始状态 ID 和 E2 边界探针；缺 E2 时标为 `public-data-derived`，不得写成 confirmed；
4. 核心 runner 与实时画布消费同一 normalized rule；前端不能另建简化的角色触发表；
5. `TriggerComboSkillAction`、`ChangeSkillAction` 和 `ShowComboRingQte` 分别表示开窗后的动作触发、技能槽 overlay 与精准时机提示，不能看到 “Combo” 字样就全部编译成 `CreateComboPending`。

### 12.9 洛茜两段连携的原始链路

洛茜是上述分层的最小压力测试。三路证据给出的链路如下：

```text
敌人首次满足：破防 AND 任一四元素附着
  -> 创建洛茜第一段连携 pending
  -> 释放 chr_0028_wulfa_combo_2_skill
  -> ChangeSkillAction 把 ComboSkill 槽换成 chr_0028_wulfa_combo_3_skill
  -> 第二段可用计时与 QTE listening Buff 启动
  -> 重击期间 PauseComboSkillTime + PauseBuffTime 同步冻结
  -> 精准窗口仅由 ShowComboRingQte / timing_success 表示
  -> 释放第二段或计时结束后恢复 chr_0028_wulfa_combo_2_skill
  -> OnRemoveAllPendingComboSkill / Buff finish 清理监听与计时
```

原始数据中的关键边界是：

- 公共技能组只公开 `combo_2_skill` 和 `combo_3_skill`，与中文描述的“可连续发动两次”一致；
- `combo_2_skill` 在 37 帧把连携槽换成 `combo_3_skill`，而 `combo_3_skill` 在起始组换回 `combo_2_skill`；这是通用 skill-slot overlay，不是洛茜专用状态机；
- 内部 `combo_1_skill` 不在公开技能组中，但包含 6 秒临时换槽、`TriggerComboSkillAction`、冷却清零和 use-timer 创建，属于内部触发/接续代理，不能作为第三个用户技能暴露；
- `TriggerComboSkillAction` 没有目标 skill id，且出现在技能已经执行后的条件分支中，所以它不足以定义最初的全局开窗条件；
- `ShowComboRingQte` 只写入 QTE 成功标记和教程 Buff，不能用来代替普通 pending；
- Endaxis 在洛茜源码中明确留下“两段连携窗口尚未对应”的 TODO，进一步证明其手填窗口不能作为本项目的行为真值。

由此，洛茜的实现必须拆成三份可复用事实：复合状态条件创建第一段 pending、`ChangeSkillAction` 驱动技能槽 overlay、原始 Buff/动作驱动第二段计时与精准窗口。任何只在画布中把一个按钮强行改绿的修复都会掩盖这三者中的至少一个缺口。

### 12.10 复合连携规则的实时画布投影

核心运行时已经可以在提交后的 `StatusEffectApplied/StatusEffectRefreshed` 快照上计算递归条件；实时画布此前却只导出单个 `eventType`，并只保存一个破防计数。这会产生两类互相相反的错误：洛茜永远没有合法释放空间，或者未来把条件字段丢失后错误地把她的连携视为无条件可用。

本轮将投影边界收敛为：

1. 生成器不解释角色机制，只原样导出声明式 `eventTypes` 与 `conditions`；目录 schema 升至 v5；
2. UI 目录类型保留 `All/Any/Not` 递归形状和 `HasBuff/BuffStackCompare` 所需字段，未知条件或未知比较符一律返回 false；
3. 画布的轻量状态账本只接受已经落到真实 Hit 的目标 Buff 效果，并在状态写入后发出 applied/refreshed observation；它不重算伤害、乘区或派生 Hit；
4. 破防与四种元素附着用稳定 Buff ID 记录，洛茜两条规则分别覆盖“先附着后破防”和“先破防后附着”；同一 Hit 内按效果提交顺序求值，只由补全复合状态的那次 transition 创建窗口；
5. 跨角色先后关系继续使用 `releaseAnchor` 的真实命中依赖。不同角色泳道的首按钮都可以位于 0 秒，不能用视觉列号冒充因果顺序；
6. pending 的创建、过期、冷却抑制、选择与消费仍沿用通用连携生命周期；水位分组、每列斜率、命中点位置和按钮布局均未修改。

回归包含一条正例和一条反例：同一命中依次提交火附着与破防时，洛茜窗口在该命中帧创建并由锚定按钮消费；只有破防而没有任何元素附着时，按钮保持 `COMBO_TRIGGER_MISSING`。这验证的是公共条件和目标状态投影，不是洛茜角色分支。真实状态持续时间和完整 Buff 生命周期仍以 settled runtime ledger 为最终事实；后续若把动态 runtime mutation 直接流式投影到画布，应删除对应的轻量预演状态，而不是保留两份长期真值。
