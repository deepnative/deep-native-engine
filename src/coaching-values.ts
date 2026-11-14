import { invoiceCents, invoiceDate } from "./simple-invoice-values.ts";

export interface CoachingRate {
  id: string;
  effectiveMonth: string;
  cents: number;
  version: number;
}
export interface CoachingSnapshot {
  month: string;
  /** #832: first and last day of an administrator-defined period. */
  periodStart?: string;
  periodEnd?: string;
  minutes: number;
  rate: CoachingRate;
  subtotalCents: number;
  name: string;
  email: string;
  /** RECIPIENT-05: present only when the member gave a company. */
  company?: string;
  sample: boolean;
}
export interface CoachingMonth {
  month: string;
  /** #832: the period's first and last day (a calendar month for YYYY-MM). */
  periodStart: string;
  periodEnd: string;
  minutes: number;
  name: string;
  email: string;
  company?: string | null;
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

/** "2026-10" as "October 2026" (UTC), for reading; values stay YYYY-MM. */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// #832 slice B (owner, 12 November 2026): an administrator sets each
// student's billing period. Periods run back to back from the first start
// date; a changed length applies from the next period.

/** One version of a student's billing-period setting. */
export interface BillingSchedule {
  version: number;
  /** "days" for 1 to 31 days (7 is one week, 14 two weeks), or one month. */
  unit: "days" | "month";
  days: number | null;
  /** First day (UTC date) of the first period under this version. */
  startsOn: string;
  /** UTC date the administrator saved it. */
  setOn: string;
}
/** One billing period; `key` is YYYY-MM for a calendar month, else its first day. */
export interface CoachingPeriod {
  key: string;
  start: string;
  end: string;
  days: number;
}
const DAY = 86400000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

export function coachingDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "0001-01-01" &&
    invoiceDate(value)
  );
}
/** A period key: a calendar month or the first day of a defined period. */
export function coachingPeriodKey(value: unknown): value is string {
  return coachingMonth(value) || coachingDate(value);
}
export function addDays(date: string, days: number) {
  return iso(utc(date) + days * DAY);
}
/** The same day `months` later, or that month's last day when it is shorter. */
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) =>
  Math.round((utc(to) - utc(from)) / DAY);
/** The calendar month `month` as a period, as every student had before #832. */
export function monthPeriod(month: string): CoachingPeriod {
  const start = `${month}-01`,
    end = addDays(addMonths(start, 1), -1);
  return { key: month, start, end, days: daysBetween(start, end) + 1 };
}
/**
 * The settings that take effect, oldest first. One replaced before its first
 * period started never applies.
 */
export function effectiveSchedules(schedules: BillingSchedule[]) {
  return schedules
    .filter(
      (s) =>
        !schedules.some((w) => w.version > s.version && w.setOn < s.startsOn),
    )
    .sort((a, b) => a.version - b.version);
}
/** The defined period containing `date`, or null before the first one starts. */
export function periodContaining(
  schedules: BillingSchedule[],
  date: string,
): CoachingPeriod | null {
  const effective = effectiveSchedules(schedules),
    index = effective.findLastIndex((s) => s.startsOn <= date),
    s = effective[index];
  if (!s) return null;
  let start: string, next: string;
  if (s.unit === "month") {
    const [ay, am] = s.startsOn.split("-").map(Number) as [number, number],
      [y, m] = date.split("-").map(Number) as [number, number];
    let k = (y - ay) * 12 + (m - am);
    if (addMonths(s.startsOn, k) > date) k--;
    start = addMonths(s.startsOn, k);
    next = addMonths(s.startsOn, k + 1);
  } else {
    const length = s.days!,
      k = Math.floor(daysBetween(s.startsOn, date) / length);
    start = addDays(s.startsOn, k * length);
    next = addDays(start, length);
  }
  // A later setting starts on a period boundary; never run past it.
  const later = effective[index + 1]?.startsOn;
  if (later && later < next) next = later;
  const end = addDays(next, -1);
  return { key: start, start, end, days: daysBetween(start, end) + 1 };
}
/** Up to `limit` periods that have started by `today`, newest first. */
export function recentPeriods(
  schedules: BillingSchedule[],
  today: string,
  limit: number,
) {
  const periods: CoachingPeriod[] = [];
  for (
    let p = periodContaining(schedules, today);
    p && periods.length < limit;
    p = periodContaining(schedules, addDays(p.start, -1))
  )
    periods.push(p);
  return periods;
}
/** "1 week", "2 weeks", "1 month" or "10 days". */
export function scheduleLabel(s: Pick<BillingSchedule, "unit" | "days">) {
  return s.unit === "month"
    ? "1 month"
    : s.days === 7
      ? "1 week"
      : s.days === 14
        ? "2 weeks"
        : `${s.days} day${s.days === 1 ? "" : "s"}`;
}
/** "2026-11-16" as "16 Nov 2026" (UTC). */
export function dayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
/** A period for reading: "October 2026" or "16 Nov 2026 to 29 Nov 2026". */
export function periodLabel(p: { key: string; start?: string; end?: string }) {
  if (p.key.length === 7) return monthLabel(p.key);
  const start = p.start ?? p.key;
  return !p.end
    ? `Period from ${dayLabel(start)}`
    : p.end === start
      ? dayLabel(start)
      : `${dayLabel(start)} to ${dayLabel(p.end)}`;
}

/**
 * #842 MONTHNAV-01, #844 MONTHNAV-02: previous and next month links instead
 * of a month box. The next link stops at the current month. `extra` is an
 * already-escaped query suffix the links keep, such as a sort order.
 */
export function monthNav(
  base: string,
  month: string,
  today: string,
  extra = "",
) {
  const shift = (by: number) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + by);
    return d.toISOString().slice(0, 7);
  };
  const prev = shift(-1),
    next = shift(1);
  return `<nav class="month-nav" aria-label="Months"><a href="${base}?month=${prev}${extra}">‹ ${periodLabel({ key: prev })}</a>${next <= today ? `<a href="${base}?month=${next}${extra}">${periodLabel({ key: next })} ›</a>` : ""}</nav>`;
}
