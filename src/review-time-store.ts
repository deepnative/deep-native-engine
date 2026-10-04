import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import {
  allocateReviewTime,
  cancelReviewTime,
  reviewTimeReceipt,
  type ReviewTimeResult,
  type ReviewTimeReceipt,
} from "./review-time.ts";

export type ReviewTimeHistory =
  | { kind: "ready"; receipts: ReviewTimeReceipt[]; next: string | null }
  | { kind: "denied" | "unavailable" };

const denied = (): never => {
  throw new SampleFeedbackFailure("denied");
};
/** Owner accounting remains available when new review writes are paused. */
export function reviewTimeStore(
  pool: Pool,
  options: { enabled: boolean; mode: ApplicationMode },
) {
  async function owner<T>(
    token: string,
    writing: boolean,
    use: (
      tx: SampleTransaction,
      memberId: string,
      workspaceId: string,
      deadlines: Date[],
    ) => Promise<T>,
  ): Promise<T | { kind: "denied" | "unavailable" }> {
    if (!sampleToken(token)) return { kind: "denied" };
    try {
      return await sampleFeedbackTransaction(pool, writing, async (tx) => {
        const member = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='member'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!member) return denied();
        const deadlines = [member.expires];
        await tx.observe(deadlines);
        const workspace = (
          await tx.query<{ id: string }>(
            "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
            [member.id],
          )
        ).rows[0];
        if (!workspace) return denied();
        const result = await use(tx, member.id, workspace.id, deadlines);
        await tx.observe(deadlines);
        return result;
      });
    } catch (error) {
      return {
        kind:
          error instanceof SampleFeedbackFailure && error.kind === "denied"
            ? "denied"
            : "unavailable",
      };
    }
  }
  async function ownedAllocation(
    tx: SampleTransaction,
    memberId: string,
    workspaceId: string,
    allocationId: string,
    writing: boolean,
  ) {
    const allocation = (
      await tx.query<{ sourceKey: string }>(
        `SELECT source_key AS "sourceKey" FROM review_time_allocations WHERE id=$1 AND member_id=$2 AND workspace_id=$3 FOR ${writing ? "UPDATE" : "SHARE"}`,
        [allocationId, memberId, workspaceId],
      )
    ).rows[0];
    if (!allocation) return denied();
    return allocation;
  }
  return {
    history(token: string, after?: string): Promise<ReviewTimeHistory> {
      if (after !== undefined && !sampleUuid(after))
        return Promise.resolve({ kind: "denied" });
      return owner<ReviewTimeHistory>(
        token,
        false,
        async (tx, memberId, workspaceId) => {
          if (after !== undefined)
            await ownedAllocation(tx, memberId, workspaceId, after, false);
          const rows = (
            await tx.query<{ id: string }>(
              `SELECT id FROM review_time_allocations WHERE member_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 21 FOR SHARE`,
              [memberId, workspaceId, after ?? null],
            )
          ).rows;
          const receipts: ReviewTimeReceipt[] = [];
          for (const row of rows.slice(0, 20))
            receipts.push(await reviewTimeReceipt(tx, row.id));
          return {
            kind: "ready",
            receipts,
            next: rows.length > 20 ? rows[19]!.id : null,
          };
        },
      );
    },
    allocate(
      token: string,
      evidenceId: string,
      key: string,
      ceiling: number,
    ): Promise<ReviewTimeResult> {
      if (!options.enabled || options.mode === "live")
        return Promise.resolve({ kind: "unavailable" });
      if (
        !sampleUuid(evidenceId) ||
        !sampleUuid(key) ||
        !Number.isSafeInteger(ceiling) ||
        ceiling < 1 ||
        ceiling > 120
      )
        return Promise.resolve({ kind: "denied" });
      return owner<ReviewTimeResult>(
        token,
        true,
        async (tx, memberId, workspaceId, deadlines) => {
          const evidence = (
            await tx.query<{ revision: number }>(
              `SELECT revision_number AS revision FROM evidence_objects WHERE id=$1 AND workspace_id=$2 AND owner_principal_id=$3
           AND quarantine_state='clean' AND private_review_allowed AND media_type='text/plain' FOR UPDATE`,
              [evidenceId, workspaceId, memberId],
            )
          ).rows[0];
          if (!evidence) return denied();
          const submission = (
            await tx.query<{ id: string; status: string }>(
              "SELECT id,status FROM evidence_review_submissions WHERE evidence_id=$1 AND submitted_by=$2 FOR UPDATE",
              [evidenceId, memberId],
            )
          ).rows[0];
          if (!submission || submission.status !== "queued") return denied();
          return allocateReviewTime(
            tx,
            {
              sourceKey: submission.id,
              workspaceId,
              evidenceId,
              sourceRevision: evidence.revision,
              memberId,
              withdrawnAt: null,
              resolvedAt: null,
            },
            key,
            ceiling,
            deadlines,
          );
        },
      );
    },
    receipt(token: string, allocationId: string): Promise<ReviewTimeResult> {
      if (!sampleUuid(allocationId)) return Promise.resolve({ kind: "denied" });
      return owner<ReviewTimeResult>(
        token,
        false,
        async (tx, memberId, workspaceId) => {
          await ownedAllocation(tx, memberId, workspaceId, allocationId, false);
          return {
            kind: "applied",
            receipt: await reviewTimeReceipt(tx, allocationId),
          };
        },
      );
    },
    cancel(token: string, allocationId: string): Promise<ReviewTimeResult> {
      if (!sampleUuid(allocationId)) return Promise.resolve({ kind: "denied" });
      return owner<ReviewTimeResult>(
        token,
        true,
        async (tx, memberId, workspaceId, deadlines) => {
          const allocation = await ownedAllocation(
            tx,
            memberId,
            workspaceId,
            allocationId,
            true,
          );
          return cancelReviewTime(
            tx,
            allocation.sourceKey,
            allocationId,
            memberId,
            deadlines,
          );
        },
      );
    },
  };
}
