# 通用引擎与逐角色对接:Endaxis 专门代码对照 × cleanroom 通用模型 × 不健全审计

> 本文日期:2026-08-28
> Endaxis 对照基线:`66bb80b`(无 LICENSE,仅作机制目录与结构对照,不复制任何代码/数据/数值)
> cleanroom 审计数据:`derived/cleanroom/ake-operator-mechanism-audit.json`(2026-08-28,31 角色 3,034 条 finding)、`ake-ability-event-audit.json`、`ake-action-coverage.json`
> 前置阅读:[17 Endaxis 专有机制归纳与 AKE 通用引擎升级研究](17-endaxis-proprietary-mechanism-generalization-audit.md)(本文的逐干员细化与数据更新)
> 本文回答三个问题:**① cleanroom 的"通用模型"如何接住每一个角色;② 同一角色在 Endaxis(专门代码范式)里长什么样;③ 通用引擎现在还有哪些不健全。**

## 0. 读法与两个仓库的引用约定

§1 立论:两种范式的本质差异。§2 讲 cleanroom 接一个角色要经过什么(机制面)。§3 是 Endaxis 专门代码的全景统计。**§4 是主体:31 个角色逐个对照**,每个角色固定四段:Endaxis 专门实现(带行号引用)→ 机制本质 → cleanroom 通用对接 → 当前缺口。§5 是通用引擎不健全的系统性审计,§6 给健全度总评。

引用约定:Endaxis 侧引用写 `Endaxis/src/...:行号`(该仓库根为 `/Users/sailstellar/Documents/ChatGPT/dmg-data/Endaxis`);cleanroom 侧引用写本仓库相对路径。逐干员 finding 数来自最新 operator audit(数字每日随修复推进,与 doc 17 记载的历史数字可能有差异,以 `derived/` 最新产物为准)。

---

## 1. 两种范式:专门代码 vs 通用模型

两个项目对"同一件事"——让 31 名干员各自正确——给出了相反的答案:

| 维度 | Endaxis(专门代码范式) | cleanroom(通用模型范式) |
| --- | --- | --- |
| 事实来源 | 人工维护的类型化 TS 数据(30 个手写 sheet,13,898 行) | AKE 公开 JSON + TableCfg(3,517 份,哈希锁定) |
| 角色机制在哪 | 每名干员一份 `src/data/operators/*.ts`,用声明式 DSL 组合 | 编译器把原始数据编译成 program/buff definition,角色只是数据组合 |
| 引擎认识角色吗 | 基本不认识,但有泄漏:引擎判断 `trackId === 'laevatain'`、组件识别 `rossi-combo-perfect-timing`、合约点名 endministrator/tangtang 状态 | **禁止**:核心代码不允许 `characterId` 分支,角色差异只允许存在于语义映射条目与原始数据 |
| 新角色成本 | 人工写 300–1,100 行 sheet + 手填数值 + 专项测试 | `assemble({characterId})` 自动编译闭包;机制缺口以 blocker 形式暴露 |
| 数值权威 | 手填(可能过时/出错,无版本锁定) | E1 原始数据 + E2 Calc 黑盒对拍;缺证据必须标 `evidence-missing`,不许猜 |
| 成熟度 | 30 干员全闭环,599 测试通过,已上线 | 逐干员审计仍有 289 条 combat-blocking;精度层只有佩丽卡等少数角色达到逐帧对拍 |

**两者不是竞争关系,而是互补的研究材料。** doc 17 §0 的判断仍然成立:Endaxis 的角色实现应被当作"机制假设目录"(E3 证据)——它证明某种状态转移和测试维度**应当存在**,但它的数值与行为不是权威;结构服从 E1(AKE 数据),行为数值由 E1+E2(Calc)校准。本文逐角色对照的用途是:**用 Endaxis 的专门代码发现 cleanroom 通用引擎的表达力缺口**——凡是 Endaxis 需要写专门代码的地方,就是通用模型需要检验"是否已有对应原语"的地方。

Endaxis 自己也证明了这个范式的天花板:30 名干员里仍有 1 名(laevatain)需要引擎内 ID 分支、1 名(rossi)需要组件 ID 分支、4 名需要约定状态 ID/专属字段。专门代码范式无法把"强化期随技能插入延长"这类机制通用化,只能在引擎里写 `if`。这正是 cleanroom 选择通用模型的原因——代价是必须把每个机制都做成有审计的原语,做不到就诚实地留 blocker。

## 2. cleanroom 如何"接住"一个角色:机制面

接一名新角色,调用方只需要一句 `new AkeScenarioAssembler().assemble({characterId, enemyId, weaponId, ...})`,内部发生的事:

```text
① 面板推导(AkeDataRepository):基础属性 + 武器/装备/天赋/潜能修正 → 八区属性组件
② 技能编译(AkeActionCompiler):
   roleMap 从 skillGroupType 推导四类技能组(普攻/战技/连携/终结)
   → 逐技能 parse → classify(每个 AKE $type 归为 compiler/metadata-only/
     external-provider/unresolved 四种处置)→ compile
   → collectReferences 扫描 buff_/skillId/childSkillId 引用入队,
     依赖闭包自动展开(maxDependencies=4000)
③ 装备/天赋/潜能 → AkeLoadoutCompiler 编译为 loadoutEffects
④ 内在被动自动发现(扫描 ${characterId}_*.json 且 castType=Passive)
⑤ spec/engine-semantic-mappings.json 注入角色级规则证据:
   ComboTriggerRule(连携开窗条件)、CommandAdmissionRule 等
⑥ 产出 bundle → AkeScenarioRunner 驱动 CombatRuntime 逐帧执行
```

机制的表达靠三层词汇(与 doc 17 §4 的 G1–G12 对应):

| 通用能力 | 引擎原语(示例) | 说明 |
| --- | --- | --- |
| G1 事件订阅与过滤 | `RegisterAbilityEventListener` + 生产者清单 | 35 种运行时事件;缺生产者 → fail-closed 审计 |
| G2 条件代数 | All/Any/Not/Compare/HasBuff/BuffStackCompare/BitMaskCompare | 连携规则 schema v5 支持递归条件 |
| G3 状态生命周期 | apply/refresh/replace/extend/pause/inherit/consume/expire + 显式 exitReason | 消费与到期是不同事务(OnConsumeBuff 契约) |
| G4 形态与技能 overlay | SwitchModeAction / ChangeSkillAction → skill-form-state-registry | 换槽不换冷却组 |
| G5 子动作与子 Hit | LaunchSkillProgram / 派生施放(parentCastId) | 子 Hit 独立事务 |
| G6 DoT 周期调度 | ScheduleIntervalActions + 时钟域 timer | 快照/刷新策略 |
| G7 资源事务 | ResourceSystem Shared/Entity 池 | 队伍 ATB 共享 |
| G8 冷却事务 | SkillCooldownSystem:set/reduce flat/percent-base/pause | 状态键=角色×公共技能组 |
| G9 admission window | ComboTriggerMachine pending | 180 Tick 公共窗口、冷却旁路 |
| G10 目标与作用域 | source/owner/carrier/target 四元身份 | 不得用模糊 actorId |
| G11 确定性随机 | Probablity → 场景 seed | 可重放 |
| G12 patch/派生值 | patchEffect/appendEffect/derived(编译层) | 潜能修改天赋效果 |

**关键点:语义映射是"证据"不是"配置"。** `spec/engine-semantic-mappings.json` 共 53 条映射,其中含角色 ID 的条目(chr_0002/0003/0004/0005/0006/0028/0030)只出现在 `ComboTriggerRule`——即连携开窗条件。这**不是**角色特判的溃败,而是 doc 17 §12.8 论证的"数据断层":AKE 的连携触发条件写在 `CharGrowthTable.skillGroupMap` 的中文文本里,无法从 SkillData 动作树闭包推导,只能作为逐角色声明式规则录入(规则的 `ownerId`/状态 ID 本来就是合法数据,引擎 `if (characterId)` 才是错误)。

## 3. Endaxis 专门代码全景

对 `Endaxis/src` 的全量扫描结论(排除 i18n 文案):

| 类别 | 形态 | 干员数 | 干员 |
| --- | --- | ---: | --- |
| A. 数据声明型 | 全部机制在 `src/data/operators/*.ts` 手写 sheet,引擎无感知 | 30/30 | 每人 230–1,144 行 |
| B. 引擎/store 特判 | 硬编码 ID 分支 | 1 | laevatain(`SimulationEngine.ts:362`、`timelineStore.ts:221-224`) |
| B2. 约定标记/字段型 | 通用机制 + 干员专属数据触发 | 4 | estella(免疫标记)、endministrator+tangtang(CONTROL_STATUS_IDS)、last-rite(`acceptTeamUltEnergy` 字段) |
| C. 组件特判 | 4 个组件各一份硬编码常量 | 1 | rossi(完美连携高亮 ×4 处拷贝) |
| D. 手工别名 | statusOptions.ts 4 条 | 3 | avywenna×2、tangtang×1、zhuang-fangyi×1 |
| E. 测试守护型 | 专项 mechanics 测试 | 6(核心) | antal、arcane、liino、camille、tangtang(+golden 覆盖约 20) |

复杂度顶层(Endaxis sheet 行数):烛渊/arcane 1,144、庄芳仪/zhuang-fangyi 890、梨诺/liino 796、洛茜/rossi 688、波格拉尼奇/pogranichnik 658、勒瓦坦/laevatain 606。这六名也是 cleanroom 侧 finding 数最高的群体——**复杂度是客观的,范式只决定复杂度落在哪一层**(Endaxis 落在数据文件,cleanroom 落在编译器原语覆盖)。

---

## 4. 逐角色对照(31 个 chr 条目)

以下按 chr ID 顺序排列。每名角色四段:**E**(Endaxis 专门实现,带行号)、**机制本质**(归入的通用能力)、**C**(cleanroom 通用对接现状)、**缺口**(当前审计/已知问题)。finding 数为 2026-08-28 operator audit 快照。

### 4.1 大端员 Endministrator(`chr_0002_endminm` / `chr_0003_endminf`)— finding 120 ×2

**E**:`Endaxis/src/data/operators/endministrator.ts`(364 行):`:26-44` 天赋1"源石结晶被消耗→自身攻击翻倍";`:48-59` 天赋2 条件型敌方物理承伤;`:80-93` 潜能2 `appendEffect` 把天赋效果派生给队友减半;`:272-298` 连携 triggers(敌方物反→消耗全部结晶触发 damageHit,`icd:0.01` 防重);`:331-356` 大招按 `skillLevelKey:'comboSkill'` 查表的同款引爆;`:21` 独有 `defaultPotential:3` 字段。**跨模块泄漏最深**:武器 `data/weapons/sword/6/grand-vision.ts:41` 与套装 `data/gearsets/grizzled-edge.ts:41` 直接检测 `endministrator-originium-crystals` 状态 ID;合约 `criteriaEffects.ts:497-502` 把它列入 CONTROL_STATUS_IDS。

**机制本质**:G3 状态堆叠与消费读取 + G5 派生 Hit + G4 形态 overlay——结晶是"有来源、层数、退出原因的状态实例"的标准样本。

**C**:结晶施加/强化选择/猛击/击碎作为独立账本事件验证(doc 17 §3);`SetSkillCdAtOnce` 冷却事务已闭环(§12.4,40 处全库收敛);消费事务经 `OnConsumeBuff` 契约(§15.6)。

**缺口**:消费读取按消费层数放大(`CheckConsumeBuffLayer` 已实现,`buff_equipsuit_expend_spell01` 的 Context Blackboard 读取已闭环);剩余缺口集中在强化战技的形态细节与击碎 Hit 的时间快照。

### 4.2 佩丽卡 Perlica(`chr_0004_pelica`)— finding 50

**E**:`perlica.ts`(270 行,最简样本之一):`:201-242` 连携窗口 = 全局重击,命中挂 `perlica-combo-electrification`(感电,`applyTiming:'beforeDamage'`);`:44-53/66-80/82-92` 三条潜能全是 patchEffect(延长感电、叠攻击、`effectiveness:1.33` 反应强度)。

**机制本质**:G9 admission window + G3 元素状态 + G12 patch——整个角色不需要任何引擎新原语。

**C**:**全项目精度锚点**。精确链(simulator)与其 Calc oracle 逐帧严格相等:连携窗口 `[86,265)`、pending 多条并存取最新、冷却 600 tick、导电进 `1.12` 防守方乘区、技力恢复 `0.2666666805744171/帧`;通用链自动装配回放同一主链。导电数值走 10 张公共元素表(§12.1)。

**缺口**:finding 数全库最低之一(50),P0 blocker 已清零(§13.2"佩丽卡仍为 2");导电在通用链的时序与精确链完全一致。

### 4.3 陈千语 Chen Qianyu(`chr_0005_chen`)— finding 71

**E**:`chen-qianyu.ts`(316 行):`:24-38` 天赋1 任意战技/连携/大招命中叠攻击(5 层);`:44-111` 潜能纯数值型;`:217/255` 战技与连携带 `physicalStatus:'lift'` 挑空;`:264-312` 大招 6 段 each + 高倍率收尾。

**机制本质**:G5 多段 Hit + G3 逐 Hit 自身堆叠 + 物理状态事务。

**C**:七段技能前五段逐层生效已验证(doc 17 §3);监听内的 `SetSkillCdAtOnce` 已进公共冷却事务(`OnBeforeOutputAirborne` 比例减冷却可在事件帧修改运行中的连携冷却,§12.4);"一次战技不能被 UI 重放成两层破防"是 doc 16 首轮修复项。

**缺口**:多段普攻的逐段状态快照审计;跨角色 oracle 已有面板对拍(§测试)。

### 4.4 乌尔夫加德 Wulfgard(`chr_0006_wolfgd`,狼卫)— finding 46

**E**:`wulfgard.ts`(378 行):`:24-40` 天赋1 敌方燃烧→自身火伤加成;`:44-53` 天赋2 patchHit 给追加射击塞 spReturn;`:66-104` 潜能3 两个 `derived` 把灼热獠牙复制给全队(0.5 倍);`:228-285` 战技条件追加射击(无燃烧/感电时上附着,有则 1.5s 后大倍率追击)。

**机制本质**:G1 事件订阅(燃烧存在)+ G5 子 Hit + G12 derived 派生(队友共享)。

**C**:追加 Hit 的 source/时间/状态快照验证路径已有(doc 17 §3);冷却重置(`SetSkillCdAtOnce`)已通用化。

**缺口**:狼卫的**一处空 `FinishBuffAdvanced` 选择器仍 fail closed**(doc 17 §12 第 20 条)——这是全库唯一残留的空 selector blocker;finding 46 全库最低档。

### 4.5 弧光 Arclight(`chr_0007_ikut`)— finding 88

**E**:`arclight.ts`(362 行):`:24-65` 天赋1 patchHit 塞 3 层 tracker,第 3 层消耗给全队电伤(智力系数 scaling);`:114-136` 潜能5 联动改 tracker 上限 3→2 并同步改触发条件(两处 patchEffect);`:242-256` 战技条件伤害组(敌方感电存在且 consume:true);`:261-282` 连携窗口 = 感电被施加**或被消耗**双触发。

**机制本质**:G1 标记状态(带 ICD/来源去重)+ G3 强制元素状态 + G2 或条件开窗。

**C**:`ForceSpellStatusAction` 七处公开动作已统一为 `ForceEnemySpellStatus` 事务(§12 第 10 条),弧光的按层消费沿同一事务;标记只由匹配 Hit 触发 + ICD 去重的验证项在 doc 17 §3。

**缺口**:施加大窗口与消费窗口的双触发条件(连携规则 schema v5 递归条件已支持,规则录入待证据);tracker 的 scaling 按智力属性读取。

### 4.6 烬 Ember(`chr_0009_azrila`)— finding 68

**E**:`ember.ts`(259 行,最简):`:24-36` 天赋1 `duringAction` 期间自身 protection;`:40-47` 天赋2 `value:[6*3, 9*3]` 内联算术硬编码;`:84-99` 潜能5 patchHit 目标 `ember-ultimate-hit`(该 ID 实际挂在战技段 `:180`,**跨技能 patch**);`:239-244` 大招全队盾(通用盾 ID)。

**机制本质**:G3 duringAction 生命周期 + G7 护盾 + G12 跨技能 patch。

**C**:动作结束清理与倒地失败原因不由 UI 猜测(§3);`ShelterAction` 七份数据已走公共 `buff_common_affixes_shelter`(§12 第 6 条)。

**缺口**:倒地(lift/knockdown)事务的失败原因明细;跨技能 patchHit 的 ID 引用完整性。

### 4.7 汐希 Xaihi(`chr_0011_seraph`)— finding 49

**E**:`xaihi.ts`(365 行):`:24-45` 天赋1 patchHit 给连击塞条件增伤;`:186-211` 战技(无伤害组)全队挂"辅晶"2 层;`:213-251` triggers 全局重击→消耗队友 1 层辅晶给自己增幅+给触发者回血(`target:'owner'`);`:253-269` 连携窗口 = 辅晶被消耗;`:307-355` 大招双元素增幅按智力 scaling 带 cap。

**机制本质**:G10 作用域(队友消费)+ G1 订阅(队友重击)+ G9 消费开窗。

**C**:**支援实体次数耗尽或状态消费**开窗是七类公共连携事件族之一(§12.8);`DispelAction`/`EnhancedAction` 在 doc 17 §3 标记为缺口;队友伤害读取敌方而非施法者私有状态的验证项。

**缺口**:DispelAction/EnhancedAction 两个原始动作未实现(会阻塞辅晶的驱散/增幅完整链);owner 目标解析的验证。

### 4.8 艾薇温娜 Avywenna(`chr_0012_avywen`)— finding 67

**E**:`avywenna.ts`(459 行):`:36-72` 天赋1"雷枪归还"双触发器(消耗雷枪/EX 雷枪按**消耗层数**回大能量,key 指向自身状态层数);`:321-370` 战技追击倍率与失衡值都由雷枪层数线性放大,`readConsumedStacks` + `infliction stacks:'fromConsume'`(消耗层数转电附着);`:403-444` 连携挂雷枪(3 层 99 上限)、大招挂 EX 雷枪;`:184-202` 潜能5 条件缩放。手工别名:`editor/hits/statusOptions.ts:63-64` 雷枪/雷枪·极。

**机制本质**:G3 消费读取(consumedStacks 作为倍率输入)+ G10 来源实体归属(ability entity)。

**C**:消费事件保留离场实例快照(`GetTargetBuffBBAdvanced(Context)` 读被消费 Buff 自身 Blackboard,§15.3);"返回不是重复施加"的来源归属验证项(§3)。

**缺口**:ability entity(雷枪作为实体)的 source attribution 仍是 G5 弱项;`OnAfterOutputPhysicalInfliction` 类事件桥接缺生产者。

### 4.9 吉尔贝塔 Gilberta(`chr_0013_aglina`)— finding 59

**E**:`gilberta.ts`(321 行):`:24-31` 天赋1 按**职业范围**的终结技充能加成(`target:{scope:'team', classes:['guard','caster','supporter']}` 受益人筛选 DSL);`:44-63` 潜能2 vulnerability 双吃(系数 ×1 + "视作多 1 层",注释写明 cap ×4);`:282-300` 大招易伤按敌方破防层数线性放大;`:302-306` 大招附带减速。

**机制本质**:G10 受益人筛选(职业 scope)+ G3 层数读取缩放 + 敌方 debuff 进乘区。

**C**:**doc 16 的明星修复案例**:Gilberta 的"脆弱"曾是 EN-01 的实证——Buff 识别了但 `PhysicalVulnerableDmgIncrease` 没进公式、伤害 100→100;现在 vuln 走 `vulnerableDmgScale` 独立乘区且全队后续 Hit 读取敌方实时状态(§3)。

**缺口**:破防层数线性放大依赖 consumedStatuses 快照的层数正确性(部分消费/整数层的边界);职业 scope 筛选 cleanroom 尚无对应原语(Endaxis 的 classes 筛选是 DSL 特性)。

### 4.10 雪曙 Snowshine(`chr_0014_aurora`)— finding 55

**E**:`snowshine.ts`(230 行):`:27-37` 天赋2 onHit 按 skillId 回大能量;`:174-183` **零伤害连携**(damageGroups 空,只有 `ultimateEnergyGain:10`,纯增益连携样本);`:202-218` 大招 tick 的 effects 为函数(第 6 段才附带凝固)。

**机制本质**:G6 周期调度(逐段条件)+ G7 资源增益——连携不必造成伤害。

**C**:`ShelterAction` 已闭合(§3);元素附着的 tick 条件分支走 reaction 机器。

**缺口**:Buff 生命周期内的 `AddTagAction` 仍需绑定准确 owner lifetime(§3,BuffData 31 处 tag 声明保持 unresolved);逐段函数式 effects 的编译等价物(timeline 组条件)。

### 4.11 李凤 Lifeng(`chr_0015_lifeng`)— finding 79

**E**:`lifeng.ts`(402 行):`:24-33` 天赋1 智/意双属性转攻;`:38-50` 天赋2 敌方被击倒→追加 damageHit(50~100%);`:108-158` 潜能5 derived 派生加强版击倒追击(×250)+ 15s 冷却标记(`ignoreTimeShift:true`);`:269-283` 战技易伤仅当敌方无 vulnerability 时挂(与通用易伤互补);`:380-391` 大招末段条件 `actionLinkConsumed`。

**机制本质**:G1 动作链消费订阅 + G5 派生 Hit + G8 冷却标记。

**C**:action link 事务与"消费发生在同一 admission/commit 边界"的验证项(§3);击倒追击的 GlobalCDTimer internal cooldown 已通用化(§12.6,14 对检查/启动收敛)。

**缺口**:动作链(actionLink)作为一等事务尚无通用原语(Endaxis 的 `actionLinkConsumed` 条件暗示 AKE 有对应机制);derived 追击的倍率快照。

### 4.12 勒瓦坦 Laevatain(`chr_0016_laevat`)— finding 110

**E**:`laevatain.ts`(606 行,**引擎级特判干员**):`:3-16` 熔焰 4 层、每层独立图标;`:18-34` 三个 SkillRequisite(强化普攻/战技仅在大招强化期可用,普通版反之);`:36-55` `createAbsorbHeatInflictionEffects()` 按熔焰层数 0–3 生成 4 个 consume(吸火附着转熔焰);`:348-378` 战技第 10 段满层追加"熔焰终结击"(consume 全层+挂燃烧+回 100 大能量);`:511-602` 大招本体 0 伤害、`enhancementTime:15` 数值型强化期,强化普攻作为 subSkills 挂在 ultimate 下。**特判**:`SimulationEngine.ts:362` `if (ultimateAction.trackId !== 'laevatain') return 0`——强化期内每插入一个战技/连携动作,大招强化时间随之延长(while 循环+200 次 guard);`timelineStore.ts:221-224` 编辑器侧同一套注册表。

**机制本质**:G4 形态状态机 + G3 熔焰消费 + **技能接续延长强化期**(Endaxis 无法通用化、只能写 ID 分支的机制)。

**C**:`PauseBuffTime` 已进统一 Buff 生命周期(§12 第 2 条,暂停冻结到期/周期/时间线);熔焰消费走消费事务;概率分支在 doc 17 §3 标记为缺口。**强化期延长的通用化路径**:doc 17 §2.2 明确"技能接续延长必须成为数据驱动的状态持续时间事务,不得保留角色 ID 的时间延长特例"——这正是 Endaxis 泄漏清单第一名。

**缺口**:强化期随接续延长的通用事务未实现;概率分支(RandomAction 确定性抽样,G11)未实现;finding 110 偏高。

### 4.13 伊冯 Yvonne(`chr_0017_yvonne`)— finding 98

**E**:`yvonne.ts`(551 行,强化期干员之二):`:3-29` 强化期三 requisite + 暴击常量;`:112-129` 潜能1 patchTick(DoT hitCount 4→6)+patchEffect(回能 +15);`:170-207` 潜能4/5 patchHit 战技返 SP / 大招标记命中塞 buff(注释解释必须在 animationTime 前落 buff 防被打断);`:383-427` 连携 DoT tick.effects 函数式(第 0 跳回能×2);`:429-547` 大招 `enhancementTime:7`,强化普攻 3+8+64 段射击(`hitCount:64`)+ 依暴击层数收尾(consume 10 层暴击标记+凝固时追加一击)。`data/types.ts:999` 注释把她与 laevatain/zhuang-fangyi 并列为 subSkill 挂 ultimate 下、group 却是 basicAttack 的三个例子;`simulator.test.ts` 45 处引用(全库最高)。

**机制本质**:G4 形态 overlay + G3 继承状态 + 强制元素状态 + G12 patchTick。

**C**:`InheritBuffAction` 52 处公开动作已进"技能动作所有权租约"(§12 第 8 条:CreateBuffAction 创建租约,白名单技能接管实例,旧动作迟到 cleanup 无权误删);`ForceSpellStatusAction` 事务化(第 10 条);击杀恢复标记经 BuffData listener 生命周期闭环(第 22 条:"伊冯击杀恢复标记不再是静态 metadata")。

**缺口**:"末段才消费/触发"的边界验证(64 段射击的末段收尾);patchTick 的等级补丁联动。

### 4.14 大潘 Da Pan(`chr_0018_dapan`)— finding 58

**E**:`da-pan.ts`(330 行):`:26-37` 天赋1 敌方破防被消耗时按消耗层数叠物伤(4 层上限,`stacks:'fromConsume'`);`:43-74` 天赋2 patchHit 大招末段挂"备菜",连携命中消耗 1 层→连携 CD -40%;`:225-241` 连携窗口 = 敌方破防 ≥4 层;`:289/316` 大招两处强制挑空/击倒(`forced:true` 无视抗性)。

**机制本质**:G3 消费读取 + G8 CD 事务(percent-base)+ 物理状态事务。

**C**:**消费链的完整闭环样本**(§15.6):大潘真实天赋按实际消费两层生成两层增益;`cd_reduce=0.5` 的百分比冷却走公共 `ModifySkillCooldown`(base-basis,§12.4)。大招倒地的 Hit 归属经 §12.5 修正:43–50 帧八次前置伤害 + 81 帧结算,倒地只属于 81 帧 Hit(契约测试从"首个 Hit 有倒地"改为"只有 81 帧 Hit 有倒地")。"弭弗特殊猛击"数值保持 evidence-missing 不猜值。

**缺口**:物理碎甲与其他清理的 `isFinishedEarly` 时序区分;首破防只上破防不产生反应 Hit 的验证已闭环(doc 16 §16)。

### 4.15 阿哕 Akekuri(`chr_0019_karin`)— finding 61

**E**:`akekuri.ts`(306 行):`:38-51` 天赋2 duringAction 大招期间全队 link(协击);`:107-114` 潜能5 patchEffect 追加 durationExtension;`:219-240` 连携窗口由**敌方被打出 staggered/staggerNode 触发**(onStatusApplied + `triggerScope:'global'`,任意队友击倒失衡都开窗);`:53-70` 潜能1 onSpRecovery 触发型叠攻;`:284-293` 大招 SP 回复内联 `.map(x => x*0.33)`。

**机制本质**:G9 全局状态开窗(敌方失衡边沿)+ G1 队伍事件 + G3 延长。

**C**:`ExtendBuff` 语义已实现为"到期计时租约"(§12 第 7 条:只延后到期,不冻结周期动作;重叠技能分别持有/释放租约);"刷新与延长不是重新施加两次"验证项(§3);敌方失衡边沿(`OnPoiseZero` 49 组)已从缺生产者转 complete(§14.4)。

**缺口**:全队 link(协击)的共享状态事务(连击 Buff `TEAM_COMBO_BUFF_ID` 4 层已有,协击语义待证);分段回复的量化边界。

### 4.16 捕手 Catcher(`chr_0020_meurs`)— finding 70

**E**:`catcher.ts`(336 行):`:38-54` 天赋2 patchHit 给大招末段追加分段倍率伤害(`multiplierScaling:{multiplier:[[2,3]]}`);`:194-224` 战技起手 1.2s 全队 protection + 命中挂破防 + `spReturn:30`;`:253-268` 连携第二伤害组挂自盾;`:98-118` 潜能5 spReturn 条件化(自身有盾时 +10)。

**机制本质**:G5 子 Hit + G7 护盾快照 + G3 虚弱。

**C**:`WeakAction` 五份数据已走公共 `buff_common_affixes_weak`(§12 第 5 条:正数减伤转有符号 FinalMultiplier,从伤害来源实体读取);"护盾读取命中瞬间快照"被明确保留为独立问题(§12 结尾:"按护盾值派生额外伤害仍属独立的命中快照问题,不能因 ShelterAction 已执行就宣称完成")。

**缺口**:按护盾值缩放的追加 Hit(命中快照策略)未实现;虚弱方向(攻方乘区)已对但快照来源待验。

### 4.17 艾丝黛拉 Estella(`chr_0021_whiten`)— finding 63

**E**:`estella.ts`(333 行):`:27-51` 天赋1 敌方"碎冰"→自身隐匿 tracker,下次战技开局消耗返 SP;`:54-70` 天赋2 **约定标记型特判**——挂 `CRYO_INFLICTION_IMMUNE_ID`('cryo-infliction-immune',值 0 的假状态),消费方在 `data/contingencyContracts/criteriaEffects.ts:37-58`(合约"热失"的寒霜累积对带此标记的受控干员跳过);`:247-291` 连携双伤害组(无凝固低位倍率/有凝固高位+物理易伤);`:305-320` 大招 forced lift 且条件 = 敌方有物理易伤。**双重角色**:她还是全量回归夹具(`runtimeCoverage/runtimeSweep` 全用 estella 当载体)。

**机制本质**:G3 免疫/过滤器 + 敌方 debuff 分支条件。

**C**:免疫是拒绝原因(显式失败),脆弱是敌方状态而非队伍光环(§3 验证项);物理易伤进独立乘区(doc 16 首轮)。

**缺口**:免疫标记的通用表达(拒绝原因进 ledger)已支持,但"合约系统按约定 ID 识别干员"这类 Endaxis 式泄漏在 cleanroom 的对应问题是:免疫语义必须从 AKE 数据推导而非约定字符串。

### 4.18 萤石 Fluorite(`chr_0022_bounda`)— finding 68

**E**:`fluorite.ts`(481 行):`:186-269` 战技"即席爆弹"挂 3s 敌方状态,`onStatusExpire` 与 `onStatusConsumed` **双触发引爆**(readConsumedStacks 按层数放大,两个引爆命中各有独立 ID 供 patchHit);`:211-221` 战技 effects 持续光环(爆弹存在时敌方减速);`:335-398` 连携按霜/自然附着 ≥2 层挂互斥 tracker;`:457-473` 大招 duringAction 给战技 +30% 直伤(**跨技能增益**)。

**机制本质**:G3 **退出原因分叉**(expire 与 consume 引爆不同)——doc 17 §6.1 状态事务显式 exitReason 的动机样本("过期爆炸 vs 消费爆炸")。

**C**:`DoOnce`/`SlowAction` 在 §3 标记缺口;"expire、consume 互斥且只爆一次"验证项;消费事务已支持 exitReason 分叉(§15)。

**缺口**:DoOnceAction(一次性派生)未实现;跨技能增益(战技直伤 +30%)的乘区归属验证。

### 4.19 安塔尔 Antal(`chr_0023_antal`)— finding 50

**E**:`antal.ts`(396 行):`:3-37` 用代码生成 8 个"附着/物反 tracker"互斥 consume(任一触发清掉其他 7 个);`:39-68` 连携效果按 tracker 条件复制对应状态;`:148-186` 潜能5"Focus 20s 结束→重新以 +4% 挂 40s"的 onStatusExpire + derived + 防死循环标记(注释解释防重入);`:273-283` 战技挂 battle focus(电/火易伤 REPLACE);`:292-316` 连携窗口 = 敌方上 10 种状态且自身 focus 存活。专项测试 `antalComboWindow.test.ts`。

**机制本质**:G3 replace stacking + G2 派生属性 + G1 开窗(敌方状态施加 + 自身状态存活复合条件)。

**C**:`VulnerableAction` 已映射为"脆弱"进独立乘区(§12 第 4 条);窗口"只在 Focus 存活期间、由敌方状态施加打开"的验证项(§3)。

**缺口**:tracker 互斥 consume 的通用表达(消费一个→取消同族其他)尚无原语;防重入派生的租约验证。

### 4.20 阿列什 Alesh(`chr_0024_deepfin`)— finding 83

**E**:`alesh.ts`(416 行):`:24-56` 天赋1 双 onStatusApplied 触发器(凝固/源岩结晶时全队回能,自身凝固再回一次,`icd:3`);`:62-101` 潜能1 一次性 patchEffect 修补 4 个效果 ID(各加 10 SP);`:259-305` 战技按敌方寒霜附着层数(exact 1/2/3/4)阶梯回 SP(四个条件效果);`:313-332` 连携窗口 = 五种异常反应被**消耗**时;`:360-386` subSkills 定义强化连携(该 ID 成为全引擎 skillId 过滤机制的文档范例)。

**机制本质**:G1 订阅(状态施加/消费双源)+ G7 资源阶梯 + G4 子技能。

**C**:`ForceSpellStatusAction` 事务化(§3);"资源先后顺序及窗口 cohort"验证项;元素反应消耗事件已闭环。

**缺口**:五类异常反应消耗开窗的连携规则录入(§12.8"敌方状态消费"事件族:阿列什在列);subSkills 的强化连携依赖 `CastSkill` 子技能事务(卡缪链路的同款缺口,§16)。

### 4.21 阿德莉亚 Ardelia(`chr_0025_ardelia`)— finding 86

**E**:`ardelia.ts`(317 行):`:54-61` 潜能3 patchTick 把大招 tick hitCount 5→6;`:225-245` 连携窗口 = `onFinalStrike`(全局重击)且敌方**没有**易伤/四种附着时;`:275-279` 连携命中挂腐蚀(自定义 duration:7);`:296-305` 大招多段 tick 的 stagger 与 durationExtension **函数式按段定义**。

**机制本质**:G6 逐段条件 tick + G3 腐蚀反应 + G2 否定条件开窗。

**C**:`VulnerableAction` 类型过滤验证("同一 debuff 对全队匹配伤害类型生效",§3);腐蚀走公共元素表(初始 -0.048、每跳 -0.0112、上限 -0.24、15s 完整回滚五抗,§12 第 15 条);`TriggerComboSkillAction` 六处公开节点含阿德莉亚 BuffData(§12.12)。

**缺口**:否定条件(敌方无状态)在连携规则 schema 已支持(Not),规则录入待 E2 证据;逐段 stagger 的编译等价。

### 4.22 终仪 Last Rite(`chr_0026_lastrite`)— finding 78

**E**:`last-rite.ts`(433 行):`:13-14` **独有布尔字段** `acceptTeamUltEnergy:false`/`acceptSelfSpCostUltEnergy:false`(不吃队友充能;引擎消费点 `simulator.ts:547`、`compileEndaxisScenario.ts:104-120`);`:26-64` 天赋1 四种附着被消耗时按消耗层数线性叠霜易伤;`:79-105` 潜能1 低温灌注存在时全队重击增伤+失衡值(条件型队伍光环);`:235-300` 战技施放即返 SP + 全队挂灌注,triggers = 全局重击→消耗队友灌注触发"幻象追击"(`consumeTarget:'team'`);`:341-380` 连携倍率与大能量回复按敌方霜附着层数 scaling 并 consume 全部。`utils/hitModel.ts:253` 注释引用灌注作为 displayType 遮蔽范例。

**机制本质**:G3 施法生命周期 + G10 team target 消费 + G5 幻影子 Hit(来源归属)。

**C**:"施法取消/结束清理与幻影 source attribution"验证项(§3);非空 `switchToBuffConfig` 与卡缪共享同一编译缺口(§16.2:Last Rite 也使用该结构)。

**缺口**:`switchToBuffConfig` 编译(六字段身份契约的一部分);team 消费(消耗队友的状态)的通用原语;acceptTeamUltEnergy 类字段在 AKE 数据中的对应物待查。

### 4.23 汤汤 Tangtang(`chr_0027_tangtang`)— finding 100

**E**:`tangtang.ts`(566 行):`:27-106` 天赋2 "古视"被消耗→按自身水涡层数放大触发"水龙卷"DoT(`skillLevelKey:'battleSkill'` + `consumedStatEffects` 消耗时转加成);`:350-428` 战技同款水龙卷(倍率/SP/易伤全部按水涡层数 scaling);`:480-557` 大招挂古视 DoT(`duration:3.99` 注释"prevent last tick"防最后半跳),triggers = 到期引爆 + **`onDive`(全局下潜)提前引爆**;`:431-478` 连携挂水涡。泄漏:`statusOptions.ts:65` 手工别名;`criteriaEffects.ts:497` 把古视列入 CONTROL_STATUS_IDS。专项测试 `dotSkillType.test.ts`。

**机制本质**:G6 DoT 调度(快照/防尾跳/提前引爆)+ G3 消费层缩放 + G1 全局事件(下潜)。

**C**:"重点校准两次战技分别施加几层寒冷,不能用图标数猜"(§3);水龙卷的 opt-in skillType 传播是 Endaxis 专项;汤汤的 `OnOutputBuff` 监听内按状态条件跳转原技能时间轴(§12.3 表)。

**缺口**:下潜事件(`onDive`)在 AKE 数据中的对应生产者未证实;两次战技的寒冷层数校准仍 evidence 级;`Duration:3.99` 的防尾跳语义(右开边界)已有时钟域支持但逐跳验证未完。

### 4.24 洛茜 Rossi(`chr_0028_wulfa`)— finding 328(全库最高,近期工作焦点)

**E**:`rossi.ts`(688 行):`:24-57` 天赋1 patchHit 塞"利爪痕"DoT(`snapshot:true, cancelOnRefresh:true`)+隐藏增伤;`:59-93` 天赋2 命中追击火伤(敌方有利爪痕时,燃烧存在 ×1.5 conditionalScaling,`scaleByCrit:true`);`:315-356` 战技条件伤害组(敌方破防时追加 4 段);`:362-402` 连携窗口双触发(破防+附着同时存在的两个方向);`:404-598` 连携**双段 segments**(gap 0.5):第一段挂 0.516s 倒计时与 combo window,第二段开局 consume 完美时机获暴击加成、按 4 种附着层数放大并全部消耗;`:599-617` triggers 倒计时到期→挂完美时机;`:433-434` **TODO 注释自白**:"二段连携窗口目前未与两段连携技对应起来"。**组件级特判**:4 个组件(ActionItem.vue:274、TimelineGrid.vue:678、TimelineShareCard.vue:312、MobileTimelineViewer.vue:2044)各一份 `PERFECT_LINK_STATUS_IDS` 硬编码画"完美连携"高亮。

**机制本质**:G9 两段连携 + G11 确定性随机(利爪痕) + G3 快照 DoT + 精准时机窗口——doc 17 §12.9 称之为"上述分层的最小压力测试"。

**C**:**全库最深入的通用化样本**(§12.7–§12.13、§12.15–§12.16 七节落地):`PauseComboSkillTime` 暂停租约(重击区间冻结 pending 与监听 Buff);连携规则 schema v5 复合条件(破防 AND 任一附着,两种到达顺序都开窗);`TriggerComboSkillAction` 接续开窗事务(37 帧换槽→同帧 trigger→38 帧释放,冷却旁路只属于被选中的 pending);`OnRemoveAllPendingComboSkill` owner 集合边沿事件(use-timer 提前结束:216 帧消费 vs 217 帧兜底);无限换槽不能自我撤销(Infinite 换槽是持久状态)。**核心纪律:Endaxis 的 TODO 是"未闭合反证",不能复制它的手写窗口规则冒充 AKE 语义**(§12.7 表)。

**缺口**:finding 328 中含大量 event-subscription P0(§13.2:洛茜 19→23)——订阅可达性审计最严的就是她;精准时机(`ShowComboRingQte`/timing_success)仅标记不结算;确定性随机(RandomAction/G11)未实现。

### 4.25 波格拉尼奇尼克 Pogranichnik(`chr_0029_pograni`)— finding 147

**E**:`pogranichnik.ts`(658 行):`:3-57` 文件头常量(钢铁誓言的袭扰/决强突击两个条件 damageHit、触发源映射表,全部代码生成);`:79-149` 天赋1 SP tracker(80 层上限 `stacks:'fromConsume'`)→满 80 层转 3 层"高昂士气"(双修饰符 `stackStrategy:'INDEPENDENT'`);`:132-149` 天赋2 appendEffect 把士气效果派生附加到 4 个触发源;`:169-244` 潜能3 阈值 80→60 的 **6 处 patchEffect 联动** + maxStacks 注册(注释详释 INDEPENDENT cap 竞争);`:460-608` 连携按 tracker 层数(exact 1/2/3/4)切换 4 个递增伤害组;`:610-654` 大招全队 5 层钢铁誓言 + 双触发源。

**机制本质**:G7 资源阈值订阅(跨越只触发一次)+ G3 independent stacking + G2 exact 层数分支。

**C**:"阈值跨越只触发一次,破防与资源事件共用时间顺序"验证项(§3);independent stacking 已是 StatusEffectSystem 策略之一。

**缺口**:阈值边沿触发(资源跨越)的通用原语(ResourceSystem 有恢复但无 onCrossThreshold 订阅);exact 层数条件分支依赖 BuffStackCompare(已支持)但四组伤害的规则录入待证;finding 147 偏高。

### 4.26 庄芳仪 Zhuang Fangyi(`chr_0030_zhuangfy`)— finding 140

**E**:`zhuang-fangyi.ts`(890 行,强化期干员之三):`:3-25` 四个强化期 requisite;`:27-149` 按敌方感电层数(0/1/≥2)与"免战"给裂刃挂 1/2/3 层(INDEPENDENT)+ 消耗感电倍率 tracker;`:151-328` **用循环代码生成 9 档×2 伤害组**(裂刃 exact 1~9 对应雷击段数递增,倍率按 tracker `target:'action'` scaling,普通与强化两套共 36 组);`:349-417` 天赋1 战技开局/每次雷击命中叠电增幅到期统一 consume;`:419-462` 潜能1 patchHit 生成命中追加裂刃(999s 隐藏冷却标记);`:666-790` 连携+强化连携 subSkill(强化版 CD 为原值 **/4**);`:792-886` 大招挂"免战"(战技免费 25s)+ 连携 CD **-75%(`percentBasis:'remaining'` 按剩余值)**。手工别名 `statusOptions.ts:66`。

**机制本质**:G4 形态 overlay + G3 independent stacking + G8 **percent-remaining 冷却缩减** + G12 patch 派生。

**C**:`TogglableAction`/tag 操作在 §5.3 标记缺口;ability entity 列名(§3);**关键边界:remaining-basis 冷却操作"不得借已实现的 base-basis 百分比猜补"**(§12 第 24 条结尾)——庄芳仪的按剩余 CD -75% 正是未实现的 operation,保持 fail closed 而不是用 base-basis 近似。

**缺口**:percent-remaining 冷却未实现(有明确证据、待独立 operation);9 档 exact 层数的规则录入;finding 140 偏高。

### 4.27 弭弗 Mifu(`chr_0031_mifu`)— finding 155

**E**:`mifu.ts`(417 行):`:24-43` 天赋1 **按 skillId 定向**的直伤乘区(`modifier:'directMultiplier', skillId:'mifu-world-splitter'`,条件 = 敌方物理易伤或已失衡);`:262-323` 战技**三段分段技能**(普通段返 SP50 / 50SP 段 / 50SP 强化段,命中 `treatAsReaction:'crush'`);`:46-64` 天赋2 连携开局自盾(icd:60);`:393-404` 大招两命中 weight 2/5 权重分配。测试:`simulator.test.ts:1915-1921`(两段倍率 200/500)、golden 10 处。

**机制本质**:G4 条件形态选择(第三段由状态自动选择)+ G5 反应别名 + G2 目标状态分支。

**C**:`PauseBuffTime` 缺口列表在列(§5.3:莱万汀、洛茜、米芙);"第三段由状态自动选择"验证项(§3);"弭弗特殊猛击"数值 evidence-missing 保持不猜(§12 结尾);`TakeDownAction`、目标 provider 在 §3 缺口列表。

**缺口**:三段技能的段选择(状态驱动)依赖 switchToBuffConfig 同款编译;特殊猛击 evidence-missing;finding 155 全库第三高。

### 4.28 诀 Arcane(`chr_0032_lizhiyan`,烛渊)— finding 182(全库第二)

**E**:`arcane.ts`(1,144 行,**全库最大 sheet,唯一多形态干员**):`:237-239` `forms.selector:{kind:'attributeCompare', left:'intellect', right:'will'}` 按智力/意志高低自动选形态;`:60-82` 两个 SkillRequisite(大招需要 gloompurge-arcana-ready 或不在强化期,含冷却豁免分支);`:371-390` 连携挂禁锢(减速)+自然/霜易伤;`:399-501` 战技命中引爆禁锢(consume + 5 段激光,权重 0.6×4+2.6);`:548-556/978-986` 大招挂 array + 隐藏 2 层集束打击计数器;`:594-657/1030-1094` 队友终结技/处决触发 4 激光,onStatusConsumed 计数归零给"大招免耗";`:103-106` trustAttributeBonus 信赖加成字段。专项测试 ×3(集束打击/禁锢易伤/patch 等级上限)。

**机制本质**:G4 selector/form + G3 owner 消费计数 + G5 子动作簇——doc 17 §3 定性:"诀不是独立引擎,只是原语组合压力测试"。

**C**:`CastSkill`(大招免耗的依赖)、ability entity、VulnerableAction 在 §3 缺口列表;诀的 event-subscription blocker 从 42 增至 52(§13.2:审计变严,不是行为回归)。

**缺口**:`CastSkill` 子技能事务未实现(卡缪链路同款);属性比较形态 selector 在 cleanroom 的对应物(SwitchModeAction 只覆盖状态驱动,属性比较待证);计数器 Buff(集束打击)的 owner 消费;finding 182 全库第二高。

### 4.29 卡米尔 Camille(`chr_0033_camille`)— finding 145

**E**:`camille.ts`(508 行):`:44-63` 天赋1 双触发(追击末段命中/burst-lag 到期→全队 link+自疗);`:66-98` 天赋2 onStatusApplied **按修饰符匹配状态**(`status:{modifier:'heal'}`——被治疗时上分层火伤,teamExcludeSelf 半价);`:316-341` 战技双形态伤害组(未处于追击态挂易伤+隐藏 weaken,处于追击态打 4 段追击 `treatAsSkillType:'comboSkill'`);`:376-411` 战技 triggers 连携末段命中→0.4s 延迟 burst→到期转 damageHit;`:485-493` 大招末段挂 hunter-pursuit-ready(战技 SP -100%)。专项测试 `statusRecipientScope.test.ts`(治疗受益人分层)。

**机制本质**:G1 末段事件 + G5 延迟爆伤 + **"战技输入、连携结算"的身份分层**——doc 17 §16 的完整案例。

**C**:**假成功探针的当事人**(§16.2):终结技正确挂形态 Buff、战技正确换槽、命令 `success=true`,但 **0 Hit、无 combo2 Buff、无队伍连击、`unresolvedEffectCount=0`**——UI 无法从运行结果识别空执行。根因两个通用缺口:`compileSkill` 丢弃非空 `switchToBuffConfig`;`CastSkill` 编译为 UNSUPPORTED。修复契约已冻结(§16.3 六字段身份:`inputCommandType/inputSkillId/executedSkillId/effectiveSkillType/rootCastId/parentCastId`),实施待做。卡米尔 HP-zero listener 已随 `OnOwnerHpZero` 闭环(§13.4)。

**缺口**:六字段身份契约与 switchToBuffConfig/CastSkill 编译是当前最大的通用引擎缺口(同时阻塞终仪、梨诺、诀、庄芳仪);finding 145。

### 4.30 梨诺 Liino(`chr_0035_liino`)— finding 140

**E**:`liino.ts`(796 行,机制最复杂之一):`:3-9` 两种"声部形态"任一存活的或条件;`:330-343` 战技 requisites(不在形态中才能开)+**自定义冷却键**(形态终结后 3s CD);`:388-409` subSkills 定义 `group:'nonSkill'` 的"形态终止"动作(0 SP 0 伤害,唯一 nonSkill 干员);`:77-113` 潜能1 开战送一次性免费战技(battleSkillSPCostReduction 100%,用后 consume);`:410-511` 战技 triggers 三个**自续期倒计时状态**(10s/3s,到期触发伤害/治疗→再挂自己,全部被形态存活条件约束);`:580-745` 大招挂"宇宙声"形态+1.5s 倒计时循环,**`enhancementTime:'liino-cosmovoice-stance'`(字符串型强化期,跟随状态存在)**——引擎为此实现了状态绑定强化窗口(`SimulationEngine.ts:406-420` 通用机制);开大终结全队歌手形态(`consumeTarget:'team'`)。专项测试 ×3(倒计时边界/nonSkill/触发器去重)。

**机制本质**:G3 自续期倒计时 + G4 状态绑定强化期 + G1 onBattleStart + 非技能动作 + 强制导电(零层消费)。

**C**:`ForceSpellStatusAction` 的 `consumedLayer=0` 直接制造导电(§12 第 10 条:"梨诺的零层消费因此可以直接制造导电");技能时间窗 AddTagAction 已闭合(§3);`EventListenerAction`/`ChannelingCasting` 需完整生命周期场景测试(§3);梨诺的 `TriggerComboSkillAction` BuffData(§12.12)。

**缺口**:`ChannelingCasting`(引导施法)未实现——这是 doc 16 第二轮修复的三个根因之一(汤汤寒冷附着缺失的同族问题);Buff/Event tag lifetime(31 处 BuffData AddTagAction 保持 unresolved);倒计时循环的收敛验证(Endaxis 专项测试给了测试维度:无终点线也收敛、19 跳/5 跳精确计数)。

### 4.31 Endaxis 未覆盖的角色说明

Endaxis 的 30 个 sheet 对应 AKE 的 31 个 chr 条目(大端员男女共享一个 sheet)。doc 17 §12.8 的连携事件族表格中还提到"艾米尔、昼雪、别礼、秋栗、黎风"等中文名——它们分别是 avywenna/snowshine/last-rite/akekuri/lifeng 的另一种译名,不是额外角色。**当前 31 个 chr 全部通过 assembler 自动装配并可执行**,没有"走不通"的角色,差距只在逐干员 blocker 数量。

---

## 5. 通用引擎不健全审计

以上逐角色缺口汇总为七类系统性问题。**核心结论:引擎的不健全不在伤害公式,而在"机制没有通用执行路径"与"事件没有生产者"**——公式本身已可复算(§18 factor snapshot),但喂给公式的状态可能根本没有被正确的机制产生。

### 5.1 覆盖率数字的欺骗性

最新全库审计(`ake-action-coverage.json`,2026-08-28):

| 指标 | 数值 | 说明 |
| --- | ---: | --- |
| Skill/BuffData 文件 | 3,517 | 含全部公开语料 |
| 动作出现次数 | 27,289 | 164 种动作类型 |
| executable | 9,114 | 完整编译执行 |
| metadata-only | 11,075 | 表现类,记录不执行 |
| unresolved | 7,100 | **含真正的 blocker** |
| calculator-core 可执行路径覆盖率 | ~96.6% | doc 17 §12.14 |

**96.6% 不能按角色外推**。doc 17 §5.1 的论证仍成立:一个角色只要有一个关键 `InheritBuffAction` 未执行,整套形态就错误;数百个镜头/曲线动作的 unresolved 淹没真正的 blocker;测试若只断言"生成了 Hit"或"没有抛异常",不会发现少施加一层状态。这就是为什么逐干员审计(operator audit)必须作为独立事实存在——总覆盖率回答"库"的问题,operator audit 回答"角色"的问题。

### 5.2 unresolved 六级重分类:当前分布

`ake-operator-mechanism-audit.json` 总计 3,034 条 finding:

| 分类 | 数量 | 含义与处置 |
| --- | ---: | --- |
| combat-blocking | **289** | 会改变状态/形态/冷却/命中/伤害但无实现 → 对应技能 fail closed |
| combat-partial | 163 | 只执行了一部分或缺 provider → 场景标记 unverified |
| evidence-missing | 422 | 字段语义无法由 AKE 决定 → 建 Calc 探针,**不猜默认值** |
| presentation-only | 389 | 相机/特效/音效 → metadata |
| spatial-assumption | 1,771 | 位移/半径/搜索 → 固定木桩假设下显式降级 |

按优先级:P0=165、P1=635、P2=1,845、P3=389。289 条 combat-blocking 是"通用引擎当前不健全"的最硬数字——它们分布在 31 个角色上(人均 ~9 条),没有任何角色是零(最健康的佩丽卡/狼卫也在 46–50 条 finding 量级,但 P0 已清零或接近)。

### 5.3 能力事件生产者缺口(最大结构性缺口)

`ake-ability-event-audit.json`(2026-08-28):

| 指标 | 数值 |
| --- | ---: |
| 事件键总数 | 84 |
| 消费者组总数 | 1,072(BuffData 956 / SkillData 116) |
| **已闭环事件** | 30 种 / 911 组 |
| **缺生产者事件** | 52 种 / 154 组 |
| 非法事件值 | 2 种 / 7 组 |

已闭环 30 种包括 `OnOwnerHpZero`(105 组,§13.4)、`OnPoiseZero`(49)、`OnPoiseRecover`(19)、`OnConsumeBuff`(21,§15.6)、`OnRemoveAllPendingComboSkill` 等。剩余 154 组消费者**可编译但不可触发**——"消费者存在不等于事件可触发"是 doc 17 §13.1 确立的审计原则。剩余头部缺口(按 doc 17 §13.2 口径):`OnOwnerDead`(18,真死提交与 HP 归零尚未分层,fail closed)、`OnAfterOutputPhysicalInfliction`(物理异常前后桥接)、`OnEnterFight`(11)、`OnOutputHeal`/`OnReceiveHeal`(各 7,治疗只写 vital ledger 未发事件)。

### 5.4 连携触发规则的数据断层

31 个角色的连携开窗条件只有 4 条静态 `ComboTriggerRule`(佩丽卡/陈千语/男女管理员)有完整证据(doc 17 §12.8)。根因是**数据面断层**:开窗条件写在 `CharGrowthTable.skillGroupMap` 的中文文本里,SkillData 动作树只能闭包"开窗之后发生什么",不能闭包"何时开窗"。七类公共事件族(重击/处决提交、敌方状态施加或层数、敌方状态消费、其他干员命中、主控受击、资源/实体生命周期、属性形态)已归纳,但逐角色规则录入需要 E1 文本 + E2 边界探针双证据,缺 E2 时只能标 `public-data-derived`。**这不是引擎缺口而是证据工程缺口**,但它直接表现为"画布把大量连携判为没有合法释放空间"。

### 5.5 卡缪身份分层:最大的单一编译缺口

`compileSkill` 丢弃非空 `switchToBuffConfig` + `CastSkill` 未支持(§16.2)。影响的不是一个人:终仪、梨诺使用同款 switchToBuffConfig;诀、庄芳宜共享 CastSkill。**症状是假成功**:命令 success、0 Hit、unresolvedEffectCount=0——审计报告看不到,UI 看不到,只有行为差分能发现。六字段身份契约已冻结(§16.3),实施待做。这是当前 P0 中的 P0。

### 5.6 双状态机与双执行链的残留分叉

- **Poise/Resilience 分叉已修**(doc 17 §14.4):Poise 只进 PoiseSystem,四个 Calc 恢复帧对齐。残留:`OnPoiseKnotBreak` 4 组消费者无证据不许命名;快速破韧保护"核心标量 vs 可见 Buff"谁拥有数值待冻结(双倍乘区风险);部位韧性/多韧性条/特殊 boss 节点未逐模板审计。
- **精确链/通用链仍是两套代码**:精确链(佩丽卡逐帧对拍)与通用链(31 角色自动装配)共享 parser 与连携机,但资源/Buff/失衡是两套实现。统一是 doc 15 的方向,未完成前"精确对拍"的保证范围只有佩丽卡系用例。

### 5.7 fail-open 残留与审计盲区

- **空执行不可见**(§5.5 卡缪案例的普遍化):`unresolvedEffectCount=0` 不等于"全部执行",还可能是"该编译的结构被整个丢弃"。审计器对结构性丢弃(整段 switchToBuffConfig 不进编译)不报警——这是当前审计工具自身的盲区。
- **审计器只查 Skill 内嵌 listener**:严格的 emitter 检查曾只覆盖 SkillData `EventListenerAction`,不查 BuffData 顶层 `abilityEventAction`(doc 17 §12.16 末尾);`audit:ake-ability-events` 补上了三条消费者路径,但"生产者存在"仍以运行时证明为准,静态审计与运行时可达之间有缝隙(§12.14:"若干 Trigger 动作所在 Buff 在单角色隔离探针中也未必能达到")。
- **一个训练动作序列化在 IfElse.conditionAction 条件之后**(§12 结尾):以 condition/action sequencing gap 明示,不能冒充已执行。

### 5.8 与 Endaxis 的成熟度差距总表

| 能力 | Endaxis(专门代码) | cleanroom(通用模型) |
| --- | --- | --- |
| 31 干员可排轴出数 | ✅ 全部 | ✅ 全部可执行,但 289 blocker 影响正确性 |
| 复杂机制表达 | ✅ 手写保证(每人一份代码) | ⚠️ 原语覆盖逐步补齐(G1–G12 已落大半) |
| 逐帧数值对拍 | ❌ 无 oracle 概念 | ✅ 佩丽卡系严格相等;跨角色对拍部分覆盖 |
| 数据版本锁定 | ❌ 手填无版本 | ✅ sources.lock.json SHA-256 |
| 新角色边际成本 | 高(人工 sheet) | 低(assemble 自动)+ blocker 暴露 |
| 防角色特例回归 | ❌ 无此测试维度 | ✅ L3 跨角色变形测试(状态 ID 任意替换结果不变) |
| 假成功防护 | ❌ 无(机制缺失=静默不触发) | ⚠️ 建设中(fail closed 原则已立,结构性丢弃仍盲) |

## 6. 健全度总评

通用引擎的健全度按维度评级(2026-08-28):

| 维度 | 评级 | 依据 |
| --- | --- | --- |
| 伤害公式与乘区 | **健全** | 14 语义乘区、factor 复算硬校验、虚弱/庇护/易伤方向修正 |
| 状态生命周期事务 | **基本健全** | apply/refresh/extend/pause/inherit/consume/expire + exitReason;31 处 BuffData tag lifetime 未闭环 |
| 冷却/资源事务 | **基本健全** | 六种冷却 operation 中 5 种已实现(percent-remaining fail closed);资源 cohort 待完整化 |
| 能力事件系统 | **不健全** | 52/84 事件缺生产者,154 组消费者不可达 |
| 连携规则覆盖 | **不健全(证据缺口)** | 4/31 静态规则;事件族已归纳,录入缺 E2 证据 |
| 形态/子技能执行 | **不健全(最大缺口)** | switchToBuffConfig/CastSkill 丢弃 → 假成功 |
| 空间机制 | **设计内不健全** | 1,771 spatial-assumption 显式降级,木桩假设 |
| 审计与防回归 | **健全且持续改进** | 三份审计产物 + L0–L6 测试体系 + 每提交 9 条门槛 |
| 防特例纪律 | **健全** | 核心无 characterId 分支;语义映射中角色 ID 仅限连携规则(合法数据) |

**一句话总评**:这套通用引擎已经证明了"范式可行"(31 角色零核心特判、机制按证据逐条通用化),它的不健全是**工程进度的函数而不是架构的函数**——每一个 blocker 都有明确的原始数据证据、冻结的契约和 fail-closed 的处置,没有一个缺口需要靠"写一个角色分支"来临时补。这与 Endaxis 的 laevatain `if` 分支形成对照:专门代码范式的缺口最终只能堆叠特判,通用模型范式的缺口以可审计的方式排队。
