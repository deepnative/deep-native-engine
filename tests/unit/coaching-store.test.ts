import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  shiftMonth,
  simpleInvoiceStore,
  type InvoiceSettings,
} from "../../src/simple-invoice-store.ts";
import {
  practiceTransaction,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { invoiceDigest } from "../../src/simple-invoice-values.ts";
import type {
  CoachingMonth,
  CoachingRate,
  CoachingSnapshot,
} from "../../src/coaching-values.ts";
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111",
  key = "22222222-2222-4222-8222-222222222222",
  token = "a".repeat(64),
  month = "2026-10",
  rate: CoachingRate = { id, effectiveMonth: month, cents: 12000, version: 1 };
const snapshot: CoachingSnapshot = {
  month,
  minutes: 90,
  rate,
  subtotalCents: 18000,
  name: "Invented",
  email: "invented@example.invalid",
  sample: true,
};
const draft: CoachingMonth = {
  month,
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  minutes: 90,
  name: snapshot.name,
  email: snapshot.email,
  state: "draft",
  revision: 1,
  submittedRevision: null,
  snapshot: null,
  invoiceId: null,
  previousInvoiceId: null,
  returnReason: null,
};
const submitted = {
  ...draft,
  state: "submitted" as const,
  revision: 2,
  submittedRevision: 2,
  snapshot,
};
const rateInput = {
    ownerId: id,
    effectiveMonth: month,
    cents: 12000,
    expectedVersion: 1,
    operationId: key,
  },
  save = {
    month,
    minutes: 90,
    name: snapshot.name,
    email: snapshot.email,
    expectedRevision: 1,
    operationId: key,
  },
  submit = {
    month,
    rateId: id,
    sample: true,
    expectedRevision: 1,
    operationId: key,
  },
  action = {
    ownerId: id,
    month,
    expectedRevision: 2,
    operationId: key,
    reason: "Correction",
    taxCents: 0,
  };
function fixture(
  o: {
    admin?: boolean;
    entry?: CoachingMonth | null;
    rates?: CoachingRate[];
    snapshot?: CoachingSnapshot | null;
    receipt?: { digest: string; result: unknown };
    activeInvoice?: boolean;
    invoice?: {
      voidReason: string | null;
      paidCents: number;
      delivery: string;
    } | null;
    settings?: InvoiceSettings;
    dashboard?: { summary: unknown; rows: unknown[] };
    studentGone?: boolean;
    overrides?: unknown[];
    schedules?: unknown[];
    lastSaved?: string;
    date?: string;
  } = {},
) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes("AS student_present"))
      rows = o.studentGone ? [] : [{ student_present: true }];
    else if (sql.includes("FROM principals WHERE token_hash"))
      rows = [
        {
          id,
          kind: o.admin ? "staff" : "member",
          expires: new Date("2099-01-01"),
        },
      ];
    else if (sql.includes("FROM authorized_staff_profiles"))
      rows = [{ role: "platform_admin" }];
    else if (sql.includes("FROM principals p JOIN learners"))
      rows = [{ expires: new Date("2099-01-01") }];
    else if (sql.includes("FROM workspaces WHERE")) rows = [{ id }];
    else if (sql.includes("FROM simple_invoice_operations"))
      rows = o.receipt ? [o.receipt] : [];
    else if (sql.includes('AS "submittedMinutes"'))
      rows = [o.dashboard?.summary];
    else if (sql.includes('AS "yearMinutes"')) rows = o.dashboard?.rows ?? [];
    else if (sql.includes("FROM coaching_billing_schedules"))
      rows = o.schedules ?? [];
    else if (sql.includes("max(period_end)"))
      rows = [{ last: o.lastSaved ?? null }];
    else if (sql.includes("AS month"))
      rows = [{ month, date: o.date ?? month + "-31" }];
    else if (sql.includes("AS today")) rows = [{ today: month + "-31" }];
    else if (sql.includes("FROM coaching_rates")) rows = o.rates ?? [rate];
    else if (sql.includes("o.reason,o.state")) rows = o.overrides ?? [];
    else if (sql.includes("FROM coaching_months"))
      rows = o.entry === null ? [] : [o.entry ?? draft];
    else if (sql.includes("FROM coaching_submissions"))
      rows = o.snapshot === null ? [] : [{ snapshot: o.snapshot ?? snapshot }];
    else if (sql.includes("FROM simple_invoices"))
      rows = sql.includes("coaching_month")
        ? o.activeInvoice
          ? [{ id }]
          : []
        : o.invoice === null
          ? []
          : [
              o.invoice ?? {
                voidReason: "Correction",
                paidCents: 0,
                delivery: "not_sent",
              },
            ];
    return { rows, rowCount: rows.length };
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe: async () => {} } as unknown as PracticeTransaction),
  );
  return {
    service: simpleInvoiceStore(
      {} as Pool,
      o.settings ?? {
        sample: true,
        issuer: "Invented",
        instructions: "Sample only",
      },
    ),
    query,
  };
}
beforeEach(() => vi.clearAllMocks());
it("HOUR02 overview shows inherited current rates and saved state privately, with no guessed missing rate", async () => {
  for (const [selected, owner] of [
    [undefined, undefined],
    [month, undefined],
    [month, id],
  ] as const)
    expect(
      (
        await fixture({ admin: !!owner }).service.coachingOverview(
          token,
          selected,
          owner,
        )
      ).kind,
    ).toBe("ready");
  const old = { ...rate, effectiveMonth: "2026-01", version: 2 },
    future = { ...rate, effectiveMonth: "2027-01", version: 3 };
  const f = fixture({ rates: [future, old, rate], entry: submitted });
  const result = await f.service.coachingOverview(token);
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.value.rate).toEqual(rate);
  const none = await fixture({
    rates: [],
    entry: null,
  }).service.coachingOverview(token);
  if (none.kind === "ready") {
    expect(none.value.rate).toBeNull();
    expect(none.value.rateVersion).toBe(0);
  }
  expect(
    (
      await fixture({
        rates: [{ ...rate, version: 2 }, rate],
      }).service.coachingOverview(token)
    ).kind,
  ).toBe("ready");
  expect(
    (
      await fixture({
        entry: submitted,
        snapshot: null,
      }).service.coachingOverview(token)
    ).kind,
  ).toBe("ready");
  for (const [selected, owner] of [
    ["bad", undefined],
    [month, "bad"],
    ["2999-01", undefined],
  ])
    expect(
      (
        await fixture({ entry: null }).service.coachingOverview(
          token,
          selected,
          owner,
        )
      ).kind,
    ).toBe("invalid");
});
it("HOUR02/06 rate changes are positive, version-bound and original-operation recoverable", async () => {
  expect(
    (await fixture({ admin: true }).service.setCoachingRate(token, rateInput))
      .kind,
  ).toBe("ready");
  expect(
    (
      await fixture({ admin: true, rates: [] }).service.setCoachingRate(token, {
        ...rateInput,
        expectedVersion: 0,
      })
    ).kind,
  ).toBe("ready");
  expect(
    (
      await fixture({ admin: true }).service.setCoachingRate(token, {
        ...rateInput,
        expectedVersion: 0,
      })
    ).kind,
  ).toBe("conflict");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-rate", input: rateInput }),
    result: { rateId: id, version: 2 },
  };
  expect(
    await fixture({ admin: true, receipt }).service.setCoachingRate(
      token,
      rateInput,
    ),
  ).toEqual({ kind: "ready", value: receipt.result });
  for (const change of [
    null,
    { ownerId: "bad" },
    { operationId: "bad" },
    { effectiveMonth: "bad" },
    { cents: -1 },
    { cents: 0 },
    { expectedVersion: -1 },
  ])
    expect(
      (
        await fixture().service.setCoachingRate(
          token,
          change === null ? (null as never) : { ...rateInput, ...change },
        )
      ).kind,
    ).toBe("invalid");
});
it("HOUR03/05 draft saving preserves exact duration/recipient, rejects closed or stale records and future months", async () => {
  expect((await fixture().service.saveCoaching(token, save)).kind).toBe(
    "ready",
  );
  expect(
    (
      await fixture({ entry: null }).service.saveCoaching(token, {
        ...save,
        expectedRevision: 0,
      })
    ).kind,
  ).toBe("ready");
  for (const entry of [submitted, { ...draft, revision: 3 }])
    expect(
      (await fixture({ entry }).service.saveCoaching(token, save)).kind,
    ).toBe("conflict");
  expect(
    (
      await fixture({ entry: null }).service.saveCoaching(token, {
        ...save,
        expectedRevision: 0,
        month: "2999-01",
      })
    ).kind,
  ).toBe("invalid");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-save", input: save }),
    result: { month, revision: 2 },
  };
  expect(await fixture({ receipt }).service.saveCoaching(token, save)).toEqual({
    kind: "ready",
    value: receipt.result,
  });
  for (const change of [
    null,
    { operationId: "bad" },
    { minutes: -1 },
    { expectedRevision: -1 },
    { name: "" },
    { email: 3 },
    { email: "bad" },
  ])
    expect(
      (
        await fixture().service.saveCoaching(
          token,
          change === null ? (null as never) : ({ ...save, ...change } as never),
        )
      ).kind,
    ).toBe("invalid");
});
it("HOUR03/05/09 submission freezes accepted values and mode, rejecting stale rate/revision, missing rate and overflow", async () => {
  const f = fixture();
  expect((await f.service.submitCoaching(token, submit)).kind).toBe("ready");
  const inserted = f.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO coaching_submissions"),
  );
  expect(inserted).toBeDefined();
  expect(
    (await fixture({ entry: null }).service.submitCoaching(token, submit)).kind,
  ).toBe("not-found");
  expect(
    (await fixture({ rates: [] }).service.submitCoaching(token, submit)).kind,
  ).toBe("unavailable");
  for (const o of [
    { entry: submitted },
    { entry: { ...draft, revision: 2 } },
    { rates: [{ ...rate, id: key }] },
    { settings: { sample: false, issuer: "Issuer", instructions: "Offline" } },
  ])
    expect((await fixture(o).service.submitCoaching(token, submit)).kind).toBe(
      "conflict",
    );
  expect(
    (
      await fixture({
        entry: { ...draft, minutes: 44640 },
        rates: [{ ...rate, cents: 1000000000 }],
      }).service.submitCoaching(token, submit)
    ).kind,
  ).toBe("invalid");
  // A month that has not started has no saved hours to submit.
  expect(
    (
      await fixture({ entry: null }).service.submitCoaching(token, {
        ...submit,
        month: "2999-01",
      })
    ).kind,
  ).toBe("not-found");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-submit", input: submit }),
    result: { month, revision: 2 },
  };
  expect(
    await fixture({ receipt }).service.submitCoaching(token, submit),
  ).toEqual({ kind: "ready", value: receipt.result });
  for (const change of [
    null,
    { month: "bad" },
    { rateId: "bad" },
    { sample: "true" },
    { expectedRevision: -1 },
    { operationId: "bad" },
  ])
    expect(
      (
        await fixture().service.submitCoaching(
          token,
          change === null
            ? (null as never)
            : ({ ...submit, ...change } as never),
        )
      ).kind,
    ).toBe("invalid");
});
it("HOUR08 return permits only current unissued or safely voided unpaid snapshots", async () => {
  for (const entry of [
    submitted,
    { ...submitted, state: "invoiced" as const, invoiceId: id },
  ])
    expect(
      (
        await fixture({ admin: true, entry }).service.returnCoaching(
          token,
          action,
        )
      ).kind,
    ).toBe("ready");
  expect(
    (
      await fixture({ admin: true, entry: null }).service.returnCoaching(
        token,
        action,
      )
    ).kind,
  ).toBe("not-found");
  for (const entry of [draft, { ...submitted, revision: 3 }])
    expect(
      (
        await fixture({ admin: true, entry }).service.returnCoaching(
          token,
          action,
        )
      ).kind,
    ).toBe("conflict");
  for (const invoice of [
    null,
    { voidReason: null, paidCents: 0, delivery: "not_sent" },
    { voidReason: "Void", paidCents: 1, delivery: "not_sent" },
    { voidReason: "Void", paidCents: 0, delivery: "sending" },
    { voidReason: "Void", paidCents: 0, delivery: "unconfirmed" },
  ])
    expect(
      (
        await fixture({
          admin: true,
          entry: { ...submitted, state: "invoiced", invoiceId: id },
          invoice,
        }).service.returnCoaching(token, action)
      ).kind,
    ).toBe("conflict");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-return", input: action }),
    result: { month, revision: 3 },
  };
  expect(
    await fixture({ admin: true, receipt }).service.returnCoaching(
      token,
      action,
    ),
  ).toEqual({ kind: "ready", value: receipt.result });
  for (const change of [
    null,
    { ownerId: "bad" },
    { month: "bad" },
    { expectedRevision: -1 },
    { operationId: "bad" },
    { reason: "" },
  ])
    expect(
      (
        await fixture().service.returnCoaching(
          token,
          change === null ? (null as never) : { ...action, ...change },
        )
      ).kind,
    ).toBe("invalid");
});
it("HOUR04/06/09 exact issuance requires positive subtotal, explicit bounded tax, issuer and matching accepted mode", async () => {
  expect(
    (
      await fixture({ admin: true, entry: submitted }).service.issueCoaching(
        token,
        action,
      )
    ).kind,
  ).toBe("ready");
  expect(
    (
      await fixture({ admin: true, entry: null }).service.issueCoaching(
        token,
        action,
      )
    ).kind,
  ).toBe("not-found");
  for (const o of [
    { entry: draft },
    { entry: { ...submitted, revision: 3 } },
    { entry: submitted, snapshot: null },
    { entry: submitted, snapshot: { ...snapshot, sample: false } },
    { entry: submitted, activeInvoice: true },
  ])
    expect(
      (
        await fixture({ admin: true, ...o }).service.issueCoaching(
          token,
          action,
        )
      ).kind,
    ).toBe("conflict");
  for (const o of [
    { snapshot: { ...snapshot, subtotalCents: 0 } },
    { snapshot: { ...snapshot, subtotalCents: 1000000000 } },
    { settings: { sample: true, issuer: "", instructions: "Okay" } },
    { settings: { sample: true, issuer: "Okay", instructions: "" } },
  ])
    expect(
      (
        await fixture({
          admin: true,
          entry: submitted,
          ...o,
        }).service.issueCoaching(token, { ...action, taxCents: 1 })
      ).kind,
    ).toBe("invalid");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-issue", input: action }),
    result: { invoiceId: id },
  };
  expect(
    await fixture({ admin: true, receipt }).service.issueCoaching(
      token,
      action,
    ),
  ).toEqual({ kind: "ready", value: receipt.result });
  for (const change of [
    null,
    { ownerId: "bad" },
    { month: "bad" },
    { expectedRevision: -1 },
    { taxCents: -1 },
    { operationId: "bad" },
  ])
    expect(
      (
        await fixture().service.issueCoaching(
          token,
          change === null ? (null as never) : { ...action, ...change },
        )
      ).kind,
    ).toBe("invalid");
});

it("DASH-01/02 maps one month's records to manager figures and contractor statuses", async () => {
  const row = (over: Record<string, unknown>) => ({
    id,
    displayName: "Invented",
    rateCents: 9500,
    minutes: 60,
    previousMinutes: null,
    yearMinutes: 60,
    state: null,
    returned: false,
    invoiceId: null,
    delivery: null,
    balanceCents: null,
    ...over,
  });
  const f = fixture({
    admin: true,
    dashboard: {
      summary: {
        submittedMinutes: 285,
        contractorsSubmitted: 3,
        invoicedCents: "16000",
        invoicesNotSent: 1,
        outstandingCents: "11000",
        awaitingReview: 2,
        oldestWaitingDays: null,
      },
      rows: [
        row({}),
        row({ state: "draft", periodKey: "2026-09-07", scheduled: true }),
        row({ state: "draft", returned: true, periodKey: "2026-09" }),
        row({ state: null, scheduled: true }),
        row({ state: "submitted" }),
        row({ state: "invoiced", invoiceId: id }),
        row({
          state: "invoiced",
          invoiceId: id,
          delivery: "sent",
          balanceCents: "0",
          notSent: 0,
        }),
        row({
          state: "invoiced",
          invoiceId: id,
          delivery: "not_sent",
          balanceCents: "11000",
          notSent: 1,
        }),
      ],
    },
  });
  const result = await f.service.coachingDashboard(token, "2026-09");
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.value.month).toBe("2026-09");
  expect(result.value.summary).toEqual({
    submittedMinutes: 285,
    contractorsSubmitted: 3,
    invoicedCents: 16000,
    invoicesNotSent: 1,
    outstandingCents: 11000,
    awaitingReview: 2,
    oldestWaitingDays: null,
  });
  expect(
    result.value.contractors.map((c) => [c.status, c.sent, c.balanceCents]),
  ).toEqual([
    ["not_started", null, null],
    ["draft", null, null],
    ["returned", null, null],
    ["not_started", null, null],
    ["submitted", null, null],
    ["voided", null, null],
    ["invoiced", true, 0],
    ["invoiced", false, 11000],
  ]);
  // PERIOD832-08: a name opens the period shown, else the calendar month,
  // else (a student on defined periods with none here) their current period.
  expect(result.value.contractors.slice(0, 4).map((c) => c.periodKey)).toEqual([
    "2026-09",
    "2026-09-07",
    "2026-09",
    null,
  ]);
  // The previous, current and year-start months reach the contractor query.
  expect(
    f.query.mock.calls.find(([sql]) => sql.includes('AS "yearMinutes"'))?.[1],
  ).toEqual(["2026-09", "2026-08", "2026-01"]);
  // No month means the previous calendar month; January wraps the year.
  const defaulted = await f.service.coachingDashboard(token);
  if (defaulted.kind === "ready")
    expect(defaulted.value.month).toBe(shiftMonth(month, -1));
  expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  expect((await f.service.coachingDashboard(token, "2999-01")).kind).toBe(
    "invalid",
  );
  f.query.mockClear();
  expect((await f.service.coachingDashboard(token, "2026-13")).kind).toBe(
    "invalid",
  );
  expect(f.query).not.toHaveBeenCalled();
  expect(
    (await fixture().service.coachingDashboard(token, "2026-09")).kind,
  ).toBe("denied");
});

it("ISSUER-03 computes HST on a configured coaching invoice and refuses a typed tax", async () => {
  const settings = {
      sample: false,
      issuer: "Deep Native Inc. · Ontario, Canada",
      instructions: "Invented offline instructions",
      tax: {
        label: "HST" as const,
        registration: "713254472RT0001",
        rateBasisPoints: 1300,
      },
    },
    real = { ...snapshot, sample: false },
    entry = { ...submitted, snapshot: real },
    computed = { ...action, taxCents: undefined };
  expect(
    (
      await fixture({
        admin: true,
        entry,
        snapshot: real,
        settings,
      }).service.issueCoaching(token, action)
    ).kind,
  ).toBe("invalid");
  const f = fixture({ admin: true, entry, snapshot: real, settings });
  expect((await f.service.issueCoaching(token, computed)).kind).toBe("ready");
  const write = f.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO simple_invoices"),
  )!;
  // 13% of CAD 180.00.
  expect(JSON.parse(write[1]![2] as string)).toMatchObject({
    taxCents: 2340,
    tax: settings.tax,
  });
  expect(write[1]![4]).toBe(18000 + 2340);
});

it("RECIPIENT-03/05 a saved draft keeps an optional company, updates the reusable recipient and carries the company to the invoice", async () => {
  const sql = (f: ReturnType<typeof fixture>, start: string) =>
    f.query.mock.calls.find(([text]) => text.startsWith(start));
  const f = fixture({ entry: null });
  expect(
    (
      await f.service.saveCoaching(token, {
        ...save,
        expectedRevision: 0,
        company: "  Invented Co  ",
      })
    ).kind,
  ).toBe("ready");
  expect(sql(f, "INSERT INTO coaching_months")?.[1]).toEqual([
    id,
    month,
    90,
    snapshot.name,
    snapshot.email,
    1,
    "Invented Co",
    "2026-10-01",
    "2026-10-31",
  ]);
  // The reusable recipient follows the saved draft; the sign-in email is untouched.
  expect(sql(f, "INSERT INTO billing_profiles")?.[1]).toEqual([
    id,
    snapshot.name,
    snapshot.email,
    "Invented Co",
  ]);
  expect(
    f.query.mock.calls.some(([text]) =>
      /member_email|principals SET/.test(text),
    ),
  ).toBe(false);
  for (const company of [undefined, " "]) {
    const g = fixture({ entry: null });
    await g.service.saveCoaching(token, {
      ...save,
      expectedRevision: 0,
      company,
    });
    expect(sql(g, "INSERT INTO billing_profiles")?.[1]).toEqual([
      id,
      snapshot.name,
      snapshot.email,
      null,
    ]);
  }
  for (const company of ["a".repeat(201), "Bad\u0000Co", 3])
    expect(
      (
        await fixture().service.saveCoaching(token, {
          ...save,
          company,
        } as never)
      ).kind,
    ).toBe("invalid");
  const s = fixture({ entry: { ...draft, company: "Invented Co" } });
  expect((await s.service.submitCoaching(token, submit)).kind).toBe("ready");
  expect(
    JSON.parse(sql(s, "INSERT INTO coaching_submissions")![1]![3] as string),
  ).toMatchObject({ company: "Invented Co" });
  const plain = fixture();
  await plain.service.submitCoaching(token, submit);
  expect(
    JSON.parse(
      sql(plain, "INSERT INTO coaching_submissions")![1]![3] as string,
    ),
  ).not.toHaveProperty("company");
  const i = fixture({
    admin: true,
    entry: submitted,
    snapshot: { ...snapshot, company: "Invented Co" },
  });
  expect((await i.service.issueCoaching(token, action)).kind).toBe("ready");
  expect(
    JSON.parse(sql(i, "INSERT INTO simple_invoices")![1]![2] as string),
  ).toMatchObject({ billedTo: snapshot.name, billedToCompany: "Invented Co" });
  const j = fixture({ admin: true, entry: submitted });
  await j.service.issueCoaching(token, action);
  expect(
    JSON.parse(sql(j, "INSERT INTO simple_invoices")![1]![2] as string),
  ).not.toHaveProperty("billedToCompany");
});

it("WALK44-01 an administrator's overview of a student reference no account has is not-found, before any coaching read", async () => {
  const f = fixture({ admin: true, studentGone: true });
  expect(await f.service.coachingOverview(token, month, id)).toEqual({
    kind: "not-found",
  });
  const statements = f.query.mock.calls.map(([sql]) => sql);
  expect(statements.some((sql) => sql.includes("AS student_present"))).toBe(
    true,
  );
  expect(statements.some((sql) => sql.includes("coaching_"))).toBe(false);
  // A member's own overview never asks.
  const own = fixture();
  expect((await own.service.coachingOverview(token)).kind).toBe("ready");
  expect(
    own.query.mock.calls.some(([sql]) => sql.includes("AS student_present")),
  ).toBe(false);
});
it("DRAFTEMAIL-01/02 saves hours without an invoice email, keeps the reusable recipient and refuses to submit until one is given", async () => {
  const f = fixture();
  expect(
    (await f.service.saveCoaching(token, { ...save, email: "  " })).kind,
  ).toBe("ready");
  const month = f.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO coaching_months"),
  );
  expect(month?.[1]?.[4]).toBe("");
  // No email yet: the reusable billing recipient is left as it was.
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO billing_profiles"),
    ),
  ).toBe(false);
  const g = fixture({ entry: { ...draft, email: "" } });
  expect((await g.service.submitCoaching(token, submit)).kind).toBe("invalid");
  expect(
    g.query.mock.calls.some(([sql]) =>
      sql.startsWith("INSERT INTO coaching_submissions"),
    ),
  ).toBe(false);
});

const override = {
  ownerId: id,
  month,
  minutes: 60,
  reason: "Two sessions were cancelled",
  expectedRevision: 1,
  operationId: key,
};
it("OVR832-02/03/04/05/06 an administrator changes only saved, uninvoiced hours at the current revision, with a reason and a different figure", async () => {
  const f = fixture({ admin: true });
  expect(await f.service.overrideCoachingHours(token, override)).toEqual({
    kind: "ready",
    value: { month, revision: 2 },
  });
  const sql = f.query.mock.calls.map(([text]) => text);
  // A draft has no submitted snapshot to replace, and no period is created.
  expect(sql.some((q) => q.includes("INSERT INTO coaching_submissions"))).toBe(
    false,
  );
  expect(sql.some((q) => q.includes("INSERT INTO coaching_months"))).toBe(
    false,
  );
  expect(
    f.query.mock.calls.find(([q]) =>
      q.startsWith("UPDATE coaching_months"),
    )![1],
  ).toEqual([id, month, 60, 2]);
  expect(
    f.query.mock.calls
      .find(([q]) => q.includes("INSERT INTO coaching_hours_overrides"))![1]!
      .slice(1),
  ).toEqual([id, month, 90, 60, override.reason, "draft", 2, id]);
  expect(
    f.query.mock.calls.find(([q]) =>
      q.includes("INSERT INTO billing_change_events"),
    )![1],
  ).toEqual([id, "hours_overridden", id, month, null]);
  expect(
    (
      await fixture({ admin: true, entry: null }).service.overrideCoachingHours(
        token,
        override,
      )
    ).kind,
  ).toBe("not-found");
  for (const entry of [
    { ...draft, revision: 2 },
    { ...submitted, state: "invoiced" as const, revision: 1, invoiceId: id },
  ])
    expect(
      (
        await fixture({ admin: true, entry }).service.overrideCoachingHours(
          token,
          override,
        )
      ).kind,
    ).toBe("conflict");
  // The same figure is not a change.
  expect(
    (
      await fixture({ admin: true }).service.overrideCoachingHours(token, {
        ...override,
        minutes: 90,
      })
    ).kind,
  ).toBe("invalid");
  for (const change of [
    null,
    { ownerId: "bad" },
    { month: "bad" },
    { minutes: -1 },
    { minutes: 31 * 24 * 60 + 1 },
    { expectedRevision: -1 },
    { operationId: "bad" },
    { reason: " " },
    { reason: "x".repeat(501) },
  ])
    expect(
      (
        await fixture({ admin: true }).service.overrideCoachingHours(
          token,
          change === null ? (null as never) : { ...override, ...change },
        )
      ).kind,
    ).toBe("invalid");
  // A student token is not an administrator.
  expect(
    (await fixture().service.overrideCoachingHours(token, override)).kind,
  ).toBe("denied");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-override", input: override }),
    result: { month, revision: 2 },
  };
  expect(
    await fixture({ admin: true, receipt }).service.overrideCoachingHours(
      token,
      override,
    ),
  ).toEqual({ kind: "ready", value: receipt.result });
});
it("OVR832-01 changing submitted hours appends a snapshot at the rate the student confirmed and keeps the month awaiting review", async () => {
  const input = { ...override, expectedRevision: 2 };
  const f = fixture({ admin: true, entry: submitted });
  expect(await f.service.overrideCoachingHours(token, input)).toEqual({
    kind: "ready",
    value: { month, revision: 3 },
  });
  const appended = f.query.mock.calls.find(([q]) =>
    q.includes("INSERT INTO coaching_submissions"),
  )![1]!;
  expect(appended.slice(0, 3)).toEqual([id, month, 3]);
  expect(JSON.parse(appended[3] as string)).toEqual({
    ...snapshot,
    minutes: 60,
    subtotalCents: 12000,
  });
  expect(
    f.query.mock.calls.find(([q]) =>
      q.startsWith("UPDATE coaching_months"),
    )![0],
  ).toContain("submitted_revision=CASE WHEN state='submitted' THEN $4");
  expect(
    f.query.mock.calls
      .find(([q]) => q.includes("INSERT INTO coaching_hours_overrides"))![1]!
      .slice(3, 8),
  ).toEqual([90, 60, override.reason, "submitted", 3]);
  // A submitted month with no retained snapshot, or an amount beyond the
  // invoice limit, is refused.
  expect(
    (
      await fixture({
        admin: true,
        entry: submitted,
        snapshot: null,
      }).service.overrideCoachingHours(token, input)
    ).kind,
  ).toBe("conflict");
  expect(
    (
      await fixture({
        admin: true,
        entry: submitted,
        snapshot: { ...snapshot, rate: { ...rate, cents: 1000000000 } },
      }).service.overrideCoachingHours(token, { ...input, minutes: 600 })
    ).kind,
  ).toBe("invalid");
});
it("OVR832-07 the overview lists each change for the month, naming the administrator only to administrators", async () => {
  const row = {
    previousMinutes: 90,
    minutes: 60,
    reason: override.reason,
    state: "draft",
    changedAt: new Date("2026-11-12T12:00:00Z"),
    actorName: null,
  };
  for (const admin of [false, true]) {
    const f = fixture({ admin, overrides: [row] });
    const r = await f.service.coachingOverview(
      token,
      month,
      admin ? id : undefined,
    );
    if (r.kind !== "ready") throw Error("Expected overview");
    expect(r.value.overrides).toEqual([row]);
    expect(
      f.query.mock.calls.find(([q]) => q.includes("o.reason,o.state"))![1],
    ).toEqual([id, month, admin]);
  }
});

// #832 slice B: administrator-defined billing periods. Two weeks from
// Monday 5 October 2026; "today" is 20 October unless a case says otherwise.
const twoWeeks = {
    version: 1,
    unit: "days",
    days: 14,
    startsOn: "2026-10-05",
    setOn: "2026-10-01",
  },
  today = "2026-10-20",
  setting = {
    ownerId: id,
    unit: "days" as const,
    days: 14,
    startsOn: "2026-11-02",
    expectedVersion: 0,
    operationId: key,
  },
  periodDraft: CoachingMonth = {
    ...draft,
    month: "2026-10-19",
    periodStart: "2026-10-19",
    periodEnd: "2026-11-01",
  };
it("PERIOD832-01 the first billing period needs a start date after everything the student saved, within a year", async () => {
  const f = fixture({ admin: true, date: today, lastSaved: "2026-10-31" });
  expect(await f.service.setBillingSchedule(token, setting)).toEqual({
    kind: "ready",
    value: { version: 1, startsOn: "2026-11-02" },
  });
  expect(
    f.query.mock.calls
      .find(([q]) => q.includes("INSERT INTO coaching_billing_schedules"))![1]!
      .slice(1),
  ).toEqual([id, 1, "days", 14, "2026-11-02", id]);
  expect(
    f.query.mock.calls.find(([q]) =>
      q.includes("INSERT INTO billing_change_events"),
    )![1],
  ).toEqual([id, "billing_period_set", id, "2026-11-02", null]);
  const month = fixture({ admin: true, date: today });
  expect(
    (
      await month.service.setBillingSchedule(token, {
        ownerId: id,
        unit: "month",
        startsOn: "2026-10-15",
        expectedVersion: 0,
        operationId: key,
      })
    ).kind,
  ).toBe("ready");
  expect(
    month.query.mock.calls
      .find(([q]) => q.includes("INSERT INTO coaching_billing_schedules"))![1]!
      .slice(3, 6),
  ).toEqual(["month", null, "2026-10-15"]);
  for (const startsOn of [
    undefined,
    "2026-10-31",
    "2026-10-01",
    "2025-10-18",
    "2027-10-22",
  ])
    expect(
      (
        await fixture({
          admin: true,
          date: today,
          lastSaved: "2026-10-31",
        }).service.setBillingSchedule(token, { ...setting, startsOn })
      ).kind,
    ).toBe("invalid");
  for (const change of [
    null,
    { ownerId: "bad" },
    { operationId: "bad" },
    { expectedVersion: -1 },
    { days: 0 },
    { days: 32 },
    { days: 1.5 },
    { days: undefined },
    { unit: "week" },
    { unit: "month" },
    { startsOn: "2026-02-30" },
    { startsOn: "2026-11" },
  ])
    expect(
      (
        await fixture({ admin: true, date: today }).service.setBillingSchedule(
          token,
          change === null
            ? (null as never)
            : ({ ...setting, ...change } as never),
        )
      ).kind,
    ).toBe("invalid");
  expect(
    (
      await fixture({
        admin: true,
        date: today,
        schedules: [twoWeeks],
      }).service.setBillingSchedule(token, setting)
    ).kind,
  ).toBe("conflict");
  expect(
    (await fixture().service.setBillingSchedule(token, setting)).kind,
  ).toBe("denied");
  const receipt = {
    digest: invoiceDigest({ action: "coaching-period", input: setting }),
    result: { version: 1, startsOn: "2026-11-02" },
  };
  expect(
    await fixture({ admin: true, receipt }).service.setBillingSchedule(
      token,
      setting,
    ),
  ).toEqual({ kind: "ready", value: receipt.result });
});
it("PERIOD832-04 once periods have started only the length changes, from the day after the current period", async () => {
  const started = () =>
    fixture({ admin: true, date: today, schedules: [twoWeeks] });
  const weekly = {
    ownerId: id,
    unit: "days" as const,
    days: 7,
    expectedVersion: 1,
    operationId: key,
  };
  // 20 October is in the period 19 October to 1 November.
  const f = started();
  expect(await f.service.setBillingSchedule(token, weekly)).toEqual({
    kind: "ready",
    value: { version: 2, startsOn: "2026-11-02" },
  });
  // No saved period is read or rewritten for a change of length.
  expect(
    f.query.mock.calls.some(
      ([q]) =>
        q.includes("max(period_end)") || q.includes("UPDATE coaching_months"),
    ),
  ).toBe(false);
  expect(
    (
      await started().service.setBillingSchedule(token, {
        ...weekly,
        startsOn: "2026-10-26",
      })
    ).kind,
  ).toBe("invalid");
  // The same length again is not a change.
  expect(
    (await started().service.setBillingSchedule(token, { ...weekly, days: 14 }))
      .kind,
  ).toBe("invalid");
  // A pending change is replaced by a newer one from the same day.
  const pending = [
    twoWeeks,
    {
      ...twoWeeks,
      version: 2,
      days: 7,
      startsOn: "2026-11-02",
      setOn: "2026-10-19",
    },
  ];
  expect(
    await fixture({
      admin: true,
      date: today,
      schedules: pending,
    }).service.setBillingSchedule(token, {
      ownerId: id,
      unit: "month",
      expectedVersion: 2,
      operationId: key,
    }),
  ).toEqual({ kind: "ready", value: { version: 3, startsOn: "2026-11-02" } });
  // Before a first period starts, the start date can still be moved, but
  // the same setting again is refused.
  const unstarted = [{ ...twoWeeks, startsOn: "2026-11-02" }];
  const again = { ...setting, expectedVersion: 1 };
  expect(
    (
      await fixture({
        admin: true,
        date: today,
        schedules: unstarted,
      }).service.setBillingSchedule(token, again)
    ).kind,
  ).toBe("invalid");
  expect(
    await fixture({
      admin: true,
      date: today,
      schedules: unstarted,
    }).service.setBillingSchedule(token, { ...again, startsOn: "2026-11-09" }),
  ).toEqual({ kind: "ready", value: { version: 2, startsOn: "2026-11-09" } });
});
it("PERIOD832-02/05 the overview opens the current period, lists started periods and refuses keys that are not the student's periods", async () => {
  const open = (selected?: string, schedules: unknown[] = [twoWeeks]) =>
    fixture({ entry: null, date: today, schedules }).service.coachingOverview(
      token,
      selected,
    );
  const current = await open();
  if (current.kind !== "ready") throw Error("Expected overview");
  expect(current.value).toMatchObject({
    month: "2026-10-19",
    date: today,
    period: {
      key: "2026-10-19",
      start: "2026-10-19",
      end: "2026-11-01",
      days: 14,
    },
    billing: { version: 1, nextStart: "2026-11-02", schedules: [twoWeeks] },
  });
  expect(current.value.periods.map((p) => p.key)).toEqual([
    "2026-10-19",
    "2026-10-05",
  ]);
  expect((await open("2026-10-05")).kind).toBe("ready");
  // Not a period start, not started yet, and a month the periods reach into.
  for (const selected of ["2026-10-12", "2026-11-02", "2026-10", "2026-11"])
    expect((await open(selected)).kind).toBe("invalid");
  // A calendar month wholly before the first period is still reportable.
  const earlier = await open("2026-09");
  expect(earlier.kind === "ready" && earlier.value.period).toEqual({
    key: "2026-09",
    start: "2026-09-01",
    end: "2026-09-30",
    days: 30,
  });
  // Saved hours keep their own dates whatever the setting says now.
  const saved = await fixture({
    entry: periodDraft,
    date: today,
    schedules: [],
  }).service.coachingOverview(token, "2026-10-19");
  expect(saved.kind === "ready" && saved.value.period).toEqual({
    key: "2026-10-19",
    start: "2026-10-19",
    end: "2026-11-01",
    days: 14,
  });
  // Before a first period starts mid-month, the opening view has no period.
  const waiting = await open(undefined, [
    { ...twoWeeks, startsOn: "2026-10-26" },
  ]);
  expect(waiting.kind === "ready" && waiting.value).toMatchObject({
    month: "2026-10",
    period: null,
    periods: [],
    billing: { nextStart: null },
  });
  // With no setting at all, the calendar month as before.
  const legacy = await open(undefined, []);
  expect(legacy.kind === "ready" && legacy.value).toMatchObject({
    month: "2026-10",
    period: { key: "2026-10", days: 31 },
    periods: [],
    billing: { version: 0, nextStart: null, schedules: [] },
  });
});
it("PERIOD832-02/06 hours are saved for a started period within its length, and submitted at the rate for its first day", async () => {
  const input = {
    ...save,
    month: "2026-10-19",
    minutes: 14 * 1440,
    expectedRevision: 0,
  };
  const f = fixture({ entry: null, date: today, schedules: [twoWeeks] });
  expect((await f.service.saveCoaching(token, input)).kind).toBe("ready");
  expect(
    f.query.mock.calls
      .find(([q]) => q.includes("INSERT INTO coaching_months"))![1]!
      .slice(-2),
  ).toEqual(["2026-10-19", "2026-11-01"]);
  for (const change of [
    { minutes: 14 * 1440 + 1 },
    { month: "2026-10-20" },
    { month: "2026-11-02" },
    { month: "2026-10" },
    { minutes: 1.5 },
  ])
    expect(
      (
        await fixture({
          entry: null,
          date: today,
          schedules: [twoWeeks],
        }).service.saveCoaching(token, { ...input, ...change })
      ).kind,
    ).toBe("invalid");
  // A saved one-day period keeps its own length.
  expect(
    (
      await fixture({
        entry: { ...periodDraft, periodEnd: "2026-10-19" },
        date: today,
      }).service.saveCoaching(token, {
        ...input,
        minutes: 1441,
        expectedRevision: 1,
      })
    ).kind,
  ).toBe("invalid");
  const s = fixture({ entry: periodDraft, date: today });
  expect(
    (await s.service.submitCoaching(token, { ...submit, month: "2026-10-19" }))
      .kind,
  ).toBe("ready");
  expect(
    s.query.mock.calls.find(
      ([q]) =>
        q.includes("FROM coaching_rates") && q.includes("effective_month<=$2"),
    )![1],
  ).toEqual([id, "2026-10"]);
  expect(
    JSON.parse(
      s.query.mock.calls.find(([q]) =>
        q.includes("INSERT INTO coaching_submissions"),
      )![1]![3] as string,
    ),
  ).toMatchObject({
    month: "2026-10-19",
    periodStart: "2026-10-19",
    periodEnd: "2026-11-01",
  });
  // An administrator's change must fit the period too.
  expect(
    (
      await fixture({
        admin: true,
        entry: { ...periodDraft, periodEnd: "2026-10-19" },
      }).service.overrideCoachingHours(token, {
        ...override,
        month: "2026-10-19",
        minutes: 1441,
      })
    ).kind,
  ).toBe("invalid");
});
it("PERIOD832-03 a defined period is invoiced only after its last day, and the invoice names its dates", async () => {
  const entry = {
    ...submitted,
    month: "2026-10-19",
    periodStart: "2026-10-19",
    periodEnd: "2026-11-01",
  };
  const input = { ...action, month: "2026-10-19" };
  const issue = input;
  for (const date of ["2026-10-20", "2026-11-01"])
    expect(
      (
        await fixture({ admin: true, entry, date }).service.issueCoaching(
          token,
          issue,
        )
      ).kind,
    ).toBe("invalid");
  const f = fixture({ admin: true, entry, date: "2026-11-02" });
  expect((await f.service.issueCoaching(token, issue)).kind).toBe("ready");
  const inserted = f.query.mock.calls.find(([q]) =>
    q.includes("INSERT INTO simple_invoices"),
  )![1]!;
  expect(inserted.at(-1)).toBe("2026-10-19");
  expect(JSON.parse(inserted[2] as string)).toMatchObject({
    lines: [{ description: "Coaching · 2026-10-19 to 2026-11-01" }],
    coaching: {
      month: snapshot.month,
      periodStart: "2026-10-19",
      periodEnd: "2026-11-01",
    },
  });
  // A calendar month is unchanged: invoiced during the month, named by month.
  const legacy = fixture({ admin: true, entry: submitted, date: today });
  const monthly = action;
  expect((await legacy.service.issueCoaching(token, monthly)).kind).toBe(
    "ready",
  );
  const document = JSON.parse(
    legacy.query.mock.calls.find(([q]) =>
      q.includes("INSERT INTO simple_invoices"),
    )![1]![2] as string,
  );
  expect(document.lines[0].description).toBe("Coaching · 2026-10");
  expect(document.coaching).not.toHaveProperty("periodStart");
  // Returning a period for correction takes its key like any other.
  expect(
    (await fixture({ admin: true, entry }).service.returnCoaching(token, input))
      .kind,
  ).toBe("ready");
});
