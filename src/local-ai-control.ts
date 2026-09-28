import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export interface LocalAiControlStore {
  current(): Promise<"paused" | "enabled" | "unavailable">;
  read(token: string): Promise<{ paused: boolean } | null>;
  set(token: string, paused: boolean): Promise<boolean>;
}

// Queue and both dispatch transactions take this lock before principal,
// workspace, source, receipt and job locks. Dispatch holds it through its
// bounded deterministic invocation and commit; pause takes UPDATE instead.
export async function localAiEnabled(client: PoolClient): Promise<boolean> {
  const row = (
    await client.query<{ paused: unknown }>(
      "SELECT paused FROM local_ai_control WHERE singleton=true FOR SHARE",
    )
  ).rows[0];
  return row?.paused === false;
}

export function localAiControlStore(pool: Pool): LocalAiControlStore {
  async function transaction<T>(
    fallback: T,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let broken = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
      }
      return fallback;
    } finally {
      client?.release(broken);
    }
  }
  async function admin(client: PoolClient, token: string): Promise<boolean> {
    const args = [hash(token)];
    const predicate =
      "FROM principals p JOIN staff_profiles s ON s.principal_id=p.id WHERE p.token_hash=$1 AND p.kind='staff' AND s.role='platform_admin' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()";
    const locked = await client.query(
      `SELECT p.id ${predicate} FOR SHARE OF p,s`,
      args,
    );
    // Time may advance while waiting for either principal or profile lock.
    return Boolean(
      locked.rows[0] &&
      (await client.query(`SELECT p.id ${predicate}`, args)).rows[0],
    );
  }
  return {
    current() {
      return transaction<"paused" | "enabled" | "unavailable">(
        "unavailable",
        async (client) => {
          const row = (
            await client.query<{ paused: unknown }>(
              "SELECT paused FROM local_ai_control WHERE singleton=true",
            )
          ).rows[0];
          return typeof row?.paused === "boolean"
            ? row.paused
              ? "paused"
              : "enabled"
            : "unavailable";
        },
      );
    },
    read(token) {
      return transaction<{ paused: boolean } | null>(null, async (client) => {
        const row = (
          await client.query<{ paused: unknown }>(
            "SELECT paused FROM local_ai_control WHERE singleton=true FOR SHARE",
          )
        ).rows[0];
        if (typeof row?.paused !== "boolean" || !(await admin(client, token)))
          return null;
        return { paused: row.paused };
      });
    },
    set(token, paused) {
      if (typeof paused !== "boolean") return Promise.resolve(false);
      return transaction(false, async (client) => {
        const row = (
          await client.query<{ paused: unknown }>(
            "SELECT paused FROM local_ai_control WHERE singleton=true FOR UPDATE",
          )
        ).rows[0];
        if (typeof row?.paused !== "boolean" || !(await admin(client, token)))
          return false;
        await client.query(
          "UPDATE local_ai_control SET paused=$1 WHERE singleton=true",
          [paused],
        );
        return true;
      });
    },
  };
}
