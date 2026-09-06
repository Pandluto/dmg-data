# 卡缪派生技能被提前中断与排轴输入过期

2026-09-05，通过 Chrome 的 live debug 接口冻结用户当前洛茜／卡缪七动作排轴。强化 B 请求 F292、实际 F294；后接卡缪 E 请求 F316。修复前仅保留强化 B 的首个命中，最终只有普通 E 在 F363 发放的一层共享连击。

## 根因与修复

1. `CastSkill` 更新了伤害身份和自然结束时刻，却未更新指令准入所用的控制程序。运行中的连携程序仍被视为优先级 2、独占 24 帧的战技入口；下一次优先级 5 的 E 被错误放行，取消强化 B 的剩余命中与最终发放。两个 runner 现在读取实际派生程序的类型、优先级、局部时间和释放窗口，保留独立输入/root cast 身份。
2. 前端未提交已有的 `queueMode: timeline-sequence`。纠正抢断后，F316 输入会按一次按键的 30 帧缓存过期。provider 现在明确提交排轴持续排队语义；原始按键模拟的严格过期规则保留。执行契约升级到 v4，使旧报告失效。

来源：派生 [SkillData](../../reference/public-data/akedata/Json/SkillData/chr_0033_camille_combo_skill_2.json) 的 `CharacterComboSkill / exclusiveFrame=86`、入口 [SkillData](../../reference/public-data/akedata/Json/SkillData/chr_0033_camille_normal_skill_2.json) 的 `CharacterNormalSkill / exclusiveFrame=24`，以及[已有准入映射](../../spec/engine-semantic-mappings.json)的优先级。此修复是来源驱动的运行时一致性修复，没有新增外部游戏 oracle。

## 原排轴的前后记录

| 记录 | Case | Run |
| --- | --- | --- |
| 修复前 | `browser-case-20260905T043049246z-d5bfe1f1` | `run-ff69a3b9-379b-49de-8a03-bb25ff093694` |
| 修复后 | `browser-case-20260905T044147052z-15c80a18` | `run-347a5e8f-76a4-4e8b-a225-777e48a6b156` |

Run 可通过本机 `GET /api/ria/runs/RUN_ID/manifest` 定位；归档属于本地调查记录，不随 Git 提交。修复后保持相同按钮、请求帧和配装，新增明确的排队模式：

| 事实 | 修复前 | 修复后 |
| --- | --- | --- |
| 强化 B 的 HP 命中 | F314 | F314、F327、F343、F364 |
| 后接 E 的实际释放 | F316 抢断 | F380，等待 64 帧 |
| 连击发放 | F363：0 → 1 | F364：0 → 1；F427：1 → 2 |

Chrome 侧栏和技能标记已读到两层。`COMBO_TRIGGER_UNVERIFIED` 仍表示连携触发门槛尚未完整验证，不能据此宣称整条轴具有外部游戏合法性；它的中文提示已与“条件未满足”区分。

## 验证

- 使用原浏览器输入经实际 squad API 重放，连击峰值由 1 变为 2；未手工写入状态。
- [实际派生技能回归](../../test/ake-derived-skill-cast.test.mjs)覆盖同一角色强化 B 后接 E、完整四次命中、排队边界及两次独立发放。
- 既有共享连击消费/身份回归通过；43 个冻结 Calc 中断样本逐命中保持一致。
- 前端类型检查、构建和文档链接检查通过。
