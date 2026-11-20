# Shared Agent Memory v1 · Implementation progress

Local development branch `sam/v1` from `fd79df2df2f898aa373b6b521eb362615eec47c7`.
Source, installed runtime and canonical database started at v0.4.8, v0.4.8 and
Schema 5 respectively. The source checkout uses Node 24.18.0 and the committed
lockfile. Production inspection uses SQLite read-only access and existing MCP.

| Stage | Status | Evidence |
| --- | --- | --- |
| P0 baseline | Passed | Build, 98 tests, frozen 120 and 60 query sets, 6 sanitized audit queries and 53 private replays |
| P1 versions and events | Passed | Schema 6, versioned archive, 101 tests, 607 identical frozen pages and 53 identical private replays |
| P2 explicit state and relations | Passed | Schema 7, 107 tests, atomic predecessor updates, scoped relation revisions, 607 matching frozen pages and 53 matching private replays |
| P3 bounded graph recall | Implemented, experimental | Schema 8, 111 tests, 607 matching frozen pages, 53 matching private pages, no gain on frozen cross-event subset |
| P4 feedback, consolidation and forget | Implemented and tested | Schema 10, receipt-bound learning and projection, bounded learned expansion, consolidation preview and historical erasure. 119 tests and 607 matching compatibility pages. |
| P5 evaluation and recovery | Local preview verified | Schema 11, 120 tests, 160 trajectories, 36 independent STDIO cells and switch rehearsal. Graph and learned ranking remain opt-in. |

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
registry or record changes. Local source and launcher details are in
`.local/upgrade-v1/p0/scope-audit.json`. Live process enumeration was unavailable
in the managed sandbox.

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

P2 results are in `.local/upgrade-v1/p2/`. The final build and all 107 tests
passed with the configured local BGE for the existing integration suite.
`state-tests.log` has the deterministic mock gates for effective time, decision
state, cross-environment coexistence, scope, CAS, rollback and dependency
invalidation. `compatibility.json` matches all 607 old pages with zero ordinary
body reads. `private-replay/report.json` matches all 53 available pages.

P3 results are in `.local/upgrade-v1/p3/`. The four graph tests cover eligible
two-hop explanations, hidden bridges, stale and corrupt edges, concurrent replay
and shared work budgets. The full suite covers Schema 5 migration through Schema
8. `compatibility.json` matches 607 frozen pages, and `private-replay/report.json`
matches 53 private pages. The real-BGE B/C cross-event comparison reached the
Recall@5 ceiling in both arms. Keep graph disabled by default.

P4 feedback ingestion records only authorized, current ID/revision pairs from
opaque page receipts. It queues events and supports a bounded projection batch
and replay. Observations do not change association weights. The first P4 tests
cover permission and expiry, canonical write isolation on recall, concurrent
retry and SIGKILL rollback of projection. Result files are under
`.local/upgrade-v1/p4/`. `npm run build` and all 114 tests passed. The three
frozen corpora rerun with `BENCH_LABEL=v1-p4-feedback` matched all 607 pages
with zero full-body reads under the old permissions and graph-off requests.
See `feedback-full-suite.log` and `feedback-compatibility.json`.

P4 closes with `final-build.log`, `final-tests.log` and `compatibility.json`
under `.local/upgrade-v1/p4/`. The 119-test suite checks same-origin retellings,
conflicts, direct statements, a parent update during encoding, and source
scope. It also checks weight decay, projection epoch and historical erasure.
The erasure rehearsal applied the latest ledger to a pre-forget backup. A
derived record with a changed latest source list and an exact reimport were
removed along with the root. The unrelated association neighbor survived.
The compatibility rerun again matched 607 pages with zero full-body reads.

P5 completed the 160-task A/B/C/D/E comparison. A passed 72/96 held-out
checks. B/C/D/E each passed 96/96. Explicit time and decision filters account
for the difference. Graph had no gain on the labeled cross-event tasks and
exceeded the latency target in some cells. Graph and learned ranking remain
opt-in. The graph-off p95 gate was met using the primary matrix and the
predefined-order rechecks documented in [evaluation](evaluation.md).

The final build, 120 tests, 607 frozen pages and 53 available private replay
pages passed. The migration rehearsal used a SQLite backup of 368 live
records, an external ledger with six entries, fault injection and six isolated
client launch templates. See [migration and recovery](migration-and-rollback.md).
The checked-out preview is `1.0.0-beta.1`. The installed runtime remains
v0.4.8 on Schema 5. This branch has no live rollout or remote push.

## Beta.6 support calibration

Beta.6 keeps Schema 14 and changes ordinary focused labels only. `support.level`
is now `direct`, `partial` or `missing`, with `support.basis` and subject,
entity and relation coverage. Only `direct` yields `evidence_strength=supported`.
Person numbers, shared public paths and a lone exact identifier remain recall
clues. Cross-end link questions require both endpoints and relation wording;
vendor or model questions require the named product and required object.

The frozen sanitized regressions are in
`bench/upgrade-v1/support-regressions.json`: S03/S04, S11, S13, S15 and S18.
Each case records the query-visible subject, relation, expected level and a
disjoint family. `tests/support-calibration.test.mjs` replays the before/after
pages. The paired runner now excludes development rows from pilot aggregates
and reports each split separately.

The beta.6 build and all 159 tests pass with Node 24.18.0. The installed runtime
was activated as `1.0.0-beta.6` on Schema 14 from the working tree on
2026-11-19. Because the source checkout was not committed, the installation
manifest records `commit: null`; the activation report keeps the source HEAD,
dirty status and the pre-swap artifact hash. The canonical database was backed
up before the swap and was not modified by activation.

## Beta.7 stable-release blockers

Beta.7 keeps Schema 14 and addresses the three blockers in the 2026-11-20
review. Ordinary focused support now extracts object qualifiers (north/south
warehouse, east/west library, web/desktop edition, first/reprint edition,
weekday, team/personal plan) and answer types (location, quantity, time,
boolean). The `direct` label is re-issued on the delivered excerpt, so a
qualifier or answer sentence cut by the window or budget cannot remain direct.

The six frozen counterexamples are in
`bench/upgrade-v1/stable-regressions.json`. With real local BGE, beta.6 marked
all 6 adjacent objects as supported before and after the correct record was
added. Beta.7 marked 0/6 before, kept 6/6 correct records in the top five, and
kept 0/6 wrong objects supported after. Results are in
`bench/upgrade-v1/stable-regressions-evidence.json`.

Cursors now use `am5`; `am4` returns `CURSOR_STALE` with a restart hint. On the
same generation-583 copy, beta.6's S15 first page produced an `am4` cursor;
beta.7 rejected it as stale, a fresh beta.7 page continued to the same
`019f08d1` revision with `weak / partial`, and beta.6 rejected the `am5`
cursor as `CURSOR_INVALID`. See `bench/upgrade-v1/cursor-cross-evidence.json`.

Two independent warm pairs (120 calls per runtime, 12 frozen queries) measured
beta.6/beta.7 median p95 of 23.736/23.753 ms, ratio 1.0007, with zero ordinary
full-body reads. See `bench/upgrade-v1/stable-warm-evidence.json`.

The CI CPU job now sets `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` for `npm ci`, so
`onnxruntime-node` does not try the unpublished Linux GPU archive. The local
suite has 165 tests. The clean Ubuntu run
[44747471987](https://github.com/logex-linux/shared-agent-memory/actions/runs/44747471987)
passed `npm ci`, model download, all 165 tests, the adaptive benchmark and the
installer/CLI check on commit `b69e3a6`.

Beta.7 was activated as `1.0.0-beta.7` on Schema 14 with commit
`b69e3a65ca4abe8f7663025db0799b20801e1eaa`. The canonical database was backed
up before the swap and remained at generation 583 with 460 records. The
beta.7 candidate, beta.6 rollback runtime, evidence and CI report are under
`~/.agents/backups/shared-agent-memory/beta7-stable-20261120/`.
