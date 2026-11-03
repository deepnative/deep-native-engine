# Gate and deploy timings

This page records how long each stage of the local gate and the Azure deploy takes, and which stages are worth optimizing. It was measured on 3 November 2026 for [#630](https://github.com/deepnative/deep-native-engine/issues/630). It follows the [local verification playbook](LOCAL-VERIFICATION-PLAYBOOK.md) and the [deployment performance review](AZURE-DEMO-DEPLOYMENT.md#performance-review-after-every-deployment). It grants no new authority: every option below is a proposal, and anything that removes coverage is an owner decision.

## Recording timings after every run

`make verify` now prints a per-stage table when it ends, whether it passed or failed. It also appends one JSON line to `dne-timings.jsonl` in the Git common directory, so all worktrees share one history. The file is outside `artifacts/`, so receipts and artifact hashes are unchanged.

```sh
python3 scripts/pipeline_timings.py gate                          # table for this checkout's artifacts/
python3 scripts/pipeline_timings.py gate path/to/artifacts        # another run's artifacts
python3 scripts/pipeline_timings.py deploy 41674463237 --record   # deploy steps via gh, saved to history
python3 scripts/pipeline_timings.py history 20                    # last 20 recorded gate/deploy runs
```

The timestamps come from receipts the gate already wrote, plus these additions:

| Receipt | Timing data |
| --- | --- |
| `artifacts/repository-verification.json` | `stage_timings`: repository assets, repository tests, application verification, local learning, artifact scan (**new**) |
| `artifacts/application-verification.json` | each command's `start` (existing) and `finished` (**new**) |
| `artifacts/integration-shards.json` | each lane's `started`/`finished` (existing) |
| `artifacts/browser-shards.json` | each shard's `index`/`started`/`finished` and the report merge (**new**) |
| `gh run view <id> --json jobs` | queue time and every deploy step |

Reports written before this change have no command finish times. For those, the tool measures each command from its start to the next command's start and marks the figure with `~`.

## Measured: full gate on 41f9c3e (passed)

The run was `make verify` with `DNE_TEST_GROUPS=auto` (8 groups), from 16:48:37 to 17:12:27 UTC: **23m50s**. It ran natively on an Apple M5 Max (18 CPUs, 128 GiB) under macOS, with Node 26.12.1 against `.nvmrc` 24.21.0. Results: 5,293 unit tests, 2,754 PostgreSQL assertions, 562 primary browser executions and 281/281 journeys, with no retries or skips. The earlier 5096af4 run failed in browser tests after about 20 minutes, and its artifacts were overwritten before they could be measured. That change's lead time was therefore roughly 44 minutes of gate time.

| Stage | Wall time | Share |
| --- | ---: | ---: |
| PostgreSQL integration (`npm run test:integration`) | ~8m14s | 35% |
| Primary browser shards (`npm run test:e2e`) | ~7m02s | 30% |
| Repository assets + 90 repository tests | 2m07s | 9% |
| Local learning, artifact scan, receipt (after the application stage) | 2m15s | 9% |
| Provisional browser journeys | ~1m16s | 5% |
| Unit tests + coverage evidence | ~0m56s | 4% |
| Gate probes (+ coverage assertion before them) | ~0m56s | 4% |
| Cross-browser keyboard journey | ~0m41s | 3% |
| Format, lint, typecheck, build, audit | ~0m21s | 1% |
| **Total** | **23m50s** | |

The two parallel stages make up 65% of the run, and both are limited by one slow group rather than by total work:

| Parallel stage | Fastest group | Slowest group | Mean of 8 | Total work |
| --- | ---: | ---: | ---: | ---: |
| Integration lanes | 2m47s (lane 7) | **8m09s (lane 4)** | 4m44s | 37m51s |
| Browser shards | 2m46s (shard 1) | **7m00s (shard 2)** | ~4m48s | 38m24s of test time |

The largest single units set a lower bound: `attempt-lifetime.test.ts` takes 239s and `owner-preview.test.ts` 159s in integration. `event-attendance.spec.ts` takes 311s across both browser projects, about 155s per project. Each browser shard runs one Playwright worker with `fullyParallel: false`, so the files in a shard run one after another.

Compared with the 1 November baseline (18m30s, Linux VM, 12 CPU/64 GiB): integration grew from 7m17s to 8m14s and browser from 5m43s to 7m02s. The inventory also grew (2,695 → 2,754 assertions, 530 → 562 executions), and the machine and Node version differ, so the two runs are not like-for-like.

## Measured: Azure deploy runs

| Run | Revision | Total | Queue | Build + push | Roll | Readiness wait |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [41674463237](https://github.com/deepnative/deep-native-engine/actions/runs/41674463237) | d70e5b1 | 2m54s | 6s | 1m20s | 3s | 1m02s |
| [41574885561](https://github.com/deepnative/deep-native-engine/actions/runs/41574885561) | 534b79b | 2m31s | 4s | 1m12s | 3s | 58s |
| [41570005800](https://github.com/deepnative/deep-native-engine/actions/runs/41570005800) | 98af6d3 | 2m37s | 5s | 1m17s | 3s | 1m00s |
| [41541758698](https://github.com/deepnative/deep-native-engine/actions/runs/41541758698) | aebba1c | 2m33s | 5s | 1m20s | 3s | 43s |
| [41529359009](https://github.com/deepnative/deep-native-engine/actions/runs/41529359009) | 8057b78 | 2m21s | 5s | 1m12s | 4s | 43s |

The remaining steps (setup, checkout, OIDC sign-in, preflight) take about 12s in total. In run 41674463237, the app image's build-stage `npm ci` (all dev dependencies, used only to run `tsc`) took **49.4s of the 80s** build step. `tsc` took 8.3s, the proxy image about 2s and both pushes about 11s. Every run builds from scratch because there is no layer cache. The readiness loop makes three `az containerapp show` calls per round, then sleeps 15s, so a revision that is ready is noticed up to about 20s late.

## Optimization options, ranked by expected saving

Savings are estimates from the measured run above. Re-measure with the timing tool after each change.

| # | Option | Expected saving | Coverage impact | Effort / risk |
| --- | --- | ---: | --- | --- |
| 1 | **Balance integration lanes by measured file duration.** Assign files greedily, longest first, using the previous run's `integration-results.json`, and fall back to Vitest's `--shard` when there is no history. Keep one database per lane and the complete-inventory union check. | **~3m** (8m14s → ~5m, limited by the 239s file) | None: same files, same lanes | Medium; touches `integration-runner.mjs` |
| 2 | **Balance browser shards by measured file × project duration**, passing explicit file lists per shard instead of `--shard`. Keep each file's ordered tests together. | **~2m** (7m02s → ~5m) | None | Medium; touches `browser-runner.mjs`; the blob merge is unchanged |
| 3 | **Make repository tests cheaper.** `RepositoryFixture` copies the whole repository and creates a Git commit for each of ~92 tests (126s). Build the fixture once per class and clone it per test, or run test classes in parallel processes. | ~1.5m | None | Low–medium |
| 4 | **Split the two longest integration files** (`attempt-lifetime` 239s, `owner-preview` 159s) into smaller files along their existing scenario groups. This lowers the floor for option 1. | ~1m on top of #1 | None if every case is kept | Medium |
| 5 | **Docker layer cache in the deploy build** (buildx with a registry cache in the existing ACR, or the GitHub Actions cache). The `npm ci` layer is reused whenever `package-lock.json` is unchanged. Tags stay SHA-pinned. | **~45s per deploy** (~30%) | None | Low; a workflow change under the [Azure guide](AZURE-DEMO-DEPLOYMENT.md) |
| 6 | **Poll readiness every 5s with one `az` query** for images, latest and ready revision. Keep the same three conditions and the same overall time limit. | ~10–20s per deploy | None | Low; workflow change |
| 7 | **Run integration and browser stages at the same time.** This would be 16 groups on 18 CPUs and 128 GiB. Benchmark it first on exact source, keeping zero retries. | up to ~5m | None, but more load can expose timing races | High; needs a measured benchmark |
| 8 | **Allow more than 8 groups** for the browser stage on large machines (the cap is `1`–`8`). This helps only after option 2. | ~1m | None | Low code, needs a benchmark |
| 9 | **Find the 2m15s after the application stage.** Local learning checks, artifact scan and receipt hashing are now timed separately, so the next run will show which one is slow. | unknown | None | Measure first |
| 10 | **Test-database reuse.** Lane setup measured about 0.2s for integration and about 3.5s for browser shards, including server start. | <10s | — | Not worth doing now |

**Owner trade-offs (these reduce assurance, so they are not recommended without a decision):**

- Skip unchanged stages, for example only repository checks for documentation-only commits. This would save ~21m on those pushes, but the standing agreement requires the complete gate for every push, including documentation.
- Reuse a receipt for an identical tree after a same-tree amend or rebase. Today any new commit needs a new full gate.
- Run the provisional and cross-browser journeys (~2m) only before a release instead of on every push.

Options 1, 2 and 3 together should take the gate from about 24m to about 17–18m with no change in what is checked. Option 5 is the cheapest deploy win.
