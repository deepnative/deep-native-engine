import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export type SlotHoldFailureCode =
  | "uncertain"
  | "invalid_request"
  | "unavailable"
  | "insufficient"
  | "already_settled"
  | "idempotency_conflict";

export class SlotHoldFailure extends Error {
  constructor(readonly code: SlotHoldFailureCode) {
    super(`Synthetic slot hold: ${code}.`);
  }
}

export interface SyntheticSlotHolds {
  hold(
    memberId: string,
    slotId: string,
    grantId: string,
    key: string,
    deadline: Date,
  ): Promise<string>;
  expire(holdId: string, key: string): Promise<string>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codes: Record<string, SlotHoldFailureCode> = {
  DN001: "invalid_request",
  DN002: "unavailable",
  DN003: "insufficient",
  DN004: "already_settled",
  DN005: "idempotency_conflict",
};

function requireId(value: string) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new SlotHoldFailure("invalid_request");
}
function requireKey(value: string) {
  if (typeof value !== "string" || !value || value.length > 120)
    throw new SlotHoldFailure("invalid_request");
}
function requireInstant(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new SlotHoldFailure("invalid_request");
}
function fingerprint(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function failure(error: unknown): SlotHoldFailure {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return new SlotHoldFailure(codes[code] ?? "unavailable");
}

export function syntheticSlotHolds(
  pool: Pool,
  now: () => Date = () => new Date(),
): SyntheticSlotHolds {
  return {
    async hold(memberId, slotId, grantId, key, deadline) {
      requireId(memberId);
      requireId(slotId);
      requireId(grantId);
      requireKey(key);
      requireInstant(deadline);
      const current = now();
      requireInstant(current);
      if (deadline <= current) throw new SlotHoldFailure("invalid_request");
      const request = {
        operation: "slot_hold",
        memberId,
        slotId,
        grantId,
        quantity: 60,
        deadline: deadline.toISOString(),
      };
      try {
        const result = await pool.query<{ id: string }>(
          "SELECT synthetic_hold_slot($1,$2,$3,$4,$5,$6,$7) AS id",
          [
            memberId,
            slotId,
            grantId,
            key,
            fingerprint(request),
            deadline,
            current,
          ],
        );
        if (!result.rows[0]) throw new SlotHoldFailure("unavailable");
        return result.rows[0].id;
      } catch (error) {
        throw failure(error);
      }
    },
    async expire(holdId, key) {
      requireId(holdId);
      requireKey(key);
      const current = now();
      requireInstant(current);
      try {
        const result = await pool.query<{ id: string }>(
          "SELECT synthetic_expire_slot_hold($1,$2,$3,$4) AS id",
          [
            holdId,
            key,
            fingerprint({ operation: "slot_expire", holdId }),
            current,
          ],
        );
        if (!result.rows[0]) throw new SlotHoldFailure("unavailable");
        return result.rows[0].id;
      } catch (error) {
        throw failure(error);
      }
    },
  };
}

export interface SampleHoldReceipt {
  id: string;
  slotId: string;
  domain: string;
  serviceType: "coaching" | "formal-review";
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  state: "held" | "expired";
  quantity: number;
}
export interface SampleHoldGrant {
  id: string;
  category: "coach_minutes" | "review_minutes";
}
export interface MemberHoldSnapshot {
  grants: SampleHoldGrant[];
  receipts: SampleHoldReceipt[];
}
export interface MemberSlotHolds {
  snapshot(token: string): Promise<MemberHoldSnapshot>;
  get(token: string, requestId: string): Promise<SampleHoldReceipt | null>;
  request(
    token: string,
    slotId: string,
    grantId: string,
    requestId: string,
  ): Promise<string>;
}
export function disabledMemberSlotHolds(): MemberSlotHolds {
  return {
    snapshot: async () => ({ grants: [], receipts: [] }),
    get: async () => null,
    request: async () => {
      throw new SlotHoldFailure("unavailable");
    },
  };
}

export function memberSlotHolds(pool: Pool): MemberSlotHolds {
  const validToken = (value: string) =>
    typeof value === "string" && !!value.trim();
  async function receipts(token: string, requestId: string | null) {
    const read = () =>
      pool.query<SampleHoldReceipt>(
        `SELECT r.request_id AS id,r.slot_id AS "slotId",r.domain,
        r.service_type AS "serviceType",r.starts_at AS "startsAt",
        r.ends_at AS "endsAt",h.expires_at AS "expiresAt",h.state,60 AS quantity
       FROM synthetic_member_hold_receipts r
       JOIN synthetic_slot_holds h ON h.id=r.hold_id
       JOIN principals p ON p.id=r.member_id
       WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
         AND p.expires_at>clock_timestamp()
         AND ($2::uuid IS NULL OR r.request_id=$2)
       ORDER BY h.created_at DESC,r.request_id`,
        [hash(token), requestId],
      );
    const initial = await read();
    // One receipt per transaction: never hold several slot locks while waiting
    // for a member lock held by a competing request on another slot.
    for (const item of initial.rows) {
      if (item.state === "held")
        await pool.query("SELECT settle_member_sample_holds($1,$2)", [
          hash(token),
          item.id,
        ]);
    }
    // Recheck ownership and current session after any settlement waits.
    return (await read()).rows;
  }
  return {
    async snapshot(token) {
      if (!validToken(token)) return { grants: [], receipts: [] };
      const own = await receipts(token, null);
      const grants = await pool.query<SampleHoldGrant>(
        `SELECT g.id,g.category FROM synthetic_entitlement_grants g
         JOIN principals p ON p.id=g.member_id
         WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>clock_timestamp() AND g.starts_at<=clock_timestamp()
           AND g.expires_at>clock_timestamp() AND g.expired_at IS NULL
           AND g.available>=60 AND g.category IN ('coach_minutes','review_minutes')
         ORDER BY g.expires_at,g.id`,
        [hash(token)],
      );
      return { grants: grants.rows, receipts: own };
    },
    async get(token, requestId) {
      if (!validToken(token) || !uuid.test(requestId)) return null;
      return (await receipts(token, requestId))[0] ?? null;
    },
    async request(token, slotId, grantId, requestId) {
      if (!validToken(token)) throw new SlotHoldFailure("invalid_request");
      requireId(slotId);
      requireId(grantId);
      requireId(requestId);
      try {
        await pool.query("SELECT prepare_member_sample_slot($1,$2,$3)", [
          hash(token),
          slotId,
          requestId,
        ]);
        const result = await pool.query<{ id: string }>(
          "SELECT member_sample_hold($1,$2,$3,$4) AS id",
          [hash(token), slotId, grantId, requestId],
        );
        if (!result.rows[0]) throw new Error("Missing sample receipt result");
        return result.rows[0].id;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        throw new SlotHoldFailure(codes[code] ?? "uncertain");
      }
    },
  };
}
