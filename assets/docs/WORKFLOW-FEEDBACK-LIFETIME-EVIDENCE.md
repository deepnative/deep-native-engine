# Private workflow-feedback lifetime evidence

Issue #463 advances #42's existing private feedback authority boundary. It does not establish full-MVP, qualified publication or live-provider acceptance.

## Original evidence

Base: e1ff6905930f297c60c8e8d651dcd39d03105e94. Original standalone PostgreSQL probe exercised list/create/update/withdraw with successful COMMIT reply and native handback deliberately delayed beyond the principal's database expiry. All eight returned private rows or successful acknowledgements after expiry. Committed create/update revisions and withdrawn absence were inspected separately. Original expected-failure result: `/tmp/dne463-fail-first-results.json`; log `/tmp/dne463-fail-first-original.log`.

HTTP read probe returned 200 and the invented note at both boundaries. Its original result is `/tmp/dne463-http-fail-first-results.json`. The original log also records an administrator-termination pool error during cleanup. That run is not claimed as clean fixture completion, and concurrent baseline execution is not evidence of the error's cause. Repository regressions use an owned loopback server and dedicated database after the baseline ends.

## Intended correction and invariants

Reuse the established bounded private transaction engine rather than duplicate deadline logic. Preserve feedback's principal → workspace → feedback-row lock order, exact owner and source-version checks, optimistic revisions and #369 export ordering. Charge acquisition (3 seconds), queries (5 seconds maximum) and total transaction (10 seconds) against conservative PostgreSQL-derived remaining authority through COMMIT and native handback. Late private reads withhold the entire result. Mutations whose callback has completed may have reached COMMIT; uncertain outcomes require explicit current-authority read-back and never automatic replay. Disposal of owned connections preserves deadline/timeout isolation at the cost of connection churn.

No schema, provider, retention policy, publication or commercial change. Compatible code rollback preserves stored data, but restoring the old reader reopens the demonstrated late-response defect; pause the affected endpoint if needed.

## Delivery state

Implementation and focused checks are in progress; complete changed-revision verification, CI, merge, cleanup and actual demo are pending. Focused checks are not delivery acceptance. Record exact revision/tree, first failures and fixes, raw test/coverage results, original CI, demo environment and closeout on #463.

## Development checkpoints

- Original clean baseline `make verify` passed at e1ff690; reports preserved in `/tmp/dne463-baseline-original-artifacts`, log `/tmp/dne463-baseline-original.log`. Repository73, unit2373, PostgreSQL1567; the baseline does not contain the correction.
- The repository HTTP regression fixture failed all eight cases on unchanged source at the expected response assertion: read200 disclosed text, mutations303 acknowledged success after expiry. Dedicated PostgreSQL18 container, zero unhandled diagnostics; `/tmp/dne463-http-regressions-fail-first.json` and corresponding original log retained.
- First corrected combined integration run:37 passed,5 failed with5 unhandled diagnostics. Older fixtures supplied no-op release wrappers, leaving transactions alive after the engine requested disposal. Corrected wrappers perform actual once-only native handback; the disposal assertion now expects disposal on both successful and failed rollback. No data assertions, lock ordering or timeout limits were weakened. Type checking also exposed two boolean-only promise declarations, corrected to include the explicit uncertain result.
- Corrected focused integration:42/42, zero unhandled diagnostics, including all eight regression cases and existing owner-export races. Reports `/tmp/dne463-corrected-integration-fixtures.json` and `-unhandled.json`; original failed reports retained separately.
- Focused unit/route111 passed; full unit coverage in the disposable draft snapshot passed all four global metrics99% (S99.91/B99.65/F100/L99.93). The final branch must independently pass the complete gate; these are development results only.

- First focused recovery-browser run:6/6 desktop/narrow Chromium executions passed, no retries/skips/flaky/unexpected cases. The final test context additionally preserves the registered device user agent, scale and touch/mobile settings; the complete final gate must verify that revision. Reports `/tmp/dne463-focused-browser-results.json` and original log retained.

- Final focused HTTP regression file:10/10 passed with zero unhandled diagnostics, adding actual HTTP503 and read-back evidence for withdrawal transport failure both before and after COMMIT. Original reports `/tmp/dne463-withdrawal-recovery-check.json` and `-unhandled.json`.

Author self-review: inspected the production diff, transaction reuse, principal/workspace/row lock order, source-version and revision checks, all store callers, HTTP uncertainty handling, actual disposal in test doubles, preserved export races, added browser scenarios and unchanged full-MVP register. No new schema, dependency, external provider, authority grant or retention policy. This is self-review, not independent or qualified approval. Exact committed full gate, pre-push and hosted verification remain mandatory.

- Original exact gate at14dd27f stopped at lint (`prefer-const` in the new browser fixture); formatting and repository73 passed, application tests did not run. Original log and revision-stamped reports are preserved under `/tmp/dne463-exact-original-artifacts`. Corrected the fixture binding to const without changing its behavior; a new committed complete gate is required.

## Original hosted failure and correction

Original PR CI37234219004 failed one of1577 PostgreSQL cases at the database-expired assertion after delayed withdrawal COMMIT. Reports for merge candidatef63eaf2 (same reviewed tree3a6200b) are preserved in `/tmp/dne463-pr-ci-original-artifacts`; the failed run is not overridden by local passes or another CI run.

A disposable unchanged-production fixture first delayed both clock observations too aggressively, causing seven failures, including pre-COMMIT expiry; that exploratory report is retained separately. A controlled80ms delay only before the first DB observation then reproduced the exact premature database-clock assertion in all four COMMIT cases (4failed/6passed, zero unhandled diagnostics). The conservative monotonic deadline can deny before PostgreSQL wall time reaches expiry. The fixture now retains and awaits its own delayed successful reply before asserting that later clock, including teardown. The controlled complete file passed10/10 with zero unhandled diagnostics. Original failed and corrected reports are under `/tmp/dne463-ci-clock-controlled-original-artifacts` and `-corrected-artifacts`.

The committed regression retains that delayed first observation and all response-denial, private-text, exactly-one-COMMIT, no-rollback, durable-state and fresh-authority recovery assertions. No production behavior, timeout, retries or journey denominator changed. Corrected clean exact-commit, pre-push and original hosted checks remain required.
