BEGIN;
-- MANPAY: staff-recorded receipts and refunds stay separate, provider-free events.
ALTER TABLE simple_invoices ADD COLUMN IF NOT EXISTS refunded_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE simple_invoices DROP CONSTRAINT IF EXISTS simple_invoices_refunded_within_paid;
ALTER TABLE simple_invoices ADD CONSTRAINT simple_invoices_refunded_within_paid CHECK(refunded_cents BETWEEN 0 AND paid_cents);
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'receipt';
-- Every migration re-runs at each start; 107 widens this, and its rows must survive a restart.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=107) THEN
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_kind;
ALTER TABLE simple_invoice_payments ADD CONSTRAINT simple_invoice_payments_kind CHECK(kind IN ('receipt','refund'));
END IF;
END $$;
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS verification text NOT NULL DEFAULT 'manual_unverified';
-- Every migration re-runs at each start; 107 widens this, and its rows must survive a restart.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=107) THEN
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_unverified;
ALTER TABLE simple_invoice_payments ADD CONSTRAINT simple_invoice_payments_unverified CHECK(verification='manual_unverified');
END IF;
END $$;
-- Receipts recorded before this migration keep no reference and stay unedited.
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS evidence_reference text;
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_evidence;
ALTER TABLE simple_invoice_payments ADD CONSTRAINT simple_invoice_payments_evidence
 CHECK(evidence_reference IS NULL OR length(btrim(evidence_reference)) BETWEEN 1 AND 200);
CREATE OR REPLACE FUNCTION require_simple_invoice_payment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_reference IS NULL THEN RAISE EXCEPTION 'Manual invoice events need an evidence reference'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_payment_evidence ON simple_invoice_payments;
CREATE TRIGGER simple_invoice_payment_evidence BEFORE INSERT ON simple_invoice_payments
 FOR EACH ROW EXECUTE FUNCTION require_simple_invoice_payment_evidence();
CREATE OR REPLACE FUNCTION preserve_simple_invoice_money() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.paid_cents<OLD.paid_cents OR NEW.refunded_cents<OLD.refunded_cents
 THEN RAISE EXCEPTION 'Recorded invoice totals cannot decrease'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_money_preserved ON simple_invoices;
CREATE TRIGGER simple_invoice_money_preserved BEFORE UPDATE OF paid_cents,refunded_cents ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION preserve_simple_invoice_money();
-- MANPAY-09: refunds join staff change history; the table may be absent on repair paths.
-- Every migration re-runs at each start; 107 widens this, and its rows must survive a restart.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=107) THEN
ALTER TABLE IF EXISTS billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE IF EXISTS billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided'));
END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES(106) ON CONFLICT DO NOTHING;
COMMIT;
