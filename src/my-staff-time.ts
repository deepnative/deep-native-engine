import type { Pool, PoolClient } from "pg";
import {
  activeSql,
  currentSql,
  decodeRosterFact,
  recordRoom,
  rosterStanding,
  verifiedSql,
  type CapacityService,
  type RosterStanding,
} from "./staff-capacity.ts";
import { hash } from "./store.ts";

/** #193 MYTIME: one staff member's own roster records, held slots and room left. */
export interface HeldSlot {
  startsAt: Date;
  endsAt: Date;
}
export interface MyRosterRecord {
  service: CapacityService;
  domain: string;
  startsAt: Date;
  endsAt: Date;
  standing: Exclude<RosterStanding, "not_current">;
  capacityMinutes: number;
  committedMinutes: number;
  /** Open future slots, each 60 minutes, held or not. */
  slotMinutes: number;
  held: HeldSlot[];
  /** Null unless the record is covered: room is never offered otherwise. */
  roomMinutes: number | null;
}
export interface MyStaffTimeSnapshot {
  asOf: Date;
  records: MyRosterRecord[];
  /** Own records outside their window or retired: counted, not listed. */
  notCurrent: number;
}
export type MyStaffTimeResult =
  | { kind: "ready"; value: MyStaffTimeSnapshot }
  | { kind: "denied" | "unavailable" };
export interface MyStaffTimeStore {
  snapshot(token: string): Promise<MyStaffTimeResult>;
}
export function disabledMyStaffTimeStore(): MyStaffTimeStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}

// MYTIME-06: only records naming this person as the primary staff member.
const recordsSql = `SELECT e.id,e.service_type AS service,e.domain,e.starts_at AS "startsAt",e.ends_at AS "endsAt",
   ${currentSql("e")} AS current,
   ${verifiedSql("e")} AS verified,
   ${activeSql("e")} AS "staffActive",
   EXISTS(SELECT 1 FROM expert_registry b WHERE b.staff_id=e.backup_staff_id
     AND b.domain=e.domain AND b.service_type=e.service_type
     AND ${currentSql("b")} AND ${verifiedSql("b")} AND ${activeSql("b")}) AS "backupVerified",
   e.capacity_minutes AS "capacityMinutes",e.committed_minutes AS "committedMinutes",
   (SELECT count(*)*60 FROM expert_availability_slots s
     WHERE s.expert_registry_id=e.id AND s.retired_at IS NULL AND s.starts_at>now())::text AS "slotMinutes",
   0 AS "heldSlots"
 FROM expert_registry e WHERE e.staff_id=$1
 ORDER BY e.starts_at,e.id`;
// MYTIME-02: the same held rule as the staff capacity report, times only.
const heldSql = `SELECT s.expert_registry_id AS record,s.starts_at AS "startsAt",s.ends_at AS "endsAt"
 FROM expert_availability_slots s JOIN synthetic_slot_holds h ON h.slot_id=s.id
 JOIN expert_registry e ON e.id=s.expert_registry_id
 WHERE e.staff_id=$1 AND s.retired_at IS NULL AND s.starts_at>now()
   AND h.state='held' AND h.expires_at>now()
 ORDER BY s.starts_at,s.id`;

const instant = (value: unknown) => {
  if (!(value instanceof Date) || !Number.isFinite(+value))
    throw new Error("Booked time value is not a time");
  return value;
};
const text = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Booked time value is not text");
  return value;
};

/** Builds one person's records from rows read inside one snapshot. */
export function myStaffTime(
  asOf: Date,
  rows: readonly Record<string, unknown>[],
  heldRows: readonly Record<string, unknown>[],
): MyStaffTimeSnapshot {
  const held = new Map<string, HeldSlot[]>();
  for (const row of heldRows) {
    const record = text(row.record);
    held.set(record, [
      ...(held.get(record) ?? []),
      { startsAt: instant(row.startsAt), endsAt: instant(row.endsAt) },
    ]);
  }
  const records: MyRosterRecord[] = [];
  let notCurrent = 0;
  for (const row of rows) {
    const id = text(row.id),
      slots = held.get(id) ?? [];
    const fact = decodeRosterFact({ ...row, heldSlots: slots.length });
    const standing = rosterStanding(fact);
    if (standing === "not_current") {
      notCurrent++;
      continue;
    }
    records.push({
      service: fact.service,
      domain: text(row.domain),
      startsAt: instant(row.startsAt),
      endsAt: instant(row.endsAt),
      standing,
      capacityMinutes: fact.capacityMinutes,
      committedMinutes: fact.committedMinutes,
      slotMinutes: fact.slotMinutes,
      held: slots,
      roomMinutes: standing === "covered" ? recordRoom(fact) : null,
    });
  }
  return { asOf: instant(asOf), records, notCurrent };
}

class AccessDenied extends Error {}
export function myStaffTimeStore(pool: Pool): MyStaffTimeStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        failure: Error | undefined,
        result: MyStaffTimeResult;
      try {
        client = await pool.connect();
        // One snapshot across every statement; it writes nothing and rolls back.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout='5s'");
        // MYTIME-05: any current staff member, and only for themselves.
        const self = (
          await client.query<{ id: string }>(
            `SELECT id FROM principals WHERE token_hash=$1 AND kind='staff'
             AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
            [hash(token)],
          )
        ).rows[0];
        if (!self) throw new AccessDenied();
        const rows = (await client.query(recordsSql, [self.id])).rows,
          heldRows = (await client.query(heldSql, [self.id])).rows,
          asOf = (await client.query<{ asOf: Date }>('SELECT now() AS "asOf"'))
            .rows[0];
        if (!asOf) throw new Error("Booked time row missing");
        result = {
          kind: "ready",
          value: myStaffTime(asOf.asOf, rows, heldRows),
        };
      } catch (error) {
        result = {
          kind: error instanceof AccessDenied ? "denied" : "unavailable",
        };
      }
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          failure = new Error("Booked time rollback failed");
          result = { kind: "unavailable" };
        }
        client.release(failure);
      }
      return result;
    },
  };
}
