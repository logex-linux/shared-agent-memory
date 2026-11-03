# v0.4.8 Focused retrieval from call-log replay

## Audit

The local audit covered 480 Codex and StepCode conversations and 340 recorded
recall calls. Results were available for 294 calls. Another 32 completed calls
had status and arguments only, and 14 failed. Of the available results, 107
reported insufficient evidence and 21 returned no items. Those counts include
legitimate gaps in stored evidence and do not measure ranking accuracy. Six
empty responses reported `RESPONSE_BUDGET`. Recorded failures also included
invalid combinations of query, IDs, and cursor, or a changed mode on continuation.

For the version comparison, replayed 40 parseable query-only requests from
the post-v0.4.7 Codex and StepCode logs with real BGE. Both versions read
copies of the same 342-record Schema 5 snapshot. This isolates ranking from
records and revisions added after the original calls. Logs, identifiers,
paths, memory excerpts, and the database snapshot stay local.

## Changes

- The first Focused page can promote one candidate when FTS coverage and
  weighted coverage in the title and hit chunks both reach 70%, both are at
  least 20 percentage points above the incumbent's best coverage, and the
  candidate matches a salient term. Only admitted candidates qualify.
  Broad, strict identifier searches, and explicit fact-state intents keep
  their existing ranking rules.
- Mixed-case names such as `AtlasBridge` now inform reference assessment and
  excerpt selection. A similar fault from another system can still surface
  as weak background. The reference remains a soft signal so strong
  paraphrases can still be retrieved. The exact-only index is unchanged.
- Applicability and verification still describe the stored record and its
  context. A promoted record may require checking its environment or version.
  Reordering uses existing candidate and hit-chunk data.

## Results

Four of the 40 replayed queries moved more direct evidence to the first
position. The cases covered a transport error, a short system name, a
browser-session fault, and a logging requirement. Two first-page evidence
statuses changed in the expected directions on review. A similar fault from
another system no longer appeared to answer the named system's startup query.
In the other case, a memory documenting the requested logging procedure was
no longer marked as background. These are reviewed cases, not a precision
estimate for the 480 conversations.

| Real-BGE fixture | v0.4.7 to v0.4.8 |
| --- | --- |
| Frozen 120-query evaluation | Identical page contents and ordering. Focused P@1 71.7%, Recall@5 92.7%, Broad cumulative Recall 97.8% |
| Frozen 60-query specialist set | Identical page contents and ordering. Focused P@1 80.0%, Recall@5 100%, 32/32 evidence targets |
| Six sanitized earlier audit queries | One exact path case moved the labeled evidence from rank 6 to rank 1. Other pages matched. Cumulative recall matched |
| Local Node 24.18.0 suite | 98/98 passed, including two regressions reproduced against v0.4.7 |

The fixture runs read zero full memory bodies during ordinary recall.
The audit does not establish a latency improvement. Unstored history,
metadata that cannot fit a page, and invalid cursor arguments remain separate
from ranking.

## Compatibility and rollback

The database remains Schema 5. The ranking fingerprint is
`adaptive-v048`. Restart old queries after `CURSOR_SCOPE_CHANGED`.
Continue an active query with `{"cursor":"<next_cursor>"}`, omitting
`query`, `ids`, and mode/scope overrides. If an item is blocked by the
page budget, retry with a larger budget within the configured caps.

To roll back, restore the v0.4.7 runtime and its version marker in the
client launcher, then restart the query under that version. The canonical
database, embedding profile, and stored revisions work with both versions.
Keep the canonical database and revocations in place during runtime rollback.
