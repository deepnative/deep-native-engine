import type { Pool } from "pg";
import { hash } from "./store.ts";

export interface PracticeSource {
  id: string;
  version: number;
  title: string;
  body: string;
  goal: "everyday" | "work" | "build";
  response: string | null;
}
export interface PracticeHistory {
  id: string;
  version: number;
  title: string;
  response: string;
  savedAt: Date;
  available: boolean;
}
export type PracticeSave = "saved" | "replayed" | "conflict" | "unavailable";
export interface PracticeStore {
  current(token: string, id: string): Promise<PracticeSource | null>;
  history(token: string): Promise<PracticeHistory[]>;
  save(
    token: string,
    id: string,
    version: number,
    response: string,
  ): Promise<PracticeSave>;
}
export function disabledPracticeStore(): PracticeStore {
  return {
    current: async () => null,
    history: async () => [],
    save: async () => "unavailable",
  };
}
const member = `p.kind='member' AND p.token_hash=$1 AND p.revoked_at IS NULL
  AND p.expires_at>CURRENT_TIMESTAMP`;
const eligible = `cv.kind='lesson' AND
  member_content_eligible(l.id,cv.id,cv.version)`;
const from = `FROM principals p JOIN learners l ON l.id=p.id
  JOIN content_versions cv ON ${eligible}`;
export function practiceStore(pool: Pool): PracticeStore {
  return {
    async current(token, id) {
      const result = await pool.query<PracticeSource>(
        `SELECT cv.id,cv.version,cv.title,cv.body,l.goal,pp.response ${from}
         LEFT JOIN private_practice pp ON pp.member_id=l.id AND pp.content_id=cv.id
           AND pp.content_version=cv.version
         WHERE ${member} AND cv.id=$2`,
        [hash(token), id],
      );
      return result.rows[0] ?? null;
    },
    async history(token) {
      return (
        await pool.query<PracticeHistory>(
          `SELECT cv.id,cv.version,cv.title,pp.response,pp.saved_at AS "savedAt",
           (${eligible}) AS available FROM private_practice pp
         JOIN learners l ON l.id=pp.member_id JOIN principals p ON p.id=l.id
         JOIN content_versions cv ON cv.id=pp.content_id AND cv.version=pp.content_version
         WHERE ${member} ORDER BY pp.saved_at DESC,cv.id,cv.version DESC`,
          [hash(token)],
        )
      ).rows;
    },
    async save(token, id, version, response) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Lock source and member while claiming the one immutable note for this version.
        const source = await client.query<{ memberId: string; goal: string }>(
          `SELECT l.id AS "memberId",l.goal ${from}
           WHERE ${member} AND cv.id=$2 AND cv.version=$3
           FOR SHARE OF l,cv`,
          [hash(token), id, version],
        );
        if (!source.rows[0]) {
          await client.query("ROLLBACK");
          return "unavailable";
        }
        const { memberId, goal } = source.rows[0];
        const inserted = await client.query(
          `INSERT INTO private_practice(member_id,content_id,content_version,goal_at_save,response)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING member_id`,
          [memberId, id, version, goal, response],
        );
        if (inserted.rowCount === 1) {
          await client.query("COMMIT");
          return "saved";
        }
        const existing = await client.query<{ response: string }>(
          `SELECT response FROM private_practice WHERE member_id=$1
           AND content_id=$2 AND content_version=$3`,
          [memberId, id, version],
        );
        await client.query("COMMIT");
        return existing.rows[0]?.response === response
          ? "replayed"
          : "conflict";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
