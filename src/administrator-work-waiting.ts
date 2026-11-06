import type { PoolClient } from "pg";
import { feedbackQueueSelection } from "./sample-assignment-intake.ts";
import { SAMPLE_FEEDBACK_PURPOSE } from "./sample-feedback-values.ts";
import { workflowBundle } from "./workflow-registry.ts";

/**
 * WAITWORK: counts and ages an administrator needs to notice waiting member
 * work. Metadata only: no subject, title, note, name or account reference.
 * Workflow review references are the one exception: assignment needs them, and
 * they reveal nothing about the member or the note.
 */
export interface WorkQueue {
  waiting: number;
  /** Minutes the oldest waiting item has waited; null when none is waiting. */
  oldestWaitingMinutes: number | null;
  /** Null when this queue has no assigned state of its own. */
  assigned: number | null;
  oldestAssignedMinutes: number | null;
  /** WAITWORK-09: current accounts holding the role this queue needs. */
  people: number;
}
export interface WorkWaiting {
  support: WorkQueue;
  feedback: WorkQueue;
  workflow: WorkQueue & { references: string[] };
  contributions: WorkQueue;
}
export const WORKFLOW_REFERENCE_LIMIT = 20;

const minutes = (filter: string) =>
  `floor(extract(epoch FROM clock_timestamp()-min(at) FILTER (WHERE ${filter}))/60)::int`;
/** Summarizes an inner query that yields `at timestamptz, assigned boolean`. */
const summary = (inner: string) =>
  `SELECT count(*) FILTER (WHERE NOT assigned)::int AS waiting,
    ${minutes("NOT assigned")} AS "oldestWaitingMinutes",
    count(*) FILTER (WHERE assigned)::int AS assigned,
    ${minutes("assigned")} AS "oldestAssignedMinutes"
   FROM (${inner}) q`;
const currentMember = (alias: string) =>
  `${alias}.kind='member' AND ${alias}.revoked_at IS NULL AND ${alias}.expires_at>clock_timestamp()`;
const currentStaff = (alias: string, until: string) =>
  `${alias}.kind='staff' AND ${alias}.revoked_at IS NULL AND LEAST(${until},${alias}.expires_at)>clock_timestamp()`;

const support = `SELECT r.received_at AS at, EXISTS(
   SELECT 1 FROM support_request_grants g JOIN principals s ON s.id=g.staff_id
   WHERE g.request_id=r.id AND g.revoked_at IS NULL AND ${currentStaff("s", "g.expires_at")}
  ) AS assigned
  FROM support_requests r
  JOIN workspaces w ON w.id=r.workspace_id AND w.owner_principal_id=r.member_id AND w.deleting_at IS NULL
  JOIN principals p ON p.id=r.member_id AND ${currentMember("p")}
  WHERE r.withdrawn_at IS NULL AND r.resolved_at IS NULL`;

// staff_profiles, not the authorized view: that view takes share locks, which a
// read-only transaction refuses, and it filters only platform_admin rows.
const feedback = `SELECT "submittedAt"::timestamptz AS at, false AS assigned
   FROM (${feedbackQueueSelection("staff_profiles", "NOT EXISTS")}) unassigned
  UNION ALL
  SELECT "submittedAt"::timestamptz AS at, true AS assigned
   FROM (${feedbackQueueSelection("staff_profiles", "EXISTS")}
    AND NOT EXISTS (SELECT 1 FROM private_sample_feedback f
     WHERE f.submission_id=s.id AND f.published_at IS NOT NULL)) unfinished`;

// The same "still assignable" facts the assignment check enforces: the request
// is live and still matches the member's current note and workflow version.
const workflow = `SELECT r.id, r.created_at AS at, EXISTS(
   SELECT 1 FROM workflow_review_grants g JOIN principals s ON s.id=g.moderator_id
   WHERE g.request_id=r.id AND g.source_instance_id=r.source_instance_id
    AND g.source_revision=r.source_revision AND g.revoked_at IS NULL
    AND ${currentStaff("s", "g.expires_at")}
  ) AS assigned
  FROM workflow_review_requests r
  JOIN workspaces w ON w.id=r.workspace_id AND w.owner_principal_id=r.member_id AND w.deleting_at IS NULL
  JOIN principals p ON p.id=r.member_id AND ${currentMember("p")}
  JOIN workflow_feedback f ON f.member_id=r.member_id AND f.workflow_id=r.workflow_id
   AND f.workflow_version=r.workflow_version AND f.instance_id=r.source_instance_id
   AND f.revision=r.source_revision
  WHERE r.withdrawn_at IS NULL AND r.expires_at>clock_timestamp()
   AND (r.workflow_id||':'||r.workflow_version)=ANY($1::text[])`;

const contributions = `SELECT mp.submitted_at AS at, false AS assigned
  FROM member_proposals mp
  JOIN workspaces w ON w.owner_principal_id=mp.member_id AND w.deleting_at IS NULL
  JOIN principals p ON p.id=mp.member_id AND ${currentMember("p")}
  WHERE mp.state='submitted'`;

const people = `SELECT
   (SELECT count(*) FROM staff_profiles s JOIN principals p ON p.id=s.principal_id
     WHERE s.role='operator' AND ${currentStaff("p", "p.expires_at")})::int AS operators,
   (SELECT count(*) FROM staff_profiles s JOIN principals p ON p.id=s.principal_id
     WHERE s.role='reviewer' AND ${currentStaff("p", "p.expires_at")})::int AS reviewers,
   (SELECT count(*) FROM staff_profiles s JOIN principals p ON p.id=s.principal_id
     WHERE s.role='moderator' AND ${currentStaff("p", "p.expires_at")})::int AS moderators,
   (SELECT count(DISTINCT a.member_id) FROM administrator_sessions a JOIN principals p ON p.id=a.staff_id
     WHERE a.revoked_at IS NULL AND ${currentStaff("p", "a.expires_at")})::int AS administrators`;

/** The workflow versions members can still be assigned for, as `id:version`. */
async function currentWorkflowVersions(client: PoolClient) {
  const pairs = await client.query<{ id: string; version: number }>(
    `SELECT DISTINCT workflow_id AS id,workflow_version AS version FROM workflow_review_requests
     WHERE withdrawn_at IS NULL AND expires_at>clock_timestamp()`,
  );
  const current: string[] = [];
  for (const { id, version } of pairs.rows)
    if ((await workflowBundle(id))?.version === version)
      current.push(`${id}:${version}`);
  return current;
}

export async function readWorkWaiting(
  client: PoolClient,
): Promise<WorkWaiting> {
  type Row = Omit<WorkQueue, "people">;
  const one = async (sql: string, values: unknown[] = []) =>
    (await client.query<Row>(summary(sql), values)).rows[0]!;
  const versions = await currentWorkflowVersions(client);
  const staff = (
    await client.query<{
      operators: number;
      reviewers: number;
      moderators: number;
      administrators: number;
    }>(people)
  ).rows[0]!;
  const references = await client.query<{ id: string }>(
    `SELECT id FROM (${workflow}) q WHERE NOT assigned ORDER BY at,id LIMIT ${WORKFLOW_REFERENCE_LIMIT}`,
    [versions],
  );
  return {
    support: { ...(await one(support)), people: staff.operators },
    feedback: {
      ...(await one(feedback, [SAMPLE_FEEDBACK_PURPOSE])),
      people: staff.reviewers,
    },
    workflow: {
      ...(await one(workflow, [versions])),
      people: staff.moderators,
      references: references.rows.map((row) => row.id),
    },
    // A contribution has no assignment: any moderator or administrator acts.
    contributions: {
      ...(await one(contributions)),
      assigned: null,
      oldestAssignedMinutes: null,
      people: staff.moderators + staff.administrators,
    },
  };
}
