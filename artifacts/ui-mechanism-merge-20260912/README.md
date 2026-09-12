# UI 与机制修复合并检查证据

执行日期：2026-09-12；Node v24.16.0。来源、手动处理及证明边界见 [主库合并记录](../../docs/specs/timeline-execution-order/implementation-main-merge.md)。

| 证据 | 结果与解释 |
| --- | --- |
| [首次根层定向检查](runtime-initial.tap) | 12 项，11 通过；洛茜／卡缪旧日志哈希与机制修复后的已归档哈希不符 |
| [受影响项复跑及两条控制案例](runtime-final-focused.tap) | 3 项通过；旧哈希协调后完整 v0／v1／数组反转比较仍保留 |
| [前端五文件](frontend-focused.log) | 操作序列、控制队列、预演、payload 和 snapshot 通过 |
| [读取最小复现：修改前](read-purity-initial.log) | 一条旧按钮直接读取即可触发一次意外写入 |
| [读取最小复现：修改后](read-purity-final.log) | repository 与 storage 两条读取路径零写入，显式保存正常 |
| [完整服务检查：修改前](integration-smoke-initial.log) | 读取恢复产生一次按钮表写入 |
| [完整服务与前后端接线：修改后](integration-smoke.json) | 恢复和内存迁移零写入、显式保存一次；v1 请求和两条技能执行成功 |
| [最终类型检查](typecheck-final.log)、[最终构建](build-final.log) | 补齐读取路径后均通过；只有已有的大 chunk 提示 |
| [源码与测试指纹](verification.json) | 对两个父版本的改动文件作 SHA-256 记录，main 接入后按相同文件复核 |

`runtime-initial.tap` 与最终定向 TAP 合计覆盖 14 个不同根层测试；旧哈希失败没有被删除或隐瞒。`typecheck.log`、`build.log` 另保留发现读取缺口之前的检查记录，最终状态以上表的 final 文件为准。

离线接线脚本可在仓库根目录运行：

```sh
node artifacts/ui-mechanism-merge-20260912/integration-smoke.mjs
```

它加载实际 catalog／provider／demo／runner，仅使用合成 UI 输入和进程内存存储，fetch 直接接本地函数，未知请求报错；Vite 仅作 SSR 模块加载，不监听端口。脚本会重写同目录的 smoke 结果文件，不生成真实 RIA 归档。
