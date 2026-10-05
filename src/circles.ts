import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import {
  practiceTransaction as circleTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";

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
  async function withMember<T>(
    token: string,
    denied: T,
    use: (client: PracticeTransaction, memberId: string) => Promise<T>,
    options: { joinCircle?: string; read?: boolean } = {},
  ): Promise<T> {
    let readyToCommit = false;
    try {
      return await circleTransaction(pool, async (client) => {
        // Joining serializes seats before authority. Leaving deliberately does
        // not take this lock: a leave may complete while a rejoin waits here.
        if (options.joinCircle)
          await client.query(
            "SELECT pg_advisory_xact_lock(7529,hashtext($1::text))",
            [options.joinCircle],
          );
        const member = (
          await client.query<{ id: string; expires_at: Date }>(
            `SELECT p.id,p.expires_at FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR ${options.joinCircle ? "UPDATE" : "SHARE"} OF p`,
            [hash(token)],
          )
        ).rows[0];
        if (!member) throw new PracticeLifetimeFailure("denied");
        await client.observe([member.expires_at]);
        const workspace = await client.query(
          `SELECT id FROM workspaces
           WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [member.id],
        );
        if (!workspace.rows[0]) throw new PracticeLifetimeFailure("denied");
        const result = await use(client, member.id);
        await client.observe([member.expires_at]);
        readyToCommit = true;
        return result;
      });
    } catch (error) {
      if (
        options.read ||
        (!readyToCommit &&
          error instanceof PracticeLifetimeFailure &&
          error.kind === "denied")
      )
        return denied;
      throw new Error("Circle operation unconfirmed", { cause: error });
    }
  }
  return {
    list(token) {
      return withMember<CircleListing[] | null>(
        token,
        null,
        async (client, memberId) => {
          const result = await client.query<{
            circle_id: string;
            member_count: number;
            joined: boolean;
          }>(
            `SELECT circle_id,
             COUNT(*) FILTER (WHERE left_at IS NULL AND p.revoked_at IS NULL
               AND p.expires_at>statement_timestamp())::integer AS member_count,
             BOOL_OR(member_id=$1 AND left_at IS NULL) AS joined
           FROM preview_circle_memberships m
           JOIN principals p ON p.id=m.member_id GROUP BY circle_id`,
            [memberId],
          );
          return CIRCLES.map((circle) => {
            const row = result.rows.find(
              (value) => value.circle_id === circle.id,
            );
            return {
              ...circle,
              joined: row?.joined ?? false,
              seatsRemaining: circle.capacity - (row?.member_count ?? 0),
            };
          });
        },
        { read: true },
      );
    },
    async join(token, id) {
      const circle = CIRCLES.find((item) => item.id === id);
      if (!circle) return "denied";
      return withMember<JoinResult>(
        token,
        "denied",
        async (client, memberId) => {
          const existing = await client.query(
            `SELECT 1 FROM preview_circle_memberships
           WHERE circle_id=$1 AND member_id=$2 AND left_at IS NULL`,
            [id, memberId],
          );
          if (existing.rowCount) return "joined";
          const count = await client.query<{ n: number }>(
            `SELECT COUNT(*)::integer AS n FROM preview_circle_memberships m
             JOIN principals p ON p.id=m.member_id
             WHERE m.circle_id=$1 AND m.left_at IS NULL
               AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()`,
            [id],
          );
          if (count.rows[0]!.n >= circle.capacity) return "full";
          await client.query(
            `INSERT INTO preview_circle_memberships(circle_id,member_id)
               VALUES($1,$2)
               ON CONFLICT(circle_id,member_id) DO UPDATE
               SET joined_at=clock_timestamp(),left_at=NULL,
                   generation=preview_circle_memberships.generation+1`,
            [id, memberId],
          );
          return "joined";
        },
        { joinCircle: id },
      );
    },
    async leave(token, id) {
      if (!CIRCLES.some((item) => item.id === id)) return false;
      return withMember(token, false, async (client, memberId) => {
        const result = await client.query(
          `UPDATE preview_circle_memberships SET left_at=clock_timestamp()
           WHERE member_id=$1 AND circle_id=$2 AND left_at IS NULL`,
          [memberId, id],
        );
        return result.rowCount === 1;
      });
    },
  };
}
