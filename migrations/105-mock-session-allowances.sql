BEGIN;
-- Versioned finite practice session allowance (#199, #200). Test configuration
-- only: no provider rate, spend, purchase or paid offer is implied.
ALTER TABLE study_allowance_policies DROP CONSTRAINT IF EXISTS study_allowance_policies_version_check;
ALTER TABLE study_allowance_policies DROP CONSTRAINT IF EXISTS study_allowance_policies_category_check;
ALTER TABLE study_allowance_policies ADD CONSTRAINT study_allowance_policies_version_check
 CHECK((category='study_requests' AND version ~ '^study-allowance-test-v[1-9][0-9]*$')
  OR (category='mock_sessions' AND version ~ '^mock-allowance-test-v[1-9][0-9]*$'));
INSERT INTO study_allowance_policies(version,category,period_limit,period,eligibility,grant_source,rate_estimate_version,spend_state,effective_from)
 VALUES('mock-allowance-test-v1','mock_sessions',3,'utc_calendar_month','current_member_explicit_claim','test_configuration',NULL,'test','2026-01-01T00:00:00Z')
 ON CONFLICT(version) DO NOTHING;

ALTER TABLE study_allowance_claims DROP CONSTRAINT IF EXISTS study_allowance_claims_category_check;
ALTER TABLE study_allowance_claims ADD CONSTRAINT study_allowance_claims_category_check
 CHECK(category IN ('study_requests','mock_sessions'));
CREATE OR REPLACE FUNCTION guard_study_allowance_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM principals WHERE id=OLD.member_id) THEN
   RAISE EXCEPTION 'Study allowance claim is retained';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Study allowance claim is immutable'; END IF;
 NEW.created_at=clock_timestamp();
 IF NOT EXISTS(
  SELECT 1 FROM synthetic_entitlement_grants g
   JOIN synthetic_entitlement_events e ON e.grant_id=g.id
   JOIN study_allowance_policies p ON p.version=NEW.policy_version
   JOIN workspaces w ON w.id=NEW.workspace_id
  WHERE g.id=NEW.grant_id AND g.member_id=NEW.member_id AND g.category=NEW.category
   AND g.quantity=NEW.quantity AND g.expires_at=NEW.period_end
   AND g.starts_at>=NEW.period_start AND g.starts_at<NEW.period_end
   AND p.category=NEW.category AND p.period_limit=NEW.quantity
   AND p.effective_from<=NEW.created_at
   AND e.operation='grant' AND e.member_id=NEW.member_id AND e.quantity=NEW.quantity
   AND e.idempotency_key=CASE NEW.category WHEN 'mock_sessions' THEN 'mock-allowance:' ELSE 'study-allowance:' END
    ||NEW.member_id::text||':'||to_char(NEW.period_start AT TIME ZONE 'UTC','YYYY-MM')
   AND w.owner_principal_id=NEW.member_id AND w.deleting_at IS NULL
 ) THEN RAISE EXCEPTION 'Exact study allowance grant required'; END IF;
 RETURN NEW;
END $$;

-- One consumed unit per started session. A withdrawn session keeps its row, so
-- the unit is never refunded and the session can't be started again for free.
CREATE TABLE IF NOT EXISTS practice_session_allowance_uses (
 session_id uuid PRIMARY KEY REFERENCES private_practice_sessions(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 claim_id uuid NOT NULL REFERENCES study_allowance_claims(id) ON DELETE CASCADE,
 reservation_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_reservations(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at))
);
CREATE INDEX IF NOT EXISTS practice_session_allowance_uses_member ON practice_session_allowance_uses(member_id,session_id);
CREATE INDEX IF NOT EXISTS practice_session_allowance_uses_claim ON practice_session_allowance_uses(claim_id);
CREATE OR REPLACE FUNCTION guard_practice_session_allowance_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM principals WHERE id=OLD.member_id) THEN
   RAISE EXCEPTION 'Practice session allowance use is retained';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Practice session allowance use is immutable'; END IF;
 NEW.created_at=clock_timestamp();
 IF NOT EXISTS(
  SELECT 1 FROM private_practice_sessions s
   JOIN study_allowance_claims c ON c.member_id=s.member_id
   JOIN synthetic_entitlement_reservations r ON r.grant_id=c.grant_id
  WHERE s.id=NEW.session_id AND s.member_id=NEW.member_id AND c.id=NEW.claim_id
   AND c.category='mock_sessions' AND r.id=NEW.reservation_id AND r.quantity=1 AND r.state='consumed'
 ) THEN RAISE EXCEPTION 'Exact practice session allowance unit required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS practice_session_allowance_use_guard ON practice_session_allowance_uses;
CREATE TRIGGER practice_session_allowance_use_guard BEFORE INSERT OR UPDATE OR DELETE ON practice_session_allowance_uses
 FOR EACH ROW EXECUTE FUNCTION guard_practice_session_allowance_use();
INSERT INTO schema_migrations(version) VALUES(105) ON CONFLICT DO NOTHING;
COMMIT;
