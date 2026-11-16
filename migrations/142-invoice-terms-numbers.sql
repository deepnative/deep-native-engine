-- #856 (owner, 16 November 2026): new invoices carry payment terms, a due date
-- and a short number from a gapless counter: INV-0001 onward for real
-- invoices and SAMPLE-0001 onward for samples, so a sample never takes a real
-- number. The counter row is updated inside the issuing transaction, so a
-- rolled-back or failed issue uses no number. Existing invoices keep their
-- DN- numbers and have no due date. Every migration re-runs at each start, so
-- this file only adds or replaces.
BEGIN;
CREATE TABLE IF NOT EXISTS simple_invoice_numbers (
 series text PRIMARY KEY CHECK(series IN ('real','sample')),
 next integer NOT NULL CHECK(next>0)
);
INSERT INTO simple_invoice_numbers(series,next) VALUES('real',1),('sample',1)
 ON CONFLICT DO NOTHING;

-- An administrator issued the invoice from the student's saved draft. The
-- reason is shown to the student and in their records, never printed on the
-- invoice. The administrator is named only in staff change history.
CREATE TABLE IF NOT EXISTS coaching_admin_issues (
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 month text NOT NULL,
 revision integer NOT NULL CHECK(revision>1),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,month,revision)
);

-- Staff change history gains an invoice issued from the student's saved draft.
ALTER TABLE billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','hours_overridden','billing_period_set','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided','test_payment_received','test_payment_failed','test_refund_recorded','issued_from_draft'));
INSERT INTO schema_migrations(version) VALUES(142) ON CONFLICT DO NOTHING;
COMMIT;
