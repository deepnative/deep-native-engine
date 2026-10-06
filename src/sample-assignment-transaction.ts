import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import type { SampleAssignmentFailure } from "./sample-assignment-values.ts";

export interface SampleAssignmentPrincipal {
  id: string;
  kind: string;
  expires: Date;
  revoked: Date | null;
}
export interface SampleAssignmentContext {
  tx: SampleTransaction;
  actorId: string;
  credentialHash: string;
  expires: Date[];
}
export const sampleAssignmentDeny = (): never => {
  throw new SampleFeedbackFailure("denied");
};

/** Discover identity without a row lock, then let the caller acquire its entire
 * sorted actor set. The final projection carries DB-observed authority through
 * HTTP acceptance; the existing runner still owns COMMIT/native-return bounds. */
export async function sampleAssignmentExecute<T extends object>(
  pool: Pool,
  token: string,
  writing: boolean,
  use: (context: SampleAssignmentContext) => Promise<T>,
): Promise<(T & { deadline: number }) | SampleAssignmentFailure> {
  if (!sampleToken(token)) return { kind: "denied" };
  const requestDeadline = performance.now() + 10000;
  const credentialHash = hash(token);
  try {
    return await sampleFeedbackTransaction(pool, writing, async (tx) => {
      const identity = (
        await tx.query<{ id: string; expires: Date }>(
          `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='staff'
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
          [credentialHash],
        )
      ).rows[0];
      if (!identity) return sampleAssignmentDeny();
      const context = {
        tx,
        actorId: identity.id,
        credentialHash,
        expires: [identity.expires],
      };
      await tx.observe(context.expires);
      const result = await use(context);
      await tx.observe(context.expires);
      const entered = performance.now();
      const observed = (
        await tx.query<{ remaining: string }>(
          "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS remaining",
          [new Date(Math.min(...context.expires.map(Number)))],
        )
      ).rows[0];
      if (
        !observed ||
        typeof observed.remaining !== "string" ||
        !observed.remaining.trim() ||
        !Number.isFinite(Number(observed.remaining))
      )
        throw new SampleFeedbackFailure("unavailable");
      const deadline = Math.min(
        requestDeadline,
        tx.deadline(),
        entered + Number(observed.remaining),
      );
      if (performance.now() >= deadline) return sampleAssignmentDeny();
      return { ...result, deadline };
    });
  } catch (error) {
    // The owned transaction runner normalizes callback, pool, query and cleanup
    // exceptions to SampleFeedbackFailure before returning control here.
    return { kind: (error as SampleFeedbackFailure).kind };
  }
}

export async function sampleAssignmentActors(
  context: SampleAssignmentContext,
  ids: string[],
  exclusive = false,
  role: "platform_admin" | "reviewer" = "platform_admin",
) {
  const principals = new Map<string, SampleAssignmentPrincipal>();
  const ordered = [...new Set([context.actorId, ...ids])].sort();
  for (const id of ordered) {
    const principal = (
      await context.tx.query<SampleAssignmentPrincipal>(
        `SELECT id,kind,expires_at AS expires,revoked_at AS revoked FROM principals WHERE id=$1
       AND ($2::text IS NULL OR token_hash=$2)
       FOR ${exclusive && id === context.actorId ? "UPDATE" : "SHARE"}`,
        [id, id === context.actorId ? context.credentialHash : null],
      )
    ).rows[0];
    if (principal) principals.set(id, principal);
  }
  const actor = principals.get(context.actorId);
  if (!actor || actor.kind !== "staff" || actor.revoked !== null)
    return sampleAssignmentDeny();
  context.expires.push(actor.expires);
  await context.tx.observe(context.expires);
  const profiles = new Map(
    (
      await context.tx.query<{ id: string; role: string }>(
        "SELECT principal_id AS id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [ordered],
      )
    ).rows.map((profile) => [profile.id, profile.role]),
  );
  if (profiles.get(context.actorId) !== role) return sampleAssignmentDeny();
  return { principals, profiles };
}
