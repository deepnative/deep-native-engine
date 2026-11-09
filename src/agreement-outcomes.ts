import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

/** #123 AGREE: read-only counts of course-billing agreements by outcome. */
export interface AgreementCounts {
  /** Every agreement ever offered and still held, whatever happened next. */
  offered: number;
  accepted: number;
  /** Offered and not yet accepted or withdrawn. */
  waiting: number;
  /** Cancelled before acceptance. Still in the offered denominator. */
  withdrawn: number;
  active: number;
  /** Cancelled after acceptance. Still in the accepted denominator. */
  cancelled: number;
  firstOffered: Date | null;
  lastOffered: Date | null;
  firstAccepted: Date | null;
  lastAccepted: Date | null;
}
export interface AgreementGroup extends AgreementCounts {
  /** False when the outcomes don't add up to their denominators. */
  consistent: boolean;
}
export interface AgreementOutcomesSnapshot {
  asOf: Date;
  /** Agreements whose terms say they aren't a test. */
  real: AgreementGroup;
  /** Agreements whose terms say they are a test, or don't say. */
  test: AgreementGroup;
}
export type AgreementOutcomesResult =
  | { kind: "ready"; value: AgreementOutcomesSnapshot }
  | { kind: "denied" }
  | { kind: "unavailable" };
export interface AgreementOutcomesStore {
  snapshot(token: string): Promise<AgreementOutcomesResult>;
}
export function disabledAgreementOutcomesStore(): AgreementOutcomesStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}

/** AGREE-04: a share of a denominator, never 0% of nothing. */
export function share(part: number, whole: number, none: string) {
  if (whole === 0) return none;
  return `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;
}

/** AGREE-02: outcomes partition their denominators exactly. */
export function agreementGroup(counts: AgreementCounts): AgreementGroup {
  return {
    ...counts,
    consistent:
      counts.offered ===
        counts.waiting + counts.withdrawn + counts.active + counts.cancelled &&
      counts.accepted === counts.active + counts.cancelled,
  };
}

const COUNT_KEYS = [
  "offered",
  "accepted",
  "waiting",
  "withdrawn",
  "active",
  "cancelled",
] as const;
const DATE_KEYS = [
  "firstOffered",
  "lastOffered",
  "firstAccepted",
  "lastAccepted",
] as const;
const EMPTY: AgreementCounts = {
  offered: 0,
  accepted: 0,
  waiting: 0,
  withdrawn: 0,
  active: 0,
  cancelled: 0,
  firstOffered: null,
  lastOffered: null,
  firstAccepted: null,
  lastAccepted: null,
};

/** Validates one grouped row before it reaches the page. */
export function decodeAgreementCounts(
  row: Record<string, unknown>,
): AgreementCounts {
  const counts = { ...EMPTY };
  for (const key of COUNT_KEYS) {
    const value = row[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error("Agreement outcome row invalid");
    counts[key] = value as number;
  }
  for (const key of DATE_KEYS) {
    const value = row[key];
    if (value !== null && !(value instanceof Date && isFinite(+value)))
      throw new Error("Agreement outcome row invalid");
    counts[key] = value as Date | null;
  }
  return counts;
}

// AGREE-03: only terms that explicitly say sample=false count as real.
const outcomesSql = `SELECT (terms->'sample' IS DISTINCT FROM 'false'::jsonb) AS test,
  count(*)::integer AS offered,
  count(*) FILTER (WHERE accepted_at IS NOT NULL)::integer AS accepted,
  count(*) FILTER (WHERE state='offered' AND accepted_at IS NULL)::integer AS waiting,
  count(*) FILTER (WHERE state='cancelled' AND accepted_at IS NULL)::integer AS withdrawn,
  count(*) FILTER (WHERE state='active' AND accepted_at IS NOT NULL)::integer AS active,
  count(*) FILTER (WHERE state='cancelled' AND accepted_at IS NOT NULL)::integer AS cancelled,
  min(created_at) AS "firstOffered",max(created_at) AS "lastOffered",
  min(accepted_at) AS "firstAccepted",max(accepted_at) AS "lastAccepted"
  FROM simple_invoice_plans GROUP BY 1`;

/** Reads every source inside the caller's one snapshot. */
export async function readAgreementOutcomes(
  client: Pick<PoolClient, "query">,
): Promise<AgreementOutcomesSnapshot> {
  const rows = (await client.query<Record<string, unknown>>(outcomesSql)).rows,
    asOf = (await client.query<{ asOf: Date }>('SELECT now() AS "asOf"'))
      .rows[0];
  if (!asOf || !(asOf.asOf instanceof Date))
    throw new Error("Agreement outcome row missing");
  const group = (test: boolean) => {
    const found = rows.filter((row) => row.test === test);
    if (rows.some((row) => typeof row.test !== "boolean") || found.length > 1)
      throw new Error("Agreement outcome row invalid");
    return agreementGroup(found[0] ? decodeAgreementCounts(found[0]) : EMPTY);
  };
  return { asOf: asOf.asOf, real: group(false), test: group(true) };
}

class AccessDenied extends Error {}
export function agreementOutcomesStore(pool: Pool): AgreementOutcomesStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        failure: Error | undefined,
        result: AgreementOutcomesResult;
      try {
        client = await pool.connect();
        // One snapshot. It writes nothing and always rolls back.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SET LOCAL statement_timeout='5s'");
        // AGREE-06: the same people who can open invoice reconciliation.
        const allowed = (
          await client.query(
            `SELECT 1 FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND s.role='platform_admin'`,
            [hash(token)],
          )
        ).rows[0];
        if (!allowed) throw new AccessDenied();
        result = { kind: "ready", value: await readAgreementOutcomes(client) };
      } catch (error) {
        result = {
          kind: error instanceof AccessDenied ? "denied" : "unavailable",
        };
      }
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          failure = new Error("Agreement outcomes rollback failed");
          result = { kind: "unavailable" };
        }
        client.release(failure);
      }
      return result;
    },
  };
}
