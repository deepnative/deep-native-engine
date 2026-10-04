# Private practice-session lifetime evidence — #453

## Scope and original failure

The unchanged source at `2ca8fd5e4602d58c6e294e04e24e8dcd8f8932ae`
checked database expiry before COMMIT but returned private results after delayed
successful COMMIT replies or synchronous native handback. Six real PostgreSQL
store cases and six actual HTTP cases reproduced this: detail/history returned
objects/HTTP 200 and append acknowledged saved/HTTP 303 after real authority expiry.
Controlled delays wrapped actual PostgreSQL operations, not simulated errors.
Original failures remain attached through the #453 issue checkpoints.

## Baseline and development evidence

The original clean baseline passed repository 73, unit 2,104, PostgreSQL 1,441,
approved local journeys 141/141 including 140/140 critical; browser executions
282 + 6 cross-browser + 68 separately provisional. All four unit metrics met 99%
globally and per module. Accepted full-MVP evidence remains separately 0/100.

A separate source copy reproduced the defect without modifying the active baseline
checkout or its database/reports. The first correction passed the original twelve
cases, then the complete store/HTTP files (46/46), focused units (53/53) and types.
An initial development full-unit run passed 2,130 tests and all coverage thresholds;
the new lifetime module measured 100% in all four metrics. Additional edge cases
were subsequently added, so those counts do not establish final-revision coverage.

Expanded six-operation expiry testing initially passed 11/12: one assertion assumed
the conservative monotonic denial would wait until the driver's delayed reply had
arrived. The failure was preserved. The test now explicitly waits for its controlled
reply before confirming PostgreSQL expiry; it retains the denial, single-commit,
owned-release, fresh-authority durability and foreign-owner assertions. All twelve
expanded cases then passed once. Production timing, thresholds and retries were not
changed to conceal that failure.

Two additional resource checks initially assumed an active PostgreSQL backend would
vanish synchronously with client closure. Those failures are preserved. Client-side
discard/no rollback/no commit remain immediate assertions; bounded server teardown
now checks backend exit, lock release, fresh-authority recovery and isolation.
The original 10-second test query and application 5-second statement limit remain;
no test/hook timeout or dataset was reduced. The corrected 55-case complete
store/HTTP run passed once. PostgreSQL documents long-query disconnect detection in
[its connection settings](https://www.postgresql.org/docs/18/runtime-config-connection.html).

## Remaining delivery gates

The implementation is now in the claimed branch. The expanded complete store/HTTP
files passed 63/63, including both read-first and revoke/delete-first orders,
all-operation expiry, unresolved actual queries and late actual acquisition. The
full development unit suite passed 2,140/2,140; S99.90/B99.61/F100/L99.92 globally,
and every executable module met 99%, including 100% on the new lifetime helper.
A lint finding on rethrowing a generic error from a named catch was corrected by
constructing the public error after the catch, preserving denial mapping without
attaching raw driver details. Corrected lint passed; final exact-commit checks must
verify that final source. No production retry, test timeout or threshold changed. No exact final commit, pre-push, hosted PR/main success,
merge, cleanup or completed demo is claimed here. Record those actual revisions and
reports in #453 before Done. Parent #42 and #200/#34 remain open for broader criteria.

Demonstrate ordinary invented practice create/append/reload/history/withdrawal using
a dedicated preview, plus an isolated controlled expiry showing no private response
and a fresh authorized view of any durable write. Keep credentials and private data
out of captures. This is local synthetic evidence, not qualified or full-MVP acceptance.

## Original hosted CI synchronization finding

At head `d3607d9`, original push CI 37177008731 failed two HTTP cases
(history and append); original PR CI 37177030176 failed the history case.
Both failed the database-clock-expired assertion before testing response denial.
Their complete original reports are retained separately; local gate success does
not override either hosted failure. The conservative monotonic deadline can return
a denial before the test driver finishes its deliberately delayed successful
COMMIT reply. The HTTP fixture now waits for that controlled reply before checking
the PostgreSQL clock, matching the existing store-level synchronization. It still
asserts exactly one COMMIT, denied response, no private text and no success redirect.
No production logic, timeout, retry, test inventory or assertion is weakened.
The corrected complete store/HTTP files passed once: 63/63, no pending/failed tests
and zero unhandled diagnostics, using a fresh owned PostgreSQL database. Raw reports
are retained in `/tmp/dne453-http-sync-focused-original-artifacts`. A new clean
exact-commit gate, pre-push and original hosted checks remain required; focused
success does not establish those gates.
