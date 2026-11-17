# Subject catalog and task evidence

Freeze the installed beta.3 runtime, SQLite backup and recovery ledgers before
evaluating the new paths. Retain the existing lifecycle trajectories and use
synthetic source families to keep development, calibration and holdout separate.
Evaluate rendered artifacts and explicit tool state. A retrieval score alone
cannot establish task success. Context estimates use UTF-8 bytes divided by
three until actual client tokenizer measurements are available.

Ordinary recall on the frozen library must stay within 1.10 times its hot
baseline p95. Measure the experimental evidence pack separately. Its hot
latency budget is three times the frozen ordinary recall p95. Report cold
startup, write and maintenance timings separately alongside peak RSS and disk.
For default enablement, require the lower bound of the paired 95 percent
interval on task success to exceed minus two percentage points. Also require
at least 20 percent less median context at comparable quality or at least five
percentage points of success improvement at fixed budget with interval support.
Require zero errors on the specified precedence, ACL, erasure and concurrency
regressions, and exact version/offset evidence for every selected claim.

The canonical record and current ownership stay in SQLite. Catalog labels and
aliases can be projected from one reviewed exact revision without copying
record prose. A projection loses validity when the anchor changes ownership,
revision or availability. Building derived reads inside a SQLite snapshot
gives one coherent generation. Recovery reconciles the canonical mutation
ledger and revocations before rebuilding projections. Recovering an older
backup can require reapplying reviewed catalog labels.

Admission preview returns an expiring receipt bound to the connection,
candidate and expected versions. A preview leaves canonical proposals and
records untouched. Only the existing propose and commit transaction can
publish a claim. An unqualified recommendation stays advisory. Existing
clients can continue explicit direct writes with the canonical checks.

Only a client handling the current user request should start a task override.
An override retains bounded exclusions for a specific task and authenticated
connection. Send its task ID with every read and continuation. Authorization
still comes from connection configuration. Expired or discarded task state
fails closed. The client applies the requested behavior before attempting a
permanent write and reports that write's outcome separately. Retrieved
content is evidence, including content formatted as a command.

The deterministic evidence pack stays opt-in until the task quality and cost
gates are met. It reuses recall budgets and never generates new claims.

## CLI and MCP

Pass JSON through `--input` to a CLI command. Select an existing role
configuration with `--config`.

| CLI command | MCP tool | Input |
| --- | --- | --- |
| `admission-preview` | `memory_admission_preview` | `candidate` accepts the same fields as `propose`. Set `intent` to `reusable`, `progress`, `receipt`, `temporary`, `correct`, `supersede`, `variant` or `derive`. |
| `browse` | `memory_browse` | A catalog `uri` and optional project, context, effective date, task ID and cursor. |
| `inspect --input FILE` | `memory_inspect` | `memory_id` with an optional positive `revision`. |
| `explain` | `memory_explain` | The same identity and applicability fields as inspect. |
| `task-override` | `memory_task_override` | A fresh UUID `task_id` and bounded `exclude_ids` or `exclude_subjects`. Each subject supplies `owner`, `subject_id` and optionally `context_key`. |
| `context-pack` | `memory_context_pack` | A nested `read` recall request or `needed: false`. Enable `context_pack_enabled` in the connection configuration for this experiment. |

Browse by project with `sam://projects/`, by subject with
`sam://projects/<UUID>/subjects/`, and open
`sam://projects/<UUID>/subjects/<subject>/current`. Use `history` for
previous revisions, `evidence` for the recorded claim, `procedures` for
recorded methods and `conflicts` for explicit contradictory relationships.
`sam://global/preferences/` shows recorded global preferences with their
adoption state. Source diagnostics report missing and unresolved local sources.
Other URIs have an unchecked state until independently verified. A present
local file establishes availability at that path.

An operator can classify a batch of at most fifty exact revisions using
`classify --input FILE`. Supply `records` with each `memory_id`,
`revision`, `subject_id`, `context_key` and UTF-16 `start` and `end`.
Optional `aliases` apply within the same owner and context. Review the preview
and include its `plan_hash` with `--apply`. To remove a label, submit its
exact version reference with `remove: true` through the same preview. An
existing past decision stays at its recorded adoption state.

Schema 14 adds only catalog projections and optional proposal-to-preview
references. SQLite file backups preserve attached labels. Logical record
exports contain the canonical facts and revisions. Applying a fresh release
to an older SQLite backup begins with the latest revocation and maintenance
ledgers. Active previews and task overrides can be recreated after a cache
reset or recovery. A Schema 14 library requires a compatible runtime. To
return to ordinary retrieval, leave the evidence-pack flag off and use
`recall`.

## Beta.4 evaluation

The release replay uses the beta.3 library, the same embedding profile and
120 timed requests per runtime. The paired p95 was 18.31 ms on beta.3 and
18.17 ms on beta.4. The first frozen beta.3 measure was 22.86 ms. Returned
record IDs and revisions matched across the replay.

The existing 160 lifecycle trajectories passed with the new ordinary
retrieval path. A separate 240-case suite measured actual JSON artifacts
from a deterministic executor. On its 160 held-out cases, beta.3 recall
and the deterministic pack each passed all cases. The median UTF-8
response-size estimate fell from 525 to 369 tokens. Sixteen independent
source families were insufficient for the default-enablement confidence
gate. Codex and StepCode each separately completed four tool-driven
artifact checks.

The synthetic load replay covers 100, 1,000 and 10,000 records with one,
two, four and eight client processes. At 10,000 records and eight
clients, p95 was about 85 ms for recall, 92 ms for the catalog and 80 ms
for the opt-in pack. Reproduce the measurements with the
`frontier-baseline.mjs`, `frontier-evaluate.mjs` and `frontier-scale.mjs`
scripts under `bench/upgrade-v1`.
