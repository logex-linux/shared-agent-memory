# v0.4.1 measured results

Measured locally on macOS, Node 24.18.0, real BGE fp32 CPU / two threads per process. Canonical user data was not used. Original labels were not changed. Precision denominators include unfilled K positions; no-answer cases count as zero precision. These rule-generated corpora are not real-user accuracy.

| Frozen 120-query set: Focused (60 queries) | 0.4.0 | 0.4.1 |
|---|---:|---:|
| Precision@1 | 0.5333 | 0.7167 |
| Precision@3 | 0.2389 | 0.3500 |
| Precision@5 | 0.1500 | 0.2167 |
| Recall@5 | 0.7188 | 0.9271 |
| Cumulative recall | 0.8542 | 0.9479 |
| nDCG@5 | 0.6957 | 0.8920 |
| MRR | 0.7277 | 0.9172 |
| Cumulative irrelevant fraction | 0.9037 | 0.7951 |
| Mean returned records | 10.0333 | 5.4500 |
| Mean cumulative estimated tokens | 3599.9500 | 2230.4000 |
| Page p50 ms | 7.2246 | 11.7817 |
| Page p95 ms | 13.2368 | 17.6178 |

Broad cumulative recall stays **97.78%**, with unchanged leading quality, zero duplicate returns and no false-sufficient claims on the 12 no-answer queries. Focused irrelevant results remain high; this is an improvement, not a complete solution.

| Specialist 60-query / 126-record set: Focused (40 queries) | 0.4.0 | 0.4.1 |
|---|---:|---:|
| Precision@1 | 0.5250 | 0.8000 |
| Precision@3 | 0.2000 | 0.3417 |
| Precision@5 | 0.1500 | 0.2400 |
| Recall@5 | 0.7188 | 1.0000 |
| Cumulative recall | 1.0000 | 1.0000 |
| nDCG@5 | 0.6676 | 0.9622 |
| MRR | 0.7208 | 1.0000 |
| Cumulative irrelevant fraction | 0.9357 | 0.8996 |
| Mean returned records | 18.6750 | 11.9500 |
| Mean cumulative estimated tokens | 6869.4250 | 4869.8000 |

Evidence includes the target original text: **16/32 → 32/32**. Rejected-before-adopted: **8/8 → 0/8**. Specialist Broad cumulative coverage remains 100%; no-answer false-sufficient claims remain 0/8. Explicit assertions, temporary preferences and inference retain their original sources, without profile writes.

| Size | Mode | p95 ms 0.4.0 → 0.4.1 | Full bodies | Chunks 0.4.0 → 0.4.1 |
|---:|---|---:|---:|---:|
| 100 | focused | 12.05 → 15.95 | 0 | 4.95 → 27.75 |
| 100 | broad | 12.57 → 13.67 | 0 | 4.95 → 4.95 |
| 1000 | focused | 15.22 → 19.59 | 0 | 4.95 → 32.35 |
| 1000 | broad | 15.69 → 17.59 | 0 | 4.95 → 4.95 |
| 10000 | focused | 59.17 → 65.02 | 0 | 4.95 → 33.50 |
| 10000 | broad | 59.58 → 61.58 | 0 | 4.95 → 4.95 |

Each scale/mode/version has 60 requests (20 fixed queries × 3 rounds). Recall@5 remains 1.0 and MRR is unchanged at all sizes. Focused reads additional bounded hit Chunks for ranking; it does not read full memory bodies. Final metadata materialization averages 4.95 records. This overhead is measurable, especially on small databases. Internal sqlite-vec scan count remains unknown.

## Independent real-model STDIO MCP processes

These measurements use actual MCP child processes and the real BGE model, separate from deterministic encoder concurrency tests. Cold means a new process/model session; OS file cache is not flushed. Each version executes single cold start, four simultaneous cold starts, four Focused readers, four Broad pagers, three readers plus an authorized synthetic writer, 1,000 repetition rounds with expiry cleanup, and survival of one SIGKILL. The live user database is never opened.

| Scenario | 0.4.0 | 0.4.1 |
|---|---:|---:|
| Single process startup+first query ms | 281.89 | 304.05 |
| Four concurrent startup+first queries ms | 566.02 | 446.92 |
| four_focused page p50 / p95 ms | 31.91 / 82.20 | 35.54 / 72.56 |
| four_broad page p50 / p95 ms | 4.36 / 120.94 | 5.43 / 101.31 |
| read_write page p50 / p95 ms | 14.02 / 58.90 | 15.93 / 130.78 |
| sustained page p50 / p95 ms | 28.26 / 49.53 | 34.09 / 71.79 |
| survive_sigkill page p50 / p95 ms | 25.19 / 44.11 | 25.99 / 44.78 |
| Simultaneous sampled peak MCP RSS MiB | 1676.3 | 2152.5 |
| Successful recall requests | 4096 | 4096 |
| Approximate sample duration seconds | 50.3 | 65.6 |

All four Broad readers cover 72 distinct relevant records in 11 pages each. Every measured page reads zero full canonical bodies. Four thousand sustained queries per version are included; explicit busy retries and unexpected errors are zero. This does not mean SQLite performed no internal busy waits. Per-process RSS peaks, sampled lifetime CPU percentages, tokens and Chunk reads are recorded in the ignored local JSON report (`.local/v041/results-v041.json`), reproducible with the committed benchmark scripts. 100ms sampling may miss short-lived peaks. CPU percentages are lifetime averages, not per-query CPU time.

Final v0.4.1 cache snapshot: 62 active / 0 expired queries; 6438912 disk bytes; 3394748 accounted logical bytes. File size can remain allocated after cleanup. RSS overhead and growth require further investigation; no days-long stability or leak-free claim is made. Candidate mitigations and costs are documented in [implementation boundaries](quality-v041.md#boundaries-and-next-options).

## Validation and changed files

51/51 tests pass: the original 45 plus six quality/cache regressions. Coverage includes four-process writes, revision races, ten SIGKILL points, migration/revocations, scope boundaries, multilingual/late snippets, fact-state ambiguity, explicit capacity rollback, bounded cleanup/replay and concurrent maintainers.

Changed implementation: `src/retrieval/{recall,state,evidence}.ts`, `src/core/{contracts,service}.ts`, CLI and MCP version metadata. Added `tests/quality.test.mjs`; improved failure diagnostics in `tests/adaptive.test.mjs`. Benchmark work: frozen evaluation runner, scale runner, real MCP runner and separate `bench/quality/` fixture/results. Updated package versions, both READMEs and quality audit/operations/results documents. Canonical Schema 5 needs no migration; disposable sidecar additions and cursor restart/rollback are described in [operations](quality-v041.md#upgrade-backup-and-rollback).

No external vector database, model replacement, resident embedding service, live-memory rewrite or client configuration change was introduced.
