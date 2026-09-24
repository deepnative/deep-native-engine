# CTP-025: isolated synthetic restore rehearsal

[Delivery #147](https://github.com/deepnative/deep-native-engine/issues/147) implements the local restore subset of [#45](https://github.com/deepnative/deep-native-engine/issues/45) and QA-004 M19. It is an automated integration rehearsal with synthetic fixtures, not a production backup service, deployment or launch approval. Accountable delivery owner: @tomqwu; review is self-review unless a separate review is explicitly recorded.

## Reproduce

Run the normal `make verify` after repository setup. The integration suite includes [`tests/integration/restore.test.ts`](../../tests/integration/restore.test.ts), using the existing digest-pinned PostgreSQL 18 Docker Compose service. Both local verification and CI already start that service. No new dependency, image, port or provider is introduced.

The test requires the generated loopback `DNE_TEST_DATABASE_URL` created by the verification runner and the repository Compose fixture at `127.0.0.1:54329` with its disposable `dne` role. It does not accept a source archive or destination database from the caller. It creates two fresh random databases with the `dne_test_<32 hex>` naming pattern, plus an owner-private temporary directory. Only names created successfully by this test are eligible for cleanup. It never reads or restores the existing `dne_dev` data.

The command checks the installed PostgreSQL tool version and uses `pg_dump --format=custom` and `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`. Archive bytes stay in process memory, and raw subprocess stdout/stderr is not printed. The PostgreSQL [dump](https://www.postgresql.org/docs/18/app-pgdump.html) and [restore](https://www.postgresql.org/docs/18/app-pgrestore.html) documentation defines these flags. The dump covers one database; cluster roles and production grants are not captured by this rehearsal.

## Observable acceptance

1. Migrate a fresh source and seed general, non-IT professional and IT learning records through application stores. Add a clean private evidence item, a derivative, and a revoked reviewer assignment. No real member information or external service is used.
2. Stop fixture writes while capturing all public-table row fingerprints, a custom-format database archive, and private object files. The database and filesystem snapshot is consistent because this test owns and pauses all writers; it does not claim a concurrent production snapshot protocol.
3. Make a later draft write only in the source. Feed both a malformed header and a truncated real archive to the separate empty target; require a nonzero restore result and no public tables after each failed restore. Then restore the valid archive and object copy into that target.
4. Compare every public table's row count and canonical row digest and every object's byte count/digest. Rerun all migrations twice and require unchanged restored rows. Recover all three learner profiles and their snapshot progress through the application stores.
5. Verify owner reads, cross-member denial, revoked-reviewer denial, consent restrictions, new writes after recovery, and deletion of restored evidence/derivative bytes. A previously issued download is denied after deletion. Source files and the later source draft remain unchanged by target mutations.
6. Close all pools and attempt cleanup of every owned database and directory even if a prior cleanup fails. A cleanup failure prevents a passing restore report. The test preserves an original assertion failure while reporting a fixed cleanup diagnostic if both fail.

No new browser journey is introduced because this test adds no product route or interaction. The complete existing local browser matrix and the separate outstanding full-MVP denominator remain required. Application unit coverage scope and thresholds are unchanged.

## Evidence and measurements

`artifacts/restore-drill.json` is written only after successful assertions and cleanup. It records source commit/tree and dirty state, Node/PostgreSQL versions, fixture counts, snapshot time, capture/restore/validation durations, the two rejected corrupt archives and privacy verification. It contains no member identifiers, tokens, object names, record text, connection URL or raw archive. The normal CI artifact scanner and upload preserve this report alongside integration results.

The first development rehearsal restored 28 tables, three learners and two private objects using PostgreSQL 18.6; the full integration run passed 45 tests. Initial lint rejected throwing from `finally`; the final cleanup path reports its own failure without masking an earlier assertion and rejects success after cleanup failure. Those development observations are separate from final acceptance. Exact-commit local/pre-push results, PR/main CI, measured timings and branch cleanup are recorded on #147 and its PR.

Durations measure a tiny same-host synthetic fixture. The recovered point is the captured quiescent snapshot; the deliberate later source write is absent from recovery. Neither observation establishes an approved production RTO/RPO, continuous backup, outage recovery time or production capacity.

## Remaining launch decisions and limitations

Before real data or hosting, #45 still needs an approved backup owner and incident operator, storage region, encryption and key custody, retention/access rules, production RPO/RTO, realistic volume and failure drills, provider recovery evidence and a controlled restore destination. In particular, restoring historical data must reconcile deletions/revocations that happened after capture; this rehearsal proves pre-snapshot revocation survives and does not implement a post-snapshot deletion/revocation journal. Global database roles, production least-privilege grants, WAL/PITR, external object stores, concurrent writer coordination and off-host loss are not covered.

The recommended default remains to keep real-data hosting and live enablement gated until those decisions and the wider #45 prerequisites are met. No service purchase or provider activation is implied. Removing this test has no application/schema migration effect, but removes the automated local restore evidence and must be a reviewed change. Keep #45, #42 and release gates open for their wider criteria.
