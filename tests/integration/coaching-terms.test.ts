import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { migrate, store } from "../../src/store.ts";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import {
  coachingTermsStore,
  type TermsResult,
} from "../../src/coaching-terms.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { memberExportStore } from "../../src/member-export.ts";

// #316 owner decision 9 Nov 2026: an administrator sets each student's coaching
// terms. Invented people and amounts only.
const pool = testPool(),
  members = store(pool),
  terms = coachingTermsStore(pool),
  auth = authorizationStore(pool);
const origin = "http://127.0.0.1:3000",
  secret = "coaching-terms-test";
const application = app(members, {
  origin,
  secret,
  mode: "test",
  simpleInvoices: simpleInvoiceStore(pool, {
    sample: true,
    issuer: "Invented coaching issuer",
    instructions: "Sample only; do not pay.",
  }),
  coachingTerms: terms,
});
const ready = <T>(result: TermsResult<T>): T => {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
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
const agreed = {
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
};
const form = {
  price: "1200.00",
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: "120",
  coachingSessions: "6",
  aiRequests: "200",
};
const input = (ownerId: string, expectedVersion = 0, values = agreed) => ({
  ...values,
  ownerId,
  expectedVersion,
  operationId: randomUUID(),
});
const get = (path: string, token: string) =>
  withLoopback(application, (s) =>
    request(s)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`),
  );
const post = (
  path: string,
  token: string,
  fields: Record<string, string>,
  from = origin,
  anti = csrf(token, secret),
) =>
  withLoopback(application, (s) =>
    request(s)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", from)
      .set("Cookie", `${COOKIE}=${token}`)
      .type("form")
      .send({ csrf: anti, ...fields }),
  );
const versions = async (id: string) =>
  (
    await pool.query<{ n: number }>(
      "SELECT count(*)::integer n FROM coaching_terms WHERE owner_id=$1",
      [id],
    )
  ).rows[0]!.n;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");
let admin: string;
beforeAll(async () => {
  await migrate(pool);
  admin = await staff();
});
afterAll(() => pool.end());

it("TERMS316-01 an administrator saves a student's terms on the student's coaching page, and they show as current", async () => {
  const m = await member();
  const page = await get(`/operator/coaching/${m.id}`, admin);
  expect(page.status).toBe(200);
  expect(text(page.text)).toContain(
    "No coaching terms are set for this student.",
  );
  expect(page.text).toContain(
    `<form method="post" action="/operator/coaching/${m.id}/terms">`,
  );
  const saved = await post(`/operator/coaching/${m.id}/terms`, admin, {
    ...form,
    revision: "0",
    operationId: randomUUID(),
  });
  expect(saved.status).toBe(303);
  expect(saved.headers.location).toBe(`/operator/coaching/${m.id}`);
  const after = text((await get(`/operator/coaching/${m.id}`, admin)).text);
  for (const shown of [
    "Current terms, version 1:",
    "Price CAD 1,200.00",
    "Coaching period December 1, 2026 to May 31, 2027",
    "Renewal date June 1, 2027",
    "Expert review time 120 minutes",
    "Coaching sessions 6",
    "AI requests 200",
  ])
    expect(after).toContain(shown);
  expect(ready(await terms.forStudent(admin, m.id))).toMatchObject({
    version: 1,
    ...agreed,
  });
});

it("TERMS316-02 a new save is a new version, and saved versions can't be changed or deleted", async () => {
  const m = await member();
  ready(await terms.save(admin, input(m.id)));
  expect(
    ready(
      await terms.save(admin, input(m.id, 1, { ...agreed, priceCents: 90000 })),
    ),
  ).toEqual({ version: 2 });
  expect(ready(await terms.forStudent(admin, m.id))).toMatchObject({
    version: 2,
    priceCents: 90000,
  });
  const rows = await pool.query(
    "SELECT version,price_cents FROM coaching_terms WHERE owner_id=$1 ORDER BY version",
    [m.id],
  );
  expect(rows.rows).toEqual([
    { version: 1, price_cents: 120000 },
    { version: 2, price_cents: 90000 },
  ]);
  await expect(
    pool.query("UPDATE coaching_terms SET price_cents=1 WHERE owner_id=$1", [
      m.id,
    ]),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("DELETE FROM coaching_terms WHERE owner_id=$1", [m.id]),
  ).rejects.toThrow(/immutable/);
});

it("TERMS316-03 a stale form is refused, and replaying the same save returns the same version", async () => {
  const m = await member();
  const first = input(m.id);
  expect(ready(await terms.save(admin, first))).toEqual({ version: 1 });
  expect(ready(await terms.save(admin, first))).toEqual({ version: 1 });
  expect(await terms.save(admin, { ...first, priceCents: 1 })).toEqual({
    kind: "conflict",
  });
  expect(await terms.save(admin, input(m.id, 0))).toEqual({
    kind: "conflict",
  });
  const stale = await post(`/operator/coaching/${m.id}/terms`, admin, {
    ...form,
    revision: "0",
    operationId: randomUUID(),
  });
  expect(stale.status).toBe(409);
  expect(await versions(m.id)).toBe(1);
});

it("TERMS316-04 invalid terms are refused and nothing is saved", async () => {
  const m = await member();
  for (const wrong of [
    { price: "" },
    { price: "-5" },
    { price: "0" },
    { price: "10000001" },
    { startsOn: "2026-02-30" },
    { endsOn: "2026-11-30" },
    { renewsOn: "2026-11-30" },
    { reviewMinutes: "-1" },
    { coachingSessions: "1.5" },
    { aiRequests: "1000001" },
    { reviewMinutes: "" },
  ]) {
    const refused = await post(`/operator/coaching/${m.id}/terms`, admin, {
      ...form,
      ...wrong,
      revision: "0",
      operationId: randomUUID(),
    });
    expect(refused.status, JSON.stringify(wrong)).toBe(422);
  }
  const extra = await post(`/operator/coaching/${m.id}/terms`, admin, {
    ...form,
    revision: "0",
    operationId: randomUUID(),
    sponsor: "company",
  });
  expect(extra.status).toBe(403);
  expect(await terms.save(admin, { ...input(m.id), priceCents: 0 })).toEqual({
    kind: "invalid",
  });
  expect(await versions(m.id)).toBe(0);
});

it("TERMS316-05 only a platform administrator with a valid form can save", async () => {
  const m = await member(),
    other = await member(),
    reviewer = await staff("reviewer");
  const fields = { ...form, revision: "0", operationId: randomUUID() };
  const path = `/operator/coaching/${m.id}/terms`;
  for (const refused of [
    await post(path, m.token, fields),
    await post(path, other.token, fields),
    await post(path, reviewer, fields),
    await post(path, admin, fields, "http://evil.invalid"),
    await post(path, admin, fields, origin, "wrong"),
  ])
    expect(refused.status).toBe(403);
  expect(await terms.save(m.token, input(m.id))).toEqual({ kind: "denied" });
  expect(await terms.save(reviewer, input(m.id))).toEqual({ kind: "denied" });
  expect(await terms.forStudent(reviewer, m.id)).toEqual({ kind: "denied" });
  expect(await versions(m.id)).toBe(0);
});

it("TERMS316-06 the student sees their own current terms read-only, with the contact line, and nobody else's", async () => {
  const m = await member(),
    other = await member();
  const none = text((await get("/account/coaching", m.token)).text);
  expect(none).toContain(
    "Your administrator hasn't set your coaching terms yet.",
  );
  ready(await terms.save(admin, input(m.id)));
  const page = await get("/account/coaching", m.token);
  expect(page.status).toBe(200);
  const shown = text(page.text);
  for (const sentence of [
    "Your coaching terms",
    "Price CAD 1,200.00",
    "Coaching period December 1, 2026 to May 31, 2027",
    "Renewal date June 1, 2027",
    "Expert review time 120 minutes",
    "Coaching sessions 6",
    "AI requests 200",
    "Your administrator set these terms. Your coaching price covers these allowances.",
    "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io.",
  ])
    expect(shown).toContain(sentence);
  expect(page.text).toContain(
    '<a href="mailto:info@deepnative.io">info@deepnative.io</a>',
  );
  expect(page.text).not.toContain('name="price"');
  expect(ready(await terms.own(m.token))).toMatchObject({ version: 1 });
  expect(ready(await terms.own(other.token))).toBeNull();
  expect(text((await get("/account/coaching", other.token)).text)).toContain(
    "Your administrator hasn't set your coaching terms yet.",
  );
});

it("TERMS316-07 the student's download has every version without the administrator, and deleting the account removes them", async () => {
  const m = await member();
  ready(await terms.save(admin, input(m.id)));
  ready(
    await terms.save(admin, input(m.id, 1, { ...agreed, aiRequests: 300 })),
  );
  const exporter = memberExportStore(pool);
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.exportOwned(m.token, cursor);
    if (page.kind !== "ready") throw Error("Expected an export page");
    expect(page.payload.version).toBe("local-member-records-v47");
    rows.push(...(page.payload.records.coachingTerms ?? []));
    cursor = page.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(
    rows.map(({ savedAt, ...row }) => (expect(savedAt).toBeTruthy(), row)),
  ).toEqual([
    { version: 1, ...agreed },
    { version: 2, ...agreed, aiRequests: 300 },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/actor|operation|digest/);
  await pool.query("DELETE FROM principals WHERE id=$1", [m.id]);
  expect(await versions(m.id)).toBe(0);
});

// #317 owner decisions of 9 Nov 2026: renewal is the admin-set date only.
// Nothing renews or charges automatically; staff see whose date is near or past.
it("RENEW317-01/02 administrators see current renewal dates that have passed or fall within 30 days, oldest first", async () => {
  const today = (
    await pool.query<{ d: string }>(
      "SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d",
    )
  ).rows[0]!.d;
  const day = (offset: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000)
      .toISOString()
      .slice(0, 10);
  const terms0 = (renew: number) => ({
    ...agreed,
    startsOn: day(-90),
    endsOn: day(-1),
    renewsOn: day(renew),
  });
  const overdue = await member(),
    soon = await member(),
    later = await member(),
    moved = await member(),
    edge = await member(),
    gone = await member();
  await pool.query("UPDATE learners SET display_name=$2 WHERE id=$1", [
    overdue.id,
    "Renewal <Overdue>",
  ]);
  ready(await terms.save(admin, input(overdue.id, 0, terms0(-5))));
  ready(await terms.save(admin, input(soon.id, 0, terms0(10))));
  ready(await terms.save(admin, input(later.id, 0, terms0(31))));
  ready(await terms.save(admin, input(moved.id, 0, terms0(1))));
  ready(await terms.save(admin, input(moved.id, 1, terms0(90))));
  ready(await terms.save(admin, input(edge.id, 0, terms0(30))));
  ready(await terms.save(admin, input(gone.id, 0, terms0(0))));
  await pool.query("UPDATE principals SET revoked_at=now() WHERE id=$1", [
    gone.id,
  ]);
  const mine = [overdue, soon, later, moved, edge, gone].map((m) => m.id);
  const listed = ready(await terms.renewalsDue(admin)).filter((r) =>
    mine.includes(r.ownerId),
  );
  expect(listed).toEqual([
    {
      ownerId: overdue.id,
      displayName: "Renewal <Overdue>",
      renewsOn: day(-5),
      days: -5,
    },
    { ownerId: soon.id, displayName: null, renewsOn: day(10), days: 10 },
    { ownerId: edge.id, displayName: null, renewsOn: day(30), days: 30 },
  ]);
  const page = await get("/operator/coaching", admin);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Renewal &lt;Overdue&gt;");
  expect(text(page.text)).toContain(
    `renewal date ${new Date(`${day(-5)}T00:00:00Z`).toLocaleDateString("en-CA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })} · 5 days overdue`,
  );
  const section = page.text.match(
    /<section[^>]*aria-labelledby="renewals-due".*?<\/section>/,
  )![0];
  expect(section).toContain(`href="/operator/coaching/${soon.id}"`);
  for (const hidden of [later, moved, gone])
    expect(section).not.toContain(hidden.id);
  // Listing changes nothing: no new version, charge or invoice.
  expect(await versions(overdue.id)).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM simple_invoices WHERE owner_id=ANY($1::uuid[])",
        [mine],
      )
    ).rowCount,
  ).toBe(0);
  expect(await terms.renewalsDue(overdue.token)).toEqual({ kind: "denied" });
  expect(await terms.renewalsDue(await staff("reviewer"))).toEqual({
    kind: "denied",
  });
  expect((await get("/operator/coaching", overdue.token)).status).toBe(403);
});

it("RENEW317-03 the student sees their renewal date and that nothing renews automatically", async () => {
  const m = await member();
  ready(await terms.save(admin, input(m.id)));
  const page = text((await get("/account/coaching", m.token)).text);
  expect(page).toContain("Renewal date June 1, 2027");
  expect(page).toContain(
    "Nothing renews or charges automatically. To renew, contact info@deepnative.io.",
  );
});
