# 运行拓扑

## 固定精确链

```text
npm run simulate:pelica / simulate:poise
  → src/cli.mjs
  → src/scenarios/pelica.mjs
  → src/core/simulator.mjs
  → derived/cleanroom/*simulation.json
```

这条链保护早期佩丽卡、资源、失衡和局部时钟 oracle。它不读取通用链的运行结果，也不是 Demo 的服务端引擎。

## 通用单人链

```text
npm run simulate:pelica-generic
  → src/generic-cli.mjs
  → AkeScenarioAssembler
  → AkeScenarioRunner
  → CombatRuntime
  → pelica-generic-runtime-simulation.json
```

装配器负责依赖闭包，runner 负责命令状态，`CombatRuntime` 负责效果与状态事务。三者不能合并成一个“万能引擎”职责。

## 通用小队链

```text
成员配置 + 敌人 + 命令
  → AkeSquadScenarioAssembler
  → AkeSquadScenarioRunner
  → 共享 CombatRuntime
  → projectAkeTimeline
  → schema v3 小队报告
```

小队链拥有一个共享敌人、一个共享 ATB 池和每名成员各自的 USP。命令、Hit、状态、冷却和资源都保留成员、角色、技能与 cast 身份。

## Demo 开发

```text
npm run demo
  → Vite · 127.0.0.1:43821
  ├─ React LTS 工作台
  └─ ake-demo-api middleware
      ├─ GET  /api/health
      ├─ GET  /api/ake/catalog
      ├─ POST /api/ake/simulate
      ├─ POST /api/ake/squad/simulate
      ├─ POST /api/ake/ria/start · /api/ake/ria/seal
      └─ POST /api/ria/runs/:runId/ui-actions（本进程 UI Run）
```

没有 RIA context 时，Vite 插件直接调用 `demo/demo-service.mjs`。配置了 Case/Session/Run 后，provider 的同一份请求由 RIA worker 执行，Vite 在 completed/failed UI action 落盘后 seal；其他 `/api/ria` 请求同源代理到 `127.0.0.1:43822`。请求体上限为 1 MB；服务只绑定 loopback。

## Demo 生产式本地服务

```bash
npm run demo:build
npm run demo:serve
```

`demo:build` 生成 `demo/lts-ui/dist/`；`demo:serve` 由 `demo/server.mjs` 在同一端口提供静态资源和相同 API。它是本地研究服务，不包含远端部署流程。

## 一次页面结算

1. 工作台把角色配置、武器、四件装备和按钮轴交给 `akeProvider.ts`。
2. `akeRealtimeTimeline.ts` 先把按钮关系解析为真实请求帧。
3. provider 为当前输入生成 execution digest，并提交小队模拟请求。
4. Demo 服务装配公开数据，运行到请求终点，再投影命令、Hit、资源、冷却和窗口。
5. provider 保存 schema v3 report；页面只在 digest 匹配时把它视为当前结算。
6. `akeRuntimeLedger.ts` 按按钮和 cast 切片，不重新运行伤害公式。

## 运行产物

| 产物 | 来源 | 用途 |
| --- | --- | --- |
| `pelica-simulation.json` | 固定精确链 | oracle 锚点 |
| `pelica-generic-runtime-simulation.json` | 通用单人链 | 通用链回归与调试 |
| `ake-timing-profiles.json` | timing builder | 前端预演的技能时长、Hit 和释放画像；运行失败时显式携带 diagnostic 并使用结构 fallback |
| API schema v3 report | 通用小队链 | 当前页面结算、逐 Hit 详情和时间轴投影 |
| `ake-*-audit.json` | audit scripts | 覆盖与风险快照，不参与战斗执行 |

结构 fallback 对相同帧和来源技能的静态命中进行聚合，避免子技能图按路径指数展开；它只保证画像可生成，不具备 settled 行为精度。当前 diagnostic 数量见[生成证据](../evidence/current-snapshot.md)。
