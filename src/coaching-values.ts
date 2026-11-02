import { invoiceCents, invoiceDate } from "./simple-invoice-values.ts";

export interface CoachingRate {
  id: string;
  effectiveMonth: string;
  cents: number;
  version: number;
}
export interface CoachingSnapshot {
  month: string;
  minutes: number;
  rate: CoachingRate;
  subtotalCents: number;
  name: string;
  email: string;
  sample: boolean;
}
export interface CoachingMonth {
  month: string;
  minutes: number;
  name: string;
  email: string;
  state: "draft" | "submitted" | "invoiced";
  revision: number;
  submittedRevision: number | null;
  snapshot: CoachingSnapshot | null;
  invoiceId: string | null;
  previousInvoiceId: string | null;
  returnReason: string | null;
}
export function coachingMonth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}$/.test(value) &&
    value >= "0001-01" &&
    invoiceDate(value + "-01")
  );
}
export function coachingMinutes(
  month: string,
  minutes: unknown,
): minutes is number {
  if (
    !coachingMonth(month) ||
    !Number.isSafeInteger(minutes) ||
    Number(minutes) < 0
  )
    return false;
  const date = new Date(month + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return Number(minutes) <= date.getUTCDate() * 24 * 60;
}
export function coachingSubtotal(
  minutes: number,
  rateCents: number,
): number | null {
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 0 ||
    !invoiceCents(rateCents) ||
    rateCents === 0
  )
    return null;
  const numerator = minutes * rateCents + 30;
  if (!Number.isSafeInteger(numerator)) return null;
  const cents = Math.floor(numerator / 60);
  return invoiceCents(cents) ? cents : null;
}
export function parseCoachingDuration(
  hours: unknown,
  minutes: unknown,
): number | null {
  if (
    typeof hours !== "string" ||
    typeof minutes !== "string" ||
    !/^(0|[1-9]\d{0,3})$/.test(hours) ||
    !/^(0|[1-9]\d?)$/.test(minutes) ||
    Number(minutes) > 59
  )
    return null;
  return Number(hours) * 60 + Number(minutes);
}

export function coachingDuration(minutes: number) {
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
}
