import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction as feedbackTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
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
  ): Promise<WorkflowFeedbackSaveResult>;
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

async function authorize(tx: PracticeTransaction, token: string) {
  const principal = (
    await tx.query<{ id: string; expiresAt: Date }>(
      `SELECT id,expires_at AS "expiresAt" FROM principals
     WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL
       AND expires_at>clock_timestamp() FOR SHARE`,
      [hash(token)],
    )
  ).rows[0];
  if (!principal) throw new PracticeLifetimeFailure("denied");
  await tx.observe([principal.expiresAt]);
  const workspace = await tx.query(
    `SELECT id FROM workspaces WHERE owner_principal_id=$1
    AND deleting_at IS NULL FOR SHARE`,
    [principal.id],
  );
  if (!workspace.rows[0]) throw new PracticeLifetimeFailure("denied");
  return principal;
}

// Reuse the established bounded private transaction engine. Its historical
// practice name does not change feedback's own principal/workspace/row fences.
export function workflowFeedbackStore(pool: Pool): WorkflowFeedbackStore {
  return {
    async list(token) {
      try {
        return await feedbackTransaction(pool, async (tx) => {
          const principal = await authorize(tx, token);
          const rows = (
            await tx.query<WorkflowFeedback>(
              `SELECT workflow_id AS "workflowId",workflow_version AS "workflowVersion",
             note,revision,created_at AS "createdAt",updated_at AS "updatedAt"
             FROM workflow_feedback WHERE member_id=$1 ORDER BY workflow_id,workflow_version`,
              [principal.id],
            )
          ).rows;
          await tx.observe([principal.expiresAt]);
          return rows;
        });
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
      let readyToCommit = false;
      try {
        return await feedbackTransaction(pool, async (tx) => {
          const principal = await authorize(tx, token);
          const current = await tx.bounded(() => workflowBundle(workflowId));
          if (!current || current.version !== workflowVersion)
            throw new PracticeLifetimeFailure("denied");
          const saved =
            expectedRevision === 0
              ? await tx.query(
                  `INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note)
                VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision`,
                  [principal.id, workflowId, workflowVersion, note],
                )
              : await tx.query(
                  `UPDATE workflow_feedback SET note=$4,revision=revision+1,
                updated_at=clock_timestamp() WHERE member_id=$1 AND workflow_id=$2
                AND workflow_version=$3 AND revision=$5 RETURNING revision`,
                  [
                    principal.id,
                    workflowId,
                    workflowVersion,
                    note,
                    expectedRevision,
                  ],
                );
          if (saved.rowCount !== 1) throw new PracticeLifetimeFailure("denied");
          await tx.observe([principal.expiresAt]);
          // From this boundary onward the engine may issue COMMIT. A late or
          // failed acknowledgement requires read-back, never a claimed denial.
          readyToCommit = true;
          return true;
        });
      } catch {
        return readyToCommit ? "uncertain" : false;
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
      let readyToCommit = false;
      try {
        return await feedbackTransaction(pool, async (tx) => {
          const principal = await authorize(tx, token);
          const deleted = await tx.query(
            `DELETE FROM workflow_feedback WHERE member_id=$1
            AND workflow_id=$2 AND workflow_version=$3 AND revision=$4 RETURNING revision`,
            [principal.id, workflowId, workflowVersion, expectedRevision],
          );
          if (deleted.rowCount !== 1)
            throw new PracticeLifetimeFailure("denied");
          await tx.observe([principal.expiresAt]);
          readyToCommit = true;
          return true;
        });
      } catch {
        return readyToCommit ? "uncertain" : false;
      }
    },
  };
}
