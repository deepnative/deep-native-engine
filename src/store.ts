import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { LESSON, type Background, type Goal } from "./content.ts";
export interface Learner {
  id: string;
  background: Background;
  goal: Goal;
}
export interface Exercise {
  instruction: string;
  verification: string;
  completed_at: Date | null;
}
export type Session =
  { kind: "new" } | { kind: "expired" } | { kind: "active"; learner: Learner };
export interface Store {
  session(token: string): Promise<Session>;
  create(
    token: string,
    profile: { background: Background; goal: Goal },
  ): Promise<void>;
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
  await pool.query(
    await readFile(
      new URL("../migrations/001-learning.sql", import.meta.url),
      "utf8",
    ),
  );
}
export function store(pool: Pool): Store {
  return {
    async session(token) {
      const row = (
        await pool.query<Learner & { active: boolean }>(
          "SELECT id,background,goal,expires_at>CURRENT_TIMESTAMP AS active FROM learners WHERE token_hash=$1",
          [hash(token)],
        )
      ).rows[0];
      if (!row) return { kind: "new" };
      if (!row.active) return { kind: "expired" };
      return {
        kind: "active",
        learner: { id: row.id, background: row.background, goal: row.goal },
      };
    },
    async create(token, profile) {
      await pool.query(
        "INSERT INTO learners(id,token_hash,background,goal) VALUES($1,$2,$3,$4) ON CONFLICT(token_hash) DO NOTHING",
        [randomUUID(), hash(token), profile.background, profile.goal],
      );
    },
    async progress(id) {
      return (
        await pool.query<Exercise>(
          "SELECT instruction,verification,completed_at FROM exercises WHERE learner_id=$1 AND lesson_id=$2 AND lesson_version=$3",
          [id, LESSON.id, LESSON.version],
        )
      ).rows[0];
    },
    async save(id, input) {
      await pool.query(
        `INSERT INTO exercises(learner_id,lesson_id,lesson_version,instruction,verification,completed_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT(learner_id,lesson_id,lesson_version) DO UPDATE SET instruction=EXCLUDED.instruction,verification=EXCLUDED.verification,completed_at=EXCLUDED.completed_at WHERE exercises.completed_at IS NULL`,
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
      await pool.query("DELETE FROM learners WHERE id=$1", [id]);
    },
  };
}
