import type { BillingProfileStore } from "./billing-profile.ts";
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { csrf, validCsrf } from "./session.ts";
import { page, escape } from "./views.ts";
import { hostingText } from "./hosting-presentation.ts";
import {
  adminMenuFor,
  administrationLink,
  shortInvoiceNumber,
} from "./administration-presentation.ts";
import { coachAssignmentCard } from "./account-role-admin-routes.ts";
import type { AccountRoleAdmin } from "./account-role-admin.ts";
import type {
  AdministratorConsole,
  AdministratorEntry,
} from "./administrator-entry.ts";
import {
  coachingDashboardSection,
  DASHBOARD_SORTS,
  type DashboardSort,
  hours,
} from "./coaching-dashboard-views.ts";
import {
  parseInvoiceMoney,
  salesTaxCents,
  taxRate,
} from "./simple-invoice-values.ts";
import {
  coachingSubtotal,
  coachingDuration,
  parseCoachingDuration,
  addDays,
  dayLabel,
  monthNav,
  periodLabel,
  scheduleLabel,
  type BillingSchedule,
  type CoachingRate,
} from "./coaching-values.ts";
import {
  adminTermsInvoiceSection,
  adminTermsSection,
  memberTermsSection,
  NO_CANCELLATION,
  parseCoachingTerms,
  renewalsSection,
  TERMS_FIELDS,
  TERMS_BOUNDS,
  type CoachingTermsStore,
} from "./coaching-terms.ts";
import {
  adminAgreedSection,
  AGREED_FIELDS,
  memberAgreedSection,
  parseAgreedChange,
  type CoachingAgreedChangesStore,
} from "./coaching-agreed-changes.ts";
import type {
  CoachingHoursOverride,
  InvoiceFailure,
  SavedCoachingMonth,
  SimpleInvoiceStore,
} from "./simple-invoice-store.ts";

const memberPath = "/account/coaching",
  adminPath = "/operator/coaching";
const hidden = (name: string, value: string | number) =>
  `<input type="hidden" name="${name}" value="${escape(String(value))}">`;
const money = (cents: number) => `CAD ${(cents / 100).toFixed(2)}`;
function failure(
  res: Response,
  kind: InvoiceFailure["kind"],
  admin: boolean,
  key?: string,
  detail?: string,
) {
  return res
    .status(
      {
        denied: 403,
        invalid: 422,
        conflict: 409,
        unavailable: 503,
        "not-found": 404,
      }[kind],
    )
    .send(
      page(
        "Coaching request not confirmed",
        `<h1>Coaching request not confirmed</h1><p role="alert">${kind === "unavailable" ? "The outcome is uncertain. Inspect the original operation before another action." : kind === "conflict" ? "This form is out of date or the current state does not allow this action. Reopen the period and review its rate and invoice status." : (detail ?? (admin && kind === "denied" ? 'Your administrator session has ended or was not entered. Open <a href="/admin">Administration</a>, end the earlier session if it asks you to, then enter administration and try again.' : "The request was not accepted. Check the period, whole hours and minutes, recipient and explicit amounts using the current form."))}</p>${key ? `<p><a href="${admin ? "/operator/invoices" : "/account/purchases"}/operations/${escape(key)}">Inspect original operation</a></p>` : ""}<p><a href="${admin ? adminPath : memberPath}">Return to coaching hours</a></p>`,
      ),
    );
}
/** WALK44-01: an administrator opened a student reference no account has now. */
function studentGonePage(menu: string) {
  return page(
    "Student account not found",
    `<section class="invoice-workspace portal-workspace">${menu}<h1>Student account not found</h1><p role="alert">No student account has this reference now. If the student deleted their account, their coaching terms, hours and allowances were removed with it.</p><p>Invoices already issued to a deleted account are kept for the tax record and stay listed under Invoices, without a link to the account.</p>${ALL_STUDENTS}</section>`,
  );
}
// BACK-01 (#850): the one way back from a student's page; the menu has the rest.
const ALL_STUDENTS =
  '<p class="back-link"><a href="/operator">All students</a></p>';
/**
 * SEAM-01 (#850): the student's coaches, folded on their page. The form and
 * its POST are the ones the old Coaches page used.
 */
function coachesDetails(
  result: Awaited<ReturnType<AccountRoleAdmin["learnerCoaches"]>>,
  ownerId: string,
  anti: string,
) {
  const names =
    result.kind !== "ready"
      ? "unavailable"
      : result.value.coaches
          .filter((c) => result.value.assigned.includes(c.emailHash))
          .map((c) => escape(c.label))
          .join(", ") || "none";
  return `<details class="coaching-details" id="student-coaches"><summary>Coaches: ${names}</summary>${coachAssignmentCard(result, ownerId, anti)}</details>`;
}
/** SEAM-01 (#850): course enrollments, bundles and course invoices, folded. */
function coursesDetails(
  chosen: NonNullable<AdministratorConsole["selected"]>,
  ownerId: string,
) {
  const count = (n: number, one: string) =>
    n ? [`${n} ${one}${n === 1 ? "" : "s"}`] : [];
  const group = (title: string, items: string[]) =>
    items.length
      ? `<h3>${title}</h3><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
      : "";
  const records =
    group(
      "Enrollments",
      chosen.enrollments.map((e) => `${escape(e.title)} · ${escape(e.id)}`),
    ) +
    group(
      "Course bundles",
      chosen.plans.map((p) => `Course bundle · ${escape(p.state)}`),
    ) +
    group(
      "Invoices",
      chosen.invoices.map(
        (i) =>
          `<a href="/operator/invoices/${escape(i.id)}">${escape(shortInvoiceNumber(i.number))}</a> · ${money(Number(i.totalCents))} · ${i.delivery === "sent" ? "Sent" : "Not sent"}`,
      ),
    );
  const summary =
    [
      ...count(chosen.enrollments.length, "enrollment"),
      ...count(chosen.plans.length, "bundle"),
      ...count(chosen.invoices.length, "invoice"),
    ].join(", ") || "none";
  return `<details class="coaching-details" id="student-courses"><summary>Courses: ${summary}</summary>${records || "<p>No course enrollment, bundle or course invoice yet.</p>"}<p><a href="/operator/invoices?ownerId=${escape(ownerId)}">Prepare course billing for this student</a></p></details>`;
}
/** HOURTABLE-01/02: saved periods with hours, amount, readable status and invoice. */
// #844 TABLE-01: the explicit roles keep this a table for assistive technology
// when a phone lays each row out as a block.
/** A saved month's state as members and administrators read it. */
export function coachingStatus(m: {
  state: string;
  returned?: boolean;
  totalCents?: string | number | null;
  paidCents?: string | number | null;
  refundedCents?: string | number | null;
  voided?: boolean | null;
}) {
  const total = m.totalCents == null ? null : Number(m.totalCents);
  const paid = Number(m.paidCents ?? 0),
    refunded = Number(m.refundedCents ?? 0);
  if (m.state === "invoiced")
    return m.voided
      ? "Void"
      : total === null
        ? "Invoiced"
        : refunded > 0
          ? refunded === paid
            ? "Invoiced · Refunded"
            : "Invoiced · Partly refunded"
          : paid >= total
            ? "Invoiced · Paid"
            : `Invoiced · ${money(total - paid)} due`;
  if (m.state === "submitted") return "Awaiting review";
  return m.returned ? "Returned for correction" : "Draft";
}

const changedOn = (at: Date) =>
  at.toLocaleDateString("en-CA", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Toronto",
  });
/**
 * #838 ONEPAGE-01: what the saved draft holds, so a request posted with the
 * same values is requested as it is. It only decides whether to save first;
 * the request always uses the stored draft.
 */
function draftPrint(
  minutes: number,
  name: string,
  email: string,
  company: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        minutes,
        name,
        email.trim().toLowerCase(),
        company.trim(),
      ]),
    )
    .digest("hex");
}
// #844 STUDENT-01: the student's own four steps; the rate is not one of them.
const STEPS = ["Save hours", "Request invoice", "Review", "Invoice issued"];
/**
 * #836 NEXTSTEP-01/02: where the student's month stands and the one thing
 * to do next. It reads the same entry and rate as the forms; it decides
 * nothing the store does not.
 */
function studentNextStep(s: {
  e: {
    minutes: number;
    email: string;
    state: string;
    returnReason?: string | null;
    invoiceId?: string | null;
  } | null;
  rate: { cents: number } | null;
  amount: number | null;
  label: string;
  unit: string;
  periodEnd: string | null;
}) {
  const { e, rate, amount, label } = s,
    hours = e ? coachingDuration(e.minutes) : "";
  const button = (href: string, text: string) =>
    `<a class="button" href="${href}">${text}</a>`;
  let step: number,
    status: string,
    message: string,
    action = "";
  if (!e) {
    [step, status] = [0, "Nothing saved yet"];
    message = rate
      ? `Enter your coaching hours for ${label} below, then choose Save and request invoice.`
      : `Enter your coaching hours for ${label} below and save them. Your hourly rate isn't set yet; ask your coach or administrator to set it, then request the invoice here.`;
  } else if (e.state === "submitted") {
    [step, status] = [2, "Awaiting review"];
    message = `Your invoice request is with your administrator for review. The invoice appears here once it is issued; nothing is charged on this site.${s.periodEnd ? ` The invoice can be issued after this ${s.unit} ends on ${dayLabel(s.periodEnd)}.` : ""}`;
  } else if (e.state === "invoiced") {
    [step, status] = [3, "Invoice issued"];
    message = "Your invoice has been issued.";
    if (e.invoiceId)
      action = button(
        `/account/purchases/invoices/${escape(e.invoiceId)}`,
        "View invoice",
      );
  } else if (e.returnReason) {
    [step, status] = [0, "Returned for correction"];
    message = `Your administrator returned these hours: ${escape(e.returnReason)}. Correct them below and choose Save and request invoice.`;
  } else if (!rate) {
    [step, status] = [1, "Draft, not sent yet"];
    message = `Your ${hours} are saved. Your hourly rate isn't set yet, so the invoice can't be requested. Ask your coach or administrator to set it, then come back here to request the invoice.`;
  } else if (amount === null) {
    [step, status] = [1, "Draft, not sent yet"];
    message =
      "The saved hours at this rate exceed the invoice amount limit. Correct your hours or ask your administrator to review the rate.";
  } else {
    [step, status] = [1, "Draft, not sent yet"];
    message = `Ready to request: ${hours} at ${money(rate.cents)} per hour is ${money(amount)} before tax.${amount === 0 ? " A zero total creates no invoice." : ""} Check your hours below and choose Save and request invoice.`;
  }
  const steps = STEPS.map((name, i) =>
    i === step
      ? `<li aria-current="step">${name}</li>`
      : i < step
        ? `<li class="done">${name}</li>`
        : `<li>${name}</li>`,
  ).join("");
  return `<section class="portal-card next-step" aria-labelledby="next-step"><h3 id="next-step">Next step</h3><ol class="coaching-steps">${steps}</ol><p class="next-step-message">${message}</p>${action}<p class="small">Status: ${status} · Rate: ${rate ? `${money(rate.cents)} per hour` : "not set yet"}</p></section>`;
}
/** OVR832-07: each administrator change, with the figure it replaced. */
function hoursChangesSection(rows: CoachingHoursOverride[], admin: boolean) {
  if (!rows.length) return "";
  return `<h2 id="hours-changes">Hours changed by an administrator</h2><p>${admin ? "The student sees each change and its reason, without the administrator’s name." : "An administrator changed the hours you reported here. Your earlier figure is kept below."}</p><ul class="portal-list hours-changes">${rows
    .map(
      (r) =>
        `<li>${changedOn(r.changedAt)} · from <strong>${coachingDuration(r.previousMinutes)}</strong> to <strong>${coachingDuration(r.minutes)}</strong>${admin ? ` · by ${r.actorName ? escape(r.actorName) : "an administrator"}` : ""}<p>Reason: ${escape(r.reason)}</p></li>`,
    )
    .join("")}</ul>`;
}

type Billing = {
  schedules: BillingSchedule[];
  version: number;
  nextStart: string | null;
};
/** "2 weeks, from 2 Nov 2026", then any change that has not started yet. */
function billingSummary(b: Billing, today: string) {
  const started = b.schedules.filter((s) => s.startsOn <= today).at(-1),
    later = b.schedules.filter((s) => s.startsOn > today).at(-1);
  return [
    started
      ? `${scheduleLabel(started)}, from ${dayLabel(started.startsOn)}`
      : null,
    later
      ? `${started ? "then " : ""}${scheduleLabel(later)} from ${dayLabel(later.startsOn)}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
}
/** PERIOD832-01/04: the student's billing period and the form that sets it. */
function adminBillingSection(
  b: Billing,
  today: string,
  action: string,
  hiddenFields: string,
) {
  const length = b.schedules.at(-1),
    custom = length?.unit === "days" && length.days !== 7 && length.days !== 14;
  const chosen = !length
    ? "14"
    : length.unit === "month"
      ? "month"
      : custom
        ? "custom"
        : String(length.days);
  const option = (value: string, label: string) =>
    `<option value="${value}"${value === chosen ? " selected" : ""}>${label}</option>`;
  return `<details class="coaching-details" id="billing-period"><summary>Billing period: ${b.schedules.length ? billingSummary(b, today) : "calendar month"}</summary><p>${
    b.schedules.length
      ? `This student’s billing period: <strong>${billingSummary(b, today)}</strong>.`
      : "No billing period is set, so this student reports hours by calendar month. Set one to have them report per period; 2 weeks is the usual choice."
  } The student reports hours for each period, and a period can be invoiced once it has ended.</p><form method="post" action="${action}">${hiddenFields}<label>Billing period length<select name="length" required>${option("14", "2 weeks")}${option("7", "1 week")}${option("month", "1 month")}${option("custom", "Custom number of days")}</select></label><label>Custom number of days (1 to 31)<input name="days" type="number" min="1" max="31" step="1" value="${custom ? length!.days : ""}"></label>${
    b.nextStart
      ? `<p>A new length applies from ${dayLabel(b.nextStart)}, the day after the current period ends. Periods already saved, submitted or invoiced are not changed.</p>`
      : `<label>First period starts on<input name="startsOn" type="date" value="${length?.startsOn ?? ""}" required></label><p>Periods run back to back from this date. It must be after the last month or period this student has already saved hours for.</p>`
  }<button>Save billing period</button></form></details>`;
}
/** PERIOD832-02: what the student is told about their billing period. */
function memberBillingSection(b: Billing, today: string) {
  return b.schedules.length
    ? `<section class="portal-card" aria-labelledby="billing-period"><h2 id="billing-period">Your billing period</h2><p>Your administrator set your billing period: <strong>${billingSummary(b, today)}</strong>. You report your hours for each period, and its invoice can be issued once the period has ended. A change of length applies from the next period; periods you already saved stay as they are.</p></section>`
    : "";
}

function savedMonthsTable(
  months: SavedCoachingMonth[],
  rates: CoachingRate[],
  base: string,
  invoicePath: string,
) {
  if (!months.length) return "<p>No saved periods.</p>";
  const rateFor = (month: string) =>
    rates
      .filter((r) => r.effectiveMonth <= month)
      .sort(
        (a, b) =>
          b.effectiveMonth.localeCompare(a.effectiveMonth) ||
          b.version - a.version,
      )[0];
  const rows = months.map((m) => {
    const total = m.totalCents == null ? null : Number(m.totalCents);
    const draftRate = rateFor(m.month.slice(0, 7));
    const amount =
      total !== null
        ? money(total)
        : m.submittedCents != null
          ? money(Number(m.submittedCents))
          : draftRate
            ? money(coachingSubtotal(m.minutes, draftRate.cents) ?? 0)
            : "No rate";
    const status = coachingStatus(m);
    const invoice = m.invoiceId
      ? `<a href="${invoicePath}${escape(m.invoiceId)}">View invoice</a>`
      : "—";
    return `<tr role="row"><th scope="row" role="rowheader"><a href="${base}?month=${m.month}">${periodLabel({ key: m.month, start: m.periodStart, end: m.periodEnd })}</a></th><td role="cell" data-label="Hours">${hours(m.minutes)}${m.overridden ? ' <span class="small">changed by an administrator</span>' : ""}</td><td role="cell" data-label="Amount">${amount}</td><td role="cell" data-label="Status">${status}</td><td role="cell" data-label="Invoice">${invoice}</td></tr>`;
  });
  return `<div class="table-scroll" role="region" aria-labelledby="saved-months" tabindex="0"><table class="coaching-months stack-table" role="table" aria-labelledby="saved-months"><caption class="visually-hidden">Saved periods</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Period</th><th scope="col" role="columnheader">Hours</th><th scope="col" role="columnheader">Amount</th><th scope="col" role="columnheader">Status</th><th scope="col" role="columnheader">Invoice</th></tr></thead><tbody role="rowgroup">${rows.join("")}</tbody></table></div>`;
}

export function mountCoachingRoutes(
  app: Express,
  store: SimpleInvoiceStore | undefined,
  options: {
    origin: string;
    secret: string;
    billingProfiles?: BillingProfileStore;
    coachingTerms?: CoachingTermsStore;
    agreedChanges?: CoachingAgreedChangesStore;
  },
  /** #850: the student's coaches and course records on their page. */
  student: {
    roleAdmin?: Pick<AccountRoleAdmin, "learnerCoaches">;
    administratorEntry?: Pick<AdministratorEntry, "console">;
  } = {},
) {
  const token = (res: Response) => res.locals.token as string;
  function valid(
    req: Request,
    res: Response,
    fields: string[] = [],
    query = ["month"],
  ) {
    res.set("Cache-Control", "no-store");
    if (
      Object.entries(req.query).some(
        ([key, value]) =>
          req.method !== "GET" ||
          !query.includes(key) ||
          typeof value !== "string",
      ) ||
      (req.method === "POST" &&
        (!req.body ||
          typeof req.body !== "object" ||
          Array.isArray(req.body) ||
          Object.entries(req.body).some(
            ([key, value]) =>
              typeof value !== "string" ||
              !["csrf", "operationId", "revision", ...fields].includes(key),
          ) ||
          req.get("origin") !== options.origin ||
          !validCsrf(req.body.csrf, token(res), options.secret)))
    ) {
      failure(res, "denied", req.path.startsWith(adminPath));
      return false;
    }
    return true;
  }
  app.get(adminPath, async (req, res) => {
    if (!valid(req, res, [], ["month", "sort"])) return;
    const sort = (req.query.sort ?? "name") as DashboardSort;
    if (!DASHBOARD_SORTS.includes(sort)) return failure(res, "denied", true);
    if (!store) return failure(res, "unavailable", true);
    const dashboard = await store.coachingDashboard(
      token(res),
      req.query.month as string | undefined,
    );
    if (dashboard.kind !== "ready") return failure(res, dashboard.kind, true);
    const result = await store.adminOverview(token(res));
    if (result.kind !== "ready") return failure(res, result.kind, true);
    // #317 RENEW317-01: renewal dates that have passed or are near; read-only.
    let renewals = "";
    if (options.coachingTerms) {
      const due = await options.coachingTerms.renewalsDue(token(res));
      if (due.kind !== "ready")
        return failure(res, due.kind === "invalid" ? "denied" : due.kind, true);
      // #844 PACKAGE-01: no card until a renewal is actually due.
      if (due.value.length) renewals = renewalsSection(due.value, adminPath);
    }
    // #844 NAMES-01: one table of students. Anyone with no rate or hours yet
    // is still a row, so a new student can be opened from here.
    const listed = new Set(dashboard.value.contractors.map((c) => c.id));
    const students = {
      ...dashboard.value,
      contractors: [
        ...dashboard.value.contractors,
        ...result.value.members
          .filter((m) => !listed.has(m.id))
          .map((m) => ({
            id: m.id,
            displayName: m.displayName ?? null,
            rateCents: null,
            minutes: null,
            previousMinutes: null,
            yearMinutes: 0,
            status: "not_started" as const,
            sent: null,
            balanceCents: null,
            periodKey: null,
          })),
      ],
    };
    res.send(
      page(
        "Coaching hours by month",
        `<section class="invoice-workspace portal-workspace">${adminMenuFor(res, "more")}<h1>Coaching hours by month</h1><p>Choose a student to set an hourly rate or billing period, or to review submitted hours.</p>${coachingDashboardSection(students, adminPath, sort)}<section class="portal-card" aria-labelledby="awaiting-review"><h2 id="awaiting-review">Awaiting review</h2><ul class="portal-list">${result.value.coachingPending.map((m) => `<li><a href="${adminPath}/${m.ownerId}?month=${m.month}">${escape(m.displayName ?? "Name needed")} · ${periodLabel({ key: m.month, start: m.periodStart, end: m.periodEnd })}</a></li>`).join("") || "<li>No submitted hours await review.</li>"}</ul></section>${renewals}</section>`,
      ),
    );
  });
  for (const admin of [false, true]) {
    const path = admin ? `${adminPath}/:ownerId` : memberPath;
    app.get(path, async (req, res) => {
      // NEXTSTEP-03: the student's page also reads which action just finished.
      if (!valid(req, res, [], admin ? ["month"] : ["month", "done"])) return;
      if (
        req.query.done !== undefined &&
        !["saved", "requested"].includes(req.query.done as string)
      )
        return failure(res, "denied", admin);
      if (!store)
        return res
          .status(admin ? 503 : 200)
          .send(
            page(
              "Coaching",
              "<h1>Coaching</h1><p>Coaching invoicing is not configured. No rate or payable amount is assumed. Your learning and saved work remain available.</p><h2>How to enter coaching hours</h2><p>Hours entry is unavailable " +
                hostingText("on this preview", "here") +
                " while coaching invoicing is disabled. Ask your administrator to arrange coaching and enable the agreed workflow; there is no hours form to complete here yet.</p><ol><li>When coaching is configured, choose the billing period and save hours and minutes as a draft.</li><li>Your administrator records the agreed hourly rate before you submit.</li><li>Review and submit your hours. Submission does not take payment; an administrator reviews it before an invoice is issued.</li></ol><p>" +
                administrationLink('<a href="/admin">Administration</a> · ') +
                '<a href="/account">My account</a></p>',
            ),
          );
      const r = await store.coachingOverview(
        token(res),
        req.query.month as string | undefined,
        admin ? (req.params as Record<string, string>).ownerId! : undefined,
      );
      if (admin && r.kind === "not-found")
        return res
          .status(404)
          .send(studentGonePage(adminMenuFor(res, "students")));
      if (r.kind !== "ready") return failure(res, r.kind, admin);
      const v = r.value,
        e = v.entry,
        base = admin ? `${adminPath}/${v.ownerId}` : memberPath,
        anti = csrf(token(res), options.secret),
        // ISSUER-03: configured invoices add HST computed by the server.
        hst = store?.tax;
      const recipient =
        !admin && options.billingProfiles
          ? await options.billingProfiles.suggest(token(res))
          : { kind: "ready" as const, value: null };
      if (recipient.kind !== "ready")
        return failure(res, recipient.kind, admin);
      const form = (action: string, revision: number) =>
        `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", revision)}${hidden("month", v.month)}<input type="hidden" name="action" value="${action}">`;
      const snapshot = e?.snapshot,
        amount = v.rate
          ? coachingSubtotal(e?.minutes ?? 0, v.rate.cents)
          : null,
        // #832: a defined period is keyed by its first day; a calendar month
        // keeps the wording it always had.
        period = v.period,
        defined = v.month.length === 10,
        unit = defined ? "period" : "month",
        label = period ? periodLabel(period) : "",
        periodic = v.periods.length > 0;
      // PERIOD832-02: once periods have started, the student picks one of
      // them; before that, a calendar month as before.
      const choices = [
        ...(period && !v.periods.some((p) => p.key === period.key)
          ? [period]
          : []),
        ...v.periods,
      ];
      const picker = periodic
        ? `<form class="period-picker" method="get" action="${base}"><label>Billing period<select name="month">${choices.map((p) => `<option value="${p.key}"${p.key === v.month ? " selected" : ""}>${periodLabel(p)}${p.key === v.periods[0]!.key ? " (current)" : ""}</option>`).join("")}</select></label><button class="secondary">Open period</button></form>`
        : monthNav(base, v.month.slice(0, 7), v.today);
      // #844 STUDENT-01/PLAIN-01: the rate is stated once, in Next step for
      // the student and in the Hourly rate card for the administrator.
      const noRate = v.rate
        ? ""
        : `<p>No rate is set for this ${unit}. Set it under Hourly rate.</p>`;
      // NEXTSTEP-03: a plain confirmation after the student's save or request.
      const done =
        !admin && e && req.query.done === "saved"
          ? `Saved ${coachingDuration(e.minutes)} for ${label}.${v.rate ? "" : " Ask your coach or administrator to set your hourly rate, then request the invoice here."}`
          : !admin && req.query.done === "requested"
            ? `Invoice requested for ${label}. Your administrator will review it.`
            : "";
      // #840 SIMPLE-03: a wide page, the hours on the left and the settings
      // beside them, with no card inside another.
      let body = `${picker}${
        period
          ? admin
            ? `<h2>${label}</h2><p>Status: ${e ? coachingStatus({ state: e.state, returned: Boolean(e.returnReason) }) : "No hours saved"}</p>${e?.returnReason ? `<p role="status">Returned for correction: ${escape(e.returnReason)}</p>` : ""}${noRate}`
            : `<h2>${label}</h2>${studentNextStep({ e, rate: v.rate, amount, label, unit, periodEnd: defined && period.end >= v.date ? period.end : null })}`
          : `<h2>No billing period has started</h2><p role="status">${admin ? "This student’s" : "Your"} first billing period starts on ${dayLabel(v.billing.schedules[0]!.startsOn)}. Hours can be reported from that day.</p>`
      }`;
      if (admin) body += hoursChangesSection(v.overrides, admin);
      // #844 PLAIN-01: what was saved and what was submitted, one line each,
      // for the administrator only. The student reads theirs in Next step.
      if (admin && e)
        body += `${snapshot && e.state !== "draft" ? "" : `<p>Saved hours: ${hours(e.minutes)}</p>`}${snapshot ? `<p>Submitted: ${hours(snapshot.minutes)} at ${money(snapshot.rate.cents)} per hour = ${money(snapshot.subtotalCents)}</p>` : ""}<p>Invoice to: ${escape(e.name)}${e.company ? ` · ${escape(e.company)}` : ""}${e.email ? ` · ${escape(e.email)}` : ""}</p>`;
      if (!admin && period && (!e || e.state === "draft")) {
        // #838 ONEPAGE-01..03: hours, recipient and the invoice request are
        // one form. Save draft comes first, so Enter never requests.
        // #842 NOEMAIL-01: the student is never asked for an invoice
        // email. The recipient is the saved one, else their own name.
        const known = e?.email
            ? e
            : recipient.value?.email
              ? recipient.value
              : null,
          to = {
            name:
              known?.name ||
              e?.name ||
              recipient.value?.name ||
              v.displayName ||
              "Student",
            email: known?.email ?? "",
            company: known?.company ?? "",
          },
          rate = v.rate,
          fields = `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", e?.revision ?? 0)}${hidden("month", v.month)}${e ? hidden("saved", draftPrint(e.minutes, e.name, e.email, e.company ?? "")) : ""}`,
          request = rate
            ? `<h3>Request the invoice</h3><p>The subtotal is your hours × your hourly rate, before ${hst ? `${escape(hst.label)}. ${escape(hst.label)} at ${taxRate(hst)} is added when the invoice is issued` : "tax"}.</p>${e && amount === 0 ? "<p>A zero-total submission creates no invoice.</p>" : ""}${e && amount === null ? '<p role="alert">The saved duration at this rate exceeds the invoice amount limit. Correct the draft or ask the administrator to review the rate.</p>' : ""}<label class="check"><input type="checkbox" name="confirm" value="submit" required><span>I confirm these hours, recipient and the rate ${money(rate.cents)} per hour for ${label}. ${v.sample ? "This is a sample, not payable." : "I submit for configured offline invoicing; issued financial records may be retained after account deletion."}</span></label>${hidden("rateId", rate.id)}${hidden("sample", String(v.sample))}<div class="form-actions"><button class="secondary" name="action" value="save" formnovalidate>Save draft</button><button name="action" value="request" formaction="${base}/request">Save and request invoice</button></div>`
            : `<h3>Request the invoice</h3><p class="rate-missing">Your hourly rate for ${label} isn't set yet, so the invoice can't be requested. Ask your coach or administrator to set it. You can save your hours now and request the invoice here once it's set.</p><div class="form-actions"><button name="action" value="save">Save draft</button><button type="button" disabled>Save and request invoice</button></div>`;
        body += `<h2>Your hours</h2><form id="hours-form" method="post" action="${base}/save">${fields}<div class="duration-fields"><label>Hours<input name="hours" type="number" min="0" max="${defined ? period.days * 24 : 744}" step="1" value="${Math.floor((e?.minutes ?? 0) / 60)}" required></label><label>Minutes<input name="minutes" type="number" min="0" max="59" step="1" value="${(e?.minutes ?? 0) % 60}" required></label></div>${hidden("name", to.name)}${hidden("email", to.email)}${hidden("company", to.company)}<p class="invoice-to">Invoice to: <strong>${escape(to.name)}</strong>${to.company ? ` · ${escape(to.company)}` : ""}${to.email ? ` · ${escape(to.email)}` : ""}. <a href="/account/billing">Change</a>${to.email ? "" : '<br><span class="small">The invoice will be under Invoices.</span>'}</p>${request}</form>`;
      }
      if (e?.invoiceId)
        body += `${admin ? `<p><a href="/operator/invoices/${e.invoiceId}">View issued invoice</a></p>` : ""}<p>To correct an issued ${unit}, the administrator must first void its unpaid invoice. Paid or partially paid invoices cannot be corrected here; contact the administrator for financial review.</p>`;
      if (e?.previousInvoiceId)
        body += `<p><a href="${admin ? "/operator/invoices/" : "/account/purchases/invoices/"}${e.previousInvoiceId}">View preserved original invoice</a></p>`;
      if (admin && e && e.state !== "draft") {
        // PERIOD832-03: a defined period is invoiced only after its last day.
        if (e.state === "submitted" && defined && period!.end >= v.date)
          body += `<p role="status">This period ends on ${dayLabel(period!.end)}. Its invoice can be issued from ${dayLabel(addDays(period!.end, 1))}; until then you can change the hours or return them for correction.</p>`;
        else if (
          e.state === "submitted" &&
          snapshot &&
          snapshot.subtotalCents > 0 &&
          snapshot.sample === v.sample
        )
          body += `<h2>Issue the reviewed invoice</h2><form method="post" action="${base}/issue">${form("issue", e.revision)}${hst ? `<p>${escape(hst.label)} at ${taxRate(hst)} (${money(salesTaxCents(snapshot.subtotalCents, hst))}) is added to the subtotal.</p>` : `<label>${v.sample ? "Invented sample tax (CAD)" : "Explicit tax amount (CAD)"}<input name="tax" inputmode="decimal" ${v.sample ? 'value="0.00"' : ""} required></label>`}<label class="check"><input type="checkbox" name="confirm" value="issue" required><span>I reviewed these submitted hours and the ${hst ? `computed ${escape(hst.label)}` : "separately supplied tax"}.</span></label><button>Issue coaching invoice</button></form>`;
        else if (e.state === "submitted")
          body += `<p role="status">${snapshot?.sample !== v.sample ? "The submitted billing mode differs from current configuration. Return it and ask the student to confirm the current mode." : "This zero-total submission is retained. No invoice can be issued."}</p>`;
        body += `<details class="coaching-details"><summary>Return for correction</summary><p>An issued ${unit} can only be returned after its invoice is void and unpaid, with no delivery in progress or unconfirmed. Other financial corrections require administrator review outside this action.</p><form method="post" action="${base}/return">${form("return", e.revision)}<label>Correction reason<input name="reason" maxlength="500" required></label><button class="secondary">Return ${unit} for correction</button></form></details>`;
      }
      // #832 OVR832-01..03/06: change hours the student saved or submitted.
      if (admin && e && e.state !== "invoiced")
        body += `<details class="coaching-details"><summary>Change this student’s hours</summary><p>Correct hours the student has saved or submitted. The student sees the earlier figure, the new figure and your reason on their coaching page and in Download my records. ${e.state === "submitted" ? `The ${unit} stays awaiting review at the rate the student confirmed, and its subtotal is recalculated.` : "The draft stays the student’s to submit."}</p><form method="post" action="${base}/override">${form("override", e.revision)}<div class="duration-fields"><label>Hours<input name="hours" type="number" min="0" max="${defined ? period!.days * 24 : 744}" step="1" value="${Math.floor(e.minutes / 60)}" required></label><label>Minutes<input name="minutes" type="number" min="0" max="59" step="1" value="${e.minutes % 60}" required></label></div><label>Reason for the change<input name="reason" maxlength="500" required></label><button>Change hours</button></form></details>`;
      else if (admin && !e && period)
        body += `<p>The student has not saved hours for this ${unit}. An administrator cannot enter new hours for a student; once the student saves hours, you can change them here.</p>`;
      if (!admin) body += hoursChangesSection(v.overrides, admin);
      body += `<h2 id="saved-months">Saved periods</h2>${savedMonthsTable(v.months, v.rates, base, admin ? "/operator/invoices/" : "/account/purchases/invoices/")}`;
      let side = "";
      // #840 SIMPLE-01: one hourly rate, first in the side column.
      if (admin)
        side += `<section class="portal-card" aria-labelledby="hourly-rate"><h2 id="hourly-rate">Hourly rate</h2><p class="rate-now">${v.rate ? `<strong>${money(v.rate.cents)} per hour</strong> from ${periodLabel({ key: v.rate.effectiveMonth })}` : `No hourly rate set${label ? ` for ${label}` : ""}.`}</p><form method="post" action="${base}/rate">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", v.rateVersion)}<label>Hourly rate (CAD)<input name="rate" inputmode="decimal" value="${v.rate ? (v.rate.cents / 100).toFixed(2) : ""}" required></label><label>Applies from<input type="month" name="effectiveMonth" value="${v.month.slice(0, 7)}" required></label><button>Save hourly rate</button></form><p class="small">The rate applies from that month on. Hours a student already requested keep the rate they confirmed.</p></section>`;
      // PERIOD832-01/02: the billing period, beside the hours.
      side += admin
        ? adminBillingSection(
            v.billing,
            v.date,
            `${base}/billing-period`,
            `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", v.billing.version)}`,
          )
        : memberBillingSection(v.billing, v.date);
      // #840 SIMPLE-02: packages and agreed changes are optional and live on
      // their own page; the student keeps their terms card, with the contact
      // line, and the folded agreed changes beside the hours.
      // #844 PACKAGE-01/STUDENT-01: the package link, the terms card and the
      // agreed changes appear only once there is something in them. The
      // contact line is on the student's page once either way.
      const refused = (kind: string) =>
        failure(res, (kind === "invalid" ? "denied" : kind) as never, admin);
      let foot = "";
      if (admin) {
        let has = false;
        if (options.coachingTerms) {
          const t = await options.coachingTerms.forStudent(
            token(res),
            v.ownerId,
          );
          if (t.kind !== "ready") return refused(t.kind);
          has = t.value !== null;
        }
        if (!has && options.agreedChanges) {
          const a = await options.agreedChanges.forStudent(
            token(res),
            v.ownerId,
          );
          if (a.kind !== "ready") return refused(a.kind);
          has = a.value.length > 0;
        }
        if (has)
          side += `<p class="coaching-more"><a href="${base}/package">Coaching package and agreed changes</a></p>`;
        // SEAM-01 (#850): coaches and course records live on this page now.
        if (student.roleAdmin)
          side += coachesDetails(
            await student.roleAdmin.learnerCoaches(token(res), v.ownerId),
            v.ownerId,
            anti,
          );
        const courses = await student.administratorEntry?.console?.(
          token(res),
          v.ownerId,
        );
        if (courses?.kind === "ready" && courses.value.selected)
          side += coursesDetails(courses.value.selected, v.ownerId);
      } else {
        foot = `<p class="small coaching-contact">${NO_CANCELLATION}</p>`;
        if (options.coachingTerms) {
          const t = await options.coachingTerms.own(token(res));
          if (t.kind !== "ready") return refused(t.kind);
          if (t.value) {
            side += memberTermsSection(t.value);
            foot = "";
          }
        }
        if (options.agreedChanges) {
          const a = await options.agreedChanges.own(token(res));
          if (a.kind !== "ready") return refused(a.kind);
          if (a.value.length)
            side += `<details class="coaching-details"><summary>Agreed changes, early release and refunds</summary>${memberAgreedSection(a.value)}</details>`;
        }
      }
      body = `<section class="invoice-workspace coaching-page${admin ? " portal-workspace" : ""}">${admin ? adminMenuFor(res, "students") : ""}<h1>${admin ? escape(v.displayName ?? "Name needed") : "Coaching"}</h1>${admin ? '<p class="page-kind">Student</p>' : ""}${done ? `<p class="notice" role="status">${done}</p>` : ""}${admin || v.sample ? `<p>${v.sample ? "SAMPLE · NOT PAYABLE. All sample amounts and tax are invented." : "Configured offline invoicing. Submission does not take payment; an administrator reviews it before issuing an invoice."}</p>` : ""}${admin ? "" : `<p>Enter your hours for the ${periodic ? "billing period" : "month"}, then request the invoice; your administrator reviews it before it is issued and nothing is charged on this site.</p>`}<div class="coaching-layout"><div class="coaching-main">${body}</div>${side ? `<aside class="coaching-side">${side}</aside>` : ""}</div>${foot}${
        admin
          ? ALL_STUDENTS
          : '<p class="back-link"><a href="/account/purchases">Invoices</a></p>'
      }</section>`;
      res.send(
        page(admin ? (v.displayName ?? "Name needed") : "Coaching", body),
      );
    });
  }
  // #840 SIMPLE-02: the optional coaching package, its invoice and agreed
  // changes, off the student's hours page.
  app.get(`${adminPath}/:ownerId/package`, async (req, res) => {
    if (!valid(req, res, [], [])) return;
    if (!store) return failure(res, "unavailable", true);
    const ownerId = (req.params as Record<string, string>).ownerId!;
    const r = await store.coachingOverview(token(res), undefined, ownerId);
    if (r.kind === "not-found")
      return res
        .status(404)
        .send(studentGonePage(adminMenuFor(res, "students")));
    if (r.kind !== "ready") return failure(res, r.kind, true);
    const refused = (kind: string) =>
      failure(res, (kind === "invalid" ? "denied" : kind) as never, true);
    const base = `${adminPath}/${ownerId}`,
      anti = csrf(token(res), options.secret),
      fields = (revision?: number) =>
        `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${revision === undefined ? "" : hidden("revision", revision)}`;
    let main = "",
      side = "";
    if (options.coachingTerms) {
      const t = await options.coachingTerms.forStudent(token(res), ownerId);
      if (t.kind !== "ready") return refused(t.kind);
      const i = await store.coachingTermsInvoice(token(res), ownerId);
      if (i.kind !== "ready") return refused(i.kind);
      main = adminTermsSection(
        t.value,
        `${base}/terms`,
        fields(t.value?.version ?? 0),
      );
      side = adminTermsInvoiceSection(
        i.value,
        `${base}/terms-invoice`,
        fields(i.value.terms?.version ?? 0),
        store.tax,
        r.value.sample,
      );
    }
    if (options.agreedChanges) {
      const a = await options.agreedChanges.forStudent(token(res), ownerId);
      if (a.kind !== "ready") return refused(a.kind);
      side += adminAgreedSection(a.value, `${base}/agreed-change`, fields());
    }
    res.send(
      page(
        "Coaching package",
        `<section class="invoice-workspace portal-workspace coaching-page">${adminMenuFor(res, "students")}<h1>Coaching package</h1><p class="page-kind">Student: <a href="${base}">${escape(r.value.displayName ?? "Name needed")}</a></p><p>Optional. Most students only need an hourly rate, which you set on their page. Use this page for a prepaid coaching package with allowances, its invoice, or a change you agreed with the student.</p><div class="coaching-layout"><div class="coaching-main">${main}</div><aside class="coaching-side">${side}</aside></div></section>`,
      ),
    );
  });
  // #316 TERMS316-01..05: a platform administrator saves a new terms version.
  app.post(`${adminPath}/:ownerId/terms`, async (req, res) => {
    if (!valid(req, res, [...TERMS_FIELDS])) return;
    if (!options.coachingTerms) return failure(res, "unavailable", true);
    const values = parseCoachingTerms(req.body);
    if (
      values === null ||
      !/^(0|[1-9]\d{0,8})$/.test(String(req.body.revision))
    )
      return failure(
        res,
        "invalid",
        true,
        undefined,
        `The coaching terms were not saved. Check the price, dates and whole-number allowances, and that ${TERMS_BOUNDS} are within their bounds.`,
      );
    const ownerId = (req.params as Record<string, string>).ownerId!;
    const r = await options.coachingTerms.save(token(res), {
      ...values,
      ownerId,
      expectedVersion: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${ownerId}/package`)
      : failure(res, r.kind, true);
  });
  // #94 AGREED94-01/02/04/05: a platform administrator records an agreed change.
  app.post(`${adminPath}/:ownerId/agreed-change`, async (req, res) => {
    if (!valid(req, res, [...AGREED_FIELDS])) return;
    if (!options.agreedChanges) return failure(res, "unavailable", true);
    const values = parseAgreedChange(req.body);
    if (values === null) return failure(res, "invalid", true);
    const ownerId = (req.params as Record<string, string>).ownerId!;
    const r = await options.agreedChanges.record(token(res), {
      ...values,
      ownerId,
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${ownerId}/package#agreed-changes`)
      : failure(res, r.kind, true);
  });
  // #318 TERMSINV318-01..06: one invoice for the current terms version.
  app.post(`${adminPath}/:ownerId/terms-invoice`, async (req, res) => {
    // ISSUER-03: a typed tax is refused when the server computes HST.
    if (!valid(req, res, store?.tax ? ["confirm"] : ["tax", "confirm"])) return;
    if (!store) return failure(res, "unavailable", true);
    const taxCents = parseInvoiceMoney(req.body.tax);
    if (
      req.body.confirm !== "terms-invoice" ||
      !/^[1-9]\d{0,8}$/.test(String(req.body.revision)) ||
      (!store.tax && taxCents === null)
    )
      return failure(res, "invalid", true);
    const r = await store.issueCoachingTerms(token(res), {
      ownerId: (req.params as Record<string, string>).ownerId!,
      version: Number(req.body.revision),
      operationId: req.body.operationId,
      ...(store.tax ? {} : { taxCents: taxCents! }),
    });
    return r.kind === "ready"
      ? res.redirect(303, `/operator/invoices/${r.value.invoiceId}`)
      : failure(res, r.kind, true, req.body.operationId);
  });
  app.post(`${adminPath}/:ownerId/rate`, async (req, res) => {
    if (!valid(req, res, ["effectiveMonth", "rate"])) return;
    if (!store) return failure(res, "unavailable", true);
    const cents = parseInvoiceMoney(req.body.rate);
    if (cents === null) return failure(res, "invalid", true);
    const r = await store.setCoachingRate(token(res), {
      ownerId: (req.params as Record<string, string>).ownerId!,
      effectiveMonth: req.body.effectiveMonth,
      cents,
      expectedVersion: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(
          303,
          `${adminPath}/${(req.params as Record<string, string>).ownerId!}`,
        )
      : failure(res, r.kind, true, req.body.operationId);
  });
  // #832 PERIOD832-01/04: a platform administrator sets the billing period.
  app.post(`${adminPath}/:ownerId/billing-period`, async (req, res) => {
    if (!valid(req, res, ["length", "days", "startsOn"])) return;
    if (!store) return failure(res, "unavailable", true);
    const ownerId = (req.params as Record<string, string>).ownerId!,
      { length, days = "", startsOn } = req.body as Record<string, string>,
      custom = length === "custom";
    if (
      !["7", "14", "month", "custom"].includes(length ?? "") ||
      (custom ? !/^([1-9]|[12]\d|3[01])$/.test(days) : days !== "") ||
      !/^(0|[1-9]\d{0,8})$/.test(String(req.body.revision))
    )
      return failure(
        res,
        "invalid",
        true,
        undefined,
        "The billing period was not saved. Choose 1 week, 2 weeks or 1 month, or choose a custom number of days and enter 1 to 31; leave the custom days empty otherwise.",
      );
    const r = await store.setBillingSchedule(token(res), {
      ownerId,
      ...(length === "month"
        ? { unit: "month" as const }
        : { unit: "days" as const, days: Number(custom ? days : length) }),
      ...(startsOn === undefined ? {} : { startsOn }),
      expectedVersion: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${ownerId}#billing-period`)
      : failure(
          res,
          r.kind,
          true,
          req.body.operationId,
          "The billing period was not saved. A first period must start on a valid date within a year of today, after the last month or period the student already saved hours for. Once periods have started, only the length changes, from the next period, and it must differ from the current setting.",
        );
  });
  // #832 OVR832-01..06/08: a platform administrator changes saved hours.
  app.post(`${adminPath}/:ownerId/override`, async (req, res) => {
    if (!valid(req, res, ["month", "action", "hours", "minutes", "reason"]))
      return;
    if (!store) return failure(res, "unavailable", true);
    const minutes = parseCoachingDuration(req.body.hours, req.body.minutes),
      ownerId = (req.params as Record<string, string>).ownerId!;
    if (req.body.action !== "override" || minutes === null)
      return failure(res, "invalid", true);
    const r = await store.overrideCoachingHours(token(res), {
      ownerId,
      month: req.body.month,
      minutes,
      reason: req.body.reason,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(
          303,
          `${adminPath}/${ownerId}?month=${encodeURIComponent(req.body.month)}#hours-changes`,
        )
      : failure(
          res,
          r.kind,
          true,
          req.body.operationId,
          r.kind === "not-found"
            ? "The student has not saved hours for this period, so there is nothing to change. An administrator cannot enter new hours for a student."
            : "The hours were not changed. Give a reason, and hours that fit the period and differ from the current figure.",
        );
  });
  // #838 ONEPAGE-01/02: the student's one form saves the entered values and
  // requests the invoice. Each step keeps its own operation and revision.
  app.post(`${memberPath}/request`, async (req, res) => {
    if (
      !valid(req, res, [
        "month",
        "action",
        "hours",
        "minutes",
        "name",
        "email",
        "company",
        "rateId",
        "sample",
        "confirm",
        "saved",
      ])
    )
      return;
    if (!store) return failure(res, "unavailable", false);
    const minutes = parseCoachingDuration(req.body.hours, req.body.minutes);
    if (
      req.body.action !== "request" ||
      req.body.confirm !== "submit" ||
      minutes === null ||
      typeof req.body.email !== "string" ||
      !["true", "false"].includes(req.body.sample)
    )
      return failure(
        res,
        "invalid",
        false,
        undefined,
        "The invoice was not requested and nothing was saved. Enter whole hours and minutes and tick the confirmation.",
      );
    const month = req.body.month,
      expected = Number(req.body.revision),
      name = req.body.name,
      email = req.body.email,
      company = req.body.company ?? "";
    // A draft saved exactly as posted is requested as it is, keeping its
    // revision and this form's operation; otherwise the edits are saved first.
    const unchanged =
      typeof req.body.saved === "string" &&
      req.body.saved === draftPrint(minutes, name, email, company);
    let revision = expected,
      operationId = req.body.operationId as string;
    if (!unchanged) {
      const saved = await store.saveCoaching(token(res), {
        month,
        expectedRevision: expected,
        operationId,
        minutes,
        name,
        email,
        company,
      });
      if (saved.kind !== "ready")
        return failure(res, saved.kind, false, operationId);
      revision = saved.value.revision;
      operationId = randomUUID();
    }
    const requested = await store.submitCoaching(token(res), {
      month,
      expectedRevision: revision,
      operationId,
      rateId: req.body.rateId,
      sample: req.body.sample === "true",
    });
    if (requested.kind !== "ready" && unchanged)
      return failure(res, requested.kind, false, operationId);
    if (requested.kind !== "ready")
      return res
        .status(
          {
            denied: 403,
            invalid: 422,
            conflict: 409,
            unavailable: 503,
            "not-found": 404,
          }[requested.kind],
        )
        .send(
          page(
            "Invoice not requested",
            `<h1>Invoice not requested</h1><p role="alert">Your hours were saved, but the invoice was not requested. ${requested.kind === "conflict" ? "This form is out of date: the rate or the period changed since the page opened. Review them and request again." : requested.kind === "unavailable" ? "The outcome is uncertain; reopen the period to see whether it was requested." : "Check the period and rate, then request again."}</p><p><a href="${memberPath}?month=${encodeURIComponent(month)}">Return to coaching hours</a></p>`,
          ),
        );
    return res.redirect(
      303,
      `${memberPath}?month=${encodeURIComponent(month)}&done=requested`,
    );
  });
  for (const action of ["save", "submit", "return", "issue"] as const) {
    const admin = action === "return" || action === "issue",
      base = admin ? `${adminPath}/:ownerId` : memberPath;
    app.post(`${base}/${action}`, async (req, res) => {
      const fields = {
        // ONEPAGE-01: Save draft sends the whole form, request fields too.
        save: [
          "hours",
          "minutes",
          "name",
          "email",
          "company",
          "rateId",
          "sample",
          "confirm",
          "saved",
        ],
        submit: ["rateId", "sample", "confirm"],
        return: ["reason"],
        // ISSUER-03: a typed tax is refused when the server computes HST.
        issue: store?.tax ? ["confirm"] : ["tax", "confirm"],
      }[action];
      if (!valid(req, res, ["month", "action", ...fields])) return;
      if (!store) return failure(res, "unavailable", admin);
      if (
        req.body.action !== action ||
        ((action === "submit" || action === "issue") &&
          req.body.confirm !== action)
      )
        return failure(res, "invalid", admin);
      const input = {
        month: req.body.month,
        expectedRevision: Number(req.body.revision),
        operationId: req.body.operationId,
      };
      const minutes = parseCoachingDuration(req.body.hours, req.body.minutes),
        taxCents = parseInvoiceMoney(req.body.tax);
      if (
        (action === "save" && minutes === null) ||
        (action === "issue" && !store?.tax && taxCents === null) ||
        (action === "submit" && !["true", "false"].includes(req.body.sample))
      )
        return failure(res, "invalid", admin);
      const r =
        action === "save"
          ? await store.saveCoaching(token(res), {
              ...input,
              minutes: minutes!,
              name: req.body.name,
              email: req.body.email,
              company: req.body.company,
            })
          : action === "submit"
            ? await store.submitCoaching(token(res), {
                ...input,
                rateId: req.body.rateId,
                sample: req.body.sample === "true",
              })
            : action === "return"
              ? await store.returnCoaching(token(res), {
                  ...input,
                  ownerId: (req.params as Record<string, string>).ownerId!,
                  reason: req.body.reason,
                })
              : await store.issueCoaching(token(res), {
                  ...input,
                  ownerId: (req.params as Record<string, string>).ownerId!,
                  ...(store?.tax ? {} : { taxCents: taxCents! }),
                });
      if (r.kind !== "ready")
        return failure(
          res,
          r.kind,
          admin,
          req.body.operationId,
          action === "issue"
            ? "The invoice was not issued. A billing period can be invoiced only after its last day; also check the amount and the current form."
            : undefined,
        );
      return res.redirect(
        303,
        "invoiceId" in r.value
          ? `/operator/invoices/${r.value.invoiceId}`
          : `${admin ? `${adminPath}/${(req.params as Record<string, string>).ownerId!}` : memberPath}?month=${encodeURIComponent(req.body.month)}${admin ? "" : action === "save" ? "&done=saved" : "&done=requested"}`,
      );
    });
  }
}
