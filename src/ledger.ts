import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

// Internal synthetic accounting only. No route grants these units or accepts a
// payment; approved offers and retention rules need separate owner decisions.
export type LedgerCategory =
  | "coach_minutes"
  | "review_minutes"
  | "support_minutes"
  | "mock_sessions"
  | "study_requests";
export type LedgerFailureCode =
  | "invalid_request"
  | "unavailable"
  | "insufficient"
  | "already_settled"
  | "idempotency_conflict";

export class LedgerFailure extends Error {
  constructor(readonly code: LedgerFailureCode) {
    super(`Synthetic entitlement ledger: ${code}.`);
  }
}

const categories: readonly LedgerCategory[] = [
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
  "study_requests",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export interface ValidityWindow {
  startsAt: string;
  expiresAt: string;
}
function requireWindow(window: ValidityWindow) {
  if (
    !window ||
    typeof window.startsAt !== "string" ||
    typeof window.expiresAt !== "string"
  )
    throw new LedgerFailure("invalid_request");
  const start = new Date(window.startsAt);
  const end = new Date(window.expiresAt);
  if (
    !instant.test(window.startsAt) ||
    !instant.test(window.expiresAt) ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.toISOString() !== window.startsAt ||
    end.toISOString() !== window.expiresAt ||
    start >= end
  )
    throw new LedgerFailure("invalid_request");
}

function requireId(value: string) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new LedgerFailure("invalid_request");
}
function requireKey(value: string) {
  if (typeof value !== "string" || !value || value.length > 120)
    throw new LedgerFailure("invalid_request");
}
function requireQuantity(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw new LedgerFailure("invalid_request");
}

interface EventInput {
  operation: "grant" | "reserve" | "consume" | "release" | "expire" | "adjust";
  memberId: string;
  grantId?: string;
  reservationId?: string;
  category?: LedgerCategory;
  quantity?: number;
  window?: ValidityWindow;
}
interface EventResult {
  resultId: string;
  grantId: string;
  reservationId: string | null;
  quantity: number;
}
interface ExistingEvent {
  request_fingerprint: string;
  result_id: string;
}

export interface SyntheticLedger {
  grant(
    memberId: string,
    category: LedgerCategory,
    quantity: number,
    key: string,
    window: ValidityWindow,
  ): Promise<string>;
  reserve(
    memberId: string,
    grantId: string,
    quantity: number,
    key: string,
  ): Promise<string>;
  consume(
    memberId: string,
    reservationId: string,
    key: string,
  ): Promise<string>;
  release(
    memberId: string,
    reservationId: string,
    key: string,
  ): Promise<string>;
  expire(memberId: string, grantId: string, key: string): Promise<string>;
  // Synthetic writeoff only: quantity is removed from available, never added.
  adjust(
    memberId: string,
    grantId: string,
    quantity: number,
    key: string,
  ): Promise<string>;
}

export function syntheticLedger(
  pool: Pool,
  now: () => Date = () => new Date(),
): SyntheticLedger {
  async function apply(
    key: string,
    input: EventInput,
    change: (client: PoolClient) => Promise<EventResult>,
  ) {
    requireKey(key);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const client = await pool.connect().catch(() => {
      throw new LedgerFailure("unavailable");
    });
    try {
      await client.query("BEGIN");
      // Serialize same-key retries before reading the event. Grant row locks
      // below serialize different-key reservations against the same balance.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [key],
      );
      const previous = (
        await client.query<ExistingEvent>(
          "SELECT request_fingerprint,result_id FROM synthetic_entitlement_events WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_fingerprint !== fingerprint)
          throw new LedgerFailure("idempotency_conflict");
        await client.query("COMMIT");
        return previous.result_id;
      }
      const result = await change(client);
      await client.query(
        `INSERT INTO synthetic_entitlement_events
         (id,member_id,grant_id,reservation_id,operation,quantity,
          idempotency_key,request_fingerprint,result_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          input.memberId,
          result.grantId,
          result.reservationId,
          input.operation,
          result.quantity,
          key,
          fingerprint,
          result.resultId,
        ],
      );
      await client.query("COMMIT");
      return result.resultId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error instanceof LedgerFailure
        ? error
        : new LedgerFailure("unavailable");
    } finally {
      client.release();
    }
  }

  async function settle(
    operation: "consume" | "release",
    memberId: string,
    reservationId: string,
    key: string,
  ) {
    requireId(memberId);
    requireId(reservationId);
    return apply(
      key,
      { operation, memberId, reservationId },
      async (client) => {
        const row = (
          await client.query<{
            grant_id: string;
            quantity: number;
            state: string;
            expires_at: Date;
            expired_at: Date | null;
          }>(
            `SELECT r.grant_id,r.quantity,r.state,g.expires_at,g.expired_at
           FROM synthetic_entitlement_reservations r
           JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
           WHERE r.id=$1 AND g.member_id=$2 FOR UPDATE OF r,g`,
            [reservationId, memberId],
          )
        ).rows[0];
        if (!row) throw new LedgerFailure("unavailable");
        if (row.state !== "reserved")
          throw new LedgerFailure("already_settled");
        const expired = row.expired_at !== null || now() >= row.expires_at;
        await client.query(
          operation === "consume"
            ? `UPDATE synthetic_entitlement_grants SET reserved=reserved-$2,
             consumed=consumed+$2 WHERE id=$1`
            : expired
              ? `UPDATE synthetic_entitlement_grants SET reserved=reserved-$2,
                 expired=expired+$2 WHERE id=$1`
              : `UPDATE synthetic_entitlement_grants SET reserved=reserved-$2,
                 available=available+$2 WHERE id=$1`,
          [row.grant_id, row.quantity],
        );
        await client.query(
          "UPDATE synthetic_entitlement_reservations SET state=$2 WHERE id=$1",
          [reservationId, operation === "consume" ? "consumed" : "released"],
        );
        return {
          resultId: reservationId,
          grantId: row.grant_id,
          reservationId,
          quantity: row.quantity,
        };
      },
    );
  }

  return {
    async grant(memberId, category, quantity, key, window) {
      requireId(memberId);
      if (!categories.includes(category))
        throw new LedgerFailure("invalid_request");
      requireQuantity(quantity);
      requireWindow(window);
      return apply(
        key,
        { operation: "grant", memberId, category, quantity, window },
        async (client) => {
          const member = (
            await client.query(
              `SELECT 1 FROM learners l JOIN principals p ON p.id=l.id
             WHERE l.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND p.expires_at>CURRENT_TIMESTAMP`,
              [memberId],
            )
          ).rows[0];
          if (!member) throw new LedgerFailure("unavailable");
          const grantId = randomUUID();
          await client.query(
            `INSERT INTO synthetic_entitlement_grants
           (id,member_id,category,quantity,available,starts_at,expires_at)
           VALUES($1,$2,$3,$4,$4,$5,$6)`,
            [
              grantId,
              memberId,
              category,
              quantity,
              window.startsAt,
              window.expiresAt,
            ],
          );
          return { resultId: grantId, grantId, reservationId: null, quantity };
        },
      );
    },
    async reserve(memberId, grantId, quantity, key) {
      requireId(memberId);
      requireId(grantId);
      requireQuantity(quantity);
      return apply(
        key,
        { operation: "reserve", memberId, grantId, quantity },
        async (client) => {
          const grant = (
            await client.query<{
              available: number;
              starts_at: Date;
              expires_at: Date;
              expired_at: Date | null;
            }>(
              `SELECT g.available,g.starts_at,g.expires_at,g.expired_at FROM synthetic_entitlement_grants g
             JOIN principals p ON p.id=g.member_id
             WHERE g.id=$1 AND g.member_id=$2 AND p.kind='member'
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
             FOR UPDATE OF g`,
              [grantId, memberId],
            )
          ).rows[0];
          if (!grant) throw new LedgerFailure("unavailable");
          const current = now();
          if (
            grant.expired_at !== null ||
            current < grant.starts_at ||
            current >= grant.expires_at
          )
            throw new LedgerFailure("unavailable");
          if (grant.available < quantity)
            throw new LedgerFailure("insufficient");
          const reservationId = randomUUID();
          await client.query(
            `UPDATE synthetic_entitlement_grants SET available=available-$2,
           reserved=reserved+$2 WHERE id=$1`,
            [grantId, quantity],
          );
          await client.query(
            `INSERT INTO synthetic_entitlement_reservations
           (id,grant_id,quantity,state) VALUES($1,$2,$3,'reserved')`,
            [reservationId, grantId, quantity],
          );
          return { resultId: reservationId, grantId, reservationId, quantity };
        },
      );
    },
    consume(memberId, reservationId, key) {
      return settle("consume", memberId, reservationId, key);
    },
    release(memberId, reservationId, key) {
      return settle("release", memberId, reservationId, key);
    },
    async adjust(memberId, grantId, quantity, key) {
      requireId(memberId);
      requireId(grantId);
      requireQuantity(quantity);
      return apply(
        key,
        { operation: "adjust", memberId, grantId, quantity },
        async (client) => {
          const grant = (
            await client.query<{
              available: number;
              expires_at: Date;
              expired_at: Date | null;
            }>(
              `SELECT available,expires_at,expired_at FROM synthetic_entitlement_grants
           WHERE id=$1 AND member_id=$2 FOR UPDATE`,
              [grantId, memberId],
            )
          ).rows[0];
          if (!grant || grant.expired_at !== null || now() >= grant.expires_at)
            throw new LedgerFailure("unavailable");
          if (grant.available < quantity)
            throw new LedgerFailure("insufficient");
          await client.query(
            `UPDATE synthetic_entitlement_grants SET available=available-$2,
           adjusted=adjusted+$2 WHERE id=$1`,
            [grantId, quantity],
          );
          return {
            resultId: grantId,
            grantId,
            reservationId: null,
            quantity,
          };
        },
      );
    },
    async expire(memberId, grantId, key) {
      requireId(memberId);
      requireId(grantId);
      return apply(
        key,
        { operation: "expire", memberId, grantId },
        async (client) => {
          const grant = (
            await client.query<{
              available: number;
              expires_at: Date;
              expired_at: Date | null;
            }>(
              `SELECT available,expires_at,expired_at FROM synthetic_entitlement_grants
           WHERE id=$1 AND member_id=$2 FOR UPDATE`,
              [grantId, memberId],
            )
          ).rows[0];
          if (!grant) throw new LedgerFailure("unavailable");
          const current = now();
          if (current < grant.expires_at)
            throw new LedgerFailure("unavailable");
          if (grant.expired_at !== null)
            throw new LedgerFailure("already_settled");
          await client.query(
            `UPDATE synthetic_entitlement_grants SET expired=expired+available,
           available=0,expired_at=$2 WHERE id=$1`,
            [grantId, current],
          );
          return {
            resultId: grantId,
            grantId,
            reservationId: null,
            quantity: grant.available,
          };
        },
      );
    },
  };
}
