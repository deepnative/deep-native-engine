import { expect, it } from "vitest";
import type {
  AttendanceMemberView,
  AttendancePermission,
} from "../../src/event-attendance-values.ts";
import {
  attendanceMemberPage,
  attendanceHistoryPage,
  attendanceNotice,
  attendancePermissionConfirm,
  attendanceObservationConfirm,
  attendanceRemovalConfirm,
  attendanceSavedPage,
  attendanceStaffHome,
  attendanceStaffReceipt,
} from "../../src/event-attendance-views.ts";
const registrationId = "11111111-1111-4111-8111-111111111111";
const permissionId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-07T18:00:00.000Z");
const permission: AttendancePermission = {
  id: permissionId,
  registrationId,
  eventId: "invented-local-rehearsal",
  eventVersion: 1,
  title: 'Invented <script>alert("title")</script>',
  administratorId: key,
  startsAt: new Date(+now - 1000),
  expiresAt: new Date(+now + 60000),
  createdAt: new Date(+now - 10000),
  withdrawnAt: null,
};
const view: AttendanceMemberView = {
  registrationId,
  eventId: permission.eventId,
  eventVersion: 1,
  title: permission.title,
  eventStartsAt: permission.startsAt,
  eventEndsAt: permission.expiresAt,
  registrationWithdrawnAt: null,
  cancelledAt: null,
  permission: null,
  observation: null,
  creationEnabled: true,
};
const observation = {
  id: key,
  permissionId,
  registrationId,
  recordedAt: now,
  attribution: "Local platform administrator" as const,
};
it("ATTEND-01/03 first receipt offers deliberate permission without inferring presence or publishing member text", () => {
  const html = attendanceMemberPage('csrf"<invented>', view, now, key);
  expect(html).toContain("No observation recorded.");
  expect(html).toContain("No attendance permission saved.");
  expect(html).toContain("Check attendance permission");
  expect(html).not.toContain(permission.title);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain('csrf"<invented>');
  expect(html).toContain("not a qualified assessment");
});
it.each([
  { change: { permission }, status: "Permission saved until", request: false },
  {
    change: { permission: { ...permission, withdrawnAt: now } },
    status: "Attendance sharing withdrawn.",
    request: true,
  },
  {
    change: { permission, registrationWithdrawnAt: now },
    status: "Attendance sharing stopped",
    request: false,
  },
  {
    change: { permission, cancelledAt: now },
    status: "Attendance sharing stopped",
    request: false,
  },
  {
    change: { permission: { ...permission, expiresAt: now } },
    status: "Attendance permission expired.",
    request: false,
  },
  {
    change: { creationEnabled: false },
    status: "No attendance permission saved.",
    request: false,
  },
])(
  "ATTEND-03/04/08 member receipt shows current sharing $status",
  ({ change, status, request }) => {
    const html = attendanceMemberPage("csrf", { ...view, ...change }, now, key);
    expect(html).toContain(status);
    expect(html.includes("Check attendance permission")).toBe(request);
    expect(html).toContain("No observation recorded.");
    expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  },
);
it("ATTEND-03/04 recorded fact has distinct removal while erased staff attribution never reveals a credential", () => {
  const html = attendanceMemberPage(
    "csrf",
    {
      ...view,
      permission: { ...permission, administratorId: null },
      observation,
    },
    now,
    key,
  );
  expect(html).toContain("Present observation recorded");
  expect(html).toContain(now.toISOString());
  expect(html).toContain("Check removal of my observation");
  expect(html).toContain("Withdraw attendance permission");
  expect(html).not.toContain("Share only this permission reference");
});
it.each([true, false])(
  "ATTEND-08 staff creation enabled=%s retains exact protected inspection and self reference",
  (enabled) => {
    const html = attendanceStaffHome("csrf", key, enabled);
    expect(html).toContain(key);
    expect(html).toContain("not your sign-in credential");
    expect(html).toContain('action="/operator/event-attendance/inspect"');
    expect(html.includes("observations are paused")).toBe(!enabled);
  },
);
it("ATTEND-01/02/04 consent screens preserve exact scope and require unchecked deliberate confirmation", () => {
  const checked = {
    registrationId,
    administratorId: key,
    eventId: permission.eventId,
    eventVersion: 1,
    title: permission.title,
    eventStartsAt: permission.startsAt.toISOString(),
    eventEndsAt: permission.expiresAt.toISOString(),
    startsAt: permission.startsAt.toISOString(),
    expiresAt: permission.expiresAt.toISOString(),
  };
  const screens = [
    attendancePermissionConfirm("csrf", checked, key),
    attendanceObservationConfirm(
      "csrf",
      {
        permissionId,
        registrationId,
        eventId: checked.eventId,
        eventVersion: 1,
        startsAt: checked.startsAt,
        expiresAt: checked.expiresAt,
      },
      key,
    ),
    attendanceRemovalConfirm(
      "csrf",
      { registrationId, observationId: key },
      key,
    ),
  ];
  for (const html of screens) {
    expect(html).toContain(key);
    expect(html).toContain(registrationId);
    expect(html).toMatch(/type="checkbox"[^>]*required/);
    expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
    expect(html).not.toContain(permission.title);
  }
  expect(screens[1]).toContain("I personally observed this member present");
  expect(screens[2]).toContain("cannot recall an earlier authorized capture");
  expect(attendanceStaffReceipt(permission)).toContain("Finite permission");
});
it.each([
  {
    kind: "permit" as const,
    permission,
    text: "Exact finite attendance permission saved",
  },
  {
    kind: "withdraw" as const,
    permission,
    text: "Attendance permission withdrawn",
  },
  {
    kind: "observe" as const,
    observation,
    text: "Present observation recorded",
  },
  {
    kind: "remove" as const,
    registrationId,
    removed: true as const,
    text: "Registration retained",
  },
])(
  "ATTEND-03/04/06 canonical $kind receipt reports only the saved outcome",
  (receipt) => {
    const html = attendanceSavedPage(receipt, key);
    expect(html).toContain(receipt.text);
    expect(html).toContain(key);
    expect(html).toContain(
      receipt.kind === "observe"
        ? 'href="/operator/event-attendance"'
        : `href="/events/registrations/${registrationId}/attendance"`,
    );
  },
);
it.each(["permit", "withdraw", "remove", "observe"])(
  "ATTEND-06 uncertain %s retains read-only inspection plus original unchecked manual repeat",
  (kind) => {
    const base =
      kind === "observe"
        ? "/operator/event-attendance"
        : `/events/registrations/${registrationId}/attendance`;
    const html = attendanceNotice(
      "csrf",
      "Unknown <script>diagnostic</script>",
      { target: `${base}/${kind}`, key, checked: { registrationId } },
    );
    expect(html).toContain(`action="${base}/recover"`);
    expect(html).toContain(`name="kind" value="${kind}"`);
    expect(html).toContain(`action="${base}/${kind}"`);
    expect(html).toContain("Inspect original result");
    expect(html).toContain(key);
    expect(html).not.toContain("<script>diagnostic</script>");
    expect(html).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  },
);
it("ATTEND-06 generic denial offers no made-up recovery or replacement instruction", () => {
  expect(attendanceNotice("csrf", "Denied")).not.toContain(
    "Inspect original result",
  );
  expect(
    attendanceNotice("csrf", "Denied", {
      target: "/unsupported",
      key,
      checked: {},
    }),
  ).not.toContain("Inspect original result");
});
it("ATTEND-07 owning history preserves exact links, finite pagination and missing-fact language", () => {
  const html = attendanceHistoryPage(
    {
      items: [
        view,
        {
          ...view,
          permission: { ...permission, withdrawnAt: now },
          observation,
        },
      ],
      nextCursor: "invented&cursor",
    },
    now,
  );
  expect(html).toContain("No observation recorded");
  expect(html).toContain("Attendance sharing withdrawn");
  expect(html).toContain("Present observation recorded");
  expect(html).toContain("after=invented%26cursor");
  expect(html).not.toContain(permission.title);
  const empty = attendanceHistoryPage({ items: [], nextCursor: null }, now);
  expect(empty).toContain(
    "No attendance permissions or observations are saved",
  );
  expect(empty).not.toContain("More private attendance history");
});

it("ATTEND-03 history shows current sharing deadline/cancellation while retaining the exact observation", () => {
  const render = attendanceHistoryPage as (
    history: { items: AttendanceMemberView[]; nextCursor: string | null },
    observedAt: Date,
  ) => string;
  const expired = render(
    {
      items: [
        { ...view, permission: { ...permission, expiresAt: now }, observation },
      ],
      nextCursor: null,
    },
    now,
  );
  expect(expired).toContain("Attendance permission expired.");
  expect(expired).toContain("Present observation recorded");
  const cancelled = render(
    {
      items: [{ ...view, permission, cancelledAt: now, observation }],
      nextCursor: null,
    },
    now,
  );
  expect(cancelled).toContain(
    "Attendance sharing stopped because the registration is unavailable.",
  );
  expect(cancelled).toContain("Present observation recorded");
});
