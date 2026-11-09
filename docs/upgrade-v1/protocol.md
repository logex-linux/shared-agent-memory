# Shared Agent Memory v1 · Protocol

The installed v0.4.8 protocol remains documented in [protocol.md](../protocol.md).
This document records the proposed v1 additions and implementation status. Each
stage adds its executable examples here after its acceptance checks.

| Contract | Stage | Status |
| --- | --- | --- |
| Exact version expansion and event metadata | P1 | Implemented and tested |
| Effective time, decision state and atomic transitions | P2 | Implemented and tested |
| Bounded related-evidence paths | P3 | Planned |
| Authorized feedback and dry-run consolidation | P4 | Planned |

A record may include `memory_form` of `legacy`, `episodic`, `semantic` or
`procedural`. This leaves its existing `kind` intact. Optional `episode`
fields are `conversation_ref`, `session_ref`, `event_ref`, `speaker`,
`event_time` and `context`. References are source-provided strings. Use a UTC
timestamp only when the source supplies one. Omit unknown values or use null
for unknown speaker or time. `valid_time` holds optional UTC `valid_from` and
`valid_to`. An ordinary update
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

Decision state accepts `unknown`, `proposed`, `adopted` and `rejected`.
Lifecycle accepts `current`, `historical` and `quarantined`. These fields are
independent of verification. The optional `decision_state` recall filter
requires an explicitly matching state. Focused searches without an explicit
filter continue to apply the previous heuristic to undeclared records. A
declared proposal remains a proposal even if the prose quotes an adoption.
`subject_id` and `context_key` are caller-provided within the project or global
scope. Similarity alone does not establish a shared subject or context.

Current search and ID expansion exclude historical, quarantined and
out-of-interval records. `as_of` queries include eligible historical records
and use the asserted effective interval [valid_from, valid_to). An unknown
boundary returns `effective_time: "unknown"`, `EFFECTIVE_TIME_UNKNOWN` and
weak evidence. `include_history: true` permits diagnostic review of
quarantined records. Current authorization, expiry and context filters still
apply to ordinary queries. Exact version reads can explicitly review an
expired revision with `requires_check`. A continuation pins the initial
effective time and scope. Old-version ranking cursors should restart.

Use the normal propose and commit calls with these optional proposal fields.

```json
{
  "transition": "supersede",
  "expected_refs": [
    {"memory_id":"31dbd102-1990-4891-87a4-080d74d64b13","revision":2}
  ]
}
```

The successor supplies its source-backed effective start, the same explicit
subject and matching context. The cutoff must already have taken effect.
Commit checks all predecessor revisions together and writes each closed
historical revision, successor, source relations, dependent invalidations and
receipt atomically. Supersession edges point to the new historical predecessor
revision. Predecessor vectors remain unchanged. Changes to a verified
predecessor also require verify permission.

`reinforce` publishes separate supporting evidence with matching subject,
context and decision state. A repeated source URI or source hash is rejected
as reinforcement. `branch` requires the same subject and a demonstrably
different context. `quarantine` updates the supplied `target_id` with its
existing revision CAS and sets lifecycle to quarantined. The explicit `new`
transition publishes an independent record.

An optional `relations` array contains `{target_id,type,sources}` entries.
Each target must appear in `expected_refs`. Manual relations allow
`supports`, `contradicts`, `context_variant` and `related_to`.
`supersedes` is produced only by its state transition. Relation sources are
stored with exact endpoint revisions and the shared scope. The graph reader
will validate endpoint currency and visibility before it can use these rows.
