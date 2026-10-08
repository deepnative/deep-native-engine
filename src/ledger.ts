import { createHash, randomUUID } from "node:crypto";
import type { Pool, QueryResult, QueryResultRow } from "pg";
export interface LedgerConnection {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

// Internal synthetic accounting. Only the explicit fixed local study fixture
// can be issued by browser; live offers/payments remain separately gated.
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
  readonly code: LedgerFailureCode;

  constructor(code: LedgerFailureCode) {
    super(`Synthetic entitlement ledger: ${code}.`);
    this.code = code;
  }
}

// Only eligibility failures observed under the expiry row lock are benign.
// An unavailable database must never be mistaken for a deleted grant.
class ExpirySkipped extends LedgerFailure {}

export interface ExpirySweepResult {
  processed: number;
  skipped: number;
  moreDue: boolean;
}
export class ExpirySweepFailure extends Error {
  readonly processed: number;
  readonly skipped: number;
  constructor(processed: number, skipped: number) {
    super("Synthetic expiry sweep failed; committed work is safe to retry.");
    this.processed = processed;
    this.skipped = skipped;
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

export type SyntheticCompletion =
  | {
      reference: string;
      category: "review_minutes" | "support_minutes";
      deliveredMinutes: number;
      preparationMinutes: number;
    }
  | {
      reference: string;
      category: "study_requests";
      quantity: 1;
    };

function completionSnapshot(value: SyntheticCompletion): SyntheticCompletion {
  if (
    !value ||
    typeof value.reference !== "string" ||
    !/^synthetic:[A-Za-z0-9][A-Za-z0-9._-]{0,109}$/.test(value.reference)
  )
    throw new LedgerFailure("invalid_request");
  const { reference, category } = value;
  if (category === "study_requests") {
    if (value.quantity !== 1) throw new LedgerFailure("invalid_request");
    return { reference, category, quantity: 1 };
  }
  if (category !== "review_minutes" && category !== "support_minutes")
    throw new LedgerFailure("invalid_request");
  requireQuantity(value.deliveredMinutes);
  if (
    !Number.isSafeInteger(value.preparationMinutes) ||
    value.preparationMinutes < 0
  )
    throw new LedgerFailure("invalid_request");
  requireQuantity(value.deliveredMinutes + value.preparationMinutes);
  return {
    reference,
    category,
    deliveredMinutes: value.deliveredMinutes,
    preparationMinutes: value.preparationMinutes,
  };
}

interface EventInput {
  operation: "grant" | "reserve" | "consume" | "release" | "expire" | "adjust";
  memberId: string;
  grantId?: string;
  reservationId?: string;
  category?: LedgerCategory;
  quantity?: number;
  window?: ValidityWindow;
  completion?: SyntheticCompletion;
  fixtureRequestId?: string;
  expiryReason?: "owner_fixture_withdrawal";
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
  settleCompletion(
    memberId: string,
    reservationId: string,
    key: string,
    completion: SyntheticCompletion,
  ): Promise<string>;
  release(
    memberId: string,
    reservationId: string,
    key: string,
  ): Promise<string>;
  expire(memberId: string, grantId: string, key: string): Promise<string>;
  sweepExpired(limit: number): Promise<ExpirySweepResult>;
  // Synthetic writeoff only: quantity is removed from available, never added.
  adjust(
    memberId: string,
    grantId: string,
    quantity: number,
    key: string,
  ): Promise<string>;
}

type EventChange = (
  client: LedgerConnection,
  eventId: string,
) => Promise<EventResult>;
type ApplyEvent = (
  key: string,
  input: EventInput,
  change: EventChange,
) => Promise<string>;

// Caller owns the connection transaction. No connection acquisition or nested
// BEGIN/COMMIT occurs here; pool and atomic member-job paths share event rules.
async function applyEvent(
  client: LedgerConnection,
  key: string,
  input: EventInput,
  change: EventChange,
  supportAllocationId?: string,
  reviewAllocationId?: string,
) {
  requireKey(key);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    key,
  ]);
  // Replay also observes the protected domain; a known event is not authority
  // for a generic ledger caller to operate on another domain's reservation.
  if (input.operation === "consume" || input.operation === "release") {
    const supportLink = (
      await client.query<{ allocation_id: string }>(
        "SELECT allocation_id FROM support_time_units WHERE reservation_id=$1",
        [input.reservationId],
      )
    ).rows[0];
    if (
      supportLink
        ? supportLink.allocation_id !== supportAllocationId
        : supportAllocationId !== undefined
    )
      throw new LedgerFailure("unavailable");
  }
  if (input.operation === "reserve" && supportAllocationId !== undefined) {
    const allocation = (
      await client.query(
        "SELECT 1 FROM support_time_allocations WHERE id=$1 AND member_id=$2 AND grant_id=$3 AND state='allocated' AND policy='support-time-test-v1'",
        [supportAllocationId, input.memberId, input.grantId],
      )
    ).rows[0];
    if (!allocation || input.quantity !== 1)
      throw new LedgerFailure("unavailable");
  }
  if (input.operation === "consume" || input.operation === "release") {
    const reviewLink = (
      await client.query<{ allocation_id: string }>(
        "SELECT allocation_id FROM review_time_units WHERE reservation_id=$1",
        [input.reservationId],
      )
    ).rows[0];
    if (
      reviewLink
        ? reviewLink.allocation_id !== reviewAllocationId
        : reviewAllocationId !== undefined
    )
      throw new LedgerFailure("unavailable");
  }
  if (input.operation === "reserve" && reviewAllocationId !== undefined) {
    if (
      input.quantity !== 1 ||
      !(
        await client.query(
          "SELECT 1 FROM review_time_allocations WHERE id=$1 AND member_id=$2 AND grant_id=$3 AND state='allocated' AND policy='review-time-test-v1'",
          [reviewAllocationId, input.memberId, input.grantId],
        )
      ).rows[0]
    )
      throw new LedgerFailure("unavailable");
  }
  const previous = (
    await client.query<ExistingEvent>(
      "SELECT request_fingerprint,result_id FROM synthetic_entitlement_events WHERE idempotency_key=$1",
      [key],
    )
  ).rows[0];
  if (previous) {
    if (previous.request_fingerprint !== fingerprint)
      throw new LedgerFailure("idempotency_conflict");
    if (
      input.operation === "reserve" &&
      supportAllocationId !== undefined &&
      !(
        await client.query(
          "SELECT 1 FROM support_time_units WHERE reservation_id=$1 AND allocation_id=$2",
          [previous.result_id, supportAllocationId],
        )
      ).rows[0]
    )
      throw new LedgerFailure("unavailable");
    if (
      input.operation === "reserve" &&
      reviewAllocationId !== undefined &&
      !(
        await client.query(
          "SELECT 1 FROM review_time_units WHERE reservation_id=$1 AND allocation_id=$2",
          [previous.result_id, reviewAllocationId],
        )
      ).rows[0]
    )
      throw new LedgerFailure("unavailable");
    return previous.result_id;
  }
  const eventId = randomUUID();
  const result = await change(client, eventId);
  await client.query(
    `INSERT INTO synthetic_entitlement_events
    (id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      eventId,
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
  return result.resultId;
}

// Shared native clock keeps internal bridges on the same existing time source.
const systemLedgerClock = () => new Date();

export function syntheticLedger(
  pool: Pool,
  now: () => Date = systemLedgerClock,
): SyntheticLedger {
  const apply: ApplyEvent = async (key, input, change) => {
    requireKey(key);
    const client = await pool.connect().catch(() => {
      throw new LedgerFailure("unavailable");
    });
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await applyEvent(client, key, input, change);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      if (broken && error instanceof ExpirySkipped)
        throw new LedgerFailure("unavailable");
      throw error instanceof LedgerFailure
        ? error
        : new LedgerFailure("unavailable");
    } finally {
      client.release(broken);
    }
  };
  return ledgerOperations(pool, apply, now);
}

// Internal atomic job boundary; not a route or an independently committed ledger.
export function syntheticLedgerOnConnection(
  client: LedgerConnection,
  jobId: string,
) {
  requireId(jobId);
  const ledger = ledgerOperations(
    client,
    (key, input, change) => applyEvent(client, key, input, change),
    systemLedgerClock,
    jobId,
  );
  return { reserve: ledger.reserve, consume: ledger.consume };
}

// Internal fixed-fixture boundary. The issuance store owns current authority,
// the policy slot/provenance and the sole transaction. No arbitrary grant or
// generic early expiry is exposed by this bridge.
export function studyFixtureLedgerOnConnection(
  client: LedgerConnection,
  requestId: string,
) {
  requireId(requestId);
  const ledger = ledgerOperations(
    client,
    (key, input, change) =>
      applyEvent(
        client,
        key,
        { ...input, fixtureRequestId: requestId },
        change,
      ),
    systemLedgerClock,
  );
  return {
    async grant(memberId: string, window: ValidityWindow) {
      requireId(memberId);
      requireWindow(window);
      const exact = (
        await client.query(
          `SELECT r.id FROM browser_study_fixture_requests r
           JOIN principals m ON m.id=r.member_id
           JOIN principals a ON a.id=r.administrator_id
           JOIN staff_profiles s ON s.principal_id=a.id
           JOIN workspaces w ON w.id=r.workspace_id
           WHERE r.id=$1 AND r.member_id=$2 AND r.policy='browser-study-fixture-v1'
             AND r.grant_id IS NULL AND r.withdrawn_at IS NULL
             AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()
             AND a.kind='staff' AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
             AND s.role='platform_admin' AND w.owner_principal_id=m.id AND w.deleting_at IS NULL
             AND $3::timestamptz<=clock_timestamp() AND $4::timestamptz>clock_timestamp()
             AND $4::timestamptz<=$3::timestamptz+interval '15 minutes'
             AND $4::timestamptz<=r.expires_at AND $4::timestamptz<=m.expires_at
             AND $4::timestamptz<=a.expires_at
           FOR UPDATE OF r`,
          [requestId, memberId, window.startsAt, window.expiresAt],
        )
      ).rows[0];
      if (!exact) throw new LedgerFailure("unavailable");
      return ledger.grant(
        memberId,
        "study_requests",
        3,
        `browser-study-fixture-grant:${requestId}`,
        window,
      );
    },
    async withdraw(memberId: string, grantId: string) {
      requireId(memberId);
      requireId(grantId);
      const source = (
        await client.query<{ withdrawn_at: Date }>(
          `SELECT withdrawn_at FROM browser_study_fixture_requests
           WHERE id=$1 AND member_id=$2 AND grant_id=$3
             AND policy='browser-study-fixture-v1' AND withdrawn_at IS NOT NULL FOR UPDATE`,
          [requestId, memberId, grantId],
        )
      ).rows[0];
      if (!source) throw new LedgerFailure("unavailable");
      const grant = (
        await client.query<{ expired_at: Date | null; available: number }>(
          `SELECT expired_at,available FROM synthetic_entitlement_grants
           WHERE id=$1 AND member_id=$2 AND category='study_requests' AND quantity=3 FOR UPDATE`,
          [grantId, memberId],
        )
      ).rows[0];
      if (!grant) throw new LedgerFailure("unavailable");
      // A previously settled natural expiry is not another balance mutation.
      if (grant.expired_at !== null) return grantId;
      return applyEvent(
        client,
        `browser-study-fixture-withdraw:${requestId}`,
        {
          operation: "expire",
          memberId,
          grantId,
          fixtureRequestId: requestId,
          expiryReason: "owner_fixture_withdrawal",
        },
        async (connection) => {
          const row = (
            await connection.query<{ id: string }>(
              `UPDATE synthetic_entitlement_grants SET expired=expired+available,
               available=0,expired_at=(SELECT withdrawn_at FROM browser_study_fixture_requests WHERE id=$3)
               WHERE id=$1 AND member_id=$2
               AND expired_at IS NULL RETURNING id`,
              [grantId, memberId, requestId],
            )
          ).rows[0];
          if (!row) throw new LedgerFailure("unavailable");
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

// Internal checked support boundary. The support store owns authorization,
// allocation/entry/link writes and the sole transaction; this grants no units.
export function supportLedgerOnConnection(
  client: LedgerConnection,
  allocationId: string,
) {
  requireId(allocationId);
  const ledger = ledgerOperations(
    client,
    (key, input, change) =>
      applyEvent(client, key, input, change, allocationId),
    systemLedgerClock,
    undefined,
    allocationId,
  );
  return {
    reserve: ledger.reserve,
    consume: ledger.consume,
    release: ledger.release,
  };
}

// The review store owns the sole transaction, exact publication and authority.
export function reviewLedgerOnConnection(
  client: LedgerConnection,
  allocationId: string,
) {
  requireId(allocationId);
  const ledger = ledgerOperations(
    client,
    (key, input, change) =>
      applyEvent(client, key, input, change, undefined, allocationId),
    systemLedgerClock,
    undefined,
    undefined,
    allocationId,
  );
  return {
    reserve: ledger.reserve,
    consume: ledger.consume,
    release: ledger.release,
  };
}

function ledgerOperations(
  pool: LedgerConnection,
  apply: ApplyEvent,
  now: () => Date,
  jobId?: string,
  supportAllocationId?: string,
  reviewAllocationId?: string,
): SyntheticLedger {
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
           WHERE r.id=$1 AND g.member_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM synthetic_slot_holds h WHERE h.reservation_id=r.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM local_ai_test_unit_jobs b
               WHERE b.reservation_id=r.id AND b.job_id IS DISTINCT FROM $3::uuid
             )
             AND NOT EXISTS (
               SELECT 1 FROM support_time_units u WHERE u.reservation_id=r.id
                AND u.allocation_id IS DISTINCT FROM $4::uuid
             )
           FOR UPDATE OF r,g`,
            [
              reservationId,
              memberId,
              jobId ?? null,
              supportAllocationId ?? null,
            ],
          )
        ).rows[0];
        if (!row) throw new LedgerFailure("unavailable");
        if (row.state !== "reserved")
          throw new LedgerFailure("already_settled");
        const linked = (
          await client.query<{ job_id: string }>(
            "SELECT job_id FROM local_ai_test_unit_jobs WHERE reservation_id=$1",
            [reservationId],
          )
        ).rows[0];
        if (linked ? linked.job_id !== jobId : jobId !== undefined)
          throw new LedgerFailure("unavailable");
        const supportLink = (
          await client.query<{ allocation_id: string }>(
            "SELECT allocation_id FROM support_time_units WHERE reservation_id=$1",
            [reservationId],
          )
        ).rows[0];
        if (
          supportLink
            ? supportLink.allocation_id !== supportAllocationId
            : supportAllocationId !== undefined
        )
          throw new LedgerFailure("unavailable");
        if (
          supportAllocationId !== undefined &&
          operation === "consume" &&
          !(
            await client.query(
              `SELECT 1 FROM support_time_allocations a JOIN support_time_units u ON u.allocation_id=a.id
           JOIN support_time_entries e ON e.allocation_id=a.id
           WHERE a.id=$1 AND a.member_id=$2 AND a.state='begun' AND e.actor_id=a.begun_by
             AND u.reservation_id=$3 AND u.ordinal<=e.support_minutes+e.preparation_minutes`,
              [supportAllocationId, memberId, reservationId],
            )
          ).rows[0]
        )
          throw new LedgerFailure("unavailable");
        const reviewLink = (
          await client.query<{ allocation_id: string }>(
            "SELECT allocation_id FROM review_time_units WHERE reservation_id=$1",
            [reservationId],
          )
        ).rows[0];
        if (
          reviewLink
            ? reviewLink.allocation_id !== reviewAllocationId
            : reviewAllocationId !== undefined
        )
          throw new LedgerFailure("unavailable");
        if (
          reviewAllocationId !== undefined &&
          operation === "consume" &&
          !(
            await client.query(
              `SELECT 1 FROM review_time_allocations a JOIN review_time_units u ON u.allocation_id=a.id
           JOIN review_time_entries e ON e.allocation_id=a.id
           WHERE a.id=$1 AND a.member_id=$2 AND a.state='begun' AND e.actor_id=a.begun_by
            AND u.reservation_id=$3 AND u.ordinal<=e.review_minutes+e.preparation_minutes`,
              [reviewAllocationId, memberId, reservationId],
            )
          ).rows[0]
        )
          throw new LedgerFailure("unavailable");
        if (operation === "release") {
          await client.query(
            "SELECT release_synthetic_reservation_balance($1,$2,$3,NULL,$4,$5)",
            [
              reservationId,
              memberId,
              now(),
              supportAllocationId ?? null,
              reviewAllocationId ?? null,
            ],
          );
        } else {
          await client.query(
            `UPDATE synthetic_entitlement_grants SET reserved=reserved-$2,
            consumed=consumed+$2 WHERE id=$1`,
            [row.grant_id, row.quantity],
          );
          await client.query(
            "UPDATE synthetic_entitlement_reservations SET state=$2 WHERE id=$1",
            [reservationId, "consumed"],
          );
        }
        return {
          resultId: reservationId,
          grantId: row.grant_id,
          reservationId,
          quantity: row.quantity,
        };
      },
    );
  }

  const ledger: SyntheticLedger = {
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
    async settleCompletion(memberId, reservationId, key, value) {
      requireId(memberId);
      requireId(reservationId);
      // Snapshot only the defined fields before awaiting. Fingerprints and
      // evidence must describe the same value even if a caller mutates theirs.
      const completion = completionSnapshot(value);
      const human = completion.category !== "study_requests";
      const quantity = human
        ? completion.deliveredMinutes + completion.preparationMinutes
        : completion.quantity;
      return apply(
        key,
        { operation: "consume", memberId, reservationId, completion },
        async (client, eventId) => {
          const row = (
            await client.query<{
              grant_id: string;
              quantity: number;
              state: string;
              category: LedgerCategory;
            }>(
              `SELECT r.grant_id,r.quantity,r.state,g.category
               FROM synthetic_entitlement_reservations r
               JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
               WHERE r.id=$1 AND g.member_id=$2
                 AND NOT EXISTS (
                   SELECT 1 FROM synthetic_slot_holds h WHERE h.reservation_id=r.id
                 )
                 AND NOT EXISTS (SELECT 1 FROM local_ai_test_unit_jobs b WHERE b.reservation_id=r.id)
                 AND NOT EXISTS (SELECT 1 FROM support_time_units u WHERE u.reservation_id=r.id)
                 AND NOT EXISTS (SELECT 1 FROM review_time_units u WHERE u.reservation_id=r.id)
               FOR UPDATE OF r,g`,
              [reservationId, memberId],
            )
          ).rows[0];
          if (
            !row ||
            row.category !== completion.category ||
            row.quantity !== quantity
          )
            throw new LedgerFailure("unavailable");
          if (
            (
              await client.query(
                "SELECT 1 FROM local_ai_test_unit_jobs WHERE reservation_id=$1",
                [reservationId],
              )
            ).rows[0]
          )
            throw new LedgerFailure("unavailable");
          if (
            (
              await client.query(
                "SELECT 1 FROM support_time_units WHERE reservation_id=$1",
                [reservationId],
              )
            ).rows[0]
          )
            throw new LedgerFailure("unavailable");
          if (row.state !== "reserved")
            throw new LedgerFailure("already_settled");
          // The two-integer advisory space is separate from apply()'s bigint
          // idempotency lock. Check ownership first, then serialize reference
          // reuse across distinct grants without exposing the existing record.
          await client.query(
            "SELECT pg_advisory_xact_lock(27044,hashtext($1))",
            [completion.reference],
          );
          const previousCompletion = (
            await client.query(
              "SELECT 1 FROM synthetic_entitlement_settlements WHERE completion_ref=$1",
              [completion.reference],
            )
          ).rows[0];
          if (previousCompletion)
            throw new LedgerFailure("idempotency_conflict");
          // Like consume(), this is internal settlement of previously reserved
          // units, including after expiry/revocation; it grants no new access.
          await client.query(
            `UPDATE synthetic_entitlement_grants SET reserved=reserved-$2,
             consumed=consumed+$2 WHERE id=$1`,
            [row.grant_id, quantity],
          );
          await client.query(
            "UPDATE synthetic_entitlement_reservations SET state='consumed' WHERE id=$1",
            [reservationId],
          );
          await client.query(
            `INSERT INTO synthetic_entitlement_settlements
             (id,member_id,grant_id,reservation_id,completion_ref,category,
              quantity,delivered_minutes,preparation_minutes)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              eventId,
              memberId,
              row.grant_id,
              reservationId,
              completion.reference,
              completion.category,
              quantity,
              human ? completion.deliveredMinutes : null,
              human ? completion.preparationMinutes : null,
            ],
          );
          return {
            resultId: eventId,
            grantId: row.grant_id,
            reservationId,
            quantity,
          };
        },
      );
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
    async sweepExpired(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new LedgerFailure("invalid_request");
      let processed = 0;
      let skipped = 0;
      try {
        const candidates = await pool.query<{ id: string; member_id: string }>(
          `SELECT id,member_id FROM synthetic_entitlement_grants
           WHERE expired_at IS NULL AND expires_at <= $1
           ORDER BY expires_at,id LIMIT $2`,
          [now(), limit],
        );
        for (const candidate of candidates.rows) {
          try {
            // Each grant commits independently. Keep this key stable across
            // operators, batches and retries after partial completion.
            await ledger.expire(
              candidate.member_id,
              candidate.id,
              `synthetic-expiry:${candidate.id}`,
            );
            processed += 1;
          } catch (error) {
            if (!(error instanceof ExpirySkipped)) throw error;
            skipped += 1;
          }
        }
        const remaining = await pool.query(
          `SELECT 1 FROM synthetic_entitlement_grants
           WHERE expired_at IS NULL AND expires_at <= $1 LIMIT 1`,
          [now()],
        );
        return { processed, skipped, moreDue: remaining.rows.length > 0 };
      } catch {
        throw new ExpirySweepFailure(processed, skipped);
      }
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
          if (!grant) throw new ExpirySkipped("unavailable");
          const current = now();
          if (current < grant.expires_at)
            throw new ExpirySkipped("unavailable");
          if (grant.expired_at !== null)
            throw new ExpirySkipped("already_settled");
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
  return ledger;
}
