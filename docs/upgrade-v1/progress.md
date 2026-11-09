# Shared Agent Memory v1 · Implementation progress

Local development branch `sam/v1` from `fd79df2df2f898aa373b6b521eb362615eec47c7`.
Source, installed runtime and canonical database started at v0.4.8, v0.4.8 and
Schema 5 respectively. The source checkout uses Node 24.18.0 and the committed
lockfile. Production inspection uses SQLite read-only access and existing MCP.

| Stage | Status | Evidence |
| --- | --- | --- |
| P0 baseline | Passed | Build, 98 tests, frozen 120 and 60 query sets, 6 sanitized audit queries and 53 private replays |
| P1 versions and events | In progress | ADR and baseline risk reproduction |
| P2 explicit state and relations | Pending | P1 migration, restore and permission gates |
| P3 bounded graph recall | Pending | P2 endpoints and graph-off comparison |
| P4 feedback, consolidation and forget | Pending | P3 and receipt authorization |
| P5 evaluation and recovery | Pending | All stage gates and release evaluation |

P0 artifacts are under `.local/upgrade-v1/p0/`. `build.log` and `tests.log`
contain the fresh Node 24.18.0 runs. `model-profile.json` identifies the validated
FP32 profile. `private-replay/report.json` records 53 response matches, excluding
eight queries with unavailable intermediate revisions. Replay used frozen local
copies and test configurations with recall permission only.

The registered memory project ID was verified against the canonical registry.
Its aliases do not include this source checkout. Two records with unrelated
subject matter are filed under that project. Both have source evidence and
commit receipts from the StepCode writer. The scope and writer identity agree
with the receipts. This establishes the recorded attribution. The intended
destination and reason for the selection remain unresolved. The audit makes no
registry or record changes.

The isolated synthetic baseline probe reproduced loss of revision 1 after
update, a draft quotation interpreted as implemented, and a prior revision
passing import preview after its ID changed. The same probe verified environment
filtering, parent-update invalidation, and zero canonical event writes on repeated
recall. Feedback is unavailable at baseline. See `baseline-risks.json`.

Next P1 gate covers byte-preserving migration, history reads with budget and
permission checks, and recovery under interruption. The fixture and original
baselines remain frozen for all later comparisons.
