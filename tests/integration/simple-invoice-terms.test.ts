import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { coachingTermsStore } from "../../src/coaching-terms.ts";
import { billingProfileStore } from "../../src/billing-profile.ts";
import { DEEP_NATIVE_INVOICE_ISSUER } from "../../src/invoice-issuer.ts";
import { addDays } from "../../src/coaching-values.ts";
import { shiftMonth } from "../../src/simple-invoice-store.ts";
import { testPool } from "../support/database.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #856: new invoices carry payment terms, a due date, a Toronto issue date and
// a short gapless number. Every person, rate and amount here is invented.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  terms = coachingTermsStore(pool),
  profiles = billingProfileStore(pool),
  samples = simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  configured = simpleInvoiceStore(pool, {
    sample: false,
    ...DEEP_NATIVE_INVOICE_ISSUER,
  });
type Service = typeof samples;
let admin: string, month: string, toronto: string;
const ready = <T>(result: InvoiceResult<T>): T => {
  if (result.kind !== "ready")
    throw Error(`Expected ready, got ${result.kind}`);
  return result.value;
};
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const s = await members.session(token, "account");
  if (s.kind !== "active") throw Error();
  return { token, id: s.learner.id };
}
/** A student whose hours for `month` await review in `service`'s mode. */
async function submitted(service: Service = samples, minutes = 90) {
  const m = await member(),
    sample = service === samples;
  const rate = ready(
    await service.setCoachingRate(admin, {
      ownerId: m.id,
      effectiveMonth: month,
      cents: 12000,
      expectedVersion: 0,
      operationId: randomUUID(),
    }),
  );
  const draft = ready(
    await service.saveCoaching(m.token, {
      month,
      minutes,
      expectedRevision: 0,
      operationId: randomUUID(),
      name: "Invented student",
      email: "student@example.invalid",
    }),
  );
  const s = ready(
    await service.submitCoaching(m.token, {
      month,
      rateId: rate.rateId,
      sample,
      expectedRevision: draft.revision,
      operationId: randomUUID(),
    }),
  );
  return { ...m, revision: s.revision };
}
const issueInput = (
  m: { id: string; revision: number },
  extra: Record<string, unknown> = {},
  sample = true,
) =>
  ({
    ownerId: m.id,
    month,
    expectedRevision: m.revision,
    operationId: randomUUID(),
    ...(sample ? { taxCents: 0 } : {}),
    ...extra,
  }) as Parameters<Service["issueCoaching"]>[1];
const counter = async (series: "real" | "sample") =>
  (
    await pool.query<{ next: number }>(
      "SELECT next FROM simple_invoice_numbers WHERE series=$1",
      [series],
    )
  ).rows[0]!.next;
const documentOf = async (id: string) =>
  (
    await pool.query<{
      document: {
        number: string;
        issuedOn: string;
        terms?: string;
        dueOn?: string;
      };
    }>("SELECT document FROM simple_invoices WHERE id=$1", [id])
  ).rows[0]!.document;
const numbered = (prefix: string, n: number) =>
  `${prefix}-${String(n).padStart(4, "0")}`;
beforeAll(async () => {
  await migrate(pool);
  admin = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const clock = (
    await pool.query<{ month: string; toronto: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month,to_char(toronto_today(),'YYYY-MM-DD') AS toronto",
    )
  ).rows[0]!;
  // Last calendar month has ended in both UTC and Toronto.
  month = shiftMonth(clock.month, -1);
  toronto = clock.toronto;
});
afterAll(() => pool.end());

it("TERMS856-01 new coaching invoice is INV-0001 then INV-0002, dated Toronto today, Net 15 dueOn = +15d", async () => {
  // A fresh database starts the real series at one; other files in this lane
  // may already have used numbers, so the run reads where the counter stands.
  const start = await counter("real");
  const a = await submitted(configured),
    b = await submitted(configured);
  const first = ready(
    await configured.issueCoaching(admin, issueInput(a, {}, false)),
  );
  const second = ready(
    await configured.issueCoaching(admin, issueInput(b, {}, false)),
  );
  expect(await documentOf(first.invoiceId)).toMatchObject({
    number: numbered("INV", start),
    issuedOn: toronto,
    terms: "net_15",
    dueOn: addDays(toronto, 15),
  });
  expect((await documentOf(second.invoiceId)).number).toBe(
    numbered("INV", start + 1),
  );
  expect(await counter("real")).toBe(start + 2);
});

it("TERMS856-02 sample invoices use SAMPLE-0001 and leave the real series alone", async () => {
  const real = await counter("real"),
    start = await counter("sample");
  const m = await submitted();
  const issued = ready(await samples.issueCoaching(admin, issueInput(m)));
  expect((await documentOf(issued.invoiceId)).number).toBe(
    numbered("SAMPLE", start),
  );
  expect(await counter("sample")).toBe(start + 1);
  expect(await counter("real")).toBe(real);
});

it("TERMS856-03 due_on_receipt dueOn = issuedOn; net_30 = +30, on coaching and coaching-terms invoices", async () => {
  const a = await submitted(),
    b = await submitted();
  const now = ready(
    await samples.issueCoaching(
      admin,
      issueInput(a, { terms: "due_on_receipt" }),
    ),
  );
  expect(await documentOf(now.invoiceId)).toMatchObject({
    issuedOn: toronto,
    terms: "due_on_receipt",
    dueOn: toronto,
  });
  const later = ready(
    await samples.issueCoaching(admin, issueInput(b, { terms: "net_30" })),
  );
  expect(await documentOf(later.invoiceId)).toMatchObject({
    terms: "net_30",
    dueOn: addDays(toronto, 30),
  });
  // The coaching-terms invoice takes the same choice and the real series.
  const c = await member();
  ready(
    await profiles.save(c.token, {
      name: "Invented Student",
      email: "invented.student@example.test",
      company: "",
      revision: 0,
    }),
  );
  expect(
    (
      await terms.save(admin, {
        ownerId: c.id,
        priceCents: 120000,
        startsOn: "2026-12-01",
        endsOn: "2027-05-31",
        renewsOn: "2027-06-01",
        reviewMinutes: 120,
        coachingSessions: 6,
        aiRequests: 200,
        expectedVersion: 0,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("ready");
  const start = await counter("real");
  const packaged = ready(
    await configured.issueCoachingTerms(admin, {
      ownerId: c.id,
      version: 1,
      terms: "net_30",
      operationId: randomUUID(),
    }),
  );
  expect(await documentOf(packaged.invoiceId)).toMatchObject({
    number: numbered("INV", start),
    issuedOn: toronto,
    terms: "net_30",
    dueOn: addDays(toronto, 30),
  });
});

it("TERMS856-04 unknown terms → invalid, with no number used", async () => {
  const m = await submitted(),
    start = await counter("sample");
  for (const value of ["net_60", "", 15, null, "constructor"])
    expect(
      (await samples.issueCoaching(admin, issueInput(m, { terms: value })))
        .kind,
    ).toBe("invalid");
  expect(
    (
      await configured.issueCoachingTerms(admin, {
        ownerId: m.id,
        version: 1,
        terms: "net_45" as never,
        operationId: randomUUID(),
      })
    ).kind,
  ).toBe("invalid");
  expect(await counter("sample")).toBe(start);
});

it("TERMS856-05 retried operationId returns the same number; counter unchanged", async () => {
  const m = await submitted(),
    input = issueInput(m);
  const first = ready(await samples.issueCoaching(admin, input));
  const after = await counter("sample");
  const again = ready(await samples.issueCoaching(admin, input));
  expect(again).toEqual(first);
  expect(await counter("sample")).toBe(after);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM simple_invoices WHERE owner_id=$1",
        [m.id],
      )
    ).rows[0]!.n,
  ).toBe(1);
});

it("TERMS856-06 failed issue leaves the counter unchanged", async () => {
  const start = await counter("sample");
  const m = await submitted();
  // Over the amount limit once the tax is added.
  expect(
    (await samples.issueCoaching(admin, issueInput(m, { taxCents: 999999999 })))
      .kind,
  ).toBe("invalid");
  // A stale form, and a store whose issuer can't be printed.
  expect(
    (
      await samples.issueCoaching(
        admin,
        issueInput({ ...m, revision: m.revision + 5 }),
      )
    ).kind,
  ).toBe("conflict");
  const broken = simpleInvoiceStore(pool, {
    sample: true,
    issuer: "",
    instructions: "Sample only; do not pay.",
  });
  expect((await broken.issueCoaching(admin, issueInput(m))).kind).toBe(
    "invalid",
  );
  // A failure inside the database after the number is taken rolls it back.
  await pool.query(
    "CREATE OR REPLACE FUNCTION terms856_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$",
  );
  await pool.query(
    `CREATE TRIGGER terms856_refuse BEFORE INSERT ON simple_invoices FOR EACH ROW WHEN (NEW.owner_id='${m.id}') EXECUTE FUNCTION terms856_refuse()`,
  );
  try {
    expect((await samples.issueCoaching(admin, issueInput(m))).kind).toBe(
      "unavailable",
    );
  } finally {
    await pool.query("DROP TRIGGER terms856_refuse ON simple_invoices");
    await pool.query("DROP FUNCTION terms856_refuse()");
  }
  expect(await counter("sample")).toBe(start);
  // The same submission then takes the next number, with no gap.
  const issued = ready(await samples.issueCoaching(admin, issueInput(m)));
  expect((await documentOf(issued.invoiceId)).number).toBe(
    numbered("SAMPLE", start),
  );
});

it("TERMS856-07 concurrent issues get distinct consecutive numbers", async () => {
  const a = await submitted(configured),
    b = await submitted(configured),
    start = await counter("real");
  const [x, y] = await Promise.all([
    configured.issueCoaching(admin, issueInput(a, {}, false)),
    configured.issueCoaching(admin, issueInput(b, {}, false)),
  ]);
  const numbers = [
    (await documentOf(ready(x).invoiceId)).number,
    (await documentOf(ready(y).invoiceId)).number,
  ].sort();
  expect(numbers).toEqual([numbered("INV", start), numbered("INV", start + 1)]);
  expect(await counter("real")).toBe(start + 2);
});
