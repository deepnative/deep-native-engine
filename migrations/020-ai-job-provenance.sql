BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=20) THEN
ALTER TABLE adapter_jobs
 ADD COLUMN prompt_template_version text,
 ADD COLUMN model_contract_version text,
 ADD COLUMN provider_operation_reference text,
 ADD CONSTRAINT adapter_jobs_ai_versions_check
  CHECK((prompt_template_version IS NULL) = (model_contract_version IS NULL) AND
        (prompt_template_version IS NULL OR
         (prompt_template_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' AND
          model_contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'))),
 ADD CONSTRAINT adapter_jobs_ai_provenance_scope_check
  CHECK(adapter='ai' OR
        (prompt_template_version IS NULL AND model_contract_version IS NULL AND
         provider_operation_reference IS NULL)),
 ADD CONSTRAINT adapter_jobs_ai_reference_check
  CHECK(provider_operation_reference IS NULL OR
        (status='succeeded' AND adapter='ai' AND
         provider_operation_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')),
 ADD CONSTRAINT adapter_jobs_ai_success_reference_check
  CHECK(adapter<>'ai' OR status<>'succeeded' OR
        prompt_template_version IS NULL OR provider_operation_reference IS NOT NULL);
INSERT INTO schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
