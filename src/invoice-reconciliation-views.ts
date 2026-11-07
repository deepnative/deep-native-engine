import { portalActions } from "./backend-portal-presentation.ts";
import { readableTime } from "./display-time.ts";
import { hostingText } from "./hosting-presentation.ts";
import type {
  InvoiceCashGroup,
  InvoiceFlag,
  InvoiceReconciliationSnapshot,
} from "./invoice-reconciliation.ts";
import { FLAGGED_LIMIT } from "./invoice-reconciliation.ts";
import type {
  AiRequestSummary,
  TestEventSummary,
} from "./request-reconciliation.ts";
import { escape, page } from "./views.ts";

const money = (cents: number) =>
  `${cents < 0 ? "−" : ""}CAD ${(Math.abs(cents) / 100).toFixed(2)}`;
const flagText: Record<InvoiceFlag, string> = {
  receipts_differ: "Paid total differs from its receipts",
  refunds_differ: "Refunded total differs from its refunds",
  document_differs: "Stored invoice differs from its document",
  void_with_cash: "Money recorded on a void invoice",
  refund_before_receipt: "Refund dated before any receipt",
  receipt_before_issue: "Receipt dated before the invoice was issued",
  late_recorded: "Recorded after the month of its date",
  partly_refunded: "Reversal: partly refunded",
  fully_refunded: "Reversal: fully refunded",
  voided: "Reversal: voided",
  test_event_held: "Signed test event held and not applied",
};
const heading = {
  configured: "Invoices not marked as samples",
  sample: "Sample invoices · Test data",
};
const summary = {
  configured:
    "Amounts are as recorded by staff. No bank or payment provider has confirmed them.",
  sample:
    "Invented sample invoices. Nothing here is payable and no money moved. These never count towards any other figure.",
};
function fields(rows: [string, string, string][]) {
  return `<dl>${rows.map(([key, label, value]) => `<dt>${label}</dt><dd data-field="${key}">${value}</dd>`).join("")}</dl>`;
}
function groupSection(row: InvoiceCashGroup) {
  const statusText = {
    empty:
      "No invoices to compare. Zero here does not show that nothing is owed anywhere else.",
    consistent:
      "Invoices agree with their recorded events. This does not confirm any money arrived.",
    discrepancies:
      "Mismatches remain visible below. This report corrects nothing.",
  }[row.status];
  return `<section class="portal-card" data-invoice-group="${row.group}"><h2>${heading[row.group]}</h2><p>${summary[row.group]}</p><p role="status" data-reconciliation-status="${row.status}">${statusText}</p><h3>Invoiced</h3>${fields(
    [
      ["invoices", "Current invoices", String(row.current)],
      ["invoiced", "Invoiced, excluding void", money(row.invoicedCents)],
      ["unpaid", "Unpaid balance", money(row.unpaidCents)],
    ],
  )}<h3>Collected cash</h3><p>Receipts minus refunds. An invoice is not cash until a receipt is recorded.</p>${fields(
    [
      [
        "receipts",
        `Receipts recorded (${row.receipts})`,
        money(row.receiptCents),
      ],
      ["refunds", `Refunds recorded (${row.refunds})`, money(row.refundCents)],
      ["net", "Net collected", money(row.netCollectedCents)],
      [
        "share",
        "Net collected as a share of invoiced",
        row.collectedShare === null
          ? "Not applicable: nothing invoiced"
          : `${row.collectedShare}%`,
      ],
      [
        "simulatedReceipts",
        "Simulated test receipts, not collected cash",
        money(row.simulatedReceiptCents),
      ],
      [
        "simulatedRefunds",
        "Simulated test refunds, not collected cash",
        money(row.simulatedRefundCents),
      ],
    ],
  )}<h3>Reversals</h3>${fields([
    ["partlyRefunded", "Partly refunded invoices", String(row.partlyRefunded)],
    ["fullyRefunded", "Fully refunded invoices", String(row.fullyRefunded)],
    ["voided", "Void invoices", String(row.voided)],
    ["voidedAmount", "Removed from invoiced by void", money(row.voidedCents)],
  ])}<h3>Gaps and late records</h3>${fields([
    ["mismatched", "Invoices with a mismatch", String(row.mismatchedInvoices)],
    [
      "mismatchAmount",
      "Size of gaps, never netted between invoices",
      money(row.mismatchCents),
    ],
    [
      "late",
      `Recorded after the month of their date (${row.lateEvents})`,
      money(row.lateCents),
    ],
    [
      "beforeIssue",
      "Invoices with a receipt dated before issue",
      String(row.datedBeforeIssue),
    ],
    ["unlinked", "Invoices no longer linked to a member", String(row.unlinked)],
  ])}</section>`;
}
const points = (value: number) => `${value} points`;
function testEventSection(row: TestEventSummary) {
  const statusText = {
    empty: "No signed test events to compare.",
    applied:
      "Every signed test event was applied or recorded as a failed payment.",
    waiting:
      "Some signed test events are held and not applied. They stay listed so none is lost. This report applies nothing.",
  }[row.status];
  return `<section class="portal-card" data-test-events><h2>Signed test events · Test data</h2><p>Invented events from the local test handler, on sample invoices only. No payment provider sent or checked them and no money moved. They are never counted as collected cash.</p><p role="status" data-reconciliation-status="${row.status}">${statusText}</p>${fields(
    [
      [
        "test.receipts",
        `Test receipts applied (${row.receipts})`,
        money(row.receiptCents),
      ],
      [
        "test.refunds",
        `Test refunds applied (${row.refunds})`,
        money(row.refundCents),
      ],
      [
        "test.failures",
        `Failed test payments, no money moved (${row.failures})`,
        money(row.failureCents),
      ],
      [
        "test.waiting",
        `Held and not applied (${row.waiting})`,
        money(row.waitingCents),
      ],
      [
        "test.appliedAfterHold",
        "Held at first, applied later and counted once",
        String(row.appliedAfterHold),
      ],
    ],
  )}</section>`;
}
function aiRequestSection(row: AiRequestSummary) {
  const statusText = {
    empty: "No metered test AI requests to compare.",
    consistent:
      "Every settled cost has a used unit, and every used unit has a settled cost.",
    discrepancies:
      "Mismatches between costs and units remain visible below. This report corrects nothing.",
  }[row.status];
  return `<section class="portal-card" data-ai-requests><h2>Metered test AI requests · Test data</h2><p>Local test AI requests, each using one study-request unit. Simulated points at invented rates, not money. Points are never set against any invoice amount.</p><p role="status" data-reconciliation-status="${row.status}">${statusText}</p><h3>Estimated and actual cost</h3>${fields(
    [
      ["ai.requests", "Requests", String(row.requests)],
      [
        "ai.noEstimate",
        "Requests with no estimate, not comparable",
        String(row.noEstimate),
      ],
      [
        "ai.estimated",
        `Estimated, all requests (${row.estimated})`,
        points(row.estimatedPoints),
      ],
      [
        "ai.settledEstimate",
        `Estimated, settled requests (${row.settled})`,
        points(row.settledEstimatePoints),
      ],
      [
        "ai.actual",
        `Actual, settled requests (${row.settled})`,
        points(row.actualPoints),
      ],
      [
        "ai.openEstimate",
        "Estimated for requests with no settled cost, not an actual",
        points(row.openEstimatePoints),
      ],
      [
        "ai.above",
        `Actual above estimate, never netted (${row.aboveEstimate})`,
        points(row.abovePoints),
      ],
      [
        "ai.below",
        `Actual below estimate, never netted (${row.belowEstimate})`,
        points(row.belowPoints),
      ],
    ],
  )}<h3>Study-request units</h3>${fields([
    ["ai.reserved", "Still reserved", String(row.reservedUnits)],
    ["ai.consumed", "Used", String(row.consumedUnits)],
    ["ai.released", "Released", String(row.releasedUnits)],
    [
      "ai.heldUnknown",
      "Held with an unknown outcome, unit kept reserved",
      String(row.heldUnknown),
    ],
    [
      "ai.consumedWithoutActual",
      "Unit used with no settled cost",
      String(row.consumedWithoutActual),
    ],
    [
      "ai.actualWithoutConsumed",
      "Settled cost with no used unit",
      String(row.actualWithoutConsumed),
    ],
  ])}</section>`;
}
export function invoiceReconciliationPage(
  snapshot: InvoiceReconciliationSnapshot,
) {
  const { flagged, flaggedTotal, manual } = snapshot;
  const flaggedSection = flagged.length
    ? `<div class="table-scroll" role="region" aria-label="Flagged invoices" tabindex="0"><table><caption>Flagged invoices, mismatches first</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Group</th><th scope="col">Flags</th><th scope="col">Gap</th></tr></thead><tbody>${flagged
        .map(
          (row) =>
            `<tr data-flagged-invoice="${escape(row.id)}"><td><a href="/operator/invoices/${escape(row.id)}">DN-${escape(row.id.slice(0, 8))}</a></td><td>${row.group === "sample" ? "Sample" : "Not sample"}</td><td>${row.flags.map((flag) => flagText[flag]).join("<br>")}</td><td>${money(row.gapCents)}</td></tr>`,
        )
        .join(
          "",
        )}</tbody></table></div>${flaggedTotal > FLAGGED_LIMIT ? `<p role="status">Showing ${FLAGGED_LIMIT} of ${flaggedTotal} flagged invoices. The totals above include all of them.</p>` : ""}`
    : '<p role="status">No invoices are flagged.</p>';
  return page(
    "Invoice and cash reconciliation",
    `<article class="reading"><p class="eyebrow">ADMINISTRATOR · ${hostingText("PREVIEW RECORDS", "TEST DATA")} · NOT A LIVE FIGURE</p><h1>Invoice and cash reconciliation</h1><p>One read-only snapshot comparing each invoice with its recorded receipts and refunds. Sample and other invoices are shown apart and are never added together.</p><p>As of <time datetime="${escape(snapshot.asOf.toISOString())}">${readableTime(snapshot.asOf)}</time>. Late records can change these totals on a later read.</p>${portalActions(
      [
        ["/operator/invoices", "Courses and invoices"],
        ["/operator", "Administration console"],
      ],
    )}${snapshot.groups.map(groupSection).join("")}<section class="portal-card" data-manual-check><h2>Staff change history</h2><p>Each member's recorded receipts and refunds compared with staff change history. No member is named here.</p>${fields(
      [
        ["manual.compared", "Members compared", String(manual.comparedMembers)],
        [
          "manual.mismatched",
          "Members with a difference",
          String(manual.mismatchedMembers),
        ],
        [
          "manual.amount",
          "Size of differences, never netted between members",
          money(manual.mismatchCents),
        ],
        [
          "manual.notComparable",
          "Invoices not comparable, no longer linked to a member",
          String(manual.notComparableInvoices),
        ],
      ],
    )}</section>${testEventSection(snapshot.testEvents)}${aiRequestSection(snapshot.aiRequests)}<h2>Flagged invoices</h2>${flaggedSection}<h2>What this report cannot establish</h2><ul><li>Collected cash here is what staff recorded. No bank or payment provider record is compared.</li><li>Signed test events are invented, and AI request costs are simulated points. Neither is money, and no payment provider record is compared.</li><li>No staff cost, forecast or capacity records are compared, because none exist to compare.</li><li>This is not revenue, conversion, renewal or cancellation. Those need decisions that have not been made.</li><li>No member names, emails or evidence references are shown. Nothing is corrected or stored.</li></ul><p><a href="/operator/invoice-reconciliation">Read a fresh snapshot</a></p></article>`,
  );
}
export function invoiceReconciliationUnavailablePage(
  kind: "denied" | "unavailable" | "live" | "query",
) {
  const message = {
    denied: "This report is not available to this session.",
    unavailable:
      "The snapshot could not be confirmed. No figures are shown. Nothing is retried automatically.",
    live: "This report is unavailable in live mode, so it shows no live figures.",
    query:
      "This report does not accept query fields or filters. Open the report using its original link.",
  }[kind];
  return page(
    "Invoice report unavailable",
    `<section class="error-page"><h1>Invoice report unavailable</h1><p role="alert">${message}</p>${portalActions(
      [
        ["/operator/invoice-reconciliation", "Open the report"],
        ["/operator", "Administration console"],
      ],
    )}</section>`,
  );
}
