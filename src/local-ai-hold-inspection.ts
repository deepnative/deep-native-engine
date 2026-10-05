import { createHmac, randomBytes } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import { hash } from "./store.ts";
import { sampleToken, sampleUuid } from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
  type SampleTransaction,
} from "./sample-feedback-lifetime.ts";
import { reviewerWorklistCursor } from "./reviewer-worklist-cursor.ts";
import {
  HOLD_INSPECTION_PURPOSE,
  denyHoldInspection,
  holdInspectionAuthority,
  holdInspectionFailure,
  holdInspectionWorkspaces,
  localAiHoldInspectionGrants,
  type HoldGrantResult,
} from "./local-ai-hold-inspection-grants.ts";
export interface LocalAiHoldItem {
  jobId: string;
  state: "needs-reconciliation" | "expired-claim" | "not-unconfirmed";
  status:
    "pending" | "running" | "needs_reconciliation" | "succeeded" | "exhausted";
  createdAt: string;
  updatedAt: string;
  leaseUntil: string | null;
  unitState: "reserved" | "consumed" | "released";
  policy: "deterministic-request-test-v1";
  promptTemplateVersion: "local-simulation-v1";
  modelContractVersion: "deterministic-local-v1";
}
type Failure = { kind: "denied" | "invalid" | "unavailable" };
export type LocalAiHoldList =
  { kind: "ready"; items: LocalAiHoldItem[]; next: string | null } | Failure;
export type LocalAiHoldDetail =
  { kind: "ready"; value: LocalAiHoldItem } | Failure;
export interface LocalAiHoldInspectionStore {
  list(token: string, after?: string): Promise<LocalAiHoldList>;
  detail(token: string, jobId: string): Promise<LocalAiHoldDetail>;
  grant(
    token: string,
    jobId: string,
    operatorId: string,
    starts: Date,
    expires: Date,
    key: string,
  ): Promise<HoldGrantResult>;
  revoke(token: string, grantId: string): Promise<HoldGrantResult>;
}
interface Candidate extends QueryResultRow {
  jobId: string;
  memberId: string;
  grantId: string;
  grantExpires: Date;
  status: LocalAiHoldItem["status"];
  createdAt: Date;
  updatedAt: Date;
  leaseUntil: Date | null;
  at: string;
  expiredClaim: boolean;
  unitState: LocalAiHoldItem["unitState"];
  quantity: number;
  attemptCount: number;
  maxAttempts: number;
  policy: string;
  promptTemplateVersion: string;
  modelContractVersion: string;
}
// One database-observed instant determines grant validity and effective claim
// expiry. Source/receipt/private text are deliberately absent from every join.
const selection = `WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS observed)
 SELECT j.id AS "jobId",j.member_id AS "memberId",chosen.id AS "grantId",chosen.expires_at AS "grantExpires",
 j.status,j.created_at AS "createdAt",j.updated_at AS "updatedAt",j.lease_until AS "leaseUntil",
 to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
 COALESCE(j.status='running' AND j.lease_until<=instant.observed,false) AS "expiredClaim",
 r.state AS "unitState",r.quantity,j.attempt_count AS "attemptCount",j.max_attempts AS "maxAttempts",
 b.policy,j.prompt_template_version AS "promptTemplateVersion",j.model_contract_version AS "modelContractVersion"
 FROM instant CROSS JOIN adapter_jobs j
 JOIN local_ai_test_unit_jobs b ON b.job_id=j.id AND b.member_id=j.member_id
 JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
 JOIN synthetic_entitlement_grants units ON units.id=r.grant_id AND units.member_id=j.member_id
 JOIN workspaces w ON w.owner_principal_id=j.member_id AND w.deleting_at IS NULL
 JOIN LATERAL (SELECT g.id,g.expires_at FROM local_ai_hold_inspection_grants g
  WHERE g.job_id=j.id AND g.member_id=j.member_id AND g.staff_id=$1 AND g.purpose=$2
   AND g.revoked_at IS NULL AND g.starts_at<=instant.observed AND g.expires_at>instant.observed
  ORDER BY g.expires_at DESC,g.id LIMIT 1) chosen ON TRUE
 WHERE j.adapter='ai' AND j.mode IN ('demo','test') AND j.operation='evidence-summary-local-v1'
 AND units.category='study_requests'
 AND ($3::timestamptz IS NULL OR (j.created_at,j.id)>($3::timestamptz,$4::uuid))
 AND (NOT $5::boolean OR (r.state='reserved' AND (j.status='needs_reconciliation' OR (j.status='running' AND j.lease_until<=instant.observed))))
 AND ($6::uuid IS NULL OR j.id=$6::uuid)`;
function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(+value))
    throw new SampleFeedbackFailure("unavailable");
  return value.toISOString();
}
function item(row: Candidate): LocalAiHoldItem {
  const statePairs: Record<
    LocalAiHoldItem["status"],
    [number, LocalAiHoldItem["unitState"]]
  > = {
    pending: [0, "reserved"],
    running: [1, "reserved"],
    needs_reconciliation: [1, "reserved"],
    succeeded: [1, "consumed"],
    exhausted: [0, "released"],
  };
  const pair = Object.hasOwn(statePairs, row.status)
    ? statePairs[row.status]
    : undefined;
  if (
    !sampleUuid(row.jobId) ||
    !pair ||
    row.quantity !== 1 ||
    row.maxAttempts !== 1 ||
    pair[0] !== row.attemptCount ||
    pair[1] !== row.unitState ||
    row.policy !== "deterministic-request-test-v1" ||
    row.promptTemplateVersion !== "local-simulation-v1" ||
    row.modelContractVersion !== "deterministic-local-v1" ||
    typeof row.expiredClaim !== "boolean" ||
    (row.status === "running" && row.leaseUntil === null)
  )
    throw new SampleFeedbackFailure("unavailable");
  return {
    jobId: row.jobId,
    state:
      row.status === "needs_reconciliation"
        ? "needs-reconciliation"
        : row.expiredClaim
          ? "expired-claim"
          : "not-unconfirmed",
    status: row.status,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    leaseUntil: row.leaseUntil === null ? null : timestamp(row.leaseUntil),
    unitState: row.unitState,
    policy: "deterministic-request-test-v1",
    promptTemplateVersion: "local-simulation-v1",
    modelContractVersion: "deterministic-local-v1",
  };
}
async function lockCandidates(tx: SampleTransaction, rows: Candidate[]) {
  await holdInspectionWorkspaces(
    tx,
    rows.map((r) => r.memberId),
  );
  const jobIds = [...new Set(rows.map((r) => r.jobId))].sort();
  const jobs = await tx.query(
    "SELECT id FROM adapter_jobs WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
    [jobIds],
  );
  if (jobs.rows.length !== jobIds.length) return denyHoldInspection();
  const grantIds = [...new Set(rows.map((r) => r.grantId))].sort();
  const grants = await tx.query(
    "SELECT id FROM local_ai_hold_inspection_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
    [grantIds],
  );
  if (grants.rows.length !== grantIds.length) return denyHoldInspection();
}
export function localAiHoldInspectionStore(
  pool: Pool,
  options: { mode: ApplicationMode; enabled: boolean; secret?: Buffer },
): LocalAiHoldInspectionStore {
  const available = options.mode !== "live" && options.enabled;
  const grants = localAiHoldInspectionGrants(pool, available);
  // Reuse the existing reviewed navigation encoding with a separate derived
  // secret; reviewer and inspection continuations cannot cross purposes.
  const cursor = reviewerWorklistCursor(
    createHmac("sha256", options.secret ?? randomBytes(32))
      .update(HOLD_INSPECTION_PURPOSE)
      .digest(),
  );
  async function read(
    token: string,
    after: string | undefined,
    jobId: string | null,
  ) {
    if (!available) return { kind: "unavailable" as const };
    if (!sampleToken(token)) return { kind: "denied" as const };
    if (jobId !== null && !sampleUuid(jobId))
      return { kind: "invalid" as const };
    const previous = cursor.decode(token, "active", after);
    if (previous === "invalid") return { kind: "invalid" as const };
    try {
      return await sampleFeedbackTransaction(pool, false, async (tx) => {
        const actor = (
          await tx.query<{ id: string }>(
            "SELECT id FROM principals WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp()",
            [hash(token)],
          )
        ).rows[0];
        if (!actor) return denyHoldInspection();
        const args = [
          actor.id,
          HOLD_INSPECTION_PURPOSE,
          previous?.at ?? null,
          previous?.id ?? null,
          jobId === null,
          jobId,
        ];
        const candidates = (
          await tx.query<Candidate>(
            selection + " ORDER BY j.created_at,j.id LIMIT 21",
            args,
          )
        ).rows;
        if (!candidates.length) return denyHoldInspection();
        const authority = await holdInspectionAuthority(
          tx,
          token,
          "operator",
          candidates.map((r) => r.memberId),
        );
        if (authority.actorId !== actor.id) return denyHoldInspection();
        await lockCandidates(tx, candidates);
        const current = (
          await tx.query<Candidate>(
            selection +
              " AND j.id=ANY($7::uuid[]) ORDER BY j.created_at,j.id LIMIT 21",
            [...args, candidates.map((r) => r.jobId)],
          )
        ).rows;
        if (
          current.length !== candidates.length ||
          current.some(
            (r, i) =>
              r.jobId !== candidates[i]!.jobId ||
              r.memberId !== candidates[i]!.memberId ||
              r.grantId !== candidates[i]!.grantId,
          )
        )
          return denyHoldInspection();
        const deadlines = [
          ...authority.deadlines,
          ...current.map((r) => r.grantExpires),
          ...(previous ? [new Date(previous.expires)] : []),
        ];
        await tx.observe(deadlines);
        const items = current.slice(0, 20).map(item);
        const tail = current[Math.min(current.length, 20) - 1]!;
        const next =
          current.length > 20
            ? cursor.encode(
                token,
                "active",
                { at: tail.at, id: tail.jobId },
                Math.min(Date.now() + 900000, ...deadlines.map(Number)),
              )
            : null;
        await tx.observe(deadlines);
        return { kind: "ready" as const, items, next };
      });
    } catch (error) {
      return { kind: holdInspectionFailure(error) };
    }
  }
  return {
    grant: grants.grant,
    revoke:
      options.mode === "live"
        ? async () => ({ kind: "unavailable" })
        : grants.revoke,
    list: (token, after) => read(token, after, null),
    async detail(token, jobId) {
      const result = await read(token, undefined, jobId);
      return result.kind === "ready"
        ? { kind: "ready", value: result.items[0]! }
        : result;
    },
  };
}
export function disabledLocalAiHoldInspectionStore(): LocalAiHoldInspectionStore {
  const unavailable = async () => ({ kind: "unavailable" as const });
  return {
    list: unavailable,
    detail: unavailable,
    grant: unavailable,
    revoke: unavailable,
  };
}
