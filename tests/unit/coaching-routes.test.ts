import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountCoachingRoutes } from "../../src/coaching-routes.ts";
import { csrf } from "../../src/session.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { mainHtml, portalActionRows } from "../support/portal-layout.ts";
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
function fixture(disabled = false, student: Record<string, unknown> = {}) {
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
    student,
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
  expect(text).toContain(
    "Enter your hours for the month, then request the invoice",
  );
  expect(text).not.toContain("past month");
});
it("HOUR01/02/09 keeps empty, disabled, sample and configured states honest and escapes private recipient text", async () => {
  const f = fixture();
  expect((await f.get("/account/coaching")).text).toContain(
    "Save and request invoice",
  );
  expect((await f.get("/operator/coaching")).text).toContain("Awaiting review");
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
it("HOUR07 #844 PLAIN-01 admin review names the student, with no account reference", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, displayName: "Invented <Coaching> member" }),
  );
  const named = (await f.get(`/operator/coaching/${id}`)).text;
  expect(named).toContain(
    '<h1>Invented &lt;Coaching&gt; member</h1><p class="page-kind">Student</p>',
  );
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, displayName: null }),
  );
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    '<h1>Name needed</h1><p class="page-kind">Student</p>',
  );
});
const noMembers = () => ready({ members: [], coachingPending: [] });
it("DASH-01/02 shows the month's summary and a student table above the awaiting-review list", async () => {
  const f = fixture();
  f.service.adminOverview.mockResolvedValue(noMembers());
  const r = await f.get("/operator/coaching?month=2026-09");
  expect(r.status).toBe(200);
  expect(f.service.coachingDashboard).toHaveBeenCalledWith(token, "2026-09");
  const html = r.text;
  expect(html).toContain('<h2 id="hours-title">Hours for September 2026</h2>');
  expect(html).toContain(
    'href="/operator/coaching?month=2026-08&amp;sort=name"',
  );
  for (const [label, figure, note] of [
    ["Hours submitted", "4h 45m", "3 students"],
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
    '<td role="cell" data-label="Rate">CAD 95.00</td><td role="cell" data-label="Hours">2h 15m</td><td role="cell" data-label="Previous month">1h</td><td role="cell" data-label="Year to date">3h 15m</td><td role="cell" data-label="Status">Awaiting review</td><td role="cell" data-label="Invoice email">—</td><td role="cell" data-label="Balance">—</td>',
  );
  expect(html).toContain(
    '<td role="cell" data-label="Invoice email">Not sent</td><td role="cell" data-label="Balance">CAD 110.00</td>',
  );
  expect(html).toContain(
    '<td role="cell" data-label="Hours">0h</td><td role="cell" data-label="Previous month">—</td><td role="cell" data-label="Year to date">0h</td><td role="cell" data-label="Status">Invoiced</td><td role="cell" data-label="Invoice email">Sent</td><td role="cell" data-label="Balance">Paid</td>',
  );
  expect(html).toContain("Name needed");
  expect(html).toContain('<td role="cell" data-label="Rate">No rate</td>');
  // Default order is by name, missing names last; the existing lists remain.
  const order = (text: string) =>
    [
      ...text.matchAll(/<th scope="row" role="rowheader"><a [^>]*>([^<]+)</g),
    ].map((m) => m[1]);
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
    html.indexOf('<h2 id="awaiting-review">Awaiting review</h2>'),
  );
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
  f.service.adminOverview.mockResolvedValue(noMembers());
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
  expect(html).toContain("<dd>0h</dd><p>1 student</p>");
  expect(html).toContain("all months · oldest submitted today");
  expect(html).toContain("<dd>CAD 1,234.56</dd><p>All sent</p>");
  expect(html).toContain(
    "No student has a rate or submitted hours for this month.",
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
  expect(full).toContain("Showing the first 100 students.");
});
it("DASH-02 breaks sorting ties by name and keeps unnamed students last", async () => {
  const f = fixture();
  f.service.adminOverview.mockResolvedValue(noMembers());
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
      [
        ...html.matchAll(/<th scope="row" role="rowheader"><a [^>]*>([^<]+)</g),
      ].map((m) => m[1]),
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
it("ADMIN-LAYOUT-02 coaching administration groups its lists in cards; #850 BACK-01 the menu replaces the button rows", async () => {
  const f = fixture();
  const overview = (await f.get("/operator/coaching")).text;
  expect(portalActionRows(overview)).toEqual([]);
  const main = mainHtml(overview);
  expect(main).toContain(
    '<section class="invoice-workspace portal-workspace"><nav class="admin-menu"',
  );
  expect(main).toContain(
    '<section class="portal-card" aria-labelledby="awaiting-review"><h2 id="awaiting-review">Awaiting review</h2>',
  );
  const review = (await f.get(`/operator/coaching/${id}`)).text;
  expect(portalActionRows(review)).toEqual([]);
  expect(mainHtml(review)).toContain(
    '<section class="invoice-workspace coaching-page portal-workspace"><nav class="admin-menu"',
  );
  const member = mainHtml((await f.get("/account/coaching")).text);
  expect(member).toContain('<section class="invoice-workspace coaching-page">');
  // #850 BACK-01: the header has My account; one text link reaches Invoices.
  expect(member).toContain(
    '<p class="back-link"><a href="/account/purchases">Invoices</a></p>',
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
    /<table class="coaching-months stack-table"[\s\S]*?<\/table>/,
  )?.[0];
  expect(table).toBeDefined();
  expect(page).toContain('<div class="table-scroll" role="region"');
  for (const header of ["Period", "Hours", "Amount", "Status", "Invoice"])
    expect(table).toContain(
      `<th scope="col" role="columnheader">${header}</th>`,
    );
  const row = (label: string) =>
    table!.match(
      new RegExp(
        `<tr role="row"><th scope="row" role="rowheader"><a[^>]*>${label}</a></th>[\\s\\S]*?</tr>`,
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
  expect(page).toMatch(
    /August 2026<\/a><\/th><td role="cell" data-label="Hours">1h<\/td><td role="cell" data-label="Amount">CAD 100\.00/,
  );
  expect(page).toMatch(
    /March 2026<\/a><\/th><td role="cell" data-label="Hours">1h<\/td><td role="cell" data-label="Amount">CAD 60\.00/,
  );
  expect(page).toMatch(
    /February 2026[\s\S]*?<td role="cell" data-label="Status">Invoiced<\/td>/,
  );
  f.service.coachingOverview.mockResolvedValue(ready({ ...value, months: [] }));
  expect(
    mainHtml((await f.get(`/account/coaching?month=${month}`)).text),
  ).toContain("<p>No saved periods.</p>");
});

it("GAPS-03 tells the administrator to set a missing rate, and the student to ask for one", async () => {
  const f = fixture();
  const none = ready({ ...value, rate: null, rateVersion: null });
  f.service.coachingOverview.mockResolvedValue(none);
  const member = (await f.get("/account/coaching")).text;
  expect(member).toContain(
    "Ask your coach or administrator to set it, then come back here to request the invoice.",
  );
  expect(member).toContain("Rate: not set yet");
  const staff = (await f.get(`/operator/coaching/${id}`)).text;
  expect(staff).toContain(
    "No rate is set for this month. Set it under Hourly rate.",
  );
  expect(staff).not.toContain("Ask your coach");
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

it("RECIPIENT-01/02/03 a new month carries the member or saved recipient in the form, and saving passes edits and an optional company", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  f.profiles.suggest.mockResolvedValue(
    ready({ name: "陳 Registered", email: "", revision: 0 }),
  );
  let text = (await f.get("/account/coaching")).text;
  // #842 NOEMAIL-01: the recipient travels as hidden fields, shown in one line.
  expect(text).toContain(
    '<input type="hidden" name="name" value="陳 Registered"><input type="hidden" name="email" value=""><input type="hidden" name="company" value="">',
  );
  expect(text).toContain(
    '<p class="invoice-to">Invoice to: <strong>陳 Registered</strong>. <a href="/account/billing">Change</a>',
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
  expect(text).toContain(
    '<input type="hidden" name="email" value="saved@example.invalid">',
  );
  expect(text).toContain(
    '<input type="hidden" name="company" value="Invented &lt;Co&gt;">',
  );
  expect(text).toContain(
    "Invoice to: <strong>Saved</strong> · Invented &lt;Co&gt; · saved@example.invalid.",
  );
  // A retained draft with an email keeps its own company, even a blank one.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, company: "Draft Co" } }),
  );
  expect((await f.get("/account/coaching")).text).toContain(
    '<input type="hidden" name="company" value="Draft Co">',
  );
  f.service.coachingOverview.mockResolvedValue(ready(value));
  expect((await f.get("/account/coaching")).text).toContain(
    '<input type="hidden" name="company" value="">',
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

it("RECIPIENT-01/05 shows a submitted company and falls back to Student without a billing profile store", async () => {
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
    "<p>Invoice to: Invented &lt;member&gt; · Invented &lt;Co&gt; · recipient@example.invalid</p>",
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
    '<input type="hidden" name="name" value="Student"><input type="hidden" name="email" value="">',
  );
  expect(text).toContain("Invoice to: <strong>Student</strong>.");
});

it("WALK44-01 an administrator opening a student reference no account has is told so, with the way back", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  const gone = await f.get(`/operator/coaching/${id}`);
  expect(gone.status).toBe(404);
  expect(gone.text).toContain("<h1>Student account not found</h1>");
  expect(gone.text).toContain("No student account has this reference now.");
  expect(gone.text).toContain("If the student deleted their account");
  expect(mainHtml(gone.text)).toContain(
    '<p class="back-link"><a href="/operator">All students</a></p>',
  );
  expect(gone.text).not.toContain("Coaching request not confirmed");
  expect(gone.text).not.toContain("Set member rate");
  // A member's own page never takes that branch.
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  const own = await f.get("/account/coaching");
  expect(own.status).toBe(404);
  expect(own.text).toContain("Coaching request not confirmed");
});
it("DRAFTEMAIL-01/03 lets a member save and request hours with no invoice email, never asking for one", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  f.profiles.suggest.mockResolvedValue(
    ready({ name: "Registered", email: "", revision: 0 }),
  );
  let text = (await f.get("/account/coaching")).text;
  expect(text).not.toContain("Invoice email");
  expect(text).toContain('<input type="hidden" name="email" value="">');
  expect(text).toContain(
    '<br><span class="small">The invoice will be under Invoices.</span></p>',
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, email: "" } }),
  );
  text = (await f.get("/account/coaching")).text;
  // #842 NOEMAIL-02: a draft without an email is ready to request.
  expect(text).toContain(
    "Ready to request: 1 hour 30 minutes at CAD 120.00 per hour is CAD 180.00 before tax.",
  );
  expect(text).not.toContain("Add your invoice email");
  expect(text).not.toContain('name="email" type="email"');
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

// #842 NOEMAIL-01..02: the student is never asked for an invoice email.
const invoiceTo = (html: string) =>
  /<p class="invoice-to">[\s\S]*?<\/p>/.exec(html)?.[0];
const hiddenRecipient = (html: string) =>
  ["name", "email", "company"].map(
    (n) =>
      new RegExp(`<input type="hidden" name="${n}" value="([^"]*)">`).exec(
        html,
      )?.[1],
  );
it("NOEMAIL-01 the hours form has no recipient inputs, only one invoice-to line and a link to change it", async () => {
  const f = fixture();
  const text = (await f.get("/account/coaching")).text;
  for (const label of [
    "Invoice recipient name",
    "Invoice email",
    "Company name (optional)",
  ])
    expect(text).not.toContain(label);
  expect(text).not.toContain('autocomplete="email"');
  expect(text).not.toContain("reusable billing recipient");
  expect(invoiceTo(text)).toBe(
    '<p class="invoice-to">Invoice to: <strong>Invented &lt;member&gt;</strong> · recipient@example.invalid. <a href="/account/billing">Change</a></p>',
  );
  // The suggestion is read even when a draft exists.
  expect(f.profiles.suggest).toHaveBeenCalledWith(token);
});
it("NOEMAIL-01 prefers the draft's email, then the saved recipient's, then a name with no email", async () => {
  const f = fixture();
  f.profiles.suggest.mockResolvedValue(
    ready({
      name: "Saved <name>",
      email: "saved@example.invalid",
      company: "Saved Co",
      revision: 1,
    }),
  );
  // A draft with an email wins over the saved recipient.
  let text = (await f.get("/account/coaching")).text;
  expect(hiddenRecipient(text)).toEqual([
    "Invented &lt;member&gt;",
    "recipient@example.invalid",
    "",
  ]);
  // A draft without an email takes the whole saved recipient.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, email: "", company: "Draft Co" } }),
  );
  text = (await f.get("/account/coaching")).text;
  expect(hiddenRecipient(text)).toEqual([
    "Saved &lt;name&gt;",
    "saved@example.invalid",
    "Saved Co",
  ]);
  expect(invoiceTo(text)).toContain(
    "Invoice to: <strong>Saved &lt;name&gt;</strong> · Saved Co · saved@example.invalid.",
  );
  expect(invoiceTo(text)).not.toContain("Courses and invoices");
  // Neither has an email: the draft's name, no email and the note.
  f.profiles.suggest.mockResolvedValue(
    ready({ name: "Saved", email: "", revision: 1 }),
  );
  text = (await f.get("/account/coaching")).text;
  expect(hiddenRecipient(text)).toEqual(["Invented &lt;member&gt;", "", ""]);
  expect(invoiceTo(text)).toBe(
    '<p class="invoice-to">Invoice to: <strong>Invented &lt;member&gt;</strong>. <a href="/account/billing">Change</a><br><span class="small">The invoice will be under Invoices.</span></p>',
  );
  // A draft with no name and no email takes the saved name.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: { ...entry, name: "", email: "" } }),
  );
  expect(hiddenRecipient((await f.get("/account/coaching")).text)[0]).toBe(
    "Saved",
  );
});
it("NOEMAIL-01 falls back to the account name, then Student", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null, displayName: "Ada <Account>" }),
  );
  let text = (await f.get("/account/coaching")).text;
  expect(hiddenRecipient(text)).toEqual(["Ada &lt;Account&gt;", "", ""]);
  expect(invoiceTo(text)).toContain(
    "Invoice to: <strong>Ada &lt;Account&gt;</strong>.",
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null, displayName: null }),
  );
  text = (await f.get("/account/coaching")).text;
  expect(hiddenRecipient(text)).toEqual(["Student", "", ""]);
  expect(invoiceTo(text)).toContain("The invoice will be under Invoices.");
});
it("NOEMAIL-02 a month submitted without an email reads its recipient with no email and no gap", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      entry: {
        ...entry,
        email: "",
        state: "submitted",
        revision: 2,
        submittedRevision: 2,
        snapshot: { ...snapshot, email: "" },
        returnReason: "Earlier <reason>",
      },
    }),
  );
  for (const path of ["/account/coaching", `/operator/coaching/${id}`])
    expect((await f.get(path)).text).not.toContain("no invoice email yet");
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    "<p>Invoice to: Invented &lt;member&gt;</p>",
  );
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    '<p role="status">Returned for correction: Earlier &lt;reason&gt;</p>',
  );
  // The request form refuses fields it does not know before anything else.
  expect(
    (
      await f.post("/account/coaching/request", {
        ...requestFields,
        extra: "x",
      })
    ).status,
  ).toBe(403);
  expect(f.service.saveCoaching).not.toHaveBeenCalled();
});
it("NOEMAIL-02 a request with no invoice email is saved and submitted", async () => {
  const f = fixture();
  const r = await f.post("/account/coaching/request", {
    action: "request",
    month,
    hours: "2",
    minutes: "15",
    name: "Student",
    email: "",
    company: "",
    rateId: id,
    sample: "true",
    confirm: "submit",
  });
  expect(r.status).toBe(303);
  expect(r.headers.location).toBe(
    `/account/coaching?month=${month}&done=requested`,
  );
  expect(f.service.saveCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({ minutes: 135, name: "Student", email: "" }),
  );
  expect(f.service.submitCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({ month, rateId: id, sample: true }),
  );
  // An unconfirmed request still names only what is missing.
  const refused = await f.post("/account/coaching/request", {
    action: "request",
    month,
    hours: "2",
    minutes: "15",
    name: "Student",
    email: "",
    company: "",
    rateId: id,
    sample: "true",
  });
  expect(refused.status).toBe(422);
  expect(refused.text).toContain(
    "Enter whole hours and minutes and tick the confirmation.",
  );
  expect(refused.text).not.toContain("invoice email");
});
// #842 MONTHNAV-01: previous and next month links replace the month box.
const monthNavHtml = (html: string) =>
  /<nav class="month-nav"[\s\S]*?<\/nav>/.exec(html)?.[0];
it("MONTHNAV-01 links to the previous month always and the next month only up to the current month", async () => {
  const f = fixture();
  let text = (await f.get("/account/coaching")).text;
  expect(text).not.toContain("Calendar month (UTC)");
  expect(text).not.toContain("Open month");
  expect(text).not.toContain('type="month"');
  expect(monthNavHtml(text)).toBe(
    '<nav class="month-nav" aria-label="Months"><a href="/account/coaching?month=2026-09">‹ September 2026</a></nav>',
  );
  // An earlier month links forward, up to and including the current one.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, month: "2026-09" }),
  );
  text = (await f.get("/account/coaching?month=2026-09")).text;
  expect(monthNavHtml(text)).toBe(
    '<nav class="month-nav" aria-label="Months"><a href="/account/coaching?month=2026-08">‹ August 2026</a><a href="/account/coaching?month=2026-10">October 2026 ›</a></nav>',
  );
  // Links cross a year and keep the administrator on the student's page.
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, month: "2026-01", today: "2026-01" }),
  );
  expect(monthNavHtml((await f.get(`/operator/coaching/${id}`)).text)).toBe(
    `<nav class="month-nav" aria-label="Months"><a href="/operator/coaching/${id}?month=2025-12">‹ December 2025</a></nav>`,
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, month: "2025-12", today: "2026-01" }),
  );
  expect(monthNavHtml((await f.get(`/operator/coaching/${id}`)).text)).toBe(
    `<nav class="month-nav" aria-label="Months"><a href="/operator/coaching/${id}?month=2025-11">‹ November 2025</a><a href="/operator/coaching/${id}?month=2026-01">January 2026 ›</a></nav>`,
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
  expect(admin).toContain(
    '<details class="coaching-details"><summary>Change this student’s hours</summary>',
  );
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
  expect(none).toContain(
    '<details class="coaching-details" id="billing-period"><summary>Billing period: calendar month</summary>',
  );
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
    '<label>First period starts on<input name="startsOn" type="date" value="" required></label>',
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
    "Enter your hours for the billing period, then request the invoice; your administrator reviews it before it is issued",
  );
  expect(page).toContain('name="hours" type="number" min="0" max="336"');
  expect(page).toContain('name="month" value="2026-10-19"');
  expect(page).toContain(
    '<p class="invoice-to">Invoice to: <strong>Student</strong>. <a href="/account/billing">Change</a>',
  );
  expect(page).not.toContain('class="month-nav"');
  expect(page).toContain("Rate: CAD 120.00 per hour");
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
    "I confirm these hours, recipient and the rate CAD 120.00 per hour for 19 Oct 2026 to 1 Nov 2026.",
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
      '<p role="status">This period ends on 1 Nov 2026. Its invoice can be issued from 2 Nov 2026; until then you can change the hours or return them for correction.</p>',
    );
    expect(early).not.toContain("Issue coaching invoice");
    expect(early).toContain("Return period for correction");
    expect(early).toContain(
      "The period stays awaiting review at the rate the student confirmed",
    );
    expect(early).toContain("<p>Submitted: ");
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
    "The invoice was not issued. A billing period can be invoiced only after its last day;",
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
it("NEXTSTEP-01 #844 STUDENT-01 shows the four steps and starts at saving hours for a month with nothing saved", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  const text = mainHtml((await f.get("/account/coaching")).text);
  expect(card(text)).toContain('<h3 id="next-step">Next step</h3>');
  expect(card(text)).toContain(
    '<ol class="coaching-steps"><li aria-current="step">Save hours</li><li>Request invoice</li><li>Review</li><li>Invoice issued</li></ol>',
  );
  // ONEPAGE-01: the form is right below; the card points to it in words.
  expect(card(text)).toContain(
    "Enter your coaching hours for October 2026 below, then choose Save and request invoice.",
  );
  expect(card(text)).not.toContain('class="button"');
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
  expect(currentStep(text)).toBe("Request invoice");
  expect(card(text)).toContain('<li class="done">Save hours</li>');
  expect(card(text)).toContain(
    "Your 1 hour 30 minutes are saved. Your hourly rate isn't set yet, so the invoice can't be requested. Ask your coach or administrator to set it, then come back here to request the invoice.",
  );
  expect(card(text)).not.toContain('class="button"');
  // Rate set, no invoice email: #842 NOEMAIL-02 still ready to request.
  text = await show({ ...value, entry: { ...entry, email: "" } });
  expect(currentStep(text)).toBe("Request invoice");
  expect(card(text)).toContain(
    "Ready to request: 1 hour 30 minutes at CAD 120.00 per hour is CAD 180.00 before tax.",
  );
  expect(card(text)).not.toContain('class="button"');
  expect(text).toContain('<input type="hidden" name="email" value="">');
  // Ready to request.
  text = await show(value);
  expect(currentStep(text)).toBe("Request invoice");
  expect(card(text)).toContain(
    "Ready to request: 1 hour 30 minutes at CAD 120.00 per hour is CAD 180.00 before tax. Check your hours below and choose Save and request invoice.",
  );
  expect(card(text)).not.toContain('class="button"');
  // Returned for correction.
  text = await show({
    ...value,
    entry: { ...entry, returnReason: "Correct <time>" },
  });
  expect(currentStep(text)).toBe("Save hours");
  expect(card(text)).toContain(
    "Your administrator returned these hours: Correct &lt;time&gt;. Correct them below and choose Save and request invoice.",
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
  expect(currentStep(text)).toBe("Review");
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
    `<a class="button" href="/account/purchases/invoices/${id}">View invoice</a>`,
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
      own: vi.fn().mockResolvedValue(ready(packageTerms)),
    } as never,
    agreedChanges: {
      own: vi.fn().mockResolvedValue(ready([agreedRow])),
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
  // The administrator's review page has no Next step card.
  const staff = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(staff).toContain("<p>Status: Draft</p><p>Saved hours: 1h 30m</p>");
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

// #838 ONEPAGE: hours, recipient and the invoice request are one form.
const hoursForm = (html: string) =>
  html.slice(
    html.indexOf('<form id="hours-form"'),
    html.indexOf("</form>", html.indexOf('<form id="hours-form"')),
  );
const requestFields = {
  action: "request",
  month,
  hours: "2",
  minutes: "15",
  name: "Invented",
  email: "recipient@example.invalid",
  company: "",
  rateId: id,
  sample: "true",
  confirm: "submit",
};
it("ONEPAGE-01 puts the hours, recipient and invoice request in one form with Save draft first", async () => {
  const f = fixture();
  const text = mainHtml((await f.get("/account/coaching")).text);
  const form = hoursForm(text);
  expect(form).toContain('action="/account/coaching/save"');
  expect(form).toContain(
    '<input type="hidden" name="email" value="recipient@example.invalid">',
  );
  expect(form).toContain(
    '<p class="invoice-to">Invoice to: <strong>Invented &lt;member&gt;</strong> · recipient@example.invalid. <a href="/account/billing">Change</a></p>',
  );
  expect(form).toContain(
    "<h3>Request the invoice</h3><p>The subtotal is your hours × your hourly rate, before tax.</p>",
  );
  expect(form).toContain(
    '<label class="check"><input type="checkbox" name="confirm" value="submit" required><span>I confirm these hours, recipient and the rate CAD 120.00 per hour for October 2026. This is a sample, not payable.</span></label>',
  );
  expect(form).toContain(
    `<input type="hidden" name="rateId" value="${id}"><input type="hidden" name="sample" value="true">`,
  );
  // Enter submits the first button, so the safe one comes first.
  expect(form).toContain(
    '<div class="form-actions"><button class="secondary" name="action" value="save" formnovalidate>Save draft</button><button name="action" value="request" formaction="/account/coaching/request">Save and request invoice</button></div>',
  );
  expect(text).not.toContain('action="/account/coaching/submit"');
  expect(text).not.toContain("Request coaching invoice");
});
it("ONEPAGE-01 saves the entered values and requests the invoice in one step", async () => {
  const f = fixture();
  f.service.saveCoaching.mockResolvedValueOnce(ready({ month, revision: 4 }));
  const r = await f.post("/account/coaching/request", {
    ...requestFields,
    revision: "3",
  });
  expect(r.status).toBe(303);
  expect(r.headers.location).toBe(
    `/account/coaching?month=${month}&done=requested`,
  );
  expect(f.service.saveCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({
      month,
      minutes: 135,
      expectedRevision: 3,
      email: "recipient@example.invalid",
    }),
  );
  expect(f.service.submitCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({
      month,
      expectedRevision: 4,
      rateId: id,
      sample: true,
    }),
  );
  // Each step keeps its own operation key.
  const saveKey = f.service.saveCoaching.mock.lastCall![1].operationId,
    submitKey = f.service.submitCoaching.mock.lastCall![1].operationId;
  expect(saveKey).toBe(id);
  expect(submitKey).not.toBe(saveKey);
});
it("ONEPAGE-02 refuses a request without confirmation or an email field, and says when the hours were saved but not requested", async () => {
  const f = fixture();
  const noEmail: Record<string, string> = { ...requestFields };
  delete noEmail.email;
  for (const fields of [
    { ...requestFields, confirm: "" },
    noEmail,
    { ...requestFields, sample: "maybe" },
    { ...requestFields, hours: "x" },
  ]) {
    expect((await f.post("/account/coaching/request", fields)).status).toBe(
      422,
    );
  }
  expect(f.service.saveCoaching).not.toHaveBeenCalled();
  f.service.saveCoaching.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (await f.post("/account/coaching/request", requestFields)).status,
  ).toBe(409);
  expect(f.service.submitCoaching).not.toHaveBeenCalled();
  f.service.submitCoaching.mockResolvedValueOnce({ kind: "conflict" });
  const half = await f.post("/account/coaching/request", requestFields);
  expect(half.status).toBe(409);
  expect(half.text).toContain(
    "Your hours were saved, but the invoice was not requested.",
  );
  expect(half.text).toContain(
    `<a href="/account/coaching?month=${month}">Return to coaching hours</a>`,
  );
  // The administrator has no request action.
  expect(
    (await f.post(`/operator/coaching/${id}/request`, requestFields)).status,
  ).toBe(404);
});
it("ONEPAGE-03 with no rate shows the request button unavailable and says to ask the coach", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, rate: null, rates: [] }),
  );
  const form = hoursForm(mainHtml((await f.get("/account/coaching")).text));
  expect(form).toContain(
    "<h3>Request the invoice</h3><p class=\"rate-missing\">Your hourly rate for October 2026 isn't set yet, so the invoice can't be requested. Ask your coach or administrator to set it. You can save your hours now and request the invoice here once it's set.</p>",
  );
  expect(form).toContain(
    '<div class="form-actions"><button name="action" value="save">Save draft</button><button type="button" disabled>Save and request invoice</button></div>',
  );
  expect(form).not.toContain('name="confirm"');
  expect(form).toContain(
    '<input type="hidden" name="email" value="recipient@example.invalid">',
  );
});
it("ONEPAGE-03 confirms a save with no rate by saying what to ask for", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, rate: null, rates: [] }),
  );
  const text = mainHtml(
    (await f.get(`/account/coaching?month=${month}&done=saved`)).text,
  );
  expect(text).toContain(
    '<p class="notice" role="status">Saved 1 hour 30 minutes for October 2026. Ask your coach or administrator to set your hourly rate, then request the invoice here.</p>',
  );
});
it("ADMINEXP-02 says the administrator session ended when a coaching action is refused for it", async () => {
  const f = fixture();
  f.service.setCoachingRate.mockResolvedValueOnce({ kind: "denied" });
  const r = await f.post(`/operator/coaching/${id}/rate`, {
    effectiveMonth: month,
    rate: "80.00",
  });
  expect(r.status).toBe(403);
  expect(r.text).toContain(
    'Your administrator session has ended or was not entered. Open <a href="/admin">Administration</a>, end the earlier session if it asks you to, then enter administration and try again.',
  );
  expect(r.text).not.toContain("Check the period");
});
it("ONEPAGE-01 requests a draft saved exactly as posted without saving it again", async () => {
  const f = fixture();
  const saved = /name="saved" value="([a-f0-9]{64})"/.exec(
    (await f.get("/account/coaching")).text,
  )![1]!;
  const same = {
    ...requestFields,
    hours: "1",
    minutes: "30",
    name: entry.name,
    email: entry.email,
    saved,
  };
  // A changed value, or no fingerprint, saves first.
  await f.post("/account/coaching/request", { ...same, minutes: "31" });
  await f.post("/account/coaching/request", { ...same, saved: undefined });
  expect(f.service.saveCoaching).toHaveBeenCalledTimes(2);
  f.service.saveCoaching.mockClear();
  const r = await f.post("/account/coaching/request", same);
  expect(r.headers.location).toBe(
    `/account/coaching?month=${month}&done=requested`,
  );
  expect(f.service.saveCoaching).not.toHaveBeenCalled();
  expect(f.service.submitCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({ expectedRevision: 1, operationId: id }),
  );
  // Its refusal reads as before: nothing new was saved.
  f.service.submitCoaching.mockResolvedValueOnce({ kind: "conflict" });
  const stale = await f.post("/account/coaching/request", same);
  expect(stale.status).toBe(409);
  expect(stale.text).toContain("This form is out of date");
  expect(stale.text).not.toContain("Your hours were saved");
});
it("ONEPAGE-02 covers the request's remaining refusals and the first-visit wording without a rate", async () => {
  const f = fixture();
  expect(
    (
      await f.post("/account/coaching/request", {
        ...requestFields,
        action: "save",
      })
    ).status,
  ).toBe(422);
  const noCompany: Record<string, string> = { ...requestFields };
  delete noCompany.company;
  await f.post("/account/coaching/request", noCompany);
  expect(f.service.saveCoaching).toHaveBeenLastCalledWith(
    token,
    expect.objectContaining({ company: "" }),
  );
  for (const [kind, text] of [
    ["unavailable", "The outcome is uncertain"],
    ["invalid", "Check the period and rate"],
  ] as const) {
    f.service.submitCoaching.mockResolvedValueOnce({ kind });
    const r = await f.post("/account/coaching/request", requestFields);
    expect(r.text).toContain(
      "Your hours were saved, but the invoice was not requested.",
    );
    expect(r.text).toContain(text);
  }
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, entry: null, rate: null, rates: [] }),
  );
  expect(mainHtml((await f.get("/account/coaching")).text)).toContain(
    "Enter your coaching hours for October 2026 below and save them. Your hourly rate isn't set yet; ask your coach or administrator to set it, then request the invoice here.",
  );
  const disabled = fixture(true);
  expect(
    (await disabled.post("/account/coaching/request", requestFields)).status,
  ).toBe(503);
});
// #840 SIMPLE-01..04: one hourly rate on the student tab, the rest optional.
const packageTerms = {
  version: 2,
  priceCents: 8000,
  startsOn: "2026-11-13",
  endsOn: "2027-06-30",
  renewsOn: "2027-07-31",
  reviewMinutes: 0,
  coachingSessions: 0,
  aiRequests: 0,
  sessionMinutes: 60,
  practiceExchanges: 20,
  balances: null,
};
const agreedRow = {
  id,
  kind: "early_release",
  agreed: "Invented agreement",
  reason: "Invented reason",
  recordedAt: new Date("2026-11-01T00:00:00Z"),
};
function simpleFixture(t: unknown = null, rows: unknown[] = []) {
  const f = fixture();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  const coachingTerms = {
    own: vi.fn().mockResolvedValue(ready(t)),
    forStudent: vi.fn().mockResolvedValue(ready(t)),
    save: vi.fn().mockResolvedValue(ready({ version: 3 })),
  };
  const agreedChanges = {
    own: vi.fn().mockResolvedValue(ready(rows)),
    forStudent: vi.fn().mockResolvedValue(ready(rows)),
    record: vi.fn().mockResolvedValue(ready({ id })),
  };
  const service = {
    ...f.service,
    coachingTermsInvoice: vi
      .fn()
      .mockResolvedValue(
        ready({ terms: t, recipient: null, invoiceId: null, earlier: [] }),
      ),
  };
  mountCoachingRoutes(app, service as unknown as SimpleInvoiceStore, {
    origin,
    secret,
    coachingTerms: coachingTerms as never,
    agreedChanges: agreedChanges as never,
  });
  const get = async (path: string) =>
    withLoopback(app, (s) => request(s).get(path));
  const post = (path: string, fields: Record<string, unknown>) =>
    withLoopback(app, (s) =>
      request(s)
        .post(path)
        .set("Origin", origin)
        .type("form")
        .send({ csrf: csrf(token, secret), operationId: id, ...fields }),
    );
  return { service, coachingTerms, agreedChanges, get, post };
}
it("SIMPLE-01/03 the student tab puts one hourly rate beside the hours in two columns", async () => {
  const f = simpleFixture(packageTerms, [agreedRow]);
  const html = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(html).toContain('<div class="coaching-layout">');
  expect(html).toContain('<div class="coaching-main">');
  expect(html).toContain('<aside class="coaching-side">');
  const side = html.slice(html.indexOf('<aside class="coaching-side">'));
  expect(side.indexOf('<h2 id="hourly-rate">Hourly rate</h2>')).toBeGreaterThan(
    0,
  );
  expect(side.indexOf('id="hourly-rate"')).toBeLessThan(
    side.indexOf("billing-period"),
  );
  expect(side).toContain(
    '<p class="rate-now"><strong>CAD 120.00 per hour</strong>',
  );
  expect(side).toContain(`action="/operator/coaching/${id}/rate"`);
  expect(side).toContain("Hourly rate (CAD)");
  expect(side).toContain("Applies from");
  expect(side).toContain("<button>Save hourly rate</button>");
  expect(html).not.toContain("Set member rate");
  // No cards inside cards.
  expect(html).not.toMatch(
    /portal-card[^>]*>(?:(?!<\/section>).)*portal-card/s,
  );
});
it("SIMPLE-01 says plainly when no hourly rate is set", async () => {
  const f = simpleFixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, rate: null, rateVersion: null }),
  );
  const html = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(html).toContain(
    '<p class="rate-now">No hourly rate set for October 2026.</p>',
  );
  expect(html).toContain(
    "No rate is set for this month. Set it under Hourly rate.",
  );
});
it("SIMPLE-02 moves the package, its invoice and agreed changes off the student tab", async () => {
  const f = simpleFixture(packageTerms, [agreedRow]);
  const tab = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(tab).not.toContain("Save coaching terms");
  expect(tab).not.toContain("Invoice these coaching terms");
  expect(tab).not.toContain("Record agreed change");
  expect(tab).toContain(
    `<a href="/operator/coaching/${id}/package">Coaching package and agreed changes</a>`,
  );
  const pkg = mainHtml((await f.get(`/operator/coaching/${id}/package`)).text);
  expect(pkg).toContain("<h1>Coaching package</h1>");
  expect(pkg).toContain("Optional. Most students only need an hourly rate");
  expect(pkg).toContain("Save coaching terms");
  expect(pkg).toContain("Invoice these coaching terms");
  expect(pkg).toContain("Record agreed change");
  expect(pkg).toContain(
    `<p class="page-kind">Student: <a href="/operator/coaching/${id}">`,
  );
  // Saves come back to the package page.
  const saved = await f.post(`/operator/coaching/${id}/terms`, {
    revision: "2",
    price: "80",
    startsOn: "2026-11-13",
    endsOn: "2027-06-30",
    renewsOn: "2027-07-31",
    reviewMinutes: "0",
    coachingSessions: "0",
    aiRequests: "0",
    sessionMinutes: "60",
    practiceExchanges: "20",
  });
  expect(saved.headers.location).toBe(`/operator/coaching/${id}/package`);
  const rec = await f.post(`/operator/coaching/${id}/agreed-change`, {
    kind: "early_release",
    agreed: "x",
    reason: "y",
    confirm: "agreed-change",
  });
  expect(rec.headers.location).toBe(
    `/operator/coaching/${id}/package#agreed-changes`,
  );
});
it("SIMPLE-02 the package page refuses extra queries, a missing student and store refusals", async () => {
  const f = simpleFixture();
  expect((await f.get(`/operator/coaching/${id}/package?x=1`)).status).not.toBe(
    200,
  );
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  expect((await f.get(`/operator/coaching/${id}/package`)).status).toBe(404);
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.get(`/operator/coaching/${id}/package`)).status).not.toBe(
    200,
  );
  f.coachingTerms.forStudent.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get(`/operator/coaching/${id}/package`)).status).not.toBe(
    200,
  );
  f.service.coachingTermsInvoice.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get(`/operator/coaching/${id}/package`)).status).not.toBe(
    200,
  );
  f.agreedChanges.forStudent.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get(`/operator/coaching/${id}/package`)).status).not.toBe(
    200,
  );
});
it("SIMPLE-04 the student keeps their terms card and folded agreed changes beside the hours", async () => {
  const f = simpleFixture(packageTerms, [agreedRow]);
  const html = mainHtml((await f.get("/account/coaching")).text);
  expect(html).toContain('<div class="coaching-layout">');
  const side = html.slice(html.indexOf('<aside class="coaching-side">'));
  expect(side).toContain("Your administrator set these terms.");
  expect(side).toContain(
    '<details class="coaching-details"><summary>Agreed changes, early release and refunds</summary>',
  );
  expect(html.indexOf('id="hours-form"')).toBeLessThan(
    html.indexOf('<aside class="coaching-side">'),
  );
});
it("SIMPLE-01/02/04 covers no period yet, the student's refused reads and a package page without coaching invoicing", async () => {
  const f = simpleFixture();
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({
      ...value,
      rate: null,
      rateVersion: null,
      entry: null,
      period: null,
      billing: {
        schedules: [{ unit: "days", days: 14, startsOn: "2026-12-01" }],
        version: 1,
        nextStart: null,
      },
    }),
  );
  const html = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(html).toContain('<p class="rate-now">No hourly rate set.</p>');
  f.coachingTerms.own.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get("/account/coaching")).status).toBe(403);
  f.agreedChanges.own.mockResolvedValueOnce({ kind: "invalid" });
  expect((await f.get("/account/coaching")).status).toBe(403);
  const off = fixture(true);
  expect((await off.get(`/operator/coaching/${id}/package`)).status).toBe(503);
});
// #844 UI review 1: plain labels and simpler coaching pages.
const submitted844 = {
  ...entry,
  minutes: 270,
  state: "submitted",
  revision: 2,
  submittedRevision: 2,
  snapshot: { ...snapshot, minutes: 270, subtotalCents: 54000 },
};
const visible = (html: string) =>
  mainHtml(html)
    .replace(/<input type="hidden"[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ");
it("#844 PLAIN-01 coaching pages show no revision, version, snapshot, UTC or account reference", async () => {
  const f = simpleFixture(packageTerms, [agreedRow]);
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, displayName: "Mei Invented", entry: submitted844 }),
  );
  const admin = (await f.get(`/operator/coaching/${id}`)).text;
  const student = (await f.get("/account/coaching")).text;
  const board = (await f.get("/operator/coaching")).text;
  for (const text of [admin, student, board].map(visible)) {
    expect(text).not.toMatch(/revision|version|snapshot|UTC|not_sent/i);
    expect(text).not.toMatch(/account reference/i);
    expect(text).not.toContain(id);
    expect(text).not.toContain(id.slice(0, 8));
  }
  // The administrator keeps one plain line of what was submitted.
  expect(mainHtml(admin)).toContain(
    "<p>Submitted: 4h 30m at CAD 120.00 per hour = CAD 540.00</p>",
  );
  expect(mainHtml(admin)).toContain("<p>Status: Awaiting review</p>");
  expect(visible(student)).not.toContain("Submitted:");
  // The posted contract is unchanged.
  expect(admin).toContain('<input type="hidden" name="revision" value="2">');
  // A draft with a period still to start asks for a plain date.
  f.service.coachingOverview.mockResolvedValue(ready(value));
  const draft = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(draft).toContain("<label>First period starts on<input");
  expect(draft).toContain("<p>Status: Draft</p>");
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: null }),
  );
  expect(mainHtml((await f.get(`/operator/coaching/${id}`)).text)).toContain(
    "<p>Status: No hours saved</p>",
  );
});
it("#844 NAMES-01 coaching pages say student, and the dashboard keeps one table and a short awaiting-review list", async () => {
  const f = fixture();
  const other = "66666666-6666-4666-8666-666666666666";
  f.service.adminOverview.mockResolvedValue(
    ready({
      members: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          displayName: "Ada Invented",
        },
        { id: other, displayName: "Zed <New>" },
      ],
      coachingPending: [{ ownerId: id, month, displayName: "Ada Invented" }],
    }),
  );
  const html = mainHtml((await f.get("/operator/coaching")).text);
  expect(visible(html)).not.toMatch(/contractor|member|learner/i);
  expect(html).toContain("Choose a student");
  expect(html).toContain(
    '<caption id="students-caption">Students · September 2026</caption>',
  );
  expect(html).not.toContain("<h2>Members</h2>");
  expect(html).not.toContain("<h2>Pending periods</h2>");
  // A student with no rate or hours yet is still a row, opened on their current month.
  expect(html).toContain(
    `<th scope="row" role="rowheader"><a href="/operator/coaching/${other}">Zed &lt;New&gt;</a></th><td role="cell" data-label="Rate">No rate</td>`,
  );
  expect(html.match(/Ada Invented<\/a><\/th>/g)).toHaveLength(1);
  expect(html).toContain(
    `<h2 id="awaiting-review">Awaiting review</h2><ul class="portal-list"><li><a href="/operator/coaching/${id}?month=${month}">Ada Invented · October 2026</a></li></ul>`,
  );
  expect(html).toContain('<a href="/operator/invoices">Invoices</a>');
  f.service.coachingOverview.mockResolvedValueOnce(
    ready({ ...value, entry: { ...entry, name: "Ada Invented" } }),
  );
  const student = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(student).toContain(
    '<h1>Name needed</h1><p class="page-kind">Student</p>',
  );
  expect(visible(student)).not.toMatch(/member|learner/i);
  expect(student).toContain('<a href="/operator">All students</a>');
  f.service.adminOverview.mockResolvedValue(
    ready({ members: [], coachingPending: [] }),
  );
  f.service.coachingDashboard.mockResolvedValue(
    ready({ ...dashboard, contractors: [] }),
  );
  const empty = mainHtml((await f.get("/operator/coaching")).text);
  expect(empty).toContain(
    "No student has a rate or submitted hours for this month.",
  );
  expect(empty).toContain("<li>No submitted hours await review.</li>");
});
it("#844 MONTHNAV-02 the dashboard moves between months with links that keep the sort", async () => {
  const f = fixture();
  const html = mainHtml((await f.get("/operator/coaching?sort=hours")).text);
  expect(html).toContain(
    '<nav class="month-nav" aria-label="Months"><a href="/operator/coaching?month=2026-08&amp;sort=hours">‹ August 2026</a><a href="/operator/coaching?month=2026-10&amp;sort=hours">October 2026 ›</a></nav>',
  );
  expect(html).not.toContain('type="month"');
  expect(html).not.toContain("Show month");
  f.service.coachingDashboard.mockResolvedValue(
    ready({ ...dashboard, month, today: month }),
  );
  const now = mainHtml((await f.get("/operator/coaching")).text);
  expect(now).toContain(
    'href="/operator/coaching?month=2026-09&amp;sort=name"',
  );
  expect(now).not.toContain("month=2026-11");
});
it("#844 STUDENT-01 the student page states status, rate and the invoice link once each", async () => {
  const f = simpleFixture();
  const html = mainHtml((await f.get("/account/coaching")).text);
  expect(html.match(/Status:/g)).toHaveLength(1);
  expect(html).toContain(
    '<p class="small">Status: Draft, not sent yet · Rate: CAD 120.00 per hour</p>',
  );
  expect(html).not.toContain("Applicable rate");
  expect(html).not.toContain("Rate set");
  expect(html).toContain(
    '<ol class="coaching-steps"><li class="done">Save hours</li><li aria-current="step">Request invoice</li><li>Review</li><li>Invoice issued</li></ol>',
  );
  // One intro sentence.
  expect(html).toContain(
    "<p>Enter your hours for the month, then request the invoice; your administrator reviews it before it is issued and nothing is charged on this site.</p>",
  );
  expect(html).not.toContain("Coaching is optional");
  // No terms and no agreed changes: no card, no disclosure, one contact line.
  expect(html).not.toContain("Your coaching terms");
  expect(html).not.toContain("Agreed changes");
  expect(html).not.toContain('<aside class="coaching-side">');
  expect(
    html.match(
      /There are no cancellation or refund rules\. To ask about changes, contact/g,
    ),
  ).toHaveLength(1);
  expect(html).toContain(
    '<a href="mailto:info@deepnative.io">info@deepnative.io</a>',
  );
  // With terms and an agreed change both show, and the contact line is still once.
  const full = simpleFixture(packageTerms, [agreedRow]);
  const withTerms = mainHtml((await full.get("/account/coaching")).text);
  expect(withTerms).toContain("Your coaching terms");
  expect(withTerms).toContain(
    '<details class="coaching-details"><summary>Agreed changes, early release and refunds</summary>',
  );
  expect(
    withTerms.match(/There are no cancellation or refund rules/g),
  ).toHaveLength(1);
  // An invoiced month: one invoice link in Next step and one in its saved row.
  const invoiceId = "77777777-7777-4777-8777-777777777777";
  f.service.coachingOverview.mockResolvedValue(
    ready({
      ...value,
      entry: { ...submitted844, state: "invoiced", invoiceId },
      months: [{ month, minutes: 270, state: "invoiced", invoiceId }],
    }),
  );
  const invoiced = mainHtml((await f.get("/account/coaching")).text);
  expect(invoiced.match(new RegExp(invoiceId, "g"))).toHaveLength(2);
  expect(invoiced).toContain(
    `<a class="button" href="/account/purchases/invoices/${invoiceId}">View invoice</a>`,
  );
  expect(invoiced).not.toContain("Saved duration");
  expect(invoiced).not.toContain("Invoice recipient");
  expect(invoiced).toContain(
    '<p class="small">Status: Invoice issued · Rate: CAD 120.00 per hour</p>',
  );
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, rate: null, rates: [] }),
  );
  expect(mainHtml((await f.get("/account/coaching")).text)).toContain(
    '<p class="small">Status: Draft, not sent yet · Rate: not set yet</p>',
  );
});
it("#844 INPUT-01 hours and minutes share one row in the student and administrator forms", async () => {
  const f = fixture();
  const student = mainHtml((await f.get("/account/coaching")).text);
  expect(student).toMatch(
    /<div class="duration-fields"><label>Hours<input name="hours" type="number"[^>]*><\/label><label>Minutes<input name="minutes" type="number"[^>]*><\/label><\/div>/,
  );
  const admin = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(admin).toMatch(
    /<div class="duration-fields"><label>Hours<input name="hours" type="number"[^>]*><\/label><label>Minutes<input name="minutes" type="number"[^>]*><\/label><\/div>/,
  );
});
it("#844 ADMINFORMS-01 the administrator's student page keeps issuing and the rate open and folds the rest", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, entry: submitted844 }),
  );
  const html = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  const closed = [
    ...html.matchAll(
      /<details class="coaching-details"[^>]*><summary>([^<]+)<\/summary>/g,
    ),
  ].map((m) => m[1]);
  expect(closed).toEqual([
    "Return for correction",
    "Change this student’s hours",
    "Billing period: calendar month",
  ]);
  expect(html).not.toContain("<details open");
  const outside = html.replace(/<details[\s\S]*?<\/details>/g, "");
  expect(outside).toContain("<h2>Issue the reviewed invoice</h2>");
  expect(outside).toContain("<button>Issue coaching invoice</button>");
  expect(outside).toContain('<h2 id="hourly-rate">Hourly rate</h2>');
  expect(outside).toContain("<button>Save hourly rate</button>");
  expect(outside).not.toContain("Change hours</button>");
  expect(outside).not.toContain("Save billing period");
  expect(outside).not.toContain("Correction reason");
  // The folded forms post exactly what they did.
  expect(html).toContain(
    `<form method="post" action="/operator/coaching/${id}/return">`,
  );
  expect(html).toContain(
    `<form method="post" action="/operator/coaching/${id}/override">`,
  );
  expect(html).toContain(
    `<form method="post" action="/operator/coaching/${id}/billing-period">`,
  );
});
it("#844 PACKAGE-01 the package link and renewals card show only once a package exists", async () => {
  const none = simpleFixture();
  const renewalsDue = vi.fn().mockResolvedValue(ready([]));
  Object.assign(none.coachingTerms, { renewalsDue });
  const plain = mainHtml((await none.get(`/operator/coaching/${id}`)).text);
  expect(plain).not.toContain("/package");
  expect(mainHtml((await none.get("/operator/coaching")).text)).not.toContain(
    "Renewals due",
  );
  // The package page itself still opens.
  expect((await none.get(`/operator/coaching/${id}/package`)).status).toBe(200);
  const terms = simpleFixture(packageTerms);
  Object.assign(terms.coachingTerms, {
    renewalsDue: vi
      .fn()
      .mockResolvedValue(
        ready([
          { ownerId: id, displayName: "Ada", renewsOn: "2026-11-01", days: -3 },
        ]),
      ),
  });
  expect(
    mainHtml((await terms.get(`/operator/coaching/${id}`)).text),
  ).toContain(
    `<a href="/operator/coaching/${id}/package">Coaching package and agreed changes</a>`,
  );
  expect(mainHtml((await terms.get("/operator/coaching")).text)).toContain(
    "Renewals due",
  );
  const agreed = simpleFixture(null, [agreedRow]);
  expect(
    mainHtml((await agreed.get(`/operator/coaching/${id}`)).text),
  ).toContain(`href="/operator/coaching/${id}/package"`);
  // A refused read of either is a refusal, not a guess.
  agreed.coachingTerms.forStudent.mockResolvedValueOnce({ kind: "invalid" });
  expect((await agreed.get(`/operator/coaching/${id}`)).status).toBe(403);
  agreed.agreedChanges.forStudent.mockResolvedValueOnce({
    kind: "unavailable",
  });
  expect((await agreed.get(`/operator/coaching/${id}`)).status).toBe(503);
  // Without those stores there is no link.
  expect(
    mainHtml((await fixture().get(`/operator/coaching/${id}`)).text),
  ).not.toContain("/package");
});
it("#844 TABLE-01 saved periods and the dashboard table carry a caption and a label on every cell", async () => {
  const f = fixture();
  const html = mainHtml((await f.get("/account/coaching")).text);
  expect(html).toContain(
    '<table class="coaching-months stack-table" role="table" aria-labelledby="saved-months"><caption class="visually-hidden">Saved periods</caption>',
  );
  expect(html).toMatch(
    /<td role="cell" data-label="Hours">[^<]*<\/td><td role="cell" data-label="Amount">[^<]*<\/td><td role="cell" data-label="Status">Draft<\/td><td role="cell" data-label="Invoice">—<\/td>/,
  );
  const board = mainHtml((await f.get("/operator/coaching")).text);
  expect(board).toContain(
    '<table class="contractor-hours stack-table" role="table" aria-labelledby="students-caption">',
  );
  for (const label of [
    "Rate",
    "Hours",
    "Previous month",
    "Year to date",
    "Status",
    "Invoice email",
    "Balance",
  ])
    expect(board).toContain(`<td role="cell" data-label="${label}">`);
});

// #850: the three UI-review changes read as one system.
const MENU = (current: string) =>
  new RegExp(
    `<nav class="admin-menu" aria-label="Administration">.*<a href="[^"]+" aria-current="page">${current}</a>`,
  );
it("MENUALL-01 the coaching dashboard, a student's page and the package page carry the administrator menu", async () => {
  const f = fixture();
  const dashboardPage = (await f.get("/operator/coaching")).text;
  expect(dashboardPage).toMatch(MENU("More"));
  expect((await f.get(`/operator/coaching/${id}`)).text).toMatch(
    MENU("Students"),
  );
  expect((await f.get(`/operator/coaching/${id}/package`)).text).toMatch(
    MENU("Students"),
  );
  f.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  expect((await f.get(`/operator/coaching/${id}`)).text).toMatch(
    MENU("Students"),
  );
  // The student's own page is not an administrator page.
  expect((await f.get("/account/coaching")).text).not.toContain("admin-menu");
});
it("NAMES-02 names each page by its destination: Coaching for the student, the student's name for the administrator", async () => {
  const f = fixture();
  f.service.coachingOverview.mockResolvedValue(
    ready({ ...value, displayName: "Mei <Tanaka>" }),
  );
  const own = (await f.get("/account/coaching")).text;
  expect(own).toContain("<title>Coaching · Deep Native Engine</title>");
  expect(own).toContain("<h1>Coaching</h1>");
  const admin = (await f.get(`/operator/coaching/${id}`)).text;
  expect(admin).toContain("<title>Mei &lt;Tanaka&gt; · Deep Native Engine");
  expect(admin).toContain(
    '<h1>Mei &lt;Tanaka&gt;</h1><p class="page-kind">Student</p>',
  );
  const packagePage = (await f.get(`/operator/coaching/${id}/package`)).text;
  expect(packagePage).toContain(
    '<h1>Coaching package</h1><p class="page-kind">Student: <a href="/operator/coaching/' +
      id +
      '">Mei &lt;Tanaka&gt;</a></p>',
  );
  f.service.coachingOverview.mockResolvedValue(ready(value));
  expect((await f.get(`/operator/coaching/${id}`)).text).toContain(
    "<h1>Name needed</h1>",
  );
  const dashboardPage = (await f.get("/operator/coaching")).text;
  expect(dashboardPage).toContain("<h1>Coaching hours by month</h1>");
  for (const text of [own, admin, packagePage, dashboardPage])
    for (const old of [
      "Administration console",
      "Courses and invoices",
      "Coaching administration",
      "Review coaching hours",
      "<h1>Coaching hours</h1>",
    ])
      expect(text).not.toContain(old);
});
it("BACK-01 an administrator's student page keeps one All students link and the student's page one Invoices link", async () => {
  const f = fixture();
  const admin = mainHtml((await f.get(`/operator/coaching/${id}`)).text);
  expect(admin).not.toContain("portal-actions");
  expect(admin).not.toContain("Choose another student");
  expect(admin.match(/<a href="\/operator">All students<\/a>/g)).toHaveLength(
    1,
  );
  expect(admin).not.toContain('class="button secondary"');
  const packagePage = mainHtml(
    (await f.get(`/operator/coaching/${id}/package`)).text,
  );
  expect(packagePage).not.toContain("Back to hours and rate");
  expect(packagePage).not.toContain('class="button');
  const dashboardPage = mainHtml((await f.get("/operator/coaching")).text);
  expect(dashboardPage).not.toContain("portal-actions");
  const own = mainHtml((await f.get("/account/coaching")).text);
  expect(own).not.toContain("account-links");
  expect(own).not.toContain('class="button secondary" href="/account"');
  expect(
    own.match(/<a href="\/account\/purchases">Invoices<\/a>/g),
  ).toHaveLength(1);
  const gone = fixture();
  gone.service.coachingOverview.mockResolvedValueOnce({ kind: "not-found" });
  const missing = mainHtml((await gone.get(`/operator/coaching/${id}`)).text);
  expect(missing).not.toContain("portal-actions");
  expect(missing).toContain('<a href="/operator">All students</a>');
  expect(missing).toContain("stay listed under Invoices");
});
it("SEAM-01 the student's coaches and course records sit folded on the student's page", async () => {
  const learnerCoaches = vi.fn().mockResolvedValue(
    ready({
      assigned: ["h1", "h3"],
      coaches: [
        { emailHash: "h1", label: "Ada <Coach>" },
        { emailHash: "h2", label: "Ben Coach" },
        { emailHash: "h3", label: "sh…@example.test (not signed up yet)" },
      ],
    }),
  );
  const consoleRead = vi.fn().mockResolvedValue(
    ready({
      selected: {
        member: { id },
        enrollments: [{ id: "course-1", title: "Course <one>" }],
        plans: [{ id, state: "offered" }],
        invoices: [
          {
            id,
            number: `DN-${id}`,
            totalCents: "12345",
            delivery: "sent",
          },
          { id, number: "DN-7", totalCents: "100", delivery: "not_sent" },
        ],
      },
    }),
  );
  const f = fixture(false, {
    roleAdmin: { learnerCoaches },
    administratorEntry: { console: consoleRead },
  });
  const text = (await f.get(`/operator/coaching/${id}`)).text;
  expect(learnerCoaches).toHaveBeenCalledWith(token, id);
  expect(consoleRead).toHaveBeenCalledWith(token, id);
  expect(text).toContain(
    '<details class="coaching-details" id="student-coaches"><summary>Coaches: Ada &lt;Coach&gt;, sh…@example.test (not signed up yet)</summary>',
  );
  expect(text).toContain(
    '<form class="coach-choices" method="post" action="/operator/coach-assignments">',
  );
  expect(text).toContain(`name="learnerId" value="${id}"`);
  expect(text).toContain(
    '<details class="coaching-details" id="student-courses"><summary>Courses: 1 enrollment, 1 bundle, 2 invoices</summary>',
  );
  expect(text).toContain("Course &lt;one&gt; · course-1");
  expect(text).toContain("Course bundle · offered");
  expect(text).toContain(
    `<a href="/operator/invoices/${id}">DN-11111111</a> · CAD 123.45 · Sent`,
  );
  expect(text).toContain("DN-7</a> · CAD 1.00 · Not sent");
  expect(text).toContain(
    `<a href="/operator/invoices?ownerId=${id}">Prepare course billing for this student</a>`,
  );
  // Nobody assigned, nothing recorded: the summaries say so.
  learnerCoaches.mockResolvedValueOnce(
    ready({ assigned: [], coaches: [{ emailHash: "h1", label: "Ada" }] }),
  );
  consoleRead.mockResolvedValueOnce(
    ready({
      selected: { member: { id }, enrollments: [], plans: [], invoices: [] },
    }),
  );
  const empty = (await f.get(`/operator/coaching/${id}`)).text;
  expect(empty).toContain("<summary>Coaches: none</summary>");
  expect(empty).toContain("<summary>Courses: none</summary>");
  expect(empty).toContain(
    "No course enrollment, bundle or course invoice yet.",
  );
  // A failed read folds to a plain line; the hours page still renders.
  learnerCoaches.mockResolvedValueOnce({ kind: "unavailable" });
  consoleRead.mockResolvedValueOnce({ kind: "unavailable" });
  const failed = await f.get(`/operator/coaching/${id}`);
  expect(failed.status).toBe(200);
  expect(failed.text).toContain("<summary>Coaches: unavailable</summary>");
  expect(failed.text).toContain("Coach assignment is unavailable right now.");
  expect(failed.text).not.toContain('id="student-courses"');
  consoleRead.mockResolvedValueOnce(ready({}));
  expect((await f.get(`/operator/coaching/${id}`)).text).not.toContain(
    'id="student-courses"',
  );
  // A site without these areas shows neither; the student never sees them.
  const plain = (await fixture().get(`/operator/coaching/${id}`)).text;
  expect(plain).not.toContain("student-coaches");
  expect(plain).not.toContain("student-courses");
  expect((await f.get("/account/coaching")).text).not.toContain(
    "student-coaches",
  );
  // An entry store without a console lists no courses.
  const noConsole = fixture(false, { administratorEntry: {} });
  expect((await noConsole.get(`/operator/coaching/${id}`)).text).not.toContain(
    "student-courses",
  );
});
