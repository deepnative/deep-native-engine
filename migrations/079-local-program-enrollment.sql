BEGIN;
CREATE TABLE IF NOT EXISTS local_program_terms (
 id text PRIMARY KEY CHECK(id='local-foundation-1'),
 digest text NOT NULL CHECK(digest='d2e243bcaf4aff80a03c8ed95b37e4240bc310cf31842f2b0fe1700ec6ea7284'),
 snapshot jsonb NOT NULL CHECK(snapshot='{"programId":"foundation","programVersion":1,"termId":"local-foundation-1","termVersion":1,"title":"Applied AI foundations","capacity":20,"simulation":true,"lessons":[{"id":"FND-001","version":2,"sourceDigest":"586f4b189fbed4d44208a1ccf6ea2e111b616686112dff8a11eaba65469d4d06","outcome":"Choose a useful task and distinguish a claim from evidence."},{"id":"FND-002","version":2,"sourceDigest":"ed24db3df9c205f5e3288b5f6c7c908b279750679da3a0a2551294157bf5b2ee","outcome":"Write a clear request with context and a checkable result."},{"id":"FND-003","version":2,"sourceDigest":"040191ed7b6ee9b1c01784e4819d5e1ea2c21b30112d91caeb4a5c638d664833","outcome":"Check an output against its sources and explain a correction."},{"id":"FND-004","version":2,"sourceDigest":"a81642cf418549c73f5f87041a377230d971e91042db57afceb2bf279f14bf0a","outcome":"Choose what is safe and permitted to share."},{"id":"FND-005","version":2,"sourceDigest":"de47809375ad26c60fbe3a41ae585643d5a30995bf2ab61917da102f72f2f272","outcome":"Describe and check a repeatable practical workflow."},{"id":"FND-006","version":2,"sourceDigest":"de978a9af2c2cb91f70ba31536d95244d122d3c4f0e160e764b15b7d1e419e53","outcome":"Ask for useful feedback and choose what to contribute."}]}'::jsonb),
 state text NOT NULL DEFAULT 'not_open' CHECK(state IN ('not_open','open','closed')),
 revision integer NOT NULL DEFAULT 1,
 admission_generation bigint NOT NULL DEFAULT 0 CHECK(admission_generation>=0),
 CHECK((state,revision) IN (('not_open',1),('open',2),('closed',3)))
);
INSERT INTO local_program_terms(id,digest,snapshot)
 VALUES('local-foundation-1','d2e243bcaf4aff80a03c8ed95b37e4240bc310cf31842f2b0fe1700ec6ea7284','{"programId":"foundation","programVersion":1,"termId":"local-foundation-1","termVersion":1,"title":"Applied AI foundations","capacity":20,"simulation":true,"lessons":[{"id":"FND-001","version":2,"sourceDigest":"586f4b189fbed4d44208a1ccf6ea2e111b616686112dff8a11eaba65469d4d06","outcome":"Choose a useful task and distinguish a claim from evidence."},{"id":"FND-002","version":2,"sourceDigest":"ed24db3df9c205f5e3288b5f6c7c908b279750679da3a0a2551294157bf5b2ee","outcome":"Write a clear request with context and a checkable result."},{"id":"FND-003","version":2,"sourceDigest":"040191ed7b6ee9b1c01784e4819d5e1ea2c21b30112d91caeb4a5c638d664833","outcome":"Check an output against its sources and explain a correction."},{"id":"FND-004","version":2,"sourceDigest":"a81642cf418549c73f5f87041a377230d971e91042db57afceb2bf279f14bf0a","outcome":"Choose what is safe and permitted to share."},{"id":"FND-005","version":2,"sourceDigest":"de47809375ad26c60fbe3a41ae585643d5a30995bf2ab61917da102f72f2f272","outcome":"Describe and check a repeatable practical workflow."},{"id":"FND-006","version":2,"sourceDigest":"de978a9af2c2cb91f70ba31536d95244d122d3c4f0e160e764b15b7d1e419e53","outcome":"Ask for useful feedback and choose what to contribute."}]}'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS local_program_enrollments (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 term_id text NOT NULL REFERENCES local_program_terms(id),
 idempotency_key uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint='d2e243bcaf4aff80a03c8ed95b37e4240bc310cf31842f2b0fe1700ec6ea7284'),
 enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(enrolled_at)),
 UNIQUE(workspace_id,term_id), UNIQUE(workspace_id,idempotency_key)
);
CREATE OR REPLACE FUNCTION guard_local_program_term() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Local program inventory is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','revision','admission_generation']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','revision','admission_generation'])
 THEN RAISE EXCEPTION 'Local program definition is immutable'; END IF;
 IF NEW.state=OLD.state AND NEW.revision=OLD.revision
    AND NEW.admission_generation=OLD.admission_generation+1 THEN RETURN NEW; END IF;
 IF NEW.admission_generation<>OLD.admission_generation OR NOT
   ((OLD.state='not_open' AND NEW.state='open' AND NEW.revision=2)
    OR (OLD.state='open' AND NEW.state='closed' AND NEW.revision=3))
 THEN RAISE EXCEPTION 'Local term state conflicts'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_program_term_guard ON local_program_terms;
CREATE TRIGGER local_program_term_guard BEFORE UPDATE OR DELETE ON local_program_terms
 FOR EACH ROW EXECUTE FUNCTION guard_local_program_term();
CREATE OR REPLACE FUNCTION guard_local_program_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory local_program_terms%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Enrollment receipt is immutable'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  THEN RAISE EXCEPTION 'Enrollment is retained until account erasure'; END IF;
  RETURN OLD;
 END IF;
 -- Update as well as lock admission so stale RR writers fail rather than use an old count.
 UPDATE local_program_terms SET admission_generation=admission_generation+1
  WHERE id=NEW.term_id RETURNING * INTO inventory;
 IF NOT FOUND OR inventory.state<>'open' OR NEW.fingerprint<>inventory.digest
  OR (SELECT count(*) FROM local_program_enrollments WHERE term_id=NEW.term_id)>=20
 THEN RAISE EXCEPTION 'Local term admission unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspaces w JOIN principals p ON p.id=w.owner_principal_id
  WHERE w.id=NEW.workspace_id AND w.deleting_at IS NULL AND p.kind='member'
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Current local member required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS local_program_enrollment_guard ON local_program_enrollments;
CREATE TRIGGER local_program_enrollment_guard BEFORE INSERT OR UPDATE OR DELETE
 ON local_program_enrollments FOR EACH ROW EXECUTE FUNCTION guard_local_program_enrollment();
INSERT INTO schema_migrations(version) VALUES(79) ON CONFLICT DO NOTHING;
COMMIT;
