import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { LESSON, type LearnerProfile } from "./content.ts";
import type { MilestoneInput } from "./milestones.ts";
export interface Learner extends Pick<LearnerProfile, "background" | "goal"> {
  id: string;
  backgroundTags?: LearnerProfile["backgroundTags"];
  domainTags?: LearnerProfile["domainTags"];
  itRoles?: LearnerProfile["itRoles"];
  experience?: LearnerProfile["experience"];
  exploratory?: boolean;
  timezone?: LearnerProfile["timezone"];
  weeklyMinutes?: LearnerProfile["weeklyMinutes"];
}
export interface Exercise {
  instruction: string | null;
  verification: string | null;
  withdrawn_at?: Date | null;
  completed_at: Date | null;
  goal_at_start?: LearnerProfile["goal"] | null;
}
export interface ExerciseHistory {
  lessonId: string;
  version: number;
  instruction: string | null;
  verification: string | null;
  completedAt: Date | null;
  withdrawnAt: Date | null;
  goalAtStart: LearnerProfile["goal"] | null;
}
export type ExerciseWithdrawal =
  "withdrawn" | "already-withdrawn" | "unavailable";
export type ExerciseSave = "saved" | "unchanged" | "withdrawn";
export interface AssignmentChoice {
  contentId: string;
  contentVersion: number;
}
export interface LessonActivity {
  contentId: string;
  contentVersion: number;
  title?: string;
  openedAt: Date;
  startedAt: Date | null;
  selfAssessedAt: Date | null;
  available: boolean;
  reportable?: boolean;
}
export interface Milestone extends MilestoneInput {
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export type Session =
  { kind: "new" } | { kind: "expired" } | { kind: "active"; learner: Learner };
export interface Store {
  session(token: string): Promise<Session>;
  create(
    token: string,
    profile: Pick<LearnerProfile, "background" | "goal"> &
      Partial<LearnerProfile>,
  ): Promise<void>;
  updateProfile(id: string, profile: LearnerProfile): Promise<void>;
  progress(
    id: string,
    lessonId?: string,
    version?: number,
  ): Promise<Exercise | undefined>;
  withExerciseRead<T>(
    token: string,
    render: (rows: ExerciseHistory[]) => T,
  ): Promise<T | null>;
  withdrawExercise(
    token: string,
    lessonId: string,
    version: number,
  ): Promise<ExerciseWithdrawal>;
  lessonActivities(id: string): Promise<LessonActivity[]>;
  openLesson(id: string, contentId: string, version: number): Promise<boolean>;
  advanceLesson(
    id: string,
    contentId: string,
    version: number,
    action: "start" | "complete",
  ): Promise<boolean>;
  assignmentChoice(id: string): Promise<AssignmentChoice | null>;
  chooseAssignment(
    id: string,
    contentId: string,
    version: number,
  ): Promise<boolean>;
  milestones(id: string): Promise<Milestone[]>;
  createMilestone(id: string, input: MilestoneInput): Promise<string | null>;
  updateMilestone(
    id: string,
    milestoneId: string,
    version: number,
    input: MilestoneInput,
  ): Promise<boolean>;
  deleteMilestone(
    id: string,
    milestoneId: string,
    version: number,
  ): Promise<boolean>;
  save(
    id: string,
    input: { instruction: string; verification: string; complete: boolean },
  ): Promise<ExerciseSave>;
  remove(id: string): Promise<void>;
}
export function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export async function migrate(pool: Pool) {
  const scripts = await Promise.all(
    [
      "001-learning.sql",
      "002-adapter-jobs.sql",
      "003-workspace-authorization.sql",
      "004-private-evidence.sql",
      "005-learner-profile.sql",
      "006-content-lifecycle.sql",
      "007-expert-readiness.sql",
      "008-member-proposals.sql",
      "009-learning-plan.sql",
      "010-assignment-choice.sql",
      "011-learning-milestones.sql",
      "012-private-career-planning.sql",
      "013-lesson-activity.sql",
      "014-preview-circles.sql",
      "015-assignment-attempts.sql",
      "016-synthetic-entitlement-ledger.sql",
      "017-synthetic-entitlement-expiry.sql",
      "018-synthetic-entitlement-adjustment.sql",
      "019-ai-job-ambiguity.sql",
      "020-ai-job-provenance.sql",
      "021-private-practice.sql",
      "022-exact-evidence-review-grants.sql",
      "023-private-review-revocation.sql",
      "024-evidence-revisions.sql",
      "025-retained-evidence-lineage.sql",
      "026-structured-prerequisites.sql",
      "027-expert-availability.sql",
      "028-synthetic-slot-holds.sql",
      "029-private-assignment-submissions.sql",
      "030-member-owned-adapter-jobs.sql",
      "031-lesson-usefulness.sql",
      "032-private-workflow-feedback.sql",
      "033-synthetic-manual-observations.sql",
      "034-workflow-improvement-proposals.sql",
      "035-staff-authorization-audit.sql",
      "036-staff-evidence-access-audit.sql",
      "037-sample-slot-conflicts.sql",
      "038-proposal-moderation-audit.sql",
      "039-local-ai-consent.sql",
      "040-local-ai-control.sql",
      "041-proposal-draft-revision.sql",
      "042-private-practice-withdrawal.sql",
      "043-exercise-withdrawal.sql",
      "044-synthetic-settlement.sql",
    ].map((name) =>
      readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    ),
  );
  await pool.query(scripts.join("\n"));
}
export function store(pool: Pool): Store {
  async function exerciseTransaction<T>(
    token: string,
    write: boolean,
    use: (client: PoolClient, memberId: string) => Promise<T>,
  ): Promise<T | null> {
    if (typeof token !== "string" || !token.trim()) return null;
    const client = await pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      const principal = (
        await client.query<{ id: string; expires_at: Date }>(
          `SELECT id,expires_at FROM principals WHERE token_hash=$1 AND kind='member'
         AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
          [hash(token)],
        )
      ).rows[0];
      if (!principal) {
        await client.query("ROLLBACK");
        return null;
      }
      // Match account deletion and private-practice locking. A fresh statement
      // after this lock observes any withdrawal that committed while we waited.
      const workspace = await client.query(
        `SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$1
         AND deleting_at IS NULL FOR ${write ? "UPDATE" : "SHARE"}`,
        [principal.id],
      );
      if (!workspace.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const result = await use(client, principal.id);
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expires_at],
      );
      if (!current.rows[0]!.valid) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        releaseError = new Error("Exercise transaction rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
  return {
    async session(token) {
      const row = (
        await pool.query<Learner & { active: boolean }>(
          `SELECT l.id,l.background,l.goal,l.background_tags AS "backgroundTags",
                  l.domain_tags AS "domainTags",l.it_roles AS "itRoles",
                  l.experience,l.exploratory,l.time_zone AS timezone,
                  l.weekly_minutes AS "weeklyMinutes",
                  p.expires_at>CURRENT_TIMESTAMP AND p.revoked_at IS NULL AS active
           FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.kind='member' AND p.token_hash=$1`,
          [hash(token)],
        )
      ).rows[0];
      if (!row) return { kind: "new" };
      if (!row.active) return { kind: "expired" };
      return {
        kind: "active",
        learner: {
          id: row.id,
          background: row.background,
          goal: row.goal,
          ...(row.backgroundTags === undefined
            ? {}
            : { backgroundTags: row.backgroundTags }),
          ...(row.domainTags === undefined
            ? {}
            : { domainTags: row.domainTags }),
          ...(row.itRoles === undefined ? {} : { itRoles: row.itRoles }),
          ...(row.experience === undefined
            ? {}
            : { experience: row.experience }),
          ...(row.exploratory === undefined
            ? {}
            : { exploratory: row.exploratory }),
          ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
          ...(row.weeklyMinutes === undefined
            ? {}
            : { weeklyMinutes: row.weeklyMinutes }),
        },
      };
    },
    async create(token, profile) {
      await pool.query(
        `WITH identity AS (
           INSERT INTO principals(id,token_hash,kind,expires_at)
           VALUES($1,$2,'member',CURRENT_TIMESTAMP+INTERVAL '30 days')
           ON CONFLICT(token_hash) DO NOTHING RETURNING id,token_hash,expires_at
         ), member AS (
           INSERT INTO learners(id,token_hash,background,goal,expires_at,
                                background_tags,domain_tags,it_roles,experience,exploratory,
                                time_zone,weekly_minutes)
           SELECT id,token_hash,$3,$4,expires_at,$5,$6,$7,$8,$9,$10,$11 FROM identity
           RETURNING id
         )
         INSERT INTO workspaces(id,owner_principal_id)
         SELECT id,id FROM member`,
        [
          randomUUID(),
          hash(token),
          profile.background,
          profile.goal,
          profile.backgroundTags ?? [],
          profile.domainTags ?? [],
          profile.itRoles ?? [],
          profile.experience ?? null,
          profile.exploratory ?? false,
          profile.timezone ?? null,
          profile.weeklyMinutes ?? null,
        ],
      );
    },
    async updateProfile(id, profile) {
      await pool.query(
        `UPDATE learners SET background=$2,goal=$3,background_tags=$4,
          domain_tags=$5,it_roles=$6,experience=$7,exploratory=$8,
          time_zone=$9,weekly_minutes=$10 WHERE id=$1`,
        [
          id,
          profile.background,
          profile.goal,
          profile.backgroundTags,
          profile.domainTags,
          profile.itRoles,
          profile.experience,
          profile.exploratory,
          profile.timezone ?? null,
          profile.weeklyMinutes ?? null,
        ],
      );
    },
    async progress(id, lessonId = LESSON.id, version = LESSON.version) {
      return (
        await pool.query<Exercise>(
          "SELECT instruction,verification,completed_at,goal_at_start,withdrawn_at FROM exercises WHERE learner_id=$1 AND workspace_id=$1 AND lesson_id=$2 AND lesson_version=$3 FOR SHARE",
          [id, lessonId, version],
        )
      ).rows[0];
    },
    async withExerciseRead<T>(
      token: string,
      render: (rows: ExerciseHistory[]) => T,
    ) {
      return exerciseTransaction(token, false, async (client, memberId) => {
        const rows = (
          await client.query<ExerciseHistory>(
            `SELECT lesson_id AS "lessonId",lesson_version AS version,instruction,verification,
           completed_at AS "completedAt",withdrawn_at AS "withdrawnAt",goal_at_start AS "goalAtStart"
           FROM exercises WHERE learner_id=$1 AND workspace_id=$1
           ORDER BY lesson_id,lesson_version FOR SHARE`,
            [memberId],
          )
        ).rows;
        // Form the response while row and workspace locks still exclude withdrawal.
        return render(rows);
      });
    },
    async withdrawExercise(token, lessonId, version) {
      if (
        typeof lessonId !== "string" ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(lessonId) ||
        !Number.isInteger(version) ||
        version < 1 ||
        version > 2147483647
      )
        return "unavailable";
      return (
        (await exerciseTransaction<ExerciseWithdrawal>(
          token,
          true,
          async (client, memberId) => {
            const row = (
              await client.query<{
                completed_at: Date | null;
                withdrawn_at: Date | null;
              }>(
                `SELECT completed_at,withdrawn_at FROM exercises
           WHERE learner_id=$1 AND workspace_id=$1 AND lesson_id=$2 AND lesson_version=$3 FOR UPDATE`,
                [memberId, lessonId, version],
              )
            ).rows[0];
            if (!row?.completed_at) return "unavailable";
            if (row.withdrawn_at) return "already-withdrawn";
            await client.query(
              `UPDATE exercises SET instruction=NULL,verification=NULL,withdrawn_at=clock_timestamp()
           WHERE learner_id=$1 AND workspace_id=$1 AND lesson_id=$2 AND lesson_version=$3`,
              [memberId, lessonId, version],
            );
            return "withdrawn";
          },
        )) ?? "unavailable"
      );
    },
    async lessonActivities(id) {
      return (
        await pool.query<LessonActivity>(
          `SELECT a.content_id AS "contentId",a.content_version AS "contentVersion",
                  cv.title,
                  a.opened_at AS "openedAt",a.started_at AS "startedAt",
                  a.self_assessed_at AS "selfAssessedAt",
                  EXISTS(SELECT 1 FROM content_versions cv
                    WHERE cv.id=a.content_id AND cv.version=a.content_version
                      AND cv.kind='lesson' AND cv.state='published'
                      AND NOT EXISTS(SELECT 1 FROM content_versions newer
                        WHERE newer.id=cv.id AND newer.published_at IS NOT NULL
                          AND newer.version>cv.version)) AS available,
                  EXISTS(SELECT 1 FROM content_versions cv
                    WHERE cv.id=a.content_id AND cv.version=a.content_version
                      AND cv.kind='lesson' AND cv.origin='curated'
                      AND cv.state='published' AND NOT cv.requires_qualified_signoff
                      AND a.self_assessed_at IS NOT NULL
                      AND member_content_eligible(a.member_id,cv.id,cv.version)
                      AND NOT EXISTS(SELECT 1 FROM content_versions newer
                        WHERE newer.id=cv.id AND newer.published_at IS NOT NULL
                          AND newer.version>cv.version)) AS reportable
           FROM lesson_activity a
           LEFT JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
           WHERE a.member_id=$1
           ORDER BY a.opened_at DESC,a.content_id,a.content_version DESC`,
          [id],
        )
      ).rows;
    },
    async openLesson(id, contentId, version) {
      const result = await pool.query(
        `INSERT INTO lesson_activity(member_id,content_id,content_version)
         SELECT l.id,cv.id,cv.version FROM learners l
         JOIN content_versions cv ON cv.id=$2 AND cv.version=$3
         WHERE l.id=$1 AND cv.kind='lesson' AND cv.state='published'
           AND member_content_eligible(l.id,cv.id,cv.version)
           AND NOT EXISTS(SELECT 1 FROM content_versions newer
             WHERE newer.id=cv.id AND newer.published_at IS NOT NULL AND newer.version>cv.version)
         ON CONFLICT(member_id,content_id,content_version) DO UPDATE
           SET opened_at=lesson_activity.opened_at`,
        [id, contentId, version],
      );
      return result.rowCount === 1;
    },
    async advanceLesson(id, contentId, version, action) {
      const result = await pool.query(
        `UPDATE lesson_activity a SET
           started_at=CASE WHEN $4='start' THEN COALESCE(a.started_at,CURRENT_TIMESTAMP)
                           ELSE a.started_at END,
           self_assessed_at=CASE WHEN $4='complete' THEN COALESCE(a.self_assessed_at,CURRENT_TIMESTAMP)
                                 ELSE a.self_assessed_at END
         WHERE a.member_id=$1 AND a.content_id=$2 AND a.content_version=$3
           AND ($4='start' OR ($4='complete' AND a.started_at IS NOT NULL))
           AND EXISTS(SELECT 1 FROM content_versions cv
             WHERE cv.id=a.content_id AND cv.version=a.content_version
               AND cv.kind='lesson' AND cv.state='published'
               AND member_content_eligible(a.member_id,cv.id,cv.version)
               AND NOT EXISTS(SELECT 1 FROM content_versions newer
                 WHERE newer.id=cv.id AND newer.published_at IS NOT NULL AND newer.version>cv.version))`,
        [id, contentId, version, action],
      );
      return result.rowCount === 1;
    },
    async assignmentChoice(id) {
      return (
        (
          await pool.query<AssignmentChoice>(
            `SELECT content_id AS "contentId",content_version AS "contentVersion"
             FROM learner_assignment_choices WHERE member_id=$1`,
            [id],
          )
        ).rows[0] ?? null
      );
    },
    async chooseAssignment(id, contentId, version) {
      const result = await pool.query(
        `INSERT INTO learner_assignment_choices(member_id,content_id,content_version)
         SELECT l.id,cv.id,cv.version FROM learners l
         JOIN content_versions cv ON cv.id=$2 AND cv.version=$3
         WHERE l.id=$1 AND cv.kind='assignment' AND cv.state='published'
           AND member_content_eligible(l.id,cv.id,cv.version)
           AND NOT EXISTS(
             SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
               AND newer.published_at IS NOT NULL AND newer.version>cv.version
           )
         ON CONFLICT(member_id) DO UPDATE SET
           content_id=EXCLUDED.content_id,content_version=EXCLUDED.content_version,
           chosen_at=CURRENT_TIMESTAMP`,
        [id, contentId, version],
      );
      return result.rowCount === 1;
    },
    async milestones(id) {
      return (
        await pool.query<Milestone>(
          `SELECT id,goal_title AS "goalTitle",milestone_title AS "milestoneTitle",
                  evidence_note AS "evidenceNote",next_action AS "nextAction",
                  to_char(reminder_date,'YYYY-MM-DD') AS "reminderDate",
                  to_char(reminder_time,'HH24:MI') AS "reminderTime",
                  reminder_time_zone AS "reminderTimezone",
                  self_reported_complete AS "selfReportedComplete",
                  version,created_at AS "createdAt",updated_at AS "updatedAt"
           FROM learning_milestones WHERE member_id=$1 ORDER BY created_at DESC,id`,
          [id],
        )
      ).rows;
    },
    async createMilestone(id, input) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO learning_milestones(
           id,member_id,goal_title,milestone_title,evidence_note,next_action,
           reminder_date,reminder_time,reminder_time_zone,self_reported_complete)
         SELECT $2,l.id,$3,$4,$5,$6,$7,$8,$9,$10 FROM learners l WHERE l.id=$1
         RETURNING id`,
        [
          id,
          randomUUID(),
          input.goalTitle,
          input.milestoneTitle,
          input.evidenceNote,
          input.nextAction,
          input.reminderDate,
          input.reminderTime,
          input.reminderTimezone,
          input.selfReportedComplete,
        ],
      );
      return result.rows[0]?.id ?? null;
    },
    async updateMilestone(id, milestoneId, version, input) {
      const result = await pool.query(
        `UPDATE learning_milestones SET goal_title=$4,milestone_title=$5,
           evidence_note=$6,next_action=$7,reminder_date=$8,reminder_time=$9,
           reminder_time_zone=$10,self_reported_complete=$11,
           version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE member_id=$1 AND id=$2 AND version=$3`,
        [
          id,
          milestoneId,
          version,
          input.goalTitle,
          input.milestoneTitle,
          input.evidenceNote,
          input.nextAction,
          input.reminderDate,
          input.reminderTime,
          input.reminderTimezone,
          input.selfReportedComplete,
        ],
      );
      return result.rowCount === 1;
    },
    async deleteMilestone(id, milestoneId, version) {
      const result = await pool.query(
        `DELETE FROM learning_milestones WHERE member_id=$1 AND id=$2 AND version=$3`,
        [id, milestoneId, version],
      );
      return result.rowCount === 1;
    },
    async save(id, input) {
      const result = await pool.query(
        `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification,completed_at,goal_at_start)
         VALUES($1,$1,$2,$3,$4,$5,CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE NULL END,
                (SELECT goal FROM learners WHERE id=$1))
      ON CONFLICT(learner_id,lesson_id,lesson_version) DO UPDATE SET instruction=EXCLUDED.instruction,verification=EXCLUDED.verification,completed_at=EXCLUDED.completed_at,goal_at_start=COALESCE(exercises.goal_at_start,EXCLUDED.goal_at_start) WHERE exercises.completed_at IS NULL AND exercises.withdrawn_at IS NULL RETURNING learner_id`,
        [
          id,
          LESSON.id,
          LESSON.version,
          input.instruction,
          input.verification,
          input.complete,
        ],
      );
      if (result.rowCount === 1) return "saved";
      const existing = (
        await pool.query<{ withdrawn_at: Date | null }>(
          `SELECT withdrawn_at FROM exercises WHERE learner_id=$1 AND workspace_id=$1
         AND lesson_id=$2 AND lesson_version=$3`,
          [id, LESSON.id, LESSON.version],
        )
      ).rows[0];
      return existing?.withdrawn_at ? "withdrawn" : "unchanged";
    },
    async remove(id) {
      await pool.query("DELETE FROM principals WHERE id=$1 AND kind='member'", [
        id,
      ]);
    },
  };
}
