-- #832 slice A (owner, 12 November 2026): a platform administrator can change
-- hours a student already saved or submitted, with a reason, but cannot enter
-- hours for a period the student has not started. Each change is kept here,
-- append-only, with the figure it replaced; the student sees it.
BEGIN;
CREATE TABLE IF NOT EXISTS coaching_hours_overrides (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 month text NOT NULL,
 previous_minutes integer NOT NULL CHECK(previous_minutes BETWEEN 0 AND 44640),
 minutes integer NOT NULL CHECK(minutes BETWEEN 0 AND 44640),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 -- What the period was when it was changed, and the revision the change made.
 state text NOT NULL CHECK(state IN ('draft','submitted')),
 revision integer NOT NULL CHECK(revision>1),
 actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(minutes<>previous_minutes),
 UNIQUE(owner_id,month,revision),
 -- OVR832-03: no change record without hours the student saved themselves.
 -- Only the student's own save creates a coaching_months row.
 CONSTRAINT coaching_hours_overrides_started_period
  FOREIGN KEY(owner_id,month) REFERENCES coaching_months(owner_id,month)
);
CREATE INDEX IF NOT EXISTS coaching_hours_overrides_owner_idx
 ON coaching_hours_overrides(owner_id,month,created_at);
DROP TRIGGER IF EXISTS coaching_hours_overrides_immutable ON coaching_hours_overrides;
CREATE TRIGGER coaching_hours_overrides_immutable BEFORE UPDATE OR DELETE ON coaching_hours_overrides
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
-- Staff change history names who changed a student's hours and when; the
-- reason stays on the record above. Migration 110 is guarded on this one.
-- Every migration re-runs at each start; 141 widens this, and its rows must survive a restart.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=141) THEN
ALTER TABLE billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','hours_overridden','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided','test_payment_received','test_payment_failed','test_refund_recorded'));
END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(140) ON CONFLICT DO NOTHING;
COMMIT;
