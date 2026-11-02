import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  simpleInvoiceStore,
  type InvoicePlan,
  type StoredInvoice,
} from "../../src/simple-invoice-store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "../../src/practice-session-lifetime.ts";
import { invoiceDigest } from "../../src/simple-invoice-values.ts";
vi.mock("../../src/practice-session-lifetime.ts", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/practice-session-lifetime.ts")
  >("../../src/practice-session-lifetime.ts")),
  practiceTransaction: vi.fn(),
}));
const ownerId = "11111111-1111-4111-8111-111111111111",
  planId = "22222222-2222-4222-8222-222222222222",
  invoiceId = "33333333-3333-4333-8333-333333333333",
  operationId = "44444444-4444-4444-8444-444444444444";
const member = "a".repeat(64),
  admin = "b".repeat(64),
  expiry = new Date("2099-01-01");
const terms = {
  courses: [
    {
      id: "FND-001",
      version: 2,
      description: "Checking claims",
      amountCents: 1000,
    },
  ],
  cadence: "monthly" as const,
  startsOn: "2026-10-31",
  taxCents: 100,
  issuer: "Invented issuer",
  instructions: "Sample only",
  sample: true,
};
const plan: InvoicePlan = {
  id: planId,
  ownerId,
  terms,
  state: "offered",
  revision: 1,
  nextCycle: 1,
};
const invoice: StoredInvoice = {
  id: invoiceId,
  document: {
    number: "DN-invented",
    issuedOn: "2026-10-31",
    issuer: terms.issuer,
    billedTo: "Invented student",
    lines: [{ description: "Checking claims", amountCents: 1000 }],
    billing: { kind: "one_time" },
    currency: "CAD",
    taxCents: 100,
    paidCents: 0,
    instructions: terms.instructions,
    sample: true,
  },
  totalCents: 1100,
  paidCents: 0,
  revision: 1,
  delivery: "not_sent",
  voidReason: null,
};
const proposal = {
  ownerId,
  operationId,
  courses: [{ id: "FND-001", version: 2, amountCents: 1000 }],
  cadence: "monthly" as const,
  startsOn: "2026-10-31",
  taxCents: 100,
};
const acceptance = {
  planId,
  operationId,
  expectedRevision: 1,
  name: "Invented student",
  email: "invented@example.invalid",
};
const payment = {
  invoiceId,
  operationId,
  expectedRevision: 1,
  amountCents: 100,
  receivedOn: "2026-10-31",
};
const action = { invoiceId, operationId, expectedRevision: 1 };
function fixture(
  options: {
    actor?: boolean;
    wrongKind?: boolean;
    role?: string | null;
    owner?: boolean;
    workspace?: boolean;
    receipt?: { digest: string; result: unknown };
    plan?: InvoicePlan | null;
    invoice?: StoredInvoice | null;
    source?: boolean;
    eligible?: boolean;
    today?: string;
    fail?: boolean;
    lifetime?: boolean;
    receiptExists?: boolean;
    updated?: boolean;
    due?: boolean;
    lease?: boolean;
    activeAgreement?: boolean;
  } = {},
) {
  const result = (rows: unknown[], rowCount = rows.length) => ({
    rows,
    rowCount,
  });
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (options.fail) throw Error("Private driver detail");
    if (sql.includes("FROM principals WHERE token_hash"))
      return result(
        options.actor === false
          ? []
          : [
              {
                id: ownerId,
                kind: options.wrongKind
                  ? "other"
                  : values?.[0] === awaitHash(admin)
                    ? "staff"
                    : "member",
                expires: expiry,
              },
            ],
      );
    if (sql.includes("FROM authorized_staff_profiles"))
      return result(
        options.role === null
          ? []
          : [{ role: options.role ?? "platform_admin" }],
      );
    if (sql.includes("FROM principals p JOIN learners"))
      return result(options.owner === false ? [] : [{ expires: expiry }]);
    if (sql.includes("FROM workspaces WHERE"))
      return result(options.workspace === false ? [] : [{ id: ownerId }]);
    if (sql.includes("FROM simple_invoice_operations")) {
      if (sql.startsWith("SELECT 1"))
        return result(options.receiptExists === false ? [] : [{}]);
      if (sql.startsWith("SELECT result"))
        return result(
          options.receipt ? [{ result: options.receipt.result }] : [],
        );
      return result(options.receipt ? [options.receipt] : []);
    }
    if (sql.includes("FROM content_versions"))
      return result(
        options.source === false ||
          (sql.includes("member_content_eligible") &&
            options.eligible === false)
          ? []
          : [{ id: "FND-001", version: 2, title: "Checking claims" }],
      );
    if (sql.includes("AS today"))
      return result([{ today: options.today ?? "2026-10-31" }]);
    if (sql.includes("FROM simple_invoice_plans b"))
      return result(options.due ? [{ id: planId, owner_id: ownerId }] : []);
    if (sql.startsWith("SELECT 1 FROM simple_invoice_plans"))
      return result(options.activeAgreement ? [{}] : []);
    if (sql.includes("FROM simple_invoice_plans WHERE"))
      return result(
        options.plan === null
          ? []
          : [
              {
                ...plan,
                ...options.plan,
                name: "Invented student",
                email: "invented@example.invalid",
              },
            ],
      );
    if (sql.includes("FROM simple_invoices WHERE"))
      return result(
        options.invoice === null ? [] : [options.invoice ?? invoice],
      );
    if (sql.includes("FROM learners l JOIN workspaces"))
      return result([{ id: ownerId }]);
    if (sql.includes("FROM simple_invoices ORDER"))
      return result([{ id: invoiceId, revision: 1, delivery: "not_sent" }]);
    if (sql.includes("FROM coaching_months WHERE state")) return result([]);
    if (sql.includes("interval '10 seconds'"))
      return result(options.lease === false ? [] : [{ expires: expiry }]);
    if (sql.startsWith("INSERT") || sql.startsWith("UPDATE"))
      return result(options.updated === false ? [] : [{ id: invoiceId }]);
    throw Error("Unexpected database interaction: " + sql);
  });
  const observe = vi.fn(async () => {
    if (options.lifetime) throw new PracticeLifetimeFailure("denied");
  });
  vi.mocked(practiceTransaction).mockImplementation(async (_pool, use) =>
    use({ query, observe } as unknown as PracticeTransaction),
  );
  return {
    service: simpleInvoiceStore({} as Pool, {
      sample: true,
      issuer: terms.issuer,
      instructions: terms.instructions,
    }),
    query,
    observe,
  };
}
// Original bearer hashes, not a fixture-specific replacement identity.
import { hash as awaitHash } from "../../src/store.ts";
beforeEach(() => vi.clearAllMocks());
it("OFFPUR-05 requires the original current member or billing administrator and an available workspace", async () => {
  for (const options of [
    { actor: false },
    { wrongKind: true },
    { lifetime: true },
    { owner: false },
    { workspace: false },
  ]) {
    const f = fixture(options);
    expect((await f.service.overview(member)).kind).toBe("denied");
  }
  for (const role of ["reviewer", null])
    expect((await fixture({ role }).service.adminOverview(admin)).kind).toBe(
      "denied",
    );
  for (const token of ["", 1, null])
    expect((await fixture().service.overview(token as string)).kind).toBe(
      "denied",
    );
  expect((await fixture({ fail: true }).service.overview(member)).kind).toBe(
    "unavailable",
  );
  const f = fixture();
  expect((await f.service.overview(member)).kind).toBe("ready");
  expect(f.observe).toHaveBeenCalledWith([expiry]);
  expect((await f.service.adminOverview(admin)).kind).toBe("ready");
});
it("OFFPUR-01/08 prepares exact eligible course terms and rejects changed, missing or malformed proposals", async () => {
  const f = fixture();
  expect((await f.service.propose(admin, proposal)).kind).toBe("ready");
  const write = f.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO simple_invoice_plans"),
  )!;
  expect(JSON.parse(write[1]![2] as string)).toEqual(terms);
  for (const options of [
    { source: false },
    { eligible: false },
    { today: "2026-11-01" },
  ])
    expect((await fixture(options).service.propose(admin, proposal)).kind).toBe(
      options.source === false ? "invalid" : "conflict",
    );
  for (const change of [
    { courses: [] },
    { courses: [{ ...proposal.courses[0], id: "" }] },
    { courses: [{ ...proposal.courses[0], version: 0 }] },
    { courses: [{ ...proposal.courses[0], amountCents: -1 }] },
    { cadence: "weekly" },
    { taxCents: -1 },
    { ownerId: "bad" },
    { operationId: "bad" },
  ])
    expect(
      (
        await f.service.propose(admin, {
          ...proposal,
          ...change,
        } as typeof proposal)
      ).kind,
    ).toBe("invalid");
  expect(
    (await f.service.propose(admin, null as unknown as typeof proposal)).kind,
  ).toBe("invalid");
});
it("OFFPUR-03 preserves the original proposal result and refuses another intent with the same operation", async () => {
  const receipt = {
    digest: invoiceDigest({ action: "propose", input: proposal }),
    result: { planId },
  };
  expect(await fixture({ receipt }).service.propose(admin, proposal)).toEqual({
    kind: "ready",
    value: { planId },
  });
  expect(
    (
      await fixture({
        receipt: { ...receipt, digest: "different" },
      }).service.propose(admin, proposal)
    ).kind,
  ).toBe("conflict");
});
it("OFFPUR-08/09 issues one immutable accepted invoice and never accepts stale or unavailable courses", async () => {
  expect(
    (
      await fixture({ activeAgreement: true }).service.accept(
        member,
        acceptance,
      )
    ).kind,
  ).toBe("conflict");
  const f = fixture();
  expect((await f.service.accept(member, acceptance)).kind).toBe("ready");
  const write = f.query.mock.calls.find(([sql]) =>
    sql.startsWith("INSERT INTO simple_invoices"),
  )!;
  const doc = JSON.parse(write[1]![4] as string);
  expect(doc.billedTo).toBe(acceptance.name);
  expect(doc.lines).toEqual([
    { description: "Checking claims · FND-001 version 2", amountCents: 1000 },
  ]);
  expect(doc.billing).toEqual({
    kind: "recurring",
    periodStart: "2026-10-31",
    periodEnd: "2026-11-30",
  });
  expect(
    (
      await fixture({
        plan: { ...plan, terms: { ...terms, cadence: "one_time" } },
      }).service.accept(member, acceptance)
    ).kind,
  ).toBe("ready");
  for (const options of [
    { plan: null },
    { plan: { ...plan, state: "active" as const } },
    { plan: { ...plan, revision: 2 } },
    { eligible: false },
  ])
    expect(
      (await fixture(options).service.accept(member, acceptance)).kind,
    ).toBe(options.plan === null ? "not-found" : "conflict");
  const receipt = {
    digest: invoiceDigest({ action: "accept", input: acceptance }),
    result: { invoiceId },
  };
  expect(await fixture({ receipt }).service.accept(member, acceptance)).toEqual(
    { kind: "ready", value: { invoiceId } },
  );
  for (const change of [
    { planId: "bad" },
    { operationId: "bad" },
    { expectedRevision: -1 },
    { name: "" },
    { email: "invalid" },
    { email: 2 },
  ])
    expect(
      (
        await f.service.accept(member, {
          ...acceptance,
          ...change,
        } as typeof acceptance)
      ).kind,
    ).toBe("invalid");
  expect(
    (await f.service.accept(member, null as unknown as typeof acceptance)).kind,
  ).toBe("invalid");
});
it("OFFPUR-10 cancellation is revision guarded and keeps original invoices", async () => {
  const input = { planId, operationId, expectedRevision: 1 },
    f = fixture();
  expect((await f.service.cancel(member, input)).kind).toBe("ready");
  for (const options of [
    { plan: null },
    { plan: { ...plan, state: "cancelled" as const } },
    { plan: { ...plan, revision: 2 } },
  ])
    expect((await fixture(options).service.cancel(member, input)).kind).toBe(
      options.plan === null ? "not-found" : "conflict",
    );
  expect(
    (
      await fixture({
        receipt: {
          digest: invoiceDigest({ action: "cancel", input }),
          result: { cancelled: true },
        },
      }).service.cancel(member, input)
    ).kind,
  ).toBe("ready");
  for (const change of [
    { planId: "bad" },
    { operationId: "bad" },
    { expectedRevision: -1 },
  ])
    expect((await f.service.cancel(member, { ...input, ...change })).kind).toBe(
      "invalid",
    );
  expect(
    (await f.service.cancel(member, null as unknown as typeof input)).kind,
  ).toBe("invalid");
});
it("OFFPUR-02/05 returns only the available owned invoice and operation reference", async () => {
  const f = fixture();
  expect(await f.service.invoice(member, invoiceId)).toEqual({
    kind: "ready",
    value: invoice,
  });
  expect((await f.service.invoice(admin, invoiceId, true)).kind).toBe("ready");
  expect(
    (await fixture({ invoice: null }).service.invoice(member, invoiceId)).kind,
  ).toBe("not-found");
  expect((await f.service.invoice(member, "bad")).kind).toBe("invalid");
  expect((await f.service.inspect(member, operationId)).kind).toBe("not-found");
  expect((await f.service.inspect(member, "bad")).kind).toBe("invalid");
  const receipt = { digest: "unused", result: { invoiceId } };
  expect(
    await fixture({ receipt }).service.inspect(admin, operationId, true),
  ).toEqual({ kind: "ready", value: { result: { invoiceId } } });
  expect(
    (await fixture({ receipt }).service.inspect(member, operationId)).kind,
  ).toBe("ready");
});
it("OFFPUR-04 only records bounded actual received funds against the exact current outstanding invoice", async () => {
  const f = fixture();
  expect((await f.service.pay(admin, payment)).kind).toBe("ready");
  expect(
    f.query.mock.calls
      .find(([sql]) =>
        sql.startsWith("INSERT INTO simple_invoice_payments"),
      )![1]!
      .slice(1),
  ).toEqual([invoiceId, ownerId, 100, "2026-10-31"]);
  for (const options of [
    { invoice: null },
    { invoice: { ...invoice, revision: 2 } },
    { invoice: { ...invoice, paidCents: 1100 } },
    { invoice: { ...invoice, voidReason: "Wrong course" } },
    { today: "2026-10-30" },
  ])
    expect((await fixture(options).service.pay(admin, payment)).kind).toBe(
      options.invoice === null ? "not-found" : "conflict",
    );
  const receipt = {
    digest: invoiceDigest({ action: "pay", input: payment }),
    result: { invoiceId },
  };
  expect((await fixture({ receipt }).service.pay(admin, payment)).kind).toBe(
    "ready",
  );
  for (const change of [
    { invoiceId: "bad" },
    { operationId: "bad" },
    { expectedRevision: -1 },
    { amountCents: 0 },
    { amountCents: -1 },
    { receivedOn: "2026-02-30" },
  ])
    expect((await f.service.pay(admin, { ...payment, ...change })).kind).toBe(
      "invalid",
    );
  expect(
    (await f.service.pay(admin, null as unknown as typeof payment)).kind,
  ).toBe("invalid");
});
it("OFFPUR-06 voids only an unpaid invoice and preserves receipts and uncertain delivery", async () => {
  const input = { ...action, reason: "Wrong course" },
    f = fixture();
  expect((await f.service.voidInvoice(admin, input)).kind).toBe("ready");
  for (const options of [
    { invoice: null },
    { invoice: { ...invoice, revision: 2 } },
    { invoice: { ...invoice, paidCents: 1 } },
    { invoice: { ...invoice, voidReason: "Already void" } },
    { invoice: { ...invoice, delivery: "sending" as const } },
    { invoice: { ...invoice, delivery: "unconfirmed" as const } },
  ])
    expect(
      (await fixture(options).service.voidInvoice(admin, input)).kind,
    ).toBe(options.invoice === null ? "not-found" : "conflict");
  expect(
    (
      await fixture({
        receipt: {
          digest: invoiceDigest({ action: "void", input }),
          result: { invoiceId },
        },
      }).service.voidInvoice(admin, input)
    ).kind,
  ).toBe("ready");
  for (const change of [
    { invoiceId: "bad" },
    { operationId: "bad" },
    { expectedRevision: -1 },
    { reason: "" },
  ])
    expect(
      (await f.service.voidInvoice(admin, { ...input, ...change })).kind,
    ).toBe("invalid");
  expect(
    (await f.service.voidInvoice(admin, null as unknown as typeof input)).kind,
  ).toBe("invalid");
});
it("OFFPUR-02/03 claims an email once and records confirmed versus unknown provider outcomes", async () => {
  const f = fixture();
  expect(await f.service.claimEmail(admin, action)).toEqual({
    kind: "ready",
    value: { send: true, invoice },
  });
  const receipt = {
    digest: invoiceDigest({ action: "email", input: action }),
    result: { invoiceId },
  };
  expect(await fixture({ receipt }).service.claimEmail(admin, action)).toEqual({
    kind: "ready",
    value: { send: false, invoice },
  });
  expect(
    (
      await fixture({
        receipt: { ...receipt, digest: "other" },
      }).service.claimEmail(admin, action)
    ).kind,
  ).toBe("conflict");
  for (const options of [
    { invoice: null },
    { invoice: { ...invoice, revision: 2 } },
    { invoice: { ...invoice, voidReason: "void" } },
    { invoice: { ...invoice, delivery: "sent" as const } },
  ])
    expect(
      (await fixture(options).service.claimEmail(admin, action)).kind,
    ).toBe(options.invoice === null ? "not-found" : "conflict");
  for (const change of [
    { invoiceId: "bad" },
    { operationId: "bad" },
    { expectedRevision: -1 },
  ])
    expect(
      (await f.service.claimEmail(admin, { ...action, ...change })).kind,
    ).toBe("invalid");
  expect(
    (await f.service.claimEmail(admin, null as unknown as typeof action)).kind,
  ).toBe("invalid");
  for (const sent of [true, false])
    expect(
      (await f.service.finishEmail(admin, invoiceId, operationId, sent)).kind,
    ).toBe("ready");
  expect(
    (
      await fixture({ receiptExists: false }).service.finishEmail(
        admin,
        invoiceId,
        operationId,
        true,
      )
    ).kind,
  ).toBe("denied");
  expect(
    (
      await fixture({ updated: false }).service.finishEmail(
        admin,
        invoiceId,
        operationId,
        true,
      )
    ).kind,
  ).toBe("conflict");
  expect(
    (await f.service.finishEmail(admin, "bad", operationId, true)).kind,
  ).toBe("invalid");
  expect(
    (await f.service.finishEmail(admin, invoiceId, "bad", true)).kind,
  ).toBe("invalid");
});
it("OFFPUR-10 processes only active due agreements with unchanged eligible source versions", async () => {
  const active = {
    ...plan,
    state: "active" as const,
    terms: { ...terms, startsOn: "2026-09-30" },
  };
  const f = fixture({ due: true, plan: active });
  expect(await f.service.generateScheduled()).toEqual({
    kind: "ready",
    value: { created: 1 },
  });
  expect(
    (await fixture({ due: true, plan: active }).service.generateDue(admin))
      .kind,
  ).toBe("ready");
  for (const change of [
    null,
    { ...active, state: "cancelled" as const },
    { ...active, nextCycle: 1201 },
    { ...active, terms: { ...terms, startsOn: "2027-01-01" } },
  ])
    expect(
      await fixture({ due: true, plan: change }).service.generateScheduled(),
    ).toEqual({ kind: "ready", value: { created: 0 } });
  expect(
    await fixture({
      due: true,
      plan: active,
      eligible: false,
    }).service.generateScheduled(),
  ).toEqual({ kind: "ready", value: { created: 0 } });
  expect(await fixture().service.generateScheduled()).toEqual({
    kind: "ready",
    value: { created: 0 },
  });
  expect((await fixture({ fail: true }).service.generateScheduled()).kind).toBe(
    "unavailable",
  );
  expect(
    (await fixture({ lease: false }).service.generateScheduled()).kind,
  ).toBe("unavailable");
});
