import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import {
  shiftMonth,
  simpleInvoiceStore,
  type InvoiceResult,
} from "../../src/simple-invoice-store.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { dayLabel } from "../../src/coaching-values.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #856 (owner's choice): an administrator issues the invoice from a student's
// saved draft once its period has ended, with a reason the student sees.
// Every person, rate and reason here is invented.
const pool = testPool(),
  members = store(pool),
  settings = {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  },
  invoices = simpleInvoiceStore(pool, settings),
  secret = "coaching-issue-draft-test",
  origin = "http://127.0.0.1:3000",
  application = app(members, {
    origin,
    secret,
    mode: "test",
    simpleInvoices: invoices,
  }),
  auth = authorizationStore(pool);
const REASON = "Invented: the student is travelling without a computer";
let admin: string, month: string, current: string, toronto: string;
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
/** A student with a CAD 120.00 rate and a saved draft for `key`. */
async function drafted(key = month, minutes = 90) {
  const m = await member();
  ready(
    await invoices.setCoachingRate(admin, {
      ownerId: m.id,
      effectiveMonth: key,
      cents: 12000,
      expectedVersion: 0,
      operationId: randomUUID(),
    }),
  );
  const draft = ready(
    await invoices.saveCoaching(m.token, {
      month: key,
      minutes,
      expectedRevision: 0,
      operationId: randomUUID(),
      name: "Invented student",
      email: "student@example.invalid",
    }),
  );
  return { ...m, revision: draft.revision };
}
const input = (
  m: { id: string; revision: number },
  extra: Record<string, unknown> = {},
) =>
  ({
    ownerId: m.id,
    month,
    expectedRevision: m.revision,
    taxCents: 0,
    reason: REASON,
    operationId: randomUUID(),
    ...extra,
  }) as Parameters<typeof invoices.issueCoachingFromDraft>[1];
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
const state = async (id: string, key = month) =>
  (
    await pool.query<{ state: string; revision: number }>(
      "SELECT state,revision FROM coaching_months WHERE owner_id=$1 AND month=$2",
      [id, key],
    )
  ).rows[0];
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
  current = clock.month;
  month = shiftMonth(current, -1);
  toronto = clock.toronto;
});
afterAll(() => pool.end());

it("TERMS856-40 an administrator issues an ended draft month; the invoice says so and the month is invoiced", async () => {
  const m = await drafted();
  const { invoiceId } = ready(
    await invoices.issueCoachingFromDraft(admin, input(m)),
  );
  const row = (
    await pool.query(
      "SELECT document,total_cents::integer AS total,coaching_month FROM simple_invoices WHERE id=$1",
      [invoiceId],
    )
  ).rows[0]!;
  expect(row.total).toBe(18000);
  expect(row.coaching_month).toBe(month);
  expect(row.document).toMatchObject({
    number: expect.stringMatching(/^SAMPLE-\d{4,}$/),
    issuedOn: toronto,
    terms: "net_15",
    billedTo: "Invented student",
    recipientEmail: "student@example.invalid",
    coaching: { month, minutes: 90, rateCents: 12000, issuedFromDraft: true },
  });
  expect(JSON.stringify(row.document)).not.toContain(REASON);
  expect(await state(m.id)).toMatchObject({ state: "invoiced" });
  // The submission snapshot is written as the student's would be.
  const submission = (
    await pool.query(
      "SELECT revision,snapshot FROM coaching_submissions WHERE owner_id=$1 AND month=$2",
      [m.id, month],
    )
  ).rows;
  expect(submission).toEqual([
    {
      revision: m.revision + 1,
      snapshot: expect.objectContaining({
        month,
        minutes: 90,
        subtotalCents: 18000,
        name: "Invented student",
        sample: true,
      }),
    },
  ]);
  expect(
    (
      await pool.query(
        "SELECT revision,reason,actor_id IS NOT NULL AS actor FROM coaching_admin_issues WHERE owner_id=$1",
        [m.id],
      )
    ).rows,
  ).toEqual([{ revision: m.revision + 1, reason: REASON, actor: true }]);
  expect(
    (
      await pool.query(
        "SELECT action FROM billing_change_events WHERE member_id=$1 ORDER BY id",
        [m.id],
      )
    ).rows.map((r) => r.action),
  ).toEqual(["rate_set", "issued_from_draft", "coaching_invoice_issued"]);
  // A retried submit returns the same invoice and uses no second number.
  const replay = input(m);
  const other = await drafted();
  const first = ready(
    await invoices.issueCoachingFromDraft(admin, {
      ...replay,
      ownerId: other.id,
      expectedRevision: other.revision,
    }),
  );
  const after = (
    await pool.query<{ next: number }>(
      "SELECT next FROM simple_invoice_numbers WHERE series='sample'",
    )
  ).rows[0]!.next;
  expect(
    ready(
      await invoices.issueCoachingFromDraft(admin, {
        ...replay,
        ownerId: other.id,
        expectedRevision: other.revision,
      }),
    ),
  ).toEqual(first);
  expect(
    (
      await pool.query<{ next: number }>(
        "SELECT next FROM simple_invoice_numbers WHERE series='sample'",
      )
    ).rows[0]!.next,
  ).toBe(after);
  // The printed invoice says who issued it, never the reason.
  const printed = await get(
    `/account/purchases/invoices/${invoiceId}`,
    m.token,
  );
  expect(printed.text).toContain(
    "Issued by the administrator from the student's saved hours.",
  );
  expect(printed.text).not.toContain("travelling");
});

it("TERMS856-41 a period that has not ended → conflict, with nothing written", async () => {
  const m = await drafted(current);
  expect(
    (await invoices.issueCoachingFromDraft(admin, input(m, { month: current })))
      .kind,
  ).toBe("conflict");
  expect(await state(m.id, current)).toEqual({
    state: "draft",
    revision: m.revision,
  });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM coaching_admin_issues WHERE owner_id=$1 UNION ALL SELECT 1 FROM coaching_submissions WHERE owner_id=$1",
        [m.id],
      )
    ).rowCount,
  ).toBe(0);
  const page = await get(`/operator/coaching/${m.id}?month=${current}`, admin);
  expect(page.text).not.toContain("Issue invoice from this draft</button>");
});

it("TERMS856-42 an empty or 501-character reason → invalid", async () => {
  const m = await drafted();
  for (const reason of ["", "   ", "x".repeat(501), 7])
    expect(
      (await invoices.issueCoachingFromDraft(admin, input(m, { reason }))).kind,
    ).toBe("invalid");
  expect(
    (
      await invoices.issueCoachingFromDraft(
        admin,
        input(m, { reason: "x".repeat(500) }),
      )
    ).kind,
  ).toBe("ready");
});

it("TERMS856-43 a stale revision → conflict; a submitted or zero-hour month is refused", async () => {
  const m = await drafted();
  expect(
    (
      await invoices.issueCoachingFromDraft(
        admin,
        input(m, { expectedRevision: m.revision + 1 }),
      )
    ).kind,
  ).toBe("conflict");
  const none = await drafted(month, 0);
  expect((await invoices.issueCoachingFromDraft(admin, input(none))).kind).toBe(
    "invalid",
  );
  expect(await state(m.id)).toEqual({ state: "draft", revision: m.revision });
  // Once the student submits, the reviewed path issues it instead.
  const rateId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM coaching_rates WHERE owner_id=$1",
      [m.id],
    )
  ).rows[0]!.id;
  const submitted = ready(
    await invoices.submitCoaching(m.token, {
      month,
      rateId,
      sample: true,
      expectedRevision: m.revision,
      operationId: randomUUID(),
    }),
  );
  expect(
    (
      await invoices.issueCoachingFromDraft(
        admin,
        input(m, { expectedRevision: submitted.revision }),
      )
    ).kind,
  ).toBe("conflict");
});

it("TERMS856-44 a non-admin token → denied", async () => {
  const m = await drafted(),
    reviewer = randomBytes(32).toString("hex");
  await auth.provisionStaff(
    reviewer,
    "reviewer",
    new Date(Date.now() + 3600000),
  );
  for (const token of [m.token, reviewer])
    expect((await invoices.issueCoachingFromDraft(token, input(m))).kind).toBe(
      "denied",
    );
  expect(await state(m.id)).toEqual({ state: "draft", revision: m.revision });
});

it("TERMS856-45/47 the form issues from the admin page and the student's page shows the exact notice", async () => {
  const m = await drafted();
  const page = await get(`/operator/coaching/${m.id}?month=${month}`, admin);
  expect(page.text).toContain("<h2>Issue invoice from this draft</h2>");
  expect(page.text).toContain(
    "I issue these hours for the student. They will see the hours, the amount and this reason.",
  );
  const sent = await post(`/operator/coaching/${m.id}/issue-draft`, admin, {
    month,
    revision: String(m.revision),
    operationId: randomUUID(),
    action: "issue-draft",
    tax: "0.00",
    terms: "net_30",
    reason: REASON,
    confirm: "issue-draft",
  });
  expect(sent.status).toBe(303);
  const invoiceId = sent.headers.location!.split("/").at(-1)!;
  expect(sent.headers.location).toBe(`/operator/invoices/${invoiceId}`);
  const own = await get(`/account/coaching?month=${month}`, m.token);
  expect(own.text).toContain(
    `Your administrator issued this invoice from your saved draft on ${dayLabel(toronto)}. Reason: ${REASON}`,
  );
  // Another student sees nothing of it.
  const other = await drafted();
  expect(
    (await get(`/account/coaching?month=${month}`, other.token)).text,
  ).not.toContain("Your administrator issued");
});

it("TERMS856-46 Download my records includes the reason, without the administrator", async () => {
  const m = await drafted();
  ready(await invoices.issueCoachingFromDraft(admin, input(m)));
  const exporter = memberExportStore(pool),
    records: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined, version: string | undefined;
  do {
    const result = await exporter.exportOwned(m.token, cursor);
    if (result.kind !== "ready") throw Error("Expected export");
    version = result.payload.version;
    for (const [key, rows] of Object.entries(result.payload.records))
      records[key] = [...(records[key] ?? []), ...rows];
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(version).toBe("local-member-records-v53");
  expect(records.coachingAdminIssues).toEqual([
    { month, reason: REASON, issuedAt: expect.any(Date) },
  ]);
});
