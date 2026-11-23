# Shared Agent Memory 自进化诊断与架构升级方案

状态：v1.0-rc1（`1.0.0-rc.1`）已完成实施、全套单测与同机配对 A/B 验证，并已同步至本地运行库（Schema 14 零改库）  
日期：2026-11-23  
基线：`1.0.0-beta.7`（Git HEAD `6b5d625`） → 候选：`1.0.0-rc.1`，Schema 14  
工作分支：`main` / `sam/v1` / `feat/self-evolve-v1`

## 0. 执行摘要

本轮基于 `1.0.0-beta.7` 源码审计、生产 SQLite 只读快照探针（473 条活跃记忆 / 752 个 Chunk）与 274 份历史调用日志分析，建立 32 条人工复核回归基准后推进到 `1.0.0-rc.1`。实测表明既有混合检索框架（BGE Cosine KNN + FTS5/BM25 + 精确标识符）总体有效，问题集中在**响应包络臃肿、单条/跨记录支持口径断层、单结果收缩误杀与 `exact_only` 零命中空转**。

`1.0.0-rc.1` 已落地以下四项改进：

1. **`detail=compact` 证据包压缩（P0）**：在 `view=evidence` 下按需省略诊断与冗余包络，保留全部正文、UTF-16 片段偏移、核验状态/依据及核心来源定位；响应估算 Token P50 从 `3,619` 降至 `2,210`（`-38.93%`），正文占比从 `17.58%` 升至 `25.68%`。
2. **页面级多记录联合覆盖 `page_support`（P1a）**：不抬升任何单条弱记录，而对同一项目/Scope/环境且兼容 `subject_id`/`context_key` 的已筛选记录计算最小有序贡献者集合，同时排除 `codex-memory`/`historical-source`/`raw_memories` 原始会话流水，避免跨上下文误拼。有相关命中但整页判为 `insufficient` 的比例由 `41.38%` 降至 `27.59%`。
3. **Focused 收缩保护与 `exact_only` 零命中预检（P1b / P2）**：仅在首条确认为 `direct` 且无互补实体时收缩为 1 条，兼容 `0.2.0` 类零尾缀版本号命中 `v0.2` 候选背景；`exact_only` 在 Query Embedding 前先做范围化 `LIMIT 1` 标识符预检，零命中核心耗时由 `102.8–113.563 ms` 降至 `0.1–0.3 ms`（向量/排序读取降为 `0 / 0`）。
4. **写入侧显式覆盖审查提示（P3）**：在 `propose` 与 `admission_preview` 中针对同标题或显式覆盖措辞（且非低重叠噪音）标注 `suggested_transition: 'supersede' | 'correct'`，从源头减少类似 `372b1412…` / `66ccc8c2…` 的双 `active` 隐式冲突；不实施破坏性自动删除或全库重编码。

`1.0.0-rc.1` **延续 Schema 14、现有 752 个 Chunk 及其 512 维向量，不更改 Embedding Profile，不改写存量正文。**

## 1. beta7 全链路审计

### 1.1 写入链路

| 环节 | 当前实现 | 约束与后果 |
|---|---|---|
| 输入与元数据 | `recordSchema`/Zod 校验项目、类型、来源、核验、适用时间、生命周期等字段 | 元数据由调用者提供；不存在自动事实抽取，不能把缺失字段误称为切分算法问题 |
| 提议与重复检查 | `propose` 持久化候选；检查 `import_key`、规范化正文和来源物化身份；FTS 提供最多 5 条相似提示 | 相似提示仅供审核；不会自动合并语义相似记录 |
| 冲突与更新 | 按 `target_id + expected_revision` 做 CAS； adopted 决策/偏好按 subject、context、environment 检查现行冲突 | 必须保留 Revision、幂等 request receipt、依赖及替代关系事务语义 |
| 切分与 Embedding | BGE small zh v1.5，本地 512 维归一化向量；按标题加正文的 384 Token 预算切分，32 Token 重叠 | 码点以 JS UTF-16 偏移保存；修改切分会改变 Profile，本文不要求修改 |
| 发布 | `commit` 在同一事务写 memories、versions、chunks、vec、FTS、identifier、依赖及事件 | Schema 14 的触发器同步 `memory_search`；正文、版本和索引不能分库异步提交 |

### 1.2 检索链路

1. 新 Query 编码一次；随后固定 canonical 读快照、generation、权限摘要和有效时间。
2. Scope、项目注册、global、任务排除、有效期、branch/commit/environment、生命周期及有效时间在候选 SQL 内生效。
3. 召回通道为 **cosine KNN + Chunk FTS/BM25 + 精确标识符**，不是单向量检索。候选按 32→64→128→256 扩展，使用 RRF、词法覆盖、标识符和启发式证据评分。
4. `focused` 与 `broad` 分别处理事实定位和跨项目归纳；支持上下文适用性、实体/关系/限定词/答案类型、多样性和分页继续。
5. 普通 Query 仅物化入选 Chunk；`view=evidence` 截取至多 200 个 JS 字符。响应受 Token、字节和条目预算约束，查询状态存入 sidecar。

**结论：BM25+Dense、时间过滤、冲突关系、反馈衰减、晚物化和确定性 Rerank 已存在。** 新提案不得重复命名这些能力，也不得在缺少 Bad Case 时增加 neural rerank、ANN 或外部模型调用。

## 2. 数据与日志取证

### 2.1 真实库只读快照

探针先通过 `mode=ro` 源连接执行 SQLite Backup，再只读分析临时副本。结果见本地忽略文件 `.local/evolve-v1/data-probe.json`。

| 指标 | 实测值 |
|---|---:|
| 活跃 / 总记忆 | 473 / 473 |
| Schema / quick_check | 14 / `ok` |
| 当前 Chunk / 多 Chunk 记忆 | 752 / 165 |
| memory_versions / tombstones | 524 / 6 |
| Chunk UTF-16 长度 p50 / p95 / max | 420 / 748 / 1,138 |
| Chunk Token p50 / p95 / max | 286 / 384 / 384 |
| 正文 UTF-16 长度 p50 / p95 / max | 416 / 2,023 / 2,353 |
| 无效正文 JSON / 非活跃 memories | 0 / 0 |
| 完全重复组 / 文本高相似候选对（≥0.88） | 0 / 1 |
| 向量余弦 ≥0.88 跨记忆 Chunk 对（总 / 历史导入 / 含原生写入） | 488 / 483 / 5 |
| 含原生写入的向量余弦 ≥0.85 高相似对 | 20 |
| `codex-memory` 历史导入 / 头占位记录 / 断词残片 | 269（56.87%）/ 22 / 6 |
| `subject_id` / `context_key` 覆盖率 | 2.54%（12/473）/ 4.44%（21/473） |
| 90 天未复核候选 / 已过期活跃记录 | 0 / 0 |
| 活跃历史状态记录 | 1 |
| 缺少 `verification.status` 与 `basis` 的旧记录 | 268（各 268，非 536 条） |

深度语义与状态取证揭示了纯文本匹配未能暴露的三类隐性问题：

1. **隐式覆盖与事实冲突（非普通冗余）**：唯一满足“3-gram 预筛 + SequenceMatcher ≥0.88”的记忆对 `372b1412…` 与 `66ccc8c2…`（同标题、向量余弦 `0.9866`、文本相似度 `0.9087`）实际代表相反事实——前者写有“原文件保留原位、未移动未删除”，而同日稍晚写入的后者明确写有“按用户要求删除原文件，打包文件夹为唯一留存（本条更新此前同主题记录：原文件已不再保留）”。由于写入时走了新建而非 `supersede`/`target_id` 更新，且 `subject_id` 为空导致 `checkCurrentRule` 未触发，两条记录至今同为 `status=active` 且缺少 `lifecycle=historical` 标记。类似隐式覆盖/版本迭代还包括 `49a23d4d…`（「取代 11-15 的 6 相册 1350 张旧数」）、`419ec3d5…`（「此偏好取代旧的 Crawl4AI」）、`5b91c575…`/`a43bc74f…`（Look 抽帧参数）、`99e61e75…`/`d3fa9675…`（chrome-use v0.2 vs v0.3）及 `ca4fbb11…`/`f5a02a5c…`（logex bot v2 vs v4）。
2. **历史导入切分瑕疵**：`269` 条（`56.87%`）带 `codex-memory` / `historical-source` 标签的历史记录中，有 `22` 条仅含 `thread_id`/`rollout_path`/`cwd` 元数据头的极短占位记录（`<350` 字符，彼此向量余弦高达 `0.95–0.97`，易在无精确命中时挤占语义前排），另有 `6` 条跨条目硬切导致的断词残片（如 `b72e2bc0…` 首行 `nd how to do differently:`）。
3. **规则锚点稀疏**：全库仅 `12/473`（`2.54%`）填写了 `subject_id`、`21/473`（`4.44%`）填写了 `context_key`，`checkCurrentRule` 仅能保护显式声明规则的极小切片；`propose()` 的 `similar_candidates` 也仅依赖 FTS 词项重叠（`overlap >= 3`），未结合向量余弦或覆盖措辞提示。

268 条旧记录的读取端默认已经提供 `unverified/source_claim`；**不会把旧数据批量提升为 verified，也不为形式统一改写历史正文。**

### 2.2 历史调取日志

解析 274 个 Codex/StepCode JSONL 文件，排除自进化任务本身，得到 481 次调用、467 条有效响应；其中真实 Query 341 次、有效 Query 响应 332 条、去重 Query 335 条。

| 现象 | 定量结果 | 解释边界 |
|---|---:|---|
| `related_evidence` / `insufficient` | 277 / 190（全部有效响应） | 包含 ID、版本和游标展开，不能直接当准确率 |
| Query 响应估算 Token p50 / p95 | 2,352 / 5,593 | 使用现有 `ceil(UTF-8 bytes/3)` 口径 |
| Query `RESPONSE_BUDGET` | 108 | 预算截断确实发生，不只是理论风险 |
| Query `REFERENCE_EVIDENCE_MISSING` | 166 | 代表指定引用未充分支撑，不等于全部误召回 |
| Query `DIRECT_EVIDENCE_MISSING` | 20 | 代表首页无 `direct` 记录且 `has_more=true` |
| 页内近重复响应 / 片段对 | 2 / 2 | 重复存在但不普遍 |
| 具备核心分阶段耗时的历史响应 | 6 | 样本太小，不用于定论性能根因 |
| 自动改写候选对 | 25 | 人工发现同项目误配，未直接用作 gold |

自动银标曾把 Academic Writing Lab 实验流程误配到 `open_basedir`，把低帧率问题误配到项目总览。最终基准改为人工读取 Query、当前候选标题及正文后标注；Scope 不匹配单独记录，不计漏召回。

## 3. 可重复回归基准

### 3.1 方法

`tests/benchmark_evolve.py` 从日志分层选择 32 个真实 Query，保留原请求中的 Scope、limit、Token/byte budget、`exact_only` 和上下文。每个 Query 预热 1 轮、实测 3 轮，共 96 次 MCP 调用，Top-K=5。人工标注为**非穷尽相关 ID 集合**，因此只报告 Hit、Recall、MRR、已知噪音和支持状态；不伪造“全量 Precision”。

- 运行库：2026-11-22 生产 SQLite 的一次性一致性快照，Scope 校验后共有 473 条可用记录。
- 运行时代码：`beta7`，`core_diff_from_head=false`，Node 24.18.0。
- 输出：`.local/evolve-v1/baseline-beta7.json`，含逐 Query、逐轮、逐阶段数据。
- 所有测量均开启 `debug=true`；壁钟包含 MCP STDIO，核心耗时来自服务诊断。冷启动不计入预热后的 P95。
- 标注状态为 32 条 reviewed，其中 3 条明确无在库目标证据。`reviewed_precision_at_k` 因非穷尽标注保持 `null`。

### 3.2 基线与 v1.0-rc1 A/B 实测对比

以下基线与候选数据均基于同一生产 SQLite 只读快照、同一 32 条人工复核 Query（每轮 32 次、共 96 次 MCP STDIO 调用，开启 `debug=true`）在同一机器同机复跑得到：

| 指标 | beta7（原基线 / 同机配对） | v1.0-rc1 (`detail=full`) | v1.0-rc1 (`detail=compact`) |
|---|---:|---:|---:|
| 成功调用 / 错误率 | 96 / 96，0% | 96 / 96，0% | 96 / 96，0% |
| Reviewed Hit@5 | 96.55%（84/87） | **100.00%（87/87）** | **100.00%（87/87）** |
| Reviewed Recall@5 | 70.89%（168/237） | **72.15%（171/237）** | **72.15%（171/237）** |
| Reviewed MRR | 0.908046 | **0.942529** | **0.942529** |
| Gold 至少一条为 supported（单条） | 51.72%（45/87） | 51.72%（45/87） | 51.72%（45/87） |
| 有相关命中但页面仍 insufficient | **41.38%（36/87）** | **27.59%（24/87）** | **27.59%（24/87）** |
| 无目标证据时正确 abstain | 100%（9/9） | 100%（9/9） | 100%（9/9） |
| 已知高分 / 弱背景噪音返回数 | **0 / 18** | **0 / 18** | **0 / 18** |
| 无重复片段响应 | 96.875% | 96.875% | 96.875% |
| 普通查询完整正文读取 | 0 | 0 | 0 |
| 核心耗时 p50 / p95 / p99（配对时段） | 40.483 / **63.972** / 140.576 ms | 39.767 / **60.778** / **69.153 ms** | 39.330 / **58.470** / **66.750 ms** |
| 空 `exact_only` 用例核心耗时 / 向量行 / 排序 Chunk | 102.8–113.563 ms / 288 / 398 | **0.1–0.3 ms / 0 / 0** | **0.1–0.3 ms / 0 / 0** |
| MCP 壁钟 p95 / p99（配对时段） | **67.556** / 156.832 ms | **67.027** / **73.191 ms** | **63.126** / **70.281 ms** |
| `RESPONSE_BUDGET` 触发次数 | 24 | 24 | **15** |
| 响应估算 Token p50 / p95 | 3,619 / 5,533 | 3,619 / 5,577 | **2,210（-38.93%）** / 5,012 |
| 正文估算 Token p50 / p95 | 563 / 1,421 | 563 / 1,421 | 594 / 1,421 |
| 正文 / 总响应 Token | **17.58%**（53,031 / 301,590） | 17.42% | **25.68%** |
| 非正文估算 Token p50 | 2,927 | 2,927 | **1,650（-43.63%）** |
| 来源估算 Token p50 / p95 | 915 / 1,889 | 915 / 1,889 | **689 / 1,548** |
| 重复来源估算 Token | **0** | **0** | **0** |

注：1) 基准基线原始保存于 `.local/evolve-v1/baseline-beta7.json`（空闲时段核心 P50/P95/P99 为 `34.035 / 53.127 / 113.563 ms`），上表耗时尚列同步给出同一时刻、同一机器状态下的 `beta7`（`6b5d625`）与 `rc1` 配对实测对比：`rc1 full` P95/P99 为基线的 `0.95x / 0.49x`，`rc1 compact` 为 `0.91x / 0.47x`。2) 对 `e917ea45…` 用例，初版未过滤 `codex-memory` 原始线程标签时曾误把 1 条非 gold 全局提醒与 1 条 `codex-memory` 聊天记录拼成 `page_support`（`24.14%`）；排除未策展原始对话记录后，5 组触发 `page_support` 的用例全部为 2 条精确互补的策展记录且均覆盖对应 gold，干净口径为 `27.59%`（较基线下降 `13.79` 个百分点）。

包络聚合审计显示，`verification`（41,364 Token）、`support`（20,400 Token）、`answer_relevance`（12,018 Token）是前三类条目级开销；`uri`（27,600 Token）是最大来源字段。重复来源为 0，页级来源表去重不是有效措施。`detail=compact` 通过省略诊断性字段与按需字段（`source_hash`/`checked_at`/完整 `verification.method`/`answer_relevance`/`snippet_selection`/`support.basis`/`support.subject_coverage`/冗余 `excerpt` 等），在不丢失任何正文与来源定位的前提下，将响应估算 Token P50 降至 **2,210**（`-38.93%`），正文占比提升至 **25.68%**。

### 3.3 典型 Bad Case 与根因

#### A. 多事实问题：候选已命中，联合回答仍被判为不足

Query `iamlnx.me/lab Academic Writing Lab open_basedir 无效响应 php 启动` 的前两条正是线上故障与一键修复记录 `d05206d5…`、`854c5248…`。两条均为 `weak / partial`，页面为 `insufficient`。

根因不是 KNN 或 FTS 漏捞，而是 `src/retrieval/evidence.ts` 的 `supportAssessment()` 让每个候选分别承担 Query 的全部实体（`entities_covered: 2/4`）、关系和回答类型。多记录本应互补时，没有任何单条能单独成为 `direct`，最终无法形成页面级相关证据状态。

#### B. 多标识符问题：相关证据被背景化和单结果收缩隐藏

chrome-use 0.2.0 的原请求要求 `limit=4`。默认首页只返回一条 `e1dbb7d0…` 旧 MCP 排错背景；放宽到 8 条后，`99e61e75…`（v0.2）和 `5836da94…` 分别位于第 5、6 位，均为相关实现记录。所有条目被标为 `background_only`。

这里同时存在两个机制：`src/retrieval/recall.ts` 第 620–624 行 Focused 的突出首条逻辑可把输出缩为一条（即便第 1 条为 `background_only / weak`）；多标识符引用覆盖又把多个有用候选保留为弱背景。不能简单提高向量阈值，也不能把 `0.2` 与 `0.2.0` 静默视为完全等价事实。应先保证多条互补证据可见，再让版本相近性只影响排序、不提升支持等级。

#### C. `exact_only` 空结果仍做全通道探索

Query `/Users/linnx/.gemini/antigravity-cli/settings.json` 使用 `exact_only=true`，库内正文检查确认没有该路径记录。一次调用仍累计 333 个候选、398 个排序 Chunk 和 288 个向量返回行，核心耗时 113.563 ms，成为整体 P99 长尾来源。

根因是最终只接受标识符命中的请求，在零标识符命中后仍继续 Embedding、KNN、FTS 和候选分析。空结果质量没有因此改善，资源消耗却达到普通 Query 的 3 倍以上。

#### D. 页内重复与隐式覆盖冲突并存，但不是全库普遍冗余

第三学期 HTML 笔记的 broad Query 同时返回同标题打包记录 `372b1412…` 与 `66ccc8c2…`（余弦 `0.9866`、文本相似度 `0.9087`），不仅导致页内重复，还向 Agent 同时暴露相互矛盾的“原文件保留原位”与“已删除原文件”两条记录。写入端因缺少 `subject_id` 与覆盖检测未能提示 `supersede`；读取端可按来源与时间序保留主条并折叠呈现。不能从这一对推导出需要全库自动语义删除或无差别的全局时间衰减。

#### E. Scope 排除不是漏召回

“在哪里开启精简证据包”的 gold `5e366248…` 明确记录 `context_pack_enabled=true`，但它是 global，而历史请求显式 `project_id=0253deea…、include_global=false`。基准将其列入 `scope_excluded_gold_ids`，该请求的正确结论是 in-scope evidence insufficient。**这项行为必须保持不变。**

## 4. 针对性升级设计（按收益与风险排序）

### P0：Compact evidence 响应，先解决可验证的上下文浪费

新增可选 `detail=compact|full`，`full` 保持 beta7 字节级兼容；候选阶段先只对 `view=evidence` 开放 compact。

- 保留 `id/revision/project/scope/title/content/excerpts`、`verification.status/basis`、`support.level`、适用性及核心来源定位。
- compact 保留来源 `source_type/uri/locator/revision_ref`；`source_hash、checked_at`、完整 verification 方法/摘要、诊断性 `answer_relevance` 和 `snippet_selection` 按需展开。
- 合并冗余的 `excerpt` 与 `excerpts` 表达；不在紧凑页重复 `debug` 明细。
- 条目省略字段不能改变排序、片段偏移、substantive claim、冲突或 `requires_check`。需要完整事实核验时，继续使用 full 或按 ID/revision 展开。
- 不采用“来源去重”方案：实测重复来源为 0。不得删除来源来凑条目数，也不得改变现有 32,000-byte 与 Token 硬保护。

**验收门：**同一快照、同一选中 ID/revision/excerpt 下，compact 响应 p50 估算 Token 至少下降 30%，正文/总响应 Token 比至少达到 25%；`RESPONSE_BUDGET` 次数下降。全量字段仍可按需读取，零事实字段被静默改写。

### P1a：页面级联合覆盖，不升级单条弱事实

对明确包含多个事实子句的 Query 增加 `page_support` 计算：

1. 保留现有逐条 `support`；任何 weak/partial 项都不得因联合覆盖变成 direct。
2. 只在至少两条独立记录、来源和 revision 可追溯时，按排序贪心选出最小贡献集合（跳过无新增实体、关系、限定词或主题词的尾部陪跑条目），对所交付片段计算并集。
3. 排除 `background_only`、`codex-memory`/`historical-source`/`raw_memories` 未策展原始会话记录、冲突、requires_check、不同有效时间/环境、不同 decision intent 或相互冲突的 `subject_id`/`context_key` 记录（同时允许同项目下未锚定记录与单主题锚定记录互补），禁止跨上下文拼接假答案。
4. 全部必要条件被互补证据覆盖时，检查页面字节/Token 预算后输出 `evidence_status=related_evidence`、`composition=multi_record` 与最小 `contributors` 列表。
5. 单事实 Query 继续走现有严格 direct 规则。缺目标证据的三条用例不得被联合规则“拼出答案”。

**验收门：**相关命中却 insufficient 的比例从 41.38% 明显下降（≤28% 且贡献集合零原始对话误拼），不改变任何单条的 evidence_strength；三条无目标证据 abstain 保持 100%，已知高分噪音保持 0。

### P1b：限制单结果收缩，保留互补证据可见性

- 只有首条本身为 `direct`，且没有其他实体/版本互补候选时，才允许 Focused 缩为单条。
- 首条为 `background_only`、weak、引用覆盖不足，或 Query 包含多个标识符/版本/子句时，不得收缩。
- 可把 `0.2`/`0.2.0` 解析为“候选排序用版本线相近”信号；文段未声明 patch 版本时仍保持 partial，不能推断同一次发布。
- 不做通用 LLM Query 改写。若后续仍出现真实改写对，先人工确认意图，再评审确定性子句拆分。

**验收门：**chrome-use 用例至少返回 `99e61e75…`，且不再只剩背景项；其他 31 个用例的 Hit、Scope、冲突状态不回退。

### P2：`exact_only` 标识符预检，零命中快速返回

在 Query Embedding 前复用现有 eligibility 和 `chunk_identifiers` 查询做一次有界 `LIMIT 1` 预检：

- 零标识符命中时，直接生成与现有空页相同权限、预算和状态语义的响应；跳过模型编码、KNN、FTS、candidate ranking 和 sidecar 候选展开。
- 有命中时继续运行 beta7 原链路，**保持原候选集合及排序**，避免以性能优化改写相关行为。
- 预检自身使用独立短读快照并检查 generation/authority，不跨模型编码长期持有事务。零命中响应以预检快照为一致性边界；有命中时完全丢弃预检结果，再由 beta7 原链路固定正式读快照，不依赖两次读取之间的数据不变。不得绕过 Scope、任务排除、Revision 或 Profile 约束。

**验收门：**空路径用例不再产生向量查询或排序 Chunk 读取；该用例 warm P95 小于 40 ms。所有非空 `exact_only` 回归的 ID 列表和排序逐项一致，整体核心 P95 不超过基线的 1.10 倍（58.440 ms；同机复跑 paired A/B 对比）。

### P3：写入侧显式覆盖审查提示与读取隔离边界

- **写入期覆盖检测（`admission_preview` / `propose`）**：在既有查重之外，对 `propose` 的 FTS 同 Scope 候选与 `admission_preview` 的 `suggestions` 检查**标题标准化匹配**或**显式覆盖措辞（含 `本条更新此前`、`取代…旧`、`不再保留`、`已废弃…改用`、`supersede`/`replace`）结合词项/标题重叠（`overlap >= 3 && titleOverlap >= 1`）**，命中时附带 `suggested_transition: 'supersede' | 'correct'`，从源头防止产生如 `372b1412…` / `66ccc8c2…` 的双 `active` 冲突。
- **读取端克制原则**：`focused`、`contradicts`、不同 revision 语义或不同有效时间的记录不自动静默折叠；`broad` 模式维持既有排序输出，`full` 与按 ID/revision 展开仍读取同一权威正文，不改动 canonical 文本或自动 retire。

## 5. 明确不做的改动

- 不再次“引入”BM25+Dense、RRF、时间过滤、冲突关系或反馈衰减；它们已存在。
- 不增加 neural rerank、托管 Query 改写或新 Embedding 模型。当前 KNN P95 为 4.512 ms，473 条规模没有证据支持 ANN 或重编码。
- 不启用默认 graph/learned ranking；此前评测未证明质量增益，且部分并发单元有延迟回退。
- 不做全库时间衰减、僵尸自动删除或无监督语义合并。当前过期数为 0，90 天未复核候选为 0；`372b1412…`/`66ccc8c2…` 等隐式覆盖通过受管 `retire`/`supersede` 显式治理，不对 22 条历史导入头记录做破坏性静默删除。
- 不为 268 条旧记录伪造核验结论；缺失字段继续按兼容默认值解释。

## 6. 存量数据兼容与无损迁移

### 6.1 Canonical 数据：Schema 14 保持不变

本方案**不需要 Schema 15，也不需要 SQL 正文或向量迁移脚本**：

- `memories`、`memory_versions`、`memory_chunks`、`memory_vec`、FTS 与 identifier 表结构不变。
- 现有 752 个 512 维向量和 BGE Profile 原样复用，模型下载和重新编码均为 0 次。
- 268 条旧记录缺少 `verification.status/basis` 时，读取端继续解释为 `unverified/source_claim`。此默认不向数据源回写，不制造新 revision，也不改变原 content hash。
- **存量隐式覆盖记录受管治理（非 Schema 变更）**：针对取证发现的 `372b1412…`（已被 `66ccc8c2…` 明确声明“本条更新此前同主题记录：原文件已不再保留”替代）等隐式覆盖对，不直接 `DELETE`/`UPDATE`，而是按现有受管维护协议在 `/tmp/memory_test_snapshot-*` 先行演练 `retire`（`reason='redundant'`，指向 `replacement=66ccc8c2…`），校验逻辑签名与撤销清单无误后，再由管理员配置执行。
- compact 仅改变传输表示；full 与按 ID/revision 展开仍读取同一正文及来源。`page_support` 是派生判断，不写回记忆。

如果后续实现偏离本 RFC、确需调整 canonical Schema，必须另写 migration RFC，并在快照中提供升级/回滚脚本、事务故障注入、逐 ID/revision/body/hash/vector 签名比对；不得直接在本方案下顺手改库。

### 6.2 API、游标与状态兼容

- `detail` 的缺省值为 `full`，旧客户端请求和原默认响应保持兼容。compact 是客户端显式选择，不是静默删字段。
- `detail` 纳入查询和页面 options；同一 cursor 不得中途切换表示，违反时返回既有页面选项不匹配错误。
- 单结果策略、预检和联合支持改变检索/支持语义时，递增 `RANKING_VERSION`（`adaptive-v3-rc1`）与 `SUPPORT_VERSION`（`support-v3-page-joint`），通过 `authority()` 摘要与既有 `am5:` 游标格式协同使旧版 query cache/游标失效并要求从原 Query 重启，禁止跨策略拼接下一页。
- sidecar 只含短期查询状态，不是迁移事实源。不得通过修改游标正文或 authority 来强留旧页。
- `page_support` 等新字段采用增量输出；不确定的旧客户端应继续使用 full，而不是复用含义不同的 `support.level`。

### 6.3 快照演练与切换步骤

1. 固定 beta7 源码、lockfile、配置和模型 manifest。真实切换前暂停写入，使用 SQLite Backup API 生成一致性备份，同时保存最新 revocations 与 maintenance 清单。
2. 在 `/tmp/memory_test_snapshot-*` 创建一次性副本；所有探针、索引检查、基准和故障注入只操作副本。不得直接复制正在写入的主文件而忽略 WAL。
3. 对副本运行 `npm ci`、`npm run build`、`npm test`、`quick_check` 和现有 CLI `check`。`check` 使用仅指向该副本的快照专用 manage 配置，不复用生产写配置。比较升级前后 ID、revision、正文、content hash、Chunk 偏移、profile 和向量 bytes 的逻辑签名。
4. 用同一 32 条 Query 对 beta7 与候选做 paired A/B。full 模式下非目标行为的 ID/revision/excerpt 必须一致；compact 模式另做字段完整性检查。
5. 为候选配置独立 sidecar，先以 recall-only 运行。记录调用前后生产主库/WAL 指纹，确认演练未触碰生产文件。
6. 通过所有门禁并完成 `upgrade-local` 备份后，可将候选运行时原子切换至 `~/.agents/shared-agent-memory` 并同步本地与远端仓库；本文所述评测本身始终只操作只读快照，不写入生产 `memory.db`。

### 6.4 回滚

- 仅程序与表示层回滚时，恢复原 beta7 runtime 和配置，客户端停止发送 `detail=compact`。Canonical 不需降级。
- 停掉全部实例后才可清理新 sidecar；旧游标失效是可接受行为，重新检索即可。不能删除运行中的 sidecar 来“快速回滚”。
- 若候选只做只读演练，无需恢复 canonical 备份。若实际切换后产生新写入，不得用升级前备份直接覆盖；先停止连接、保存新数据库及最新撤销/维护清单，再按现有恢复协议处理新增/遗忘。
- 任何回滚都先保存故障现场和验证签名，禁止只改 `PRAGMA user_version` 或 manifest 假装降级完成。

## 7. 实施切分与验证门禁

### 7.1 实际改动清单（`v1.0-rc1`）

- `package.json`、`package-lock.json`、`src/mcp/server.ts`：版本递增至 `1.0.0-rc.1`，同步更新 MCP `instructions` 与 `memory_recall` / `memory_propose` 参数描述。
- [src/core/contracts.ts](src/core/contracts.ts)：`recallSchema` 新增 `detail: z.enum(['compact', 'full']).optional()`。
- [src/retrieval/state.ts](src/retrieval/state.ts)：`RANKING_VERSION = 'adaptive-v3-rc1'`、`SUPPORT_VERSION = 'support-v3-page-joint'`（保持 `am5:` 游标格式，通过 `authority()` 摘要使旧版 query cache/游标显式失效）。
- [src/retrieval/evidence.ts](src/retrieval/evidence.ts)：`referenceEvidence()` 兼容 `.0` 结尾小版本族候选背景消解（不伪造 `direct`）；新增 `pageSupportAssessment()` 按兼容上下文计算最小有序多记录联合 `page_support`，并排除 `codex-memory`/`historical-source`/`raw_memories` 原始对话流水。
- [src/retrieval/recall.ts](src/retrieval/recall.ts)：实施 `detail=compact` 序列化与 `CURSOR_PAGE_OPTIONS_MISMATCH` 校验、Focused 单结果收缩保护、`exact_only` 零命中 `LIMIT 1` 预检（对齐 `graphFallback`/`GRAPH_DISABLED` 与 `view=chunks` 语义）以及受字节/Token 预算约束的 `page_support` 输出。
- [src/core/service.ts](src/core/service.ts)：为 `propose()` 的 `similar_candidates` 与 `admissionPreview()` 的 `suggestions` 增加同标题或显式覆盖措辞提示（`suggested_transition: 'supersede' | 'correct'`，且要求低重叠噪音不误标）。
- [tests/support-calibration.test.mjs](tests/support-calibration.test.mjs) & [tests/benchmark_evolve.py](tests/benchmark_evolve.py)：补充 5 项 `rc1` 回归测试（含最小贡献者、原始日志排除、游标 `detail` 冲突、预算/图降级、`suggested_transition` 边界）与 `--detail full|compact` 对比评测。
- [README.md](README.md)、[README.en.md](README.en.md)、[docs/adaptive-retrieval.md](docs/adaptive-retrieval.md) 与 `docs/upgrade-v1/*.md`：补充 `1.0.0-rc.1` 新参数与实测记录。

### 7.2 发布前门禁验证情况

| 门禁 | 要求 | `v1.0-rc1` 实测结果 |
|---|---|---|
| 数据安全 | 生产主库/WAL 指纹不变；所有写入仅发生在临时快照；Canonical Schema 与向量签名一致 | **通过**：基准前后生产库 SHA-256 保持一致，Schema 14 与 752 条 512 维向量零修改 |
| 兼容 | `npm run build`、`npm test` 全过；full 的非目标响应与 beta7 一致；权限、Revision、遗忘和恢复测试不回退 | **通过**：`npm test` **170 / 170** 全过 |
| 质量 | Hit@5 ≥ 96.55%，Recall@5 ≥ 70.89%，MRR ≥ 0.908046；已知高分噪音保持 0 | **通过**：Hit@5 **100.00%**、Recall@5 **72.15%**、MRR **0.942529**、高分噪音 **0** |
| 证据状态 | 相关命中却 insufficient 显著下降（≤28% 且零原始对话误拼）；abstain 保持 100%；不提升单条弱记录 | **通过**：`insufficient` 降至 **27.59%**（24/87，5 组全为策展 gold 相关记录）、abstain **100%**、单条 `supported` 不变 |
| Token | compact p50 响应 Token 降低 ≥30%；正文/总响应 Token ≥25%；支出与片段偏移可审计 | **通过**：`compact` P50 降至 **2,210**（**-38.93%**），正文占比 **25.68%**，`RESPONSE_BUDGET` 由 24 降至 15 |
| 性能 | 同机配对核心 P95 ≤ 基线 1.10x；空 exact-only 用例 P95 <40 ms、向量/排序为 0 | **通过**：配对核心 P95 为基线 `0.95x`（full）/ `0.91x`（compact），P99 为 `0.49x` / `0.47x`；空 `exact_only` **0.1–0.3 ms**、向量/排序行 **0 / 0** |
| 稳定性 | 三轮 paired A/B 均保留全部调用结果；记录波动，不挑样本 | **通过**：96 / 96 全部记录在 `.local/evolve-v1/candidate-rc1-{full,compact}.json` |

当前 96 次单进程配对测量与 CI 检查已覆盖上述门禁；后续如进一步提升并发负载，仍可按需复跑多客户端矩阵。

## 8. 复现与产物

```sh
# 只读真实库探针；临时快照默认在结束后回收
python3 tests/probe_evolve.py

# 重新解析日志，生成自动候选集；排除当前任务 session
python3 tests/analyze_recall_logs.py --exclude-session <CURRENT_SESSION_ID>

# 人工复核自动候选后，使用本地 reviewed 集进行基线或候选 A/B
python3 tests/benchmark_evolve.py --cases .local/evolve-v1/replay-cases-reviewed.json --output .local/evolve-v1/candidate-rc1-full.json
python3 tests/benchmark_evolve.py --cases .local/evolve-v1/replay-cases-reviewed.json --detail compact --skip-build --output .local/evolve-v1/candidate-rc1-compact.json

# 现有工程验证
npm run build
npm test
```

| 文件 | 用途 |
|---|---|
| [tests/evolve_common.py](tests/evolve_common.py) | 只读配置、SQLite Backup、指纹、分位数及本地报告 |
| [tests/probe_evolve.py](tests/probe_evolve.py) | 真实库统计、元数据、重复与过时候选 |
| [tests/analyze_recall_logs.py](tests/analyze_recall_logs.py) | 两类日志解析、Bad Case 代理信号及候选抽样 |
| [tests/benchmark_evolve.py](tests/benchmark_evolve.py) | MCP 真模型快照回放、质量/Token/延迟及 Scope 校验 |
| `.local/evolve-v1/data-probe.json` | 原始数据探针报告，Git 忽略 |
| `.local/evolve-v1/log-analysis.json` | 历史日志聚合，Git 忽略 |
| `.local/evolve-v1/replay-cases-reviewed.json` | 32 条人工复核用例，Git 忽略 |
| `.local/evolve-v1/baseline-beta7.json` | beta7 96 次基线全量结果，Git 忽略 |
| `.local/evolve-v1/candidate-rc1-full.json` | v1.0-rc1 (`detail=full`) 96 次验证结果，Git 忽略 |
| `.local/evolve-v1/candidate-rc1-compact.json` | v1.0-rc1 (`detail=compact`) 96 次验证结果，Git 忽略 |

原始 Query、记忆正文和日志报告只保存在 `.local`，不进入公开测试夹具。自动银标与人工 reviewed 指标不得混用。

## 9. 剩余风险与状态说明

- 32 条真实 Query 由单人复核且是非穷尽标注，适合阻止回归，不代表全库真实 Precision。稳定发布前建议补充第二名复核者或独立真实任务验收集。
- 历史日志跨多个 beta 版本，只用于发现候选问题和选 Query；所有 `beta7` 与 `v1.0-rc1` 数值对比均来自隔离快照上的同机实测。
- 当前库只有 473 条活跃记忆（752 个 Chunk），KNN 不是瓶颈；不得把该结论外推为百万条规模证明。
- 本版本已落地 P0、P1a、P1b、P2 及 P3 写入侧 `suggested_transition` 提示，通过 `170 / 170` 单测与同机配对 `beta7` vs `v1.0-rc1` A/B 门禁，并将本地运行库原子升级至 `1.0.0-rc.1`（Schema 14 与生产 `memory.db` 保持零改库）。
