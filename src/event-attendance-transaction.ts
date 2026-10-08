import type { Pool } from "pg";
import { hash } from "./store.ts";
import { sampleToken } from "./sample-feedback-values.ts";
import {
  eventCancellationTransaction,
  EventCancellationFailure,
  type EventCancellationTransaction,
} from "./event-cancellation-lifetime.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";

export interface AttendanceContext {
  tx: EventCancellationTransaction;
  actorId: string;
  credentialHash: string;
  expires: Date[];
  enteredAt: Date;
}
export const attendanceDeny = (): never => {
  throw new EventCancellationFailure("denied");
};
export async function attendanceExecute<T>(
  pool: Pool,
  token: string,
  writing: boolean,
  use: (context: AttendanceContext) => Promise<T>,
): Promise<EventCancellationResult<T>> {
  if (!sampleToken(token)) return { kind: "denied" };
  return eventCancellationTransaction(pool, writing, async (tx) => {
    // Discovery is never authority. The complete actor set is locked and
    // re-read before any workspace, inventory or exact registration locks.
    const identity = (
      await tx.query<{ id: string; expires: Date }>(
        `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1
         AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [hash(token)],
      )
    ).rows[0];
    if (!identity) return attendanceDeny();
    const expires = [identity.expires];
    const context: AttendanceContext = {
      tx,
      actorId: identity.id,
      credentialHash: hash(token),
      expires,
      enteredAt: await tx.observe(expires),
    };
    const result = await use(context);
    await tx.observe(expires);
    return () => result;
  });
}
export interface AttendanceActor {
  id: string;
  kind: string;
  expires: Date;
  revoked: Date | null;
}
export async function attendanceActors(
  context: AttendanceContext,
  ids: string[],
  role: "member" | "platform_admin",
) {
  const ordered = [...new Set([context.actorId, ...ids])].sort();
  const principals = new Map<string, AttendanceActor>();
  for (const id of ordered) {
    const row = (
      await context.tx.query<AttendanceActor>(
        `SELECT id,kind,expires_at AS expires,revoked_at AS revoked FROM principals
         WHERE id=$1 AND ($2::text IS NULL OR token_hash=$2) FOR SHARE`,
        [id, id === context.actorId ? context.credentialHash : null],
      )
    ).rows[0];
    if (row) principals.set(id, row);
  }
  const actor = principals.get(context.actorId);
  if (
    !actor ||
    actor.revoked !== null ||
    actor.kind !== (role === "member" ? "member" : "staff")
  )
    return attendanceDeny();
  const profiles = new Map(
    (
      await context.tx.query<{ id: string; role: string }>(
        `SELECT principal_id AS id,role FROM staff_profiles
         WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE`,
        [ordered],
      )
    ).rows.map((row) => [row.id, row.role]),
  );
  if (role === "platform_admin" && profiles.get(actor.id) !== role)
    return attendanceDeny();
  context.expires.push(actor.expires);
  await context.tx.observe(context.expires);
  return { principals, profiles };
}
export interface AttendanceSource {
  registrationId: string;
  memberId: string;
  workspaceId: string;
  eventId: string;
  eventVersion: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  withdrawnAt: Date | null;
  cancelledAt: Date | null;
}
export async function attendanceSource(
  context: AttendanceContext,
  registrationId: string,
  memberId: string,
): Promise<AttendanceSource> {
  const locator = (
    await context.tx.query<{
      workspaceId: string;
      eventId: string;
      eventVersion: number;
    }>(
      `SELECT workspace_id AS "workspaceId",event_id AS "eventId",event_version AS "eventVersion"
       FROM private_event_enrollments WHERE id=$1 AND member_id=$2`,
      [registrationId, memberId],
    )
  ).rows[0];
  if (!locator) return attendanceDeny();
  const workspace = (
    await context.tx.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE id=$1 AND owner_principal_id=$2
       AND deleting_at IS NULL FOR UPDATE`,
      [locator.workspaceId, memberId],
    )
  ).rows[0];
  if (!workspace) return attendanceDeny();
  const inventory = (
    await context.tx.query<{ title: string; startsAt: Date; endsAt: Date }>(
      `SELECT title,starts_at AS "startsAt",ends_at AS "endsAt" FROM private_event_inventory
       WHERE event_id=$1 AND event_version=$2 FOR UPDATE`,
      [locator.eventId, locator.eventVersion],
    )
  ).rows[0];
  if (!inventory) return attendanceDeny();
  const cancellation = (
    await context.tx.query<{ cancelledAt: Date | null }>(
      `SELECT c.cancelled_at AS "cancelledAt" FROM private_event_cancellation_state s
       LEFT JOIN private_event_cancellations c ON c.id=s.cancellation_id
       WHERE s.event_id=$1 AND s.event_version=$2 FOR SHARE OF s`,
      [locator.eventId, locator.eventVersion],
    )
  ).rows[0];
  if (!cancellation) return attendanceDeny();
  const registration = (
    await context.tx.query<{ withdrawnAt: Date | null }>(
      `SELECT withdrawn_at AS "withdrawnAt" FROM private_event_enrollments
       WHERE id=$1 AND member_id=$2 AND workspace_id=$3 AND event_id=$4 AND event_version=$5
       FOR UPDATE`,
      [
        registrationId,
        memberId,
        workspace.id,
        locator.eventId,
        locator.eventVersion,
      ],
    )
  ).rows[0];
  if (!registration) return attendanceDeny();
  await context.tx.observe(context.expires);
  return {
    registrationId,
    memberId,
    workspaceId: workspace.id,
    eventId: locator.eventId,
    eventVersion: locator.eventVersion,
    ...inventory,
    ...registration,
    ...cancellation,
  };
}
