BEGIN;
-- Shared evidence-upload admission. State lives in PostgreSQL so a restart or
-- second application instance cannot reset a limit. No IP, cookie, filename or
-- content is stored; member rows are deleted with the member's principal.
CREATE TABLE IF NOT EXISTS upload_admission_windows (
 pool text NOT NULL CHECK(pool IN ('global','unauthenticated','member')),
 principal_id uuid REFERENCES principals(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 admitted integer NOT NULL CHECK(admitted>0),
 CHECK((pool='member')=(principal_id IS NOT NULL)),
 UNIQUE NULLS NOT DISTINCT(pool,principal_id,window_start)
);
CREATE INDEX IF NOT EXISTS upload_admission_windows_age
 ON upload_admission_windows(window_start);
CREATE TABLE IF NOT EXISTS upload_admission_leases (
 id uuid PRIMARY KEY,
 principal_id uuid REFERENCES principals(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_admission_leases_active
 ON upload_admission_leases(principal_id,expires_at);
CREATE INDEX IF NOT EXISTS upload_admission_leases_expiry
 ON upload_admission_leases(expires_at);
-- Operator diagnosis signal: hourly counts by reason only.
CREATE TABLE IF NOT EXISTS upload_admission_denials (
 hour_start timestamptz NOT NULL,
 reason text NOT NULL CHECK(reason IN (
   'member_rate','member_concurrency','unauthenticated_rate',
   'global_rate','global_concurrency'
 )),
 denied integer NOT NULL CHECK(denied>0),
 PRIMARY KEY(hour_start,reason)
);
INSERT INTO schema_migrations(version) VALUES(85) ON CONFLICT DO NOTHING;
COMMIT;
