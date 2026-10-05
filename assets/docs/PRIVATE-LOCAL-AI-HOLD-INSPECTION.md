# Assigned local request hold inspection

This private local tool lets a currently assigned operator read a held deterministic test request's safe metadata. The member continues to see their own held receipt and test-unit balance. Reading does not run, retry, settle, refund or release anything. A database-observed expired running claim is displayed as **outcome unconfirmed**; elapsed time does not establish execution. External outcome lookup and resolution remain separately gated in [#189](https://github.com/deepnative/deep-native-engine/issues/189).

## Explicit access and operation

Inspection is disabled by default. In an isolated invented-data local test environment, set `DNE_LOCAL_AI_HOLD_INSPECTION=enabled` and restart the compatible application. No live mode is supported. A current platform administrator must assign a distinct current operator to one exact owned metered local job with purpose `local-ai-hold-inspection-test-v1`. Being an operator or knowing a job reference grants no access. An assignment creates no source/evidence permission, allowance, provider access or staff role.

Use the existing private local admin procedure (`npm run support:local-admin -- bootstrap`) only when its administrator/operator credential files do not exist. Bootstrap preserves existing files and creates expiring credentials in a directory owned by the current OS user, mode0700; all credential/instruction files must be mode0600. Never paste credentials into issues, browser URLs, logs or captures. This is an invented-data operational fixture, not a staffing or hosting system.

An instruction file inside the configured private storage's `support-admin` directory has exactly four fields:

```json
{
  "jobId": "exact-owned-local-job-uuid",
  "idempotencyKey": "stable-new-instruction-uuid",
  "startsAt": "explicit-UTC-validity-start",
  "expiresAt": "explicit-UTC-validity-end"
}
```

These placeholders are not executable values. Use a current, finite validity window no later than either current administrator or operator expiry. Obtain the exact invented job reference through its owner's retained local simulation export or controlled fixture; there is no cross-member discovery endpoint. Run `npm run support:local-admin -- hold-grant instruction.json`. The command reads private administrator/operator credentials, checks current role and owner/workspace/job/unit linkage, and returns only a completion status, action and grant reference. Repeating the exact stable instruction returns its original grant without another event; changing its contract conflicts. The grant reference is a private revocation receipt, not permission for browser reads.

The assigned operator opens `/operator/local-ai-holds` with their current local staff session. Each page has at most20 assigned unconfirmed held jobs and, when needed, an authenticated actor/purpose-bound continuation. Detail and fresh links independently recheck current authority. Other members, unassigned operators and administrators cannot use the inspection endpoint to read the job. Invalid navigation gives400, absent authority403, and unavailable/uncertain confirmation503; each response is `no-store` and contains no private diagnostic.

Revoke with a private instruction containing only `{"grantId":"exact-private-grant-uuid"}` using `npm run support:local-admin -- hold-revoke instruction.json`. Current administrator authority remains required. Revocation and its immutable content-free event commit together; replay adds nothing. Revocation remains available while inspection/new grants are disabled. A new browser read after revocation is denied; a previously rendered page is historical and cannot be remotely erased.

## Data and privacy boundary

The browser displays only local job reference, fixed status/state descriptions, recorded timestamps/claim deadline, fixed local policy/prompt/model contracts and test-unit state. It does not show member/workspace/evidence/receipt/reservation/grant identities, names, source/output text, request fingerprints, provider references, raw errors, credentials or free-text reasons. There are no mutation forms or arbitrary member filters.

Current principals and roles, available owner workspaces, jobs and exact purpose grants are fenced in consistent order. Each selection is repeated under those fences; validity is checked through SQL, commit acknowledgement and native connection handback. Reads use the existing bounded transaction lifetime: three-second acquisition, five-second command/lock limit and ten-second operation limit. An uncertain or late response withholds the snapshot rather than replaying it or claiming an outcome.

Source withdrawal, revision and deletion do not turn a previously started unknown request into a confirmed failure. Retained content-free job/unit linkage can still be inspected under a current exact metadata assignment without joining or regaining its removed source. Full member erasure cascades their jobs, metered links, inspection grants and events; stale reads deny and other members remain separate. Staff-principal erasure removes assignments to that principal; administrator deletion nulls historical issuer/actor references. No provider-side erasure is implied.

## Additive migration and rollback

Migration059 adds exact-purpose grants and immutable grant/revoke events, with owned metered job/member linkage and purpose/current staff constraints. No legacy job or staff principal receives an inferred grant. Reapplying migrations preserves history. Index/constraint/trigger setup can take table locks: stop affected local workers and inspect the actual environment before applying. No production migration performance claim is made.

To pause, set `DNE_LOCAL_AI_HOLD_INSPECTION=disabled` and restart the compatible process. New reads/grants become unavailable; authorized private revocation still works. Keep migration059 and retained grants/events in place. Disable inspection before an application downgrade; retain compatible revocation tooling and metered-job safety constraints. Do not drop populated tables, delete audit history, reset claims, infer refunds or redispatch unknown jobs. Inspection pause is separate from the existing local queue/dispatch pause control.

[Design and behavioral evidence](CTP-014-HOLD-INSPECTION-EVIDENCE.md) is linked to [delivery #473](https://github.com/deepnative/deep-native-engine/issues/473) covers this private metadata outcome. Parent#189/#31/#42 remain open for their other criteria. Automated local evidence and a later invented-data demo do not establish qualified review, external execution, accepted full-MVP behavior or deployment.
