import type { EventCancellationResult } from "./event-cancellation-values.ts";

export interface AttendanceScope {
  registrationId: string;
  administratorId: string;
}
export interface AttendanceChecked extends AttendanceScope {
  eventId: string;
  eventVersion: number;
  title: string;
  eventStartsAt: string;
  eventEndsAt: string;
  startsAt: string;
  expiresAt: string;
}
export interface AttendancePermission {
  id: string;
  registrationId: string;
  eventId: string;
  eventVersion: number;
  title: string;
  administratorId: string | null;
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
  withdrawnAt: Date | null;
}
export interface AttendanceObservation {
  id: string;
  permissionId: string;
  registrationId: string;
  recordedAt: Date;
  attribution: "Local platform administrator";
}
export interface AttendanceMemberView {
  registrationId: string;
  eventId: string;
  eventVersion: number;
  title: string;
  eventStartsAt: Date;
  eventEndsAt: Date;
  registrationWithdrawnAt: Date | null;
  cancelledAt: Date | null;
  permission: AttendancePermission | null;
  observation: AttendanceObservation | null;
  creationEnabled: boolean;
}
export interface AttendanceObservationChecked {
  permissionId: string;
  registrationId: string;
  eventId: string;
  eventVersion: number;
  startsAt: string;
  expiresAt: string;
}
export interface AttendanceRemovalChecked {
  registrationId: string;
  observationId: string;
}
export type AttendanceOperationKind =
  "permit" | "withdraw" | "observe" | "remove";
export type AttendanceSavedReceipt =
  | { kind: "permit" | "withdraw"; permission: AttendancePermission }
  | { kind: "observe"; observation: AttendanceObservation }
  | { kind: "remove"; registrationId: string; removed: true };
export interface EventAttendanceStore {
  member(
    token: string,
    registrationId: string,
  ): Promise<EventCancellationResult<AttendanceMemberView>>;
  administrator(
    token: string,
  ): Promise<
    EventCancellationResult<{ reference: string; creationEnabled: boolean }>
  >;
  checkPermission(
    token: string,
    scope: unknown,
  ): Promise<EventCancellationResult<AttendanceChecked>>;
  permit(
    token: string,
    key: string,
    checked: unknown,
  ): Promise<EventCancellationResult<AttendanceSavedReceipt>>;
  permission(
    token: string,
    permissionId: string,
  ): Promise<EventCancellationResult<AttendancePermission>>;
  withdraw(
    token: string,
    key: string,
    permissionId: string,
  ): Promise<EventCancellationResult<AttendanceSavedReceipt>>;
  checkObservation(
    token: string,
    permissionId: string,
  ): Promise<EventCancellationResult<AttendanceObservationChecked>>;
  observe(
    token: string,
    key: string,
    checked: unknown,
  ): Promise<EventCancellationResult<AttendanceSavedReceipt>>;
  checkRemoval(
    token: string,
    observationId: string,
  ): Promise<EventCancellationResult<AttendanceRemovalChecked>>;
  remove(
    token: string,
    key: string,
    checked: unknown,
  ): Promise<EventCancellationResult<AttendanceSavedReceipt>>;
  history(
    token: string,
    cursor?: string,
  ): Promise<
    EventCancellationResult<{
      items: AttendanceMemberView[];
      nextCursor: string | null;
    }>
  >;
  inspect(
    token: string,
    key: string,
    kind: AttendanceOperationKind,
    instruction: unknown,
  ): Promise<EventCancellationResult<AttendanceSavedReceipt | null>>;
}

export const attendanceId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact = (
  value: unknown,
  names: string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  Object.keys(value).every((key) => names.includes(key));
const instant = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length !== 24) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString() === value;
};
export function attendanceScope(value: unknown): AttendanceScope | null {
  return exact(value, ["registrationId", "administratorId"]) &&
    attendanceId(value.registrationId) &&
    attendanceId(value.administratorId)
    ? {
        registrationId: value.registrationId,
        administratorId: value.administratorId,
      }
    : null;
}
export function attendanceChecked(value: unknown): AttendanceChecked | null {
  if (
    !exact(value, [
      "registrationId",
      "administratorId",
      "eventId",
      "eventVersion",
      "title",
      "eventStartsAt",
      "eventEndsAt",
      "startsAt",
      "expiresAt",
    ])
  )
    return null;
  const scope = attendanceScope({
    registrationId: value.registrationId,
    administratorId: value.administratorId,
  });
  if (
    !scope ||
    typeof value.eventId !== "string" ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(value.eventId) ||
    !Number.isInteger(value.eventVersion) ||
    Number(value.eventVersion) < 1 ||
    Number(value.eventVersion) > 1000000 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 1000 ||
    !instant(value.eventStartsAt) ||
    !instant(value.eventEndsAt) ||
    !instant(value.startsAt) ||
    !instant(value.expiresAt)
  )
    return null;
  if (
    +new Date(value.startsAt) < +new Date(value.eventStartsAt) ||
    +new Date(value.expiresAt) > +new Date(value.eventEndsAt) ||
    +new Date(value.startsAt) >= +new Date(value.expiresAt)
  )
    return null;
  return {
    ...scope,
    eventId: value.eventId,
    eventVersion: Number(value.eventVersion),
    title: value.title,
    eventStartsAt: value.eventStartsAt,
    eventEndsAt: value.eventEndsAt,
    startsAt: value.startsAt,
    expiresAt: value.expiresAt,
  };
}
export function attendanceObservationChecked(
  value: unknown,
): AttendanceObservationChecked | null {
  if (
    !exact(value, [
      "permissionId",
      "registrationId",
      "eventId",
      "eventVersion",
      "startsAt",
      "expiresAt",
    ]) ||
    !attendanceId(value.permissionId) ||
    !attendanceId(value.registrationId) ||
    typeof value.eventId !== "string" ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(value.eventId) ||
    !Number.isInteger(value.eventVersion) ||
    Number(value.eventVersion) < 1 ||
    Number(value.eventVersion) > 1000000 ||
    !instant(value.startsAt) ||
    !instant(value.expiresAt) ||
    +new Date(value.startsAt) >= +new Date(value.expiresAt)
  )
    return null;
  return {
    permissionId: value.permissionId,
    registrationId: value.registrationId,
    eventId: value.eventId,
    eventVersion: Number(value.eventVersion),
    startsAt: value.startsAt,
    expiresAt: value.expiresAt,
  };
}
export function attendanceRemovalChecked(
  value: unknown,
): AttendanceRemovalChecked | null {
  return exact(value, ["registrationId", "observationId"]) &&
    attendanceId(value.registrationId) &&
    attendanceId(value.observationId)
    ? {
        registrationId: value.registrationId,
        observationId: value.observationId,
      }
    : null;
}
