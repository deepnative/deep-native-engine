BEGIN;
-- Labelled estimate and once-only usage settlement for metered AI requests
-- (#188). Integers and versions only: never a prompt, evidence or provider text.
-- Legacy metered jobs receive no estimate, so they cannot dispatch; withdrawing
-- permission still releases a never-started hold.
CREATE TABLE IF NOT EXISTS ai_usage_estimates (
 job_id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 rate_version text NOT NULL CHECK(rate_version ~ '^[a-z0-9-]{1,64}$'),
 model_version text NOT NULL CHECK(model_version ~ '^[a-z0-9-]{1,64}$'),
 input_tokens integer NOT NULL CHECK(input_tokens BETWEEN 1 AND 10000000),
 output_tokens integer NOT NULL CHECK(output_tokens BETWEEN 0 AND 10000000),
 cost_points integer NOT NULL CHECK(cost_points>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(job_id,member_id),
 FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_usage_estimates_member_idx ON ai_usage_estimates(member_id,job_id);
CREATE TABLE IF NOT EXISTS ai_usage_settlements (
 job_id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 input_tokens integer NOT NULL CHECK(input_tokens BETWEEN 1 AND 10000000),
 output_tokens integer NOT NULL CHECK(output_tokens BETWEEN 0 AND 10000000),
 cost_points integer NOT NULL CHECK(cost_points>=0),
 settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(job_id,member_id) REFERENCES ai_usage_estimates(job_id,member_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_usage_settlements_member_idx ON ai_usage_settlements(member_id,job_id);

-- Recorded amounts never change. Removal is only part of member erasure.
CREATE OR REPLACE FUNCTION guard_ai_usage_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'AI usage history is immutable'; END IF;
 IF EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
  RAISE EXCEPTION 'AI usage history requires member erasure';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ai_usage_estimate_history_guard ON ai_usage_estimates;
CREATE TRIGGER ai_usage_estimate_history_guard BEFORE UPDATE OR DELETE ON ai_usage_estimates
 FOR EACH ROW EXECUTE FUNCTION guard_ai_usage_history();
DROP TRIGGER IF EXISTS ai_usage_settlement_history_guard ON ai_usage_settlements;
CREATE TRIGGER ai_usage_settlement_history_guard BEFORE UPDATE OR DELETE ON ai_usage_settlements
 FOR EACH ROW EXECUTE FUNCTION guard_ai_usage_history();

-- An estimate belongs to a never-started metered request.
CREATE OR REPLACE FUNCTION guard_ai_usage_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND j.status='pending' AND j.attempt_count=0
 ) THEN RAISE EXCEPTION 'AI usage estimate needs a new metered request'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_usage_estimate_guard ON ai_usage_estimates;
CREATE TRIGGER ai_usage_estimate_guard BEFORE INSERT ON ai_usage_estimates
 FOR EACH ROW EXECUTE FUNCTION guard_ai_usage_estimate();

-- A settlement follows consumption of this exact started request's reservation.
CREATE OR REPLACE FUNCTION guard_ai_usage_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM adapter_jobs j
  JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
  JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
  WHERE j.id=NEW.job_id AND j.member_id=NEW.member_id AND j.status='running' AND j.attempt_count=1
   AND r.state='consumed'
 ) THEN RAISE EXCEPTION 'AI usage settlement is out of order'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_usage_settlement_guard ON ai_usage_settlements;
CREATE TRIGGER ai_usage_settlement_guard BEFORE INSERT ON ai_usage_settlements
 FOR EACH ROW EXECUTE FUNCTION guard_ai_usage_settlement();
INSERT INTO schema_migrations(version) VALUES(100) ON CONFLICT DO NOTHING;
COMMIT;
