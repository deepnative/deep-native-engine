import { escape, hidden, page } from "./views.ts";
import type {
  AttendanceChecked,
  AttendanceMemberView,
  AttendanceObservationChecked,
  AttendancePermission,
  AttendanceRemovalChecked,
  AttendanceSavedReceipt,
} from "./event-attendance-values.ts";
export const attendancePath = (id: string) =>
  `/events/registrations/${encodeURIComponent(id)}/attendance`;
const notice = `<p class="eyebrow">PRIVATE LOCAL REHEARSAL · INVENTED DATA ONLY</p><p>A human administrator may record that they observed you present. This is not a qualified assessment, course completion, credential or proof of real clinic service. No recording, location or browser activity is collected.</p>`;
export interface AttendanceAttempt {
  target: string;
  key: string;
  checked: object;
}
const details = (registrationId: string, title: string, version: number) =>
  `<h2>${escape(title)}</h2><dl><dt>Exact event version</dt><dd>${version}</dd><dt>Private registration reference</dt><dd style="overflow-wrap:anywhere">${escape(registrationId)}</dd></dl>`;
const attemptFields = (attempt: AttendanceAttempt) =>
  `<input type="hidden" name="key" value="${escape(attempt.key)}"><input type="hidden" name="checked" value="${escape(JSON.stringify(attempt.checked))}">`;
const confirm = (text: string) =>
  `<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>${escape(text)}</span></label>`;
function attendanceSharing(view: AttendanceMemberView, observedAt: Date) {
  return !view.permission
    ? "No attendance permission saved."
    : view.permission.withdrawnAt
      ? "Attendance sharing withdrawn."
      : view.registrationWithdrawnAt || view.cancelledAt
        ? "Attendance sharing stopped because the registration is unavailable."
        : +view.permission.expiresAt <= +observedAt
          ? "Attendance permission expired."
          : `Permission saved until ${view.permission.expiresAt.toISOString()}.`;
}
export function attendanceMemberPage(
  csrf: string,
  view: AttendanceMemberView,
  observedAt: Date,
  key: string,
) {
  const permission = view.permission;
  const sharing = attendanceSharing(view, observedAt);
  const observation = view.observation
    ? `<p role="status">Present observation recorded · ${view.observation.recordedAt.toISOString()} · ${escape(view.observation.attribution)}.</p><form method="post" action="${attendancePath(view.registrationId)}/remove-check">${hidden(escape(csrf))}<input type="hidden" name="observationId" value="${escape(view.observation.id)}"><button type="submit">Check removal of my observation</button></form>`
    : `<p role="status">No observation recorded.</p>`;
  const request =
    view.creationEnabled &&
    !view.registrationWithdrawnAt &&
    !view.cancelledAt &&
    !view.observation &&
    (!permission || permission.withdrawnAt)
      ? `<form method="post" action="${attendancePath(view.registrationId)}/check">${hidden(escape(csrf))}<label for="administratorId">Selected administrator reference</label><input id="administratorId" name="administratorId" maxlength="36" autocomplete="off" required><p>Ask your selected administrator to share their own attendance reference. There is no staff or member directory.</p><button type="submit">Check attendance permission</button></form>`
      : "";
  const withdrawal =
    permission && !permission.withdrawnAt
      ? `<form method="post" action="${attendancePath(view.registrationId)}/withdraw">${hidden(escape(csrf))}${attemptFields({ target: "", key, checked: { permissionId: permission.id } })}${confirm("Withdraw this attendance permission. Keep my registration and any saved observation.")}<button type="submit">Withdraw attendance permission</button></form>`
      : "";
  return page(
    "Private attendance receipt",
    `<section class="reading">${notice}<h1>Private attendance receipt</h1>${details(view.registrationId, view.title, view.eventVersion)}<p>Event window: ${view.eventStartsAt.toISOString()} to ${view.eventEndsAt.toISOString()} (UTC).</p><p role="status">${escape(sharing)}</p>${observation}${permission && !permission.withdrawnAt && permission.administratorId ? `<p>Share only this permission reference with your selected administrator: <code style="overflow-wrap:anywhere">${escape(permission.id)}</code>.</p>` : ""}${request}${withdrawal}<p><a href="/events/registrations/${encodeURIComponent(view.registrationId)}">Your registration</a> · <a href="/events/attendance">My private attendance history</a> · <a href="/events/registrations">Registration history</a> · <a href="/member/export">Download your private records</a></p></section>`,
  );
}
export function attendancePermissionConfirm(
  csrf: string,
  checked: AttendanceChecked,
  key: string,
) {
  const attempt = {
    target: `${attendancePath(checked.registrationId)}/permit`,
    key,
    checked,
  };
  return page(
    "Confirm attendance permission",
    `<section class="reading">${notice}<h1>Confirm attendance permission</h1>${details(checked.registrationId, checked.title, checked.eventVersion)}<p>Selected administrator: <span style="overflow-wrap:anywhere">${escape(checked.administratorId)}</span>.</p><p>Exact observation window: ${escape(checked.startsAt)} to ${escape(checked.expiresAt)} (UTC).</p><form method="post" action="${attempt.target}">${hidden(escape(csrf))}${attemptFields(attempt)}${confirm("Permit only this selected administrator to record a present observation for this exact registration during this window.")}<button type="submit">Save this attendance permission</button></form><p><a href="${attendancePath(checked.registrationId)}">Back to my receipt</a></p></section>`,
  );
}
export function attendanceStaffHome(
  csrf: string,
  reference: string,
  enabled: boolean,
) {
  return page(
    "Private rehearsal attendance",
    `<section class="reading">${notice}<h1>Private rehearsal attendance</h1><p>Your own administrator reference: <code style="overflow-wrap:anywhere">${escape(reference)}</code>. Share it only with the member choosing you. This is a reference, not your sign-in credential.</p>${!enabled ? '<p role="status">New permissions and observations are paused. Existing finite protected inspection remains available.</p>' : ""}<form method="post" action="/operator/event-attendance/check">${hidden(escape(csrf))}<label for="permissionId">Member-supplied permission reference</label><input id="permissionId" name="permissionId" maxlength="36" required autocomplete="off"><button type="submit">Check exact attendance permission</button></form><form method="post" action="/operator/event-attendance/inspect">${hidden(escape(csrf))}<label for="inspectPermissionId">Inspect an existing permission</label><input id="inspectPermissionId" name="permissionId" maxlength="36" required autocomplete="off"><button type="submit">Inspect permitted scope</button></form><p><a href="/staff">Your staff tools</a></p></section>`,
  );
}
export function attendanceObservationConfirm(
  csrf: string,
  checked: AttendanceObservationChecked,
  key: string,
) {
  const attempt = {
    target: "/operator/event-attendance/observe",
    key,
    checked,
  };
  return page(
    "Confirm a present observation",
    `<section class="reading">${notice}<h1>Confirm a present observation</h1><p>Exact event: ${escape(checked.eventId)} · version ${checked.eventVersion}.</p><p>Exact registration: <span style="overflow-wrap:anywhere">${escape(checked.registrationId)}</span>.</p><p>Permission window: ${escape(checked.startsAt)} to ${escape(checked.expiresAt)} (UTC).</p><form method="post" action="${attempt.target}">${hidden(escape(csrf))}${attemptFields(attempt)}${confirm("I personally observed this member present in this exact invented local rehearsal. This is not a qualified assessment.")}<button type="submit">Record present observation</button></form><p><a href="/operator/event-attendance">Attendance tools</a></p></section>`,
  );
}
export function attendanceRemovalConfirm(
  csrf: string,
  checked: AttendanceRemovalChecked,
  key: string,
) {
  const attempt = {
    target: `${attendancePath(checked.registrationId)}/remove`,
    key,
    checked,
  };
  return page(
    "Remove my private observation",
    `<section class="reading">${notice}<h1>Remove my private observation</h1><p>This removes this exact observation and its identifying attendance permission links. Your registration remains. It cannot recall an earlier authorized capture or promise deletion from hosted backups.</p><form method="post" action="${attempt.target}">${hidden(escape(csrf))}${attemptFields(attempt)}${confirm("Remove my exact private observation and its attendance permission links.")}<button type="submit">Remove my observation</button></form><p><a href="${attendancePath(checked.registrationId)}">Keep my observation</a></p></section>`,
  );
}
export function attendanceStaffReceipt(receipt: AttendancePermission) {
  return page(
    "Permitted attendance scope",
    `<section class="reading">${notice}<h1>Permitted attendance scope</h1>${details(receipt.registrationId, receipt.title, receipt.eventVersion)}<p>Finite permission: ${receipt.startsAt.toISOString()} to ${receipt.expiresAt.toISOString()} (UTC).</p><p><a href="/operator/event-attendance">Attendance tools</a></p></section>`,
  );
}
export function attendanceHistoryPage(
  history: {
    items: AttendanceMemberView[];
    nextCursor: string | null;
  },
  observedAt: Date,
) {
  return page(
    "My private attendance history",
    `<section class="reading">${notice}<h1>My private attendance history</h1>${history.items.length ? `<ul>${history.items.map((item) => `<li><a href="${attendancePath(item.registrationId)}">${escape(item.title)} · version ${item.eventVersion}</a><p>${item.observation ? `Present observation recorded ${item.observation.recordedAt.toISOString()} by ${escape(item.observation.attribution)}.` : "No observation recorded."}${escape(attendanceSharing(item, observedAt))}</p></li>`).join("")}</ul>` : "<p>No attendance permissions or observations are saved.</p>"}${history.nextCursor ? `<p><a href="/events/attendance?after=${encodeURIComponent(history.nextCursor)}">More private attendance history</a></p>` : ""}<p><a href="/events/registrations">Your registrations</a> · <a href="/member/export">Download your private records</a></p></section>`,
  );
}
export function attendanceSavedPage(
  receipt: AttendanceSavedReceipt,
  key: string,
) {
  const id =
    receipt.kind === "observe"
      ? receipt.observation.registrationId
      : receipt.kind === "remove"
        ? receipt.registrationId
        : receipt.permission.registrationId;
  const message =
    receipt.kind === "observe"
      ? `Present observation recorded at ${receipt.observation.recordedAt.toISOString()} by ${receipt.observation.attribution}.`
      : receipt.kind === "remove"
        ? "Private observation and attendance permission links removed. Registration retained."
        : receipt.kind === "withdraw"
          ? "Attendance permission withdrawn. Your registration and any saved observation remain."
          : "Exact finite attendance permission saved.";
  return page(
    "Attendance result",
    `<section class="reading">${notice}<h1>Attendance result</h1><p role="status">${escape(message)}</p><p>Original recovery reference: <code style="overflow-wrap:anywhere">${escape(key)}</code>.</p><p><a href="${receipt.kind === "observe" ? "/operator/event-attendance" : attendancePath(id)}">${receipt.kind === "observe" ? "Attendance tools" : "Open my attendance receipt"}</a></p></section>`,
  );
}
export function attendanceNotice(
  csrf: string,
  message: string,
  attempt?: AttendanceAttempt,
) {
  const kind = attempt?.target.split("/").at(-1);
  const inspection =
    attempt &&
    kind &&
    ["permit", "withdraw", "remove", "observe"].includes(kind)
      ? `<form method="post" action="${escape(attempt.target.replace(/\/(permit|withdraw|remove|observe)$/, "/recover"))}" target="_blank">${hidden(escape(csrf))}${attemptFields(attempt)}<input type="hidden" name="kind" value="${escape(kind)}"><button type="submit">Inspect original result in a new tab</button></form>`
      : "";
  return page(
    "Attendance needs attention",
    `<section class="reading">${notice}<h1>Attendance needs attention</h1><p role="alert">${escape(message)}</p><p>A missing reply does not prove that a write failed. Inspect your saved receipt before deliberately repeating the same instruction.</p>${inspection}${attempt ? `<details><summary>Repeat the original instruction manually</summary><form method="post" action="${escape(attempt.target)}">${hidden(escape(csrf))}${attemptFields(attempt)}${confirm("I inspected saved state and choose to repeat the exact original instruction with its original recovery reference.")}<button type="submit">Repeat original instruction</button></form></details>` : ""}<p><a href="/events/registrations">Your registration history</a> · <a href="/operator/event-attendance">Attendance tools</a></p></section>`,
  );
}
