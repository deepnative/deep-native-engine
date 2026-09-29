import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export interface PracticeSource {
  id: string;
  version: number;
  title: string;
  body: string;
  goal: "everyday" | "work" | "build";
  response: string | null;
  withdrawnAt: Date | null;
}
export interface PracticeHistory {
  id: string;
  version: number;
  title: string;
  response: string | null;
  withdrawnAt: Date | null;
  savedAt: Date;
  available: boolean;
}
export type PracticeSave =
  "saved" | "replayed" | "conflict" | "withdrawn" | "unavailable";
export type PracticeWithdrawal =
  "withdrawn" | "already-withdrawn" | "unavailable";
export interface PracticeStore {
  current(token: string, id: string): Promise<PracticeSource | null>;
  history(token: string): Promise<PracticeHistory[]>;
  save(
    token: string,
    id: string,
    version: number,
    response: string,
  ): Promise<PracticeSave>;
  withdraw(
    token: string,
    id: string,
    version: number,
  ): Promise<PracticeWithdrawal>;
}
export function disabledPracticeStore(): PracticeStore {
  return {
    current: async () => null,
    history: async () => [],
    save: async () => "unavailable",
    withdraw: async () => "unavailable",
  };
}
const member = `p.kind='member' AND p.token_hash=$1 AND p.revoked_at IS NULL
  AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL`;
const eligible = `cv.kind='lesson' AND
  member_content_eligible(l.id,cv.id,cv.version)`;
const from = `FROM principals p JOIN learners l ON l.id=p.id
  JOIN workspaces w ON w.owner_principal_id=p.id
  JOIN content_versions cv ON ${eligible}`;
export function practiceStore(pool: Pool): PracticeStore {
  async function mutate<T extends PracticeSave | PracticeWithdrawal>(
    token: string,
    id: string,
    version: number,
    use: (client: PoolClient, memberId: string) => Promise<T>,
  ): Promise<T | "unavailable"> {
    if (
      !/^[A-Z]{2,5}-[0-9]{3}$/.test(id) ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 2147483647
    )
      return "unavailable";
    const client = await pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
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
        return "unavailable";
      }
      // One member's practice mutations serialize even before a first-save row
      // exists. Match deletion's workspace lock; revocation waits on the principal.
      const workspace = await client.query(
        `SELECT id FROM workspaces WHERE owner_principal_id=$1
         AND deleting_at IS NULL FOR UPDATE`,
        [principal.id],
      );
      if (!workspace.rows[0]) {
        await client.query("ROLLBACK");
        return "unavailable";
      }
      const result = await use(client, principal.id);
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expires_at],
      );
      if (!current.rows[0]!.valid) {
        await client.query("ROLLBACK");
        return "unavailable";
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        releaseError = new Error("Practice mutation rollback failed");
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
  return {
    async current(token, id) {
      const result = await pool.query<PracticeSource>(
        `SELECT cv.id,cv.version,cv.title,cv.body,l.goal,pp.response,
           pp.withdrawn_at AS "withdrawnAt" ${from}
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
           pp.withdrawn_at AS "withdrawnAt",(${eligible}) AS available FROM private_practice pp
         JOIN learners l ON l.id=pp.member_id JOIN principals p ON p.id=l.id
         JOIN workspaces w ON w.owner_principal_id=p.id
         JOIN content_versions cv ON cv.id=pp.content_id AND cv.version=pp.content_version
         WHERE ${member} ORDER BY pp.saved_at DESC,cv.id,cv.version DESC`,
          [hash(token)],
        )
      ).rows;
    },
    async save(token, id, version, response) {
      return mutate<PracticeSave>(
        token,
        id,
        version,
        async (client, memberId) => {
          const source = await client.query<{ goal: string }>(
            `SELECT l.goal FROM learners l JOIN content_versions cv ON ${eligible}
           WHERE l.id=$1 AND cv.id=$2 AND cv.version=$3 FOR SHARE OF l,cv`,
            [memberId, id, version],
          );
          if (!source.rows[0]) return "unavailable";
          const inserted = await client.query(
            `INSERT INTO private_practice(member_id,content_id,content_version,goal_at_save,response)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING member_id`,
            [memberId, id, version, source.rows[0].goal, response],
          );
          if (inserted.rowCount === 1) return "saved";
          const existing = (
            await client.query<{
              response: string | null;
              withdrawnAt: Date | null;
            }>(
              `SELECT response,withdrawn_at AS "withdrawnAt" FROM private_practice WHERE member_id=$1
           AND content_id=$2 AND content_version=$3`,
              [memberId, id, version],
            )
          ).rows[0];
          if (existing?.withdrawnAt) return "withdrawn";
          return existing?.response === response ? "replayed" : "conflict";
        },
      );
    },
    async withdraw(token, id, version) {
      return mutate<PracticeWithdrawal>(
        token,
        id,
        version,
        async (client, memberId) => {
          // Retained ownership, not current source eligibility, authorizes redaction.
          const row = (
            await client.query<{ withdrawnAt: Date | null }>(
              `SELECT withdrawn_at AS "withdrawnAt" FROM private_practice
           WHERE member_id=$1 AND content_id=$2 AND content_version=$3 FOR UPDATE`,
              [memberId, id, version],
            )
          ).rows[0];
          if (!row) return "unavailable";
          if (row.withdrawnAt) return "already-withdrawn";
          await client.query(
            `UPDATE private_practice SET response=NULL,withdrawn_at=clock_timestamp()
           WHERE member_id=$1 AND content_id=$2 AND content_version=$3`,
            [memberId, id, version],
          );
          return "withdrawn";
        },
      );
    },
  };
}
