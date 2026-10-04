# Allocated private review test minutes — delivery evidence

Issue [#458](https://github.com/deepnative/deep-native-engine/issues/458), accountable owner @tomqwu, worker `/root`, claim `DNE-2026-10-04-458-root`. Branch `codex/allocated-review-feedback`. This is authorized private invented-data work under #194/#39/#38. No independent or qualified reviewer, deployment, paid allowance or formal assessment is claimed.

## Current checkpoint: 4 October 2026

Pre-commit checkpoint was recorded on base `3bc4ef05a5f1efe02f770ecff470688d3f31a642`. Final exact-commit verification, pre-push, self-review, PR/main CI, merge, cleanup and verified-main demo are **pending**. The results below are development evidence only.

| Issue area | Observed evidence | Remaining delivery work |
| --- | --- | --- |
| Explicit allocation | Actual PostgreSQL last-minute competition has one winner and exact replay; owner, category, bounds, pause and failure behavior have unit coverage | Complete gates and verified-main demo |
| Separate purpose and begin | Exact feedback permission plus allocation-specific time grant; begin is explicit and pins actor/grant; grant audit and revocation are transactional | Complete gates and verified-main demo |
| Atomic publication | 20 held → 15 consumed/5 returned, immutable publication, exact replay, concurrent identical publication, halfway 120-unit failure rolls back all settlement | Complete gates and verified-main demo |
| Cross-category overlap | Support-first and review-first role transitions, sequential and concurrent; actual PostgreSQL blockers show role changes waiting for the first commit, then overlapping second-category effort is denied | Complete gates and verified-main demo |
| Source lifecycle | Publication against withdrawal, deletion and time-grant revocation in both controlled winner orders; before-begin cancellation, begun retained holds, account erasure | Complete gates and verified-main demo |
| Private records | 101 allocations/202 events paginate and export without duplicates; 120-minute bound, owned receipts and content-free reconciliation | Complete gates |
| Uncertain outcomes | Expired allocation commit reply, expired publication commit reply and native handback withhold results; fresh authority establishes one durable outcome and exact replay does not debit again | Complete gates |
| Browser/legacy | Six desktop/mobile runs cover three backgrounds, cancellation, begin, saved draft, actual database publication failure, keyboard original-operation recovery, duplicate-safe replay, owner feedback/receipt/balance and withdrawal after begin; populated legacy migration applies twice without cost backfill | Verified-main demo and final complete matrix |

Current role model permits one staff role per principal. Cross-category concurrency evidence exercises a role transition competing with an in-flight completion; it does not pretend a principal simultaneously holds operator and reviewer roles.

## Development verification and retained failures

- Original full working-tree `make verify` passed before the recovery additions: 73 repository, 2327 unit, 1534 PostgreSQL, 294 desktop/mobile executions with no skipped/unexpected/flaky cases, plus required cross-browser and separately provisional checks. Raw reports: `/tmp/dne458-working-verify-original-artifacts`; log `/tmp/dne458-working-verify-original.log`.
- Current focused PostgreSQL suite: 29/29, `/tmp/dne458-pinned-grant-corrected.log` and `/tmp/dne458-pinned-grant-corrected.json`. The preceding 28-test run also recorded both concurrent role-transition orders. Each focused runner creates and removes its own test database and private storage.
- Current full unit coverage after recovery changes: statements 7793/7799 (99.92%), branches 7392/7417 (99.66%), functions 1567/1567 (100%), lines 7211/7215 (99.94%). Every executable module passes unchanged >=99% thresholds. Log `/tmp/dne458-recovery-unit-complete.log`.
- Expanded browser recovery/balance run: 6/6, `/tmp/dne458-recovery-browser-corrected.log`. Original six failures were the extra API replay omitting the required Origin header; actual keyboard recovery had succeeded. Added the required header, preserving the application CSRF guard. Original reports/traces retained in `/tmp/dne458-recovery-browser-original-artifacts`.
- Two fail-first HTTP cases exposed the missing manual publication reconciliation form. Original `/tmp/dne458-publication-recovery-original.log`; corrected route/view run 43/43 in `/tmp/dne458-publication-recovery-corrected.log`, followed by additional passing escaping/whitelist view coverage.
- Earlier development failures and corrections are recorded in [the issue checkpoint](https://github.com/deepnative/deep-native-engine/issues/458#issuecomment-5980952504): initial coverage gaps, loopback fixture timeout, app session-middleware omission, old publication INSERT bypass, missing grant audit, malformed test inputs and schema/column references. They are not concealed by retries or denominator changes.

No test threshold, approved scenario identity or full-MVP denominator was reduced. Synthetic/local evidence remains distinct from full-MVP and qualified acceptance.

## Operation and rollback

See [the operating guide](PRIVATE-REVIEW-TEST-MINUTES.md). Writes default off and refuse live mode. Pause new work while preserving owner reads, cancellation, export and deletion. Keep additive tables, guards and unresolved holds; do not roll back to writers that bypass the allocation. Begun unresolved holds require a separately scoped resolution decision, not an invented refund.

## Next action and milestone

Run the exact-commit gate, unbypassed pre-push and hosted delivery workflow. Recommended lead GPT-6 Astra/XHigh; author review Astra/High. This recommendation does not change runtime settings. Parents #194/#39/#38 stay open for broader criteria.

Verified-main two-actor demo, its revision/date, dedicated invented-data preview, screenshots, restart instructions and branch cleanup evidence will be recorded after delivery. No demo is claimed by this checkpoint.

## Author self-review before exact-commit verification

Reviewed the new owner/grant/effort stores, routes, runtime and session wiring; sample-feedback publication and views; migration058 guards, lifecycle triggers and release overload; ledger protection before replay and after locks; reconciliation/export ownership and stable appended cursor sections; and behavioral tests. Other existing export test edits only advance the response version from v20 to v21. No dependency or archived context changes.

The migration guards INSERT as well as UPDATE publication, couples completed allocations to published exact drafts through deferred checks, and protects unit linkage/settlement against generic ledger paths. Support and review writers share actor exclusion; the trigger adds cross-category checks to existing support insertion. Source erasure removes live source/feedback links while account/workspace erasure cascades accounting. Pause keeps required owner history/cancellation/export/deletion available. These are repository/local guarantees, not approval of a live ledger or retention policy.

A review finding was reproduced before correction: with two valid grants, reviewer detail chose the lexically first grant even after begin had pinned the other. The regression deterministically begins with the larger ID and failed against the original query. The corrected query requires the pinned grant, prioritizes unresolved allocations, and then uses creation time rather than random UUID as the primary history order. All29 PostgreSQL tests passed afterward; originals are retained under `/tmp/dne458-pinned-grant-original.*`. No separate or qualified review is claimed.

No blocking finding remains from this source review. Final exact-commit verification and hosted delivery remain mandatory; passing earlier development runs is not sufficient for push or closeout.
