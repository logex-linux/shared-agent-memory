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

A recorded contradiction raises `RECORDED_CONFLICT` and sets the affected
items to `use: "conflict"`. The pack status becomes `requires_check`. When both
endpoints are included, `conflicts` identifies their exact revisions. When
only one endpoint is included, its flag carries the review requirement and
the other endpoint stays outside the response. Endpoints must satisfy the
effective time, current revision, connection scope and task exclusions.
The pack resolves these conditions inside the recall snapshot, including on
cursor continuation. A budget fallback marks the affected raw items
`applicability: "requires_check"`. A concurrent canonical change can return
`VIEW_STALE`, in which case start the read again.

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

## Beta.5 source review and evaluation

```sh
node scripts/source-preview.mjs DATABASE SOURCE_REVIEW.json
node bench/upgrade-v1/paired-agents.mjs FROZEN_BETA4_RUNTIME REPORT_DIRECTORY
```

The source preview opens the database read-only and inspects the exact
`memory_id`, `revision` and zero-based `source_index` listed in `targets`.
Register absolute directories in `roots`. The preview checks the original
path and searches those directories for files with the same basename. Supply
the exact heading or line as `anchor`. Numbered headings must agree with the
recorded section number. A `sha256:` or `sha256-file:` revision refers to the
whole file. A `sha256-fragment:` revision uses the specified `fragment` byte
range `[start,end)`. A full Git commit uses the requested `git_path` and compares
the working file to the committed blob. A directory source can list
`directory_files` using exact relative paths already named by its locator.
The report distinguishes availability, changed bytes, missing locators and
ambiguous candidates.

For a confirmed replacement, update the current head through the normal
proposal and revision checks. Keep the original revision, source fingerprint,
scope, adoption and verification status. Check any catalog projection
against the new revision. Reopen the exact source and review the heading
before accepting the change.

The paired runner compares no memory, beta.4 ordinary recall, beta.4 packs
and the current pack in fresh workspaces. The four arms share a snapshot
and page budget within each source family. The runner rotates their order.
Clients receive natural task prompts and write an artifact through a fixture
tool. The scorer checks the file after the tool runs and verifies each
returned span against the exact revision in SQLite.

The built-in set has 12 synthetic families for piloting the protocol.
`SAM_PAIRED_CASES` can point to a JSON array of authorized, de-identified
cases using the same scenario fields. Use `split: "holdout"` for pre-frozen
holdout families, with one row per independent family. The report groups
the two clients by family and records their model IDs, cursor calls, span
checks, result bytes, latency and available usage. Codex reports aggregate
turn usage. StepCode reports usage per assistant response. A missing token
counter stays empty. Pilot scores cannot authorize default enablement.

## Beta.6 support calibration

Beta.6 keeps Schema 14 and ordinary recall budgets. Focused pages add
`support.level` (`direct`, `partial`, `missing`) and `support.basis`, plus
subject, entity and relation coverage counts. Only `direct` yields
`evidence_strength=supported`; applicability or decision-state downgrades are
recorded as `unknown_time` or `decision_mismatch`. Person numbers, shared public
paths and a lone exact identifier are recall clues. Questions about a
cross-client link require both endpoints and relation wording; vendor or model
questions require the named product and required object. A page with no `direct` item and more candidates emits `DIRECT_EVIDENCE_MISSING`, so the client can try one continuation or expand a known ID before answering.

The sanitized frozen pairs are `bench/upgrade-v1/support-regressions.json`.
Each case keeps its family, split, query-visible subject/relation and expected
level. The paired runner now excludes development rows from pilot aggregates,
reports `development_runs`, `pilot_runs`, `holdout_runs` and `case_splits`, and
still requires a pre-frozen holdout for any default-enablement claim. A page
with only `partial`/`missing` support and more candidates emits
`DIRECT_EVIDENCE_MISSING`; the client may try one continuation or expand a
known ID. Roll back the runtime to beta.5 if a shadow or small-scope run
regresses; canonical SQLite facts and revisions need no rollback.

## Beta.7 stable-release blockers

Beta.7 keeps Schema 14. Focused support adds object qualifiers and answer
types, and re-issues `direct` on the delivered excerpt rather than the whole
chunk. A qualifier or answer sentence cut by the window or budget therefore
cannot remain direct. Person numbers and shared public paths remain clues.

Cursors use `am5`; `am4` returns `CURSOR_STALE` with a restart hint. The
support version is part of query authority, so old query state cannot silently
reuse beta.6 labels. Same-version continuation keeps the existing page
semantics. The canonical database and revision checks are unchanged.

The six frozen families and the real-BGE before/after results are in
`bench/upgrade-v1/stable-regressions.json` and
`stable-regressions-evidence.json`. The CI CPU job sets
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip`; Ubuntu run
[44747471987](https://github.com/logex-linux/shared-agent-memory/actions/runs/44747471987)
passed `npm ci`, model download, 165 tests, the adaptive benchmark and the
installer/CLI check on commit `b69e3a6`.
