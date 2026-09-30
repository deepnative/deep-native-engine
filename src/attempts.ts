import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { hash } from "./store.ts";

export interface AssignmentAttempt {
  id: string;
  contentId: string;
  contentVersion: number;
  title: string;
  rubric: string | null;
  rubricVersion: number | null;
  goalAtStart: string;
  response: string;
  revision: number;
  startedAt: Date;
  savedAt: Date | null;
  submittedAt: Date | null;
  submissionCount?: number;
  submissionHistory?: Pick<AssignmentSubmission, "sequence" | "submittedAt">[];
  submissions?: AssignmentSubmission[];
  currentPublished: boolean;
  currentEligible: boolean;
}
export interface AssignmentSubmission {
  sequence: number;
  response: string;
  submittedAt: string;
  reflection?: AssignmentReflection | null;
  reflectionRevision?: number;
}
export interface AssignmentReflection {
  evidence: string;
  gaps: string;
  intention: string;
  revision: number;
}
export type AssignmentReflectionInput = Pick<
  AssignmentReflection,
  "evidence" | "gaps" | "intention"
>;
export type AssignmentAttemptListItem = Omit<
  AssignmentAttempt,
  "response" | "submissions" | "rubric" | "rubricVersion"
>;
export interface AttemptStore {
  list(token: string): Promise<AssignmentAttemptListItem[] | null>;
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
  saveReflection(
    token: string,
    id: string,
    sequence: number,
    expectedRevision: number,
    input: AssignmentReflectionInput,
  ): Promise<boolean>;
  deleteReflection(
    token: string,
    id: string,
    sequence: number,
    expectedRevision: number,
  ): Promise<boolean>;
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
    saveReflection: async () => false,
    deleteReflection: async () => false,
  };
}

export function validReflectionInput(
  input: AssignmentReflectionInput,
): boolean {
  if (!input || typeof input !== "object") return false;
  const fields = [input.evidence, input.gaps, input.intention];
  return (
    fields.every(
      (field) => typeof field === "string" && field.length <= 1000,
    ) && fields.some((field) => field.trim().length > 0)
  );
}

function validReflectionTarget(sequence: number, expectedRevision: number) {
  return (
    Number.isSafeInteger(sequence) &&
    sequence >= 1 &&
    sequence <= 10 &&
    Number.isSafeInteger(expectedRevision) &&
    expectedRevision >= 0 &&
    expectedRevision < 2147483647
  );
}

const activeMember = `p.kind='member' AND p.token_hash=$1 AND p.revoked_at IS NULL
  AND p.expires_at>CURRENT_TIMESTAMP`;
const currentPublished = `cv.kind='assignment' AND cv.state='published' AND NOT EXISTS(
  SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
    AND newer.published_at IS NOT NULL AND newer.version>cv.version)`;
const eligible = `${currentPublished}
  AND member_content_eligible(l.id,cv.id,cv.version)`;
const columns = `a.id,a.content_id AS "contentId",a.content_version AS "contentVersion",
  cv.title,a.goal_at_start AS "goalAtStart",a.revision,
  a.started_at AS "startedAt",a.saved_at AS "savedAt",a.submitted_at AS "submittedAt",
  a.submission_count AS "submissionCount",
  (${currentPublished}) AS "currentPublished",
  COALESCE((ch.content_id=a.content_id AND ch.content_version=a.content_version
    AND ${eligible}),false) AS "currentEligible"`;

export function attemptStore(pool: Pool): AttemptStore {
  async function authorizedOperation<Row extends QueryResultRow>(
    statement: string,
    values: unknown[],
  ) {
    const client = await pool.connect();
    let committed = false;
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      // Match owner export and deletion: principal, workspace, then attempt.
      // The shared locks keep revocation and workspace deletion serialized.
      const principal = (
        await client.query<{ id: string; expiresAt: Date }>(
          `SELECT id,expires_at AS "expiresAt" FROM principals
           WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL
             AND expires_at>clock_timestamp() FOR SHARE`,
          [values[0]],
        )
      ).rows[0];
      if (!principal) return null;
      const workspace = await client.query(
        `SELECT id FROM workspaces WHERE owner_principal_id=$1
         AND deleting_at IS NULL FOR SHARE`,
        [principal.id],
      );
      if (!workspace.rows[0]) return null;
      const result = await client.query<Row>(statement, values);
      // CURRENT_TIMESTAMP predates lock waits. Check wall time after every
      // operation, including reads, insert conflicts and snapshot insertion.
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expiresAt],
      );
      if (!current.rows[0]?.valid) return null;
      await client.query("COMMIT");
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          releaseError = new Error("Attempt operation rollback failed");
        }
      }
      client.release(releaseError);
    }
  }
  return {
    async list(token) {
      const result = await authorizedOperation<AssignmentAttemptListItem>(
        `SELECT ${columns},COALESCE((SELECT jsonb_agg(
              jsonb_build_object('sequence',s.sequence,'submittedAt',s.submitted_at)
                ORDER BY s.sequence)
              FROM assignment_submission_snapshots s WHERE s.attempt_id=a.id),
              '[]'::jsonb) AS "submissionHistory" FROM assignment_attempts a
         JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
         JOIN learners l ON l.id=a.member_id JOIN principals p ON p.id=l.id
         LEFT JOIN learner_assignment_choices ch ON ch.member_id=l.id
         WHERE ${activeMember} ORDER BY a.started_at DESC,a.id`,
        [hash(token)],
      );
      return result?.rows ?? null;
    },
    async detail(token, id) {
      const client = await pool.connect();
      let committed = false;
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout='5s'");
        const principal = (
          await client.query<{ id: string; expiresAt: Date }>(
            `SELECT id,expires_at AS "expiresAt" FROM principals
             WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL
               AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) return null;
        const workspace = await client.query(
          `SELECT id FROM workspaces WHERE owner_principal_id=$1
           AND deleting_at IS NULL FOR SHARE`,
          [principal.id],
        );
        if (!workspace.rows[0]) return null;
        const attempt = (
          await client.query<AssignmentAttempt>(
            `SELECT ${columns},cv.rubric,
              cv.rubric_version AS "rubricVersion",a.response
             FROM assignment_attempts a
             JOIN content_versions cv ON cv.id=a.content_id
               AND cv.version=a.content_version
             JOIN learners l ON l.id=a.member_id
             LEFT JOIN learner_assignment_choices ch ON ch.member_id=l.id
             WHERE a.member_id=$1 AND a.id=$2 FOR SHARE OF a`,
            [principal.id, id],
          )
        ).rows[0];
        if (!attempt) return null;
        // Lock retained text before reading it. A concurrent deletion must
        // either finish first or wait until this owner-only read commits.
        await client.query(
          `SELECT sequence FROM assignment_submission_reflections
           WHERE attempt_id=$1 FOR SHARE`,
          [id],
        );
        const submissions = await client.query<AssignmentSubmission>(
          `SELECT s.sequence,s.response,s.submitted_at AS "submittedAt",
             CASE WHEN r.deleted_at IS NULL AND r.revision IS NOT NULL THEN
               jsonb_build_object('evidence',r.evidence,'gaps',r.gaps,
                 'intention',r.intention,'revision',r.revision)
             ELSE NULL END AS reflection,
             COALESCE(r.revision,0) AS "reflectionRevision"
           FROM assignment_submission_snapshots s
           LEFT JOIN assignment_submission_reflections r
             ON r.attempt_id=s.attempt_id AND r.sequence=s.sequence
           WHERE s.attempt_id=$1 ORDER BY s.sequence`,
          [id],
        );
        const current = await client.query<{ valid: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS valid",
          [principal.expiresAt],
        );
        if (!current.rows[0]?.valid) return null;
        await client.query("COMMIT");
        committed = true;
        attempt.submissions = submissions.rows.map((entry) => ({
          ...entry,
          submittedAt: new Date(entry.submittedAt).toISOString(),
        }));
        return attempt;
      } finally {
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Attempt detail rollback failed");
          }
        }
        client.release(releaseError);
      }
    },
    async start(token) {
      const result = await authorizedOperation<{ id: string }>(
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
      return result?.rows[0]?.id ?? null;
    },
    async save(token, id, revision, response) {
      const result = await authorizedOperation(
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
      return result?.rowCount === 1;
    },
    async submit(token, id, revision) {
      const result = await authorizedOperation(
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
      return result?.rowCount === 1;
    },
    async revise(token, id) {
      const result = await authorizedOperation(
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
      return result?.rowCount === 1;
    },
    async saveReflection(token, id, sequence, expectedRevision, input) {
      if (
        !validReflectionTarget(sequence, expectedRevision) ||
        !validReflectionInput(input)
      )
        return false;
      const values = [
        hash(token),
        id,
        sequence,
        input.evidence,
        input.gaps,
        input.intention,
      ];
      const owned = `WITH owned AS MATERIALIZED (
        SELECT a.id FROM assignment_attempts a
        JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
          AND s.sequence=$3
        JOIN learners l ON l.id=a.member_id
        JOIN principals p ON p.id=l.id
        WHERE ${activeMember} AND a.id=$2 FOR SHARE OF a
      )`;
      const result =
        expectedRevision === 0
          ? await authorizedOperation(
              `${owned}
               INSERT INTO assignment_submission_reflections
                 (attempt_id,sequence,evidence,gaps,intention)
               SELECT id,$3,$4,$5,$6 FROM owned
               ON CONFLICT DO NOTHING RETURNING revision`,
              values,
            )
          : await authorizedOperation(
              `${owned}
               UPDATE assignment_submission_reflections r
               SET evidence=$4,gaps=$5,intention=$6,
                 revision=r.revision+1,updated_at=clock_timestamp()
               FROM owned WHERE r.attempt_id=owned.id AND r.sequence=$3
                 AND r.revision=$7 AND r.deleted_at IS NULL
               RETURNING r.revision`,
              [...values, expectedRevision],
            );
      return result?.rowCount === 1;
    },
    async deleteReflection(token, id, sequence, expectedRevision) {
      if (
        !validReflectionTarget(sequence, expectedRevision) ||
        expectedRevision === 0
      )
        return false;
      const result = await authorizedOperation(
        `WITH owned AS MATERIALIZED (
           SELECT a.id FROM assignment_attempts a
           JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
             AND s.sequence=$3
           JOIN learners l ON l.id=a.member_id
           JOIN principals p ON p.id=l.id
           WHERE ${activeMember} AND a.id=$2 FOR SHARE OF a
         )
         UPDATE assignment_submission_reflections r
         SET evidence='',gaps='',intention='',deleted_at=clock_timestamp(),
           revision=r.revision+1,updated_at=clock_timestamp()
         FROM owned WHERE r.attempt_id=owned.id AND r.sequence=$3
           AND r.revision=$4 AND r.deleted_at IS NULL
         RETURNING r.revision`,
        [hash(token), id, sequence, expectedRevision],
      );
      return result?.rowCount === 1;
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
