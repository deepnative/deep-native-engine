BEGIN;
-- Historical UUIDs deliberately have no evidence/grant foreign keys: deleting
-- evidence or a grant must not erase a staff access event while its workspace exists.
ALTER TABLE authorization_audit
 ADD COLUMN IF NOT EXISTS evidence_id uuid,
 ADD COLUMN IF NOT EXISTS assignment_grant_id uuid;
ALTER TABLE authorization_audit DROP CONSTRAINT IF EXISTS authorization_audit_action_check;
ALTER TABLE authorization_audit ADD CONSTRAINT authorization_audit_action_check
 CHECK(action IN ('grant_created','grant_revoked','workspace_read','support_content_read',
                  'evidence_link_issued','evidence_bytes_loaded'));
ALTER TABLE authorization_audit DROP CONSTRAINT IF EXISTS authorization_audit_evidence_action_check;
ALTER TABLE authorization_audit ADD CONSTRAINT authorization_audit_evidence_action_check CHECK(
 (action IN ('evidence_link_issued','evidence_bytes_loaded')
   AND actor_id=staff_id AND evidence_id IS NOT NULL AND assignment_grant_id IS NOT NULL
   AND ((grant_type='assignment' AND grant_id=assignment_grant_id) OR grant_type='evidence_review'))
 OR (action NOT IN ('evidence_link_issued','evidence_bytes_loaded')
   AND evidence_id IS NULL AND assignment_grant_id IS NULL)
);
-- Existing IDs, action types and times are untouched. No historical access is inferred.
INSERT INTO schema_migrations(version) VALUES(36) ON CONFLICT DO NOTHING;
COMMIT;
