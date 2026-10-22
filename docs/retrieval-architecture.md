# Vector-first 与延迟物化 · 0.3.0

0.3.0 的实现与验证使用隔离合成库。公开代码不包含真实记忆、数据库、模型权重或客户端配置；升级已有运行实例需按下方步骤单独备份和迁移。实施前的审计及 SQL 探针见 [方案](retrieval-plan.md)。

## 旧流程的问题

旧 recall 先 SELECT 全部可见 memories 行到 Node，逐条 JSON.parse 检查 valid_for，再逐条解析执行 exactScore；关键词覆盖与响应生成又会解析少量正文。向量通道通过 scalar vec_distance_cosine 排序，将全部距离行送入 Node 后才按 Memory 去重、保留20个候选。输出本来有少量条目与字节预算，但服务端正文物化量随库大小增长。

实测基线使用冻结的051be15编译代码，仅添加候选计数；观测数据库返回行和JSON.parse调用，未用代码结构推算正文读取量。10,000条时每次实际传入Node的正文为10,000条、约20,014次JSON解析，向量距离结果10,000行，最终仅约5.8KB。数据库内部向量扫描量和距离函数底层计算数无法精确观测，返回行数不作为内部扫描计数。

## 新旧流程

| 阶段 | 旧流程 | 新流程 |
|---|---|---|
| 编码 | 查询编码一次 | 保持一次；模型校验失败明确降级 |
| 范围和有效性 | 全正文传入Node后解析过滤 | memory_search结构化SQL约束，前置到每个候选通道 |
| 向量 | scalar cosine全部距离行返回Node | sqlite-vec cosine MATCH/KNN，仅候选ID与距离返回Node |
| 标识符 | 遍历全部正文执行exactScore | chunk_identifiers等值索引查错误码、路径、函数名 |
| 关键词 | 整条记忆FTS | Chunk FTS，命中片段可以在记忆后部 |
| 排序 | Memory正文对象参与 | ID、分数及轻量适用标记参与，不解析完整Record |
| 物化 | 排序前已经读了全库正文 | 最终最多limit条metadata，普通查询0条完整body，按ID显式展开 |
| Agent上下文 | 少量返回值 | 保持少量片段，增加可配置预算和明确诊断 |

向量、FTS、标识符是独立候选通道，在同一SQLite读快照内依次执行SQL，以保持generation和版本一致；没有将同步SQL伪称为多核并发。编码在打开读快照之前完成。普通查询默认Top5，limit最多10；每条最多物化两个命中Chunk，按相邻/重叠偏移合并，非相邻片段分别定位。

每通道保留20个Memory候选。KNN每次取32–40个Chunk，如果被同一Memory占据，则在下一次KNN中排除已见Memory，继续取剩余Memory，直到足额或耗尽。FTS采用相同的按Memory续取规则。授权项目、global开关、status、profile、revision、有效期、branch/commit/environment在候选SQL中检查，且all_projects仅搜索已注册项目；不会先全局截断再剔除非法项目。缺失上下文保持requires_check，明确不匹配和过期不参与排名；适用记录优先于requires_check。

标识符仅有限加权；默认不会排除没有字面标识符的语义候选。exact_only才要求索引中存在标识符。保留原语义阈值、RRF权重、来源、核验状态、五种类型和写入授权模式。

## sqlite-vec 0.1.9 验证

使用已有扩展，未引入外部数据库。官方版本固定为[sqlite-vec v0.1.9源码](https://github.com/asg017/sqlite-vec/blob/e9f598abfa0c06b328d8fe5da9c3760cce74be10/sqlite-vec.c)。本机实际执行KNN、metadata等值/IN、rowid IN子查询和partition约束探针，并保存EXPLAIN QUERY PLAN。

生产检索SQL形式：

```sql
SELECT chunk_id, distance
FROM memory_vec
WHERE embedding MATCH ? AND k = ?
  AND chunk_id IN (
    SELECT c.id FROM memory_chunks c
    JOIN memory_search s ON s.memory_id = c.memory_id
    WHERE /* 授权、适用条件、版本、profile，以及排除已选Memory */
  )
ORDER BY distance;
```

实际计划包含 `SCAN memory_vec VIRTUAL TABLE INDEX 0:3{___}___[___`、search_scope/chunks_memory索引及IN子查询；这是带候选约束的精确KNN，不是ANN。扩展k上限4096，本实现每次远低于此值。分区IN探针显示可分次执行、返回超过全局k的行，本次没有采用分区。

旧vec0表默认L2，旧代码实际使用scalar cosine。本次直接重建cosine vec0表，保留原cosine排序语义，不依赖浮点向量的L2近似等价。迁移前10,000向量SQL探针：scalar cosine p95约284.6ms，cosine KNN约12.3ms；单个固定查询候选次序一致。最终全流程A/B另见下方，不把SQL探针当作完整系统性能。

## Schema 5、事务与回滚

- memories保持Schema4的原正文、ID、Revision及审计列；memory_chunks的关联ID和偏移保留。
- memory_search保存memory_id/project_id/scope/revision/status/profile_id/branch/commit_ref/environment/expires_at，以及不含content的metadata JSON。INSERT/UPDATE/DELETE触发器与主记录在同一事务中同步。
- chunk_fts索引分词后的标题、片段、标签；chunk_identifiers保存精确标识符、权重及Chunk/Memory关联。提交、reindex生成，Chunk删除触发器清理。
- memory_vec在迁移事务内暂存既有向量、重建cosine表、原样复制向量和Chunk ID、删除暂存表。无需下载模型或重编码。迁移用一次性SQL与流式Chunk回填，不是每次recall重复回填。
- 每次向量检索仍通过SQL集合检查缺失向量、陈旧revision/profile，损坏时明确lexical_degraded；check增加检索索引一致性检查。

迁移自动发生在新版首次打开库时，包含事务内版本复查以处理并发客户端。迁移暂存需要额外磁盘空间。对隔离Schema4合成库的测试证明正文、内容hash、ID、Revision、向量bytes完全不变；迁移DDL完成但COMMIT前SIGKILL后，重开仍为完整Schema4，原数据和向量一致。

真实库升级步骤（本任务没有执行）：

1. 停止所有使用该库的MCP/CLI写入，保存旧程序/lockfile、配置和最新revocations.jsonl。用SQLite backup API取得一致备份，不仅复制可能有WAL的主文件。
2. 在仓库目录使用相同Node版本备份，以下路径全替换为实际位置：

```sh
node --input-type=module -e '
import {DatabaseSync,backup} from "node:sqlite";
const db=new DatabaseSync(process.argv[1],{readOnly:true});
await backup(db,process.argv[2]);db.close();
' /absolute/data/memory.db /absolute/backup/memory-schema4.db
```

3. 先复制备份到隔离目录，用该副本配置运行新版`check`触发迁移。核对ID/Revision数量、check所有异常计数为0，再决定升级真实库。
4. 切换程序后运行管理员`check`，成功后再重新连接客户端。不得通过改manifest跳过模型校验。

回滚：停止全部连接，将升级后的DB及其WAL/SHM保存为另一套文件，恢复Schema4备份，并切回0.2.0程序和对应配置。不要只改PRAGMA user_version。若备份后发生过遗忘，必须保留真正最新撤销清单，在重新开放读取前用旧版管理员import空数组、`--mode restore --revocations 最新清单 --commit`应用撤销。备份后新增/更新不会自动存在于旧备份；应先单独导出并审查后恢复，不能把文件回滚当作无损时间旅行。隔离回滚测试已核对恢复备份的Schema4、正文和向量签名。

## 预算与诊断

`response_token_budget`配置默认6000，`memory_recall.token_budget`可下调。估算为紧凑JSON UTF-8 bytes/3向上取整，包含headers、来源和diagnostics；不是任一LLM的真实tokenizer。仍有32,000 payload bytes和5,000 content JS字符硬限，JSON-RPC外层包裹不计入payload。

预算不足先缩短片段，更新excerpts偏移并标记truncated；完整来源与身份字段一起保留。连headers都装不下时减少条目并返回RESPONSE_BUDGET；候选存在但无法输出时明确insufficient。evidence_strength只表示相关性，verified等事实核验状态没有由相似度升级。

| 指标 | 含义 |
|---|---|
| elapsed_ms | 一次核心检索耗时；分位数由基准汇总 |
| candidate_ids / candidates_ranked | 各通道合并去重后的候选ID数 / 资格及exact_only处理后参与排序数 |
| full_body_records_read / full_body_bytes_read | 实际从SQLite送入Node的完整body；普通查询为0，ids仅计所选记录 |
| json_parses / metadata_json_parses | 检索物化层显式JSON解析；不含模型库初始化内部解析 |
| chunk_text_rows_read | 最终物化的Chunk文本行数 |
| query_embeddings / vector_queries / vector_rows_returned | 查询编码调用次数、KNN调用数、送入Node的距离行数 |
| vector_internal_scanned / vector_distance_computations | null：扩展没有可用的精确计数接口，不能用返回Top-K冒充 |
| response_bytes / estimated_tokens | 最终紧凑工具JSON payload的实际字节和预算估算 |

## 写入内容规范

一条记忆保留一个主要事实、决策、偏好或经验，标题说明主题，正文提供必要上下文。保留来源、项目、版本和适用条件。propose仍给出重复线索，提示只用于人工/Agent审阅，不自动合并；关键词重复提示并不是穷尽的语义去重证明。矛盾记录保留各自来源与差异，需核验时用disputed。没有自动改写已有内容，也没有增加知识图谱或自主写入流程。

## 验证与A/B

最终复测：macOS arm64、Node24.18.0、同一固定BGE模型与100/1,000/10,000实际编码快照。基线051be15与0.3.0在独立进程依次测量；20个查询各3轮、每规模60次。时延含观测计数，不含冷模型加载、首次迁移和MCP传输。

| 记忆数 | p50 ms 旧→新 | p95 ms 旧→新 | 正文读取/次 旧→新 | JSON解析/次 旧→新 | Recall@5 旧/新 | MRR 旧/新 |
|---:|---:|---:|---:|---:|---:|---:|
|100|8.21 → 8.53|13.94 → 9.99|100 → 0|214.25 → 4.95|100% / 100%|0.8792 / 0.8792|
|1,000|33.85 → 10.49|37.41 → 12.11|1,000 → 0|2,014.25 → 4.95|100% / 100%|0.8792 / 0.8792|
|10,000|339.12 → 46.33|385.47 → 60.58|10,000 → 0|20,014.25 → 4.95|100% / 100%|0.8767 / 0.8767|

| 记忆数 | 查询后RSS MiB 旧→新 | 进程峰值MiB 旧→新 | 候选ID / 排名候选 旧/新 | 距离结果行进入Node 旧→新 |
|---:|---:|---:|---:|---:|
|100|407.9 → 454.0|472.6 → 454.0|23.30 / 18.75（一致）|100 → 40|
|1,000|524.3 → 473.0|524.3 → 473.0|24.15 / 19.95（一致）|1,000 → 40|
|10,000|443.4 → 297.5|747.8 → 437.2|24.55 / 20.65（一致）|10,000 → 40|

180/180 次返回的Memory ID列表及排序完全相同；不是只比较平均命中率。严格单gold标注的误召回率代理（非gold返回比例）旧新均为79.80%，没有提高或隐瞒这一限制。数据集不足以证明真实任务的事实准确率。

10,000条时平均返回字节5,762→6,421，估算token1,921→2,140；增加来自诊断和精确片段定位，仍受同一预算限制。输出不随全库正文数量膨胀。普通查询完整body读取为0，最终平均4.95条metadata解析；每个入选Memory的命中Chunk最多两条。内部向量扫描/计算量依旧null；40是送入Node的候选行数。

JSON解析观测与内置诊断交叉核对；完整性检查从逐向量点查改为数据库内集合检查，避免由10,000次虚表点查拖慢KNN。峰值RSS受模型初始化、GC和迁移阶段影响，不能用单次差异承诺普遍内存下降。

完整逐查询结果、SQL计划、source/corpus/script hashes保存在`.local/late-materialization/report.json`；测试原始输出在`.local/late-materialization/tests-full.log`。这些均未加入Git。


原25项加8项专项回归，共33项。包括四进程400次发布、同Revision竞争、十个提交SIGKILL点、Schema3/4迁移、迁移DDL中途SIGKILL、删除撤销恢复、只读MCP拒绝写工具、10,000可见记忆零正文传输、9,999更近但越权候选不挤出合法结果、过期（包括查询编码期间到期）/环境/跨项目/global过滤、真实BGE后部Chunk与路径/函数/错误码、片段合并、预算来源保全、更新/遗忘不返回旧片段、hash损坏降级。

复现（先按README安装依赖和固定模型；所有目录用全新隔离位置）：

```sh
# 沿用原有真实BGE的100/1,000/10,000合成库
node scripts/benchmark-scale.mjs build .local/scale-benchmark
# 从本地旧提交构建，不访问或修改远程
mkdir -p .local/retrieval-baseline-source
git archive 051be15 | tar -x -C .local/retrieval-baseline-source
ln -s "$PWD/node_modules" .local/retrieval-baseline-source/node_modules
node node_modules/typescript/bin/tsc -p .local/retrieval-baseline-source/tsconfig.json
node scripts/benchmark-retrieval.mjs freeze .local/retrieval-baseline-source/dist 100 .local/retrieval-ab-repro
# 对每个规模各运行一次下面两条命令；脚本内部20查询×3轮
node scripts/benchmark-retrieval.mjs measure .local/retrieval-ab-repro/baseline/dist 10000 .local/retrieval-ab-repro
node scripts/benchmark-retrieval.mjs measure dist 10000 .local/retrieval-ab-repro
npm test
```

生成的数据库、逐查询结果与报告保存在`.local`，不进入Git。核对报告的source/corpus/script hashes及实际SQL计划后再比较不同机器结果。

## 仍有的边界

KNN及完整性检查仍会在数据库内部处理可见Chunk/向量ID集合，不承诺次线性。多个Chunk挤占候选时可能重复执行KNN；内部扫描量不可观测。FTS常用词的数据库候选排序也可能增长。这些成本留在SQLite/扩展中，没有转化为Node全库正文物化。

原20个单gold查询和编号干扰项并非盲测或真实用户质量评估。严苛单gold标注下非gold返回比例仍高，不能将Recall@5=100%宣传为生产准确率；没有为本次架构改动调整阈值来隐蔽接受召回取舍。未来应使用人工标注的相似难例、更多多Chunk记录和并发查询作评估。

首次模型加载/文件校验、Schema迁移不计入warm查询延迟，但进程峰值RSS包含这些阶段；本次没有测多任务持续并发延迟或超过10,000条的性能。全文仍按既有单条4,000 JS字符上限写入，真正更长的原文应拆为多条带来源记录。metadata与检索索引增加磁盘占用，模型编码成本不变。

## 实际修改文件

- `README.en.md`
- `README.md`
- `docs/operations.md`
- `docs/protocol.md`
- `docs/retrieval-architecture.md`
- `docs/retrieval-plan.md`
- `package-lock.json`
- `package.json`
- `scripts/benchmark-retrieval.mjs`
- `src/core/contracts.ts`
- `src/core/service.ts`
- `src/mcp/server.ts`
- `src/retrieval/indexes.ts`
- `src/retrieval/lexical.ts`
- `src/retrieval/recall.ts`
- `src/storage/database.ts`
- `tests/processes.test.mjs`
- `tests/repairs.test.mjs`
- `tests/retrieval.test.mjs`

`src/embedding/bge.ts`经过审查，编码与分块协议保持不变；没有改模型权重、真实库或客户端配置。
