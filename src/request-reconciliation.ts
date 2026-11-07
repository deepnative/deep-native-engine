import type { PoolClient } from "pg";

/** #123 RECON-13..20: signed test events and metered test AI requests. */
export interface TestEventSummary {
  status: "empty" | "applied" | "waiting";
  receipts: number;
  receiptCents: number;
  refunds: number;
  refundCents: number;
  failures: number;
  failureCents: number;
  /** Held events with no applied receipt or refund for the same event. */
  waiting: number;
  waitingCents: number;
  /** Held events that were applied later, counted once as applied. */
  appliedAfterHold: number;
}
export interface AiRequestSummary {
  status: "empty" | "consistent" | "discrepancies";
  requests: number;
  estimated: number;
  noEstimate: number;
  estimatedPoints: number;
  settled: number;
  settledEstimatePoints: number;
  actualPoints: number;
  /** Estimates of requests with no settled cost. Never an actual. */
  openEstimatePoints: number;
  aboveEstimate: number;
  abovePoints: number;
  belowEstimate: number;
  belowPoints: number;
  reservedUnits: number;
  consumedUnits: number;
  releasedUnits: number;
  heldUnknown: number;
  consumedWithoutActual: number;
  actualWithoutConsumed: number;
  mismatches: number;
}
export interface RequestSources {
  testEvents: TestEventSummary;
  aiRequests: AiRequestSummary;
}
export const emptyTestEvents: TestEventSummary = {
  status: "empty",
  receipts: 0,
  receiptCents: 0,
  refunds: 0,
  refundCents: 0,
  failures: 0,
  failureCents: 0,
  waiting: 0,
  waitingCents: 0,
  appliedAfterHold: 0,
};
export const emptyAiRequests: AiRequestSummary = {
  status: "empty",
  requests: 0,
  estimated: 0,
  noEstimate: 0,
  estimatedPoints: 0,
  settled: 0,
  settledEstimatePoints: 0,
  actualPoints: 0,
  openEstimatePoints: 0,
  aboveEstimate: 0,
  abovePoints: 0,
  belowEstimate: 0,
  belowPoints: 0,
  reservedUnits: 0,
  consumedUnits: 0,
  releasedUnits: 0,
  heldUnknown: 0,
  consumedWithoutActual: 0,
  actualWithoutConsumed: 0,
  mismatches: 0,
};
const whole = (value: unknown) => {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(number))
    throw new Error("Request report value is not a whole number");
  return number;
};
const decode = <T extends object>(
  row: Record<string, unknown> | undefined,
  empty: T,
) => {
  if (!row) throw new Error("Request report row missing");
  return Object.fromEntries(
    Object.keys(empty)
      // Derived, never read from a row.
      .filter((key) => key !== "status" && key !== "mismatches")
      .map((key) => [key, whole(row[key])]),
  ) as Omit<T, "status" | "mismatches">;
};

/** RECON-13/14: test events are compared by kind; a held one is waiting until applied. */
export function summarizeTestEvents(
  facts: Omit<TestEventSummary, "status">,
): TestEventSummary {
  const any =
    facts.receipts + facts.refunds + facts.failures + facts.waiting > 0 ||
    facts.appliedAfterHold > 0;
  return {
    status: !any ? "empty" : facts.waiting ? "waiting" : "applied",
    ...facts,
  };
}
/** RECON-16..18: estimate and actual stay apart; only ledger disagreements are mismatches. */
export function summarizeAiRequests(
  facts: Omit<AiRequestSummary, "status" | "mismatches">,
): AiRequestSummary {
  const mismatches = facts.consumedWithoutActual + facts.actualWithoutConsumed;
  return {
    status: !facts.requests
      ? "empty"
      : mismatches
        ? "discrepancies"
        : "consistent",
    ...facts,
    mismatches,
  };
}

// Signed test events live on sample invoices only, which the database enforces.
const testEventsSql = `SELECT count(*) FILTER (WHERE kind='receipt')::integer AS receipts,
   COALESCE(sum(amount_cents) FILTER (WHERE kind='receipt'),0)::text AS "receiptCents",
   count(*) FILTER (WHERE kind='refund')::integer AS refunds,
   COALESCE(sum(amount_cents) FILTER (WHERE kind='refund'),0)::text AS "refundCents",
   count(*) FILTER (WHERE kind='failure')::integer AS failures,
   COALESCE(sum(amount_cents) FILTER (WHERE kind='failure'),0)::text AS "failureCents",
   count(*) FILTER (WHERE kind='held' AND NOT applied)::integer AS waiting,
   COALESCE(sum(amount_cents) FILTER (WHERE kind='held' AND NOT applied),0)::text AS "waitingCents",
   count(*) FILTER (WHERE kind='held' AND applied)::integer AS "appliedAfterHold"
 FROM (
   SELECT p.kind,p.amount_cents,EXISTS(
     SELECT 1 FROM simple_invoice_payments a
     WHERE a.provider_event_id=p.provider_event_id AND a.kind IN ('receipt','refund')
   ) AS applied
   FROM simple_invoice_payments p WHERE p.verification='signed_test_event'
 ) e`;
// A metered test request is one linked to a study-request unit. Settlement
// cannot exist without an estimate (foreign key), so only the unit can disagree.
const aiRequestsSql = `WITH r AS (
   SELECT j.status,u.state,e.cost_points AS estimate,s.cost_points AS actual,
     e.job_id IS NOT NULL AS estimated,s.job_id IS NOT NULL AS settled
   FROM local_ai_test_unit_jobs b
   JOIN adapter_jobs j ON j.id=b.job_id AND j.member_id=b.member_id
   JOIN synthetic_entitlement_reservations u ON u.id=b.reservation_id
   LEFT JOIN ai_usage_estimates e ON e.job_id=b.job_id AND e.member_id=b.member_id
   LEFT JOIN ai_usage_settlements s ON s.job_id=b.job_id AND s.member_id=b.member_id
 )
 SELECT count(*)::integer AS requests,
   count(*) FILTER (WHERE estimated)::integer AS estimated,
   count(*) FILTER (WHERE NOT estimated)::integer AS "noEstimate",
   COALESCE(sum(estimate),0)::text AS "estimatedPoints",
   count(*) FILTER (WHERE settled)::integer AS settled,
   COALESCE(sum(estimate) FILTER (WHERE settled),0)::text AS "settledEstimatePoints",
   COALESCE(sum(actual),0)::text AS "actualPoints",
   COALESCE(sum(estimate) FILTER (WHERE NOT settled),0)::text AS "openEstimatePoints",
   count(*) FILTER (WHERE actual>estimate)::integer AS "aboveEstimate",
   COALESCE(sum(actual-estimate) FILTER (WHERE actual>estimate),0)::text AS "abovePoints",
   count(*) FILTER (WHERE actual<estimate)::integer AS "belowEstimate",
   COALESCE(sum(estimate-actual) FILTER (WHERE actual<estimate),0)::text AS "belowPoints",
   count(*) FILTER (WHERE state='reserved')::integer AS "reservedUnits",
   count(*) FILTER (WHERE state='consumed')::integer AS "consumedUnits",
   count(*) FILTER (WHERE state='released')::integer AS "releasedUnits",
   count(*) FILTER (WHERE status='needs_reconciliation')::integer AS "heldUnknown",
   count(*) FILTER (WHERE state='consumed' AND NOT settled)::integer AS "consumedWithoutActual",
   count(*) FILTER (WHERE settled AND state<>'consumed')::integer AS "actualWithoutConsumed"
 FROM r`;

/** Reads both sources inside the caller's one read-only snapshot. */
export async function readRequestSources(
  client: Pick<PoolClient, "query">,
): Promise<RequestSources> {
  const events = (await client.query<Record<string, unknown>>(testEventsSql))
      .rows[0],
    requests = (await client.query<Record<string, unknown>>(aiRequestsSql))
      .rows[0];
  return {
    testEvents: summarizeTestEvents(decode(events, emptyTestEvents)),
    aiRequests: summarizeAiRequests(decode(requests, emptyAiRequests)),
  };
}
