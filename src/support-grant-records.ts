import { randomUUID } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

export interface SupportGrantConnection {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
export interface SupportGrantRecordInput {
  requestId: string;
  staffId: string;
  role: "operator" | "platform_admin";
  startsAt: Date;
  expiresAt: Date;
  idempotencyKey: string;
}
export function sameSupportGrant(
  existing: Omit<SupportGrantRecordInput, "idempotencyKey" | "role"> & {
    role: string;
    revokedAt: Date | null;
  },
  input: SupportGrantRecordInput,
) {
  return (
    existing.requestId === input.requestId &&
    existing.staffId === input.staffId &&
    existing.role === input.role &&
    existing.startsAt.valueOf() === input.startsAt.valueOf() &&
    existing.expiresAt.valueOf() === input.expiresAt.valueOf() &&
    !existing.revokedAt
  );
}
async function event(
  connection: SupportGrantConnection,
  actorId: string,
  requestId: string,
  grantId: string,
  action: "grant-created" | "grant-revoked",
) {
  await connection.query(
    `INSERT INTO support_request_events(id,request_id,actor_id,grant_id,action,message_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING request_id AS "requestId",id AS "eventId",occurred_at AS "occurredAt",message_id AS "messageId"`,
    [randomUUID(), requestId, actorId, grantId, action, null],
  );
}
/** Caller owns authority locks and the transaction; persistence and audit never
 * acquire a second connection or reinterpret the caller's permission policy. */
export async function createSupportGrantRecord(
  connection: SupportGrantConnection,
  actorId: string,
  input: SupportGrantRecordInput,
) {
  const id = randomUUID();
  await connection.query(
    `INSERT INTO support_request_grants(id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.requestId,
      input.staffId,
      input.role,
      input.startsAt,
      input.expiresAt,
      actorId,
      input.idempotencyKey,
    ],
  );
  await event(connection, actorId, input.requestId, id, "grant-created");
  return id;
}
export async function revokeSupportGrantRecord(
  connection: SupportGrantConnection,
  actorId: string,
  requestId: string,
  grantId: string,
) {
  await connection.query(
    "UPDATE support_request_grants SET revoked_at=clock_timestamp() WHERE id=$1",
    [grantId],
  );
  await event(connection, actorId, requestId, grantId, "grant-revoked");
}
