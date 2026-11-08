import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export interface LocalAiControlStore {
  current(): Promise<"paused" | "enabled" | "unavailable">;
  read(token: string): Promise<{ paused: boolean } | null>;
  set(token: string, paused: boolean): Promise<boolean>;
  spending?(token: string): Promise<LocalAiSpending | null>;
  setCeiling?(
    token: string,
    change: CeilingChangeRequest,
  ): Promise<{ kind: CeilingChangeOutcome }>;
  ceilingHistory?(token: string): Promise<CeilingChange[] | null>;
}
// An administrator's change to the TEST ceiling (#188): the value they saw,
// the new value, and a key so a resubmitted form changes it once.
export interface CeilingChangeRequest {
  expectedPoints: number;
  ceilingPoints: number;
  key: string;
}
export type CeilingChangeOutcome =
  "changed" | "replayed" | "stale" | "conflict" | "invalid" | "denied";
// Content-free history: no member or administrator detail.
export interface CeilingChange {
  changedAt: Date;
  rateVersion: string;
  previousPoints: number;
  ceilingPoints: number;
  committedPoints: number;
}
// Content-free platform totals in invented simulated points (#188).
export interface LocalAiSpending {
  rateVersion: string;
  ceilingPoints: number;
  committedPoints: number;
  remainingPoints: number;
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

export const MAX_TEST_CEILING_POINTS = 1_000_000_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const points = (value: unknown) =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_TEST_CEILING_POINTS;
export function validCeilingChange(change: CeilingChangeRequest): boolean {
  return (
    points(change.expectedPoints) &&
    points(change.ceilingPoints) &&
    change.expectedPoints !== change.ceilingPoints &&
    typeof change.key === "string" &&
    UUID.test(change.key)
  );
}

export function localAiControlStore(pool: Pool): Required<LocalAiControlStore> {
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
    return Boolean(await adminId(client, token));
  }
  async function adminId(
    client: PoolClient,
    token: string,
  ): Promise<string | null> {
    const args = [hash(token)];
    const predicate =
      "FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id WHERE p.token_hash=$1 AND p.kind='staff' AND s.role='platform_admin' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()";
    const locked = await client.query(
      `SELECT p.id ${predicate} FOR SHARE OF p,s`,
      args,
    );
    // Time may advance while waiting for either principal or profile lock.
    const id = (locked.rows[0] as { id: string } | undefined)?.id;
    return id && (await client.query(`SELECT p.id ${predicate}`, args)).rows[0]
      ? id
      : null;
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
    spending(token) {
      return transaction<LocalAiSpending | null>(null, async (client) => {
        if (!(await admin(client, token))) return null;
        const row = (
          await client.query<{
            rate_version: string;
            ceiling_points: string;
            committed_points: string;
          }>(
            "SELECT rate_version,ceiling_points,committed_points FROM ai_test_spending_ceiling WHERE singleton",
          )
        ).rows[0];
        if (!row) return null;
        const ceilingPoints = Number(row.ceiling_points);
        const committedPoints = Number(row.committed_points);
        return {
          rateVersion: row.rate_version,
          ceilingPoints,
          committedPoints,
          remainingPoints: Math.max(0, ceilingPoints - committedPoints),
        };
      });
    },
    setCeiling(token, change) {
      if (!validCeilingChange(change))
        return Promise.resolve({ kind: "invalid" as const });
      return transaction<{ kind: CeilingChangeOutcome }>(
        { kind: "denied" },
        async (client) => {
          // Dispatch claims lock this row last; a change takes it first and
          // then only the administrator's own rows, so neither can deadlock.
          const row = (
            await client.query<{
              rate_version: string;
              ceiling_points: string;
              committed_points: string;
            }>(
              "SELECT rate_version,ceiling_points,committed_points FROM ai_test_spending_ceiling WHERE singleton FOR UPDATE",
            )
          ).rows[0];
          const id = row ? await adminId(client, token) : null;
          if (!row || !id) return { kind: "denied" };
          const earlier = (
            await client.query<{
              previous_points: string;
              ceiling_points: string;
            }>(
              "SELECT previous_points,ceiling_points FROM ai_test_spending_ceiling_changes WHERE administrator_id=$1 AND idempotency_key=$2",
              [id, change.key],
            )
          ).rows[0];
          if (earlier)
            return {
              kind:
                Number(earlier.previous_points) === change.expectedPoints &&
                Number(earlier.ceiling_points) === change.ceilingPoints
                  ? "replayed"
                  : "conflict",
            };
          if (Number(row.ceiling_points) !== change.expectedPoints)
            return { kind: "stale" };
          await client.query(
            "INSERT INTO ai_test_spending_ceiling_changes(administrator_id,idempotency_key,rate_version,previous_points,ceiling_points,committed_points) VALUES($1,$2,$3,$4,$5,$6)",
            [
              id,
              change.key,
              row.rate_version,
              change.expectedPoints,
              change.ceilingPoints,
              row.committed_points,
            ],
          );
          return { kind: "changed" };
        },
      );
    },
    ceilingHistory(token) {
      return transaction<CeilingChange[] | null>(null, async (client) => {
        if (!(await admin(client, token))) return null;
        return (
          await client.query<{
            changed_at: Date;
            rate_version: string;
            previous_points: string;
            ceiling_points: string;
            committed_points: string;
          }>(
            "SELECT changed_at,rate_version,previous_points,ceiling_points,committed_points FROM ai_test_spending_ceiling_changes ORDER BY changed_at DESC, id LIMIT 10",
          )
        ).rows.map((r) => ({
          changedAt: r.changed_at,
          rateVersion: r.rate_version,
          previousPoints: Number(r.previous_points),
          ceilingPoints: Number(r.ceiling_points),
          committedPoints: Number(r.committed_points),
        }));
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
