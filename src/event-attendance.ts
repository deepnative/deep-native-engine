import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { attendanceHistory } from "./event-attendance-history.ts";
import { attendanceInspect } from "./event-attendance-inspection.ts";
import type { EventAttendanceStore } from "./event-attendance-values.ts";
import {
  attendanceAdministratorReference,
  attendanceMemberView,
  attendancePermissionCheck,
  type AttendanceOptions,
} from "./event-attendance-reader.ts";
import {
  attendancePermit,
  attendanceWithdraw,
} from "./event-attendance-permissions.ts";
import {
  attendanceObservationCheck,
  attendanceObserve,
  attendanceStaffPermission,
} from "./event-attendance-observations.ts";
import {
  attendanceRemovalCheck,
  attendanceRemove,
} from "./event-attendance-removal.ts";

export type EventAttendanceRuntimeStore = Pick<
  EventAttendanceStore,
  | "member"
  | "history"
  | "inspect"
  | "administrator"
  | "checkPermission"
  | "permit"
  | "withdraw"
  | "permission"
  | "checkObservation"
  | "observe"
  | "checkRemoval"
  | "remove"
>;
export function eventAttendanceStore(
  pool: Pool,
  supplied: AttendanceOptions,
  secret = randomBytes(32).toString("hex"),
): EventAttendanceRuntimeStore {
  const options = Object.freeze({ ...supplied });
  return {
    member: (token, id) => attendanceMemberView(pool, options, token, id),
    inspect: (token, key, kind, checked) =>
      attendanceInspect(pool, options, token, key, kind, checked),
    history: (token, cursor) =>
      attendanceHistory(pool, options, secret, token, cursor),
    administrator: (token) =>
      attendanceAdministratorReference(pool, options, token),
    checkPermission: (token, scope) =>
      attendancePermissionCheck(pool, options, token, scope),
    permit: (token, key, checked) =>
      attendancePermit(pool, options, token, key, checked),
    withdraw: (token, key, id) =>
      attendanceWithdraw(pool, options, token, key, id),
    permission: (token, id) =>
      attendanceStaffPermission(pool, options, token, id),
    checkObservation: (token, id) =>
      attendanceObservationCheck(pool, options, token, id),
    observe: (token, key, checked) =>
      attendanceObserve(pool, options, token, key, checked),
    checkRemoval: (token, id) =>
      attendanceRemovalCheck(pool, options, token, id),
    remove: (token, key, checked) =>
      attendanceRemove(pool, options, token, key, checked),
  };
}
