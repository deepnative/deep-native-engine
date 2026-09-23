BEGIN;
CREATE TABLE IF NOT EXISTS content_versions (
 id text NOT NULL CHECK(id ~ '^[A-Z]{2,5}-[0-9]{3}$'),
 version integer NOT NULL CHECK(version > 0),
 kind text NOT NULL CHECK(kind IN ('lesson','assignment','workflow','community')),
 origin text NOT NULL CHECK(origin IN ('curated','member-proposal')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
 owner text NOT NULL CHECK(length(owner) BETWEEN 1 AND 160),
 sources text NOT NULL CHECK(length(sources) BETWEEN 1 AND 2000),
 rights text NOT NULL CHECK(length(rights) BETWEEN 1 AND 2000),
 goals text[] NOT NULL DEFAULT '{}',
 backgrounds text[] NOT NULL DEFAULT '{}',
 domains text[] NOT NULL DEFAULT '{}',
 prerequisites text NOT NULL DEFAULT '',
 requires_qualified_signoff boolean NOT NULL DEFAULT false,
 rubric text,
 rubric_version integer CHECK(rubric_version > 0),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','in_review','approved','published','retired')),
 created_by uuid REFERENCES staff_profiles(principal_id),
 reviewed_by uuid REFERENCES staff_profiles(principal_id),
 reviewed_at timestamptz,
 rights_confirmed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_at timestamptz,
 retired_at timestamptz,
 PRIMARY KEY(id,version),
 CHECK((rubric IS NULL AND rubric_version IS NULL) OR (rubric IS NOT NULL AND rubric_version IS NOT NULL)),
 CHECK(state NOT IN ('approved','published','retired') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND rights_confirmed)),
 CHECK(state NOT IN ('approved','published','retired') OR NOT requires_qualified_signoff),
 CHECK(state <> 'published' OR published_at IS NOT NULL),
 CHECK(state <> 'retired' OR retired_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS content_versions_search_idx ON content_versions(state,id,version DESC);
CREATE TABLE IF NOT EXISTS content_assessments (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 content_id text NOT NULL,
 content_version integer NOT NULL,
 rubric_version integer NOT NULL,
 reviewer_id uuid NOT NULL REFERENCES staff_profiles(principal_id),
 mode text NOT NULL DEFAULT 'simulated' CHECK(mode='simulated'),
 result text NOT NULL CHECK(length(result) BETWEEN 1 AND 4000),
 assessed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(content_id,content_version) REFERENCES content_versions(id,version)
);
CREATE OR REPLACE FUNCTION preserve_released_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.state IN ('published','retired') THEN RAISE EXCEPTION 'Released content is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.state IN ('published','retired') AND
    (to_jsonb(NEW)-'state'-'retired_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'retired_at') THEN
  RAISE EXCEPTION 'Released content is immutable';
 END IF;
 IF OLD.state='retired' OR (OLD.state='published' AND NEW.state NOT IN ('published','retired')) THEN
  RAISE EXCEPTION 'Released content cannot be reactivated';
 END IF;
 IF OLD.state='published' AND
    ((NEW.state='published' AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) OR
     (NEW.state='retired' AND NEW.retired_at IS NULL)) THEN
  RAISE EXCEPTION 'Released content has an invalid retirement';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_versions_immutable ON content_versions;
CREATE TRIGGER content_versions_immutable BEFORE UPDATE OR DELETE ON content_versions
 FOR EACH ROW EXECUTE FUNCTION preserve_released_content();
CREATE OR REPLACE FUNCTION preserve_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Assessment history is immutable'; END $$;
DROP TRIGGER IF EXISTS content_assessments_immutable ON content_assessments;
-- Privacy deletion cascades may remove historical records; edits still cannot rewrite a result.
CREATE TRIGGER content_assessments_immutable BEFORE UPDATE ON content_assessments
 FOR EACH ROW EXECUTE FUNCTION preserve_assessment();
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
COMMIT;
