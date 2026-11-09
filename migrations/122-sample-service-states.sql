BEGIN;
-- SVC: a simulated service state on sample invoices, moved only by signed test events.
-- No row means awaiting payment. A row grants nothing and links to no access.
CREATE TABLE IF NOT EXISTS sample_service_states (
 id uuid PRIMARY KEY,
 invoice_id uuid NOT NULL REFERENCES simple_invoices(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('ready','withdrawn')),
 cause_event_id text NOT NULL CHECK(cause_event_id ~ '^[A-Za-z0-9_-]{1,80}$'),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(invoice_id,state)
);
CREATE OR REPLACE FUNCTION guard_sample_service_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM simple_invoices WHERE id=NEW.invoice_id AND sample)
  THEN RAISE EXCEPTION 'Service states apply to sample invoices only'; END IF;
  IF NOT EXISTS(SELECT 1 FROM simple_invoice_payments WHERE invoice_id=NEW.invoice_id
   AND provider_event_id=NEW.cause_event_id AND verification='signed_test_event' AND kind IN ('receipt','refund'))
  THEN RAISE EXCEPTION 'A service state needs the applied signed test event that moved it'; END IF;
  IF NEW.state='ready' AND EXISTS(SELECT 1 FROM sample_service_states WHERE invoice_id=NEW.invoice_id AND state='withdrawn')
  THEN RAISE EXCEPTION 'A withdrawn service cannot become ready again'; END IF;
  RETURN NEW;
 END IF;
 -- SVC-06: the rows go only with their erased sample invoice.
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM simple_invoices WHERE id=OLD.invoice_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Service state records are immutable';
END $$;
DROP TRIGGER IF EXISTS sample_service_state_guard ON sample_service_states;
CREATE TRIGGER sample_service_state_guard BEFORE INSERT OR UPDATE OR DELETE ON sample_service_states
 FOR EACH ROW EXECUTE FUNCTION guard_sample_service_state();
INSERT INTO schema_migrations(version) VALUES(122) ON CONFLICT DO NOTHING;
COMMIT;
