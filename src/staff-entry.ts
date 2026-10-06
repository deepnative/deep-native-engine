import type { Pool } from "pg";
import { STAFF_ROLES, type StaffRole } from "./authorization.ts";
import { hash } from "./store.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import {
  sampleFeedbackTransaction,
  SampleFeedbackFailure,
} from "./sample-feedback-lifetime.ts";
export type StaffEntryResult =
  | { kind: "ready"; role: StaffRole; deadline: number }
  | { kind: "denied" | "unavailable" };
export interface StaffEntryStore {
  admit(credential: string): Promise<StaffEntryResult>;
}
export function staffEntryStore(pool: Pool): StaffEntryStore {
  return {
    async admit(credential) {
      if (!staffCredential(credential)) return { kind: "denied" };
      const requestDeadline = performance.now() + 10000;
      try {
        return await sampleFeedbackTransaction(pool, false, async (tx) => {
          const principal = (
            await tx.query<{ id: string; expires: Date }>(
              `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
              [hash(credential)],
            )
          ).rows[0];
          if (!principal) throw new SampleFeedbackFailure("denied");
          await tx.observe([principal.expires]);
          const profile = (
            await tx.query<{ role: StaffRole }>(
              "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
              [principal.id],
            )
          ).rows[0];
          if (!profile || !STAFF_ROLES.includes(profile.role))
            throw new SampleFeedbackFailure("denied");
          await tx.observe([principal.expires]);
          // Carry the conservative database lifetime through synchronous HTTP handoff.
          // Start the monotonic allowance BEFORE the observation crosses the wire.
          const entered = performance.now();
          const row = (
            await tx.query<{ remaining: string }>(
              "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS remaining",
              [principal.expires],
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
            requestDeadline,
            entered + Number(row.remaining),
          );
          if (performance.now() >= deadline)
            throw new SampleFeedbackFailure("denied");
          return { kind: "ready" as const, role: profile.role, deadline };
        });
      } catch (error) {
        return {
          kind:
            error instanceof SampleFeedbackFailure && error.kind === "denied"
              ? "denied"
              : "unavailable",
        };
      }
    },
  };
}
