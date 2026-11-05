BEGIN;
-- Versioned finite study allowance policies (#199). Every row is a test
-- configuration: no provider rate, spend, purchase or paid offer is implied.
CREATE TABLE IF NOT EXISTS study_allowance_policies (
 version text PRIMARY KEY CHECK(version ~ '^study-allowance-test-v[1-9][0-9]*$'),
 category text NOT NULL CHECK(category='study_requests'),
 period_limit integer NOT NULL CHECK(period_limit BETWEEN 1 AND 100),
 period text NOT NULL CHECK(period='utc_calendar_month'),
 eligibility text NOT NULL CHECK(eligibility='current_member_explicit_claim'),
 grant_source text NOT NULL CHECK(grant_source='test_configuration'),
 rate_estimate_version text CHECK(rate_estimate_version IS NULL),
 spend_state text NOT NULL CHECK(spend_state='test'),
 effective_from timestamptz NOT NULL CHECK(isfinite(effective_from))
);
CREATE OR REPLACE FUNCTION guard_study_allowance_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Study allowance policy versions are immutable';
END $$;
DROP TRIGGER IF EXISTS study_allowance_policy_guard ON study_allowance_policies;
CREATE TRIGGER study_allowance_policy_guard BEFORE UPDATE OR DELETE ON study_allowance_policies
 FOR EACH ROW EXECUTE FUNCTION guard_study_allowance_policy();
INSERT INTO study_allowance_policies(version,category,period_limit,period,eligibility,grant_source,rate_estimate_version,spend_state,effective_from)
 VALUES('study-allowance-test-v1','study_requests',5,'utc_calendar_month','current_member_explicit_claim','test_configuration',NULL,'test','2026-01-01T00:00:00Z')
 ON CONFLICT(version) DO NOTHING;

-- One claim per member, category and period, whichever policy version applied.
-- A slot is retained after its units are used or expire, so it can't be reminted.
CREATE TABLE IF NOT EXISTS study_allowance_claims (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 policy_version text NOT NULL REFERENCES study_allowance_policies(version),
 category text NOT NULL CHECK(category='study_requests'),
 period_start timestamptz NOT NULL CHECK(isfinite(period_start)),
 period_end timestamptz NOT NULL CHECK(isfinite(period_end)),
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 grant_id uuid NOT NULL UNIQUE REFERENCES synthetic_entitlement_grants(id),
 operation_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(member_id,category,period_start),
 UNIQUE(member_id,operation_key),
 CHECK(period_end>period_start)
);
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
   AND e.idempotency_key='study-allowance:'||NEW.member_id::text||':'||to_char(NEW.period_start AT TIME ZONE 'UTC','YYYY-MM')
   AND w.owner_principal_id=NEW.member_id AND w.deleting_at IS NULL
 ) THEN RAISE EXCEPTION 'Exact study allowance grant required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS study_allowance_claim_guard ON study_allowance_claims;
CREATE TRIGGER study_allowance_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON study_allowance_claims
 FOR EACH ROW EXECUTE FUNCTION guard_study_allowance_claim();
INSERT INTO schema_migrations(version) VALUES(99) ON CONFLICT DO NOTHING;
COMMIT;
