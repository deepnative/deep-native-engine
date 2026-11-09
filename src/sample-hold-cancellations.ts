import type { Pool, PoolClient } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { staffCredential } from "./staff-entry-selection.ts";
import { hash } from "./store.ts";

/** #27 STAFFCANCEL (F-BUILD-03-C): an operator cancels a member's held sample
 * slot. One replacement credit with the replaced credit's own dates is added;
 * no earlier ledger event is changed. Sample holds and test minutes only. */
export const CANCEL_REASONS = [
  "coach-unavailable",
  "scheduling-error",
  "member-request",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export interface StaffHeldSample {
  holdId: string;
  slotId: string;
  domain: string;
  serviceType: "coaching" | "formal-review";
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
}
export interface StaffCancellation {
  holdId: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  reason: CancelReason;
  cancelledAt: Date;
  replacementMinutes: number;
  replacementStartsAt: Date;
  replacementExpiresAt: Date;
  /** Only whether the reader cancelled it; never another staff identity. */
  cancelledByReader: boolean;
}
export type StaffHoldList =
  | { kind: "ready"; held: StaffHeldSample[]; recent: StaffCancellation[] }
  | { kind: "denied" | "unavailable" };
export type StaffCancelResult =
  | { kind: "applied" | "replayed"; cancellation: StaffCancellation }
  | {
      kind:
        "stale" | "ended" | "conflict" | "denied" | "invalid" | "unavailable";
    };
export interface SampleHoldCancellationStore {
  list(token: string): Promise<StaffHoldList>;
  cancel(
    token: string,
    holdId: string,
    requestId: string,
    reason: string,
  ): Promise<StaffCancelResult>;
}
export function disabledSampleHoldCancellationStore(): SampleHoldCancellationStore {
  const unavailable = async () => ({ kind: "unavailable" as const });
  return { list: unavailable, cancel: unavailable };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CancelFailure = Exclude<StaffCancelResult["kind"], "applied" | "replayed">;
const failures: Record<string, CancelFailure> = {
  DN001: "invalid",
  DN002: "denied",
  DN004: "stale",
  DN005: "conflict",
  DN006: "ended",
};
// The same authority the function checks: a current operator or administrator.
const authoritySql = `SELECT p.id FROM principals p
 JOIN authorized_staff_profiles s ON s.principal_id=p.id
 WHERE p.token_hash=$1 AND p.kind='staff' AND s.role IN ('operator','platform_admin')
   AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()`;
const heldSql = `SELECT h.id AS "holdId",h.slot_id AS "slotId",e.domain,e.service_type AS "serviceType",
   s.starts_at AS "startsAt",s.ends_at AS "endsAt",h.expires_at AS "expiresAt"
 FROM synthetic_slot_holds h
 JOIN synthetic_member_hold_receipts r ON r.hold_id=h.id
 JOIN expert_availability_slots s ON s.id=h.slot_id
 JOIN expert_registry e ON e.id=s.expert_registry_id
 WHERE h.state='held' AND h.expires_at>clock_timestamp()
 ORDER BY s.starts_at,h.id LIMIT 100`;
const cancellationSql = (
  where: string,
) => `SELECT c.hold_id AS "holdId",h.slot_id AS "slotId",
   s.starts_at AS "startsAt",s.ends_at AS "endsAt",c.reason,c.cancelled_at AS "cancelledAt",
   g.quantity AS "replacementMinutes",g.starts_at AS "replacementStartsAt",
   g.expires_at AS "replacementExpiresAt",c.staff_id IS NOT DISTINCT FROM $1 AS "cancelledByReader"
 FROM sample_hold_staff_cancellations c
 JOIN synthetic_slot_holds h ON h.id=c.hold_id
 JOIN expert_availability_slots s ON s.id=h.slot_id
 JOIN synthetic_entitlement_grants g ON g.id=c.replacement_grant_id
 ${where}`;

async function readOnly<T>(
  pool: Pool,
  token: string,
  read: (client: PoolClient, staffId: string) => Promise<T>,
): Promise<T | { kind: "denied" | "unavailable" }> {
  let client: PoolClient | undefined;
  let result: T | { kind: "denied" | "unavailable" };
  let broken: Error | undefined;
  try {
    client = await pool.connect();
    // Not READ ONLY: the administrator fence view takes FOR SHARE locks.
    // Nothing is written, and the transaction always rolls back.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout='5s'");
    const staff = (
      await client.query<{ id: string }>(authoritySql, [hash(token)])
    ).rows[0];
    result = staff ? await read(client, staff.id) : { kind: "denied" };
  } catch {
    result = { kind: "unavailable" };
  }
  if (client) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = new Error("Sample hold cancellation rollback failed");
      result = { kind: "unavailable" };
    }
    client.release(broken);
  }
  return result;
}

export function sampleHoldCancellationStore(
  pool: Pool,
  options: { mode: ApplicationMode },
): SampleHoldCancellationStore {
  const live = options.mode === "live";
  return {
    async list(token) {
      if (live) return { kind: "unavailable" };
      if (!staffCredential(token)) return { kind: "denied" };
      return readOnly(pool, token, async (client, staffId) => ({
        kind: "ready" as const,
        held: (await client.query<StaffHeldSample>(heldSql)).rows,
        recent: (
          await client.query<StaffCancellation>(
            cancellationSql("ORDER BY c.cancelled_at DESC,c.id LIMIT 20"),
            [staffId],
          )
        ).rows,
      }));
    },
    async cancel(token, holdId, requestId, reason) {
      if (live) return { kind: "unavailable" };
      if (!staffCredential(token)) return { kind: "denied" };
      if (
        !uuid.test(holdId) ||
        !uuid.test(requestId) ||
        !CANCEL_REASONS.includes(reason as CancelReason)
      )
        return { kind: "invalid" };
      let outcome: { cancellation_id: string; replayed: boolean } | undefined;
      try {
        outcome = (
          await pool.query<{ cancellation_id: string; replayed: boolean }>(
            "SELECT * FROM staff_cancel_sample_hold($1,$2,$3,$4)",
            [hash(token), holdId, requestId, reason],
          )
        ).rows[0];
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        return { kind: failures[code] ?? "unavailable" };
      }
      if (!outcome) return { kind: "unavailable" };
      const read = await readOnly(pool, token, async (client, staffId) => {
        const row = (
          await client.query<StaffCancellation>(
            cancellationSql("WHERE c.id=$2"),
            [staffId, outcome.cancellation_id],
          )
        ).rows[0];
        return row
          ? { kind: "found" as const, row }
          : { kind: "unavailable" as const };
      });
      // The write committed; if it cannot be read back, say so, never "denied".
      if (read.kind !== "found") return { kind: "unavailable" };
      return {
        kind: outcome.replayed ? "replayed" : "applied",
        cancellation: read.row,
      };
    },
  };
}
