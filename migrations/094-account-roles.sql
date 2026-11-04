BEGIN;
-- #673 Account types. Every account is a student; coach and admin are held
-- by verified email (a hash, never the address). Seeded once for the two
-- approved owners; a role removed later is not restored on the next start.
CREATE TABLE IF NOT EXISTS account_roles (
 email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 role text NOT NULL CHECK(role IN ('coach','admin')),
 PRIMARY KEY(email_hash, role)
);
INSERT INTO account_roles(email_hash, role)
SELECT encode(sha256(convert_to(address, 'UTF8')), 'hex'), role
  FROM unnest(ARRAY['shi@deepnative.io','tom@deepnative.io']) AS address
 CROSS JOIN unnest(ARRAY['coach','admin']) AS role
 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=94)
ON CONFLICT DO NOTHING;
-- ROLES-06: the shared administrator fence (083) now reads the stored admin
-- role instead of two fixed hashes; removing a role ends current sessions too.
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
     WHERE e.email_hash IN (SELECT r.email_hash FROM account_roles r WHERE r.role='admin')
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
INSERT INTO schema_migrations(version) VALUES(94) ON CONFLICT DO NOTHING;
COMMIT;
