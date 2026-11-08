import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

/** #123 CAP: read-only comparison of declared staff capacity with recorded commitments. */
export type CapacityService = "coaching" | "formal-review";
export const CAPACITY_SERVICES: readonly CapacityService[] = [
  "coaching",
  "formal-review",
];
/** One retained roster record, with the checks the registry itself applies. */
export interface RosterFact {
  service: CapacityService;
  current: boolean;
  verified: boolean;
  staffActive: boolean;
  backupVerified: boolean;
  capacityMinutes: number;
  committedMinutes: number;
  /** Open future slots, each 60 minutes. */
  slotMinutes: number;
  heldSlots: number;
}
export type RosterStanding =
  | "covered"
  | "unverified"
  | "inactive"
  | "no_backup"
  | "not_current";
export interface CapacityGroup {
  service: CapacityService;
  status: "empty" | "consistent" | "discrepancies";
  records: number;
  notCurrent: number;
  covered: number;
  capacityMinutes: number;
  committedMinutes: number;
  slotMinutes: number;
  heldSlots: number;
  /** Null when no covered record exists: unknown, not zero. */
  availableMinutes: number | null;
  overcommitted: number;
  /** Sum of each record's overrun, so one record's room never hides another's. */
  overcommitMinutes: number;
  unverified: number;
  unverifiedCapacityMinutes: number;
  unverifiedCommittedMinutes: number;
  noBackup: number;
  noBackupCapacityMinutes: number;
  inactive: number;
  inactiveCapacityMinutes: number;
}
export interface ReviewTimeCommitments {
  status: "empty" | "consistent" | "discrepancies";
  open: number;
  openMinutes: number;
  /** Open allocations with a current reviewer grant. */
  granted: number;
  grantedMinutes: number;
  reviewers: number;
  /** Granted to reviewers none of whom has a current verified formal-review record. */
  unrostered: number;
  unrosteredMinutes: number;
  unrosteredReviewers: number;
  waiting: number;
  waitingMinutes: number;
  completed: number;
  reviewMinutes: number;
  preparationMinutes: number;
}
export interface StaffCapacitySnapshot {
  asOf: Date;
  groups: [CapacityGroup, CapacityGroup];
  reviewTime: ReviewTimeCommitments;
}
export type StaffCapacityResult =
  | { kind: "ready"; value: StaffCapacitySnapshot }
  | { kind: "denied" | "unavailable" };
export interface StaffCapacityStore {
  snapshot(token: string): Promise<StaffCapacityResult>;
}
export function disabledStaffCapacityStore(): StaffCapacityStore {
  return { snapshot: async () => ({ kind: "unavailable" }) };
}

/** CAP-02/05/06: the first failing check decides; only covered records count as available. */
export function rosterStanding(fact: RosterFact): RosterStanding {
  if (!fact.current) return "not_current";
  if (!fact.verified) return "unverified";
  if (!fact.staffActive) return "inactive";
  if (!fact.backupVerified) return "no_backup";
  return "covered";
}
/** CAP-03/04: room left on one record, or its overrun. Never netted across records. */
export function recordRoom(fact: RosterFact) {
  return fact.capacityMinutes - fact.committedMinutes - fact.slotMinutes;
}
export function capacityGroup(
  service: CapacityService,
  facts: readonly RosterFact[],
): CapacityGroup {
  const group: CapacityGroup = {
    service,
    status: "empty",
    records: 0,
    notCurrent: 0,
    covered: 0,
    capacityMinutes: 0,
    committedMinutes: 0,
    slotMinutes: 0,
    heldSlots: 0,
    availableMinutes: null,
    overcommitted: 0,
    overcommitMinutes: 0,
    unverified: 0,
    unverifiedCapacityMinutes: 0,
    unverifiedCommittedMinutes: 0,
    noBackup: 0,
    noBackupCapacityMinutes: 0,
    inactive: 0,
    inactiveCapacityMinutes: 0,
  };
  let available = 0;
  for (const fact of facts.filter((row) => row.service === service)) {
    const standing = rosterStanding(fact);
    if (standing === "not_current") {
      group.notCurrent++;
      continue;
    }
    group.records++;
    if (standing === "unverified") {
      group.unverified++;
      group.unverifiedCapacityMinutes += fact.capacityMinutes;
      group.unverifiedCommittedMinutes += fact.committedMinutes;
    } else if (standing === "inactive") {
      group.inactive++;
      group.inactiveCapacityMinutes += fact.capacityMinutes;
    } else if (standing === "no_backup") {
      group.noBackup++;
      group.noBackupCapacityMinutes += fact.capacityMinutes;
    } else {
      group.covered++;
      group.capacityMinutes += fact.capacityMinutes;
      group.committedMinutes += fact.committedMinutes;
      group.slotMinutes += fact.slotMinutes;
      group.heldSlots += fact.heldSlots;
      const room = recordRoom(fact);
      if (room < 0) {
        group.overcommitted++;
        group.overcommitMinutes -= room;
      } else available += room;
    }
  }
  group.availableMinutes = group.covered ? available : null;
  group.status = !group.records
    ? "empty"
    : group.overcommitted
      ? "discrepancies"
      : "consistent";
  return group;
}
export function reviewTimeCommitments(
  facts: Omit<ReviewTimeCommitments, "status">,
): ReviewTimeCommitments {
  return {
    status:
      !facts.open && !facts.completed
        ? "empty"
        : facts.unrostered
          ? "discrepancies"
          : "consistent",
    ...facts,
  };
}

// The registry's own checks (expertEligible and the availability page), read once
// at the snapshot's time. A record is never counted from its label alone.
const verifiedSql = (e: string) =>
  `(${e}.verified_by IS NOT NULL AND ${e}.verified_at IS NOT NULL AND ${e}.verified_at<=now()
    AND btrim(${e}.qualification_ref)<>'' AND btrim(${e}.agreement_ref)<>'' AND btrim(${e}.conflict_review_ref)<>''
    AND ${e}.backup_staff_id IS NOT NULL AND ${e}.backup_staff_id<>${e}.staff_id)`;
const currentSql = (e: string) =>
  `(${e}.retired_at IS NULL AND ${e}.starts_at<=now() AND ${e}.ends_at>now())`;
const activeSql = (e: string) =>
  `EXISTS(SELECT 1 FROM principals p WHERE p.id=${e}.staff_id AND p.kind='staff'
    AND p.revoked_at IS NULL AND p.expires_at>now())`;
const rosterSql = `SELECT e.service_type AS service,
   ${currentSql("e")} AS current,
   ${verifiedSql("e")} AS verified,
   ${activeSql("e")} AS "staffActive",
   EXISTS(SELECT 1 FROM expert_registry b WHERE b.staff_id=e.backup_staff_id
     AND b.domain=e.domain AND b.service_type=e.service_type
     AND ${currentSql("b")} AND ${verifiedSql("b")} AND ${activeSql("b")}) AS "backupVerified",
   e.capacity_minutes AS "capacityMinutes",e.committed_minutes AS "committedMinutes",
   (SELECT count(*)*60 FROM expert_availability_slots s
     WHERE s.expert_registry_id=e.id AND s.retired_at IS NULL AND s.starts_at>now())::text AS "slotMinutes",
   (SELECT count(*) FROM expert_availability_slots s JOIN synthetic_slot_holds h ON h.slot_id=s.id
     WHERE s.expert_registry_id=e.id AND s.retired_at IS NULL AND s.starts_at>now()
       AND h.state='held' AND h.expires_at>now())::integer AS "heldSlots"
 FROM expert_registry e`;
// An open allocation counts once, however many reviewers hold a current grant on it.
const reviewTimeSql = `WITH grants AS (
   SELECT g.allocation_id,g.staff_id,EXISTS(
     SELECT 1 FROM expert_registry e WHERE e.staff_id=g.staff_id AND e.service_type='formal-review'
       AND ${currentSql("e")} AND ${verifiedSql("e")}) AS rostered
   FROM review_time_grants g JOIN review_time_allocations a ON a.id=g.allocation_id
   WHERE a.state IN ('allocated','begun','needs_reconciliation')
     AND g.revoked_at IS NULL AND g.starts_at<=now() AND g.expires_at>now()
 ),open AS (
   SELECT a.id,a.ceiling,
     EXISTS(SELECT 1 FROM grants g WHERE g.allocation_id=a.id) AS granted,
     EXISTS(SELECT 1 FROM grants g WHERE g.allocation_id=a.id AND g.rostered) AS rostered
   FROM review_time_allocations a WHERE a.state IN ('allocated','begun','needs_reconciliation')
 )
 SELECT (SELECT count(*) FROM open)::integer AS open,
   (SELECT COALESCE(sum(ceiling),0) FROM open)::text AS "openMinutes",
   (SELECT count(*) FROM open WHERE granted)::integer AS granted,
   (SELECT COALESCE(sum(ceiling),0) FROM open WHERE granted)::text AS "grantedMinutes",
   (SELECT count(DISTINCT staff_id) FROM grants)::integer AS reviewers,
   (SELECT count(*) FROM open WHERE granted AND NOT rostered)::integer AS unrostered,
   (SELECT COALESCE(sum(ceiling),0) FROM open WHERE granted AND NOT rostered)::text AS "unrosteredMinutes",
   (SELECT count(DISTINCT staff_id) FROM grants WHERE NOT rostered)::integer AS "unrosteredReviewers",
   (SELECT count(*) FROM open WHERE NOT granted)::integer AS waiting,
   (SELECT COALESCE(sum(ceiling),0) FROM open WHERE NOT granted)::text AS "waitingMinutes",
   (SELECT count(*) FROM review_time_allocations a JOIN review_time_entries t ON t.allocation_id=a.id
     WHERE a.state='completed')::integer AS completed,
   (SELECT COALESCE(sum(t.review_minutes),0) FROM review_time_allocations a JOIN review_time_entries t ON t.allocation_id=a.id
     WHERE a.state='completed')::text AS "reviewMinutes",
   (SELECT COALESCE(sum(t.preparation_minutes),0) FROM review_time_allocations a JOIN review_time_entries t ON t.allocation_id=a.id
     WHERE a.state='completed')::text AS "preparationMinutes"`;

const whole = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Error("Capacity report value is not a whole number");
  return number;
};
const flag = (value: unknown) => {
  if (typeof value !== "boolean")
    throw new Error("Capacity report check is not a yes or no");
  return value;
};
export function decodeRosterFact(row: Record<string, unknown>): RosterFact {
  if (!CAPACITY_SERVICES.includes(row.service as CapacityService))
    throw new Error("Capacity report service is unknown");
  return {
    service: row.service as CapacityService,
    current: flag(row.current),
    verified: flag(row.verified),
    staffActive: flag(row.staffActive),
    backupVerified: flag(row.backupVerified),
    capacityMinutes: whole(row.capacityMinutes),
    committedMinutes: whole(row.committedMinutes),
    slotMinutes: whole(row.slotMinutes),
    heldSlots: whole(row.heldSlots),
  };
}
const reviewKeys = [
  "open",
  "openMinutes",
  "granted",
  "grantedMinutes",
  "reviewers",
  "unrostered",
  "unrosteredMinutes",
  "unrosteredReviewers",
  "waiting",
  "waitingMinutes",
  "completed",
  "reviewMinutes",
  "preparationMinutes",
] as const;
export function decodeReviewTime(
  row: Record<string, unknown> | undefined,
): ReviewTimeCommitments {
  if (!row) throw new Error("Capacity report row missing");
  return reviewTimeCommitments(
    Object.fromEntries(reviewKeys.map((key) => [key, whole(row[key])])) as Omit<
      ReviewTimeCommitments,
      "status"
    >,
  );
}
/** Reads every source inside the caller's one snapshot. */
export async function readStaffCapacity(
  client: Pick<PoolClient, "query">,
): Promise<StaffCapacitySnapshot> {
  const roster = (await client.query<Record<string, unknown>>(rosterSql)).rows,
    review = (await client.query<Record<string, unknown>>(reviewTimeSql))
      .rows[0],
    asOf = (await client.query<{ asOf: Date }>('SELECT now() AS "asOf"'))
      .rows[0];
  if (!asOf || !(asOf.asOf instanceof Date))
    throw new Error("Capacity report row missing");
  const facts = roster.map(decodeRosterFact);
  return {
    asOf: asOf.asOf,
    groups: [
      capacityGroup("coaching", facts),
      capacityGroup("formal-review", facts),
    ],
    reviewTime: decodeReviewTime(review),
  };
}
class AccessDenied extends Error {}
export function staffCapacityStore(pool: Pool): StaffCapacityStore {
  return {
    async snapshot(token) {
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        return { kind: "denied" };
      let client: PoolClient | undefined,
        failure: Error | undefined,
        result: StaffCapacityResult;
      try {
        client = await pool.connect();
        // One snapshot across every statement. It writes nothing and always rolls
        // back; the staff-role view locks, so it can't be READ ONLY.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await client.query("SET LOCAL statement_timeout='5s'");
        // CAP-08: the same people who can open the expert registry.
        const allowed = (
          await client.query(
            `SELECT 1 FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND s.role IN ('operator','platform_admin')`,
            [hash(token)],
          )
        ).rows[0];
        if (!allowed) throw new AccessDenied();
        result = { kind: "ready", value: await readStaffCapacity(client) };
      } catch (error) {
        result = {
          kind: error instanceof AccessDenied ? "denied" : "unavailable",
        };
      }
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch {
          failure = new Error("Capacity report rollback failed");
          result = { kind: "unavailable" };
        }
        client.release(failure);
      }
      return result;
    },
  };
}
