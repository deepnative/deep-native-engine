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
  submissionCount?: number;
  submissions?: AssignmentSubmission[];
  currentPublished: boolean;
  currentEligible: boolean;
}
export interface AssignmentSubmission {
  sequence: number;
  response: string;
  submittedAt: string;
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
  revise(token: string, id: string): Promise<boolean>;
  remove(token: string, id: string): Promise<boolean>;
}
export function disabledAttemptStore(): AttemptStore {
  return {
    list: async () => [],
    detail: async () => null,
    start: async () => null,
    save: async () => false,
    submit: async () => false,
    revise: async () => false,
    remove: async () => false,
  };
}

const activeMember = `p.kind='member' AND p.token_hash=$1 AND p.revoked_at IS NULL
  AND p.expires_at>CURRENT_TIMESTAMP`;
const currentPublished = `cv.kind='assignment' AND cv.state='published' AND NOT EXISTS(
  SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
    AND newer.published_at IS NOT NULL AND newer.version>cv.version)`;
const eligible = `${currentPublished}
  AND member_content_eligible(l.id,cv.id,cv.version)`;
const columns = `a.id,a.content_id AS "contentId",a.content_version AS "contentVersion",
  cv.title,a.goal_at_start AS "goalAtStart",a.response,a.revision,
  a.started_at AS "startedAt",a.saved_at AS "savedAt",a.submitted_at AS "submittedAt",
  a.submission_count AS "submissionCount",
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
            `SELECT ${columns},COALESCE((SELECT jsonb_agg(
              jsonb_build_object('sequence',s.sequence,'response',s.response,
                'submittedAt',s.submitted_at) ORDER BY s.sequence)
              FROM assignment_submission_snapshots s WHERE s.attempt_id=a.id),
              '[]'::jsonb) AS submissions FROM assignment_attempts a
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
        `WITH submitted AS (
         UPDATE assignment_attempts a SET submitted_at=CURRENT_TIMESTAMP,
           submission_count=a.submission_count+1
         FROM principals p JOIN learners l ON l.id=p.id
         JOIN learner_assignment_choices ch ON ch.member_id=l.id
         JOIN content_versions cv ON cv.id=ch.content_id AND cv.version=ch.content_version
         WHERE ${activeMember} AND a.member_id=l.id AND a.id=$2 AND a.revision=$3
           AND a.saved_at IS NOT NULL AND length(btrim(a.response))>=20
           AND a.submitted_at IS NULL AND a.submission_count<10
           AND a.content_id=cv.id AND a.content_version=cv.version AND ${eligible}
         RETURNING a.id,a.submission_count,a.response,a.submitted_at
         )
         INSERT INTO assignment_submission_snapshots(attempt_id,sequence,response,submitted_at)
         SELECT id,submission_count,response,submitted_at FROM submitted
         RETURNING attempt_id`,
        [hash(token), id, revision],
      );
      return result.rowCount === 1;
    },
    async revise(token, id) {
      const result = await pool.query(
        `UPDATE assignment_attempts a SET response='',saved_at=NULL,
           submitted_at=NULL,revision=a.revision+1
         FROM principals p JOIN learners l ON l.id=p.id
         JOIN learner_assignment_choices ch ON ch.member_id=l.id
         JOIN content_versions cv ON cv.id=ch.content_id AND cv.version=ch.content_version
         WHERE ${activeMember} AND a.member_id=l.id AND a.id=$2
           AND a.submitted_at IS NOT NULL AND a.submission_count BETWEEN 1 AND 9
           AND a.content_id=cv.id AND a.content_version=cv.version AND ${eligible}`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
    async remove(token, id) {
      try {
        const client = await pool.connect();
        let committed = false;
        let releaseError: Error | undefined;
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await client.query("SET LOCAL lock_timeout='5s'");
          // Match owner export and account deletion: principal, workspace,
          // then the attempt whose deletion cascades its submission history.
          const principal = (
            await client.query<{ id: string; expiresAt: Date }>(
              `SELECT id,expires_at AS "expiresAt" FROM principals
               WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL
                 AND expires_at>clock_timestamp() FOR SHARE`,
              [hash(token)],
            )
          ).rows[0];
          if (!principal) return false;
          const workspace = await client.query(
            `SELECT id FROM workspaces WHERE owner_principal_id=$1
             AND deleting_at IS NULL FOR SHARE`,
            [principal.id],
          );
          if (!workspace.rows[0]) return false;
          const deleted = await client.query(
            `DELETE FROM assignment_attempts WHERE member_id=$1 AND id=$2`,
            [principal.id, id],
          );
          if (deleted.rowCount !== 1) return false;
          // CURRENT_TIMESTAMP is fixed at transaction start, which may be
          // older than a wait on an export's attempt row lock.
          const current = await client.query<{ valid: boolean }>(
            "SELECT clock_timestamp() < $1::timestamptz AS valid",
            [principal.expiresAt],
          );
          if (!current.rows[0]?.valid) return false;
          await client.query("COMMIT");
          committed = true;
          return true;
        } finally {
          if (!committed) {
            try {
              await client.query("ROLLBACK");
            } catch {
              releaseError = new Error("Attempt deletion rollback failed");
            }
          }
          client.release(releaseError);
        }
      } catch {
        // A lost commit acknowledgement leaves deletion uncertain, never a
        // confirmed success. The caller directs the member to inspect state.
        return false;
      }
    },
  };
}
