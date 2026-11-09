import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountSimpleInvoiceRoutes } from "../../src/simple-invoice-routes.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { csrf } from "../../src/session.ts";
import { expectPortalActions, mainHtml } from "../support/portal-layout.ts";
import { withLoopback } from "../support/loopback-server.ts";
const token = "a".repeat(64),
  secret = "invoice-test",
  origin = "http://127.0.0.1:3000",
  id = "11111111-1111-4111-8111-111111111111";
const terms = {
  courses: [
    {
      id: "FND-001",
      version: 2,
      description: "Claim checking",
      amountCents: 1000,
    },
  ],
  cadence: "monthly" as const,
  startsOn: "2026-10-31",
  taxCents: 100,
  issuer: "Invented issuer",
  instructions: "Sample only",
  sample: true,
};
const doc = {
  number: "DN-invented",
  issuedOn: "2026-10-31",
  issuer: terms.issuer,
  billedTo: "陳",
  recipientEmail: "invented@example.invalid",
  lines: [{ description: "Claim checking", amountCents: 1000 }],
  billing: { kind: "one_time" as const },
  currency: "CAD" as const,
  taxCents: 100,
  paidCents: 0,
  instructions: terms.instructions,
  sample: true,
};
const invoice = {
  id,
  document: doc,
  totalCents: 1100,
  paidCents: 0,
  revision: 1,
  delivery: "not_sent" as const,
  voidReason: null,
};
const ready = (value: unknown) => ({ kind: "ready", value });
function fixture(disabled = false, noSender = false) {
  const service = {
    overview: vi
      .fn()
      .mockResolvedValue(
        ready({
          plans: [],
          invoices: [],
          today: "2026-10-31",
          unavailable: {},
        }),
      ),
    adminOverview: vi.fn().mockResolvedValue(
      ready({
        members: [{ id }],
        courses: [{ id: "FND-001", version: 2, title: "Claim checking" }],
        invoices: [{ id, delivery: "not_sent" }],
      }),
    ),
    invoice: vi.fn().mockResolvedValue(ready(invoice)),
    inspect: vi.fn().mockResolvedValue(ready({ result: { invoiceId: id } })),
    accept: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
    cancel: vi.fn().mockResolvedValue(ready({ cancelled: true })),
    propose: vi.fn().mockResolvedValue(ready({ planId: id })),
    pay: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
    refund: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
    voidInvoice: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
    generateDue: vi.fn().mockResolvedValue(ready({ created: 0 })),
    claimEmail: vi.fn().mockResolvedValue(ready({ send: true, invoice })),
    finishEmail: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
  };
  const sender = { send: vi.fn().mockResolvedValue(undefined) };
  const profiles = {
    read: vi.fn().mockResolvedValue(ready(null)),
    save: vi.fn().mockResolvedValue(ready({ revision: 1 })),
  };
  const options = {
    billingProfiles: profiles,
    origin,
    secret,
    invoiceSender: noSender ? undefined : sender,
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountSimpleInvoiceRoutes(
    app,
    disabled ? undefined : (service as unknown as SimpleInvoiceStore),
    options,
  );
  const get = (path: string) => withLoopback(app, (s) => request(s).get(path));
  const post = (
    path: string,
    fields: Record<string, unknown> = {},
    customOrigin = origin,
  ) =>
    withLoopback(app, (s) =>
      request(s)
        .post(path)
        .set("Origin", customOrigin)
        .type("form")
        .send({
          csrf: csrf(token, secret),
          operationId: randomUUID(),
          revision: "1",
          ...fields,
        }),
    );
  return { service, profiles, sender, options, app, get, post };
}
const base = "/account/purchases",
  admin = "/operator/invoices";
it("OFFPUR-05 refuses extra fields belonging to a different billing action", async () => {
  const f = fixture();
  const response = await f.post(`${admin}/${id}/payment`, {
    amount: "1.00",
    receivedOn: "2026-10-31",
    confirm: "received",
    name: "unexpected",
  });
  expect(response.status).toBe(403);
  expect(f.service.pay).not.toHaveBeenCalled();
});
it("OFFPUR-07 exposes an honest unconfigured account entry without issuing anything", async () => {
  const f = fixture(true);
  expect((await f.get(base)).text).toContain("No payable offer is configured");
  for (const path of [
    admin,
    `${base}/operations/${id}`,
    `${admin}/operations/${id}`,
    `${base}/invoices/${id}`,
    `${admin}/${id}`,
  ])
    expect((await f.get(path)).status).toBe(503);
  for (const path of [
    `${base}/plans/${id}/accept`,
    `${base}/plans/${id}/cancel`,
    `${admin}/plans`,
    `${admin}/due`,
    `${admin}/${id}/payment`,
    `${admin}/${id}/refund`,
    `${admin}/${id}/void`,
    `${admin}/${id}/email`,
  ])
    expect((await f.post(path)).status).toBe(503);
});
it("OFFPUR-08/10 shows exact courses, explicit cadence and cancelled agreements with individual invoice states", async () => {
  const f = fixture();
  f.service.overview.mockResolvedValue(
    ready({
      plans: [
        { id, terms, state: "offered", revision: 1 },
        {
          id,
          terms: { ...terms, cadence: "one_time", sample: false },
          state: "offered",
          revision: 1,
        },
        { id, terms, state: "active", revision: 2 },
        { id, terms, state: "cancelled", revision: 3 },
      ],
      invoices: [
        invoice,
        { ...invoice, paidCents: 100 },
        { ...invoice, paidCents: 1100, document: { ...doc, sample: false } },
        { ...invoice, voidReason: "wrong course" },
      ],
      today: "2026-10-31",
      unavailable: {},
    }),
  );
  const r = await f.get(base);
  expect(r.status).toBe(200);
  for (const text of [
    "FND-001 version 2",
    "monthly recurring invoices",
    "one-time billing terms",
    "Cancel future billing",
    "cancelled",
    "Partially paid",
    "Paid",
    "Awaiting offline payment",
    "Void",
  ])
    expect(r.text).toContain(text);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect((await f.get(admin)).text).toContain(
    "Prepare course billing proposal",
  );
});
it("BUILD-04-C closes an offer once its start date passes, with no accept form", async () => {
  const f = fixture();
  f.service.overview.mockResolvedValue(
    ready({
      plans: [
        { id, terms, state: "offered", revision: 1 },
        {
          id,
          terms: { ...terms, startsOn: "2026-11-01" },
          state: "offered",
          revision: 1,
        },
      ],
      invoices: [],
      today: "2026-11-01",
      unavailable: {},
    }),
  );
  const r = await f.get(base);
  expect(r.status).toBe(200);
  expect(r.text).toContain("Acceptance closed on 2026-10-31.");
  expect(r.text).not.toContain("Acceptance closed on 2026-11-01.");
  // Only the offer starting today keeps its accept form.
  expect(r.text.match(/\/accept"/g)).toHaveLength(1);
});
it("BUILD-09-B names the courses an open offer no longer has, with no accept form", async () => {
  const f = fixture(),
    other = "00000000-0000-4000-8000-0000000000aa",
    open = "00000000-0000-4000-8000-0000000000bb";
  f.service.overview.mockResolvedValue(
    ready({
      plans: [
        { id, terms, state: "offered", revision: 1 },
        { id: other, terms, state: "offered", revision: 1 },
        { id: open, terms, state: "offered", revision: 1 },
      ],
      invoices: [],
      today: "2026-10-31",
      unavailable: { [id]: ["FND-003"], [other]: ["FND-001", "<FND-9>"] },
    }),
  );
  const r = await f.get(base);
  expect(r.status).toBe(200);
  expect(r.text).toContain(
    "This proposal can no longer be accepted: FND-003 is not currently offered.",
  );
  expect(r.text).toContain(
    "This proposal can no longer be accepted: FND-001, &lt;FND-9&gt; are not currently offered.",
  );
  // Only the offer whose courses are all still offered keeps its form.
  expect(r.text.match(/\/accept"/g)).toEqual([`/accept"`]);
  expect(r.text).toContain(`/plans/${open}/accept"`);
});
it("OFFPUR-05 denies query parameters, forged CSRF/origin and malformed form shapes", async () => {
  const f = fixture();
  expect((await f.get(base + "?foreign=1")).status).toBe(403);
  expect(
    (await f.post(`${admin}/due`, {}, "https://foreign.invalid")).status,
  ).toBe(403);
  expect((await f.post(`${admin}/due`, { csrf: "wrong" })).status).toBe(403);
  expect((await f.post(`${admin}/due`, { unexpected: "value" })).status).toBe(
    403,
  );
  expect(
    (await f.post(`${admin}/${id}/payment`, { amount: ["1", "2"] })).status,
  ).toBe(403);
  expect(
    (
      await withLoopback(f.app, (s) =>
        request(s)
          .post(`${admin}/due`)
          .set("Origin", origin)
          .send({ csrf: "anything" }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await f.post(`${admin}/plans`, { courses: { bad: "shape" } })).status,
  ).toBe(403);
});
it("OFFPUR-01/03 accepts or cancels only explicit original-key requests and retains inspectable failures", async () => {
  const f = fixture(),
    operationId = randomUUID();
  expect(
    (
      await f.post(`${base}/plans/${id}/accept`, {
        operationId,
        name: "陳",
        email: "invented@example.invalid",
        confirm: "accept",
      })
    ).status,
  ).toBe(303);
  expect(f.service.accept).toHaveBeenCalledWith(token, {
    planId: id,
    operationId,
    expectedRevision: 1,
    name: "陳",
    email: "invented@example.invalid",
  });
  expect((await f.post(`${base}/plans/${id}/accept`)).status).toBe(422);
  expect(
    (await f.post(`${base}/plans/${id}/cancel`, { confirm: "cancel" })).status,
  ).toBe(303);
  expect((await f.post(`${base}/plans/${id}/cancel`)).status).toBe(422);
  for (const kind of [
    "denied",
    "invalid",
    "conflict",
    "unavailable",
    "not-found",
  ]) {
    f.service.accept.mockResolvedValueOnce({ kind });
    const r = await f.post(`${base}/plans/${id}/accept`, { confirm: "accept" });
    expect(r.status).toBe(
      {
        denied: 403,
        invalid: 422,
        conflict: 409,
        unavailable: 503,
        "not-found": 404,
      }[kind]!,
    );
    expect(r.text).toContain("Inspect original operation");
  }
  f.service.cancel.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (await f.post(`${base}/plans/${id}/cancel`, { confirm: "cancel" })).status,
  ).toBe(409);
  f.service.overview.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.get(base)).status).toBe(403);
  f.service.adminOverview.mockResolvedValueOnce({ kind: "denied" });
  expect((await f.get(admin)).status).toBe(403);
});
it("OFFPUR-08 prepares the selected courses and validates malformed or ambiguous amounts", async () => {
  const f = fixture();
  const fields = {
    ownerId: id,
    courses: JSON.stringify(["FND-001", 2]),
    "amount_FND-001_2": "10.01",
    tax: "1.00",
    cadence: "one_time",
    startsOn: "2026-10-31",
  };
  expect((await f.post(`${admin}/plans`, fields)).status).toBe(303);
  expect(f.service.propose.mock.calls[0]![1]).toMatchObject({
    ownerId: id,
    courses: [{ id: "FND-001", version: 2, amountCents: 1001 }],
    taxCents: 100,
  });
  expect(
    (
      await f.post(`${admin}/plans`, {
        ...fields,
        courses: [fields.courses, fields.courses],
      })
    ).status,
  ).toBe(303);
  for (const change of [
    { courses: "bad" },
    { courses: "[1,2]" },
    { courses: '["FND-001",1.2]' },
    { courses: [1, 2] },
    { "amount_FND-001_2": "1e2" },
    { tax: "1.001" },
  ])
    expect(
      (await f.post(`${admin}/plans`, { ...fields, ...change })).status,
    ).toBe(422);
  f.service.propose.mockResolvedValueOnce({ kind: "conflict" });
  expect((await f.post(`${admin}/plans`, fields)).status).toBe(409);
});
it("OFFPUR-02 opens a private printable invoice and original operation without another submission", async () => {
  const f = fixture();
  for (const path of [`${base}/invoices/${id}`, `${admin}/${id}`]) {
    const r = await f.get(path);
    expect(r.status).toBe(200);
    expect(r.text).toContain("陳");
    expect(r.text).toContain("Print command");
  }
  f.service.invoice.mockResolvedValueOnce(
    ready({ ...invoice, delivery: "sent" }),
  );
  expect((await f.get(`${admin}/${id}`)).text).toContain(
    "Simulated; no email sent",
  );
  f.service.invoice.mockResolvedValueOnce({ kind: "not-found" });
  expect((await f.get(`${base}/invoices/${id}`)).status).toBe(404);
  for (const path of [`${base}/operations/${id}`, `${admin}/operations/${id}`])
    expect((await f.get(path)).text).toContain("retained original result");
  f.service.inspect.mockResolvedValueOnce({ kind: "not-found" });
  expect((await f.get(`${base}/operations/${id}`)).status).toBe(404);
});
it("OFFPUR-04/06 confirms offline receipts and unpaid voids without interpreting a student claim as money", async () => {
  const f = fixture();
  expect(
    (
      await f.post(`${admin}/${id}/payment`, {
        amount: "1.00",
        receivedOn: "2026-10-31",
        evidence: "  Invented reference  ",
        confirm: "received",
      })
    ).status,
  ).toBe(303);
  expect(f.service.pay.mock.calls[0]![1]).toMatchObject({
    amountCents: 100,
    receivedOn: "2026-10-31",
    evidence: "Invented reference",
  });
  for (const fields of [
    { amount: "1.00" },
    { amount: "bad", confirm: "received" },
  ])
    expect((await f.post(`${admin}/${id}/payment`, fields)).status).toBe(422);
  f.service.pay.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (
      await f.post(`${admin}/${id}/payment`, {
        amount: "1.00",
        confirm: "received",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post(`${admin}/${id}/void`, {
        reason: "wrong course",
        confirm: "void",
      })
    ).status,
  ).toBe(303);
  expect((await f.post(`${admin}/${id}/void`)).status).toBe(422);
  f.service.voidInvoice.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (await f.post(`${admin}/${id}/void`, { confirm: "void" })).status,
  ).toBe(409);
  expect((await f.post(`${admin}/due`)).status).toBe(303);
  f.service.generateDue.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await f.post(`${admin}/due`)).status).toBe(503);
});
it("OFFPUR-02/03 never sends twice after replay and preserves ambiguous provider outcomes", async () => {
  const f = fixture();
  expect(
    (await f.post(`${admin}/${id}/email`, { confirm: "send" })).status,
  ).toBe(303);
  expect(f.sender.send).toHaveBeenCalledOnce();
  f.service.claimEmail.mockResolvedValueOnce(ready({ send: false, invoice }));
  expect(
    (await f.post(`${admin}/${id}/email`, { confirm: "send" })).status,
  ).toBe(303);
  expect(f.sender.send).toHaveBeenCalledOnce();
  f.sender.send.mockRejectedValueOnce(Error("Private provider error"));
  expect(
    (await f.post(`${admin}/${id}/email`, { confirm: "send" })).status,
  ).toBe(303);
  expect(f.service.finishEmail.mock.calls.at(-1)![3]).toBe(false);
  f.service.finishEmail.mockResolvedValueOnce({ kind: "unavailable" });
  expect(
    (await f.post(`${admin}/${id}/email`, { confirm: "send" })).status,
  ).toBe(503);
  f.service.claimEmail.mockResolvedValueOnce({ kind: "conflict" });
  expect(
    (await f.post(`${admin}/${id}/email`, { confirm: "send" })).status,
  ).toBe(409);
  expect((await f.post(`${admin}/${id}/email`)).status).toBe(422);
  expect(
    (
      await fixture(false, true).post(`${admin}/${id}/email`, {
        confirm: "send",
      })
    ).status,
  ).toBe(503);
});
it("OFFPUR-05 checks the final OS-assigned origin rather than a copied pre-listen value", async () => {
  const f = fixture();
  f.options.origin = "http://127.0.0.1:54321";
  expect((await f.post(`${admin}/due`, {}, f.options.origin)).status).toBe(303);
  expect((await f.post(`${admin}/due`)).status).toBe(403);
});

it("OFFPUR-05 applies the same no-query and original-form boundary to every invoice action", async () => {
  const f = fixture();
  for (const path of [
    admin,
    `${base}/operations/${id}`,
    `${admin}/operations/${id}`,
    `${base}/invoices/${id}`,
    `${admin}/${id}`,
  ])
    expect((await f.get(path + "?unexpected=1")).status).toBe(403);
  for (const path of [
    `${base}/plans/${id}/accept`,
    `${base}/plans/${id}/cancel`,
    `${admin}/plans`,
    `${admin}/${id}/void`,
    `${admin}/${id}/email`,
  ])
    expect((await f.post(path + "?unexpected=1")).status).toBe(403);
  expect((await f.get(`${base}/invoices/invalid`)).status).toBe(422);
  expect((await f.get(base)).text).toContain(
    "No course bundle has been prepared",
  );
});

it("OFFPUR-02 offers no email action when invoice email is not configured", async () => {
  const f = fixture(false, true);
  f.service.invoice.mockResolvedValueOnce(
    ready({ ...invoice, document: { ...doc, sample: false } }),
  );
  const r = await f.get(`${admin}/${id}`);
  expect(r.status).toBe(200);
  expect(r.text).not.toContain(`action="${admin}/${id}/email"`);
  expect(r.text).not.toContain(">Send invoice email</button>");
  expect(r.text).toContain(
    "Invoice email is not configured on this service, so nothing can be sent from here.",
  );
  expect(r.text).toContain(">Record offline payment</button>");
});

it("OFFPUR-02 clearly names actual invoice correspondence when the issuer is configured", async () => {
  const f = fixture();
  f.service.invoice.mockResolvedValueOnce(
    ready({ ...invoice, document: { ...doc, sample: false } }),
  );
  const r = await f.get(`${admin}/${id}`);
  expect(r.text).toContain(
    "Send this individual invoice to its accepted billing recipient.",
  );
  expect(r.text).toContain(">Send invoice email</button>");
  expect(r.text).not.toContain(">Simulate invoice email</button>");
});

it("HOUR08 coaching invoice controls direct an unpaid correction back to the retained month", async () => {
  const f = fixture();
  f.service.invoice.mockResolvedValueOnce(
    ready({
      ...invoice,
      document: {
        ...doc,
        coaching: {
          month: "2026-10",
          minutes: 90,
          rateCents: 12000,
          rateVersion: 1,
          rateId: id,
          submissionRevision: 2,
          replacesInvoiceId: null,
        },
      },
    }),
  );
  const response = await f.get(`/operator/invoices/${id}`);
  expect(response.text).toContain("return its coaching month for correction");
  expect(response.text).toContain(
    "Paid or partially paid corrections are unavailable",
  );
});

it("ADMINCON02 preserves exact learner selection and rejects forged selection queries", async () => {
  const f = fixture();
  expect((await f.get("/operator/invoices?ownerId=" + id)).status).toBe(200);
  expect(f.service.adminOverview).toHaveBeenLastCalledWith(token, id);
  expect((await f.get("/operator/invoices?ownerId=wrong")).status).toBe(422);
  expect((await f.get("/operator/invoices?ownerId=a&ownerId=b")).status).toBe(
    422,
  );
  expect((await f.get("/operator/invoices?unexpected=x")).status).toBe(403);
});
it("BILLPROFILE02 offers a separate private billing profile even when invoices are disabled", async () => {
  const f = fixture(true);
  const response = await f.get("/account/billing");
  expect(response.status).toBe(200);
  expect(response.text).toContain("Billing recipient");
  expect(response.text).toContain("does not change your sign-in email");
});
it("BILLPROFILE02/04 isolates profile validation, stale forms, unavailable outcomes and escaped prefills", async () => {
  const f = fixture();
  f.profiles.read.mockResolvedValue(
    ready({
      name: "Invented <recipient>",
      email: "billing@example.invalid",
      revision: 2,
    }),
  );
  let r = await f.get("/account/billing");
  expect(r.text).toContain("Invented &lt;recipient&gt;");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(
    (
      await f.post("/account/billing", {
        name: "Invented",
        email: "billing@example.invalid",
        revision: "2",
      })
    ).headers.location,
  ).toBe("/account/billing");
  expect(f.profiles.save).toHaveBeenCalledWith(token, {
    name: "Invented",
    email: "billing@example.invalid",
    revision: 2,
  });
  for (const kind of ["denied", "invalid", "conflict", "unavailable"]) {
    f.profiles.read.mockResolvedValueOnce({ kind });
    expect((await f.get("/account/billing")).status).toBe(
      { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
    );
    f.profiles.save.mockResolvedValueOnce({ kind });
    expect(
      (
        await f.post("/account/billing", {
          name: "Invented",
          email: "billing@example.invalid",
        })
      ).status,
    ).toBe(
      { denied: 403, invalid: 422, conflict: 409, unavailable: 503 }[kind],
    );
  }
  expect((await f.get("/account/billing?ownerId=" + id)).status).toBe(403);
  expect(
    (
      await f.post("/account/billing", {
        name: "Invented",
        email: "billing@example.invalid",
        ownerId: id,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/account/billing",
        { name: "Invented" },
        "https://other.invalid",
      )
    ).status,
  ).toBe(403);
  f.service.overview.mockResolvedValue(
    ready({
      plans: [{ id, terms, state: "offered", revision: 1 }],
      invoices: [],
      today: "2026-10-31",
      unavailable: {},
    }),
  );
  r = await f.get(base);
  expect(r.text).toContain("Invented &lt;recipient&gt;");
  f.profiles.read.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await f.get(base)).status).toBe(503);
  const bare = express();
  bare.use(express.urlencoded({ extended: false }));
  bare.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountSimpleInvoiceRoutes(bare, undefined, { origin, secret });
  expect(
    (await withLoopback(bare, (s) => request(s).get("/account/billing")))
      .status,
  ).toBe(503);
  expect(
    (
      await withLoopback(bare, (s) =>
        request(s)
          .post("/account/billing")
          .set("Origin", origin)
          .type("form")
          .send({ csrf: csrf(token, secret) }),
      )
    ).status,
  ).toBe(503);
  expect(
    (await withLoopback(bare, (s) => request(s).get("/account/billing?bad=1")))
      .status,
  ).toBe(403);
  const legacy = express();
  legacy.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  mountSimpleInvoiceRoutes(legacy, f.service as unknown as SimpleInvoiceStore, {
    origin,
    secret,
  });
  expect((await withLoopback(legacy, (s) => request(s).get(base))).status).toBe(
    200,
  );
});

it("BILLPROFILE02 preserves empty invalid attempted recipient fields with a safe recovery message", async () => {
  const f = fixture();
  f.profiles.save.mockResolvedValue({ kind: "invalid" });
  const r = await f.post("/account/billing");
  expect(r.status).toBe(422);
  expect(r.text).toContain("Recipient not saved");
  expect(r.text).toContain('value=""');
});
it("ADMIN-LAYOUT-02 course billing administration titles each task card and offers navigation as buttons", async () => {
  const f = fixture();
  const html = (await f.get("/operator/invoices")).text;
  expectPortalActions(html, [
    ["/operator", "Administration console"],
    ["/operator/coaching", "Monthly coaching"],
  ]);
  const main = mainHtml(html);
  expect(main).toContain(
    '<section class="invoice-workspace portal-workspace">',
  );
  for (const title of [
    "Prepare course billing",
    "Recurring invoices",
    "Issued invoice references",
  ])
    expect(main).toMatch(
      new RegExp(`<section class="portal-card"><h2>${title}</h2>`),
    );
  expect(main).toContain('action="/operator/invoices/plans"');
  expect(main).toContain('action="/operator/invoices/due"');
});

it("AUDIT-01/02/03 shows readable delivery states, month names and button navigation", async () => {
  const f = fixture();
  for (const [delivery, text] of [
    ["not_sent", "Email status: Not sent"],
    ["sending", "Email status: Sending"],
    ["unconfirmed", "Email status: Unconfirmed: check the recipient"],
  ] as const) {
    f.service.invoice.mockResolvedValueOnce(
      ready({ ...invoice, delivery, document: { ...doc, sample: false } }),
    );
    const page = (await f.get(`/operator/invoices/${id}`)).text;
    expect(page).toContain(text);
    expect(page).not.toContain(`Email status: ${delivery}`);
  }
  f.service.invoice.mockResolvedValueOnce(
    ready({
      ...invoice,
      document: {
        ...doc,
        coaching: {
          month: "2026-10",
          minutes: 90,
          rateCents: 12000,
          rateVersion: 1,
          rateId: id,
          submissionRevision: 2,
          replacesInvoiceId: null,
        },
      },
    }),
  );
  const document = (await f.get(`/account/purchases/invoices/${id}`)).text;
  expect(document).toContain("Month: October 2026");
  expect(document).toContain(
    '<a class="button secondary" href="/account/purchases">Courses and invoices</a>',
  );
  const purchases = (await f.get("/account/purchases")).text;
  expect(purchases).toContain(
    '<a class="button secondary" href="/account/billing">Billing recipient</a>',
  );
});

it("GAPS-01 an administrator's invoice links stay in administration; a member's keep theirs", async () => {
  const f = fixture();
  const staff = (await f.get(`/operator/invoices/${id}`)).text;
  expect(staff).toContain('href="/operator/invoices">Courses and invoices</a>');
  expect(staff).toContain('href="/operator">Administration console</a>');
  expect(staff).not.toContain('href="/account/purchases"');
  const member = (await f.get(`${base}/invoices/${id}`)).text;
  expect(member).toContain(
    'href="/account/purchases">Courses and invoices</a>',
  );
  expect(member).toContain('href="/account">My account</a>');
});
it("GAPS-02 confirms a prepared proposal and keeps the learner selected", async () => {
  const f = fixture();
  const done = await f.post(`${admin}/plans`, {
    ownerId: id,
    courses: JSON.stringify(["FND-001", 2]),
    "amount_FND-001_2": "10.01",
    tax: "1.00",
    cadence: "one_time",
    startsOn: "2026-10-31",
  });
  expect(done.status).toBe(303);
  expect(done.headers.location).toBe(`${admin}?ownerId=${id}&prepared=1`);
  const page = await f.get(done.headers.location!);
  expect(page.status).toBe(200);
  expect(page.text).toContain(
    '<p role="status">Course billing proposal prepared. The learner can now review and accept it in Courses and invoices.</p>',
  );
  expect((await f.get(`${admin}?ownerId=${id}`)).text).not.toContain(
    "Course billing proposal prepared",
  );
  expect((await f.get(`${admin}?ownerId=${id}&prepared=2`)).status).toBe(422);
  expect((await f.get(`${admin}?prepared=1`)).status).toBe(422);
});

const refundForm = {
  amount: "1.00",
  refundedOn: "2026-10-31",
  evidence: " Invented refund ",
  confirm: "refunded",
};
it("MANPAY-04 posts a confirmed refund and refuses anything unconfirmed or unavailable", async () => {
  const f = fixture();
  expect((await f.post(`${admin}/${id}/refund`, refundForm)).status).toBe(303);
  expect(f.service.refund.mock.calls[0]![1]).toMatchObject({
    amountCents: 100,
    refundedOn: "2026-10-31",
    evidence: "Invented refund",
  });
  for (const fields of [
    { ...refundForm, confirm: "no" },
    { ...refundForm, amount: "bad" },
  ])
    expect((await f.post(`${admin}/${id}/refund`, fields)).status).toBe(422);
  await f.post(`${admin}/${id}/refund`, {
    amount: "1.00",
    confirm: "refunded",
  });
  expect(f.service.refund.mock.lastCall![1]).toMatchObject({ evidence: "" });
  f.service.refund.mockResolvedValueOnce({ kind: "conflict" });
  expect((await f.post(`${admin}/${id}/refund`, refundForm)).status).toBe(409);
  expect(
    (await f.post(`${admin}/${id}/refund`, { ...refundForm, extra: "x" }))
      .status,
  ).toBe(403);
});
it("MANPAY-01/03/04 shows payment history, statuses and the refund form only when funds remain", async () => {
  const f = fixture();
  const paidDoc = { ...doc, paidCents: 300, refundedCents: 100 };
  const payments = [
    {
      kind: "receipt",
      amountCents: 300,
      on: "2026-10-30",
      evidence: "<Invented>",
      verification: "manual_unverified",
      recordedBy: "Staff account 12345678",
    },
    {
      kind: "refund",
      amountCents: 100,
      on: "2026-10-31",
      evidence: null,
      verification: "manual_unverified",
    },
  ];
  const stored = {
    ...invoice,
    document: paidDoc,
    paidCents: 300,
    refundedCents: 100,
    payments,
  };
  f.service.invoice.mockResolvedValueOnce(ready(stored));
  const page = await f.get(`${admin}/${id}`);
  expect(page.text).toContain("Payment record");
  expect(page.text).toContain("&lt;Invented&gt;");
  expect(page.text).toContain("Not recorded");
  expect(page.text).toContain("Staff account 12345678");
  expect(page.text).toContain("−CAD 1.00");
  expect(page.text).toContain("Recorded refund");
  expect(page.text).toContain("Not verified by a payment provider");
  expect(page.text).toContain(">Record offline refund</button>");
  f.service.invoice.mockResolvedValueOnce(
    ready({ ...stored, refundedCents: 300 }),
  );
  expect((await f.get(`${admin}/${id}`)).text).not.toContain(
    ">Record offline refund</button>",
  );
  f.service.invoice.mockResolvedValueOnce(ready(invoice));
  const plain = await f.get(`${admin}/${id}`);
  expect(plain.text).not.toContain("Payment record");
  expect(plain.text).not.toContain(">Record offline refund</button>");
});
it("MANPAY-03 shows the member a receipt-only record with no staff column or refund note", async () => {
  const f = fixture();
  f.service.invoice.mockResolvedValueOnce(
    ready({
      ...invoice,
      paidCents: 300,
      document: { ...doc, paidCents: 300 },
      payments: [
        {
          kind: "receipt",
          amountCents: 300,
          on: "2026-10-30",
          evidence: "Invented reference",
          verification: "manual_unverified",
        },
      ],
    }),
  );
  const page = await f.get(`${base}/invoices/${id}`);
  expect(page.text).toContain("Invented reference");
  expect(page.text).toContain("Not verified by a payment provider");
  expect(page.text).not.toContain("Recorded by");
  expect(page.text).not.toContain("does not reopen this balance");
  expect(page.text).not.toContain("Recorded refund");
  expect(page.text).not.toContain("Record offline refund");
});
it("WALK-04 offers only the invoice actions the record can still accept", async () => {
  const f = fixture();
  const page = async (value: unknown) => {
    f.service.invoice.mockResolvedValueOnce(ready(value));
    return (await f.get(`${admin}/${id}`)).text;
  };
  const unpaid = await page(invoice);
  expect(unpaid).toContain(">Record offline payment</button>");
  expect(unpaid).toContain("Balance still due: CAD 11.00.");
  expect(unpaid).toContain(">Void unpaid invoice</button>");

  const part = await page({
    ...invoice,
    paidCents: 500,
    document: { ...doc, paidCents: 500 },
  });
  expect(part).toContain(">Record offline payment</button>");
  expect(part).toContain("Balance still due: CAD 6.00.");
  expect(part).not.toContain(">Void unpaid invoice</button>");

  const paid = await page({
    ...invoice,
    paidCents: 1100,
    document: { ...doc, paidCents: 1100 },
  });
  expect(paid).not.toContain(">Record offline payment</button>");
  expect(paid).not.toContain(">Void unpaid invoice</button>");
  expect(paid).toContain("Nothing is left to receive on this invoice.");
  expect(paid).toContain(">Record offline refund</button>");

  const voided = await page({
    ...invoice,
    voidReason: "Invented wrong bundle",
    document: { ...doc, voidReason: "Invented wrong bundle" },
  });
  expect(voided).not.toContain(">Record offline payment</button>");
  expect(voided).not.toContain(">Void unpaid invoice</button>");
});

it("WALK-02 tells a member with no invoices that none have been issued, and lists them once they exist", async () => {
  const f = fixture();
  const empty = (await f.get(base)).text;
  expect(empty).toContain("<h2>Your invoices</h2>");
  expect(empty).toContain("No invoices have been issued to this account yet.");
  expect(empty).not.toContain("<ul></ul>");
  f.service.overview.mockResolvedValueOnce(
    ready({
      plans: [],
      invoices: [{ ...invoice, document: { ...doc, sample: true } }],
      today: "2026-10-31",
      unavailable: {},
    }),
  );
  const listed = (await f.get(base)).text;
  expect(listed).toMatch(/<h2>Your invoices<\/h2><ul><li>/);
  expect(listed).not.toContain("No invoices have been issued");
});
