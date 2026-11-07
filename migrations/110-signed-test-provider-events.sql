BEGIN;
-- TESTPAY: signed test events share the invoice event table. A row may say it came
-- from a signed test event; nothing may say a payment provider verified it.
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS provider_event_id text;
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS provider_payment_ref text;
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS provider_event_type text;
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS provider_event_digest text;
ALTER TABLE simple_invoice_payments ADD COLUMN IF NOT EXISTS provider_occurred_at timestamptz;
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_kind;
ALTER TABLE simple_invoice_payments ADD CONSTRAINT simple_invoice_payments_kind CHECK(kind IN ('receipt','refund','failure','held'));
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_unverified;
ALTER TABLE simple_invoice_payments DROP CONSTRAINT IF EXISTS simple_invoice_payments_verification;
ALTER TABLE simple_invoice_payments ADD CONSTRAINT simple_invoice_payments_verification CHECK(
 (verification='manual_unverified' AND kind IN ('receipt','refund')
  AND provider_event_id IS NULL AND provider_payment_ref IS NULL AND provider_event_type IS NULL
  AND provider_event_digest IS NULL AND provider_occurred_at IS NULL)
 OR
 (verification='signed_test_event' AND kind IN ('receipt','refund','failure','held') AND actor_id IS NULL
  AND provider_event_id IS NOT NULL AND provider_payment_ref IS NOT NULL
  AND provider_event_type IN ('payment.succeeded','payment.failed','refund.succeeded')
  AND provider_event_digest ~ '^[a-f0-9]{64}$' AND provider_occurred_at IS NOT NULL));
-- A held refund later gains its applied row, so one event has at most one row of each kind.
CREATE UNIQUE INDEX IF NOT EXISTS simple_invoice_payments_provider_event
 ON simple_invoice_payments(provider_event_id,kind) WHERE provider_event_id IS NOT NULL;
CREATE OR REPLACE FUNCTION require_simple_invoice_payment_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_reference IS NULL THEN RAISE EXCEPTION 'Manual invoice events need an evidence reference'; END IF;
 IF NEW.verification='signed_test_event'
  AND NOT EXISTS(SELECT 1 FROM simple_invoices WHERE id=NEW.invoice_id AND sample)
 THEN RAISE EXCEPTION 'Signed test events apply to sample invoices only'; END IF;
 RETURN NEW;
END $$;
-- TESTPAY-10: no staff member acts on a signed test event, so none is named.
ALTER TABLE IF EXISTS billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_action_check;
ALTER TABLE IF EXISTS billing_change_events ADD CONSTRAINT billing_change_events_action_check
 CHECK(action IN ('plan_offered','rate_set','hours_returned','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','payment_refunded','invoice_voided','test_payment_received','test_payment_failed','test_refund_recorded'));
ALTER TABLE IF EXISTS billing_change_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE IF EXISTS billing_change_events DROP CONSTRAINT IF EXISTS billing_change_events_actor;
ALTER TABLE IF EXISTS billing_change_events ADD CONSTRAINT billing_change_events_actor
 CHECK((actor_id IS NULL)=(action IN ('test_payment_received','test_payment_failed','test_refund_recorded')));
INSERT INTO schema_migrations(version) VALUES(110) ON CONFLICT DO NOTHING;
COMMIT;
