# Inspect the private synthetic ledger

This local operator report helps inspect retained invented accounting records. It is not a revenue dashboard, invoice or cash reconciliation, a service-delivery certificate, or qualified/bookable capacity. It creates no grants, reservations, payments or corrections.

## Access and use

In local demo/test mode, use an existing active operator or platform-administrator browser session. Open the operator registry at `/operator/experts`, then **Inspect synthetic ledger reconciliation**. The report is at `/operator/ledger-reconciliation`. There is no public staff login and member backgrounds do not grant staff authority. Trusted local staff setup is documented in [private sample support](PRIVATE-SAMPLE-SUPPORT.md); no support-content grant is required for this identifier-free aggregate report.

The page shows an as-of time and exactly five separate categories: coaching minutes, review minutes, support minutes, mock sessions and study requests. Each includes observed grant/reservation/event/attachment counts, accounting buckets, operation counts and structural results. Empty categories remain visible. Units are never combined into a grand total. Ordinary consumed reservations can legitimately lack a completion attachment.

An attached synthetic completion must match its exact consume event, reservation, member, grant, category and quantity. Delivered and preparation minutes count once within attached quantity. An invented reference is not proof that qualified service happened. Coach/mock categories have no supported completion attachment.

## What structural consistency means

The report validates each grant, reservation, event and attachment before aggregating. It checks original grant quantity/linkage, balance conservation including adjusted/expired units, reservation states and quantities, required operation events, adjustment agreement and exact attachment relationships. Opposite per-record discrepancies cannot cancel each other in a category total. Reported discrepancies identify affected record counts without exposing their identifiers or correcting records.

Observed available and expired buckets are accounting facts. Release events do not record whether units returned to available or expired; the report cannot reconstruct that attribution from timestamps. It does not authenticate historical request fingerprints. Invoice, collected cash, provider/job/manual reconciliation and qualified capacity remain unavailable; those broader criteria remain on [#123](https://github.com/deepnative/deep-native-engine/issues/123).

## Privacy, concurrency and recovery

The store locks current staff authority and reads all ledger relationships and aggregates in one database statement snapshot. This uses PostgreSQL’s documented [Read Committed statement snapshot](https://www.postgresql.org/docs/18/transaction-iso.html) and [row-lock behavior](https://www.postgresql.org/docs/18/explicit-locking.html); controlled PostgreSQL tests must still verify the actual implementation. A final database wall-clock check rejects an expired actor after waits/query work. There are no member identifiers, completion references, fingerprints, private text, drill-down or background segments in the report. Responses are not cached. Live mode is unavailable.

A concurrent mutation/deletion cannot mix two ledger snapshots. A valid pre-deletion snapshot may show the then-retained aggregate facts; the next read reflects deletion. Deleted members are not reconstructed as historical metrics. This is a local synthetic disclosure, not approval for hosted analytics.

Authorization denial or database/commit uncertainty returns no partial report. Reload after resolving the local fault; no automatic retry or correction runs. A failed rollback discards the connection. Integer overflow fails closed rather than rounding quantities.

## Verification and rollback

[#429](https://github.com/deepnative/deep-native-engine/issues/429) records actual revision-specific evidence. Behavioral unit, real PostgreSQL and desktop/mobile journeys L111/L112 exercise the report and its boundaries; those local results remain separate from accepted full-MVP evidence and qualified approval. Use `make verify` and the normal exact-commit pre-push/CI workflow.

This is read-only and adds no schema or retained analytics. Roll back its route, store wiring, navigation and presentation together; existing ledger records and their deletion/settlement behavior stay intact. No migration rollback, ledger repair or service activation is involved.
