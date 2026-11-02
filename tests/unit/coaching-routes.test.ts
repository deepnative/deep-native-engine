import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountCoachingRoutes } from "../../src/coaching-routes.ts";
import { csrf } from "../../src/session.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { withLoopback } from "../support/loopback-server.ts";
const id = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64),
  origin = "http://127.0.0.1:3000",
  secret = "coaching-test",
  month = "2026-10";
const rate = { id, effectiveMonth: month, cents: 12000, version: 1 },
  snapshot = {
    month,
    minutes: 90,
    rate,
    subtotalCents: 18000,
    name: "Invented <member>",
    email: "recipient@example.invalid",
    sample: true,
  };
const entry = {
  month,
  minutes: 90,
  name: snapshot.name,
  email: snapshot.email,
  state: "draft",
  revision: 1,
  submittedRevision: null,
  snapshot: null,
  invoiceId: null,
  previousInvoiceId: null,
  returnReason: null,
};
const value = {
  ownerId: id,
  month,
  today: month,
  rates: [rate],
  rate,
  rateVersion: 1,
  entry,
  months: [{ month, state: "draft" }],
  sample: true,
};
const ready = (v: unknown) => ({ kind: "ready", value: v });
function fixture(disabled = false) {
  const service = {
    adminOverview: vi
      .fn()
      .mockResolvedValue(
        ready({ members: [{ id }], coachingPending: [{ ownerId: id, month }] }),
      ),
    coachingOverview: vi.fn().mockResolvedValue(ready(value)),
    setCoachingRate: vi.fn().mockResolvedValue(ready({ rateId: id })),
    saveCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 1 })),
    submitCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 2 })),
    returnCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 3 })),
    issueCoaching: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountCoachingRoutes(
    app,
    disabled ? undefined : (service as unknown as SimpleInvoiceStore),
    { origin, secret },
  );
  const get = (path: string) => withLoopback(app, (s) => request(s).get(path));
  const post = (
    path: string,
    fields: Record<string, unknown> = {},
    o = origin,
  ) =>
    withLoopback(app, (s) =>
      request(s)
        .post(path)
        .set("Origin", o)
        .type("form")
        .send({
          csrf: csrf(token, secret),
          operationId: id,
          revision: "1",
          ...fields,
        }),
    );
  return { app, service, get, post };
}
it("HOUR01/02/09 keeps empty, disabled, sample and configured states honest and escapes private recipient text", async () => {
  const f = fixture();
  expect((await f.get("/operator/coaching")).text).toContain("Pending months");
  f.service.adminOverview.mockResolvedValueOnce(
    ready({ members: [], coachingPending: [] }),
  );
  expect((await f.get("/operator/coaching")).text).toContain(
    "No submitted months",
  );
  for (const path of ["/account/coaching", `/operator/coaching/${id}`]) {
    const r = await f.get(path);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Invented &lt;member&gt;");
    expect(r.headers["cache-control"]).toBe("no-store");
  }
  for (const variant of [
    { ...value, rate: null, entry: null, months: [], rates: [], sample: false },
    { ...value, entry: { ...entry, minutes: 0 } },
    {
      ...value,
      entry: { ...entry, minutes: 44640 },
      rate: { ...rate, cents: 1000000000 },
    },
    { ...value, entry: null, rate: null },
    {
      ...value,
      entry: {
        ...entry,
        state: "draft",
        snapshot,
        returnReason: "Correct <time>",
        previousInvoiceId: id,
      },
    },
    { ...value, sample: false },
    { ...value, entry: null },
  ]) {
    f.service.coachingOverview.mockResolvedValueOnce(ready(variant));
    expect((await f.get("/account/coaching")).status).toBe(200);
  }
  const disabled = fixture(true);
  expect((await disabled.get("/account/coaching")).text).toContain(
    "not configured",
  );
  expect((await disabled.get(`/operator/coaching/${id}`)).status).toBe(503);
  expect((await disabled.get("/operator/coaching")).status).toBe(503);
});
it("HOUR04/08/09 admin review shows immutable submitted detail, correction links, zero totals and mode mismatch", async () => {
  const f = fixture();
  for (const variant of [
    {
      ...value,
      entry: { ...entry, state: "submitted", snapshot, submittedRevision: 2 },
    },
    {
      ...value,
      sample: false,
      entry: {
        ...entry,
        state: "submitted",
        snapshot: { ...snapshot, sample: false },
        submittedRevision: 2,
      },
    },
    {
      ...value,
      entry: {
        ...entry,
        state: "submitted",
        snapshot: { ...snapshot, subtotalCents: 0 },
        submittedRevision: 2,
      },
    },
    {
      ...value,
      sample: false,
      entry: { ...entry, state: "submitted", snapshot, submittedRevision: 2 },
    },
    { ...value, entry: { ...entry, state: "submitted", snapshot: null } },
    {
      ...value,
      entry: {
        ...entry,
        state: "invoiced",
        snapshot,
        invoiceId: id,
        previousInvoiceId: id,
      },
    },
  ]) {
    f.service.coachingOverview.mockResolvedValueOnce(ready(variant));
    expect(
      (await f.get(`/operator/coaching/${id}?month=${month}`)).status,
    ).toBe(200);
  }
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({
      ...value,
      entry: {
        ...entry,
        state: "invoiced",
        snapshot,
        invoiceId: id,
        previousInvoiceId: id,
      },
    }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    `/account/purchases/invoices/${id}`,
  );
});
it("HOUR07 rejects query pollution, unknown/body types, absent body, origin and CSRF before mutation", async () => {
  const f = fixture();
  for (const path of [
    "/account/coaching?ownerId=other",
    "/account/coaching?month=a&month=b",
    "/operator/coaching?unexpected=1",
    `/operator/coaching/${id}?unexpected=1`,
  ])
    expect((await f.get(path)).status).toBe(403);
  for (const fields of [
    { extra: "bad" },
    { csrf: "bad" },
    { revision: ["1", "2"] },
  ])
    expect((await f.post("/account/coaching/save", fields)).status).toBe(403);
  expect(
    (await f.post("/account/coaching/save", {}, "https://other.invalid"))
      .status,
  ).toBe(403);
  expect((await f.post("/account/coaching/save?month=2026-10")).status).toBe(
    403,
  );
  expect(
    (
      await withLoopback(f.app, (s) =>
        request(s).post("/account/coaching/save"),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await withLoopback(f.app, (s) =>
        request(s).post("/account/coaching/save").send([]),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await withLoopback(f.app, (s) =>
        request(s)
          .post("/account/coaching/save")
          .set("Content-Type", "application/json")
          .send("null"),
      )
    ).status,
  ).toBe(400);
  expect(f.service.saveCoaching).not.toHaveBeenCalled();
});
it("HOUR02/03/04/08 mutations retain original keys, exact revisions and explicit amounts", async () => {
  const f = fixture();
  expect(
    (
      await f.post(`/operator/coaching/${id}/rate`, {
        effectiveMonth: month,
        rate: "120.00",
      })
    ).status,
  ).toBe(303);
  expect(f.service.setCoachingRate).toHaveBeenCalledWith(token, {
    ownerId: id,
    effectiveMonth: month,
    cents: 12000,
    expectedVersion: 1,
    operationId: id,
  });
  const actions = [
    {
      action: "save",
      path: "/account/coaching/save",
      fields: {
        hours: "1",
        minutes: "30",
        name: snapshot.name,
        email: snapshot.email,
      },
    },
    {
      action: "submit",
      path: "/account/coaching/submit",
      fields: { rateId: id, sample: "true", confirm: "submit" },
    },
    {
      action: "submit",
      path: "/account/coaching/submit",
      fields: { rateId: id, sample: "false", confirm: "submit" },
    },
    {
      action: "return",
      path: `/operator/coaching/${id}/return`,
      fields: { reason: "Correction" },
    },
    {
      action: "issue",
      path: `/operator/coaching/${id}/issue`,
      fields: { tax: "0.00", confirm: "issue" },
    },
  ];
  for (const a of actions)
    expect(
      (await f.post(a.path, { month, action: a.action, ...a.fields })).status,
    ).toBe(303);
  expect(f.service.saveCoaching).toHaveBeenCalledWith(
    token,
    expect.objectContaining({ minutes: 90 }),
  );
  expect(f.service.submitCoaching).toHaveBeenCalledWith(
    token,
    expect.objectContaining({ sample: false }),
  );
});
it("HOUR03/06 invalid and uncertain writes never silently retry; receipts remain inspectable", async () => {
  const f = fixture();
  expect(
    (
      await f.post(`/operator/coaching/${id}/rate`, {
        effectiveMonth: month,
        rate: "",
      })
    ).status,
  ).toBe(422);
  f.service.setCoachingRate.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (
      await f.post(`/operator/coaching/${id}/rate`, {
        effectiveMonth: month,
        rate: "1.00",
      })
    ).status,
  ).toBe(409);
  for (const [action, fields] of [
    ["save", { hours: "1.5", minutes: "0" }],
    ["submit", { confirm: "wrong" }],
    ["submit", { confirm: "submit", sample: "unknown" }],
    ["issue", { confirm: "issue", tax: "" }],
    ["return", { action: "wrong" }],
  ] as const) {
    const path =
      action === "issue" || action === "return"
        ? `/operator/coaching/${id}/${action}`
        : `/account/coaching/${action}`;
    expect((await f.post(path, { action, month, ...fields })).status).toBe(422);
  }
  for (const admin of [false, true]) {
    const name = admin ? "issueCoaching" : "submitCoaching";
    f.service[name].mockResolvedValueOnce({ kind: "unavailable" });
    const r = await f.post(
      admin ? `/operator/coaching/${id}/issue` : "/account/coaching/submit",
      admin
        ? { action: "issue", confirm: "issue", month, tax: "0.00" }
        : {
            action: "submit",
            confirm: "submit",
            month,
            sample: "true",
            rateId: id,
          },
    );
    expect(r.status).toBe(503);
    expect(r.text).toContain("Inspect original operation");
  }
  for (const path of ["/account/coaching", `/operator/coaching/${id}`]) {
    f.service.coachingOverview.mockResolvedValueOnce({ kind: "denied" });
    expect((await f.get(path)).status).toBe(403);
  }
  f.service.adminOverview.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.get("/operator/coaching")).status).toBe(403);
  const disabled = fixture(true);
  expect((await disabled.post(`/operator/coaching/${id}/rate`)).status).toBe(
    503,
  );
  expect((await disabled.post("/account/coaching/save")).status).toBe(503);
  expect(
    (await f.post(`/operator/coaching/${id}/rate`, { bad: "field" })).status,
  ).toBe(403);
});

it("HOUR05 stale draft saves and correction decisions recover from the current state", async () => {
  const f = fixture();
  f.service.saveCoaching.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (
      await f.post("/account/coaching/save", {
        action: "save",
        month,
        hours: "1",
        minutes: "0",
        name: "Invented",
        email: "member@example.invalid",
      })
    ).status,
  ).toBe(409);
  f.service.returnCoaching.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (
      await f.post(`/operator/coaching/${id}/return`, {
        action: "return",
        month,
        reason: "Changed state",
      })
    ).status,
  ).toBe(409);
});
