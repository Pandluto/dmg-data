# 数据关系与查找路线

## 目标

把一个角色、技能、潜能、道具或关卡条件转换成可执行的 Buff/Skill 关系图。图中的每条边必须标注来源，不能把静态引用、运行时参数和引擎推断混为一谈。

建议使用四类边：

- `explicit`：JSON 中直接包含目标 ID；
- `blackboard`：ID 或数值由 Blackboard 提供；
- `semantic`：动作类型由引擎映射成另一实体，例如 `SpellInfliction(Pulse)`；
- `observed`：通过 Calc 公共服务的输入/输出差分确认，但公开数据中尚未找到来源。

## 入口路线

### 角色技能

```text
CharGrowthTable[charId]
  .skillGroupMap[*].skillIdList[*]
    → SkillPatchTable[skillId].SkillPatchDataBundle[level]
    → Json/SkillData/<skillId>.json
```

`SkillPatchTable` 给出等级 Blackboard；`SkillData` 给出时间轴、动作、子技能、投射物、Buff 和元素附着。

### 天赋与潜能

```text
CharGrowthTable[charId].talentNodeMap[*]
  .passiveSkillNodeInfo.talentEffectId
    → PotentialTalentEffectTable[talentEffectId].dataList[*]
      → attachBuff / attachSkill + blackboard
```

必须把调用处 Blackboard 作为 Buff 实例参数传递，不能只使用 BuffData 内的默认值。

### 道具

```text
UseItemTable[itemId].useActions[*]
  → buffBBData.buffId + blackboard
  → skillBBData.skillId/skillPath + blackboard
```

### 敌人与关卡

检查：

- `EnemyTable[*].bornBuffs`
- `EnemyAttributeTemplateTable[*].poiseKnotBuffList`
- `SpawnerConfig[*].enemyLibrary[*].bornBuffList`
- `LevelScriptData` 中敌人节点的 `buffs`
- `LevelScriptData` 动作图中的 `AddBuffToTarget`、`AddBuffsToTargets` 及 `_buffId`

关卡动作还需要解析目标选择图、条件节点和来源脚本，不能只收集 `_buffId`。

### 危机合约与模式规则

```text
CcTagTable.tagTerms[*]
  → buffId + blackboard
  → GlobalBuffData（当前公共索引缺失）
  → 子 BuffData / globalModifier / level event
```

当前公开数据能看到 CcTag 的 Global Buff ID 和子 Buff，但中间 `GlobalBuffData` 未出现在公共资产索引里，因此这条边必须标记为缺失或黑盒观测，不能假装已经静态恢复。

## 递归关系

在 SkillData 与 BuffData 中递归检查：

- 字段：`buffId`、`buffIds`、`targetBuffId`、`buffIdList`、`buffInput`、`smartTargetBuffIds`；
- 动作：Create、Add、Aura、Extend、Finish、Dispel、Inherit Buff；
- 间接 ID：`readIdFromBlackboard=true` 与对应 `buffIdKey`；
- 子技能：LaunchProjectile、CastSkill、SpawnAbilityEntity；
- 条件：Check、Compare、TagQuery 和分支数组。

遍历器必须具有循环检测、深度上限、节点预算，并保存每条边的 JSON 路径。

## 不能靠字符串搜索恢复的关系

`SpellInfliction(Pulse)` 的原始动作没有目标 Buff ID，但运行时会产生 `buff_common_energy_shard_attached_pulse`。此类关系需要单独的引擎语义映射表，并用受控黑盒差分验证。

