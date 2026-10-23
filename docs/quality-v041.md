# v0.4.1: quality fixes and operational limits

This is an incremental quality release. Canonical Schema 5, existing memory IDs/revisions, four MCP tools, authorization, lifecycle, global/project filtering, explicit ID expansion and unlimited cumulative pagination are unchanged. All evaluation corpora are fictional, with rule-authored multi-answer labels. These are reproducible scenario results, not independently annotated real-world accuracy.

## Retrieval changes

Previously Focused inherited five protected first-window anchors, counted generic question scaffolding as lexical evidence and rewarded an identifier appearing in a title more strongly than the same identifier in an actual procedure. A rejected proposal could outrank an adopted repair. The fix uses informative query terms weighted by FTS vocabulary document frequency, semantic distribution, identifier-linked topics and local answer intent. Identifier presence is still complementary: a missing literal identifier alone does not exclude a strong semantic/subject match. Ordinary semantic questions retain the existing leading relevance order; execution/rejection questions use answer alignment. Broad keeps its discovery, diversity and pagination rules.

The bounded candidate stage reads at most two hit Chunks per newly analyzed Focused candidate, within the configured candidate work budget. It never selects canonical full bodies. Cached analysis stores only scalar state/coverage, IDs and scores, never Chunk text. Repeated candidates reuse analysis unless the selected hit IDs change. Diagnostics distinguish `ranking_chunk_rows_read` from final `chunk_text_rows_read`. This is additional bounded Chunk materialization, not a return to all-memory body loading. SQLite's exact vector scan remains internal and unobservable; Top-K output is not reported as scanned-vector count.

`answer_relevance.state` describes an explicit **local claim**, with `assessment=local_claim_heuristic`. It is separate from `verification` and relevance strength. Affirmative attributed execution statements can be `implemented`; proposals, rejections, disputes and explicit supersession have separate states. Mixed claims, bare status words and model inference stay `unknown`. A verified record alone never proves implementation. These conservative language rules are fallible and do not establish historical truth or automatically connect a superseding record to its predecessor. No new user profile or memory is written.

## Evidence windows

Previously SQL selected `substr(text,1,200)`. Now the selected hit Chunk is read and a contiguous original window is selected around literal identifiers or the highest local query-term coverage. Sentence/line boundaries are preferred; long code lines use a bounded contiguous window. Paths and symbols spanning punctuation receive literal match anchors. Default windows remain at most 200 UTF-16 code units, within page byte/token budgets. Offsets point into original content, with existing Memory ID, revision, chunk IDs and original sources. Separate excerpts retain their separator and separate offsets.

No sentence embeddings or extra BGE calls are made. Purely semantic hits without a local match explicitly use `snippet_selection=chunk_fallback`; this may still omit a later key sentence. `query_window` is a lexical location heuristic, not a generated summary or proof of support. Expand the selected ID if context is insufficient.

## Sidecar governance

New optional configuration (bytes):

```json
{
  "cache_max_bytes": 67108864,
  "cache_query_max_bytes": 8388608,
  "cache_disk_max_bytes": 134217728,
  "cache_cleanup_rows": 256
}
```

Logical usage includes UTF-8 payload length, vectors and a conservative fixed row overhead; it is not an exact physical measurement. Transactional triggers account for queries, candidates, seen IDs and page snapshots. Per-query and aggregate quotas are checked before page commit. A failed page rolls back atomically and increments capacity rejection telemetry separately. Already committed pages remain consistent. A query may continue through arbitrarily many pages subject to available resources: there is no cumulative result-count cutoff. If resident dedup/replay state reaches quota, the service returns `QUERY_CACHE_CAPACITY`, not `exhausted`. An operator can raise the resource budget, wait for expiry cleanup, or restart the query; restarting alone will not solve a single query that exceeds the same quota.

Every retrieval performs a separate small maintenance transaction before its page transaction. At most `cache_cleanup_rows` expired child/header rows are deleted per pass. Expired queries are immediately unresumable even while their child cleanup is incomplete. Active queries and generated pages are never silently evicted. `BEGIN IMMEDIATE`, busy timeout, bounded initialization retries and WAL serialize concurrent maintainers. No background daemon or automatic VACUUM is introduced.

Allocated SQLite pages are bounded with `max_page_count`; WAL uses automatic checkpoints and a reusable journal size target. `QUERY_CACHE_DISK_CAPACITY` also checks DB/WAL/SHM footprint. **This is not an exact hard cap on the sum of live files**: a bounded page transaction can transiently grow WAL; readers can delay checkpointing. Disk usage is observed separately. Shrinking the configured budget does not shrink existing allocated pages. Deleted pages are reused; maintenance runs PASSIVE checkpoint only and never deletes live files.

Admin-only CLI observability (existing `manage` permission):

```sh
node dist/cli/main.js cache-inspect --config /absolute/path/admin.config.json
node dist/cli/main.js cache-maintenance --config /absolute/path/admin.config.json
```

Active means unexpired resident queries, including completed queries retained for page replay. Inspection includes active/expired queries, logical bytes, DB+WAL+SHM bytes, candidate count, limits, last cleanup rows/time and capacity rejection count. Maintenance does one bounded cleanup batch; repeat to drain a backlog. `inspect` and explicit `maintenance` also include cache information. Ordinary MCP results do not include these fields. Telemetry counts surfaced capacity failures and explicit busy retries, not invisible SQLite busy-handler waits.

## Upgrade, backup and rollback

No canonical migration or re-embedding is needed. The disposable sidecar gains `cache_usage`, `cache_meta` and accounting triggers. Initialization/backfill is transactional and rechecks initialization after acquiring the writer lock. The ranking fingerprint changes, so old cursors require restarting their original query (`CURSOR_SCOPE_CHANGED`). Never resume old rankings under a new policy.

Before deployment, stop clients and take a SQLite backup of the canonical database plus its external revocation ledger using the existing documented backup process. Keep the previous executable/configuration. Rollback may simply restore v0.4.0 code: Schema 5 records and indexes remain compatible; restart queries. If a clean auxiliary cache is needed, stop **all** clients, finish/checkpoint sidecar transactions and quarantine the `.retrieval.db` sidecar together with its `-wal`/`-shm` companions. Then restart to rebuild disposable query state. Do not move/delete live files, run online VACUUM, or replace the canonical database to clear cache. A pre-existing oversized sidecar needs this offline rebuild to physically shrink; normal deletion only frees pages for reuse.

## Reproduction

Use Node 24.18.0, the lockfile and the existing local fp32 BGE model. Freeze v0.4.0 compiled code to an ignored directory with access to node_modules. `BENCH_LABEL` labels versions explicitly; kernel path no longer silently decides version.

```sh
npm test
BENCH_LABEL=0.4.0 node scripts/benchmark-adaptive.mjs measure .local/v041/eval .local/v041/baseline/dist
BENCH_LABEL=0.4.1 node scripts/benchmark-adaptive.mjs measure .local/v041/eval dist
BENCH_FIXTURE=bench/quality/fixtures.mjs node scripts/benchmark-adaptive.mjs build .local/v041/specialist dist
BENCH_FIXTURE=bench/quality/fixtures.mjs BENCH_LABEL=0.4.1 node scripts/benchmark-adaptive.mjs measure .local/v041/specialist dist
BENCH_LABEL=0.4.1 node scripts/benchmark-adaptive-scale.mjs dist 10000 focused .local/v041/scale
node scripts/benchmark-real-mcp.mjs dist 0.4.1 1000
```

The frozen 120-query/240-record fixture is unchanged. The specialist fixture has 60 queries and 126 records: execution/proposals/rejection, inference vs claims, superseded/expired accounts, different roots sharing error codes, background, independent sources, late evidence, cross-project preferences/temporary exceptions/conflicts and absent answers. Fingerprints and aggregated measurements are in [results](quality-v041-results.md). Raw disposable DBs/reports and the detailed aggregate JSON remain in ignored `.local/v041/`; only the human-readable results summary is published. Precision@K divides by K even when fewer results exist. Recall is macro-averaged over answerable queries; cumulative irrelevant fraction is micro-averaged over distinct returned records. Snippet inclusion counts the literal target in returned content; it is not general semantic faithfulness.

## Boundaries and next options

- Focused cumulative irrelevant results remain high under strict synthetic labels, even where first ranks improve. Explicit continuation still returns related counterevidence/background. Do not equate label precision with real-user accuracy or claim this problem is solved.
- Bounded local reranking has CPU/Chunk-read overhead; smaller libraries expose this overhead more clearly than vector scanning at 10,000 records. The native vector index remains exact KNN, and FTS vocabulary statistics may scan index terms internally.
- Multiple MCP processes each own a model and allocator. Sampled aggregate RSS can grow during repetition; this run is roughly minute-scale, not a days-long endurance certification. No memory-leak-free claim is made.
- Before changing model infrastructure, options are: reuse prepared statements/buffer allocations (small implementation cost; no representation change, benefit unmeasured); test 1 vs 2 threads (low configuration cost, throughput/latency tradeoff); fp32 vs q8 (requires a new profile and reindex/quality A/B, no assumed accuracy equivalence); optional shared model service (higher lifecycle/IPC/security cost, only if independently authorized). None of the latter architecture/model changes was introduced here.

### Candidate mitigation costs (not implemented)

| Option | Implementation / operational cost | Expected tradeoff to measure |
|---|---|---|
| Reuse prepared statements and temporary buffers | Small local code change; no reindex | Could reduce allocation and RSS pressure; benefit not measured |
| One vs two CPU threads per process | Configuration-only, same embedding profile | Less oversubscription may lower contention; single-query latency may rise |
| q8 model | Download/check existing quantized weights, separate profile, full reindex and quality A/B | Smaller weights; total process RSS and quality gains cannot be assumed proportional |
| Optional shared model service | New lifecycle, transport, isolation and failure-recovery design; explicit future authorization | Could avoid four model copies but adds service management and a shared bottleneck |

The measured additional resident peak is about 476 MiB across four processes in this run. No option has been costed with measured performance benefits; a separate A/B is required before adopting a representation or architecture change.
