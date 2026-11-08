import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  FLAGGED_LIMIT,
  disabledInvoiceReconciliationStore,
  invoiceFlags,
  invoiceGap,
  invoiceReconciliationStore,
  reconcileInvoices,
  type InvoiceFact,
} from "../../src/invoice-reconciliation.ts";
import {
  invoiceReconciliationPage,
  invoiceReconciliationUnavailablePage,
} from "../../src/invoice-reconciliation-views.ts";
import { withHosting } from "../../src/hosting-presentation.ts";
import {
  emptyAiRequests,
  emptyTestEvents,
} from "../../src/request-reconciliation.ts";

const asOf = new Date("2026-11-06T12:00:00Z"),
  token = "a".repeat(64),
  manual = {
    comparedMembers: 0,
    mismatchedMembers: 0,
    mismatchCents: 0,
    notComparableInvoices: 0,
  };
const fact = (change: Partial<InvoiceFact> = {}): InvoiceFact => ({
  id: "00000000-0000-4000-8000-000000000001",
  sample: true,
  linked: true,
  voided: false,
  totalCents: 3000,
  paidCents: 0,
  refundedCents: 0,
  documentTotalCents: 3000,
  documentSample: true,
  issuedOn: "2026-11-01",
  receipts: 0,
  receiptCents: 0,
  refunds: 0,
  refundCents: 0,
  simulatedReceiptCents: 0,
  simulatedRefundCents: 0,
  firstReceipt: null,
  firstRefund: null,
  lateEvents: 0,
  lateCents: 0,
  heldEvents: 0,
  ...change,
});
const paid = (cents: number, change: Partial<InvoiceFact> = {}) =>
  fact({
    paidCents: cents,
    receipts: 1,
    receiptCents: cents,
    firstReceipt: "2026-11-02",
    ...change,
  });

it("RECON-01 a zero denominator gives no share and an empty status", () => {
  const { groups, flagged, flaggedTotal } = reconcileInvoices([], manual, asOf);
  expect(groups.map((row) => row.group)).toEqual(["configured", "sample"]);
  for (const row of groups)
    expect(row).toMatchObject({ status: "empty", collectedShare: null });
  expect(flagged).toEqual([]);
  expect(flaggedTotal).toBe(0);
  const allVoid = reconcileInvoices([fact({ voided: true })], manual, asOf);
  expect(allVoid.groups[1]).toMatchObject({
    status: "consistent",
    invoicedCents: 0,
    voidedCents: 3000,
    collectedShare: null,
  });
});

it("RECON-02 net collected comes from events and unpaid from running totals", () => {
  const row = reconcileInvoices(
    [
      paid(1000),
      paid(3000, { refunds: 1, refundCents: 500, refundedCents: 500 }),
      fact(),
    ],
    manual,
    asOf,
  ).groups[1];
  expect(row).toMatchObject({
    invoicedCents: 9000,
    receiptCents: 4000,
    refundCents: 500,
    netCollectedCents: 3500,
    unpaidCents: 5000,
    collectedShare: 38,
  });
});

it("RECON-03 sample and other invoices are never added together", () => {
  const { groups } = reconcileInvoices(
    [paid(1000), paid(2000, { sample: false, documentSample: false })],
    manual,
    asOf,
  );
  expect(groups[0]).toMatchObject({ group: "configured", receiptCents: 2000 });
  expect(groups[1]).toMatchObject({ group: "sample", receiptCents: 1000 });
});

it("RECON-05 each mismatch is flagged and opposite gaps do not cancel", () => {
  expect(invoiceFlags(paid(1000, { receiptCents: 1200 }))).toEqual([
    "receipts_differ",
  ]);
  expect(invoiceFlags(paid(1000, { refundCents: 5 }))).toEqual([
    "refunds_differ",
  ]);
  expect(invoiceFlags(fact({ documentTotalCents: 1 }))).toEqual([
    "document_differs",
  ]);
  expect(invoiceFlags(fact({ documentSample: false }))).toEqual([
    "document_differs",
  ]);
  const row = reconcileInvoices(
    [paid(1000, { receiptCents: 1200 }), paid(1000, { receiptCents: 800 })],
    manual,
    asOf,
  ).groups[1];
  expect(row).toMatchObject({
    status: "discrepancies",
    mismatchedInvoices: 2,
    mismatchCents: 400,
  });
  expect(
    invoiceGap(
      paid(1000, {
        receiptCents: 900,
        refundCents: 30,
        documentTotalCents: 3005,
      }),
    ),
  ).toBe(135);
});

it("RECON-06 reversals are shown and money on a void invoice is a mismatch", () => {
  expect(invoiceFlags(fact({ voided: true }))).toEqual(["voided"]);
  expect(
    invoiceFlags(paid(0, { voided: true, receiptCents: 40, receipts: 1 })),
  ).toEqual(["receipts_differ", "void_with_cash", "voided"]);
  expect(
    invoiceFlags(
      fact({
        voided: true,
        refundCents: 40,
        refundedCents: 40,
        firstRefund: "2026-11-02",
      }),
    ),
  ).toContain("void_with_cash");
  expect(
    invoiceFlags(paid(1000, { refundedCents: 1000, refundCents: 1000 })),
  ).toEqual(["fully_refunded"]);
  expect(
    invoiceFlags(paid(1000, { refundedCents: 10, refundCents: 10 })),
  ).toEqual(["partly_refunded"]);
});

it("RECON-07 late and out-of-order dates are flagged and still count", () => {
  expect(
    invoiceFlags(paid(1000, { firstReceipt: "2026-10-31", lateEvents: 1 })),
  ).toEqual(["receipt_before_issue", "late_recorded"]);
  expect(invoiceFlags(fact({ firstRefund: "2026-11-02" }))).toContain(
    "refund_before_receipt",
  );
  expect(invoiceFlags(paid(1000, { firstRefund: "2026-11-01" }))).toContain(
    "refund_before_receipt",
  );
  expect(invoiceFlags(paid(1000, { firstRefund: "2026-11-03" }))).toEqual([]);
  const row = reconcileInvoices(
    [paid(1000, { lateEvents: 1, lateCents: 1000 })],
    manual,
    asOf,
  ).groups[1];
  expect(row).toMatchObject({
    status: "consistent",
    lateEvents: 1,
    lateCents: 1000,
    receiptCents: 1000,
  });
});

it("RECON-09 simulated events reconcile but are not collected cash", () => {
  const row = reconcileInvoices(
    [
      fact({
        paidCents: 700,
        refundedCents: 100,
        simulatedReceiptCents: 700,
        simulatedRefundCents: 100,
        firstReceipt: "2026-11-02",
        firstRefund: "2026-11-03",
      }),
    ],
    manual,
    asOf,
  ).groups[1];
  expect(row).toMatchObject({
    status: "consistent",
    receiptCents: 0,
    netCollectedCents: 0,
    simulatedReceiptCents: 700,
    simulatedRefundCents: 100,
  });
});

it("RECON-21 an invoice with a held signed test event is flagged for the operator", () => {
  const held = fact({ heldEvents: 1 }),
    other = paid(3000, { id: "00000000-0000-4000-8000-000000000002" });
  expect(invoiceFlags(held)).toEqual(["test_event_held"]);
  expect(invoiceFlags(other)).toEqual([]);
  const snapshot = reconcileInvoices(
    [
      held,
      other,
      fact({ id: "00000000-0000-4000-8000-000000000003", voided: true }),
    ],
    manual,
    asOf,
  );
  // Waiting is not a cash mismatch, so the totals still agree.
  expect(snapshot.groups[1]).toMatchObject({
    status: "consistent",
    mismatchedInvoices: 0,
  });
  // It needs attention before reversal-only rows.
  expect(snapshot.flagged.map((row) => [row.id.at(-1), row.flags])).toEqual([
    ["1", ["test_event_held"]],
    ["3", ["voided"]],
  ]);
  const html = invoiceReconciliationPage(snapshot);
  expect(html).toContain(
    `<tr data-flagged-invoice="${held.id}"><td><a href="/operator/invoices/${held.id}">`,
  );
  expect(html).toContain("Signed test event held and not applied");
});

it("orders flags by severity, then gap, then id, and caps the list", () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const { flagged } = reconcileInvoices(
    [
      fact({ id: id(1), voided: true }),
      paid(1000, { id: id(2), lateEvents: 1, lateCents: 1000 }),
      paid(1000, { id: id(3), receiptCents: 1001 }),
      paid(1000, { id: id(4), receiptCents: 1500 }),
      paid(1000, { id: id(5), receiptCents: 1001 }),
      paid(1000, { id: id(6), firstReceipt: "2026-10-30" }),
    ],
    manual,
    asOf,
  );
  expect(flagged.map((row) => row.id)).toEqual(
    [4, 3, 5, 2, 6, 1].map((n) => id(n)),
  );
  const many = reconcileInvoices(
    Array.from({ length: FLAGGED_LIMIT + 2 }, (_, n) =>
      fact({
        id: id(n),
        voided: true,
        sample: n % 2 === 0,
        documentSample: n % 2 === 0,
      }),
    ),
    manual,
    asOf,
  );
  expect(many.flagged).toHaveLength(FLAGGED_LIMIT);
  expect(many.flaggedTotal).toBe(FLAGGED_LIMIT + 2);
  const html = invoiceReconciliationPage(many);
  expect(html).toContain(
    `Showing ${FLAGGED_LIMIT} of ${FLAGGED_LIMIT + 2} flagged invoices`,
  );
  expect(html).toContain("Not sample");
});

it("RECON-03 labels test data, shows gaps and never reads as a live figure", () => {
  const snapshot = reconcileInvoices(
    [
      paid(1000, { refundCents: 2000, refundedCents: 0 }),
      fact({ id: "00000000-0000-4000-8000-000000000002", linked: false }),
    ],
    { ...manual, mismatchedMembers: 1, mismatchCents: 25 },
    asOf,
  );
  const local = invoiceReconciliationPage(snapshot),
    hosted = withHosting(true, () => invoiceReconciliationPage(snapshot));
  expect(local).toContain("PREVIEW RECORDS");
  expect(hosted).toContain("TEST DATA · NOT A LIVE FIGURE");
  expect(hosted).not.toContain("PREVIEW RECORDS");
  expect(hosted).not.toMatch(/synthetic/i);
  expect(local).toContain("Sample invoices · Test data");
  expect(local).toContain("Refunded total differs from its refunds");
  expect(local).toMatch(/data-field="net">−CAD 10\.00/);
  expect(local).toMatch(/data-field="unlinked">1/);
  expect(local).toMatch(/data-field="manual\.amount">CAD 0\.25/);
  expect(local).toContain('data-reconciliation-status="discrepancies"');
  expect(local).toContain('data-reconciliation-status="empty"');
  expect(local).toContain("not revenue, conversion, renewal or cancellation");
  const clean = invoiceReconciliationPage(
    reconcileInvoices([paid(1000)], manual, asOf),
  );
  expect(clean).toContain("No invoices are flagged.");
  expect(clean).toContain('data-reconciliation-status="consistent"');
  expect(clean).toMatch(/data-field="share">33%/);
});

it.each([
  ["denied", "not available to this session"],
  ["unavailable", "could not be confirmed"],
  ["live", "no live figures"],
  ["query", "does not accept query fields"],
] as const)("explains a %s refusal without figures", (kind, text) => {
  const html = invoiceReconciliationUnavailablePage(kind);
  expect(html).toContain(text);
  expect(html).not.toContain("CAD");
});

const factRow = {
  id: "00000000-0000-4000-8000-000000000001",
  sample: true,
  linked: true,
  voided: false,
  totalCents: "3000",
  paidCents: "1000",
  refundedCents: "0",
  documentTotalCents: "3000",
  documentSample: true,
  issuedOn: "2026-11-01",
  receipts: 1,
  receiptCents: "1000",
  refunds: 0,
  refundCents: "0",
  simulatedReceiptCents: "0",
  simulatedRefundCents: "0",
  firstReceipt: "2026-11-02",
  firstRefund: null,
  lateEvents: 0,
  lateCents: "0",
  heldEvents: 0,
};
const manualRow = {
  comparedMembers: 1,
  mismatchedMembers: 0,
  mismatchCents: "0",
  notComparableInvoices: 0,
};
const eventRow = Object.fromEntries(
  Object.keys(emptyTestEvents)
    .filter((key) => key !== "status")
    .map((key) => [key, 0]),
);
const requestRow = Object.fromEntries(
  Object.keys(emptyAiRequests)
    .filter((key) => key !== "status" && key !== "mismatches")
    .map((key) => [key, 0]),
);
function pool(
  respond: (sql: string) => { rows: unknown[] } | Promise<never>,
  release = vi.fn(),
) {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    return respond(sql);
  });
  return {
    fake: { connect: async () => ({ query, release }) } as unknown as Pool,
    queries,
    release,
  };
}
const respond =
  (rows: {
    admin?: unknown[];
    facts?: unknown[];
    manual?: unknown[];
    asOf?: unknown[];
  }) =>
  (sql: string) => {
    if (sql.includes("authorized_staff_profiles"))
      return { rows: rows.admin ?? [{}] };
    if (sql.includes("FROM simple_invoices i\n"))
      return { rows: rows.facts ?? [factRow] };
    if (sql.startsWith("WITH recorded"))
      return { rows: rows.manual ?? [manualRow] };
    if (sql.includes("verification='signed_test_event'"))
      return { rows: [eventRow] };
    if (sql.includes("local_ai_test_unit_jobs")) return { rows: [requestRow] };
    if (sql.includes('now() AS "asOf"'))
      return { rows: rows.asOf ?? [{ asOf }] };
    return { rows: [] };
  };

it("reads one read-only snapshot and always ends the transaction", async () => {
  const f = pool(respond({}));
  const result = await invoiceReconciliationStore(f.fake).snapshot(token);
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") {
    expect(result.value.asOf).toBe(asOf);
    expect(result.value.groups[1].receiptCents).toBe(1000);
  }
  expect(f.queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ");
  expect(f.queries.at(-1)).toBe("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("decodes absent optional facts as false and null", async () => {
  const rest: Record<string, unknown> = { ...factRow };
  for (const key of ["sample", "linked", "voided", "firstReceipt"])
    delete rest[key];
  const f = pool(
    respond({
      facts: [
        {
          ...rest,
          paidCents: "0",
          receiptCents: "0",
          receipts: 0,
          documentSample: false,
        },
      ],
    }),
  );
  const result = await invoiceReconciliationStore(f.fake).snapshot(token);
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.value.groups[0].current).toBe(1);
});

it("RECON-10 refuses a malformed token before connecting and denies a non-administrator", async () => {
  const connect = vi.fn();
  expect(
    await invoiceReconciliationStore({ connect } as unknown as Pool).snapshot(
      "nope",
    ),
  ).toEqual({ kind: "denied" });
  expect(connect).not.toHaveBeenCalled();
  const f = pool(respond({ admin: [] }));
  expect(await invoiceReconciliationStore(f.fake).snapshot(token)).toEqual({
    kind: "denied",
  });
  expect(f.queries.at(-1)).toBe("ROLLBACK");
  expect(f.queries.some((sql) => sql.includes("simple_invoice_payments"))).toBe(
    false,
  );
});

it.each([
  ["no manual row", { manual: [] }],
  ["no clock row", { asOf: [] }],
  [
    "a value that is not a whole number",
    { facts: [{ ...factRow, totalCents: "x" }] },
  ],
])("RECON-12 %s shows no figures", async (_name, rows) => {
  const f = pool(respond(rows));
  expect(await invoiceReconciliationStore(f.fake).snapshot(token)).toEqual({
    kind: "unavailable",
  });
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("RECON-12 a failed connection or rollback shows no figures", async () => {
  expect(await disabledInvoiceReconciliationStore().snapshot(token)).toEqual({
    kind: "unavailable",
  });
  const down = {
    connect: async () => {
      throw new Error("down");
    },
  } as unknown as Pool;
  expect(await invoiceReconciliationStore(down).snapshot(token)).toEqual({
    kind: "unavailable",
  });
  const release = vi.fn();
  const f = pool((sql) => {
    if (sql === "ROLLBACK") return Promise.reject(new Error("gone"));
    return respond({})(sql);
  }, release);
  expect(await invoiceReconciliationStore(f.fake).snapshot(token)).toEqual({
    kind: "unavailable",
  });
  expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});
