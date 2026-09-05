# 汤汤：源码与运行时分析结论

分析基线：`f9ed924e1eb2fe13e3599bea0873948fc219378b`；基线提交日期：2026-09-03 22:57:44 +08:00。
知识整理日期：2026-09-05；机制证据来自同日审计及未提交工作树修复，不能在仅检出该基线时假定修复已存在。
数据基线：AKE `1.5.3@9764758-3`，JSON revision `2026-09-01T22:53:25.945329+00:00`，详见 [来源锁](../../../sources.lock.json)。
本次知识内容提交与日期：见 [版本索引](../README.md#条目版本)。

## 什么时候查这份记录

角色 ID 为 `chr_0027_tangtang`。调查水龙卷打错目标、自然与提前巨浪叠加、涡流提前消失、终结技派生伤害类型或天赋增伤时，从这里进入已有证据。

## 可复用结论

| 已验证的窄场景 | 结论 | 共用语义 |
| --- | --- | --- |
| 固定技能等级下自然施放终结技 | 八次 0.4 倍后接一次 4 倍巨浪；不能继续执行提前结束路径 | 能力实体寿命决定其程序、定时事件和监听的存活 |
| 既有原始下落程序触发的提前结束实验 | 两次 0.4 倍后接一次 7 倍巨浪，只有一次跳转；这组次数取决于该实验下落时点 | Aura 阵营、动作级伤害前置事件与条件跳转共同形成因果链 |
| 自身 Buff 创建的派生水龙卷 | 该固定目标实验的十二跳与寒冷作用于敌人；派生程序有自己的实际技能类型 | 创建者、Buff carrier 与伤害目标分别绑定；首跳要读取同一事务中的目标查找结果 |
| 固定等级/零潜的提前结束派生水龙卷 | 等级参数使天赋为 +60%；直接读 raw fallback 会误取 +30% | 调用/等级 Blackboard 与 DamageScaleProcessor 进入同一解析和 RD 来源链 |
| 实际连携产生涡流后接战技 | 条件未满足时保留实体，条件满足后才唤醒；两次 child cast 的施冷标记分别计数 | 条件观察与 `limitSkillCastId` 按程序和施法身份隔离 |

## 找回证据

- 原始程序：[终结技](../../../reference/public-data/akedata/Json/SkillData/chr_0027_tangtang_ultimate_skill.json)、[水龙卷](../../../reference/public-data/akedata/Json/SkillData/chr_0027_tangtang_normal_skill_water_projhit.json)、[下落结尾](../../../reference/public-data/akedata/Json/SkillData/chr_0027_tangtang_plunging_attack_end.json)。
- 本地机制复现位置：`test/ake-tangtang-lifecycle.test.mjs`、`test/ake-conditional-timeline-seek.test.mjs`、`test/ake-cold-combo-gates.test.mjs`。这些新增回归和相关引擎修复尚未包含于本次知识文档提交。
- 具体参数、修复前后差异、Chrome Run 及追加后继实验见 [完整审计](../../maintenance/tangtang-lastrite-engine-audit-20260905.md)。本次知识整理引用已有结果，没有重新运行所有实验。

## 使用边界

连携开窗触发与消费已在窄场景验证；180 tick 待释放时长仍是沿用共享约定的推定。下落程序链不等于完整 UI 下落操作流已经验收。上述伤害倍率有技能等级与时点前提，不能推广成任意配装/潜能的最终伤害或全角色准确性结论。
