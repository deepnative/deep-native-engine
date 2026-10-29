BEGIN;
CREATE OR REPLACE FUNCTION member_prerequisites_met(p_member_id uuid, target_id text,
 target_version integer, seen text[] DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 RETURN (
  WITH RECURSIVE reachable(id,version) AS (
   SELECT target_id,target_version
   UNION
   SELECT atom->>'id',(atom->>'version')::integer
   FROM reachable r JOIN content_versions cv ON cv.id=r.id AND cv.version=r.version
   CROSS JOIN LATERAL jsonb_array_elements(
     effective_prerequisite_spec(cv.structured_prerequisites,cv.prerequisites)->'all') atom
   WHERE atom->>'kind'='lesson'
  ),
  nodes AS MATERIALIZED (
   SELECT cv.id,cv.version,cv.kind,cv.origin,cv.state,cv.requires_qualified_signoff,
     effective_prerequisite_spec(cv.structured_prerequisites,cv.prerequisites) AS spec
   FROM content_versions cv JOIN reachable r ON r.id=cv.id AND r.version=cv.version
   ORDER BY cv.id,cv.version FOR SHARE OF cv
  ),
  requirements AS MATERIALIZED (
   SELECT n.id,n.version,atom
   FROM nodes n CROSS JOIN LATERAL jsonb_array_elements(n.spec->'all') atom
  ),
  -- UNION deduplicates shared paths; bounded depths still reject cycles and long paths.
  depths(id,version,depth) AS (
   SELECT target_id,target_version,cardinality(COALESCE(seen,'{}'))
   UNION
   SELECT req.atom->>'id',(req.atom->>'version')::integer,d.depth+1
   FROM depths d JOIN requirements req ON req.id=d.id AND req.version=d.version
   WHERE d.depth<=32 AND req.atom->>'kind'='lesson'
  )
  SELECT NOT EXISTS(SELECT 1 FROM depths WHERE depth>32)
   AND NOT EXISTS(SELECT 1 FROM reachable r WHERE (r.id||':'||r.version)=ANY(seen)
     OR NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=r.id AND n.version=r.version))
   AND NOT EXISTS(SELECT 1 FROM nodes n
     WHERE n.origin<>'curated' OR n.state<>'published' OR n.requires_qualified_signoff
       OR n.spec IS NULL OR EXISTS(SELECT 1 FROM content_versions newer
         WHERE newer.id=n.id AND newer.version>n.version AND newer.published_at IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM requirements req WHERE
     CASE WHEN req.atom->>'kind'='exercise' THEN
       NOT EXISTS(SELECT 1 FROM exercises e WHERE e.learner_id=p_member_id
         AND e.workspace_id=p_member_id AND e.lesson_id=req.atom->>'id'
         AND e.lesson_version=(req.atom->>'version')::integer AND e.completed_at IS NOT NULL)
     ELSE
       NOT EXISTS(SELECT 1 FROM nodes ref WHERE ref.id=req.atom->>'id'
         AND ref.version=(req.atom->>'version')::integer AND ref.kind='lesson')
       OR NOT EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=p_member_id
         AND a.content_id=req.atom->>'id' AND a.content_version=(req.atom->>'version')::integer
         AND CASE WHEN req.atom->>'activity'='started' THEN a.started_at IS NOT NULL
           ELSE a.self_assessed_at IS NOT NULL END)
     END)
 );
END $$;
INSERT INTO schema_migrations(version) VALUES(77) ON CONFLICT DO NOTHING;
COMMIT;
