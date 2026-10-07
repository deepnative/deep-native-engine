import type { Pool } from "pg";
import type { ApplicationMode } from "./adapters.ts";
import {
  attendanceId,
  attendanceScope,
  type AttendanceChecked,
  type AttendanceMemberView,
  type AttendanceObservation,
  type AttendancePermission,
} from "./event-attendance-values.ts";
import type { EventCancellationResult } from "./event-cancellation-values.ts";
import {
  attendanceActors,
  attendanceDeny,
  attendanceExecute,
  attendanceSource,
  type AttendanceContext,
  type AttendanceSource,
} from "./event-attendance-transaction.ts";

export interface AttendanceOptions {
  mode: ApplicationMode;
  enabled: boolean;
  registration: boolean;
}
export const attendanceLocal = (options: AttendanceOptions) =>
  options.mode === "demo" || options.mode === "test";
export const attendanceCreation = (options: AttendanceOptions) =>
  attendanceLocal(options) && options.enabled && options.registration;

export async function attendanceMemberView(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  registrationId: string,
): Promise<EventCancellationResult<AttendanceMemberView>> {
  if (!attendanceLocal(options) || !attendanceId(registrationId))
    return { kind: "denied" };
  return attendanceExecute(pool, token, false, async (context) => {
    await attendanceActors(context, [], "member");
    const source = await attendanceSource(
      context,
      registrationId,
      context.actorId,
    );
    return attendanceReadOwned(context, source, options);
  });
}

export async function attendanceReadOwned(
  context: AttendanceContext,
  source: AttendanceSource,
  options: AttendanceOptions,
): Promise<AttendanceMemberView> {
  const registrationId = source.registrationId;
  const permission = (
    await context.tx.query<
      Omit<AttendancePermission, "eventId" | "eventVersion" | "title">
    >(
      `SELECT id,registration_id AS "registrationId",administrator_id AS "administratorId",
         starts_at AS "startsAt",expires_at AS "expiresAt",created_at AS "createdAt",withdrawn_at AS "withdrawnAt"
         FROM private_event_attendance_permissions WHERE registration_id=$1 AND member_id=$2
         AND workspace_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [registrationId, context.actorId, source.workspaceId],
    )
  ).rows[0];
  const observation = (
    await context.tx.query<Omit<AttendanceObservation, "attribution">>(
      `SELECT id,permission_id AS "permissionId",registration_id AS "registrationId",recorded_at AS "recordedAt"
         FROM private_event_attendance_observations WHERE registration_id=$1 AND member_id=$2
         AND workspace_id=$3 FOR UPDATE`,
      [registrationId, context.actorId, source.workspaceId],
    )
  ).rows[0];
  return {
    registrationId,
    eventId: source.eventId,
    eventVersion: source.eventVersion,
    title: source.title,
    eventStartsAt: source.startsAt,
    eventEndsAt: source.endsAt,
    registrationWithdrawnAt: source.withdrawnAt,
    cancelledAt: source.cancelledAt,
    permission: permission
      ? {
          ...permission,
          eventId: source.eventId,
          eventVersion: source.eventVersion,
          title: source.title,
        }
      : null,
    observation: observation
      ? { ...observation, attribution: "Local platform administrator" }
      : null,
    creationEnabled: attendanceCreation(options),
  };
}

export async function attendanceAdministratorReference(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
): Promise<
  EventCancellationResult<{ reference: string; creationEnabled: boolean }>
> {
  if (!attendanceLocal(options)) return { kind: "denied" };
  return attendanceExecute(pool, token, false, async (context) => {
    await attendanceActors(context, [], "platform_admin");
    return {
      reference: context.actorId,
      creationEnabled: attendanceCreation(options),
    };
  });
}

export async function attendancePermissionCheck(
  pool: Pool,
  options: AttendanceOptions,
  token: string,
  input: unknown,
): Promise<EventCancellationResult<AttendanceChecked>> {
  const scope = attendanceScope(input);
  if (!scope) return { kind: "invalid" };
  if (!attendanceCreation(options)) return { kind: "denied" };
  return attendanceExecute(pool, token, false, async (context) => {
    const actors = await attendanceActors(
      context,
      [scope.administratorId],
      "member",
    );
    const administrator = actors.principals.get(scope.administratorId);
    if (
      !administrator ||
      administrator.kind !== "staff" ||
      administrator.revoked !== null ||
      actors.profiles.get(administrator.id) !== "platform_admin"
    )
      return attendanceDeny();
    context.expires.push(administrator.expires);
    await context.tx.observe(context.expires);
    const source = await attendanceSource(
      context,
      scope.registrationId,
      context.actorId,
    );
    if (source.withdrawnAt || source.cancelledAt) return attendanceDeny();
    const now = await context.tx.observe(context.expires);
    const startsAt = new Date(Math.max(+source.startsAt, +now));
    const expiresAt = new Date(
      Math.min(
        +source.endsAt,
        +context.enteredAt + 3600000,
        ...context.expires.map(Number),
      ),
    );
    if (+startsAt >= +expiresAt) return attendanceDeny();
    return {
      ...scope,
      eventId: source.eventId,
      eventVersion: source.eventVersion,
      title: source.title,
      eventStartsAt: source.startsAt.toISOString(),
      eventEndsAt: source.endsAt.toISOString(),
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  });
}
