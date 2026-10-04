# Private local event registration evidence

Delivery issue #456; parents #119/#37 remain open. Worker DNE-2026-10-04-456-root, branch `codex/private-event-enrollment`, base `d0115bb55a2b2294e09ff10674070ceff086b437`. This is a development evidence record; clean exact-commit verification, push, hosted CI, merge, main CI, cleanup and verified-main demo are not yet complete.

## Acceptance map

| Area | Behavior and evidence |
| --- | --- |
| Explicit local entry | Disabled-default config, per-event opt-in and live refusal; config/store/HTTP tests. L142–144 exercise all three learner backgrounds without paid or staff authority. |
| Atomic bounded enrollment | Principal→workspace→inventory locking, active-owner and active-seat unique constraints, immutable inventory. Real PostgreSQL final-seat contention, simultaneous same-key replay, maximum100-seat case and stale-withdraw/re-enroll checks. Session expiry does not release a durable seat. |
| Private receipt and withdrawal | Exact UUID receipt and withdrawal; one-time terminal state, own history, old-version withdrawal after catalog replacement, unknown COMMIT reconciliation with no replay. |
| Private lifecycle | Owned workspace joins, foreign denial, CSRF/Origin HTTP checks, bounded export of102 retained records with unchanged preceding cursor indices, erasure denying continuation and preserving another owner's receipt. |
| Authority lifetime | Existing bounded practice transaction helper, no unrelated refactor. Real COMMIT-reply/native-handback expiry for preview/enroll/receipt/history/withdraw; uncertain committed write checks, no queued rollback; actual deletion/revocation locks in both winner orders against enroll/receipt/withdraw. |
| Usability and compatibility | L142–144 each run desktop/mobile: discovery, keyboard enrollment, reload, foreign denial, other-member full, keyboard withdrawal, other-member enrollment, own export and account deletion. Toronto DST offset change asserted. Repeated migration retains receipts and infers no registrations for existing members; SQL immutability checks. Pause/compatible rollback documented separately. |

Source catalog is current per process; same-version mismatch fails closed, but this is not a multi-deployment retirement protocol. Event-start checks use database time after inventory waits. Read availability is an observed snapshot, not a promise that a seat remains free.

## Executed development evidence

- Clean base full verification passed before implementation. Unchanged source returned404 to proposed enrollment POST for all three backgrounds; no preexisting registration capability was claimed.
- Expanded focused real PostgreSQL/HTTP:41/41, unhandled count0. Includes expiry, real race ordering, maximum capacity, schedule boundary, export continuation, erasure and migration checks. Original reports: `/tmp/dne456-focused-boundaries-artifacts`.
- New browser journeys first run:6/6 expected,0 skipped/unexpected/flaky, no retries. `/tmp/dne456-browser-original-artifacts/e2e-results.json`.
- Complete expanded unit run:2171/2171. Global statements99.90%, branches99.62%, functions100%, lines99.92%; unchanged per-module99% thresholds passed. `/tmp/dne456-all-unit-coverage-expanded.log`. Subsequent small sanitization/type fixes require the full gate again.
- No new dependencies, provider integration, production data, paid entitlement or deployment. Approved local register adds L142–144 as v83; full-MVP denominator remains unchanged and unaccepted.

## Retained failures and corrections

1. Original unchanged HTTP probe reproduced404 then encountered asynchronous forced-database cleanup error. Corrected probe used safe pool error capture and non-forced drop, confirmed zero remaining connections/errors and preserved expected missing-flow failure. Original retained, not counted as clean success.
2. Initial typecheck found invalid-field fixture inference and export-version mocks stillv19. Typed the fixture and updated expectations to the appended v20 payload; old section indices remain unchanged.
3. Initial view test caught raw synthetic CSRF text passed to the shared hidden helper. New event views now escape that value before rendering. Original failing test retained; corrected4/4 passed.
4. Compatibility unit tests initially expected the earlier catalog size and rejected index32, now the appended event export section. Expectations include the additional opted-in event and reject index33. Existing event and cursor checks remain.
5. Original full unit run passed2144 tests but failed new-module/config/view coverage. Added behavior units for validation, authority denial, inventory mismatch, seat outcomes, replay, private history, withdrawal, config and route recovery. Thresholds, source inclusion and exclusions unchanged; expanded2171-test run passed.
6. Lint rejected a replacement error thrown inside a caught-error block; aligned the existing privacy boundary pattern by throwing the generic error after the catch, without exposing raw driver causes. Typecheck required an explicit assertion/guard before reading the optional export section. Full verification is required after these corrections.

## Complete development gate

Original full `make PYTHON=/opt/homebrew/bin/python3.12 verify` passed with repository73, unit2171, PostgreSQL1511 and zero unhandled diagnostics. Approved local144/144 (critical143/143), browser288 plus6 cross-browser and68 separately provisional executions all passed without retries/skips/flaky cases. Formatting, lint, types, gate probes, production build, dependency audit and artifact/secret checks passed. Full-MVP remains separately0/100 accepted. Preserved raw reports: `/tmp/dne456-development-full-original-artifacts`. This was a dirty development tree, not clean-commit publication evidence. After this run, the existing repository schema test gained three invalid opt-in flag cases; final clean verification must include them.

## Remaining delivery evidence

Record the clean tested revision/tree, full gate and pre-push reports, author self-review, original PR/main CI, expected-head guarded merge, branch cleanup, and isolated runnable demo before closeout. Do not treat this acceptance map or focused tests as proof those remaining steps succeeded.
