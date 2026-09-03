# 1.5.3 通用运行时闭包研究

> 本文固定分析提交 `9bce3c1` 的缺口，因此正文数字是研究基线，不是当前统计。实施结果见[运行时语义收口记录](../maintenance/runtime-generalization-20260903.md)，实时数字只看[当前证据快照](../evidence/current-snapshot.md)。

## 结论

当前 `3477` 条逐角色 finding 不是 `3477` 个独立功能。只看会影响战斗结论的 `combat-blocking`、`combat-partial` 与 `evidence-missing`，`1080` 条风险可归并为六个根契约：

1. 谓词与值图；
2. 事件与时间内核；
3. 目标集与 ability entity；
4. 状态、形态与伤害修饰；
5. 资源与动作准入事务；
6. 证据、依赖与相关性判定。

前五项应一次性补成通用语义，不按角色或 action 名逐个打补丁。第六项不能靠写代码消失：缺失上游文件、非法枚举、随机/曲线黑盒语义、环境与几何输入必须继续显示为 unresolved。真正的关闭条件也不是“action 已有 switch case”，而是“原始字段进入类型化 IR、运行时产生可追溯状态变化、来源支持的 fixture 证明该变化”。

## 事实口径

### 固定来源

本研究以仓库提交 `9bce3c1b8ee5ab671fad6d8c55772338c9e8ae2a` 上已经生成的审计为基线；工作区中尚未进入该基线的实验性修改不用于证明语义。

| 来源 | 固定版本 | 本研究中的用途 |
| --- | --- | --- |
| `sources.lock.json`、`reference/public-data/akedata/table-corpus.manifest.json` | 表 `1.5.3@9764758-3` | 角色、技能、Buff、敌人与数值字段 |
| `sources.lock.json`、`reference/public-data/akedata/runtime-corpus.manifest.json` | JSON 索引修订 `2026-09-01T22:53:25.945329+00:00` | SkillData/BuffData 运行时闭包与缺失文件 |
| `reference/third-party/akedatabase/` | AKEDatabase `1bb9549705eba2601affed4cb8a7ea69ba13b150` | action 名称、字段结构与依赖链的结构性旁证 |
| `fixtures/calc/` | Calc 数据 `9163343-11`，bundle `/_nuxt/Cgx2mFCV.js` | 指定输入下的帧、资源、状态、伤害与中断黑盒事实 |
| `/Users/sailstellar/Documents/coding/dmg-end-field` | `codex/v1.8-lts-slimming` 当前提交 `086350a0c5ac5eb090b550299922ea8e9acfe18f`；资源发布 `20260902.092658.831b4fda55cf` | 专用产品实现的命中模板、叠层输入与伤害解释方式对照 |

`runtime-corpus.manifest.json` 记录 `3517` 个索引文件、`1320` 个已发现/验证文件、`88` 个补充文件和 `5` 个已知缺失文件。这里的数量描述来源闭包，不等于编译或战斗闭包。

### 三份 audit 不可相加

| audit | 实际问题 | 当前事实 |
| --- | --- | --- |
| `derived/cleanroom/ake-action-coverage.json` | 全 BuffData/SkillData action 语料是否有编译/执行路由 | `3605` 文件、`31912` 次 action、`164` 种类型；compiler status 为 executable `10258`、metadata-only `12516`、unresolved `9138`；gameplay 可执行路由 `13727 / 17430 = 78.755%`；calculator-core 可执行路由 `10796 / 11143 = 96.886%`，其中 complete `7464`、adapter-required `3332`、blocked `204`、metadata-only `143` |
| `derived/cleanroom/ake-ability-event-audit.json` | 三个消费者入口是否有已登记生产者 | `85` 个 key、`1095` 个消费者组；complete `30 / 920`，emitter-required `53 / 167`，invalid `2 / 8` |
| `derived/cleanroom/ake-operator-mechanism-audit.json` | 32 个固定装配角色场景中的 unresolved 对战斗结论有何影响 | `3477` findings；combat risk `1080`，其中 blocking `312`（覆盖 32 个角色中的 31 个、179 个来源文件）、partial `284`（28 个角色、100 文件）、evidence-missing `484`（32 个角色、115 文件） |

逐角色 audit 固定使用 90 级、技能 12 级、武器 90 级、潜能 5、天赋 2 和 `eny_0007_mimicw`。`scripts/audit-ake-operator-mechanisms.mjs:142-218` 是场景口径；`:44-51` 以 `entityKind + entityId + code + sourceType + jsonPath` 去重；`:54-103` 仅按 entity id 中的角色别名区分 operator 与 shared dependency。因此：

- `1080` 是固定场景中的 occurrence，不是独立缺陷数，也不是全配装覆盖率；
- shared dependency 另有 `217` 条，其中 combat risk `97`（blocking `28`、partial `17`、evidence-missing `52`），与逐角色汇总存在作用域关系，不能直接相加；它们的能力项仍落在下文六个根契约内，没有形成第七套语义；
- 只有 `chr_0012_avywen` 没有 blocking，但仍有 `12` 条 partial 和 `6` 条 evidence-missing；当前没有角色可据此宣称完整闭合；
- Typhoeus 的 `214` 和 Rossi 的 `186` 是 occurrence 数，不代表前者一定比后者更严重；
- finding 路径中的 `[1..]` 是 `AkeActionCompiler.#compileSequence` 递归切片生成的诊断路径，不是原始 JSONPath。

`src/core/ake-mechanism-impact.mjs:1-269` 按 action 类型和诊断码做保守静态分级。它适合回答“不能静默忽略什么”，不证明每一次 occurrence 都真的改变最终伤害。例如 `RandomAction` 统一进入 deterministic-choice，但 `reference/public-data/akedata/Json/SkillData/chr_0030_zhuangfy_attack1_ult_3_abilityrange.json` 的 `randomRotate` 是空间旋转输入；是否进入战斗核心必须继续追踪它的下游消费者。

## 根因族

下表中的数量来自逐角色 audit 的 `summary.byCapability`。不同能力项在该 audit 中互斥，但它们仍是 occurrence，不能理解为要新增同样数量的实现。

| 根契约 | 当前能力项 | 共同根因 | 可批量关闭的通用机制 | 必须保留的边界 |
| --- | --- | --- | --- | --- |
| 谓词与值图 | condition-algebra `130`、deterministic-choice `393`、derived-state `8`、data-provider `1` | 编译器仍把若干控制流、读取与派生值当成平铺 action；随机和曲线没有重放契约 | 类型化 predicate/value AST、序列前缀语法、Blackboard 派生写入、确定性选择账本 | RNG 分布/种子/调用顺序、Unity 曲线插值、缺失 SkillSetting/环境值 |
| 事件与时间内核 | event-subscription `46`、event-scheduling `28`，另有少量 unclassified channel/listener | listener 已能登记，但 producer 相位、payload 和周期/取消契约不完整 | 统一事件 envelope、事务相位、Buff/Skill listener 生命周期、per-target 周期调度、施法准入 lease | 未观测的 before/after 顺序和 payload；非法 event 值 |
| 目标集与 ability entity | targeting-scope `204`、child-action `32`、physical-status `80` | 目标选择、目标组、无脚本标记实体、子技能和空间位移被混在一起 | 目标集代数、validator、实体注册/变更/销毁、子技能可选、物理控制结果与轨迹分离 | 几何、碰撞、AI、多敌人选择与精确位移 |
| 状态、形态与伤害修饰 | status-lifecycle `21`、form-state `30`、damage-factor `11` | Apply/stack/refresh/finish、tag/overlay、damage factor 没有全部落到同一生命周期模型 | 参数化状态、selector、退出原因、tag lease、可逆技能 overlay、嵌套 enhancement | 环境 Buff 选择；空 layer mask；未证明的特殊 stacking 语义 |
| 资源与准入事务 | resource-transaction `2`，并吸收 ChannelingCasting 的锁定语义 | 数值来源、team/self recipient、同帧顺序和“能否施放”没有统一事务边界 | provenance provider、float32 量化、before/actual/after ledger、动作锁 lease | 上游未给出的全局 USP/SkillSetting 值只能由 Calc 探针补证 |
| 证据、依赖与相关性 | dependency-closure `4`、unclassified `90` | 缺文件、非法枚举和无下游使用分析被混成 action-name 风险 | 来源闭包检查、write/read/emit/consume 图、固定木桩 relevance profile、分层 unresolved | 缺失文件正文、世界/地牢/AI 输入、无法从字段名推出的枚举和黑盒规则 |

### 1. 谓词与值图

现有运行时并不缺基本表达能力。`src/core/effect-runtime.mjs:376-425` 已执行 `All`、`Any`、`Not`、`Compare`；`:522-609` 已读取 Blackboard、Payload、Context、Attribute，并执行 Add/Multiply/Subtract/Divide/Min/Max；`:615-637` 保证同一事务内前序 Blackboard 写入对后序 action 可见。缺口主要在 AKE 编译层：

- `src/core/ake-action-compiler.mjs:760-831` 把连续 condition 隐式合成 AND，并把余下序列作为 success tail；这已经证明条件是“控制后续序列”的语法，不是彼此独立的 metadata。
- `reference/public-data/akedata/Json/SkillData/chr_0002_endminm_normal_skill.json` 中 `NotNextCheckAction` 本身没有 operand，紧邻后一个 `CheckMainCharacterCondition`；它只能在序列层解释为“否定下一个条件”，不能作为普通 leaf。
- `reference/public-data/akedata/Json/SkillData/chr_0030_zhuangfy_normal_skill_ult.json` 的 `OrConditionAction.conditionList` 直接嵌套 actionData；`reference/public-data/akedata/Json/BuffData/buff_chr_0016_laevat_combo_skill_hit.json` 的 `Probablity.prob.value` 为 `0.5` 且参与 IfElse combat branch。
- `CheckEnemyRank` 的 `enemyRankSet` 可见于 `chr_0026_lastrite_ultimate_skill.json`；`CheckTargetContains` 的父组 `tar` 和子组 `MainTar` 可见于 `chr_0028_wulfa_combo_3_skill.json`；`CheckSuperArmor` 的 GE `30` 可见于 `chr_0031_mifu_normalskill_1.json`；`CheckPoiseValue` 的 Equals `0` 可见于 `buff_chr_0004_pelica_talent_0.json`。相应状态已有承载位置：`src/core/combat-context.mjs` 的 entity kind/metadata、`src/core/resilience-machine.mjs` 的 super armor、`src/core/poise-system.mjs` 的 poise。
- `SaveCollectedBuffBbValue` 与 `ModifyCollectedBuffBbValue` 的 key、乘数、加数和 direct 字段可见于 `buff_chr_0032_lizhiyan_talent2.json`，能够直接编译为已有 value expression 与 Blackboard 写入。

因此可直接实现的是：先把 action 序列解析为 predicate/value AST，再生成已有 EffectRuntime IR；`NotNextCheckAction` 包裹其后一个 predicate，连续普通 predicate 组成 All，`OrConditionAction.conditionList` 组成 Any，`IfElseAction` 与 `TogglableAction` 只消费 AST。rank/kind/目标组包含/super armor/poise/已知 custom event/skill-hit 都可以读取已有上下文，不需要角色特判。

`RandomAction` 与 `Probablity` 可以先实现确定性选择服务的结构：显式 seed、roll identity、调用序号、候选/阈值和账本结果；但在没有同输入多次 Calc 探针前，不能宣称分布和调用顺序一致。`CurveEvaluateFloat` 的输入、输出 key 和关键帧在 `buff_chr_0016_laevat_passive_teammate.json` 中齐全，但 `time/value/inSlope/outSlope/inWeight/outWeight/weightedMode` 只证明数据形状，不能单靠名称断言 Unity 风格插值。曲线 IR 和 provenance 可先落地，数值 evaluator 必须等精确规则或 probe。

### 2. 事件与时间内核

`src/core/ability-event-listener-registry.mjs:34-41` 已明确区分 SkillData timeline listener 与由 `StatusEffectSystem` 持有的 BuffData listener；`:65-150`、`:188-257`、`:259-305` 已有登记、通知、Blackboard 回写和 seek 清理。问题不是再造 listener，而是生产者和相位不完整。

`src/core/ability-event-producers.mjs:1-35` 只登记 33 个 producer 定义。`scripts/audit-ake-ability-events.mjs:28-72` 和 `:111-178` 表明，event audit 的 `complete` 仅表示字符串命中 producer 表，不等于场景已触发或 payload 已验证。当前最大缺口为 `OnOwnerDead` 19 组、`OnAfterOutputPhysicalInfliction` 12 组、`OnEnterFight` 12 组、`OnCharBeforeOutputSpellBurst` 10 组、`OnTeleportationPointRest` 9 组、`OnCustomAbilityEvent` 7 组、`OnBuffEndsEarly` 6 组、`OnAbilityEntitySpawned` 5 组。

周期动作也应并入同一内核：

- `chr_0034_typhoea_ultimate_skill_arrowrain_sub1.json` 的 `ChannelingActionV2` 明确给出 `executeEachFrame=true`、`triggerInterval=0.033`、`maxCountPerTarget=3`、`targetTriggerInterval=0.1`，tick 内含 Interrupt 与 Natural Damage；这些字段足够让 IR 和 scheduler 保留“全局 tick + 每目标节流 + 每目标次数上限”，但首 tick、取整和同帧先后仍须 fixture 证明。
- 基线 `src/core/ake-action-compiler.mjs:1396-1482` 会生成 `ScheduleIntervalActions.targetIntervalSeconds`，但 `src/core/combat-runtime.mjs:1295-1417` 只按全局 interval 生成 offsets，未读取该字段；这属于现有通用契约的遗漏，不是未知游戏规则。
- `chr_0013_aglina_normal_skill.json` 的 `ChannelingCastingAction` 只有 `duration=3.7`、`cantSwitchPosition=true`、`cantCastSkill=true`，没有 tick actions。它应编译为有期限的动作准入 lease，而不是强行要求 interval action。

可直接实现的统一事件 envelope 至少包含 `eventType/phase/frame/transactionId/sourceId/ownerId/carrierId/targetId/skillId/rootSkillId/castId/rootCastId/parentCastId/buffInstanceId/payload`。只在已有明确事务边缘发生产者：fight enter/exit、damage/infliction before-after、Buff apply/finish/early-finish、ability entity spawn/finish、resource before-actual-after。producer 必须绑定实际 edge；只向 `ability-event-producers.mjs` 增加名称不算关闭。

### 3. 目标集与 ability entity

基线编译器 `AkeActionCompiler` 的 `FindTargetAction` 分支（`src/core/ake-action-compiler.mjs:1123-1194`）已经生成 `FindTargets`，覆盖 owner-spawned、hostile、allied-character 和 reference-point；运行时 `src/core/combat-runtime.mjs:2757-2825` 已支持 `onlyMainCharacter` 和 tags。当前缺口主要是 finder/validator 规范化不完整：编译器读取 ExcludeOwner 与 TagValidator，却没有把 `MainCharacterValidator` 传给已存在的 `onlyMainCharacter`。

`chr_0025_ardelia_combo_skill.json` 同时给出 `CharacterTeamFinder + MainCharacterValidator`、PointFinder 与 MainTarget 的真实形状。前者在现有 squad/entity 模型中可直接实现；Point/HitBox/RandomPoint 等涉及几何的 finder 必须走外部 target/spatial provider。固定木桩只能显式声明 fallback，不能把 fallback 写成通用真值。

`SpawnAbilityEntity` 还错误地把“无 child program”当成“实体不存在”。`buff_chr_0030_zhuangfy_normal_skill_trigger_sword_tar.json` 创建 `abilityentity_chr_0030_zhuangfy_normal_skill_fake_target`，`abilityEntitySkillId` 是空字符串，同时给出 ActionSource、`fakePos` 和继承 cast id；这是可被后续 action 引用的 marker entity。`chr_0030_zhuangfy_normal_skill.json` 随后用 `SetAbilityEntityDuration` 写入 3 秒；`chr_0033_camille_normal_skill_projhit_sub.json` 用 `SetAbilityEntityTarget` 改目标。现有 `src/core/combat-context.mjs:9,123-160` 已能注册 `Object`/`Summon` 和 metadata，`src/core/combat-runtime.mjs` 的 child program 分支也已有 owner/carrier/root cast 继承。

因此应把实体存在与脚本执行解耦：`SpawnAbilityEntity` 总能注册有 identity、owner/team/tags/metadata/duration/target/cast lineage 的实体；`abilityEntitySkillId` 非空时才附加调度 child SkillData。Duration、Target、Clear、Finish 都操作 entity handle。这样一个机制同时关闭 marker、召唤物、子技能与 owner-spawned finder 的大量问题。

`BlowOffAction`、`PullAction`、`LaunchUpwardAction`、`TakeDownAction` 等不能整体降级成 presentation。`chr_0015_lifeng_power_attack.json` 明确给出 source/target、distance 和 direction 设置，证明存在位移请求，却不证明精确轨迹或控制免疫判定。通用运行时应分开记录 `PhysicalControlAttempt/Resolved/Rejected` 与可选 trajectory；固定木桩可验证状态结果，坐标变化仍留给 spatial provider。

### 4. 状态、形态与伤害修饰

基线 `src/core/ake-action-compiler.mjs:870-1016` 已有 `#compileParameterizedStatusAction`，能够处理 source/target、duration/rate、child Buff、enhancingList 条件分支和 auto-finish；Vulnerable/Weak/Shelter 已在 `:1959-2015` 复用它。下列字段足以沿同一路径实现，而不需要角色代码：

- `buff_chr_0013_aglina_ultimate_skill.json` 的 `SlowAction` 给出 source/target、`duration=-1`、Blackboard `move_speed_scalar`、child 标志与 `autoFinishByAction`；Slow/Speedup 应映射到规范化状态，而不是散落的 action handler。
- `buff_chr_0030_zhuangfy_talent1_base.json` 的 `EnhancedAction` 给出 Blackboard duration/rate、`subType=Pulse`、childBuffId，以及含 buffIds、Add、Blackboard value 的 enhancingList；它与 Vulnerable/Shelter 共用“参数化 damage modifier + 条件增强”契约。
- `buff_chr_0032_lizhiyan_talent2.json` 的 collected-Buff read/modify 字段足够进入 selector + lifecycle snapshot。
- `src/core/skill-form-state-registry.mjs:33-180` 已有按优先级、可逆的 skill override/mode；`chr_0017_yvonne_attack4.json` 的 `TogglableAction` 可直接编译为条件分支，`buff_chr_0035_liino_comboskill_ultskill_hit.json` 的 `AddTagAction` 可绑定当前 Buff/cast lifetime，`buff_chr_0030_zhuangfy_ult_base.json` 的 `TagQueryListenerAction` 可作为 tag query subscription 并触发 `FinishBuffAdvanced`。

需要新增的是一个统一 lease/selector 规则：状态、tag、overlay 都记录 owner、carrier、来源 Buff/cast、开始/结束、stacking 操作和退出原因；replace/refresh/extend/consume/early-finish 走同一状态机并在事件内核发边缘事件。`ChangeSkillType` 可按原始 `skillId + skillType` 建立显式映射；但 `ChangeSpecificLayerAction` 样本中的 mask 为空对象，不能从空字段推断战斗层、碰撞层或渲染层语义，必须继续 unresolved。

`buff_chr_0026_lastrite_talent_1_vul.json` 的 `SaveBuffLifeTime.buffSettings.checkType=Environment` 是明确反例：状态机本身可以实现，但选中哪个环境 Buff 不能由当前战斗上下文推断，必须由 environment provider 输入。

### 5. 资源与动作准入事务

`src/core/ake-action-compiler.mjs:3261-3330` 的 `ObtainUspInNormalSkill` 已要求 evidence-backed `ResourceActionRule`，在本地没有 `usp_everyone/usp_self` 时报告全局 provider 缺口；这是正确的 fail-closed 方向。`fixtures/calc/squad-resource-boundaries.oracle.json` 的 `shared-atb-teamwide-usp` 则给出可使用的黑盒事实：Perlica 普通战技后，frame 13 时 Perlica 与 Chen 的 USP 都是 `6.499999761581421`。同文件还固定了 shared ATB、队列执行时重检、同帧顺序、returned ATB 优先消费与 ultimate-time 暂停恢复等用例。

可直接实现的机制是 provenance-carrying resource provider，而不是在 compiler 里按角色硬编码：provider 返回值、recipient scope、量化方式和证据 rule id；资源机统一记录 before/requested/actual/after、team cohort、命令与 cast。当前 Calc 样本已支持 teamwide recipient、float32 结果和特定同帧顺序，只能对这些 case 宣称闭合。

`src/core/ake-action-compiler.mjs:1860-1940` 的 `ReadSkillSettingData` 已优先读语义映射。`chr_0031_mifu_normalskill_3.json` 请求数据键 `弭弗特殊猛击`、column 1 并写入 `yuanshi_multi`；当前来源没有该 setting 时，数值不可编造。它应继续是 provider/evidence gap，直到获得上游表或针对该读取的 Calc probe。

### 6. 证据、依赖与相关性

operator audit 直接命中的四个缺失依赖是：

- `BuffData/buff_chr_0030_zhuangfy_have_sword.json`；
- `SkillData/chr_0034_typhoea_attack5_02_projhit.json`；
- `SkillData/chr_0034_typhoea_normal_skill.json`；
- `SkillData/chr_0034_typhoea_power_attack_projhit.json`。

`reference/public-data/akedata/runtime-corpus.manifest.json` 另记录 `buff_wpn_passive_spirit_01.json`、`chr_0028_wulfa_absorb_entity_effect.json`、`chr_0028_wulfa_normal_v4_skill.json`，连同重叠项合计七个唯一缺失标识。这些文件的正文只能从上游补齐；空文件、猜测 action 或从最终伤害反推一份伪 SkillData 都会破坏来源链。

相关性也必须由数据流而非 action 名决定。建议给每个 IR 节点标注 `reads/writes/emits/consumes`，从 Damage、Resource、Admission、Status、Target 和 ChildSkill sink 反向追踪：

- 有路径进入 combat sink：按 blocking/partial/evidence 评估；
- 只进入相机、动画、UI：presentation-only；
- 依赖几何但固定木桩有显式 fallback：spatial-assumption；
- 无可证明下游：保留 unresolved/unclassified，不擅自判 complete。

这会消除大量“类型看起来危险但本样本只用于表现”的假阳性，同时不会把未知类型静默吞掉。

## 参考实现与数据证据如何使用

| 证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| `reference/public-data/akedata/Json/` | action 顺序、字段、引用、Blackboard key、静态数值与依赖 | 字段未编码的执行顺序、RNG、曲线算法、世界查询结果 |
| `reference/third-party/akedatabase/plugin/js/v3-skill.js:100-315` 的 `ACTION_LABELS` 及其 raw renderer | action 类型名与字段确实存在，页面如何呈现原始数据 | 它不是战斗执行器，label 或格式化函数不能作为运行时语义 |
| `reference/third-party/akedatabase/research/cc-buff-analysis-v2.md` | 具体 Buff/action 依赖链与该文档观察到的优先级 | 不可外推成所有角色、所有事务的通用规则 |
| `fixtures/calc/ake-cross-character-smoke.oracle.json` | Chen/Wulfgard 指定命令的真实命中帧与数值 | 其他角色、其他配装或随机分支 |
| `fixtures/calc/ake-interruption-probe.oracle.json` | Wulfgard 普通战技被终结技同帧中断、未发生的 Hit、Buff add/finish | 所有 interrupt 原因和所有 child entity 生命周期 |
| `fixtures/calc/pelica-combo-boundaries.oracle.json` | 连携在真实 Hit 同帧开启，之前失败，之后/边界按记录处理 | 任意角色连携窗口的通用时长 |
| `fixtures/calc/pelica-resource-boundaries.oracle.json` 与 `squad-resource-boundaries.oracle.json` | 已列 case 的 ATB/USP 数值、recipient 与同帧顺序 | 没有 probe 的全局 USP 黑板值 |
| `fixtures/calc/poise-guard-boundaries.oracle.json` | 指定敌人与命令下的 poise guard 边界 | 所有 enemy rank/super armor/物理位移规则 |

专用 `dmg-end-field` 也只作边界清晰的对照。其 `src/core/calculators/buffCalculator.ts:135-145` 把 countable Buff 计算为 `baseValue × 调用方提供的 stack count`；`src/core/calculators/skillButtonDamageCalculatorV2.ts:124-216,233-253` 对预先编排的 `template.hits` 逐 Hit 计算；`src/core/services/buffExtraHit.ts:39-145` 规范化手工 extra-hit 配置。资源发布 manifest 说明这是一份 32 角色、78 武器的产品数据快照。它可以校验“某个已知 Hit/层数输入应如何展示和计算”，但没有模拟层数如何获得、何时过期、事件在同帧如何排序，所以不能充当 AKE 事件、目标、随机和生命周期 oracle。

## 可直接实现的通用语义

以下项目的输入字段和承载模块都已存在，可作为一次实现的主范围：

1. **Predicate/value IR**：序列先解析再编译；支持 Not-next、nested Or、IfElse/Togglable、rank/kind/group contains/super armor/poise/skill-hit/custom-event；统一 descriptor、Blackboard read/write 和 collected-Buff 派生值。
2. **事件 envelope 与真实 producer edge**：复用现有两类 listener；在 fight、damage/infliction、Buff、entity、resource 的明确事务边缘发事件，记录 phase、payload 与完整 lineage；没有 edge 的事件不登记 complete。
3. **周期与准入 lease**：`ChannelingAction(V2)` 支持 tick、每目标间隔/次数、generation cancellation；无 tick 的 `ChannelingCastingAction` 只创建 cant-cast/cant-switch lease。
4. **目标集与实体图**：实现 target group 的 union/filter/pick/contains、MainCharacterValidator、source/owner/main target/team；marker-only ability entity 可存在，child program 可选，duration/target/clear/finish 操作实体 handle。
5. **状态/形态/修饰统一生命周期**：Slow、Speedup、Enhanced 复用参数化状态路径；Save/Modify/Finish/Dispel/Seal 使用 selector；AddTag 与 overlay 绑定 Buff/cast lease；所有退出记录唯一原因。
6. **物理控制双层结果**：在没有几何 provider 时仍可执行 control attempt、免疫/韧性判定与结果事件，trajectory 保持 unresolved spatial assumption。
7. **资源 provider 与事务账本**：规则值来自带来源的 provider；统一 team/self recipient、float32 量化、before/actual/after 和同帧 cohort，不在 action compiler 写角色常量。
8. **确定性与相关性基础设施**：choice service 记录 seed/roll/call order；IR 生成 reads/writes/emits/consumes 图；audit 只在 combat sink 可达时升级风险。

这些是“可以直接写对的架构与字段语义”。其中 RNG 的具体采样、曲线数值、外部 finder 结果仍由下一节的证据门控制，不能因基础设施已存在就标记 complete。

## 不可推断边界

下列内容必须保留为显式 unresolved/provider-required，不属于实现遗漏：

- 七个唯一缺失上游 SkillData/BuffData 的正文与内部 action；
- ability event 数值 `0`（7 组）和 `32`（1 组）的枚举映射；样本位于 `buff_chr_0031_mifu_red.json`、`buff_chr_0034_typhoea_passive_arrowrecover_exitfight.json`、`buff_wpn_extra_attack.json` 等，当前字段不能证明其事件名；
- `RandomAction`/`Probablity` 的真实 PRNG、seed 来源、调用顺序与边界分布；
- `CurveEvaluateFloat` 的精确插值、切线与 weighted mode 规则；
- environment/dungeon/AI/screen/input/geometry provider 的结果，以及多目标碰撞和精确位移；
- 缺失 SkillSetting、动态计算参数和没有证据映射的全局 Blackboard 常量；
- 空 `ChangeSpecificLayerAction` mask 的战斗含义；
- `TimedGrowingEnhance` 的准确增长触发、起始时点、重置和离战处理。`buff_chr_0034_typhoea_passive_arrowrecover_exitfight.json` 只给出 Infinity、`arrow_recover_time=3`、maxStack 4、max_arrow 5 与非法 event `0`，且 `chr_0034_typhoea_normal_skill.json` 缺失；名称不能替代语义证据。

Calc fixture 的证明范围必须按 case id 书写。现有 fixture 没有覆盖 RNG/curve、53 个缺 producer event 类型、大多数 finder、Typhoeus 的 `TimedGrowingEnhance` 或完整 status lifecycle；这些项需要新增最小黑盒探针，不能以“其他固定用例通过”替代。

## 推荐一次性实现范围

建议把下一次实现定义为一个完整的“runtime semantic closure”切片，而不是继续按角色返修：

### 纳入同一变更

1. 新增 predicate/value AST 与 AKE 序列解析，并迁移所有现有 condition/IfElse/Togglable 到同一入口。
2. 扩充统一事件 schema，在已有事务 edge 上补 producer；同时完成 Channeling V2、per-target cadence、取消和 casting lease。
3. 完成 target set、validator 与 marker entity 注册/变更；child SkillData 从实体存在条件中解耦。
4. 将 Slow/Speedup/Enhanced、Buff selector、tag/overlay lease 和物理 control result 接到现有状态、形态、韧性/poise 深模块。
5. 将全局资源/setting 读取统一放入 provenance provider；只装入当前 Calc/公开数据已经证明的规则。
6. 为编译 IR 生成依赖/下游使用图，重做 combat relevance 判定，并在审计里区分 `implemented-unverified`、`provider-required`、`upstream-missing` 和真正 `complete`。

### 明确不纳入“已完成”声明

不伪造七个缺失文件，不猜 event `0/32`，不猜 RNG/curve，不内置虚构几何/AI/环境，不把专用 DEF 模板当运行时 oracle，也不把 `TimedGrowingEnhance` 的名称当规则。

### 一次性验收条件

- 重新生成三份 audit，三者仍各自解释自身作用域，不汇成一个误导性的百分比；
- 每个从 risk 移除的 action 都能追到：原始 JSON path → typed IR → 运行时 ledger/state edge → 来源支持的 test/fixture；
- action/event 只有注册表命中、编译不报错或输出 metadata，均不能标记 complete；
- 固定木桩降级必须在结果中保留 provider/assumption，不得冒充世界模拟；
- 尚无证据的项目数量可以下降，也可以因更精确追踪而上升；审计诚实性优先于“零 unresolved”。

这个范围完成后，剩余 blocker 应主要收敛为可命名的外部证据队列，而不再是散落在角色文件中的运行时结构缺口。
