BEGIN;
-- #318 under the owner's 9 Nov 2026 decisions: an administrator issues one
-- invoice for a student's coaching-terms version (#316, migration 126). One
-- invoice that isn't void per version; the link can't change once issued. No
-- foreign key: the terms leave with a deleted account, the invoice is retained
-- and its document keeps the version and dates.
ALTER TABLE simple_invoices ADD COLUMN IF NOT EXISTS coaching_terms_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS simple_invoice_one_terms_version
 ON simple_invoices(coaching_terms_id)
 WHERE coaching_terms_id IS NOT NULL AND void_reason IS NULL;
CREATE OR REPLACE FUNCTION preserve_coaching_terms_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coaching_terms_id IS DISTINCT FROM OLD.coaching_terms_id THEN RAISE EXCEPTION 'Invoiced coaching terms are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS coaching_terms_invoice_immutable ON simple_invoices;
CREATE TRIGGER coaching_terms_invoice_immutable BEFORE UPDATE OF coaching_terms_id ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_terms_invoice();
ALTER TABLE IF EXISTS billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE IF EXISTS billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided','test_payment_received','test_payment_failed','test_refund_recorded','terms_invoice_issued'));
INSERT INTO schema_migrations(version) VALUES(132) ON CONFLICT DO NOTHING;
COMMIT;
