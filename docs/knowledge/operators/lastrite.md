# 别礼：源码与运行时分析结论

分析基线：`f9ed924e1eb2fe13e3599bea0873948fc219378b`；基线提交日期：2026-09-03 22:57:44 +08:00。
知识整理日期：2026-09-05；机制证据来自同日审计及未提交工作树修复，不能在仅检出该基线时假定修复已存在。
数据基线：AKE `1.5.3@9764758-3`，JSON revision `2026-09-01T22:53:25.945329+00:00`，详见 [来源锁](../../../sources.lock.json)。
本次知识内容提交与日期：见 [版本索引](../README.md#条目版本)。

## 什么时候查这份记录

角色 ID 为 `chr_0026_lastrite`。调查普攻中插战技导致丢命中、后台灌注、追击来源、自身/队友回能或三层寒冷连携时，从这里进入已有证据。

## 可复用结论

| 已验证的窄场景 | 结论 | 共用语义 |
| --- | --- | --- |
| 主控别礼 A@0，在 F50 或 F95 插战技 | 原始 `switchToBuffConfig.asSkillCast=true` 条件满足时瞬时施放，原六次普攻命中保留，战技单独付费/冷却 | 施法替代不等于打断并启动普通动作 |
| 普攻结束于 F131 的边界实验 | F130 仍能瞬时替代，F131/132/140 回到普通施放；界面自然时长与占用剪尾另有合同 | 使用真实动作占用和局部时钟判断条件 |
| 灌注后换主控，或延迟重击前换人 | 追击资格读取实际命中时的主控，不能把施法者恒定当成主控 | 动态 MainCharacter、施法者、Buff 来源是不同身份 |
| 从零终结技能量检查回能 | 自身战技可回 16，队友通用回能被阻止；不能从满能量封顶后的净变化反推过滤方向 | `RefrainObtainUsp` 的指定 tag 是允许例外 |
| 汤汤连续三次战技后接别礼连携 | 修复施法隔离后在 F23/173/323 施冷，C@350 合法并消费三层 | 比较状态前后阈值，第三层与第四层不能混同 |
| 别礼灌注普攻与汤汤两次战技交叉施冷 | 别礼幻影的附着目标必须是 Context `tar` 中的敌人；两人来源可以共同组成三层寒冷，连携正常消费 | Buff 挂在自身不代表其派生附着作用于自身；伤害和附着各自核对目标 |

后续完整配装实验定位了一处旧分析遗漏：幻影伤害打敌，但 `SpellInfliction` 编译曾硬编码 `Target`，丢失原始 `Context/tar` 选择器，把寒冷施给别礼自己。界面看似“跨来源层数未合并”，实际是目标错误；修复目标传播，不修改连携门槛。原始选择器见上述幻影 Buff，实际双人输入见 [本轮爆发案例](../../../fixtures/ria/lastrite-tangtang-hot-start-burst.json)。该修复仍需结合工作树与运行记录使用。

## 找回证据

- 原始程序：[战技](../../../reference/public-data/akedata/Json/SkillData/chr_0026_lastrite_normal_skill.json)、[普攻起始](../../../reference/public-data/akedata/Json/SkillData/chr_0026_lastrite_attack1.json)、[灌注自身 Buff](../../../reference/public-data/akedata/Json/BuffData/buff_chr_0026_lastrite_normal_skill_self.json)、[追击](../../../reference/public-data/akedata/Json/BuffData/buff_chr_0026_lastrite_normal_skill_phantom.json)。
- 本地机制复现位置：`test/ake-controller-state.test.mjs`、`test/ake-cold-combo-gates.test.mjs`。这些新增回归和相关引擎修复尚未包含于本次知识文档提交。
- [完整审计](../../maintenance/tangtang-lastrite-engine-audit-20260905.md) 保存具体参数及 Chrome“普攻命中后战技→结束后汤汤终结技”的可保存输入。聚合按钮的 F44 命中属于源 attack2 本地 F24，是前端命中锚点曾经用错时钟的具体反例。

## 使用边界

零能量回能实验是为暴露过滤规则，不能改称用户定义的 [热启动](../terms/hot-start.md)。热启动下还应检查请求量、允许量、封顶与溢出，而非只看最终能量。连携窗口时长仍缺独立游戏边界观测；有限配装搜索不构成全部装备与时序的最优性证明。
