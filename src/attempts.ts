import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export interface AssignmentAttempt {
  id: string;
  contentId: string;
  contentVersion: number;
  title: string;
  goalAtStart: string;
  response: string;
  revision: number;
  startedAt: Date;
  savedAt: Date | null;
  submittedAt: Date | null;
  currentPublished: boolean;
  currentEligible: boolean;
}
export interface AttemptStore {
  list(token: string): Promise<AssignmentAttempt[]>;
  detail(token: string, id: string): Promise<AssignmentAttempt | null>;
  start(token: string): Promise<string | null>;
  save(
    token: string,
    id: string,
    revision: number,
    response: string,
  ): Promise<boolean>;
  submit(token: string, id: string, revision: number): Promise<boolean>;
  remove(token: string, id: string): Promise<boolean>;
}
export function disabledAttemptStore(): AttemptStore {
  return {
    list: async () => [],
    detail: async () => null,
    start: async () => null,
    save: async () => false,
    submit: async () => false,
    remove: async () => false,
  };
}

const activeMember = `p.kind='member' AND p.token_hash=$1 AND p.revoked_at IS NULL
  AND p.expires_at>CURRENT_TIMESTAMP`;
const currentPublished = `cv.kind='assignment' AND cv.state='published' AND NOT EXISTS(
  SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
    AND newer.state='published' AND newer.version>cv.version)`;
const eligible = `${currentPublished}
  AND (cardinality(cv.goals)=0 OR l.goal=ANY(cv.goals))
  AND (cardinality(cv.backgrounds)=0 OR l.background=ANY(cv.backgrounds)
    OR cv.backgrounds && l.background_tags)
  AND (cardinality(cv.domains)=0 OR cv.domains && l.domain_tags)
  AND array_position(ARRAY['new','some','experienced'],COALESCE(l.experience,'new'))
    >= array_position(ARRAY['new','some','experienced'],cv.minimum_experience)
  AND (btrim(cv.prerequisites)='' OR lower(btrim(cv.prerequisites))='none'
    OR (cv.prerequisites='LOCAL-FIRST-EXERCISE-COMPLETE' AND EXISTS(
      SELECT 1 FROM exercises e WHERE e.learner_id=l.id AND e.workspace_id=l.id
        AND e.lesson_id='clear-instructions' AND e.lesson_version=1
        AND e.completed_at IS NOT NULL)))`;
const columns = `a.id,a.content_id AS "contentId",a.content_version AS "contentVersion",
  cv.title,a.goal_at_start AS "goalAtStart",a.response,a.revision,
  a.started_at AS "startedAt",a.saved_at AS "savedAt",a.submitted_at AS "submittedAt",
  (${currentPublished}) AS "currentPublished",
  COALESCE((ch.content_id=a.content_id AND ch.content_version=a.content_version
    AND ${eligible}),false) AS "currentEligible"`;

export function attemptStore(pool: Pool): AttemptStore {
  return {
    async list(token) {
      return (
        await pool.query<AssignmentAttempt>(
          `SELECT ${columns} FROM assignment_attempts a
         JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
         JOIN learners l ON l.id=a.member_id JOIN principals p ON p.id=l.id
         LEFT JOIN learner_assignment_choices ch ON ch.member_id=l.id
         WHERE ${activeMember} ORDER BY a.started_at DESC,a.id`,
          [hash(token)],
        )
      ).rows;
    },
    async detail(token, id) {
      return (
        (
          await pool.query<AssignmentAttempt>(
            `SELECT ${columns} FROM assignment_attempts a
         JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
         JOIN learners l ON l.id=a.member_id JOIN principals p ON p.id=l.id
         LEFT JOIN learner_assignment_choices ch ON ch.member_id=l.id
         WHERE ${activeMember} AND a.id=$2`,
            [hash(token), id],
          )
        ).rows[0] ?? null
      );
    },
    async start(token) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO assignment_attempts(id,member_id,content_id,content_version,goal_at_start)
         SELECT $2,l.id,cv.id,cv.version,l.goal FROM principals p
         JOIN learners l ON l.id=p.id
         JOIN learner_assignment_choices ch ON ch.member_id=l.id
         JOIN content_versions cv ON cv.id=ch.content_id AND cv.version=ch.content_version
         WHERE ${activeMember} AND ${eligible}
         ON CONFLICT(member_id,content_id,content_version) DO UPDATE
           SET id=assignment_attempts.id RETURNING id`,
        [hash(token), randomUUID()],
      );
      return result.rows[0]?.id ?? null;
    },
    async save(token, id, revision, response) {
      const result = await pool.query(
        `UPDATE assignment_attempts a SET response=$4,revision=a.revision+1,
           saved_at=CURRENT_TIMESTAMP FROM principals p
         JOIN learners l ON l.id=p.id
         JOIN learner_assignment_choices ch ON ch.member_id=l.id
         JOIN content_versions cv ON cv.id=ch.content_id AND cv.version=ch.content_version
         WHERE ${activeMember} AND a.member_id=l.id AND a.id=$2 AND a.revision=$3
           AND a.submitted_at IS NULL AND a.content_id=cv.id
           AND a.content_version=cv.version AND ${eligible}`,
        [hash(token), id, revision, response],
      );
      return result.rowCount === 1;
    },
    async submit(token, id, revision) {
      const result = await pool.query(
        `UPDATE assignment_attempts a SET submitted_at=CURRENT_TIMESTAMP
         FROM principals p JOIN learners l ON l.id=p.id
         JOIN learner_assignment_choices ch ON ch.member_id=l.id
         JOIN content_versions cv ON cv.id=ch.content_id AND cv.version=ch.content_version
         WHERE ${activeMember} AND a.member_id=l.id AND a.id=$2 AND a.revision=$3
           AND a.saved_at IS NOT NULL AND length(btrim(a.response))>=20
           AND a.submitted_at IS NULL AND a.content_id=cv.id
           AND a.content_version=cv.version AND ${eligible}`,
        [hash(token), id, revision],
      );
      return result.rowCount === 1;
    },
    async remove(token, id) {
      const result = await pool.query(
        `DELETE FROM assignment_attempts a USING learners l,principals p
         WHERE a.member_id=l.id AND p.id=l.id AND ${activeMember} AND a.id=$2`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
  };
}
