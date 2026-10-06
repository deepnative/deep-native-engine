import type { SampleAssignmentReferences } from "./sample-assignment-values.ts";
import {
  sampleAssignmentActors,
  sampleAssignmentDeny,
  type SampleAssignmentContext,
} from "./sample-assignment-transaction.ts";

export interface SampleAssignmentSourceKeys {
  workspaceId: string;
  ownerId: string;
}

/** Discover only structural identifiers before acquiring the entire sorted
 * principal set. Source eligibility is re-read under source-first row locks. */
export async function sampleAssignmentDiscover(
  context: SampleAssignmentContext,
  evidenceId: string,
) {
  return (
    await context.tx.query<SampleAssignmentSourceKeys>(
      `SELECT e.workspace_id AS "workspaceId",e.owner_principal_id AS "ownerId"
     FROM evidence_objects e WHERE e.id=$1`,
      [evidenceId],
    )
  ).rows[0];
}

export async function sampleAssignmentEligible(
  context: SampleAssignmentContext,
  references: SampleAssignmentReferences,
  discovered: SampleAssignmentSourceKeys | undefined,
  actors: Awaited<ReturnType<typeof sampleAssignmentActors>>,
) {
  const reviewer = actors.principals.get(references.reviewerId);
  const owner = discovered && actors.principals.get(discovered.ownerId);
  if (
    !discovered ||
    !owner ||
    owner.kind !== "member" ||
    owner.revoked !== null ||
    !reviewer ||
    reviewer.kind !== "staff" ||
    reviewer.revoked !== null ||
    actors.profiles.get(reviewer.id) !== "reviewer" ||
    reviewer.id === context.actorId
  )
    return sampleAssignmentDeny();
  context.expires.push(owner.expires, reviewer.expires);
  await context.tx.observe(context.expires);
  const workspace = (
    await context.tx.query(
      `SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$2 AND deleting_at IS NULL FOR SHARE`,
      [discovered.workspaceId, owner.id],
    )
  ).rows[0];
  if (!workspace) return sampleAssignmentDeny();
  const source = (
    await context.tx.query(
      `SELECT id FROM evidence_objects WHERE id=$1 AND workspace_id=$2 AND owner_principal_id=$3
      AND revision_number=$4 AND media_type='text/plain' AND private_review_allowed AND quarantine_state='clean' FOR SHARE`,
      [
        references.evidenceId,
        discovered.workspaceId,
        owner.id,
        references.sourceRevision,
      ],
    )
  ).rows[0];
  if (!source) return sampleAssignmentDeny();
  const submission = (
    await context.tx.query<{ id: string }>(
      `SELECT id FROM evidence_review_submissions WHERE evidence_id=$1 AND submitted_by=$2
      AND status IN ('queued','reviewed') FOR SHARE`,
      [references.evidenceId, owner.id],
    )
  ).rows[0];
  if (!submission) return sampleAssignmentDeny();
  return {
    ...discovered,
    submissionId: submission.id,
    reviewerExpires: reviewer.expires,
  };
}
