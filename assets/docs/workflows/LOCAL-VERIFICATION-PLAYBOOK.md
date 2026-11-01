# Fast local verification and deployment playbook

This is the shared execution guide for agents. It records the delivered [#568 pipeline](https://github.com/deepnative/deep-native-engine/issues/568) and the measured [#572 release](https://github.com/deepnative/deep-native-engine/issues/572). Follow [AGENTS.md](../../../AGENTS.md), the live issue claim and the [verification contract](VERIFICATION.md); this guide grants no additional implementation or deployment authority.

## Measured performance, 1 November 2026

The complete successful local gate took **18m29.803s**, followed by a **2.034s protected push** that reused its original receipt. Azure deployment took **2m23s** including scheduling (2m19s job execution). That is approximately **21 minutes for these execution stages**, excluding implementation, review/merge time, additional queues and failed or changed-source campaigns.

| Local stage | Observed wall time |
| --- | ---: |
| 5,145 unit tests, 250 files | ~32s |
| 2,695 PostgreSQL assertions, 171 files; eight isolated groups | 7m17s |
| 530 primary browser executions; eight isolated groups | 5m43s |
| Six cross-browser plus 68 provisional executions | 1m25s |
| Remaining repository, format/lint/types, probes, build, audit, local learning, scans and cleanup | ~3m33s |
| **Complete local gate** | **18m30s** |

Stage times are rounded; command boundaries include small launcher/report overhead. Database and primary browser stages account for about 70% of this run. Database and primary browser groups run concurrently **within their respective stages**; this is not eight concurrent full campaigns.

### Measurement identity and limits

- Verified local commit: `12df554f4259843292855c4f031fcb341bff411b`; tree: `e215634cdbbeba5bffa9ca094b3702e1fe3accab`.
- [PR #573](https://github.com/deepnative/deep-native-engine/pull/573) merged as `7dbb7f0238051dbb3950a6b3c130308fba8ef0f6`, with the same tree and verified base/head parents.
- Linux `aarch64` verifier on the owner's Mac, Node `24.21.0`, Python `3.12.3`, locked dependencies, PostgreSQL 18 with default durability. Docker VM allocation: 12 CPUs, 64 GiB RAM, 300 GiB data disk. This is allocated capacity, not a minimum requirement or a measured 16 GiB result.
- Original local full run: `2026-11-01T19:21:12.161848Z`–`19:39:41.965017Z`; owner `DNE-2026-11-01-572-learning-theme-root`, process/session `250974`/`96958` (both terminal, never restart).
- Preserved proof: 459 original artifact hashes and eight private original browser-blob hashes matched; executed raw-review SHA256: `2e1b0cd520f2e188031fe6513bc5fb5071e819e5765addf619f81bde7b1ab663`. Original reports are retained privately outside the checkout; the [#572 closeout](https://github.com/deepnative/deep-native-engine/issues/572#issuecomment-6563016068) records their owner-local location. Other agents must obtain the originals for an audit, not treat this table or a summary as executable proof.
- All 87 repository checks, 5,145 units, 2,695 native assertions, 213 application modules at >=99% for every metric, 530+6+68 browser executions, 265 local journeys/264 critical journeys, 165 local-learning checks and 12 application commands passed. Zero skipped, retried or flaky accepted cases. Full-MVP acceptance remained unapproved.
- The [original Azure workflow](https://github.com/deepnative/deep-native-engine/actions/runs/41343046726) ran `19:42:02Z`–`19:44:25Z`; both ready images matched the exact merge SHA. This is deployment evidence, not a GitHub test run.

These counts describe that revision; derive future expected inventory from the current approved registers and source. Cold setup, dependency/browser installation, hardware, architecture, cache warmth, network, database work and competing load can change timings. The delivery also had preserved failed earlier-source campaigns and a specifically tested cleanup remedy; **18m30s is the final successful campaign, not total feature lead time or a first-attempt claim**.

## Procedure every delivery agent follows

1. **Claim one bounded issue and isolate source.** Check live ownership and dependencies. Use an owned `codex/` worktree, preserve foreign work and preview resources, record AC/scenario IDs and the recommended model/effort. Establish an honest baseline; reproduce missing behavior before fixing it.
2. **Prepare once.** Run `make bootstrap` once per checkout with Python 3.11+; use the Node version in `.nvmrc` and locked dependencies. Follow [setup](VERIFICATION.md#reproduce-the-complete-check). Inspect existing resources before setup; never reset or restart somebody else's database or preview. Keep preview data separate from gate databases.
3. **Choose groups explicitly or use `auto`.** Follow the profiles below. Keep the same selection and runtime for verification and push. Record the actual CPU/memory allocation, group count and resource identity; do not change the machine to match a benchmark without authorization.
4. **Serialize full campaigns.** Before starting, check the live gate owner/process/session and shared fixture. Claim capacity, then run one full campaign. Primary groups use separate databases, private files, ephemeral loopback servers and reports; other checks can use port4317. Isolated groups do not authorize competing full campaigns. An observation timeout means observe the SAME process again, not cancel/restart/duplicate it.
5. **Freeze and verify the exact commit.** Finish affected checks and self-review, commit, confirm a clean checkout, then run `make verify`. Record command, HEAD/tree, environment, started/finished times and process/session handle. Preserve all prescribed checks, thresholds, case IDs and zero-retry requirements, including for documentation-only pushes under the standing agreement.
6. **Inspect original evidence before pushing.** Confirm terminal exit0, unchanged source, successful child exits, complete current inventories, raw per-module coverage and journey mapping, zero skips/retries/flaky results, artifact scans and ordinary owned cleanup. Preserve original reports and hashes outside the checkout before later runs or cleanup replace them. A passing summary cannot override a failed process or missing raw report.
7. **Use the ordinary protected push.** The installed hook validates a worktree-specific receipt in Git metadata, bound to clean commit/tree, runtime/CPU/memory, `DNE_TEST_GROUPS` and original artifact hashes/private blobs. An intact receipt avoids a second full run. Missing, stale or altered proof falls back to the full gate. Never edit/copy receipts to borrow a pass, use `--no-verify`, remove the hook or reduce coverage. A source/configuration/runtime change invalidates previous acceptance.
8. **PR and guarded merge.** Record author self-review honestly. Recheck current PR head/base, local proof, actual required reviews and source protections. Merge with the expected head SHA when eligible; do not wait for an optional reviewer or a retired CI-test status. Read back actual main, exact merge tree and parents against the verified source and reviewed base/head. Safely fast-forward only a clean local main. **GitHub Actions contains only Azure deployment: no PR/main tests, independent verification or proof-promotion jobs.**
9. **Deploy only within existing authorization.** Follow the [Azure release guide](AZURE-DEMO-DEPLOYMENT.md). Recheck exact verified current main, isolated subscription/tenant and actual durable target immediately before dispatch. Compare snapshots from the same Azure API format/version. Preserve the current automatic-release setting; the measured release used a scoped manual dispatch with the flag false. Stop execution on ANY preflight failure: use fail-fast shell execution or checked sequential subprocesses, never an unconditional dispatch after a failed command. Do not directly apply a prepared patch, create a cutover receipt or provision/reset services to get around the workflow.
10. **Observe and finish.** Observe the SAME deployment to terminal readiness; verify actual ready revision/images, preserved configuration and the real public journey. Keep original API/log evidence privately. Distinguish local verification, merged source, deployment and product acceptance. Reconcile issue/project, preserve failures, clean only owned merged refs/worktrees when safe, and record concrete live-preview/unsaved-state blockers. Release gate capacity and name one bounded next action/model without automatically starting it.

### Group and cache profiles

```sh
# After the exact clean commit and normal setup:
export DNE_TEST_GROUPS=auto
make verify
# Inspect and preserve the original reports; keep this environment unchanged.
git push
```

`DNE_TEST_GROUPS` accepts `auto` or an explicit `1`–`8`, always running the COMPLETE inventory. Auto considers CPU tier and allocated/constrained memory, budgeting about4GiB per group. Group selection does not allocate RAM. Optional starting profiles are 8GiB/two groups/5GB build-cache retention, 16GiB/four groups/10GB, and 64GiB/eight groups/40GB. See [configurable local resources](VERIFICATION.md#configurable-local-resources) for supported configuration and limitations. The smaller profiles have not been hardware-benchmarked by this measurement.

Build-cache retention is a garbage-collection target, not a hard total-disk quota. It does not shrink a data disk or authorize deleting images, volumes, databases or failure evidence. Global CPU/RAM/disk/cache changes and VM restarts require their own authorized maintenance window; preserve and restore existing services. No allocation change is required to follow this guide.

## When a run fails

Preserve the FIRST original logs/reports/traces, source/environment and resource identities. Inspect the exact failing stage and ordinary cleanup before choosing a bounded remedy. Do not retry unchanged source for green, increase deadlines, shrink data, change denominators or suppress errors. Run focused checks for the demonstrated change, then the complete new-source gate. A later pass supplements the history; it never changes the earlier failure into a pass.

For test-owned HTTP fixtures, reuse `tests/support/loopback-server.ts` after expected responses complete. An owned unfinished connection can otherwise leave listener shutdown waiting; never generalize test cleanup into production request cancellation, forced SQL deletion, or killing another worker's server. The #572 listener regression and six unchanged real-PostgreSQL support journeys documented the specific remedy; the precise socket identity in the original failed campaign was not captured.

Record timings only from original current evidence. Distinguish actual child duration from start-to-next-stage wall time; distinguish reused receipt push time from verification. Rebenchmark a changed scheduler/resource profile on its exact source, with complete inventories and failures retained. Prefer resolving measured database/browser bottlenecks over reducing assurance or adding another duplicate gate.
