import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { LESSON, type LearnerProfile } from "./content.ts";
export interface Learner extends Pick<LearnerProfile, "background" | "goal"> {
  id: string;
  backgroundTags?: LearnerProfile["backgroundTags"];
  domainTags?: LearnerProfile["domainTags"];
  itRoles?: LearnerProfile["itRoles"];
  experience?: LearnerProfile["experience"];
  exploratory?: boolean;
}
export interface Exercise {
  instruction: string;
  verification: string;
  completed_at: Date | null;
  goal_at_start?: LearnerProfile["goal"] | null;
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
                  l.experience,l.exploratory,
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
                                background_tags,domain_tags,it_roles,experience,exploratory)
           SELECT id,token_hash,$3,$4,expires_at,$5,$6,$7,$8,$9 FROM identity
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
        ],
      );
    },
    async updateProfile(id, profile) {
      await pool.query(
        `UPDATE learners SET background=$2,goal=$3,background_tags=$4,
          domain_tags=$5,it_roles=$6,experience=$7,exploratory=$8 WHERE id=$1`,
        [
          id,
          profile.background,
          profile.goal,
          profile.backgroundTags,
          profile.domainTags,
          profile.itRoles,
          profile.experience,
          profile.exploratory,
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
