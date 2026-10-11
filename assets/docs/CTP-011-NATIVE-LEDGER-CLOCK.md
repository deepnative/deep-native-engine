# Native local test-unit clock — #504

A newly issued test-unit grant should be usable immediately when its stored
validity window is open. PostgreSQL stores those windows and now supplies the
clock for native reservation, release, adjustment and expiry. A different app
wall clock cannot permit an expired/future grant or prematurely expire a current
one. No grace period, shifted grant date or extra allowance is introduced.

The first unchanged-main verification for #503 failed in `TESTISSUE-05` while
reserving a freshly issued fixture. PostgreSQL was observed 35–43 milliseconds
ahead of the app clock. A separate real PostgreSQL reproduction confirmed the
same invalid-window branch with controlled, process-local app-clock lag. The
original baseline, diagnostic and failure reports are retained on [#504](https://github.com/deepnative/deep-native-engine/issues/504).

## Time and accounting boundaries

- Native operations query `clock_timestamp()` on the owned transaction's
  connection after the relevant grant/reservation locks. Transaction-start time
  and app wall time do not authorize a mutation after a lock wait.
- Expiry discovery reads current PostgreSQL time; each candidate still obtains
  its own transaction/lock and observes fresh time before expiring it. A later
  discovery observation determines whether more work is due.
- Missing, malformed or unavailable database time fails closed, without a host
  fallback. Accounting, authorization, exact allocation/source prerequisites,
  immutable events and original idempotency rules remain controlling.
- Explicit clocks passed to `syntheticLedger(pool, clock)` remain deterministic
  synthetic-test inputs. Runtime/internal native bridges use database time.
- Release returns units only according to their current grant state; withdrawn
  and expired units cannot become usable through clock skew or replay. This
  does not establish a paid service, commercial refund or qualified capacity.

## Executable BDD evidence

| Scenario | Behavioral evidence |
| --- | --- |
| LEDGER-CLOCK-01 | Existing fixture issuance followed by immediate native reservation with a lagging clock, one immutable event and unchanged replay; valid reservation with an ahead clock |
| LEDGER-CLOCK-02 | Expired/future native reservation denial, expired adjustment denial, native expiry and expiry discovery under clock skew |
| LEDGER-CLOCK-03 | Expired hold release stays expired; existing `TESTISSUE-05` retains withdrawn/held/consumed accounting |
| LEDGER-CLOCK-04 | Real PostgreSQL lock wait crossing expiry; unit clock-shape/query failures; metered local request rolls back on unavailable database time |

Tests are in `tests/integration/ledger-clock.test.ts`, the existing ledger and
study-unit-fixture integration suites, and ledger/local-AI-consent unit suites.
They use invented data and isolated generated PostgreSQL databases. Date-only
process-local faking does not change PostgreSQL time, real timers or host system
settings. The first seven meaningful failing regressions precede the source
repair. The original first regression run also contained a mistaken fixture
column name; that failure is retained and is not counted as behavioral proof.
The corrected fixture then exposed all seven intended failures. A later unit
fixture omitted the new database clock response; its failure and correction are
also retained, including a fail-closed metered-request test.
The next full unit run passed its assertions but failed per-module function
coverage because the former host-clock function remained as an unused identity
sentinel. Removing that unused function and representing the native clock with
an omitted argument restored the existing coverage gate; no exclusion or
threshold changed. The lock-wait regression observes the actual PostgreSQL
blocker while the grant is valid before holding it through its stored expiry.
Its first strengthened version chose a five-second fixture window and exceeded
the existing five-second test timeout. That failure is retained; the fixture
now uses a two-second window and bounded blocker observation, preserving the
same expiry assertion and existing test timeout.

Use the prescribed `make verify` for full verification and exact-commit push
evidence. Focused development passes alone do not prove delivery. See the live
issue for current commit, review, CI, merge, demonstration and cleanup evidence.
Original parents and #503 retain their unmet criteria. Policy work remains
parked, and full-MVP/deployment/qualified acceptance is not claimed.
