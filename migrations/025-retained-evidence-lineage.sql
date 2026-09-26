BEGIN;
-- A deleted source must not erase the parent ID on its surviving owner-bound
-- revision. Existing version >1 rows whose FK was already nulled cannot have
-- their former parent ID reconstructed; the reader/export identify that state.
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM evidence_objects child
  JOIN evidence_objects parent ON parent.id=child.revision_parent_id
  WHERE child.owner_principal_id<>parent.owner_principal_id
     OR child.workspace_id<>parent.workspace_id
     OR child.revision_number<>parent.revision_number+1
 ) THEN
  RAISE EXCEPTION 'Existing evidence revision lineage is inconsistent';
 END IF;
END $$;
ALTER TABLE evidence_objects
 DROP CONSTRAINT IF EXISTS evidence_objects_revision_parent_id_fkey;

CREATE OR REPLACE FUNCTION validate_evidence_revision_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 parent_owner uuid;
 parent_workspace uuid;
 parent_number integer;
 parent_state text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.revision_parent_id IS DISTINCT FROM OLD.revision_parent_id
     OR NEW.revision_number IS DISTINCT FROM OLD.revision_number THEN
   RAISE EXCEPTION 'Evidence revision lineage is immutable';
  END IF;
  RETURN NEW;
 END IF;

 IF NEW.revision_parent_id IS NULL THEN
  IF NEW.revision_number<>1 THEN
   RAISE EXCEPTION 'New evidence revisions require a parent';
  END IF;
  RETURN NEW;
 END IF;

 SELECT owner_principal_id,workspace_id,revision_number,quarantine_state
 INTO parent_owner,parent_workspace,parent_number,parent_state
 FROM evidence_objects WHERE id=NEW.revision_parent_id FOR SHARE;
 IF NOT FOUND OR parent_owner<>NEW.owner_principal_id
    OR parent_workspace<>NEW.workspace_id
    OR parent_number+1<>NEW.revision_number OR parent_state='deleting' THEN
  RAISE EXCEPTION 'Invalid evidence revision parent';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS evidence_objects_revision_lineage_guard ON evidence_objects;
CREATE TRIGGER evidence_objects_revision_lineage_guard
 BEFORE INSERT OR UPDATE OF revision_parent_id,revision_number
 ON evidence_objects FOR EACH ROW
 EXECUTE FUNCTION validate_evidence_revision_lineage();

INSERT INTO schema_migrations(version) VALUES(25) ON CONFLICT DO NOTHING;
COMMIT;
