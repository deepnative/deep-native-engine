BEGIN;
-- #684 COACHLINK-01/03: one coach per learner, assigned by an administrator.
-- The coach is a verified email hash holding the coach role, so removing the
-- role removes that coach's assignments.
CREATE TABLE IF NOT EXISTS coach_assignments (
 learner_id uuid PRIMARY KEY REFERENCES learners(id) ON DELETE CASCADE,
 coach_email_hash text NOT NULL,
 coach_role text NOT NULL DEFAULT 'coach' CHECK(coach_role='coach'),
 assigned_by uuid NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(coach_email_hash, coach_role)
   REFERENCES account_roles(email_hash, role) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coach_assignments_coach
 ON coach_assignments(coach_email_hash);
-- ROLEADMIN-05 / COACHLINK-04: who changed a role or assignment, and when.
CREATE TABLE IF NOT EXISTS account_role_events (
 id bigserial PRIMARY KEY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('granted','removed','assigned','cleared')),
 email_hash text CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 role text CHECK(role IN ('coach','admin')),
 learner_id uuid,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((action IN ('granted','removed')) = (role IS NOT NULL AND email_hash IS NOT NULL AND learner_id IS NULL)),
 CHECK((action IN ('assigned','cleared')) = (learner_id IS NOT NULL AND role IS NULL)),
 CHECK(action<>'assigned' OR email_hash IS NOT NULL)
);
INSERT INTO schema_migrations(version) VALUES(95) ON CONFLICT DO NOTHING;
COMMIT;
