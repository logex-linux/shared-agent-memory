# v0.4.5: recent-call coverage and applicability-aware evidence

This is a quality patch over v0.4.4 (`8cf8605`). Schema 5, stored vectors, Memory
IDs/revisions, permissions, lifecycle, explicit ID expansion and cumulative Broad
pagination remain compatible. No conversation auto-importer or profiling service is
introduced.

## What the recent-call audit found

A local audit reviewed 89 recall calls and 24 write calls in 24 Codex sessions over
approximately two days, including recent turns in older sessions. The audit excludes
its own conversation. It covers observable local Codex logs, not every harness.
Some callers reduced their tool responses, one output was truncated, and some request
fields were dynamically constructed. Missing fields were kept unknown rather than
reconstructed by executing conversation code. The private report retains requests,
responses, source locators, call IDs and these observation limits.

The library grew from 275 to 283 memories. Ten successful commits account for eight
new records and two revisions. One commit initially reused the proposal's UUID and
was rejected with `REQUEST_ID_REUSED`; its retry with a distinct UUID succeeded.
Three proposal validation failures were corrected. Two recall requests failed input
validation: query plus cursor, and a byte budget below 2048. These are not write
permission failures. Descriptions now explicitly require distinct UUIDs for propose
and commit, while preserving the same-operation, identical-input retry contract.

Many recent project discussions had no committed memory. Old writing, cleanup and
tool-policy records could offer background, but could not establish the new work's
history. A large number of conversations is not equivalent to a populated memory
library. Corpus inspection, historical responses and current-snapshot replays are
reported separately.

## Fixes

### Direct evidence with missing applicability context

A committed report-requirements record had a high vector score, exact identifier
hits and full local query coverage, but also an `environment` restriction. Without
context it was correctly marked `requires_check`. Two ordering rules then hid it
behind weak background: current records preceded all records requiring a check, and
the first-page relevance anchors preserved that order. Under a small page budget,
the direct record appeared only on the second page. Explicit ID reads worked.

The correction applies only to Focused queries with unknown fact-state intent and
at least one high-coverage direct reference requiring a context check. It gives
direct-reference candidates precedence over weak background, preserving the existing
ordering within each group. `requires_check` stays visible. A conflicting supplied
environment, branch or commit still excludes the record. Permission filtering is
unchanged. Adopted/proposed/rejected-intent ranking and Broad ranking are unchanged.

An initial, broader promotion rule reduced specialist Recall@5 from 1.0 to 0.890625
by moving topic background ahead of supporting review evidence. That implementation
was rejected. Its results are retained privately. The released rule is deliberately
narrow; no relevance labels or frozen requests were changed to pass the gate.

### Acronyms and mixed Chinese/code evidence

Short explicit acronyms such as `JD` and `OCR` now participate in the existing
reference-evidence heuristic. Previously a general work policy could be marked
`supported` for an unrelated acronym-specific project query. Neighbors remain
accessible, but unsupported references produce `background_only`, `weak` and
`REFERENCE_EVIDENCE_MISSING`; an all-weak page is `insufficient`.

ASCII references adjacent to Han prose are recognized, for example `2000字`,
`3391课程`, and `FONTCONFIG_FILE与SAL_FONTPATH`. Identifier extensions such as
`JD_EXTRA`, and longer mixed names extending a Han-ending reference, remain distinct.
Evidence windows use the same reference matcher and retain contiguous original text
and UTF-16 offsets. There are no new embedding calls or complete-body reads.

These are testable relevance heuristics, not evidence of truth or automatic proof of
sufficiency. Acronym aliases, unnamed semantic topics and partial answers still need
Agent judgment. A source about one requirement may not answer every part of a query.

## Recent-case A/B and source curation

Both retrieval versions were replayed against the same 283-memory/488-chunk snapshot,
using the original parameters and continued pages. Earlier historical queries ran
against smaller libraries; this replay is a counterfactual comparison, not a claim
to reproduce every original response.

For 15 queries about a newly created project without direct stored records,
first-page `related_evidence` responses fall from 8 to 0. Both versions still expose
70 neighbors across continued pages. Estimated transfer tokens increase from 49,760
to 50,370 because of the explanatory markers. This is improved abstention, not a
recall-count reduction, and these totals are not a single LLM prompt size. Two queries that previously
deferred a direct record to page two now return it on the first page with
`requires_check` preserved. These case judgments are an agent's source review, not
independent human accuracy labels.

Separately, under the operator's existing task-completion curation authorization,
three short records were added after checking the current project documents: a
project entry point, its cleaning/provenance rules, and an installed writing skill's
entry point. They retain document hashes, dates and explicit project boundaries with
`unverified` / `document_review` provenance. No prior record was rewritten. Post-write
retrieval is verified separately and is not mixed into the fixed-corpus A/B results.
The package does not automatically import conversations or infer permanent profiles.

## Quality and reliability gates

The unchanged 120-query/240-record fixture and 60-query/126-record specialist fixture
were run in three alternating A/B trials with real BGE FP32. Every query's P@1,
P@3, P@5, Recall@5, MRR, nDCG, cumulative recall and target-evidence inclusion are
unchanged. These rule-generated datasets are not real-world accuracy estimates.

| Focused metric | Original fixture, old / new | Specialist fixture, old / new |
|---|---:|---:|
| Precision@1 | 0.7167 / 0.7167 | 0.8000 / 0.8000 |
| Precision@3 | 0.3500 / 0.3500 | 0.3417 / 0.3417 |
| Precision@5 | 0.2167 / 0.2167 | 0.2400 / 0.2400 |
| Recall@5 | 0.9271 / 0.9271 | 1.0000 / 1.0000 |
| MRR | 0.9172 / 0.9172 | 1.0000 / 1.0000 |
| nDCG@5 | 0.8920 / 0.8920 | 0.9622 / 0.9622 |

Broad cumulative Recall remains 0.9778 / 1.0000 on the two fixtures. Target evidence
inclusion is 32/32; rejected-before-adopted is 0/8. No-answer false-sufficient counts
remain 0/12 and 0/8. The latter do not measure all possible unsupported questions.

`npm test`: 71/71 pass. Three added regressions cover acronyms/Han-adjacent boundaries
and offsets, direct retrieval with missing/matching/conflicting context and cursor
replay, and generic-policy abstention with retained semantic neighbors. Existing
concurrent writes, revision conflicts, SIGKILL recovery, migrations, permissions,
revocations, model degradation and pagination checks pass.

## Performance and limits

The existing 100/1,000/10,000-memory workload retains Recall@5=1.0, unchanged MRR and
zero full-body reads. Focused chunk reads remain 22.80 / 27.40 / 28.55; Broad reads
remain 4.95. An initial 10,000-memory Focused run overlapped other validation and
showed a p95 spike; it was retained and repeated without those competing tests.
In three isolated repeats, the 10,000-memory Focused p95 median is 63.94 ms before
and 61.62 ms after, with unchanged MRR and chunk reads. These differences do not
establish a stable speedup. No scan-count reduction or ANN behavior is claimed; sqlite-vec's internal vector
scan count remains unobservable.

Final real-model validation runs four independent STDIO MCP processes with the same
BGE FP32 model and two threads per process, three alternating trials per version,
508 recalls per trial: 3,048 recalls, zero errors. Each Broad reader retrieves 72
distinct records over 11 pages. Shared-cursor replay, concurrent writes, TTL cleanup
and survivor queries after SIGKILL succeed. Full-body reads are zero; Focused ranking
still reads 38 chunks on this workload.

| Final four-process p95 ms, median of three trials | v0.4.4 | v0.4.5 |
|---|---:|---:|
| Focused | 62.28 | 80.85 |
| Broad pages | 142.77 | 104.19 |
| Concurrent readers/writer | 59.84 | 82.68 |
| Sustained queries | 62.39 | 62.07 |

Focused and reader/writer p95 are higher in this final sample. They did not improve
consistently across the earlier retained trial sets. No stable performance gain is
claimed and the short concurrent scenarios remain noisy. Sustained-query median
embedding/ranking times are 14.250/0.819 ms before and 13.850/0.818 ms after;
median state wait is 0.007 ms in both. This does not establish a cause for tail
latency. Performance remains a follow-up measurement boundary, not a hidden tradeoff
accepted by changing relevance tests.

Simultaneous sampled RSS peaks range from 1.36–1.66 GiB before to 1.40–1.68 GiB after.
RSS sums may count shared pages repeatedly and are not exclusive physical memory.
No model, quantization, default thread count, embedding service or vector store was
changed. Query-aware matching and a conditional candidate-ordering pass add a small
maintenance surface; ordinary/Broad pages do not allocate an unnecessary ranking map.

## Installation, compatibility and rollback

Build and test with Node 24.18.0 and the existing lockfile/model:

```sh
npm run build
npm test
```

The tool names and parameters are unchanged. Generate a new UUID for each propose
and commit operation. Retry an operation with its original UUID only for identical
input. Keep normal writes `unverified` unless the connection has separately
authorized verification rights.

Back up installed code/config and take a consistent SQLite backup before upgrading.
No canonical schema/index/vector migration or re-embedding is required.
`adaptive-v045` binds new cursors to the revised ranking; restart the original query
when an old cursor becomes invalid. Reconnect existing MCP processes to load the new
code. A fresh process at the installed path verifies the upgrade; replacing files
does not prove a preexisting process has reloaded its modules.

For code rollback, restore the previous runtime and runtime-version marker, reconnect,
and restart queries. Keep the current memory database: the code-only rollback does
not require reverting separately authorized new records. Preserve the latest
revocation log for any independent data restore.

Reproduce with `scripts/benchmark-adaptive.mjs`, the unchanged two fixture modules,
`scripts/benchmark-adaptive-scale.mjs`, and `scripts/benchmark-real-mcp.mjs` with
`BENCH_DRAIN=1` and 100 rounds. Private conversations, raw audit files, canonical
databases, local configurations and generated benchmark results stay outside Git.
