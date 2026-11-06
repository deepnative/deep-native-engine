BEGIN;
-- #40 CHANGELOG: who changed billing, and when. No foreign keys: an entry
-- outlives the member and the administrator it names. It holds no email, token
-- or free text; a void or return reason stays on its own record.
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=101) THEN
CREATE TABLE IF NOT EXISTS billing_change_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('plan_offered','rate_set','hours_returned','coaching_invoice_issued','monthly_invoice_issued','payment_recorded','invoice_voided')),
 member_id uuid,
 month text CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'),
 amount_cents bigint CHECK(amount_cents>=0),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX billing_change_events_time ON billing_change_events(occurred_at DESC,id DESC);
CREATE INDEX account_role_events_time ON account_role_events(occurred_at DESC,id DESC);
-- CHANGELOG-07: what earlier records already say about who acted. Issuing,
-- returning hours and setting rates recorded nobody, so they start from here.
INSERT INTO billing_change_events(actor_id,action,member_id,occurred_at)
 SELECT created_by,'plan_offered',owner_id,created_at FROM simple_invoice_plans WHERE created_by IS NOT NULL;
INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents,occurred_at)
 SELECT p.actor_id,'payment_recorded',i.owner_id,p.amount_cents,p.recorded_at
   FROM simple_invoice_payments p JOIN simple_invoices i ON i.id=p.invoice_id WHERE p.actor_id IS NOT NULL;
INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents,occurred_at)
 SELECT voided_by,'invoice_voided',owner_id,total_cents,voided_at FROM simple_invoices WHERE voided_by IS NOT NULL;
CREATE OR REPLACE FUNCTION preserve_staff_change_event() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'Staff change history is append-only'; END $f$;
CREATE TRIGGER billing_change_events_append_only BEFORE UPDATE OR DELETE ON billing_change_events
 FOR EACH ROW EXECUTE FUNCTION preserve_staff_change_event();
CREATE TRIGGER account_role_events_append_only BEFORE UPDATE OR DELETE ON account_role_events
 FOR EACH ROW EXECUTE FUNCTION preserve_staff_change_event();
INSERT INTO schema_migrations(version) VALUES(101) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
