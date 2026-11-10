import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import {
  adminTermsSection,
  coachingTermsStore,
  memberTermsSection,
  parseCoachingTerms,
  renewalsSection,
  type CoachingTerms,
  type CoachingTermsStore,
} from "../../src/coaching-terms.ts";
import { mountCoachingRoutes } from "../../src/coaching-routes.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { invoiceDigest } from "../../src/simple-invoice-values.ts";
import { csrf } from "../../src/session.ts";
import type { SimpleInvoiceStore } from "../../src/simple-invoice-store.ts";
import { withLoopback } from "../support/loopback-server.ts";

// #316 TERMS316-01..06 without a database; PostgreSQL behaviour is in
// tests/integration/coaching-terms.test.ts.
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  token = "a".repeat(64),
  origin = "http://127.0.0.1:3000",
  secret = "terms-unit";
const values = {
  priceCents: 120000,
  startsOn: "2026-12-01",
  endsOn: "2027-05-31",
  renewsOn: "2027-06-01",
  reviewMinutes: 120,
  coachingSessions: 6,
  aiRequests: 200,
};
const saved: CoachingTerms = {
  ...values,
  version: 1,
  savedAt: new Date("2026-11-09T12:00:00Z"),
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
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1");

function fixture(
  o: {
    kind?: "staff" | "member" | null;
    role?: string;
    student?: boolean;
    current?: CoachingTerms | null;
    earlier?: { digest: string; version: number };
    due?: unknown[];
    fail?: Error;
  } = {},
) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes("FROM principals WHERE token_hash"))
      rows =
        o.kind === null
          ? []
          : [
              {
                id: key,
                kind: o.kind ?? "staff",
                expires: new Date("2099-01-01"),
              },
            ];
    else if (sql.includes("FROM authorized_staff_profiles"))
      rows = [{ role: o.role ?? "platform_admin" }];
    else if (sql.includes("FROM principals p JOIN learners"))
      rows = o.student === false ? [] : [{ "?column?": 1 }];
    else if (sql.includes("WHERE actor_id=$1 AND operation_id=$2"))
      rows = o.earlier ? [o.earlier] : [];
    else if (sql.includes("DISTINCT ON (owner_id)")) rows = o.due ?? [];
    else if (sql.includes("FROM coaching_terms WHERE owner_id"))
      rows = o.current ? [o.current] : [];
    return { rows, rowCount: rows.length };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) => {
    if (o.fail) throw o.fail;
    return use({
      query,
      observe: async () => {},
    } as unknown as PracticeTransaction);
  });
  return { terms: coachingTermsStore({} as Pool), query };
}
const input = (over: Record<string, unknown> = {}) => ({
  ...values,
  ownerId: id,
  expectedVersion: 0,
  operationId: key,
  ...over,
});
beforeEach(() => vi.clearAllMocks());

it("TERMS316-04 parses whole, bounded form values and refuses anything else", () => {
  expect(parseCoachingTerms(form)).toEqual(values);
  for (const wrong of [
    { price: "" },
    { price: "0" },
    { price: "-1" },
    { price: 12 },
    { startsOn: "2026-02-30" },
    { endsOn: "2026-11-30" },
    { renewsOn: "2026-11-30" },
    { reviewMinutes: "100001" },
    { reviewMinutes: "01" },
    { coachingSessions: "1001" },
    { coachingSessions: 6 },
    { aiRequests: "1.5" },
  ])
    expect(
      parseCoachingTerms({ ...form, ...wrong }),
      JSON.stringify(wrong),
    ).toBeNull();
  expect(
    parseCoachingTerms({
      ...form,
      endsOn: "2026-12-01",
      renewsOn: "2026-12-01",
    }),
  ).toMatchObject({ endsOn: "2026-12-01", renewsOn: "2026-12-01" });
});

it("TERMS316-01/03 saves a new version, replays the same operation and refuses stale or reused ones", async () => {
  let f = fixture();
  expect(await f.terms.save(token, input())).toEqual({
    kind: "ready",
    value: { version: 1 },
  });
  const insert = f.query.mock.calls.find(([sql]) =>
    String(sql).startsWith("INSERT INTO coaching_terms"),
  )!;
  expect(insert[1]).toEqual(
    expect.arrayContaining([id, 1, 120000, "2026-12-01", key]),
  );
  f = fixture({ current: saved });
  expect(await f.terms.save(token, input({ expectedVersion: 1 }))).toEqual({
    kind: "ready",
    value: { version: 2 },
  });
  expect(await f.terms.save(token, input())).toEqual({ kind: "conflict" });
  const digest = invoiceDigest({
    ownerId: id,
    expectedVersion: 0,
    terms: values,
  });
  f = fixture({ earlier: { digest, version: 1 }, current: saved });
  expect(await f.terms.save(token, input())).toEqual({
    kind: "ready",
    value: { version: 1 },
  });
  expect(
    f.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
  ).toBe(false);
  f = fixture({ earlier: { digest: "0".repeat(64), version: 1 } });
  expect(await f.terms.save(token, input())).toEqual({ kind: "conflict" });
});

it("TERMS316-04/05 refuses invalid input, the wrong people and failures without saving", async () => {
  const f = fixture();
  for (const wrong of [
    { ownerId: "nope" },
    { operationId: "nope" },
    { expectedVersion: -1 },
    { expectedVersion: 0.5 },
    { priceCents: 0 },
    { priceCents: 1_000_000_001 },
    { priceCents: 1.5 },
    { reviewMinutes: -1 },
    { aiRequests: 1_000_001 },
    { endsOn: "2026-11-01" },
  ])
    expect(
      await f.terms.save(token, input(wrong)),
      JSON.stringify(wrong),
    ).toEqual({
      kind: "invalid",
    });
  expect(await f.terms.save(token, null as never)).toEqual({ kind: "invalid" });
  expect(await f.terms.save("short", input())).toEqual({ kind: "denied" });
  expect(await fixture({ kind: null }).terms.save(token, input())).toEqual({
    kind: "denied",
  });
  expect(await fixture({ kind: "member" }).terms.save(token, input())).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ role: "reviewer" }).terms.save(token, input()),
  ).toEqual({
    kind: "denied",
  });
  expect(await fixture({ student: false }).terms.save(token, input())).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ fail: new Error("lost") }).terms.save(token, input()),
  ).toEqual({ kind: "unavailable" });
  expect(
    await fixture({
      fail: new PracticeLifetimeFailure("unavailable"),
    }).terms.save(token, input()),
  ).toEqual({ kind: "unavailable" });
  expect(f.query).not.toHaveBeenCalled();
});

it("TERMS316-06 a student reads only their own terms; an administrator reads one student's", async () => {
  expect(
    await fixture({ kind: "member", current: saved }).terms.own(token),
  ).toEqual({
    kind: "ready",
    value: saved,
  });
  expect(await fixture({ kind: "member" }).terms.own(token)).toEqual({
    kind: "ready",
    value: null,
  });
  expect(await fixture().terms.own(token)).toEqual({ kind: "denied" });
  expect(await fixture({ current: saved }).terms.forStudent(token, id)).toEqual(
    {
      kind: "ready",
      value: saved,
    },
  );
  expect(await fixture().terms.forStudent(token, "nope")).toEqual({
    kind: "invalid",
  });
  expect(await fixture({ kind: "member" }).terms.forStudent(token, id)).toEqual(
    {
      kind: "denied",
    },
  );
});

it("TERMS316-01/06 show the terms read-only to the student and with a prefilled form to an administrator", () => {
  const member = text(memberTermsSection(saved));
  for (const shown of [
    "Your coaching terms",
    "Price CAD 1,200.00",
    "Coaching period December 1, 2026 to May 31, 2027",
    "Renewal date June 1, 2027",
    "Expert review time 120 minutes",
    "Coaching sessions 6",
    "AI requests 200",
    "Your coaching price covers these allowances.",
    "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io.",
  ])
    expect(member).toContain(shown);
  expect(memberTermsSection(saved)).not.toContain("<form");
  expect(text(memberTermsSection(null))).toContain(
    "Your administrator hasn't set your coaching terms yet.",
  );
  const admin = adminTermsSection(saved, "/operator/coaching/x/terms", "<i>");
  expect(text(admin)).toContain("Current terms, version 1:");
  expect(admin).toContain(
    '<form method="post" action="/operator/coaching/x/terms"><i>',
  );
  expect(admin).toContain(
    'name="price" inputmode="decimal" value="1200.00" required',
  );
  expect(admin).toContain(
    'name="aiRequests" type="number" min="0" max="1000000" step="1" value="200" required',
  );
  const empty = adminTermsSection(null, "/a", "");
  expect(text(empty)).toContain("No coaching terms are set for this student.");
  expect(empty).toContain('name="price" inputmode="decimal" value="" required');
});

const overview = {
  ownerId: id,
  month: "2026-10",
  today: "2026-10",
  rates: [],
  rate: null,
  rateVersion: 0,
  entry: null,
  months: [],
  sample: true,
};
function routes(terms?: Partial<CoachingTermsStore>) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  const invoices = {
    coachingDashboard: vi.fn().mockResolvedValue({
      kind: "ready",
      value: {
        month: "2026-10",
        today: "2026-10",
        contractors: [],
        summary: {
          submittedMinutes: 0,
          contractorsSubmitted: 0,
          awaitingReview: 0,
          oldestWaitingDays: null,
          invoicedCents: 0,
          invoicesNotSent: 0,
          outstandingCents: 0,
        },
      },
    }),
    adminOverview: vi.fn().mockResolvedValue({
      kind: "ready",
      value: { members: [], coachingPending: [] },
    }),
    coachingOverview: vi
      .fn()
      .mockResolvedValue({ kind: "ready", value: overview }),
  };
  mountCoachingRoutes(app, invoices as unknown as SimpleInvoiceStore, {
    origin,
    secret,
    billingProfiles: {
      read: vi.fn().mockResolvedValue({ kind: "ready", value: null }),
      // #796: a new month starts from the saved or registered recipient.
      suggest: vi.fn().mockResolvedValue({
        kind: "ready",
        value: { name: "", email: "", company: null, revision: 0 },
      }),
    } as never,
    coachingTerms: terms as CoachingTermsStore | undefined,
  });
  return {
    get: (path: string) => withLoopback(app, (s) => request(s).get(path)),
    post: (fields: Record<string, string>) =>
      withLoopback(app, (s) =>
        request(s)
          .post(`/operator/coaching/${id}/terms`)
          .set("Origin", origin)
          .type("form")
          .send({
            csrf: csrf(token, secret),
            operationId: key,
            revision: "0",
            ...form,
            ...fields,
          }),
      ),
  };
}

it("TERMS316-01/05/06 routes show the sections, save through the store and map every refusal", async () => {
  const store = {
    own: vi.fn().mockResolvedValue({ kind: "ready", value: saved }),
    forStudent: vi.fn().mockResolvedValue({ kind: "ready", value: null }),
    save: vi.fn().mockResolvedValue({ kind: "ready", value: { version: 1 } }),
  };
  const r = routes(store);
  expect(text((await r.get("/account/coaching")).text)).toContain(
    "Price CAD 1,200.00",
  );
  const admin = await r.get(`/operator/coaching/${id}`);
  expect(admin.text).toContain(`action="/operator/coaching/${id}/terms"`);
  expect(admin.text).toContain('name="revision" value="0"');
  store.forStudent.mockResolvedValueOnce({ kind: "ready", value: saved });
  expect((await r.get(`/operator/coaching/${id}`)).text).toContain(
    'name="revision" value="1"',
  );
  store.own.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await r.get("/account/coaching")).status).toBe(503);
  store.forStudent.mockResolvedValueOnce({ kind: "invalid" });
  expect((await r.get(`/operator/coaching/${id}`)).status).toBe(403);
  const ok = await r.post({});
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe(`/operator/coaching/${id}`);
  expect(store.save).toHaveBeenCalledWith(token, {
    ...values,
    ownerId: id,
    expectedVersion: 0,
    operationId: key,
  });
  expect((await r.post({ price: "nope" })).status).toBe(422);
  expect((await r.post({ revision: "-1" })).status).toBe(422);
  expect((await r.post({ sponsor: "x" })).status).toBe(403);
  store.save.mockResolvedValueOnce({ kind: "conflict" });
  expect((await r.post({})).status).toBe(409);
  expect(store.save).toHaveBeenCalledTimes(2);
  const off = routes();
  expect((await off.post({})).status).toBe(503);
  expect((await off.get("/account/coaching")).text).not.toContain(
    "Your coaching terms",
  );
});

// #317 owner decisions of 9 Nov 2026: renewal is the admin-set date only.
// Nothing renews or charges automatically; staff see whose date is near or past.
const due = [
  {
    ownerId: id,
    displayName: "Ada <Sample>",
    renewsOn: "2026-11-01",
    days: -8,
  },
  { ownerId: key, displayName: null, renewsOn: "2026-11-09", days: 0 },
  { ownerId: id, displayName: "Bo", renewsOn: "2026-11-10", days: 1 },
  { ownerId: key, displayName: "Cy", renewsOn: "2026-12-09", days: 30 },
];

it("RENEW317-01/02 lists renewals due to platform administrators only", async () => {
  const { terms, query } = fixture({ due });
  expect(await terms.renewalsDue(token)).toEqual({ kind: "ready", value: due });
  const sql = String(query.mock.calls.at(-1)![0]);
  expect(sql).toContain("ORDER BY owner_id,version DESC");
  expect(sql).toContain("renews_on<=d.today+30");
  expect(sql).toContain("w.deleting_at IS NULL");
  expect(sql).toContain("p.revoked_at IS NULL");
  expect(await fixture({ kind: "member" }).terms.renewalsDue(token)).toEqual({
    kind: "denied",
  });
  expect(await fixture({ role: "reviewer" }).terms.renewalsDue(token)).toEqual({
    kind: "denied",
  });
  expect(await fixture().terms.renewalsDue("bad")).toEqual({ kind: "denied" });
  expect(
    await fixture({ fail: new Error("down") }).terms.renewalsDue(token),
  ).toEqual({ kind: "unavailable" });
});

it("RENEW317-01/03 shows each renewal's state and that nothing renews automatically", () => {
  const html = renewalsSection(due, "/operator/coaching");
  const shown = text(html);
  for (const line of [
    "Renewals due",
    "Students whose renewal date has passed or is within 30 days.",
    "Nothing renews or charges automatically.",
    "Ada &lt;Sample&gt; · renewal date November 1, 2026 · 8 days overdue",
    "Name needed · renewal date November 9, 2026 · due today",
    "Bo · renewal date November 10, 2026 · due in 1 day",
    "Cy · renewal date December 9, 2026 · due in 30 days",
  ])
    expect(shown).toContain(line);
  expect(html).toContain("Ada &lt;Sample&gt;");
  expect(html).toContain(`href="/operator/coaching/${id}"`);
  expect(text(renewalsSection([{ ...due[0]!, days: -1 }], "/o"))).toContain(
    "1 day overdue",
  );
  expect(text(renewalsSection(Array(200).fill(due[0]), "/o"))).toContain(
    "Showing the first 200 students.",
  );
  expect(text(renewalsSection(due, "/o"))).not.toContain("Showing the first");
  expect(text(renewalsSection([], "/o"))).toContain(
    "No renewal dates have passed or fall within the next 30 days.",
  );
  expect(text(memberTermsSection(saved))).toContain(
    "Nothing renews or charges automatically. To renew, contact info@deepnative.io.",
  );
  expect(text(adminTermsSection(saved, "/a", ""))).toContain(
    "Nothing renews or charges automatically. To renew, save new terms with the next renewal date.",
  );
  expect(text(memberTermsSection(null))).not.toContain("To renew");
});

it("RENEW317-01/04 the administration page shows renewals due and maps a failure", async () => {
  const store = {
    renewalsDue: vi.fn().mockResolvedValue({ kind: "ready", value: due }),
  };
  const r = routes(store);
  const page = await r.get("/operator/coaching");
  expect(page.status).toBe(200);
  expect(text(page.text)).toContain("Bo · renewal date November 10, 2026");
  expect(store.renewalsDue).toHaveBeenCalledWith(token);
  store.renewalsDue.mockResolvedValueOnce({ kind: "denied" });
  expect((await r.get("/operator/coaching")).status).toBe(403);
  store.renewalsDue.mockResolvedValueOnce({ kind: "invalid" });
  expect((await r.get("/operator/coaching")).status).toBe(403);
  store.renewalsDue.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await r.get("/operator/coaching")).status).toBe(503);
  const off = await routes().get("/operator/coaching");
  expect(off.status).toBe(200);
  expect(off.text).not.toContain("Renewals due");
});
