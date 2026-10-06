BEGIN;
CREATE INDEX IF NOT EXISTS preview_circle_grant_audit_scope_idx
 ON preview_circle_grant_audit(staff_id,circle_id,grant_id,id);
INSERT INTO schema_migrations(version) VALUES(61) ON CONFLICT DO NOTHING;
COMMIT;
