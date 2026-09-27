import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type SlotHoldFailureCode =
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
