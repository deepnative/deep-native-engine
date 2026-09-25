# Local structured member export (#240)

The local preview offers an active member a JSON download at `/api/member/export`. It is a synthetic, current-state snapshot, separate from the evidence source export. A single repeatable-read, read-only PostgreSQL transaction checks the current member session and reads every section for that member ID. It does not accept a member ID from the request. The response is `no-store` and a download attachment.

`local-member-records-v1` includes the profile, exercises, lesson activity, assignment choice and attempts, milestones, opt-in career preferences and plans/drafts, retained private proposals, private practice, and local circle memberships. Sections use stable ordering; timestamps are serialized as UTC by JSON. Withdrawn/rejected proposal text is null because the source rows are redacted. Deleted rows are absent. The export fails with HTTP 413 when more than 100 current rows or 256 KiB would be returned; it never returns a truncated response. Authorization denial is HTTP 403 and storage failure is HTTP 503 with generic errors.

The UI explicitly distinguishes this download from `/api/evidence/export`. Neither endpoint supplies a complete portability response. Structured export excludes evidence objects/bytes, derivatives, audit records, synthetic entitlement/billing data, provider copies and backups. Evidence export separately excludes most structured records. Live privacy, retention, backup expiry and hosted download/job authorization remain unresolved under #40 and PLAN-002. This implementation does not authorize a live community or release.

Verification: real-PostgreSQL tests cover active/expired/revoked and unrelated members, current/deleted/redacted rows, both limits and a concurrent update after snapshot establishment. L61 exercises the owner link, cross-member result and expired denial in desktop/mobile browsers. The repository gate reports exact revision and raw counts in `artifacts/application-verification.json`; attach the PR/main CI results at handoff.

Rollback: remove the route/UI and `memberExportStore` wiring; no schema or data migration is introduced.
