BEGIN;
CREATE TABLE IF NOT EXISTS administrator_sessions (
 staff_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 member_token_hash text NOT NULL CHECK(member_token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS administrator_sessions_current
 ON administrator_sessions(member_id,member_token_hash) WHERE revoked_at IS NULL;
-- Preserve historical profiles; every application read uses this shared fence.
CREATE OR REPLACE VIEW authorized_staff_profiles AS
 SELECT s.* FROM staff_profiles s
 WHERE s.role<>'platform_admin' OR EXISTS(
   -- Materialization preserves the same member → workspace → identity → binding
   -- lock order as member signout and explicit administrator ending.
   WITH owner AS MATERIALIZED (
     SELECT m.id,m.token_hash,m.expires_at FROM principals m
     WHERE m.id=(SELECT a.member_id FROM administrator_sessions a WHERE a.staff_id=s.principal_id)
       AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()
     FOR SHARE OF m
   ), workspace AS MATERIALIZED (
     SELECT w.id FROM workspaces w JOIN owner m ON m.id=w.owner_principal_id
     WHERE w.deleting_at IS NULL FOR SHARE OF w
   ), identity AS MATERIALIZED (
     SELECT e.principal_id FROM member_email_identities e
     JOIN owner m ON m.id=e.principal_id CROSS JOIN workspace w
     WHERE e.email_hash IN ('bb8f295272d8b7075a8d665e68562ce2d66f7f30d4c04106b29557b72edbb6eb','60fac5e61836a4f8c9a0ec19d10d33eaf8a454959d64a211a6c1f049f79c34a4')
     FOR SHARE OF e
   )
   SELECT 1 FROM administrator_sessions a
   JOIN principals staff ON staff.id=a.staff_id
   JOIN owner m ON m.id=a.member_id
   JOIN identity e ON e.principal_id=m.id
   WHERE a.staff_id=s.principal_id AND a.revoked_at IS NULL
     AND a.expires_at>=staff.expires_at AND m.expires_at>=staff.expires_at
     AND a.expires_at>clock_timestamp() AND m.token_hash=a.member_token_hash
   FOR SHARE OF a
 );
INSERT INTO schema_migrations(version) VALUES(83) ON CONFLICT DO NOTHING;
COMMIT;
