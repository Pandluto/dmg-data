# 开发指南

## 环境

根引擎要求 Node.js 20 或更高；复用的 LTS 前端当前固定 Node.js 24、npm 11。需要同时开发两层时，统一使用前端要求的版本。

```bash
npm ci
npm run demo:install
```

## 先确定修改属于哪一层

| 修改目标 | 主要位置 | 至少验证 |
| --- | --- | --- |
| 来源与版本 | `reference/`、`sources.lock.json` | 哈希、全部生成物和 oracle |
| 语义映射 | `spec/` | 对应证据、compiler 测试和 audit |
| parser/compiler | `src/core/ake-*.mjs` | 单元测试、动作 audit、受影响角色 |
| 状态/伤害 | `src/core/` 状态机与 resolver | 事务测试、factor 校验、相关 oracle |
| runner/时间 | scenario runner、admission、clock | 同帧顺序、打断、小队和 timeline projector |
| Demo API | `demo/demo-service.mjs`、server/Vite 接线 | 根测试、API 测试和 Demo build |
| 调查档案/API | `src/ria/`、`schemas/ria/`、`openapi/` | `npm run test:ria`、Schema export、OpenAPI/REST/SSE 契约和真实 replay |
| 前端投影 | provider、realtime、ledger、React | 聚焦测试、typecheck、build、必要时浏览器 |
| 当前文档 | `README.md`、`docs/` | `npm run check:docs` 与事实源核对 |

## 实现顺序

1. 找到 AKE 结构、Calc fixture 或已记录语义映射；证据不足时先登记 unresolved。
2. 把原始动作编译为通用 operation，不在核心增加角色 ID 分支。
3. 为 operation 写状态事务或事件测试，明确 source/owner/carrier/target 与相位。
4. 用至少一个角色场景证明组合行为；涉及外部精度时再加入 Calc oracle。
5. 重新生成受影响 audit，检查减少是新增能力而不是降级分类。
6. 若 report schema 或前端语义变化，同步 provider、ledger 和真实页面验收。
7. 更新唯一当前架构页；实现过程写入维护记录，旧方案不回流正文。

## 常用验证

```bash
npm run check
npm run audit:ake-actions
npm run audit:ake-ability-events
npm run audit:ake-operator-mechanisms
npm --prefix demo/lts-ui run typecheck
npm --prefix demo/lts-ui test
npm run demo:build
npm run test:ria
```

不需要每次机械运行全部命令；验证范围应覆盖实际责任边界。修改跨越根引擎与前端时，两边都要验证。

## 文档更新

- 当前架构只描述现在成立的事实，不写提交日志和测试总数。
- 数字型覆盖直接指向生成 JSON；需要抄录时必须带生成日期和基线。
- 新研究先判断它是当前事实、验证方法、外部对照、维护记录还是档案。
- 删除当前入口前先迁移有效结论，并在维护记录中留下旧到新的映射。
- 文档链接和顶层编号旧文档由 `npm run check:docs` 自动守护。

## 更新公开数据

公开数据升级会改变证据基线，必须作为独立工作处理：更新来源锁与哈希，重建依赖和 timing，重跑三类 audit 与全部 oracle，区分上游版本差异和本地回归，并记录尚未闭合的跨版本差异。

## 提交纪律

一个提交应能回答“改变了哪一项责任”和“用什么验证”。机制证据、运行时实现、UI 投影和文档可以按可回滚边界拆分；不要用后续大文档覆盖提交本身的真实演变。完整既有提交索引见 [开发提交演变](../maintenance/development-history.md)。
