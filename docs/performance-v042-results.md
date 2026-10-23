# v0.4.2 性能与资源效率报告

基线 ff210f0（v0.4.1）；macOS、Node24.18.0、同一本地BGE fp32、每进程两线程。全部使用隔离合成库。先完成三轮瓶颈探测，再冻结候选实现，最终分阶段表来自另三轮配对实验，不挑选最快轮次。原始JSON和数据库留在ignored .local/v042/。

**结论：保持质量、减少重复工作；持续负载p95和总体RSS没有稳定改善。** 不将校验缓冲节省等同于整个模型进程内存下降。

## 瓶颈与决策

1. sidecar串行写锁：旧版每请求先做清理写事务，再持锁完成检索。稳定探测轮平均等待约16ms、持锁8–9ms，而KNN约0.8ms。保留主页面原子事务，通过减少事务和重复工作降低成本。
2. 重复本地处理：重开/初始化sidecar、重复编译SQL、精排后再次读取相同Chunk、重复获取已有标量元数据、分词、选窗口和预算序列化。
3. manifest校验整文件缓冲：旧实现将约90MiB fp32和23MiB q8权重读入Buffer后hash。改为流式SHA-256，全部校验和profile ID保持不变。

没有引入lease/CAS、提前解锁或动态候选截断。准入和unknown回退仍可能依赖局部正文，证明安全边界需要过多复杂度。所有原候选继续参与相同分析，仅复用重复工作。Broad无累计数量上限。

## 分阶段耗时

四进程Focused，每轮32次预热请求。每格为三轮各自p50/p95的中位数；占比为每请求阶段/总耗时的均值再取三轮中位数。分位数不能相加。

| 阶段 | 0.4.1 p50 / p95 ms | 0.4.2 p50 / p95 ms | 平均占比 旧→新 |
|---|---:|---:|---:|
| Query embedding / inference | 14.335 / 19.382 | 13.950 / 17.146 | 38.6% → 47.7% |
| sidecar打开/初始化 | 0.428 / 0.803 | 0.006 / 0.011 | 1.4% → 0.0% |
| 清理（含其锁等待） | 11.133 / 41.965 | 0.029 / 0.080 | 33.7% → 0.3% |
| 主页面BEGIN等待 | 0.005 / 0.009 | 4.235 / 38.452 | 0.1% → 27.5% |
| sqlite-vec KNN | 0.751 / 2.342 | 0.734 / 2.373 | 3.0% → 3.8% |
| FTS5 / 标识符 | 0.546 / 1.334 | 0.597 / 1.194 | 1.8% → 2.5% |
| 候选生成、适用检查、去重 | 3.511 / 5.591 | 2.061 / 4.043 | 10.8% → 8.7% |
| Focused读取与精排 | 1.553 / 2.367 | 0.915 / 1.539 | 5.1% → 3.7% |
| Metadata/Evidence与预算物化 | 0.483 / 0.861 | 0.231 / 0.382 | 1.5% → 0.9% |
| 最终序列化 | 0.168 / 0.256 | 0.163 / 0.184 | 0.5% → 0.6% |
| 页面状态提交 | 0.400 / 1.711 | 0.329 / 2.745 | 1.8% → 2.6% |
| 连接释放 | 0.149 / 0.284 | 0.001 / 0.003 | 0.5% → 0.0% |

候选阶段包含provisional candidate/seen写入及状态准备；页面提交行只计最终页面、进度和commit，没有把中间写入算成零。物化含预算探测的序列化，序列化行只计最终响应。完整state_lock held/wait与阶段有重叠，不能重复相加。少量配额检查和剖析记账未单独归类。端到端请求覆盖JSON-RPC与客户端处理，向量内部扫描量不可观测。

| 锁指标（逐请求三轮中位数） | 旧 | 新 |
|---|---:|---:|
| BEGIN等待均值ms | 17.676 | 11.602 |
| 持锁均值ms | 9.023 | 6.385 |
| 预热样本平均事务数（含TTL清理） | 2.000 | 1.031 |

同cursor三进程并发续取返回相同页面；不同cursor四进程各覆盖72条记录/11页且无重复。主页面事务没有提前解锁，权限/generation、seen、候选及页面仍原子提交。清理probe在写锁外，真正删除在取得锁后重新检查TTL，避免删除被刷新过的活跃查询。

## 三轮真实MCP并发

每格依次为三轮p95。每轮单进程预热8次、四进程Focused32次、Broad44页、同cursor3次、读写并发12次读取、持续240次。读写样本少且波动显著，不当作稳定SLA。

| 场景 | 0.4.1 三轮p95 ms | 0.4.2 三轮p95 ms |
|---|---|---|
| single_warm | 16.81 / 15.16 / 17.26 | 18.04 / 13.56 / 14.31 |
| four_focused | 67.64 / 67.13 / 95.20 | 62.30 / 61.64 / 67.04 |
| four_broad | 179.32 / 120.67 / 115.84 | 107.78 / 101.38 / 137.75 |
| same_cursor | 44.17 / 42.85 / 41.67 | 43.53 / 43.42 / 68.54 |
| read_write | 114.86 / 55.44 / 89.85 | 83.89 / 83.83 / 99.50 |
| sustained | 96.82 / 65.74 / 79.76 | 63.43 / 65.11 / 80.41 |

| 冷启动（协议/首次检索） | 旧三轮ms | 新三轮ms |
|---|---|---|
| 单进程 | 427.12 / 282.70 / 293.58 | 308.53 / 301.06 / 291.38 |
| 四进程同时启动 | 661.94 / 428.63 / 776.88 | 441.90 / 504.19 / 522.10 |

冷启动为新进程/新模型会话，未清空OS文件缓存。没有意外降级或显式busy重试，不等于SQLite内部无等待。

## 内存与模型生命周期

RSS每100ms采样，Node内存约每200ms采样并随debug响应采集，可能漏掉瞬时峰值。RSS相加可能重复计算共享页。macOS Physical footprint是OS记账指标，不是PSS，不能简单求和当作独占物理RAM。

| 轮次 | 旧四进程各自峰值MiB | 新四进程各自峰值MiB | 旧同时RSS峰值和MiB | 新同时RSS峰值和MiB |
|---|---|---|---:|---:|
| 1 | 407.7 / 426.3 / 418.8 / 422.0 | 429.7 / 437.6 / 442.0 / 456.5 | 1674.9 | 1765.7 |
| 2 | 464.0 / 475.8 / 457.7 / 477.5 | 382.0 / 399.6 / 364.9 / 395.7 | 1875.1 | 1521.3 |
| 3 | 397.1 / 388.4 / 390.5 / 384.2 | 416.0 / 414.4 / 376.5 / 389.4 | 1545.0 | 1568.3 |

长测检查点：Node列为四进程平均MiB，arrayBuffers是external的子集；RSS列为同一检查点四进程总和。latest probe可能滞后约200ms。

| 版本/检查点 | heapUsed | external | arrayBuffers | RSS总和MiB |
|---|---:|---:|---:|---:|
| 0.4.1 models_loaded | 35.5 | 121.4 | 114.4 | 1117.3 |
| 0.4.1 warmed | 33.8 | 52.8 | 45.8 | 1646.5 |
| 0.4.1 queries_1000 | 36.6 | 7.7 | 0.7 | 919.8 |
| 0.4.1 queries_5000 | 43.7 | 8.1 | 1.1 | 1034.4 |
| 0.4.1 queries_10000 | 43.1 | 7.9 | 0.9 | 1005.7 |
| 0.4.1 after_ttl_cleanup | 37.7 | 8.0 | 0.6 | 724.4 |
| 0.4.2 models_loaded | 27.9 | 24.6 | 18.0 | 1339.9 |
| 0.4.2 warmed | 31.9 | 98.1 | 90.9 | 1260.8 |
| 0.4.2 queries_1000 | 40.4 | 7.8 | 0.8 | 873.8 |
| 0.4.2 queries_5000 | 44.8 | 8.2 | 1.2 | 933.5 |
| 0.4.2 queries_10000 | 44.0 | 8.1 | 1.1 | 1098.2 |
| 0.4.2 after_ttl_cleanup | 46.5 | 8.2 | 1.2 | 756.5 |

| Physical footprint（四进程原始单位） | 旧 | 新 |
|---|---|---|
| warmed | 310.5M / 251.7M / 329.6M / 263.9M | 337.8M / 326.6M / 336.8M / 332.5M |
| after_ttl_cleanup | 313.5M / 315.5M / 323.8M / 324.3M | 368.8M / 379.1M / 377.0M / 377.5M |

预热后的四个进程均观察到一次pipeline初始化，后续推理计数增加但模型未按请求重复加载。原生分配器保留页不能直接判成泄漏。优化版10,000次检查点RSS高于旧版，不能宣称长期内存下降或已达到稳定平台。

### 独立manifest微基准，不加载pipeline

| 指标，三轮中位数 | 整文件 | 流式 |
|---|---:|---:|
| 校验耗时ms | 63.49 | 61.97 |
| 完成后external MiB | 119.09 | 28.79 |
| 完成后arrayBuffers MiB | 113.54 | 23.24 |
| 完成后RSS MiB | 202.22 | 155.77 |

两个方案profile ID完全相同；只证明校验缓冲减少，不证明整个ONNX驻留同比例降低。

## 线程与10,000次持续检索

线程实验使用同一优化算法、相同请求、teardown计时扩展前的同一剖析版本（release系列）；1/2线程各三轮。因单查询和总体收益不稳定，保留2线程默认。

| 场景 | 1线程三轮p95 ms | 2线程三轮p95 ms |
|---|---|---|
| single_warm | 18.27 / 17.44 / 18.40 | 15.77 / 20.25 / 12.85 |
| four_focused | 62.27 / 74.72 / 85.20 | 60.19 / 61.69 / 62.13 |
| sustained | 61.97 / 62.06 / 62.49 | 60.51 / 61.00 / 72.67 |
| 混合预热负载Recall/s | 75.5 / 69.6 / 70.5 | 85.8 / 85.9 / 75.8 |

吞吐覆盖Broad、共享cursor、读写和持续读取以及驱动开销，不当作纯模型吞吐。CPU lifetime百分比和各进程峰值见本地summary.json。

| 长测指标 | 0.4.1 | 0.4.2 |
|---|---:|---:|
| 成功召回（含前置场景） | 10108.000 | 10108.000 |
| 持续阶段p50 ms | 38.109 | 36.582 |
| 持续阶段p95 ms | 67.405 | 68.078 |
| 平均完整正文读取 | 0.000 | 0.000 |
| 平均精排Chunk读取 | 38.000 | 38.000 |
| 最终物化额外Chunk读取 | 8.000 | 0.000 |
| 排空后逻辑bytes | 0.000 | 0.000 |
| 排空后磁盘bytes | 6283264.000 | 6811648.000 |

长测每版本一次、持续阶段10,000请求，记录1,000/5,000/10,000检查点；不是三次10,000耐久认证。三轮重复来自短并发及线程实验。维护与前台并发，TTL到期后分批排空至零，磁盘保留可复用空闲页，无在线VACUUM/删除。长测端到端延迟包含连接关闭；阶段细分的最终teardown计时来自上述三轮短测。

## 质量及规模门槛

原120-query和60-query专项集的180个查询，累计去重ID及顺序全部一致，数据/标签/定义未改。普通质量测量不带debug，Token不含剖析开销。

| 指标 | 旧 | 新 |
|---|---:|---:|
| Focused Precision@1 | 0.7167 | 0.7167 |
| Focused Precision@3 | 0.3500 | 0.3500 |
| Focused Precision@5 | 0.2167 | 0.2167 |
| Focused Recall@5 | 0.9271 | 0.9271 |
| Focused MRR | 0.9172 | 0.9172 |
| Focused nDCG@5 | 0.8920 | 0.8920 |
| Broad累计Recall | 0.9778 | 0.9778 |
| Focused累计估算Token均值 | 2230.4000 | 2230.4000 |
| Evidence目标包含数/32 | 32.0000 | 32.0000 |
| 否决先于采用数/8 | 0.0000 | 0.0000 |
| 无答案误报数/12 | 0.0000 | 0.0000 |

| 规模/模式 | p95旧→新ms | Chunk旧→新 | Recall@5 / MRR 旧新 |
|---|---:|---:|---|
| 100/focused | 14.81 → 14.65 | 27.75 → 22.80 | 1.00/0.8792 = 1.00/0.8792 |
| 100/broad | 13.20 → 16.43 | 4.95 → 4.95 | 1.00/0.8792 = 1.00/0.8792 |
| 1000/focused | 19.21 → 14.78 | 32.35 → 27.40 | 1.00/0.8792 = 1.00/0.8792 |
| 1000/broad | 16.76 → 14.92 | 4.95 → 4.95 | 1.00/0.8792 = 1.00/0.8792 |
| 10000/focused | 69.76 → 63.47 | 33.50 → 28.55 | 1.00/0.8767 = 1.00/0.8767 |
| 10000/broad | 61.86 → 57.61 | 4.95 → 4.95 | 1.00/0.8767 = 1.00/0.8767 |

每版本/规模/模式60请求（20个冻结问题×3轮）。全文读取全部为0。Focused减少来自最终物化复用，不是少精排候选。Broad100条p95回退，不能声称所有规模更快。

## 工程验证、维护成本与回滚

56/56测试通过：原51项加5项语句/连接缓存、Chunk复用、错误恢复、资源释放、磁盘配额测试。保留四进程400次提交、Revision竞争、10个SIGKILL点、schema迁移、撤销恢复、模型损坏降级、权限与分页。真实MCP另验证同cursor一致、不同cursor覆盖、读写、清理争用及SIGKILL后存活。

维护成本：每连接有界96条语句、每MemoryService一个sidecar连接，服务关闭时显式dispose；请求内有限Chunk/元数据Map不跨查询保存正文。没有新表、lease、后台服务或模型更换。剩余写锁串行化、native内存波动、大库精确KNN和持续尾延迟是边界。未为微小收益增加临时FTS词表跨查询失效缓存。

改动：src/storage/statements.ts、src/retrieval/{recall,state,profile}.ts、src/embedding/bge.ts、src/core/service.ts与版本元数据；tests/performance.test.mjs；真实MCP基准、聚合/观测脚本、bench/performance复现支持以及READMEs。

canonical仍为Schema5，sidecar结构和ranking fingerprint兼容。升级前一致备份数据库、撤销和配置，保存旧dist。仅换程序，不改记忆正文/Revision/向量及写权限。回滚可停止共享服务后恢复0.4.1程序，保留当前canonical，无需回滚用户数据。不删除在线sidecar、不改user_version。

## 复现

先从ff210f0编译单独冻结基线，链接同一node_modules，然后运行scripts/instrument-v041.mjs仅添加观测。原始和专项fixture构建方式沿用v0.4.1；详细脚本说明见下一节。

### 可复现命令

先安装 README 指定依赖和本地模型。基线必须来自 ff210f0，不能把优化代码当作基线：

~~~sh
mkdir -p .local/v042/baseline-source
git archive ff210f0 | tar -x -C .local/v042/baseline-source
ln -s "$PWD/node_modules" .local/v042/baseline-source/node_modules
node node_modules/typescript/bin/tsc -p .local/v042/baseline-source/tsconfig.json
npm run build
node scripts/instrument-v041.mjs .local/v042/baseline-source/dist

# 新环境先构建冻结语料；已有 corpus.db 时不要覆盖
node scripts/benchmark-adaptive.mjs build .local/v041/eval dist
BENCH_FIXTURE=bench/quality/fixtures.mjs node scripts/benchmark-adaptive.mjs build .local/v041/specialist dist
BENCH_LABEL=0.4.1 node scripts/benchmark-adaptive.mjs measure .local/v041/eval .local/v042/baseline-source/dist
BENCH_LABEL=0.4.2 node scripts/benchmark-adaptive.mjs measure .local/v041/eval dist

BENCH_FOOTPRINT=1 BENCH_OUTPUT=.local/v042/trial node scripts/benchmark-real-mcp.mjs dist 0.4.2 60
BENCH_THREADS=1 BENCH_OUTPUT=.local/v042/thread-trial node scripts/benchmark-real-mcp.mjs dist 0.4.2 60
BENCH_FOOTPRINT=1 BENCH_DRAIN=1 BENCH_OUTPUT=.local/v042/long-trial node scripts/benchmark-real-mcp.mjs dist 0.4.2 2500
node scripts/summarize-performance.mjs .local/v042
node bench/performance/profile-memory.mjs dist
npm test
~~~

短测需按两个版本交错各跑三轮，输出目录使用 phase-0.4.1-r1 等命名；线程实验与长测命名见聚合脚本。sampler只观测测试子进程，不操作客户端UI。macOS 的 vmmap 和 ps 可需正常本地权限。普通 MCP 不启用 benchmark hook；阶段字段仅 debug 返回，单页预算不足时省略可选剖析字段。完整脚本与原始JSON留作复核，未将真实数据或生成配置提交到Git。

### 下一步没有实施的优化

- SQLite的主页面写锁仍是串行边界。lease/CAS可能降低等待，但增加崩溃恢复、重复提交和维护成本，本次未采用。
- 没有证明可安全提前排除精排候选，继续保留同等精排，未牺牲中文改写、符号或证据定位。
- 模型各进程独立加载。未切换q8、引入常驻共享模型服务、云端模型或新向量库。
- 当前有限长测没有证明内存平台期或不存在泄漏；需要更长、低观测干扰的负载与native分配器剖析。
