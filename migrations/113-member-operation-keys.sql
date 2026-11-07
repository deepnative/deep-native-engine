BEGIN;
-- #42 A member's operation key is unique only within that member, so another
-- member's key reads and acts exactly like an unused one.
ALTER TABLE provided_evidence_operations DROP CONSTRAINT IF EXISTS provided_evidence_operations_operation_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS provided_evidence_operations_member_key ON provided_evidence_operations(member_id,operation_id);
ALTER TABLE assignment_evidence_operations DROP CONSTRAINT IF EXISTS assignment_evidence_operations_operation_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS assignment_evidence_operations_member_key ON assignment_evidence_operations(member_id,operation_id);
ALTER TABLE proposal_publications DROP CONSTRAINT IF EXISTS proposal_publications_operation_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS proposal_publications_member_key ON proposal_publications(member_id,operation_id);
INSERT INTO schema_migrations(version) VALUES(113) ON CONFLICT DO NOTHING;
COMMIT;
