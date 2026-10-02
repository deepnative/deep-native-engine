import type { Pool, PoolClient } from "pg";
import type { LedgerCategory } from "./ledger.ts";
import { hash } from "./store.ts";

export interface LedgerReconciliationCategory {
  category: LedgerCategory;
  unit: "minutes" | "sessions" | "requests";
  observed: {
    grants: number;
    reservations: number;
    events: number;
    completions: number;
    granted: number;
    available: number;
    reserved: number;
    consumed: number;
    expired: number;
    adjusted: number;
  };
  events: {
    grant: number;
    reserve: number;
    consume: number;
    release: number;
    expire: number;
    adjust: number;
  };
  completion: {
    attachedQuantity: number;
    deliveredMinutes: number;
    preparationMinutes: number;
    consumedWithoutAttachment: number;
  };
  reconciliation: {
    status: "consistent" | "discrepancies";
    grants: number;
    reservations: number;
    events: number;
    completions: number;
  };
}
export interface LedgerReconciliationSnapshot {
  scope: "synthetic-local-preview";
  asOf: Date;
  categories: LedgerReconciliationCategory[];
}
export type LedgerReconciliationResult =
  | { kind: "ready"; value: LedgerReconciliationSnapshot }
  | { kind: "denied" | "unavailable" };
export interface LedgerReconciliationStore {
  snapshot(token: string): Promise<LedgerReconciliationResult>;
}
export function disabledLedgerReconciliationStore(): LedgerReconciliationStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}
const categories: readonly LedgerCategory[] = [
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
  "study_requests",
];
const numericFields = [
  "grants",
  "reservations",
  "events",
  "completions",
  "granted",
  "available",
  "reserved",
  "consumed",
  "expired",
  "adjusted",
  "grantEvents",
  "reserveEvents",
  "consumeEvents",
  "releaseEvents",
  "expireEvents",
  "adjustEvents",
  "attachedQuantity",
  "deliveredMinutes",
  "preparationMinutes",
  "consumedWithoutAttachment",
  "invalidGrants",
  "invalidReservations",
  "invalidEvents",
  "invalidCompletions",
] as const;
const rowFields = ["category", "asOf", ...numericFields].sort().join(",");
type ReportRow = Record<string, unknown>;
class AccessDenied extends Error {}

// Each validation is per retained record, before category aggregation. Separate
// aggregates prevent join fanout and opposite discrepancies cancelling out.
// IDs stay inside SQL joins; references and fingerprints are never selected.
const reportSql = `WITH
 event_facts AS (
   SELECT e.id,e.member_id,e.grant_id,e.reservation_id,e.operation,e.quantity,e.result_id,g.category,
     NOT COALESCE(e.member_id=g.member_id AND
       CASE WHEN e.operation IN ('grant','expire','adjust') THEN
         e.reservation_id IS NULL AND e.result_id=g.id
         AND (e.quantity>0 OR (e.operation='expire' AND e.quantity=0))
         AND (e.operation<>'grant' OR e.quantity=g.quantity)
       ELSE r.id IS NOT NULL AND r.grant_id=g.id AND e.quantity=r.quantity AND
         CASE e.operation
           WHEN 'reserve' THEN e.result_id=r.id
           WHEN 'release' THEN r.state='released' AND e.result_id=r.id
           WHEN 'consume' THEN r.state='consumed' AND
             e.result_id=CASE WHEN s.id IS NULL THEN r.id ELSE e.id END
           ELSE false
         END
       END,false) AS invalid
   FROM synthetic_entitlement_events e
   JOIN synthetic_entitlement_grants g ON g.id=e.grant_id
   LEFT JOIN synthetic_entitlement_reservations r ON r.id=e.reservation_id
   LEFT JOIN synthetic_entitlement_settlements s ON s.id=e.id
 ), reservation_event_facts AS (
   SELECT reservation_id,
     count(*) FILTER(WHERE operation='reserve') AS reserves,
     count(*) FILTER(WHERE operation='consume') AS consumes,
     count(*) FILTER(WHERE operation='release') AS releases,
     bool_or(invalid) AS invalid
   FROM event_facts WHERE reservation_id IS NOT NULL GROUP BY reservation_id
 ), reservation_facts AS (
   SELECT r.id,r.grant_id,r.quantity,r.state,g.category,
     (s.id IS NOT NULL) AS attached,
     NOT COALESCE(f.reserves=1 AND NOT f.invalid AND
       CASE r.state
         WHEN 'reserved' THEN f.consumes=0 AND f.releases=0
         WHEN 'consumed' THEN f.consumes=1 AND f.releases=0
         WHEN 'released' THEN f.consumes=0 AND f.releases=1
         ELSE false
       END,false) AS invalid
   FROM synthetic_entitlement_reservations r
   JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
   LEFT JOIN reservation_event_facts f ON f.reservation_id=r.id
   LEFT JOIN synthetic_entitlement_settlements s ON s.reservation_id=r.id
 ), grant_event_facts AS (
   SELECT grant_id,
     count(*) FILTER(WHERE operation='grant') AS grants,
     bool_or(invalid) FILTER(WHERE operation='grant') AS invalid_grant,
     sum(quantity::numeric) FILTER(WHERE operation='adjust') AS adjusted,
     count(*) FILTER(WHERE operation='expire') AS expiries,
     sum(quantity::numeric) FILTER(WHERE operation='expire') AS expired
   FROM event_facts GROUP BY grant_id
 ), grant_reservation_facts AS (
   SELECT grant_id,
     sum(quantity::numeric) FILTER(WHERE state='reserved') AS reserved,
     sum(quantity::numeric) FILTER(WHERE state='consumed') AS consumed
   FROM reservation_facts GROUP BY grant_id
 ), grant_facts AS (
   SELECT g.*,
     NOT COALESCE(e.grants=1 AND NOT e.invalid_grant
       AND g.available::numeric+g.reserved+g.consumed+g.expired+g.adjusted=g.quantity
       AND g.reserved=COALESCE(r.reserved,0)
       AND g.consumed=COALESCE(r.consumed,0)
       AND g.adjusted=COALESCE(e.adjusted,0)
       AND e.expiries=CASE WHEN g.expired_at IS NULL THEN 0 ELSE 1 END
       AND COALESCE(e.expired,0)<=g.expired,false) AS invalid
   FROM synthetic_entitlement_grants g
   LEFT JOIN grant_event_facts e ON e.grant_id=g.id
   LEFT JOIN grant_reservation_facts r ON r.grant_id=g.id
 ), completion_facts AS (
   SELECT s.quantity,s.delivered_minutes,s.preparation_minutes,g.category,
     NOT COALESCE(s.member_id=g.member_id AND s.grant_id=r.grant_id
       AND s.category=g.category AND s.quantity=r.quantity AND r.state='consumed'
       AND e.operation='consume' AND e.reservation_id=r.id
       AND e.member_id=s.member_id AND e.grant_id=s.grant_id
       AND e.quantity=s.quantity AND e.result_id=s.id
       AND CASE g.category
         WHEN 'study_requests' THEN s.quantity=1 AND s.delivered_minutes IS NULL AND s.preparation_minutes IS NULL
         WHEN 'review_minutes' THEN s.delivered_minutes>0 AND s.preparation_minutes>=0 AND s.delivered_minutes::numeric+s.preparation_minutes=s.quantity
         WHEN 'support_minutes' THEN s.delivered_minutes>0 AND s.preparation_minutes>=0 AND s.delivered_minutes::numeric+s.preparation_minutes=s.quantity
         ELSE false
       END,false) AS invalid
   FROM synthetic_entitlement_settlements s
   JOIN synthetic_entitlement_grants g ON g.id=s.grant_id
   LEFT JOIN synthetic_entitlement_reservations r ON r.id=s.reservation_id
   LEFT JOIN synthetic_entitlement_events e ON e.id=s.id
 ), grants AS (
   SELECT category,count(*) AS records,count(*) FILTER(WHERE invalid) AS invalid,
     sum(quantity::numeric) AS granted,sum(available::numeric) AS available,
     sum(reserved::numeric) AS reserved,sum(consumed::numeric) AS consumed,
     sum(expired::numeric) AS expired,sum(adjusted::numeric) AS adjusted
   FROM grant_facts GROUP BY category
 ), reservations AS (
   SELECT category,count(*) AS records,count(*) FILTER(WHERE invalid) AS invalid,
     count(*) FILTER(WHERE state='consumed' AND NOT attached) AS unattached
   FROM reservation_facts GROUP BY category
 ), events AS (
   SELECT category,count(*) AS records,count(*) FILTER(WHERE invalid) AS invalid,
     count(*) FILTER(WHERE operation='grant') AS grants,
     count(*) FILTER(WHERE operation='reserve') AS reserves,
     count(*) FILTER(WHERE operation='consume') AS consumes,
     count(*) FILTER(WHERE operation='release') AS releases,
     count(*) FILTER(WHERE operation='expire') AS expiries,
     count(*) FILTER(WHERE operation='adjust') AS adjustments
   FROM event_facts GROUP BY category
 ), completions AS (
   SELECT category,count(*) AS records,count(*) FILTER(WHERE invalid) AS invalid,
     sum(quantity::numeric) AS quantity,sum(delivered_minutes::numeric) AS delivered,
     sum(preparation_minutes::numeric) AS preparation
   FROM completion_facts GROUP BY category
 )
 SELECT c.category,statement_timestamp() AS "asOf",
   COALESCE(g.records,0)::text AS grants,COALESCE(r.records,0)::text AS reservations,
   COALESCE(e.records,0)::text AS events,COALESCE(s.records,0)::text AS completions,
   COALESCE(g.granted,0)::text AS granted,COALESCE(g.available,0)::text AS available,
   COALESCE(g.reserved,0)::text AS reserved,COALESCE(g.consumed,0)::text AS consumed,
   COALESCE(g.expired,0)::text AS expired,COALESCE(g.adjusted,0)::text AS adjusted,
   COALESCE(e.grants,0)::text AS "grantEvents",COALESCE(e.reserves,0)::text AS "reserveEvents",
   COALESCE(e.consumes,0)::text AS "consumeEvents",COALESCE(e.releases,0)::text AS "releaseEvents",
   COALESCE(e.expiries,0)::text AS "expireEvents",COALESCE(e.adjustments,0)::text AS "adjustEvents",
   COALESCE(s.quantity,0)::text AS "attachedQuantity",COALESCE(s.delivered,0)::text AS "deliveredMinutes",
   COALESCE(s.preparation,0)::text AS "preparationMinutes",COALESCE(r.unattached,0)::text AS "consumedWithoutAttachment",
   COALESCE(g.invalid,0)::text AS "invalidGrants",COALESCE(r.invalid,0)::text AS "invalidReservations",
   COALESCE(e.invalid,0)::text AS "invalidEvents",COALESCE(s.invalid,0)::text AS "invalidCompletions"
 FROM (VALUES ('coach_minutes',1),('review_minutes',2),('support_minutes',3),('mock_sessions',4),('study_requests',5)) c(category,position)
 LEFT JOIN grants g USING(category) LEFT JOIN reservations r USING(category)
 LEFT JOIN events e USING(category) LEFT JOIN completions s USING(category)
 ORDER BY c.position`;

function integer(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 16 ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw Error("Unavailable aggregate");
  return Number(value);
}
function snapshot(rows: ReportRow[]): LedgerReconciliationSnapshot {
  if (rows.length !== categories.length) throw Error("Unavailable categories");
  const asOf = rows[0]!.asOf;
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.valueOf()))
    throw Error("Unavailable snapshot time");
  return {
    scope: "synthetic-local-preview",
    asOf,
    categories: rows.map((row, index) => {
      if (
        Object.keys(row).sort().join(",") !== rowFields ||
        row.category !== categories[index] ||
        !(row.asOf instanceof Date) ||
        row.asOf.valueOf() !== asOf.valueOf()
      )
        throw Error("Unavailable report shape");
      const values = Object.fromEntries(
        numericFields.map((key) => [key, integer(row[key])]),
      ) as Record<(typeof numericFields)[number], number>;
      const category = categories[index]!;
      return {
        category,
        unit:
          category === "mock_sessions"
            ? "sessions"
            : category === "study_requests"
              ? "requests"
              : "minutes",
        observed: {
          grants: values.grants,
          reservations: values.reservations,
          events: values.events,
          completions: values.completions,
          granted: values.granted,
          available: values.available,
          reserved: values.reserved,
          consumed: values.consumed,
          expired: values.expired,
          adjusted: values.adjusted,
        },
        events: {
          grant: values.grantEvents,
          reserve: values.reserveEvents,
          consume: values.consumeEvents,
          release: values.releaseEvents,
          expire: values.expireEvents,
          adjust: values.adjustEvents,
        },
        completion: {
          attachedQuantity: values.attachedQuantity,
          deliveredMinutes: values.deliveredMinutes,
          preparationMinutes: values.preparationMinutes,
          consumedWithoutAttachment: values.consumedWithoutAttachment,
        },
        reconciliation: {
          status:
            values.invalidGrants +
              values.invalidReservations +
              values.invalidEvents +
              values.invalidCompletions >
            0
              ? "discrepancies"
              : "consistent",
          grants: values.invalidGrants,
          reservations: values.invalidReservations,
          events: values.invalidEvents,
          completions: values.invalidCompletions,
        },
      };
    }),
  };
}
export function ledgerReconciliationStore(
  pool: Pool,
): LedgerReconciliationStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        committed = false,
        releaseError: Error | undefined;
      let result: LedgerReconciliationResult;
      try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        const principal = (
          await client.query<{ id: string; expiresAt: Date }>(
            `SELECT id,expires_at AS "expiresAt" FROM principals WHERE token_hash=$1 AND kind='staff'
           AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!principal) throw new AccessDenied();
        const profile = (
          await client.query(
            "SELECT role FROM staff_profiles WHERE principal_id=$1 AND role IN ('operator','platform_admin') FOR SHARE",
            [principal.id],
          )
        ).rows[0];
        if (!profile) throw new AccessDenied();
        // This is the only ledger read: its one statement snapshot covers every
        // table and every category, even while a writer or deletion commits.
        const report = snapshot(
          (await client.query<ReportRow>(reportSql)).rows,
        );
        const current = (
          await client.query<{ valid: boolean }>(
            "SELECT clock_timestamp()<$1::timestamptz AS valid",
            [principal.expiresAt],
          )
        ).rows[0];
        if (!current?.valid) throw new AccessDenied();
        await client.query("COMMIT");
        committed = true;
        result = { kind: "ready", value: report };
      } catch (error) {
        result = {
          kind: error instanceof AccessDenied ? "denied" : "unavailable",
        };
      } finally {
        if (client && !committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            releaseError = new Error("Reconciliation rollback failed");
            result = { kind: "unavailable" };
          }
        }
        client?.release(releaseError);
      }
      return result;
    },
  };
}
