# AKE / Calc Clean-room 架构总览

## 系统定位

本项目是公开数据驱动的战斗行为重建与交互验证环境。AKE 提供结构和大部分静态参数，Calc 公共接口提供有限场景的行为对照，clean-room 代码负责独立编译和执行，`dmg-end-field` 的 LTS 工作台负责产品交互。

```text
AKE 公开表 / SkillData / BuffData      Calc 公共请求与响应
                 \                         /
                  \                       /
                   固定版本、哈希与 fixture
                              ↓
                  解析、语义映射与依赖闭包
                              ↓
                       可执行技能程序
                              ↓
             指令准入 + 确定性事件运行时
                              ↓
              Hit / 状态 / 资源 / 冷却账本
                              ↓
             时间轴、技能详情与伤害报告投影
```

## 五层结构

| 层 | 当前所有者 | 输出 |
| --- | --- | --- |
| 证据 | `reference/`、`fixtures/`、`sources.lock.json` | 固定来源、版本、哈希和黑盒观察 |
| 规范化 | `ake-data-repository.mjs`、`ake-parser.mjs`、`ake-action-compiler.mjs`、`spec/` | 角色目录、依赖闭包、技能程序、Buff 定义和显式 unresolved |
| 运行时 | `combat-runtime.mjs`、单人/小队 runner 与状态机 | 指令结果、事件 trace、Hit、状态、资源、冷却和最终快照 |
| 投影 | `ake-timeline-projector.mjs`、`demo-service.mjs`、前端 ledger | API 报告、时间轴读取模型和逐 Hit 解释 |
| 产品外壳 | `demo/lts-ui/` | 角色配置、共享变速排轴、详情、报告与交互 |

依赖只允许由上向下。前端不得重新解释 AKE 动作或重新计算已经结算的伤害；运行时不得读取 UI 状态、Calc oracle 或第三方参考实现作为答案。

## 两条执行链

当前仍保留两个不同保证等级的执行入口：

| 执行链 | 入口 | 用途 | 保证范围 |
| --- | --- | --- | --- |
| 固定精确链 | `src/cli.mjs` → `src/scenarios/pelica.mjs` → `simulator.mjs` | 保护最初佩丽卡、资源、失衡和局部时钟 oracle | 固定单角色、单目标样本 |
| 通用链 | assembler → runner → `CombatRuntime` | 自动装配角色/小队并驱动 Demo | 已实现原语和已提供证据范围；不能由“成功执行”外推全角色精确 |

精确链是回归锚点，不是产品主链；通用链是产品主链，但尚未吸收所有精确链实现。文档和测试必须明确自己讨论哪条链。

## 三种“正确”不能混用

1. **结构正确**：公开数据被找到、依赖被闭包、动作没有被静默丢弃。
2. **运行正确**：同一原语按确定性事务执行，来源、目标、时间和退出原因可追踪。
3. **行为精确**：给定冻结输入时，指令、逐 Hit、状态或资源与 Calc oracle 相等。

编译成功、测试通过或全角色能跑完都不自动等于行为精确。每个结论应落到 [验证矩阵](./verification-matrix.md) 中对应的证据层。

## 产品边界

- 工作台面向固定木桩式排轴研究，不实现敌人 AI、导航和完整空间世界。
- AKE 与 Calc 快照版本不同；跨源数值差异必须先排除版本因素。
- Endaxis 只提供机制目录、架构参照和测试维度，不提供本项目的权威数值或可复制实现。
- 前端实时预演与服务端结算仍是两个结果等级；结算存在且 execution digest 匹配时，结算是唯一展示权威。
