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
  } = {},
) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes("FROM principals WHERE token_hash"))
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
    else if (sql.includes("AS month")) rows = [{ month }];
    else if (sql.includes("AS today")) rows = [{ today: month + "-31" }];
    else if (sql.includes("FROM coaching_rates")) rows = o.rates ?? [rate];
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
      (await fixture().service.coachingOverview(token, selected, owner)).kind,
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
    (await fixture().service.saveCoaching(token, { ...save, month: "2999-01" }))
      .kind,
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
  expect(
    (
      await fixture().service.submitCoaching(token, {
        ...submit,
        month: "2999-01",
      })
    ).kind,
  ).toBe("invalid");
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
        row({ state: "draft" }),
        row({ state: "draft", returned: true }),
        row({ state: "submitted" }),
        row({ state: "invoiced", invoiceId: id }),
        row({
          state: "invoiced",
          invoiceId: id,
          delivery: "sent",
          balanceCents: "0",
        }),
        row({
          state: "invoiced",
          invoiceId: id,
          delivery: "not_sent",
          balanceCents: "11000",
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
    ["submitted", null, null],
    ["voided", null, null],
    ["invoiced", true, 0],
    ["invoiced", false, 11000],
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
