import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { hash, migrate, store } from "../../src/store.ts";
import {
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { addDays, addMonths, dayLabel } from "../../src/coaching-values.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #832 slice B (owner, 12 November 2026): an administrator sets each
// student's billing period. Dates are relative to the database's UTC date so
// a period can have ended, be running or not have started. Every person,
// rate and hour is invented.
const pool = testPool(),
  members = store(pool),
  invoices = simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  secret = "coaching-period-native-test",
  origin = "http://127.0.0.1:3000",
  application = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
  }),
  auth = authorizationStore(pool);
let admin: string, today: string, month: string;
const day = (offset: number) => addDays(today, offset);
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
async function staff(role: "platform_admin" | "reviewer" = "platform_admin") {
  const token = randomBytes(32).toString("hex");
  await auth.provisionStaff(token, role, new Date(Date.now() + 3600000));
  return token;
}
const setPeriod = (
  ownerId: string,
  length: { unit: "days"; days: number } | { unit: "month" },
  expectedVersion: number,
  startsOn?: string,
) =>
  invoices.setBillingSchedule(admin, {
    ownerId,
    ...length,
    ...(startsOn ? { startsOn } : {}),
    expectedVersion,
    operationId: randomUUID(),
  });
const setRate = async (
  ownerId: string,
  cents: number,
  effectiveMonth: string,
) =>
  ready(
    await invoices.setCoachingRate(admin, {
      ownerId,
      effectiveMonth,
      cents,
      expectedVersion: (
        await pool.query("SELECT 1 FROM coaching_rates WHERE owner_id=$1", [
          ownerId,
        ])
      ).rowCount!,
      operationId: randomUUID(),
    }),
  ).rateId;
const save = (token: string, key: string, minutes: number, revision = 0) =>
  invoices.saveCoaching(token, {
    month: key,
    minutes,
    expectedRevision: revision,
    operationId: randomUUID(),
    name: "Invented student",
    email: "student@example.invalid",
  });
const submit = (token: string, key: string, rateId: string, revision = 1) =>
  invoices.submitCoaching(token, {
    month: key,
    rateId,
    sample: true,
    expectedRevision: revision,
    operationId: randomUUID(),
  });
const issue = (ownerId: string, key: string, revision = 2) =>
  invoices.issueCoaching(admin, {
    ownerId,
    month: key,
    expectedRevision: revision,
    taxCents: 0,
    operationId: randomUUID(),
  });
/** A student on two-week periods that started 20 days ago, at CAD 120.00. */
async function student() {
  const m = await member();
  ready(await setPeriod(m.id, { unit: "days", days: 14 }, 0, day(-20)));
  const rateId = await setRate(m.id, 12000, day(-400).slice(0, 7));
  return { ...m, rateId, ended: day(-20), current: day(-6) };
}
const rows = async (id: string) =>
  (
    await pool.query(
      `SELECT month,to_char(period_start,'YYYY-MM-DD') AS start,to_char(period_end,'YYYY-MM-DD') AS "end",minutes,state
       FROM coaching_months WHERE owner_id=$1 ORDER BY period_start`,
      [id],
    )
  ).rows;
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  from = origin,
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", from)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: csrf(token, secret), ...fields }),
  );
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
  today = (
    await pool.query<{ today: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today",
    )
  ).rows[0]!.today;
  month = today.slice(0, 7);
});
afterAll(() => pool.end());

it("PERIOD832-01 an administrator sets 1 week, 2 weeks, 1 month or 1 to 31 days from a first start date, and periods run back to back", async () => {
  const m = await student();
  const own = ready(await invoices.coachingOverview(m.token));
  expect(own).toMatchObject({
    month: m.current,
    date: today,
    period: { key: m.current, start: day(-6), end: day(7), days: 14 },
    billing: {
      version: 1,
      nextStart: day(8),
      schedules: [{ version: 1, unit: "days", days: 14, startsOn: day(-20) }],
    },
  });
  expect(own.periods).toEqual([
    { key: day(-6), start: day(-6), end: day(7), days: 14 },
    { key: day(-20), start: day(-20), end: day(-7), days: 14 },
  ]);
  for (const [length, end] of [
    [{ unit: "days", days: 7 }, day(-25)],
    [{ unit: "days", days: 1 }, day(-31)],
    [{ unit: "days", days: 31 }, day(-1)],
    [{ unit: "month" }, addDays(addMonths(day(-31), 1), -1)],
  ] as const) {
    const other = await member();
    ready(await setPeriod(other.id, length, 0, day(-31)));
    expect(
      ready(await invoices.coachingOverview(other.token, day(-31))).period,
    ).toMatchObject({ start: day(-31), end });
  }
  // The database refuses lengths outside the owner's choices.
  for (const [unit, days] of [
    ["days", 0],
    ["days", 32],
    ["days", null],
    ["month", 14],
    ["week", 1],
  ])
    await expect(
      pool.query(
        "INSERT INTO coaching_billing_schedules(id,owner_id,version,unit,days,starts_on,actor_id) VALUES($1,$2,9,$3,$4,$5,$6)",
        [randomUUID(), m.id, unit, days, today, randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
});

it("PERIOD832-02 the student reports hours for periods that have started, within the period's length", async () => {
  const m = await student();
  ready(await save(m.token, m.ended, 600));
  ready(await save(m.token, m.current, 14 * 1440));
  expect(await rows(m.id)).toEqual([
    {
      month: m.ended,
      start: day(-20),
      end: day(-7),
      minutes: 600,
      state: "draft",
    },
    {
      month: m.current,
      start: day(-6),
      end: day(7),
      minutes: 14 * 1440,
      state: "draft",
    },
  ]);
  // Not a period's first day, not started yet, longer than the period, and
  // a calendar month the periods reach into.
  for (const [key, minutes] of [
    [day(-5), 60],
    [day(8), 60],
    [m.current, 14 * 1440 + 1],
    [month, 60],
  ] as const) {
    const other = await student();
    expect((await save(other.token, key, minutes)).kind).toBe("invalid");
    expect(await rows(other.id)).toEqual([]);
  }
  expect((await invoices.coachingOverview(m.token, day(8))).kind).toBe(
    "invalid",
  );
  const page = await get("/account/coaching", m.token);
  expect(page.text).toContain(
    `<option value="${m.current}" selected>${dayLabel(day(-6))} to ${dayLabel(day(7))} (current)</option>`,
  );
  expect(page.text).toContain("Your billing period");
  expect(page.text).toContain("Saved periods");
  expect(page.text).not.toContain('class="month-nav"');
  // The database ties a dated key to its first day and the hours to its length.
  for (const [key, start, end, minutes] of [
    [day(-34), day(-33), day(-21), 60],
    [day(-34), day(-34), day(-35), 60],
    [day(-34), day(-34), day(-34), 1441],
    [addMonths(today, -3).slice(0, 7), day(-100), day(-90), 60],
  ] as const)
    await expect(
      pool.query(
        "INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision,period_start,period_end) VALUES($1,$2,$3,'Invented','',$4,1,$5,$6)",
        [m.id, key, minutes, "draft", start, end],
      ),
    ).rejects.toThrow(/check constraint/);
});

it("PERIOD832-03 a period is invoiced only after it has ended, once, and the invoice names its dates", async () => {
  const m = await student();
  for (const key of [m.ended, m.current]) {
    ready(await save(m.token, key, 600));
    ready(await submit(m.token, key, m.rateId));
  }
  // The running period: refused by the store, the route and the database.
  expect((await issue(m.id, m.current)).kind).toBe("invalid");
  const early = await get(
    `/operator/coaching/${m.id}?month=${m.current}`,
    admin,
  );
  expect(early.text).toContain(
    `This period ends on ${dayLabel(day(7))}. Its invoice can be issued from ${dayLabel(day(8))};`,
  );
  expect(early.text).not.toContain("Issue coaching invoice");
  const refused = await post(`/operator/coaching/${m.id}/issue`, admin, {
    month: m.current,
    action: "issue",
    confirm: "issue",
    tax: "0.00",
    revision: "2",
    operationId: randomUUID(),
  });
  expect(refused.status).toBe(422);
  expect(refused.text).toContain(
    "A billing period can be invoiced only after its last day",
  );
  const document = JSON.stringify({ number: "DN-invented", lines: [] });
  await expect(
    pool.query(
      "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,coaching_month) VALUES($1,$2,0,$3,true,100,$4)",
      [randomUUID(), m.id, document, m.current],
    ),
  ).rejects.toThrow("A coaching period is invoiced only after it has ended");
  expect(
    (
      await pool.query("SELECT 1 FROM simple_invoices WHERE owner_id=$1", [
        m.id,
      ])
    ).rowCount,
  ).toBe(0);
  // The ended period: issued once, at 10 hours × CAD 120.00.
  const issued = ready(await issue(m.id, m.ended));
  const invoice = ready(await invoices.invoice(admin, issued.invoiceId, true));
  // #844 LINK-01: the administrator's invoice links back to that student's period.
  expect(invoice.ownerId).toBe(m.id);
  expect(
    (await get(`/operator/invoices/${issued.invoiceId}`, admin)).text,
  ).toContain(
    `<a href="/operator/coaching/${m.id}?month=${m.ended}">return its coaching month for correction</a>`,
  );
  expect(invoice.document.lines).toEqual([
    {
      description: `Coaching · ${day(-20)} to ${day(-7)}`,
      amountCents: 120000,
    },
  ]);
  expect(invoice.document.coaching).toMatchObject({
    month: m.ended,
    periodStart: day(-20),
    periodEnd: day(-7),
    minutes: 600,
  });
  expect((await issue(m.id, m.ended, 3)).kind).toBe("conflict");
  await expect(
    pool.query(
      "INSERT INTO simple_invoices(id,owner_id,cycle,document,sample,total_cents,coaching_month) VALUES($1,$2,0,$3,true,100,$4)",
      [randomUUID(), m.id, document, m.ended],
    ),
  ).rejects.toThrow(/simple_invoice_one_coaching_month/);
  const view = await get(
    `/account/purchases/invoices/${issued.invoiceId}`,
    m.token,
  );
  expect(view.text).toContain(
    `Billing period: ${dayLabel(day(-20))} to ${dayLabel(day(-7))}`,
  );
  // An administrator's change to hours works per period (slice A).
  const changed = ready(
    await invoices.overrideCoachingHours(admin, {
      ownerId: m.id,
      month: m.current,
      minutes: 480,
      reason: "Invented: two sessions were cancelled",
      expectedRevision: 2,
      operationId: randomUUID(),
    }),
  );
  expect(changed).toEqual({ month: m.current, revision: 3 });
  expect(
    ready(await invoices.coachingOverview(m.token, m.current)).entry!.snapshot,
  ).toMatchObject({
    minutes: 480,
    subtotalCents: 96000,
    periodStart: day(-6),
    periodEnd: day(7),
  });
});

it("PERIOD832-04 a changed length applies from the next period; saved periods are not rewritten and a pending change can be replaced", async () => {
  const m = await student();
  ready(await save(m.token, m.ended, 600));
  ready(await save(m.token, m.current, 300));
  const before = await rows(m.id);
  // A start date is not accepted once periods have started.
  expect(
    (await setPeriod(m.id, { unit: "days", days: 7 }, 1, day(1))).kind,
  ).toBe("invalid");
  expect((await setPeriod(m.id, { unit: "days", days: 14 }, 1)).kind).toBe(
    "invalid",
  );
  expect(ready(await setPeriod(m.id, { unit: "days", days: 7 }, 1))).toEqual({
    version: 2,
    startsOn: day(8),
  });
  expect(await rows(m.id)).toEqual(before);
  const own = ready(await invoices.coachingOverview(m.token));
  // The current two-week period runs to its end; one week starts after it.
  expect(own.period).toMatchObject({ start: day(-6), end: day(7), days: 14 });
  expect(own.billing.schedules.map((s) => [s.days, s.startsOn])).toEqual([
    [14, day(-20)],
    [7, day(8)],
  ]);
  // A stale form is refused; a newer change replaces the pending one.
  expect((await setPeriod(m.id, { unit: "month" }, 1)).kind).toBe("conflict");
  expect(ready(await setPeriod(m.id, { unit: "month" }, 2))).toEqual({
    version: 3,
    startsOn: day(8),
  });
  expect(
    ready(await invoices.coachingOverview(m.token)).billing.schedules.map(
      (s) => [s.unit, s.startsOn],
    ),
  ).toEqual([
    ["days", day(-20)],
    ["month", day(8)],
  ]);
  // The database keeps a saved period's dates, and every setting as saved.
  await expect(
    pool.query(
      "UPDATE coaching_months SET period_end=period_end+7 WHERE owner_id=$1",
      [m.id],
    ),
  ).rejects.toThrow("A saved coaching period keeps its dates");
  for (const sql of [
    "UPDATE coaching_billing_schedules SET days=1 WHERE owner_id=$1",
    "DELETE FROM coaching_billing_schedules WHERE owner_id=$1",
  ])
    await expect(pool.query(sql, [m.id])).rejects.toThrow(
      "Coaching history is immutable",
    );
});

it("PERIOD832-05 calendar-month records stay intact and readable, and a first period starts only after them", async () => {
  const m = await member(),
    rateId = await setRate(m.id, 12000, month);
  // Before any setting: the calendar month, invoiced during the month.
  ready(await save(m.token, month, 90));
  ready(await submit(m.token, month, rateId));
  const first = `${month}-01`,
    last = addDays(addMonths(first, 1), -1);
  expect(await rows(m.id)).toEqual([
    { month, start: first, end: last, minutes: 90, state: "submitted" },
  ]);
  // A first period cannot start inside or before the saved month.
  for (const startsOn of [first, today, last])
    expect(
      (await setPeriod(m.id, { unit: "days", days: 14 }, 0, startsOn)).kind,
    ).toBe("invalid");
  const next = addDays(last, 1);
  ready(await setPeriod(m.id, { unit: "days", days: 14 }, 0, next));
  // The month is unchanged and still issued as a calendar month.
  const issued = ready(await issue(m.id, month));
  const invoice = ready(await invoices.invoice(admin, issued.invoiceId, true));
  expect(invoice.document.lines[0]!.description).toBe(`Coaching · ${month}`);
  expect(invoice.document.coaching).not.toHaveProperty("periodStart");
  const own = ready(await invoices.coachingOverview(m.token));
  expect(own).toMatchObject({
    month,
    period: { key: month, start: first, end: last },
    entry: { state: "invoiced", minutes: 90 },
    periods: [],
    billing: { nextStart: null },
  });
  expect(own.months).toMatchObject([
    { month, periodStart: first, periodEnd: last, state: "invoiced" },
  ]);
  const page = await get("/account/coaching", m.token);
  expect(page.text).toContain("Your billing period");
  expect(page.text).toContain(`2 weeks from ${dayLabel(next)}`);
  // A student never given a period keeps reporting by calendar month.
  const legacy = await member();
  expect(ready(await invoices.coachingOverview(legacy.token))).toMatchObject({
    month,
    periods: [],
    billing: { version: 0, schedules: [] },
  });
  expect((await save(legacy.token, month, 60)).kind).toBe("ready");
  // #842 MONTHNAV-01: calendar months move by previous-month links.
  expect((await get("/account/coaching", legacy.token)).text).toContain(
    '<nav class="month-nav" aria-label="Months">',
  );
  // The database refuses a second period over the same days.
  await expect(
    pool.query(
      "INSERT INTO coaching_months(owner_id,month,minutes,name,email,state,revision,period_start,period_end) VALUES($1,$2,60,'Invented','','draft',1,$3,$3)",
      [legacy.id, today, today],
    ),
  ).rejects.toThrow("Coaching periods cannot overlap");
  // A month wholly before a first period is still reportable; one the
  // periods reach into is not.
  const late = await member();
  ready(await setPeriod(late.id, { unit: "days", days: 7 }, 0, day(-3)));
  const earlier = addMonths(day(-3), -1).slice(0, 7);
  expect((await save(late.token, earlier, 60)).kind).toBe("ready");
  expect((await save(late.token, day(-3).slice(0, 7), 60)).kind).toBe(
    "invalid",
  );
});

it("PERIOD832-06 the rate in effect on the period's first day applies", async () => {
  const m = await member();
  ready(await setPeriod(m.id, { unit: "days", days: 14 }, 0, day(-45)));
  // Periods start 45, 31, 17 and 3 days ago. One rate from the month of the
  // oldest, a second from the month of the newest.
  const starts = [day(-45), day(-31), day(-17), day(-3)],
    older = await setRate(m.id, 10000, starts[0]!.slice(0, 7)),
    newer = await setRate(m.id, 15000, starts[3]!.slice(0, 7));
  for (const start of starts) {
    const expected =
      start.slice(0, 7) >= starts[3]!.slice(0, 7) ? 15000 : 10000;
    const own = ready(await invoices.coachingOverview(m.token, start));
    expect(own.rate).toMatchObject({ cents: expected });
    ready(await save(m.token, start, 60));
    ready(await submit(m.token, start, expected === 15000 ? newer : older));
    expect(
      ready(await invoices.coachingOverview(m.token, start)).entry!.snapshot,
    ).toMatchObject({ subtotalCents: expected, rate: { cents: expected } });
  }
  // The other rate is refused for the period, as a stale rate always was.
  const other = await student();
  ready(await save(other.token, other.ended, 60));
  expect((await submit(other.token, other.ended, randomUUID())).kind).toBe(
    "conflict",
  );
});

it("PERIOD832-08 the dashboard counts a period in the month it ends and shows the period that needs attention", async () => {
  const m = await student();
  await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
    m.id,
    "Invented period student",
  ]);
  ready(await save(m.token, m.ended, 600));
  ready(await submit(m.token, m.ended, m.rateId));
  ready(await save(m.token, m.current, 300));
  const ends = day(-7).slice(0, 7);
  const row = async (when: string) =>
    ready(await invoices.coachingDashboard(admin, when)).contractors.find(
      (c) => c.id === m.id,
    );
  const shown = await row(ends);
  expect(shown).toMatchObject({
    displayName: "Invented period student",
    rateCents: 12000,
    status: "submitted",
    periodKey: m.ended,
    balanceCents: null,
  });
  // The running period is a draft ending later; it counts only if it ends
  // in the same month, and drafts never add hours.
  expect(shown!.minutes).toBe(600);
  expect(shown!.yearMinutes).toBeGreaterThanOrEqual(600);
  const issued = ready(await issue(m.id, m.ended));
  expect(await row(ends)).toMatchObject({
    status: day(7).slice(0, 7) === ends ? "draft" : "invoiced",
    minutes: 600,
    balanceCents: 120000,
    sent: false,
  });
  const pending = ready(
    await invoices.adminOverview(admin, m.id),
  ).coachingPending;
  expect(pending).toEqual([]);
  ready(await submit(m.token, m.current, m.rateId));
  expect(
    ready(await invoices.adminOverview(admin, m.id)).coachingPending,
  ).toEqual([
    {
      ownerId: m.id,
      month: m.current,
      periodStart: day(-6),
      periodEnd: day(7),
      displayName: "Invented period student",
    },
  ]);
  const page = await get(`/operator/coaching?month=${ends}`, admin);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Awaiting review</h2>");
  expect(issued.invoiceId).toBeTruthy();
});

it("PERIOD832-09 Download my records carries period dates and the billing-period settings, without the administrator; deletion removes them", async () => {
  const m = await student(),
    other = await student();
  ready(await save(m.token, m.ended, 600));
  ready(await setPeriod(m.id, { unit: "days", days: 10 }, 1));
  const exporter = memberExportStore(pool),
    records: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined, version: string | undefined;
  do {
    const result = await exporter.exportOwned(m.token, cursor);
    if (result.kind !== "ready") throw Error("Expected export");
    version = result.payload.version;
    for (const [key, list] of Object.entries(result.payload.records))
      records[key] = [...(records[key] ?? []), ...list];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(version).toBe("local-member-records-v52");
  expect(records.coachingMonths).toMatchObject([
    { month: m.ended, periodStart: day(-20), periodEnd: day(-7), minutes: 600 },
  ]);
  expect(records.coachingBillingSchedules).toEqual([
    {
      version: 1,
      unit: "days",
      days: 14,
      startsOn: day(-20),
      setAt: expect.any(Date),
    },
    {
      version: 2,
      unit: "days",
      days: 10,
      startsOn: day(8),
      setAt: expect.any(Date),
    },
  ]);
  const staffId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE token_hash=$1",
      [hash(admin)],
    )
  ).rows[0]!.id;
  expect(JSON.stringify(records)).not.toContain(staffId);
  expect(JSON.stringify(records)).not.toContain(other.id);
  await members.remove(m.id);
  for (const table of ["coaching_billing_schedules", "coaching_months"])
    expect(
      (await pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [m.id]))
        .rowCount,
    ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coaching_billing_schedules WHERE owner_id=$1",
        [other.id],
      )
    ).rowCount,
  ).toBe(1);
});

it("PERIOD832-10 only a current platform administrator sets a billing period, through the checked form, and Change history records it", async () => {
  const m = await member(),
    other = await member(),
    reviewer = await staff("reviewer");
  for (const denied of [m.token, other.token, reviewer])
    expect(
      (
        await invoices.setBillingSchedule(denied, {
          ownerId: m.id,
          unit: "days",
          days: 14,
          startsOn: day(1),
          expectedVersion: 0,
          operationId: randomUUID(),
        })
      ).kind,
    ).toBe("denied");
  const path = `/operator/coaching/${m.id}/billing-period`,
    fields = {
      length: "custom",
      days: "10",
      startsOn: day(-10),
      revision: "0",
      operationId: randomUUID(),
    };
  expect(
    (await post(path, admin, fields, "https://other.invalid")).status,
  ).toBe(403);
  expect((await post(path, m.token, fields)).status).toBeGreaterThanOrEqual(
    403,
  );
  expect((await post(path, admin, { ...fields, days: "40" })).status).toBe(422);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coaching_billing_schedules WHERE owner_id=$1",
        [m.id],
      )
    ).rowCount,
  ).toBe(0);
  const before = await get(`/operator/coaching/${m.id}`, admin);
  expect(before.text).toContain("No billing period is set");
  expect(before.text).toContain('<option value="14" selected>2 weeks</option>');
  const accepted = await post(path, admin, fields);
  expect(accepted.status).toBe(303);
  expect(accepted.headers.location).toBe(
    `/operator/coaching/${m.id}#billing-period`,
  );
  // The same form again returns the original outcome, once.
  expect((await post(path, admin, fields)).status).toBe(303);
  const after = await get(`/operator/coaching/${m.id}`, admin);
  expect(after.text).toContain(
    `This student’s billing period: <strong>10 days, from ${dayLabel(day(-10))}</strong>.`,
  );
  expect(after.text).toContain(
    `A new length applies from ${dayLabel(day(10))}, the day after the current period ends.`,
  );
  const staffId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE token_hash=$1",
      [hash(admin)],
    )
  ).rows[0]!.id;
  expect(
    (
      await pool.query(
        "SELECT actor_id,action,month FROM billing_change_events WHERE member_id=$1",
        [m.id],
      )
    ).rows,
  ).toEqual([
    { actor_id: staffId, action: "billing_period_set", month: day(-10) },
  ]);
  // Restarting re-runs every migration; settings and history survive.
  await migrate(pool);
  expect(
    ready(await invoices.coachingOverview(admin, undefined, m.id)).billing,
  ).toMatchObject({ version: 1, schedules: [{ days: 10 }] });
});
