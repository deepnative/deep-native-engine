import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hash } from "./store.ts";
import { EventCancellationFailure } from "./event-cancellation-lifetime.ts";
import {
  attendanceId,
  attendanceObservationChecked,
  type AttendanceObservation,
  type AttendanceObservationChecked,
  type AttendancePermission,
} from "./event-attendance-values.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
  type AttendanceContext,
} from "./event-attendance-transaction.ts";
import {
  attendanceCreation,
  attendanceLocal,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";

export async function attendanceProtectedPermission(
  context: AttendanceContext,
  permissionId: string,
) {
  const locator = (
    await context.tx.query<{
      registrationId: string;
      memberId: string;
      administratorId: string | null;
    }>(
      `SELECT registration_id AS "registrationId",member_id AS "memberId",administrator_id AS "administratorId"
     FROM private_event_attendance_permissions WHERE id=$1`,
      [permissionId],
    )
  ).rows[0];
  if (!locator || locator.administratorId !== context.actorId)
    return attendanceDeny();
  const actors = await attendanceActors(
    context,
    [locator.memberId],
    "platform_admin",
  );
  const member = actors.principals.get(locator.memberId);
  if (!member || member.kind !== "member" || member.revoked !== null)
    return attendanceDeny();
  context.expires.push(member.expires);
  await context.tx.observe(context.expires);
  const source = await attendanceSource(
    context,
    locator.registrationId,
    locator.memberId,
  );
  const permission = (
    await context.tx.query<
      Omit<AttendancePermission, "eventId" | "eventVersion" | "title">
    >(
      `SELECT id,registration_id AS "registrationId",administrator_id AS "administratorId",starts_at AS "startsAt",
     expires_at AS "expiresAt",created_at AS "createdAt",withdrawn_at AS "withdrawnAt"
     FROM private_event_attendance_permissions WHERE id=$1 AND registration_id=$2 AND member_id=$3
     AND workspace_id=$4 FOR UPDATE`,
      [
        permissionId,
        source.registrationId,
        source.memberId,
        source.workspaceId,
      ],
    )
  ).rows[0];
  if (
    !permission ||
    permission.administratorId !== context.actorId ||
    permission.withdrawnAt ||
    source.withdrawnAt ||
    source.cancelledAt
  )
    return attendanceDeny();
  context.expires.push(permission.expiresAt, source.endsAt);
  const now = await context.tx.observe(context.expires);
  if (+permission.startsAt > +now || +source.startsAt > +now)
    return attendanceDeny();
  return {
    source,
    permission: {
      ...permission,
      eventId: source.eventId,
      eventVersion: source.eventVersion,
      title: source.title,
    },
  };
}
const checkedPermission = (
  permission: AttendancePermission,
): AttendanceObservationChecked => ({
  permissionId: permission.id,
  registrationId: permission.registrationId,
  eventId: permission.eventId,
  eventVersion: permission.eventVersion,
  startsAt: permission.startsAt.toISOString(),
  expiresAt: permission.expiresAt.toISOString(),
});
export async function attendanceObservationCheck(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  permissionId: string,
) {
  if (!attendanceId(permissionId)) return { kind: "invalid" as const };
  if (!attendanceCreation(options)) return { kind: "denied" as const };
  return attendanceExecute(pool, token, false, async (context) => {
    const { permission } = await attendanceProtectedPermission(
      context,
      permissionId,
    );
    return checkedPermission(permission);
  });
}
export async function attendanceStaffPermission(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  permissionId: string,
) {
  if (!attendanceLocal(options) || !attendanceId(permissionId))
    return { kind: "denied" as const };
  return attendanceExecute(
    pool,
    token,
    false,
    async (context) =>
      (await attendanceProtectedPermission(context, permissionId)).permission,
  );
}
export async function attendanceObserve(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  key: string,
  input: unknown,
) {
  const checked = attendanceObservationChecked(input);
  if (!checked || !attendanceId(key)) return { kind: "invalid" as const };
  if (!attendanceCreation(options)) return { kind: "denied" as const };
  return attendanceExecute(pool, token, true, async (context) => {
    const { source, permission } = await attendanceProtectedPermission(
      context,
      checked.permissionId,
    );
    if (
      JSON.stringify(checkedPermission(permission)) !== JSON.stringify(checked)
    )
      throw new EventCancellationFailure("conflict");
    const observation = (
      await context.tx.query<Omit<AttendanceObservation, "attribution">>(
        `SELECT id,permission_id AS "permissionId",registration_id AS "registrationId",recorded_at AS "recordedAt"
       FROM private_event_attendance_observations WHERE registration_id=$1 FOR UPDATE`,
        [source.registrationId],
      )
    ).rows[0];
    await context.tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [key],
    );
    const saved = (
      await context.tx.query<{
        actorId: string | null;
        registrationId: string | null;
        kind: string | null;
        instructionHash: string | null;
        observationId: string | null;
      }>(
        `SELECT actor_id AS "actorId",registration_id AS "registrationId",kind,instruction_hash AS "instructionHash",
       observation_id AS "observationId" FROM private_event_attendance_operations WHERE operation_id=$1 FOR UPDATE`,
        [key],
      )
    ).rows[0];
    const instructionHash = hash(JSON.stringify(checked));
    if (saved) {
      if (
        saved.actorId !== context.actorId ||
        saved.registrationId !== source.registrationId ||
        saved.kind !== "observe" ||
        saved.instructionHash !== instructionHash ||
        !observation ||
        saved.observationId !== observation.id ||
        observation.permissionId !== permission.id
      )
        throw new EventCancellationFailure("conflict");
      return {
        kind: "observe" as const,
        observation: {
          ...observation,
          attribution: "Local platform administrator" as const,
        },
      };
    }
    if (observation) throw new EventCancellationFailure("conflict");
    const recorded = (
      await context.tx.query<Omit<AttendanceObservation, "attribution">>(
        `INSERT INTO private_event_attendance_observations(id,permission_id,registration_id,workspace_id,member_id,administrator_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,permission_id AS "permissionId",registration_id AS "registrationId",recorded_at AS "recordedAt"`,
        [
          randomUUID(),
          permission.id,
          source.registrationId,
          source.workspaceId,
          source.memberId,
          context.actorId,
        ],
      )
    ).rows[0];
    if (!recorded) throw new EventCancellationFailure("unavailable");
    await context.tx.query(
      `INSERT INTO private_event_attendance_operations(operation_id,actor_id,workspace_id,registration_id,kind,instruction_hash,permission_id,observation_id)
       VALUES($1,$2,$3,$4,'observe',$5,$6,$7)`,
      [
        key,
        context.actorId,
        source.workspaceId,
        source.registrationId,
        instructionHash,
        permission.id,
        recorded.id,
      ],
    );
    return {
      kind: "observe" as const,
      observation: {
        ...recorded,
        attribution: "Local platform administrator" as const,
      },
    };
  });
}
