import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountEventAttendanceRoutes } from "../../src/event-attendance-routes.ts";
import type { EventAttendanceRuntimeStore } from "../../src/event-attendance.ts";
import type { EventCancellationResult } from "../../src/event-cancellation-values.ts";
import * as views from "../../src/event-attendance-views.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const member = `/events/registrations/${id}/attendance`,
  staff = "/operator/event-attendance",
  token = "b".repeat(64);
const instant = new Date("2026-10-07T18:00:00.000Z");
const checked = {
  registrationId: id,
  administratorId: key,
  eventId: "invented-rehearsal",
  eventVersion: 1,
  title: "Invented private rehearsal",
  eventStartsAt: instant.toISOString(),
  eventEndsAt: new Date(+instant + 60000).toISOString(),
  startsAt: instant.toISOString(),
  expiresAt: new Date(+instant + 60000).toISOString(),
};
const permission = {
  id: key,
  registrationId: id,
  eventId: checked.eventId,
  eventVersion: 1,
  title: checked.title,
  administratorId: key,
  startsAt: instant,
  expiresAt: new Date(checked.expiresAt),
  createdAt: instant,
  withdrawnAt: null,
};
const observationChecked = {
  permissionId: key,
  registrationId: id,
  eventId: checked.eventId,
  eventVersion: 1,
  startsAt: checked.startsAt,
  expiresAt: checked.expiresAt,
};
const observation = {
  id: key,
  permissionId: key,
  registrationId: id,
  recordedAt: instant,
  attribution: "Local platform administrator" as const,
};
const removal = { registrationId: id, observationId: key };
const view = {
  registrationId: id,
  eventId: checked.eventId,
  eventVersion: 1,
  title: checked.title,
  eventStartsAt: instant,
  eventEndsAt: permission.expiresAt,
  registrationWithdrawnAt: null,
  cancelledAt: null,
  permission,
  observation: null,
  creationEnabled: true,
};
const ready = <T>(
  value: T,
): Extract<EventCancellationResult<T>, { kind: "ready" }> => ({
  kind: "ready",
  value,
  observedAt: instant,
  deadline: performance.now() + 60000,
});
const payload = (value: object) => ({
  csrf: "invented",
  key,
  checked: JSON.stringify(value),
  confirm: "yes",
});
function fixture(
  options: Parameters<typeof mountEventAttendanceRoutes>[2] = {},
  missing = false,
  csrf = true,
) {
  const port = {
    member: vi
      .fn<EventAttendanceRuntimeStore["member"]>()
      .mockResolvedValue(ready(view)),
    history: vi
      .fn<EventAttendanceRuntimeStore["history"]>()
      .mockResolvedValue(ready({ items: [view], nextCursor: null })),
    inspect: vi
      .fn<EventAttendanceRuntimeStore["inspect"]>()
      .mockResolvedValue(ready({ kind: "permit", permission })),
    administrator: vi
      .fn<EventAttendanceRuntimeStore["administrator"]>()
      .mockResolvedValue(ready({ reference: key, creationEnabled: true })),
    checkPermission: vi
      .fn<EventAttendanceRuntimeStore["checkPermission"]>()
      .mockResolvedValue(ready(checked)),
    permit: vi
      .fn<EventAttendanceRuntimeStore["permit"]>()
      .mockResolvedValue(ready({ kind: "permit", permission })),
    withdraw: vi
      .fn<EventAttendanceRuntimeStore["withdraw"]>()
      .mockResolvedValue(ready({ kind: "withdraw", permission })),
    permission: vi
      .fn<EventAttendanceRuntimeStore["permission"]>()
      .mockResolvedValue(ready(permission)),
    checkObservation: vi
      .fn<EventAttendanceRuntimeStore["checkObservation"]>()
      .mockResolvedValue(ready(observationChecked)),
    observe: vi
      .fn<EventAttendanceRuntimeStore["observe"]>()
      .mockResolvedValue(ready({ kind: "observe", observation })),
    checkRemoval: vi
      .fn<EventAttendanceRuntimeStore["checkRemoval"]>()
      .mockResolvedValue(ready(removal)),
    remove: vi
      .fn<EventAttendanceRuntimeStore["remove"]>()
      .mockResolvedValue(
        ready({ kind: "remove", registrationId: id, removed: true }),
      ),
  };
  const application = express();
  application.use(express.json());
  application.use((_req, res, next) => {
    res.locals.token = token;
    if (csrf) res.locals.csrf = "invented";
    next();
  });
  mountEventAttendanceRoutes(application, missing ? undefined : port, {
    mode: "test",
    localStaffEntry: true,
    ...options,
  });
  const get = (path = member, cookie = `dne_staff=${token}`) =>
    withLoopback(application, (server) =>
      request(server).get(path).set("Cookie", cookie),
    );
  const post = (path: string, body: unknown, cookie = `dne_staff=${token}`) =>
    withLoopback(application, (server) =>
      request(server)
        .post(path)
        .set("Cookie", cookie)
        .send(body as object),
    );
  return { port, get, post };
}
afterEach(() => vi.restoreAllMocks());
it("ATTEND-05 committed result that expires while rendering is uncertain and never exposes stale success", async () => {
  const f = fixture();
  vi.spyOn(views, "attendanceSavedPage").mockImplementationOnce(() => {
    vi.spyOn(performance, "now").mockReturnValue(1e15);
    return "PRIVATE stale success";
  });
  const response = await f.post(member + "/permit", payload(checked));
  expect(response.status).toBe(503);
  expect(response.text).not.toContain("PRIVATE stale success");
  expect(response.text).toContain("Inspect original result");
});
it("ATTEND-01/02/04 omitted checked/reference fields cannot become a deliberate mutation", async () => {
  const f = fixture();
  expect(
    (await f.post(member + "/permit", { key, confirm: "yes" })).status,
  ).toBe(422);
  expect(
    (await f.post(staff + "/observe", { key, confirm: "no" })).status,
  ).toBe(422);
  f.port.checkRemoval.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.post(member + "/remove-check", {})).status).toBe(422);
  expect(f.port.checkRemoval).toHaveBeenCalledWith(token, "");
  f.port.checkObservation.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.post(staff + "/check", {})).status).toBe(422);
  expect(f.port.checkObservation).toHaveBeenCalledWith(token, "");
  f.port.permission.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.post(staff + "/inspect", {})).status).toBe(403);
  expect(f.port.permission).toHaveBeenCalledWith(token, "");
  expect(f.port.permit).not.toHaveBeenCalled();
  expect(f.port.observe).not.toHaveBeenCalled();
});
it.each([
  { key, checked: JSON.stringify(checked) },
  { key, kind: "permit" },
  { key, kind: "withdraw", checked: "{}" },
  { key, kind: "withdraw", checked: "null" },
])(
  "ATTEND-06 omitted or malformed recovery reference %j cannot inspect",
  async (body) => {
    const f = fixture();
    expect((await f.post(member + "/recover", body)).status).toBe(422);
    expect(f.port.inspect).not.toHaveBeenCalled();
  },
);
it("ATTEND-06 backend receipt from another protected source is not disclosed on an owning member route", async () => {
  const f = fixture();
  f.port.inspect.mockResolvedValueOnce(
    ready({
      kind: "observe",
      observation: { ...observation, registrationId: key },
    }),
  );
  expect(
    (
      await f.post(member + "/recover", {
        key,
        kind: "withdraw",
        checked: JSON.stringify({ permissionId: key }),
      })
    ).status,
  ).toBe(403);
});
it.each([member, staff, "/events/attendance"])(
  "ATTEND-08 unavailable/live configuration hides private route %s",
  async (path) => {
    expect((await fixture({}, true).get(path)).status).toBe(404);
    expect((await fixture({ mode: "live" }).get(path)).status).toBe(404);
  },
);
it("ATTEND-08 staff entry disabled hides staff attendance", async () => {
  expect((await fixture({ localStaffEntry: false }).get(staff)).status).toBe(
    404,
  );
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=bad",
  `dne_staff=${token}; dne_staff=${token}`,
])("ATTEND-02 selected staff credential required %s", async (cookie) => {
  const f = fixture();
  expect((await f.get(staff, cookie)).status).toBe(403);
  expect(f.port.administrator).not.toHaveBeenCalled();
});
it.each([
  `${member}?unexpected=yes`,
  `${staff}?unexpected=yes`,
  "/events/attendance?unexpected=yes",
])("ATTEND-03 unknown query rejected %s", async (path) => {
  expect((await fixture().get(path)).status).toBe(422);
});
it("ATTEND-01/02/03 ordinary check-confirm-read flows bind current member/staff identities and exact references", async () => {
  const f = fixture();
  expect((await f.get()).status).toBe(200);
  expect((await f.get(staff)).status).toBe(200);
  expect((await f.get("/events/attendance?after=original")).status).toBe(200);
  expect(f.port.history).toHaveBeenCalledWith(token, "original");
  expect(
    (
      await f.post(member + "/check", {
        csrf: "invented",
        administratorId: key,
      })
    ).status,
  ).toBe(200);
  expect(f.port.checkPermission).toHaveBeenCalledWith(token, {
    registrationId: id,
    administratorId: key,
  });
  expect((await f.post(member + "/permit", payload(checked))).status).toBe(200);
  expect(f.port.permit).toHaveBeenCalledWith(token, key, checked);
  expect(
    (await f.post(member + "/withdraw", payload({ permissionId: key }))).status,
  ).toBe(200);
  expect(f.port.withdraw).toHaveBeenCalledWith(token, key, key);
  expect(
    (
      await f.post(member + "/remove-check", {
        csrf: "invented",
        observationId: key,
      })
    ).status,
  ).toBe(200);
  expect((await f.post(member + "/remove", payload(removal))).status).toBe(200);
  expect(f.port.remove).toHaveBeenCalledWith(token, key, removal);
  expect(
    (await f.post(staff + "/check", { csrf: "invented", permissionId: key }))
      .status,
  ).toBe(200);
  expect(
    (await f.post(staff + "/inspect", { csrf: "invented", permissionId: key }))
      .status,
  ).toBe(200);
  expect((await f.get(staff + "/" + key)).status).toBe(200);
  expect(
    (await f.post(staff + "/observe", payload(observationChecked))).status,
  ).toBe(200);
  expect(f.port.observe).toHaveBeenCalledWith(token, key, observationChecked);
});
it.each(["permit", "withdraw", "remove"])(
  "ATTEND-01/04 reject unchecked or malformed %s before any mutation",
  async (action) => {
    const f = fixture();
    const value =
      action === "permit"
        ? checked
        : action === "withdraw"
          ? { permissionId: key }
          : removal;
    for (const body of [
      { ...payload(value), confirm: "no" },
      { ...payload(value), key: "guessed" },
      { ...payload(value), checked: "broken json" },
      { ...payload(value), extra: "unexpected" },
      { ...payload(value), checked: JSON.stringify({}) },
    ]) {
      expect((await f.post(member + "/" + action, body)).status).toBe(422);
    }
    expect(f.port.permit).not.toHaveBeenCalled();
    expect(f.port.withdraw).not.toHaveBeenCalled();
    expect(f.port.remove).not.toHaveBeenCalled();
  },
);
it.each(["permit", "remove"])(
  "ATTEND-01/04 refuse %s checked scope from another registration",
  async (action) => {
    const f = fixture();
    expect(
      (
        await f.post(
          member + "/" + action,
          payload({
            ...(action === "permit" ? checked : removal),
            registrationId: key,
          }),
        )
      ).status,
    ).toBe(422);
    expect(f.port.permit).not.toHaveBeenCalled();
    expect(f.port.remove).not.toHaveBeenCalled();
  },
);
it("ATTEND-04 withdrawal rechecks the current exact permission and finite receipt before mutating", async () => {
  const f = fixture();
  expect(
    (await f.post(member + "/withdraw", payload({ permissionId: id }))).status,
  ).toBe(403);
  f.port.member.mockResolvedValueOnce({ kind: "denied" });
  expect(
    (await f.post(member + "/withdraw", payload({ permissionId: key }))).status,
  ).toBe(403);
  f.port.member.mockResolvedValueOnce({
    ...ready(view),
    deadline: performance.now() - 1,
  });
  expect(
    (await f.post(member + "/withdraw", payload({ permissionId: key }))).status,
  ).toBe(403);
  expect(f.port.withdraw).not.toHaveBeenCalled();
});
it("ATTEND-04 removal preview cannot expose another exact registration", async () => {
  const f = fixture();
  f.port.checkRemoval.mockResolvedValueOnce(
    ready({ ...removal, registrationId: key }),
  );
  expect(
    (await f.post(member + "/remove-check", { observationId: key })).status,
  ).toBe(403);
});
it.each([
  member + "/check",
  member + "/remove-check",
  staff + "/check",
  staff + "/inspect",
])("ATTEND-01/02/04 unknown form fields rejected %s", async (path) => {
  expect((await fixture().post(path, { extra: "bad" })).status).toBe(422);
});
it("ATTEND-02 malformed observation is never sent to the backend", async () => {
  const f = fixture();
  expect((await f.post(staff + "/observe", payload({}))).status).toBe(422);
  expect(f.port.observe).not.toHaveBeenCalled();
});
it.each(["denied", "invalid", "conflict", "unavailable"] as const)(
  "ATTEND-03 current backend %s result has explicit bounded public status",
  async (kind) => {
    const f = fixture({}, false, false);
    f.port.member.mockResolvedValue({ kind });
    const response = await f.get();
    expect(response.status).toBe(
      { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
    );
    expect(response.text).not.toContain("Inspect original result");
  },
);
it("ATTEND-05 read denied both before and after rendering the original finite result", async () => {
  const f = fixture();
  f.port.member.mockResolvedValueOnce({ ...ready(view), deadline: NaN });
  expect((await f.get()).status).toBe(403);
  vi.spyOn(views, "attendanceMemberPage").mockImplementationOnce(() => {
    vi.spyOn(performance, "now").mockReturnValue(1e15);
    return "PRIVATE stale rendered observation";
  });
  const response = await f.get();
  expect(response.status).toBe(403);
  expect(response.text).not.toContain("PRIVATE stale");
});
it("ATTEND-05/06 expired committed write is uncertain with original inspection/manual repeat rather than success", async () => {
  const f = fixture();
  f.port.permit.mockResolvedValueOnce({
    ...ready({ kind: "permit", permission }),
    deadline: performance.now() - 1,
  });
  const response = await f.post(member + "/permit", payload(checked));
  expect(response.status).toBe(503);
  expect(response.text).toContain("Inspect original result");
  expect(response.text).toContain(key);
});
it("ATTEND-06 backend exception withholds sensitive diagnostics and keeps only validated original instruction", async () => {
  const f = fixture();
  f.port.permit.mockRejectedValueOnce(Error("PRIVATE database credential"));
  const response = await f.post(member + "/permit", payload(checked));
  expect(response.status).toBe(503);
  expect(response.text).not.toContain("PRIVATE database credential");
  expect(response.text).toContain("Inspect original result");
});
it.each(["permit", "withdraw", "remove", "observe"] as const)(
  "ATTEND-06 read-only %s recovery retains the original key and correct actor",
  async (kind) => {
    const f = fixture();
    const value =
      kind === "permit"
        ? checked
        : kind === "withdraw"
          ? { permissionId: key }
          : kind === "remove"
            ? removal
            : observationChecked;
    const receipt =
      kind === "observe"
        ? { kind, observation }
        : kind === "remove"
          ? { kind, registrationId: id, removed: true as const }
          : { kind, permission };
    f.port.inspect.mockResolvedValueOnce(ready(receipt));
    const response = await f.post(
      (kind === "observe" ? staff : member) + "/recover",
      { csrf: "invented", key, kind, checked: JSON.stringify(value) },
    );
    expect(response.status).toBe(200);
    expect(f.port.inspect).toHaveBeenCalledWith(token, key, kind, value);
    expect(f.port.permit).not.toHaveBeenCalled();
    expect(f.port.withdraw).not.toHaveBeenCalled();
    expect(f.port.observe).not.toHaveBeenCalled();
    expect(f.port.remove).not.toHaveBeenCalled();
  },
);
it("ATTEND-06 missing original result never promises rollback or automatically resubmits", async () => {
  const f = fixture();
  f.port.inspect.mockResolvedValueOnce(ready(null));
  const response = await f.post(member + "/recover", {
    key,
    kind: "permit",
    checked: JSON.stringify(checked),
  });
  expect(response.status).toBe(200);
  expect(response.text).toContain(
    "does not prove that an uncertain write failed",
  );
  expect(response.text).not.toContain("Repeat original instruction");
});
it.each([
  { key: "bad", kind: "permit", checked: JSON.stringify(checked) },
  { key, kind: "observe", checked: JSON.stringify(observationChecked) },
  { key, kind: "permit", checked: "bad json" },
  { key, kind: "permit", checked: "{}" },
  {
    key,
    kind: "permit",
    checked: JSON.stringify({ ...checked, registrationId: key }),
  },
])(
  "ATTEND-06 invalid member recovery never inspects or writes %j",
  async (body) => {
    const f = fixture();
    expect((await f.post(member + "/recover", body)).status).toBe(422);
    expect(f.port.inspect).not.toHaveBeenCalled();
  },
);
it("ATTEND-06 staff recovery cannot inspect member permission operations", async () => {
  const f = fixture();
  expect(
    (
      await f.post(staff + "/recover", {
        key,
        kind: "permit",
        checked: JSON.stringify(checked),
      })
    ).status,
  ).toBe(422);
  expect(f.port.inspect).not.toHaveBeenCalled();
});
it("ATTEND-06 owned original receipt for a different registration is not rendered", async () => {
  const f = fixture();
  f.port.inspect.mockResolvedValueOnce(
    ready({
      kind: "withdraw",
      permission: { ...permission, registrationId: key },
    }),
  );
  expect(
    (
      await f.post(member + "/recover", {
        key,
        kind: "withdraw",
        checked: JSON.stringify({ permissionId: key }),
      })
    ).status,
  ).toBe(403);
});
