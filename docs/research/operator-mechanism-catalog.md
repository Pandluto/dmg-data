# 32 角色机制目录

本表把角色专有名词归入通用机制族，用于设计测试和发现引擎原语缺口。它不是角色完成度表：当前 finding、风险等级和具体 blocker 只读取 `derived/cleanroom/ake-operator-mechanism-audit.json`。

## 通用机制族

| 机制族 | 运行时应表达的事实 |
| --- | --- |
| 事件订阅 | 事件类型、过滤器、ICD、once、匹配/拒绝原因 |
| 条件代数 | compare、and/or/not 与读取时快照 |
| 状态生命周期 | apply、stack、refresh、replace、extend、pause、inherit、consume 和退出原因 |
| 形态与 overlay | 候选、优先级、选择原因、输入技能与实际执行技能 |
| 子动作与子 Hit | parent/root cast、延迟、来源、快照和取消策略 |
| 周期调度 | interval、次数、刷新、快照与终止条件 |
| 资源与冷却 | before、operation、actual、after、同帧 cohort 和来源 |
| 准入窗口 | 开启、候选、选择、消费、过期和非法原因 |
| 目标与作用域 | source、owner、carrier、target、team 和 controlled target |
| 确定性选择 | seed、候选、权重、roll identity 和可重放结果 |
| patch 与派生值 | patch 目标、相位、运算、读取来源和前后值 |

## 角色到通用能力

| AKE 角色 | 专有表现 | 必须由通用机制验证的核心 |
| --- | --- | --- |
| Endministrator M · `chr_0002_endminm` | 源石结晶、强化战技、击碎 | 状态消费读数、形态 overlay、派生 Hit、冷却事务 |
| Endministrator F · `chr_0003_endminf` | 与男管理员共享机制图 | 与另一性别入口保持同一语义、独立目录和配装身份 |
| Perlica · `chr_0004_pelica` | 末段开连携、导电 | 真实 Hit commit 开窗、元素状态来源、窗口过期与消费 |
| Chen Qianyu · `chr_0005_chen` | 多段普攻、攻击叠层、击飞 | 逐 Hit 堆叠和快照、物理状态、一次动作不被 UI 重放 |
| Wulfgard · `chr_0006_wolfgd` | 燃烧、追加射击、冷却重置 | 子 Hit 的来源/时间、元素反应、冷却事务 |
| Arclight · `chr_0007_ikut` | 追踪层、追加命中、强制导电 | 事件过滤与去重、状态消费、复合连携条件 |
| Ember · `chr_0009_azrila` | 动作期间保护、治疗、倒地 | during-action 生命周期、护盾/治疗、物理状态失败原因 |
| Xaihi · `chr_0011_seraph` | 辅晶、双元素增幅、队伍消费 | team/owner 作用域、队友消费事件、消费开窗 |
| Avywenna · `chr_0012_avywen` | 雷枪、返回、按层缩放 | 独立状态源、消费层快照、ability entity 来源归因 |
| Gilberta · `chr_0013_aglina` | 队伍光环、法术脆弱 | recipient scope、敌方 debuff、全队后续 Hit 读取 |
| Snowshine · `chr_0014_aurora` | 元素附着与庇护 | 附着事务、Shelter 方向、状态与 owner 生命周期 |
| Lifeng · `chr_0015_lifeng` | 消耗接续、派生增益、击倒 | action-link 消费相位、来源链和物理状态 |
| Laevatain · `chr_0016_laevat` | 强化期、技能替换、熔火 | 形态状态机、暂停/延长、状态消费，不使用角色 ID 特判 |
| Yvonne · `chr_0017_yvonne` | 强化形态、末段强化、冻结消费 | 形态 overlay、继承、末段事件和强制状态 |
| Da Pan · `chr_0018_dapan` | 猛击、击倒、击飞、物理易伤 | 统一物理状态、消费、异常伤害和 debuff 事件 |
| Akekuri · `chr_0019_karin` | 连携窗口、持续时间延长 | refresh 与 extend 区分、窗口生命周期 |
| Catcher · `chr_0020_meurs` | 护盾缩放追加 Hit、虚弱 | Hit 时护盾快照、派生 Hit、Weakness 攻击方方向 |
| Estella · `chr_0021_whiten` | 寒冷免疫、物理脆弱 | 免疫拒绝原因、敌方 debuff 与伤害类型过滤 |
| Fluorite · `chr_0022_bounda` | 炸弹过期/消费爆炸 | 退出原因互斥、一次性派生 Hit、冷却减少 |
| Antal · `chr_0023_antal` | 专注、替换堆叠、元素增幅 | replace stacking、派生属性、敌方脆弱作用域 |
| Alesh · `chr_0024_deepfin` | 子技能、强化连携、SP | 子动作、资源先后、形态选择和窗口 cohort |
| Ardelia · `chr_0025_ardelia` | 物理/法术脆弱、腐蚀 | 类型过滤脆弱、反应状态、周期 Tick patch |
| Last Rite · `chr_0026_lastrite` | 施法状态、低温灌注、幻影 | cast 清理、状态消费、team target 和幻影归因 |
| Tangtang · `chr_0027_tangtang` | 水涡、水龙卷、DoT、下落 | 独立状态源、周期调度、消费层和 dive 事件 |
| Rossi · `chr_0028_wulfa` | DoT、完美接续、两段连携 | 确定性选择、窗口标签、DoT 快照、暂停租约 |
| Pogranichnik · `chr_0029_pograni` | SP 阈值、士气、破防 | 阈值跨越事件、independent stacking、同帧资源/状态顺序 |
| Zhuang Fangyi · `chr_0030_zhuangfy` | 强化技能、剑层、剩余冷却缩减 | overlay、独立层、按剩余值冷却和 action snapshot |
| Mifu · `chr_0031_mifu` | 三段战技、失衡分支、猛击别名 | 条件形态选择、目标状态、反应别名与证据边界 |
| Arcane · `chr_0032_lizhiyan` | 双形态、属性比较、簇击 | selector、owner 消费计数、派生技能簇和冷却条件 |
| Camille · `chr_0033_camille` | 追击、末段爆伤、队伍/自身 Buff | 派生技能身份、末段事件、延迟 Hit 和 recipient scope |
| Typhoeus · `chr_0034_typhoea` | 浮空、启示/猎矢、强化射击、箭阵与箭雨 | 形态 overlay、自定义资源、有限攻击次数、子技能图、目标选择、自然爆发与 `TimedGrowingEnhance` 证据边界 |
| Liino · `chr_0035_liino` | 开战状态、倒计时循环、姿态、非技能动作 | onBattleStart、循环收敛、状态绑定形态、事件监听和零层强制状态 |

角色只是通用原语的组合压力测试。出现新角色机制时，应先确认现有机制族是否能够表达；只有确实出现新的状态事务或事件语义时才扩展核心。

逐角色旧分析中的 finding 数、已完成/未完成判断和源码行号会随实现漂移，已保留在 [历史原文](../archive/initial-research-series/17-endaxis-proprietary-mechanism-generalization-audit.md) 与 [后续对接草稿](../archive/initial-research-series/20-generic-engine-per-operator-integration.md)，不在本页继续复制。
