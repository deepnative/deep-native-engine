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
  instructions: string;
  sample: boolean;
  voidReason?: string;
}

/** Amounts come from the validated immutable invoice, never query/form values. */
export function simpleInvoiceDocument(invoice: SimpleInvoiceDocument) {
  const money = (cents: number) =>
    `${invoice.currency} ${(cents / 100).toFixed(2)}`;
  const subtotal = invoice.lines.reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
  const total = subtotal + invoice.taxCents;
  return page(
    `Invoice ${invoice.number}`,
    `<article class="invoice-document"><p>${invoice.sample ? "SAMPLE · NOT PAYABLE" : "INVOICE"}</p><h1>Invoice</h1><p class="invoice-reference">${escape(invoice.number)}</p><p>Issued ${escape(invoice.issuedOn)}</p>${invoice.voidReason ? `<p role="status"><strong>VOID · No payment due</strong> — ${escape(invoice.voidReason)}</p>` : ""}<h2>From</h2><p class="invoice-instructions">${escape(invoice.issuer)}</p><h2>Bill to</h2><p>${escape(invoice.billedTo)}</p>${invoice.billing.kind === "one_time" ? "<p>One-time billing</p>" : `<p>Recurring billing · Period starts ${escape(invoice.billing.periodStart)} and ends before ${escape(invoice.billing.periodEnd)}. No automatic payment is taken.</p>`}<table><caption>Included courses</caption><thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead><tbody>${invoice.lines.map((line) => `<tr><td>${escape(line.description)}</td><td>${money(line.amountCents)}</td></tr>`).join("")}</tbody></table><dl><dt>Subtotal</dt><dd>${money(subtotal)}</dd><dt>Tax</dt><dd>${money(invoice.taxCents)}</dd><dt>Total</dt><dd>${money(total)}</dd><dt>Recorded payment</dt><dd>${money(invoice.paidCents)}</dd><dt>Balance</dt><dd>${money(invoice.voidReason ? 0 : total - invoice.paidCents)}</dd></dl><h2>Offline payment</h2><p class="invoice-instructions">${escape(invoice.instructions)}</p>${invoice.sample ? "<p>This sample cannot be paid. Its issuer, amounts and tax are invented preview values.</p>" : "<p>Payment is confirmed after staff records received funds against this invoice.</p>"}</article><aside class="invoice-controls"><p>Use your browser’s Print command to print this invoice or save it as a PDF.</p><p><a href="/account/purchases">Courses and invoices</a> · <a href="/account">My account</a></p></aside>`,
  );
}
