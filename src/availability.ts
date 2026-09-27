import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";

export interface AvailableSlot {
  id: string;
  domain: string;
  serviceType: "coaching" | "formal-review";
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityStore {
  list(): Promise<AvailableSlot[]>;
  create(
    operatorToken: string,
    registryId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<string | null>;
  retire(operatorToken: string, slotId: string): Promise<boolean>;
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validSlotWindow(startsAt: Date, endsAt: Date, now: Date) {
  return (
    startsAt instanceof Date &&
    endsAt instanceof Date &&
    Number.isFinite(startsAt.getTime()) &&
    Number.isFinite(endsAt.getTime()) &&
    startsAt > now &&
    endsAt.getTime() - startsAt.getTime() === 60 * 60_000
  );
}

export function localSlotTime(date: Date, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "longOffset",
    }).format(date);
  } catch {
    return null;
  }
}

export function disabledAvailabilityStore(): AvailabilityStore {
  return {
    list: async () => [],
    create: async () => null,
    retire: async () => false,
  };
}

export function availabilityStore(pool: Pool): AvailabilityStore {
  return {
    async list() {
      const result = await pool.query<AvailableSlot>(
        `SELECT s.id,e.domain,e.service_type AS "serviceType",
                s.starts_at AS "startsAt",s.ends_at AS "endsAt"
         FROM expert_availability_slots s
         JOIN expert_registry e ON e.id=s.expert_registry_id
         JOIN principals primary_staff ON primary_staff.id=e.staff_id
         WHERE s.retired_at IS NULL AND s.starts_at>CURRENT_TIMESTAMP
           AND NOT EXISTS (
             SELECT 1 FROM synthetic_slot_holds held
             WHERE held.slot_id=s.id AND held.state='held'
           )
           AND primary_staff.kind='staff'
           AND primary_staff.revoked_at IS NULL
           AND primary_staff.expires_at>CURRENT_TIMESTAMP
           AND e.verified_by IS NOT NULL AND e.verified_at IS NOT NULL
           AND e.verified_at<=CURRENT_TIMESTAMP
           AND e.qualification_ref<>'' AND e.agreement_ref<>''
           AND e.conflict_review_ref<>'' AND e.retired_at IS NULL
           AND e.backup_staff_id IS NOT NULL
           AND e.starts_at<=CURRENT_TIMESTAMP
           AND e.starts_at<=s.starts_at AND e.ends_at>=s.ends_at
           AND e.capacity_minutes-e.committed_minutes >= (
             SELECT COUNT(*) * 60 FROM expert_availability_slots reserved
             WHERE reserved.expert_registry_id=e.id
               AND reserved.retired_at IS NULL
               AND reserved.starts_at>CURRENT_TIMESTAMP
           )
           AND EXISTS (
             SELECT 1 FROM expert_registry b
             JOIN principals backup_staff ON backup_staff.id=b.staff_id
             WHERE b.staff_id=e.backup_staff_id
               AND backup_staff.kind='staff'
               AND backup_staff.revoked_at IS NULL
               AND backup_staff.expires_at>CURRENT_TIMESTAMP
               AND b.domain=e.domain AND b.service_type=e.service_type
               AND b.verified_by IS NOT NULL AND b.verified_at IS NOT NULL
               AND b.verified_at<=CURRENT_TIMESTAMP
               AND b.qualification_ref<>'' AND b.agreement_ref<>''
               AND b.conflict_review_ref<>'' AND b.retired_at IS NULL
               AND b.starts_at<=s.starts_at AND b.ends_at>=s.ends_at
               AND b.capacity_minutes-b.committed_minutes >= (
                 SELECT COUNT(*) * 60 FROM expert_availability_slots reserved
                 JOIN expert_registry source ON source.id=reserved.expert_registry_id
                 WHERE source.backup_staff_id=b.staff_id
                   AND source.domain=b.domain
                   AND source.service_type=b.service_type
                   AND reserved.retired_at IS NULL
                   AND reserved.starts_at>CURRENT_TIMESTAMP
               )
               AND b.starts_at<=CURRENT_TIMESTAMP
           )
         ORDER BY s.starts_at,s.id`,
      );
      return result.rows;
    },
    async create(operatorToken, registryId, startsAt, endsAt) {
      if (
        typeof operatorToken !== "string" ||
        !operatorToken.trim() ||
        typeof registryId !== "string" ||
        !uuid.test(registryId) ||
        !validSlotWindow(startsAt, endsAt, new Date())
      )
        return null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const authorized = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p
             JOIN staff_profiles sp ON sp.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff'
               AND sp.role IN ('operator','platform_admin')
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`,
            [hash(operatorToken)],
          )
        ).rows[0];
        if (!authorized) {
          await client.query("ROLLBACK");
          return null;
        }
        const expert = (
          await client.query<{
            staff_id: string;
            backup_staff_id: string | null;
          }>(
            `SELECT staff_id,backup_staff_id FROM expert_registry WHERE id=$1`,
            [registryId],
          )
        ).rows[0];
        if (!expert) {
          await client.query("ROLLBACK");
          return null;
        }
        for (const staffId of [
          ...new Set(
            [expert.staff_id, expert.backup_staff_id].filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ].sort()) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [staffId],
          );
        }
        const eligible = (
          await client.query<{ id: string }>(
            `SELECT e.id FROM expert_registry e
             JOIN principals primary_staff ON primary_staff.id=e.staff_id
             WHERE e.id=$1 AND e.verified_by IS NOT NULL
               AND e.verified_at IS NOT NULL AND e.verified_at<=CURRENT_TIMESTAMP
               AND e.retired_at IS NULL
               AND primary_staff.kind='staff'
               AND primary_staff.revoked_at IS NULL
               AND primary_staff.expires_at>CURRENT_TIMESTAMP
               AND e.qualification_ref<>'' AND e.agreement_ref<>''
               AND e.conflict_review_ref<>'' AND e.backup_staff_id IS NOT NULL
               AND e.starts_at<=CURRENT_TIMESTAMP
               AND e.starts_at<=$2 AND e.ends_at>=$3
               AND e.capacity_minutes-e.committed_minutes >= 60 + (
                 SELECT COUNT(*) * 60 FROM expert_availability_slots reserved
                 WHERE reserved.expert_registry_id=e.id
                   AND reserved.retired_at IS NULL
                   AND reserved.starts_at>CURRENT_TIMESTAMP
               )
               AND EXISTS (
                 SELECT 1 FROM expert_registry b
                 JOIN principals backup_staff ON backup_staff.id=b.staff_id
                 WHERE b.staff_id=e.backup_staff_id
                   AND backup_staff.kind='staff'
                   AND backup_staff.revoked_at IS NULL
                   AND backup_staff.expires_at>CURRENT_TIMESTAMP
                   AND b.domain=e.domain AND b.service_type=e.service_type
                   AND b.verified_by IS NOT NULL AND b.verified_at IS NOT NULL
                   AND b.verified_at<=CURRENT_TIMESTAMP
                   AND b.qualification_ref<>'' AND b.agreement_ref<>''
                   AND b.conflict_review_ref<>'' AND b.retired_at IS NULL
                   AND b.starts_at<=CURRENT_TIMESTAMP
                   AND b.starts_at<=$2 AND b.ends_at>=$3
                   AND b.capacity_minutes-b.committed_minutes >= 60 + (
                     SELECT COUNT(*) * 60 FROM expert_availability_slots reserved
                     JOIN expert_registry source ON source.id=reserved.expert_registry_id
                     WHERE source.backup_staff_id=b.staff_id
                       AND source.domain=b.domain
                       AND source.service_type=b.service_type
                       AND reserved.retired_at IS NULL
                       AND reserved.starts_at>CURRENT_TIMESTAMP
                   )
               ) FOR UPDATE OF e`,
            [registryId, startsAt, endsAt],
          )
        ).rows[0];
        const overlap = (
          await client.query<{ id: string }>(
            `SELECT s.id FROM expert_availability_slots s
             JOIN expert_registry e ON e.id=s.expert_registry_id
             WHERE e.staff_id=$1 AND s.retired_at IS NULL
               AND tstzrange(s.starts_at,s.ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
             LIMIT 1`,
            [expert.staff_id, startsAt, endsAt],
          )
        ).rows[0];
        if (!eligible || overlap) {
          await client.query("ROLLBACK");
          return null;
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO expert_availability_slots
           (id,expert_registry_id,starts_at,ends_at,created_by)
           VALUES($1,$2,$3,$4,$5)`,
          [id, registryId, startsAt, endsAt, authorized.id],
        );
        await client.query("COMMIT");
        return id;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async retire(operatorToken, slotId) {
      if (
        typeof operatorToken !== "string" ||
        !operatorToken.trim() ||
        typeof slotId !== "string" ||
        !uuid.test(slotId)
      )
        return false;
      const result = await pool.query(
        `UPDATE expert_availability_slots s
         SET retired_at=CURRENT_TIMESTAMP,version=version+1
         WHERE s.id=$1 AND s.retired_at IS NULL
           AND EXISTS (
             SELECT 1 FROM principals p
             JOIN staff_profiles sp ON sp.principal_id=p.id
             WHERE p.token_hash=$2 AND p.kind='staff'
               AND sp.role IN ('operator','platform_admin')
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
           )`,
        [slotId, hash(operatorToken)],
      );
      return result.rowCount === 1;
    },
  };
}
