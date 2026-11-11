import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import {
  adminAgreedSection,
  AGREED_LIST_LIMIT,
  coachingAgreedChangesStore,
  memberAgreedSection,
  parseAgreedChange,
  type AgreedChange,
  type CoachingAgreedChangesStore,
} from "../../src/coaching-agreed-changes.ts";
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

// #94 AGREED94-01..05 without a database; PostgreSQL behaviour is in
// tests/integration/coaching-agreed-changes.test.ts.
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  recordId = "33333333-3333-4333-8333-333333333333",
  token = "a".repeat(64),
  origin = "http://127.0.0.1:3000",
  secret = "agreed-unit";
const values = {
  kind: "early_release" as const,
  agreed: "Invented: coaching ends on 31 January.",
  reason: "Invented: the student is moving abroad.",
};
const form = { ...values, confirm: "agreed-change" };
const saved: AgreedChange = {
  ...values,
  recordedAt: new Date("2026-11-10T17:00:00Z"),
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
    rows?: AgreedChange[];
    earlier?: { id: string; digest: string };
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
    else if (sql.includes("FROM coaching_agreed_changes WHERE owner_id"))
      rows = o.rows ?? [];
    return { rows, rowCount: rows.length };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) => {
    if (o.fail) throw o.fail;
    return use({
      query,
      observe: async () => {},
    } as unknown as PracticeTransaction);
  });
  return { store: coachingAgreedChangesStore({} as Pool), query };
}
const input = (over: Record<string, unknown> = {}) => ({
  ...values,
  ownerId: id,
  operationId: key,
  ...over,
});
beforeEach(() => vi.clearAllMocks());

it("AGREED94-04 parses a confirmed, bounded form and refuses anything else", () => {
  expect(parseAgreedChange(form)).toEqual(values);
  expect(
    parseAgreedChange({ ...form, agreed: "  kept \n", reason: " why " }),
  ).toEqual({ kind: "early_release", agreed: "kept", reason: "why" });
  for (const kind of ["refund", "other"])
    expect(parseAgreedChange({ ...form, kind })).toMatchObject({ kind });
  for (const wrong of [
    { confirm: "yes" },
    { confirm: undefined },
    { kind: "cancel" },
    { kind: undefined },
    { agreed: "" },
    { agreed: "   " },
    { agreed: "x".repeat(1001) },
    { agreed: 12 },
    { reason: "" },
    { reason: "x".repeat(1001) },
    { reason: "bell\u0007" },
  ])
    expect(
      parseAgreedChange({ ...form, ...wrong }),
      JSON.stringify(wrong),
    ).toBeNull();
  expect(parseAgreedChange(null)).toBeNull();
});

it("AGREED94-01/02 records one change and replays the same operation; a reused operation with other content is refused", async () => {
  let f = fixture();
  const first = await f.store.record(token, input());
  expect(first).toEqual({
    kind: "ready",
    value: { id: expect.stringMatching(/^[a-f0-9-]{36}$/) },
  });
  const insert = f.query.mock.calls.find(([sql]) =>
    String(sql).startsWith("INSERT INTO coaching_agreed_changes"),
  )!;
  const digest = invoiceDigest({
    action: "agreed-change",
    ownerId: id,
    values,
  });
  expect(insert[1]).toEqual([
    expect.any(String),
    id,
    "early_release",
    values.agreed,
    values.reason,
    key,
    key,
    digest,
  ]);
  // Stored trimmed, and the digest is of the trimmed text.
  f = fixture();
  await f.store.record(token, input({ agreed: `  ${values.agreed}  ` }));
  expect(
    f.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("INSERT INTO coaching_agreed_changes"),
    )![1],
  ).toEqual(expect.arrayContaining([values.agreed, digest]));

  f = fixture({ earlier: { id: recordId, digest } });
  expect(await f.store.record(token, input())).toEqual({
    kind: "ready",
    value: { id: recordId },
  });
  expect(await f.store.record(token, input({ kind: "refund" }))).toEqual({
    kind: "conflict",
  });
  expect(
    f.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
  ).toBe(false);
});

it("AGREED94-04/05 refuses invalid input, the wrong people and failures without recording", async () => {
  for (const wrong of [
    { ownerId: "nope" },
    { operationId: "nope" },
    { kind: "cancel" },
    { agreed: "" },
    { agreed: "x".repeat(1001) },
    { reason: " " },
  ]) {
    const f = fixture();
    expect(
      await f.store.record(token, input(wrong)),
      JSON.stringify(wrong),
    ).toEqual({ kind: "invalid" });
    expect(f.query).not.toHaveBeenCalled();
  }
  expect(await fixture().store.record(token, null as never)).toEqual({
    kind: "invalid",
  });
  for (const o of [
    { kind: null },
    { kind: "member" as const },
    { role: "reviewer" },
    { student: false },
  ]) {
    const f = fixture(o);
    expect(await f.store.record(token, input()), JSON.stringify(o)).toEqual({
      kind: "denied",
    });
    expect(
      f.query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT")),
    ).toBe(false);
  }
  expect(await fixture().store.record("short", input())).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ fail: new Error("lost") }).store.record(token, input()),
  ).toEqual({ kind: "unavailable" });
  expect(
    await fixture({
      fail: new PracticeLifetimeFailure("unavailable"),
    }).store.record(token, input()),
  ).toEqual({ kind: "unavailable" });
});

it("AGREED94-03 a student reads only their own records; an administrator reads one student's", async () => {
  let f = fixture({ kind: "member", rows: [saved] });
  expect(await f.store.own(token)).toEqual({ kind: "ready", value: [saved] });
  const read = f.query.mock.calls.find(([sql]) =>
    String(sql).includes("FROM coaching_agreed_changes WHERE owner_id"),
  )!;
  // The signed-in student's own ID, and never who recorded it.
  expect(read[1]).toEqual([key]);
  expect(String(read[0])).not.toMatch(/actor_id|operation_id|digest/);
  expect(String(read[0])).toContain(`LIMIT ${AGREED_LIST_LIMIT}`);
  expect(await fixture().store.own(token)).toEqual({ kind: "denied" });

  f = fixture({ rows: [saved] });
  expect(await f.store.forStudent(token, id)).toEqual({
    kind: "ready",
    value: [saved],
  });
  expect(
    f.query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM coaching_agreed_changes WHERE owner_id"),
    )![1],
  ).toEqual([id]);
  expect(await f.store.forStudent(token, "nope")).toEqual({ kind: "invalid" });
  expect(await fixture({ kind: "member" }).store.forStudent(token, id)).toEqual(
    { kind: "denied" },
  );
  expect(await fixture({ student: false }).store.forStudent(token, id)).toEqual(
    { kind: "denied" },
  );
});

it("AGREED94-01/03 show the records read-only to the student and with a form to an administrator", () => {
  const empty = text(memberAgreedSection([]));
  expect(empty).toContain("Changes agreed with you");
  expect(empty).toContain("No cancellation or refund happens automatically.");
  expect(empty).toContain("No agreed changes are recorded.");
  expect(memberAgreedSection([])).toContain(
    '<a href="mailto:info@deepnative.io">info@deepnative.io</a>',
  );
  const rows: AgreedChange[] = [
    saved,
    {
      kind: "refund",
      agreed: "<b>CAD 100.00</b> back",
      reason: "Invented & agreed",
      recordedAt: new Date("2026-11-11T02:00:00Z"),
    },
    { ...saved, kind: "other" },
  ];
  const member = memberAgreedSection(rows);
  expect(text(member)).toContain(
    "Early release · recorded November 10, 2026 Agreed: Invented: coaching ends on 31 January. Reason: Invented: the student is moving abroad.",
  );
  // The date is the Toronto day, and member text is escaped.
  expect(text(member)).toContain("Refund · recorded November 10, 2026");
  expect(member).toContain("&lt;b&gt;CAD 100.00&lt;/b&gt; back");
  expect(member).toContain("Invented &amp; agreed");
  expect(text(member)).toContain("Other change · recorded");
  expect(member).not.toContain("<form");
  expect(member).not.toContain("Showing the latest");

  const admin = adminAgreedSection(rows, "/save", "<i>hidden</i>");
  expect(text(admin)).toContain("Changes agreed with this student");
  expect(text(admin)).toContain(
    "Recording changes nothing else: to end coaching early, also save new coaching terms with the agreed end date, and to refund, also record the refund on its invoice.",
  );
  expect(admin).toContain('<form method="post" action="/save"><i>hidden</i>');
  expect(admin).toContain('<option value="early_release">Early release');
  expect(admin).toContain('<option value="refund">Refund');
  expect(admin).toContain('<option value="other">Other change');
  expect(admin).toContain('name="confirm" value="agreed-change" required');
  expect(text(adminAgreedSection([], "/save", ""))).toContain(
    "No agreed changes are recorded for this student.",
  );
  expect(
    text(
      memberAgreedSection(
        Array.from({ length: AGREED_LIST_LIMIT }, () => saved),
      ),
    ),
  ).toContain(`Showing the latest ${AGREED_LIST_LIMIT} records.`);
});

const overview = {
  ownerId: id,
  displayName: "Invented student",
  month: "2026-10",
  today: "2026-10",
  rates: [],
  rate: null,
  rateVersion: 0,
  entry: null,
  months: [],
  sample: true,
};
function routes(agreed?: Partial<CoachingAgreedChangesStore>) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.locals.token = token;
    next();
  });
  const invoices = {
    coachingOverview: vi
      .fn()
      .mockResolvedValue({ kind: "ready", value: overview }),
  };
  mountCoachingRoutes(app, invoices as unknown as SimpleInvoiceStore, {
    origin,
    secret,
    billingProfiles: {
      suggest: vi.fn().mockResolvedValue({
        kind: "ready",
        value: { name: "", email: "", company: null, revision: 0 },
      }),
    } as never,
    agreedChanges: agreed as CoachingAgreedChangesStore | undefined,
  });
  return {
    get: (path: string) => withLoopback(app, (s) => request(s).get(path)),
    post: (fields: Record<string, string | undefined>) =>
      withLoopback(app, (s) =>
        request(s)
          .post(`/operator/coaching/${id}/agreed-change`)
          .set("Origin", origin)
          .type("form")
          .send({
            csrf: csrf(token, secret),
            operationId: key,
            ...form,
            ...fields,
          }),
      ),
  };
}

it("AGREED94-01/03/04/05 routes show the sections, record through the store and map every refusal", async () => {
  const store = {
    own: vi.fn().mockResolvedValue({ kind: "ready", value: [saved] }),
    forStudent: vi.fn().mockResolvedValue({ kind: "ready", value: [] }),
    record: vi
      .fn()
      .mockResolvedValue({ kind: "ready", value: { id: recordId } }),
  };
  const r = routes(store);
  const member = await r.get("/account/coaching");
  expect(text(member.text)).toContain("Changes agreed with you");
  expect(text(member.text)).toContain("Early release · recorded");
  expect(member.text).not.toContain("/agreed-change");
  const admin = await r.get(`/operator/coaching/${id}`);
  expect(admin.text).toContain(
    `action="/operator/coaching/${id}/agreed-change"`,
  );
  expect(store.forStudent).toHaveBeenCalledWith(token, id);
  store.own.mockResolvedValueOnce({ kind: "unavailable" });
  expect((await r.get("/account/coaching")).status).toBe(503);
  store.forStudent.mockResolvedValueOnce({ kind: "invalid" });
  expect((await r.get(`/operator/coaching/${id}`)).status).toBe(403);
  store.forStudent.mockResolvedValueOnce({ kind: "denied" });
  expect((await r.get(`/operator/coaching/${id}`)).status).toBe(403);

  const ok = await r.post({});
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe(`/operator/coaching/${id}#agreed-changes`);
  expect(store.record).toHaveBeenCalledWith(token, {
    ...values,
    ownerId: id,
    operationId: key,
  });
  expect((await r.post({ confirm: undefined })).status).toBe(422);
  expect((await r.post({ kind: "cancel" })).status).toBe(422);
  expect((await r.post({ agreed: " " })).status).toBe(422);
  expect((await r.post({ sponsor: "x" })).status).toBe(403);
  expect((await r.post({ csrf: "wrong" })).status).toBe(403);
  expect(store.record).toHaveBeenCalledTimes(1);
  store.record.mockResolvedValueOnce({ kind: "conflict" });
  expect((await r.post({})).status).toBe(409);
  store.record.mockResolvedValueOnce({ kind: "denied" });
  expect((await r.post({})).status).toBe(403);

  const off = routes();
  expect((await off.post({})).status).toBe(503);
  expect((await off.get("/account/coaching")).text).not.toContain(
    "Changes agreed with you",
  );
});
