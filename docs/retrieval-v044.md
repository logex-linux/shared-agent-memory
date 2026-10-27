# v0.4.4: reference evidence and recent-call review

This is an incremental quality patch over v0.4.3 (`e152884`). It preserves Schema 5,
Memory IDs/revisions, the embedding profile, permissions, lifecycle, explicit ID
expansion, late materialization, source offsets and cumulative Broad pagination.
No user record is imported, rewritten, merged or deleted by this upgrade.

## Findings

A local review covered 31 recall calls and three write calls after the previous
upgrade, including recent turns in conversations created earlier. Two recall
requests failed validation: one requested a byte budget below 2048, another combined
query and cursor. A write request used invalid UUID/time placeholders and update
parameters for a new proposal; its corrected propose/commit and subsequent read
succeeded. This is not a loss of write permission.

The snapshot contains 275 memories and 480 chunks, with only one added memory since
the preceding audit. Many recent conversations have no committed memory. Better
ranking cannot reconstruct their missing history. In those cases, old documents
about broadly similar work could receive `supported` from a high vector score, or
from a generic filename such as `app.js`. English function words also participated
in local evidence ranking. The private report retains the original calls, sources,
IDs, offsets and judgments; it is deliberately excluded from Git.

## Changes

- Focused ranking and evidence windows ignore common English query scaffolding.
  This changes neither stored text nor stored vectors/indexes.
- Focused analysis prepares reference matchers once per query. It recognizes code
  symbols, paths, compound names and letter/digit labels; calendar dates are context.
  It reads only the already loaded hit chunks and title. No additional body or chunk
  reads are needed. Absolute-path suffixes and sentence-final periods are handled.
- When fewer than half of the named references match, and fewer than 60% of the
  remaining subject terms have local support with an existing distinctive-term
  signal, the candidate is treated as background. These are explicit heuristics,
  not proof that the memory is irrelevant or that an answer is impossible.
- Such semantic neighbors remain accessible. Focused places them after candidates
  without this qualification and marks them `weak`, with
  `recall_reason: [..., "background_only"]`. The response adds
  `REFERENCE_EVIDENCE_MISSING` when any returned item has this qualification. A page
  containing only weak items is `insufficient`. The warning does not disqualify
  other items in the same response. Strong local subject evidence can still support
  a paraphrase with an unmatched identifier. Broad admission/ranking is unchanged.
- MCP validation errors retain `INVALID_INPUT` and now include the actual constraint
  message in `fields`. Recall guidance shows cursor-only continuation. Proposal
  guidance distinguishes new proposals from the commit revision, real request UUIDs
  and actual ISO UTC source-check times.

The ordinary result remains compact: no new debug object, whole-body fetch or model
inference per candidate. Relevance and factual verification remain separate. The
service does not automatically save conversation history or create a user profile.

## Quality and case review

The 120-query/240-record and 60-query/126-record fixtures, labels, modes and requests
are unchanged. Three alternating A/B trials use the same BGE FP32 snapshots.

| Focused metric | Original fixture: old / new | Specialist fixture: old / new |
|---|---:|---:|
| Precision@1 | 0.7167 / 0.7167 | 0.8000 / 0.8000 |
| Precision@3 | 0.3500 / 0.3500 | 0.3417 / 0.3417 |
| Precision@5 | 0.2167 / 0.2167 | 0.2400 / 0.2400 |
| Recall@5 | 0.9271 / 0.9271 | 1.0000 / 1.0000 |
| MRR | 0.9172 / 0.9172 | 1.0000 / 1.0000 |
| nDCG@5 | 0.8920 / 0.8920 | 0.9622 / 0.9622 |

No labeled relevant result is lost and no query's MRR decreases. Broad cumulative
Recall stays 0.9778 / 1.0000 on the two fixtures. Evidence target inclusion is 32/32,
rejected-before-adopted is 0/8, and no-answer false-sufficient counts remain 0/12 and
0/8. These rule-generated fixtures are not real-world accuracy estimates.

The private audit separately reviews 25 queries without direct records for their
specific requested subjects. On the same current snapshot, first pages marked
`related_evidence` decrease from 15 to 2; total emitted neighbors across continued
pages decrease from 157 to 148. Context use decreases from approximately 112,507 to
108,605 estimated tokens across those complete multi-page query runs. These totals
are not a single prompt size or the content actually read in the original chats.
The two remaining cases include an Auto query resolved to Broad and a query with no
explicit code/path references. They still need source judgment. These are an agent's
retrospective source judgments, not independent human labels or an accuracy score.
Historical responses and current-snapshot replays are kept separate.

## Verification and performance

`npm test`: 68/68 pass, including five new regressions for reference matching,
English snippet location, background qualification, semantic retention and MCP
validation guidance. Existing concurrency, revision, SIGKILL, migration, permission,
revocation, cursor and degradation checks pass.

The unchanged scale workload uses 20 queries, three repeats per mode/size, `limit=5`.
Recall@5 remains 1.0 and MRR is unchanged. Normal queries load zero complete bodies.

| Memories | Focused p95 ms: old / new | Broad p95 ms: old / new | Focused chunk rows: old / new |
|---|---:|---:|---:|
| 100 | 11.85 / 11.31 | 11.12 / 10.37 | 22.80 / 22.80 |
| 1,000 | 14.85 / 14.79 | 13.33 / 14.81 | 27.40 / 27.40 |
| 10,000 | 111.73 / 106.90 | 58.35 / 60.12 | 28.55 / 28.55 |

Three longer alternating real-BGE MCP trials per version each complete 508 recalls
with zero errors: 3,048 calls total. They cover four processes, independent and shared
cursors, concurrent writes, TTL cleanup and survivor reads after SIGKILL. Every Broad
reader collects 72 unique records over 11 pages. Full-body reads remain zero.

| MCP p95 ms, median across three trials | v0.4.3 | v0.4.4 |
|---|---:|---:|
| Four Focused readers | 65.44 | 61.43 |
| Four Broad readers | 86.44 | 85.58 |
| Concurrent readers/writer | 78.94 | 78.21 |
| Sustained queries | 60.99 | 61.07 |

Simultaneously sampled aggregate RSS ranges from 1.24–1.84 GiB to 1.31–1.82 GiB.
RSS sums can double-count shared pages and are not exclusive physical memory.
Shorter exploratory trials showed larger latency variation, including slower Broad
runs; they were retained rather than discarded. No stable speed or memory reduction
is claimed. This patch improves evidence qualification, not the model architecture.
sqlite-vec internal vector scans remain unobservable.

## Upgrade, rollback and limits

Build with the pinned Node version and run the tests. Back up installed code/config
and use a consistent SQLite backup before replacing the runtime. Dependencies,
canonical schema, vectors and role configurations are unchanged; no reindex or
migration is required. `adaptive-v044` invalidates prior ranking cursors: restart the
original query. To roll back, restore the previous code and runtime marker, reconnect,
and restart queries. Do not restore an old memory database for this code-only change.

Reference checks use the already fetched hit chunks, not every chunk in a long memory.
An unreturned section may contain further evidence; expand selected IDs when useful.
Aliases and reference-free semantic questions still require judgment. Missing history
must be explicitly authorized and committed before it can become shared memory; this
release does not silently import conversations or increase any Agent's write scope.

Reproduce the frozen evaluation with `scripts/benchmark-adaptive.mjs` using the two
unchanged fixture modules, scale runs with `scripts/benchmark-adaptive-scale.mjs`, and
real MCP runs with `scripts/benchmark-real-mcp.mjs` (`BENCH_DRAIN=1`, 100 rounds). Keep
generated corpora, private reviews and raw benchmark outputs outside Git.
