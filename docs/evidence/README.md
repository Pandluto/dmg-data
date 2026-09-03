# 当前证据

本目录只保存由仓库当前输入和生成报告自动汇总的证据页，不保存人工抄录的覆盖率或一次性命令日志。

- [当前证据快照](./current-snapshot.md)：来源版本、目录规模、语料哈希、审计数字和明确缺失依赖。
- `npm run docs:evidence`：重新生成快照。
- `npm run docs:evidence:check`：只检查快照是否与当前数据和审计一致。

证据页说明“当前测到了什么”；架构合同、产品规格、测试方法和升级过程分别属于 `architecture/`、`specs/`、`testing/` 与 `maintenance/`。
