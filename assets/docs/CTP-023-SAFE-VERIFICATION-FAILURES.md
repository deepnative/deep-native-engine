# CTP-023: safe verification failure output

24 September 2026. Owner: @tomqwu; worker: Codex root task. The owner authorized the next bounded [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42) slice; [delivery issue #137](https://github.com/deepnative/deep-native-engine/issues/137) tracks this repair. This is a local synthetic QA-004 M18 verification-tool boundary, not release security approval.

## Reproduction and change

On clean baseline `c226fc21ed4bec2c5e0f61e7ab2f8bde8b3e7442`, `make verify` passed. New runner probes then produced seven failures and one passing control on the unchanged runner: a synthetic private database error reached `report.error`; non-Error rejections lacked safe diagnostics; connection cleanup could reject before the report; and an idle database error had no safe event handler. Those failures are reproduction evidence, not acceptance passes.

The runner now reports only code-owned stage names and fixed cleanup messages. A rejected value is never inspected, including its `message`, `stack` or coercion methods. The report retains the failed command's exit status. Database deletion, pool shutdown and private-storage removal are attempted independently; any failure blocks verification. Idle database errors and an unwritable final report also fail the run without printing the raw exception. Application startup and runtime idle-database logging already used fixed messages; the shutdown regression now asserts its complete console output too.

| Acceptance | Behavioral evidence | Boundary |
| --- | --- | --- |
| Suppress private failure details | [Runner tests](../../tests/unit/verify-app.test.mjs) inject a synthetic private marker into database, artifact setup, cleanup and report-write errors; console/report assertions exclude it | Orchestrator-owned output only |
| Reject non-Error failures and malformed evidence | Error, string and null rejection cases; malformed JSON evidence fails with a named stage | Assertions and parser details are withheld; stage and command status remain actionable |
| Complete cleanup and retain failed status | Combined database-drop, pool-end and storage-removal failures attempt all three and write a failed report; an idle connection error cannot become a pass | Failed database cleanup may require manual removal of the isolated test database; no cleanup success is inferred |
| Preserve successful verification | Successful control retains passing status and resource cleanup; full real PostgreSQL/browser gate runs separately | Tooling unit doubles do not establish live database/provider behavior |
| Runtime console minimization | [Startup/shutdown tests](../../tests/unit/main.test.ts), [idle database test](../../tests/unit/runtime.test.ts) | Existing local application lifecycle only |

Focused verification passed 18 tests across the runner and existing startup/runtime suites, plus ESLint on changed executable files. The final exact source/tree, clean-commit gate, pre-push repeat, self-review, PR/main CI, merge and branch cleanup evidence are recorded in the live delivery issue; a dirty run or this document alone does not establish completion. Tooling is outside the application coverage denominator and has these separate behavioral tests. No application coverage exclusion, journey denominator or retry setting changes.

The subsequent [Python runner slice](CTP-023-SAFE-REPOSITORY-DIAGNOSTICS.md) addresses the Python diagnostic boundary listed below; this document records the original #137 scope.

## Remaining scope and recovery

Inherited child-process stdout/stderr, Python repository exceptions, compressed artifact contents, hosted runtime logs, provider systems, backups, analytics and AI prompts remain outside this repair. The generated-artifact scanner is still required before CI display/upload. The full-MVP inventory and broader QA-004 matrix remain outstanding on #42. All fixtures are synthetic; no provider, publication or deployment is added.

To roll back this tooling change, revert the scoped commit and re-run verification; there is no schema/data migration. A missing final report or nonzero command status remains a failure even if an older artifact exists. Next bounded M18 candidate: reproduce and suppress private values in Python repository-verification exception diagnostics. Recommend GPT-6 Astra/xhigh, with separate Astra/high design/review when requested or required; this is not a claim of that work.
