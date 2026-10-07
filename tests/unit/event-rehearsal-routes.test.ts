import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { mountEventRehearsalRoutes } from "../../src/event-rehearsal-routes.ts";
import {
  rehearsalSnapshot,
  type EventRehearsalStore,
} from "../../src/event-rehearsal-values.ts";
import type { EventCancellationResult } from "../../src/event-cancellation-values.ts";
import { withLoopback } from "../support/loopback-server.ts";
const base = "/operator/event-rehearsals",
  token = "b".repeat(64),
  key = "44444444-4444-4444-8444-444444444444";
const snapshot = rehearsalSnapshot({
  templateId: "local-registration-rehearsal",
  templateVersion: 1,
  startsAt: "2026-10-07T12:00:00.000Z",
})!;
const receipt = {
  id: "33333333-3333-4333-8333-333333333333",
  eventId: "local-rehearsal-33333333-3333-4333-8333-333333333333",
  eventVersion: 1,
  title: snapshot.title,
  startsAt: new Date(snapshot.startsAt),
  endsAt: new Date(snapshot.endsAt),
  scheduledAt: new Date("2026-10-06T12:00:00Z"),
};
const ready = <T>(
  value: T,
): Extract<EventCancellationResult<T>, { kind: "ready" }> => ({
  kind: "ready",
  value,
  observedAt: receipt.scheduledAt,
  deadline: performance.now() + 60000,
});
const core = {
  csrf: "invented",
  templateId: snapshot.templateId,
  templateVersion: "1",
  startsAt: snapshot.startsAt,
};
const payload: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(snapshot).map(([k, v]) => [k, String(v)]),
  ),
  csrf: "invented",
  key,
};
function fixture(
  options: Parameters<typeof mountEventRehearsalRoutes>[2] = {},
  missing = false,
  integrity = true,
) {
  const port = {
    admin: vi
      .fn<EventRehearsalStore["admin"]>()
      .mockResolvedValue(ready({ creationEnabled: true })),
    preview: vi
      .fn<EventRehearsalStore["preview"]>()
      .mockResolvedValue(ready({ snapshot, creationEnabled: true })),
    schedule: vi
      .fn<EventRehearsalStore["schedule"]>()
      .mockResolvedValue(ready({ receipt, replayed: false })),
    inspectOperation: vi
      .fn<EventRehearsalStore["inspectOperation"]>()
      .mockResolvedValue(ready(receipt)),
    receipt: vi
      .fn<EventRehearsalStore["receipt"]>()
      .mockResolvedValue(ready(receipt)),
  };
  const application = express();
  application.use(express.json());
  application.use(express.urlencoded({ extended: false }));
  application.use((_req, res, next) => {
    if (integrity) res.locals.csrf = "invented";
    next();
  });
  mountEventRehearsalRoutes(application, missing ? undefined : port, {
    mode: "test",
    localStaffEntry: true,
    ...options,
  });
  const get = (path = base, cookie = `dne_staff=${token}`) =>
    withLoopback(application, (s) =>
      request(s).get(path).set("Cookie", cookie),
    );
  const post = (path: string, body: object | undefined) =>
    withLoopback(application, (s) =>
      request(s)
        .post(base + path)
        .set("Cookie", `dne_staff=${token}`)
        .send(body),
    );
  return { port, get, post };
}
afterEach(() => vi.restoreAllMocks());
it.each([{ mode: "live" as const }, { localStaffEntry: false }])(
  "REHSCHED-08 disabled configuration %j hides scheduling",
  async (options) => {
    const f = fixture(options);
    expect((await f.get()).status).toBe(404);
    expect(f.port.admin).not.toHaveBeenCalled();
  },
);
it("REHSCHED-08 absent store hides scheduling", async () => {
  expect((await fixture({}, true).get()).status).toBe(404);
});
it.each([
  "",
  `dne_session=${token}`,
  "dne_staff=bad",
  `dne_staff=${token}; dne_staff=${token}`,
])("REHSCHED-05 selected credential required %s", async (cookie) => {
  const f = fixture();
  expect((await f.get(base, cookie)).status).toBe(403);
  expect(f.port.admin).not.toHaveBeenCalled();
});
it("REHSCHED-01 check then explicit confirmation preserves normalized exact instruction", async () => {
  const f = fixture();
  expect((await f.get()).status).toBe(200);
  const checked = await f.post("/check", core);
  expect(checked.status).toBe(200);
  expect(checked.text).not.toMatch(/type="checkbox"[^>]*\bchecked\b/);
  expect(
    (await f.post("/schedule", { ...payload, confirm: "yes" })).status,
  ).toBe(200);
  expect(f.port.schedule).toHaveBeenCalledWith(token, key, snapshot);
});
it.each([
  {},
  { ...core, extra: "x" },
  { ...core, templateVersion: "01" },
  { ...core, templateVersion: "0" },
  { ...core, startsAt: "invalid" },
])("REHSCHED-04 malformed check refuses %j", async (body) => {
  const f = fixture();
  f.port.preview.mockResolvedValue({ kind: "invalid" });
  expect((await f.post("/check", body)).status).toBe(422);
});
it.each([
  { ...payload },
  { ...payload, confirm: "no" },
  { ...payload, confirm: "yes", extra: "x" },
  { ...payload, confirm: "yes", key: "bad" },
  { ...payload, confirm: "yes", capacity: "01" },
  { ...payload, confirm: "yes", templateDigest: "bad" },
])(
  "REHSCHED-01/04 invalid or unchecked creation %j has no write",
  async (body) => {
    const f = fixture();
    expect((await f.post("/schedule", body)).status).toBe(422);
    expect(f.port.schedule).not.toHaveBeenCalled();
  },
);
it("REHSCHED-06 inspection supports original core or readonly checked snapshot and canonical receipts", async () => {
  const f = fixture();
  expect((await f.post("/inspect", { ...core, key })).status).toBe(200);
  expect((await f.post("/inspect", payload)).status).toBe(200);
  expect(f.port.inspectOperation).toHaveBeenCalledWith(token, key, snapshot);
  expect((await f.get(`${base}/receipts/${receipt.id}`)).status).toBe(200);
  expect((await f.get(`${base}/receipts/bad`)).status).toBe(422);
  expect((await f.post("/inspect", { ...core, key: "bad" })).status).toBe(422);
});
it("REHSCHED-04 unexpected query or oversized/nonstrings refuse before access", async () => {
  const f = fixture();
  expect((await f.get(base + "?unexpected=yes")).status).toBe(422);
  expect(
    (await f.get(`${base}/receipts/${receipt.id}?unexpected=yes`)).status,
  ).toBe(422);
  for (const body of [
    { ...core, startsAt: [] },
    { ...core, startsAt: "x".repeat(201) },
  ])
    expect((await f.post("/check", body)).status).toBe(422);
  expect(
    (await f.post("/schedule?extra=1", { ...payload, confirm: "yes" })).status,
  ).toBe(422);
  expect((await f.post("/check?extra=1", core)).status).toBe(422);
});
it.each(["denied", "invalid", "conflict", "unavailable"] as const)(
  "REHSCHED-06 %s result preserves honest failure without private driver text",
  async (kind) => {
    const f = fixture();
    f.port.schedule.mockResolvedValue({ kind });
    const result = await f.post("/schedule", { ...payload, confirm: "yes" });
    expect(result.status).toBe(
      { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
    );
    expect(
      result.text.includes('action="/operator/event-rehearsals/inspect"'),
    ).toBe(kind === "unavailable");
  },
);
it("REHSCHED-06 unexpected failure offers original manual recovery, never driver text", async () => {
  const f = fixture();
  f.port.schedule.mockRejectedValue(Error("private driver diagnostics"));
  const result = await f.post("/schedule", { ...payload, confirm: "yes" });
  expect(result.status).toBe(503);
  expect(result.text).toContain(key);
  expect(result.text).not.toContain("private driver diagnostics");
});
it.each([NaN, 0])(
  "REHSCHED-05/06 expired or invalid deadline %s withholds success",
  async (deadline) => {
    const f = fixture();
    f.port.admin.mockResolvedValue({
      ...ready({ creationEnabled: true }),
      deadline,
    });
    expect((await f.get()).status).toBe(403);
    f.port.schedule.mockResolvedValue({
      ...ready({ receipt, replayed: false }),
      deadline,
    });
    expect(
      (await f.post("/schedule", { ...payload, confirm: "yes" })).status,
    ).toBe(503);
  },
);
it("REHSCHED-05/06 expiry during synchronous rendering withholds read and write handback", async () => {
  const f = fixture();
  const read = ready({ creationEnabled: true });
  Object.defineProperty(read.value, "creationEnabled", {
    get() {
      read.deadline = 0;
      return true;
    },
  });
  f.port.admin.mockResolvedValue(read);
  expect((await f.get()).status).toBe(403);
  const write = ready({ receipt: { ...receipt }, replayed: false });
  Object.defineProperty(write.value.receipt, "title", {
    get() {
      write.deadline = 0;
      return receipt.title;
    },
  });
  f.port.schedule.mockResolvedValue(write);
  expect(
    (await f.post("/schedule", { ...payload, confirm: "yes" })).status,
  ).toBe(503);
});

it("REHSCHED-04 missing body or missing checked capacity cannot create or inspect a schedule", async () => {
  const f = fixture();
  expect((await f.post("/inspect", undefined)).status).toBe(422);
  const withoutCapacity = { ...payload };
  delete withoutCapacity.capacity;
  expect(
    (await f.post("/schedule", { ...withoutCapacity, confirm: "yes" })).status,
  ).toBe(422);
  expect(f.port.schedule).not.toHaveBeenCalled();
});
it("REHSCHED-05 denial without response integrity does not expose an undefined token", async () => {
  const f = fixture({}, false, false);
  f.port.admin.mockResolvedValue({ kind: "denied" });
  const result = await f.get();
  expect(result.status).toBe(403);
  expect(result.text).not.toContain('value="undefined"');
});
