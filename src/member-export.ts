import type { Pool } from "pg";
import { hash } from "./store.ts";

export const MAX_MEMBER_EXPORT_RECORDS = 100;
export const MAX_MEMBER_EXPORT_BYTES = 256 * 1024;

const sections = {
  exercises: `SELECT lesson_id AS "lessonId",lesson_version AS "lessonVersion",
    instruction,verification,completed_at AS "completedAt",goal_at_start AS "goalAtStart",
    CASE WHEN withdrawn_at IS NULL THEN 'saved' ELSE 'withdrawn' END AS state,
    withdrawn_at AS "withdrawnAt"
    FROM exercises WHERE learner_id=$1 ORDER BY lesson_id,lesson_version LIMIT $2 FOR SHARE`,
  lessonActivity: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    opened_at AS "openedAt",started_at AS "startedAt",self_assessed_at AS "selfAssessedAt"
    FROM lesson_activity WHERE member_id=$1 ORDER BY content_id,content_version LIMIT $2`,
  lessonUsefulness: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    choice,revision,reported_at AS "reportedAt",updated_at AS "updatedAt"
    FROM lesson_usefulness WHERE member_id=$1 ORDER BY content_id,content_version LIMIT $2`,
  assignmentChoices: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    chosen_at AS "chosenAt" FROM learner_assignment_choices WHERE member_id=$1 LIMIT $2`,
  // Whole-series deletion cascades submission snapshots through this parent.
  // Lock attempts before reading either section, in stable UUID order, then
  // restore the prior display order. A changed snapshot tuple fails closed.
  assignmentAttempts: `WITH locked AS MATERIALIZED (
    SELECT id,content_id AS "contentId",content_version AS "contentVersion",
      goal_at_start AS "goalAtStart",response,revision,
      submission_count AS "submissionCount",started_at AS "startedAt",
      saved_at AS "savedAt",submitted_at AS "submittedAt"
    FROM assignment_attempts WHERE member_id=$1 ORDER BY id LIMIT $2 FOR SHARE
    ) SELECT * FROM locked ORDER BY "startedAt",id`,
  assignmentSubmissions: `SELECT s.attempt_id AS "attemptId",s.sequence,s.response,
    s.submitted_at AS "submittedAt" FROM assignment_submission_snapshots s
    JOIN assignment_attempts a ON a.id=s.attempt_id
    WHERE a.member_id=$1 ORDER BY a.started_at,s.sequence LIMIT $2`,
  adapterJobs: `SELECT j.id,j.adapter,j.mode,j.status,j.attempt_count AS attempts,
    j.max_attempts AS "maxAttempts",j.safe_error AS "safeError",
    j.created_at AS "createdAt",j.updated_at AS "updatedAt",
    r.id AS "localAiReceiptId"
    FROM adapter_jobs j LEFT JOIN local_ai_receipts r
      ON r.id=j.local_ai_receipt_id AND r.member_id=j.member_id
    WHERE j.member_id=$1 ORDER BY j.created_at,j.id LIMIT $2`,
  // Retained history is not current eligibility; withdrawal and revision
  // retirement do not erase it. Source deletion already cascades these rows.
  localAiReceipts: `SELECT id,evidence_id AS "evidenceId",
    revision_number AS "revisionNumber",purpose,statement_version AS "statementVersion",
    granted_at AS "grantedAt",withdrawn_at AS "withdrawnAt"
    FROM local_ai_receipts WHERE member_id=$1 ORDER BY granted_at,id LIMIT $2`,
  milestones: `SELECT id,goal_title AS "goalTitle",milestone_title AS "milestoneTitle",
    evidence_note AS "evidenceNote",next_action AS "nextAction",
    reminder_date AS "reminderDate",reminder_time AS "reminderTime",
    reminder_time_zone AS "reminderTimeZone",self_reported_complete AS "selfReportedComplete",
    version,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM learning_milestones WHERE member_id=$1 ORDER BY created_at,id LIMIT $2`,
  careerPreferences: `SELECT opted_in_at AS "optedInAt"
    FROM career_preferences WHERE member_id=$1 LIMIT $2`,
  careerEntries: `SELECT id,kind,title,note,next_action AS "nextAction",
    self_reported_outcome AS "selfReportedOutcome",version,
    created_at AS "createdAt",updated_at AS "updatedAt"
    FROM career_entries WHERE member_id=$1 ORDER BY created_at,id LIMIT $2`,
  careerDrafts: `SELECT id,kind,title,body,approved,version,
    created_at AS "createdAt",updated_at AS "updatedAt"
    FROM career_drafts WHERE member_id=$1 ORDER BY created_at,id LIMIT $2`,
  // Withdrawal and rejection redact these fields. Lock rows in UUID order,
  // matching moderation's lock order, then restore the export's date order.
  // A changed tuple under REPEATABLE READ makes the export fail closed.
  proposals: `WITH locked AS MATERIALIZED (
    SELECT id,title,body,sources,state,revision,
      workflow_id AS "workflowId",workflow_version AS "workflowVersion",
      created_at AS "createdAt",
      submitted_at AS "submittedAt",withdrawn_at AS "withdrawnAt"
    FROM member_proposals WHERE member_id=$1 ORDER BY id LIMIT $2 FOR SHARE
    ) SELECT * FROM locked ORDER BY "createdAt",id`,
  workflowFeedback: `SELECT workflow_id AS "workflowId",
    workflow_version AS "workflowVersion",note,revision,
    created_at AS "createdAt",updated_at AS "updatedAt"
    FROM workflow_feedback WHERE member_id=$1
    ORDER BY workflow_id,workflow_version LIMIT $2 FOR SHARE`,
  // A withdrawal may commit while the repeatable-read owner lookup waits.
  // Lock the note too: a changed snapshot tuple must fail closed, not export
  // its pre-withdrawal response. Owner/workspace locks are acquired first.
  privatePractice: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    goal_at_save AS "goalAtSave",response,saved_at AS "savedAt",
    CASE WHEN withdrawn_at IS NULL THEN 'saved' ELSE 'withdrawn' END AS state,
    withdrawn_at AS "withdrawnAt"
    FROM private_practice WHERE member_id=$1 ORDER BY content_id,content_version LIMIT $2 FOR SHARE`,
  circleMemberships: `SELECT circle_id AS "circleId",joined_at AS "joinedAt",
    left_at AS "leftAt" FROM preview_circle_memberships
    WHERE member_id=$1 ORDER BY circle_id LIMIT $2`,
} as const;

export type MemberExport =
  | { kind: "denied" }
  | { kind: "limit" }
  | { kind: "unavailable" }
  | { kind: "ready"; payload: Record<string, unknown> };
export interface MemberExportStore {
  exportOwned(token: string): Promise<MemberExport>;
}
export function disabledMemberExportStore(): MemberExportStore {
  return { exportOwned: async () => ({ kind: "denied" }) };
}

export function memberExportStore(pool: Pool): MemberExportStore {
  return {
    async exportOwned(token) {
      try {
        const client = await pool.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          // Match the runtime's five-second statement bound for lock acquisition,
          // including callers that supply a pool without runtime configuration.
          await client.query("SET LOCAL lock_timeout='5s'");
          // Keep revocation state and the deletion marker stable through COMMIT;
          // ordinary record changes remain a repeatable snapshot.
          const owner = await client.query<Record<string, unknown>>(
            `SELECT l.id,l.background,l.goal,l.background_tags AS "backgroundTags",
              l.domain_tags AS "domainTags",l.it_roles AS "itRoles",l.experience,
              l.exploratory,l.time_zone AS "timeZone",l.weekly_minutes AS "weeklyMinutes"
              FROM principals p JOIN learners l ON l.id=p.id
              JOIN workspaces w ON w.owner_principal_id=p.id
              WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
                AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
              FOR SHARE OF p,w`,
            [hash(token)],
          );
          if (!owner.rows[0]) return { kind: "denied" };
          const memberId = owner.rows[0].id;
          let count = 0;
          const records: Record<string, unknown> = {};
          for (const [name, sql] of Object.entries(sections)) {
            const rows = (
              await client.query(sql, [
                memberId,
                MAX_MEMBER_EXPORT_RECORDS - count + 1,
              ])
            ).rows;
            count += rows.length;
            if (count > MAX_MEMBER_EXPORT_RECORDS) return { kind: "limit" };
            records[name] = rows;
          }
          const payload = {
            kind: "ready",
            version: "local-member-records-v9",
            profile: owner.rows[0],
            records,
          };
          if (
            Buffer.byteLength(JSON.stringify(payload)) > MAX_MEMBER_EXPORT_BYTES
          )
            return { kind: "limit" };
          // CURRENT_TIMESTAMP is frozen at BEGIN; assembly may outlive a session.
          const current = await client.query(
            "SELECT id FROM principals WHERE id=$1 AND expires_at>clock_timestamp()",
            [memberId],
          );
          if (!current.rows[0]) return { kind: "denied" };
          await client.query("COMMIT");
          return { kind: "ready", payload };
        } finally {
          let rollbackError: Error | undefined;
          try {
            await client.query("ROLLBACK");
          } catch {
            // A failed rollback may leave authorization locks on a live client.
            rollbackError = new Error("Member export rollback failed");
          }
          client.release(rollbackError);
        }
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
