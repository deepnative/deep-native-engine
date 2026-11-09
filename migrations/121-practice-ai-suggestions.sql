BEGIN;
-- #200 PRACTICE-AI: at most one simulated AI suggestion per saved practice
-- pair, from the local deterministic test provider. The pair's withdrawal or
-- the member's erasure removes it with the pair. Its request is an ordinary
-- member-owned adapter job, so it counts toward the #190 open-request limit.
CREATE TABLE IF NOT EXISTS practice_ai_suggestions (
 session_id uuid NOT NULL,
 sequence integer NOT NULL,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 job_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','ready','rejected')),
 suggestion text CHECK(suggestion IS NULL OR length(suggestion) BETWEEN 1 AND 1200),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 PRIMARY KEY(session_id,sequence),
 FOREIGN KEY(session_id,sequence) REFERENCES private_practice_exchanges(session_id,sequence) ON DELETE CASCADE,
 FOREIGN KEY(job_id,member_id) REFERENCES adapter_jobs(id,member_id) ON DELETE CASCADE,
 CHECK((state='ready') = (suggestion IS NOT NULL)),
 CHECK((state='requested') = (completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS practice_ai_suggestions_member_idx ON practice_ai_suggestions(member_id);
CREATE OR REPLACE FUNCTION guard_practice_ai_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'requested' OR NOT EXISTS(
   SELECT 1 FROM private_practice_sessions s JOIN adapter_jobs j ON j.id=NEW.job_id
   WHERE s.id=NEW.session_id AND s.member_id=NEW.member_id AND s.withdrawn_at IS NULL
    AND j.member_id=NEW.member_id AND j.adapter='ai' AND j.mode IN ('demo','test')
    AND j.operation='practice-suggestion-local-v1' AND j.local_ai_receipt_id IS NULL) THEN
   RAISE EXCEPTION 'Practice suggestion must start as its owner''s own request';
  END IF;
 ELSIF OLD.state<>'requested' OR NEW.state='requested'
   OR (to_jsonb(NEW)-'state'-'suggestion'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'suggestion'-'completed_at') THEN
  RAISE EXCEPTION 'Practice suggestions complete once and are then immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS practice_ai_suggestions_guard ON practice_ai_suggestions;
CREATE TRIGGER practice_ai_suggestions_guard BEFORE INSERT OR UPDATE ON practice_ai_suggestions
 FOR EACH ROW EXECUTE FUNCTION guard_practice_ai_suggestion();
INSERT INTO schema_migrations(version) VALUES(121) ON CONFLICT DO NOTHING;
COMMIT;
