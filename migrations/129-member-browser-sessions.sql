BEGIN;
-- #695 MULTISESSION: an account keeps one sign-in per browser. Each browser's
-- cookie fingerprint gets its own row; the account's own token_hash becomes a
-- random value that no cookie hashes to. Deleting the account deletes the rows.
ALTER TABLE principals ADD COLUMN IF NOT EXISTS separate_sessions boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS member_sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS member_sessions_principal ON member_sessions(principal_id);
-- Existing accounts keep their one signed-in browser: its fingerprint moves to
-- a session row before the account's own value is replaced. This runs once,
-- the first time 129 is applied; afterwards sign-up and email linking do it.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM schema_migrations WHERE version=129) THEN RETURN; END IF;
 WITH accounts AS (
  SELECT p.id,p.token_hash,p.expires_at FROM principals p
  WHERE p.kind='member' AND NOT p.separate_sessions
    AND (EXISTS(SELECT 1 FROM member_email_identities i WHERE i.principal_id=p.id)
      OR EXISTS(SELECT 1 FROM member_login_emails e WHERE e.principal_id=p.id))
  FOR UPDATE OF p
 ), moved AS (
  INSERT INTO member_sessions(token_hash,principal_id,expires_at)
  SELECT token_hash,id,expires_at FROM accounts ON CONFLICT DO NOTHING
 )
 UPDATE principals p
  SET token_hash=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),
      separate_sessions=true
  FROM accounts a WHERE p.id=a.id;
 UPDATE learners l SET token_hash=p.token_hash FROM principals p
  WHERE p.id=l.id AND p.separate_sessions AND l.token_hash<>p.token_hash;
END $$;
-- Administration entered from a browser lasts while that browser's own
-- session does (083/094 bound it to the account's single value).
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
     AND a.expires_at>clock_timestamp()
     AND (m.token_hash=a.member_token_hash OR EXISTS(
       SELECT 1 FROM member_sessions b WHERE b.token_hash=a.member_token_hash
         AND b.principal_id=m.id AND b.expires_at>clock_timestamp()))
   FOR SHARE OF a
 );
INSERT INTO schema_migrations(version) VALUES(129) ON CONFLICT DO NOTHING;
COMMIT;
