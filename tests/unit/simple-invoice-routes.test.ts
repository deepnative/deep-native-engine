import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { mountSimpleInvoiceRoutes } from "../../src/simple-invoice-routes.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { csrf } from "../../src/session.ts";
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
    overview: vi.fn().mockResolvedValue(ready({ plans: [], invoices: [] })),
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
    voidInvoice: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
    generateDue: vi.fn().mockResolvedValue(ready({ created: 0 })),
    claimEmail: vi.fn().mockResolvedValue(ready({ send: true, invoice })),
    finishEmail: vi.fn().mockResolvedValue(ready({ invoiceId: id })),
  };
  const sender = { send: vi.fn().mockResolvedValue(undefined) };
  const options = {
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
  return { service, sender, options, app, get, post };
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
        confirm: "received",
      })
    ).status,
  ).toBe(303);
  expect(f.service.pay.mock.calls[0]![1]).toMatchObject({
    amountCents: 100,
    receivedOn: "2026-10-31",
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
