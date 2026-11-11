-- #94: no automatic cancellation or refund rules (owner, 9 and 10 November
-- 2026). When a student has contacted info@deepnative.io, an administrator
-- records what was agreed and why. Append-only; changes nothing by itself.
BEGIN;
CREATE TABLE IF NOT EXISTS coaching_agreed_changes (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('early_release','refund','other')),
 agreed text NOT NULL CHECK(length(btrim(agreed)) BETWEEN 1 AND 1000),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,operation_id)
);
CREATE INDEX IF NOT EXISTS coaching_agreed_changes_owner_idx
 ON coaching_agreed_changes(owner_id,created_at);
DROP TRIGGER IF EXISTS coaching_agreed_changes_immutable ON coaching_agreed_changes;
CREATE TRIGGER coaching_agreed_changes_immutable BEFORE UPDATE OR DELETE ON coaching_agreed_changes
 FOR EACH ROW EXECUTE FUNCTION preserve_coaching_history();
INSERT INTO schema_migrations(version) VALUES(138) ON CONFLICT DO NOTHING;
COMMIT;
