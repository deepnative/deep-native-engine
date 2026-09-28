BEGIN;
CREATE TABLE IF NOT EXISTS synthetic_manual_observations (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL,
 idempotency_key uuid NOT NULL UNIQUE,
 evidence_reference text NOT NULL CHECK(evidence_reference ~ '^SYN-[A-Z0-9-]{6,64}$'),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 10000000),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'unverified_manual' CHECK(status='unverified_manual'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS synthetic_manual_observations_member_idx
 ON synthetic_manual_observations(member_id,created_at);
CREATE OR REPLACE FUNCTION reject_synthetic_manual_observation_mutation()
RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM learners WHERE id=OLD.member_id) THEN
  RAISE EXCEPTION 'Synthetic manual observation history is immutable';
 END IF;
 RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS synthetic_manual_observations_immutable
 ON synthetic_manual_observations;
CREATE TRIGGER synthetic_manual_observations_immutable
 BEFORE UPDATE OR DELETE ON synthetic_manual_observations
 FOR EACH ROW EXECUTE FUNCTION reject_synthetic_manual_observation_mutation();
INSERT INTO schema_migrations(version) VALUES(33) ON CONFLICT DO NOTHING;
COMMIT;
