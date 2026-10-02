import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export const testUnitCategories = [
  ["coach_minutes", "minutes"],
  ["review_minutes", "minutes"],
  ["support_minutes", "minutes"],
  ["mock_sessions", "sessions"],
  ["study_requests", "requests"],
] as const;
export interface MemberTestUnitCategory {
  category: (typeof testUnitCategories)[number][0];
  unit: (typeof testUnitCategories)[number][1];
  grants: number;
  granted: number;
  usable: number;
  future: number;
  awaitingExpiry: number;
  held: number;
  consumed: number;
  expired: number;
  adjusted: number;
  nextExpiry: Date | null;
  nextStart: Date | null;
}
export interface MemberTestUnitSnapshot {
  scope: "synthetic-local-preview";
  asOf: Date;
  categories: MemberTestUnitCategory[];
}
export type MemberTestUnitsResult =
  | { kind: "ready"; value: MemberTestUnitSnapshot }
  | { kind: "denied" | "unavailable" };
export interface MemberTestUnitsStore {
  snapshot(token: string): Promise<MemberTestUnitsResult>;
}
export function disabledMemberTestUnitsStore(): MemberTestUnitsStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}

// One statement snapshot of all the owner's grants. The materialized clock is
// for classification; it is not a claim of historically reconstructed state.
const summarySql = `WITH observed AS MATERIALIZED (
  SELECT clock_timestamp() AS at
), own AS MATERIALIZED (
  SELECT * FROM synthetic_entitlement_grants WHERE member_id=$1
), validity AS (
  SELECT COALESCE(bool_and(COALESCE(
    category IN ('coach_minutes','review_minutes','support_minutes','mock_sessions','study_requests')
    AND quantity>0 AND available>=0 AND reserved>=0 AND consumed>=0 AND expired>=0 AND adjusted>=0
    AND quantity::numeric=available::numeric+reserved+consumed+expired+adjusted
    AND isfinite(starts_at) AND isfinite(expires_at)
    AND (starts_at<expires_at OR (starts_at=expires_at AND expired_at IS NOT NULL AND available=0))
    AND (expired_at IS NULL OR (isfinite(expired_at) AND available=0))
  ,false)),true) AS valid FROM own
), categories(category,unit,ordinal) AS (VALUES
  ('coach_minutes','minutes',1),('review_minutes','minutes',2),('support_minutes','minutes',3),
  ('mock_sessions','sessions',4),('study_requests','requests',5)
)
SELECT c.category,c.unit,o.at AS "asOf",v.valid,
  count(g.id)::text AS grants,COALESCE(sum(g.quantity::numeric),0)::text AS granted,
  COALESCE(sum(g.available::numeric) FILTER(WHERE g.expired_at IS NULL AND g.starts_at<=o.at AND g.expires_at>o.at),0)::text AS usable,
  COALESCE(sum(g.available::numeric) FILTER(WHERE g.expired_at IS NULL AND g.starts_at>o.at),0)::text AS future,
  COALESCE(sum(g.available::numeric) FILTER(WHERE g.expired_at IS NULL AND g.expires_at<=o.at),0)::text AS "awaitingExpiry",
  COALESCE(sum(g.reserved::numeric),0)::text AS held,
  COALESCE(sum(g.consumed::numeric),0)::text AS consumed,
  COALESCE(sum(g.expired::numeric),0)::text AS expired,
  COALESCE(sum(g.adjusted::numeric),0)::text AS adjusted,
  min(g.expires_at) FILTER(WHERE g.expired_at IS NULL AND g.available>0 AND g.starts_at<=o.at AND g.expires_at>o.at) AS "nextExpiry",
  min(g.starts_at) FILTER(WHERE g.expired_at IS NULL AND g.available>0 AND g.starts_at>o.at) AS "nextStart"
FROM categories c CROSS JOIN observed o CROSS JOIN validity v
LEFT JOIN own g ON g.category=c.category
GROUP BY c.category,c.unit,c.ordinal,o.at,v.valid ORDER BY c.ordinal`;

type ReportRow = Record<string, unknown>;
class Denied extends Error {}
function instant(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("Invalid test-unit timestamp");
  return value;
}
function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid test-unit quantity");
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Unsafe test-unit quantity");
  return result;
}
function snapshot(rows: ReportRow[]): MemberTestUnitSnapshot {
  if (rows.length !== testUnitCategories.length)
    throw new Error("Incomplete test-unit snapshot");
  const asOf = instant(rows[0]!.asOf);
  const categories = rows.map((row, index): MemberTestUnitCategory => {
    const [category, unit] = testUnitCategories[index]!;
    if (
      row.category !== category ||
      row.unit !== unit ||
      row.valid !== true ||
      instant(row.asOf).getTime() !== asOf.getTime()
    )
      throw new Error("Invalid test-unit snapshot");
    const result: MemberTestUnitCategory = {
      category,
      unit,
      grants: quantity(row.grants),
      granted: quantity(row.granted),
      usable: quantity(row.usable),
      future: quantity(row.future),
      awaitingExpiry: quantity(row.awaitingExpiry),
      held: quantity(row.held),
      consumed: quantity(row.consumed),
      expired: quantity(row.expired),
      adjusted: quantity(row.adjusted),
      nextExpiry: row.nextExpiry === null ? null : instant(row.nextExpiry),
      nextStart: row.nextStart === null ? null : instant(row.nextStart),
    };
    const accounted =
      result.usable +
      result.future +
      result.awaitingExpiry +
      result.held +
      result.consumed +
      result.expired +
      result.adjusted;
    if (
      !Number.isSafeInteger(accounted) ||
      accounted !== result.granted ||
      (result.grants === 0) !== (result.granted === 0) ||
      result.usable > 0 !== (result.nextExpiry !== null) ||
      result.future > 0 !== (result.nextStart !== null) ||
      (result.nextExpiry !== null && result.nextExpiry <= asOf) ||
      (result.nextStart !== null && result.nextStart <= asOf)
    )
      throw new Error("Inconsistent test-unit accounting");
    return result;
  });
  return { scope: "synthetic-local-preview", asOf, categories };
}

export function memberTestUnitsStore(pool: Pool): MemberTestUnitsStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        committed = false,
        commitStarted = false,
        releaseError: Error | undefined;
      let result: MemberTestUnitsResult;
      // A checked-out client can emit an error between queries. Own that
      // interval, withhold any result and destroy the connection on release.
      const connectionFailed = (error: Error) => {
        releaseError = error;
      };
      try {
        client = await pool.connect();
        client.on("error", connectionFailed);
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        const member = (
          await client.query<{ id: string; expiresAt: Date }>(
            `SELECT p.id,p.expires_at AS "expiresAt" FROM principals p
             JOIN learners l ON l.id=p.id
             WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() FOR SHARE OF p`,
            [hash(token)],
          )
        ).rows[0];
        if (!member) throw new Denied();
        instant(member.expiresAt);
        const workspace = (
          await client.query(
            `SELECT id FROM workspaces WHERE owner_principal_id=$1
             AND deleting_at IS NULL FOR SHARE`,
            [member.id],
          )
        ).rows[0];
        if (!workspace) throw new Denied();
        const value = snapshot(
          (await client.query<ReportRow>(summarySql, [member.id])).rows,
        );
        const nextExpiry = value.categories.reduce<Date | null>(
          (next, row) =>
            row.nextExpiry !== null && (next === null || row.nextExpiry < next)
              ? row.nextExpiry
              : next,
          null,
        );
        const current = (
          await client.query<{ authorized: boolean; unexpired: boolean }>(
            `SELECT clock_timestamp()<$1::timestamptz AS authorized,
             ($2::timestamptz IS NULL OR clock_timestamp()<$2::timestamptz) AS unexpired`,
            [member.expiresAt, nextExpiry],
          )
        ).rows[0];
        if (current?.authorized !== true) throw new Denied();
        if (current.unexpired !== true)
          throw new Error("Test-unit deadline passed");
        commitStarted = true;
        await client.query("COMMIT");
        committed = true;
        result = { kind: "ready", value };
      } catch (error) {
        if (commitStarted)
          releaseError = new Error("Test-unit commit uncertain");
        result = { kind: error instanceof Denied ? "denied" : "unavailable" };
      } finally {
        if (client && !committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Test-unit rollback failed");
            result = { kind: "unavailable" };
          }
        }
        if (releaseError) result = { kind: "unavailable" };
        try {
          client?.release(releaseError);
          // pg-pool installs its idle listener during release. Remove ours
          // only after ownership has transferred, without an unhandled gap.
          client?.removeListener("error", connectionFailed);
        } catch {
          result = { kind: "unavailable" };
        }
      }
      return releaseError ? { kind: "unavailable" } : result;
    },
  };
}
