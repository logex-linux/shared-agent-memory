# 协议与数据结构

MCP STDIO 和 CLI 使用相同的 `MemoryService`。配置路径通过 `SHARED_MEMORY_CONFIG` 或 CLI 的 `--config` 提供，数据库和模型路径必须为绝对路径。

## 工具

| 工具 | 必要参数 | 说明 |
|---|---|---|
| `memory_recall` | `query`、`ids` 或 `cursor` 三选一 | `mode`、`view`、`limit`、单页预算、`debug`；原 project/context/exact_only 参数保留 |
| `memory_propose` | UUID `request_id`、完整 `record` | 更新时同时提供 `target_id` 和 `expected_revision` |
| `memory_commit` | UUID `request_id`、`proposal_id`、`expected_revision` | 新记忆的 expected_revision 为 0 |
| `memory_forget` | UUID `request_id`、`memory_id`、`expected_revision` | 版本必须与当前记录一致 |

完整校验规则以 [contracts.ts](../src/core/contracts.ts) 为准。工具返回一个 JSON 文本内容块；MCP 失败结果设置 `isError` 并返回结构化错误码。CLI 输出 JSON，失败时退出码非 0。

## 检索

```json
{"query":"发布前怎样确认构建结果？","limit":3}
```

`project_id` 省略时搜索当前连接可访问的所有项目。默认安装配置中 `all_projects: true`，允许所有已注册项目；`allow_global: true` 时，跨项目查询默认包含 global。显式提供 `project_id` 则收窄到该项目，默认排除 global，可用 `include_global: true` 加入。

旧配置省略 `all_projects` 时，仍按 `allowed_projects` 列表检索。工具参数只能进一步缩小已有配置范围。指定的分支、commit、environment 与记录条件不符时排除；缺少必需上下文时返回 `requires_check`，过期记录排除。

0.4.0 支持 `mode=auto|focused|broad`，默认auto。limit为单页建议，不再最多10；服务端page_item_limit默认128，无累计上限。返回has_more/next_cursor继续分页。query最多512字符，并检查加前缀后的模型token数。`view=evidence`提供最佳命中的短片段，普通响应默认不含诊断，debug=true显式开启。预算、游标失效、安全与完整示例见[自适应检索协议](adaptive-retrieval.md)。

代码标识符匹配仅提供有限排序加权；`exact_only: true` 才按标识符严格过滤，且必须存在可识别的标识符。

每条结果包含 `id`、`revision`、`project_id`、`content`、`sources`、`valid_for`、`applicability`、`evidence_strength`、`verification.status` 和服务端 `written_by` 和命中片段偏移。按选中 ID 展开完整正文：

```json
{"ids":["11111111-1111-4111-8111-111111111111"]}
```

`evidence_strength` 表示与本次问题的相关性，同一版本在不同查询下可以不同；不等于事实可信度。`evidence_status=insufficient` 表示候选不足以支持答案。空结果不证明某件事从未发生。

## 新增记录

下面是合成参数示例，项目 UUID 必须替换成已注册项目；来源、时间、会话和内容应反映实际获授权的记录。

```json
{
  "request_id": "22222222-2222-4222-8222-222222222222",
  "record": {
    "project_id": "11111111-1111-4111-8111-111111111111",
    "scope": "project",
    "kind": "procedure",
    "title": "发布检查示例",
    "content": "发布前运行项目构建，并检查生成目录和构建日志。",
    "tags": ["release"],
    "sources": [{
      "source_type": "test",
      "uri": "test://examples/release-check",
      "locator": "synthetic documentation example",
      "revision_ref": "v1",
      "checked_at": "2026-01-01T00:00:00.000Z"
    }],
    "verification": {
      "method": "synthetic example",
      "summary": "Demonstration only; not real project history."
    },
    "author_client": "example-client",
    "author_session": "example-session"
  }
}
```

`kind` 可以是 `preference`、`fact`、`decision`、`procedure`、`lesson`。global 记录使用 `scope: "global"` 和 `project_id: null`。可选字段包括 `valid_for`、`derived_from`、`import_key`；来源支持 `source_hash`。

propose 返回 `proposal_id` 与 `expected_revision`，随后 commit：

```json
{
  "request_id": "33333333-3333-4333-8333-333333333333",
  "proposal_id": "44444444-4444-4444-8444-444444444444",
  "expected_revision": 0
}
```

示例 proposal_id 应替换为实际返回值。propose 会持久化候选，但候选在 commit 前不可正常召回。发布前本地生成向量，短事务内重新验证版本，再一起切换正文、索引和候选状态。

## 核验状态与连接身份

`verification`仍需method/summary，新增status（unverified/verified/disputed）、basis（source_claim/model_inference/user_confirmation/code_review/document_review）和evidence。旧记录默认unverified，不从相似度、声明式method或checked_at推断事实已核实。

verified要求服务端配置包含verify能力，basis必须为用户确认或代码/文档审阅，并提供evidence。reviewer和reviewed_at由服务端覆盖生成；调用者不能通过author_client或伪造reviewer冒充管理员。unverified会清除伪造核验身份，disputed允许保存反证。verified代表指定审阅者的可追溯核验记录，不是通用自动事实证明。导入内容重新作为unverified处理。

用户明确要求保存偏好时，普通 writer 可以提交以下核验字段。`basis` 描述来源依据，`status` 描述特权核验状态，两者不相互推导：

```json
{"method":"explicit user instruction","summary":"User explicitly requested this preference be saved.","basis":"user_confirmation","status":"unverified"}
```

将该例的 status 改为 verified，会在不具备 verify 权限的连接上失败，且不会保存候选。MCP 保持原错误码并增加可选诊断字段：

```json
{"error":{"code":"OPERATION_DENIED","retryable":false,"required_operation":"verify","hint":"verification.status=verified requires separate verify permission. For ordinary user-authorized storage, basis=user_confirmation can accompany status=unverified. Do not silently change verification intent or elevate permissions."}}
```

CLI 保留原有字符串 `error: "OPERATION_DENIED"` 和非零退出码，附加顶层 `required_operation`、`hint`。缺少 propose 或 commit 权限时，required_operation 为相应操作，不会误报成 verify。服务端不自动修改核验字段；若调用者确实要求特权核验，需要操作者处理，不能自行切换管理员配置。对于普通保存，应按真实保存意图构造新请求。

数据库schema4为正文写入、候选与事件记录连接配置身份；旧写入保留legacy:unknown。readConfig对没有显式connection_id的旧配置使用真实配置路径摘要。written_by与自报author_client独立，record_updated_at只是记录写入时间，不表示事实核验时间。

## 编辑、依赖和重试

编辑时先 recall 当前记录，再在 propose 顶层增加 `target_id` 和当前 `expected_revision`。记录 ID 保持不变，commit 后版本递增；冲突返回 `VERSION_CONFLICT`，需要重新读取。更新时省略 tags、valid_for、derived_from、import_key 会保留旧值；前三项可用显式空数组/对象清空。

同 request_id、同参数的写请求重试返回相同逻辑结果；同 ID 换参数会被拒绝。不同的逻辑请求使用不同 UUID。依赖记录保存父记忆的 ID 和版本，父来源更新或遗忘时递归失效，不允许循环依赖。

## 遗忘

```json
{
  "request_id": "55555555-5555-4555-8555-555555555555",
  "memory_id": "11111111-1111-4111-8111-111111111111",
  "expected_revision": 1
}
```

遗忘清除目标及依赖正文、关键词和向量索引、相关候选，并保留不含正文的撤销记录。受管理导出需要清理时，返回维护状态；不能把 pending 当作所有副本均已清理。先前聊天结果和非托管备份不受服务器控制。

## 编码、存储与降级

SQLite schema 5 使用 WAL、Chunk FTS5 与 sqlite-vec cosine KNN。从 schema4 原地迁移的步骤与回滚见 [按需检索架构](retrieval-architecture.md)。索引可以从正文重建。BGE 使用固定模型 revision、512 维、FP32、CLS pooling、L2 normalization；query 加中文检索前缀，正文分块最多 384 tokens、重叠约 32 tokens。文件 hash、dtype、前缀和分块协议共同形成 embedding profile。

检索融合 RRF（k=60）、关键词和标识符精确匹配。模型失败、profile 不符或向量索引不完整时，读取可返回 `lexical_degraded`；恢复完整向量功能需要修复配置/文件及必要的索引重建。无法生成有效向量时，发布不能假装成功。

新增错误码包括EXACT_IDENTIFIER_REQUIRED、IMPORT_MODE_REQUIRED、LATEST_REVOCATIONS_REQUIRED、RESTORE_METADATA_NOT_ALLOWED、REQUEST_ID_OWNER_MISMATCH、VERIFICATION_EVIDENCE_REQUIRED。

常见错误码：`INVALID_INPUT`、`SCOPE_DENIED`、`PROJECT_UNKNOWN`、`OPERATION_DENIED`、`QUERY_TOO_LONG`、`VERSION_CONFLICT`、`REQUEST_ID_REUSED`、`DEPENDENCY_STALE`、`DEPENDENCY_CYCLE`、`EMBEDDING_UNAVAILABLE`、`INDEX_PROFILE_MISMATCH`、`REVOKED_IMPORT`、`BUSY_RETRYABLE`。维护与恢复见 [operations.md](operations.md)。


## 0.4.0 片段与诊断

工具名称和写入生命周期不变。token_budget为512–1,000,000，只能下调配置上限（默认6000）；max_bytes只能下调page_response_bytes（默认32000）。预算为当前传输，按UTF-8 bytes/3估算，诊断不占内容Token预算。字节硬限制仍包含诊断，不含外层JSON-RPC。预算不足缩短content或减少条目，保留来源并标记RESPONSE_BUDGET/truncated；来源本身过大则返回blocked_ids，扩大单页预算后重试。

普通查询最多读取每条入选记忆的两个命中Chunk，优先命中位置，重叠/相邻片段合并。新增`excerpts[]`提供每段start/end及chunk_ids，均为原始正文JS字符偏移；非相邻片段由换行省略号连接。原`excerpt`保留为范围包络，精确定位应看excerpts。按ids读取完整正文仍受响应预算约束。

`diagnostics`提供elapsed_ms、candidate_ids、candidates_ranked、full_body_records_read/full_body_bytes_read、json_parses/metadata_json_parses、chunk_text_rows_read、query_embeddings、vector_queries/vector_rows_returned、response_bytes、estimated_tokens。JSON解析数包含检索与查询缓存的显式解析，不涵盖模型库初始化；基准另用全局JSON.parse观测作交叉验证。普通查询的完整正文读取应为0。

sqlite-vec内部的向量扫描量、距离计算次数没有公开计数接口，`vector_internal_scanned`和`vector_distance_computations`为null。vector_rows_returned只表示KNN返回Node的候选行，不能解释为内部扫描量。候选通道在同一个SQLite读快照内独立检索，SQL按顺序执行，保持一致性；没有伪称同步SQLite调用在多核上并行。
