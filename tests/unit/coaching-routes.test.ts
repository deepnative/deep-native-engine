import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountCoachingRoutes } from "../../src/coaching-routes.ts";
import { csrf } from "../../src/session.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { expectPortalActions, mainHtml } from "../support/portal-layout.ts";
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
  overrides: [],
  period: { key: "2026-10", start: "2026-10-01", end: "2026-10-31", days: 31 },
  periods: [],
  date: "2026-10-20",
  billing: { schedules: [], version: 0, nextStart: null },
  sample: true,
};
const contractor = (over: Record<string, unknown>) => ({
  id,
  displayName: "Invented contractor",
  rateCents: 9500,
  minutes: null,
  previousMinutes: null,
  yearMinutes: 0,
  status: "not_started",
  sent: null,
  balanceCents: null,
  ...over,
});
const dashboard = {
  month: "2026-09",
  today: month,
  summary: {
    submittedMinutes: 285,
    contractorsSubmitted: 3,
    invoicedCents: 123456,
    invoicesNotSent: 1,
    outstandingCents: 11000,
    awaitingReview: 2,
    oldestWaitingDays: 3,
  },
  contractors: [
    contractor({
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "Ben <Invented>",
      minutes: 120,
      yearMinutes: 120,
      status: "invoiced",
      sent: false,
      balanceCents: 11000,
    }),
    contractor({
      id: "33333333-3333-4333-8333-333333333333",
      displayName: "Ada Invented",
      minutes: 135,
      previousMinutes: 60,
      yearMinutes: 195,
      status: "submitted",
    }),
    contractor({
      id: "44444444-4444-4444-8444-444444444444",
      displayName: null,
      rateCents: null,
      yearMinutes: 30,
      status: "draft",
    }),
    contractor({
      id: "55555555-5555-4555-8555-555555555555",
      displayName: "Cy Invented",
      minutes: 0,
      yearMinutes: 0,
      status: "invoiced",
      sent: true,
      balanceCents: 0,
    }),
  ],
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
    coachingDashboard: vi.fn().mockResolvedValue(ready(dashboard)),
    setCoachingRate: vi.fn().mockResolvedValue(ready({ rateId: id })),
    saveCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 1 })),
    submitCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 2 })),
    returnCoaching: vi.fn().mockResolvedValue(ready({ month, revision: 3 })),
    overrideCoachingHours: vi
      .fn()
      .mockResolvedValue(ready({ month, revision: 2 })),
    setBillingSchedule: vi
      .fn()
      .mockResolvedValue(ready({ version: 1, startsOn: "2026-11-02" })),
    issueCoaching: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  const profiles = {
    read: vi.fn(),
    suggest: vi
      .fn()
      .mockResolvedValue(ready({ name: "", email: "", revision: 0 })),
    save: vi.fn(),
  };
  mountCoachingRoutes(
    app,
    disabled ? undefined : (service as unknown as SimpleInvoiceStore),
    { origin, secret, billingProfiles: profiles },
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
  return { app, service, profiles, get, post };
}
it("WORDING-04 does not call the opening month a past month", async () => {
  const text = (await fixture().get("/account/coaching")).text;
  expect(text).toContain("Choose the month you want to invoice");
  expect(text).not.toContain("past month");
});
it("HOUR01/02/09 keeps empty, disabled, sample and configured states honest and escapes private recipient text", async () => {
  const f = fixture();
  expect((await f.get("/account/coaching")).text).toContain(
    "Request coaching invoice",
  );
  expect((await f.get("/operator/coaching")).text).toContain("Pending periods");
  f.service.adminOverview.mockResolvedValueOnce(
    ready({ members: [], coachingPending: [] }),
  );
  expect((await f.get("/operator/coaching")).text).toContain(
    "No submitted hours await review",
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
it("HOUR07 admin review names the member before the secondary account reference", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, displayName: "Invented <Coaching> member" }),
  );
  const named = (await f.get(`/operator/coaching/${id}`)).text;
  expect(named).toContain(
    `Member: <strong>Invented &lt;Coaching&gt; member</strong> · account reference <code>${id}</code>`,
  );
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, displayName: null }),
  );
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    "Member: <strong>Name needed</strong>",
  );
});
it("DASH-01/02 shows the month's summary and a contractor table above the existing lists", async () => {
  const f = fixture();
  const r = await f.get("/operator/coaching?month=2026-09");
  expect(r.status).toBe(200);
  expect(f.service.coachingDashboard).toHaveBeenCalledWith(token, "2026-09");
  const html = r.text;
  expect(html).toContain('<h2 id="hours-title">Hours for September 2026</h2>');
  expect(html).toContain(
    '<input type="month" name="month" value="2026-09" max="2026-10" required>',
  );
  for (const [label, figure, note] of [
    ["Hours submitted", "4h 45m", "3 contractors"],
    ["Awaiting review", "2", "all months · oldest waiting 3 days"],
    ["Invoiced", "CAD 1,234.56", "1 not yet sent"],
    ["Outstanding", "CAD 110.00", "on this month’s invoices"],
  ])
    expect(html).toContain(
      `<div><dt>${label}</dt><dd>${figure}</dd><p>${note}</p></div>`,
    );
  expect(html).toContain(
    '<a href="/operator/coaching/33333333-3333-4333-8333-333333333333?month=2026-09">Ada Invented</a>',
  );
  expect(html).toContain("Ben &lt;Invented&gt;");
  expect(html).not.toContain("Ben <Invented>");
  expect(html).toContain(
    "<td>CAD 95.00</td><td>2h 15m</td><td>1h</td><td>3h 15m</td><td>Awaiting review</td><td>—</td><td>—</td>",
  );
  expect(html).toContain("<td>Not sent</td><td>CAD 110.00</td>");
  expect(html).toContain(
    "<td>0h</td><td>—</td><td>0h</td><td>Invoiced</td><td>Sent</td><td>Paid</td>",
  );
  expect(html).toContain("Name needed");
  expect(html).toContain("<td>No rate</td>");
  // Default order is by name, missing names last; the existing lists remain.
  const order = (text: string) =>
    [...text.matchAll(/<th scope="row"><a [^>]*>([^<]+)</g)].map((m) => m[1]);
  expect(order(html)).toEqual([
    "Ada Invented",
    "Ben &lt;Invented&gt;",
    "Cy Invented",
    "Name needed",
  ]);
  expect(html).toContain(
    'aria-sort="ascending"><a href="/operator/coaching?month=2026-09&amp;sort=name">Name</a>',
  );
  expect(html.indexOf("Hours for September 2026")).toBeLessThan(
    html.indexOf("<h2>Members</h2>"),
  );
  expect(html).toContain("<h2>Pending periods</h2>");
  const sorted = async (sort: string) =>
    order((await f.get(`/operator/coaching?month=2026-09&sort=${sort}`)).text);
  expect(await sorted("hours")).toEqual([
    "Ada Invented",
    "Ben &lt;Invented&gt;",
    "Cy Invented",
    "Name needed",
  ]);
  expect(await sorted("year")).toEqual([
    "Ada Invented",
    "Ben &lt;Invented&gt;",
    "Name needed",
    "Cy Invented",
  ]);
  expect(await sorted("status")).toEqual([
    "Ada Invented",
    "Name needed",
    "Ben &lt;Invented&gt;",
    "Cy Invented",
  ]);
  expect((await f.get("/operator/coaching?sort=hours")).text).toContain(
    'aria-sort="descending"><a href="/operator/coaching?month=2026-09&amp;sort=hours">Hours</a>',
  );
});
it("DASH-01 words an empty month and a same-day wait plainly", async () => {
  const f = fixture();
  f.service.coachingDashboard.mockResolvedValueOnce(
    ready({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        submittedMinutes: 0,
        contractorsSubmitted: 1,
        awaitingReview: 1,
        oldestWaitingDays: 0,
        invoicesNotSent: 0,
      },
      contractors: [],
    }),
  );
  const html = (await f.get("/operator/coaching")).text;
  expect(html).toContain("<dd>0h</dd><p>1 contractor</p>");
  expect(html).toContain("all months · oldest submitted today");
  expect(html).toContain("<dd>CAD 1,234.56</dd><p>All sent</p>");
  expect(html).toContain(
    "No contractor has a rate or submitted hours for this period.",
  );
  f.service.coachingDashboard.mockResolvedValueOnce(
    ready({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        awaitingReview: 0,
        oldestWaitingDays: null,
      },
      contractors: Array.from({ length: 100 }, () => contractor({})),
    }),
  );
  const full = (await f.get("/operator/coaching")).text;
  expect(full).toContain("<p>all months · none waiting</p>");
  f.service.coachingDashboard.mockResolvedValueOnce(
    ready({
      ...dashboard,
      summary: { ...dashboard.summary, invoicedCents: 0, invoicesNotSent: 0 },
    }),
  );
  expect((await f.get("/operator/coaching")).text).toContain(
    "<dd>CAD 0.00</dd><p>No invoices yet</p>",
  );
  expect(full).toContain("Showing the first 100 contractors.");
});
it("DASH-02 breaks sorting ties by name and keeps unnamed contractors last", async () => {
  const f = fixture();
  const tied = (name: string | null, n: number) =>
    contractor({
      id: `${n}${id.slice(1)}`,
      displayName: name,
      minutes: 60,
      yearMinutes: 60,
      status: "submitted",
    });
  for (const sort of ["name", "hours", "year", "status"]) {
    f.service.coachingDashboard.mockResolvedValueOnce(
      ready({
        ...dashboard,
        contractors: [
          tied(null, 2),
          tied("Zed", 3),
          tied(null, 4),
          tied("Amy", 5),
        ],
      }),
    );
    const html = (await f.get(`/operator/coaching?sort=${sort}`)).text;
    expect(
      [...html.matchAll(/<th scope="row"><a [^>]*>([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Amy", "Zed", "Name needed", "Name needed"]);
  }
});
it("DASH-03 refuses unknown sorting and extra query values, and reports store refusals", async () => {
  const f = fixture();
  for (const query of [
    "sort=amount",
    "sort=hours&sort=name",
    "month=2026-09&extra=1",
  ])
    expect((await f.get(`/operator/coaching?${query}`)).status).toBe(403);
  expect(f.service.coachingDashboard).not.toHaveBeenCalled();
  // Sorting belongs to the dashboard only.
  expect((await f.get(`/operator/coaching/${id}?sort=name`)).status).toBe(403);
  f.service.coachingDashboard.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get("/operator/coaching?month=2999-01")).status).toBe(422);
  f.service.coachingDashboard.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.get("/operator/coaching")).status).toBe(403);
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

it("BILLPROFILE03 suggests the saved recipient only on a new member coaching month, never overwriting a retained draft", async () => {
  const f = fixture();
  f.profiles.suggest.mockResolvedValue(
    ready({
      name: "Reusable <recipient>",
      email: "billing@example.invalid",
      revision: 1,
    }),
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    'value="Reusable &lt;recipient&gt;"',
  );
  f.profiles.suggest.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await f.get("/account/coaching")).status).toBe(503);
  f.service.coachingOverview.mockResolvedValue(ready(value));
  expect((await f.get("/account/coaching")).text).not.toContain(
    'value="Reusable &lt;recipient&gt;"',
  );
});
it("ADMIN-LAYOUT-02 coaching administration groups its lists in cards and navigation as buttons", async () => {
  const f = fixture();
  const overview = (await f.get("/operator/coaching")).text;
  expectPortalActions(overview, [
    ["/operator/invoices", "Courses and invoices"],
    ["/operator", "Administration console"],
  ]);
  const main = mainHtml(overview);
  expect(main).toContain(
    '<section class="invoice-workspace portal-workspace">',
  );
  expect(main).toContain('<section class="portal-card"><h2>Members</h2>');
  expect(main).toContain(
    '<section class="portal-card"><h2>Pending periods</h2>',
  );
  const review = (await f.get(`/operator/coaching/${id}`)).text;
  expectPortalActions(review, [
    ["/operator/coaching", "Choose another member"],
    ["/operator/invoices", "Courses and invoices"],
  ]);
  expect(mainHtml(review)).toContain(
    '<section class="invoice-workspace portal-workspace">',
  );
  const member = mainHtml((await f.get("/account/coaching")).text);
  expect(member).toContain('<section class="invoice-workspace">');
  // AUDIT-03 (#643): student navigation is a button row too.
  expect(member).toContain(
    '<p class="account-links"><a class="button secondary" href="/account">My account</a> <a class="button secondary" href="/account/purchases">Courses and invoices</a></p>',
  );
  expect(member).not.toContain("</a> · <a");
});

it("HOURTABLE-01/02/03 lists saved months as a table with hours, amount, status and invoice", async () => {
  const f = fixture();
  const invoiceId = "22222222-2222-4222-8222-222222222222";
  const months = [
    { month: "2026-10", state: "draft", minutes: 90, returned: false },
    { month: "2026-09", state: "draft", minutes: 30, returned: true },
    {
      month: "2026-08",
      state: "submitted",
      minutes: 120,
      submittedCents: 24000,
    },
    {
      month: "2026-07",
      state: "invoiced",
      minutes: 60,
      invoiceId,
      totalCents: "12000",
      paidCents: "12000",
    },
    {
      month: "2026-06",
      state: "invoiced",
      minutes: 60,
      invoiceId,
      totalCents: "12000",
      paidCents: "2000",
    },
    {
      month: "2026-05",
      state: "invoiced",
      minutes: 60,
      invoiceId,
      totalCents: "12000",
      paidCents: "0",
      voided: true,
    },
    {
      month: "2026-04",
      state: "invoiced",
      minutes: 60,
      invoiceId,
      totalCents: "12000",
      paidCents: "12000",
      refundedCents: "12000",
    },
    {
      month: "2026-03",
      state: "invoiced",
      minutes: 60,
      invoiceId,
      totalCents: "12000",
      paidCents: "12000",
      refundedCents: "2000",
    },
    { month: "2025-01", state: "draft", minutes: 45, returned: false },
  ];
  f.service.coachingOverview.mockResolvedValue(ready({ ...value, months }));
  const page = mainHtml((await f.get(`/account/coaching?month=${month}`)).text);
  const table = page.match(
    /<table class="coaching-months"[\s\S]*?<\/table>/,
  )?.[0];
  expect(table).toBeDefined();
  expect(page).toContain('<div class="table-scroll" role="region"');
  for (const header of ["Period", "Hours", "Amount", "Status", "Invoice"])
    expect(table).toContain(`<th scope="col">${header}</th>`);
  const row = (label: string) =>
    table!.match(
      new RegExp(
        `<tr><th scope="row"><a[^>]*>${label}</a></th>[\\s\\S]*?</tr>`,
      ),
    )?.[0] ?? "";
  expect(row("October 2026")).toContain(
    'href="/account/coaching?month=2026-10"',
  );
  expect(row("October 2026")).toContain("1h 30m");
  expect(row("October 2026")).toContain("CAD 180.00");
  expect(row("October 2026")).toContain("Draft");
  expect(row("September 2026")).toContain("Returned for correction");
  expect(row("August 2026")).toContain("CAD 240.00");
  expect(row("August 2026")).toContain("Awaiting review");
  expect(row("July 2026")).toContain("Invoiced · Paid");
  // MANPAY-04: a refunded month reads as refunded, never as paid or due.
  expect(row("April 2026")).toContain("Invoiced · Refunded");
  expect(row("March 2026")).toContain("Invoiced · Partly refunded");
  expect(row("July 2026")).toContain(
    `href="/account/purchases/invoices/${invoiceId}"`,
  );
  expect(row("June 2026")).toContain("Invoiced · CAD 100.00 due");
  expect(row("May 2026")).toContain("Void");
  // No rate applies to a month before the first effective rate.
  expect(row("January 2025")).toContain("No rate");
  expect(page).not.toContain("<h2>Saved periods</h2><ul>");

  // HOURTABLE-03: the administrator's member view links admin invoices.
  const admin = mainHtml(
    (await f.get(`/operator/coaching/${id}?month=${month}`)).text,
  );
  expect(admin).toContain(`href="/operator/invoices/${invoiceId}"`);
  expect(admin).toContain(`href="/operator/coaching/${id}?month=2026-08"`);
});

it("HOURTABLE-01 prices drafts at the newest applicable rate and labels an invoice without details", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      rates: [
        { id, effectiveMonth: "2026-01", cents: 6000, version: 1 },
        { id, effectiveMonth: "2026-06", cents: 9000, version: 2 },
        { id, effectiveMonth: "2026-06", cents: 10000, version: 3 },
      ],
      months: [
        { month: "2026-08", state: "draft", minutes: 60 },
        { month: "2026-03", state: "draft", minutes: 60 },
        { month: "2026-02", state: "invoiced", minutes: 60, invoiceId: id },
      ],
    }),
  );
  const page = mainHtml((await f.get(`/account/coaching?month=${month}`)).text);
  expect(page).toMatch(/August 2026<\/a><\/th><td>1h<\/td><td>CAD 100\.00/);
  expect(page).toMatch(/March 2026<\/a><\/th><td>1h<\/td><td>CAD 60\.00/);
  expect(page).toMatch(/February 2026[\s\S]*?<td>Invoiced<\/td>/);
  f.service.coachingOverview.mockResolvedValue(ready({ ...value, months: [] }));
  expect(
    mainHtml((await f.get(`/account/coaching?month=${month}`)).text),
  ).toContain("<p>No saved periods.</p>");
});

it("GAPS-03 tells the administrator to set a missing rate, and the member to ask for one", async () => {
  const f = fixture();
  const none = ready({ ...value, rate: null, rateVersion: null });
  f.service.coachingOverview.mockResolvedValue(none);
  const member = (await f.get("/account/coaching")).text;
  expect(member).toContain("Ask the administrator to enter your agreed rate");
  const staff = (await f.get(`/operator/coaching/${id}`)).text;
  expect(staff).toContain("No rate is set for this month. Set the rate below.");
  expect(staff).not.toContain("Ask the administrator");
});
it("ISSUER-03 issues a configured coaching invoice with computed 13% HST and no tax field", async () => {
  const f = fixture();
  (f.service as Record<string, unknown>).tax = {
    label: "HST",
    registration: "713254472RT0001",
    rateBasisPoints: 1300,
  };
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      sample: false,
      entry: {
        ...entry,
        state: "submitted",
        snapshot: { ...snapshot, sample: false },
        submittedRevision: 2,
      },
    }),
  );
  const page = (await f.get(`/operator/coaching/${id}`)).text;
  expect(page).toContain("Issue the reviewed invoice");
  expect(page).toContain("HST at 13% (CAD 23.40) is added");
  expect(page).not.toContain('name="tax"');
  const path = `/operator/coaching/${id}/issue`;
  expect(
    (await f.post(path, { month, action: "issue", confirm: "issue" })).status,
  ).toBe(303);
  expect(f.service.issueCoaching.mock.calls[0]![1]).not.toHaveProperty(
    "taxCents",
  );
  // A typed tax is refused: the server sets HST.
  expect(
    (
      await f.post(path, {
        month,
        action: "issue",
        confirm: "issue",
        tax: "0.00",
      })
    ).status,
  ).toBe(403);
  expect(f.service.issueCoaching).toHaveBeenCalledTimes(1);
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, sample: false }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    "HST at 13% is added when the invoice is issued",
  );
});

it("RECIPIENT-01/02/03 a new month suggests the member or saved recipient, and saving passes edits and an optional company", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  f.profiles.suggest.mockResolvedValue(
    ready({ name: "陳 Registered", email: "", revision: 0 }),
  );
  let text = (await f.get("/account/coaching")).text;
  expect(text).toContain(
    '<label>Invoice recipient name<input name="name" autocomplete="name" maxlength="200" value="陳 Registered" required></label>',
  );
  expect(text).toContain(
    '<label>Company name (optional)<input name="company" autocomplete="organization" maxlength="200" value=""></label>',
  );
  expect(text).toContain(
    "Changes here are saved as your reusable billing recipient for later months.",
  );
  f.profiles.suggest.mockResolvedValue(
    ready({
      name: "Saved",
      email: "saved@example.invalid",
      company: "Invented <Co>",
      revision: 2,
    }),
  );
  text = (await f.get("/account/coaching")).text;
  expect(text).toContain('value="saved@example.invalid"');
  expect(text).toContain('value="Invented &lt;Co&gt;"');
  // A retained draft keeps its own company, even a blank one.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, company: "Draft Co" } }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    'name="company" autocomplete="organization" maxlength="200" value="Draft Co"',
  );
  f.service.coachingOverview.mockResolvedValue(ready(value));
  expect((await f.get("/account/coaching")).text).toContain(
    'name="company" autocomplete="organization" maxlength="200" value=""',
  );
  await f.post("/account/coaching/save", {
    action: "save",
    month,
    hours: "1",
    minutes: "30",
    name: "Edited",
    email: "edited@example.invalid",
    company: "Edited Co",
  });
  expect(f.service.saveCoaching).toHaveBeenLastCalledWith(token, {
    month,
    expectedRevision: 1,
    operationId: id,
    minutes: 90,
    name: "Edited",
    email: "edited@example.invalid",
    company: "Edited Co",
  });
});

it("RECIPIENT-01/05 shows a submitted company and starts empty without a billing profile store", async () => {
  const f = fixture();
  const withCompany = { ...snapshot, company: "Invented <Co>" };
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      entry: {
        ...entry,
        company: "Invented <Co>",
        state: "submitted",
        revision: 2,
        submittedRevision: 2,
        snapshot: withCompany,
      },
    }),
  );
  const review = (await f.get(`/operator/coaching/${id}`)).text;
  expect(review).toContain(
    "Recipient: Invented &lt;member&gt; · Invented &lt;Co&gt; · recipient@example.invalid",
  );
  expect(review).toContain(
    "Invoice recipient: Invented &lt;member&gt; · Invented &lt;Co&gt; · recipient@example.invalid",
  );
  const app = express();
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountCoachingRoutes(
    app,
    {
      coachingOverview: vi
        .fn()
        .mockResolvedValue(ready({ ...value, entry: null })),
    } as unknown as SimpleInvoiceStore,
    { origin, secret },
  );
  const text = (
    await withLoopback(app, (s) => request(s).get("/account/coaching"))
  ).text;
  expect(text).toContain(
    'name="name" autocomplete="name" maxlength="200" value="" required',
  );
  expect(text).toContain(
    'name="email" type="email" autocomplete="email" maxlength="254" value=""',
  );
});

it("WALK44-01 an administrator opening a student reference no account has is told so, with the way back", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  const gone = await f.get(`/operator/coaching/${id}`);
  expect(gone.status).toBe(404);
  expect(gone.text).toContain("<h1>Student account not found</h1>");
  expect(gone.text).toContain("No student account has this reference now.");
  expect(gone.text).toContain("If the student deleted their account");
  expect(gone.text).toContain('href="/operator/coaching"');
  expect(gone.text).toContain('href="/operator/invoices"');
  expect(gone.text).not.toContain("Coaching request not confirmed");
  expect(gone.text).not.toContain("Set member rate");
  // A member's own page never takes that branch.
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  const own = await f.get("/account/coaching");
  expect(own.status).toBe(404);
  expect(own.text).toContain("Coaching request not confirmed");
});
it("DRAFTEMAIL-01/03 lets a member save hours with no invoice email and asks for one before requesting the invoice", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  f.profiles.suggest.mockResolvedValue(
    ready({ name: "Registered", email: "", revision: 0 }),
  );
  let text = (await f.get("/account/coaching")).text;
  expect(text).toContain(
    '<label>Invoice email<input id="invoice-email" name="email" type="email" autocomplete="email" maxlength="254" value=""></label>',
  );
  expect(text).toContain(
    "You can save your hours now and add the invoice email before you request the invoice.",
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, email: "" } }),
  );
  text = (await f.get("/account/coaching")).text;
  // NEXTSTEP-02: the draft's own form shows the recipient; the next step
  // names the missing email.
  expect(text).toContain(
    "Add your invoice email and save, then request the invoice.",
  );
  expect(text).not.toContain("Request coaching invoice");
  expect(text).toContain(
    '<p role="alert">Add your invoice email and save the draft before you request the invoice.</p>',
  );
  await f.post("/account/coaching/save", {
    action: "save",
    month,
    hours: "100",
    minutes: "0",
    name: "Registered",
    email: "",
    company: "",
  });
  expect(f.service.saveCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({ minutes: 6000, email: "" }),
  );
});

const change = {
  previousMinutes: 600,
  minutes: 480,
  reason: "Two <sessions> were cancelled",
  state: "submitted",
  changedAt: new Date("2026-11-12T17:00:00Z"),
  actorName: "Ada <Admin>",
};
it("OVR832-01/02/07 an administrator gets a change-hours form for saved or submitted hours, and both people read each change with its reason", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      overrides: [change],
      months: [{ month, state: "draft", minutes: 480, overridden: true }],
    }),
  );
  const admin = (await f.get(`/operator/coaching/${id}`)).text;
  expect(admin).toContain("<h2>Change this student’s hours</h2>");
  expect(admin).toContain(
    `<form method="post" action="/operator/coaching/${id}/override">`,
  );
  expect(admin).toContain('name="action" value="override"');
  expect(admin).toContain(
    '<label>Reason for the change<input name="reason" maxlength="500" required></label><button>Change hours</button>',
  );
  expect(admin).toContain("The draft stays the student’s to submit.");
  expect(admin).toContain(
    '<h2 id="hours-changes">Hours changed by an administrator</h2>',
  );
  expect(admin).toContain(
    "November 12, 2026 · from <strong>10 hours 0 minutes</strong> to <strong>8 hours 0 minutes</strong> · by Ada &lt;Admin&gt;<p>Reason: Two &lt;sessions&gt; were cancelled</p>",
  );
  expect(admin).toContain(
    '8h <span class="small">changed by an administrator</span>',
  );
  const member = (await f.get("/account/coaching")).text;
  expect(member).not.toContain("Change this student");
  expect(member).not.toContain("Ada");
  expect(member).toContain(
    "An administrator changed the hours you reported here. Your earlier figure is kept below.",
  );
  expect(member).toContain(
    "November 12, 2026 · from <strong>10 hours 0 minutes</strong> to <strong>8 hours 0 minutes</strong><p>Reason: Two &lt;sessions&gt; were cancelled</p>",
  );
  // A submitted month keeps the rate the student confirmed.
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      overrides: [{ ...change, actorName: null }],
      entry: {
        ...entry,
        state: "submitted",
        revision: 2,
        submittedRevision: 2,
        snapshot,
      },
    }),
  );
  const review = (await f.get(`/operator/coaching/${id}`)).text;
  expect(review).toContain(
    "The month stays awaiting review at the rate the student confirmed, and its subtotal is recalculated.",
  );
  expect(review).toContain("</strong> · by an administrator<p>");
});
it("OVR832-03/06 no change-hours form for a month the student has not started or one that is invoiced", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null, months: [] }),
  );
  const empty = (await f.get(`/operator/coaching/${id}`)).text;
  expect(empty).not.toContain("/override");
  expect(empty).toContain(
    "The student has not saved hours for this month. An administrator cannot enter new hours for a student; once the student saves hours, you can change them here.",
  );
  expect((await f.get("/account/coaching")).text).not.toContain(
    "An administrator cannot enter",
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      entry: {
        ...entry,
        state: "invoiced",
        revision: 3,
        submittedRevision: 2,
        snapshot,
        invoiceId: id,
      },
    }),
  );
  const invoiced = (await f.get(`/operator/coaching/${id}`)).text;
  expect(invoiced).not.toContain("/override");
  expect(invoiced).not.toContain("An administrator cannot enter");
});
it("OVR832-01/04/05/08 a posted change carries exact minutes, reason and revision; refusals say why and change nothing", async () => {
  const f = fixture();
  const fields = {
    month,
    action: "override",
    hours: "8",
    minutes: "15",
    reason: "Two sessions were cancelled",
  };
  const ok = await f.post(`/operator/coaching/${id}/override`, fields);
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe(
    `/operator/coaching/${id}?month=${month}#hours-changes`,
  );
  expect(f.service.overrideCoachingHours).toHaveBeenCalledWith(token, {
    ownerId: id,
    month,
    minutes: 495,
    reason: "Two sessions were cancelled",
    expectedRevision: 1,
    operationId: id,
  });
  f.service.overrideCoachingHours.mockClear();
  for (const bad of [
    { hours: "x" },
    { minutes: "60" },
    { action: "return" },
    { extra: "1" },
  ])
    expect(
      (await f.post(`/operator/coaching/${id}/override`, { ...fields, ...bad }))
        .status,
    ).toBeGreaterThanOrEqual(403);
  expect(
    (
      await f.post(
        `/operator/coaching/${id}/override`,
        fields,
        "https://attacker.invalid",
      )
    ).status,
  ).toBe(403);
  expect(f.service.overrideCoachingHours).not.toHaveBeenCalled();
  // The member has no such action.
  expect((await f.post("/account/coaching/override", fields)).status).toBe(404);
  f.service.overrideCoachingHours.mockResolvedValueOnce({ kind: "not-found" });
  const missing = await f.post(`/operator/coaching/${id}/override`, fields);
  expect(missing.status).toBe(404);
  expect(missing.text).toContain(
    "The student has not saved hours for this period, so there is nothing to change. An administrator cannot enter new hours for a student.",
  );
  f.service.overrideCoachingHours.mockResolvedValueOnce({ kind: "invalid" });
  const invalid = await f.post(`/operator/coaching/${id}/override`, fields);
  expect(invalid.status).toBe(422);
  expect(invalid.text).toContain(
    "The hours were not changed. Give a reason, and hours that fit the period and differ from the current figure.",
  );
  f.service.overrideCoachingHours.mockResolvedValueOnce({ kind: "conflict" });
  const stale = await f.post(`/operator/coaching/${id}/override`, fields);
  expect(stale.status).toBe(409);
  expect(stale.text).toContain("This form is out of date");
  const off = fixture(true);
  expect(
    (await off.post(`/operator/coaching/${id}/override`, fields)).status,
  ).toBe(503);
});

// #832 slice B: administrator-defined billing periods.
const twoWeeks = {
    version: 1,
    unit: "days",
    days: 14,
    startsOn: "2026-10-05",
    setOn: "2026-10-01",
  },
  current = {
    key: "2026-10-19",
    start: "2026-10-19",
    end: "2026-11-01",
    days: 14,
  },
  first = {
    key: "2026-10-05",
    start: "2026-10-05",
    end: "2026-10-18",
    days: 14,
  },
  periodic = {
    ...value,
    month: "2026-10-19",
    entry: null,
    months: [],
    period: current,
    periods: [current, first],
    date: "2026-10-20",
    billing: { schedules: [twoWeeks], version: 1, nextStart: "2026-11-02" },
  },
  periodEntry = {
    ...entry,
    month: "2026-10-19",
    periodStart: "2026-10-19",
    periodEnd: "2026-11-01",
  };
it("PERIOD832-01/04 the administrator sees the billing period and a form that asks for a start date only before periods have started", async () => {
  const f = fixture();
  const none = (await f.get(`/operator/coaching/${id}`)).text;
  expect(none).toContain('<h2 id="billing-period">Billing period</h2>');
  expect(none).toContain(
    "No billing period is set, so this student reports hours by calendar month. Set one to have them report per period; 2 weeks is the usual choice.",
  );
  expect(none).toContain(
    `<form method="post" action="/operator/coaching/${id}/billing-period">`,
  );
  // Two weeks is the default; the others are offered.
  expect(none).toContain(
    '<option value="14" selected>2 weeks</option><option value="7">1 week</option><option value="month">1 month</option><option value="custom">Custom number of days</option>',
  );
  expect(none).toContain(
    '<label>First period starts on (UTC date)<input name="startsOn" type="date" value="" required></label>',
  );
  expect(none).toContain("<button>Save billing period</button>");
  // The student is told nothing about a setting that does not exist.
  expect((await f.get("/account/coaching")).text).not.toContain(
    "billing-period",
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...periodic,
      billing: {
        ...periodic.billing,
        version: 2,
        schedules: [
          twoWeeks,
          { ...twoWeeks, version: 2, days: 10, startsOn: "2026-11-02" },
        ],
      },
    }),
  );
  const set = (await f.get(`/operator/coaching/${id}`)).text;
  expect(set).toContain(
    "This student’s billing period: <strong>2 weeks, from 5 Oct 2026; then 10 days from 2 Nov 2026</strong>.",
  );
  expect(set).toContain(
    "A new length applies from 2 Nov 2026, the day after the current period ends. Periods already saved, submitted or invoiced are not changed.",
  );
  expect(set).not.toContain('name="startsOn"');
  expect(set).toContain('<option value="custom" selected>');
  expect(set).toContain(
    'name="days" type="number" min="1" max="31" step="1" value="10"',
  );
  expect(set).toContain('name="revision" value="2"');
  const member = (await f.get("/account/coaching")).text;
  expect(member).toContain('<h2 id="billing-period">Your billing period</h2>');
  expect(member).toContain(
    "Your administrator set your billing period: <strong>2 weeks, from 5 Oct 2026; then 10 days from 2 Nov 2026</strong>.",
  );
  expect(member).not.toContain("Save billing period");
  // A one-month setting that has not started yet.
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      billing: {
        version: 1,
        nextStart: null,
        schedules: [
          { ...twoWeeks, unit: "month", days: null, startsOn: "2026-11-15" },
        ],
      },
    }),
  );
  const pending = (await f.get(`/operator/coaching/${id}`)).text;
  expect(pending).toContain("<strong>1 month from 15 Nov 2026</strong>");
  expect(pending).toContain('<option value="month" selected>');
  expect(pending).toContain('name="startsOn" type="date" value="2026-11-15"');
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...periodic,
      billing: {
        ...periodic.billing,
        schedules: [{ ...twoWeeks, days: 7 }],
      },
    }),
  );
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    '<option value="7" selected>1 week</option>',
  );
});
it("PERIOD832-02 a student on defined periods picks a started period, saves within its length and sees period wording", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(ready(periodic));
  const page = (await f.get("/account/coaching")).text;
  expect(page).toContain(
    '<label>Billing period<select name="month"><option value="2026-10-19" selected>19 Oct 2026 to 1 Nov 2026 (current)</option><option value="2026-10-05">5 Oct 2026 to 18 Oct 2026</option></select></label><button class="secondary">Open period</button>',
  );
  expect(page).not.toContain("Calendar month (UTC)");
  expect(page).toContain("<h2>19 Oct 2026 to 1 Nov 2026</h2>");
  expect(page).toContain(
    "Choose the billing period you want to invoice, enter your coaching hours and minutes",
  );
  expect(page).toContain(
    "then request the invoice. Your administrator reviews it before it is issued",
  );
  expect(page).toContain('name="hours" type="number" min="0" max="336"');
  expect(page).toContain('name="month" value="2026-10-19"');
  expect(page).toContain("reusable billing recipient for later periods");
  expect(page).toContain("effective October 2026");
  // An earlier calendar month the student saved stays in the picker.
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...periodic,
      month,
      period: value.period,
      entry,
      months: [
        { month, state: "draft", minutes: 90 },
        {
          month: "2026-10-19",
          periodStart: "2026-10-19",
          periodEnd: "2026-11-01",
          state: "draft",
          minutes: 60,
        },
      ],
    }),
  );
  const earlier = (await f.get("/account/coaching?month=2026-10")).text;
  expect(earlier).toContain(
    '<option value="2026-10" selected>October 2026</option><option value="2026-10-19">19 Oct 2026 to 1 Nov 2026 (current)</option>',
  );
  expect(earlier).toContain('max="744"');
  expect(earlier).toContain(
    `<a href="/account/coaching?month=2026-10-19">19 Oct 2026 to 1 Nov 2026</a>`,
  );
  expect(earlier).toContain(
    `<a href="/account/coaching?month=2026-10">October 2026</a>`,
  );
  // Confirming a saved period names its dates.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...periodic, entry: periodEntry }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    "I confirm this saved duration, recipient and exact rate version for 19 Oct 2026 to 1 Nov 2026.",
  );
  // Before the first period starts mid-month there is nothing to report yet.
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      entry: null,
      months: [],
      period: null,
      billing: {
        version: 1,
        nextStart: null,
        schedules: [{ ...twoWeeks, startsOn: "2026-10-26" }],
      },
    }),
  );
  for (const [path, whose] of [
    ["/account/coaching", "Your"],
    [`/operator/coaching/${id}`, "This student’s"],
  ]) {
    const waiting = (await f.get(path!)).text;
    expect(waiting).toContain(
      `<h2>No billing period has started</h2><p role="status">${whose} first billing period starts on 26 Oct 2026. Hours can be reported from that day.</p>`,
    );
    expect(waiting).not.toContain("Save coaching draft");
    expect(waiting).not.toContain("An administrator cannot enter");
  }
});
it("PERIOD832-03 the administrator is offered the invoice only after the period's last day", async () => {
  const f = fixture();
  const review = {
    ...periodic,
    entry: {
      ...periodEntry,
      state: "submitted",
      revision: 2,
      submittedRevision: 2,
      snapshot: {
        ...snapshot,
        month: "2026-10-19",
        periodStart: "2026-10-19",
        periodEnd: "2026-11-01",
      },
    },
  };
  for (const date of ["2026-10-20", "2026-11-01"]) {
    f.service.coachingOverview.mockResolvedValue(ready({ ...review, date }));
    const early = (await f.get(`/operator/coaching/${id}`)).text;
    expect(early).toContain(
      '<p role="status">This period ends on 1 Nov 2026. Its invoice can be issued from 2 Nov 2026 (UTC date); until then you can change the hours or return them for correction.</p>',
    );
    expect(early).not.toContain("Issue coaching invoice");
    expect(early).toContain("Return period for correction");
    expect(early).toContain(
      "The period stays awaiting review at the rate the student confirmed",
    );
    expect(early).toContain(
      "<h2>Submitted snapshot</h2><p>19 Oct 2026 to 1 Nov 2026 · ",
    );
  }
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...review, date: "2026-11-02" }),
  );
  const ended = (await f.get(`/operator/coaching/${id}`)).text;
  expect(ended).toContain("<button>Issue coaching invoice</button>");
  expect(ended).not.toContain("Its invoice can be issued from");
  // A crafted or racing post is refused with the reason.
  f.service.issueCoaching.mockResolvedValueOnce({ kind: "invalid" });
  const refused = await f.post(`/operator/coaching/${id}/issue`, {
    month: "2026-10-19",
    action: "issue",
    confirm: "issue",
    tax: "0.00",
  });
  expect(refused.status).toBe(422);
  expect(refused.text).toContain(
    "The invoice was not issued. A billing period can be invoiced only after its last day (UTC date)",
  );
  // An invoiced period words its correction by period; with no hours saved,
  // the administrator is told so by period.
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...review,
      entry: { ...review.entry, state: "invoiced", revision: 3, invoiceId: id },
    }),
  );
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    "To correct an issued period, the administrator must first void its unpaid invoice.",
  );
  f.service.coachingOverview.mockResolvedValue(ready(periodic));
  const empty = (await f.get(`/operator/coaching/${id}`)).text;
  expect(empty).toContain(
    "The student has not saved hours for this period. An administrator cannot enter new hours",
  );
});
it("PERIOD832-01/04/10 a posted billing period carries the exact length, start date and version; refusals say why", async () => {
  const f = fixture();
  const path = `/operator/coaching/${id}/billing-period`;
  const sent = async (fields: Record<string, string>) => {
    f.service.setBillingSchedule.mockClear();
    const response = await f.post(path, { revision: "0", ...fields });
    return [response.status, f.service.setBillingSchedule.mock.calls[0]?.[1]];
  };
  expect(
    await sent({ length: "14", days: "", startsOn: "2026-11-02" }),
  ).toEqual([
    303,
    {
      ownerId: id,
      unit: "days",
      days: 14,
      startsOn: "2026-11-02",
      expectedVersion: 0,
      operationId: id,
    },
  ]);
  expect((await sent({ length: "7", revision: "3" }))[1]).toEqual({
    ownerId: id,
    unit: "days",
    days: 7,
    expectedVersion: 3,
    operationId: id,
  });
  expect((await sent({ length: "month", days: "" }))[1]).toMatchObject({
    unit: "month",
  });
  expect((await sent({ length: "month" }))[1]).not.toHaveProperty("days");
  expect((await sent({ length: "custom", days: "31" }))[1]).toMatchObject({
    unit: "days",
    days: 31,
  });
  const ok = await f.post(path, { length: "14", revision: "0" });
  expect(ok.headers.location).toBe(`/operator/coaching/${id}#billing-period`);
  const refusals: Record<string, string>[] = [
    { length: "21" },
    { length: "custom", days: "" },
    { length: "custom", days: "0" },
    { length: "custom", days: "32" },
    { length: "custom", days: "1.5" },
    { length: "7", days: "9" },
    { days: "9" },
    { length: "14", revision: "x" },
  ];
  for (const bad of refusals) {
    const [status, call] = await sent(bad);
    expect(status).toBe(422);
    expect(call).toBeUndefined();
  }
  const invalid = await f.post(path, { length: "custom", days: "40" });
  expect(invalid.text).toContain(
    "The billing period was not saved. Choose 1 week, 2 weeks or 1 month, or choose a custom number of days and enter 1 to 31",
  );
  f.service.setBillingSchedule.mockResolvedValueOnce({ kind: "invalid" });
  const late = await f.post(path, { length: "14", startsOn: "2026-10-01" });
  expect(late.status).toBe(422);
  expect(late.text).toContain(
    "A first period must start on a valid date within a year of today, after the last month or period the student already saved hours for.",
  );
  f.service.setBillingSchedule.mockResolvedValueOnce({ kind: "conflict" });
  expect((await f.post(path, { length: "14" })).status).toBe(409);
  expect(
    (await f.post(path, { length: "14" }, "https://attacker.invalid")).status,
  ).toBe(403);
  expect((await f.post(path, { length: "14", extra: "1" })).status).toBe(403);
  expect(
    (await f.post("/account/coaching/billing-period", { length: "14" })).status,
  ).toBe(404);
  expect((await fixture(true).post(path, { length: "14" })).status).toBe(503);
});
it("PERIOD832-08 pending periods and the dashboard name and open the right period", async () => {
  const f = fixture();
  f.service.adminOverview.mockResolvedValue(
    ready({
      members: [{ id }],
      coachingPending: [
        {
          ownerId: id,
          month: "2026-10-05",
          periodStart: "2026-10-05",
          periodEnd: "2026-10-18",
          displayName: "Ada",
        },
        { ownerId: id, month, displayName: null },
      ],
    }),
  );
  f.service.coachingDashboard.mockResolvedValue(
    ready({
      ...dashboard,
      contractors: [
        contractor({ displayName: "Period shown", periodKey: "2026-09-21" }),
        contractor({ displayName: "Current period", periodKey: null }),
        contractor({ displayName: "Earlier shape" }),
      ],
    }),
  );
  const page = (await f.get("/operator/coaching")).text;
  expect(page).toContain(
    `<a href="/operator/coaching/${id}?month=2026-10-05">Ada · 5 Oct 2026 to 18 Oct 2026</a>`,
  );
  expect(page).toContain(
    `<a href="/operator/coaching/${id}?month=${month}">Name needed · October 2026</a>`,
  );
  expect(page).toContain(
    `<a href="/operator/coaching/${id}?month=2026-09-21">Period shown</a>`,
  );
  expect(page).toContain(
    `<a href="/operator/coaching/${id}">Current period</a>`,
  );
  expect(page).toContain(
    `<a href="/operator/coaching/${id}?month=2026-09">Earlier shape</a>`,
  );
  expect(page).toContain(
    "A billing period shorter or longer than a calendar month counts in the month it ends",
  );
});

// #836 NEXTSTEP: the student always sees where the month stands and one next
// action, beside the hours form; reference material moves below it.
const card = (html: string) =>
  html.slice(
    html.indexOf('<section class="portal-card next-step"'),
    html.indexOf(
      "</section>",
      html.indexOf('<section class="portal-card next-step"'),
    ),
  );
const currentStep = (html: string) =>
  /<li aria-current="step">([^<]+)<\/li>/.exec(card(html))?.[1];
it("NEXTSTEP-01 shows the five steps and starts at saving hours for a month with nothing saved", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  const text = mainHtml((await f.get("/account/coaching")).text);
  expect(card(text)).toContain('<h3 id="next-step">Next step</h3>');
  expect(card(text)).toContain(
    '<ol class="coaching-steps"><li aria-current="step">Save hours</li><li>Rate set</li><li>Request invoice</li><li>Administrator review</li><li>Invoice issued</li></ol>',
  );
  expect(card(text)).toContain(
    "Enter your coaching hours for October 2026 and save them.",
  );
  expect(card(text)).toContain(
    '<a class="button" href="#hours-form">Enter your hours</a>',
  );
  expect(text).toContain('<form id="hours-form" method="post"');
  expect(text).toContain("Status: Nothing saved yet");
});
it("NEXTSTEP-02 names one plain next action for each state of the month", async () => {
  const f = fixture();
  const show = async (v: unknown) => {
    f.service.coachingOverview.mockResolvedValueOnce(ready(v));
    return mainHtml((await f.get("/account/coaching")).text);
  };
  // Saved, but no rate yet: waiting on the administrator, no button.
  let text = await show({ ...value, rate: null });
  expect(currentStep(text)).toBe("Rate set");
  expect(card(text)).toContain('<li class="done">Save hours</li>');
  expect(card(text)).toContain(
    "Your 1 hour 30 minutes are saved. Your administrator needs to set your hourly rate before you can request the invoice. You can still change your hours.",
  );
  expect(card(text)).not.toContain('class="button"');
  // Rate set, but no invoice email.
  text = await show({ ...value, entry: { ...entry, email: "" } });
  expect(currentStep(text)).toBe("Request invoice");
  expect(card(text)).toContain(
    "Add your invoice email and save, then request the invoice.",
  );
  expect(card(text)).toContain(
    '<a class="button" href="#invoice-email">Add invoice email</a>',
  );
  expect(text).toContain('<input id="invoice-email" name="email"');
  // Ready to request.
  text = await show(value);
  expect(currentStep(text)).toBe("Request invoice");
  expect(card(text)).toContain(
    "Ready to request: 1 hour 30 minutes at CAD 120.00 per hour is CAD 180.00 before tax.",
  );
  expect(card(text)).toContain(
    '<a class="button" href="#request-invoice">Request the invoice</a>',
  );
  expect(text).toContain('<section id="request-invoice">');
  // Returned for correction.
  text = await show({
    ...value,
    entry: { ...entry, returnReason: "Correct <time>" },
  });
  expect(currentStep(text)).toBe("Save hours");
  expect(card(text)).toContain(
    "Your administrator returned these hours: Correct &lt;time&gt;. Correct them and save, then request the invoice again.",
  );
  expect(text).toContain("Status: Returned for correction");
  // Submitted.
  text = await show({
    ...value,
    entry: {
      ...entry,
      state: "submitted",
      revision: 2,
      submittedRevision: 2,
      snapshot,
    },
  });
  expect(currentStep(text)).toBe("Administrator review");
  expect(card(text)).toContain(
    "Your invoice request is with your administrator for review. The invoice appears here once it is issued; nothing is charged on this site.",
  );
  expect(text).toContain("Status: Awaiting review");
  expect(text).not.toContain("revision 2");
  // Invoiced.
  text = await show({
    ...value,
    entry: { ...entry, state: "invoiced", snapshot, invoiceId: id },
  });
  expect(currentStep(text)).toBe("Invoice issued");
  expect(card(text)).toContain(
    `<a class="button" href="/account/purchases/invoices/${id}">View the invoice</a>`,
  );
  expect(text).toContain("Status: Invoice issued");
});
it("NEXTSTEP-03 confirms a save or an invoice request after the redirect", async () => {
  const f = fixture();
  const saved = await f.post("/account/coaching/save", {
    action: "save",
    month,
    hours: "1",
    minutes: "30",
    name: "Invented",
    email: "recipient@example.invalid",
    company: "",
  });
  expect(saved.headers.location).toBe(
    `/account/coaching?month=${month}&done=saved`,
  );
  const requested = await f.post("/account/coaching/submit", {
    action: "submit",
    month,
    rateId: id,
    sample: "true",
    confirm: "submit",
  });
  expect(requested.headers.location).toBe(
    `/account/coaching?month=${month}&done=requested`,
  );
  let text = mainHtml(
    (await f.get(`/account/coaching?month=${month}&done=saved`)).text,
  );
  expect(text).toContain(
    '<p class="notice" role="status">Saved 1 hour 30 minutes for October 2026.</p>',
  );
  text = mainHtml(
    (await f.get(`/account/coaching?month=${month}&done=requested`)).text,
  );
  expect(text).toContain(
    '<p class="notice" role="status">Invoice requested for October 2026. Your administrator will review it.</p>',
  );
  expect(
    (await f.get(`/account/coaching?month=${month}&done=other`)).status,
  ).not.toBe(200);
  // The administrator's own pages keep their redirect.
  expect(
    (await f.get(`/operator/coaching/${id}?month=${month}&done=saved`)).status,
  ).not.toBe(200);
});
it("NEXTSTEP-04 shows the student a plain status and moves reference material below the hours form", async () => {
  const f = fixture();
  // Terms and allowances stay in view below the form; agreed changes fold.
  const terms = express();
  terms.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountCoachingRoutes(terms, f.service as unknown as SimpleInvoiceStore, {
    origin,
    secret,
    coachingTerms: {
      own: vi.fn().mockResolvedValue(ready(null)),
    } as never,
    agreedChanges: {
      own: vi.fn().mockResolvedValue(ready([])),
    } as never,
  });
  const text = mainHtml(
    (await withLoopback(terms, (s) => request(s).get("/account/coaching")))
      .text,
  );
  expect(text).toContain("Status: Draft, not sent yet");
  expect(text).not.toContain("revision 1");
  expect(text).toContain(
    '<details class="coaching-details"><summary>Agreed changes, early release and refunds</summary><section class="portal-card" aria-labelledby="agreed-changes">',
  );
  expect(text.indexOf('id="hours-form"')).toBeLessThan(
    text.indexOf('aria-labelledby="coaching-terms"'),
  );
  expect(text.indexOf('aria-labelledby="coaching-terms"')).toBeLessThan(
    text.indexOf('<details class="coaching-details">'),
  );
  expect(text.indexOf('<section class="portal-card next-step"')).toBeLessThan(
    text.indexOf('id="hours-form"'),
  );
  // The administrator's review page is unchanged.
  const staff = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(staff).toContain("Status: draft · revision 1");
  expect(staff).not.toContain("next-step");
});
it("NEXTSTEP-02 covers the amount limit, a zero total, an invoice still being linked and a period still running", async () => {
  const f = fixture();
  const show = async (v: unknown, q = "") => {
    f.service.coachingOverview.mockResolvedValueOnce(ready(v));
    return mainHtml((await f.get(`/account/coaching${q}`)).text);
  };
  let text = await show({
    ...value,
    entry: { ...entry, minutes: 44640 },
    rate: { ...rate, cents: 1000000000 },
  });
  expect(card(text)).toContain(
    "The saved hours at this rate exceed the invoice amount limit.",
  );
  expect(card(text)).not.toContain('class="button"');
  text = await show({ ...value, entry: { ...entry, minutes: 0 } });
  expect(card(text)).toContain("A zero total creates no invoice.");
  text = await show({
    ...value,
    entry: { ...entry, state: "invoiced", snapshot, invoiceId: null },
  });
  expect(card(text)).toContain("Your invoice has been issued.");
  expect(card(text)).not.toContain('class="button"');
  text = await show({
    ...value,
    month: "2026-10-19",
    date: "2026-10-20",
    period: {
      key: "2026-10-19",
      start: "2026-10-19",
      end: "2026-11-01",
      days: 14,
    },
    entry: { ...entry, state: "submitted", snapshot },
  });
  expect(card(text)).toContain(
    "The invoice can be issued after this period ends on",
  );
  // A stale "saved" link to a month with nothing saved confirms nothing.
  text = await show({ ...value, entry: null }, `?month=${month}&done=saved`);
  expect(text).not.toContain('class="notice"');
});
