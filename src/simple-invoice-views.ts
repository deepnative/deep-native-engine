import { monthLabel } from "./coaching-values.ts";
import { coachingDuration } from "./coaching-values.ts";
import type { InvoicePaymentEvent } from "./simple-invoice-store.ts";
import { escape, page } from "./views.ts";

export interface SimpleInvoiceDocument {
  number: string;
  issuedOn: string;
  issuer: string;
  billedTo: string;
  lines: Array<{ description: string; amountCents: number }>;
  billing:
    | { kind: "one_time" }
    | { kind: "recurring"; periodStart: string; periodEnd: string };
  currency: "CAD";
  taxCents: number;
  paidCents: number;
  refundedCents?: number;
  instructions: string;
  sample: boolean;
  voidReason?: string;
  coaching?: {
    month: string;
    minutes: number;
    rateCents: number;
    rateVersion: number;
    rateId: string;
    submissionRevision: number;
    replacesInvoiceId: string | null;
  };
}

const TEST_ENTRY = {
  receipt: "Test receipt",
  refund: "Test refund",
  failure: "Test payment failed",
  held: "Test event not applied",
};
const entryLabel = (event: InvoicePaymentEvent) =>
  event.verification === "signed_test_event"
    ? TEST_ENTRY[event.kind]
    : event.kind === "refund"
      ? "Refund"
      : "Receipt";

/** Amounts come from the validated immutable invoice, never query/form values. */
export function simpleInvoiceDocument(
  invoice: SimpleInvoiceDocument,
  admin = false,
  payments: InvoicePaymentEvent[] = [],
) {
  // GAPS-01: each reader returns to their own billing pages.
  const [billing, home] = admin
    ? [
        '<a class="button secondary" href="/operator/invoices">Courses and invoices</a>',
        '<a class="button secondary" href="/operator">Administration console</a>',
      ]
    : [
        '<a class="button secondary" href="/account/purchases">Courses and invoices</a>',
        '<a class="button secondary" href="/account">My account</a>',
      ];
  const money = (cents: number) =>
    `${invoice.currency} ${(cents / 100).toFixed(2)}`;
  const subtotal = invoice.lines.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  const total = subtotal + invoice.taxCents;
  const refunded = invoice.refundedCents ?? 0;
  // MANPAY-01/03: every entry stays visible and never reads as provider proof.
  const record = payments.length
    ? `<h2>Payment record</h2><div class="table-scroll" role="region" aria-label="Payment record" tabindex="0"><table class="invoice-payment-record"><caption>Recorded receipts and refunds</caption><thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Reference</th>${admin ? '<th scope="col">Recorded by</th>' : ""}<th scope="col">Amount</th></tr></thead><tbody>${payments.map((event) => `<tr><td>${escape(event.on)}</td><td>${entryLabel(event)}</td><td>${event.evidence === null ? "Not recorded" : escape(event.evidence)}</td>${admin ? `<td>${escape(event.recordedBy ?? "")}</td>` : ""}<td>${event.kind === "refund" ? "−" : ""}${money(event.amountCents)}</td></tr>`).join("")}</tbody></table></div>${payments.some((event) => event.verification === "manual_unverified") ? "<p>Recorded manually by staff. Not verified by a payment provider.</p>" : ""}${payments.some((event) => event.verification === "signed_test_event") ? "<p>Test entries come from signed test events simulated by this site’s test setup. No payment provider checked them and no money moved. A failed or not applied test event changes no amount.</p>" : ""}${refunded ? "<p>A recorded refund does not reopen this balance or change the course agreement.</p>" : ""}`
    : "";
  return page(
    `Invoice ${invoice.number}`,
    `<article class="invoice-document"><p>${invoice.sample ? "SAMPLE · NOT PAYABLE" : "INVOICE"}</p><h1>Invoice</h1><p class="invoice-reference">${escape(invoice.number)}</p><p>Issued ${escape(invoice.issuedOn)}</p>${invoice.voidReason ? `<p role="status"><strong>VOID · No payment due</strong> — ${escape(invoice.voidReason)}</p>` : ""}<h2>From</h2><p class="invoice-instructions">${escape(invoice.issuer)}</p><h2>Bill to</h2><p>${escape(invoice.billedTo)}</p>${invoice.billing.kind === "one_time" ? "<p>One-time billing</p>" : `<p>Recurring billing · Period starts ${escape(invoice.billing.periodStart)} and ends before ${escape(invoice.billing.periodEnd)}. No automatic payment is taken.</p>`}${invoice.coaching ? `<h2>Monthly coaching</h2><p>Month: ${escape(monthLabel(invoice.coaching.month))} · ${coachingDuration(invoice.coaching.minutes)} · ${money(invoice.coaching.rateCents)} per hour · rate version ${invoice.coaching.rateVersion} · submitted revision ${invoice.coaching.submissionRevision}</p>${invoice.coaching.replacesInvoiceId ? `<p>Replaces void invoice DN-${escape(invoice.coaching.replacesInvoiceId)}. The original remains retained.</p>` : ""}` : ""}<table><caption>${invoice.coaching ? "Coaching charges" : "Included courses"}</caption><thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead><tbody>${invoice.lines.map((line) => `<tr><td>${escape(line.description)}</td><td>${money(line.amountCents)}</td></tr>`).join("")}</tbody></table><dl><dt>Subtotal</dt><dd>${money(subtotal)}</dd><dt>Tax</dt><dd>${money(invoice.taxCents)}</dd><dt>Total</dt><dd>${money(total)}</dd><dt>Recorded payment</dt><dd>${money(invoice.paidCents)}</dd>${refunded ? `<dt>Recorded refund</dt><dd>${money(refunded)}</dd>` : ""}<dt>Balance</dt><dd>${money(invoice.voidReason ? 0 : total - invoice.paidCents)}</dd></dl>${record}<h2>Offline payment</h2><p class="invoice-instructions">${escape(invoice.instructions)}</p>${invoice.sample ? "<p>This sample cannot be paid. Its issuer, amounts and tax are invented preview values.</p>" : "<p>Payment is confirmed after staff records received funds against this invoice.</p>"}</article><aside class="invoice-controls"><p>Use your browser’s Print command to print this invoice or save it as a PDF.</p><p class="account-links invoice-actions">${billing} ${home}</p></aside>`,
  );
}
