import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountEventCancellationRoutes } from "../../src/event-cancellation-routes.ts";
import { EVENT_PREVIEWS } from "../../src/events.ts";
import type {
  EventCancellationResult,
  EventCancellationStore,
} from "../../src/event-cancellation-values.ts";
import { withLoopback } from "../support/loopback-server.ts";
const base = "/operator/event-cancellations";
const token = "b".repeat(64);
const event = EVENT_PREVIEWS[0]!;
const scope = { eventId: event.id, eventVersion: event.version };
const key = "44444444-4444-4444-8444-444444444444";
const receipt = {
  ...scope,
  id: "33333333-3333-4333-8333-333333333333",
  title: event.title,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  cancelledAt: new Date("2026-10-06T12:00:00.000Z"),
};
const payload = () => ({
  ...scope,
  key,
  title: event.title,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  capacity: event.fixtureCapacity,
  confirm: "yes",
});
function ready<T>(value: T): EventCancellationResult<T> {
  return {
    kind: "ready",
    value,
    observedAt: receipt.cancelledAt,
    deadline: performance.now() + 60000,
  };
}
function fixture(
  options: Parameters<typeof mountEventCancellationRoutes>[2] = {},
  missing = false,
) {
  const port = {
    admin: vi
      .fn<EventCancellationStore["admin"]>()
      .mockResolvedValue(ready({ creationEnabled: true })),
    preview: vi
      .fn<EventCancellationStore["preview"]>()
      .mockResolvedValue(
        ready({ event, creationEnabled: true, receipt: null }),
      ),
    cancel: vi
      .fn<EventCancellationStore["cancel"]>()
      .mockResolvedValue(ready({ receipt, replayed: false })),
    inspect: vi
      .fn<EventCancellationStore["inspect"]>()
      .mockResolvedValue(ready(receipt)),
    inspectOperation: vi
      .fn<EventCancellationStore["inspectOperation"]>()
      .mockResolvedValue(ready(receipt)),
  };
  const application = express();
  application.use(express.json());
  application.use(express.urlencoded({ extended: false }));
  application.use((_req, res, next) => {
    res.locals.csrf = "invented-csrf";
    next();
  });
  mountEventCancellationRoutes(application, missing ? undefined : port, {
    mode: "test",
    localStaffEntry: true,
    ...options,
  });
  return { application, port };
}
afterEach(() => vi.restoreAllMocks());
it.each([{ localStaffEntry: false }, { mode: "live" as const }])(
  "EVCANCEL-08 disabled configuration %j exposes no administration",
  async (options) => {
    const f = fixture(options);
    await withLoopback(f.application, (s) =>
      request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(404),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("EVCANCEL-08 missing store exposes no administration", async () => {
  const f = fixture({}, true);
  await withLoopback(f.application, (s) =>
    request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(404),
  );
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=bad",
  `dne_staff=${token}; dne_staff=${token}`,
])(
  "EVCANCEL-05 selected cookie %s cannot fall back or escalate",
  async (cookie) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s).get(base).set("Cookie", cookie).expect(403),
    );
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("EVCANCEL-01 check presents an unchecked exact snapshot without exposing credentials", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    const home = await request(s)
      .get(base)
      .set("Cookie", `dne_staff=${token}`)
      .expect(200);
    expect(home.text).toContain("invented-csrf");
    expect(home.text).not.toContain(token);
    const check = await request(s)
      .post(base + "/check")
      .set("Cookie", `dne_staff=${token}`)
      .type("form")
      .send(scope)
      .expect(200);
    expect(check.text).toContain(event.title);
    expect(check.text).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
    expect(check.text).toContain('name="title"');
  });
  expect(f.port.preview).toHaveBeenCalledExactlyOnceWith(token, scope);
  expect(f.port.cancel).not.toHaveBeenCalled();
});
it("EVCANCEL-01 cancellation requires explicit confirmation and forwards the checked snapshot", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    await request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .send({
        ...payload(),
        confirm: undefined,
        capacity: String(event.fixtureCapacity),
        eventVersion: String(event.version),
      })
      .expect(403);
    const r = await request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .type("form")
      .send(payload())
      .expect(200);
    expect(r.text).toContain(receipt.id);
  });
  expect(f.port.cancel).toHaveBeenCalledExactlyOnceWith(token, scope, key, {
    ...scope,
    key,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    capacity: event.fixtureCapacity,
  });
});
it.each([
  { eventVersion: "01" },
  { eventId: "UNKNOWN" },
  { key: "bad" },
  { title: "" },
  { startsAt: "2026-02-30T00:00:00.000Z" },
  { endsAt: "tomorrow" },
  { capacity: "101" },
  { capacity: "0" },
  { capacity: "01" },
  { title: "x".repeat(201) },
  { actor: token },
  { title: ["a", "b"] },
])("EVCANCEL-05 malformed cancellation %j never writes", async (changes) => {
  const f = fixture();
  await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .send({
        ...payload(),
        eventVersion: String(event.version),
        capacity: String(event.fixtureCapacity),
        ...changes,
      })
      .expect(422),
  );
  expect(f.port.cancel).not.toHaveBeenCalled();
});
it.each(["check", "cancel", "inspect"])(
  "EVCANCEL-05 %s refuses authority or keys in the URL",
  async (path) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(`${base}/${path}?key=${key}`)
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send(payload())
        .expect(422),
    );
    for (const fn of Object.values(f.port)) expect(fn).not.toHaveBeenCalled();
  },
);
it("EVCANCEL-05 home refuses query authority", async () => {
  const f = fixture();
  await withLoopback(f.application, (s) =>
    request(s)
      .get(base + "?role=platform_admin")
      .set("Cookie", `dne_staff=${token}`)
      .expect(422),
  );
  expect(f.port.admin).not.toHaveBeenCalled();
});
it.each([{ eventVersion: "0" }, { eventId: "bad/id" }, { extra: "directory" }])(
  "EVCANCEL-01 invalid check %j never previews",
  async (changes) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/check")
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send({ ...scope, ...changes })
        .expect(422),
    );
    expect(f.port.preview).not.toHaveBeenCalled();
  },
);
it("EVCANCEL-06 inspection distinguishes exact canonical state from creator original-key state", async () => {
  const f = fixture();
  await withLoopback(f.application, async (s) => {
    for (const submitted of [undefined, "", key])
      await request(s)
        .post(base + "/inspect")
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send({
          ...scope,
          ...(submitted === undefined ? {} : { key: submitted }),
        })
        .expect(200);
  });
  expect(f.port.inspect).toHaveBeenCalledTimes(2);
  expect(f.port.inspectOperation).toHaveBeenCalledExactlyOnceWith(
    token,
    scope,
    key,
  );
  expect(f.port.cancel).not.toHaveBeenCalled();
});
it.each([{ key: "bad" }, { eventVersion: "-1" }, { directory: "all" }])(
  "EVCANCEL-06 malformed inspection %j never reads",
  async (changes) => {
    const f = fixture();
    await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/inspect")
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send({ ...scope, ...changes })
        .expect(422),
    );
    expect(f.port.inspect).not.toHaveBeenCalled();
    expect(f.port.inspectOperation).not.toHaveBeenCalled();
  },
);
it.each([
  ["denied", 403],
  ["invalid", 422],
  ["conflict", 409],
  ["unavailable", 503],
] as const)(
  "EVCANCEL-06 %s response never claims confirmed cancellation",
  async (kind, status) => {
    const f = fixture();
    f.port.cancel.mockResolvedValue({ kind });
    const r = await withLoopback(f.application, (s) =>
      request(s)
        .post(base + "/cancel")
        .set("Cookie", `dne_staff=${token}`)
        .type("form")
        .send(payload())
        .expect(status),
    );
    expect(r.text).not.toContain(receipt.id);
    expect(r.text.includes("Repeat original cancellation")).toBe(
      kind === "unavailable",
    );
  },
);
it("EVCANCEL-06 unexpected write failure preserves the original attempt for manual recovery", async () => {
  const f = fixture();
  f.port.cancel.mockRejectedValue(new Error("private database diagnostics"));
  const r = await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .type("form")
      .send(payload())
      .expect(503),
  );
  expect(r.text).toContain(key);
  expect(r.text).toContain('target="_blank"');
  expect(r.text).not.toContain("private database diagnostics");
  expect(r.text).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
});
it("EVCANCEL-05 unexpected read failure discloses neither diagnostics nor repeat controls", async () => {
  const f = fixture();
  f.port.admin.mockRejectedValue(new Error("private database diagnostics"));
  const r = await withLoopback(f.application, (s) =>
    request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(503),
  );
  expect(r.text).not.toContain("private database diagnostics");
  expect(r.text).not.toContain("Repeat original cancellation");
});
it.each(["admin", "cancel"] as const)(
  "EVCANCEL-05 %s expired or nonfinite handback withholds success",
  async (method) => {
    for (const deadline of [performance.now() - 1, NaN]) {
      const f = fixture();
      if (method === "admin")
        f.port.admin.mockResolvedValue({
          kind: "ready",
          value: { creationEnabled: true },
          observedAt: receipt.cancelledAt,
          deadline,
        });
      else
        f.port.cancel.mockResolvedValue({
          kind: "ready",
          value: { receipt, replayed: false },
          observedAt: receipt.cancelledAt,
          deadline,
        });
      const r = await withLoopback(f.application, (s) =>
        method === "admin"
          ? request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(403)
          : request(s)
              .post(base + "/cancel")
              .set("Cookie", `dne_staff=${token}`)
              .type("form")
              .send(payload())
              .expect(503),
      );
      expect(r.text).not.toContain(receipt.id);
    }
  },
);
it.each(["admin", "cancel"] as const)(
  "EVCANCEL-05 %s expiry during rendering withholds the rendered result",
  async (method) => {
    const f = fixture();
    let clock = 1;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    if (method === "admin")
      f.port.admin.mockResolvedValue({
        kind: "ready",
        observedAt: receipt.cancelledAt,
        deadline: 10,
        value: {
          get creationEnabled() {
            clock = 11;
            return true;
          },
        },
      });
    else
      f.port.cancel.mockResolvedValue({
        kind: "ready",
        observedAt: receipt.cancelledAt,
        deadline: 10,
        value: {
          get receipt() {
            clock = 11;
            return receipt;
          },
          replayed: false,
        },
      });
    const r = await withLoopback(f.application, (s) =>
      method === "admin"
        ? request(s).get(base).set("Cookie", `dne_staff=${token}`).expect(403)
        : request(s)
            .post(base + "/cancel")
            .set("Cookie", `dne_staff=${token}`)
            .type("form")
            .send(payload())
            .expect(503),
    );
    expect(r.text).not.toContain(receipt.id);
  },
);
it("EVCANCEL-05 absent form body never accepts a cancellation", async () => {
  const f = fixture();
  await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .expect(422),
  );
  expect(f.port.cancel).not.toHaveBeenCalled();
});
it("EVCANCEL-05 missing version cannot check a reference", async () => {
  const f = fixture();
  await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/check")
      .set("Cookie", `dne_staff=${token}`)
      .type("form")
      .send({ eventId: event.id })
      .expect(422),
  );
  expect(f.port.preview).not.toHaveBeenCalled();
});
it("EVCANCEL-05 missing capacity cannot authorize a write", async () => {
  const f = fixture();
  const { capacity: _unused, ...body } = payload();
  void _unused;
  await withLoopback(f.application, (s) =>
    request(s)
      .post(base + "/cancel")
      .set("Cookie", `dne_staff=${token}`)
      .type("form")
      .send(body)
      .expect(422),
  );
  expect(f.port.cancel).not.toHaveBeenCalled();
});
