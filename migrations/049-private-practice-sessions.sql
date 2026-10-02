BEGIN;
CREATE TABLE IF NOT EXISTS private_practice_sessions (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 goal_at_start text NOT NULL CHECK(goal_at_start IN ('everyday','work','build')),
 prompt_version text NOT NULL CHECK(length(prompt_version) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version),
 UNIQUE(member_id,content_id,content_version,goal_at_start,prompt_version)
);
CREATE INDEX IF NOT EXISTS private_practice_sessions_history_idx
 ON private_practice_sessions(member_id,created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION preserve_private_practice_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD)-'withdrawn_at')
    OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
  RAISE EXCEPTION 'Practice session identity and withdrawal are immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS private_practice_sessions_immutable ON private_practice_sessions;
CREATE TRIGGER private_practice_sessions_immutable BEFORE UPDATE ON private_practice_sessions
 FOR EACH ROW EXECUTE FUNCTION preserve_private_practice_session();
CREATE TABLE IF NOT EXISTS private_practice_exchanges (
 session_id uuid NOT NULL REFERENCES private_practice_sessions(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 15),
 response text NOT NULL CHECK(length(response) BETWEEN 1 AND 1000 AND length(btrim(response))>0),
 comparison text NOT NULL CHECK(length(comparison) BETWEEN 1 AND 4000),
 source_excerpt text NOT NULL CHECK(length(source_excerpt) BETWEEN 1 AND 600),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(session_id,sequence)
);
CREATE OR REPLACE FUNCTION preserve_private_practice_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Practice exchanges are immutable'; END $$;
DROP TRIGGER IF EXISTS private_practice_exchanges_immutable ON private_practice_exchanges;
-- Deletion remains available for explicit withdrawal and account deletion.
CREATE TRIGGER private_practice_exchanges_immutable BEFORE UPDATE ON private_practice_exchanges
 FOR EACH ROW EXECUTE FUNCTION preserve_private_practice_exchange();
INSERT INTO schema_migrations(version) VALUES(49) ON CONFLICT DO NOTHING;
COMMIT;
