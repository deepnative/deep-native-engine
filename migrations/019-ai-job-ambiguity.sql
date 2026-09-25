BEGIN;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=19) THEN
ALTER TABLE adapter_jobs
 DROP CONSTRAINT adapter_jobs_status_check,
 ADD CONSTRAINT adapter_jobs_status_check
  CHECK(status IN ('pending','running','succeeded','failed','exhausted','needs_reconciliation')),
 DROP CONSTRAINT adapter_jobs_safe_error_check,
 ADD CONSTRAINT adapter_jobs_safe_error_check
  CHECK(safe_error IN ('provider_unavailable','provider_timeout','invalid_provider_response','provider_outcome_unknown')),
 ADD CONSTRAINT adapter_jobs_ai_reconciliation_check
  CHECK(status <> 'needs_reconciliation' OR
        (adapter='ai' AND safe_error IN ('provider_timeout','provider_outcome_unknown')));
INSERT INTO schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
END IF;
END $$;
COMMIT;
