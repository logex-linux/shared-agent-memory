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
These are frozen inputs. Execution and scoring of the new trajectories and
the A/B/C/D/E comparisons are pending.

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
