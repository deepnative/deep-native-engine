import { SAMPLE_FEEDBACK_PURPOSE } from "./sample-feedback-values.ts";
import {
  sampleAssignmentDeny,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import type { SampleAssignmentRow } from "./sample-assignment-values.ts";

export interface SampleAssignmentCandidate {
  receiptId: string | null;
  workspaceId: string;
  ownerId: string;
  administratorId: string | null;
  operationId: string | null;
  reviewerId: string;
  evidenceId: string;
  sourceRevision: number;
  submissionId: string;
  assignmentId: string;
  exactGrantId: string;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  at: string;
}

/** Receipt rows survive their source/grants. Legacy grants enter the same stable
 * history only while they exist; reads never manufacture historical receipts. */
const candidates = `WITH candidates AS (
 SELECT o.id AS receipt_id,o.workspace_id,o.administrator_id,o.operation_id,o.reviewer_id,o.evidence_id,o.source_revision,
  o.submission_id,o.assignment_id,o.exact_grant_id,o.starts_at,o.expires_at,o.created_at
 FROM private_sample_assignment_operations o
 UNION ALL
 SELECT NULL::uuid,a.workspace_id,NULL::uuid,NULL::uuid,g.reviewer_id,e.id,e.revision_number,
  s.id,a.id,g.id,g.starts_at,g.expires_at,g.created_at
 FROM reviewer_evidence_grants g JOIN assignment_grants a ON a.id=g.assignment_id
 JOIN evidence_review_submissions s ON s.id=g.submission_id JOIN evidence_objects e ON e.id=s.evidence_id
 WHERE g.purpose='${SAMPLE_FEEDBACK_PURPOSE}' AND a.staff_id=g.reviewer_id AND a.staff_role='reviewer'
  AND a.workspace_id=e.workspace_id AND NOT EXISTS(SELECT 1 FROM private_sample_assignment_operations o WHERE o.exact_grant_id=g.id)
)
SELECT c.receipt_id AS "receiptId",c.workspace_id AS "workspaceId",w.owner_principal_id AS "ownerId",
 c.administrator_id AS "administratorId",c.operation_id AS "operationId",c.reviewer_id AS "reviewerId",
 c.evidence_id AS "evidenceId",c.source_revision AS "sourceRevision",c.submission_id AS "submissionId",
 c.assignment_id AS "assignmentId",c.exact_grant_id AS "exactGrantId",c.starts_at AS "startsAt",c.expires_at AS "expiresAt",
 c.created_at AS "createdAt",to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM candidates c JOIN workspaces w ON w.id=c.workspace_id`;

export async function sampleAssignmentCandidates(
  context: SampleAssignmentContext,
  where: string,
  values: unknown[],
) {
  return (
    await context.tx.query<SampleAssignmentCandidate>(
      candidates + " " + where,
      values,
    )
  ).rows;
}

/** Principals and profiles are already locked by the caller. A disappearing
 * historical source is a structural state, while a deleting workspace denies. */
export async function sampleAssignmentHistoryLocks(
  context: SampleAssignmentContext,
  rows: SampleAssignmentCandidate[],
  revoking = false,
) {
  const workspaces = [...new Set(rows.map((row) => row.workspaceId))].sort();
  const locked = (
    await context.tx.query(
      "SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY id FOR SHARE",
      [workspaces],
    )
  ).rows;
  if (locked.length !== workspaces.length) return sampleAssignmentDeny();
  const levels: [string, string[]][] = [
    ["evidence_objects", rows.map((row) => row.evidenceId)],
    ["evidence_review_submissions", rows.map((row) => row.submissionId)],
    ["assignment_grants", rows.map((row) => row.assignmentId)],
    ["reviewer_evidence_grants", rows.map((row) => row.exactGrantId)],
  ];
  for (const [table, ids] of levels)
    await context.tx.query(
      `SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${revoking && table === "reviewer_evidence_grants" ? "UPDATE" : "SHARE"}`,
      [[...new Set(ids)].sort()],
    );
}

export async function sampleAssignmentProject(
  context: SampleAssignmentContext,
  candidate: SampleAssignmentCandidate,
): Promise<SampleAssignmentRow> {
  const state = (
    await context.tx.query<
      Pick<SampleAssignmentRow, "revokedAt" | "state" | "canRevoke">
    >(
      `SELECT g.revoked_at::text AS "revokedAt",
     CASE WHEN g.id IS NULL THEN 'removed'
      WHEN g.revoked_at IS NOT NULL OR a.revoked_at IS NOT NULL THEN 'revoked'
      WHEN g.expires_at<=clock_timestamp() OR a.expires_at<=clock_timestamp() THEN 'expired'
      WHEN NOT (COALESCE(p.kind='staff' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND profile.role='reviewer',FALSE)
       AND COALESCE(e.workspace_id=$2 AND e.revision_number=$6 AND e.owner_principal_id=w.owner_principal_id
        AND s.submitted_by=e.owner_principal_id AND e.private_review_allowed AND e.quarantine_state='clean'
        AND e.media_type='text/plain' AND s.status IN ('queued','reviewed'),FALSE)) THEN 'ineffective'
      WHEN g.starts_at>clock_timestamp() OR a.starts_at>clock_timestamp() THEN 'scheduled' ELSE 'active' END AS state,
     g.id IS NOT NULL AND g.revoked_at IS NULL AS "canRevoke"
     FROM workspaces w
     LEFT JOIN assignment_grants a ON a.id=$3 AND a.workspace_id=w.id AND a.staff_id=$4 AND a.staff_role='reviewer'
     LEFT JOIN reviewer_evidence_grants g ON g.id=$1 AND g.assignment_id=a.id AND g.reviewer_id=$4 AND g.submission_id=$5 AND g.purpose=$7
     LEFT JOIN evidence_review_submissions s ON s.id=$5
     LEFT JOIN evidence_objects e ON e.id=s.evidence_id AND e.id=$8
     LEFT JOIN principals p ON p.id=$4 LEFT JOIN staff_profiles profile ON profile.principal_id=p.id
     WHERE w.id=$2 AND w.deleting_at IS NULL`,
      [
        candidate.exactGrantId,
        candidate.workspaceId,
        candidate.assignmentId,
        candidate.reviewerId,
        candidate.submissionId,
        candidate.sourceRevision,
        SAMPLE_FEEDBACK_PURPOSE,
        candidate.evidenceId,
      ],
    )
  ).rows[0];
  if (!state) return sampleAssignmentDeny();
  return {
    evidenceId: candidate.evidenceId,
    sourceRevision: candidate.sourceRevision,
    reviewerId: candidate.reviewerId,
    exactGrantId: candidate.exactGrantId,
    receiptId: candidate.receiptId,
    startsAt: candidate.startsAt.toISOString(),
    expiresAt: candidate.expiresAt.toISOString(),
    createdAt: candidate.createdAt.toISOString(),
    revokedAt:
      state.revokedAt === null ? null : new Date(state.revokedAt).toISOString(),
    state: state.state,
    canRevoke: state.canRevoke,
  };
}
