import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
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
  instruction: string;
  verification: string;
  completed_at: Date | null;
  goal_at_start?: LearnerProfile["goal"] | null;
}
export interface AssignmentChoice {
  contentId: string;
  contentVersion: number;
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
  progress(id: string): Promise<Exercise | undefined>;
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
  ): Promise<void>;
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
    ].map((name) =>
      readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    ),
  );
  await pool.query(scripts.join("\n"));
}
export function store(pool: Pool): Store {
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
    async progress(id) {
      return (
        await pool.query<Exercise>(
          "SELECT instruction,verification,completed_at,goal_at_start FROM exercises WHERE learner_id=$1 AND workspace_id=$1 AND lesson_id=$2 AND lesson_version=$3",
          [id, LESSON.id, LESSON.version],
        )
      ).rows[0];
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
           AND NOT EXISTS(
             SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
               AND newer.state='published' AND newer.version>cv.version
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
      await pool.query(
        `INSERT INTO exercises(learner_id,workspace_id,lesson_id,lesson_version,instruction,verification,completed_at,goal_at_start)
         VALUES($1,$1,$2,$3,$4,$5,CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE NULL END,
                (SELECT goal FROM learners WHERE id=$1))
      ON CONFLICT(learner_id,lesson_id,lesson_version) DO UPDATE SET instruction=EXCLUDED.instruction,verification=EXCLUDED.verification,completed_at=EXCLUDED.completed_at,goal_at_start=COALESCE(exercises.goal_at_start,EXCLUDED.goal_at_start) WHERE exercises.completed_at IS NULL`,
        [
          id,
          LESSON.id,
          LESSON.version,
          input.instruction,
          input.verification,
          input.complete,
        ],
      );
    },
    async remove(id) {
      await pool.query("DELETE FROM principals WHERE id=$1 AND kind='member'", [
        id,
      ]);
    },
  };
}
