# AKE / Calc Clean-room 战斗运行时

这个仓库从固定版本的 AKE 公开数据和 Calc 公共接口行为出发，独立实现可执行、可审计的战斗运行时。它负责把角色、技能、Buff、资源、敌方状态和时间轴命令编译成确定性的事件结果，并把同一份结算投影到复用的终末地伤害工作台界面。

> 这不是 Calc 后端源码，也不声称完整复现游戏。当前精确结论只覆盖已经固化为 oracle 的场景；其余能力必须区分“可编译”“可执行”“需要外部适配”“缺少证据”和“已与 Calc 对拍”。

## 当前边界

- AKE TableCfg 固定为 `1.4.4@9433094-12`，Calc 数据固定为 `9163343-11`；两者不是同一数据版本。
- `sources.lock.json` 保存公开来源、版本与 SHA-256；运行时不读取 Calc oracle 作为答案。
- `src/core/simulator.mjs` 是佩丽卡固定场景的精确回归锚点；通用产品链使用 `CombatRuntime`、AKE 编译器和单人/小队运行器。两条链仍然并存，保证范围不同。
- `demo/lts-ui/` 复用 `dmg-end-field` 的产品外壳；战斗结算来自根运行时，前端实时预演只提供尚未结算时的规划反馈。
- `reference/third-party/akedatabase/` 是隔离的强 copyleft 研究快照；`src/` 不导入其中实现。许可说明见 [NOTICE.md](NOTICE.md)。

## 本地运行

运行根引擎测试：

```bash
npm test
```

首次启动交互工作台：

```bash
npm run demo:install
npm run demo
```

浏览器打开 `http://127.0.0.1:43821`。Vite 开发服务会同时提供 AKE 目录和小队模拟 API。

构建并以生产静态服务运行：

```bash
npm run demo:build
npm run demo:serve
```

常用研究入口：

```bash
npm run simulate:pelica
npm run simulate:pelica-generic -- --no-write
npm run simulate:poise
npm run verify:cross-character
npm run audit:ake-actions
npm run audit:ake-ability-events
npm run audit:ake-operator-mechanisms
```

记录并查询可重放计算证据：

```bash
npm run ria -- case create --case-id first-investigation --title "计算调查"
npm run ria -- session create --case-id first-investigation --session-id session-1
npm run ria -- record --case-id first-investigation --session-id session-1 \
  --fixture fixtures/ria/pelica-normal-skill.json
npm run ria:server
```

RIA 把 Case、Session、不可变 Run、事实事件、状态证据、重放和 first-divergence diff 保存到默认被 Git 忽略的 `artifacts/`。参见 [RIA 快速开始](docs/guides/ria-quickstart.md)。

## 仓库结构

| 目录 | 责任 |
| --- | --- |
| `reference/public-data/` | 固定的 AKE 与 Calc 公开输入 |
| `reference/third-party/` | 隔离的第三方研究参考 |
| `spec/` | 有证据的语义映射与仍未闭合的外部依赖 |
| `src/core/` | 解析、编译、运行时、状态机、伤害与投影 |
| `fixtures/` | Calc 请求、响应、manifest 与归一化 oracle |
| `derived/` | 可重新生成的分析、审计和模拟结果 |
| `test/` | 根引擎、状态机、编译器与 oracle 回归 |
| `demo/` | API 接线与复用的 LTS 工作台 |
| `src/ria/`、`schemas/ria/`、`openapi/` | 可重放调查档案、REST/SSE、Schema 与受控 replay |
| `artifacts/` | 本地不可变运行证据和可重建索引；真实数据默认 Git ignore |
| `docs/` | 当前架构、测试方法、研究与维护历史 |

## 文档

- [项目文档入口](docs/README.md)
- [架构总览](docs/architecture/overview.md)
- [当前系统与模块职责](docs/architecture/current-system.md)
- [数据来源与派生链](docs/architecture/data-lineage.md)
- [战斗运行时](docs/architecture/combat-runtime.md)
- [共享变速时间轴](docs/architecture/shared-variable-rate-timeline.md)
- [引擎与前端接线](docs/architecture/frontend-integration.md)
- [可重放调查档案](docs/architecture/replayable-investigation-archive.md)
- [RIA 快速开始](docs/guides/ria-quickstart.md)
- [验证矩阵](docs/architecture/verification-matrix.md)
- [当前边界与未闭合项](docs/architecture/known-boundaries.md)
- [Endaxis 对照研究](docs/research/endaxis-comparison.md)
- [文档重组记录](docs/maintenance/documentation-cleanup-20260828.md)

## 文档维护

`npm run check:docs` 检查当前文档链接；`npm run check` 再运行根引擎测试。数字型覆盖结论以重新生成的 `derived/cleanroom/*.json` 为准，不在架构正文中复制一份会漂移的统计。

历史编号文档保存在 [初始研究档案](docs/archive/README.md)，只用于追溯写作与实现演变，不再作为当前事实入口。
