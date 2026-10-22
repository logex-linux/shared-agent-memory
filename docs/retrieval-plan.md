# 按需检索实施方案

## 审计及修改前实测

冻结 0.2.0（051be15）的 dist，只增加观测计数，在原 100/1,000/10,000 条合成快照上重测。20 个查询、每个三轮、预热后共 60 次，所有测量要求 hybrid，否则失败。

| 记忆数 | p50 / p95 ms | 正文读取/次 | JSON 解析/次 | 向量距离结果送入 Node/次 | Recall@5 | MRR |
|---:|---:|---:|---:|---:|---:|---:|
|100|8.3 / 10.3|100|214.25|100|1.0|0.8792|
|1,000|34.8 / 40.0|1,000|2,014.25|1,000|1.0|0.8792|
|10,000|344.1 / 389.4|10,000|20,014.25|10,000|1.0|0.8767|

10,000 条时平均候选 20.65 个，返回 5,762 bytes，估算 1,921 tokens（UTF-8 bytes / 3 向上取整，不是指定 LLM 的 tokenizer）。只有一条 gold 的严格合成标注下，返回条目误召回比例约 79.8%；这只是该测试集的非 gold 比例，不等于真实用户知识库准确率。原实现的过期过滤、标识符判定、词覆盖度和输出多次解析完整正文。

## sqlite-vec 实验

本机扩展 v0.1.9、SQLite 3.53.1。已知的[官方源码版本](https://github.com/asg017/sqlite-vec/blob/e9f598abfa0c06b328d8fe5da9c3760cce74be10/sqlite-vec.c)及实际 EXPLAIN QUERY PLAN 均确认：`embedding MATCH ? AND k=? AND chunk_id IN (子查询)` 支持在 Top-K 前约束候选。虚表计划包含 `INDEX 0:3{___}___[___`。TEXT 元数据与 partition key 亦可用于约束，但分区 IN 会分别执行，各分区结果并非一个全局 K；本方案不采用分区。

10,000 向量的独立 SQL 探针（单个固定查询，各 30 次，非全工作负载）：scalar cosine p95 284.6ms，L2 KNN 10.2ms，cosine KNN 12.3ms。此次候选顺序一致，但不把 L2 和 cosine 对浮点向量视为无条件等价。采用 cosine KNN 保留原距离语义；它是精确 KNN，不是 ANN。内部扫描数/距离计算次数无法从扩展公开接口准确读取，报告 null，不用 Top-K 数替代。

## 实施

1. Schema 5：memory_search 存储结构化 scope/project/revision/status/profile/branch/commit/environment/expires_at，metadata JSON 不含 content。事务触发器与主记录同步。新增 chunk_fts 和 chunk_identifiers。
2. 现有 memory_vec 在迁移事务中复制为 cosine 距离表；不重编码向量、不改写正文和历史 ID/revision。迁移先备份，详见最终迁移文档。临时复制需要额外磁盘空间。
3. 一个 SQLite 读快照内独立执行向量、FTS、标识符候选通道。作用域及适用条件作为各通道候选的 SQL 前置约束；不先全局截断再过滤。对单条多 Chunk 占据候选的问题，排除已选 Memory 后继续取精确 Top-K，直到达到候选数或耗尽，不使用固定过量截断来猜测覆盖率。
4. Node 只接收候选 ID、分数和少量索引词；只为最终入选记录读取 metadata 和命中 Chunk。普通检索不读取完整 body；按 ID 展开保留原行为。
5. 最多合并同一记忆两个命中 Chunk；相邻/重叠片段合并，非相邻片段保留独立 offset。来源与 ID/revision 保留。
6. 可配置估算 token 预算，保留 32,000 bytes / 5,000 字符硬限。削减片段或候选时保留来源，明确预算不足/insufficient。相关性与核验状态分离。
7. 增加诊断与专门回归，重跑原测试、100/1,000/10,000 A/B，比较 Recall@5、MRR、误召回比例、RSS、正文读取及 JSON 次数。不接受无 A/B 支撑的准确率退让。

实施和性能验证使用本地源代码与隔离合成库。公开发布内容仅包含代码、通用文档与合成测试；真实用户记忆、数据库、模型权重及客户端配置保留在本机。已有运行实例的升级需另行备份和迁移。
