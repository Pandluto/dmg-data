# 2026-09-03 通用运行时语义收口

## 目标

把 1.5.3 升级暴露的重复缺口按通用契约一次处理，使相同 AKE 结构不再因角色、专用样例或 child 文件是否存在而进入不同规则。实现、测试、三类 audit、timing 画像和当前架构在同一提交同步。

## 基线与结果

基线为提交 `9bce3c1b8ee5ab671fad6d8c55772338c9e8ae2a`。数字是该基线与本次重生成报告的带日期差异，不替代 [当前证据快照](../evidence/current-snapshot.md)。

| 指标 | 基线 | 本次结果 |
| --- | ---: | ---: |
| calculator-core complete | 7,464 | 7,500 |
| calculator-core executable route | 10,796 / 11,143 | 10,803 / 11,143 |
| ability event complete 类型 / 消费者组 | 30 / 920 | 31 / 927 |
| operator findings | 3,477 | 3,362 |
| operator combat risks | 1,080 | 965 |
| combat-blocking | 312 | 197 |
| condition-algebra | 130 | 53 |
| child-action | 32 | 1 |
| event-subscription | 46 | 39 |
| runtime timing profiles | 258 runtime + 16 fallback | 274 runtime + 0 fallback |

`combat-partial=284` 与 `evidence-missing=484` 没有因本次实现被伪造为完成。剩余项主要属于随机/曲线、外部 provider、空间世界、特殊状态/形态和缺失上游正文。

## 已统一的语义

### 条件与值

- condition list 统一解释 `NotNextCheckAction`、nested `OrConditionAction` 和连续 All；伤害修正、Buff 切换、序列 gate 与 IfElse 共用同一入口。
- damage tag、目标组包含、实体类型、职业、super armor、Poise、skill-hit、interrupt reason、custom event 和 ability entity 剩余时间进入可执行谓词。
- 未知条件继续生成 fail-closed diagnostic，不以 false/true 常量假装已理解。

### 事件、目标与实体

- `TriggerCustomAbilityEvent` 产生真实 `OnCustomAbilityEvent` envelope，并携带名称和参数到 listener Blackboard。
- `MainCharacterValidator`、目标组全量读取和 per-target cadence 进入通用路径。
- marker-only ability entity 可以独立存在；source、target、duration、到期、timeline cleanup 和 source death 共享一套 lifecycle。
- child SkillData 变成可选行为依赖。文件缺失仍进入依赖审计，但不再让父技能抛错或抹掉 marker。

### 状态与时间

- `TimedGrowingEnhance` 保存零层容器、离散层数、上限、增长 interval 和 generation-safe timer；直接 CreateBuff 层数按离散语义截断、封顶。
- timing 生成器的 274 个技能画像全部来自 isolated runtime probe，不再因该状态结构退回静态路径。
- DamageUnit 的 tag、目标 interval 和实体期限从 compiler IR 一直保留到实际运行时读取。

## 未扩大声明的边界

- 没有猜测 `Probablity`/`RandomAction` 的 PRNG、seed 或调用顺序。
- 没有猜测曲线插值、enemy rank、dungeon/environment、AI、几何、碰撞或多目标世界结果。
- 没有伪造固定来源中缺失的 SkillData/BuffData。
- `TimedGrowingEnhance` 的本地字段语义已实现，但没有相应 Calc oracle，不能写成外部逐帧一致。
- event producer 只在存在真实事务 edge 时登记；字符串列入表不算完成。

## 验证与追溯

实现由 `ake-runtime-semantic-closure`、`ake-timed-growing-enhance`、`ake-missing-skill-dependency` 与既有 ability-entity、事件和 timing 测试覆盖。最终提交同时重生成 action、ability-event、operator-mechanism 和 timing 输出，并执行根 `check`、前端 typecheck/test 与 Demo production build。

设计约束见 [ADR-0004](../architecture/decisions/0004-source-backed-runtime-semantics.md)，当前事实见 [战斗运行时](../architecture/combat-runtime.md)，仍未闭合的外部边界见 [当前边界](../architecture/known-boundaries.md)。
