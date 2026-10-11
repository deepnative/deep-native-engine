# Private review-minute permissions

This local administrator screen lets a member and a separately assigned reviewer
use an existing private review-minute allocation through their browsers. It does
not issue minutes, assign a reviewer to source content, or establish qualified or
paid review. Use invented samples in an isolated preview.

## Member → administrator → reviewer

1. The member queues their clean invented sample for local review and explicitly
   reserves existing review test minutes. Their receipt displays an ordinary
   **Allocation reference**. Reserving minutes grants no staff access.
2. A current reviewer signs in through the staff form and opens their own review
   reference. The reference is an identifier, not their protected credential.
3. With local administration enabled, a current platform administrator signs in
   and opens **Private review-minute permissions**. They enter the exact supplied
   allocation and reviewer references, then **Check exact references**.
4. The administrator checks the finite UTC window and deliberately checks the
   initially unchecked confirmation before **Grant review-minute permission**.
   The window cannot outlive the current applicable authority. The receipt shows
   the ordinary permission reference; bounded own history contains safe metadata
   and no source text, filename, staff credential or member directory.
5. The reviewer still needs separately current workspace and exact-source
   feedback permission. Once all prerequisites hold, they can explicitly begin
   the reserved review and publish their own feedback with bounded simulated
   preparation/review effort. Existing settlement returns unused test minutes.

The member keeps their private receipt and feedback. Granting permission alone
does not begin work or consume, return or replenish any test minutes.

## Exact revocation and overlapping grants

Only the creating current administrator can inspect their permission receipt and
confirm **Revoke this exact permission**. Revocation affects that one permission;
another applicable overlapping permission remains separate. When no applicable
time permission remains, fresh timed access is denied. Held units and earlier
accounting are retained; revocation is not an automatic refund.

Each successfully recorded browser revocation retains its own durable receipt and
original outcome, `revoked` or `unchanged`. Repeating the same original instruction
returns that retained outcome without a duplicate revocation or audit. An
earlier confirmed operation may observe `unchanged` if another operation already
revoked the permission. That observation does not invent another actual
revocation. A receipt already showing revocation offers no new revoke action.

## An action's reply is unavailable

An unavailable reply can occur after a write actually committed. The recovery
screen retains the original hidden operation and offers **Inspect saved
permission in a new tab** or **Inspect saved revocation in a new tab**. Inspection
checks current authority and reads the original outcome without dispatching the
write. It opens without access to the original browser tab.

If inspection finds no retained outcome, that does not establish that no write
committed: erasure, expiry or lost authority can make it unavailable. A deliberate
retry keeps the original instruction and requires a fresh unchecked confirmation.
Changed instructions under the same operation conflict. There is no automatic
retry or provider call. Hidden operation identifiers stay out of URLs and member
exports; normal staff sign-in credentials must stay out of screenshots and traces.

## Configuration, legacy data and rollback

`DNE_REVIEW_TIME_GRANT_ADMINISTRATION` accepts:

- `disabled` (default): deny all new administration routes.
- `enabled`: allow freshly authorized check, creation, own history, original
  inspection and exact revocation.
- `recovery-only`: deny new check/creation while retaining freshly authorized own
  history, original inspection and explicitly confirmed exact revocation. The
  staff entry link remains discoverable for these retained operations.

Existing review writes use their separate `DNE_REVIEW_TIME_WRITES` setting. Live
application mode cannot use this private administration feature.

Migration 068 adds metadata-only original browser revocation receipts. It does
not backfill legacy revocations or change existing internal writer contracts.
Legacy grants retain their ordinary receipts and original creation identity;
legacy revocations remain observed legacy state, not invented browser operations.
Owner erasure removes the linked permission/operation records under the existing
account and workspace erasure rules. Migration 069 repairs normal source cleanup
for an explicitly deleting workspace, including retry after cleanup was
unconfirmed. It marks only the deleting source unavailable before removing its
links; it creates no accounting event, refund or settlement.

For a creation rollback, use `recovery-only` and retain the migration/records.
Do not drop grants or operation metadata, automatically release held units, or
reinterpret a lost reply as rollback. `disabled` also withholds recovery access.

## Acceptance evidence

[Issue #501](https://github.com/deepnative/deep-native-engine/issues/501) maps
REVIEW-GRANT-01–07 to executable tests. Existing L145–L147 retain publication,
settlement, private feedback and source-withdrawal assertions while using normal
administrator grant screens. L201–L203 cover original committed create/revoke
recovery, exact overlapping revocation, retained accounting, creator privacy,
configuration rollback and owner erasure for all three audiences and both
registered Chromium viewports. PostgreSQL tests cover transaction, deadline,
legacy, immutable-history and contention boundaries. A scenario description or
this guide is not a test pass or full-MVP acceptance; exact revision, results and
the runnable milestone demo belong in the issue's delivery evidence.
