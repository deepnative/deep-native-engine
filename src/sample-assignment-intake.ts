import type { Pool } from "pg";
import { sampleAssignmentCursor } from "./sample-assignment-cursor.ts";
import { sampleAssignmentSource } from "./sample-assignment-input.ts";
import {
  sampleAssignmentActors,
  sampleAssignmentExecute,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "./sample-feedback-values.ts";
import {
  SAMPLE_ASSIGNMENT_PAGE_SIZE,
  type SampleAssignmentPendingItem,
  type SampleAssignmentSource,
} from "./sample-assignment-values.ts";

interface Candidate extends SampleAssignmentPendingItem {
  ownerId: string;
  workspaceId: string;
}
// Only deliberately requested, still-shareable sources need intake. A valid
// scheduled pair already assigns the work even though it cannot yet be read.
const selection = `SELECT e.id AS "evidenceId",e.revision_number AS "sourceRevision",
 to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "submittedAt",
 e.owner_principal_id AS "ownerId",e.workspace_id AS "workspaceId"
 FROM evidence_review_submissions s JOIN evidence_objects e ON e.id=s.evidence_id AND e.owner_principal_id=s.submitted_by
 JOIN principals p ON p.id=e.owner_principal_id AND p.kind='member' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
 JOIN workspaces w ON w.id=e.workspace_id AND w.owner_principal_id=p.id AND w.deleting_at IS NULL
 WHERE s.status='queued' AND e.private_review_allowed AND e.quarantine_state='clean' AND e.media_type='text/plain'
 AND NOT EXISTS (
  SELECT 1 FROM reviewer_evidence_grants g JOIN assignment_grants a ON a.id=g.assignment_id
  JOIN principals r ON r.id=g.reviewer_id AND r.kind='staff' AND r.revoked_at IS NULL
  JOIN staff_profiles rp ON rp.principal_id=r.id AND rp.role='reviewer'
  WHERE g.submission_id=s.id AND g.purpose=$1 AND g.revoked_at IS NULL
   AND a.staff_id=r.id AND a.staff_role='reviewer' AND a.workspace_id=w.id AND a.revoked_at IS NULL
   AND LEAST(a.expires_at,g.expires_at,r.expires_at)>GREATEST(a.starts_at,g.starts_at,clock_timestamp())
 )`;
const order = ` ORDER BY s.created_at,e.id LIMIT ${SAMPLE_ASSIGNMENT_PAGE_SIZE + 1}`;
async function candidates(
  context: SampleAssignmentContext,
  predicate: string,
  values: unknown[],
) {
  return (
    await context.tx.query<Candidate>(selection + predicate + order, [
      SAMPLE_FEEDBACK_PURPOSE,
      ...values,
    ])
  ).rows;
}
async function current(
  context: SampleAssignmentContext,
  discovered: Candidate[],
) {
  const actors = await sampleAssignmentActors(
    context,
    discovered.map((row) => row.ownerId),
  );
  for (const row of discovered) {
    const owner = actors.principals.get(row.ownerId);
    if (owner?.kind === "member" && owner.revoked === null)
      context.expires.push(owner.expires);
  }
  await context.tx.observe(context.expires);
  if (!discovered.length) return [];
  const ids = discovered.map((row) => row.evidenceId);
  await context.tx.query(
    "SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
    [[...new Set(discovered.map((row) => row.workspaceId))]],
  );
  await context.tx.query(
    "SELECT id FROM evidence_objects WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
    [ids],
  );
  await context.tx.query(
    "SELECT id FROM evidence_review_submissions WHERE evidence_id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
    [ids],
  );
  const prior = new Map(discovered.map((row) => [row.evidenceId, row]));
  const rows = await candidates(context, " AND e.id=ANY($2::uuid[])", [ids]);
  return rows.filter((row) => {
    const before = prior.get(row.evidenceId);
    return (
      before?.ownerId === row.ownerId &&
      before.workspaceId === row.workspaceId &&
      before.sourceRevision === row.sourceRevision &&
      before.submittedAt === row.submittedAt
    );
  });
}
const project = (row: Candidate): SampleAssignmentPendingItem => ({
  evidenceId: row.evidenceId,
  sourceRevision: row.sourceRevision,
  submittedAt: row.submittedAt,
});

export function sampleAssignmentIntake(
  pool: Pool,
  enabled: boolean,
  secret: Buffer,
) {
  const cursor = sampleAssignmentCursor(secret, "sample-assignment-intake");
  return {
    async pending(token: string, after?: string) {
      if (!enabled) return { kind: "unavailable" as const };
      const key = cursor.decode(token, undefined, after);
      if (key === "invalid") return { kind: "invalid" as const };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const discovered = await candidates(
          context,
          key ? " AND (s.created_at,e.id)>($2::timestamptz,$3::uuid)" : "",
          key ? [key.at, key.id] : [],
        );
        const rows = await current(context, discovered);
        const emitted = rows.slice(0, SAMPLE_ASSIGNMENT_PAGE_SIZE);
        // A page may shrink after a withdrawal. Continue past examined rows
        // without skipping an eligible overflow row or renewing cursor expiry.
        const last =
          rows.length > SAMPLE_ASSIGNMENT_PAGE_SIZE
            ? emitted.at(-1)
            : discovered.length > SAMPLE_ASSIGNMENT_PAGE_SIZE
              ? discovered.at(-1)
              : undefined;
        return {
          kind: "ready" as const,
          items: emitted.map(project),
          next: last
            ? cursor.encode(
                token,
                undefined,
                { at: last.submittedAt, id: last.evidenceId },
                key?.expires,
              )
            : null,
        };
      });
    },
    async selectPending(token: string, value: SampleAssignmentSource) {
      if (!enabled) return { kind: "unavailable" as const };
      const source = sampleAssignmentSource(value);
      if (!source) return { kind: "invalid" as const };
      return sampleAssignmentExecute(pool, token, false, async (context) => {
        const discovered = await candidates(
          context,
          " AND e.id=$2 AND e.revision_number=$3",
          [source.evidenceId, source.sourceRevision],
        );
        const rows = await current(context, discovered);
        return rows.length
          ? { kind: "ready" as const, source }
          : { kind: "denied" as const };
      });
    },
  };
}
