import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import type { WorkflowReviewResult } from "./workflow-review.ts";

export interface WorkflowReviewContext {
  tx: SampleTransaction;
  actorId: string;
  credentialHash: string;
  expires: Date[];
}
export const reviewDeny = (): never => {
  throw new SampleFeedbackFailure("denied");
};
export async function reviewExecute<T extends object>(
  pool: Pool,
  token: string,
  writing: boolean,
  use: (context: WorkflowReviewContext) => Promise<T>,
): Promise<WorkflowReviewResult<T>> {
  if (!sampleToken(token)) return { kind: "denied" };
  const entered = performance.now();
  const credentialHash = hash(token);
  try {
    return await sampleFeedbackTransaction(pool, writing, async (tx) => {
      // Identity discovery is not authorization. Callers lock/re-read the full
      // ordered actor set before acquiring workspace/source/request/grant rows.
      const identity = (
        await tx.query<{ id: string; expires: Date }>(
          `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
          [credentialHash],
        )
      ).rows[0];
      if (!identity) return reviewDeny();
      const context = {
        tx,
        actorId: identity.id,
        credentialHash,
        expires: [identity.expires],
      };
      await tx.observe(context.expires);
      const result = await use(context);
      await tx.observe(context.expires);
      const observed = performance.now();
      const row = (
        await tx.query<{ remaining: string }>(
          "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS remaining",
          [new Date(Math.min(...context.expires.map(Number)))],
        )
      ).rows[0];
      if (
        !row ||
        typeof row.remaining !== "string" ||
        !row.remaining.trim() ||
        !Number.isFinite(Number(row.remaining))
      )
        throw new SampleFeedbackFailure("unavailable");
      const deadline = Math.min(
        entered + 10000,
        tx.deadline(),
        observed + Number(row.remaining),
      );
      if (performance.now() >= deadline) return reviewDeny();
      return { ...result, deadline };
    });
  } catch (error) {
    return {
      kind: error instanceof SampleFeedbackFailure ? error.kind : "unavailable",
    };
  }
}
export interface ReviewPrincipal {
  id: string;
  kind: string;
  expires: Date;
  revoked: Date | null;
}
export async function reviewActors(
  context: WorkflowReviewContext,
  ids: string[],
  role: "member" | "platform_admin" | "moderator",
) {
  const ordered = [...new Set([context.actorId, ...ids])].sort();
  const principals = new Map<string, ReviewPrincipal>();
  for (const id of ordered) {
    const value = (
      await context.tx.query<ReviewPrincipal>(
        `SELECT id,kind,expires_at AS expires,revoked_at AS revoked FROM principals
       WHERE id=$1 AND ($2::text IS NULL OR token_hash=$2) FOR SHARE`,
        [id, id === context.actorId ? context.credentialHash : null],
      )
    ).rows[0];
    if (value) principals.set(id, value);
  }
  const actor = principals.get(context.actorId);
  if (
    !actor ||
    actor.revoked !== null ||
    actor.kind !== (role === "member" ? "member" : "staff")
  )
    return reviewDeny();
  const profiles = new Map(
    (
      await context.tx.query<{ id: string; role: string }>(
        "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [ordered],
      )
    ).rows.map((value) => [value.id, value.role]),
  );
  if (role !== "member" && profiles.get(actor.id) !== role) return reviewDeny();
  context.expires.push(actor.expires);
  await context.tx.observe(context.expires);
  return { principals, profiles };
}
export async function reviewWorkspace(
  context: WorkflowReviewContext,
  memberId: string,
) {
  const row = (
    await context.tx.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
      [memberId],
    )
  ).rows[0];
  if (!row) return reviewDeny();
  return row.id;
}
