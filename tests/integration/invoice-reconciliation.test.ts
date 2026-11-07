import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import {
  invoiceReconciliationStore,
  readInvoiceReconciliation,
  type InvoiceReconciliationResult,
} from "../../src/invoice-reconciliation.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { COOKIE } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import {
  testProviderEventStore,
  type TestProviderEvent,
} from "../../src/test-provider-events.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool),
  settings = {
    issuer: "Invented invoice issuer",
    instructions: "Invented instructions; do not pay.",
  },
  invoices = simpleInvoiceStore(pool, { sample: true, ...settings }),
  configured = simpleInvoiceStore(pool, { sample: false, ...settings }),
  report = invoiceReconciliationStore(pool),
  testEvents = testProviderEventStore(pool),
  origin = "http://127.0.0.1:3000",
  secret = "native-invoice-reconciliation-test",
  application = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
    invoiceReconciliation: report,
  });
const path = "/operator/invoice-reconciliation";
const ready = <T>(r: InvoiceResult<T>): T => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected invoice result");
  return r.value;
};
const value = (r: InvoiceReconciliationResult) => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected report");
  return r.value;
};
let admin: string, today: string, lastMonth: string;
const staff = async (
  role: "platform_admin" | "operator" | "reviewer" | "editor",
) => {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3_600_000));
  return token;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token, "account");
  if (session.kind !== "active") throw Error("Member fixture missing");
  return { token, id: session.learner.id };
}
async function issued(using = invoices, cents = 3000) {
  const m = await member(),
    p = ready(
      await using.propose(admin, {
        ownerId: m.id,
        operationId: randomUUID(),
        courses: [{ id: "FND-001", version: 2, amountCents: cents }],
        cadence: "one_time",
        startsOn: today,
        taxCents: 0,
      }),
    ),
    { invoiceId } = ready(
      await using.accept(m.token, {
        planId: p.planId,
        expectedRevision: 1,
        operationId: randomUUID(),
        name: "Invented Private Name",
        email: "invented-private@example.invalid",
      }),
    );
  return { ...m, invoiceId, revision: 1 };
}
type Invoice = Awaited<ReturnType<typeof issued>>;
async function pay(i: Invoice, cents: number, on = today) {
  ready(
    await invoices.pay(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: i.revision++,
      operationId: randomUUID(),
      amountCents: cents,
      receivedOn: on,
      evidence: "Invented private evidence",
    }),
  );
}
async function refund(i: Invoice, cents: number, on = today) {
  ready(
    await invoices.refund(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: i.revision++,
      operationId: randomUUID(),
      amountCents: cents,
      refundedOn: on,
      evidence: "Invented private refund evidence",
    }),
  );
}
// A raw event, as a repair or a faulty writer could leave one: no running total
// moves and staff change history records nothing.
const strayEvent = (invoiceId: string, cents: number, kind = "receipt") =>
  pool.query(
    "INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,evidence_reference) VALUES($1,$2,$3,$4,$5,'Invented stray')",
    [randomUUID(), invoiceId, cents, today, kind],
  );
const get = (url: string, token?: string) =>
  withLoopback(application, (s) => {
    const r = request(s).get(url).set("Host", "127.0.0.1:3000");
    return token ? r.set("Cookie", `${COOKIE}=${token}`) : r;
  });
const sample = async () => value(await report.snapshot(admin)).groups[1];
const flagsOf = async (id: string) =>
  value(await report.snapshot(admin)).flagged.find((row) => row.id === id);

beforeAll(async () => {
  await migrate(pool);
  await seedDraftPack(pool);
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
  ({ today, lastMonth } = (
    await pool.query<{ today: string; lastMonth: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today,
              to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day','YYYY-MM-DD') AS "lastMonth"`,
    )
  ).rows[0]!);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE simple_invoice_payments,simple_invoices,simple_invoice_plans,simple_invoice_operations,billing_change_events CASCADE",
  );
});
afterAll(async () => {
  await pool.end();
});

it("RECON-01 no invoices, and all-void invoices, show no percentage", async () => {
  const empty = value(await report.snapshot(admin));
  for (const row of empty.groups) {
    expect(row).toMatchObject({
      status: "empty",
      invoicedCents: 0,
      netCollectedCents: 0,
      collectedShare: null,
    });
  }
  const page = await get(path, admin);
  expect(page.status).toBe(200);
  expect(page.text).toContain("No invoices to compare.");
  expect(page.text).toContain("Not applicable: nothing invoiced");
  const i = await issued();
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented void reason",
    }),
  );
  expect(await sample()).toMatchObject({
    status: "consistent",
    current: 0,
    voided: 1,
    voidedCents: 3000,
    invoicedCents: 0,
    collectedShare: null,
  });
});

it("RECON-02 invoiced amounts stay apart from collected cash", async () => {
  const part = await issued();
  await pay(part, 1000);
  const full = await issued();
  await pay(full, 3000);
  await refund(full, 500);
  await issued();
  expect(await sample()).toMatchObject({
    status: "consistent",
    current: 3,
    invoicedCents: 9000,
    receipts: 2,
    receiptCents: 4000,
    refunds: 1,
    refundCents: 500,
    netCollectedCents: 3500,
    unpaidCents: 5000,
    collectedShare: 38,
    mismatchedInvoices: 0,
  });
});

it("RECON-03 sample invoices never join the other group, and nothing reads as live", async () => {
  const s = await issued();
  await pay(s, 3000);
  await issued(configured, 7000);
  const { groups } = value(await report.snapshot(admin));
  expect(groups[0]).toMatchObject({
    group: "configured",
    invoices: 1,
    invoicedCents: 7000,
    receiptCents: 0,
  });
  expect(groups[1]).toMatchObject({
    group: "sample",
    invoices: 1,
    invoicedCents: 3000,
    receiptCents: 3000,
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Sample invoices · Test data");
  expect(page.text).toContain("NOT A LIVE FIGURE");
  expect(page.text).not.toMatch(/\blive (revenue|cash|total)/i);
});

it("RECON-05 mismatches are flagged with their size and opposite gaps do not cancel", async () => {
  const over = await issued();
  await pay(over, 1000);
  await strayEvent(over.invoiceId, 200);
  const under = await issued();
  await pay(under, 1000);
  await pool.query(
    "UPDATE simple_invoices SET paid_cents=paid_cents+200 WHERE id=$1",
    [under.invoiceId],
  );
  const refunds = await issued();
  await pay(refunds, 1000);
  await strayEvent(refunds.invoiceId, 100, "refund");
  expect(await sample()).toMatchObject({
    status: "discrepancies",
    mismatchedInvoices: 3,
    mismatchCents: 500,
  });
  expect(await flagsOf(over.invoiceId)).toMatchObject({
    gapCents: 200,
    flags: ["receipts_differ"],
  });
  expect(await flagsOf(under.invoiceId)).toMatchObject({
    gapCents: 200,
    flags: ["receipts_differ"],
  });
  expect((await flagsOf(refunds.invoiceId))?.flags).toContain("refunds_differ");
  const page = await get(path, admin);
  expect(page.text).toContain("Paid total differs from its receipts");
  expect(page.text).toContain(`/operator/invoices/${over.invoiceId}`);
});

it("RECON-05 a stored total that differs from its document is flagged", async () => {
  const i = await issued();
  const id = randomUUID();
  await pool.query(
    "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents) SELECT $1,owner_id,0,document,sample,total_cents+1 FROM simple_invoices WHERE id=$2",
    [id, i.invoiceId],
  );
  expect(await flagsOf(id)).toMatchObject({
    gapCents: 1,
    flags: ["document_differs"],
  });
  expect(await flagsOf(i.invoiceId)).toBeUndefined();
});

it("RECON-06 refunds and voids read as reversals, and money on a void invoice is a mismatch", async () => {
  const part = await issued();
  await pay(part, 3000);
  await refund(part, 1000);
  const full = await issued();
  await pay(full, 3000);
  await refund(full, 3000);
  const voided = await issued();
  ready(
    await invoices.voidInvoice(admin, {
      invoiceId: voided.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: "Invented void reason",
    }),
  );
  expect(await sample()).toMatchObject({
    partlyRefunded: 1,
    fullyRefunded: 1,
    voided: 1,
    invoicedCents: 6000,
    netCollectedCents: 2000,
    unpaidCents: 0,
    status: "consistent",
  });
  expect((await flagsOf(part.invoiceId))?.flags).toEqual(["partly_refunded"]);
  expect((await flagsOf(full.invoiceId))?.flags).toEqual(["fully_refunded"]);
  expect((await flagsOf(voided.invoiceId))?.flags).toEqual(["voided"]);
  await strayEvent(voided.invoiceId, 400);
  expect((await flagsOf(voided.invoiceId))?.flags).toEqual([
    "receipts_differ",
    "void_with_cash",
    "voided",
  ]);
  expect(await sample()).toMatchObject({ status: "discrepancies" });
});

it("RECON-07 late and out-of-order events are flagged and still counted", async () => {
  const late = await issued();
  await pay(late, 1000, lastMonth);
  const s = await sample();
  expect(s).toMatchObject({
    lateEvents: 1,
    lateCents: 1000,
    receiptCents: 1000,
    datedBeforeIssue: 1,
    status: "consistent",
  });
  expect((await flagsOf(late.invoiceId))?.flags).toEqual([
    "receipt_before_issue",
    "late_recorded",
  ]);
  const early = await issued();
  await pool.query(
    "INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,kind,evidence_reference) VALUES($1,$2,1,$3,'refund','Invented stray')",
    [randomUUID(), early.invoiceId, lastMonth],
  );
  expect((await flagsOf(early.invoiceId))?.flags).toContain(
    "refund_before_receipt",
  );
});

it("RECON-08 staff change history is compared per member without naming them", async () => {
  const agrees = await issued();
  await pay(agrees, 1000);
  await refund(agrees, 400);
  expect(value(await report.snapshot(admin)).manual).toEqual({
    comparedMembers: 1,
    mismatchedMembers: 0,
    mismatchCents: 0,
    notComparableInvoices: 0,
  });
  const stray = await issued();
  await pay(stray, 500);
  await strayEvent(stray.invoiceId, 200);
  const extra = await issued();
  await pool.query(
    "INSERT INTO billing_change_events(actor_id,action,member_id,amount_cents) VALUES($1,'payment_refunded',$2,50)",
    [randomUUID(), extra.id],
  );
  const orphan = await issued();
  await pool.query(
    "INSERT INTO simple_invoices(id,cycle,document,sample,total_cents) SELECT $1,0,document,sample,total_cents FROM simple_invoices WHERE id=$2",
    [randomUUID(), orphan.invoiceId],
  );
  const snapshot = value(await report.snapshot(admin));
  expect(snapshot.manual).toEqual({
    comparedMembers: 3,
    mismatchedMembers: 2,
    mismatchCents: 250,
    notComparableInvoices: 1,
  });
  expect(snapshot.groups[1].unlinked).toBe(1);
  const page = await get(path, admin);
  expect(page.text).not.toContain(stray.id);
});

it("RECON-09 simulated events reconcile but are not collected cash", async () => {
  const i = await issued();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on,verification,evidence_reference,
         provider_event_id,provider_payment_ref,provider_event_type,provider_event_digest,provider_occurred_at)
       VALUES($1,$2,700,$3,'signed_test_event','Invented event','evt-recon-09','pay-recon-09','payment.succeeded',$4,now())`,
      [randomUUID(), i.invoiceId, today, "a".repeat(64)],
    );
    await client.query(
      "UPDATE simple_invoices SET paid_cents=700 WHERE id=$1",
      [i.invoiceId],
    );
    const row = (await readInvoiceReconciliation(client)).groups[1];
    expect(row).toMatchObject({
      receiptCents: 0,
      netCollectedCents: 0,
      simulatedReceiptCents: 700,
      unpaidCents: 2300,
      status: "consistent",
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("RECON-10 only a platform administrator can read it", async () => {
  const i = await issued();
  await pay(i, 1000);
  for (const token of [
    await staff("operator"),
    await staff("reviewer"),
    i.token,
    "b".repeat(64),
  ]) {
    expect(await report.snapshot(token)).toEqual({ kind: "denied" });
    const page = await get(path, token);
    expect(page.status).toBe(403);
    expect(page.text).not.toContain("CAD");
  }
  const signedOut = await get(path);
  expect(signedOut.status).toBe(403);
  expect(signedOut.text).not.toContain("CAD");
  expect((await get(`${path}?group=sample`, admin)).status).toBe(400);
  expect(await report.snapshot("not-a-token")).toEqual({ kind: "denied" });
});

it("RECON-11 reading changes nothing and shows no private text", async () => {
  const i = await issued();
  await pay(i, 1000);
  const counts = () =>
    pool.query(
      `SELECT (SELECT count(*) FROM simple_invoice_payments) AS payments,
              (SELECT count(*) FROM billing_change_events) AS history,
              (SELECT string_agg(revision::text||paid_cents::text,',') FROM simple_invoices) AS invoices`,
    );
  const before = (await counts()).rows;
  const page = await get(path, admin);
  expect((await counts()).rows).toEqual(before);
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.text).not.toContain("Invented Private Name");
  expect(page.text).not.toContain("invented-private@example.invalid");
  expect(page.text).not.toContain("Invented private evidence");
});

const signed = async (
  invoiceId: string,
  type: TestProviderEvent["type"],
  amountCents: number,
  paymentRef = "pay-recon",
) =>
  ready(
    await testEvents.apply({
      id: `evt-${randomUUID()}`,
      type,
      invoiceId,
      paymentRef,
      amountCents,
      occurredAt: "2026-11-01T12:00:00.000Z",
    }),
  ).outcome;

it("RECON-15 no signed test events gives an empty section", async () => {
  expect(value(await report.snapshot(admin)).testEvents).toEqual({
    status: "empty",
    receipts: 0,
    receiptCents: 0,
    refunds: 0,
    refundCents: 0,
    failures: 0,
    failureCents: 0,
    waiting: 0,
    waitingCents: 0,
    appliedAfterHold: 0,
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Signed test events · Test data");
  expect(page.text).toContain("No signed test events to compare.");
});

it("RECON-13 each kind of signed test event is shown apart and none is collected cash", async () => {
  const i = await issued();
  expect(await signed(i.invoiceId, "payment.succeeded", 3000)).toBe("receipt");
  expect(await signed(i.invoiceId, "refund.succeeded", 500)).toBe("refund");
  expect(await signed(i.invoiceId, "payment.failed", 3000, "pay-other")).toBe(
    "failure",
  );
  const snapshot = value(await report.snapshot(admin));
  expect(snapshot.testEvents).toMatchObject({
    status: "applied",
    receipts: 1,
    receiptCents: 3000,
    refunds: 1,
    refundCents: 500,
    failures: 1,
    failureCents: 3000,
    waiting: 0,
  });
  expect(snapshot.groups[1]).toMatchObject({
    receiptCents: 0,
    netCollectedCents: 0,
    simulatedReceiptCents: 3000,
    status: "consistent",
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Failed test payments, no money moved");
});

it("RECON-14 a held event later applied counts once; one never applied is still waiting", async () => {
  const early = await issued();
  expect(await signed(early.invoiceId, "refund.succeeded", 1000)).toBe("held");
  expect(value(await report.snapshot(admin)).testEvents).toMatchObject({
    status: "waiting",
    waiting: 1,
    waitingCents: 1000,
  });
  expect(await signed(early.invoiceId, "payment.succeeded", 3000)).toBe(
    "receipt",
  );
  const over = await issued();
  expect(await signed(over.invoiceId, "payment.succeeded", 9000)).toBe("held");
  expect(value(await report.snapshot(admin)).testEvents).toMatchObject({
    status: "waiting",
    receipts: 1,
    refunds: 1,
    refundCents: 1000,
    waiting: 1,
    waitingCents: 9000,
    appliedAfterHold: 1,
  });
  const page = await get(path, admin);
  expect(page.text).toContain("Held and not applied");
  expect(page.text).not.toContain("evt-");
});
