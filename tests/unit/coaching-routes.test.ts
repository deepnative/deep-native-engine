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
    read: vi.fn().mockResolvedValue(ready(null)),
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
  expect(html).toContain("<h2>Pending months</h2>");
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
  f.profiles.read.mockResolvedValue(
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
  f.profiles.read.mockResolvedValueOnce({ kind: "unavailable" });
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
    '<section class="portal-card"><h2>Pending months</h2>',
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
    { month: "2025-01", state: "draft", minutes: 45, returned: false },
  ];
  f.service.coachingOverview.mockResolvedValue(ready({ ...value, months }));
  const page = mainHtml((await f.get(`/account/coaching?month=${month}`)).text);
  const table = page.match(
    /<table class="coaching-months"[\s\S]*?<\/table>/,
  )?.[0];
  expect(table).toBeDefined();
  expect(page).toContain('<div class="table-scroll" role="region"');
  for (const header of ["Month", "Hours", "Amount", "Status", "Invoice"])
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
  expect(row("July 2026")).toContain(
    `href="/account/purchases/invoices/${invoiceId}"`,
  );
  expect(row("June 2026")).toContain("Invoiced · CAD 100.00 due");
  expect(row("May 2026")).toContain("Void");
  // No rate applies to a month before the first effective rate.
  expect(row("January 2025")).toContain("No rate");
  expect(page).not.toContain("<h2>Saved months</h2><ul>");

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
  ).toContain("<p>No saved months.</p>");
});
