# Lifecycle maintenance in 1.0.0-beta.3

Schema 13 advances the existing SQLite library in one transaction. It adds subject and context projections, a current rule constraint, proposal leases, explicit version body states and a metadata-only maintenance ledger. It preserves existing IDs, revision numbers, bodies, hashes and vector bytes during schema migration. Older builds refuse to open Schema 13.

## Current tasks and lasting changes

Apply the current user request when executing a task. A one-off exception can use `exclude_ids` with query, exact ID or exact version recall. The limit is 64 distinct input positions. A cursor keeps its first page's subject, context and exclusions. Reopen a query after a lifecycle or project change.

For lasting project writes, resolve the caller's working directory with `memory_resolve_project` and include that directory in `work_directory` on `memory_propose`. Operator-selected writers can enable `require_work_directory` for new project proposals. A missing project mapping calls for deferring the long-term write while the task proceeds. Use global scope for authorized cross-project material.

Use `decision_state: "adopted"`, a specific `subject_id` and a stable `context_key` for an adopted preference or policy. The constraint covers the same subject and context in the same scope and environment. Future rules remain proposed until adoption. Legacy records retain their original fields. Identical material and source identity trigger `DUPLICATE_RECORD`. An unchanged correction returns `NO_CHANGES`. Similarity hints support review.

Use `transition: "supersede"` with the predecessor IDs and revisions in `expected_refs`. Supply `target_id` and its revision to reuse an existing successor. The successor's `valid_time.valid_from` sets the transition boundary. Cross-commit evolution needs an explicit `version_evolution` with both code or test sources, the same stable context and compatible branch and environment. The caller can explicitly adopt that identity for previously unlabelled predecessors. The transaction closes predecessors, invalidates derivations, creates sourced relations and records the receipt.

## Project scope

Run `diagnose-projects` to inspect live, moved and missing aliases. `project` adds an alias. `project-aliases --input FILE` previews the replacement list, including an empty list to remove every alias. Supply the returned `plan_hash` and use `--apply` to apply. The most specific registered directory wins. Scope restrictions still apply to that match.

`reassign --input FILE` previews a group of `records` (ID and revision), a `destination` (`scope` and `project_id`), a `reason` and a request UUID. Review the dependencies, relations, pending proposals and managed exports. Supply `plan_hash` and `--apply` once the complete group is authorized. The transaction retains historical hashes and advances the current revision. Current ownership governs exact historical reads and receipt replays. Exact version output includes `recorded_ownership` when it differs. Managed exports affected by the move enter cleanup.

## Forget and retention

`memory_forget_preview` and CLI `forget --dry-run --input FILE` compute the same erasure closure as execution. Review the covered ID/revision pairs, dependent and copied versions, candidates, indexes and exports. Execute with the new request UUID plus the preview's `plan_hash`. Nested scopes require authority for the entire closure. Changed generation, scopes, or impact invalidate the plan. Retry the identical request to check cleanup after an interruption. `cleanup: "complete"` covers the canonical bodies, managed files, logical indexes and cache cleanup. Prior chat results and independently held copies have their own lifecycle.

`retention` lists candidate expiry, historical records, version bodies and reasons an item is protected. Supply a request file to preview `expire` with `proposal_ids`, `prune` with version references, or `retire` with a record and retention reason. Use the preview hash and `--apply` for the reviewed action. Owners can renew active proposals through `memory_renew_proposal`. A commit after expiry returns `PROPOSAL_EXPIRED`.

Defaults are 7 days for proposals, 90 days for history and recovery, and 5 retained recent revisions. The operator can set these in `retention`. Apply is explicit. Pruning keeps revision and revocation metadata and returns `VERSION_PRUNED` with the affected references on exact reads. Referenced evidence, the head, recent revisions and the recovery window are protected. Retirement records an ID and reason, so another memory sharing a source remains usable. Formal forget continues to revoke the underlying identities and propagates through historical dependencies.

## Installation, archives and recovery

`installation.json` records the source, runtime, data, maintenance state, Node, commit, schema, model profile and artifact digest. Install and generate client templates from that manifest. Run `diagnose --manifest FILE` and `check` with the operator profile. Configure Codex and StepCode to use the same installed runtime and data path. Select the `project-forget` template when that connection has authorization to forget within the project.

`node scripts/upgrade-local.mjs --manifest FILE --output NEW_DIRECTORY` prepares a consistent database backup and a versioned runtime. Preserve the latest `maintenance.json` and `revocations.jsonl` independently of database backups. Existing deployments can set the absolute `maintenance_state` directory on every role. A runtime configured with that directory rejects a database that lacks required maintenance or revocations.

Versioned exports use `shared-agent-memory/versions-v2`, including explicit pruned revisions. The new importer also reads v1. For a committed logical import, pass `--revocations FILE --maintenance FILE` from the active deployment's current managed state. A logical archive carries history, while a SQLite backup carries the full transaction state.

`restore-backup --source FILE --output NEW_DIRECTORY --config ADMIN_CONFIG --revocations FILE --maintenance FILE` restores into a new isolated directory. It applies maintenance and revocations before admitting reads. The ledger carries hashes and the metadata needed for replay. A backup lacking bytes for a later authorized write requires reconciliation with a newer compatible backup or archive. Compare IDs, revisions, scopes, hashes and published changes before activating the staged copy. Run a compatible runtime for Schema 13 and retain writes made after an upgrade.
