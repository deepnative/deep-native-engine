import { createHash } from "node:crypto";
import { toUSVString } from "node:util";

export interface InvoiceCourse {
  id: string;
  version: number;
  description: string;
  amountCents: number;
}
export interface InvoiceTerms {
  courses: InvoiceCourse[];
  cadence: "one_time" | "monthly";
  startsOn: string;
  taxCents: number;
  issuer: string;
  instructions: string;
  sample: boolean;
}
export const invoiceUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
export const invoiceCents = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) <= 1_000_000_000;
export function invoiceText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit &&
    toUSVString(value) === value &&
    Array.from(value).every(
      (character) =>
        (character >= " " && character !== "\u007f") ||
        "\n\r\t".includes(character),
    )
  );
}
/**
 * RECIPIENT-04: an optional one-line company name. Missing or blank is none
 * (null); anything else that is not valid text is undefined.
 */
export function invoiceCompany(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const company = value.trim();
  if (!company) return null;
  return invoiceText(company, 200) && !/[\n\r\t]/.test(company)
    ? company
    : undefined;
}
/** MANPAY-02: one line of non-secret proof; long digit runs may be card numbers. */
export const invoiceEvidence = (value: unknown): value is string =>
  invoiceText(value, 200) &&
  !/[\n\r\t]/.test(value) &&
  !/(?:\d[ -]?){13,}/.test(value);
/** MANPAY-04: refunds keep their own status and never read as unpaid. */
export function invoicePaymentStatus(invoice: {
  voidReason: string | null;
  totalCents: number;
  paidCents: number;
  refundedCents?: number;
}) {
  const refunded = invoice.refundedCents ?? 0;
  if (invoice.voidReason) return "Void";
  if (refunded > 0)
    return refunded === invoice.paidCents ? "Refunded" : "Partly refunded";
  if (invoice.paidCents === invoice.totalCents) return "Paid";
  return invoice.paidCents ? "Partially paid" : "Awaiting offline payment";
}
export function invoiceDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function invoiceTotal(terms: InvoiceTerms) {
  return terms.courses.reduce(
    (sum, line) => sum + line.amountCents,
    terms.taxCents,
  );
}
export function validInvoiceTerms(input: unknown): input is InvoiceTerms {
  if (!input || typeof input !== "object") return false;
  const value = input as InvoiceTerms;
  return (
    Array.isArray(value.courses) &&
    value.courses.length > 0 &&
    value.courses.length <= 20 &&
    value.courses.every(
      (line) =>
        line !== null &&
        typeof line === "object" &&
        invoiceText(line.id, 80) &&
        Number.isSafeInteger(line.version) &&
        line.version > 0 &&
        invoiceText(line.description, 200) &&
        invoiceCents(line.amountCents),
    ) &&
    new Set(value.courses.map((line) => line.id)).size ===
      value.courses.length &&
    ["one_time", "monthly"].includes(value.cadence) &&
    invoiceDate(value.startsOn) &&
    invoiceCents(value.taxCents) &&
    invoiceCents(invoiceTotal(value)) &&
    invoiceTotal(value) > 0 &&
    invoiceText(value.issuer, 500) &&
    invoiceText(value.instructions, 2000) &&
    typeof value.sample === "boolean"
  );
}
/** Each month derives from the original day, so January 31 never drifts to March 28. */
export function invoicePeriod(
  anchor: string,
  cycle: number,
): { start: string; end: string } {
  if (
    !invoiceDate(anchor) ||
    !Number.isSafeInteger(cycle) ||
    cycle < 0 ||
    cycle > 1200
  )
    throw Error("Invalid invoice period");
  const date = new Date(anchor + "T00:00:00Z");
  const at = (offset: number) => {
    const first = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1),
    );
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    first.setUTCDate(Math.min(date.getUTCDate(), last));
    return first.toISOString().slice(0, 10);
  };
  return { start: at(cycle), end: at(cycle + 1) };
}
export function invoiceDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseInvoiceMoney(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/.test(value)
  )
    return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return invoiceCents(cents) ? cents : null;
}
