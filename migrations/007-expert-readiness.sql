BEGIN;
CREATE TABLE IF NOT EXISTS expert_registry (
 id uuid PRIMARY KEY,
 staff_id uuid NOT NULL,
 staff_role text NOT NULL CHECK(staff_role IN ('coach','reviewer')),
 domain text NOT NULL CHECK(domain IN ('education','health','finance','creative','public','operations')),
 service_type text NOT NULL CHECK(service_type IN ('coaching','formal-review')),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 loaded_cost_cents integer NOT NULL CHECK(loaded_cost_cents >= 0),
 capacity_minutes integer NOT NULL CHECK(capacity_minutes >= 0),
 committed_minutes integer NOT NULL DEFAULT 0 CHECK(committed_minutes >= 0),
 backup_staff_id uuid REFERENCES staff_profiles(principal_id),
 qualification_ref text NOT NULL DEFAULT '',
 agreement_ref text NOT NULL DEFAULT '',
 conflict_review_ref text NOT NULL DEFAULT '',
 verified_by uuid REFERENCES staff_profiles(principal_id),
 verified_at timestamptz,
 retired_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(ends_at > starts_at),
 CHECK(committed_minutes <= capacity_minutes),
 CHECK((staff_role='coach' AND service_type='coaching') OR
       (staff_role='reviewer' AND service_type='formal-review')),
 CHECK((verified_by IS NULL)=(verified_at IS NULL)),
 CHECK(verified_by IS NULL OR verified_by<>staff_id),
 FOREIGN KEY(staff_id,staff_role) REFERENCES staff_profiles(principal_id,role),
 CHECK(verified_at IS NULL OR
       (length(qualification_ref)>0 AND length(agreement_ref)>0 AND
        length(conflict_review_ref)>0 AND backup_staff_id IS NOT NULL AND
        backup_staff_id<>staff_id))
);
CREATE OR REPLACE FUNCTION validate_expert_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.verified_by IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM staff_profiles s WHERE s.principal_id=NEW.verified_by
     AND s.role='platform_admin'
 ) THEN RAISE EXCEPTION 'Expert verification requires platform administrator evidence review'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS expert_verifier_role ON expert_registry;
CREATE TRIGGER expert_verifier_role BEFORE INSERT OR UPDATE ON expert_registry
 FOR EACH ROW EXECUTE FUNCTION validate_expert_verification();
CREATE INDEX IF NOT EXISTS expert_registry_coverage_idx
 ON expert_registry(domain,service_type,ends_at) WHERE retired_at IS NULL;
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
COMMIT;
