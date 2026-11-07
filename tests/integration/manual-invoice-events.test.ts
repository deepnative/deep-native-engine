import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.ts";
import { catalogStore, seedDraftPack } from "../../src/catalog.ts";
import { foundationImportStore } from "../../src/foundation-import.ts";
import { reviewedFoundation } from "../../src/foundation-pack.ts";
import { memberExportStore } from "../../src/member-export.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
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
  origin = "http://127.0.0.1:3000",
  secret = "native-manual-event-test",
  application = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
  });
const ready = <T>(r: InvoiceResult<T>): T => {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Expected invoice result");
  return r.value;
};
let admin: string, today: string, earlier: string, tomorrow: string;
const staff = async (role: "platform_admin" | "reviewer" | "editor") => {
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
async function issued() {
  const m = await member(),
    p = ready(
      await invoices.propose(admin, {
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
      await invoices.accept(m.token, {
        planId: p.planId,
        expectedRevision: 1,
        operationId: randomUUID(),
        name: "Invented student",
        email: "invented-student@example.invalid",
      }),
    );
  return { ...m, planId: p.planId, invoiceId };
}
async function paid(cents = 3000) {
  const i = await issued();
  ready(
    await invoices.pay(admin, {
      invoiceId: i.invoiceId,
      expectedRevision: 1,
      operationId: randomUUID(),
      amountCents: cents,
      receivedOn: today,
      evidence: "Invented bank reference",
    }),
  );
  return i;
}
const refund = (
  i: { invoiceId: string },
  change: Record<string, unknown> = {},
  token = admin,
) =>
  invoices.refund(token, {
    invoiceId: i.invoiceId,
    expectedRevision: 2,
    operationId: randomUUID(),
    amountCents: 1000,
    refundedOn: today,
    evidence: "Invented refund reference",
    ...change,
  });
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (path: string, token: string, fields: Record<string, string>) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
const events = async (invoiceId: string) =>
  (
    await pool.query<{ kind: string; actor_id: string | null }>(
      "SELECT kind,actor_id,verification,evidence_reference,amount_cents::int AS amount FROM simple_invoice_payments WHERE invoice_id=$1 ORDER BY recorded_at",
      [invoiceId],
    )
  ).rows;

beforeAll(async () => {
  await migrate(pool);
  // The foundation import must start fresh whichever lane file ran before.
  await pool.query("TRUNCATE principals,cohorts,content_versions CASCADE");
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
  ({ today, earlier, tomorrow } = (
    await pool.query<{ today: string; earlier: string; tomorrow: string }>(
      `SELECT to_char(n,'YYYY-MM-DD') AS today,to_char(n-interval '1 day','YYYY-MM-DD') AS earlier,
              to_char(n+interval '2 day','YYYY-MM-DD') AS tomorrow
       FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS n) x`,
    )
  ).rows[0]!);
});
afterAll(() => pool.end());

it("MANPAY-01/03 keeps the actor, evidence and unverified status and shows the member the record without the actor", async () => {
  const i = await issued();
  const recorded = await post(
    `/operator/invoices/${i.invoiceId}/payment`,
    admin,
    {
      revision: "1",
      operationId: randomUUID(),
      amount: "10.00",
      receivedOn: today,
      evidence: "  Interac invented-1  ",
      confirm: "received",
    },
  );
  expect(recorded.status).toBe(303);
  const stored = await events(i.invoiceId);
  expect(stored).toEqual([
    expect.objectContaining({
      kind: "receipt",
      verification: "manual_unverified",
      evidence_reference: "Interac invented-1",
      amount: 1000,
    }),
  ]);
  expect(stored[0]!.actor_id).toEqual(expect.any(String));
  const staffPage = await get(`/operator/invoices/${i.invoiceId}`, admin);
  expect(staffPage.text).toContain("Interac invented-1");
  expect(staffPage.text).toContain(
    `Staff account ${stored[0]!.actor_id!.slice(0, 8)}`,
  );
  expect(staffPage.text).toContain("Not verified by a payment provider");
  const own = await get(`/account/purchases/invoices/${i.invoiceId}`, i.token);
  expect(own.status).toBe(200);
  expect(own.text).toContain("Interac invented-1");
  expect(own.text).toContain("Not verified by a payment provider");
  expect(own.text).not.toContain("Recorded by");
  expect(own.text).not.toContain("Staff account");
  expect(own.text).not.toContain(stored[0]!.actor_id!);
  const detail = ready(await invoices.invoice(i.token, i.invoiceId));
  expect(detail.payments).toEqual([
    {
      kind: "receipt",
      amountCents: 1000,
      on: today,
      evidence: "Interac invented-1",
      verification: "manual_unverified",
    },
  ]);
});

it("MANPAY-02 records nothing when evidence is missing, oversized or looks like a card number", async () => {
  const i = await issued();
  for (const evidence of [
    "",
    "   ",
    "x".repeat(201),
    "4242 4242 4242 4242",
    "line\nbreak",
  ]) {
    const r = await post(`/operator/invoices/${i.invoiceId}/payment`, admin, {
      revision: "1",
      operationId: randomUUID(),
      amount: "10.00",
      receivedOn: today,
      evidence,
      confirm: "received",
    });
    expect(r.status).toBe(422);
  }
  expect(
    (
      await post(`/operator/invoices/${i.invoiceId}/payment`, admin, {
        revision: "1",
        operationId: randomUUID(),
        amount: "10.00",
        receivedOn: today,
        confirm: "received",
      })
    ).status,
  ).toBe(422);
  expect(await events(i.invoiceId)).toEqual([]);
  const p = await paid();
  expect((await refund(p, { evidence: "4242424242424242" })).kind).toBe(
    "invalid",
  );
  expect(await events(p.invoiceId)).toHaveLength(1);
});

it("MANPAY-04 keeps a refund separate: payment stays, status changes, balance and agreement do not", async () => {
  const i = await paid();
  const form = await get(`/operator/invoices/${i.invoiceId}`, admin);
  expect(form.text).toContain("Record an offline refund");
  const partly = await post(`/operator/invoices/${i.invoiceId}/refund`, admin, {
    revision: "2",
    operationId: randomUUID(),
    amount: "10.00",
    refundedOn: today,
    evidence: "Invented refund reference",
    confirm: "refunded",
  });
  expect(partly.status).toBe(303);
  let current = ready(await invoices.invoice(i.token, i.invoiceId));
  expect(current).toMatchObject({
    paidCents: 3000,
    refundedCents: 1000,
    revision: 3,
    voidReason: null,
  });
  let list = await get("/account/purchases", i.token);
  expect(list.text).toContain("Partly refunded");
  ready(await refund(i, { expectedRevision: 3, amountCents: 2000 }));
  current = ready(await invoices.invoice(i.token, i.invoiceId));
  expect(current).toMatchObject({ paidCents: 3000, refundedCents: 3000 });
  list = await get("/account/purchases", i.token);
  expect(list.text).toContain("Refunded");
  expect(list.text).not.toContain("Partly refunded");
  const page = await get(`/account/purchases/invoices/${i.invoiceId}`, i.token);
  expect(page.text).toContain("Recorded refund");
  expect(page.text).toContain("does not reopen this balance");
  expect(page.text.match(/<dt>Balance<\/dt><dd>CAD ([0-9.]+)<\/dd>/)?.[1]).toBe(
    "0.00",
  );
  expect(
    (
      await pool.query<{ state: string }>(
        "SELECT state FROM simple_invoice_plans WHERE id=$1",
        [i.planId],
      )
    ).rows[0]!.state,
  ).toBe("active");
  expect((await events(i.invoiceId)).map((e) => e.kind)).toEqual([
    "receipt",
    "refund",
    "refund",
  ]);
  const staffPage = await get(`/operator/invoices/${i.invoiceId}`, admin);
  expect(staffPage.text).not.toContain("Record an offline refund");
});

it("MANPAY-05 refuses over-refunds, bad dates and stale revisions and applies one operation exactly once", async () => {
  const i = await paid(1000);
  for (const change of [
    { amountCents: 1001 },
    { refundedOn: tomorrow },
    { refundedOn: earlier },
    { expectedRevision: 1 },
  ])
    expect((await refund(i, change)).kind).toBe("conflict");
  const unpaid = await issued();
  expect((await refund(unpaid, { expectedRevision: 1 })).kind).toBe("conflict");
  expect((await refund({ invoiceId: randomUUID() })).kind).toBe("not-found");
  expect((await refund(i, { amountCents: 100.5 })).kind).toBe("invalid");
  const operationId = randomUUID(),
    input = {
      invoiceId: i.invoiceId,
      expectedRevision: 2,
      operationId,
      amountCents: 400,
      refundedOn: today,
      evidence: "Invented refund reference",
    };
  const raced = await Promise.all([
    invoices.refund(admin, input),
    invoices.refund(admin, input),
  ]);
  expect(raced.map((r) => r.kind)).toEqual(["ready", "ready"]);
  expect(ready(await invoices.refund(admin, input))).toEqual({
    invoiceId: i.invoiceId,
  });
  expect(ready(await invoices.invoice(admin, i.invoiceId, true))).toMatchObject(
    { refundedCents: 400, revision: 3 },
  );
  expect(await events(i.invoiceId)).toHaveLength(2);
  expect(
    (await invoices.refund(admin, { ...input, amountCents: 300 })).kind,
  ).toBe("conflict");
  const two = await Promise.all([
    refund(i, { expectedRevision: 3, amountCents: 600 }),
    refund(i, { expectedRevision: 3, amountCents: 600 }),
  ]);
  expect(two.map((r) => r.kind).sort()).toEqual(["conflict", "ready"]);
  expect(ready(await invoices.invoice(admin, i.invoiceId, true))).toMatchObject(
    { refundedCents: 1000 },
  );
});

it("MANPAY-06 denies refunds to members and other staff and hides the record from other members", async () => {
  const i = await paid(),
    other = await member();
  expect((await refund(i, {}, i.token)).kind).toBe("denied");
  expect((await refund(i, {}, await staff("reviewer"))).kind).toBe("denied");
  expect(
    (
      await post(`/operator/invoices/${i.invoiceId}/refund`, i.token, {
        revision: "2",
        operationId: randomUUID(),
        amount: "10.00",
        refundedOn: today,
        evidence: "Invented refund reference",
        confirm: "refunded",
      })
    ).status,
  ).toBe(403);
  expect((await invoices.invoice(other.token, i.invoiceId)).kind).toBe(
    "not-found",
  );
  expect(await events(i.invoiceId)).toHaveLength(1);
});

it("MANPAY-07 database refuses rewriting events, claiming provider proof, missing evidence and lowering totals", async () => {
  const i = await paid();
  ready(await refund(i));
  const insert = (fields: string, values: string) =>
    pool.query(
      `INSERT INTO simple_invoice_payments(id,invoice_id,amount_cents,received_on${fields}) VALUES('${randomUUID()}','${i.invoiceId}',1,'${today}'${values})`,
    );
  await expect(
    pool.query(
      "UPDATE simple_invoice_payments SET evidence_reference='changed' WHERE invoice_id=$1",
      [i.invoiceId],
    ),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM simple_invoice_payments WHERE invoice_id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("immutable");
  await expect(insert("", "")).rejects.toThrow("evidence reference");
  await expect(
    insert(",evidence_reference,verification", ",'proof','provider_verified'"),
  ).rejects.toThrow("simple_invoice_payments_verification");
  await expect(
    insert(",evidence_reference,kind", ",'proof','chargeback'"),
  ).rejects.toThrow("simple_invoice_payments_kind");
  await expect(
    pool.query("UPDATE simple_invoices SET paid_cents=2000 WHERE id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("cannot decrease");
  await expect(
    pool.query("UPDATE simple_invoices SET refunded_cents=0 WHERE id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("cannot decrease");
  await expect(
    pool.query("UPDATE simple_invoices SET refunded_cents=3001 WHERE id=$1", [
      i.invoiceId,
    ]),
  ).rejects.toThrow("simple_invoices_refunded_within_paid");
  await migrate(pool);
  expect(await events(i.invoiceId)).toHaveLength(2);
});

it("MANPAY-09 logs a refund in staff change history with no evidence reference", async () => {
  const i = await paid();
  ready(await refund(i, { amountCents: 1234 }));
  const logged = await pool.query(
    "SELECT to_jsonb(e) AS row FROM billing_change_events e WHERE member_id=$1 AND action='payment_refunded'",
    [i.id],
  );
  expect(logged.rows).toEqual([
    {
      row: expect.objectContaining({ member_id: i.id, amount_cents: 1234 }),
    },
  ]);
  expect(JSON.stringify(logged.rows)).not.toContain("Invented refund");
});

it("MANPAY-08 exports the member's own events and refund total without the staff actor", async () => {
  const i = await paid();
  ready(await refund(i));
  const records: Record<string, unknown[]> = {};
  let cursor: string | undefined;
  do {
    const result = await memberExportStore(pool).exportOwned(i.token, cursor);
    if (result.kind !== "ready") throw Error("Export unavailable");
    for (const [key, rows] of Object.entries(result.payload.records))
      records[key] = [...(records[key] ?? []), ...rows];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(records.invoices).toEqual([
    expect.objectContaining({ refundedCents: "1000" }),
  ]);
  expect(records.invoicePayments).toHaveLength(2);
  expect(records.invoicePayments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        invoiceId: i.invoiceId,
        kind: "refund",
        evidence: "Invented refund reference",
        verification: "manual_unverified",
      }),
    ]),
  );
  expect(JSON.stringify(records.invoicePayments)).not.toContain("actor");
});
