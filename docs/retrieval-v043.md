# v0.4.3: focused retrieval and writer setup

## Scope and compatibility

This patch preserves Schema 5, Memory IDs/revisions, local BGE, permission checks,
propose → commit, explicit ID expansion, source offsets, degradation and unbounded
cumulative Broad pagination. It changes neither existing records nor embeddings.
Installation still defaults to a reader. A reader cannot acquire write access by
following an AGENTS.md prompt; an operator must explicitly select a writer config.
`recall/propose/commit` suffices for creating and updating unverified memories;
`manage`, `verify` and `forget` are separate capabilities.

A later write trace revealed a second failure: a writer requested
`verification.status=verified`, which correctly requires `verify`. User confirmation
is a provenance basis, not that permission. The follow-up preserves
`OPERATION_DENIED` and adds `required_operation`/`hint` to MCP errors and CLI JSON
(CLI keeps its existing string `error`). Tool/schema descriptions and both README
Agent snippets show `basis=user_confirmation` with `status=unverified` for ordinary
authorized storage. The server never rewrites a denied request or grants privileges.

## Findings and changes

1. **Source labels could masquerade as topics.** Imported records often share tags
   identifying a file/category. When the last tag matches a source URI path component
   or file stem, and occurs on at least three eligible records, Focused uses a more
   conservative evidence gate. The count reads the lightweight metadata index, is
   permission/applicability filtered, capped at three and cached per tag per request. It never reads
   complete bodies. Other records retain the previous admission rules.
2. **Complementary evidence matters.** The gate combines semantic similarity,
   weighted local coverage and distinctive multi-character query terms. Neutral
   request verbs do not dominate those IDF anchors. A long query can retain a source
   matching several subject terms even when overall coverage is low. A very strong
   semantic match remains possible without lexical overlap. These are relevance
   heuristics, not proof of answer sufficiency or factual verification.
3. **An unmatched identifier should not impose a nonexistent topic restriction.**
   The identifier-topic guard now depends on actual initial identifier matches.
4. **A year is often context.** In ordinary Focused queries, a contextual `20xx`
   token no longer independently receives the exact-identifier channel boost.
   Year-only requests and `exact_only=true` retain literal numeric lookup. Error
   symbols, function names and code paths retain their identifier channel.
   Broad's candidate rules and identifier handling are unchanged.
5. **A weak fallback was forced into default semantic results.** An empty qualified
   pool now remains empty for ordinary hybrid/vector Focused retrieval. Explicit
   lexical searches and `lexical_degraded` keep the previous weak-evidence fallback.
   `insufficient` remains a valid outcome.
6. **Small ordinary pages reserved space for absent diagnostics.** Ordinary responses
   now reserve only bounded final envelope growth; detailed diagnostics retain their
   debug reserve. Sources, revisions and exact source offsets remain mandatory.

No fixed cumulative result limit was introduced. These rules do not guarantee that
every partial match is useful. Broad still favors evidence coverage. Current large
synthetic specialist data still has a high cumulative Focused irrelevant fraction;
this patch does not claim to have solved all ranking problems.

## Empty pages and continuation

Prefer omitting resource budgets unless there is a reason to customize them.
`max_bytes` must be at least 2048. A record's mandatory source metadata may exceed a
small page budget even with its content shortened. `item_exceeds_budget` reports a
blocked item rather than falsely claiming exhaustion. Its uncommitted page can be
retried with a larger budget:

```json
{"cursor":"<returned next_cursor>","max_bytes":8000}
```

Do not change a previously committed page's options on replay. Resume/restart as
documented by the cursor errors. To expand full content, use only selected real IDs.
Missing recent project history is not a permission failure: a record must first have
been explicitly authorized and committed before it can be retrieved.

## Quality gate

Baseline: v0.4.2 commit `7d2b697`. Both runs use the same BGE FP32 model, unchanged
120-query/240-record and 60-query/126-record corpora, labels, queries, modes and
budgets. Labels are rule-generated and auditable, not independent human judgments
or estimates of real-world accuracy. P@k uses denominator k even for short results.

| Frozen Focused metric | v0.4.2 / v0.4.3: 120-query corpus | v0.4.2 / v0.4.3: specialist corpus |
|---|---:|---:|
| P@1 | 0.7167 / 0.7167 | 0.8000 / 0.8000 |
| P@3 | 0.3500 / 0.3500 | 0.3417 / 0.3417 |
| P@5 | 0.2167 / 0.2167 | 0.2400 / 0.2400 |
| Recall@5 | 0.9271 / 0.9271 | 1.0000 / 1.0000 |
| MRR | 0.9172 / 0.9172 | 1.0000 / 1.0000 |
| nDCG@5 | 0.8920 / 0.8920 | 0.9622 / 0.9622 |
| Cumulative recall | 0.9479 / 0.9479 | 1.0000 / 1.0000 |
| Cumulative irrelevant fraction | 0.7951 / 0.7705 | 0.8996 / 0.8963 |
| Estimated tokens per complete query | 2230.4 / 2017.4 | 4869.8 / 4694.2 |

Broad cumulative recall is unchanged: 0.9778 on the original corpus and 1.0000 on the
specialist corpus. Evidence target inclusion remains 32/32, rejected-before-adopted
remains 0/8 and false sufficient classifications remain 0/12 and 0/8 on the respective
no-answer subsets. No query lost a labeled relevant record or worsened MRR. This
does not claim unchanged cumulative ordering of irrelevant results.

The local audit separately replays actual historical calls on a consistent private
snapshot. It distinguishes transport errors, invalid arguments, missing ingested
history, later-page results, relevance rejection and byte-budget blocking. Its raw
queries, record contents, IDs, client configuration and source paths stay outside Git.
Those case judgments are an agent's source review, not independent human labels.

## Verification and measurements

`npm test`: 63/63 pass, including seven new audit/permission/budget regressions plus
existing multi-process writes, revision conflicts, schema migration, source offsets,
revocations, model degradation, cursor concurrency and SIGKILL recovery. The writer
test commits/reads user-confirmed unverified data, rejects verified data with the
specific permission hint, and checks the exposed tool/schema guidance. CLI tests
distinguish propose/verify denials and prove neither persists a candidate or receipt.
The hint follow-up changes no ranking code; the quality/performance results below
measure the retrieval patch.

The 100/1,000/10,000 scale comparison uses the same 20 queries × three repetitions,
matched `limit=5` requests and disposable BGE snapshots. Recall@5 stays 1.0 in all
six workloads, MRR is unchanged, and ordinary complete-body reads remain zero.

| Size | Focused p95 ms: old / new | Broad p95 ms: old / new | Focused Chunk rows: old / new |
|---|---:|---:|---:|
| 100 | 11.27 / 11.14 | 10.99 / 10.32 | 22.80 / 22.80 |
| 1,000 | 15.46 / 14.52 | 13.01 / 13.75 | 27.40 / 27.40 |
| 10,000 | 60.60 / 58.10 | 56.40 / 56.87 | 28.55 / 28.55 |

These short timings are observations, not a speed claim. Independent four-process
real-BGE MCP verification is summarized below after repeated runs. Test records,
runtime probes and benchmark state are disposable; no real memory is written.

Three further observed runs allowed process RSS sampling, alternated A/B order and
ran without concurrent build/test jobs. Each run completed 228 recall calls with no
MCP errors. Each Broad reader retrieved 72 unique records over 11 pages. Same-cursor
replay, concurrent writers, cleanup and survivor reads after SIGKILL also passed.

| MCP p95 ms, median of three runs | v0.4.2 | v0.4.3 |
|---|---:|---:|
| Four Focused readers | 64.51 | 66.23 |
| Four Broad readers | 122.25 | 111.76 |
| Same-cursor readers | 43.43 | 43.67 |
| Concurrent readers and writer | 78.97 | 80.82 |
| Sustained readers | 61.85 | 64.75 |

Read/write trial ranges were 55.79–87.52 / 38.48–82.88 ms. No stable tail-latency or
memory improvement is claimed. Simultaneously sampled aggregate RSS ranged from
1.345–1.725 / 1.509–1.763 GiB. RSS sums can double-count shared pages and are not
exclusive physical memory. An earlier sandboxed run could not execute `ps`; its
zero aggregate counter means **unavailable**, not zero memory. Worker probes were
still available, and no data from that counter was used as a resource improvement.

## Upgrade and rollback

Build with the pinned Node runtime and lockfile, run the tests, back up installed
code/configuration, then replace the compiled runtime. Do not restore an old memory
database to roll back this code-only patch: no canonical migration or reindex is
required. Rebuild the previous commit to revert the algorithm. New cursors bind to
`adaptive-v043`; upgrading or rolling back requires restarting old queries rather
than continuing a session across ranking versions.

A writer configuration is a separate, explicitly authorized local operator change.
Back it up independently. To revoke write capability, select the prior read-only
configuration and reconnect. Existing memories are unaffected. Never grant an Agent
administrator access as a workaround for a missing write tool.

## Reproduction

```sh
npm ci
npm test
BENCH_LABEL=old node scripts/benchmark-adaptive.mjs measure EVAL_DIR OLD_DIST
BENCH_LABEL=new node scripts/benchmark-adaptive.mjs measure EVAL_DIR dist
BENCH_FIXTURE=bench/quality/fixtures.mjs BENCH_LABEL=new \
  node scripts/benchmark-adaptive.mjs measure SPECIALIST_DIR dist
node scripts/benchmark-adaptive-scale.mjs dist 10000 focused SCALE_OUTPUT SCALE_CORPUS
BENCH_OUTPUT=REAL_OUTPUT BENCH_DRAIN=1 \
  node scripts/benchmark-real-mcp.mjs dist new 30
```

Use the frozen fixture builders and local model setup described in the existing
evaluation documents. Repeat the real MCP comparison at least three times with
alternating order. Do not overlap the timing runs with test/build jobs. Internal
sqlite-vec scan counts remain unobservable; returned Top-K is not a scan count.
