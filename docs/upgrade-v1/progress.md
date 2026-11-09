# Shared Agent Memory v1 · Implementation progress

Local development branch `sam/v1` from `fd79df2df2f898aa373b6b521eb362615eec47c7`.
Source, installed runtime and canonical database started at v0.4.8, v0.4.8 and
Schema 5 respectively. The source checkout uses Node 24.18.0 and the committed
lockfile. Production inspection uses SQLite read-only access and existing MCP.

| Stage | Status | Evidence |
| --- | --- | --- |
| P0 baseline | Passed | Build, 98 tests, frozen 120 and 60 query sets, 6 sanitized audit queries and 53 private replays |
| P1 versions and events | Passed | Schema 6, versioned archive, 101 tests, 607 identical frozen pages and 53 identical private replays |
| P2 explicit state and relations | In progress | State metadata and atomic transition contracts next |
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

P1 results are in `.local/upgrade-v1/p1/`. `tests-final.log` records 101 tests.
`compatibility.json` matches all 607 pages over the three frozen corpora with
zero full-body reads on ordinary queries. `private-replay/report.json` matches
all 53 available pages. `wire-smoke.log` confirms real-BGE CLI archive restore,
STDIO revision expansion and v0.4.8 refusal of both the new archive and Schema 6.

P2 will add separate decision and lifecycle metadata with effective-time
filtering, scoped revision-bound relations and atomic transition plans.
The fixture and original baselines remain frozen for all later comparisons.
