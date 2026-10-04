import { randomUUID } from "node:crypto";
import type { LedgerConnection } from "./ledger.ts";
import { reviewLedgerOnConnection } from "./ledger.ts";
import { supportIntervalMinutes } from "./support-time.ts";

export interface ReviewTimeIntervals {
  reviewStart: Date;
  reviewEnd: Date;
  preparationStart: Date | null;
  preparationEnd: Date | null;
}
export function reviewIntervalMinutes(input: ReviewTimeIntervals) {
  const minutes = supportIntervalMinutes({
    supportStart: input.reviewStart,
    supportEnd: input.reviewEnd,
    preparationStart: input.preparationStart,
    preparationEnd: input.preparationEnd,
  });
  return minutes
    ? { review: minutes.support, preparation: minutes.preparation }
    : null;
}
export interface ReviewTimeReceipt {
  allocationId: string;
  ceiling: number;
  state:
    "allocated" | "begun" | "completed" | "cancelled" | "needs_reconciliation";
  held: number;
  consumed: number;
  released: number;
  reviewMinutes: number;
  preparationMinutes: number;
  sourceAvailable: boolean;
}
export type ReviewTimeResult =
  | { kind: "applied" | "replayed"; receipt: ReviewTimeReceipt }
  | {
      kind:
        "denied" | "unavailable" | "withdrawn" | "conflict" | "insufficient";
    };
export interface ReviewTimeScope {
  sourceKey: string;
  allocationId: string;
  grantId: string;
}
export interface ReviewPublication {
  feedbackId: string;
  draftRevision: number;
  operationId: string;
}

export async function reviewTimeReceipt(
  client: LedgerConnection,
  allocationId: string,
): Promise<ReviewTimeReceipt> {
  const row = (
    await client.query<ReviewTimeReceipt>(
      `
    SELECT a.id AS "allocationId",a.ceiling,a.state,a.source_unavailable_at IS NULL AS "sourceAvailable",
      (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='reserved') AS held,
      (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='consumed') AS consumed,
      (SELECT count(*)::integer FROM review_time_units u JOIN synthetic_entitlement_reservations r ON r.id=u.reservation_id WHERE u.allocation_id=a.id AND r.state='released') AS released,
      COALESCE(e.review_minutes,0) AS "reviewMinutes",COALESCE(e.preparation_minutes,0) AS "preparationMinutes"
    FROM review_time_allocations a LEFT JOIN review_time_entries e ON e.allocation_id=a.id WHERE a.id=$1`,
      [allocationId],
    )
  ).rows[0];
  if (!row) throw Error("Review allocation unavailable");
  return row;
}
export async function allocateReviewTime(
  client: LedgerConnection,
  request: {
    sourceKey: string;
    workspaceId: string;
    evidenceId: string;
    sourceRevision: number;
    memberId: string;
    withdrawnAt: Date | null;
    resolvedAt: Date | null;
  },
  key: string,
  ceiling: number,
  deadlines: Date[],
): Promise<ReviewTimeResult> {
  const prior = (
    await client.query<{ id: string; ceiling: number }>(
      "SELECT id,ceiling FROM review_time_allocations WHERE source_key=$1 AND member_id=$2 AND idempotency_key=$3 FOR UPDATE",
      [request.sourceKey, request.memberId, key],
    )
  ).rows[0];
  if (prior)
    return prior.ceiling === ceiling
      ? {
          kind: "replayed",
          receipt: await reviewTimeReceipt(client, prior.id),
        }
      : { kind: "conflict" };
  if (request.withdrawnAt) return { kind: "withdrawn" };
  if (request.resolvedAt) return { kind: "conflict" };
  if (
    (
      await client.query(
        "SELECT id FROM review_time_allocations WHERE source_key=$1 AND state IN ('allocated','begun','needs_reconciliation')",
        [request.sourceKey],
      )
    ).rowCount
  )
    return { kind: "conflict" };
  const grant = (
    await client.query<{ id: string; expiresAt: Date }>(
      `
    SELECT id,expires_at AS "expiresAt" FROM synthetic_entitlement_grants
    WHERE member_id=$1 AND category='review_minutes' AND available>=$2
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
    "INSERT INTO review_time_allocations(id,source_key,submission_id,member_id,grant_id,ceiling,idempotency_key,workspace_id,evidence_id,source_revision) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      allocationId,
      request.sourceKey,
      request.memberId,
      grant.id,
      ceiling,
      key,
      request.workspaceId,
      request.evidenceId,
      request.sourceRevision,
    ],
  );
  const boundary = reviewLedgerOnConnection(client, allocationId);
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
      `review-time:${allocationId}:unit:${ordinal}:reserve`,
    );
    await client.query(
      "INSERT INTO review_time_units(allocation_id,ordinal,reservation_id) VALUES($1,$2,$3)",
      [allocationId, ordinal, reservationId],
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Review allocation budget exceeded");
  }
  await client.query(
    "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$3,'allocated')",
    [randomUUID(), allocationId, request.memberId],
  );
  return {
    kind: "applied",
    receipt: await reviewTimeReceipt(client, allocationId),
  };
}

export async function beginReviewTime(
  client: LedgerConnection,
  actorId: string,
  scope: ReviewTimeScope,
  request: { withdrawnAt: Date | null; resolvedAt: Date | null },
  key: string,
  deadlines: Date[],
): Promise<ReviewTimeResult> {
  const allocation = (
    await client.query<{
      state: string;
      actorId: string | null;
      grantId: string;
      beginGrantId: string | null;
      beginKey: string | null;
    }>(
      `SELECT state,begun_by AS "actorId",grant_id AS "grantId",begun_grant_id AS "beginGrantId",begin_key AS "beginKey"
    FROM review_time_allocations WHERE id=$1 AND source_key=$2 FOR UPDATE`,
      [scope.allocationId, scope.sourceKey],
    )
  ).rows[0];
  if (!allocation) return { kind: "denied" };
  if (allocation.beginKey === key)
    return allocation.actorId === actorId &&
      allocation.beginGrantId === scope.grantId
      ? {
          kind: "replayed",
          receipt: await reviewTimeReceipt(client, scope.allocationId),
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
    "UPDATE review_time_allocations SET state='begun',begun_by=$2,begun_grant_id=$3,begin_key=$4,begun_at=clock_timestamp() WHERE id=$1",
    [scope.allocationId, actorId, scope.grantId, key],
  );
  await client.query(
    "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) SELECT $1,id,member_id,$3,'begun' FROM review_time_allocations WHERE id=$2",
    [randomUUID(), scope.allocationId, actorId],
  );
  return {
    kind: "applied",
    receipt: await reviewTimeReceipt(client, scope.allocationId),
  };
}

export async function recordReviewTime(
  client: LedgerConnection,
  actorId: string,
  scope: ReviewTimeScope,
  key: string,
  intervals: ReviewTimeIntervals,
  deadlines: Date[],
  publication: ReviewPublication,
  publish: () => Promise<void>,
): Promise<ReviewTimeResult> {
  const minutes = reviewIntervalMinutes(intervals);
  if (!minutes) return { kind: "denied" };
  const allocation = (
    await client.query<{
      state: string;
      memberId: string;
      actorId: string | null;
      beginGrantId: string | null;
      ceiling: number;
    }>(
      `SELECT state,member_id AS "memberId",begun_by AS "actorId",begun_grant_id AS "beginGrantId",ceiling FROM review_time_allocations WHERE id=$1 AND source_key=$2 FOR UPDATE`,
      [scope.allocationId, scope.sourceKey],
    )
  ).rows[0];
  if (
    !allocation ||
    allocation.actorId !== actorId ||
    allocation.beginGrantId !== scope.grantId
  )
    return { kind: "denied" };
  const saved = (
    await client.query<
      ReviewTimeIntervals & {
        key: string;
        feedbackId: string;
        draftRevision: number;
        operationId: string;
      }
    >(
      `SELECT idempotency_key AS key,feedback_id AS "feedbackId",draft_revision AS "draftRevision",publication_operation_id AS "operationId",review_start AS "reviewStart",review_end AS "reviewEnd",preparation_start AS "preparationStart",preparation_end AS "preparationEnd" FROM review_time_entries WHERE allocation_id=$1`,
      [scope.allocationId],
    )
  ).rows[0];
  if (saved)
    return saved.key === key &&
      saved.feedbackId === publication.feedbackId &&
      saved.draftRevision === publication.draftRevision &&
      saved.operationId === publication.operationId &&
      saved.reviewStart.valueOf() === intervals.reviewStart.valueOf() &&
      saved.reviewEnd.valueOf() === intervals.reviewEnd.valueOf() &&
      saved.preparationStart?.valueOf() ===
        intervals.preparationStart?.valueOf() &&
      saved.preparationEnd?.valueOf() === intervals.preparationEnd?.valueOf()
      ? {
          kind: "replayed",
          receipt: await reviewTimeReceipt(client, scope.allocationId),
        }
      : { kind: "conflict" };
  if (
    allocation.state !== "begun" ||
    minutes.review + minutes.preparation > allocation.ceiling
  )
    return { kind: "conflict" };
  const valid = (
    await client.query<{ valid: boolean }>(
      "SELECT $1::timestamptz>=clock_timestamp()-interval '24 hours' AND $2::timestamptz<=clock_timestamp() AND ($3::timestamptz IS NULL OR ($3>=clock_timestamp()-interval '24 hours' AND $4::timestamptz<=clock_timestamp())) AS valid",
      [
        intervals.reviewStart,
        intervals.reviewEnd,
        intervals.preparationStart,
        intervals.preparationEnd,
      ],
    )
  ).rows[0];
  if (!valid?.valid) return { kind: "denied" };
  const overlap = (
    await client.query<{ conflict: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM (
      SELECT actor_id,review_start,review_end,preparation_start,preparation_end FROM review_time_entries WHERE actor_id=$1
      UNION ALL SELECT actor_id,support_start,support_end,preparation_start,preparation_end FROM support_time_entries WHERE actor_id=$1
    ) e WHERE actor_id=$1 AND (
    tstzrange(e.review_start,e.review_end,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
    OR ($4::timestamptz IS NOT NULL AND tstzrange(e.review_start,e.review_end,'[)') && tstzrange($4::timestamptz,$5::timestamptz,'[)'))
    OR (e.preparation_start IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)'))
    OR (e.preparation_start IS NOT NULL AND $4::timestamptz IS NOT NULL AND tstzrange(e.preparation_start,e.preparation_end,'[)') && tstzrange($4::timestamptz,$5::timestamptz,'[)')))) AS conflict`,
      [
        actorId,
        intervals.reviewStart,
        intervals.reviewEnd,
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
  deadlines.push(budget, new Date(intervals.reviewStart.valueOf() + 86400000));
  if (intervals.preparationStart)
    deadlines.push(new Date(intervals.preparationStart.valueOf() + 86400000));
  await client.query(
    "INSERT INTO review_time_entries(allocation_id,id,actor_id,grant_id,idempotency_key,review_start,review_end,preparation_start,preparation_end,review_minutes,preparation_minutes,feedback_id,draft_revision,publication_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [
      scope.allocationId,
      randomUUID(),
      actorId,
      scope.grantId,
      key,
      intervals.reviewStart,
      intervals.reviewEnd,
      intervals.preparationStart,
      intervals.preparationEnd,
      minutes.review,
      minutes.preparation,
      publication.feedbackId,
      publication.draftRevision,
      publication.operationId,
    ],
  );
  const units = (
    await client.query<{ ordinal: number; reservationId: string }>(
      `SELECT ordinal,reservation_id AS "reservationId" FROM review_time_units WHERE allocation_id=$1 ORDER BY ordinal`,
      [scope.allocationId],
    )
  ).rows;
  if (units.length !== allocation.ceiling)
    throw Error("Incomplete review allocation");
  const boundary = reviewLedgerOnConnection(client, scope.allocationId);
  for (const unit of units) {
    const operation =
      unit.ordinal <= minutes.review + minutes.preparation
        ? "consume"
        : "release";
    await boundary[operation](
      allocation.memberId,
      unit.reservationId,
      `review-time:${scope.allocationId}:unit:${unit.ordinal}:${operation}`,
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Review settlement budget exceeded");
  }
  await publish();
  await client.query(
    "UPDATE review_time_allocations SET state='completed',settled_at=clock_timestamp() WHERE id=$1",
    [scope.allocationId],
  );
  await client.query(
    "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'published')",
    [randomUUID(), scope.allocationId, allocation.memberId, actorId],
  );
  return {
    kind: "applied",
    receipt: await reviewTimeReceipt(client, scope.allocationId),
  };
}

export async function cancelReviewTime(
  client: LedgerConnection,
  sourceKey: string,
  allocationId: string,
  memberId: string,
  deadlines: Date[],
): Promise<ReviewTimeResult> {
  const allocation = (
    await client.query<{ state: string; ceiling: number }>(
      "SELECT state,ceiling FROM review_time_allocations WHERE id=$1 AND source_key=$2 AND member_id=$3 FOR UPDATE",
      [allocationId, sourceKey, memberId],
    )
  ).rows[0];
  if (!allocation) return { kind: "denied" };
  if (allocation.state === "cancelled")
    return {
      kind: "replayed",
      receipt: await reviewTimeReceipt(client, allocationId),
    };
  if (allocation.state !== "allocated") return { kind: "conflict" };
  const units = (
    await client.query<{ ordinal: number; reservationId: string }>(
      `SELECT ordinal,reservation_id AS "reservationId" FROM review_time_units WHERE allocation_id=$1 ORDER BY ordinal`,
      [allocationId],
    )
  ).rows;
  if (units.length !== allocation.ceiling)
    throw Error("Incomplete review allocation");
  const budget = (
    await client.query<{ deadline: Date }>(
      "SELECT clock_timestamp()+interval '10 seconds' AS deadline",
    )
  ).rows[0]!.deadline;
  deadlines.push(budget);
  const boundary = reviewLedgerOnConnection(client, allocationId);
  for (const unit of units) {
    await boundary.release(
      memberId,
      unit.reservationId,
      `review-time:${allocationId}:unit:${unit.ordinal}:release`,
    );
    if (
      !(
        await client.query("SELECT 1 WHERE clock_timestamp()<$1::timestamptz", [
          budget,
        ])
      ).rowCount
    )
      throw Error("Review cancellation budget exceeded");
  }
  await client.query(
    "UPDATE review_time_allocations SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1",
    [allocationId],
  );
  await client.query(
    "INSERT INTO review_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$3,'cancelled')",
    [randomUUID(), allocationId, memberId],
  );
  return {
    kind: "applied",
    receipt: await reviewTimeReceipt(client, allocationId),
  };
}
