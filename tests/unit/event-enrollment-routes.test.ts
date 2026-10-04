import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountEventEnrollmentRoutes } from "../../src/event-enrollment-routes.ts";
import {
  disabledEventEnrollmentStore,
  type EventEnrollmentStore,
} from "../../src/event-enrollments.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "00000000-0000-4000-8000-000000000001";
const event = {
  id: "rehearsal",
  version: 1,
  status: "current" as const,
  title: "Invented event",
  description: "Sample",
  agenda: [],
  goals: ["everyday" as const],
  domainTags: [],
  itRoles: [],
  startsAt: "2030-01-01T12:00:00.000Z",
  endsAt: "2030-01-01T13:00:00.000Z",
  fixtureCapacity: 1,
  localRegistration: true,
};
const preview = { event, canEnroll: true, remaining: 1, activeReceiptId: null };
const receipt = {
  id,
  eventId: event.id,
  eventVersion: 1,
  title: event.title,
  startsAt: new Date(event.startsAt),
  endsAt: new Date(event.endsAt),
  createdAt: new Date("2029-01-01"),
  withdrawnAt: null,
};
function fixture(overrides: Partial<EventEnrollmentStore> = {}) {
  const store = { ...disabledEventEnrollmentStore(), ...overrides };
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((_, res, next) => {
    res.locals.token = "owner";
    res.locals.csrf = "csrf";
    res.locals.learner = { timezone: "America/Toronto" };
    next();
  });
  mountEventEnrollmentRoutes(app, store);
  return {
    get: (path: string) =>
      withLoopback(app, (server) => request(server).get(path)),
    post: (path: string, body?: unknown) =>
      withLoopback(app, (server) =>
        request(server)
          .post(path)
          .set("Content-Type", "application/json")
          .send(JSON.stringify(body)),
      ),
  };
}
const enrollment = { csrf: "csrf", synthetic: "yes", operation_id: id };
it("renders only the store-authorized history, receipt and exact rehearsal", async () => {
  const history = vi.fn(async () => ({ items: [receipt], nextCursor: null }));
  const source = vi.fn(async () => preview);
  const f = fixture({ history, receipt: async () => receipt, preview: source });
  expect((await f.get(`/events/registrations?after=${id}`)).text).toContain(
    "Your registration history",
  );
  expect(history).toHaveBeenCalledWith("owner", id);
  expect((await f.get(`/events/registrations/${id}`)).text).toContain(
    "Registered for the local rehearsal",
  );
  expect((await f.get("/events/rehearsal/1/rehearsal")).text).toContain(
    "Enroll in local rehearsal",
  );
  expect(source).toHaveBeenCalledWith("owner", "rehearsal", 1);
  await f.get("/events/rehearsal/01/rehearsal");
  expect(source).toHaveBeenLastCalledWith("owner", "rehearsal", NaN);
});
it("denies unavailable objects and malformed history filters", async () => {
  const f = fixture();
  for (const path of [
    "/events/registrations",
    `/events/registrations/${id}`,
    "/events/rehearsal/1/rehearsal",
    "/events/registrations?extra=x",
    "/events/registrations?after=x&after=y",
  ])
    expect((await f.get(path)).status).toBe(404);
  expect((await f.post("/events/rehearsal/1/enroll", enrollment)).status).toBe(
    404,
  );
  expect(
    (
      await fixture({
        preview: async () => ({
          ...preview,
          event: { ...event, localRegistration: false },
        }),
      }).post("/events/rehearsal/1/enroll", enrollment)
    ).status,
  ).toBe(404);
});
it("rejects missing, structured, unconfirmed and extra enrollment fields without a write", async () => {
  const enroll = vi.fn();
  const f = fixture({ preview: async () => preview, enroll });
  for (const body of [
    null,
    [],
    "text",
    { ...enrollment, synthetic: "no" },
    { synthetic: "yes" },
    { ...enrollment, operation_id: [id] },
    { ...enrollment, operation_id: "invalid" },
    { ...enrollment, extra: "field" },
  ])
    expect((await f.post("/events/rehearsal/1/enroll", body)).status).toBe(422);
  expect(enroll).not.toHaveBeenCalled();
});
it.each(["enrolled", "replayed", "already-enrolled"] as const)(
  "redirects a known %s outcome to its exact receipt",
  async (kind) => {
    const enroll = vi.fn(async () => ({ kind, receiptId: id }));
    const result = await fixture({ preview: async () => preview, enroll }).post(
      "/events/rehearsal/1/enroll",
      enrollment,
    );
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe(`/events/registrations/${id}`);
    expect(enroll).toHaveBeenCalledWith("owner", "rehearsal", 1, id);
  },
);
it.each([
  ["full", 409, "No seat was reserved"],
  ["conflict", 409, "different event version"],
  ["unavailable", 404, "New registration is unavailable"],
] as const)(
  "reports %s without inventing a receipt",
  async (kind, status, message) => {
    const result = await fixture({
      preview: async () => preview,
      enroll: async () => ({ kind }),
    }).post("/events/rehearsal/1/enroll", enrollment);
    expect(result.status).toBe(status);
    expect(result.text).toContain(message);
    expect(result.headers.location).toBeUndefined();
  },
);
it("requires exact withdrawal confirmation, accepts terminal replay and denies unavailable attempts", async () => {
  const withdraw = vi.fn(async () => "withdrawn" as const),
    f = fixture({ withdraw });
  for (const body of [
    null,
    [],
    { confirm: ["yes"] },
    { confirm: "no" },
    { confirm: "yes", extra: "field" },
  ])
    expect(
      (await f.post(`/events/registrations/${id}/withdraw`, body)).status,
    ).toBe(422);
  expect(withdraw).not.toHaveBeenCalled();
  for (const outcome of [
    "withdrawn",
    "already-withdrawn",
    "unavailable",
  ] as const) {
    const result = await fixture({ withdraw: async () => outcome }).post(
      `/events/registrations/${id}/withdraw`,
      { confirm: "yes" },
    );
    expect(result.status).toBe(outcome === "unavailable" ? 404 : 303);
  }
});
it("withholds internal failure details and offers only validated original-key recovery", async () => {
  const fail = async (): Promise<never> => {
    throw Error("PRIVATE INTERNAL DETAIL");
  };
  const f = fixture({
    history: fail,
    receipt: fail,
    preview: fail,
    withdraw: fail,
  });
  const results = [
    await f.get("/events/registrations"),
    await f.get(`/events/registrations/${id}`),
    await f.get("/events/registrations/invalid"),
    await f.post("/events/rehearsal/1/enroll", enrollment),
    await f.post("/events/rehearsal/1/enroll", { operation_id: "invalid" }),
    await f.post("/events/rehearsal/1/enroll", null),
    await f.post(`/events/registrations/${id}/withdraw`, { confirm: "yes" }),
  ];
  for (const result of results) {
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("PRIVATE INTERNAL DETAIL");
    expect(result.text).toContain("No automatic retry occurs");
  }
  expect(results[1]!.text).toContain("Check this registration attempt");
  expect(results[3]!.text).toContain("Check this registration attempt");
  expect(results[4]!.text).not.toContain("Check this registration attempt");
});
