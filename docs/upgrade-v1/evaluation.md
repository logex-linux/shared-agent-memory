# Shared Agent Memory v1 · Evaluation

The P0 baseline uses Node 24.18.0, SQLite and sqlite-vec 0.1.9, FP32 local BGE
with two threads. Profile ID is
`490f804e2e6e312f30a64cafc2e4afa94ba85df58d89f341f9080c15e738c293`.
The lockfile SHA-256 is
`45be7d665e06419db8b2ab55370632b496bf01ef61001e6d9d232c7d9785a55f`.

Run `npm run build` and `npm test` with `TMPDIR` set to an isolated writable
directory. Copy the built v0.4.8 runtime before making source changes. The
isolated baseline used `.local/upgrade-v1/p0/baseline/dist`.

```sh
BENCH_LABEL=v048-p0 BENCH_FIXTURE=bench/adaptive/fixtures.mjs node scripts/benchmark-adaptive.mjs measure .local/upgrade-v1/p0/adaptive .local/upgrade-v1/p0/baseline/dist
BENCH_LABEL=v048-p0 BENCH_FIXTURE=bench/quality/fixtures.mjs node scripts/benchmark-adaptive.mjs measure .local/upgrade-v1/p0/specialist .local/upgrade-v1/p0/baseline/dist
BENCH_LABEL=v048-p0 BENCH_FIXTURE=bench/concurrency/replay-fixtures.mjs node scripts/benchmark-adaptive.mjs measure .local/upgrade-v1/p0/call-audit .local/upgrade-v1/p0/baseline/dist
node bench/upgrade-v1/baseline-risks.mjs .local/upgrade-v1/p0/baseline/dist
```

Each benchmark folder contains a copy of the corresponding frozen `corpus.db`
and `manifest.json`. The source folders are `.local/v041/eval`,
`.local/v041/specialist` and `.local/v047/audit`. Each measurement creates a
disposable working database in the benchmark folder. Results are in
`v048-p0.json`. The risk probe uses a deterministic mock and its own temp DB.

| Corpus | Queries | Focused P@1 | Broad cumulative Recall | Full bodies per page |
| --- | ---: | ---: | ---: | ---: |
| Adaptive | 120 | 0.7167 | 0.9778 | 0 |
| Specialist | 60 | 0.8000 | 1.0000 | 0 |
| Sanitized call audit | 6 | 0.7500 | 1.0000 | 0 |

Frozen corpus SHA-256 values in table order are
`654f331b87fb539e7c32ac2a3f2833685e4cdeec9ee939e9a3bd39128c313a8b`,
`3177bae1e54fb7627a9a9ea4faeb200395aa7437b906706a11369d012b430900`,
and `780d33e172ba6550dd7a01b1e419939d5b0ef3ceb96a1e429f6535aec6de361a`.
Specialist targets were 32/32. All 53 available private replay pages matched
their prior v0.4.8 response contents after stripping cursor IDs and timing.
Eight additional requests lacked complete historical revisions.

`bench/upgrade-v1/tasks.mjs` freezes 160 synthetic task trajectories with
expected answers and source revisions. Subject-family assignment gives 64
development tasks and 96 held-out tasks, with no family shared between splits.
The serialized task fingerprint is
`4b7aad4c1a72bbdbe6913ba2ad94a5d5f9e3cf17dfeb2a57bd43edbbbcdeec58`.
These are the frozen inputs for the trajectory comparison below.

Release gates remain those in the architecture plan. Safety regressions are
hard failures. Quality compares pairs at equal budget, with the original
source events available to every arm. Graph and learning remain opt-in until
the measured quality and performance criteria pass.

The P1 rerun uses the same corpus copies, fixtures and options. Replace the
baseline directory with the corresponding `.local/upgrade-v1/p1/<corpus>`
and run the current `dist` with `BENCH_LABEL=v1-p1`. Compare each
`samples[].pages[].response_hash` in the reports. All 607 pages matched
(380 adaptive, 217 specialist and 10 sanitized call-audit). Each had zero
ordinary full-body reads. The 53 private replay pages matched as well.
These are compatibility runs and do not establish latency ratios.

P2 repeats the three corpus commands with `BENCH_LABEL=v1-p2` and the corpus
copies under `.local/upgrade-v1/p2/`. All 607 pages and 53 private pages
matched the v0.4.8 baseline. Ordinary body reads stayed at zero. The 107-test
suite passed, including the new deterministic mock state and transition gates.
A multi-target CAS test changes one target while successor encoding is paused.
A separate checkpoint injects an error after updating predecessors inside the
transaction. Both leave the successor and relation rows uncommitted.

P3 repeats the graph-off compatibility runs with `BENCH_LABEL=v1-p3`.
All 607 frozen pages and 53 available private pages matched v0.4.8, with zero
ordinary full-body reads. `node --test tests/graph.test.mjs` runs the four mock
tests for sourced two-hop paths, graph-off and exact isolation, invalid edges,
profile and epoch invalidation, and bounded cross-process continuation.

Run `node bench/upgrade-v1/graph-ablation.mjs .local/upgrade-v1/p3` after building.
This B/C comparison uses one database of 80 source events for the 20 frozen
cross-event tasks, identical budgets and real FP32 BGE. The runner checks source
and revision matches, simulator exclusions and zero ordinary full-body reads.
The 12 held-out tasks reached 100% Recall@5 in both arms. The paired change was
0 points with a bootstrap interval of [0, 0] on that sample. Both arms returned
the answer excerpts for all 20 tasks. Graph inspected 80 edges per round and
admitted no additional paths on these queries. The baseline already retrieved
every labeled item. These data cannot establish a +10 point gain.

| Round | B warm p95 | C warm p95 |
| --- | ---: | ---: |
| 1 | 12.57 ms | 13.50 ms |
| 2 | 12.36 ms | 12.43 ms |
| 3 | 12.28 ms | 13.17 ms |

P3 leaves graph opt-in. The above is a single-process slice, with report under
`.local/upgrade-v1/p3/graph-ablation-tJehGF/`. P5 still needs the full trajectory
and multi-client scale matrix, including the A/B latency gate.

## P5 trajectory evaluation

```sh
node bench/upgrade-v1/trajectories.mjs .local/upgrade-v1/p5 .local/upgrade-v1/p0/baseline/dist
```

All five arms used the same original evidence and response budget. The
normalized current raw-evidence signature for A and B is
`f94e6e8d9c7130260ad41ed42b7c3777f289bffd7e95099f7924063f74ff6ecd`.
C adds explicit graph paths. D and E receive the same eight development-only
feedback events. E also derives 20 candidates from the raw reproduction
texts. A fixed deterministic answer model extracts spans from the returned
excerpts before scoring. Scoring compares the generated values against the
frozen labels and checks exact source and revision coverage and exclusions.
No external service is part of this measurement.

| Held-out metric | A | B | C | D | E |
| --- | ---: | ---: | ---: | ---: | ---: |
| All trajectory checks | 72/96 | 96/96 | 96/96 | 96/96 | 96/96 |
| Effective-time checks | 0/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Adopted-state absence checks | 0/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Excluded source versions returned | 36 | 0 | 0 | 0 | 0 |
| Cross-event Recall@5 | 100% | 100% | 100% | 100% | 100% |

A could find all required historical excerpts but also returned records from
outside the asserted interval. It returned proposed or rejected evidence
in the adopted-state absence cases. The same raw events were available to A.
Its protocol could not apply the explicit time and decision filters. This
evaluation does not establish a graph, learning or consolidation quality
gain on these saturated labels. Report data are in
`.local/upgrade-v1/p5/trajectories-urXSy8/report.json`.

## P5 phase diagnosis

```sh
node bench/upgrade-v1/phase-probe.mjs .local/upgrade-v1/p5 .local/scale-benchmark/10000.db .local/upgrade-v1/p0/baseline/dist
node bench/upgrade-v1/scale-matrix.mjs .local/upgrade-v1/p5 .local/scale-benchmark .local/upgrade-v1/p0/baseline/dist
```

The initial Schema 10 scale run completed 36 cells. The graph-off median
warm p95 ratio ranged from 1.67 to 2.03 across the four 10,000-record cells.
The shared-encoder phase probe measured a 51.05 ms baseline p50 and a
105.83 ms Schema 10 p50. Index validation rose from 14.67 to 35.28 ms at p50,
KNN from 14.34 to 24.31 ms and FTS/identifier stages from 8.36 to 18.70 ms.
Repeated JSON extraction in the temporal filter affected every eligible
scan. It did not require changes to sidecar lock ownership.

Schema 11 rebuilds only the derived search table. SQLite stores lifecycle,
effective time boundaries and decision state on each search row. A partial
index identifies whether there are temporal exceptions in the same read
snapshot. A subsequent single-process phase run measured 50.03 ms baseline
p50 and 54.74 ms with the stored fields, before adding the exception fast
path. Stage and matrix reports are under `.local/upgrade-v1/p5/`.

The final phase probe measured baseline/new p50 of 49.34/50.07 ms and p95 of
70.79/61.60 ms. It used the 10,000-record fixture, one process and a shared
warm encoder, alternating A/B order. The independent STDIO matrix below is
the concurrency measurement.

## P5 independent STDIO matrix

The matrix uses local FP32 BGE with two threads per process. It measures
three warm rounds per cell with the same prompts and budgets. A and B use
ordinary retrieval. C adds a synthetic ring of explicit edges to exercise
graph traversal. The three original fixture SHA-256 values are
`3bb445e13a3930c577befbeb916f1f3c022e3180d63ccf1764b6387a872e26bd`,
`93a18c68cb2f64dad5b372f00c8c092da9d0306542a4f22c013a0322763ae3db` and
`6fc1199ccf956ba5b9ecff0a99ca7c8d3269240aea6987b5926d5359f35aa15a`.

| Records | Clients | A warm p95 | B warm p95 | C warm p95 | B/A | C/B |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 12.39 ms | 12.01 ms | 12.11 ms | 0.97 | 1.01 |
| 100 | 2 | 15.89 ms | 18.18 ms | 22.16 ms | 1.14 | 1.22 |
| 100 | 4 | 43.24 ms | 41.56 ms | 43.51 ms | 0.96 | 1.05 |
| 100 | 8 | 94.82 ms | 106.89 ms | 100.47 ms | 1.13 | 0.94 |
| 1,000 | 1 | 14.59 ms | 14.54 ms | 15.46 ms | 1.00 | 1.06 |
| 1,000 | 2 | 26.15 ms | 25.77 ms | 26.46 ms | 0.99 | 1.03 |
| 1,000 | 4 | 50.71 ms | 47.99 ms | 62.91 ms | 0.95 | 1.31 |
| 1,000 | 8 | 158.18 ms | 131.00 ms | 132.29 ms | 0.83 | 1.01 |
| 10,000 | 1 | 60.08 ms | 59.33 ms | 61.59 ms | 0.99 | 1.04 |
| 10,000 | 2 | 104.24 ms | 103.11 ms | 104.96 ms | 0.99 | 1.02 |
| 10,000 | 4 | 235.40 ms | 223.23 ms | 204.18 ms | 0.95 | 0.91 |
| 10,000 | 8 | 466.41 ms | 463.90 ms | 458.28 ms | 0.99 | 0.99 |

Values are medians of three round p95s. The two B/A misses at size 100
were repeated with the same requests and each of the three arm orders
(`SAM_MATRIX_ORDER`). All six additional cell comparisons met the 1.10
limit. Pooling the original and repeat round p95s gives B/A of 0.81 and 0.91
for two and eight clients respectively. Individual cells remain subject
to scheduling noise. C exceeded 1.25 on some original and repeat cells.
Together with the absence of a graph recall gain, this keeps graph and
learned ranking opt-in.

The primary matrix completed 5,166 calls, including 4,860 warm calls,
with zero full-body reads, failures or retries. All 135 same-cursor
responses agreed with the relevant page. Each of 12 C projection probes
processed one event in 0.21–0.59 ms, rejected the old graph cursor and
served a fresh query. The probes ran after timing the clients.

At 10,000 records and eight B clients, cold launch and first recall took
1.89 s. Warm p95 lock wait and hold were 366.95 ms and 42.65 ms, close to A's
366.45 ms and 42.72 ms. Sampled concurrent RSS was 2.50 GiB for B and
2.24 GiB for A. RSS counts shared pages in each process. It is not physical
memory attributable exclusively to the processes. Temporary file growth
was 14.98 MiB for B and 14.91 MiB for A. Per-process observations, file
sizes, stage timing and per-round data are in the report. The patch fixes
the extra JSON work. It does not reduce the underlying serialized sidecar
wait in a heavily contended workload.

Raw measurements are in `.local/upgrade-v1/p5/scale-matrix-ldCluw/report.json`.
`scale-summary.json`, `scale-rechecks.json` and `recheck/` keep the original
and repeated results. The final lockfile SHA-256 is
`75179cecdf5521d531f8df8e15842a919f49ac8871aecaa94bea5272ee1f57fb`.

The final v1 build and all 120 tests passed. The tests include scope,
forgetting, concurrent revision CAS and SIGKILL recovery. The graph-off
frozen suite matched 607 pages across 186 queries, and the 53 available
private replay pages matched. Ordinary recall transferred zero full bodies
in these runs. Results are under `.local/upgrade-v1/p5/` in
`beta-tests.log`, `compatibility.json` and `private-replay/report.json`.
