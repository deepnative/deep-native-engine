import { expect, it, vi } from "vitest";
import { reconcileInvoices } from "../../src/invoice-reconciliation.ts";
import { invoiceReconciliationPage } from "../../src/invoice-reconciliation-views.ts";
import {
  emptyAiRequests,
  emptyTestEvents,
  readRequestSources,
  summarizeAiRequests,
  summarizeTestEvents,
  type AiRequestSummary,
  type TestEventSummary,
} from "../../src/request-reconciliation.ts";

const asOf = new Date("2026-11-07T12:00:00Z"),
  manual = {
    comparedMembers: 0,
    mismatchedMembers: 0,
    mismatchCents: 0,
    notComparableInvoices: 0,
  };
const without = <T extends object>(value: T, ...keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
const noEvents = without(emptyTestEvents, "status") as Omit<
  TestEventSummary,
  "status"
>;
const noRequests = without(emptyAiRequests, "status", "mismatches") as Omit<
  AiRequestSummary,
  "status" | "mismatches"
>;
const events = (change: Partial<TestEventSummary> = {}) =>
  summarizeTestEvents({ ...noEvents, ...change });
const requests = (change: Partial<AiRequestSummary> = {}) =>
  summarizeAiRequests({ ...noRequests, ...change });
const html = (
  testEvents: TestEventSummary = emptyTestEvents,
  aiRequests: AiRequestSummary = emptyAiRequests,
) =>
  invoiceReconciliationPage(
    reconcileInvoices([], manual, asOf, { testEvents, aiRequests }),
  );

it("RECON-15 nothing to compare is empty, with every figure zero", () => {
  expect(events()).toEqual(emptyTestEvents);
  expect(requests()).toEqual(emptyAiRequests);
  const page = html();
  expect(page).toContain("No signed test events to compare.");
  expect(page).toContain("No metered test AI requests to compare.");
  expect(page).toContain('data-field="ai.actual">0 points<');
  // The default sources are the same empty summaries.
  expect(reconcileInvoices([], manual, asOf)).toMatchObject({
    testEvents: emptyTestEvents,
    aiRequests: emptyAiRequests,
  });
});

it("RECON-13 each kind of test event is shown apart and never as collected cash", () => {
  const row = events({
    receipts: 1,
    receiptCents: 3000,
    refunds: 1,
    refundCents: 500,
    failures: 1,
    failureCents: 3000,
  });
  expect(row.status).toBe("applied");
  const page = html(row);
  expect(page).toContain("Every signed test event was applied");
  expect(page).toContain('data-field="test.receipts">CAD 30.00<');
  expect(page).toContain('data-field="test.failures">CAD 30.00<');
  expect(page).toContain("They are never counted as collected cash.");
  // A failure alone is still something to compare.
  expect(events({ failures: 1 }).status).toBe("applied");
});

it("RECON-14 a held event is waiting until applied, and applied-after-hold counts once", () => {
  expect(events({ waiting: 1, waitingCents: 900 }).status).toBe("waiting");
  const later = events({ appliedAfterHold: 1, refunds: 1, refundCents: 100 });
  expect(later.status).toBe("applied");
  expect(events({ appliedAfterHold: 1 }).status).toBe("applied");
  const page = html(events({ waiting: 2, waitingCents: 900 }));
  expect(page).toContain("Held and not applied (2)");
  expect(page).toContain("This report applies nothing.");
});

it("RECON-16/17 estimates and actuals stay apart, in points, never netted", () => {
  const row = requests({
    requests: 3,
    estimated: 3,
    estimatedPoints: 471,
    settled: 2,
    settledEstimatePoints: 314,
    actualPoints: 3642,
    openEstimatePoints: 157,
    aboveEstimate: 1,
    abovePoints: 3443,
    belowEstimate: 1,
    belowPoints: 115,
    consumedUnits: 2,
    reservedUnits: 1,
  });
  expect(row).toMatchObject({ status: "consistent", mismatches: 0 });
  const page = html(emptyTestEvents, row);
  expect(page).toContain("Simulated points at invented rates, not money");
  expect(page).toContain('data-field="ai.actual">3642 points<');
  expect(page).toContain('data-field="ai.openEstimate">157 points<');
  expect(page).toContain('data-field="ai.above">3443 points<');
  expect(page).toContain('data-field="ai.below">115 points<');
  expect(page).toContain("Every settled cost has a used unit");
});

it("RECON-18 only cost and unit disagreements are mismatches", () => {
  expect(
    requests({ requests: 1, heldUnknown: 1, reservedUnits: 1 }),
  ).toMatchObject({ status: "consistent", mismatches: 0 });
  const row = requests({
    requests: 2,
    consumedWithoutActual: 1,
    actualWithoutConsumed: 1,
  });
  expect(row).toMatchObject({ status: "discrepancies", mismatches: 2 });
  expect(html(emptyTestEvents, row)).toContain(
    "Mismatches between costs and units remain visible below.",
  );
});

const eventRow = Object.fromEntries(
  Object.keys(noEvents).map((key) => [key, "0"]),
);
const requestRow = Object.fromEntries(
  Object.keys(noRequests).map((key) => [key, 0]),
);
const client = (rows: unknown[][]) => {
  const query = vi.fn();
  for (const r of rows) query.mockResolvedValueOnce({ rows: r });
  return { query };
};

it("reads both sources and decodes whole numbers", async () => {
  const c = client([
    [{ ...eventRow, waiting: 1, waitingCents: "700" }],
    [
      {
        ...requestRow,
        requests: 1,
        consumedUnits: 1,
        consumedWithoutActual: 1,
      },
    ],
  ]);
  expect(await readRequestSources(c)).toMatchObject({
    testEvents: { status: "waiting", waitingCents: 700 },
    aiRequests: { status: "discrepancies", mismatches: 1 },
  });
  expect(c.query).toHaveBeenCalledTimes(2);
});

it.each([
  ["a missing test-event row", [[], [requestRow]], /row missing/],
  ["a missing request row", [[eventRow], []], /row missing/],
  [
    "a value that is not a whole number",
    [[{ ...eventRow, receiptCents: "1.5" }], [requestRow]],
    /whole number/,
  ],
  [
    "an absent value",
    [[eventRow], [{ ...requestRow, heldUnknown: null }]],
    /whole number/,
  ],
])("RECON-20 %s is refused", async (_name, rows, error) => {
  await expect(readRequestSources(client(rows))).rejects.toThrow(error);
});
