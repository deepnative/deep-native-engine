import type { Pool } from "pg";
import { hash } from "./store.ts";
import { workflowBundle } from "./workflow-registry.ts";

export interface WorkflowFeedback {
  workflowId: string;
  workflowVersion: number;
  note: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowFeedbackStore {
  list(token: string): Promise<WorkflowFeedback[]>;
  save(
    token: string,
    workflowId: string,
    workflowVersion: number,
    note: string,
    expectedRevision: number,
  ): Promise<boolean>;
  withdraw(
    token: string,
    workflowId: string,
    workflowVersion: number,
    expectedRevision: number,
  ): Promise<boolean>;
}

export function parseWorkflowFeedback(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim();
  return note.length >= 1 && note.length <= 1000 ? note : null;
}

export function disabledWorkflowFeedbackStore(): WorkflowFeedbackStore {
  return {
    list: async () => [],
    save: async () => false,
    withdraw: async () => false,
  };
}

const owner = `FROM principals p JOIN learners l ON l.id=p.id
  WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
    AND p.expires_at>CURRENT_TIMESTAMP`;

export function workflowFeedbackStore(pool: Pool): WorkflowFeedbackStore {
  return {
    async list(token) {
      return (
        await pool.query<WorkflowFeedback>(
          `SELECT f.workflow_id AS "workflowId",
             f.workflow_version AS "workflowVersion",f.note,f.revision,
             f.created_at AS "createdAt",f.updated_at AS "updatedAt"
           FROM principals p JOIN learners l ON l.id=p.id
           JOIN workflow_feedback f ON f.member_id=l.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP
           ORDER BY f.workflow_id,f.workflow_version`,
          [hash(token)],
        )
      ).rows;
    },
    async save(token, workflowId, workflowVersion, rawNote, expectedRevision) {
      const note = parseWorkflowFeedback(rawNote);
      if (
        !note ||
        !Number.isSafeInteger(workflowVersion) ||
        workflowVersion < 1 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        return false;
      const current = await workflowBundle(workflowId);
      if (!current || current.version !== workflowVersion) return false;
      if (expectedRevision === 0) {
        const result = await pool.query(
          `WITH authorized AS MATERIALIZED (
             SELECT l.id AS member_id ${owner} FOR SHARE OF p,l
           )
           INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note)
           SELECT member_id,$2,$3,$4 FROM authorized
           ON CONFLICT DO NOTHING RETURNING revision`,
          [hash(token), workflowId, workflowVersion, note],
        );
        return result.rowCount === 1;
      }
      const result = await pool.query(
        `WITH authorized AS MATERIALIZED (
           SELECT l.id AS member_id ${owner} FOR SHARE OF p,l
         )
         UPDATE workflow_feedback f SET note=$4,revision=f.revision+1,
           updated_at=CURRENT_TIMESTAMP
         FROM authorized a WHERE f.member_id=a.member_id
           AND f.workflow_id=$2 AND f.workflow_version=$3
           AND f.revision=$5 RETURNING f.revision`,
        [hash(token), workflowId, workflowVersion, note, expectedRevision],
      );
      return result.rowCount === 1;
    },
    async withdraw(token, workflowId, workflowVersion, expectedRevision) {
      if (
        !/^WF-\d{3}$/.test(workflowId) ||
        !Number.isSafeInteger(workflowVersion) ||
        workflowVersion < 1 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1
      )
        return false;
      try {
        const client = await pool.connect();
        let releaseError: Error | undefined;
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await client.query("SET LOCAL lock_timeout='5s'");
          // Hold principal and workspace before waiting for an export's
          // feedback-row lock. Revocation and account deletion cannot pass
          // those shared locks; expiry is checked again after the row wait.
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
            `DELETE FROM workflow_feedback WHERE member_id=$1
             AND workflow_id=$2 AND workflow_version=$3 AND revision=$4
             RETURNING revision`,
            [principal.id, workflowId, workflowVersion, expectedRevision],
          );
          if (deleted.rowCount !== 1) return false;
          const current = await client.query<{ valid: boolean }>(
            "SELECT clock_timestamp() < $1::timestamptz AS valid",
            [principal.expiresAt],
          );
          if (!current.rows[0]?.valid) return false;
          await client.query("COMMIT");
          return true;
        } finally {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Feedback withdrawal rollback failed");
          }
          client.release(releaseError);
        }
      } catch {
        return false;
      }
    },
  };
}
