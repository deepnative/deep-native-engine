BEGIN;
CREATE TABLE IF NOT EXISTS adapter_jobs (
 id uuid PRIMARY KEY,
 adapter text NOT NULL CHECK(adapter IN ('ai','payment','storage','calendar','email','auth','analytics')),
 mode text NOT NULL CHECK(mode IN ('demo','test','live')),
 operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 80),
 idempotency_key text NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 120),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','exhausted')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND max_attempts),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
 safe_error text CHECK(safe_error IN ('provider_unavailable','provider_timeout','invalid_provider_response')),
 attempt_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='running') = (attempt_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS adapter_jobs_status_idx ON adapter_jobs(status,updated_at);
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
