# Your local test units

In a private local learning session, open **Sample availability → View your local test units**, or visit `/member/test-units`. This view reads existing synthetic test grants. It does not create allowances or define foundation access, paid plans, prices or qualified service capacity.

Coach, review and support minutes, mock sessions and study requests are separate categories. Each shows usable units, held units, future units, units past their deadline awaiting the explicit expiry sweep, consumed units, recorded expiry and test adjustments. The earliest applicable start/deadline does not describe every grant's window. An empty state means no local test grants are configured for that session.

Reload after a hold, withdrawal, settlement or deadline. Reading never settles or expires a hold. Held units remain reserved until an explicit outcome; withdrawing after a grant deadline records expiry rather than restoring usable units. All five categories come from one database snapshot, protected by current member and owned-workspace authorization locks. A final session/deadline check withholds a report whose usable deadline crossed during assembly. Lock/query timeouts, connection loss and uncertain transaction outcomes return unavailable rather than partial or invented zero balances.

**Download a current summary (JSON)** reads another authenticated snapshot and saves `local-test-units.json`. It contains category quantities and applicable timestamps, without member/grant/reservation IDs, private learning text or ledger event details. An intervening change can make it differ from the page. This is a current summary, not historical reconstruction or the broader member export; the existing v15 export still omits raw ledger records.

The page and download use the current cookie, reject query scope, prevent caching and deny staff or expired/revoked/deleted members. Live mode does not expose this synthetic reader. No service, allowance or model-provider policy changed. Rollback removes the reader/routes/link; there is no database migration or persisted data rewrite.

Delivery scope is [#435](https://github.com/deepnative/deep-native-engine/issues/435). Parents #199, #34 and #27 remain open for their broader policies and behavior. PostgreSQL and browser evidence covers private local synthetic fixtures, not commercial or full-MVP acceptance.
