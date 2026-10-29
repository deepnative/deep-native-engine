# Gate fixture and owned shutdown repair (#546)

27 October 2026. Scope: the four unchanged-main verification failures that
blocked the authorized #95/#545 delivery work. No member behavior, migrations,
provider state, durability setting, journey denominator or coverage threshold
changes. Worker: Codex `/root/fixture_repair`, branch `codex/546-gate-fixtures`.

The preserved baseline at `3bcc0602fb85a193fee6e0eb88036ff437b8fcb1` passed
82 repository checks and 4376 unit tests, then failed 4 of 2390 integration tests.
The coordinator retains those original reports in the
`545-assignment-private-handoff` checkout and its `dne-125-private-handoff`
evidence directory. This worker did not start another full gate.

| Scenario | Change and verification boundary |
| --- | --- |
| FIXTURE-01 / ATTEND-07 | All 105 native permission check/permit/withdraw sequences run in a scoped 30-second setup hook. The existing five-second export, foreign/forged cursor, ownership and erasure body is unchanged. Observation files still retain fixture phases and mark body start separately. |
| FIXTURE-02 / PREPARED-07 | Two members and 55 native prepared copies run in a scoped 30-second setup hook. Both export loops, all 55 origins/receipts, three evidence pages, foreign-cursor denials and secret exclusions remain in the five-second body. The original timeout phase was not established; this change does not claim otherwise. |
| FIXTURE-03 | A real request, 120-minute allocation, request grant and time grant remain native store operations. The other 105 requests and 21 allocations are test-only transactional batches, including 2520 one-minute reservations and corresponding immutable ledger events. All native foreign keys, immediate guards and deferred consistency triggers run. Counts remain 106 requests, 22 total allocations and 2640 units. These batches establish a read-history fixture, not application write-authorization evidence. Setup retains its 30-second hook limit; each batch statement has a 20-second limit. All original read bounds/assertions remain. |
| FIXTURE-04 / CLOSE-DDL-01/04 | One ordinary acknowledged-owned database DROP receives a 90-second server statement budget (previously 30 seconds). The preserved native failure showed a 55.426-second checkpoint, including 53.408 seconds syncing 143108 files. A 90-second finite administrative budget accommodates that observed operation. Control reads remain five seconds, session observation remains 20 seconds, and member deadlines are unchanged. No FORCE, retry, session termination or false cleanup receipt is introduced. Lifecycle integration budgets increase from 90 to 150 seconds to contain setup/session observation and the administrative DROP; unsafe-configuration test limits remain unchanged. |

The existing CLOSE-DDL native lock test now holds the exact owned database lock
for 31 seconds, past the former 30-second deadline. It still independently
observes holder/waiter/blocker identity and zero target sessions, asserts one
DROP, observes PostgreSQL's actual 90-second setting and the unchanged five-second
control setting, and requires successful removal with no recovery DROP.

## Focused evidence

Environment: macOS arm64, Node 24.21.0, PostgreSQL 18 on the coordinator's
existing local test service. Each invocation creates a fresh generated
`dne_test_` database, uses ephemeral HTTP ports and checks zero remaining
sessions before ordinary owned removal. No shared browser gate or port 4317 is
used. Runtime dependencies come from the unchanged lockfile.

- Bootstrap succeeded with Python 3.14 after the system Python failed to import
  `tomllib`; this was a setup error, before verification.
- TypeScript, ESLint, changed-file Prettier and diff checks passed.
- Preview unit tests passed 34/34.
- First three-file integration run: 77/78 passed. All 17 attendance and 18
  prepared-sample tests passed. The new support batch failed with PostgreSQL's
  UUID/text UNION type-inference error; explicit UUID casts corrected it. The
  failed reports remain under `artifacts/546-first-focused/`.
- The isolated corrected support case passed with 106 requests, six pages,
  3511 ms setup and 129 ms maximum read. This filtered diagnostic is retained in
  `artifacts/546-support-cast-check/`; it is not a full-file or full-gate pass.
- Unfiltered four-file verification passed **86/86**, with zero skipped/failed
  tests, in 293.51 seconds. The generated test database was removed after
  observing zero sessions. Support setup took 3722 ms, with 106 requests, six
  pages, 118 ms maximum read and 21 effort candidates. The native shutdown
  test passed with exact lock evidence, one DROP taking
  31033 ms, five-second control and 90-second DDL settings, zero recovery
  DROPs, closed backend and confirmed database/private-root absence.

Durable local reports (including the first failure and filtered diagnostic):
`/Users/tomwu/Documents/Codex/2026-10-27/dne-546-gate-fixtures/`.
The final command was `vitest run --config vitest.integration.config.ts` with
all four changed integration files, launched by the retained owned-database
wrapper `focused-runner.mjs`.

Author self-review: only named fixture/admin cleanup files changed; native
constraints, representative application writes, record counts and assertions
are retained. The cleanup ownership/session checks and failure diagnostic paths
are unchanged. This is author self-review, not independent review.

## Delivery handoff

The coordinator owns the combined exact-commit `make verify`, normal pre-push
hook, PR CI, guarded merge and resulting-main CI. Issue #546 stays open until
those checks pass. No push, merge, deployment, parent acceptance or completed
product demo is claimed by this focused repair.

Next bounded action: integrate this local commit into the already claimed #95
foundation-access branch and run its serialized full gate. #95's live lead
recommendation is Astra/High; review recommends Astra/High if separately required,
and escalation is XHigh. The coordinator and #95 worker retain their existing
claims. This repair removes their known gate blocker; it does not claim #95.
