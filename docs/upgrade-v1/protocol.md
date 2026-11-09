# Shared Agent Memory v1 · Protocol

The installed v0.4.8 protocol remains documented in [protocol.md](../protocol.md).
This document records the proposed v1 additions and implementation status. Each
stage adds its executable examples here after its acceptance checks.

| Contract | Stage | Status |
| --- | --- | --- |
| Exact version expansion and event metadata | P1 | Implemented and tested |
| Effective time, decision state and atomic transitions | P2 | Planned |
| Bounded related-evidence paths | P3 | Planned |
| Authorized feedback and dry-run consolidation | P4 | Planned |

A record may include `memory_form` of `legacy`, `episodic`, `semantic` or
`procedural`. This leaves its existing `kind` intact. Optional `episode`
fields are `conversation_ref`, `session_ref`, `event_ref`, `speaker`,
`event_time` and `context`. References are source-provided strings. Use a UTC
timestamp only when the source supplies one. Omit unknown values or use null
for unknown speaker or time. `valid_time` holds optional UTC `valid_from` and
`valid_to`. Explicit effective-time filtering is P2 work. An ordinary update
preserves existing event fields when omitted, and null clears the episode or
effective interval.

```json
{"versions":[{"memory_id":"31dbd102-1990-4891-87a4-080d74d64b13","revision":2}],"limit":1}
```

`versions` is mutually exclusive with `ids`, `query` and `cursor`. It checks
current project/global authorization and revocation, excludes invalidated
derived records, and uses the selected revision's own context and offsets.
When available it returns `recorded_at`, `current_revision`,
`history_start_revision`, `history_complete` and `does_not_imply_current`.
Unknown or inaccessible revisions are omitted. Supplied context that conflicts
with the requested revision excludes it. Older or expired evidence is
`requires_check` on this explicit evidence-review path.

The existing item, token and byte budgets apply. Retry deferred pairs as
`{"versions":[...]}` using `remaining_versions`. Raise the budget for
`blocked_versions` or for an already returned truncated item. The legacy
`remaining_ids`, query cursors and v0.4.8 item shape continue to apply to their
existing modes. Ordinary recall still uses chunks and metadata.

Stored legacy hashes cover the original record. Extended records use
`hash({envelope:"sam-record-v1",record})` with the existing stable
serialization and SHA-256. Record time comes from the database write,
independently of source occurrence time. A legacy record's stored body and hash
are copied as-is into its initial version row.
