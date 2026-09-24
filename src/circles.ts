import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export interface CircleDefinition {
  id: string;
  title: string;
  goal: "everyday" | "work" | "build";
  description: string;
  capacity: number;
}
export interface CircleListing extends CircleDefinition {
  joined: boolean;
  seatsRemaining: number;
}
export type JoinResult = "joined" | "full" | "denied";
export interface CircleStore {
  list(token: string): Promise<CircleListing[] | null>;
  join(token: string, id: string): Promise<JoinResult>;
  leave(token: string, id: string): Promise<boolean>;
}

export const CIRCLES = JSON.parse(
  readFileSync(
    new URL(
      "../assets/docs/content/circles/preview-circles.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as CircleDefinition[];

export function disabledCircleStore(): CircleStore {
  return {
    list: async () => null,
    join: async () => "denied",
    leave: async () => false,
  };
}

export function circleStore(pool: Pool): CircleStore {
  return {
    async list(token) {
      const member = await pool.query<{ id: string }>(
        `SELECT p.id FROM principals p JOIN learners l ON l.id=p.id
         WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>CURRENT_TIMESTAMP`,
        [hash(token)],
      );
      if (!member.rows[0]) return null;
      const result = await pool.query<{
        circle_id: string;
        member_count: number;
        joined: boolean;
      }>(
        `SELECT circle_id,
           COUNT(*) FILTER (WHERE left_at IS NULL AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP)::integer AS member_count,
           BOOL_OR(member_id=$1 AND left_at IS NULL) AS joined
         FROM preview_circle_memberships m
         JOIN principals p ON p.id=m.member_id GROUP BY circle_id`,
        [member.rows[0].id],
      );
      return CIRCLES.map((circle) => {
        const row = result.rows.find((value) => value.circle_id === circle.id);
        return {
          ...circle,
          joined: row?.joined ?? false,
          seatsRemaining: circle.capacity - (row?.member_count ?? 0),
        };
      });
    },
    async join(token, id) {
      const circle = CIRCLES.find((item) => item.id === id);
      if (!circle) return "denied";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(7529,hashtext($1::text))",
          [id],
        );
        const member = await client.query<{ id: string }>(
          `SELECT p.id FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP FOR UPDATE OF p`,
          [hash(token)],
        );
        if (!member.rows[0]) {
          await client.query("COMMIT");
          return "denied";
        }
        const memberId = member.rows[0].id;
        const existing = await client.query(
          `SELECT 1 FROM preview_circle_memberships
           WHERE circle_id=$1 AND member_id=$2 AND left_at IS NULL`,
          [id, memberId],
        );
        if (existing.rowCount) {
          await client.query("COMMIT");
          return "joined";
        }
        const count = await client.query<{ n: number }>(
          `SELECT COUNT(*)::integer AS n FROM preview_circle_memberships m
           JOIN principals p ON p.id=m.member_id
           WHERE m.circle_id=$1 AND m.left_at IS NULL
             AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`,
          [id],
        );
        if (count.rows[0]!.n >= circle.capacity) {
          await client.query("COMMIT");
          return "full";
        }
        await client.query(
          `INSERT INTO preview_circle_memberships(circle_id,member_id)
           VALUES($1,$2)
           ON CONFLICT(circle_id,member_id) DO UPDATE
           SET joined_at=CURRENT_TIMESTAMP,left_at=NULL`,
          [id, memberId],
        );
        await client.query("COMMIT");
        return "joined";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async leave(token, id) {
      if (!CIRCLES.some((item) => item.id === id)) return false;
      const result = await pool.query(
        `UPDATE preview_circle_memberships m SET left_at=CURRENT_TIMESTAMP
         FROM principals p WHERE p.id=m.member_id AND p.token_hash=$1
           AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>CURRENT_TIMESTAMP AND m.circle_id=$2
           AND m.left_at IS NULL`,
        [hash(token), id],
      );
      return result.rowCount === 1;
    },
  };
}
