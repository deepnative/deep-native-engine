# Private sample support

Issue [#427](https://github.com/deepnative/deep-native-engine/issues/427) delivers a local support conversation for invented information. A member submits a subject and request, follows actual receipt/acknowledgement/resolution timestamps and reads deliberately member-visible operator replies. Internal notes are a separate staff-only action. Reading, noting, replying and resolving never imply acknowledgement. Resolution without acknowledgement is valid and visibly labelled. No staffed response deadline, paid entitlement, expert capacity or live support obligation is established; coverage stays **Unverified**.

## Privacy and lifecycle

Only the owner reads the member receipt/history. An active staff actor requires an exact request/role/purpose/time-bound grant for every operator read and mutation; administrator role alone is insufficient. The existing workspace support grants are unchanged. Request text stays until owner withdrawal or account deletion. Withdrawal removes the subject/body, notes/replies and mutation replay records atomically, keeping a content-free lifecycle receipt and immutable content-free events. Withdrawn requests cannot accept or replay content. Account deletion cascades the request and its five child tables. Already downloaded copies and hosted backup erasure are outside this local preview.

Acknowledgement and resolution are independent, immutable first transitions. Notes/replies are append records. Each mutation has an actor/request/action-specific UUID key. Before resolution, exact replay returns the persisted result; changed payload conflicts. On a resolved request only exact resolution replay is permitted, under current authority. Repeated intake also conflicts after resolution; owner receipt lookup remains available for recovery. Old acknowledgement/note/reply keys conflict. Expired/revoked authority never replays successfully. An uncertain result is not confirmation; inspect the durable receipt before another action. No automatic retry occurs.

Subject limits are 120 UTF-16 units; request/note/reply limits are 2,000. Accepted text is preserved exactly. Blank text, NUL, malformed surrogate strings and oversized input are rejected. Support forms have a dedicated 32-KiB encoded-body bound so a valid 2,000-character Chinese request is accepted; other forms retain their existing limits. SQL bounds use built-in declarative CHECKs. The schema's immutability guards have PostgreSQL behavioral tests, not a claim of V8-measured SQL coverage.

History/worklists/message lists have keyset pages of 20 plus lookahead. Member message pages query only replies; internal notes do not affect member counts, timestamps, ordering or cursors. Operator pages show explicit visibility labels. Multi-owner worklists discover only bounded metadata, lock every participating principal in stable order before downstream locks, and fail the whole page if authorization changes. They do not fill gaps with unbounded queries. Protected reads/transition success require content-free audit and final database-clock expiry checks before commit.

Structured export `local-member-records-v14` appends `supportRequests` and `supportReplies` at cursor-v2 indices 19 and 20. Earlier section meanings remain unchanged. Member export excludes internal notes, staff identity/grants/events and mutation receipts. Direct reply continuation locks owned request parents before text projection. Each live page remains bounded by 100 records and 256 KiB; collect every page and restart if data changes.

## Trusted local operator setup

This is an explicit maintenance boundary for a loopback demo/test database, not an HTTP identity or grant endpoint. Never use real member information. Run `make setup` first and start the local preview with `make dev`. Its private storage directory defaults to `.dne-private/evidence`; preserve your configured `DNE_PRIVATE_STORAGE_ROOT` if different.

```sh
npm run support:local-admin -- bootstrap
```

This creates one-hour administrator/operator credentials in the private storage directory's `support-admin/admin.json` and `operator.json`. The command rejects symlinked, wrongly owned, non-directory, non-0700 or noncanonical credential directories before provisioning. Files are created with mode 0600 and never overwritten. Existing credentials stop bootstrap before provisioning. Tokens are never printed. Grant/revoke commands read the current administrator token from the private file and authorize it against PostgreSQL. An expired credential is not renewed automatically; preserve old records and use a separately controlled new local preview if you need fresh bootstrap identities.

After the member creates a request, put its receipt ID and a new UUID key in a private `support-admin/grant.json` instruction. All four fields are required; no caller-supplied administrator identity or role is accepted:

```json
{
  "requestId": "REPLACE_WITH_RECEIPT_UUID",
  "idempotencyKey": "REPLACE_WITH_NEW_UUID",
  "startsAt": "REPLACE_WITH_CURRENT_UTC_ISO_TIME",
  "expiresAt": "REPLACE_WITH_UTC_TIME_BEFORE_STAFF_EXPIRY"
}
```

Create the file with restrictive permissions before filling it; keep it outside public assets. Grant instructions and credentials must be regular files owned by the invoking OS user with mode 0600. Do not put credential values in arguments, URLs, source, issues or logs.

```sh
npm run support:local-admin -- grant grant.json
```

The command prints only the confirmed grant ID. Exact repeated instructions reuse that result; a changed payload under the key conflicts. A grant is never automatic on intake. Create `support-admin/revoke.json`, mode 0600, containing only `{"grantId":"REPLACE_WITH_GRANT_UUID"}`, then:

```sh
npm run support:local-admin -- revoke revoke.json
```

The operator browser must use a separate browser context from the member. For an explicitly local demonstration, the installed Playwright library can load the operator credential file directly into a separate HttpOnly/SameSite=Strict `dne_preview` cookie, then open `/operator/support`. Keep the token in the private file; never paste it in a URL or terminal command. The browser test fixture demonstrates this exact boundary. No staff-login endpoint or remote identity provider is introduced.

## Verification and rollback

L106–L110 add five critical local browser scenarios, each with IT, non-IT professional and general-learner variants on desktop/mobile. Existing scenarios and full-MVP denominators stay intact. Unit tests cover input validation, projections, cursor/replay/error boundaries; real PostgreSQL tests cover immutable transitions, exact grants and controlled waits, pagination, withdrawal/export/deletion races, uncertainty and rollback disconnect. The authoritative issue/PR records actual revisions/results and failures; this document is not a release approval.

Before data exists, revert the additive application/schema together. Once populated, disable new intake/operator mutations while retaining owner history/export/withdrawal/account deletion. Revoke operator grants using current administrator authority. Do not drop tables, restore withdrawn text or use an old binary that omits support export/deletion as a complete rollback.

Parents #195/#39 stay open for named operator/backup, approved Toronto hours/holidays/scope/escalation, live allowance/terms and production retention. Private local interaction does not certify those decisions or authorize deployment.
