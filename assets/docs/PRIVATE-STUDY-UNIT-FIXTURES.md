# Request and issue local study test units

This private preview adds a normal member/administrator browser flow for [#494](https://github.com/deepnative/deep-native-engine/issues/494), under [CTP-011 #27](https://github.com/deepnative/deep-native-engine/issues/27). It is a small invented-data fixture, not free-tier policy, paid access, money, service capacity or permission to call an AI provider.

## Enable and use

In a dedicated local preview, set `DNE_LOCAL_STAFF_ENTRY=enabled` and `DNE_LOCAL_TEST_UNIT_ISSUANCE=enabled`, then restart the preview using the existing [setup procedure](workflows/VERIFICATION.md). Issuance defaults off. Only local demo/test modes support it; live application hosting remains denied. Use the [existing protected staff setup](PRIVATE-LOCAL-STAFF-ENTRY.md) to obtain one current finite platform-administrator credential. Keep it outside commands, URLs, captures and public assets. Onboarding creates no test units.

1. The administrator signs in through `/staff/sign-in`, opens **Issue local study test units**, and deliberately shares the noncredential administrator reference shown there. There is no member or administrator directory.
2. The member opens `/member/test-units` and **Request or withdraw your one-time local study fixture**. Enter that selected reference, review the fixed scope and original access deadlines, and tick the initially unchecked confirmation.
3. Share the resulting request reference with that exact administrator. They open `/operator/study-test-units`, review the member-supplied reference and separately confirm the initially unchecked issue form.
4. The member reloads **Current local balances**. Exactly three `study_requests` are available within their original window. Choose a permitted invented source separately and use the [existing local request flow](PRIVATE-LOCAL-AI-TEST-REQUESTS.md). Source permission and quarantined-evidence handling do not come from fixture issuance.
5. To cancel a pending request or stop using remaining units, review and explicitly confirm **fixture withdrawal**. Consumed and held history is retained. Only remaining available units become unavailable; a later release of held units remains unavailable rather than reminting units.

The flow works for general, professional and technical backgrounds. A background, goal change, page read or staff role does not create a request, grant or source permission. Generic staff, another administrator, revoked/expired access and foreign references cannot issue the selected fixture.

## Fixed quantity and original deadlines

Policy `browser-study-fixture-v1` permits exactly three integer study requests, once per member's lifetime under that policy. There is no category/quantity editor, automatic allowance, refill or renewal. The request is bounded by both originally checked current access deadlines and at most 30 minutes. Units are bounded by the original request and access deadlines and at most 15 minutes after issuance. A checked preview can conservatively shorten a window; it cannot lengthen it. Cancellation, withdrawal, another key, expiry or renewed administrator access cannot reset the slot.

An owning member can still read the retained receipt after its request window ends while their own access is current. Administrator inspection additionally requires that exact original finite source and access window. Receipts distinguish pending, cancelled, issued, expired and owner-withdrawn states. A withdrawal does not mean the original deadline naturally elapsed. Generic early ledger expiry remains forbidden.

## Unconfirmed writes and privacy

An unavailable response can follow an actual successful commit. Use **Inspect original operation** on the offered original-key form. Inspection never dispatches a write. If its exact receipt exists, it displays the saved result. If no owned receipt is found, the form offers a separate initially unchecked confirmation of the same original instruction and key; it still checks current authority and the original deadline. Do not invent another key, renew the window, repeatedly submit automatically or infer rollback from a timeout. An altered/foreign instruction conflicts or denies without exposing another member's facts.

Issuance, immutable ledger event, exact fixture linkage and original operation reservation share one caller-owned PostgreSQL transaction. Withdrawal likewise shares its original marker, expiry event and operation. Held uncertainty is not refunded or automatically retried. Account erasure removes owned fixture/grant/event data; operation-key reservations are retained only with identifying fields cleared. This is not a cross-account identity tracker. Administrator erasure anonymizes attribution and cannot transfer pending issuance to another administrator.

The structured owner export appends `studyFixtureRequests` after all existing sections; existing indexes 0–40 remain stable, and the new section uses index 41. Records contain only the policy, fixed category/quantity, original timestamps, grant reference and generic administrator attribution. They contain no credential, administrator identity, instruction hash, replay key or private learning text. Bounded authenticated pagination and owner erasure/revocation controls still apply.

## Pause and rollback

Set `DNE_LOCAL_TEST_UNIT_ISSUANCE=disabled` and restart the compatible current application. This pauses new requests/issuance, while current owning receipts, balances, history, export, withdrawal, account erasure and finite original staff inspection remain available. Keep migration 067 and these readers. Do not delete populated grants, remove the spent policy slot, force uncertain holds to settle, run an older incompatible issuer or treat a schema downgrade as rollback. There is no deployment, hosted backup or old-binary compatibility claim.

Executable acceptance maps TESTISSUE-01–08 to Vitest policy/route/store/config tests, real PostgreSQL transaction, contention, legacy/export/erasure tests, and mandatory browser journeys L199 (request→issue→use→withdraw) and L200 (lost acknowledgement and explicit original-key recovery) across all three backgrounds and both viewports. The delivery issue records exact revisions, retained development failures and final gate/main/demo evidence; prose is not a passing gate. The original parent and live/qualified policies remain separately open.
