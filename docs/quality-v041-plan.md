# v0.4.1 audit and implementation plan

Baseline: main 75224d8 (v0.4.0 code d550fe8); frozen compiled baseline under ignored `.local/v041/baseline/dist`. Canonical Schema 5 and the original 120-query/240-record fixture remain unchanged.

Observed defects:

- `assess()` admits the first five anchors irrespective of answer relevance; generic question words contribute FTS coverage. Identifier presence ranks rejected proposals as highly as procedures. No execution state is proved by verification alone.
- Evidence materialization uses `substr(text,1,200)` and discards the actual match location.
- The sidecar only expires queries; one cleanup deletes every expired child row in one writer transaction. No resident resource accounting or quota exists; freed SQLite pages remain allocated.
- Existing four-process tests use deterministic encoders. They demonstrate consistency, not real-model performance.

Implementation: preserve Broad scoring; remove Focused unconditional anchors, compare informative local coverage and semantic distribution, and conservatively rerank bounded hit chunks for answer-intent alignment. Keep execution claims unknown unless explicit original statements and non-inference provenance support them. Query-aware evidence windows retain exact offsets without additional model calls. Add sidecar-only quota accounting, bounded cooperative cleanup and admin-only maintenance/inspection. Quotas fail explicitly and never masquerade as exhausted evidence; no cumulative result-count limit is added. Freeze a separate specialist fixture before measuring. Add actual STDIO MCP multi-process real BGE measurements separately from fake-encoder tests.

Validation: original frozen quality A/B; specialist quality/snippet A/B; existing full suite plus regressions; 100/1,000/10,000 scaling and real-model MCP scenarios. Reports distinguish rule labels, relevance, credibility and execution claims. Sidecar migrations are disposable and additive; rollback instructions must cover cache invalidation without touching canonical data.
