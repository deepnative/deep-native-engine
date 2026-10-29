# Linked member sign-out — #547 source handoff

27 October 2026 (America/Toronto). Worker: Codex `/root/member_signout`, accountable owner @tomqwu. Branch `codex/547-member-signout`; isolated checkout `/Users/tomwu/.codex/worktrees/547-member-signout/deep-native-engine`, based on `dcb5dd0241a5b74f442b6a058c1f99ae7d2277cc`. The commit containing this evidence is the source handoff; its exact SHA is recorded on the live issue. Lead and independent review recommendation: Astra / High, matching [#547](https://github.com/deepnative/deep-native-engine/issues/547).

## Scope and design

The live issue recorded MOUT-01–06 before implementation. A linked member explicitly signs out through My account and deliberately returns by existing email recovery to the same saved member/workspace. The application has one current bearer per member; copied cookies are also invalidated. There is no per-device session claim.

Sign-out locks the principal first using the exact current token, then rechecks the active owned workspace and locks the verified identity. It replaces both principal and learner token hashes atomically with a discarded random secret. It preserves durable identity, expiry, profile, progress and pending email challenges. A final expiry predicate prevents a bearer expiring during dependent locking from being changed. No email is sent and no usable replacement token is returned. The member cookie is cleared only after confirmed commit; staff cookies remain separate.

Email transactions now discard a connection after a failed COMMIT acknowledgement, propagate uncertainty and never automatically replay the mutation. Precommit failures still roll back. This shared transaction adjustment is necessary for the sign-out commit-loss boundary and also makes existing email transactions conservative on that same transport failure.

No migration, dependency change, new authentication provider, device registry, account deletion behavior, staff-signout change, automatic privilege, automatic email or hosted operation is included. Existing email challenge expiry/validity remains unchanged. Browser-only, pending, absent recovery, forged origin/CSRF, foreign identifiers, expired/revoked/staff principals and deleting accounts cannot acquire sign-out authority.

## Behavior and executable evidence

Coordinator registry correction, 27 October 2026: #117 reserved L230–L232 before the sign-out claim. A broader claim read then confirmed #103 had already reserved L233–L235 and #114 L236–L238. The intermediate coordinator correction at `aa4cd20` also collided and is superseded here; preserve all three workers’ reservations. The three sign-out cases now use **L239–L241**. Historical focused reports below ran at source `6fbd4bef4c9609b2ed5466c858d0a77b76e9add9` under their original IDs: L230 → L239, L231 → L240, L232 → L241. Those raw reports remain unchanged; their passes support the unchanged behavior, not a claim of execution under the renamed IDs. Only the three new test titles, corresponding registry IDs and this evidence mapping change. All application code and earlier journey objects remain unchanged. The eventual exact full gate must use the corrected IDs. Coordinator checks passed: exact registry-object comparison, all six renamed desktop/mobile test cases discovered with `playwright test --list`, changed-file Prettier/ESLint and `git diff --check`. No browser cases were re-executed for this identifier-only correction; the original JSON reports remain byte-identical.

| Scenario | Given / When / Then | Executable evidence and observed result |
| --- | --- | --- |
| MOUT-01 | Given linked current access, when the member signs out, then both bearer copies lose authority, only the member cookie clears, no email is sent and work remains. | `tests/unit/member-email-access.test.ts`, `tests/unit/member-email-access-http.test.ts`; `tests/integration/member-signout.test.ts` copied-bearer HTTP read/write test; browser L239. Passed. |
| MOUT-02 | Given signed-out saved work, when the member deliberately requests and consumes email sign-in, then the same member/workspace/profile/progress returns and the old token remains invalid. | Native unit preservation/challenge test and browser L239; browser L241 also checks identity after uncertain sign-out. Passed. |
| MOUT-03 | Given browser-only, pending or unavailable recovery, when sign-out is attempted, then retain access and show recovery guidance. A previously linked display does not authorize a later mutation after its identity disappears. | Native unit recovery prerequisite test, HTTP denial tests, browser L240 including actual identity removal between rendering and submitting. Passed. |
| MOUT-04 | Given forged input, staff/expired/revoked authority or deleting/deleted workspace, when sign-out is attempted, then no unrelated authority or work changes. | HTTP origin/CSRF/identifier denial; native unit expired/revoked/staff/deleting/deleted/isolation tests; expiry recheck via a test-only database boundary; copied-bearer HTTP write denial and actual staff cookie preservation. Passed. |
| MOUT-05 | Given email sign-in or deletion holding a principal lock, when sign-out races, then serialization preserves the new emailed session and never revives deleted work. | Native integration tests run both email/sign-out orders and both deletion/sign-out orders, observing real lock contention through `pg_blocking_pids`. Passed. |
| MOUT-06 | Given failed storage or a lost real COMMIT response, when sign-out is uncertain, then no success claim, cookie clearing or automatic replay occurs; deliberate inspection/email return resolves actual persisted state. | Native unit and HTTP tests; integration before-commit and after-real-COMMIT transport failures; browser L241 requires both variants on each browser. Passed. |

The register is `initial-learning-v115`, with L239–241 added. All 229 previous journey objects and all full-MVP objects compare equal to the base. Scoped browser evidence is 3/3 new critical scenario IDs on both desktop and mobile Chromium: 6 first-attempt passes, no skips or retries. This is not a claim that all 232 journeys or the full-MVP matrix ran in this worker.

## Commands and preserved failures

Environment: macOS 27.0.1, Node v26.12.0, Python 3.15.0, existing lockfile. `make bootstrap PYTHON=/opt/homebrew/bin/python3` passed. The first default-Python bootstrap failed because system Python lacked `tomllib`; no repository workaround was introduced. `npm ci --ignore-scripts` completed and reported 7 advisories (6 moderate, 1 high); dependency audit interpretation/remediation remains in the coordinator's complete gate, with no lockfile changes here.

Before implementation at base `dcb5dd0` plus only the new behavioral test, `npx vitest run tests/unit/member-email-access-http.test.ts -t MOUT-01` failed meaningfully: POST `/account/sign-out` expected HTTP 200 but returned 404. Raw result: `artifacts/547/red-unit-results.json`.

The first native denial fixture attempted to change an existing member principal to staff and hit the existing workspace composite foreign key. It was corrected to create an actual standalone staff principal; this was a fixture failure, not product evidence. Raw result: `artifacts/547/first-native-fixture-failure.json`. A temporary TypeScript error in a malformed-input test cast was corrected before final typecheck. A diagnostic single-file `--coverage` command passed its route tests but failed all-source thresholds because unrelated modules were not executed; it is retained in `artifacts/547/route-coverage.log` and is not an acceptance result. No threshold or source inclusion changed.

Final source checks:

- `npm run test:unit`: exit 0, **211 files / 4,521 tests passed**. All-source and per-file 99% enforcement retained. Reports: `artifacts/547/unit-final-results.json`, `artifacts/547/coverage-final-summary.json`, `artifacts/547/unit-final-coverage.log`.
- Coverage: statements **13,092/13,100 (99.93%)**; branches **12,728/12,759 (99.75%)**; functions **2,827/2,828 (99.96%)**; lines **11,933/11,939 (99.94%)**. `member-email-access.ts`: 116/116 statements, 56/56 branches, 13/13 functions, 98/98 lines. `member-email-routes.ts`: 74/74, 52/52, 17/17, 68/68. `views.ts`: 331/331, 980/987, 164/164, 306/306; its unchanged branch shortfall remains above 99%.
- `npx vitest run --config vitest.integration.config.ts tests/integration/member-signout.test.ts`: exit 0, **7/7 native PostgreSQL tests passed**. Reports: `artifacts/547/integration-final-results.json` and `integration-final.log`.
- `npx playwright test --config artifacts/547/local-browser.config.ts`: exit 0, **6/6 desktop/mobile tests passed**. This temporary local config selects only the new spec, with retries 0, one worker and no shared web server. Native app listeners use port 0. Reports: `artifacts/547/browser-results.json`, `browser-final.log`.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`: exit 0 on final application/test source.

Each native/browser fixture creates and drops its own randomly named `dne_test_*` database. None truncates or uses the coordinator's gate database or port 4317. No real provider sends occurred. Artifacts are local ignored evidence, not committed member records.

## Review and delivery boundary

Self-review checked the entire diff, exact-token invalidation, principal-first locks, expiry after dependent reads, transactional verified identity, both hash updates, preserved pending email challenge, cookie separation, uncertain commit handling, native isolation, unchanged prior journey objects and no production operation. Independent review was requested from Codex `/root/fixture_repair`; its final findings are recorded on the live issue/handoff before integration.

This worker has **not** run `make verify`, pushed, created a PR, merged, verified main CI or deployed. The coordinator explicitly owns the serialized complete gate and release campaign. Bootstrap is complete and no hook was bypassed. The original coordinator gate PID 36367/session 22893 and port 4317 were not disturbed. The branch/worktree must remain until coordinator integration and safe cleanup; an unintegrated source commit is not complete delivery or issue closure.

## Runnable synthetic demonstration

The new desktop/mobile browser tests demonstrate My account → Sign out → old/copy denial → deliberate email sign-in → same saved profile and progress, plus recovery prerequisites and both uncertain-write states. Captures are `artifacts/member-signout-desktop-chromium.png` and `artifacts/member-signout-mobile-chromium.png`; the mobile result was visually inspected for legible guidance and return link. The dedicated ephemeral apps/databases have been shut down and removed. Re-run the scoped browser command above from this checkout to reproduce; it requires local PostgreSQL and installed Playwright Chromium. The normal coordinated browser gate also discovers `tests/e2e/member-signout.spec.ts`.

These are synthetic local acceptance demonstrations, not a live email-provider check or post-merge milestone. README now describes the changed member journey. The coordinator must demonstrate the resulting verified-main slice in the authorized preview after integration.

Next bounded action: coordinator integration and exact complete gate for [#547](https://github.com/deepnative/deep-native-engine/issues/547) after the currently claimed account/support release completes. It depends on that release and this requested independent review; do not alter the frozen release or another worker's foundation claim. Recommend Astra / High for this identity-boundary integration and review, as the live issue labels specify. This recommendation does not claim new work or change the running model.
