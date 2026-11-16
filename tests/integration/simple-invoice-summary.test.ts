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
let admin: string, month: string, today: string;
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
    /** #856: a real invoice, and its due date. */
    sample?: boolean;
    dueOn?: string;
  },
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,paid_cents,delivery,void_reason,voided_at)
     VALUES($1,$2,0,$3,$8,$4,$5,$6,$7::text,CASE WHEN $7::text IS NULL THEN NULL ELSE clock_timestamp() END)`,
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
        sample: values.sample ?? true,
        ...(values.dueOn ? { terms: "net_15", dueOn: values.dueOn } : {}),
      }),
      values.totalCents,
      values.paidCents ?? 0,
      values.delivery ?? "not_sent",
      values.voidReason ?? null,
      values.sample ?? true,
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
  today = (
    await pool.query<{ today: string }>(
      "SELECT to_char(toronto_today(),'YYYY-MM-DD') AS today",
    )
  ).rows[0]!.today;
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
    overdue: 0,
    notYetDueCents: 0,
    overdue1to30Cents: 0,
    overdueOver30Cents: 0,
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
    overdue: 0,
    notYetDueCents: 0,
    overdue1to30Cents: 0,
    overdueOver30Cents: 0,
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
    overdue: [],
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

/** #856: whole days before Toronto today. */
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
async function aging() {
  const m = await member();
  const real = (dueOn: string | undefined, extra = {}) =>
    issued(m.id, {
      totalCents: 10000,
      delivery: "sent",
      sample: false,
      ...(dueOn ? { dueOn } : {}),
      ...extra,
    });
  return {
    ...m,
    // Due today: not overdue yet.
    dueToday: await real(today),
    ten: await real(daysAgo(10), { paidCents: 2500 }),
    thirty: await real(daysAgo(30), { totalCents: 1000 }),
    forty: await real(daysAgo(40), { totalCents: 4000 }),
    // Past due but never sent, or sent but uncertain: never overdue.
    unsent: await real(daysAgo(20), { delivery: "not_sent" }),
    uncertain: await real(daysAgo(20), { delivery: "unconfirmed" }),
    // Issued before #856, with no due date.
    old: await real(undefined),
    // A sample and a void invoice are never overdue nor aged.
    sample: await issued(m.id, {
      totalCents: 500,
      delivery: "sent",
      dueOn: daysAgo(40),
    }),
    voided: await real(daysAgo(40), { voidReason: "Invented duplicate" }),
    paid: await real(daysAgo(40), { paidCents: 10000 }),
  };
}
it("TERMS856-20 splits outstanding money by age: not yet due, 1–30 and over 30 days overdue", async () => {
  const m = await aging();
  const value = ready(await invoices.adminOverview(admin, m.id));
  expect(value.summary).toMatchObject({
    // Every unpaid invoice, the sample included, as before.
    outstandingCents: 10000 + 7500 + 1000 + 4000 + 10000 * 3 + 500,
    overdue: 3,
    // Due today, unsent, unconfirmed and the old one with no due date.
    notYetDueCents: 10000 * 4,
    overdue1to30Cents: 7500 + 1000,
    overdueOver30Cents: 4000,
  });
  const row = (id: string) => value.invoices.find((i) => i.id === id)!;
  expect(row(m.ten)).toMatchObject({ dueOn: daysAgo(10), overdueDays: 10 });
  expect(row(m.thirty).overdueDays).toBe(30);
  expect(row(m.forty).overdueDays).toBe(40);
  expect(row(m.dueToday)).toMatchObject({ dueOn: today, overdueDays: null });
  expect(row(m.old)).toMatchObject({ dueOn: null, overdueDays: null });
  for (const id of [m.sample, m.voided, m.paid])
    expect(row(id).overdueDays).toBeNull();
});
it("TERMS856-21 the Overdue view lists only overdue invoices, and Unpaid still includes them", async () => {
  const m = await aging();
  const overdue = ready(await invoices.adminOverview(admin, m.id, "overdue"));
  expect(overdue.invoices.map((i) => i.id).sort()).toEqual(
    [m.ten, m.thirty, m.forty].sort(),
  );
  const unpaid = ready(await invoices.adminOverview(admin, m.id, "unpaid"));
  for (const id of [m.ten, m.thirty, m.forty, m.old, m.unsent])
    expect(unpaid.invoices.map((i) => i.id)).toContain(id);
  expect(INVOICE_VIEWS.indexOf("overdue")).toBe(
    INVOICE_VIEWS.indexOf("unpaid") + 1,
  );
});
it("TERMS856-22 an unsent invoice is never overdue, and stays in Not sent", async () => {
  const m = await aging();
  const notSent = ready(await invoices.adminOverview(admin, m.id, "not-sent"));
  expect(notSent.invoices.map((i) => i.id).sort()).toEqual(
    [m.unsent, m.uncertain].sort(),
  );
  for (const i of notSent.invoices) expect(i.overdueDays).toBeNull();
  // The single-invoice page reads the same rule.
  expect(ready(await invoices.invoice(admin, m.unsent, true)).overdueDays).toBe(
    null,
  );
  expect(ready(await invoices.invoice(admin, m.ten, true)).overdueDays).toBe(
    10,
  );
  expect(ready(await invoices.invoice(admin, m.old, true)).overdueDays).toBe(
    null,
  );
});
