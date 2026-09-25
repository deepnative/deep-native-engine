import type { Pool } from "pg";
import {
  DOMAINS,
  GOALS,
  IT_ROLES,
  type Domain,
  type Goal,
  type ItRole,
} from "./content.ts";
import { hash } from "./store.ts";

export type TrackState =
  "available" | "limited coverage" | "in preparation" | "retired";
export interface ExpertRecord {
  id: string;
  staffId: string;
  staffRole: "coach" | "reviewer";
  domain: Domain;
  serviceType: "coaching" | "formal-review";
  startsAt: Date;
  endsAt: Date;
  loadedCostCents: number;
  capacityMinutes: number;
  committedMinutes: number;
  backupStaffId: string | null;
  qualificationRef: string;
  agreementRef: string;
  conflictReviewRef: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  retiredAt: Date | null;
}
export interface TrackSnapshot {
  foundation: Array<{ goal: Goal; state: TrackState }>;
  itSpecialties: Array<{ role: ItRole; state: TrackState }>;
  specialties: Array<{
    domain: Domain;
    serviceType: ExpertRecord["serviceType"];
    state: TrackState;
    gaps: string[];
  }>;
}
export interface TrackStore {
  snapshot(): Promise<TrackSnapshot>;
  registry(token: string): Promise<ExpertRecord[] | null>;
}
const foundationIds = [
  "FND-001",
  "FND-002",
  "FND-003",
  "FND-004",
  "FND-005",
  "FND-006",
];
const serviceTypes = ["coaching", "formal-review"] as const;
export function expertEligible(record: ExpertRecord, now: Date): boolean {
  return (
    record.verifiedBy !== null &&
    record.verifiedAt !== null &&
    record.qualificationRef.trim() !== "" &&
    record.agreementRef.trim() !== "" &&
    record.conflictReviewRef.trim() !== "" &&
    record.backupStaffId !== null &&
    record.backupStaffId !== record.staffId &&
    record.retiredAt === null &&
    record.startsAt <= now &&
    record.endsAt > now
  );
}
export function specialtyState(
  contentReady: boolean,
  records: ExpertRecord[],
  now: Date,
): TrackState {
  if (records.length > 0 && records.every((record) => record.retiredAt))
    return "retired";
  if (!contentReady) return "in preparation";
  const current = records.filter(
    (record) =>
      expertEligible(record, now) &&
      record.capacityMinutes > record.committedMinutes,
  );
  const eligible = current.filter((record) =>
    current.some(
      (backup) =>
        backup.staffId === record.backupStaffId &&
        backup.capacityMinutes - backup.committedMinutes >= 60,
    ),
  );
  if (!eligible.length) return "in preparation";
  const minutes = eligible.reduce(
    (total, record) => total + record.capacityMinutes - record.committedMinutes,
    0,
  );
  return minutes >= 60 ? "available" : "limited coverage";
}
export function specialtyGaps(
  contentReady: boolean,
  records: ExpertRecord[],
  serviceType: ExpertRecord["serviceType"],
  now: Date,
): string[] {
  const gaps: string[] = [];
  if (!contentReady) gaps.push("Reviewed content not verified");
  if (
    serviceType === "formal-review" &&
    !records.some((record) => expertEligible(record, now))
  )
    gaps.push("Qualified reviewer coverage not verified");
  if (
    !["available", "limited coverage"].includes(
      specialtyState(true, records, now),
    )
  )
    gaps.push("Deliverable service capacity not verified");
  return gaps;
}
export function disabledTrackStore(): TrackStore {
  return {
    snapshot: async () => ({
      foundation: Object.keys(GOALS).map((goal) => ({
        goal: goal as Goal,
        state: "in preparation",
      })),
      itSpecialties: Object.keys(IT_ROLES).map((role) => ({
        role: role as ItRole,
        state: "in preparation",
      })),
      specialties: Object.keys(DOMAINS).flatMap((domain) =>
        serviceTypes.map((serviceType) => ({
          domain: domain as Domain,
          serviceType,
          state: "in preparation" as TrackState,
          gaps: specialtyGaps(false, [], serviceType, new Date()),
        })),
      ),
    }),
    registry: async () => null,
  };
}
const registryColumns = `id,staff_id AS "staffId",staff_role AS "staffRole",
 domain,service_type AS "serviceType",starts_at AS "startsAt",ends_at AS "endsAt",
 loaded_cost_cents AS "loadedCostCents",capacity_minutes AS "capacityMinutes",
 committed_minutes AS "committedMinutes",backup_staff_id AS "backupStaffId",
 qualification_ref AS "qualificationRef",agreement_ref AS "agreementRef",
 conflict_review_ref AS "conflictReviewRef",verified_by AS "verifiedBy",
 verified_at AS "verifiedAt",retired_at AS "retiredAt"`;
export function trackStore(pool: Pool): TrackStore {
  return {
    async snapshot() {
      const lessons = await pool.query<{
        id: string;
        goals: Goal[];
        domains: Domain[];
      }>(
        `SELECT id,goals,domains FROM content_versions
         WHERE kind='lesson' AND state='published'
           AND requires_qualified_signoff=true`,
      );
      const experts = await pool.query<ExpertRecord>(
        `SELECT ${registryColumns} FROM expert_registry`,
      );
      const now = new Date();
      const foundation = Object.keys(GOALS).map((goal) => ({
        goal: goal as Goal,
        state: foundationIds.every((id) =>
          lessons.rows.some(
            (lesson) => lesson.id === id && lesson.goals.includes(goal as Goal),
          ),
        )
          ? ("available" as TrackState)
          : ("in preparation" as TrackState),
      }));
      const specialties = Object.keys(DOMAINS).flatMap((domain) =>
        serviceTypes.map((serviceType) => {
          const contentReady = lessons.rows.some((lesson) =>
            lesson.domains.includes(domain as Domain),
          );
          const records = experts.rows.filter(
            (expert) =>
              expert.domain === domain && expert.serviceType === serviceType,
          );
          return {
            domain: domain as Domain,
            serviceType,
            state: specialtyState(contentReady, records, now),
            gaps: specialtyGaps(contentReady, records, serviceType, now),
          };
        }),
      );
      // No IT-role-specific qualified content and capacity registry exists yet.
      // Published synthetic exercises cannot establish a specialist service.
      const itSpecialties = Object.keys(IT_ROLES).map((role) => ({
        role: role as ItRole,
        state: "in preparation" as TrackState,
      }));
      return { foundation, itSpecialties, specialties };
    },
    async registry(token) {
      const result = await pool.query<ExpertRecord & { allowed: boolean }>(
        `SELECT access.allowed, roster.* FROM (
           SELECT EXISTS(
             SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff'
               AND s.role IN ('operator','platform_admin')
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
           ) AS allowed
         ) access LEFT JOIN LATERAL (
           SELECT ${registryColumns} FROM expert_registry
           WHERE access.allowed ORDER BY domain,service_type,starts_at
         ) roster ON true`,
        [hash(token)],
      );
      if (!result.rows[0]?.allowed) return null;
      return result.rows
        .filter((row) => row.id !== null)
        .map(({ allowed: _allowed, ...record }) => record);
    },
  };
}
