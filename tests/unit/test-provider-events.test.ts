import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import {
  practiceTransaction,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { invoiceDigest } from "../../src/simple-invoice-values.ts";
import {
  mountTestProviderEvents,
  parseTestProviderEvent,
  signTestProviderEvent,
  TEST_PROVIDER_PATH,
  TEST_PROVIDER_SIGNATURE,
  testEventEffect,
  testProviderEventStore,
  validTestProviderSignature,
  type InvoiceMoney,
  type TestProviderEvent,
  type TestProviderEventStore,
} from "../../src/test-provider-events.ts";
import { withLoopback } from "../support/loopback-server.ts";

vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));

const key = "invented-test-provider-key-0123456789",
  invoiceId = "33333333-3333-4333-8333-333333333333";
const valid: TestProviderEvent = {
  id: "evt-1",
  type: "payment.succeeded",
  invoiceId,
  paymentRef: "pay-1",
  amountCents: 3000,
  occurredAt: "2026-11-01T12:00:00.000Z",
};
const parse = (value: unknown) =>
  parseTestProviderEvent(Buffer.from(JSON.stringify(value)));

it("TESTPAY-03 accepts only the exact signature of the exact bytes", () => {
  const body = Buffer.from("{}"),
    signature = signTestProviderEvent(key, body);
  expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  expect(validTestProviderSignature(key, signature, body)).toBe(true);
  expect(validTestProviderSignature(key, signature, Buffer.from("{ }"))).toBe(
    false,
  );
  expect(validTestProviderSignature("other", signature, body)).toBe(false);
  expect(validTestProviderSignature(key, "sha256=short", body)).toBe(false);
  expect(validTestProviderSignature(key, undefined, body)).toBe(false);
  expect(validTestProviderSignature(key, signature, {})).toBe(false);
});

it("TESTPAY-03 reads only a complete, well-formed event", () => {
  expect(parse(valid)).toEqual(valid);
  expect(
    parse({
      amountCents: 1,
      type: "refund.succeeded",
      id: "e",
      paymentRef: "p",
      invoiceId,
      occurredAt: "2026-11-01T12:00:00Z",
    }),
  ).toMatchObject({ type: "refund.succeeded", amountCents: 1 });
  expect(parseTestProviderEvent(Buffer.from("not json"))).toBeNull();
  expect(parse(null)).toBeNull();
  expect(parse(7)).toBeNull();
  for (const change of [
    { id: 1 },
    { id: "has space" },
    { id: "1234567890123456" },
    { paymentRef: 1 },
    { paymentRef: "a.b" },
    { type: "payment.maybe" },
    { invoiceId: "nope" },
    { amountCents: 0 },
    { amountCents: 1.5 },
    { occurredAt: 1 },
    { occurredAt: "2026-11-01" },
    { occurredAt: "2026-13-45T12:00:00Z" },
    { extra: true },
  ])
    expect(parse({ ...valid, ...change })).toBeNull();
});

const money = (change: Partial<InvoiceMoney> = {}): InvoiceMoney => ({
  voided: false,
  totalCents: 3000,
  paidCents: 0,
  refundedCents: 0,
  events: [],
  ...change,
});
const paid = money({
  paidCents: 3000,
  events: [{ kind: "receipt", paymentRef: "pay-1", amountCents: 3000 }],
});

it("TESTPAY-06/07/09 decides each event's effect from recorded state alone", () => {
  const event = (
    type: TestProviderEvent["type"],
    amountCents = 3000,
    paymentRef = "pay-1",
  ) => ({ type, amountCents, paymentRef });
  expect(testEventEffect(money(), event("payment.succeeded"))).toBe("receipt");
  expect(testEventEffect(paid, event("payment.failed"))).toBe("failure");
  expect(testEventEffect(money(), event("payment.failed"))).toBe("failure");
  expect(
    testEventEffect(money({ voided: true }), event("payment.succeeded")),
  ).toBe("held");
  expect(testEventEffect(paid, event("payment.succeeded", 1))).toBe("held");
  expect(
    testEventEffect(
      money({ paidCents: 2000 }),
      event("payment.succeeded", 1001),
    ),
  ).toBe("held");
  expect(testEventEffect(money(), event("refund.succeeded"))).toBe("held");
  expect(testEventEffect(paid, event("refund.succeeded", 1, "pay-2"))).toBe(
    "held",
  );
  expect(testEventEffect(paid, event("refund.succeeded", 3000))).toBe("refund");
  expect(testEventEffect(paid, event("refund.succeeded", 3001))).toBe("held");
  expect(
    testEventEffect(
      {
        ...paid,
        refundedCents: 2000,
        events: [
          ...paid.events,
          { kind: "refund", paymentRef: "pay-1", amountCents: 2000 },
        ],
      },
      event("refund.succeeded", 1001),
    ),
  ).toBe("held");
  // A staff-recorded refund already used these funds.
  expect(
    testEventEffect(
      { ...paid, refundedCents: 2500 },
      event("refund.succeeded", 1000),
    ),
  ).toBe("held");
});

type Row = Record<string, unknown>;
function harness(state: { invoice?: Row; previous?: Row; stored?: Row[] }) {
  const stored = [...(state.stored ?? [])],
    invoice = state.invoice;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("provider_event_digest AS digest FROM"))
      return { rows: state.previous ? [state.previous] : [] };
    if (sql.startsWith("SELECT owner_id"))
      return { rows: invoice ? [invoice] : [] };
    if (sql.startsWith("SELECT kind")) return { rows: [...stored] };
    if (sql.startsWith("INSERT INTO simple_invoice_payments"))
      stored.push({
        kind: values[4],
        id: values[6],
        type: values[8],
        paymentRef: values[7],
        amountCents: String(values[2]),
        digest: values[9],
        occurredAt: values[3],
      });
    if (sql.startsWith("UPDATE simple_invoices"))
      invoice![sql.includes("paid_cents") ? "paidCents" : "refundedCents"] =
        String(values[1]);
    return { rows: [] };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query } as unknown as PracticeTransaction),
  );
  return { query, stored };
}
const openInvoice = () => ({
  ownerId: "owner",
  sample: true,
  voided: false,
  totalCents: "3000",
  paidCents: "0",
  refundedCents: "0",
});
const apply = (event: TestProviderEvent = valid) =>
  testProviderEventStore({} as Pool).apply(event);
const heldRefund = (id: string, amountCents: string) => ({
  kind: "held",
  id,
  type: "refund.succeeded",
  paymentRef: "pay-1",
  amountCents,
  digest: "d".repeat(64),
  occurredAt: "2026-11-01T12:00:00.000000Z",
});
beforeEach(() => {
  vi.mocked(practiceTransaction).mockReset();
});

it("TESTPAY-04/10 records a receipt, its total and a history entry with no staff actor", async () => {
  const f = harness({ invoice: openInvoice() });
  expect(await apply()).toEqual({
    kind: "ready",
    value: { outcome: "receipt" },
  });
  const sql = f.query.mock.calls.map(([text]) => text);
  expect(sql.some((text) => text.includes("paid_cents=paid_cents"))).toBe(true);
  expect(
    f.query.mock.calls.find(([text]) =>
      text.startsWith("INSERT INTO billing_change_events"),
    )![1],
  ).toEqual(["test_payment_received", "owner", 3000]);
});

it("TESTPAY-05 returns a duplicate or a conflict before reading the invoice", async () => {
  const same = harness({
    invoice: openInvoice(),
    previous: { digest: invoiceDigest(valid) },
  });
  expect(await apply()).toEqual({
    kind: "ready",
    value: { outcome: "duplicate" },
  });
  expect(same.stored).toEqual([]);
  harness({ invoice: openInvoice(), previous: { digest: "other" } });
  expect(await apply()).toEqual({ kind: "conflict" });
});

it("TESTPAY-09 hides a real or missing invoice and logs nothing for a held event", async () => {
  harness({});
  expect(await apply()).toEqual({ kind: "not-found" });
  harness({ invoice: { ...openInvoice(), sample: false } });
  expect(await apply()).toEqual({ kind: "not-found" });
  const held = harness({ invoice: { ...openInvoice(), voided: true } });
  expect(await apply()).toEqual({ kind: "ready", value: { outcome: "held" } });
  expect(
    held.query.mock.calls.some(
      ([text]) =>
        text.startsWith("UPDATE") || text.includes("billing_change_events"),
    ),
  ).toBe(false);
});

it("TESTPAY-07 logs a failure without touching a total", async () => {
  const f = harness({ invoice: openInvoice() });
  expect(
    await apply({ ...valid, id: "evt-f", type: "payment.failed" }),
  ).toEqual({ kind: "ready", value: { outcome: "failure" } });
  expect(f.query.mock.calls.some(([text]) => text.startsWith("UPDATE"))).toBe(
    false,
  );
  expect(
    f.query.mock.calls.find(([text]) =>
      text.startsWith("INSERT INTO billing_change_events"),
    )![1],
  ).toEqual(["test_payment_failed", "owner", 3000]);
});

it("TESTPAY-06 applies only the waiting refunds that still fit, each once", async () => {
  const f = harness({
    invoice: openInvoice(),
    stored: [
      heldRefund("evt-a", "1000"),
      heldRefund("evt-big", "2500"),
      // Already applied: its held row stays beside its refund row.
      heldRefund("evt-done", "100"),
      { ...heldRefund("evt-done", "100"), kind: "refund" },
      // Another payment's refund, and a repeated payment, stay held.
      { ...heldRefund("evt-other", "50"), paymentRef: "pay-2" },
      { ...heldRefund("evt-pay", "1"), type: "payment.succeeded" },
    ],
  });
  expect(await apply()).toEqual({
    kind: "ready",
    value: { outcome: "receipt" },
  });
  const refunds = f.stored.slice(6);
  expect(refunds.map((row) => [row.kind, row.id])).toEqual([
    ["receipt", "evt-1"],
    ["refund", "evt-a"],
  ]);
});

it("reports an unconfirmed outcome when the transaction fails", async () => {
  vi.mocked(practiceTransaction).mockRejectedValue(Error("offline"));
  expect(await apply()).toEqual({ kind: "unavailable" });
});

function application(store: Partial<TestProviderEventStore>) {
  const app = express();
  mountTestProviderEvents(app, {
    key,
    store: store as TestProviderEventStore,
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "failed" });
    },
  );
  return app;
}
const post = (
  store: Partial<TestProviderEventStore>,
  body: string,
  signature = signTestProviderEvent(key, body),
) =>
  withLoopback(application(store), (s) =>
    request(s)
      .post(TEST_PROVIDER_PATH)
      .set("Content-Type", "application/json")
      .set(TEST_PROVIDER_SIGNATURE, signature)
      .send(body),
  );

it("TESTPAY-03 answers the handler's outcomes and never calls the store for a refused body", async () => {
  const body = JSON.stringify(valid),
    apply = vi.fn();
  expect((await post({ apply }, body, "sha256=bad")).status).toBe(401);
  expect((await post({ apply }, "not json")).status).toBe(422);
  expect(
    (
      await post(
        { apply },
        JSON.stringify({ ...valid, occurredAt: "2099-01-01T00:00:00Z" }),
      )
    ).status,
  ).toBe(422);
  const unsent = await withLoopback(application({ apply }), (s) =>
    request(s).post(TEST_PROVIDER_PATH),
  );
  expect(unsent.status).toBe(401);
  expect(apply).not.toHaveBeenCalled();
  for (const [kind, status] of [
    ["conflict", 409],
    ["not-found", 404],
    ["unavailable", 503],
  ] as const) {
    apply.mockResolvedValueOnce({ kind });
    const answer = await post({ apply }, body);
    expect(answer.status).toBe(status);
    expect(answer.body).toEqual({ error: kind });
  }
  apply.mockResolvedValueOnce({
    kind: "ready",
    value: { outcome: "duplicate" },
  });
  expect((await post({ apply }, body)).body).toEqual({ outcome: "duplicate" });
  apply.mockRejectedValueOnce(Error("offline"));
  expect((await post({ apply }, body)).status).toBe(500);
});
