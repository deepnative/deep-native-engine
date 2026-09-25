import type { Pool } from "pg";
import { hash } from "./store.ts";

export const MAX_MEMBER_EXPORT_RECORDS = 100;
export const MAX_MEMBER_EXPORT_BYTES = 256 * 1024;

const sections = {
  exercises: `SELECT lesson_id AS "lessonId",lesson_version AS "lessonVersion",
    instruction,verification,completed_at AS "completedAt",goal_at_start AS "goalAtStart"
    FROM exercises WHERE learner_id=$1 ORDER BY lesson_id,lesson_version LIMIT $2`,
  lessonActivity: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    opened_at AS "openedAt",started_at AS "startedAt",self_assessed_at AS "selfAssessedAt"
    FROM lesson_activity WHERE member_id=$1 ORDER BY content_id,content_version LIMIT $2`,
  assignmentChoices: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    chosen_at AS "chosenAt" FROM learner_assignment_choices WHERE member_id=$1 LIMIT $2`,
  assignmentAttempts: `SELECT id,content_id AS "contentId",content_version AS "contentVersion",
    goal_at_start AS "goalAtStart",response,revision,started_at AS "startedAt",
    saved_at AS "savedAt",submitted_at AS "submittedAt"
    FROM assignment_attempts WHERE member_id=$1 ORDER BY started_at,id LIMIT $2`,
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
  proposals: `SELECT id,title,body,sources,state,created_at AS "createdAt",
    submitted_at AS "submittedAt",withdrawn_at AS "withdrawnAt"
    FROM member_proposals WHERE member_id=$1 ORDER BY created_at,id LIMIT $2`,
  privatePractice: `SELECT content_id AS "contentId",content_version AS "contentVersion",
    goal_at_save AS "goalAtSave",response,saved_at AS "savedAt"
    FROM private_practice WHERE member_id=$1 ORDER BY content_id,content_version LIMIT $2`,
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
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const owner = await client.query<Record<string, unknown>>(
            `SELECT l.id,l.background,l.goal,l.background_tags AS "backgroundTags",
              l.domain_tags AS "domainTags",l.it_roles AS "itRoles",l.experience,
              l.exploratory,l.time_zone AS "timeZone",l.weekly_minutes AS "weeklyMinutes"
              FROM principals p JOIN learners l ON l.id=p.id
              WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
                AND p.expires_at>CURRENT_TIMESTAMP`,
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
            version: "local-member-records-v1",
            profile: owner.rows[0],
            records,
          };
          if (
            Buffer.byteLength(JSON.stringify(payload)) > MAX_MEMBER_EXPORT_BYTES
          )
            return { kind: "limit" };
          await client.query("COMMIT");
          return { kind: "ready", payload };
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
