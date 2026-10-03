# Invented local circle discussion

Scope: [#443](https://github.com/deepnative/deep-native-engine/issues/443), supporting #40 and #196/#39. This is an explicitly enabled local sandbox with invented information, unreviewed peer replies and synthetic moderator actions. There is no staffed response, appeal, qualified review, public community or commercial service.

## Try the member journey

Run the local preview using the README setup. Set `DNE_CIRCLE_DISCUSSION=enabled` in the local environment and restart the application. The default is disabled; supported application modes remain local demo/test, with loopback PostgreSQL and listener requirements enforced. Use two separate browser profiles for invented learners.

1. Join a suitable circle from Local circles. Join alone grants no discussion access or sharing permission.
2. Open that circle's sharing choice and separately confirm invented-material sharing. The choice applies to the exact circle, fixed `circle-discussion-test-v1` policy and current membership generation.
3. Open Questions, deliberately confirm a question and ask the other learner to add one reply. Text is escaped; private assignments and evidence are never imported. Bodies are immutable: withdraw and explicitly confirm a new contribution to correct text.
4. Save an enum-only private sample report on one visible contribution. Inspect Your sample reports for your own content-free receipt. Authors and ordinary peers cannot inspect reporter identities or the moderator queue.
5. Inspect Your contributions and private structured export. Withdraw text, withdraw sharing permission, leave or delete your preview through the learning dashboard.

A root becoming unavailable removes its entire thread from group reads. A peer's independently owned reply and private report receipt remain theirs until withdrawal/erasure; they contain no copied foreign root body or author identity. Rejoining requires a new sharing choice and never republishes older contributions. Existing legacy joins receive no inferred choice. Known closed membership intervals remain in owned history; intervals never previously recorded cannot be reconstructed.

Retained engineering limits are 200 contributions per owner/circle and 100 replies per root. Withdrawn rows remain counted until erasure. Pages use 20 records plus one bounded lookahead, with signed actor/circle/list/policy/choice or grant continuations. Private exports retain the existing 100-record/256 KiB bounds; v17 appends circle choices, owned contributions, content-free reports and known membership history without changing older section indices. These bounds confer no purchased allowance.

## Trusted local moderator setup

Use an isolated invented-data preview and private storage root. The existing local administrator CLI uses `$DNE_PRIVATE_STORAGE_ROOT/support-admin`, owned directory mode0700 and JSON files mode0600. Credentials stay outside the repository, screenshots, terminal output and browser links. Preserve existing credentials; bootstrap refuses to overwrite them.

With the sandbox enabled, `npm run support:local-admin -- circle-bootstrap` provisions private `admin.json` and `moderator.json` identities. A staff role alone creates no circle grant. If the shared directory already has credentials, do not remove or replace them; use the existing trusted administrator and separately provisioned moderator through the established private operation.

Create a private JSON instruction in that directory, for example `circle-grant.json`, containing only:

```json
{
  "circleId": "everyday-ai",
  "idempotencyKey": "a fresh UUID kept stable for this instruction",
  "expiresAt": "a future ISO UTC time within the moderator principal lifetime"
}
```

Replace the placeholders before executing `npm run support:local-admin -- circle-grant circle-grant.json`. Supported circles are `everyday-ai`, `professional-work` and `technical-practice`. Successful output contains only status/action/grantId. In a separate local browser session authenticated by the private moderator identity, open `/moderate/circles/<circleId>/reports`. Hide/restore requires current principal, current role, an active exact-circle/purpose grant, eligible source, expected revision and stable form key. A withdrawn, departed, expired or obsolete-choice source cannot be restored. The audit contains action/revision/reason, not contribution bodies or reporter text.

To revoke, create a private mode0600 instruction with only `circleId` and the returned `grantId`; run `npm run support:local-admin -- circle-revoke circle-revoke.json`. Revocation remains available while sharing is paused, under a current administrator. Replaying it does not create a second audit action. Bootstrap/grant creation remain disabled during pause.

## Transaction and operation bounds

Discussion writes take the existing circle advisory lock before sorted current principal/workspace locks, then current membership and choice locks, then globally sorted target/root locks. Reads discover at most 21 candidate records before locking their eligible sources; denied candidates are not replaced by extra scans. Departure and erasure preserve the principal/workspace-before-owned-record order. Staff grant creation/revocation uses sorted staff principals and current profiles before the exact grant. Do not introduce a target-before-owner path or separate nested pool transaction.

Connection acquisition is bounded at three seconds, row-lock and statement waits at five seconds, and the whole discussion transaction at ten seconds. Current principals and grants are checked against one database wall-clock instant before commit, accounting for final-query handback time. A timeout or uncertain acknowledgement fails closed; there is no automatic retry. These are local engineering bounds, not a staffed response target or a production performance guarantee.

## Uncertain outcomes and rollback

Forms provide an original-key recovery link. Keep the key privately. A failed acknowledgement means the write may or may not have committed; do not automatically resubmit or generate a replacement key. Check the original-key receipt under current authorization, then inspect owned state. Recovery receipts contain no body/foreign target/reporter identity; an unknown receipt is not proof an earlier operation never committed. Moderator receipts require a current grant. There is no automatic retry.

To pause, remove `DNE_CIRCLE_DISCUSSION=enabled` and restart the compatible application. New choices/posts/replies/reports and moderation writes stop. Current-owner private reads, export, withdrawal and erasure continue; existing report targets are marked unavailable while paused. Trusted grant revocation continues. Pause does not erase data or authorize release.

Migration055 is additive and retained during rollback. Stop incompatible pre055 writers before upgrade or rollback: genuine rejoins must advance membership generation and preserve known leave history, while repeated active joins keep the generation. Do not drop discussion/history tables or their ownership/state guards to make old writers work. Roll back to a compatible application with sharing paused; retain the schema and protected records, verify owner export/withdrawal/erasure and grant revocation, then decide whether to restore the compatible feature. Never revive old sharing choices or copied bodies.

## Evidence boundary

The local unit/integration/browser gates exercise invented fixtures, database constraints, scoped authorization, capacities, current-source visibility, ownership and recovery. A verified-main milestone demo records its actual revision and observed journey separately. Neither tests nor this guide constitute broad-parent/full-MVP acceptance, curriculum/accessibility signoff, staffed moderation or launch approval. Real-community policy, escalation, coverage and qualified decisions remain tracked separately.
