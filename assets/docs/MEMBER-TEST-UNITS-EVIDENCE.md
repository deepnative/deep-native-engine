# Private member test-unit summary evidence

Issue [#435](https://github.com/deepnative/deep-native-engine/issues/435) adds a read-only private current summary and JSON download. Parents #199, #34, #27 and broader export #42 remain open. No grant policy, provider, payment, qualified capacity or publication approval changed.

## Behavioral evidence before the exact-commit gate

Clean base `bd589bed6501fead891f4cd74008996b2745098d` passed the complete gate after installing the unchanged lockfile. The initial missing-`pg` environment failure was retained. The fail-first HTTP test expected 200 and received 404 before implementation.

Focused source/route/view tests and all-source coverage passed: 1,437 unit cases; statement 99.96%, branch 99.64%, function 100%, line 99.96%. New reader, routes and views each have 100% metrics. A restricted-sandbox route run failed because loopback listening was denied; the same source ran with socket permission. Earlier fixture failures (foreign-host status and matching COMMIT inside READ COMMITTED) were corrected without weakening application boundaries.

Thirty real PostgreSQL cases cover three backgrounds, five categories and coherent owner accounting; unknown/staff/expired/revoked/deleted/deleting-owner denial; legitimate migrated expired windows; hold replay and withdrawal before/after expiry; explicit sweep accounting and no read mutation; concurrent reservations, deletion/revocation locks; session/grant deadlines crossed during assembly; malformed state; query/lock timeouts; uncertain commit/rollback acknowledgements and connection termination. The termination test reproduced an actual unhandled checked-out-client error although its assertion passed. The reader now owns the client's error-listener lifetime, withholds a result and destroys a failed connection. The corrected run passed 30/30 with zero unhandled errors. Original failure JSON and logs were retained, not overwritten or retried into a success claim.

Eight browser cases pass across desktop and mobile Chromium: explorer, professional and technical members navigate from availability, inspect empty/separate-unit states, refresh after replayed holds/withdrawal/expiry, download actual JSON without IDs, and see staff/revocation/query-scope denial. The first run rejected noncanonical fixture timestamps; using the existing ledger's canonical ISO timestamp contract fixed the fixture without changing source policy. Original traces and JSON were retained. Screenshots were inspected for readable mobile layout and viewport fit. The scenario register extends v74 to v75 with four critical journeys L116–L119; all earlier cases remain required, and the separate full-MVP inventory remains unchanged.

Environment: macOS, Node 26.9, repository lockfile; CI uses its declared Node 24 runtime. All PostgreSQL and browser fixtures use newly generated isolated loopback databases and private storage, removed after each run. Test assertions use invented data only.

## Author self-review

The diff was reviewed against scoped acceptance: cookie-only ownership and principal/workspace locking; complete source validation including unknown categories, safe quantities and finite windows; one captured database snapshot plus final deadline fence; no ledger mutations during reads; failure without private exception text or invented zero balance; explicit download whitelist; no-store and live-mode denial; connection error ownership through pg-pool handback. Legacy expired zero-length windows remain readable. No schema, dependency, archived context, thresholds, retry policy or live policy changed. This is author self-review, not independent or qualified signoff.

Rollback removes the runtime reader, page/download routes and availability link; no data migration or rewrite is required. The current-summary download is not retained history or the existing broader v15 export.

## Delivery evidence

The exact-commit full gate, pre-push, PR CI, expected-head merge, resulting-main CI and branch cleanup must pass before issue Done. Their revision-specific results will be recorded on #435. Focused checks above do not establish that delivery, deployment, commercial launch or full-MVP acceptance.

## Required CI failure and report repair

Original branch CI run `37033748610` attempt 1 failed on source `488fa11`: the existing 22,000-record ledger reconciliation test exceeded its unchanged five-second deadline. Original PR CI `37033805232` attempt 1 passed. Both outcomes remain recorded; the passing run does not erase the failure.

A fresh cold database executed the aggregate in about 35 ms. Normal member deletion, statistics refresh and a new 22,000-record import reproduced a dangerous stale-cardinality nested-loop plan: roughly 35 seconds and 241,989,000 rejected join pairs. No application catalog edits were needed for that reproduction. This establishes a real planner-sensitive defect consistent with the timeout; the original runner's query plan was not captured, so its precise cause is not asserted.

The extended real PostgreSQL regression retains the original fresh case and adds the erased-member history. Before the source correction, the new case failed at the unchanged five-second test deadline. The report transaction now discourages nested-loop plans only after its indexed authorization checks, using `SET LOCAL enable_nestloop=off`; transaction completion resets the setting. No server setting, time limit, arithmetic validation, snapshot boundary, dataset size or retry rule changes. The corrected retained-churn execution plan completed in about 59 ms. All 49 reconciliation integration cases passed, including existing concurrent writer, deletion, revocation, timeout and uncertain-acknowledgement cases. The unit failure matrix also covers failure to set the report planner option.

This is a bounded planner workaround, documented by [PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-query.html); it does not make arbitrarily large ledgers fit the query deadline. Fresh exact-commit and pre-push gates plus new original CI remain required before merge and closeout.

### Retained-history erasure bottleneck

Original repaired-head branch CI `37040217657` attempt 1 also failed and is preserved: the new retained-erasure fixture exceeded its unchanged 10-second setup deadline. This was a setup failure, not the five-second report assertion. The original repaired-head PR run remains separately recorded on the issue.

Events had an unindexed cascading `grant_id` foreign key, causing repeated history scans during member erasure. A disposable-database experiment with the referencing index completed the same 22,000-grant/event member deletion in about 411 ms. The additive migration 052 creates only that index, records its version idempotently and rewrites no records or constraints. Both retained histories and every deadline remain unchanged. A fail-first migration regression failed because the migration did not yet exist; it verifies repeated migration preserves immutable history, ordinary event deletion remains denied, member erasure removes that member's history, and another member's records/balance remain intact.

Rollback may drop `synthetic_entitlement_events_grant_idx` without deleting data; doing so reintroduces the erasure performance risk. The normal local startup migration acquires an index-build lock; no live rollout or concurrent production deployment is claimed. Required fresh exact-commit, pre-push and original CI gates remain pending for this additional repair.
