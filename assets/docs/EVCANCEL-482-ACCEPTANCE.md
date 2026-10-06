# #482 acceptance and review map

Scope: private local exact-version event cancellation under parent #119. This map is candidate evidence; merge/main-CI/demo closeout is recorded on the live issue. It does not declare full-MVP, qualified or live-clinic acceptance.

| Acceptance scenario | Executable evidence |
| --- | --- |
| EVCANCEL-01 exact reference, unchanged checked snapshot, future/current/opted-in | `event-cancellations.test.ts`, `event-cancellation-routes.test.ts`, `event-cancellation-browser.test.ts`; browser L185–L187 |
| EVCANCEL-02 durable affirmative canonical cancellation, absent inventory, separate versions | `event-cancellation-store.test.ts`, `event-cancellation-concurrency.test.ts`, `event-cancellation-migration.test.ts`; L185–L187 |
| EVCANCEL-03 member receipt/history/export/discovery, stable identity and separate withdrawal | `event-cancellation-store.test.ts` including 105 registrations and cursor-v2 continuation; `event-enrollments.test.ts`, `app.test.ts`, `event-cancellation-discovery.test.ts`, `event-enrollment-views.test.ts`; L185–L187 |
| EVCANCEL-04 observed inventory lock winner orders, commit/rollback/final seat and legacy insert | `event-cancellation-concurrency.test.ts`, `event-cancellation-migration.test.ts` (RC/RR/Serializable fence and workspace order) |
| EVCANCEL-05 selected current finite authority, role/hash/revocation/expiry, protected forms and handback | `event-cancellation-lifetime.test.ts`, `event-cancellation-routes.test.ts`, `event-cancellation-browser.test.ts`, `event-cancellation-concurrency.test.ts`; release expiry uses actual successful COMMIT and database clock |
| EVCANCEL-06 original-key/payload replay, lost successful COMMIT reply, manual browser recovery, different keys | `event-cancellations.test.ts`, `event-cancellation-store.test.ts`, `event-cancellation-browser.test.ts`; recovery fixture plus L185–L187 |
| EVCANCEL-07 owned reads/withdrawal/export/erasure, structural actor erasure, no attendee writer locks | `event-cancellation-store.test.ts`, migration constraints and source lock review; L185–L187 |
| EVCANCEL-08 additive populated/reapplied migration, default-off pause, continued canonical denial, no live mode/reactivation | `event-cancellation-migration.test.ts`, `event-cancellation-config.test.ts`, `event-cancellation-browser.test.ts`, `event-cancellation-store.test.ts`; source/configuration review |

Test filenames resolve under `tests/unit`, `tests/integration` or `tests/e2e` as appropriate. Gherkin/scenario IDs specify behavior; actual test results, revision and raw reports prove it. The complete prescribed gate must rerun these alongside every prior approved journey, rather than substituting focused evidence.

## Author self-review

- Global Host/Origin and selected-staff CSRF precede administrator handlers; raw selected cookie cannot fall back to member or legacy authority. The store validates the selected hash and current role under locks. Runtime supplies the default-off write switch; paused inspection/replay does not mint a new operation.
- Inventory remains immutable. State moves only from open to canonical cancellation. Deferred coherence demands the canonical fact and compatible creator operation in the same transaction; global key reservation and immutable operation payload prevent replacement. Existing receipts project canonical cancellation without mass updates.
- Enrollment and legacy inserts use workspace → inventory → state ordering. Cancellation uses principal → profile → inventory → state and no attendee workspace locks. Stale RR/Serializable writers encounter the actual state update; tests use observed blockers for winner orders.
- The earliest request/authority/event-start deadline is conserved through query/COMMIT/release and checked before/after HTTP rendering. COMMIT acknowledgement uncertainty never triggers compensating rollback or automatic retry. Browser inspection/manual repeat retains the exact original key and checked payload.
- Export adds only `cancelledAt` to stable section32 and keeps signed cursor-v2 ordering and bounds. Own deletion erases own registrations; administrator deletion redacts actor while preserving structural cancellation/key. No legal retention assertion is made.
- New L185–L187 append to the existing184 journeys. Existing published catalog and archived context remain unchanged. Schema v23 assertions update current fixtures only; no test or denominator is removed.
- README describes only the private sample capability. Parent #119 stays open for real appointment delivery, qualified experts, paid access, attendance, group costing and recording. Publication/deployment/providers remain outside authorization.

Self-review is by the implementing agent and is not independent. Required CI, expected-head merge, original resulting-main CI, actual dedicated demo and safe branch/worktree cleanup remain delivery conditions.

See [usage, privacy and compatible rollback](PRIVATE-EVENT-CANCELLATION.md). Live issue #482 retains original failures, fixture corrections and focused report locations; no failed run is replaced by a retry-only success claim.
