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
      const client = await pool.connect();
      let commitStarted = false;
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        const member = await client.query<{ id: string; expiresAt: string }>(
          `SELECT p.id,p.expires_at::text AS "expiresAt"
           FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR SHARE OF p`,
          [hash(token)],
        );
        if (!member.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        // Serialize with deletion in principal -> workspace order and retain
        // both locks until the private membership listing has been read.
        const workspace = await client.query<{ id: string }>(
          `SELECT id FROM workspaces
           WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [member.rows[0].id],
        );
        if (!workspace.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
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
          [member.rows[0].id],
        );
        // Authorization can expire during any lock/read wait, even if no
        // principal tuple was changed. Use database wall time before release.
        const current = await client.query<{ valid: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS valid",
          [member.rows[0].expiresAt],
        );
        if (!current.rows[0]!.valid) {
          await client.query("ROLLBACK");
          return null;
        }
        commitStarted = true;
        await client.query("COMMIT");
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
      } catch (error) {
        // An uncertain COMMIT must not release private results or be replayed.
        if (commitStarted) releaseError = error as Error;
        try {
          await client.query("ROLLBACK");
        } catch {
          releaseError = error as Error;
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
    async join(token, id) {
      const circle = CIRCLES.find((item) => item.id === id);
      if (!circle) return "denied";
      const client = await pool.connect();
      let commitStarted = false;
      let releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(7529,hashtext($1::text))",
          [id],
        );
        const member = await client.query<{ id: string; expiresAt: string }>(
          `SELECT p.id,p.expires_at::text AS "expiresAt"
           FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR UPDATE OF p`,
          [hash(token)],
        );
        if (!member.rows[0]) {
          await client.query("ROLLBACK");
          return "denied";
        }
        const memberId = member.rows[0].id;
        // Keep deletion/revocation order after the circle lock. The workspace
        // lock also prevents deletion from starting before this join commits.
        const workspace = await client.query<{ id: string }>(
          `SELECT id FROM workspaces
           WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [memberId],
        );
        if (!workspace.rows[0]) {
          await client.query("ROLLBACK");
          return "denied";
        }
        const existing = await client.query(
          `SELECT 1 FROM preview_circle_memberships
           WHERE circle_id=$1 AND member_id=$2 AND left_at IS NULL`,
          [id, memberId],
        );
        let result: JoinResult = "joined";
        if (!existing.rowCount) {
          const count = await client.query<{ n: number }>(
            `SELECT COUNT(*)::integer AS n FROM preview_circle_memberships m
             JOIN principals p ON p.id=m.member_id
             WHERE m.circle_id=$1 AND m.left_at IS NULL
               AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()`,
            [id],
          );
          if (count.rows[0]!.n >= circle.capacity) {
            result = "full";
          } else {
            await client.query(
              `INSERT INTO preview_circle_memberships(circle_id,member_id)
               VALUES($1,$2)
               ON CONFLICT(circle_id,member_id) DO UPDATE
               SET joined_at=CURRENT_TIMESTAMP,left_at=NULL`,
              [id, memberId],
            );
          }
        }
        // A principal, workspace or membership wait can outlast authorization.
        // Keep authorization locks and check wall time again
        // before acknowledging a repeated join or committing a write.
        const current = await client.query<{ valid: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS valid",
          [member.rows[0].expiresAt],
        );
        if (!current.rows[0]!.valid) {
          await client.query("ROLLBACK");
          return "denied";
        }
        // A lost COMMIT acknowledgement is uncertain; discard and never replay.
        commitStarted = true;
        await client.query("COMMIT");
        return result;
      } catch (error) {
        if (commitStarted) releaseError = error as Error;
        try {
          await client.query("ROLLBACK");
        } catch {
          releaseError = error as Error;
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
    async leave(token, id) {
      if (!CIRCLES.some((item) => item.id === id)) return false;
      const client = await pool.connect();
      let released = false;
      try {
        await client.query("BEGIN");
        const member = await client.query<{ id: string; expiresAt: string }>(
          `SELECT p.id,p.expires_at::text AS "expiresAt"
           FROM principals p JOIN learners l ON l.id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR SHARE OF p`,
          [hash(token)],
        );
        if (!member.rows[0]) {
          await client.query("ROLLBACK");
          return false;
        }
        const memberId = member.rows[0].id;
        const workspace = await client.query<{ id: string }>(
          `SELECT id FROM workspaces
           WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE`,
          [memberId],
        );
        if (!workspace.rows[0]) {
          await client.query("ROLLBACK");
          return false;
        }
        const result = await client.query(
          `UPDATE preview_circle_memberships SET left_at=clock_timestamp()
           WHERE member_id=$1 AND circle_id=$2 AND left_at IS NULL`,
          [memberId, id],
        );
        // The membership-row wait can outlast a valid session. Keep the
        // principal/workspace locks until the wall-clock check and commit.
        const current = await client.query<{ valid: boolean }>(
          "SELECT clock_timestamp() < $1::timestamptz AS valid",
          [member.rows[0].expiresAt],
        );
        if (!current.rows[0]!.valid) {
          await client.query("ROLLBACK");
          return false;
        }
        await client.query("COMMIT");
        return result.rowCount === 1;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          client.release(error as Error);
          released = true;
        }
        throw error;
      } finally {
        if (!released) client.release();
      }
    },
  };
}
