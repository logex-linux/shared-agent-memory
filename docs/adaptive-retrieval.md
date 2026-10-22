# Adaptive Memory Retrieval · 0.4.0

在 [0.3.0 的 Vector-first / Late Materialization](retrieval-architecture.md) 上增量实现；canonical 数据库继续为 Schema 5。质量与性能实测见 [验收报告](adaptive-results.md)，实施前审计见 [方案](adaptive-plan.md)。

## 旧限制与新流程

| 环节 | 0.3.0 | 0.4.0 |
|---|---|---|
| 工具条目数量 | 默认5、最多10 | limit 为单页建议；服务端 page_item_limit 保护单页 |
| 候选通道 | 每通道最多20个 Memory | 分批32→64→128→256，跨页继续，无累计数量上限 |
| 继续检索 | 无 | has_more、next_cursor；查询状态持久化到辅助 SQLite |
| 排序 | 固定候选池 RRF | 相关性前缀、适用性、词法覆盖、主题提示与分布、多样性 |
| 输出 | 含完整诊断 | 默认简洁；debug / 管理员 diagnostics 才带计数 |
| 正文 | 只读取选中 Chunk | 保持晚物化；evidence 只取最佳 Chunk 的短片段 |

新查询只编码一次。后续页面复用查询向量，在同一个 canonical 读快照中检查 generation、权限摘要、版本、有效期和上下文，再对各通道检索。通道排除已发现的 Memory；已提交的 seen 表通过索引反连接查询，本页未提交的少量 ID 单独排除，不发送累积的全部 ID 到 Node。没有 LIMIT/OFFSET 深分页。

SQLite 内部可扫描符合条件的索引项；这仍是精确 cosine KNN，不是 ANN。SQL 返回的是少量 Chunk ID / distance 和轻量索引信息，不是全库正文。候选在磁盘状态库中累积，本页只读取至多 page_candidate_budget 个轻量对象；当前页入选时才读取来源与命中正文。普通查询完整 body 读取为0；ids 展开才读取完整记录。

## 模式与启发式

- `focused`：事实、错误、操作经验；初步候选目标8，明确相关性分布落差且有多个检索信号时可降为1。目标是本页探索建议，不是累计上限。
- `broad`：综合历史、偏好、经验；初步目标32，并观察项目/主题/月份覆盖，按页继续扩大候选。显式 limit 可以提前形成小页，不为凑齐三个 facet 而扫描更多低收益候选。
- `auto`：默认。查询意图提示用于初始选择；也会观察偏好类候选的比例与跨情境分布来扩大广度。不是句长规则，也不依赖单个 cosine 阈值。

保留有限标识符加权；只有 exact_only 才严格限制标识符。基本相关性结合 semantic_threshold、词法覆盖和标识符。扩展阶段使用查询中已有的标签提示、初步候选的相关性峰值，以及跨情境强候选的主题族分布。主题为已有标签的启发式，不是自动知识图谱：首标签作为粗主题族，末标签作为细主题；没有标签时不推断粗主题族。

首批最多五个位置沿用0.3的相关性贡献窗口作为质量锚点，随后进行多样性排序。该窗口只影响首批打分，不限制发现、存储或返回候选；第21条、50条、160条及以后仍能被后续页面检索。此措施来自 A/B 中发现的前列质量回退，不能宣传成彻底移除所有固定数字。适用性优先于质量锚点；requires_check 不挤掉可以直接适用的结果。

后续候选按来源路径族、项目、月份、主题分配有限新颖性奖励，跨页记录已返回分布。不会因为同一主题有大量高度相似记录而只读该主题；也不会自动合并或删除相似记录。同一 Memory 只返回一次，选择最佳两个 Chunk 并合并相邻片段。需要更多片段或全文时用 ids 展开。

停止原因：

| stop_reason | 含义 |
|---|---|
| exhausted | 当前启发式准入的候选及各通道已耗尽 |
| low_marginal_gain | 相关候选产出稀疏或已有突出结果，建议先判断本页证据；has_more 可仍为 true |
| page_budget | 单页条数、字节或 token 保护，需要续取 |
| candidate_budget / time_budget | 本页候选工作量或协作式时间预算耗尽，需要续取 |
| insufficient | 本页没有足够相关证据；可能还有尚未探索的候选 |
| item_exceeds_budget | 单条来源/元数据也无法完整容纳；blocked_ids 可定位，扩大单页预算后重试同一 cursor |

`assessment: "heuristic"` 明示不确定性。exhausted 不证明现实中不存在其他相关事实，也不保证模型的语义召回100%。`evidence_status=related_evidence` 只表示找到相关证据，绝不表示已经证明答案充分或记忆真实。只有弱候选时返回 insufficient。Agent 应在低边际收益时先判断已有证据，而不是机械遍历所有弱候选。

## 分页接口与示例

```json
{"query":"根据过去的项目和讨论，有哪些设计偏好？","mode":"broad","view":"evidence","limit":12,"token_budget":4000}
```

```json
{"cursor":"am4:返回的查询UUID:1"}
```

cursor 为服务返回的不透明值，调用者不得自行拼接。后续请求继承原查询、范围、context、mode、view、limit 和单页预算；对于尚未生成的新页，可显式覆盖单页 limit / view / token_budget / max_bytes。不能改变 query、scope、mode 或 context。

```js
let request = {query: "有哪些反复出现的设计选择、反例和临时要求？", mode: "broad", view: "evidence"};
while (true) {
  const page = await memory_recall(request);
  // 分批审阅 ID/revision/source、verification.basis 和场景；不要一次堆进全部上下文。
  reviewEvidence(page.items);
  if (!page.has_more || sufficientForCurrentAnswer(page)) break;
  request = {cursor: page.next_cursor};
}
// 如需原文，使用挑选出的真实 UUID：memory_recall({ids: selectedIds})，每次最多10个。
```

CLI 使用同一 JSON 参数：`npm run cli -- recall --input /absolute/path/request.json --config /absolute/path/config.json`。不增加新 MCP 工具，不改变提议→提交、Revision 冲突或显式遗忘流程。

长期偏好应跨页查看明确陈述、行为观察、模型推断、被否定的方案和变化。来源的 source_type、时间、定位、verification.basis/status、项目和适用条件保持可查。单次选择不能自动变成永久偏好。服务不生成或持久化新用户画像；综合判断留给 Agent，写入仍需既有授权。

## 单页资源与响应

| 配置 | 默认 | 范围/说明 |
|---|---|---|
| response_token_budget | 6000 | 512–1,000,000；请求只能下调配置上限 |
| page_response_bytes | 32000 | 2048–1,048,576；JSON payload 硬限制 |
| page_item_limit | 128 | 1–10000；请求 limit 受此保护，无累计上限 |
| page_candidate_budget | 512 | 32–10000；本页跨通道返回行的工作量保护 |
| page_time_budget_ms | 2000 | 10–60000；在原生 SQL 之间检查的协作式时间预算 |
| query_ttl_seconds | 1800 | 1–86400；有效续取/重放刷新 TTL |
| diagnostics | false | 管理员可开启；调用者也可显式 debug=true |

Token 估算是 `ceil(紧凑JSON UTF-8 bytes / 3)`，不是任意 LLM 的真实 tokenizer。预算作用于当前传输的业务结果，包括来源、游标和必要标记；诊断不占内容 Token 预算。字节预算预留最多2048 bytes、内容估算预留256 bytes 给游标及末尾标记；debug 仍服从整体硬字节限制。diagnostics.content_estimated_tokens 为业务结果估算，estimated_tokens 包括诊断本身；两者不可混用。

普通结果保留 id、revision、written_by、项目/类型/标题、content、sources、verification、valid_for、applicability、片段偏移与相关性标记。hash、模型 profile、作者会话等冗长展开信息留给 ids。`view=evidence` 从最佳命中 Chunk 取至多200个JS字符，仍保留完整来源，不截掉来源来凑条目数。来源过大时明确阻塞并允许增大预算，不静默丢弃。

诊断包括耗时、累计 candidate_ids、本页 candidates_ranked、正文/片段读取、显式 JSON 解析、查询编码、向量查询及返回行、字节与估算 Token。查询缓存的显式解析也计入 json_parses；模型库初始化不包含在内。内部向量扫描量和距离计算量不可准确观测，保持 null。实际延迟 p50/p95、全局解析观测和 RSS 由基准脚本在外部测量。

## 游标安全、一致性与恢复

canonical Schema5 不变。辅助文件 `<真实database路径>.retrieval.db` 使用 WAL、0600 权限、secure_delete，保存查询参数/向量、候选 ID/分数/Chunk偏移、散列 facet、通道进度与不可变页面选择；不缓存记忆正文或来源原文。游标是随机128位查询 ID 和页序号，服务器查表验证，不是可以绕过 ACL 的令牌。

绑定内容：真实数据库路径、connection_id、允许的项目/操作、all_projects/global、注册项目集合、检索阈值、模型配置、排序策略版本、原查询和 canonical generation。每页重查权限及适用性。任何正式发布、修订、遗忘或索引重建导致 generation 变化后，旧游标拒绝；时间经过导致旧页条目过期也拒绝重放。新页跳过已过期候选；显式项目过滤和 global 规则从候选 SQL 开始执行。

| 错误 | 处理 |
|---|---|
| CURSOR_STALE | 数据已变化；用原 query 重新检索，按 ID/revision 比较新证据 |
| CURSOR_SCOPE_CHANGED | 连接权限、项目注册或检索策略变化；重新检索 |
| CURSOR_EXPIRED | TTL 到期、缓存删除或不存在；重新检索 |
| CURSOR_QUERY_MISMATCH | 不能沿同一 cursor 修改范围/mode/context；新建查询 |
| CURSOR_INVALID | 格式错误或试图跳过尚未生成的页面；使用服务返回的 cursor |
| CURSOR_PAGE_OPTIONS_MISMATCH | 已生成页面必须按原选项重放；新页才可改变预算/view |
| CURSOR_PAGE_BUDGET_CHANGED | 管理员收紧上限后原页无法重放；重新检索 |
| CURSOR_INDEX_CHANGED | 索引损坏或 profile 不符；检查/修复后重新检索 |

单个缓存短写事务串行生成页面，canonical 保持 WAL 读快照；查询编码在事务外。跨进程竞争同一新页只会生成一次，其他进程重放同一 ID 与 Chunk 选择。缓存事务失败整体回滚；SIGKILL 后 SQLite 恢复。canonical 写入可并行，写入若发生于本页快照之后，下页因 generation 变化失效。缓存锁超过5秒时 BUSY_RETRYABLE，可重试同一请求。

缓存内容可能随查询次数及候选数增大，过期状态在后续调用时清理，空闲页留给 SQLite 复用。不要手动删除正在连接的 sidecar；关闭所有服务实例后才可清理或 VACUUM。查询向量、查询词和候选标识仍有隐私意义，应按用户数据保护。

## 升级、备份与回滚

1. 暂停客户端，保留0.3程序与 lockfile，按既有维护步骤备份 canonical SQLite 和最新撤销清单。
2. 更新代码、npm ci、npm run build，使用原配置启动；新字段有默认值，不需修改客户端。首次查询仅创建可丢弃的辅助缓存，不修改 canonical Schema5，不重编码记忆。
3. 运行 check；用隔离库验证 query、分页、ids 和读写权限后再供日常客户端使用。此次开发只操作合成测试库，没有升级任何真实运行实例。
4. 回滚时停止所有实例，恢复0.3程序和 lockfile，重新构建；如曾添加0.4配置字段，应使用备份的0.3配置，旧版严格校验不接受新增键。canonical 数据无需反向迁移；0.3忽略辅助文件。可在停机后删除 `.retrieval.db` 及相应 `-wal/-shm`，所有 cursor 会失效。不能为回滚覆盖已发生新写入的 canonical 数据或丢弃最新撤销清单。

备份不需要包含查询缓存；崩溃或搬迁后重新检索即可。删除记忆继续使用既有事务与撤销机制；旧缓存不含正文且 generation 校验阻止读取已遗忘内容，其 ID/分数等短期状态会随 TTL 清理。不要把“无正文缓存”宣称为无任何残留元数据。
