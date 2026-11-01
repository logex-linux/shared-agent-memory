# v0.4.6: multi-client evidence retrieval and complete ID expansion

This is an incremental quality patch over v0.4.5 (`7e9fd00`). Schema 5, stored vectors,
Memory IDs/revisions, permissions, write lifecycle, sources, and cumulative Broad
pagination are unchanged. No additional model, service, automatic conversation
importer, or user-profile generator is introduced.

## Audit scope and observation limits

The local review covers 2026-10-29 11:34:12 UTC through 2026-11-01 15:49:27 UTC,
excluding this audit's own conversation. It statically parses actual assistant tool
calls and matched tool results, rather than treating prose about memory access as
an executed call. Logged code is never executed to reconstruct missing arguments.

| Observable calls | Codex | StepCode |
|---|---:|---:|
| Sessions containing calls | 12 | 5 |
| Recall | 67 | 6 |
| Propose | 20 | 12 |
| Commit | 14 | 9 |
| Total | 101 | 27 |
| Unknown request / response | 16 / 9 | 0 / 2 |

Some requests are dynamically constructed and some results are truncated or reduced
by the caller. These fields remain unknown. Counts are observations in the selected
local logs, not a census of all conversations or a real-world accuracy score. Older
StepCode prose saying tools were unavailable does not demonstrate current connection
failure; actual later calls succeed. The configured Codex and StepCode identities
are distinct and retain recall/propose/commit access to the same library.

Observed failures include reused operation UUIDs, stale cursors, invalid UTC date
fields, a self-dependency, and a request for privileged verification from an ordinary
writer. They do not justify broader permissions. In particular, `OPERATION_DENIED`
with `required_operation=verify` is independent of ordinary unverified storage.

The frozen current snapshot contains 307 memories and 518 chunks. Forty-three
observable query starts are replayed with their original parameters and continued
pages against both versions. There are also 19 observable ID expansions and six
cursor calls. Historical responses, current-corpus replays, and synthetic quality
benchmarks are kept separate: new committed records can repair a historical miss
without any ranking change. Private transcripts, memory bodies, source paths and
client settings are excluded from Git.

## Three iterations

### 1. Explicit expansion reports unreturned IDs

Previously, an explicit `ids` call could return fewer records than requested because
of a page budget or `limit`, while returning `has_more=false` and no continuation
list. That flag describes query paging, but the response did not explain the
unreturned part of an ID expansion. Nine logged expansions contain fewer output
records than input IDs; absent records alone do not prove a budget issue because
permissions and applicability must also be considered. Disposable regression tests
reproduce the budget/limit case with known eligible records.

The response now includes `remaining_ids` and `PARTIAL_ID_EXPANSION` for eligible,
unreturned IDs. These are included in budget accounting before reading bodies.
Filtered, expired, nonexistent and unauthorized IDs are never enumerated. Query
cursors remain separate. This is additive output; tool names and inputs are unchanged.

```json
{"ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],"max_bytes":5500}
```

These UUIDs only illustrate the format. Use actual UUIDs from retrieval, then
continue with the returned IDs:

```json
{"ids":["22222222-2222-4222-8222-222222222222"],"max_bytes":5500}
```

Preserve any explicit project/global/context filters. An `item_exceeds_budget`
response with `blocked_ids` needs a larger page budget. A returned item marked
`truncated` is not in `remaining_ids`: reread that item separately with a larger
budget when its complete text is required. All expansions remain bounded by existing
per-page guards and retain sources.

### 2. Concrete paths and provenance background

One StepCode query asks for classification rules at a concrete development path but
contains a weak cue equivalent to “organizing habits.” Auto selected Broad from that
cue alone. Common imported working-directory headers then looked highly relevant.

Auto now distinguishes a concrete slash-path question from weak preference cues.
Explicit Broad, clear long-term/cross-project synthesis, and existing candidate-
distribution widening remain available. This is an intent heuristic, not a new
cumulative limit. For Focused queries with a specific subject, matching a common
provenance path without adequate subject coverage or salient local evidence is
background, rather than support for the answer. The candidate remains accessible.

On the same snapshot, the direct classification decision moves from second to first;
the first page contains one relevant decision rather than eleven mixed neighbors.
Cumulative candidates change from 164 Broad neighbors to 26 Focused candidates. This
count reduction is not itself a quality score. An explicit Broad request retains its
original expansion strategy. A related directory-use query keeps its correct first
result while a generic imported index is downgraded to `weak/background_only`.

### 3. Specific semantic evidence with missing context

The v0.4.5 applicability exception required an exact reference. A natural-language
query could therefore find the right topical Chunk but defer it behind generic
current background because its environment was unspecified. The exception now also
accepts specific-topic, salient, high-local-coverage semantic evidence above the
existing evidence threshold. It applies only to Focused with unknown fact-state
intent, and only when a qualifying record needs a context check.

In source-reviewed replay cases, a reading-document location moves from page four
to the first result, an observed module-import workaround moves ahead of unrelated
background, and a course-maintenance record precedes a general task policy. The
records remain `requires_check`; conflicting supplied context still excludes them.
Adopted/proposed/rejected-intent ranking is unchanged. These are agent-reviewed
source cases, not independent human accuracy labels or automatic fact verification.

## Quality and reliability

The unchanged 120-query/240-record and 60-query/126-record fixtures run in three
alternating A/B trials with real BGE FP32. Every query's Precision@1/@3/@5/@20,
Recall@5/@20, MRR, nDCG, cumulative recall, duplicates, no-answer assessment and target
inclusion are unchanged. No fixture, relevance label or benchmark request was
modified. These are rule-generated evaluations, not estimates of real-world accuracy.

| Focused metric, v0.4.5 / v0.4.6 | Original fixture | Specialist fixture |
|---|---:|---:|
| Precision@1 | 0.7167 / 0.7167 | 0.8000 / 0.8000 |
| Precision@3 | 0.3500 / 0.3500 | 0.3417 / 0.3417 |
| Precision@5 | 0.2167 / 0.2167 | 0.2400 / 0.2400 |
| Recall@5 | 0.9271 / 0.9271 | 1.0000 / 1.0000 |
| MRR | 0.9172 / 0.9172 | 1.0000 / 1.0000 |
| nDCG@5 | 0.8920 / 0.8920 | 0.9622 / 0.9622 |

Broad cumulative Recall stays 0.9778 / 1.0000 on the two fixtures. Evidence target
inclusion is 32/32, rejected-before-adopted is 0/8, and no-answer false-sufficient
counts are 0/12 and 0/8. Ordinary retrieval reads zero complete memory bodies.

`npm test`: 77/77 pass, compared with 71/71 at the clean v0.4.5 baseline in the moved
repository. Added checks cover ID continuation and blocked-source retry without
unauthorized ID disclosure; concrete-path intent and provenance background; semantic
evidence with missing/conflicting context; and distinct writer identities sharing
revisions while enforcing cursor ownership, deterministic concurrent continuation,
reconnect replay and generation invalidation. Existing revision races, multiprocess
writes, SIGKILL recovery, migrations, revocations, permissions, degraded-model and
paging tests continue to pass.

## Performance

The existing 100 / 1,000 / 10,000-memory workloads run in three alternating trials
per version and mode, with identical corpora and requests. Recall@5 stays 1.0,
MRR stays unchanged, and complete-body reads remain zero. Focused mean Chunk reads
are 22.80 / 27.40 / 28.55; Broad reads remain 4.95. Token transfer on these fixed
workloads is unchanged.

| Scale p95 ms, median of three | v0.4.5 Focused / Broad | v0.4.6 Focused / Broad |
|---|---:|---:|
| 100 memories | 10.55 / 9.65 | 10.41 / 9.74 |
| 1,000 memories | 13.63 / 12.52 | 13.87 / 12.40 |
| 10,000 memories | 56.17 / 53.94 | 56.79 / 54.70 |

Real-model release validation runs four independent STDIO MCP processes using BGE
FP32, two threads each, in three alternating trials per version. Each trial performs
508 recalls: 3,048 total, zero errors and zero full-body reads. Every Broad reader
returns 72 distinct records across 11 pages. Same-cursor replay, concurrent writes,
TTL cleanup and survivor queries after SIGKILL succeed. The ordinary Focused
workload still reads 38 ranking Chunks; this release does not claim to reduce that
existing precision cost.

| Four-process latency ms, median of three | v0.4.5 p50 / p95 | v0.4.6 p50 / p95 |
|---|---:|---:|
| Focused | 28.65 / 66.59 | 25.77 / 64.78 |
| Broad pages | 4.68 / 87.30 | 4.09 / 108.02 |
| Concurrent readers/writer | 17.62 / 37.33 | 11.80 / 57.29 |
| Sustained queries | 29.07 / 70.51 | 28.88 / 67.55 |

Broad and reader/writer p95 are higher in this sample. The concurrent scenarios are
short and the host is not isolated from other applications. The new ranking branches
are conditional, and these observations do not establish a stable improvement or a
cause for the higher tails. No speedup is claimed. Median sustained-query stage
p50/p95 ms are embedding 12.860/18.598 before versus 13.223/16.345 after; sidecar
wait 0.007/27.059 versus 0.006/26.140; ranking 0.798/1.127 versus 0.783/0.930;
materialization 0.180/0.250 versus 0.176/0.210. Stage percentiles do not add up to
end-to-end percentiles.

Simultaneous sampled RSS peaks range from 1.397–1.848 GiB before and 1.197–1.821 GiB
after. RSS sums can count shared pages repeatedly and are not exclusive physical
memory; these overlapping ranges do not establish a memory reduction. Sampling is
100 ms and cannot capture every instantaneous peak. Node heap/external/ArrayBuffer
snapshots are retained privately; allocator and GC timing affect them. No exclusive
physical-memory/PSS claim is made. TTL draining leaves zero cached queries and
candidates in every trial, without claiming the SQLite file physically shrinks.

Reproduce with the unchanged scripts and explicit output paths:

```sh
node scripts/benchmark-adaptive.mjs measure .local/eval dist
BENCH_LABEL=0.4.6 node scripts/benchmark-adaptive-scale.mjs dist 10000 focused .local/scale .local/scale-benchmark
BENCH_DRAIN=1 BENCH_OUTPUT=.local/real-v046 node scripts/benchmark-real-mcp.mjs dist 0.4.6 100
```

Build the frozen fixture database first as described in the earlier evaluation
documents. Local performance artifacts and actual client configurations remain
ignored. No benchmark modifies real user memories.

## Compatibility, installation and rollback

The source checkout can move without changing a client's stable installed entry
point. Keep the configured runtime, database and model paths independent of the
checkout. A source-directory rename does not migrate memory data, change project
UUIDs, or rewrite historical source URIs. Confirm actual paths before upgrading.

No schema migration, re-embedding, model change or dependency change is required.
Back up installed code/client configuration and take a consistent SQLite backup
before installing the build. Preserve connection identities, project/global scopes
and operations. `adaptive-v046` invalidates older ranking cursors; restart their
original query and deduplicate by Memory ID/revision.

Build and verify with Node 24.18.0 and the committed lockfile:

```sh
npm run build
npm test
```

The isolated integration check uses the two existing writer configurations with
only their database path redirected to a private clone. One connection creates, the
other reads and updates to revision 2, and the first rereads. Verification remains
denied; cursors cannot cross identities and become stale after a committed update.
This validates configured MCP processes, not an autonomous client model's decision
to call a tool, and does not require operating either application's UI.

For rollback, restore the backed-up v0.4.5 runtime and runtime-version marker, then
reconnect. Canonical data need not be restored because the upgrade does not change
its format or records. Restore a database backup only for an actual data recovery
need, with awareness of subsequent legitimate writes. Old-version query states may
need a fresh query; never delete the canonical database to repair cursor state.

## Remaining limits

Specificity, subject coverage and intent are deterministic heuristics. Common paths,
aliases and mixed-language questions can still produce background neighbors. Some
English/Chinese identifier queries in the private replay remain weak or need later
pages; this release does not invent alias mappings or claim those misses are solved.
A missing source record still requires authorized curation and commit. More chats
do not automatically increase stored evidence.

The patch adds a small response continuation field and narrow ranking/intent guards,
without a second retrieval architecture. Broad can continue until relevant results
are exhausted; page budgets still bound each response. Fact-state analysis remains
local and relevance never upgrades verification. No optimization loads the full
library's memory bodies into Node.js. sqlite-vec internal scan counts remain
unobservable; returned KNN rows are not reported as scanned vectors or ANN behavior.
