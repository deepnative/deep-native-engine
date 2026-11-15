import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import {
  INVOICE_VIEWS,
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// #854 Part 1: the Invoices page's totals and status views come from SQL over
// every invoice, not from the 100 rows the list shows. Invented people only.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  settings = {
    sample: true,
    issuer: "Invented summary issuer",
    instructions: "Sample only; do not pay.",
  },
  invoices = simpleInvoiceStore(pool, settings);
let admin: string, month: string;
const ready = <T>(result: InvoiceResult<T>): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
  return result.value;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error("Member fixture missing");
  return { token, id: s.learner.id };
}
/**
 * An issued snapshot written directly: the list reads only these columns and
 * document fields, and many states are needed for one student quickly.
 */
async function issued(
  ownerId: string,
  values: {
    totalCents: number;
    paidCents?: number;
    delivery?: "not_sent" | "sending" | "sent" | "unconfirmed";
    voidReason?: string;
  },
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,paid_cents,delivery,void_reason,voided_at)
     VALUES($1,$2,0,$3,true,$4,$5,$6,$7::text,CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() END)`,
    [
      id,
      ownerId,
      JSON.stringify({
        number: `DN-${id.slice(0, 8)}`,
        issuedOn: "2026-11-14",
        issuer: settings.issuer,
        billedTo: "Invented student",
        lines: [{ description: "Claim checking", amountCents: 1000 }],
        billing: { kind: "one_time" },
        currency: "CAD",
        taxCents: 0,
        paidCents: 0,
        instructions: settings.instructions,
        sample: true,
      }),
      values.totalCents,
      values.paidCents ?? 0,
      values.delivery ?? "not_sent",
      values.voidReason ?? null,
    ],
  );
  return id;
}
beforeAll(async () => {
  await migrate(pool);
  admin = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3_600_000),
  );
  month = (
    await pool.query<{ month: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month",
    )
  ).rows[0]!.month;
});
afterAll(() => pool.end());
async function threeInvoices() {
  const m = await member();
  const unpaid = await issued(m.id, { totalCents: 72000 }),
    paid = await issued(m.id, {
      totalCents: 30000,
      paidCents: 30000,
      delivery: "sent",
    }),
    voided = await issued(m.id, {
      totalCents: 5000,
      delivery: "unconfirmed",
      voidReason: "Invented duplicate",
    });
  return { ...m, unpaid, paid, voided };
}
it("SUMMARY854-01 counts outstanding money and each status across one student's invoices", async () => {
  const m = await threeInvoices();
  // One month of hours awaiting review for this student.
  const rate = ready(
    await invoices.setCoachingRate(admin, {
      ownerId: m.id,
      effectiveMonth: month,
      cents: 12000,
      expectedVersion: 0,
      operationId: randomUUID(),
    }),
  );
  const saved = ready(
    await invoices.saveCoaching(m.token, {
      month,
      minutes: 90,
      expectedRevision: 0,
      operationId: randomUUID(),
      name: "Invented student",
      email: "invented.student@example.invalid",
    }),
  );
  ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId: rate.rateId,
      sample: true,
      expectedRevision: saved.revision,
      operationId: randomUUID(),
    }),
  );
  const value = ready(await invoices.adminOverview(admin, m.id));
  expect(value.summary).toEqual({
    outstandingCents: 72000,
    all: 3,
    unpaid: 1,
    notSent: 1,
    paid: 1,
    void: 1,
    hoursToReview: 1,
  });
  expect(value.invoices.map((i) => i.id)).toEqual([m.voided, m.paid, m.unpaid]);
  expect(value.invoices.find((i) => i.id === m.unpaid)).toMatchObject({
    issuedOn: "2026-11-14",
    sample: true,
  });
  // A student with no invoices reads zeros, not an error.
  const none = await member();
  expect(ready(await invoices.adminOverview(admin, none.id)).summary).toEqual({
    outstandingCents: 0,
    all: 0,
    unpaid: 0,
    notSent: 0,
    paid: 0,
    void: 0,
    hoursToReview: 0,
  });
});
it("SUMMARY854-02 each status view returns only its own invoices with the same totals", async () => {
  const m = await threeInvoices();
  // A partly paid invoice that is sending counts as unpaid and not sent.
  const partly = await issued(m.id, {
    totalCents: 10000,
    paidCents: 2500,
    delivery: "sending",
  });
  const expected = {
    all: [partly, m.voided, m.paid, m.unpaid],
    unpaid: [partly, m.unpaid],
    "not-sent": [partly, m.unpaid],
    paid: [m.paid],
    void: [m.voided],
  };
  expect(INVOICE_VIEWS).toEqual(Object.keys(expected));
  for (const view of INVOICE_VIEWS) {
    const value = ready(await invoices.adminOverview(admin, m.id, view));
    expect(value.invoices.map((i) => i.id)).toEqual(expected[view]);
    expect(value.summary).toMatchObject({
      outstandingCents: 79500,
      all: 4,
      unpaid: 2,
      notSent: 2,
      paid: 1,
      void: 1,
    });
  }
  // Every student's invoices are counted when no student is chosen.
  const everyone = ready(await invoices.adminOverview(admin)).summary;
  expect(everyone.all).toBeGreaterThanOrEqual(7);
  expect(everyone.outstandingCents).toBeGreaterThanOrEqual(72000 + 79500);
});
it("SUMMARY854-03 counts every unpaid invoice even when the list shows only 100", async () => {
  const m = await member();
  for (let n = 0; n < 101; n += 1) await issued(m.id, { totalCents: 100 });
  const value = ready(await invoices.adminOverview(admin, m.id, "unpaid"));
  expect(value.summary.unpaid).toBe(101);
  expect(value.summary.outstandingCents).toBe(10100);
  expect(value.invoices).toHaveLength(100);
});
