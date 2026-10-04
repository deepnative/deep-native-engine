BEGIN;
-- Deliberately grants no authority: existing arbitrary-purpose grants remain
-- read-only for the new workflow. Runtime requires private_sample_feedback_v1.
CREATE OR REPLACE FUNCTION sample_feedback_criteria_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(value)<>'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 5 THEN RETURN false; END IF;
 FOR item IN SELECT jsonb_array_elements(value) LOOP
  IF jsonb_typeof(item)<>'object'
   OR NOT item ?& ARRAY['label','comment','start','end','quote']
   OR (SELECT count(*) FROM jsonb_object_keys(item))<>5
   OR jsonb_typeof(item->'label')<>'string' OR length(item->>'label') NOT BETWEEN 1 AND 100
   OR jsonb_typeof(item->'comment')<>'string' OR length(item->>'comment') NOT BETWEEN 1 AND 1000
   OR jsonb_typeof(item->'quote')<>'string' OR length(item->>'quote') NOT BETWEEN 1 AND 1000
   OR jsonb_typeof(item->'start')<>'number' OR (item->>'start') !~ '^[0-9]{1,7}$'
   OR jsonb_typeof(item->'end')<>'number' OR (item->>'end') !~ '^[0-9]{1,7}$'
  THEN RETURN false; END IF;
  IF (item->>'start')::integer >= (item->>'end')::integer OR (item->>'end')::integer>1048576 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE IF NOT EXISTS private_sample_feedback (
 id uuid PRIMARY KEY,
 submission_id uuid NOT NULL REFERENCES evidence_review_submissions(id) ON DELETE CASCADE,
 -- Historical attribution, not a live role or qualification assertion. Removing
 -- a staff identity does not erase a member's published feedback.
 reviewer_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_revision integer NOT NULL CHECK(source_revision>0),
 criteria jsonb NOT NULL CHECK(sample_feedback_criteria_valid(criteria)),
 preparation_minutes integer CHECK(preparation_minutes BETWEEN 0 AND 480),
 review_minutes integer CHECK(review_minutes BETWEEN 0 AND 480),
 draft_revision integer NOT NULL DEFAULT 1 CHECK(draft_revision>0),
 draft_operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 publication_operation_id uuid,
 published_at timestamptz,
 clarification text CHECK(length(clarification) BETWEEN 1 AND 2000),
 clarification_operation_id uuid,
 clarified_at timestamptz,
 answer text CHECK(length(answer) BETWEEN 1 AND 2000),
 answer_operation_id uuid,
 answered_at timestamptz,
 UNIQUE(submission_id,reviewer_id),
 CHECK((publication_operation_id IS NULL)=(published_at IS NULL)),
 CHECK((clarification IS NULL)=(clarification_operation_id IS NULL)
   AND (clarification IS NULL)=(clarified_at IS NULL)),
 CHECK((answer IS NULL)=(answer_operation_id IS NULL)
   AND (answer IS NULL)=(answered_at IS NULL)),
 CHECK(clarification IS NULL OR published_at IS NOT NULL),
 CHECK(answer IS NULL OR clarification IS NOT NULL)
);
-- Retain draft operation identities so an older key cannot be reused to
-- silently replace a newer draft. Hashes, not duplicate private draft text.
CREATE TABLE IF NOT EXISTS private_sample_feedback_draft_operations (
 feedback_id uuid NOT NULL REFERENCES private_sample_feedback(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 resulting_revision integer NOT NULL CHECK(resulting_revision>0),
 PRIMARY KEY(feedback_id,operation_id)
);
CREATE INDEX IF NOT EXISTS private_sample_feedback_published_idx
 ON private_sample_feedback(submission_id,id) WHERE published_at IS NOT NULL;
CREATE OR REPLACE FUNCTION preserve_sample_feedback_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.submission_id<>OLD.submission_id OR NEW.reviewer_id<>OLD.reviewer_id
  OR NEW.source_sha256<>OLD.source_sha256 OR NEW.source_revision<>OLD.source_revision
  OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Sample feedback identity is immutable';
 END IF;
 IF OLD.published_at IS NOT NULL AND
  ROW(NEW.criteria,NEW.preparation_minutes,NEW.review_minutes,NEW.draft_revision,NEW.draft_operation_id,
      NEW.publication_operation_id,NEW.published_at)
  IS DISTINCT FROM
  ROW(OLD.criteria,OLD.preparation_minutes,OLD.review_minutes,OLD.draft_revision,OLD.draft_operation_id,
      OLD.publication_operation_id,OLD.published_at) THEN
  RAISE EXCEPTION 'Published sample feedback is immutable';
 END IF;
 IF OLD.clarification IS NOT NULL AND
  ROW(NEW.clarification,NEW.clarification_operation_id,NEW.clarified_at)
  IS DISTINCT FROM ROW(OLD.clarification,OLD.clarification_operation_id,OLD.clarified_at) THEN
  RAISE EXCEPTION 'Sample clarification is immutable';
 END IF;
 IF OLD.answer IS NOT NULL AND
  ROW(NEW.answer,NEW.answer_operation_id,NEW.answered_at)
  IS DISTINCT FROM ROW(OLD.answer,OLD.answer_operation_id,OLD.answered_at) THEN
  RAISE EXCEPTION 'Sample answer is immutable';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS private_sample_feedback_immutable ON private_sample_feedback;
CREATE TRIGGER private_sample_feedback_immutable BEFORE UPDATE ON private_sample_feedback
 FOR EACH ROW EXECUTE FUNCTION preserve_sample_feedback_publication();
-- Metadata only: no raw source, comments, quotes, answers or private profiles.
CREATE TABLE IF NOT EXISTS private_sample_feedback_audit (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 evidence_id uuid NOT NULL,
 submission_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 assignment_id uuid NOT NULL,
 exact_grant_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('read','draft-saved','published','answered')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS private_sample_feedback_audit_workspace_idx
 ON private_sample_feedback_audit(workspace_id,id);
DROP TRIGGER IF EXISTS private_sample_feedback_audit_immutable ON private_sample_feedback_audit;
CREATE TRIGGER private_sample_feedback_audit_immutable BEFORE UPDATE OR DELETE ON private_sample_feedback_audit
 FOR EACH ROW EXECUTE FUNCTION reject_authorization_audit_mutation();
INSERT INTO schema_migrations(version) VALUES(56) ON CONFLICT DO NOTHING;
COMMIT;
