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

export type WorkflowFeedbackSaveResult = boolean | "uncertain";

export interface WorkflowFeedbackStore {
  list(token: string): Promise<WorkflowFeedback[] | null>;
  save(
    token: string,
    workflowId: string,
    workflowVersion: number,
    note: string,
    expectedRevision: number,
  ): Promise<WorkflowFeedbackSaveResult>;
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
    list: async () => null,
    save: async () => false,
    withdraw: async () => false,
  };
}

export function workflowFeedbackStore(pool: Pool): WorkflowFeedbackStore {
  return {
    async list(token) {
      try {
        const client = await pool.connect();
        let releaseError: Error | undefined;
        let reports: WorkflowFeedback[];
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await client.query("SET LOCAL lock_timeout='5s'");
          // Use the same principal -> workspace lock order as feedback writes
          // and account deletion. Retained rows are private throughout deletion.
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
          reports = (
            await client.query<WorkflowFeedback>(
              `SELECT workflow_id AS "workflowId",
               workflow_version AS "workflowVersion",note,revision,
               created_at AS "createdAt",updated_at AS "updatedAt"
             FROM workflow_feedback WHERE member_id=$1
             ORDER BY workflow_id,workflow_version`,
              [principal.id],
            )
          ).rows;
          // A lock or query wait may outlive the session; transaction time is
          // insufficient even when revocation/deletion remain blocked.
          const current = await client.query<{ valid: boolean }>(
            "SELECT clock_timestamp() < $1::timestamptz AS valid",
            [principal.expiresAt],
          );
          if (!current.rows[0]?.valid) return null;
          await client.query("COMMIT");
        } finally {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Feedback read rollback failed");
          }
          client.release(releaseError);
        }
        return releaseError ? null : reports;
      } catch {
        return null;
      }
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
      let commitAttempted = false;
      try {
        const client = await pool.connect();
        let releaseError: Error | undefined;
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await client.query("SET LOCAL lock_timeout='5s'");
          // Keep revocation and workspace deletion behind the save. Row and
          // unique-key waits can outlive the session, so check wall time again
          // after the write and roll back before reporting success.
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
          const saved =
            expectedRevision === 0
              ? await client.query(
                  `INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note)
                 VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision`,
                  [principal.id, workflowId, workflowVersion, note],
                )
              : await client.query(
                  `UPDATE workflow_feedback SET note=$4,revision=revision+1,
                   updated_at=clock_timestamp()
                 WHERE member_id=$1 AND workflow_id=$2 AND workflow_version=$3
                   AND revision=$5 RETURNING revision`,
                  [
                    principal.id,
                    workflowId,
                    workflowVersion,
                    note,
                    expectedRevision,
                  ],
                );
          if (saved.rowCount !== 1) return false;
          const current = await client.query<{ valid: boolean }>(
            "SELECT clock_timestamp() < $1::timestamptz AS valid",
            [principal.expiresAt],
          );
          if (!current.rows[0]?.valid) return false;
          commitAttempted = true;
          await client.query("COMMIT");
          return true;
        } finally {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Feedback save rollback failed");
          }
          client.release(releaseError);
        }
      } catch {
        // A lost COMMIT acknowledgement cannot establish whether the write
        // persisted. The caller must offer read-back recovery, not claim denial.
        return commitAttempted ? "uncertain" : false;
      }
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
