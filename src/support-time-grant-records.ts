import { randomUUID } from "node:crypto";
import type { SupportGrantConnection } from "./support-grant-records.ts";
import type { SupportTimeGrantInput } from "./support-time.ts";

/** The caller owns current-authority/source locks and one transaction. These
 * shared CLI/browser writers neither allocate minutes nor broaden permission. */
export async function createSupportTimeGrantRecord(
  connection: SupportGrantConnection,
  actorId: string,
  memberId: string,
  input: SupportTimeGrantInput,
) {
  const id = randomUUID();
  await connection.query(
    "INSERT INTO support_time_grants(id,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      input.allocationId,
      input.requestId,
      input.staffId,
      input.role,
      input.startsAt,
      input.expiresAt,
      actorId,
      input.idempotencyKey,
    ],
  );
  await connection.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'grant-created')",
    [randomUUID(), input.allocationId, memberId, actorId],
  );
  return id;
}

export async function revokeSupportTimeGrantRecord(
  connection: SupportGrantConnection,
  actorId: string,
  memberId: string,
  allocationId: string,
  grantId: string,
) {
  await connection.query(
    "UPDATE support_time_grants SET revoked_at=clock_timestamp() WHERE id=$1",
    [grantId],
  );
  await connection.query(
    "INSERT INTO support_time_events(id,allocation_id,member_id,actor_id,action) VALUES($1,$2,$3,$4,'grant-revoked')",
    [randomUUID(), allocationId, memberId, actorId],
  );
}
