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
const hours = (minutes: number | null) =>
  minutes === null
    ? "—"
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

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

/** Manager summary and contractor table for one month, admin pages only. */
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
    `<th scope="col"${sort === key ? ` aria-sort="${key === "name" || key === "status" ? "ascending" : "descending"}"` : ""}><a href="${link(key)}">${label}</a></th>`;
  const rows = [...d.contractors].sort(COMPARE[sort]);
  const body = rows
    .map(
      (r) =>
        `<tr><th scope="row"><a href="${path}/${escape(r.id)}?month=${d.month}">${escape(r.displayName ?? "Name needed")}</a><span>${escape(r.id.slice(0, 8))}</span></th><td>${r.rateCents === null ? "No rate" : money(r.rateCents)}</td><td>${hours(r.minutes)}</td><td>${hours(r.previousMinutes)}</td><td>${hours(r.yearMinutes)}</td><td>${STATUS[r.status]}</td><td>${r.sent === null ? "—" : r.sent ? "Sent" : "Not sent"}</td><td>${r.balanceCents === null ? "—" : r.balanceCents === 0 ? "Paid" : money(r.balanceCents)}</td></tr>`,
    )
    .join("");
  return `<section class="hours-dashboard" aria-labelledby="hours-title"><h2 id="hours-title">Hours for ${monthName(d.month)}</h2><form class="month-picker" method="get" action="${path}"><label>Month<input type="month" name="month" value="${d.month}" max="${d.today}" required></label><input type="hidden" name="sort" value="${sort}"><button class="secondary">Show month</button></form><dl class="hours-summary">${card("Hours submitted", hours(s.submittedMinutes), plural(s.contractorsSubmitted, "contractor"))}${card("Awaiting review", String(s.awaitingReview), `all months · ${waiting}`)}${card("Invoiced", money(s.invoicedCents), s.invoicedCents === 0 ? "No invoices yet" : s.invoicesNotSent ? `${s.invoicesNotSent} not yet sent` : "All sent")}${card("Outstanding", money(s.outstandingCents), "on this month’s invoices")}</dl>${
    rows.length
      ? `<div class="table-scroll" role="region" aria-labelledby="contractors-caption" tabindex="0"><table class="contractor-hours"><caption id="contractors-caption">Contractors · ${monthName(d.month)}</caption><thead><tr>${header("name", "Name")}<th scope="col">Rate</th>${header("hours", "Hours")}<th scope="col">Previous month</th>${header("year", "Year to date")}${header("status", "Status")}<th scope="col">Invoice email</th><th scope="col">Balance</th></tr></thead><tbody>${body}</tbody></table></div>${rows.length >= 100 ? "<p>Showing the first 100 contractors.</p>" : ""}`
      : "<p>No contractor has a rate or submitted hours for this period.</p>"
  }<p class="small">Hours count once a month is submitted; drafts are excluded. Invoice figures leave out voided invoices.</p></section>`;
}
