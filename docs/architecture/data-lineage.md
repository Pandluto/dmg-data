# 数据来源与派生链

## 固定来源

| 来源 | 当前版本 | 在本项目中的用途 |
| --- | --- | --- |
| AKE TableCfg / SkillData / BuffData | `1.4.4@9433094-12` | 角色、技能、Buff、装备、敌人和动作结构 |
| Calc 公共数据与模拟响应 | `9163343-11` | 面板输入和选定场景的行为 oracle |
| AKEDatabase 参考实现 | commit `1bb9549` | 理解公开 JSON 的展示性解析方式；不进入运行时 |
| Endaxis | 固定研究提交 `66bb80b` | 机制目录、架构与测试维度；不提供权威数值 |

完整 URL、文件大小和哈希由 `sources.lock.json` 管理。AKE 与 Calc 版本不同，因此“字段存在于 AKE”和“Calc 在该场景这样结算”是两类证据，不能直接互相覆盖。

## 证据能证明什么

| 证据 | 可以证明 | 不能单独证明 |
| --- | --- | --- |
| AKE 原始 JSON / TableCfg | ID、字段、动作树、时间组、叠层和静态数值 | Calc 隐藏后处理、未公开 SkillSetting 和最终行为 |
| Calc fixture | 冻结输入下的指令、Hit、状态、资源和数值 | 后端源码、字段命名和其他未测试场景 |
| 本项目单元测试 | clean-room 实现满足写下的局部规则 | 规则本身等于游戏行为 |
| 全语料审计 | 哪些节点可编译、需适配或被阻塞 | 每个角色在所有组合中都正确 |
| Endaxis 源码/测试 | 成熟实现需要考虑哪些机制边界 | AKE/Calc 的权威语义 |

## 静态查找路线

### 角色技能

```text
CharGrowthTable[characterId]
  → skillGroupMap[*].skillIdList[*]
  → SkillPatchTable[skillId] 的等级 Blackboard
  → Json/SkillData/<skillId>.json
```

SkillPatch 提供等级值，SkillData 提供时间轴、动作、子技能、投射物、Buff 和元素附着。任何分析都必须同时保留技能等级上下文。

### 天赋、潜能与配装

```text
CharGrowthTable.talentNodeMap
  → PotentialTalentEffectTable
  → attachSkill / attachBuff + 调用处 Blackboard

CharacterTable / WeaponBasicTable / EquipTable
  → AkeLoadoutCompiler
  → 有来源、可安装和可撤销的效果
```

调用处 Blackboard 不能被 BuffData 默认值覆盖。武器技能的 UI 语义角色与 AKE 物理槽位不同，由 provider 在请求边界显式映射。

### 敌人

```text
EnemyTable
  → EnemyAttributeTemplateTable
  → 基础属性、Poise、恢复、节点、处决与出生 Buff
```

关卡脚本、空间选择与特殊 Boss profile 没有被这条固定木桩链完整覆盖。

### 递归依赖

装配器递归收集：

- `buffId`、`buffIds`、`targetBuffId`、`buffInput` 等显式 Buff 引用；
- `LaunchProjectile`、`SpawnAbilityEntity`、`CastSkill` 等子技能；
- 通过 Blackboard 读取的动态 ID；
- 条件、事件 listener、时间组、配装和语义映射引入的依赖。

遍历保存 JSON path，并具有循环检测和缺失依赖报告。缺文件时输出 `AKE_SKILL_DATA_MISSING` 或 `AKE_BUFF_DATA_MISSING`，不能制造空定义。

## 四种关系

| 关系 | 含义 | 例子 |
| --- | --- | --- |
| `explicit` | 原始 JSON 直接包含目标 ID | CreateBuff、LaunchProjectile |
| `blackboard` | ID 或值由当前实例参数提供 | 潜能持续时间、动态子技能 |
| `semantic` | 游戏动作需要额外映射 | SpellInfliction 到附着 Buff |
| `observed` | 由 Calc 差分确认的窄范围行为 | 指令优先级、局部时间曲线样本 |

`spec/engine-semantic-mappings.json` 只保存后两类中已有证据且运行时需要的桥接；无法确认的内容进入 `spec/unresolved-dependencies.json`。

## 派生物

```text
reference/public-data
  ├─ 第三方分析器 ─→ derived/ake-analysis
  └─ clean-room 编译/运行/审计 ─→ derived/cleanroom
```

- `derived/ake-analysis/` 是展示性、有损的参考分析，不是运行时输入。
- `derived/cleanroom/` 是本项目生成结果，包括技能模型、模拟、时序画像和覆盖审计。
- `fixtures/calc/` 是独立测试输入与 oracle；`src/` 不读取其中答案。
- 修改编译器、语义映射或审计分类后，应重新运行相关 audit，不能手工修改报告统计。

## 更新纪律

同步公开数据是有意的版本升级，不是普通开发步骤。更新时必须：

1. 更新来源快照和 `sources.lock.json`；
2. 重新生成受影响的 analysis、timing 和 audit；
3. 运行全部 oracle 回归并区分版本差异与实现回归；
4. 在维护记录中说明旧版本、新版本、变化范围和未闭合差异。

当前同步脚本不会读取仓库外的私人数据文件。
