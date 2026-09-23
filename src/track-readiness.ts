import type { Pool } from "pg";
import { DOMAINS, GOALS, type Domain, type Goal } from "./content.ts";
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
  specialties: Array<{
    domain: Domain;
    serviceType: ExpertRecord["serviceType"];
    state: TrackState;
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
  const eligible = records.filter((record) => expertEligible(record, now));
  if (!eligible.length) return "in preparation";
  const minutes = eligible.reduce(
    (total, record) => total + record.capacityMinutes - record.committedMinutes,
    0,
  );
  return minutes >= 60 ? "available" : "limited coverage";
}
export function disabledTrackStore(): TrackStore {
  return {
    snapshot: async () => ({
      foundation: Object.keys(GOALS).map((goal) => ({
        goal: goal as Goal,
        state: "in preparation",
      })),
      specialties: Object.keys(DOMAINS).flatMap((domain) =>
        serviceTypes.map((serviceType) => ({
          domain: domain as Domain,
          serviceType,
          state: "in preparation" as TrackState,
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
        serviceTypes.map((serviceType) => ({
          domain: domain as Domain,
          serviceType,
          state: specialtyState(
            lessons.rows.some((lesson) =>
              lesson.domains.includes(domain as Domain),
            ),
            experts.rows.filter(
              (expert) =>
                expert.domain === domain && expert.serviceType === serviceType,
            ),
            now,
          ),
        })),
      );
      return { foundation, specialties };
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
