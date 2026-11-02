import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { simpleInvoiceStore } from "../../src/simple-invoice-store.ts";
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
    settings?: { sample: boolean; issuer: string; instructions: string };
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
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
