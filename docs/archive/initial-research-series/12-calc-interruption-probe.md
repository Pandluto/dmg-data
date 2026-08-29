# Calc 轨道指令、打断与脱手效果差分实验

## 结论

Calc 前端提交的是时间轴指令，不需要也没有额外的 `interrupt=true`：

```json
{
  "uuid": "wulfgard",
  "frame": 76,
  "commandType": "NormalSkill"
}
```

后端根据当前技能、输入缓存、技能优先级和 SkillData 时间轴，自动决定
指令是立即执行、排队、过期还是打断当前技能。本轮在 Calc 数据版本
`9163343-11` 上冻结了 43 个沃尔夫冈差分用例。

## 一帧打断边界

沃尔夫冈战技的前三个命中位于第 6、16、23 帧。终结技分别插入这些
边界前后，得到：

| 终结技输入帧 | 保留的战技命中帧 | 结论 |
| ---: | --- | --- |
| 5 | 无 | 尚未执行的根时间轴被取消 |
| 6 / 7 / 15 | 6 | 同帧命中先于终结技指令 |
| 16 / 17 / 22 | 6、16 | 第二个同帧边界相同 |
| 23 / 24 | 6、16、23 | 第三个同帧边界相同 |

终结技在上述每个帧都立即成功，并把战技记录为 `Interrupted`。这证明
高优先级指令的打断是后端自动语义，不是前端传入的特殊标记。

## 输入缓存与可打断窗口

战技内部帧 48 有 `MarkCanInterrupt`。普攻输入的结果为：

| 普攻输入帧 | 结果 |
| ---: | --- |
| 17 | 排队，47 过期 |
| 18 | 排队，48 过期 |
| 19 | 排队，48 执行 |
| 47 | 排队，48 执行 |
| 48 / 49 | 立即执行 |

因此当前 Calc 的输入最多等待 29 帧；等待达到 30 帧时先产生
`CommandExpiredTrace`，不能在同一帧继续消费。

同一战技在帧 32 有面向自身战技的 `AllowNextSkillAction`。第二次战技
输入于帧 30 时排队，并在帧 32 执行。连携和终结技在帧 30 可以依靠
更高优先级立即打断。

原始响应中的 `INTERRUPT_CHECK` 进一步给出了实际档位：普攻 0、战技 2、
连携技 5、终结技 7。沃尔夫冈还出现了“当前技能已可打断且新指令优先级
更高”的重叠样本，Calc 报告 `HIGHER_PRIORITY`，因此本地判定也先比较
高优先级，再检查当前可打断标记。实现与逐次审计格式见
[数据驱动的指令准入与优先级](13-data-driven-command-admission.md)。

## `JumpToAction`，不是长按蓄力

沃尔夫冈战技在内部帧 0 检查目标元素 Tag：

```text
CheckTagMatch
  -> ModifyDynamicBlackboard SpellInflict = 1

内部帧 31：SpellInflict >= 1
  -> JumpToAction(destFrame = 118)
  -> 内部帧 141 发射 normal_skill_plus

内部帧 117：普通路径
  -> JumpToAction(destFrame = 247)
  -> 跳过强化弹
```

所以此前所谓“长按蓄力分支”是错误解释。它实际上是由目标元素状态
自动选择的时间轴分支。

最清晰的黑盒样本是：终结技帧 0，战技输入帧 47。战技先排队，在
终结技局部帧 75（墙钟帧 76）执行：

- 普通三发命中：82、92、99；
- 强化弹命中：131；
- 强化弹原始伤害：`310.78404`；
- 强化弹最终伤害：`155.39202`；
- 燃烧 Buff 同在帧 131 结束，说明强化分支消费了该状态。

## 投射物与 Buff 的生命周期

沃尔夫冈第一段普攻的投射物在内部帧 6 发射，帧 7 命中：

- 终结技放在帧 6：该投射物不再命中；
- 终结技放在帧 7：帧 7 命中先发生，随后普攻被打断；
- 第二枚投射物的帧 13 / 14 边界重复得到相同结论。

这证明至少该投射物在命中前仍绑定原施法，并非一生成就永久脱手。

相反，终结技产生燃烧后，在帧 81 被普攻打断，燃烧仍保持与基线相同
的十次帧序列：`76, 106, 136, 166, 196, 226, 256, 286, 316, 346`。
因此该 Buff 在创建后已经脱离终结技根时间轴，按自身生命周期运行。

## 本地执行链已经闭合

运行 `node scripts/compare-calc-interruption-probe.mjs` 得到：

| 用例组 | 完全一致 | 总数 | 已证明内容 |
| --- | ---: | ---: | --- |
| 一帧终结技边界 | 14 | 14 | 根/子时间轴取消与同帧顺序完全一致 |
| 指令接纳/排队 | 10 | 10 | Allow、Mark、独占期、优先级和严格过期完全一致 |
| Buff 与强化分支 | 13 | 13 | 目标状态、Jump、周期 Buff、消费和伤害完全一致 |
| 飞行投射物边界 | 6 | 6 | 当前取消与同帧命中行为和 Calc 一致 |

这里的“完全一致”同时比较：

- 成功指令的类型、技能 ID 与实际执行帧；
- 每个 HP 伤害包的帧、技能归属、元素类型、原始伤害和最终伤害；
- 每个用例的总伤害。

实现并不是一份沃尔夫冈专用脚本，而是以下通用链：

1. Parser/Compiler 把 `JumpToAction`、`MarkCanInterrupt`、
   `SpawnAbilityEntity`、`OnSpellInflictionStart` 编译成运行时动作；
2. Program execution 共享动态 Blackboard，并能在 seek 后取消旧代事件、
   从目标帧重排时间轴和自然结束计时器；
3. `CommandAdmissionProvider` 从证据映射读取 0/2/5/7 档位，统一比较
   `exclusiveFrame`、AllowNext 和 interrupt mark；排队资格走角色局部
   时钟，过期仍走严格墙钟边界；
4. 根施法打断会取消尚未命中的从属投射物 program，已经创建的 Buff
   则按目标实体自己的时钟继续运行；
5. 元素附着的增强事件会触发同元素反应链，强化弹命中后又通过
   `FinishBuffByTag` 消费燃烧状态。

公共数据没有导出命名时间曲线和完整 ProjectileData，因此三项参数放在
`spec/engine-semantic-mappings.json` 中并附黑盒证据，而没有藏进角色代码：

- `ComboSkill / 0.6s` 曲线的目标时钟离散样本；
- 火元素爆发 Buff 的第一次触发边界；
- `normal_skill_plus` 投射物的一帧飞行时间。

这表示当前结论是“对冻结的公开 Calc 行为精确复现”，不是声称拿到了
或复制了 Calc 的后端源码。其它曲线和其它投射物仍需要各自证据，不能
把这三个参数无条件外推。

## 重现

```powershell
node scripts/probe-calc-interruption.mjs --group=all --capture
node scripts/compare-calc-interruption-probe.mjs
npm test
```

冻结结果：

- `fixtures/calc/ake-interruption-probe.oracle.json`
- `fixtures/calc/ake-interruption-probe.manifest.json`

实验仅使用 Calc 公开、无需认证的模拟接口，没有读取或假定其后端源码。
