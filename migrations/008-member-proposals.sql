BEGIN;
CREATE TABLE IF NOT EXISTS member_proposals (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
 title text,
 body text,
 sources text,
 state text NOT NULL DEFAULT 'draft'
   CHECK(state IN ('draft','submitted','quarantined','rejected','withdrawn')),
 sample_attested_at timestamptz NOT NULL,
 rights_attested_at timestamptz,
 submitted_at timestamptz,
 moderated_by uuid REFERENCES staff_profiles(principal_id),
 moderated_at timestamptz,
 withdrawn_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(state NOT IN ('draft','submitted','quarantined') OR
   (title IS NOT NULL AND length(title) BETWEEN 1 AND 160 AND
    body IS NOT NULL AND length(body) BETWEEN 1 AND 4000 AND
    sources IS NOT NULL AND length(sources) BETWEEN 1 AND 1000)),
 CHECK(state NOT IN ('rejected','withdrawn') OR
   (title IS NULL AND body IS NULL AND sources IS NULL)),
 CHECK(state NOT IN ('submitted','quarantined','rejected') OR
   (rights_attested_at IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK(state NOT IN ('quarantined','rejected') OR
   (moderated_by IS NOT NULL AND moderated_at IS NOT NULL)),
 CHECK(state <> 'withdrawn' OR withdrawn_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS member_proposals_member_idx
 ON member_proposals(member_id,created_at DESC);
CREATE INDEX IF NOT EXISTS member_proposals_moderation_idx
 ON member_proposals(state,created_at) WHERE state IN ('submitted','quarantined');
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
COMMIT;
