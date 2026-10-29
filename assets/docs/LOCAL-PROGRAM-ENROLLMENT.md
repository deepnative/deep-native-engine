# Local program enrollment and My courses

Issue #557's first program slice models explicit enrollment using existing accounts and learning records. It is a **local enrollment simulation** in demo/test mode. The six short foundation lessons are seed content, not a full supported academic term. No payment, paid entitlement, calendar commitment, renewal, qualification or teaching/support coverage is created. Common foundation access and old private work remain available under their existing rules.

## Student journey

1. Open `/programs` or `/programs/foundation/terms/local-foundation-1`. Read the exact program/term versions, six FND-001–006 version-2 lesson outcomes and actual availability. Planned applied/specialist/monthly learning is separate.
2. When the simulation is open, choose the exact local program. The choice is a public navigation hint, not an enrollment or account credential.
3. Deliberately create a learning account or use existing email recovery when configured. In the same browser, a valid choice returns to the exact enrollment confirmation. Account creation and email confirmation never enroll automatically. Without a choice the existing `/learn` destination remains unchanged.
4. Review the current account and exact requirements, then explicitly confirm local enrollment. My courses shows the saved receipt, exact-version started/self-assessed activity and links to existing learning/work. Enrollment and reading award no mastery, credit or completion.
5. Inspect the private receipt or download `program-enrollment.json`. This supplemental export is linked from My courses; the existing general export format is unchanged.

Selection lasts up to 15 minutes in a signed HttpOnly cookie, SameSite=Lax and Secure on HTTPS. It contains public versions/digest/expiry only. An expired, missing, duplicate or altered choice requires choosing again. Losing an account cookie does not recover an account from a program choice: recover deliberately or create a new account deliberately. On another device, complete ordinary same-account email recovery and reopen the public term to choose again. Cross-device cookie transfer is not promised.

An account already enrolled in this exact term sees its existing receipt instead of consuming another place, even if inventory later closes. Different students cannot read one another's receipts or original-key results. Term closure or source unavailability retains the private receipt and original learning history. Current course access still obeys ordinary publication/version rules; a receipt does not grant access to retired content or silently count a newer version. Account erasure cascades the enrollment and denies stale receipt/download/inspection routes.

## Local administrator and publication

The migration creates one not-open inventory record, not members, enrollments, staff, progress or published lessons. The trusted program definition in `src/program-values.ts` and the exact migration snapshot bind one program/term version to six ordinary reviewed foundation lesson versions.

Use the existing ordinary content workflow: an editor imports the hash-checked version-2 pack as drafts, a distinct current reviewer confirms source/rights review, and an editor publishes each exact version. Import alone does not open enrollment. All canonical payload fields must match; a copied source-digest suffix is insufficient.

An existing current finite `platform_admin` in demo/test mode can open `/operator/programs` through the normal browser, inspect the trusted inventory and explicitly confirm opening. It does not provision staff or publish content. The inventory goes from `not_open` revision1 to `open` revision2, and explicit closure to terminal `closed` revision3. There is no arbitrary curriculum/capacity editor, automatic date, reopening or paid switch. State/digest/revision mismatch asks for a fresh inspection.

The fixed **20-record simulation admission limit** is a local operational bound, not real seats or staff capacity. Each account may own at most one receipt for this prototype. Concurrent attempts for the last place have one winner; two keys for the same already-enrolled account return the same receipt. The original key cannot be reused for changed intent.

Production/live mode refuses simulated enrollment and administration. This slice adds no provider, hosted enablement, email sender, billing configuration or deployment change. A dedicated developer demonstration uses new invented data and finite invented roles on existing authorized local resources. Existing previews, staff and test databases must not be reset or silently renewed.

## Failure and recovery

Availability is current metadata: not open, closed, full, course unavailable, ready or temporarily unavailable. A database outage is not an empty roster or an assertion that a term closed. New enrollment rechecks the original current member bearer, nondeleting workspace, exact reviewed/current course versions and term revision under ordered locks. Signout/recovery token rotation, expiry, account deletion and source changes cannot be bypassed with an old confirmation.

After an uncertain COMMIT or connection release, the response is **unconfirmed**. Keep the original enrollment key and use **Inspect original enrollment**, a read-only GET. Inspection may find the committed own receipt or honestly find none. It never submits, creates a replacement key or proves rollback. Inspect My courses before choosing another explicit action; no automatic POST replay occurs. Admin uncertainty similarly asks for `/operator/programs` inspection before another explicit command. Raw database errors and private server details are not shown.

The admission transaction locks original member principal, nondeleting workspace, the catalog table in SHARE mode, then the exact inventory row before own receipts. The brief catalog lock fences newer-version INSERT/publication and retirement as well as changes to selected rows. It can delay editorial writes within the existing finite query/transaction budgets. Inventory generation updates also reject stale repeatable-read admission snapshots. No callback/provider work runs while locks are held; all authority is checked again against database time before handback. Administrative opening follows staff principal/profile, catalog and inventory order; closure does not acquire a later catalog lock.

Only the minimal owning-workspace enrollment and immutable source references are stored. Enrollment stores no email, private exercise/assignment copy, payment facts or staff identity. The fixed JSON download uses an explicit nested whitelist, no-store and nosniff; private/internal database fields and idempotency keys are excluded. Existing exercises, submissions, feedback and general exports are not rewritten.

## Evidence and boundaries

PROGRAM-01–03/05/15 map to ENR-01–07. Three critical journeys L254/L255/L256 exercise the complete new/returning/failure sequence for general learners, professionals outside IT and IT practitioners on the existing desktop/mobile projects. Original journey entries and all full-MVP objects remain intact. Native PostgreSQL cases cover last-place and same-account races, catalog publication/retirement and closure in both orders, bearer rotation/deletion/expiry, and actual committed/noncommitted/release uncertainty. Deterministic test email stays inside the test process; no message is sent externally.

Passing tests are not independent review, a launched program, staffed support, a complete academic term or whole-parent acceptance. Monthly-versus-installment relationship, amounts/currency, academic workload/calendar, real capacity, course feedback/support integration, cancellation/refunds and paid access remain future explicit scope. The owner’s production parking remains in force.

After verified-main delivery, its dedicated demonstration receipt records the actual source revision, owned database/storage, finite roles, observed browser stages/captures and guarded preview restart. Reuse that receipt rather than relabelling a component fixture as the product demonstration.
