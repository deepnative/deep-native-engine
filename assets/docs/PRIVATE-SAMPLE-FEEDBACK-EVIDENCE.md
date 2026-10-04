# Private sample feedback — verification record

Issue #450, parent #38. Worktree branch `codex/private-sample-feedback`, implementation based on `1ebe54efe95301fa9fb3efd399e32fe56793e49b`. This is development evidence, not merged or deployed acceptance.

## Behavior and limits

An exact-purpose reviewer drafts source-bound private comments, explicitly publishes the saved revision, and answers one owner clarification. Owner feedback survives consent withdrawal until source/account/workspace deletion. New source revisions receive no inherited review authority. Published feedback enters bounded owner export v19; drafts and operation identities do not. No formal qualification, paid service, ledger charge, live provider, routing or publication is asserted. Parent #38 remains open.

## Evidence retained

- Clean original baseline `make verify`: passed on the base revision. `/tmp/dne450-baseline-original.log` and `/tmp/dne450-baseline-original-artifacts`.
- Unchanged-source fail-first real HTTP: both feedback routes returned404 instead of required200 for valid existing owner/reviewer authority. `/tmp/dne450-feedback-fail-first-original.json/.log`.
- Unit development: full2,104/2,104 passed with all four metrics >=99% globally and per executable module. `/tmp/dne450-unit-boundaries.json`, `/tmp/dne450-unit-coverage-boundaries`, `/tmp/dne450-unit-boundaries.log`. Earlier module coverage failures retained separately; thresholds and source inclusion unchanged.
- PostgreSQL focused development:39/39 passed lifecycle, exact purpose, source validity, draft/publication replay, withdrawal, revocation/deletion winner orders, delayed COMMIT/native handback, owner/export pagination and export/delete ordering. `/tmp/dne450-integration-export-first.json/.log`. Subsequent44/44 focused cases passed both clarification/answer versus deletion winner orders and the existing account-erasure path: `/tmp/dne450-integration-exchange-deletion-first.json/.log`. Final migration-repeat and unrelated-sample checks are recorded in the issue checkpoint.
- Actual browser development: three backgrounds times desktop/mobile,6/6 passed after correcting exact-source form selection. `/tmp/dne450-browser-exact-form.json/.log`. Original6failed results and traces retained at `/tmp/dne450-browser-first.json/.log` and `/tmp/dne450-browser-first-artifacts`. The original test mistakenly clicked the first revoke form after a second sample existed; corrected selection targets the original source. No retries, timeout changes or reduced assertions.
- Whole-tree lint and TypeScript passed during development. Original compiler/lint failures and corrections retained under `/tmp/dne450-*`; most recent type and lint logs are `/tmp/dne450-browser-types-first.log` and `/tmp/dne450-complete-lint-first.log`.
- Local journey register v82 appends L139–L141. Full-MVP acceptance remains separately0/100, critical0/94; no synthetic evidence relabelled as accepted full-MVP.

## Original failures and fixes

Early standalone Node execution rejected a TypeScript parameter property; replaced with explicit property assignment. The initial store probe failed until migration056 was registered. Lint rejected a control-character regexp and an unused initial view assignment; corrected without weakening input validation. Export v19 required explicit updates to typed legacy fixture versions and the invalid cursor-section boundary from31 to32. Two new test typing errors were corrected. Original logs remain intact. No failure is converted to an original first-attempt pass.

## Delivery gates still pending

Complete AC audit, additional race/error/identity tests, clean exact-commit `make verify`, unbypassed pre-push, recorded author self-review, original branch/PR CI, expected-head merge, original resulting-main CI, branch/worktree cleanup and the actual isolated verified-main two-actor demo. The original dirty development gate passed: repository73, unit2104, PostgreSQL1434, local141/141 critical140/140, desktop/mobile282, cross-browser6 and separately provisional68; no skipped/flaky/unexpected browser results. Original raw reports are preserved at `/tmp/dne450-development-full-gate-first-artifacts`. This does not substitute for the clean delivery gates.

Next bounded action: finish #450's remaining acceptance tests and exact-commit delivery. Recommended lead GPT-6 Astra/XHigh; design and author review High. No independent or qualified review is claimed.

## Additional browser recovery evidence

The expanded same six journeys now also reject another active member and recover an attempted stale-draft comment without overwriting saved text. The original expanded run failed because getByLabel did not resolve the readonly recovery textbox; the captured accessibility tree showed its expected name and text. Selecting the named textbox by role corrected the locator. Corrected6/6 passed at `/tmp/dne450-browser-isolation-recovery-corrected.json/.log`; original failed reports and captures remain at `/tmp/dne450-browser-isolation-recovery-first.json/.log` and `/tmp/dne450-browser-isolation-first-artifacts`. No production code or timeout changed.

## Author review

Reviewed purpose-specific authority, current session and source fences, monotonic lifetime and uncertain commit handling, exact-source validation, draft-operation digest/revision conflicts, immutable publication/exchange, retained owner export and deletion order, additive migration, escaped attempted-text recovery and unchanged prior journey IDs. Changes to existing export fixtures only advance the explicit payload version to v19; existing cursor section indices are preserved and the invalid-section test now uses32 because31 is the appended feedback section. No dependency, provider, ledger, paid-plan or qualification changes. No blocking finding identified in this author review; it is not an independent or qualified review. Final exact-commit gate/hosted checks remain required.

## Verified original delivery and mobile acceptance repair — 3 October 2026

PR #452 merged source `1c796e22ad160cfb1dd3ce8ee9ea28be8b8c72f5` as main `2ca8fd5e4602d58c6e294e04e24e8dcd8f8932ae`, tree `0a63f1115b862eb6371b3a7906377ff60c3f0c34`. Clean exact-commit, unbypassed pre-push, original push CI37167459609, PR CI37167482384 and resulting-main CI37169064627 passed. Downloaded main reports confirm repository73, unit2104, real PostgreSQL1441, approved local141/141 including140/140 critical, browser282 plus6 cross-browser and68 separate provisional executions; all commands passed, no skipped/flaky/retried cases or unhandled integration errors. Unit S99.90/B99.61/F100/L99.92 and every executable module meets99%. Full-MVP remains separately0/100. The original delivery branch/worktree were safely removed after verified main; unrelated work was preserved.

The actual dedicated frozen-main demo at22:18 Toronto used invented source and locally provisioned exact-purpose staff fixtures. It observed draft privacy, explicit publication, one clarification/answer, separately consented revision with no inherited authority, retained prior feedback, UI withdrawal denying the reviewer and UI deletion removing the record. Captures and original result are retained at `/tmp/dne450-demo-captures` and `/tmp/dne450-demo-result.json` on the delivery host. This is local functional evidence, not live/qualified acceptance.

Visual inspection found a mobile defect: the390px viewport expanded to507px for preformatted exact-source text. The issue remains open for repair. Strengthened existing L139–141 journeys now use an invented long unbroken source line, preserved indentation/newlines, and a long feedback reference; exact text content must survive and document width must stay within viewport for reviewer and owner. Unchanged production source failed6/6 at the width assertion (desktop content4463px versus1280px). Original log/JSON/captures: `/tmp/dne450-mobile-original-failure.log`, `.json`, and `-captures`. After the scoped fix, the six complete actor journeys passed once; reports `/tmp/dne450-mobile-corrected.log/.json`. Eight existing feedback-view unit cases also passed. No retries, timeout/threshold or register changes.

The correction reuses whitespace-preserving `.content-text` for exact source and adds wrapping only inside `.sample-feedback`; it changes no persisted text, source offsets, escaping, permissions or schema. Author review checked the small rendering/style diff and unchanged privacy flow. This is self-review, not independent review. Clean exact-commit, pre-push, original PR/main CI, cleanup and a corrected verified-main visual demo remain required for this repair before #450 closes. Next afterward: reproduce scoped #453, lead Astra/XHigh; design/author review High.
