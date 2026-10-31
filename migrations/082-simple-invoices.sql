BEGIN;
CREATE TABLE IF NOT EXISTS simple_invoice_plans (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL,
 terms jsonb NOT NULL,
 state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','active','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid REFERENCES principals(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 accepted_at timestamptz,
 recipient_name text,
 recipient_email text,
 next_cycle integer NOT NULL DEFAULT 0 CHECK(next_cycle BETWEEN 0 AND 1201),
 CHECK(state<>'active' OR (accepted_at IS NOT NULL AND recipient_name IS NOT NULL AND recipient_email IS NOT NULL)),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES workspaces(id,owner_principal_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS simple_invoice_one_recurring_agreement ON simple_invoice_plans(owner_id) WHERE state='active' AND terms->>'cadence'='monthly';
CREATE TABLE IF NOT EXISTS simple_invoices (
 id uuid PRIMARY KEY,
 plan_id uuid REFERENCES simple_invoice_plans(id) ON DELETE SET NULL,
 owner_id uuid REFERENCES learners(id) ON DELETE SET NULL,
 cycle integer NOT NULL CHECK(cycle BETWEEN 0 AND 1200),
 document jsonb NOT NULL,
 sample boolean NOT NULL,
 total_cents bigint NOT NULL CHECK(total_cents BETWEEN 1 AND 1000000000),
 paid_cents bigint NOT NULL DEFAULT 0 CHECK(paid_cents BETWEEN 0 AND total_cents),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 delivery text NOT NULL DEFAULT 'not_sent' CHECK(delivery IN ('not_sent','sending','sent','unconfirmed')),
 delivery_operation uuid,
 void_reason text CHECK(void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
 voided_at timestamptz,
 voided_by uuid REFERENCES principals(id) ON DELETE SET NULL,
 CHECK((void_reason IS NULL)=(voided_at IS NULL)),
 CHECK(void_reason IS NULL OR paid_cents=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(plan_id,cycle)
);
CREATE TABLE IF NOT EXISTS simple_invoice_operations (
 actor_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS simple_invoice_payments (
 id uuid PRIMARY KEY,
 invoice_id uuid NOT NULL REFERENCES simple_invoices(id) ON DELETE CASCADE,
 actor_id uuid REFERENCES principals(id) ON DELETE SET NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000),
 received_on date NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION preserve_simple_invoice_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.cycle,NEW.document,NEW.sample,NEW.total_cents,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.cycle,OLD.document,OLD.sample,OLD.total_cents,OLD.created_at)
 THEN RAISE EXCEPTION 'Issued invoice snapshot is immutable'; END IF;
 IF OLD.void_reason IS NOT NULL AND ROW(NEW.void_reason,NEW.voided_at) IS DISTINCT FROM ROW(OLD.void_reason,OLD.voided_at)
 THEN RAISE EXCEPTION 'Voided invoices cannot be reopened'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_snapshot_immutable ON simple_invoices;
CREATE TRIGGER simple_invoice_snapshot_immutable BEFORE UPDATE ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION preserve_simple_invoice_snapshot();
CREATE OR REPLACE FUNCTION preserve_simple_invoice_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.owner_id,NEW.workspace_id,NEW.terms,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.owner_id,OLD.workspace_id,OLD.terms,OLD.created_at)
 THEN RAISE EXCEPTION 'Course billing terms are immutable'; END IF;
 IF OLD.accepted_at IS NOT NULL AND ROW(NEW.accepted_at,NEW.recipient_name,NEW.recipient_email) IS DISTINCT FROM ROW(OLD.accepted_at,OLD.recipient_name,OLD.recipient_email)
 THEN RAISE EXCEPTION 'Accepted billing consent is immutable'; END IF;
 IF (OLD.state='cancelled' AND NEW.state<>'cancelled') OR NEW.next_cycle<OLD.next_cycle
 THEN RAISE EXCEPTION 'Billing cannot resume without new consent'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_terms_immutable ON simple_invoice_plans;
CREATE TRIGGER simple_invoice_terms_immutable BEFORE UPDATE ON simple_invoice_plans
 FOR EACH ROW EXECUTE FUNCTION preserve_simple_invoice_terms();
CREATE OR REPLACE FUNCTION guard_simple_invoice_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT OLD.sample OR OLD.owner_id IS NOT NULL THEN RAISE EXCEPTION 'Issued invoice is retained'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND NOT
  (NEW.owner_id IS NULL AND NOT EXISTS(SELECT 1 FROM learners WHERE id=OLD.owner_id))
 THEN RAISE EXCEPTION 'Invoice ownership cannot change'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_owner_guard ON simple_invoices;
CREATE TRIGGER simple_invoice_owner_guard BEFORE UPDATE OR DELETE ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION guard_simple_invoice_owner();
CREATE OR REPLACE FUNCTION erase_sample_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL AND NEW.sample
 THEN DELETE FROM simple_invoices WHERE id=NEW.id; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS simple_invoice_sample_erasure ON simple_invoices;
CREATE TRIGGER simple_invoice_sample_erasure AFTER UPDATE OF owner_id ON simple_invoices
 FOR EACH ROW EXECUTE FUNCTION erase_sample_invoice();
CREATE OR REPLACE FUNCTION preserve_simple_invoice_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM simple_invoices WHERE id=OLD.invoice_id) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM principals WHERE id=OLD.actor_id)
  AND (to_jsonb(NEW)-'actor_id')=(to_jsonb(OLD)-'actor_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Recorded invoice payments are immutable';
END $$;
DROP TRIGGER IF EXISTS simple_invoice_payment_immutable ON simple_invoice_payments;
CREATE TRIGGER simple_invoice_payment_immutable BEFORE UPDATE OR DELETE ON simple_invoice_payments
 FOR EACH ROW EXECUTE FUNCTION preserve_simple_invoice_payment();
INSERT INTO schema_migrations(version) VALUES(82) ON CONFLICT DO NOTHING;
COMMIT;
