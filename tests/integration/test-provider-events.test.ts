import { createHmac, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { readInvoiceReconciliation } from "../../src/invoice-reconciliation.ts";
import { readChangeHistory } from "../../src/staff-change-history.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { testProviderEventStore } from "../../src/test-provider-events.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  invoices = simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented invoice issuer",
    instructions: "Sample only; do not pay.",
  }),
  realInvoices = simpleInvoiceStore(pool, {
    sample: false,
    issuer: "Invented configured issuer",
    instructions: "Invented offline instructions",
  }),
  key = "invented-test-provider-key-0123456789",
  origin = "http://127.0.0.1:3000",
  secret = "native-test-provider-events",
  enabled = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
    testProviderEvents: { key, store: testProviderEventStore(pool) },
  }),
  disabled = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
  }),
  path = "/test-provider/invoice-events";
const ready = <T>(r: InvoiceResult<T>): T => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected invoice result");
  return r.value;
};
let admin: string, today: string;
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token, "account");
  if (session.kind !== "active") throw Error("Member fixture missing");
  return { token, id: session.learner.id };
}
async function issued(source = invoices) {
  const m = await member(),
    p = ready(
      await source.propose(admin, {
        ownerId: m.id,
        operationId: randomUUID(),
        courses: [
          { id: "FND-001", version: 2, amountCents: 1000 },
          { id: "FND-002", version: 2, amountCents: 2000 },
        ],
        cadence: "one_time",
        startsOn: today,
        taxCents: 0,
      }),
    ),
    { invoiceId } = ready(
      await source.accept(m.token, {
        planId: p.planId,
        expectedRevision: 1,
        operationId: randomUUID(),
        name: "Invented student",
        email: "invented-student@example.invalid",
      }),
    );
  return { ...m, planId: p.planId, invoiceId };
}
let eventNumber = 0;
const event = (invoiceId: string, change: Record<string, unknown> = {}) => ({
  id: `evt-${++eventNumber}`,
  type: "payment.succeeded",
  invoiceId,
  paymentRef: "pay-1",
  amountCents: 3000,
  occurredAt: "2026-11-01T12:00:00.000Z",
  ...change,
});
const sign = (body: string, using = key) =>
  "sha256=" + createHmac("sha256", using).update(body).digest("hex");
const deliver = (body: unknown, signature?: string, application = enabled) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return withLoopback(application, (s) => {
    const call = request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Content-Type", "application/json")
      .set("X-DNE-Test-Signature", signature ?? sign(raw));
    return call.send(raw);
  });
};
const totals = async (id: string) =>
  (
    await pool.query<{ paid: number; refunded: number; revision: number }>(
      "SELECT paid_cents::int AS paid,refunded_cents::int AS refunded,revision FROM simple_invoices WHERE id=$1",
      [id],
    )
  ).rows[0]!;
const rows = async (id: string) =>
  (
    await pool.query<{
      kind: string;
      verification: string;
      actor_id: string | null;
      amount: number;
      provider_event_id: string | null;
    }>(
      `SELECT kind,verification,actor_id,amount_cents::int AS amount,provider_event_id
       FROM simple_invoice_payments WHERE invoice_id=$1 ORDER BY recorded_at,id`,
      [id],
    )
  ).rows;

beforeAll(async () => {
  await migrate(pool);
  // The foundation import must start fresh whichever lane file ran before.
  await pool.query("TRUNCATE principals,cohorts,content_versions CASCADE");
  await seedDraftPack(pool);
  const staff = async (role: "platform_admin" | "reviewer" | "editor") => {
    const token = randomBytes(32).toString("hex");
    await auth.provisionStaff(token, role, new Date(Date.now() + 3_600_000));
    return token;
  };
  admin = await staff("platform_admin");
  const editor = await staff("editor"),
    reviewer = await staff("reviewer");
  expect(await foundationImportStore(pool).import(editor)).toBe("imported");
  for (const item of await reviewedFoundation()) {
    expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
  }
  today = (
    await pool.query<{ today: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
    )
  ).rows[0]!.today;
});
afterAll(() => pool.end());

it("TESTPAY-01 records nothing and has no route when the setting is off", async () => {
  const i = await issued();
  const off = await deliver(event(i.invoiceId), undefined, disabled);
  expect(off.status).toBe(403);
  const read = await withLoopback(disabled, (s) =>
    request(s).get(path).set("Host", "127.0.0.1:3000"),
  );
  expect(read.status).toBe(404);
  expect(await rows(i.invoiceId)).toEqual([]);
  expect((await totals(i.invoiceId)).paid).toBe(0);
});

it("TESTPAY-03 refuses a missing, wrong or tampered signature before recording anything", async () => {
  const i = await issued(),
    good = JSON.stringify(event(i.invoiceId)),
    tampered = good.replace("3000", "1");
  for (const [body, signature] of [
    [good, "sha256=" + "0".repeat(64)],
    [good, sign(good, "another-invented-key-0123456789abcd")],
    [good, "not-a-signature"],
    [tampered, sign(good)],
  ] as const) {
    const refused = await deliver(body, signature);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "invalid-signature" });
  }
  const none = await withLoopback(enabled, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Content-Type", "application/json")
      .send(good),
  );
  expect(none.status).toBe(401);
  expect(await rows(i.invoiceId)).toEqual([]);
  expect((await totals(i.invoiceId)).paid).toBe(0);
});

it("TESTPAY-03 refuses a signed body that is not a valid event", async () => {
  const i = await issued();
  for (const body of [
    "not json",
    event(i.invoiceId, { amountCents: 0 }),
    event(i.invoiceId, { type: "payment.maybe" }),
    event(i.invoiceId, { extra: "field" }),
    event(i.invoiceId, { occurredAt: "2099-01-01T00:00:00.000Z" }),
  ]) {
    expect((await deliver(body)).status).toBe(422);
  }
  expect(await rows(i.invoiceId)).toEqual([]);
});

it("TESTPAY-04 applies a signed success as a labelled receipt with no staff actor", async () => {
  const i = await issued(),
    e = event(i.invoiceId);
  const applied = await deliver(e);
  expect(applied.status).toBe(200);
  expect(applied.body).toEqual({ outcome: "receipt" });
  expect(await totals(i.invoiceId)).toMatchObject({ paid: 3000, revision: 2 });
  expect(await rows(i.invoiceId)).toEqual([
    {
      kind: "receipt",
      verification: "signed_test_event",
      actor_id: null,
      amount: 3000,
      provider_event_id: e.id,
    },
  ]);
});

it("TESTPAY-05 applies a duplicate once, refuses changed content and moves no money for a second success", async () => {
  const i = await issued(),
    e = event(i.invoiceId);
  expect((await deliver(e)).body).toEqual({ outcome: "receipt" });
  const again = await deliver(e);
  expect(again.status).toBe(200);
  expect(again.body).toEqual({ outcome: "duplicate" });
  const changed = await deliver({ ...e, amountCents: 1000 });
  expect(changed.status).toBe(409);
  expect((await totals(i.invoiceId)).paid).toBe(3000);
  expect(await rows(i.invoiceId)).toHaveLength(1);

  const other = await issued(),
    first = event(other.invoiceId, { amountCents: 1000 });
  expect((await deliver(first)).body).toEqual({ outcome: "receipt" });
  expect(
    (await deliver(event(other.invoiceId, { amountCents: 1000 }))).body,
  ).toEqual({ outcome: "held" });
  expect((await totals(other.invoiceId)).paid).toBe(1000);
});

it("TESTPAY-05 applies racing duplicates once", async () => {
  const i = await issued(),
    e = event(i.invoiceId),
    results = await Promise.all(
      Array.from({ length: 8 }, () =>
        testProviderEventStore(pool).apply(
          e as Parameters<
            ReturnType<typeof testProviderEventStore>["apply"]
          >[0],
        ),
      ),
    );
  expect(results.map((r) => ready(r).outcome).sort()).toEqual([
    ...Array.from({ length: 7 }, () => "duplicate"),
    "receipt",
  ]);
  expect((await totals(i.invoiceId)).paid).toBe(3000);
  expect(await rows(i.invoiceId)).toHaveLength(1);
});

const permutations = <T>(items: T[]): T[][] =>
  items.length < 2
    ? [items]
    : items.flatMap((item, at) =>
        permutations(items.filter((_, other) => other !== at)).map((rest) => [
          item,
          ...rest,
        ]),
      );

it("TESTPAY-06 reaches the same state for every arrival order", async () => {
  const shapes = [
    { type: "payment.failed", paymentRef: "pay-0" },
    { type: "payment.succeeded" },
    { type: "refund.succeeded", amountCents: 1000 },
    { type: "refund.succeeded", amountCents: 500 },
  ];
  for (const order of permutations(shapes)) {
    const i = await issued();
    for (const shape of order) {
      expect((await deliver(event(i.invoiceId, shape))).status).toBe(200);
    }
    expect(await totals(i.invoiceId)).toMatchObject({
      paid: 3000,
      refunded: 1500,
      revision: 4,
    });
    const shown = ready(await invoices.invoice(i.token, i.invoiceId));
    expect(shown.payments!.map((p) => p.kind).sort()).toEqual([
      "failure",
      "receipt",
      "refund",
      "refund",
    ]);
  }
});

it("TESTPAY-06 holds a refund that arrives first and applies it once when the payment arrives", async () => {
  const i = await issued(),
    refund = event(i.invoiceId, { type: "refund.succeeded", amountCents: 500 });
  expect((await deliver(refund)).body).toEqual({ outcome: "held" });
  expect(await totals(i.invoiceId)).toMatchObject({ paid: 0, refunded: 0 });
  expect((await deliver(refund)).body).toEqual({ outcome: "duplicate" });
  expect((await deliver(event(i.invoiceId))).body).toEqual({
    outcome: "receipt",
  });
  expect(await totals(i.invoiceId)).toMatchObject({
    paid: 3000,
    refunded: 500,
  });
  expect((await deliver(refund)).body).toEqual({ outcome: "duplicate" });
  expect((await totals(i.invoiceId)).refunded).toBe(500);
  expect((await rows(i.invoiceId)).map((r) => r.kind).sort()).toEqual([
    "held",
    "receipt",
    "refund",
  ]);
});

it("TESTPAY-06 holds a refund above what its payment received", async () => {
  const i = await issued();
  await deliver(event(i.invoiceId, { amountCents: 1000 }));
  expect(
    (
      await deliver(
        event(i.invoiceId, { type: "refund.succeeded", amountCents: 1001 }),
      )
    ).body,
  ).toEqual({ outcome: "held" });
  expect((await totals(i.invoiceId)).refunded).toBe(0);
});

it("TESTPAY-07 keeps paid status after a stale failure and never infers a refund from failure", async () => {
  const i = await issued();
  await deliver(event(i.invoiceId));
  const stale = await deliver(
    event(i.invoiceId, {
      type: "payment.failed",
      occurredAt: "2026-10-01T12:00:00.000Z",
    }),
  );
  expect(stale.body).toEqual({ outcome: "failure" });
  expect(await totals(i.invoiceId)).toMatchObject({
    paid: 3000,
    refunded: 0,
    revision: 2,
  });

  const unpaid = await issued();
  expect(
    (await deliver(event(unpaid.invoiceId, { type: "payment.failed" }))).body,
  ).toEqual({ outcome: "failure" });
  expect(await totals(unpaid.invoiceId)).toMatchObject({
    paid: 0,
    refunded: 0,
    revision: 1,
  });
  expect((await rows(unpaid.invoiceId)).map((r) => r.kind)).toEqual([
    "failure",
  ]);
  const own = await withLoopback(enabled, (s) =>
    request(s)
      .get(`/account/purchases/invoices/${unpaid.invoiceId}`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${unpaid.token}`),
  );
  expect(own.text).toContain("Test payment failed");
  expect(own.text).not.toContain("Recorded refund");
});

it("TESTPAY-08 grants nothing from a return address, and a signed event changes only the invoice record", async () => {
  const i = await issued();
  const snapshot = async () =>
    (
      await pool.query(
        `SELECT (SELECT to_jsonb(p)-'updated_at' FROM simple_invoice_plans p WHERE p.id=$2) AS plan,
          (SELECT count(*)::int FROM synthetic_entitlement_grants WHERE member_id=$1) AS grants,
          (SELECT count(*)::int FROM synthetic_entitlement_events e JOIN synthetic_entitlement_grants g ON g.id=e.grant_id WHERE g.member_id=$1) AS events`,
        [i.id, i.planId],
      )
    ).rows[0];
  const before = await snapshot();
  for (const address of [
    `/account/purchases/invoices/${i.invoiceId}?payment=success&status=paid&session_id=invented`,
    `${path}?invoiceId=${i.invoiceId}&type=payment.succeeded&status=paid`,
  ]) {
    await withLoopback(enabled, (s) =>
      request(s)
        .get(address)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${i.token}`),
    );
  }
  expect(await totals(i.invoiceId)).toMatchObject({ paid: 0, revision: 1 });
  expect(await rows(i.invoiceId)).toEqual([]);
  expect(await snapshot()).toEqual(before);
  await deliver(event(i.invoiceId));
  expect((await totals(i.invoiceId)).paid).toBe(3000);
  expect(await snapshot()).toEqual(before);
});

it("TESTPAY-09 refuses a real invoice, in the handler and in the database", async () => {
  const i = await issued(realInvoices),
    refused = await deliver(event(i.invoiceId));
  expect(refused.status).toBe(404);
  expect(await rows(i.invoiceId)).toEqual([]);
  await expect(
    pool.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,verification,evidence_reference,
         provider_event_id,provider_payment_ref,provider_event_type,provider_event_digest,provider_occurred_at)
       VALUES($1,$2,100,'2026-11-01','receipt','signed_test_event','Test event x','x','p','payment.succeeded',$3,now())`,
      [randomUUID(), i.invoiceId, "a".repeat(64)],
    ),
  ).rejects.toThrow("sample");
  expect((await deliver(event(randomUUID()))).status).toBe(404);
});

it("TESTPAY-09 holds a payment on a void invoice or above the balance, moving no money", async () => {
  const voided = await issued();
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented correction",
    }),
  );
  expect((await deliver(event(voided.invoiceId))).body).toEqual({
    outcome: "held",
  });
  expect((await totals(voided.invoiceId)).paid).toBe(0);

  const part = await issued();
  ready(
    await invoices.pay(admin, {
      invoiceId: part.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      amountCents: 1000,
      receivedOn: today,
      evidence: "Invented bank reference",
    }),
  );
  expect((await deliver(event(part.invoiceId))).body).toEqual({
    outcome: "held",
  });
  expect((await totals(part.invoiceId)).paid).toBe(1000);
});

it("TESTPAY-10 reads as simulated to member and staff and is labelled in change history", async () => {
  const i = await issued();
  await deliver(event(i.invoiceId));
  await deliver(
    event(i.invoiceId, { type: "refund.succeeded", amountCents: 500 }),
  );
  await deliver(
    event(i.invoiceId, { type: "payment.failed", paymentRef: "p2" }),
  );
  const read = (address: string, token: string) =>
    withLoopback(enabled, (s) =>
      request(s)
        .get(address)
        .set("Host", "127.0.0.1:3000")
        .set("Cookie", `${COOKIE}=${token}`),
    );
  const own = await read(`/account/purchases/invoices/${i.invoiceId}`, i.token),
    staffView = await read(`/operator/invoices/${i.invoiceId}`, admin);
  for (const text of [own.text, staffView.text]) {
    expect(text).toContain("Test receipt");
    expect(text).toContain("Test refund");
    expect(text).toContain("Test payment failed");
    expect(text).toContain("No payment provider checked them");
    expect(text).toContain("no money moved");
    expect(text).not.toContain("Recorded manually by staff");
    expect(text).not.toMatch(
      /verified by (a|the) (payment )?provider\.?<\/p>(?!.*Not)/,
    );
  }
  expect(staffView.text).toContain("Signed test event");
  expect(own.text).not.toContain("Recorded by");
  const client = await pool.connect();
  try {
    const history = await readChangeHistory(client, undefined);
    if (history.kind !== "ready") throw Error("Expected history");
    const mine = history.value.entries.filter(
      (e) => e.personFound && e.action.startsWith("test_"),
    );
    expect(mine.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "test_payment_received",
        "test_refund_recorded",
        "test_payment_failed",
      ]),
    );
    expect(mine.every((e) => !e.actorFound)).toBe(true);
  } finally {
    client.release();
  }
  const logged = await pool.query<{ actor_id: string | null }>(
    "SELECT actor_id FROM billing_change_events WHERE member_id=$1",
    [i.id],
  );
  expect(logged.rows.filter((r) => r.actor_id === null)).toHaveLength(3);
  await expect(
    pool.query(
      "INSERT INTO billing_change_events(actor_id,action,member_id) VALUES(NULL,'payment_refunded',$1)",
      [i.id],
    ),
  ).rejects.toThrow("billing_change_events_actor");
  await expect(
    pool.query(
      "INSERT INTO billing_change_events(actor_id,action,member_id) VALUES($1,'test_payment_failed',$1)",
      [i.id],
    ),
  ).rejects.toThrow("billing_change_events_actor");
});

it("TESTPAY-11 keeps signed event rows immutable and refuses a claim of provider verification", async () => {
  const i = await issued();
  await deliver(event(i.invoiceId));
  await deliver(event(i.invoiceId, { type: "payment.failed" }));
  await deliver(event(i.invoiceId, { amountCents: 1 }));
  await expect(
    pool.query(
      "UPDATE simple_invoice_payments SET amount_cents=1 WHERE invoice_id=$1",
      [i.invoiceId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM simple_invoice_payments WHERE invoice_id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,verification,evidence_reference,
         provider_event_id,provider_payment_ref,provider_event_type,provider_event_digest,provider_occurred_at)
       VALUES($1,$2,100,'2026-11-01','receipt','provider_verified','Claim','y','p','payment.succeeded',$3,now())`,
      [randomUUID(), i.invoiceId, "a".repeat(64)],
    ),
  ).rejects.toThrow("simple_invoice_payments_verification");
  await expect(
    pool.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,actor_id,amount_cents,received_on,kind,verification,evidence_reference)
       VALUES($1,$2,$3,100,'2026-11-01','receipt','signed_test_event','No event')`,
      [randomUUID(), i.invoiceId, i.id],
    ),
  ).rejects.toThrow("simple_invoice_payments_verification");
  await migrate(pool);
  // Every migration re-runs at each start and must accept these rows.
  expect(await rows(i.invoiceId)).toHaveLength(3);
});

it("TESTPAY-12 exports the member's own signed test events without an actor or digest", async () => {
  const i = await issued(),
    e = event(i.invoiceId);
  await deliver(e);
  const records: Record<string, unknown[]> = {};
  let cursor: string | undefined;
  do {
    const result = await memberExportStore(pool).exportOwned(i.token, cursor);
    if (result.kind !== "ready") throw Error("Export unavailable");
    for (const [name, value] of Object.entries(result.payload.records))
      records[name] = [...(records[name] ?? []), ...value];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(records.invoicePayments).toEqual([
    expect.objectContaining({
      kind: "receipt",
      verification: "signed_test_event",
      evidence: `Test event ${e.id}`,
      amountCents: "3000",
    }),
  ]);
  expect(JSON.stringify(records.invoicePayments)).not.toMatch(
    /actor|provider_event_digest/,
  );
});
it("TESTPAY-13 reports only applied test events as simulated, never failed or held ones as cash or late", async () => {
  const before = (await readInvoiceReconciliation(pool)).groups[1];
  const { invoiceId } = await issued();
  const lastYear = "2025-01-15T12:00:00.000Z";
  for (const change of [
    { type: "payment.failed", amountCents: 500, occurredAt: lastYear },
    { type: "refund.succeeded", amountCents: 100, occurredAt: lastYear },
    { type: "payment.succeeded", amountCents: 900, paymentRef: "pay-paid" },
  ])
    await deliver(event(invoiceId, change));
  const row = (await readInvoiceReconciliation(pool)).groups[1];
  expect(row.simulatedReceiptCents - before.simulatedReceiptCents).toBe(900);
  expect(row.simulatedRefundCents - before.simulatedRefundCents).toBe(0);
  expect(row.receiptCents - before.receiptCents).toBe(0);
  expect(row.refundCents - before.refundCents).toBe(0);
  expect(row.lateEvents - before.lateEvents).toBe(0);
  expect(row.lateCents - before.lateCents).toBe(0);
  expect(row.mismatchedInvoices - before.mismatchedInvoices).toBe(0);
});

const services = async (invoiceId: string) =>
  (
    await pool.query<{ state: string; cause: string }>(
      `SELECT state,cause_event_id AS cause FROM sample_service_states
       WHERE invoice_id=$1 ORDER BY changed_at,state`,
      [invoiceId],
    )
  ).rows;
const page = (address: string, token: string) =>
  withLoopback(enabled, (s) =>
    request(s)
      .get(address)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );

it("SVC-01 keeps the simulated service awaiting payment until signed receipts cover the total, whatever staff record manually", async () => {
  const i = await issued();
  ready(
    await invoices.pay(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      amountCents: 3000,
      receivedOn: today,
      evidence: "Invented bank reference",
    }),
  );
  expect((await totals(i.invoiceId)).paid).toBe(3000);
  expect(await services(i.invoiceId)).toEqual([]);
  expect(ready(await invoices.invoice(i.token, i.invoiceId)).service).toBe(
    undefined,
  );
});

it("SVC-02 appends one ready record naming the event once signed receipts cover the total", async () => {
  const i = await issued(),
    first = event(i.invoiceId, { amountCents: 1000 });
  expect((await deliver(first)).body).toEqual({ outcome: "receipt" });
  expect(await services(i.invoiceId)).toEqual([]);
  expect(ready(await invoices.invoice(i.token, i.invoiceId)).service).toEqual({
    state: "awaiting_payment",
  });
  const rest = event(i.invoiceId, { amountCents: 2000, paymentRef: "pay-2" });
  expect((await deliver(rest)).body).toEqual({ outcome: "receipt" });
  expect(await deliver(rest)).toMatchObject({
    body: { outcome: "duplicate" },
  });
  expect(await services(i.invoiceId)).toEqual([
    { state: "ready", cause: rest.id },
  ]);
  expect(
    ready(await invoices.invoice(i.token, i.invoiceId)).service,
  ).toMatchObject({ state: "ready" });
});

it("SVC-03 withdraws a ready service after a refund, and every arrival order ends in the same service state", async () => {
  const i = await issued();
  await deliver(event(i.invoiceId));
  const refund = event(i.invoiceId, {
    type: "refund.succeeded",
    amountCents: 500,
  });
  await deliver(refund);
  expect(await services(i.invoiceId)).toEqual([
    { state: "ready", cause: expect.any(String) },
    { state: "withdrawn", cause: refund.id },
  ]);
  const shapes = [
    { type: "payment.failed", paymentRef: "pay-0" },
    { type: "payment.succeeded" },
    { type: "refund.succeeded", amountCents: 1000 },
  ];
  for (const order of permutations(shapes)) {
    const o = await issued();
    for (const shape of order) await deliver(event(o.invoiceId, shape));
    expect(ready(await invoices.invoice(o.token, o.invoiceId)).service).toEqual(
      expect.objectContaining({ state: "withdrawn" }),
    );
    expect((await services(o.invoiceId)).at(-1)!.state).toBe("withdrawn");
  }
});

it("SVC-04 leaves the service state alone for failures, held events, duplicates and stale failures", async () => {
  const i = await issued(),
    pay = event(i.invoiceId);
  await deliver(pay);
  const before = await services(i.invoiceId);
  expect(before.map((s) => s.state)).toEqual(["ready"]);
  for (const change of [
    { type: "payment.failed", occurredAt: "2026-10-01T12:00:00.000Z" },
    { paymentRef: "pay-extra" },
    { type: "refund.succeeded", amountCents: 3001 },
  ])
    await deliver(event(i.invoiceId, change));
  await deliver(pay);
  expect(await services(i.invoiceId)).toEqual(before);
});

it("SVC-05 grants nothing when the simulated service is ready", async () => {
  const i = await issued();
  const snapshot = async () =>
    (
      await pool.query(
        `SELECT (SELECT to_jsonb(p)-'updated_at' FROM simple_invoice_plans p WHERE p.id=$2) AS plan,
          (SELECT count(*)::int FROM synthetic_entitlement_grants WHERE member_id=$1) AS grants,
          (SELECT count(*)::int FROM synthetic_entitlement_events e JOIN synthetic_entitlement_grants g ON g.id=e.grant_id WHERE g.member_id=$1) AS events`,
        [i.id, i.planId],
      )
    ).rows[0];
  const before = await snapshot();
  await deliver(event(i.invoiceId));
  expect((await services(i.invoiceId)).map((s) => s.state)).toEqual(["ready"]);
  expect(await snapshot()).toEqual(before);
});

it("SVC-06 refuses service records on real invoices, edits, deletes, repeats or a return to ready, and erases them with the sample", async () => {
  const insert = (invoiceId: string, state: string, cause: string) =>
    pool.query(
      "INSERT INTO sample_service_states(id,invoice_id,state,cause_event_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), invoiceId, state, cause],
    );
  const real = await issued(realInvoices);
  await expect(insert(real.invoiceId, "ready", "evt-x")).rejects.toThrow(
    "sample",
  );
  const unpaid = await issued();
  await expect(insert(unpaid.invoiceId, "ready", "evt-none")).rejects.toThrow(
    "signed test event",
  );
  const i = await issued(),
    pay = event(i.invoiceId),
    refund = event(i.invoiceId, {
      type: "refund.succeeded",
      amountCents: 3000,
    });
  await deliver(pay);
  await expect(insert(i.invoiceId, "ready", pay.id)).rejects.toThrow(
    "sample_service_states_invoice_id_state_key",
  );
  await expect(
    pool.query(
      "UPDATE sample_service_states SET state='withdrawn' WHERE invoice_id=$1",
      [i.invoiceId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM sample_service_states WHERE invoice_id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("immutable");
  const back = await issued();
  await deliver(event(back.invoiceId, { type: "refund.succeeded" }));
  const backPay = event(back.invoiceId);
  await deliver(backPay);
  expect((await services(back.invoiceId)).map((s) => s.state)).toEqual([
    "withdrawn",
  ]);
  await expect(insert(back.invoiceId, "ready", backPay.id)).rejects.toThrow(
    "cannot become ready",
  );
  await deliver(refund);
  await migrate(pool);
  // Every migration re-runs at each start and must keep these rows.
  expect(await services(i.invoiceId)).toHaveLength(2);
  await pool.query("DELETE FROM principals WHERE id=$1", [i.id]);
  expect(await services(i.invoiceId)).toEqual([]);
});

it("SVC-07 shows the simulated service to member and staff, saying nothing is provided", async () => {
  const quiet = await issued();
  expect(
    (await page(`/account/purchases/invoices/${quiet.invoiceId}`, quiet.token))
      .text,
  ).not.toContain("Service (simulated)");
  const i = await issued();
  await deliver(event(i.invoiceId, { amountCents: 1000 }));
  const waiting = await page(
    `/account/purchases/invoices/${i.invoiceId}`,
    i.token,
  );
  expect(waiting.text).toContain("Service (simulated)");
  expect(waiting.text).toContain("Awaiting payment");
  await deliver(event(i.invoiceId, { amountCents: 2000, paymentRef: "p2" }));
  for (const text of [
    (await page(`/account/purchases/invoices/${i.invoiceId}`, i.token)).text,
    (await page(`/operator/invoices/${i.invoiceId}`, admin)).text,
  ]) {
    expect(text).toContain("Service (simulated)");
    expect(text).toContain("Ready");
    expect(text).toContain("It provides nothing and grants no access");
  }
});

it("SVC-08 keeps the service awaiting payment when a signed receipt reaches a void invoice", async () => {
  const voided = await issued();
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented correction",
    }),
  );
  expect((await deliver(event(voided.invoiceId))).body).toEqual({
    outcome: "held",
  });
  expect(await services(voided.invoiceId)).toEqual([]);
  expect(
    ready(await invoices.invoice(voided.token, voided.invoiceId)).service,
  ).toEqual({ state: "awaiting_payment" });
});
