import {
  sampleAssignmentDeny,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import type { ReviewGrantRow } from "./review-time-grant-values.ts";
export interface ReviewGrantCandidate {
  grantId: string;
  allocationId: string;
  reviewerId: string;
  operationId: string;
  ownerId: string;
  workspaceId: string;
  evidenceId: string | null;
  submissionId: string | null;
  sourceRevision: number;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  at: string;
}
export async function reviewGrantCandidates(
  context: SampleAssignmentContext,
  where: string,
  values: unknown[],
) {
  return (
    await context.tx.query<ReviewGrantCandidate>(
      `SELECT g.id AS "grantId",g.allocation_id AS "allocationId",g.staff_id AS "reviewerId",g.idempotency_key AS "operationId",
 a.member_id AS "ownerId",a.workspace_id AS "workspaceId",a.evidence_id AS "evidenceId",a.submission_id AS "submissionId",a.source_revision AS "sourceRevision",
 g.starts_at AS "startsAt",g.expires_at AS "expiresAt",g.created_at AS "createdAt",to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
 FROM review_time_grants g JOIN review_time_allocations a ON a.id=g.allocation_id ` +
        where,
      values,
    )
  ).rows;
}
/** All actor/profile locks precede these source-first locks. Historical reads
 * retain only safe permission metadata when the source is gone or withdrawn. */
export async function reviewGrantHistoryLocks(
  context: SampleAssignmentContext,
  rows: ReviewGrantCandidate[],
  writing = false,
) {
  const workspaces = [...new Set(rows.map((r) => r.workspaceId))].sort();
  const locked = (
    await context.tx.query(
      "SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY id FOR SHARE",
      [workspaces],
    )
  ).rows;
  if (locked.length !== workspaces.length) return sampleAssignmentDeny();
  const levels: [string, (string | null)[]][] = [
    ["evidence_objects", rows.map((r) => r.evidenceId)],
    ["evidence_review_submissions", rows.map((r) => r.submissionId)],
    ["review_time_allocations", rows.map((r) => r.allocationId)],
    ["review_time_grants", rows.map((r) => r.grantId)],
  ];
  for (const [table, ids] of levels)
    await context.tx.query(
      `SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${writing && table === "review_time_grants" ? "UPDATE" : "SHARE"}`,
      [[...new Set(ids.filter((id): id is string => id !== null))].sort()],
    );
}
export async function reviewGrantProject(
  context: SampleAssignmentContext,
  candidate: ReviewGrantCandidate,
): Promise<ReviewGrantRow> {
  const row = (
    await context.tx.query<{
      allocationState: string;
      ceiling: number;
      revokedAt: Date | null;
      state: ReviewGrantRow["state"];
      sourceAvailable: boolean;
      canRevoke: boolean;
    }>(
      `WITH observed AS MATERIALIZED (
 SELECT g.*,a.state AS allocation_state,a.ceiling,
 COALESCE(a.source_unavailable_at IS NULL AND e.id IS NOT NULL AND e.private_review_allowed AND e.quarantine_state='clean' AND e.media_type='text/plain'
 AND e.revision_number=a.source_revision AND e.owner_principal_id=a.member_id AND e.workspace_id=a.workspace_id
 AND s.evidence_id=e.id AND s.submitted_by=a.member_id AND s.status IN ('queued','reviewed'),FALSE) source_available,
 COALESCE(p.kind='staff' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND sp.role='reviewer',FALSE) reviewer_current,
 COALESCE(m.kind='member' AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp(),FALSE) owner_current
 FROM review_time_grants g JOIN review_time_allocations a ON a.id=g.allocation_id
 JOIN workspaces w ON w.id=a.workspace_id AND w.deleting_at IS NULL
 LEFT JOIN evidence_objects e ON e.id=a.evidence_id LEFT JOIN evidence_review_submissions s ON s.id=a.submission_id
 LEFT JOIN principals p ON p.id=g.staff_id LEFT JOIN authorized_staff_profiles sp ON sp.principal_id=p.id LEFT JOIN principals m ON m.id=a.member_id
 WHERE g.id=$1 AND g.granted_by=$2)
 SELECT allocation_state AS "allocationState",ceiling,revoked_at AS "revokedAt",source_available AS "sourceAvailable",revoked_at IS NULL AS "canRevoke",
 CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired'
 WHEN NOT(source_available AND reviewer_current AND owner_current) OR allocation_state NOT IN ('allocated','begun') THEN 'ineffective'
 WHEN starts_at>clock_timestamp() THEN 'scheduled' ELSE 'active' END AS state FROM observed`,
      [candidate.grantId, context.actorId],
    )
  ).rows[0];
  if (!row) return sampleAssignmentDeny();
  return {
    grantId: candidate.grantId,
    allocationId: candidate.allocationId,
    reviewerId: candidate.reviewerId,
    sourceRevision: candidate.sourceRevision,
    startsAt: candidate.startsAt.toISOString(),
    expiresAt: candidate.expiresAt.toISOString(),
    createdAt: candidate.createdAt.toISOString(),
    ...row,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
