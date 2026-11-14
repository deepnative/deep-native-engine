import { monthLabel, monthNav } from "./coaching-values.ts";
import { escape } from "./views.ts";
import type { CoachingStatus } from "./simple-invoice-store.ts";

export type CoachingDashboard = {
  month: string;
  today: string;
  summary: {
    submittedMinutes: number;
    contractorsSubmitted: number;
    invoicedCents: number;
    invoicesNotSent: number;
    outstandingCents: number;
    awaitingReview: number;
    oldestWaitingDays: number | null;
  };
  contractors: Array<{
    id: string;
    displayName: string | null;
    rateCents: number | null;
    minutes: number | null;
    previousMinutes: number | null;
    yearMinutes: number;
    status: CoachingStatus;
    sent: boolean | null;
    balanceCents: number | null;
    /** #832: the period the name opens; null opens the student's current one. */
    periodKey?: string | null;
  }>;
};
export const DASHBOARD_SORTS = ["name", "hours", "year", "status"] as const;
export type DashboardSort = (typeof DASHBOARD_SORTS)[number];

const STATUS: Record<CoachingStatus, string> = {
  submitted: "Awaiting review",
  returned: "Returned for correction",
  draft: "Draft",
  voided: "Invoice voided",
  invoiced: "Invoiced",
  not_started: "Not started",
};
// Status order puts months that need the manager first.
const STATUS_ORDER = Object.keys(STATUS) as CoachingStatus[];
const cad = new Intl.NumberFormat("en-CA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = (cents: number) => `CAD ${cad.format(cents / 100)}`;
export const hours = (minutes: number | null) =>
  minutes === null
    ? "—"
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const monthName = monthLabel;

type Row = CoachingDashboard["contractors"][number];
const byName = (a: Row, b: Row) =>
  a.displayName === null
    ? b.displayName === null
      ? 0
      : 1
    : b.displayName === null
      ? -1
      : a.displayName.localeCompare(b.displayName);
const COMPARE: Record<DashboardSort, (a: Row, b: Row) => number> = {
  name: byName,
  hours: (a, b) => (b.minutes ?? -1) - (a.minutes ?? -1) || byName(a, b),
  year: (a, b) => b.yearMinutes - a.yearMinutes || byName(a, b),
  status: (a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    byName(a, b),
};

/** Manager summary and student table for one month, admin pages only. */
export function coachingDashboardSection(
  d: CoachingDashboard,
  path: string,
  sort: DashboardSort,
) {
  const s = d.summary;
  const card = (label: string, figure: string, note: string) =>
    `<div><dt>${label}</dt><dd>${figure}</dd><p>${note}</p></div>`;
  const waiting =
    s.oldestWaitingDays === null
      ? "none waiting"
      : s.oldestWaitingDays === 0
        ? "oldest submitted today"
        : `oldest waiting ${plural(s.oldestWaitingDays, "day")}`;
  const link = (key: DashboardSort) =>
    `${path}?month=${d.month}&amp;sort=${key}`;
  const header = (key: DashboardSort, label: string) =>
    `<th scope="col" role="columnheader"${sort === key ? ` aria-sort="${key === "name" || key === "status" ? "ascending" : "descending"}"` : ""}><a href="${link(key)}">${label}</a></th>`;
  const rows = [...d.contractors].sort(COMPARE[sort]);
  const body = rows
    .map(
      (r) =>
        `<tr role="row"><th scope="row" role="rowheader"><a href="${path}/${escape(r.id)}${r.periodKey === null ? "" : `?month=${escape(r.periodKey ?? d.month)}`}">${escape(r.displayName ?? "Name needed")}</a></th><td role="cell" data-label="Rate">${r.rateCents === null ? "No rate" : money(r.rateCents)}</td><td role="cell" data-label="Hours">${hours(r.minutes)}</td><td role="cell" data-label="Previous month">${hours(r.previousMinutes)}</td><td role="cell" data-label="Year to date">${hours(r.yearMinutes)}</td><td role="cell" data-label="Status">${STATUS[r.status]}</td><td role="cell" data-label="Invoice email">${r.sent === null ? "—" : r.sent ? "Sent" : "Not sent"}</td><td role="cell" data-label="Balance">${r.balanceCents === null ? "—" : r.balanceCents === 0 ? "Paid" : money(r.balanceCents)}</td></tr>`,
    )
    .join("");
  return `<section class="hours-dashboard" aria-labelledby="hours-title">${monthNav(path, d.month, d.today, `&amp;sort=${sort}`)}<h2 id="hours-title">Hours for ${monthName(d.month)}</h2><dl class="hours-summary">${card("Hours submitted", hours(s.submittedMinutes), plural(s.contractorsSubmitted, "student"))}${card("Awaiting review", String(s.awaitingReview), `all months · ${waiting}`)}${card("Invoiced", money(s.invoicedCents), s.invoicedCents === 0 ? "No invoices yet" : s.invoicesNotSent ? `${s.invoicesNotSent} not yet sent` : "All sent")}${card("Outstanding", money(s.outstandingCents), "on this month’s invoices")}</dl>${
    rows.length
      ? `<div class="table-scroll" role="region" aria-labelledby="students-caption" tabindex="0"><table class="contractor-hours stack-table" role="table" aria-labelledby="students-caption"><caption id="students-caption">Students · ${monthName(d.month)}</caption><thead role="rowgroup"><tr role="row">${header("name", "Name")}<th scope="col" role="columnheader">Rate</th>${header("hours", "Hours")}<th scope="col" role="columnheader">Previous month</th>${header("year", "Year to date")}${header("status", "Status")}<th scope="col" role="columnheader">Invoice email</th><th scope="col" role="columnheader">Balance</th></tr></thead><tbody role="rowgroup">${body}</tbody></table></div>${rows.length >= 100 ? "<p>Showing the first 100 students.</p>" : ""}`
      : "<p>No student has a rate or submitted hours for this month.</p>"
  }<p class="small">Hours count once they are submitted; drafts are excluded. A billing period shorter or longer than a calendar month counts in the month it ends, which is when it can be invoiced; a student with several periods ending in the month shows their total hours and the status of the period that most needs attention. Invoice figures leave out voided invoices.</p></section>`;
}
