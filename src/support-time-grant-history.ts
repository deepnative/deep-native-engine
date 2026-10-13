import {
  sampleAssignmentDeny,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import type { SupportMinuteRow } from "./support-time-grant-values.ts";
export interface SupportMinuteCandidate {
  grantId: string;
  requestId: string;
  allocationId: string;
  operatorId: string;
  operationId: string;
  ownerId: string;
  workspaceId: string;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  at: string;
}
export async function supportMinuteCandidates(
  context: SampleAssignmentContext,
  where: string,
  values: unknown[],
) {
  return (
    await context.tx.query<SupportMinuteCandidate>(
      `SELECT g.id AS "grantId",g.request_id AS "requestId",g.allocation_id AS "allocationId",g.staff_id AS "operatorId",g.idempotency_key AS "operationId",
    a.member_id AS "ownerId",r.workspace_id AS "workspaceId",g.starts_at AS "startsAt",g.expires_at AS "expiresAt",g.created_at AS "createdAt",
    to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM support_time_grants g JOIN support_time_allocations a ON a.id=g.allocation_id AND a.request_id=g.request_id JOIN support_requests r ON r.id=a.request_id AND r.member_id=a.member_id ` +
        where,
      values,
    )
  ).rows;
}
/** Support writers lock grants before workspace/request/allocation. Never copy
 * the review-source-first ordering into this support permission path. */
export async function supportMinuteLocks(
  context: SampleAssignmentContext,
  rows: SupportMinuteCandidate[],
  writing = false,
) {
  for (const [table, ids] of [
    ["support_time_grants", rows.map((r) => r.grantId)],
    ["workspaces", rows.map((r) => r.workspaceId)],
    ["support_requests", rows.map((r) => r.requestId)],
    ["support_time_allocations", rows.map((r) => r.allocationId)],
  ] as const) {
    const distinct = [...new Set(ids)].sort();
    const locked = (
      await context.tx.query(
        `SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) ${table === "workspaces" ? "AND deleting_at IS NULL" : ""} ORDER BY id FOR ${writing ? "UPDATE" : "SHARE"}`,
        [distinct],
      )
    ).rows;
    if (locked.length !== distinct.length) return sampleAssignmentDeny();
  }
}
export async function supportMinuteProject(
  context: SampleAssignmentContext,
  candidate: SupportMinuteCandidate,
): Promise<SupportMinuteRow> {
  const row = (
    await context.tx.query<{
      ceiling: number;
      allocationState: string;
      revokedAt: Date | null;
      state: SupportMinuteRow["state"];
      sourceAvailable: boolean;
      canRevoke: boolean;
      role: "operator" | "platform_admin";
    }>(
      `WITH observed AS MATERIALIZED (
    SELECT g.*,a.state AS allocation_state,a.ceiling,
      COALESCE(r.withdrawn_at IS NULL AND m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp(),FALSE) source_available,
      r.resolved_at IS NULL request_unresolved,
      COALESCE(p.kind='staff' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND sp.role=g.staff_role,FALSE) operator_current
    FROM support_time_grants g JOIN support_time_allocations a ON a.id=g.allocation_id AND a.request_id=g.request_id
    JOIN support_requests r ON r.id=a.request_id AND r.member_id=a.member_id
    JOIN workspaces w ON w.id=r.workspace_id AND w.owner_principal_id=a.member_id AND w.deleting_at IS NULL
    LEFT JOIN principals p ON p.id=g.staff_id LEFT JOIN staff_profiles sp ON sp.principal_id=p.id LEFT JOIN principals m ON m.id=a.member_id
    WHERE g.id=$1 AND g.granted_by=$2 AND a.id=$3 AND r.id=$4 AND a.member_id=$5 AND r.workspace_id=$6 AND g.staff_id=$7)
    SELECT ceiling,allocation_state AS "allocationState",revoked_at AS "revokedAt",staff_role AS role,source_available AS "sourceAvailable",revoked_at IS NULL AS "canRevoke",
    CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired'
    WHEN NOT(source_available AND operator_current) OR allocation_state NOT IN ('allocated','begun') OR (allocation_state='allocated' AND NOT request_unresolved) THEN 'ineffective'
    WHEN starts_at>clock_timestamp() THEN 'scheduled' ELSE 'active' END AS state FROM observed`,
      [
        candidate.grantId,
        context.actorId,
        candidate.allocationId,
        candidate.requestId,
        candidate.ownerId,
        candidate.workspaceId,
        candidate.operatorId,
      ],
    )
  ).rows[0];
  if (!row) return sampleAssignmentDeny();
  return {
    grantId: candidate.grantId,
    requestId: candidate.requestId,
    allocationId: candidate.allocationId,
    operatorId: candidate.operatorId,
    startsAt: candidate.startsAt.toISOString(),
    expiresAt: candidate.expiresAt.toISOString(),
    createdAt: candidate.createdAt.toISOString(),
    ...row,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
