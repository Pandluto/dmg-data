# 来源与许可边界

## AKEDatabase

- 上游：<https://github.com/NagiYume/AKEDatabase>
- 固定提交：`1bb9549705eba2601affed4cb8a7ea69ba13b150`
- 上游 README 声明：AGPL-3.0
- 当前固定 `LICENSE` 文件正文：GPL-3.0

`reference/third-party/akedatabase/` 中的文件仅作为第三方研究参考，并随附上游 LICENSE。由于上游 README 与当前 LICENSE 正文存在许可标识差异，本项目按更保守的强 copyleft 边界隔离这些代码。若将其中代码复制、修改、链接或用于网络服务，需要让法务基于上游仓库历史确认适用许可。本目录不提供法律意见。

`derived/ake-analysis/` 是通过执行上述固定版本 AKE 分析器生成的研究输出，并保留原始文件与分析器哈希。它用于理解转换关系和建立测试，不应被误认为官方发布的另一套数据，也不应直接作为未来闭源引擎的实现来源。

`src/` 下的解析器、状态机和伤害计算器是针对已观测行为独立编写的最小实现，不导入 `reference/third-party/akedatabase/` 中的代码。`derived/cleanroom/` 由这套独立实现生成，与 `derived/ake-analysis/` 的来源边界不同。

## AKE 公共数据与 Calc 公共响应

`reference/public-data/` 保存从公开 URL 获取的事实性数据和接口快照。每个文件的 URL、抓取时间、ETag（如服务器提供）和 SHA-256 都记录在 `sources.lock.json`。

这些快照用于：

- 记录数据结构和字段语义；
- 构造独立实现的行为测试；
- 比较公开数据与公开服务输出。

它们不表示 Calc 后端源码已经公开，也不表示缺失数据可以从当前公开资产中恢复。
