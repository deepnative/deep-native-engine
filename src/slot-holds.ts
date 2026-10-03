import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { hash } from "./store.ts";

export type SlotHoldFailureCode =
  | "uncertain"
  | "invalid_request"
  | "unavailable"
  | "insufficient"
  | "already_settled"
  | "idempotency_conflict";

export class SlotHoldFailure extends Error {
  readonly code: SlotHoldFailureCode;

  constructor(code: SlotHoldFailureCode) {
    super(`Synthetic slot hold: ${code}.`);
    this.code = code;
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
  state: "held" | "expired" | "released";
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
  withdraw(token: string, requestId: string): Promise<string>;
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
    withdraw: async () => {
      throw new SlotHoldFailure("unavailable");
    },
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
  function readReceipts(
    client: Pool | PoolClient,
    token: string,
    requestId: string | null,
  ) {
    return client.query<SampleHoldReceipt>(
      `SELECT r.request_id AS id,r.slot_id AS "slotId",r.domain,
        r.service_type AS "serviceType",r.starts_at AS "startsAt",
        r.ends_at AS "endsAt",h.expires_at AS "expiresAt",h.state,60 AS quantity
       FROM synthetic_member_hold_receipts r
       JOIN synthetic_slot_holds h ON h.id=r.hold_id
       JOIN principals p ON p.id=r.member_id
       JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
       WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
         AND p.expires_at>clock_timestamp()
         AND ($2::uuid IS NULL OR r.request_id=$2)
       ORDER BY h.created_at DESC,r.request_id`,
      [hash(token), requestId],
    );
  }
  async function privateSnapshot(
    token: string,
    requestId: string | null,
  ): Promise<MemberHoldSnapshot | null> {
    const started = performance.now();
    const operationDeadline = started + 10000;
    let authorityDeadline = Infinity;
    let client: PoolClient | undefined;
    let queryUncertain = false,
      authorityDenied = false,
      transactionOpen = false,
      commitIssued = false;
    let result: MemberHoldSnapshot | null = null;
    let outcomeError: unknown,
      failed = false;
    const unavailable = () => new SlotHoldFailure("unavailable");
    async function bounded<T>(
      operation: () => Promise<T>,
      maximum: number,
    ): Promise<T> {
      const entered = performance.now();
      const allowance = Math.min(
        maximum,
        operationDeadline - entered,
        authorityDeadline - entered,
      );
      const authorityLimited =
        Number.isFinite(authorityDeadline) &&
        authorityDeadline - entered <=
          Math.min(maximum, operationDeadline - entered);
      if (!Number.isFinite(allowance) || allowance <= 0) {
        queryUncertain = true;
        authorityDenied = authorityLimited;
        throw unavailable();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then(operation),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              queryUncertain = true;
              authorityDenied = authorityLimited;
              reject(unavailable());
            }, allowance);
          }),
        ]);
        if (performance.now() - entered >= allowance) {
          queryUncertain = true;
          authorityDenied = authorityLimited;
          throw unavailable();
        }
        return value;
      } finally {
        clearTimeout(timer);
      }
    }
    const query = <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => bounded(() => client!.query<T>(sql, values), 5000);
    async function observe() {
      const entered = performance.now();
      const current = (
        await query<{
          observedAt: Date;
          remainingMs: string;
          valid: boolean;
        }>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS observed_at)
        SELECT t.observed_at AS "observedAt",
          EXTRACT(EPOCH FROM (p.expires_at-t.observed_at))*1000 AS "remainingMs",
          p.expires_at>t.observed_at AS valid
        FROM principals p JOIN learners l ON l.id=p.id
        JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
        CROSS JOIN instant t
        WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
          AND p.expires_at>t.observed_at`,
          [hash(token)],
        )
      ).rows[0];
      if (!current) return false;
      const remaining = Number(current.remainingMs);
      if (
        current.valid !== true ||
        typeof current.remainingMs !== "string" ||
        !current.remainingMs.trim() ||
        !Number.isFinite(remaining) ||
        !(current.observedAt instanceof Date) ||
        !Number.isFinite(+current.observedAt)
      )
        throw unavailable();
      // Subtract the whole query/driver round trip conservatively. A later
      // observation can shorten, never extend, the operation's DB lifetime.
      authorityDeadline = Math.min(authorityDeadline, entered + remaining);
      return authorityDeadline > performance.now();
    }
    try {
      let acquisitionExpired = false,
        acquired: PoolClient | undefined;
      const connecting = () =>
        pool.connect().then((value) => {
          if (acquisitionExpired) {
            try {
              value.release(unavailable());
            } catch {
              /* Already unavailable. */
            }
            throw unavailable();
          }
          acquired = value;
          return value;
        });
      try {
        client = await bounded(connecting, 3000);
      } catch (error) {
        acquisitionExpired = true;
        if (acquired) {
          try {
            acquired.release(unavailable());
          } catch {
            /* Already unavailable. */
          }
        }
        throw error;
      }
      // Bound initial reads and atomic lazy settlement functions as well as
      // the final fenced transaction. This owned connection is discarded on
      // every handback, so session-level timeout settings cannot leak to reuse.
      await query("SET statement_timeout='5s'");
      await query("SET lock_timeout='5s'");
      read: {
        if (!(await observe())) break read;
        const initial = await bounded(
          () => readReceipts(client!, token, requestId),
          5000,
        );
        // Preserve settlement's slot -> member writer order. No read-transaction
        // locks are held while these independent atomic functions commit.
        for (const item of initial.rows) {
          if (item.state === "held")
            await query("SELECT settle_member_sample_holds($1,$2)", [
              hash(token),
              item.id,
            ]);
        }
        await query("BEGIN");
        transactionOpen = true;
        await query("SELECT set_config('transaction_timeout',$1,true)", [
          `${Math.max(1, Math.floor(operationDeadline - performance.now()))}ms`,
        ]);
        const member = await query<{ id: string; expiresAt: string }>(
          `SELECT p.id,p.expires_at::text AS "expiresAt"
           FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR SHARE OF p`,
          [hash(token)],
        );
        if (!member.rows[0]) break read;
        // Match deletion's principal -> owned workspace order and retain both
        // locks through the final read/check/COMMIT. Settlement happens above.
        const workspace = await query<{ id: string }>(
          `SELECT id FROM workspaces
           WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [member.rows[0].id],
        );
        if (!workspace.rows[0]) break read;
        const own = await bounded(
          () => readReceipts(client!, token, requestId),
          5000,
        );
        const grants =
          requestId === null
            ? await query<SampleHoldGrant>(
                `SELECT g.id,g.category FROM synthetic_entitlement_grants g
               JOIN principals p ON p.id=g.member_id
               WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
                 AND p.expires_at>clock_timestamp() AND g.starts_at<=clock_timestamp()
                 AND g.expires_at>clock_timestamp() AND g.expired_at IS NULL
                 AND g.available>=60 AND g.category IN ('coach_minutes','review_minutes')
               ORDER BY g.expires_at,g.id`,
                [hash(token)],
              )
            : { rows: [] };
        if (!(await observe())) break read;
        commitIssued = true;
        await query("COMMIT");
        transactionOpen = false;
        result = { grants: grants.rows, receipts: own.rows };
      }
    } catch (error) {
      if (
        (!authorityDenied && performance.now() < authorityDeadline) ||
        performance.now() >= operationDeadline
      ) {
        failed = true;
        outcomeError = error;
      }
    } finally {
      // A timeout or issued COMMIT has an uncertain outcome: never queue a
      // ROLLBACK behind its pending reply, and never replay it. Discard releases
      // server locks; already committed lazy settlement is not rolled back.
      if (client && transactionOpen && !queryUncertain && !commitIssued) {
        try {
          await query("ROLLBACK");
        } catch {
          failed = true;
          outcomeError = unavailable();
        }
      }
      try {
        client?.release(unavailable());
      } catch {
        failed = true;
        outcomeError = unavailable();
      }
    }
    if (failed) throw outcomeError;
    if (performance.now() >= operationDeadline) throw unavailable();
    if (performance.now() >= authorityDeadline) return null;
    return result;
  }
  return {
    async withdraw(token, requestId) {
      if (!validToken(token)) throw new SlotHoldFailure("invalid_request");
      requireId(requestId);
      try {
        const result = await pool.query<{ id: string }>(
          "SELECT withdraw_member_sample_hold($1,$2) AS id",
          [hash(token), requestId],
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
    async snapshot(token) {
      if (!validToken(token)) return { grants: [], receipts: [] };
      const snapshot = await privateSnapshot(token, null);
      if (!snapshot) throw new SlotHoldFailure("unavailable");
      return snapshot;
    },
    async get(token, requestId) {
      if (!validToken(token) || !uuid.test(requestId)) return null;
      return (await privateSnapshot(token, requestId))?.receipts[0] ?? null;
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
