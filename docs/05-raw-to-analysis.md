# 原始 JSON 与后处理 JSON

## 三层数据

```text
游戏 Unity 资产
  ↓ 未公开的提取/序列化工具
AKE public/Json 中的原始 JSON
  ↓ 已公开的 analyzeBuff / analyzeSkill
浏览器内存中的 analysis 对象
  ↓ v3-buff.js / v3-skill.js
人类可阅读的网页
```

这里所说的“原始 JSON”已经是游戏资产经过某种提取器序列化后的产物，并不是原始二进制。它仍然保留大量运行时类型名、包装字段、Blackboard 引用和深层动作数组。

AKE 当前网页不会从服务器下载一份独立的“后处理 JSON”。页面先 `fetch('/public/Json/...')`，再在浏览器内调用分析器，把返回对象保存在页面状态中并渲染。

## Buff 转换

入口：

```js
window.AKEV3BuffData.analyzeBuff(rawBuff, context)
```

输出结构：

```text
identity     身份、图标
core         生命周期、持续时间、触发间隔
stacking     叠层、刷新、优先级
dispel       驱散设置
modifiers    属性、伤害、治疗、韧性、全局、护盾
tags         应用和扩展 Tag
eventGroups  Buff/Ability/Ignite 事件组
timelineGroups
events       拉平后的动作节点，保留 parent/path/branch
links        直接 Buff/Tag 引用
blackboard   值、来源、fallback 和依赖
warnings     解析提示
stats        遍历与抽取统计
```

### Blackboard 示例

原始：

```json
{
  "duration": {
    "useBlackboardKey": true,
    "value": 2,
    "blackboardKey": "duration"
  },
  "blackboard": [
    { "key": "duration", "valueDouble": 20 }
  ]
}
```

后处理：

```json
{
  "core": {
    "duration": {
      "value": 20,
      "fallbackValue": 2,
      "usesBlackboard": true,
      "blackboardKey": "duration",
      "resolved": true,
      "status": "local-default"
    }
  }
}
```

### 动作示例

原始 `$type`：

```text
Beyond.Gameplay.Core.CreateBuffAction+Data, Gameplay.Beyond
```

会被整理成 `type=CreateBuffAction`、`category=buff` 的事件节点，并抽取 `buffs[]`、Blackboard 赋值、目标、事件种类和原始 JSON path；目标 Buff 同时进入 `links[]`。

## Skill 转换

入口：

```js
await window.AKEV3SkillData.analyzeSkill(rawSkill, skillPatchBundle, context)
```

它会将 SkillData 与 `SkillPatchTable[skillId]` 的对应等级合并，输出：

```text
basic, windows, hits, events, links, blackboard, spatial, warnings
```

例如当前佩丽卡普通技能的原始 SkillData 内 `atk_scale=2.85`，而等级 1 SkillPatch 是 `1.78`；AKE 分析对象会保留历史并把最终来源标记为 `patch`。这说明后处理结果依赖调用时提供的表和等级上下文，不仅依赖单个 SkillData 文件。

## 本地派生数据

运行：

```powershell
node ./scripts/export-ake-analysis.mjs
```

脚本会处理当前本地 `Json/BuffData/*.json` 和 `Json/SkillData/*.json`，输出到：

```text
derived/ake-analysis/BuffData/*.analyzed.json
derived/ake-analysis/SkillData/*.analyzed.json
derived/ake-analysis/manifest.json
```

每个结果都包含：

- 原始文件相对路径与 SHA-256；
- 分析器相对路径与 SHA-256；
- 固定 AKEDatabase 提交和 AKE 数据修订；
- 实际 `analysis` 对象。

`manifest.json` 再记录每个输出文件的 SHA-256，使原始输入、分析器和结果可以闭环验证。

## 重要限制

- analysis 是面向展示的有损视图，不是原始 JSON 的可逆替代品；
- 分析器不会执行时间轴，也不会计算完整战斗结果；
- 只抽取静态可见的引用，无法自动恢复全部引擎隐式映射；
- Buff 通用分析器对调用处 Blackboard 覆盖并不完整，不能把显示值直接等同于所有运行时实例值；
- Skill 分析依赖 SkillPatch、潜能表和可选的子 SkillData，缺失上下文会产生 warning 或 pending reference。

## 独立可执行模型

AKE 的网页 analysis 适合研究“原始 JSON 如何变得可读”，但本项目的运行核心不直接依赖它。执行：

```powershell
npm run derive:pelica
```

会由 `src/core/ake-parser.mjs` 独立读取相同的原始 SkillData、BuffData 和 SkillPatchTable，生成 `derived/cleanroom/pelica-model.json`。与网页 analysis 相比，这个模型只保留最小模拟器真正执行的字段，并另外保留：

- 等级补丁覆盖前后的 Blackboard 血缘；
- 发射动作到子 SkillData 的帧偏移；
- 连招缓存与允许接续窗口；
- BUFF 启动动作、赋值传播和伤害乘区；
- 不能由原始 JSON 直接得出的显式语义映射。

因此两类后处理结果不能混用：`derived/ake-analysis/` 是固定 GPL 分析器的展示型研究输出；`derived/cleanroom/` 是本项目独立子集解析器的执行输入。
