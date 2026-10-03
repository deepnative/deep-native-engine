import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { supportLedgerOnConnection } from "./ledger.ts";

export interface SupportTimeReceipt {
  allocationId: string;
  ceiling: number;
  state:
    "allocated" | "begun" | "completed" | "cancelled" | "needs_reconciliation";
  held: number;
  consumed: number;
  released: number;
  supportMinutes: number;
  preparationMinutes: number;
}
export type SupportTimeResult =
  | { kind: "applied" | "replayed"; receipt: SupportTimeReceipt }
  | {
      kind:
        "denied" | "unavailable" | "withdrawn" | "conflict" | "insufficient";
    };
export interface SupportTimeScope {
  requestId: string;
  allocationId: string;
  grantId: string;
}
export interface SupportTimeGrantInput {
  requestId: string;
  allocationId: string;
  staffId: string;
  role: "operator" | "platform_admin";
  idempotencyKey: string;
  startsAt: Date;
  expiresAt: Date;
}
export interface SupportTimeIntervals {
  supportStart: Date;
  supportEnd: Date;
  preparationStart: Date | null;
  preparationEnd: Date | null;
}
export function supportIntervalMinutes(
  input: SupportTimeIntervals,
): { support: number; preparation: number } | null {
  const finite = (v: unknown): v is Date =>
    v instanceof Date && Number.isFinite(v.valueOf());
  if (!finite(input.supportStart) || !finite(input.supportEnd)) return null;
  const support =
    (input.supportEnd.valueOf() - input.supportStart.valueOf()) / 60000;
  if (!Number.isSafeInteger(support) || support < 1 || support > 120)
    return null;
  if (input.preparationStart === null && input.preparationEnd === null)
    return { support, preparation: 0 };
  if (!finite(input.preparationStart) || !finite(input.preparationEnd))
    return null;
  const preparation =
    (input.preparationEnd.valueOf() - input.preparationStart.valueOf()) / 60000;
  if (
    !Number.isSafeInteger(preparation) ||
    preparation < 1 ||
    support + preparation > 120 ||
    !(
      input.preparationEnd <= input.supportStart ||
      input.supportEnd <= input.preparationStart
    )
  )
    return null;
  return { support, preparation };
}
export interface OperatorSupportTimeReceipt extends SupportTimeReceipt {
  canBegin: boolean;
  canRecord: boolean;
  requestId: string;
  grantId: string;
}
export interface MemberSupportTimeStore {
  readonly writesEnabled: boolean;
  cancel(
    token: string,
    requestId: string,
    allocationId: string,
  ): Promise<SupportTimeResult>;
  operatorDetail(
    token: string,
    scope: SupportTimeScope,
  ): Promise<
    | { kind: "ready"; value: OperatorSupportTimeReceipt }
    | { kind: "denied" | "unavailable" }
  >;
  operatorWorklist(
    token: string,
    after?: string,
  ): Promise<
    | {
        kind: "ready";
        value: {
          items: OperatorSupportTimeReceipt[];
          nextCursor: string | null;
        };
      }
    | { kind: "denied" | "unavailable" }
  >;
  record(
    token: string,
    scope: SupportTimeScope,
    key: string,
    intervals: SupportTimeIntervals,
  ): Promise<SupportTimeResult>;
  grant(
    token: string,
    input: SupportTimeGrantInput,
  ): Promise<
    | { kind: "created" | "replayed"; grantId: string }
    | { kind: "denied" | "unavailable" | "withdrawn" | "conflict" }
  >;
  revoke(
    token: string,
    grantId: string,
  ): Promise<{
    kind: "revoked" | "already-revoked" | "denied" | "unavailable";
  }>;
  begin(
    token: string,
    scope: SupportTimeScope,
    key: string,
  ): Promise<SupportTimeResult>;
  allocate(
    token: string,
    requestId: string,
    key: string,
    ceiling: number,
  ): Promise<SupportTimeResult>;
  receipt(
    token: string,
    requestId: string,
  ): Promise<
    | { kind: "ready"; value: SupportTimeReceipt | null }
    | { kind: "denied" | "unavailable" }
  >;
}
// Internal helpers require the caller's authorized, request-locked transaction.
// They neither accept session tokens nor acquire or commit independent connections.
export async function supportTimeReceipt(
  client: PoolClient,
  allocationId: string,
): Promise<SupportTimeReceipt> {
  const row = (
    await client.query<SupportTimeReceipt>(
      `
    SELECT a.id AS "allocationId",a.ceiling,a.state,
      (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='reserved') AS held,
      (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='consumed') AS consumed,
      (SELECT count(*)::integer FROM support_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='released') AS released,
      COALESCE(e.support_minutes,0) AS "supportMinutes",COALESCE(e.preparation_minutes,0) AS "preparationMinutes"
    FROM support_time_allocations a LEFT JOIN support_time_entries e ON e.allocation_id=a.id WHERE a.id=$1`,
      [allocationId],
    )
  ).rows[0];
  if (!row) throw Error("Support allocation unavailable");
  return row;
}
export async function allocateSupportTime(
  client: PoolClient,
  request: {
    requestId: string;
    memberId: string;
    withdrawnAt: Date | null;
    resolvedAt: Date | null;
  },
  key: string,
  ceiling: number,
  deadlines: Date[],
): Promise<SupportTimeResult> {
  const prior = (
    await client.query<{ id: string; ceiling: number }>(
      "SELECT id,ceiling FROM support_time_allocations WHERE request_id=$1 AND member_id=$2 AND idempotency_key=$3 FOR UPDATE",
      [request.requestId, request.memberId, key],
    )
  ).rows[0];
  if (prior)
    return prior.ceiling === ceiling
      ? {
          kind: "replayed",
          receipt: await supportTimeReceipt(client, prior.id),
        }
      : { kind: "conflict" };
  if (request.withdrawnAt) return { kind: "withdrawn" };
  if (request.resolvedAt) return { kind: "conflict" };
  if (
    (
      await client.query(
        "SELECT id FROM support_time_allocations WHERE request_id=$1 AND state IN ('allocated','begun','needs_reconciliation')",
        [request.requestId],
      )
    ).rowCount
  )
    return { kind: "conflict" };
  const grant = (
    await client.query<{ id: string; expiresAt: Date }>(
      `
    SELECT id,expires_at AS "expiresAt" FROM synthetic_entitlement_grants
    WHERE member_id=$1 AND category='support_minutes' AND available>=$2
      AND expired_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()
    ORDER BY expires_at,id LIMIT 1 FOR UPDATE`,
      [request.memberId, ceiling],
    )
  ).rows[0];
  if (!grant) return { kind: "insufficient" };
  // Recheck after the grant lock wait; PostgreSQL statement snapshots alone
  // cannot establish eligibility at the moment the lock is acquired.
  if (
    !(
      await client.query(
        "SELECT id FROM synthetic_entitlement_grants WHERE id=$1 AND available>=$2 AND expired_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()",
        [grant.id, ceiling],
      )
    ).rowCount
  )
    return { kind: "insufficient" };
  deadlines.push(grant.expiresAt);
  const allocationId = randomUUID();
  await client.query(
    "INSERT INTO support_time_allocations(id,request_id,member_id,grant_id,ceiling,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)",
    [allocationId, request.requestId, request.memberId, grant.id, ceiling, key],
  );
  const boundary = supportLedgerOnConnection(client, allocationId);
  const budget = (
    await client.query<{ deadline: Date }>(
      "SELECT clock_timestamp()+interval '10 seconds' AS deadline",
    )
  ).rows[0]!.deadline;
  deadlines.push(budget);
  for (let ordinal = 1; ordinal <= ceiling; ordinal++) {
    const reservationId = await boundary.reserve(
      request.memberId,
      grant.id,
      1,
      `support-time:${allocationId}:unit:${ordinal}:reserve`,
    );
    await client.query(
      "INSERT INTO support_time_units(allocation_id,ordinal,reservation_id) VALUES($1,$2,$3)",
      [allocationId, ordinal, reservationId],
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Support allocation budget exceeded");
  }
  await client.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$3,'allocated')",
    [randomUUID(), allocationId, request.memberId],
  );
  return {
    kind: "applied",
    receipt: await supportTimeReceipt(client, allocationId),
  };
}

export async function beginSupportTime(
  client: PoolClient,
  actorId: string,
  scope: SupportTimeScope,
  request: { withdrawnAt: Date | null; resolvedAt: Date | null },
  key: string,
  deadlines: Date[],
): Promise<SupportTimeResult> {
  const allocation = (
    await client.query<{
      state: string;
      actorId: string | null;
      grantId: string;
      beginGrantId: string | null;
      beginKey: string | null;
    }>(
      `SELECT state,begun_by AS "actorId",grant_id AS "grantId",begun_grant_id AS "beginGrantId",begin_key AS "beginKey"
    FROM support_time_allocations WHERE id=$1 AND request_id=$2 FOR UPDATE`,
      [scope.allocationId, scope.requestId],
    )
  ).rows[0];
  if (!allocation) return { kind: "denied" };
  if (allocation.beginKey === key)
    return allocation.actorId === actorId &&
      allocation.beginGrantId === scope.grantId
      ? {
          kind: "replayed",
          receipt: await supportTimeReceipt(client, scope.allocationId),
        }
      : { kind: "conflict" };
  if (request.withdrawnAt) return { kind: "withdrawn" };
  if (request.resolvedAt || allocation.state !== "allocated")
    return { kind: "conflict" };
  const budget = (
    await client.query<{ expiresAt: Date }>(
      `SELECT expires_at AS "expiresAt" FROM synthetic_entitlement_grants WHERE id=$1
    AND expired_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,
      [allocation.grantId],
    )
  ).rows[0];
  if (
    !budget ||
    !(
      await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
        budget.expiresAt,
      ])
    ).rowCount
  )
    return { kind: "insufficient" };
  deadlines.push(budget.expiresAt);
  await client.query(
    "UPDATE support_time_allocations SET state='begun',begun_by=$2,begun_grant_id=$3,begin_key=$4,begun_at=clock_timestamp() WHERE id=$1",
    [scope.allocationId, actorId, scope.grantId, key],
  );
  await client.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) SELECT $1,id,member_id,$3,'begun' FROM support_time_allocations WHERE id=$2",
    [randomUUID(), scope.allocationId, actorId],
  );
  return {
    kind: "applied",
    receipt: await supportTimeReceipt(client, scope.allocationId),
  };
}

export async function recordSupportTime(
  client: PoolClient,
  actorId: string,
  scope: SupportTimeScope,
  key: string,
  intervals: SupportTimeIntervals,
  deadlines: Date[],
): Promise<SupportTimeResult> {
  const minutes = supportIntervalMinutes(intervals);
  if (!minutes) return { kind: "denied" };
  const allocation = (
    await client.query<{
      state: string;
      memberId: string;
      actorId: string | null;
      beginGrantId: string | null;
      ceiling: number;
    }>(
      `SELECT state,member_id AS "memberId",begun_by AS "actorId",begun_grant_id AS "beginGrantId",ceiling FROM support_time_allocations WHERE id=$1 AND request_id=$2 FOR UPDATE`,
      [scope.allocationId, scope.requestId],
    )
  ).rows[0];
  if (
    !allocation ||
    allocation.actorId !== actorId ||
    allocation.beginGrantId !== scope.grantId
  )
    return { kind: "denied" };
  const saved = (
    await client.query<SupportTimeIntervals & { key: string }>(
      `SELECT idempotency_key AS key,support_start AS "supportStart",support_end AS "supportEnd",preparation_start AS "preparationStart",preparation_end AS "preparationEnd" FROM support_time_entries WHERE allocation_id=$1`,
      [scope.allocationId],
    )
  ).rows[0];
  if (saved)
    return saved.key === key &&
      saved.supportStart.valueOf() === intervals.supportStart.valueOf() &&
      saved.supportEnd.valueOf() === intervals.supportEnd.valueOf() &&
      saved.preparationStart?.valueOf() ===
        intervals.preparationStart?.valueOf() &&
      saved.preparationEnd?.valueOf() === intervals.preparationEnd?.valueOf()
      ? {
          kind: "replayed",
          receipt: await supportTimeReceipt(client, scope.allocationId),
        }
      : { kind: "conflict" };
  if (
    allocation.state !== "begun" ||
    minutes.support + minutes.preparation > allocation.ceiling
  )
    return { kind: "conflict" };
  const valid = (
    await client.query<{ valid: boolean }>(
      "SELECT $1::timestamptz>=clock_timestamp()-interval '24 hours' AND $2::timestamptz<=clock_timestamp() AND ($3::timestamptz IS NULL OR ($3>=clock_timestamp()-interval '24 hours' AND $4::timestamptz<=clock_timestamp())) AS valid",
      [
        intervals.supportStart,
        intervals.supportEnd,
        intervals.preparationStart,
        intervals.preparationEnd,
      ],
    )
  ).rows[0];
  if (!valid?.valid) return { kind: "denied" };
  const overlap = (
    await client.query<{ conflict: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM support_time_entries e WHERE actor_id=$1 AND (
    tstzrange(e.support_start,e.support_end,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
    OR ($4::timestamptz IS NOT NULL AND tstzrange(e.support_start,e.support_end,'[)') && tstzrange($4::timestamptz,$5::timestamptz,'[)'))
    OR (e.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)'))
    OR (e.preparation_start IS NOT NULL AND $4::timestamptz IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange($4::timestamptz,$5::timestamptz,'[)')))) AS conflict`,
      [
        actorId,
        intervals.supportStart,
        intervals.supportEnd,
        intervals.preparationStart,
        intervals.preparationEnd,
      ],
    )
  ).rows[0];
  if (overlap?.conflict) return { kind: "conflict" };
  const budget = (
    await client.query<{ deadline: Date }>(
      "SELECT clock_timestamp()+interval '10 seconds' AS deadline",
    )
  ).rows[0]!.deadline;
  deadlines.push(budget, new Date(intervals.supportStart.valueOf() + 86400000));
  if (intervals.preparationStart)
    deadlines.push(new Date(intervals.preparationStart.valueOf() + 86400000));
  await client.query(
    "INSERT INTO support_time_entries(allocation_id,id,actor_id,grant_id,idempotency_key,support_start,support_end,preparation_start,preparation_end,support_minutes,preparation_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      scope.allocationId,
      randomUUID(),
      actorId,
      scope.grantId,
      key,
      intervals.supportStart,
      intervals.supportEnd,
      intervals.preparationStart,
      intervals.preparationEnd,
      minutes.support,
      minutes.preparation,
    ],
  );
  const units = (
    await client.query<{ ordinal: number; reservationId: string }>(
      `SELECT ordinal,reservation_id AS "reservationId" FROM support_time_units WHERE allocation_id=$1 ORDER BY ordinal`,
      [scope.allocationId],
    )
  ).rows;
  if (units.length !== allocation.ceiling)
    throw Error("Incomplete support allocation");
  const boundary = supportLedgerOnConnection(client, scope.allocationId);
  for (const unit of units) {
    const operation =
      unit.ordinal <= minutes.support + minutes.preparation
        ? "consume"
        : "release";
    await boundary[operation](
      allocation.memberId,
      unit.reservationId,
      `support-time:${scope.allocationId}:unit:${unit.ordinal}:${operation}`,
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Support settlement budget exceeded");
  }
  await client.query(
    "UPDATE support_time_allocations SET state='completed',settled_at=clock_timestamp() WHERE id=$1",
    [scope.allocationId],
  );
  await client.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'recorded')",
    [randomUUID(), scope.allocationId, allocation.memberId, actorId],
  );
  return {
    kind: "applied",
    receipt: await supportTimeReceipt(client, scope.allocationId),
  };
}

export async function supportTimeOperatorReceipt(
  client: PoolClient,
  actorId: string,
  scope: SupportTimeScope,
): Promise<OperatorSupportTimeReceipt> {
  const flags = (
    await client.query<{ canBegin: boolean; canRecord: boolean }>(
      `SELECT a.state='allocated' AND r.withdrawn_at IS NULL AND r.resolved_at IS NULL AS "canBegin",
    a.state='begun' AND a.begun_by=$2 AND a.begun_grant_id=$3 AS "canRecord"
    FROM support_time_allocations a JOIN support_requests r ON r.id=a.request_id WHERE a.id=$1`,
      [scope.allocationId, actorId, scope.grantId],
    )
  ).rows[0];
  if (!flags) throw Error("Support allocation unavailable");
  return {
    ...(await supportTimeReceipt(client, scope.allocationId)),
    ...flags,
    requestId: scope.requestId,
    grantId: scope.grantId,
  };
}

export async function cancelSupportTime(
  client: PoolClient,
  requestId: string,
  allocationId: string,
  memberId: string,
  deadlines: Date[],
): Promise<SupportTimeResult> {
  const allocation = (
    await client.query<{ state: string; ceiling: number }>(
      "SELECT state,ceiling FROM support_time_allocations WHERE id=$1 AND request_id=$2 AND member_id=$3 FOR UPDATE",
      [allocationId, requestId, memberId],
    )
  ).rows[0];
  if (!allocation) return { kind: "denied" };
  if (allocation.state === "cancelled")
    return {
      kind: "replayed",
      receipt: await supportTimeReceipt(client, allocationId),
    };
  if (allocation.state !== "allocated") return { kind: "conflict" };
  const units = (
    await client.query<{ ordinal: number; reservationId: string }>(
      `SELECT ordinal,reservation_id AS "reservationId" FROM support_time_units WHERE allocation_id=$1 ORDER BY ordinal`,
      [allocationId],
    )
  ).rows;
  if (units.length !== allocation.ceiling)
    throw Error("Incomplete support allocation");
  const budget = (
    await client.query<{ deadline: Date }>(
      "SELECT clock_timestamp()+interval '10 seconds' AS deadline",
    )
  ).rows[0]!.deadline;
  deadlines.push(budget);
  const boundary = supportLedgerOnConnection(client, allocationId);
  for (const unit of units) {
    await boundary.release(
      memberId,
      unit.reservationId,
      `support-time:${allocationId}:unit:${unit.ordinal}:release`,
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Support cancellation budget exceeded");
  }
  await client.query(
    "UPDATE support_time_allocations SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",
    [allocationId],
  );
  await client.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$3,'cancelled')",
    [randomUUID(), allocationId, memberId],
  );
  return {
    kind: "applied",
    receipt: await supportTimeReceipt(client, allocationId),
  };
}
