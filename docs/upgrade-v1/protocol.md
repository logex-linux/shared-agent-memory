# Shared Agent Memory v1 · Protocol

The v0.4.8 protocol remains documented in [protocol.md](../protocol.md).
The v1 preview advertises version `1.0.0-beta.1` during MCP initialization.
Existing tools retain their names. Discover optional arguments and permissioned
tools through the tool list.

| Contract | Stage | Status |
| --- | --- | --- |
| Exact version expansion and event metadata | P1 | Implemented and tested |
| Effective time, decision state and atomic transitions | P2 | Implemented and tested |
| Bounded related-evidence paths | P3 | Implemented, experimental and off by default |
| Authorized feedback and dry-run consolidation | P4 | Implemented. Learned graph expansion is experimental and off by default. |

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
validates endpoint currency and visibility before it uses these rows.

Enable `graph_enabled` in the operator configuration and request expansion
explicitly. Both switches are required.

```json
{"query":"What check followed the restart incident?","mode":"focused","view":"evidence","graph":true,"limit":5}
```

An admitted item can include `graph_path.seed` and `graph_path.steps`. Each
step gives the edge ID and revision, its type and direction, both endpoint
versions and the edge sources. Every returned item still needs independent
query evidence in its own title and hit chunks. A path records an association.
It does not certify a claim or change its verification. `supersedes` and
`contradicts` are excluded from positive expansion. `exact_only` bypasses it.

The initial limits are eight seeds, two hops, 16 examined edges per expanded
node and 128 examined edges per page, within the shared candidate and time
budgets. Source paths use the same response budget as other evidence. Resume
with the existing `next_cursor`. `retrieval.graph` reports its state and the
remaining frontier count. `graph_limit` with `more_unexamined` indicates the
bounded walk stopped with edges left outside its limits. `GRAPH_STALE` warns
that an old endpoint revision was skipped. An unavailable or corrupt graph
degrades to ordinary hybrid retrieval with an explicit warning.

The cursor pins the initial effective time, algorithm and model profile as
well as scope, canonical generation and graph epoch. Restart on
`CURSOR_GRAPH_CHANGED`. Ordinary graph-off cursors ignore a graph-only epoch
change. Pages save paths and warnings so the same cursor can be replayed.

An operator may explicitly grant the `feedback` operation. That connection
receives an opaque `feedback_receipt` on nonempty query pages and can call
`memory_feedback`. A receipt binds the generated page to its connection,
authority and exact returned ID/revision pairs. It expires with the query
cache. Use a fresh query for `FEEDBACK_RECEIPT_EXPIRED` or
`FEEDBACK_RECEIPT_UNAVAILABLE`. A missing, obsolete or inapplicable revision
cannot be used. Both endpoints of a pair must share the same project or the
global scope. There is no receipt on explicit ID or revision expansion.

```json
{
  "request_id":"8ec2ef11-4fe1-48e2-abba-93df7f8d1493",
  "task_id":"a7f4bc15-ec87-4d3c-95ad-47f88ec1926a",
  "page_receipt":"adbfdb6c-8dfb-4de4-98ec-b1cd229e5d70",
  "used":[{"memory_id":"31dbd102-1990-4891-87a4-080d74d64b13","revision":2}],
  "outcome":"useful",
  "basis":"agent_report"
}
```

These are example IDs. Send only one or two evidence versions actually used.
Use the same `task_id` across that task's feedback. `outcome` also accepts
`irrelevant` and `misleading`. `test_result` and `user_evaluation` require
an `evidence_ref`, which the server stores as a digest. The default
`feedback_policy: "observe"` queues observations with zero weight.
`trusted_outcomes` is an operator trust decision. It permits weighted test
and user outcome reports from that connection. The fields alone do not
verify those reports. Agent reports always have zero weight.

`feedback --config FILE --input FILE` uses the same contract. An operator
with `manage` and full scope can run `project-feedback --config FILE` to
apply queued inputs in order. `--limit` accepts 1 to 1000 jobs. `--rebuild`
clears the projection and restarts from retained events. Continue regular
batches until `pending` reaches zero. The initial weights use a 30-day
half-life, increments of 0.2 for useful pairs, decrements of 0.1 or 0.3 for
irrelevant or misleading pairs and a range of [0, 1]. The policy is versioned.
Neither observation nor projection changes memory verification.

`learned_graph_enabled` also defaults to `false`. Enabling it allows a request
with `graph: true` to consider projected association edges after explicit
edges within the same traversal budget. The first page pins the weight
evaluation time. Edges decay out of consideration below 0.05. Returned
`learned_association` steps identify the exact endpoint versions, the
association policy and the decayed weight. Their sources are the endpoint
sources. They establish neither the truth of feedback nor the truth of the
claim. Historical `as_of` requests do not use learned weights. A changed
projection epoch invalidates graph cursors.

To prepare a synthesis, use an authorized CLI configuration.

```sh
node dist/cli/main.js consolidate --dry-run --config "$CONFIG" --input "$INPUT"
```

The input includes `project_id`, `scope`, `title`, `kind`, one `claim`,
optional `context`, and `evidence` containing `mode` and `citations`. A citation
contains `memory_id`, `revision`, `start`, `end` and optional `role` of
`support` or `counterexample`. Offsets are UTF-16 source offsets and each
excerpt is at most 500 units. The dry run follows existing derivations to
their originals, groups overlapping source identities, and computes the
shared applicability interval. Independent sources require two distinct
support groups. `direct_statement` instead requires a literal excerpt of an
explicitly attributed user statement.

The package returns the cited excerpts, origin versions, explicit conflicts and
an optional `candidate`. A conflict candidate is quarantined. An insufficient
package has no candidate. An operator may review and add `author_client` and
`author_session` to a candidate for normal propose and commit. The service
rechecks every source, span, scope, applicability and revision. Split a
candidate when the source limits are exceeded. Inferred claims retain
`model_inference` and `unverified`. Source independence is a provenance check,
so the caller still reviews whether the text supports the proposed claim.
