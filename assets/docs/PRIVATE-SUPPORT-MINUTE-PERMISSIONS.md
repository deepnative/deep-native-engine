# Private support-minute permissions

Scope: [#507](https://github.com/deepnative/deep-native-engine/issues/507), an independently usable local browser outcome under [CTP-019 #39](https://github.com/deepnative/deep-native-engine/issues/39). The original parent remains broader than this private fixture.

## Use the browser journey

1. A member sends an invented private request and deliberately holds a ceiling from their already-existing support test minutes. Their owned receipt displays the request and allocation references.
2. An already-provisioned finite operator signs in through `/staff/sign-in` and opens **My local assignment ID**. This noncredential reference grants nothing itself.
3. An already-provisioned finite administrator opens **Private support-minute permissions** from their staff portal, enters those three exact references and checks them. Checking creates no grant, units or effort.
4. The administrator enters canonical finite UTC timestamps, ending in `Z` with milliseconds, and deliberately confirms. The expiry must fit both current administrator and operator credentials; an excessive window is rejected rather than shortened.
5. The operator opens **Your granted support test effort**, deliberately begins, and records support and optional preparation intervals once. Existing accounting consumes the total and releases the unused ceiling. An invented 20-minute hold with10 support and 5 preparation produces 15 consumed and 5 released.
6. The member reloads their owned receipt. The administrator can inspect their own bounded permission history and revoke one exact permission. Other overlapping grants and request-text assignments remain independent. Revoking the grant bound to begun effort leaves the hold unresolved for reconciliation.

Permission metadata contains no request text, internal notes, replay keys, member directory or staff credentials. It does not promise staffed service, grant qualified status, issue allowance or enable payments.

## Explicit configuration and recovery

`DNE_SUPPORT_TIME_GRANT_ADMINISTRATION` defaults to `disabled`. With `DNE_LOCAL_STAFF_ENTRY=enabled`, `enabled` makes the finite current-administrator tool available in a private demo/test environment. Live hosting stays unavailable. This switch does not provision identity or allowance. Enable the already-delivered `DNE_LOCAL_SUPPORT_ASSIGNMENT=enabled` tool to supply the operator’s existing own-reference page. That tool assigns nothing until separately confirmed; a support-minute permission still creates no request-text assignment.

`recovery-only` pauses new checks and creation while retaining own history, exact receipts, original-operation inspection and exact revocation. An exact original creation replay inspects the retained grant; it creates no new grant and cannot resurrect a revoked one.

`DNE_SUPPORT_TIME_WRITES=disabled` additionally pauses support grant/revocation and existing support allocation/begin/settlement writes. Readback and existing member privacy operations remain available. Paused forms hide mutation controls rather than claiming a write succeeded.

If a write cannot be confirmed, its original form retains the exact operation and payload. Open **Inspect saved permission/revocation in a new tab**, inspect the retained outcome, and only then deliberately reconfirm any manual retry from the original form. Nothing is retried automatically. A missing or erased receipt does not prove that no write committed. Each page requires fresh selected-staff authority, same-origin form confirmation and a finite response deadline.

## Additive migration and rollback

Migration 071 adds immutable administrator-owned original revocation receipts and a bounded history index. It does not backfill legacy operations, change staff roles, extend permission windows or replay any allowance/effort. Existing CLI permissions keep their original role and native purpose. Legacy `platform_admin` recipients remain truthfully labeled in history; the new browser creation accepts operators only.

Use creation recovery-only mode for rollback, and pause support writes if necessary. Keep migration 071 and its receipts intact. Do not down-migrate, invent compensating settlement, replay an operation under a new key or delete recovery rows. Ordinary member erasure cascades these allocation-bound records; existing member export excludes staff credentials and operation keys.

## Acceptance scenarios

These are local synthetic acceptance boundaries, not full-MVP or qualified acceptance. The exact delivery revision and completed gate/demo evidence are recorded on the live issue.

| Scenario | Observable outcome | Executable evidence |
| --- | --- | --- |
| SUPPORT-GRANT-01 | Normal member/operator references and administrator navigation; checks reveal no source text or mutation | Config/route unit tests, native integration, L207–L209 |
| SUPPORT-GRANT-02 | Exact operator-only finite confirmation; overlong/invalid/current-authority denials | Values/admin unit tests and native integration |
| SUPPORT-GRANT-03 | Ordinary operator begin and 15 consumed/5 released settlement from a 20-minute hold | Native integration and L207–L209 desktop/mobile |
| SUPPORT-GRANT-04 | Own original creation, stable payload replay/conflict and bounded authenticated history | Native integration, admin/route tests, L207–L209 |
| SUPPORT-GRANT-05 | Exact original revocation, independent overlaps and held reconciliation after begun revocation | Native integration and L207–L209 |
| SUPPORT-GRANT-06 | Fresh authority after actual PostgreSQL lock waits; lost COMMIT and authority expiry through COMMIT/handback withhold acknowledgement | Native lifetime cases, HTTP route cases, L207–L209 |
| SUPPORT-GRANT-07 | Repeat migration, immutable receipts, export exclusions, ordinary erasure and creator-bound continuation | Native integration and history/admin unit tests |
| SUPPORT-GRANT-08 | Creation pause and write pause retain truthful reads without new writes | Config/view/admin unit tests, native integration, L207–L209 |

Test files: `tests/integration/support-time-grant-admin.test.ts`, `tests/unit/support-time-grant-*.test.ts`, and `tests/e2e/support-time-grant-admin.spec.ts`. Existing native support-time tests remain required. The first missing-navigation assertion and subsequent failures/fixes are retained separately from final exact-commit verification. Approved existing journey IDs and denominators remain intact; L207–L209 extend the local register.
