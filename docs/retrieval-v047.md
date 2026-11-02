# v0.4.7: bounded state writes and shorter sidecar lock occupancy

This is a performance and reliability patch over v0.4.6 (`5e401b8`). Retrieval,
ranking, evidence selection, cumulative Broad pagination, sources and permissions
remain compatible. Canonical Schema 5 and vector contents do not change. All write
and crash experiments use disposable synthetic databases.

## Diagnosis and changes

The v0.4.6 path acquires `QueryState.begin()` (`BEGIN IMMEDIATE`) before canonical
index validation. It then retains the sidecar writer during KNN, FTS/identifiers,
ranking, evidence materialization, quota enforcement and page persistence. A never-recalled
canonical writer can commit independently. A warmed writer, however, still has the
sidecar attached: its canonical `BEGIN IMMEDIATE` reserves that file too. A targeted
cross-database boundary test reproduced `BUSY_RETRYABLE` despite release of the
reader's canonical snapshot. WAL alone did not remove this attachment coupling. Independent query
state writers, however, wait behind that sidecar transaction.

A preliminary four-process run with 120 waves per scenario gives 480 measured
requests per scenario. Different-query mean lock occupancy is 6.64 ms and wait p95
is 40.18 ms. This confirms coordination overhead; it does not attribute all response
tails to the lock. Index validation averages 0.398 ms on the small frozen corpus;
state candidate UPSERT and Seen INSERT SQL average 0.217 and 0.168 ms. State writes
alone are only part of the serialized work.

The release makes five local changes:

1. Before a canonical write transaction, detach the idle `retrieval_state`
   attachment so `BEGIN IMMEDIATE` reserves only canonical memory. Keep the pooled
   sidecar connection; the next recall reattaches it. Revision checks retain the
   original immediate writer transaction. This fixes the reproduced warmed-writer
   coupling without weakening canonical transaction isolation.
2. A new query establishes its canonical read snapshot and validates index/profile
   consistency before acquiring the sidecar writer. It keeps the same canonical
   snapshot through subsequent computation. Cursor state still uses the existing
   serialized path. No validation result is cached across requests.
3. Per-channel local Seen sets already exclude records discovered in the current
   request. Persist each set with one `INSERT ... SELECT json_each(...)` instead of
   one native call per ID. The same rows and quota triggers are retained.
4. A request-local map skips candidate UPSERTs whose complete serialized state is
   unchanged since the request's last persistence pass. Changed scores, admission,
   answer state and offsets are still written. This map is bounded by the existing
   candidate budget and is released after the request; it is not a shared cache.
5. Merge progress and expiry into one query UPDATE, and update emitted IDs with one
   scoped batch UPDATE. Replay only refreshes expiry. Pages and progress remain in
   the same transaction, including capacity enforcement.

There is no speculative query revision, lease, retry coordinator or new backend.
The mutable Seen/Candidates/Pages computation remains under the sidecar writer. The
partial preflight move is deliberately smaller than a full optimistic transaction
split. It avoids introducing another working-state representation and conflict/
retry path for ranking, mutable channel progress, quota triggers and page budgets.
An initial state-batching/preflight prototype completed 110,370 real recalls but
showed mixed tails, including four-process Broad p95 60.90 / 76.09 ms. Its raw
samples are retained. The final boundary test then exposed the warmed-writer
attachment bug. The release matrix is rerun after that fix; prototype numbers are
not substituted for final results. The measurements below assess the retained changes;
no full parallel KNN claim is made.

## Transaction lifecycles

v0.4.6:

```mermaid
sequenceDiagram
  participant R as Recall
  participant M as Canonical WAL
  participant Q as Sidecar WAL
  R->>R: Embed query
  R->>Q: BEGIN IMMEDIATE; wait for writer
  R->>M: BEGIN; read Generation at S
  R->>M: Index validation; KNN; FTS; hit Chunks
  R->>Q: Seen; candidates; ranking state; page; quota
  R->>M: COMMIT read snapshot
  R->>Q: COMMIT page
  R->>R: Return bounded evidence
```

v0.4.7, new query:

```mermaid
sequenceDiagram
  participant R as Recall
  participant M as Canonical WAL
  participant Q as Sidecar WAL
  R->>R: Embed query
  R->>M: BEGIN; read Generation at S
  R->>M: Index/profile validation without sidecar writer
  R->>Q: BEGIN IMMEDIATE; wait for writer
  R->>R: Check authority unchanged
  R->>M: KNN; FTS; ranking; hit Chunks in same snapshot
  R->>Q: Persist changed candidates; batch Seen/emitted; page; quota
  R->>R: Recheck authority
  R->>M: COMMIT read snapshot
  R->>Q: COMMIT page
  R->>R: Return bounded evidence
```

## Cross-database consistency argument

The canonical file and sidecar file are distinct transaction domains. Neither CAS
nor SQLite ATTACH is claimed to provide an atomic WAL commit across the files.
Canonical reads establish snapshot S by reading Generation after query embedding.
The query's eligibility time, index validation, metadata, Chunk text and revisions
all use that same snapshot. A missing applicability context stays `requires_check`.
Authority is captured with eligibility and checked again before persistence/return;
in-process configuration changes roll back the page. Runtime client configurations
remain connection-scoped: replacing an operator file requires the client's normal
reconnection to apply it, as before.

A canonical write committed before S is visible. A write concurrent with this
request and committed after S may be absent from this response: the response is a
consistent snapshot at S, not a promise to include all writes completed before
network delivery. The page and query are bound to Generation(S). A later request
opens a fresh canonical snapshot and rejects that older cursor with `CURSOR_STALE`.
Permission/ranking/profile checks remain independently binding. Scope filtering is
applied before candidate selection; changing the connection's scope cannot reuse
an old cursor. Expiry is frozen for each request with its eligibility snapshot.

All mutable query state is still serialized. The same unseen cursor page can have
only one committed winner; later callers replay that page. Local Seen sets substitute
only for this request's not-yet-persisted channel IDs; committed prior Seen state
continues to come from SQLite. Quota enforcement occurs after all batches, inside
the transaction. Capacity failures roll back all page state and return an error.

Canonical writers detach the unused sidecar before reserving their transaction;
recall reattaches it after that write finishes. Cached statements reprepare on
reattachment, checked by write/read and cross-version replay regressions.

Canonical COMMIT only releases a read snapshot. A crash before sidecar COMMIT rolls
back its incomplete page and progress; it cannot undo a different process's
canonical commit. A crash after sidecar COMMIT and before response delivery leaves
a replayable page. A canonical update in either boundary window makes the old
cursor stale on its next request, including a page committed just before a crash.
No body is stored in query state and no stale page can resurrect forgotten records
in a fresh snapshot. The release tests both boundary windows with a concurrent
canonical write, then SIGKILL, rather than inferring cross-file atomicity from a
successful sidecar transaction.

## Index and model review

Profile consistency, missing vectors and Chunk revisions remain checked on each
new query and each newly computed semantic cursor page. Replayed immutable pages
retain the previous validation behavior. No Generation-only integrity cache is
added: direct database corruption need not advance Generation. Warm-process tests
remove a vector without changing Generation and require explicit lexical degradation.
Existing profile, revision, migration, forget and broken-model checks remain active.

BGE retains one pipeline promise per encoder/process and the existing manifest/
model validation. No model service, cloud inference, quantization or new model is
introduced. Prepared Statements remain bounded and per connection; no statement or
binding is shared between databases. Thread comparisons are reported separately
from database optimizations; defaults are changed only if evidence warrants it.

## Reproducible measurement

`scripts/benchmark-concurrency.mjs` runs actual independent STDIO MCP servers with
BGE FP32. `bench/concurrency/probe.mjs` is opt-in benchmark instrumentation, never
loaded by the installed launch command. It records SQL calls/times and SQLite
trigger-inclusive changes using async request context. Debug diagnostics record
embedding, writer wait/occupancy, KNN, FTS/identifier, candidate/ranking,
materialization, serialization and state persistence. Per-request COMMIT samples
include WAL/autocheckpoint work exposed by SQLite; filesystem sync time cannot be
independently attributed from that call.

The measured MCP round trip minus server time is a residual that includes transport,
JSON handling, queueing and scheduler delay, not a pure network measurement. SQL
category timing provides the same index-validation definition for both kernels.
Stage percentiles are never added together. Raw reports retain samples, process RSS,
CPU, heap/external/ArrayBuffer diagnostics, operation counts, cleanup results and
per-scenario p50/p90/p95/p99/mean/N.

The matrix uses 1/2/4/8 processes, 120 waves per scenario, and three alternating A/B
trials. Scenarios are different and identical Focused queries; independent cursor
paging; shared-cursor continuation; Focused/Broad mixtures; readers and a writer;
read/write plus TTL cleanup; and frequent short queries mixed with less frequent
long evidence queries. Read/write has 120 × process-count reads per trial, not the
previous twelve reads. Both versions use the same explicit 60-second TTL, 256 MiB
logical cache budget and 512 MiB physical cache protection for this longer workload.
Production cache defaults are unchanged; capacity errors remain separate tested
behavior, not disguised exhaustion.

```sh
node scripts/benchmark-concurrency.mjs dist .local/concurrency/new-4 4 120 2
```

Run against an explicitly built frozen `.local/v041/eval/corpus.db`; keep outputs in
`.local`. Do not target a real memory database. Cold-start and warmup samples are
separate. Primary A/B runs are sequential and do not overlap the test suite. The
preliminary new run overlapped a regression run and is retained privately but is
not used for release latency claims. Host scheduling, GC, native allocators and
background applications remain sources of noise.

## Quality and recovery gates

The clean v0.4.6 baseline passes 77 tests. The release passes 96 tests, including
18 new transaction/concurrency cases and a multi-batch operation-count regression.
The first boundary test failed before the attachment fix; that failure is retained
rather than treating the earlier 93-test subset as sufficient.

Four processes concurrently request an ungenerated page, agree on ordered IDs, and
produce one committed page. A restarted process replays it and continuation reaches
all 80 expected IDs without duplicates. Two independent scoped worker processes
reach all 80 / 65 authorized records without cross-query or cross-scope leakage.
Create/update/forget/index changes after snapshot S preserve the S response and
invalidate the next cursor. Changing permission scope at snapshot/state-update
checkpoints rolls the page back. Removing a vector without changing Generation
still causes explicit lexical degradation.

Seven SIGKILL checkpoints cover read-only preflight, before/after the writer lock,
state updates, before COMMIT, between canonical release and sidecar COMMIT, and after
sidecar COMMIT before response. The two commit-boundary tests additionally commit
new canonical data from a warmed writer before killing the reader. Both databases
remain intact; committed data survive, partial pages roll back, completed pages
replay, and old cursors become stale.

The unchanged 120-query and 60-query fixtures plus six sanitized call-audit shapes
run in three alternating A/B trials. Every query's metrics, ordered IDs and complete
page-response hashes match: content, sources, Revision, applicability, assessment
and continuation semantics are preserved. Hashes exclude random cursor tokens and
diagnostics. The datasets are rule-generated, not real-world accuracy estimates.

| Focused metric, old / new | Original 120-query fixture | Specialist 60-query fixture |
|---|---:|---:|
| Precision@1 | 0.7167 / 0.7167 | 0.8000 / 0.8000 |
| Precision@3 | 0.3500 / 0.3500 | 0.3417 / 0.3417 |
| Precision@5 | 0.2167 / 0.2167 | 0.2400 / 0.2400 |
| Recall@5 | 0.9271 / 0.9271 | 1.0000 / 1.0000 |
| MRR | 0.9172 / 0.9172 | 1.0000 / 1.0000 |
| nDCG@5 | 0.8920 / 0.8920 | 0.9622 / 0.9622 |

Broad cumulative Recall stays 0.9778 / 1.0000 on the two fixtures. Evidence target
inclusion is 32/32, rejected-before-adopted is 0/8, and no-answer false-sufficient
counts stay 0/12 and 0/8. Ordinary recall reads zero complete bodies. Sources and
budget behavior are covered by page hashes, not only a ranking metric.

A separate deterministic-encoder microcase requests a legitimate larger Focused
page across multiple candidate batches. Candidate UPSERT calls fall 256 to 192,
Seen calls 192 to 2, emitted updates 18 to 1, and query updates 2 to 1, with 192
candidate IDs and zero complete-body reads in both versions. This is operation-count
evidence, not real-model latency or accuracy. On one-batch requests, candidate
UPSERT counts can remain unchanged; no universal reduction is claimed.

## Release results

Host: macOS 15.6, arm64, Node 24.18.0, 10 logical CPUs, 16 GiB RAM. This is an
interactive host, not an isolated performance machine. Successful release matrix
and thread cohorts contain 110,370 real-model recalls, all hybrid and all with zero
complete-body reads. Six separate phase-diagnostic cohorts add 8,760 recalls.
The 36 scale cohorts contain 2,160 measured warm recalls plus their cold warmups.
These are separate workloads, not one combined latency distribution.

Two additional matrix attempts did not complete. One new-version eight-process run
hit the 120-second SDK timeout while the goal was paused; the earlier harness did
not flush its partial in-memory samples, so their count is unknown. Its log and
database are retained. One baseline eight-process attempt retained 258 successful
samples and a timeout observed after 998,207.73 ms. Its 998,307 ms sampling gap
matches a system Clamshell Sleep of 1,000 seconds. This is a confirmed measurement
interruption for that attempt, not evidence of a SQLite deadlock. Failure inventory,
partial data and replacement-run mapping remain local. The original unknown-cause
failure is not silently reclassified. Successful-cohort percentiles below do not
include failed-attempt latency, and are not a claim of zero failures across all
attempts. No successful sample or long tail was deleted. The harness now persists
available failure data before teardown; temporary idle-sleep inhibition is limited
to the benchmark process and cannot prevent deliberate lid sleep.

The four-process Broad paging p95 median is 87.27 / 56.80 ms, and mean lock occupancy
is 8.038 / 4.974 ms. This is approximately a 35% tail reduction and 38% occupancy
reduction in that scenario. Four-process reader/writer p95 is almost unchanged,
61.99 / 61.68 ms; eight-process reader/writer is 156.12 / 140.97 ms. Single- and
two-process scenarios include regressions, so the directional targets are not
uniformly achieved. No general speedup is claimed. The attachment fix is retained
because the boundary failure proves a real lock coupling; batching also reliably
reduces native state-operation calls. The design remains small rather than adding
optimistic conflict machinery to chase noisy tails.

## Concurrent latency, median of three alternating trials

Each cell is v0.4.6 / v0.4.7 in ms. Each trial has 120 × process-count samples per listed scenario.

| Processes / scenario | Mean | p50 | p90 | p95 | p99 | p95 range before / after |
|---|---:|---:|---:|---:|---:|---|
| 1 / different | 15.34 / 12.85 | 13.00 / 11.87 | 17.76 / 16.44 | 18.20 / 19.64 | 20.69 / 22.99 | 13.48–26.24 / 14.34–20.32 |
| 1 / same | 12.36 / 12.86 | 11.15 / 11.70 | 14.17 / 16.08 | 15.51 / 17.50 | 24.30 / 19.37 | 12.35–18.48 / 13.00–19.31 |
| 1 / paging | 5.98 / 5.91 | 3.92 / 3.68 | 13.04 / 12.63 | 13.64 / 14.03 | 15.05 / 15.84 | 12.10–15.49 / 12.10–14.23 |
| 1 / shared | 5.89 / 4.64 | 4.06 / 3.12 | 13.55 / 11.84 | 14.35 / 12.39 | 16.74 / 12.89 | 12.06–15.24 / 11.61–13.64 |
| 1 / mixed | 10.34 / 9.73 | 11.44 / 11.53 | 14.53 / 14.88 | 16.08 / 16.15 | 20.03 / 19.49 | 13.63–17.75 / 12.59–32.45 |
| 1 / read_write | 12.66 / 18.83 | 11.50 / 15.54 | 15.15 / 24.14 | 16.96 / 25.35 | 24.76 / 40.72 | 13.15–19.08 / 13.09–35.78 |
| 1 / cleanup | 15.78 / 21.63 | 15.13 / 18.79 | 18.97 / 29.85 | 19.77 / 32.66 | 23.07 / 39.44 | 16.54–29.56 / 15.47–39.92 |
| 1 / short_long | 14.60 / 11.77 | 14.33 / 11.15 | 18.08 / 14.66 | 18.96 / 16.35 | 26.11 / 23.86 | 14.88–40.54 / 14.34–27.18 |
| 2 / different | 17.76 / 20.01 | 16.62 / 18.08 | 24.79 / 27.64 | 25.66 / 31.00 | 28.37 / 37.22 | 24.37–28.60 / 24.07–33.05 |
| 2 / same | 20.17 / 19.96 | 19.64 / 18.85 | 27.90 / 25.95 | 29.49 / 27.65 | 38.40 / 28.90 | 24.76–32.64 / 23.27–42.70 |
| 2 / paging | 9.33 / 10.63 | 6.20 / 6.72 | 21.85 / 23.56 | 26.60 / 35.33 | 36.34 / 40.30 | 23.98–36.37 / 25.90–35.73 |
| 2 / shared | 6.47 / 6.91 | 5.08 / 5.16 | 12.64 / 13.26 | 14.92 / 23.51 | 24.39 / 24.80 | 14.73–24.30 / 15.77–24.18 |
| 2 / mixed | 10.31 / 13.23 | 10.91 / 13.91 | 20.89 / 23.10 | 22.04 / 26.46 | 25.11 / 36.04 | 21.86–42.05 / 21.80–32.57 |
| 2 / read_write | 18.81 / 19.76 | 17.85 / 21.14 | 26.23 / 26.84 | 27.74 / 33.61 | 40.72 / 35.92 | 24.39–53.03 / 24.89–33.84 |
| 2 / cleanup | 30.02 / 23.74 | 28.57 / 22.50 | 46.27 / 38.61 | 52.09 / 42.03 | 69.87 / 51.83 | 28.98–105.37 / 38.97–44.35 |
| 2 / short_long | 18.79 / 20.45 | 18.17 / 19.31 | 26.03 / 29.33 | 27.56 / 31.18 | 31.46 / 34.59 | 23.86–34.82 / 24.07–34.53 |
| 4 / different | 35.13 / 36.71 | 29.76 / 31.76 | 60.22 / 62.03 | 63.61 / 65.21 | 66.30 / 90.02 | 60.87–64.20 / 50.56–100.86 |
| 4 / same | 45.38 / 34.96 | 42.33 / 30.81 | 70.03 / 61.31 | 83.10 / 62.97 | 127.16 / 67.40 | 60.08–88.77 / 46.21–88.87 |
| 4 / paging | 30.14 / 20.97 | 20.03 / 14.12 | 67.59 / 49.03 | 87.27 / 56.80 | 123.27 / 79.92 | 54.64–89.44 / 53.97–74.96 |
| 4 / shared | 20.28 / 19.01 | 12.70 / 12.42 | 43.75 / 43.63 | 44.83 / 44.26 | 68.94 / 68.83 | 44.38–45.23 / 44.07–44.93 |
| 4 / mixed | 19.06 / 20.08 | 15.61 / 17.29 | 36.78 / 39.39 | 52.81 / 52.63 | 61.30 / 71.33 | 50.83–80.19 / 45.80–61.67 |
| 4 / read_write | 33.66 / 32.50 | 29.88 / 29.31 | 60.53 / 49.97 | 61.99 / 61.68 | 66.26 / 65.01 | 59.96–66.38 / 57.91–104.08 |
| 4 / cleanup | 48.93 / 43.35 | 43.64 / 42.19 | 82.70 / 66.21 | 94.87 / 84.93 | 129.16 / 97.06 | 65.70–163.43 / 63.99–96.38 |
| 4 / short_long | 58.00 / 35.43 | 48.65 / 31.05 | 100.11 / 61.68 | 120.05 / 62.82 | 197.20 / 65.42 | 59.54–312.52 / 59.82–69.69 |
| 8 / different | 63.17 / 54.74 | 51.92 / 45.93 | 121.00 / 100.34 | 129.65 / 108.75 | 159.36 / 144.71 | 125.28–202.79 / 105.66–160.42 |
| 8 / same | 64.24 / 57.36 | 51.74 / 48.46 | 124.50 / 103.40 | 131.78 / 111.78 | 159.40 / 157.62 | 127.18–265.27 / 111.69–167.54 |
| 8 / paging | 70.17 / 67.25 | 53.58 / 51.37 | 158.71 / 144.89 | 165.06 / 164.10 | 226.15 / 223.30 | 163.70–660.60 / 156.74–165.30 |
| 8 / shared | 63.85 / 61.76 | 45.69 / 47.33 | 131.24 / 129.87 | 159.40 / 157.27 | 217.27 / 213.08 | 158.90–160.28 / 126.17–159.22 |
| 8 / mixed | 53.84 / 49.68 | 42.95 / 41.98 | 109.96 / 102.33 | 135.65 / 121.85 | 181.36 / 172.56 | 128.83–183.06 / 118.46–134.27 |
| 8 / read_write | 70.65 / 67.88 | 56.02 / 55.90 | 129.84 / 125.71 | 156.12 / 140.97 | 188.36 / 175.28 | 141.08–194.85 / 138.77–146.94 |
| 8 / cleanup | 66.44 / 61.50 | 55.56 / 53.51 | 123.22 / 119.74 | 139.44 / 129.49 | 177.39 / 159.14 | 132.02–406.48 / 127.58–152.79 |
| 8 / short_long | 60.08 / 57.85 | 49.90 / 47.50 | 118.62 / 100.29 | 135.59 / 124.56 | 177.69 / 250.30 | 126.54–191.58 / 111.42–175.51 |

## Four-process writer coordination

| Scenario | Mean held before / after | p95 wait before / after |
|---|---:|---:|
| different | 6.55 / 6.22 | 41.15 / 41.36 |
| same | 8.95 / 6.03 | 41.44 / 41.35 |
| paging | 8.04 / 4.97 | 62.20 / 41.39 |
| shared | 2.63 / 2.49 | 41.41 / 41.39 |
| mixed | 5.66 / 6.07 | 41.12 / 38.78 |
| read_write | 6.00 / 5.77 | 41.33 / 41.27 |
| cleanup | 9.92 / 8.13 | 64.37 / 62.40 |
| short_long | 13.55 / 6.38 | 65.11 / 41.36 |

### Confirmed findings and limits of attribution

Confirmed: the sidecar writer serializes mutable candidate/ranking/materialization
work; the warmed canonical writer also reserved its attached sidecar in v0.4.6;
and batching removes the measured native calls. The cross-file regression and
statement counters demonstrate these findings directly.

Unproven explanations: CPU competition, native allocator behavior and checkpoint I/O
can affect tails, but these samples do not establish their individual causal share.
Thread comparisons show different CPU use without a universal one-thread advantage.

Measurement limits: interactive background load, scheduler/GC timing and three-trial
ranges remain visible. Confirmed lid-sleep interruption is reported separately;
the other incomplete attempt retains an unknown cause. Regressions are observations,
not automatically dismissed as noise. In particular, 10,000-memory single-process
Broad p95 rises from 56.51 to 64.05 ms in the scale sample; unchanged quality does
not imply improved latency.

### State-operation evidence

Counts below are mean native statement calls per four-process recall, shown as the
median of three trial means. Batched inserts still execute the same per-row quota
triggers. Fewer native calls do not imply equal reduction in SQLite row mutations.

| Scenario / operation | v0.4.6 | v0.4.7 |
|---|---:|---:|
| Different-query candidate UPSERT | 38.96 | 38.96 |
| Different-query Seen INSERT | 59.21 | 2.50 |
| Different-query query UPDATE | 2.00 | 1.00 |
| Different-query emitted UPDATE | 3.90 | 1.00 |
| Paging Seen INSERT | 24.02 | 0.46 |
| Paging query UPDATE | 2.00 | 1.00 |
| Paging emitted UPDATE | 6.58 | 1.00 |
| Reader/writer Seen INSERT | 68.00 | 3.00 |
| Reader/writer emitted UPDATE | 8.00 | 1.00 |

For reader/writer, trigger-inclusive SQLite changes average 236 / 234 per request.
Quota accounting stays transactional. A broad reduction in row writes is not claimed;
most savings are native-call batching, removing a redundant query update, and
conditional multi-batch persistence. The deterministic microcase above separately
shows the conditional UPSERT saving. Cache quota checks remain approximately
0.05 ms in the phase sample; maintaining a new global counter/cache to avoid them
would add more coordination than the observed cost justifies.

## Phase profile, four-process diagnostic cohorts

Cells are v0.4.6 / v0.4.7 ms, median of three per-trial statistics. Different-query, paging and read/write samples share the same fixed mixture. Wire rows include cold/warmup; other rows exclude them. Zeros indicate a stage not needed for a request. Percentiles must not be added.

| Phase | N per trial before / after | Mean | p50 | p90 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|
| decode_schema_ms | 1459 / 1459 | 0.041 / 0.043 | 0.038 / 0.039 | 0.058 / 0.059 | 0.072 / 0.075 | 0.115 / 0.118 |
| send_serialize_ms | 1459 / 1459 | 0.043 / 0.043 | 0.041 / 0.041 | 0.059 / 0.049 | 0.074 / 0.059 | 0.109 / 0.109 |
| transport_json_residual | 1440 / 1440 | 0.656 / 0.682 | 0.558 / 0.571 | 0.795 / 0.822 | 0.943 / 1.061 | 3.781 / 4.048 |
| embedding | 1440 / 1440 | 9.326 / 9.367 | 12.331 / 12.460 | 15.035 / 15.149 | 16.272 / 15.975 | 24.726 / 21.226 |
| state_open | 1440 / 1440 | 0.003 / 0.042 | 0.002 / 0.030 | 0.003 / 0.058 | 0.004 / 0.078 | 0.008 / 0.281 |
| state_read_ms | 1440 / 1440 | 0.014 / 0.012 | 0.000 / 0.000 | 0.051 / 0.051 | 0.057 / 0.056 | 0.082 / 0.079 |
| state_wait | 1440 / 1440 | 12.554 / 11.356 | 9.865 / 9.421 | 37.301 / 22.669 | 41.338 / 41.036 | 62.193 / 63.091 |
| writer_held_ms | 1440 / 1440 | 5.585 / 5.317 | 4.993 / 4.604 | 9.019 / 8.273 | 11.816 / 10.756 | 15.537 / 15.269 |
| index_validation | 1440 / 1440 | 0.356 / 0.461 | 0.317 / 0.366 | 0.425 / 0.709 | 0.637 / 0.789 | 0.869 / 1.097 |
| knn | 1440 / 1440 | 0.607 / 0.632 | 0.671 / 0.717 | 1.036 / 1.041 | 1.465 / 1.423 | 2.375 / 2.282 |
| fts_identifiers | 1440 / 1440 | 0.451 / 0.452 | 0.538 / 0.536 | 0.656 / 0.659 | 0.788 / 0.813 | 1.353 / 1.450 |
| candidates | 1440 / 1440 | 1.966 / 1.736 | 1.332 / 1.046 | 3.831 / 3.587 | 6.618 / 6.436 | 9.260 / 8.976 |
| ranking | 1440 / 1440 | 0.668 / 0.650 | 0.785 / 0.789 | 1.118 / 1.120 | 1.501 / 1.485 | 3.321 / 3.221 |
| materialization | 1440 / 1440 | 0.252 / 0.262 | 0.188 / 0.192 | 0.480 / 0.486 | 0.524 / 0.529 | 0.759 / 0.899 |
| state_persist | 1440 / 1440 | 0.710 / 0.783 | 0.295 / 0.412 | 2.351 / 2.385 | 2.876 / 3.023 | 4.050 / 4.294 |
| quota_ms | 1440 / 1440 | 0.055 / 0.050 | 0.046 / 0.046 | 0.070 / 0.068 | 0.079 / 0.077 | 0.192 / 0.133 |
| serialization | 1440 / 1440 | 0.125 / 0.126 | 0.126 / 0.128 | 0.161 / 0.162 | 0.167 / 0.169 | 0.305 / 0.287 |
| canonical_commit | 1440 / 1440 | 0.006 / 0.007 | 0.005 / 0.006 | 0.009 / 0.010 | 0.011 / 0.012 | 0.016 / 0.019 |
| sidecar_commit | 1440 / 1440 | 0.622 / 0.583 | 0.216 / 0.213 | 2.279 / 2.205 | 2.810 / 2.791 | 3.857 / 4.005 |
| cleanup | 1440 / 1440 | 0.041 / 0.030 | 0.030 / 0.025 | 0.059 / 0.050 | 0.070 / 0.061 | 0.125 / 0.087 |

## Scale latency and quality

| Memories / mode | p50 old / new ms | p95 old / new ms | Recall@5 | MRR | Chunk reads old / new |
|---|---:|---:|---:|---:|---:|
| 100 / focused | 9.103 / 9.156 | 10.663 / 10.823 | 1 | 0.8792 | 22.800 / 22.800 |
| 100 / broad | 8.568 / 8.486 | 10.304 / 9.999 | 1 | 0.8792 | 4.950 / 4.950 |
| 1000 / focused | 11.187 / 11.220 | 13.956 / 14.159 | 1 | 0.8792 | 27.400 / 27.400 |
| 1000 / broad | 10.560 / 10.569 | 13.074 / 12.329 | 1 | 0.8792 | 4.950 / 4.950 |
| 10000 / focused | 46.608 / 46.662 | 56.861 / 58.341 | 1 | 0.8767 | 28.550 / 28.550 |
| 10000 / broad | 45.771 / 46.543 | 56.513 / 64.049 | 1 | 0.8767 | 4.950 / 4.950 |

The SDK decode/schema and send rows have 1,459 observed packets per trial: the last
asynchronous wire event was not drained before each diagnostic report was built.
This telemetry gap is explicit; it is not filled with zero. Engine/SQL samples are
complete. The harness now waits briefly for wire events outside measured requests.
Wire instrumentation wraps the actual SDK ReadBuffer and STDIO send method. Send
includes serialization and stream-write/drain, not remote processing. The residual
contains scheduling/queueing as well as transport and JSON work. Sidecar COMMIT
includes any WAL/autocheckpoint time inside SQLite; no independent fsync attribution
is available. The separate diagnostic cohort confirms one pipeline initialization
per process (four processes per trial); the deterministic microcase is not used to
infer real-model performance.

Forced maintenance in the four-process read/write/TTL scenario has 24 operations
per trial. Median-of-trial mean/p50/p90/p95/p99 ms are 16.609/13.723/24.279/29.153/
73.497 before and 11.565/11.239/15.254/20.986/28.641 after. These are whole maintenance
operations, not additive request phases. No-expiry requests retain the pre-existing
skip of a cleanup writer transaction. Final sidecar disk observations range about
165–203 MiB before and 203 MiB after on this extended budget; data deletion reuses
pages and does not promise file shrinkage. Production quotas remain unchanged.

### Threads and memory

| Four processes, new version p95 ms, median of three | 1 thread | 2 threads |
|---|---:|---:|
| Different Focused queries | 58.46 | 45.17 |
| Broad pages | 55.16 | 55.29 |
| Readers/writer | 60.23 | 59.75 |
| Read/write/TTL cleanup | 64.22 | 63.52 |

The thread cohorts are separate from the version A/B. One thread does not provide a
consistent tail or memory advantage, so the default stays two. Their simultaneous
sampled RSS ranges are 1.699–2.196 GiB / 1.243–1.962 GiB. Mean summed `ps` CPU
percentages are approximately 118.9 / 229.2; these are platform-reported process
percentages, not exclusive physical CPU allocations or a throughput normalization.

| Simultaneous sampled peak RSS range, GiB | v0.4.6 | v0.4.7 |
|---|---:|---:|
| 1 process | 0.413–0.564 | 0.379–0.605 |
| 2 processes | 0.630–1.097 | 0.640–1.137 |
| 4 processes | 1.113–1.882 | 1.182–1.870 |
| 8 processes | 1.472–2.609 | 2.440–2.666 |

RSS sampling is every 200 ms after warmup and can miss instantaneous peaks. Summed
RSS may count shared pages repeatedly; it is not exclusive physical memory. PSS/
exclusive footprint was not collected. Four-process cold start plus first recall
has median 687.90 / 685.62 ms over 12 process observations per version. Native
allocation and GC timing make these overlapping memory ranges unsuitable for a
memory-saving claim. Per-response heap/external/ArrayBuffer snapshots are retained;
ArrayBuffers are part of external memory, so these categories must not be added.

The largest remaining coordination cost is the serialized mutable query computation.
The release does not move KNN, ranking or all materialization outside the writer.
A complete split would require an isolated working state, query-version/CAS checks,
winner-page replay, bounded conflict retries and quota reconciliation. Simply
unlocking early would allow duplicate/skipped pages. An auxiliary in-memory copy of
all query state could also add growing per-page copy cost on broad queries. These
mechanisms and a cross-file validation strategy need separate proof and measurement;
they are not introduced on the strength of a single favorable tail sample. Existing
statement reuse and warm connection opening are already cheap, while Generation-only
integrity caching would miss the demonstrated unchanged-generation corruption.


## Changed files and maintenance scope

- `src/storage/database.ts`, `src/retrieval/state.ts`: detach idle attachments at
  canonical writes, reattach pooled readers, and retain immediate revision isolation.
- `src/retrieval/recall.ts`, `src/core/service.ts`: canonical preflight snapshot,
  authority fences, bounded changed-state tracking, batched writes and internal
  fault checkpoints. Ranking and tool input contracts remain unchanged.
- `tests/transactions.test.mjs`, `tests/concurrency-worker.mjs`,
  `tests/performance.test.mjs`: process barriers, scoped exhaustion, mutations,
  unchanged-generation corruption, cross-file failures and operation counts.
- `scripts/benchmark-concurrency.mjs`, `bench/concurrency/`: frozen workload matrix,
  SQL/wire telemetry and sanitized replay fixtures. Benchmark outputs stay ignored;
  an existing output database is never overwritten. Failed runs now persist their
  available samples and transport errors before teardown.
- `scripts/benchmark-adaptive.mjs`: add response hashes to guard content and order
  in both versions using the same evaluation harness.
- Package/server version, both READMEs, protocol and this report: release and usage
  documentation. No dependency, model, permission, canonical schema or vector change.


## Compatibility, maintenance and rollback

Canonical Schema 5, Memory IDs/revisions, source offsets, write permissions and
propose/commit/forget behavior are unchanged. `remaining_ids` continues to support
bounded explicit expansion. Ranking stays `adaptive-v046` because ordering is not
intentionally changed; existing valid cursors need not be invalidated by the release.
Bidirectional old/new replay is checked on a disposable database.

Back up installed code and client configuration, and take a consistent canonical
SQLite backup. Install the build at the existing stable path, preserve writer
configuration bytes, and reconnect MCP clients normally. Roll back to the backed-up
v0.4.6 code and runtime marker if necessary; no database migration or re-embedding
is required. Do not restore an old canonical backup merely to roll back code, as
that could discard later legitimate writes. Query state remains a disposable
sidecar with the same tables and TTL/quota behavior.

The maintenance cost is a bounded request-local persistence comparison, batch SQL,
a detach/reattach check at canonical writes and pooled recalls, a preflight snapshot guard, and internal no-op fault checkpoints reusing the
existing service test hook. Full optimistic state computation, lease management,
Generation-only safety caches and new persistent services are left out. The
remaining KNN, ranking and materialization work is still serialized per sidecar;
this release reduces coordination work without claiming all Agent computations
run in parallel.
