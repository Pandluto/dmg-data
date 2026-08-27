# 状态机、引擎与前端正确性专项研究

> 研究日期：2026-08-27（Asia/Shanghai）
> cleanroom 基线：`b97ff736b76b578f9b41fa87b760b734c3d77b78`
> Endaxis 对照基线：`66bb80be8c07bf8b27c2606c220836f5537bf664`
> 原 dmg-end-field 对照基线：`a4095b06be945a0d6c2085cf06a1476733f3b540`
> 本文只研究状态机、计算引擎和前端正确性；不讨论 PLC 导入、加载性能、分享、部署或布局美化
> 本轮只记录问题、实现方式与逆向测试方法，不修改功能代码

## 0. 结论先行

当前最严重的问题不是缺少几个角色特例，而是同一次战斗在三个层次存在多份事实：

1. 根目录 `CombatRuntime + StatusEffectSystem` 执行一份真实运行状态；
2. `akeRealtimeTimeline.ts` 为释放合法性、资源、连携窗口和技能形态再模拟一份预览状态；
3. `fixedDummyStateMachine.ts` 又根据前端 Hit 描述重放破防、碎甲、导电、腐蚀、元素附着、失衡、额外伤害和持续 Buff；
4. `akeRuntimeLedger.ts` 最后根据不完整的服务端字段再次猜测乘区、名称、来源和“当前 Hit 生效”状态。

因此，当前测试即使全部通过，也只能证明每一份局部实现与自己的 fixture 一致，不能证明以下三个等式成立：

    预览状态 == 运行时状态
    运行时伤害 == 逐项 DamageFactorSnapshot 的乘积
    UI 展示 == 同一个运行时 Hit 报告

本轮得到的核心判断如下：

- `fixedDummyStateMachine` 不是展示适配器，而是会参与旧伤害计算、制造额外 Hit、改变连携触发判断的第二套数值引擎；这是 P0 架构错误。
- 前端状态不按真实时间过期。0.8 秒 Buff 在很后面的节点仍会作为伤害 Buff 生效；这是已执行探针确认的 P0 状态错误。
- 同一 Hit 如果同时携带“物理状态尝试”和“尝试结果”两个描述，前端会把一次事务重放两次。最小探针得到两层破防；这与此前出现的莫名额外层数具有直接结构关联。
- `ApplyCombatStatus` 没有执行编译器携带的 `triggerBuffId`，而是重新手写“无破防则上破防、有破防则上状态”的 shortcut。它虽然能通过一部分猛击 happy path，但返回的 `requested/actual/discarded` 已经失去真实语义，也没有输出消费层数与额外 Hit 身份。
- 未注册 Buff 会被 `StatusEffectSystem` 当作一个无限期、空定义、正常生效的 Buff。缺失依赖被伪装成成功状态，这是 P0 可审计性错误。
- `PhysicalVulnerableDmgIncrease` 能正确进入目标属性并显示 `0.2`，但 `AkeDamageResolver` 不读取它。最小探针中伤害保持 `100 → 100`；这就是“物理易伤看得到但不生效”的确定原因。
- 真实 `buff_common_affixes_weak` fixture 的 `WeaknessDmgScalar / FinalMultiplier / rate=-0.2` 会被当前属性模型直接算成 `-0.2`，随后伤害执行抛出 `RangeError: damage amount must be non-negative`。因此 Weakness 不是 UI 缺字，而是引擎语义未校准。
- 运行时 `modifierSnapshot` 只完整携带攻击属性、攻击方 zone、目标方 zone 和少数聚合量；目标属性、易伤、Weakness、DamageTaken、Shelter、抗性、暴击和配置加成来源均不完整。UI 没有足够数据忠实解释最终值。
- `akeRuntimeLedger` 的元素加成、技能加成、脆弱、连击和失衡仍有硬编码 `0`/`1.000`；同名 Buff 又按中文 label 合并。当前详情面板不是运行时公式账本。
- 当服务端报告缺失、命令失败或报告暂时失效时，`SkillButton` 会无提示回退到旧 dmg 计算器与 fixed dummy。一个运行时非法的技能仍可能显示一套看起来正常的本地伤害，这是 P0 前端正确性错误。
- Endaxis 可以借鉴的是“一个状态处理器、一个伤害 breakdown、所有 UI 读取同一日志”的结构，不是它的具体公式和数据。原 dmg-end-field 可以保留的是成熟的乘区展示和交互壳，也不能继续作为真实状态来源。

正确的升级方向不是继续补角色 `if`，而是建立以下唯一链路：

    AKE/Calc 证据
      → Normalized Combat IR
      → 唯一 Runtime State
      → CombatStatusResolution + DamageFactorSnapshot
      → Runtime Event Ledger
      → 纯 UI Read Model

## 1. 研究边界与证据等级

### 1.1 本文只回答三个问题

#### 状态机

- 一个状态是否只被创建、刷新、消费和过期一次；
- 破防、猛击、碎甲、元素附着、导电、腐蚀、失衡、连携窗口、技能形态和资源状态是否共享同一时间顺序；
- Buff 的 source、owner、carrier、target 和衍生伤害来源是否没有混淆。

#### 引擎

- 每个真实 Hit 是否读取了命中瞬间的状态；
- 每个乘区是否有明确数学身份、数值与来源；
- 额外伤害、状态消费和未解析动作是否能回溯到同一事件。

#### 前端

- 主轴、按钮详情、命中状态和公式是否展示同一份运行时报告；
- 非法、等待、部分执行、未解析和演示模式是否明确区分；
- UI 是否停止自行推断状态或重新计算公式。

### 1.2 明确排除

本轮不把以下问题纳入修复优先级：

- PLC 文件读取与导入；
- 网络请求速度、缓存策略和资源加载；
- 分享链接和移动端；
- 时间轴视觉布局、拖拽手感和组件美化；
- 部署、端口和服务进程。

这些模块以后仍可能影响用户体验，但不能再用来掩盖状态机、引擎和 UI 三者的事实不一致。

### 1.3 四种证据不能混用

| 证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| AKE 原始 JSON | Buff/Skill 的动作结构、条件、持续时间、堆叠配置、原始字段和引用关系 | Calc 最终采用的全部后处理公式与隐藏规则 |
| Calc 黑盒对拍 | 同版本、同配置、同敌人、同轴下的最终行为与数值 | 内部采用了哪段具体源码 |
| 当前本地运行时 | 当前项目真实执行了什么、在哪里丢字段或重复执行 | 游戏/Calc 的结果必然与本地相同 |
| Endaxis | 成熟项目如何组织状态事务、来源和 DamageBreakdown | AKE/Calc 的权威公式与数值 |

本文问题标记使用：

- **已确认**：源码与最小可执行探针共同证明；
- **高风险**：源码存在确定缺口，但需要真实角色/Calc 用例确认用户可见影响；
- **待逆向**：不能凭字段名冻结数学语义，必须做黑盒单变量实验。

## 2. 当前真实调用链

### 2.1 释放合法性与运行时并非同一执行器

当前链路实际是：

    React 画布
      ↓
    buildAkeRealtimeTimeline()
      ├─ 自己计算 ATB / USP / 动作接续 / 普攻段数
      ├─ 自己维护 pendingCombos / cooldowns / forms
      ├─ 调用 fixedDummyStateMachine 判断破防触发
      └─ 生成 requestedFrame 与 shared-variable-rate 投影
      ↓
    runAkeTeamCalculation()
      ├─ 读取预览生成的 requestedFrame
      └─ 请求根目录 AkeSquadScenarioRunner
            ├─ CommandAdmissionProvider
            ├─ ComboTriggerMachine
            ├─ CombatRuntime
            └─ StatusEffectSystem
      ↓
    前端拿到 report
      ├─ 资源/Hit 部分优先显示 settled runtime
      ├─ 连携窗口仍显示 preview comboWindows
      └─ 详情由 akeRuntimeLedger 再映射

具体证据：

- `demo/lts-ui/src/integrations/ake/akeRealtimeTimeline.ts:755-1654` 是一套完整预览模拟器；
- `akeRealtimeTimeline.ts:800` 创建前端 fixed dummy；
- `akeRealtimeTimeline.ts:1157-1188` 用 fixed dummy 的破防变化合成连携观察事件；
- `demo/lts-ui/src/integrations/ake/akeProvider.ts:637-665` 先跑预览，再把预览帧发给服务端；
- `src/core/ake-squad-scenario-runner.mjs:489-1143` 服务端又独立执行连携、准入和技能；
- `demo/lts-ui/src/components/CanvasBoard/components/CanvasArea.tsx:696-698` 无论是否已有 settled report，连携窗口仍来自 realtime preview。

所以，“UI 上连携合法/非法”和“服务端最终执行成功/失败”目前可以来自不同状态机。

### 2.2 技能详情有两套数值来源

`SkillButton.tsx` 同时构建：

- `akeRuntimeLedger`：服务端报告存在且命令成功时使用；
- `calculateSkillButtonDamageV2`：始终在后台继续计算旧 dmg 结果；
- `fixedDummyContext.modifierBuffs`：作为旧计算器 Buff 输入；
- `fixedDummyContext.mechanicAnomalyDamages`：作为额外伤害输入；
- 手动 anomaly/status 卡：运行时存在时标成“演示状态”，运行时不存在时直接参与计算。

关键代码：

- `SkillButton.tsx:1121-1149` 同时创建 fixed dummy context 与 runtime ledger；
- `SkillButton.tsx:1262-1277` 把 fixed dummy Buff 和机制伤害接入旧计算器；
- `SkillButton.tsx:1384-1432` 继续执行 `calculateSkillButtonDamageV2`；
- `SkillButton.tsx:1755-1768` 有 runtime ledger 就显示 runtime，否则显示旧计算器结果；
- `SkillButton.tsx:2625-2676` 把 runtime、演示状态和 fallback 状态拼进同一区域。

这不是安全降级。它会把“运行时没有结果”“运行时拒绝”和“用户主动进入手动演示”都压缩成同一个 `akeRuntimeLedger === null`。

### 2.3 前端 fixed dummy 是数值状态机，不是只读视图

`fixedDummyStateMachine.ts` 明确写死：

- 四档碎甲/导电数值；
- 腐蚀点数；
- 30% 失衡区；
- 100 点固定韧性；
- 400% 源石结晶击碎；
- 猛击 `150 × (1 + level)%`；
- 碎甲异常伤害 `50 × (1 + level)%`；
- 所有击飞/倒地都按不可控首领失败处理；
- 多种状态持续到整条排轴结束。

它还会：

- 根据 `id + displayName` 的字符串包含关系猜状态类型；
- 根据前序按钮顺序重放状态；
- 生成 `SkillButtonBuff` 进入旧伤害公式；
- 生成“真实机制”额外 Hit；
- 影响预览连携窗口。

因此文件名中的 `fixedDummy` 并不能降低其权威性；它目前实际承担了第二执行器的角色。

## 3. 本轮可执行探针

### 3.1 选择性回归基线

本轮重跑：

- 根目录 `ake-action-compiler`、`ake-squad-scenario`、`demo-calculator-policy`：37 个测试通过；
- 前端 `akeRuntimeLedger.test.ts`、`fixedDummyStateMachine.test.ts`：2 个测试模块通过。

这些结果说明当前代码内部是稳定的，但也暴露测试目标有误：

- fixed dummy 测试明确断言 750%、450%、400% 等前端写死值；
- ledger 测试用人工构造的 `defenderZone.scale=1.2` 断言“物理易伤”；
- 没有测试 `PhysicalVulnerableDmgIncrease` 的真实 runtime fixture；
- 没有测试同名不同来源 Buff、同帧多 Hit、runtime rejected 后 UI 是否错误 fallback；
- 没有做“root runtime report → UI view model”逐字段恒等测试。

所以这些测试通过，不能作为产品链正确的证明。

### 3.2 探针 P-01：缺失 Buff 被伪装成成功状态

输入：在未注册任何定义时执行 `ApplyBuff(buff_missing_probe)`。

实际结果：

    instanceId: status:1
    buffId: buff_missing_probe
    stackingPolicy: Refresh
    stackCount: 1
    durationTicks: null
    expireFrame: null
    active: true
    trace stage: StatusEffectApplied

原因：`status-effect-system.mjs:34-36` 对缺失定义返回 `{}`，随后套用默认 Refresh/max1/无限期规则。

判定：**已确认，P0。** 缺失依赖必须产生 Unresolved，不能创建一个看似正常的永久 Buff。

### 3.3 探针 P-02：物理易伤属性存在但伤害不变

输入：

- 攻击方 `Atk=100`；
- 目标 `Def=0`；
- 基础物理 Hit 倍率 100%；
- 应用真实 `buff_common_affixes_vulnerable_physical`；
- fixture 的 `PhysicalVulnerableDmgIncrease BaseAddition rate=0.2`。

实际结果：

    应用前伤害: 100
    目标 PhysicalVulnerableDmgIncrease: 0.2
    应用后伤害: 100

原因：`ake-damage-resolver.mjs:260-285` 读取 DamageTaken、Weakness、Shelter、attackerZone 和 defenderZone，但没有读取任何 `*VulnerableDmgIncrease`。

判定：**已确认，P0。** 这不是命名问题，而是 resolver operand 缺失。

### 3.4 探针 P-03：真实 Weakness fixture 产生负伤害

输入：应用真实 `buff_common_affixes_weak` 后执行同一基础 Hit。

原始数据：

    attributeType: WeaknessDmgScalar
    formulaItem: FinalMultiplier
    blackboard rate: -0.2

当前属性结果：

    WeaknessDmgScalar = 1 × -0.2 = -0.2

随后运行时抛出：

    RangeError: damage amount must be non-negative

原因：`EffectSourceRegistry` 和 `buildAkeAttributeComponents` 都把 `FinalMultiplier` 的 raw value 直接乘入；`AkeScenarioAssembler` 又把目标基础 Weakness 设为 1。至少这三个假设有一个不符合该真实 fixture 的 AKE 语义。

判定：**已确认存在 P0 引擎错误；正确换算仍待 Calc 黑盒校准。** 不能未经对拍直接把所有 FinalMultiplier 改成 `1 + rate`，因为其他属性也使用该 zone 且 raw 数据语义未必一致。

### 3.5 探针 P-04：0.8 秒状态在前端永久存在

输入：

- 节点 0 施加 `durationSeconds=0.8`、`physicalFragile=0.2`；
- 在节点 300 构建 fixed dummy context。

实际结果：

    targetEffects 仍保留该 effect
    modifierBuffs 仍包含 value=0.2
    condition: 前序事件已命中；当前木桩模型固定持续到排轴结束

原因：`reduceFixedDummyState()` 只比较 `nodeIndex < currentNodeIndex`，没有过期事件；`activeEffectToBuff()` 明确把状态固定到排轴结束。

判定：**已确认，P0。** 该问题会直接改变后续 Hit 数值，不只是状态卡显示错误。

### 3.6 探针 P-05：一次物理状态事务可被前端记成两层

输入：同一个 Hit、同一帧携带：

1. `statusKey=knockdown` 的尝试描述；
2. `statusKey=no-guard` 的结果描述。

实际结果：

    noGuardStacks: 2

原因：前端先对 knockdown 的失败分支主动 `applyStateStatus(no-guard)`，随后又把结果 no-guard 当第二个独立事件。当前去重键只按 `statusKey + frame` 或 effect ID 去重，没有 `stateTransactionId`。

判定：**重复机制已确认，P0；具体哪些真实角色 profile 会同时输出这两个 marker，需要逐角色 integration sweep。** 这正是“明明只有一次尝试却多一层”的高概率来源。

### 3.7 探针 P-06：物理状态事务统计字段语义错误

输入：目标已有两层 `buff_physical_no_guard`，随后执行当前 `ApplyCombatStatus(crush)`。

实际返回：

    before: 2
    requested: 3
    actual: 0
    discarded: 3
    after: 0

真实发生的是：

- 消费两层破防；
- 应用 `buff_physical_crushed`；
- 执行猛击 lifecycle；
- 产生衍生 Buff/动作。

当前字段却把“消费后剩余破防层数”写成 `actual`，把 `before+1` 写成 requested，再把差值写成 discarded。UI 或日志无法用这些字段判断消费了几层、应用了什么状态、生成了哪些 Hit。

判定：**已确认，P0 报告契约错误。**

### 3.8 探针 P-07：EffectSourceRegistry 默认参数会触发 TDZ

调用：

    damageZone({ targetId, side: 'Defender', damageType: 'Physical' })

实际结果：

    ReferenceError: Cannot access 'eventContext' before initialization

原因：第一个参数的默认值引用了后声明的第二参数 `eventContext`。

当前 resolver 因显式传入 attackerId/defenderId 而暂时绕开，但其他调用方或重构后会直接崩溃。

判定：**已确认，P2。**

## 4. 状态机问题清单

### SM-01：存在多份可写战斗状态

**级别：P0，已确认。**

当前可写状态至少包括：

| 状态域 | 根运行时 | 前端预览 | fixed dummy / 旧计算器 |
| --- | --- | --- | --- |
| ATB / USP | ResourceSystem | akeRealtimeTimeline 自己维护 | 旧面板可能另读缓存 |
| 动作接续 | CommandAdmissionProvider | nextAdmission / queuedFrames | 无 |
| 连携窗口 | ComboTriggerMachine | pendingCombos | fixed dummy 破防观察间接参与 |
| 技能形态 | SkillFormStateRegistry | pendingForms / actor form | template fallback |
| 破防/猛击/碎甲 | StatusEffectSystem + shortcut | fixed dummy replay | fixed dummy replay + anomaly card |
| 元素/敌方状态 | StatusEffectSystem / ReactionMachine | timing profile | fixed dummy 永久状态 |
| 失衡 | ResilienceMachine | profile/preview points | 固定 100 韧性 + 固定 30% |

任何一行出现两个以上可写实现，都可能发生预览和结算不一致。

#### 具体改法

1. 根运行时成为唯一可写事实；
2. 前端预览若必须同步计算，只能调用与根运行时相同的纯领域包，不能复制规则；
3. UI 只持有 `RuntimeProjection`，不持有可变 `FixedDummyState`；
4. 旧计算器只能存在于明确的 `manual-preview` 模式，不能作为 runtime 空值 fallback；
5. 连携窗口、资源点、形态、状态徽标和伤害点全部从同一事件 ledger 投影。

### SM-02：前端忽略持续时间、刷新和真实过期顺序

**级别：P0，已确认。**

fixed dummy 保存了 `durationSeconds`，但只把它写进说明文字。它没有：

- `appliedFrame`；
- `expireFrame`；
- refresh generation；
- source-safe expiry；
- 同帧“先过期还是先命中”的 sequence。

#### 具体改法

前端不应修补一个 timer。应删除它的状态所有权，并消费运行时事件：

    StatusApplied(frame, sequence, expireFrame)
    StatusRefreshed(frame, sequence, oldExpireFrame, newExpireFrame)
    StatusStackChanged(frame, sequence, before, after)
    StatusConsumed(frame, sequence, consumedStacks)
    StatusExpired(frame, sequence)

状态查询统一使用 `(frame, sequence)`，不能只比较 frame 或按钮 nodeIndex。

### SM-03：CombatStatus shortcut 绕过原始 trigger 语义

**级别：P0，已确认结构缺口。**

`AkeActionCompiler` 为 Crush/Fracture/KnockDown/Airborne 编译出：

    ApplyCombatStatus {
      triggerBuffId,
      statusBuffId,
      initialBuffId
    }

但 `CombatRuntime.ApplyCombatStatus` 完全不读取 `triggerBuffId`，而是自行判断 no-guard 层数，然后直接 ApplyBuff。

AKE 原始 `buff_physical_try_crushed` 则明确包含：

- CheckBuffStackNum；
- 成功创建 `buff_physical_crushed`；
- 成功后 Finish 全部 no_guard；
- 失败创建 no_guard。

`buff_physical_crushed` 又包含：

- StoreBuffCount；
- ReadSkillSettingData；
- 动态倍率；
- DamageAction；
- FinishBuff；
- interrupt / effect / ignite 等派生动作。

#### 目标实现：CombatStatusResolver

只能二选一：

1. **原始 Buff 模式**：执行 `triggerBuffId` 的编译 lifecycle，以其事件作为唯一事实；或
2. **正规化事务模式**：编译时把原始分支归一成 `CombatStatusIR`，由一个 handler 执行。

不能保留 shortcut、原始 Buff 和前端 replay 三者并存。

建议事务输出：

```ts
interface CombatStatusResolution {
  transactionId: string;
  eventOrder: { frame: number; sequence: number };
  statusKey: string;
  targetId: string;
  triggerActionId: string;
  triggerBuffId: string | null;
  branch: 'stacked-no-guard' | 'consumed-and-triggered' | 'controlled' | 'resisted' | 'unresolved';
  before: CombatStatusSnapshot;
  applied: Array<{ buffInstanceId: string; buffId: string; stacks: number }>;
  refreshed: Array<{ buffInstanceId: string; before: number; after: number }>;
  consumed: Array<{
    buffId: string;
    totalStacks: number;
    bySource: Array<{ sourceId: string; ownerId: string | null; stacks: number }>;
  }>;
  spawnedHitIds: string[];
  after: CombatStatusSnapshot;
  diagnostics: RuntimeDiagnostic[];
}
```

### SM-04：缺失定义被默认为无限期成功 Buff

**级别：P0，已确认。**

#### 具体改法

`definitionFrom()` 应拆成：

```ts
getRequiredDefinition(buffId): BuffDefinition | RuntimeDiagnostic
getOptionalPresentationDefinition(buffId): BuffPresentation | null
```

游戏状态执行不允许 `{}` fallback。推荐策略：

- `strict`：缺定义立即让当前事务 `Unresolved`，不改状态；
- `partial`：记录诊断、跳过该动作，并把受影响 cast/hit 标成 partial；
- `presentation-only`：必须在 definition 中显式声明，不能由缺失自动推断。

### SM-05：前端按 effect 列表重放，缺少事务边界

**级别：P0，已确认。**

同一真实动作可能同时输出：

- 尝试标记；
- 实际应用状态；
- 消费事件；
- 额外伤害；
- 展示 Buff；
- 子 Buff。

当前 fixed dummy 把每一项都当成独立命令，无法知道它们属于同一事务，因此发生重复破防和重复额外伤害。

#### 具体改法

所有派生事件必须携带：

    transactionId
    parentEventId
    rootCastId
    sourceActionPath
    semanticRole: attempt | application | consumption | reaction-hit | presentation

UI 只能展示事务结果，不能再次执行这些 role。

### SM-06：身份模型缺少 carrier 与 damageSource

**级别：P1，已确认。**

当前主要字段是 source/owner/target。`StatusEffectSystem.#executeLifecycle()` 又把 Buff carrier 作为 ActionOwner 传入，把原 attribution owner 放进 payload。这对执行原始序列化动作有理由，但报告层没有把两种 owner 拆开。

四人队、召唤物、武器、装备、敌方 Debuff 和衍生 Hit 至少需要：

```ts
interface EventAttribution {
  sourceId: string | null;       // 本次事件直接来源实体
  ownerId: string | null;        // 技能/装备/Buff 的归属者
  carrierId: string | null;      // 当前携带 Buff 的实体
  targetId: string | null;       // 本次状态或伤害目标
  damageSourceId: string | null; // 衍生伤害实际读取 ATK 的实体
  buffInstanceId: string | null;
  sourceSkillId: string | null;
  rootSkillId: string | null;
  castId: string | null;
}
```

字段必须随事件和贡献向下传递，不能靠 UI 比较 `targetId === hit.sourceId` 猜“自身 Buff”。

### SM-07：固定首领、固定韧性和固定控制失败写在前端

**级别：P1，已确认。**

`fixedDummyStateMachine` 强制：

- 100 最大韧性；
- 不随时间恢复；
- 击飞/倒地永远失败并上破防；
- 失衡固定 30% 乘区。

这些都属于敌人配置和 `ResilienceMachine`，不能成为前端常量。

#### 具体改法

木桩可以继续写死，但应写死在一个明确 `EnemyRuntimeProfile` fixture 中：

```ts
interface EnemyRuntimeProfile {
  enemyId: string;
  maxPoise: number;
  poiseRecovery: number;
  superArmorLevel: number;
  controlImmunityLevel: number;
  baseAttributes: Record<string, number>;
  initialStatuses: RuntimeStatusSeed[];
}
```

然后仍由根运行时执行，而不是 UI 自己解释。

### SM-08：状态语义通过中文名和 ID 子串推断

**级别：P1，已确认。**

`statusKeyFromHitBuff()` 和附件识别函数依赖 `id + displayName` 包含 `破防/碎甲/crush/conduct/...`。这会导致：

- 名称翻译变化即改变行为；
- 同名展示 Buff 被当成可执行状态；
- 长代码名误命中子串；
- AKE 数据版本变更后静默改变状态；
- 无法区分 attempt、active state 和 reaction hit。

#### 具体改法

语义键只能在 compiler/catalog 边界产生：

```ts
type StatusSemantic =
  | 'physical.noGuard'
  | 'physical.crushAttempt'
  | 'physical.crushResolved'
  | 'physical.fractureResolved'
  | 'physical.knockdownAttempt'
  | 'element.pulseAttached'
  | 'reaction.conductive'
  | 'poise.imbalanced';
```

中文名和 icon 都是该键的 presentation metadata，不能反过来决定执行语义。

## 5. 引擎问题清单

### EN-01：PhysicalVulnerableDmgIncrease 未进入伤害公式

**级别：P0，已确认。**

当前字段虽然在 AKE attribute name 列表中，也能被 EffectSourceRegistry 注册和快照，但 resolver 没有读取。

#### 命名要求

用户已经明确：当前讨论的效果是“易伤”，不是“脆弱”。因此不能看到 AKE 英文 `Vulnerable` 就自动映射到原 UI 的 `physicalVulnerability/物理脆弱`。

内部应先使用不带旧 UI 假设的键，例如：

    targetPhysicalDamageTakenIncrease

中文显示为“物理易伤”。它与 Defender `NormalCalcZone` 是同一加法区、不同加法区还是独立乘区，必须通过 Calc 的单变量与双变量测试决定，不能凭名字合并。

#### 具体改法

1. `AkeDamageResolver` 按伤害类型读取对应 `*VulnerableDmgIncrease`；
2. 生成完整 attribute snapshot；
3. 通过已校准的 FactorRegistry 转换为 factor；
4. 将 raw attribute、转换规则、最终 factor 和 source list 写入 Hit report；
5. UI 只读取该 factor，不再硬编码 1.000。

### EN-02：WeaknessDmgScalar 的初始值/FinalMultiplier 语义错误

**级别：P0，错误已确认，正确公式待逆向。**

不能直接采用“全部 FinalMultiplier 都做 `1 + raw`”的通用修复，因为 AKE 其他属性的 FinalMultiplier raw 值可能已经是完整 factor。应建立按 `attribute + formulaItem` 校准的规则表：

```ts
interface AttributeFormulaRule {
  attribute: string;
  formulaItem: string;
  baseSemantics: 'zero-based-rate' | 'one-based-factor' | 'raw-value';
  operandSemantics: 'addition' | 'rate-to-factor' | 'direct-factor';
  evidence: EvidenceReference[];
}
```

Weakness 的最终规则必须由以下三点共同确定：

1. AKE raw fixture；
2. Calc 无 Buff / `rate=-0.2` / 两个来源的黑盒结果；
3. 状态应用前后属性值及最终 Hit 变化。

### EN-03：DamageFactorSnapshot 不完整

**级别：P0，已确认。**

当前 `modifierSnapshot` 只包含：

- attackAttribute；
- attackerZone；
- defenderZone；
- configuredBonus 聚合值；
- configuredDamageBonusScale；
- specialScale。

以下实际参与或应该参与公式的项没有完整 source snapshot：

- target defense；
- target resistance；
- DamageTakenScalar；
- WeaknessDmgScalar；
- ShelterDmgScalar；
- Physical/element Vulnerable；
- crit rate / crit damage；
- all / element / command configured bonus 的各自来源；
- execution / anomaly / combo / imbalance 特殊项；
- 状态消费层数；
- unresolved 对本 Hit 的影响。

#### 具体改法：DamageFactorSnapshot v3

```ts
interface DamageFactorContribution {
  contributionId: string;
  semanticKey: string;
  sourceKey: string;
  sourceId: string | null;
  ownerId: string | null;
  carrierId: string | null;
  targetId: string | null;
  buffId: string | null;
  buffInstanceId: string | null;
  sourceSkillId: string | null;
  rawField: string | null;
  rawFormulaItem: string | null;
  rawValue: number;
  resolvedValue: number;
  stackCount: number;
  appliedFrame: number | null;
  expireFrame: number | null;
}

interface DamageFactorSnapshot {
  factorId: string;
  semanticKey: string;
  displayKey: string;
  operation: 'base' | 'add-rate' | 'multiply-factor' | 'clamp';
  baseValue: number;
  additiveTotal: number;
  multiplierProduct: number;
  finalValue: number;
  contributions: DamageFactorContribution[];
  evidenceStatus: 'exact' | 'calibrated' | 'assumed' | 'unresolved';
}
```

每个 Hit 必须直接携带按公式顺序排列的 factors。前端不能从 operands 与三种 snapshot 再拼一次。

### EN-04：聚合因子破坏了公式身份

**级别：P1，已确认。**

两个典型例子：

1. `configuredDamageBonus()` 把全伤、元素、法术和技能类型加成合并为一个数字；UI 因而只能把元素加成和技能加成写死为 0，再把合计塞进全伤害。
2. `damageTypeResistanceScale` 同时包含 `1 - resistance/100` 与 `damageTakenScalar`；UI 又分开展示“抗性”和“增幅”，但非暴击乘法串只放合并后的 factor。

即使最终值偶然正确，解释也是错误的。

#### 具体改法

引擎应保持 factor identity：

    allDamageBonus
    elementDamageBonus
    commandDamageBonus
    defenseScale
    resistanceScale
    damageTakenScale
    targetPhysicalDamageTakenIncrease
    defenderNormalCalcZone
    weaknessScale
    shelterScale
    comboScale
    imbalanceScale
    specialScale
    criticalScale

是否合并到同一数学区由 FactorRegistry 决定，但 report 仍保留各来源子项。

### EN-05：DamageZone contribution 丢失归属字段

**级别：P1，已确认。**

Attribute contribution 有 sourceId、ownerId、targetId、metadata；DamageZone contribution 只有：

    sourceKey
    sourceType
    buffInstanceId
    side
    zoneName
    addition

结果是武器、三件套、技能、天赋和潜能在进入目标 zone 后，UI 很难稳定区分来源，只能用状态事件或名称猜。

#### 具体改法

Attribute、DamageZone 与专属 factor contribution 必须使用同一个 `DamageFactorContribution`。EffectSourceRegistry 不应为不同 modifier 类型维护不同残缺结构。

### EN-06：额外伤害没有统一 Hit 身份

**级别：P0，高风险且已有局部 happy path。**

根运行时已经能在管理员场景产生主 Hit、猛击 Hit、源石结晶击碎 Hit；这是正确基础。但前端 fixed dummy 仍会自己制造相同概念的 anomaly cards。

目标要求：

- 每个额外伤害都是根运行时 `DamageHitResolved`；
- 有唯一 hitId；
- 有 parentTransactionId；
- 有 `reactionType/sourceBuffId/consumedStacks`；
- 有自己的 DamageFactorSnapshot；
- UI 不能通过卡片描述再算一次。

### EN-07：Unresolved 没有绑定到受影响的状态与 Hit

**级别：P0，已确认。**

当前 report 主要给 `unresolvedEffectCount` 和底层 trace。用户无法知道：

- 哪一个技能动作未解析；
- 它本应创建状态、额外 Hit 还是乘区；
- 哪些 Hit 因此不可信；
- 整个命令是 partial 还是完全无效。

#### 具体改法

```ts
interface RuntimeDiagnostic {
  diagnosticId: string;
  severity: 'warning' | 'partial' | 'fatal';
  code: string;
  frame: number;
  eventId: string | null;
  actionId: string | null;
  castId: string | null;
  hitId: string | null;
  buffId: string | null;
  sourcePath: string | null;
  expectedSemantic: string | null;
  effectOnResult: 'none' | 'status-missing' | 'factor-missing' | 'hit-missing' | 'execution-stopped';
}
```

`DamageHitReport.confidence` 由相关 diagnostics 推导，不能只在抽屉底部显示总数。

### EN-08：EffectSourceRegistry 的 API 还不够安全

**级别：P2，已确认。**

除 TDZ 外，还应增加：

- `damageZone()` 参数对象完整校验；
- attacker/defender/target 的显式含义；
- 不允许从 eventContext 隐式猜关键身份；
- contribution schema 与 attributeSnapshot 统一；
- factor 计算不可在 UI 端重新调用 registry。

## 6. 前端正确性问题清单

### FE-01：runtime rejected / pending 会静默回退到旧伤害

**级别：P0，已确认。**

`buildAkeRuntimeCommandLedger()` 在以下情况返回 null：

- report 不存在；
- command 不存在；
- castId 不存在；
- `command.success === false`。

`SkillButton` 遇到 null 后显示 `calculateSkillButtonDamageV2 + fixedDummy` 结果。因此“没有运行时结算”被错误解释为“请用旧计算器补一个答案”。

#### 具体改法

使用判别联合，禁止 null 表达多种语义：

```ts
type RuntimeCommandViewState =
  | { kind: 'pending'; requestId: string }
  | { kind: 'settled'; ledger: RuntimeCommandLedger }
  | { kind: 'rejected'; reason: string; diagnostics: RuntimeDiagnostic[] }
  | { kind: 'partial'; ledger: RuntimeCommandLedger; diagnostics: RuntimeDiagnostic[] }
  | { kind: 'stale'; mismatch: string[] }
  | { kind: 'manual-preview'; preview: LegacyDamageViewModel };
```

规则：

- runtime 模式下 rejected 必须显示 0 个 settled Hit 和拒绝原因；
- pending 显示“等待结算”，不能显示旧伤害；
- partial 显示已有 Hit，但每个缺口可见；
- manual-preview 只能由用户明确进入，不能自动触发。

### FE-02：公式详情包含硬编码假值

**级别：P0，已确认。**

`akeRuntimeLedger.ts` 当前硬编码：

    elementBonusText = 0.0%
    skillBonusText = 0.0%
    vulnerabilityFormulaText = 1.000
    comboFormulaText = 1.000
    imbalanceFormulaText = 1.000

同时把 `attackerZone × configuredScale` 全部显示为“全伤害”。这会让实际生效的技能加成、元素加成或其他因素在 UI 上消失。

#### 具体改法

删除 `buildRuntimeFormula()` 中的数学重建。改为：

```ts
function buildRuntimeFormula(hit: DamageHitReportV3): FormulaViewModel {
  return projectFactors(hit.factors, hit.finalValues);
}
```

如果某个 factor 没有 report 字段，应显示“运行时未提供”，不能显示 1.000。

### FE-03：`showNoBuff` 会在真实有 Buff 时显示“本区没有 Buff”

**级别：P0，已确认。**

`contributionBuffTags()` 只收集：

- attackAttribute contributions；
- attackerZone contributions；
- defenderZone contributions。

所以目标属性易伤、Weakness、DamageTaken、Shelter、暴击、抗性等即使进入运算，也可能不生成 buffTags，随后 `showNoBuff=true`。

#### 具体改法

“有无 Buff”按选中 factor 的 `contributions.length` 判定。整个 Hit 没有来源则看全部 factor contributions，而不是一个有限数组。

### FE-04：按中文 label 匹配会合并不同 Buff

**级别：P1，已确认。**

`buildHitStatusViews()` 建立 `appliedBuffsByLabel`，再用 `metadata.label` 匹配 active status。两个来源不同、instance 不同但中文名相同的 Buff 会：

- 只保留第一项；
- 错把另一实例标成“当前 Hit 生效”；
- 隐藏第二个来源；
- 叠层和 icon 取错。

#### 具体改法

匹配优先级必须是：

    contributionId
      → buffInstanceId
      → sourceKey
      → buffId + ownerId + carrierId + targetId

label 只能展示，不能成为 identity。

### FE-05：同帧多 Hit 与状态事件关联不稳定

**级别：P1，已确认。**

当前 `transitionBelongsToHit()` 在缺少 traceIndex 时回退到同帧第一 Hit；runtime hits 又按 `frame + hitIndex` 排序。飞行物、DoT、额外 Hit、状态先于/后于主 Hit 的同帧场景可能把状态变化挂到错误命中。

#### 具体改法

根运行时应给每个事件统一 `sequence` 和 `parentEventId`。UI 只按 parent/causal link 归属；时间仅用于排序，不再用于猜关联。

### FE-06：Hit 标题按 buffId 找最近事件，可能串来源

**级别：P1，已确认。**

`hitTitle()` 只按 `sourceBuffId` 与 `frame <= hit.frame` 反向搜索状态事件。多角色对同一敌人施加同 Buff 时，标题可能采用另一个实例的 metadata。

#### 具体改法

Hit report 直接输出：

    semanticHitType
    displayNameKey
    sourceBuffInstanceId
    parentTransactionId

前端不再搜索历史事件命名当前 Hit。

### FE-07：运行时与演示状态被放在同一视觉语境

**级别：P0，已确认。**

虽然文字写了“演示状态（不参与运行时）”，但它与“当前 Hit 生效”“本 Hit 状态变化”放在同一个列表，用户必须阅读小字才能判断真伪。更严重的是报告缺失时，同一张卡会从演示状态变成参与计算状态。

#### 具体改法

- runtime 模式完全隐藏手动演示输入，或放进独立“假设实验”页签；
- 用户开启假设后，生成一个新的 scenario variant 并重新跑引擎；
- 不允许同一个 card 根据 report 是否存在改变数学身份。

### FE-08：settled report 的有效性匹配不足

**级别：P1，已确认。**

`activeAkeTeamReport` 当前主要比较：

- commandId + requestedFrame；
- 角色 ID；
- requestedEndFrame。

它没有完整比较：

- 敌人配置；
- 武器、四件装备、三件套；
- 潜能、天赋、技能等级；
- resistance / target 状态配置；
- AKE 数据版本；
- compiler/runtime 版本；
- resolved skill form。

因此配置变化到新 response 返回前，旧报告可能继续被当作当前结果。

#### 具体改法

report 必须携带 `executionDigest`，前端只做完全相等判断。该 digest 至少包含：

    normalized commands
    selected actors
    loadouts
    enemy runtime profile
    global rules
    AKE data hash
    semantic mapping version
    compiler version
    runtime version

### FE-09：连携窗口即使有 settled report 仍来自 preview

**级别：P0，已确认。**

主轴上的 Hit 和资源点会优先采用 settled timeline，但 `comboWindows` 固定从 `akeRealtimeTimeline.comboWindows` 读取。于是用户可能看到：

- 服务端已拒绝连携，但前端仍有窗口；
- 服务端有合法窗口，但前端 fixed dummy 没开窗；
- 窗口时间与实际 status event 不一致。

#### 具体改法

服务端 report 输出 `ComboWindowOpened/Consumed/Expired/Suppressed` 事件；UI 有 settled report 时只投影这些事件。preview 仅在 pending 状态显示，并明确标注“预估”。

### FE-10：来源分组依赖名称启发式

**级别：P1，已确认。**

当前 UI 通过 sourceName、buffId 和若干中文映射猜“天赋/潜能/武器/装备/敌方状态”。DamageZone contribution 又缺少 owner/source metadata，因此长代码 ID 和错误分组不可避免。

#### 具体改法

运行时贡献直接给：

```ts
type EffectSourceCategory =
  | 'skill'
  | 'talent'
  | 'potential'
  | 'weapon'
  | 'equipment'
  | 'equipment-set'
  | 'global-buff'
  | 'enemy-status'
  | 'reaction'
  | 'system';
```

再附 `displayNameKey/iconId`。中文映射表只负责最终本地化，不负责分类。

## 7. 三套项目的正确对比方式

### 7.1 对比结论表

| 能力 | 当前 cleanroom | 原 dmg-endfield | Endaxis | 本项目目标 |
| --- | --- | --- | --- | --- |
| 状态事实 | runtime + preview + fixed dummy | 手动 Buff 快照 | 单一 simulation state | 单一 runtime state |
| 释放合法性 | 前端预演 + 服务端再判断 | 基本不模拟真实世界状态 | simulator 诊断 | 同一 planner/runtime 严格判定 |
| 状态消费 | 部分由 raw Buff，部分 shortcut，前端再重放 | 手动配置 | handler 输出 consumedStacks | 单一事务 + 来源分摊 |
| 伤害乘区 | resolver 字段不足 | 乘区 UI 很完整，但输入靠手填 | DamageBreakdown 字段完整 | AKE 因子完整 + 原 UI 表达能力 |
| 额外 Hit | runtime 可生成，前端也会生成 | 手动 anomaly card | DAMAGE_HIT event | 只允许 runtime Hit |
| UI 公式 | 二次拼装并有硬编码 | 本地计算器即事实 | 读取 sim log/breakdown | 纯读 runtime factor snapshot |
| 非法命令 | 可能 fallback 显示旧伤害 | 不适用 | 可诊断后继续 | 明确 rejected，绝不伪造伤害 |
| 来源追踪 | attribute 较好，zone 残缺 | 用户配置分组清楚 | source arrays | 统一 contribution identity |

### 7.2 原 dmg-endfield 应保留什么

原项目已经明确分开：

- damageBonus；
- defense；
- resistance；
- amplify；
- fragile/易伤；
- vulnerability/脆弱；
- combo；
- imbalance。

它的 `buffTypeRegistry`、详情布局和按来源整理 Buff 的交互价值很高。问题是这些 zone 目前由用户手填/启停，不是命中状态机自动给出。

正确迁移方式：

- 保留 UI 的区域和信息密度；
- 把输入从 `SkillButtonBuff[]` 换成 `DamageFactorSnapshot[]`；
- 旧 `physicalFragile/physicalVulnerability` 仅作为 presentation mapping；
- AKE raw 字段先进入 domain semantic，再经黑盒校准映射到 UI 区域。

### 7.3 Endaxis 应借鉴什么

Endaxis 的可借鉴结构：

1. `EnemyEffectHandler.applyPhysicalStatus()` 是物理状态的单一入口；
2. `consumeVulnerability()` 在消费前保存 snapshot，输出 `consumedStacks` 和来源队列；
3. 反应伤害作为独立 `DAMAGE_HIT` 进入事件队列；
4. `DamageBreakdown` 明确区分 susceptibility、increasedDmgTaken、defense、resistance 等并保留 sources；
5. `useDamageAnalysis()` 读取 simulation log，而不是重算伤害。

不应复制：

- Endaxis 的具体猛击、碎甲、易伤数值；
- 人工 TypeScript 数据作为 AKE 权威来源；
- 固定时间轴交互；
- 它对非法动作继续模拟的产品策略。

### 7.4 最关键的结构对比

当前 cleanroom：

    状态描述 → preview 猜一次 → runtime 算一次 → UI 再猜一次

Endaxis 的成熟模式：

    typed event → one handler → sim log → UI projection

本项目应该实现：

    AKE normalized event → one strict runtime transaction
      → state transition + hits + factor snapshots
      → shared variable-rate UI projection

## 8. 目标领域契约

### 8.1 统一事件顺序

所有状态、资源、命中和动作事件统一使用：

```ts
interface RuntimeEventOrder {
  frame: number;
  sequence: number;
  phase:
    | 'expire'
    | 'command-admission'
    | 'cast-start'
    | 'before-hit'
    | 'hit'
    | 'after-hit'
    | 'derived-effect';
}
```

`sequence` 是全局单调序号。UI 不能再用 `frame + hitIndex` 推断先后。

### 8.2 统一状态事件

```ts
interface RuntimeStatusEventV3 {
  eventId: string;
  order: RuntimeEventOrder;
  transactionId: string;
  parentEventId: string | null;
  stage: 'applied' | 'refreshed' | 'stacked' | 'consumed' | 'expired' | 'finished' | 'rejected';
  semanticKey: string;
  buffId: string;
  buffInstanceId: string;
  attribution: EventAttribution;
  beforeStacks: number;
  deltaStacks: number;
  afterStacks: number;
  consumedStacks: number;
  appliedFrame: number;
  expireFrame: number | null;
  metadata: {
    sourceCategory: EffectSourceCategory;
    displayNameKey: string | null;
    iconId: string | null;
  };
}
```

### 8.3 统一 Hit 报告

```ts
interface DamageHitReportV3 {
  hitId: string;
  order: RuntimeEventOrder;
  parentEventId: string | null;
  parentTransactionId: string | null;
  attribution: EventAttribution;
  semanticHitType: 'skill' | 'physical-anomaly' | 'element-reaction' | 'dot' | 'extra';
  damageType: string;
  damageDecorateMask: number;
  rawSkillMultiplier: number;
  factors: DamageFactorSnapshot[];
  nonCriticalDamage: number;
  criticalDamage: number;
  expectedDamage: number;
  finalDamage: number;
  activeStatusInstanceIds: string[];
  statusTransitionEventIds: string[];
  diagnostics: RuntimeDiagnostic[];
  confidence: 'exact' | 'partial' | 'unresolved';
}
```

### 8.4 数学恒等式

每个已结算 Hit 必须满足：

    reconstructedNonCrit = product(report.factors in declared order)
    abs(reconstructedNonCrit - report.nonCriticalDamage) <= tolerance

UI 测试也只根据 factors 重建，不能调用伤害 resolver。这样可以证明报告完整，而不是让 UI 悄悄拥有第二套公式。

## 9. 逆向测试策略

### 9.1 测试原则

每个机制用“最小变量差分”，不要直接用完整四人轴猜原因：

1. 固定角色、等级、装备、敌人、暴击模式和技能等级；
2. 每次只改变一个状态或一个来源；
3. 记录 Calc 的状态前后、Hit 数值、额外 Hit 数量和持续时间；
4. 记录同版本 AKE raw 路径；
5. 本地同时输出 RuntimeStatusEventV3 与 DamageFactorSnapshot；
6. 比较结构和值，不比较 UI 文案；
7. 单变量通过后再测两个效果的组合，以判断同区相加还是跨区相乘。

### 9.2 每个逆向 fixture 的格式

```json
{
  "caseId": "physical-vulnerable-isolated-l1",
  "oracleVersion": {
    "calcData": "9163343-11",
    "akeData": "1.4.4@9433094-12"
  },
  "actors": [],
  "enemy": {},
  "commands": [],
  "expected": {
    "commandSettlements": [],
    "statusTransitions": [],
    "hits": [],
    "factorRelations": []
  },
  "evidence": {
    "calcCapture": null,
    "rawPaths": [],
    "notes": []
  }
}
```

Calc 与 AKE 当前数据版本不同，所以 expected 必须携带版本。版本不一致时先标 `version-divergence`，不能直接判本地算法错。

### 9.3 状态机逆向矩阵

| ID | 最小输入 | 必须观察 | 本地验收 |
| --- | --- | --- | --- |
| SM-R01 | 应用不存在的 Buff | 是否创建状态 | 不创建；命令 partial/unresolved；诊断绑定 action |
| SM-R02 | 0.8 秒 Buff，命中 F23/F24/F25 | 过期边界及同帧顺序 | 与 Calc 顺序一致；UI 同步消失 |
| SM-R03 | no_guard 0/1/2/3/4 层后猛击 | 分支、消费、额外 Hit、倍率 | 单一 transaction；consumedStacks 精确 |
| SM-R04 | 同一 Hit 同时有 attempt/result marker | 实际增加几层 | 只执行一次状态事务 |
| SM-R05 | 两名干员分别提供破防后第三人消费 | 来源队列与伤害归属 | bySource 完整；damageSource 正确 |
| SM-R06 | 同帧两 Hit，中间叠 Buff | 哪个 Hit 吃到 Buff | 全局 sequence 与 Calc 一致 |
| SM-R07 | 击飞/倒地：普通敌人、首领、forced | 控制、破防、额外伤害 | 由 enemy profile/resilience 决定，UI 无常量 |
| SM-R08 | Refresh/AddStack/Independent 同 ID 多来源 | instance 数、层数、过期 | 与 raw stacking scope 一致 |
| SM-R09 | 诀双形态、庄方宜强化形态 | 形态切换、按钮身份、实际 skillId | generic form state；无角色特例 |
| SM-R10 | 连携窗口前/边界/后各放一次 | open/consume/expire | preview 与 settled 使用同一事件 |
| SM-R11 | 一名角色连续两次完整重击 | 动作接续、资源、连携 | 两次均按完整命令结算；无固定格时间影响 |
| SM-R12 | 强制等待跨过 Buff/连携过期 | 过期与重新准入 | 等待只推进运行时，不冻结 UI 计算 |

### 9.4 引擎逆向矩阵

| ID | 最小输入 | 目的 | 本地验收 |
| --- | --- | --- | --- |
| EN-R01 | 仅 PhysicalVulnerable +20% | 确定物理易伤 factor | 伤害变化；factor 与 source 都存在 |
| EN-R02 | 仅 Defender NormalCalcZone +20% | 确定该 zone | 独立 factor 与 source 存在 |
| EN-R03 | EN-R01 + EN-R02 | 判断同区相加还是相乘 | 按 Calc 关系合成，不覆盖、不重复 |
| EN-R04 | 真实 Weakness `rate=-0.2` | 校准 base 与 FinalMultiplier | 不得负伤害；属性与 Hit 关系匹配 Calc |
| EN-R05 | 仅 DamageTakenScalar | 拆开抗性与增幅 | 两个 factor 各自可解释 |
| EN-R06 | 全伤/元素/技能加成逐个与组合 | 校准 damageBonus 子项 | UI 各区非硬编码；合计恒等 |
| EN-R07 | 天赋、潜能、武器、三件套各提供相同数值 | 检查来源分类 | 四个 contribution 独立、数值不丢 |
| EN-R08 | 猛击 + 源石结晶击碎 | 独立额外 Hit | 三个 Hit 各有 hitId/factors/parent |
| EN-R09 | 碎甲消费 1/2/3/4 层 | 状态与异常伤害 | 状态持续、额外 Hit、易伤均可单独审计 |
| EN-R10 | SkillSetting 缺失 | partial 传播 | 受影响 Hit 明确标 partial，不伪造倍率 |
| EN-R11 | 同名 Buff 两来源 | stacking 与 attribution | 不按 label 合并 |
| EN-R12 | 每个 golden Hit | 完整公式 | factors 重建值等于 resolver 输出 |

### 9.5 前端契约矩阵

| ID | 输入 report | UI 必须表现 |
| --- | --- | --- |
| FE-R01 | pending | 显示等待；不显示 legacy 数值 |
| FE-R02 | rejected | 显示非法原因；0 settled Hit；不 fallback |
| FE-R03 | partial | 显示已有 Hit 与逐 Hit 缺口 |
| FE-R04 | settled + 物理易伤 | 物理易伤区显示真实 factor/source |
| FE-R05 | 同名、不同 instance/source | 两条来源均显示，不合并 |
| FE-R06 | 同帧多 Hit + 中间状态 | 状态变化归属正确 Hit |
| FE-R07 | 已过期 Buff | 后续 Hit 与命中状态均不显示 |
| FE-R08 | 三件套/武器/天赋/潜能 | 按 sourceCategory 分组，中文名/icon 正确 |
| FE-R09 | runtime report 与 manual assumption 同时存在 | 两种模式隔离，不混入同一列表 |
| FE-R10 | 配置变化但新 report 未返回 | 旧 report 标 stale，不当作当前结算 |
| FE-R11 | settled combo events | 窗口只读 runtime ledger |
| FE-R12 | DamageFactorSnapshot golden | UI 每个数字与 report 完全一致，无硬编码 |

### 9.6 三层差分测试

每个 fixture 同时生成三份标准化输出：

1. `runtime-result.json`：根运行时事件与 Hit；
2. `ui-read-model.json`：纯投影后的 UI 数据；
3. `oracle-result.json`：Calc 黑盒捕获或人工确认基准。

自动检查：

    runtime factors → 可重建 runtime finalDamage
    UI factors == runtime factors
    UI statuses == runtime status slice
    runtime behavior == oracle behavior（允许显式版本差异）

Endaxis 不进入第三份 oracle，只用于检查“是否缺少来源、消费、过期、breakdown 等结构字段”。

## 10. 具体实施顺序

### Phase 0：先建立会失败的契约测试

不先改 UI。先把本轮探针固化为自动测试：

- missing definition；
- PhysicalVulnerable 100→100 的失败用例；
- Weakness 负伤害；
- 0.8 秒 fixed dummy 永久状态；
- attempt + result 双层；
- runtime rejected 后旧计算器 fallback；
- 同名 contribution 合并；
- 同帧 transition 归错 Hit。

测试文件建议：

    test/status-definition-strictness.test.mjs
    test/combat-status-transaction.test.mjs
    test/ake-damage-factor-fixtures.test.mjs
    demo/lts-ui/src/core/services/runtimeLedgerContract.test.ts
    demo/lts-ui/src/components/CanvasBoard/runtimeModeFallback.test.ts

### Phase 1：收敛唯一状态机

涉及：

- `src/core/status-effect-system.mjs`；
- 新增 `src/core/combat-status-resolver.mjs`；
- `src/core/ake-action-compiler.mjs`；
- `src/core/combat-runtime.mjs`；
- `src/core/combo-trigger-machine.mjs`；
- `src/core/ake-squad-scenario-runner.mjs`。

完成条件：

1. missing definition 不再创建状态；
2. CombatStatus 只有一个 handler；
3. 每次消费有 consumedStacks 与 bySource；
4. 状态事件有全局 sequence 与 transactionId；
5. ComboTriggerMachine 直接观察真实状态事件；
6. 角色形态继续由 generic registry 处理，不新增角色分支。

### Phase 2：建立完整 DamageFactorSnapshot

涉及：

- `src/core/effect-source-registry.mjs`；
- `src/core/attribute.mjs`；
- `src/core/ake-damage-resolver.mjs`；
- `src/core/damage.mjs`；
- `src/core/ake-squad-scenario-runner.mjs`。

完成条件：

1. PhysicalVulnerable 进入已校准的“物理易伤” factor；
2. Weakness 真实 fixture 不崩溃且与 Calc 对拍；
3. 抗性与 DamageTaken 不再合成一个无法解释的字段；
4. configured all/element/command bonus 保留独立来源；
5. 每个 Hit factors 可重建最终值；
6. 所有 contribution 使用统一 attribution schema。

### Phase 3：升级 report，前端改成纯投影

涉及：

- `demo/lts-ui/src/integrations/ake/akeProvider.ts`；
- `demo/lts-ui/src/core/services/akeRuntimeLedger.ts`；
- `demo/lts-ui/src/components/CanvasBoard/SkillButton.tsx`；
- `demo/lts-ui/src/components/CanvasBoard/components/CanvasArea.tsx`。

完成条件：

1. report schema v3 携带 status transactions、combo events、Hit factors 和 diagnostics；
2. `akeRuntimeLedger` 只做格式化，不做数学推导；
3. `RuntimeCommandViewState` 取代 null fallback；
4. runtime pending/rejected/partial/stale 明确显示；
5. status/factor 按 instance/source identity 匹配；
6. 连携窗口、资源、Hit、状态全部读 settled ledger；
7. manual hypothesis 与 runtime 模式隔离。

### Phase 4：删除重复执行权

涉及：

- `demo/lts-ui/src/core/services/fixedDummyStateMachine.ts`；
- `demo/lts-ui/src/integrations/ake/akeRealtimeTimeline.ts`；
- 旧 `calculateSkillButtonDamageV2` 接线。

目标不是立刻删除所有旧文件，而是分阶段撤权：

1. fixed dummy 先停止参与数值，只保留临时 presentation adapter；
2. 停止制造机制 Hit；
3. 停止影响 combo observation；
4. 停止保存可写状态；
5. 最终由 runtime projection 完全替代；
6. 旧计算器保留在显式手动实验模式，不再自动 fallback。

### Phase 5：做角色 sweep，但只修通用层

在公共契约稳定后，对全部干员执行自动 sweep：

- 每个普攻、战技、连携、终结技能否编译；
- 状态事件是否可执行；
- 每个 Hp Hit 是否有 factors；
- 是否出现负数/NaN/异常超长状态；
- 是否存在 unresolved；
- UI 能否忠实投影 report。

发现诀、陈千语、管理员、庄方宜、佩丽卡等角色问题时，只能回溯到：

- compiler semantic mapping；
- generic status condition；
- generic form state；
- generic factor registry；
- data fixture。

禁止在 UI 或角色 ID 分支里写特例。

## 11. 第一批应修 Bug 的精确顺序

| 顺序 | Bug | 原因 |
| --- | --- | --- |
| 1 | FE-01：失败/等待静默 fallback | 它会让所有其他错误被一套假结果掩盖 |
| 2 | SM-04：missing definition 假成功 | 不先修，后续测试无法相信“状态已应用” |
| 3 | SM-03/SM-05：统一物理状态事务 | 解决多层、消费、猛击/碎甲/额外 Hit 的共同根因 |
| 4 | EN-03：先建立 factor snapshot schema | UI 和 resolver 才有共同语言 |
| 5 | EN-01：物理易伤进入 resolver | 当前用户可见的确定数值缺口 |
| 6 | EN-02：Weakness 黑盒校准 | 当前真实 fixture 会直接崩溃 |
| 7 | FE-02/03/04/05：ledger 纯投影 | 清除硬编码、同名合并和同帧误归属 |
| 8 | FE-09：连携窗口改读 runtime | 解决合法性 UI 与服务端不一致 |
| 9 | SM-02/SM-07：撤销 fixed dummy 状态权 | 清除永久 Buff、固定首领和固定失衡 |
| 10 | 全角色 sweep | 公共层稳定后才有意义 |

## 12. 合并门槛

任何声称“状态机、引擎、前端已经修好”的提交，至少必须同时满足：

### 状态机门槛

- 同一状态事务只有一个 transactionId；
- attempt + result 不会重复累计；
- 应用、刷新、消费、过期均有事件；
- source/owner/carrier/target/damageSource 完整；
- missing definition 不改变战斗状态；
- preview 与 settled 不再拥有不同规则实现。

### 引擎门槛

- PhysicalVulnerable 单变量测试改变伤害且显示“物理易伤”；
- Weakness 真实 fixture 不崩溃并完成 Calc 对拍；
- 猛击/碎甲/结晶击碎均为独立 runtime Hit；
- 每个 Hit factors 可重建最终伤害；
- 所有 Buff 来源可追到技能、天赋、潜能、武器、装备/套装或敌方状态；
- partial/unresolved 精确绑定受影响 Hit。

### 前端门槛

- runtime rejected 不显示 legacy 伤害；
- 不存在公式硬编码 1.000；
- 不按 label 合并 Buff；
- 同帧状态归属由 event identity 决定；
- 已过期状态不显示、不生效；
- settled 连携窗口来自 runtime；
- UI golden snapshot 与 report factors/statuses 完全一致。

## 13. 当前代码中可以保留的基础

本次结论不是推倒重写。以下基础已经有价值：

- `StatusEffectSystem` 已有 stacking、duration timer、source/owner 与 lifecycle；
- `EffectSourceRegistry` 已能按 buffInstance 追踪属性来源；
- `AkeActionCompiler` 已覆盖大量原始动作并保留 source path；
- `AkeSquadScenarioRunner` 已能在一个敌人和共享资源下运行四人；
- `ComboTriggerMachine`、`SkillFormStateRegistry`、`ResilienceMachine` 已是通用组件；
- 根运行时已能在部分场景生成主 Hit、状态额外 Hit 和结晶额外 Hit；
- 原 dmg 前端的角色配置和乘区详情交互可以继续使用；
- 共享变速时间轴与本次架构修复不冲突。

真正需要重构的是这些组件之间的契约和所有权，而不是重新写一套角色计算器。

## 14. 证据索引

### 状态与编译

- `src/core/status-effect-system.mjs:34-36`：缺定义返回空对象；
- `src/core/status-effect-system.mjs:158-323`：状态应用、刷新与过期调度；
- `src/core/status-effect-system.mjs:815-894`：carrier/owner 语义与状态 trace；
- `src/core/ake-action-compiler.mjs:32-52`：物理状态映射；
- `src/core/ake-action-compiler.mjs:711-773`：编译 ApplyCombatStatus；
- `src/core/combat-runtime.mjs:2378-2442`：当前 shortcut；
- `reference/public-data/akedata/Json/BuffData/buff_physical_try_crushed.json`：原始猛击尝试分支；
- `reference/public-data/akedata/Json/BuffData/buff_physical_crushed.json`：消费、SkillSetting、伤害与衍生动作；
- `reference/public-data/akedata/Json/BuffData/buff_physical_no_guard.json`：20 秒、最多四层、EnhanceAndRefresh。

### 伤害与来源

- `src/core/effect-source-registry.mjs:270-330`：damageZone 与残缺 contribution；
- `src/core/effect-source-registry.mjs:365-405`：完整度更高的 attributeSnapshot；
- `src/core/attribute.mjs:1-27`：九区属性求值；
- `src/core/ake-damage-resolver.mjs:200-307`：当前读取的有限乘区；
- `src/core/damage.mjs:1-93`：基础伤害公式与 operands；
- `reference/public-data/akedata/Json/BuffData/buff_common_affixes_vulnerable_physical.json`：PhysicalVulnerable +0.2；
- `reference/public-data/akedata/Json/BuffData/buff_common_affixes_weak.json`：Weakness FinalMultiplier -0.2。

### 前端重复状态与投影

- `demo/lts-ui/src/core/services/fixedDummyStateMachine.ts:10-15`：写死机制常量；
- `fixedDummyStateMachine.ts:155-174`：字符串语义推断；
- `fixedDummyStateMachine.ts:317-543`：第二套状态转换与机制 Hit；
- `fixedDummyStateMachine.ts:800-811`：仅按节点顺序重放；
- `fixedDummyStateMachine.ts:876-907`：明确固定持续到排轴结束；
- `fixedDummyStateMachine.ts:910-1076`：状态重新转为伤害 Buff；
- `demo/lts-ui/src/integrations/ake/akeRealtimeTimeline.ts:755-1654`：前端完整预览模拟；
- `akeRealtimeTimeline.ts:1157-1188`：fixed dummy 影响连携；
- `demo/lts-ui/src/core/services/akeRuntimeLedger.ts:490-650`：有限贡献与硬编码公式；
- `akeRuntimeLedger.ts:653-787`：同帧/label/标题二次猜测；
- `demo/lts-ui/src/components/CanvasBoard/SkillButton.tsx:1121-1425`：runtime 与旧计算并行；
- `SkillButton.tsx:1755-1768`：runtime 空值 fallback；
- `SkillButton.tsx:2625-2814`：runtime/演示/legacy 三种视图拼接；
- `demo/lts-ui/src/components/CanvasBoard/components/CanvasArea.tsx:696-698`：连携窗口固定读取 preview。

### 对照项目

- 原 dmg-end-field `src/core/domain/buffTypeRegistry.ts`：易伤与脆弱独立 UI zone；
- 原 dmg-end-field `src/core/calculators/skillButtonDamageCalculatorV2.ts`：完整但手动输入驱动的前端公式；
- Endaxis `src/simulation/events/EnemyEffectHandler.ts:438-663`：单一消费与物理状态处理器；
- Endaxis `src/data/stats/computeDamage.ts:481-625`：DamageBreakdown 与来源；
- Endaxis `src/composables/useDamageAnalysis.ts:40-99`：从 DAMAGE_HIT 日志读取分析。

## 15. 最终判断

当前项目已经具备一个可用的根运行时骨架，也已经验证了部分角色、资源、形态、连携和额外 Hit。但前端预览、fixed dummy、runtime shortcut、DamageResolver 和 UI ledger 之间仍未形成唯一事实。

最先要做的不是“把陈千语、管理员、诀分别修一下”，而是：

1. 禁止 runtime 失败时显示旧计算器假结果；
2. 禁止缺失 Buff 假装成功；
3. 把物理状态收敛成一个有 transactionId、consumedStacks、来源和 spawnedHitIds 的通用事务；
4. 让每个 Hit 携带完整 DamageFactorSnapshot；
5. 用 Calc 单变量实验校准物理易伤、Defender zone、Weakness 等关系；
6. 让 UI 只投影同一份 runtime ledger；
7. 最后再做全角色 sweep，所有问题回收到通用 compiler/state/factor 层。

达到这些门槛后，原前端的成熟交互、AKE 的原始数据和共享变速时间轴才会真正变成一套系统，而不是三套逻辑叠在同一个页面上。

## 16. 后续落实记录（2026-08-27）

本报告完成后，后续实现已按“保留水位投影、替换事实来源”的边界落地：

- 新增通用 `CombatStatusResolver`，物理状态执行真实 `triggerBuffId` 生命周期，不再由运行时手写角色或状态 shortcut；
- 缺失 Buff definition 会产生 `STATUS_DEFINITION_MISSING / Unresolved`，不再创建无限期幽灵状态；
- 状态应用、刷新、消费和结束均携带 `eventId / sequence / transactionId`，消费事件额外携带 `consumedStacks / bySource`；
- source、owner、carrier、target、damageSource、Buff instance、skill、cast 与父事件身份贯穿状态、来源贡献和 Hit；
- `PhysicalVulnerableDmgIncrease` 已作为“物理易伤”独立进入伤害公式；Weakness 仅对 `WeaknessDmgScalar + FinalMultiplier` 使用有证据约束的 rate-to-factor 规则，不扩散到其他 FinalMultiplier；
- report schema v3 的每个 Hit 直接携带有序 factors、统一 contribution、恒等校验、诊断与置信状态；
- 前端运行时详情只格式化 report factors，不再写入假的 `1.000`，也不再按中文 label 合并不同来源；
- pending、stale、rejected、partial、settled 与 manual-preview 已成为明确状态，运行时失败不会静默回退旧伤害计算器；
- fixed dummy 在 AKE runtime 模式下已撤销数值、额外 Hit 和 Buff 输入权；临时预览只保留无数值权威的占位观察；
- settled 连携窗口改读根运行时 combo ledger；report 使用包含指令、配置、敌人、数据版本与运行时契约的 execution digest 做严格有效性判断。

水位特色的保护结论：

- `demo/lts-ui/src/core/domain/sharedVariableRateTimeline.ts` 未修改；
- 未修改 Canvas CSS、单元格几何、共享变速列、水位线、真实帧到视觉列的投影算法；
- 本次只改变状态、Hit、连携和公式读取的数据权威与失败表现。

新增契约覆盖 missing definition、物理状态原子事务、真实易伤/Weakness fixture、同名不同来源、同帧多 Hit、状态过期和 runtime rejected/partial。根引擎全量测试、前端状态/引擎相关契约、严格类型检查与 Demo 生产构建均通过。

## 17. Endaxis 源码对照与第二轮通用机制修复（2026-08-27）

### 17.1 本轮采用的源码证据

Endaxis 已拉取到同级目录 `../Endaxis`，研究与验证使用其当前 `main@66bb80b`。本轮没有根据网页表现猜规则，直接读取并运行以下实现：

- `src/simulation/events/EnemyEffectHandler.ts`：元素附着、元素异常、物理破防、猛击、碎甲、击飞、倒地的唯一敌方机制处理器；
- `src/simulation/state/EnemyState.ts`：一个敌人共享一份 `infliction / vulnerability / breach / electrification / corrosion / combustion / solidification` 状态；
- `src/simulation/compiler/compileTimeline.ts` 与 `src/simulation/compiler/effectDispatch.ts`：不同角色技能先编译成同一种敌方事件，不在角色分支里执行机制；
- `src/simulation/events/HitHandler.ts`：命中前状态、同帧级联事件、伤害 Hit 和命中后触发的结算顺序；
- `src/simulation/events/TriggerRegistry.ts`：状态应用与消费通知；
- `src/simulation/mechanics/reactions.test.ts`、`src/simulation/events/EnemyEffectHandler.stackStrategy.test.ts`、`src/simulation/state/EnemyState.test.ts`：机制契约。

Endaxis 的关键规则不是“每种队伍一套引擎”，而是所有角色向同一敌人提交统一事件：

1. 四种元素共用一个附着槽，最多四层；
2. 同元素再次附着会加层、刷新并触发同元素爆发；
3. 不同元素命中会消费已有附着，以后手元素决定异常，后手元素不留在附着槽；
4. 破防最多四层；击飞、倒地增加破防并可产生物理控制伤害，但不消费已有破防；
5. 猛击与碎甲消费已有破防并按消费层数生成独立机制 Hit；目标没有破防时只先进入一层破防；
6. 反应/异常 Hit 归属触发反应的后手干员，被消费层数仍保留旧附着来源队列用于审计。

上述 Endaxis 契约测试本地执行 `42/42` 通过，作为本项目通用层修复的对照基线，而不是直接复制它的 UI 或时间轴。

### 17.2 本项目本轮确认的三个根因

#### 根因 A：多次 ChannelingAction 被编译器丢弃

汤汤战技的真实投射技能包含 `ChannelingAction`，间隔 `0.26s`、持续 90 tick、子动作中才有寒冷 `SpellInfliction`。旧编译器只接受一次执行，其余情况记为 `AKE_CHANNEL_SCHEDULER_REQUIRED`，因此伤害可能存在，但寒冷附着从未进入运行时。

修复位于 `src/core/ake-action-compiler.mjs` 和 `src/core/combat-runtime.mjs`：通道动作统一编译成可取消的 `ScheduleIntervalActions`，保留间隔、持续 tick、首帧执行和最大执行次数，不写汤汤 ID。

#### 根因 B：SpellInfliction 被当成相互独立的普通 Buff

旧实现把每个元素直接编译成 `ApplyBuff`。这样四种附着可以同时存在，也没有“同元素爆发/异元素消费”的敌方事务，更无法保证反应 Hit 的来源归属。

修复位于：

- `src/core/ake-action-compiler.mjs`：`SpellInfliction` 编译成通用 `ApplyEnemyInfliction`，携带由语义映射表产生的四元素 Buff 映射；
- `src/core/combat-status-resolver.mjs`：升级为 `EnemyMechanicResolver`，统一拥有元素与物理敌方机制；旧名称仅保留兼容导出；
- `src/core/combat-runtime.mjs` 与 `src/core/effect-runtime.mjs`：注册并执行统一敌方附着事务；
- `src/core/status-effect-system.mjs`：能力事件可显式把后手事件来源作为衍生动作来源，同时保留旧状态来源，不对其他 Buff 生命周期全局改语义。

同元素附着原始 Buff 的 `OnBuffAfterTryEnhanced` 会再触发一次重新应用。旧状态系统会先自动加层、再执行原始重应用，导致一次命中增加两层。本轮通过识别“增强事件自己负责重新应用”的定义结构，只让原始事件增加一次，不按 Buff ID 写白名单。

#### 根因 C：物理控制 Buff 共用 stacking key 时身份被错误复用

AKE 的 `buff_physical_airborne`、`buff_physical_crushed` 等状态共用 `physical` stacking key。旧状态系统找到同 key 实例后直接刷新旧实例，结果“猛击”可能仍以“击飞”身份存在，新的生命周期、破防消费和独立伤害全部不执行。

本轮将 stacking key 明确为“互斥槽”而不是“Buff 身份”：同 key、不同 Buff ID 时，先结束旧实例，再创建并执行新定义。该规则适用于所有状态，不包含角色条件。

同一个击飞/倒地状态再次命中也不能退化为只刷新图标时长。统一事务会让对应控制 Buff 重新进入其 `OnBuffStart`，因此每次真实物理事件都会重新执行“独立物理 Hit + 破防加一”，并在四层处封顶；这仍由 `statusKey / statusBuffId` 驱动，不读取角色 ID。

AKE 的击飞/倒地内部实现还会暂时结束 `buff_physical_no_guard` 并创建隐藏 `buff_physical_no_guard_fake`。直接把该内部标记当成最终敌方状态，会让陈千语战技后的破防在连携时被错误抵消。统一敌方事务现在根据 `statusKey` 对击飞/倒地保留真实破防层；猛击/碎甲仍按原始生命周期真实消费。UI 因而只读取最终规范状态，不展示内部 fake 标记。

### 17.3 前端投影适配

根引擎改为 `ApplyEnemyInfliction` 后，`src/core/ake-hit-profile-builder.mjs` 的静态命中画像仍只识别旧 `ApplyInfliction / ApplyBuff`，导致佩丽卡的电磁附着与诀的自然附着在按钮详情中消失。该构建器现已通用识别 `ApplyEnemyInfliction`，继续输出统一的 `hitBuffs / statusKey / target`；没有增加角色判断。

真实异常 Buff 也不是旧 UI 映射中的单一 `buff_common_enemy_spell_status_*` 别名。跨元素导电实际使用 `buff_common_pulse_<被消费元素>_triggered`，其他异常同样由第一个元素 token 表示后手元素。本轮在 `src/core/ake-buff-presentation.mjs` 与运行时 ledger 的兼容投影中按该结构映射燃烧、导电、腐蚀、冻结，并隐藏 `try / start / fx / wrapper` 内部事件；主界面的导电状态因此读取真实 reaction Buff，不再依赖虚构别名。

运行时 UI 继续由 `demo/lts-ui/src/core/services/akeRuntimeLedger.ts` 投影真实 `statusEvents`：

- 主界面只保留破防/碎甲、导电和元素附着等关键状态；
- 双击详情按状态实例和 trace 顺序显示应用、叠层、刷新、消费、结束；
- 每个 Hit 读取自己的 runtime snapshot，不把启停演示 Buff 当成真实命中权威；
- 隐藏内部 `buff_physical_no_guard_fake`，但不隐藏真实破防消费；
- 元素附着与导电使用不同语义映射，不再都显示成“电磁”。

本轮没有修改 Canvas CSS、按钮几何、共享变速列或水位算法。

### 17.4 新增回归矩阵与结果

新增 `test/ake-enemy-mechanics.test.mjs`，直接装配真实 AKE Buff 定义并验证：

1. 四元素全部 `4 × 4` 组合；
2. 同元素一次命中只增加一层；
3. 异元素消费唯一附着槽并生成正确的原始 AKE reaction Buff；
4. 反应 Buff 归属后手干员；
5. 汤汤真实战技通道最终产生寒冷附着；
6. 陈千语真实战技加连携后破防为两层，未被 fake 标记抵消。
7. 陈千语单次战技只增加一层；已有破防后的击飞保留独立物理 Hit；元素附着与破防都在四层封顶。

最终验证：

- Endaxis 对照机制测试：`42/42`；
- cleanroom 根引擎全量测试：`164/164`；
- 前端本轮状态账本契约：通过；
- TypeScript `tsc --noEmit`：通过；
- Demo 生产构建：通过；
- `demo/lts-ui/src/core/domain/sharedVariableRateTimeline.ts`：本轮零差异。

前端仓库级 `npm test` 仍会在与本轮无关的
`src/platform/runtime/sitesMobileShareApi.test.ts` 返回失败码：该测试在当前基线引用
`../../../worker/mobileShareApi`，但 `HEAD` 中不存在 `demo/lts-ui/worker/mobileShareApi.ts`。
状态、引擎与 UI ledger 测试在到达该文件前均通过；本轮遵守移动分享不在修复范围的边界，没有伪造或补写该服务实现。
