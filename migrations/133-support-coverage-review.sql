BEGIN;
-- #195 AC3: a currently granted operator or administrator can deliberately
-- record that an open request is outside current support. The state is
-- set once, before resolution, and never grants an entitlement, booking,
-- price or completion promise. The content-free event log records the actor
-- and the transition, like acknowledgement and resolution.
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS coverage_reviewed_by uuid;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS coverage_reviewed_at timestamptz;
ALTER TABLE support_requests DROP CONSTRAINT IF EXISTS support_requests_coverage_state_check;
ALTER TABLE support_requests ADD CONSTRAINT support_requests_coverage_state_check
 CHECK(coverage_state IN ('unverified','outside-current-support'));
ALTER TABLE support_requests DROP CONSTRAINT IF EXISTS support_requests_coverage_review_check;
ALTER TABLE support_requests ADD CONSTRAINT support_requests_coverage_review_check
 CHECK((coverage_state='unverified' AND coverage_reviewed_by IS NULL AND coverage_reviewed_at IS NULL)
    OR (coverage_state='outside-current-support' AND coverage_reviewed_by IS NOT NULL AND coverage_reviewed_at IS NOT NULL));
ALTER TABLE support_request_events DROP CONSTRAINT IF EXISTS support_request_events_action_check;
ALTER TABLE support_request_events ADD CONSTRAINT support_request_events_action_check
 CHECK(action IN ('received','acknowledged','replied','noted','resolved','withdrawn','detail-read','worklist-read','grant-created','grant-revoked','coverage-reviewed'));
ALTER TABLE support_request_mutations DROP CONSTRAINT IF EXISTS support_request_mutations_action_check;
ALTER TABLE support_request_mutations ADD CONSTRAINT support_request_mutations_action_check
 CHECK(action IN ('acknowledged','replied','noted','resolved','coverage-reviewed'));
CREATE OR REPLACE FUNCTION preserve_support_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['subject','body','acknowledged_by','acknowledged_at','resolved_by','resolved_at','withdrawn_at','coverage_state','coverage_reviewed_by','coverage_reviewed_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['subject','body','acknowledged_by','acknowledged_at','resolved_by','resolved_at','withdrawn_at','coverage_state','coverage_reviewed_by','coverage_reviewed_at'])
    OR (OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at,NEW.acknowledged_by) IS DISTINCT FROM (OLD.acknowledged_at,OLD.acknowledged_by))
    OR (OLD.resolved_at IS NOT NULL AND (NEW.resolved_at,NEW.resolved_by,NEW.acknowledged_at,NEW.acknowledged_by,NEW.coverage_state,NEW.coverage_reviewed_by,NEW.coverage_reviewed_at) IS DISTINCT FROM (OLD.resolved_at,OLD.resolved_by,OLD.acknowledged_at,OLD.acknowledged_by,OLD.coverage_state,OLD.coverage_reviewed_by,OLD.coverage_reviewed_at))
    OR (OLD.coverage_reviewed_at IS NOT NULL AND (NEW.coverage_state,NEW.coverage_reviewed_by,NEW.coverage_reviewed_at) IS DISTINCT FROM (OLD.coverage_state,OLD.coverage_reviewed_by,OLD.coverage_reviewed_at))
    OR (OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    OR (NEW.withdrawn_at IS NULL AND (NEW.subject,NEW.body) IS DISTINCT FROM (OLD.subject,OLD.body)) THEN
  RAISE EXCEPTION 'Support request history is immutable';
 END IF;
 RETURN NEW;
END $$;
INSERT INTO schema_migrations(version) VALUES(133) ON CONFLICT DO NOTHING;
COMMIT;
