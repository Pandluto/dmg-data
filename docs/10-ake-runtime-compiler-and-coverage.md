# AKE 动作编译器、通用执行链与覆盖审计

## 1. 本阶段结论

本阶段已经把“公开 AKE 原始 JSON 能被展示”推进到“公开 AKE 动作子集能编译并在本地通用运行时执行”。实现仍与现有佩丽卡精确模拟器分离：前者负责扩展语义覆盖，后者继续承担已经由 Calc 黑盒用例逐段验证的精确基线。

当前可以执行的通用链路包括：

1. Skill 与 Buff 时间轴；
2. Buff 创建、叠层、刷新、定时触发、事件监听、点燃监听与结束清理；
3. 属性和标签的来源化增删，以及攻击方/防守方伤害乘区；
4. HP、治疗、护盾、ATB/USP 等资源动作；
5. DamageUnit 到 HP 或 Resilience/Poise 的通用结算入口；
6. 全局光环、目标 Buff、元素积蓄和反应派生链；
7. Resilience、超级护甲、控制门控与处决量表；
8. 潜能/天赋表和公开装备被动 SkillData 的来源化安装、刷新和卸载。

空间搜索、连续时间曲线、部分运行时 Setting、未知选择器和未覆盖动作仍通过明确的 `unresolved` 结果暴露，不会静默猜值。

## 2. 固定公开数据语料

同步脚本：`scripts/sync-ake-runtime-corpus.mjs`

清单：`reference/public-data/akedata/runtime-corpus.manifest.json`

本轮固定语料如下：

| 项目 | 值 |
|---|---:|
| 公开索引修订 | `2026-08-21T21:51:44.260485+00:00` |
| 文件数 | 3,389 |
| 总字节数 | 147,580,776 |
| 已有文件哈希验证 | 3,348 |
| 本轮补齐文件 | 41 |
| BuffData 范围 | `BuffData/` |
| SkillData 范围 | `chr_`、`passive_equip`、`passive_rpg_equip`、`rpg_equip` |

这些文件均来自清单中的公开 `https://data.akedata.wiki/public/Json` 路径。本阶段没有读取父目录中的 `local-20260809030612.json`，也没有尝试访问 Calc 的非公开后端代码。

## 3. 原始 JSON 到运行结果

```text
AKE 原始 BuffData / SkillData / PotentialTalentEffectTable
                         │
                         ▼
                ake-parser.mjs
        保留 $type、Blackboard、目标、时间轴和原始字段
                         │
                         ▼
            ake-action-compiler.mjs
   编译动作/条件、生成生命周期与 cleanup、列出 unresolved
               │                         │
               │                         └─ 空间/曲线/Setting/provider
               ▼                              必须显式注入
       CombatRuntime + EffectRuntime
               │
     ┌─────────┼──────────┬───────────┐
     ▼         ▼          ▼           ▼
 Status/Buff  Damage   Resource/HP  Aura/Reaction/Resilience
     │         │          │           │
     └─────────┴──────────┴───────────┘
                         │
                         ▼
              可审计状态、数值与 trace
```

编译结果不只返回动作数组，还带有状态：

- `executable`：当前运行时具备完整本地执行路径；
- `adapter-required`：已经生成运行时动作，但精确结果依赖调用者提供曲线、空间、Setting 或其他 provider；
- `blocked`：缺少动作语义或选择器，不能执行；
- `metadata-only`：声音、镜头、动画等对当前伤害计算无影响的表现节点，或目前仅保留时序信息的节点。

## 4. 主要实现文件

| 文件 | 职责 |
|---|---|
| `src/core/ake-action-compiler.mjs` | 把 AKE 动作、条件、Skill 和 Buff 编译成通用动作与时间轴 |
| `src/core/ake-damage-resolver.mjs` | 把 DamageUnit 接入现有伤害公式、实时属性和来源化乘区 |
| `src/core/ake-loadout-compiler.mjs` | 编译潜能/天赋和装备被动，管理安装、条件刷新与卸载 |
| `src/core/effect-source-registry.mjs` | 以来源键维护可逆属性、标签和伤害乘区 |
| `src/core/status-effect-system.mjs` | Buff 生命周期、叠层、定时触发、事件/点燃监听和 Buff 内时间轴 |
| `src/core/combat-runtime.mjs` | 统一路由 Buff、伤害、资源、光环、反应、韧性和外部适配器 |
| `scripts/audit-ake-action-coverage.mjs` | 对每个原始动作实例实际调用编译器并统计路由结果 |

### 4.1 Buff 与时间系统

- `Limited / Infinity` 生命周期和 `Unique / Unlimited / EnhanceAndRefresh` 等叠层别名；
- Start、Trigger、Finish、Enable、DuringEnable、AbilityEvent、IgniteEvent；
- `triggerInterval` 使用实体选定的局部时钟；
- Buff 内 `timelineActions` 的开始/结束动作同样使用局部时钟；
- Buff 提前结束会取消尚未触发的持续时间、周期和时间轴定时器；
- Skill 时间轴为每次施法生成独立 `castId` 与来源键，避免两次施法互相清理。

`HitStopAction` 和 `TimeDilationAction` 已编译为 `ResolveTimeDilation`。运行时只接受适配器返回的离散 `excludedTicks`；在没有曲线采样依据时不会把 `duration` 直接猜成暂停帧数。

### 4.2 数值、来源和伤害

- Buff 属性、标签和伤害乘区都带来源键，可按 Buff、装备、潜能或光环来源独立撤销；
- `StoreAttribute`、动态 Blackboard、`StoreBuffCount` 可供同一事务中的后续动作读取；
- 通用伤害 resolver 读取攻击者/目标实时属性，并复用已存在的 `damage.mjs` 公式；
- HP DamageUnit 进入 `VitalMachine`，Poise/Resilience DamageUnit 进入 `ResilienceMachine`；
- 攻击方与防守方乘区按 zone 分组相乘，来源之间可叠加并保留审计记录；
- 未知 DamageCalculation 类型、缺失关键属性或缺失运行时 Setting 时返回明确未决结果。

### 4.3 光环、反应与控制

- `GlobalAura` 可按己方/敌方、对象类型和标签筛选当前实体；
- 目标进入光环时应用带 assignment 的 Buff，来源结束时按光环实例清理；
- 需要距离和形状判定的 Ranged Aura 会生成光环动作，同时保留空间 provider 未决项；
- 元素反应把 `igniteType` 和配置的反应事件传给 Buff Ignite 监听器；
- Buff 层数可以经 `StoreBuffCount` 写入子 Buff Blackboard，再由反应消费；
- Resilience modifier 按来源叠加并在 Buff 结束时撤销，超级护甲窗口可由 Skill 时间轴控制。

### 4.4 装备、天赋与潜能

`AkeLoadoutCompiler` 当前支持两条公开数据路径：

1. `PotentialTalentEffectTable` 的基础 Buff、属性效果和派生效果；
2. 装备被动 SkillData 中的普通 Buff、卡片属性、切换 Buff 和 HP 比例条件。

`LoadoutEffectManager` 以来源键安装效果。条件变化后调用 `refresh()`，只切换该来源的派生 Buff；`uninstall()` 会回滚基础、派生和条件 Buff，不删除其他来源的同名效果。

部分装备 SkillData 的 Blackboard 默认值为 0，真实等级/词条值仍需由装备数值表或上层调用者传入，不能把示例测试传值当作游戏真值。

## 5. 真实公开数据的轻量验证

`test/ake-action-compiler.test.mjs` 包含以下代表性真实数据链：

1. 佩丽卡 `chr_0004_pelica_attack1`：frame 0–14 超级护甲为 15，frame 15 清理；
2. 佩丽卡潜能 3：Pulse 输出触发攻击力来源叠加，卸载来源后完整回滚；
3. `buff_common_heal_moss_1`：开始治疗与 frame 60 周期治疗；
4. `buff_common_obtain_ultimate_sp`：保留公开数据中的 `6.499999761581421`；
5. Tag 选择器驱散与按层结束 Buff；
6. 真实 GlobalAura：只给符合阵营的目标应用 Buff，结束时清理；
7. EnergyShard 反应：两层父 Buff 被读取、写入子 Buff并消费；
8. 佩丽卡真实 ProjectileHit：攻击 100、目标防御 100 时，破韧易伤来源使两次伤害分别为 16.25 与 12.5；
9. 公开装备满血被动：HP 条件变化时来源效果在 12 与 10 之间切换，卸载后回到 10；
10. Laevat 真实 Buff：frame 21 创建能量子 Buff，frame 10 提前结束时定时器被取消；真实 HitStop 在 frame 25 只调用注入的曲线适配器。

这些是接口与语义的简单测试，不是全角色、全装备、全难度的精确 Calc 对照。

## 6. 全语料动作覆盖

覆盖报告：`derived/cleanroom/ake-action-coverage.json`

审计会遍历每个原始动作实例，并实际调用 `AkeActionCompiler`，不是只按动作名称维护一张人工白名单。

### 6.1 全部动作

| 指标 | 数量 | 占全部 27,129 |
|---|---:|---:|
| 直接完整执行 | 5,229 | 19.27% |
| 已有执行动作、需要适配器 | 4,218 | 15.55% |
| 明确阻塞 | 6,423 | 23.68% |
| 仅元数据 | 11,259 | 41.50% |
| 直接执行 + 适配器路径 | 9,447 | 34.82% |

全量比例被镜头、声音、动画、Root Motion 和空间动作显著拉低，因此不能直接代表伤害计算器核心覆盖。

### 6.2 伤害计算器核心类别

这里仅统计 `logic / buff / damage / resource / control / recovery / condition`：

| 指标 | 数量 | 占核心 9,303 |
|---|---:|---:|
| 直接完整执行 | 5,144 | 55.29% |
| 已有执行动作、需要适配器 | 3,090 | 33.22% |
| 明确阻塞 | 944 | 10.15% |
| 仅元数据 | 125 | 1.34% |
| 直接执行 + 适配器路径 | 8,234 | 88.51% |

88.51% 表示已经有可调用的执行路线；其中 33.22% 仍依赖外部语义或参数，不能声称数值已经精确还原。当前非演出/时间轴玩法类别的执行路线覆盖为 55.71%。

## 7. 仍未闭合的关键项

按后续精确复现价值排序：

1. **目标/空间 provider**：`FindTargetAction`、目标组、弹道、范围和距离光环需要实体查询与空间输入；
2. **伤害参数来源**：其他角色的 SkillSetting、完整 DamageCalculation 变体、等级/装备属性和抗性字段仍需接表；
3. **HitStop/TimeDilation 曲线**：通用接口、目标时钟路由和少量证据曲线已完成；其余命名曲线的积分样本仍需逐项适配；
4. **Buff 选择器**：Environment 与部分高级 selector 需要运行环境索引；
5. **TickIntervalAction**：需要定义重复区间、结束边界和局部时钟重排规则；
6. **Resilience decrease factor**：原始数值单位尚未确认，当前只保存来源与原始值；
7. **装备 Blackboard 真值**：被动结构已能执行，但实际等级/词条值必须来自对应数值表；
8. **剩余未知动作**：Interrupt、FinishOwner、部分 Context/MainCharacter/InstantSearch 目标语义仍明确阻塞；
9. **深度精确测试**：单目标打断/跳转已有 43 条逐包回归；多目标、切人、召唤物、更多复杂元素链和高级敌人仍需要统一的 Calc 差分用例。

机器可读状态见 `spec/unresolved-dependencies.json`。

## 8. 重现命令

```powershell
# 只在需要刷新公开语料时运行
npm run sync:ake-runtime-corpus

# 重建动作覆盖报告
npm run audit:ake-actions

# 当前轻量回归和既有精确回归
npm test

# 校验固定快照和关键语义
./scripts/verify-snapshots.ps1
```

## 9. 当前声明边界

可以声明：公开 AKE JSON 的核心动作已有可审计编译器、通用执行器、真实数据轻量用例和全语料覆盖报告。

不能声明：已经获得 Calc 私有后端源码、已经完整复现整个游戏、或 88.21% 的路径都具备精确游戏参数。后续精度提升应以固定公开数据、可重复 Calc 用例和明确 provider 输入逐项关闭未决项。
