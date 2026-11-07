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
export async function readRequestSources(
  _client: Pick<PoolClient, "query">,
): Promise<RequestSources> {
  return { testEvents: emptyTestEvents, aiRequests: emptyAiRequests };
}
