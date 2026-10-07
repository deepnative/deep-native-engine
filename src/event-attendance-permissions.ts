import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { EventCancellationFailure } from "./event-cancellation-lifetime.ts";
import {
  attendanceChecked,
  attendanceId,
  type AttendancePermission,
} from "./event-attendance-values.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
  type AttendanceContext,
  type AttendanceSource,
} from "./event-attendance-transaction.ts";
import {
  attendanceCreation,
  attendanceLocal,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";

async function permission(
  context: AttendanceContext,
  source: AttendanceSource,
  id: string,
): Promise<AttendancePermission> {
  const row = (
    await context.tx.query<
      Omit<AttendancePermission, "eventId" | "eventVersion" | "title">
    >(
      `SELECT id,registration_id AS "registrationId",administrator_id AS "administratorId",starts_at AS "startsAt",
       expires_at AS "expiresAt",created_at AS "createdAt",withdrawn_at AS "withdrawnAt"
       FROM private_event_attendance_permissions WHERE id=$1 AND registration_id=$2 AND member_id=$3 AND workspace_id=$4 FOR UPDATE`,
      [id, source.registrationId, context.actorId, source.workspaceId],
    )
  ).rows[0];
  if (!row) return attendanceDeny();
  return {
    ...row,
    eventId: source.eventId,
    eventVersion: source.eventVersion,
    title: source.title,
  };
}
export { permission as attendanceOwnedPermission };
async function original(
  context: AttendanceContext,
  source: AttendanceSource,
  key: string,
  kind: "permit" | "withdraw",
  instructionHash: string,
) {
  // Discovery is not authority. Lock the exact owned retained receipt before
  // the global key, including a receipt whose permission was withdrawn.
  const locator = (
    await context.tx.query<{ permissionId: string | null }>(
      `SELECT permission_id AS "permissionId" FROM private_event_attendance_operations
       WHERE operation_id=$1 AND actor_id=$2 AND workspace_id=$3 AND registration_id=$4`,
      [key, context.actorId, source.workspaceId, source.registrationId],
    )
  ).rows[0];
  if (locator?.permissionId)
    await permission(context, source, locator.permissionId);
  // Key locking follows actors/workspace/inventory/registration/permission. No automatic
  // redispatch, new instruction or renewed deadline is introduced on recovery.
  await context.tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [key],
  );
  const row = (
    await context.tx.query<{
      actorId: string | null;
      workspaceId: string | null;
      registrationId: string | null;
      kind: string | null;
      instructionHash: string | null;
      permissionId: string | null;
    }>(
      `SELECT actor_id AS "actorId",workspace_id AS "workspaceId",registration_id AS "registrationId",kind,
     instruction_hash AS "instructionHash",permission_id AS "permissionId"
     FROM private_event_attendance_operations WHERE operation_id=$1 FOR UPDATE`,
      [key],
    )
  ).rows[0];
  if (!row) return null;
  if (
    row.actorId !== context.actorId ||
    row.workspaceId !== source.workspaceId ||
    row.registrationId !== source.registrationId ||
    row.kind !== kind ||
    row.instructionHash !== instructionHash ||
    !row.permissionId
  )
    throw new EventCancellationFailure("conflict");
  return permission(context, source, row.permissionId);
}
async function reserve(
  context: AttendanceContext,
  source: AttendanceSource,
  key: string,
  kind: "permit" | "withdraw",
  instructionHash: string,
  permissionId: string,
) {
  await context.tx.query(
    `INSERT INTO private_event_attendance_operations(operation_id,actor_id,workspace_id,registration_id,kind,instruction_hash,permission_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      key,
      context.actorId,
      source.workspaceId,
      source.registrationId,
      kind,
      instructionHash,
      permissionId,
    ],
  );
}

export async function attendancePermit(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  key: string,
  input: unknown,
) {
  const checked = attendanceChecked(input);
  if (!attendanceId(key) || !checked) return { kind: "invalid" as const };
  if (!attendanceCreation(options)) return { kind: "denied" as const };
  return attendanceExecute(pool, token, true, async (context) => {
    const actors = await attendanceActors(
      context,
      [checked.administratorId],
      "member",
    );
    const source = await attendanceSource(
      context,
      checked.registrationId,
      context.actorId,
    );
    const existing = (
      await context.tx.query(
        `SELECT id FROM private_event_attendance_permissions WHERE registration_id=$1 AND withdrawn_at IS NULL FOR UPDATE`,
        [source.registrationId],
      )
    ).rows;
    const observed = (
      await context.tx.query(
        "SELECT id FROM private_event_attendance_observations WHERE registration_id=$1 FOR UPDATE",
        [source.registrationId],
      )
    ).rows;
    const digest = hash(JSON.stringify(checked));
    const saved = await original(context, source, key, "permit", digest);
    if (saved) return { kind: "permit" as const, permission: saved };
    const administrator = actors.principals.get(checked.administratorId);
    if (
      !administrator ||
      administrator.kind !== "staff" ||
      administrator.revoked !== null ||
      actors.profiles.get(administrator.id) !== "platform_admin"
    )
      return attendanceDeny();
    context.expires.push(administrator.expires, new Date(checked.expiresAt));
    const now = await context.tx.observe(context.expires);
    if (
      source.withdrawnAt ||
      source.cancelledAt ||
      source.eventId !== checked.eventId ||
      source.eventVersion !== checked.eventVersion ||
      source.title !== checked.title ||
      source.startsAt.toISOString() !== checked.eventStartsAt ||
      source.endsAt.toISOString() !== checked.eventEndsAt ||
      +new Date(checked.expiresAt) > +context.enteredAt + 3600000 ||
      +new Date(checked.startsAt) < +source.startsAt ||
      +new Date(checked.expiresAt) > +source.endsAt ||
      context.expires.some(
        (expiry) => +new Date(checked.expiresAt) > +expiry,
      ) ||
      +new Date(checked.expiresAt) <= +now
    )
      return attendanceDeny();
    if (existing.length || observed.length)
      throw new EventCancellationFailure("conflict");
    const id = randomUUID();
    await context.tx.query(
      `INSERT INTO private_event_attendance_permissions(id,registration_id,workspace_id,member_id,administrator_id,starts_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        source.registrationId,
        source.workspaceId,
        context.actorId,
        checked.administratorId,
        checked.startsAt,
        checked.expiresAt,
      ],
    );
    await reserve(context, source, key, "permit", digest, id);
    return {
      kind: "permit" as const,
      permission: await permission(context, source, id),
    };
  });
}

export async function attendanceWithdraw(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  key: string,
  permissionId: string,
) {
  if (!attendanceId(key) || !attendanceId(permissionId))
    return { kind: "invalid" as const };
  if (!attendanceLocal(options)) return { kind: "denied" as const };
  return attendanceExecute(pool, token, true, async (context) => {
    await attendanceActors(context, [], "member");
    const locator = (
      await context.tx.query<{ registrationId: string }>(
        `SELECT registration_id AS "registrationId" FROM private_event_attendance_permissions WHERE id=$1 AND member_id=$2`,
        [permissionId, context.actorId],
      )
    ).rows[0];
    if (!locator) return attendanceDeny();
    const source = await attendanceSource(
      context,
      locator.registrationId,
      context.actorId,
    );
    const digest = hash(JSON.stringify({ permissionId }));
    await permission(context, source, permissionId);
    const saved = await original(context, source, key, "withdraw", digest);
    if (saved) return { kind: "withdraw" as const, permission: saved };
    await context.tx.query(
      "UPDATE private_event_attendance_permissions SET withdrawn_at=clock_timestamp() WHERE id=$1 AND withdrawn_at IS NULL",
      [permissionId],
    );
    await reserve(context, source, key, "withdraw", digest, permissionId);
    return {
      kind: "withdraw" as const,
      permission: await permission(context, source, permissionId),
    };
  });
}
