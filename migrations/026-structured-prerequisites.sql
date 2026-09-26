BEGIN;
ALTER TABLE content_versions
 ADD COLUMN IF NOT EXISTS structured_prerequisites jsonb;

CREATE OR REPLACE FUNCTION valid_prerequisite_spec(spec jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
 atom jsonb;
 seen text[] := '{}';
 identity text;
BEGIN
 IF spec IS NULL OR jsonb_typeof(spec)<>'object' OR NOT spec ? 'schemaVersion'
    OR NOT spec ? 'all' OR (SELECT count(*) FROM jsonb_object_keys(spec))<>2
    OR spec->'schemaVersion'<>'1'::jsonb
    OR jsonb_typeof(spec->'all')<>'array'
    OR jsonb_array_length(spec->'all')>8 THEN RETURN false; END IF;
 FOR atom IN SELECT value FROM jsonb_array_elements(spec->'all') LOOP
  IF jsonb_typeof(atom)<>'object' OR NOT atom ? 'kind'
     OR NOT atom ? 'id' OR NOT atom ? 'version' OR NOT atom ? 'activity'
     OR (SELECT count(*) FROM jsonb_object_keys(atom))<>4
     OR jsonb_typeof(atom->'id')<>'string'
     OR jsonb_typeof(atom->'version')<>'number'
     OR atom->>'version' !~ '^[1-9][0-9]*$'
     OR (atom->>'version')::numeric>2147483647 THEN RETURN false; END IF;
  IF atom->>'kind'='lesson' THEN
   IF atom->>'id' !~ '^[A-Z]{2,5}-[0-9]{3}$'
      OR atom->>'activity' NOT IN ('started','self-assessed') THEN RETURN false; END IF;
  ELSIF atom->>'kind'='exercise' THEN
   IF atom->>'id'<>'clear-instructions' OR atom->>'version'<>'1'
      OR atom->>'activity'<>'completed' THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
  identity := (atom->>'kind')||':'||(atom->>'id')||':'||(atom->>'version');
  IF identity=ANY(seen) THEN RETURN false; END IF;
  seen := array_append(seen,identity);
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RETURN false;
END $$;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='content_structured_prerequisites_valid') THEN
  ALTER TABLE content_versions ADD CONSTRAINT content_structured_prerequisites_valid
   CHECK(structured_prerequisites IS NULL OR valid_prerequisite_spec(structured_prerequisites));
 END IF;
END $$;

CREATE OR REPLACE FUNCTION effective_prerequisite_spec(spec jsonb, legacy text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF spec IS NOT NULL THEN
  IF valid_prerequisite_spec(spec) THEN RETURN spec; END IF;
  RETURN NULL;
 END IF;
 IF btrim(legacy)='' OR lower(btrim(legacy))='none' THEN
  RETURN '{"schemaVersion":1,"all":[]}'::jsonb;
 END IF;
 IF btrim(legacy)='LOCAL-FIRST-EXERCISE-COMPLETE' THEN
  RETURN '{"schemaVersion":1,"all":[{"kind":"exercise","id":"clear-instructions","version":1,"activity":"completed"}]}'::jsonb;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION prerequisite_graph_valid(target_id text, spec jsonb, seen text[] DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
 atom jsonb;
 ref record;
 nested jsonb;
 identity text;
BEGIN
 IF spec IS NULL OR NOT valid_prerequisite_spec(spec) OR cardinality(seen)>32
 THEN RETURN false; END IF;
 FOR atom IN SELECT element FROM jsonb_array_elements(spec->'all') AS atoms(element)
   ORDER BY element->>'kind',element->>'id',element->>'version' LOOP
  IF atom->>'kind'='lesson' THEN
   identity := (atom->>'id')||':'||(atom->>'version');
   IF atom->>'id'=target_id OR identity=ANY(seen) THEN RETURN false; END IF;
   SELECT id,version,kind,origin,state,requires_qualified_signoff,prerequisites,
          structured_prerequisites INTO ref
     FROM content_versions WHERE id=atom->>'id'
       AND version=(atom->>'version')::integer FOR SHARE;
   IF NOT FOUND OR ref.kind<>'lesson' OR ref.origin<>'curated'
      OR ref.state<>'published'
      OR ref.requires_qualified_signoff OR EXISTS(
       SELECT 1 FROM content_versions newer WHERE newer.id=ref.id
         AND newer.version>ref.version AND newer.published_at IS NOT NULL)
   THEN RETURN false; END IF;
   nested := effective_prerequisite_spec(ref.structured_prerequisites,ref.prerequisites);
   IF nested IS NULL OR NOT prerequisite_graph_valid(target_id,nested,array_append(seen,identity))
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION member_prerequisites_met(p_member_id uuid, target_id text,
 target_version integer, seen text[] DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
 target record;
 spec jsonb;
 atom jsonb;
 identity text;
 observed boolean;
BEGIN
 identity := target_id||':'||target_version;
 IF identity=ANY(seen) OR cardinality(seen)>32 THEN RETURN false; END IF;
 SELECT id,version,kind,origin,state,requires_qualified_signoff,prerequisites,
        structured_prerequisites INTO target
   FROM content_versions WHERE id=target_id AND version=target_version FOR SHARE;
 IF NOT FOUND OR target.origin<>'curated' OR target.state<>'published'
    OR target.requires_qualified_signoff
    OR EXISTS(SELECT 1 FROM content_versions newer WHERE newer.id=target_id
      AND newer.version>target_version AND newer.published_at IS NOT NULL)
 THEN RETURN false; END IF;
 spec := effective_prerequisite_spec(target.structured_prerequisites,target.prerequisites);
 IF spec IS NULL THEN RETURN false; END IF;
 FOR atom IN SELECT element FROM jsonb_array_elements(spec->'all') AS atoms(element)
   ORDER BY element->>'kind',element->>'id',element->>'version' LOOP
  IF atom->>'kind'='exercise' THEN
   SELECT EXISTS(SELECT 1 FROM exercises e WHERE e.learner_id=p_member_id
     AND e.workspace_id=p_member_id AND e.lesson_id=atom->>'id'
     AND e.lesson_version=(atom->>'version')::integer
     AND e.completed_at IS NOT NULL) INTO observed;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM content_versions ref
      WHERE ref.id=atom->>'id' AND ref.version=(atom->>'version')::integer
        AND ref.kind='lesson' AND ref.origin='curated') THEN RETURN false; END IF;
   IF NOT member_prerequisites_met(p_member_id,atom->>'id',
      (atom->>'version')::integer,array_append(seen,identity)) THEN RETURN false; END IF;
   SELECT EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=p_member_id
     AND a.content_id=atom->>'id' AND a.content_version=(atom->>'version')::integer
     AND CASE WHEN atom->>'activity'='started' THEN a.started_at IS NOT NULL
       ELSE a.self_assessed_at IS NOT NULL END) INTO observed;
  END IF;
  IF NOT observed THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION member_content_eligible(p_member_id uuid, content_id text,
 content_version integer)
RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM learners l JOIN content_versions cv
   ON cv.id=content_id AND cv.version=content_version
   WHERE l.id=p_member_id
     AND (cardinality(cv.goals)=0 OR l.goal=ANY(cv.goals))
     AND (cardinality(cv.backgrounds)=0 OR l.background=ANY(cv.backgrounds)
       OR cv.backgrounds && l.background_tags)
     AND (cardinality(cv.domains)=0 OR cv.domains && l.domain_tags)
     AND array_position(ARRAY['new','some','experienced'],COALESCE(l.experience,'new'))
       >= array_position(ARRAY['new','some','experienced'],cv.minimum_experience)
     AND member_prerequisites_met(l.id,cv.id,cv.version));
$$;

INSERT INTO schema_migrations(version) VALUES(26) ON CONFLICT DO NOTHING;
COMMIT;
