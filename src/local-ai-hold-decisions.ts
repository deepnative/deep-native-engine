import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import {
  HOLD_INSPECTION_PURPOSE,
  denyHoldInspection,
  holdInspectionAuthority,
  holdInspectionFailure,
  holdInspectionWorkspaces,
} from "./local-ai-hold-inspection-grants.ts";

/** #189: a labelled TEST outcome. It is never a provider's confirmation. */
export const HOLD_TEST_OUTCOMES = [
  "test-executed",
  "test-not-executed",
] as const;
export const HOLD_TEST_REASONS = [
  "matching-test-record",
  "operator-test-exercise",
] as const;
export type HoldTestOutcome = (typeof HOLD_TEST_OUTCOMES)[number];
export type HoldTestReason = (typeof HOLD_TEST_REASONS)[number];
export interface HoldTestDecisionInput {
  outcome: HoldTestOutcome;
  reason: HoldTestReason;
  sourceReference: string;
  key: string;
}
export interface HoldTestDecision {
  outcome: HoldTestOutcome;
  reason: HoldTestReason;
  sourceKind: "invented-test-record";
  sourceReference: string;
  priorStatus: "needs_reconciliation" | "expired-claim";
  decidedAt: string;
  /** Only whether the reader recorded it; never another staff identity. */
  decidedByReader: boolean;
}
export type HoldDecisionView =
  | {
      kind: "ready";
      jobId: string;
      /** Whether a decision may still be recorded. */
      open: boolean;
      metered: boolean;
      decision: HoldTestDecision | null;
    }
  | { kind: "denied" | "invalid" | "unavailable" };
export type HoldDecisionResult =
  | { kind: "applied" | "replayed"; decision: HoldTestDecision }
  | { kind: "conflict" | "closed" | "denied" | "invalid" | "unavailable" };
export interface LocalAiHoldDecisionStore {
  read(token: string, jobId: string): Promise<HoldDecisionView>;
  record(
    token: string,
    jobId: string,
    input: HoldTestDecisionInput,
  ): Promise<HoldDecisionResult>;
}

const sourceReference = /^test-[a-z0-9-]{1,60}$/;
export function validHoldTestInput(
  value: Partial<Record<keyof HoldTestDecisionInput, unknown>>,
): value is HoldTestDecisionInput {
  return (
    HOLD_TEST_OUTCOMES.includes(value.outcome as HoldTestOutcome) &&
    HOLD_TEST_REASONS.includes(value.reason as HoldTestReason) &&
    typeof value.sourceReference === "string" &&
    sourceReference.test(value.sourceReference) &&
    sampleUuid(value.key)
  );
}

interface Row {
  outcome: HoldTestOutcome;
  reason: HoldTestReason;
  sourceReference: string;
  priorStatus: HoldTestDecision["priorStatus"];
  decidedAt: Date;
  operatorId: string | null;
  key: string;
}
const decisionColumns = `outcome,reason,source_reference AS "sourceReference",prior_status AS "priorStatus",
 decided_at AS "decidedAt",operator_id AS "operatorId",idempotency_key AS key`;
function decision(row: Row, actorId: string): HoldTestDecision {
  return {
    outcome: row.outcome,
    reason: row.reason,
    sourceKind: "invented-test-record",
    sourceReference: row.sourceReference,
    priorStatus: row.priorStatus,
    decidedAt: row.decidedAt.toISOString(),
    decidedByReader: row.operatorId === actorId,
  };
}

interface Target {
  status: string;
  expired: boolean;
  metered: boolean;
  unitState: string | null;
}
/** Authority, then workspace, job and grant, in the inspection lock order. */
async function authorized(
  tx: SampleTransaction,
  token: string,
  jobId: string,
  lockJob: "SHARE" | "UPDATE",
) {
  const owner = (
    await tx.query<{ memberId: string }>(
      'SELECT member_id AS "memberId" FROM adapter_jobs WHERE id=$1 AND member_id IS NOT NULL',
      [jobId],
    )
  ).rows[0];
  if (!owner) return denyHoldInspection();
  const authority = await holdInspectionAuthority(tx, token, "operator", [
    owner.memberId,
  ]);
  await holdInspectionWorkspaces(tx, [owner.memberId]);
  const target = (
    await tx.query<Target>(
      `SELECT j.status,COALESCE(j.status='running' AND j.lease_until<=clock_timestamp(),false) AS expired,
       b.job_id IS NOT NULL AS metered,r.state AS "unitState"
       FROM adapter_jobs j LEFT JOIN local_ai_test_unit_jobs b ON b.job_id=j.id
       LEFT JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
       WHERE j.id=$1 AND j.member_id=$2 AND j.adapter='ai' AND j.mode IN ('demo','test')
        AND j.operation='evidence-summary-local-v1'
       FOR ${lockJob} OF j`,
      [jobId, owner.memberId],
    )
  ).rows[0];
  if (!target) return denyHoldInspection();
  const grant = (
    await tx.query<{ id: string; expires: Date }>(
      `SELECT id,expires_at AS expires FROM local_ai_hold_inspection_grants
       WHERE job_id=$1 AND member_id=$2 AND staff_id=$3 AND purpose=$4 AND revoked_at IS NULL
        AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()
       ORDER BY expires_at DESC,id LIMIT 1 FOR SHARE`,
      [jobId, owner.memberId, authority.actorId, HOLD_INSPECTION_PURPOSE],
    )
  ).rows[0];
  if (!grant) return denyHoldInspection();
  const deadlines = [...authority.deadlines, grant.expires];
  await tx.observe(deadlines);
  const current = (
    await tx.query<Row>(
      `SELECT ${decisionColumns} FROM local_ai_hold_test_decisions WHERE job_id=$1 AND member_id=$2`,
      [jobId, owner.memberId],
    )
  ).rows[0];
  const open =
    !current &&
    (target.status === "needs_reconciliation" || target.expired) &&
    (!target.metered || target.unitState === "reserved");
  return {
    memberId: owner.memberId,
    actorId: authority.actorId,
    grantId: grant.id,
    deadlines,
    target,
    current,
    open,
  };
}

export function localAiHoldDecisionStore(
  pool: Pool,
  options: { mode: ApplicationMode; enabled: boolean },
): LocalAiHoldDecisionStore {
  const available = options.mode !== "live" && options.enabled;
  return {
    async read(token, jobId) {
      if (!available) return { kind: "unavailable" };
      if (!sampleToken(token)) return { kind: "denied" };
      if (!sampleUuid(jobId)) return { kind: "invalid" };
      try {
        return await sampleFeedbackTransaction(pool, false, async (tx) => {
          const found = await authorized(tx, token, jobId, "SHARE");
          return {
            kind: "ready" as const,
            jobId,
            open: found.open,
            metered: found.target.metered,
            decision: found.current
              ? decision(found.current, found.actorId)
              : null,
          };
        });
      } catch (error) {
        return { kind: holdInspectionFailure(error) };
      }
    },
    async record(token, jobId, input) {
      if (!available) return { kind: "unavailable" };
      if (!sampleToken(token)) return { kind: "denied" };
      if (!sampleUuid(jobId) || !validHoldTestInput(input))
        return { kind: "invalid" };
      try {
        return await sampleFeedbackTransaction(pool, true, async (tx) => {
          const found = await authorized(tx, token, jobId, "UPDATE");
          const prior = (
            await tx.query<Row & { jobId: string }>(
              `SELECT job_id AS "jobId",${decisionColumns} FROM local_ai_hold_test_decisions
               WHERE operator_id=$1 AND idempotency_key=$2`,
              [found.actorId, input.key],
            )
          ).rows[0];
          if (prior)
            return prior.jobId === jobId &&
              prior.outcome === input.outcome &&
              prior.reason === input.reason &&
              prior.sourceReference === input.sourceReference
              ? {
                  kind: "replayed" as const,
                  decision: decision(prior, found.actorId),
                }
              : { kind: "conflict" as const };
          if (found.current) return { kind: "conflict" as const };
          if (!found.open) return { kind: "closed" as const };
          // An expired claim is held first, exactly as a new claim attempt would,
          // so its late worker can no longer complete it.
          if (found.target.expired)
            await tx.query(
              `UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,
               safe_error='provider_outcome_unknown',provider_operation_reference=NULL,updated_at=clock_timestamp()
               WHERE id=$1 AND status='running' AND lease_until<=clock_timestamp()`,
              [jobId],
            );
          const row = (
            await tx.query<Row>(
              `INSERT INTO local_ai_hold_test_decisions(job_id,member_id,grant_id,operator_id,outcome,reason,
                source_reference,prior_status,idempotency_key)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${decisionColumns}`,
              [
                jobId,
                found.memberId,
                found.grantId,
                found.actorId,
                input.outcome,
                input.reason,
                input.sourceReference,
                found.target.expired ? "expired-claim" : "needs_reconciliation",
                input.key,
              ],
            )
          ).rows[0];
          if (!row) throw new SampleFeedbackFailure("unavailable");
          await tx.observe(found.deadlines);
          return {
            kind: "applied" as const,
            decision: decision(row, found.actorId),
          };
        });
      } catch (error) {
        return { kind: holdInspectionFailure(error) };
      }
    },
  };
}
export function disabledLocalAiHoldDecisionStore(): LocalAiHoldDecisionStore {
  const unavailable = async () => ({ kind: "unavailable" as const });
  return { read: unavailable, record: unavailable };
}
