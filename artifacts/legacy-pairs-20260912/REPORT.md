# 别礼／汤汤、洛茜／卡缪旧案例复跑

2026-09-12，按用户要求在通用机制修复合入后复跑两组旧案例。23 项既有定向测试通过；三份固定输入各在修复前后运行一次，均无失败指令，伤害和机制事实无回退。本次没有修改引擎、旧测试或旧输入。

## 版本与范围

- 被测提交：`584c0b3cfa74e978689cc3416dc4b242c6244271`，开始时工作树干净。
- 对照提交：`9ff9f948436ef26ab7a599b5c4ab11eba27aac90`，已跟踪文件干净；与修复分支出发点 `2fe976a8731afad4cb9056b5d48e85446bdc89ef` 的差异全部为文档，没有运行代码、数据或输入差异。
- Node `v24.16.0`，串行执行；固定轴使用 `simulateSquadDemo`，与浏览器计算入口一致。每轴两个版本的完整输出及其 SHA-256 均保存，比较过程检查了输入与输出完整性。
- 只跑这两组旧场景：23 项既有测试约 18.8 秒；3 个固定轴 × 2 个版本，共 6 次完整回放。没有新建配装矩阵或运行全套回归。
- 配装、初始资源、终点和依赖按夹具原样保留：别礼／汤汤两份均带原武器及四件装备；洛茜／卡缪保留原武器和空装备。此处的空装备是历史输入事实。

## 固定轴结果

| 输入 | 指令成功 | HP 命中数 | 修复前总伤害 | 修复后总伤害 | 差值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [别礼／汤汤九动作](../../fixtures/ria/lastrite-tangtang-status-provenance.json) | 9/9 | 102 | 647779.4031308988 | 647779.4031308988 | 0 |
| [别礼／汤汤早期爆发](../../fixtures/ria/lastrite-tangtang-hot-start-burst.json) | 9/9 | 101 | 617673.392435624 | 617673.392435624 | 0 |
| [洛茜／卡缪追加终结技](../../fixtures/ria/wulfa-camille-appended-ultimate.json) | 8/8 | 79 | 106623.10821334398 | 106623.10821334398 | 0 |

比较覆盖 26 条指令、480 条伤害记录（其中 HP 命中 282 条）、447 条状态生命周期事件及 38 条资源事件。三个结果的状态／资源列表都低于接口截断上限。

别礼／汤汤九动作仍在 F23、126、137、194 分别形成 1、2、3、4 层寒冷，F206 消耗四层至零。早期爆发轴是另一份输入：其中别礼连携被后继终结技打断，未完成与九动作相同的消耗链；这一现象修复前后相同，不能用“指令成功”代替“完整动作结束”，也不能把它当成九动作或最优轴。

洛茜／卡缪仍为：卡缪强化战技 F294 开始，以派生 `ComboSkill` 在 F314／327／343／364 命中；后续连携等到 F380，末次命中 F427。团队连携在 F364、427 从 0→1→2，洛茜终结技依照实际末次命中后 6 帧在 F433 释放并消耗两层。

## 比较方法与第一处分歧

两份别礼／汤汤输出除生成时间外，完整结果严格相等。洛茜／卡缪从 F433 起出现状态事件序号与日志位置变化；逐命中数值、倍率／修正快照、状态层数和寿命、技能类型、源／目标、技能施放归属、指令时序、资源、连携消费及最终状态都一致。

比较没有简单丢弃因果引用：将当前状态事件 ID 按有序生命周期事件对应回旧 ID，连同命中的 `parentEventId`、状态的父事件及连携账本的来源事件一起重映射，然后比较完整对象。仅排除生成时间和日志定位序号，事件相对顺序保留。具体排除字段、全部原始差异、重映射后的校验和及额外机制断言见 [comparison.json](comparison.json)。三份归一化结果均严格相等。

## 既有测试

完整输出见 [targeted-tests.tap](targeted-tests.tap)：23 通过，0 失败，0 跳过。按名称只选择以下相关行为，其他测试未执行。

| 既有文件 | 本次项数 | 检查的行为 |
| --- | ---: | --- |
| [主控与别礼灌注](../../test/ake-controller-state.test.mjs) | 6 | 命中时主控、同帧切换、普攻内插战技、独立扣费、专属回能、动作结束边界 |
| [汤汤生命周期](../../test/ake-tangtang-lifecycle.test.mjs) | 4 | 水龙卷敌方目标、自然终结技、同次施放共享附着限制、下落增强分支 |
| [寒冷与连携](../../test/ake-cold-combo-gates.test.mjs) | 5 | 真实战技解锁连携、三／四层消费与回能、多龙卷只附着一次、别礼追击与汤汤混合施冷 |
| [卡缪派生技能](../../test/ake-derived-skill-cast.test.mjs) | 4 | 强化战技按真实连携类型结算、后续动作等待、形态重解析、追加洛茜 Q 不改写既有命中和连携授予 |
| [释放依赖](../../test/ake-release-dependencies.test.mjs) | 4 | 实际命中后 6 帧双向随动、动作结束→切换→落地、精确窗口半开边界、宽窗口保持原输入 |

在仓库根目录复跑同一组测试：

```sh
node --test --test-concurrency=1 --test-reporter=tap \
  --test-name-pattern='^(only the current controller|raw Buff-cast replacement|a zero-time switch|a switch anchored|Last Rite accepts|infusion only|a tornado born|natural Tangtang|overlapping tornado|a real plunge|a real Tangtang battle|three real battle|Last Rite combo converts|one real battle skill|Last Rite phantom|Camille enhanced|a following same-actor|real Wulfa-Camille|appending Wulfa Q|Camille last impact|action end, same-frame|precision input|broad input)' \
  test/ake-controller-state.test.mjs \
  test/ake-tangtang-lifecycle.test.mjs \
  test/ake-cold-combo-gates.test.mjs \
  test/ake-derived-skill-cast.test.mjs \
  test/ake-release-dependencies.test.mjs
```

## 证据位置与证明边界

完整压缩输出、输入逐字节副本、元数据及一次性回放／比较脚本保存在本机 `/Users/sailstellar/Documents/ChatGPT/dmg-data/experiments/legacy-pairs-20260912/`，这部分为未提交的本地实验归档。仓库保留本报告、TAP 和结构化差异证据；原历史夹具继续由 `fixtures/ria/` 跟踪。

这是运行时旧案例的回退检查。三个实际运行的 `unresolvedEffectCount` 均为 0，编译依赖中的未解析条目仍为别礼／汤汤各 186、洛茜／卡缪 498，与对照完全一致；不能据此宣称角色所有分支均已实现或全游戏等价。旧输入的游戏合法性未知项也没有被指令成功覆盖。

本次未操作共享浏览器、未截图、未创建新 RIA sealed Run；保存的是离线计算结果，不构成前端布局或交互验收。此前机制修复与范围见 [实现记录](../../docs/specs/runtime-mechanism-contracts/implementation.md)。
