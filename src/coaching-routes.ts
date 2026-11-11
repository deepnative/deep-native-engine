import type { BillingProfileStore } from "./billing-profile.ts";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { csrf, validCsrf } from "./session.ts";
import { page, escape } from "./views.ts";
import { hostingText } from "./hosting-presentation.ts";
import { administrationLink } from "./administration-presentation.ts";
import { portalActions } from "./backend-portal-presentation.ts";
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
  monthLabel,
  type CoachingRate,
} from "./coaching-values.ts";
import {
  adminTermsInvoiceSection,
  adminTermsSection,
  memberTermsSection,
  parseCoachingTerms,
  renewalsSection,
  TERMS_FIELDS,
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
        `<h1>Coaching request not confirmed</h1><p role="alert">${kind === "unavailable" ? "The outcome is uncertain. Inspect the original operation before another action." : kind === "conflict" ? "This form is out of date or the current state does not allow this action. Reopen the month and review its rate, revision and invoice status." : "The request was not accepted. Check the month, whole hours and minutes, recipient and explicit amounts using the current form."}</p>${key ? `<p><a href="${admin ? "/operator/invoices" : "/account/purchases"}/operations/${escape(key)}">Inspect original operation</a></p>` : ""}<p><a href="${admin ? adminPath : memberPath}">Return to monthly coaching</a></p>`,
      ),
    );
}
/** WALK44-01: an administrator opened a student reference no account has now. */
function studentGonePage() {
  return page(
    "Student account not found",
    `<section class="invoice-workspace portal-workspace"><h1>Student account not found</h1><p role="alert">No student account has this reference now. If the student deleted their account, their coaching terms, hours and allowances were removed with it.</p><p>Invoices already issued to a deleted account are kept for the tax record and stay listed under Courses and invoices, without a link to the account.</p>${portalActions(
      [
        [adminPath, "Choose another member"],
        ["/operator/invoices", "Courses and invoices"],
      ],
    )}</section>`,
  );
}
/** HOURTABLE-01/02: saved months with hours, amount, readable status and invoice. */
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

function savedMonthsTable(
  months: SavedCoachingMonth[],
  rates: CoachingRate[],
  base: string,
  invoicePath: string,
) {
  if (!months.length) return "<p>No saved months.</p>";
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
    const draftRate = rateFor(m.month);
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
    return `<tr><th scope="row"><a href="${base}?month=${m.month}">${monthLabel(m.month)}</a></th><td>${hours(m.minutes)}</td><td>${amount}</td><td>${status}</td><td>${invoice}</td></tr>`;
  });
  return `<div class="table-scroll" role="region" aria-labelledby="saved-months" tabindex="0"><table class="coaching-months"><thead><tr><th scope="col">Month</th><th scope="col">Hours</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Invoice</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
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
      renewals = renewalsSection(due.value, adminPath);
    }
    res.send(
      page(
        "Coaching administration",
        `<section class="invoice-workspace portal-workspace"><h1>Coaching administration</h1><p>Choose a member to set an agreed hourly rate or review a submitted month. Registration and rate assignment create no invoice.</p>${portalActions(
          [
            ["/operator/invoices", "Courses and invoices"],
            ["/operator", "Administration console"],
          ],
        )}${coachingDashboardSection(dashboard.value, adminPath, sort)}${renewals}<section class="portal-card"><h2>Members</h2><ul class="portal-list">${result.value.members.map((m) => `<li><a href="${adminPath}/${m.id}">${escape(m.displayName ?? "Name needed")}</a><p class="small">Account reference: <code>${escape(m.id)}</code></p></li>`).join("") || "<li>No members available.</li>"}</ul></section><section class="portal-card"><h2>Pending months</h2><ul class="portal-list">${result.value.coachingPending.map((m) => `<li><a href="${adminPath}/${m.ownerId}?month=${m.month}">${escape(m.displayName ?? "Name needed")} · ${monthLabel(m.month)}</a><p class="small">Account reference: <code>${escape(m.ownerId)}</code></p></li>`).join("") || "<li>No submitted months await review.</li>"}</ul></section></section>`,
      ),
    );
  });
  for (const admin of [false, true]) {
    const path = admin ? `${adminPath}/:ownerId` : memberPath;
    app.get(path, async (req, res) => {
      if (!valid(req, res)) return;
      if (!store)
        return res
          .status(admin ? 503 : 200)
          .send(
            page(
              "Monthly coaching hours",
              "<h1>Monthly coaching hours</h1><p>Coaching invoicing is not configured. No rate or payable amount is assumed. Your learning and saved work remain available.</p><h2>How to enter coaching hours</h2><p>Hours entry is unavailable " +
                hostingText("on this preview", "here") +
                " while coaching invoicing is disabled. Ask your administrator to arrange coaching and enable the agreed workflow; there is no hours form to complete here yet.</p><ol><li>When coaching is configured, choose the calendar month and save hours and minutes as a draft.</li><li>Your administrator records the agreed hourly rate before you submit.</li><li>Review and submit your month. Submission does not take payment; an administrator reviews it before an invoice is issued.</li></ol><p>" +
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
        return res.status(404).send(studentGonePage());
      if (r.kind !== "ready") return failure(res, r.kind, admin);
      const v = r.value,
        e = v.entry,
        base = admin ? `${adminPath}/${v.ownerId}` : memberPath,
        anti = csrf(token(res), options.secret),
        // ISSUER-03: configured invoices add HST computed by the server.
        hst = store?.tax;
      const recipient =
        !admin && !e && options.billingProfiles
          ? await options.billingProfiles.suggest(token(res))
          : { kind: "ready" as const, value: null };
      if (recipient.kind !== "ready")
        return failure(res, recipient.kind, admin);
      const form = (action: string, revision: number) =>
        `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", revision)}${hidden("month", v.month)}<input type="hidden" name="action" value="${action}">`;
      const snapshot = e?.snapshot,
        amount = v.rate
          ? coachingSubtotal(e?.minutes ?? 0, v.rate.cents)
          : null;
      let body = `<section class="invoice-workspace${admin ? " portal-workspace" : ""}"><h1>${admin ? "Review monthly coaching" : "Monthly coaching hours"}</h1><p>${v.sample ? "SAMPLE · NOT PAYABLE. All sample amounts and tax are invented." : "Configured offline invoicing. Submission does not take payment; an administrator reviews it before issuing an invoice."}</p><p>${admin ? `Member: <strong>${escape(v.displayName ?? "Name needed")}</strong> · account reference <code>${escape(v.ownerId)}</code>` : "Choose the month you want to invoice, enter your coaching hours and minutes, then review the rate set by your administrator. Requesting an invoice submits the saved month for administrator review; it does not take payment. Coaching is optional; your learning access does not depend on a rate or invoice."}</p><form method="get" action="${base}"><label>Calendar month (UTC)<input type="month" name="month" value="${v.month}" max="${v.today}" required></label><button class="secondary">Open month</button></form><h2>${monthLabel(v.month)}</h2><p>Status: ${e ? escape(e.state) : "No saved draft or submission"}${e ? ` · revision ${e.revision}` : ""}</p>${e?.returnReason ? `<p role="status">Returned for correction: ${escape(e.returnReason)}</p>` : ""}<p>${v.rate ? `Applicable rate: ${money(v.rate.cents)} per hour · version ${v.rate.version} · effective ${monthLabel(v.rate.effectiveMonth)}` : admin ? "No rate is set for this month. Set the rate below." : "No rate is set for this month. Ask the administrator to enter your agreed rate before submitting; you can save a draft now."}</p>`;
      // #316 TERMS316-01/06: per-student coaching terms, beside the hours.
      if (options.coachingTerms) {
        const t = admin
          ? await options.coachingTerms.forStudent(token(res), v.ownerId)
          : await options.coachingTerms.own(token(res));
        if (t.kind !== "ready")
          return failure(res, t.kind === "invalid" ? "denied" : t.kind, admin);
        body += admin
          ? adminTermsSection(
              t.value,
              `${base}/terms`,
              `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", t.value?.version ?? 0)}`,
            )
          : memberTermsSection(t.value);
        // #318 TERMSINV318-01/03: invoice the current terms version.
        if (admin && store) {
          const i = await store.coachingTermsInvoice(token(res), v.ownerId);
          if (i.kind !== "ready")
            return failure(
              res,
              i.kind === "invalid" ? "denied" : i.kind,
              admin,
            );
          body += adminTermsInvoiceSection(
            i.value,
            `${base}/terms-invoice`,
            `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", i.value.terms?.version ?? 0)}`,
            hst,
            v.sample,
          );
        }
      }
      // #94 AGREED94-01/03: what staff and the student agreed, append-only.
      if (options.agreedChanges) {
        const a = admin
          ? await options.agreedChanges.forStudent(token(res), v.ownerId)
          : await options.agreedChanges.own(token(res));
        if (a.kind !== "ready")
          return failure(res, a.kind === "invalid" ? "denied" : a.kind, admin);
        body += admin
          ? adminAgreedSection(
              a.value,
              `${base}/agreed-change`,
              `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}`,
            )
          : memberAgreedSection(a.value);
      }
      if (admin)
        body += `<h2>Set member rate</h2><form method="post" action="${base}/rate">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", v.rateVersion)}<label>Effective month<input type="month" name="effectiveMonth" value="${v.month}" required></label><label>Hourly rate (CAD)<input name="rate" inputmode="decimal" required></label><button>Save hourly rate</button></form>`;
      if (e)
        body += `<p>Saved duration: ${coachingDuration(e.minutes)}</p><p>Invoice recipient: ${escape(e.name)}${e.company ? ` · ${escape(e.company)}` : ""} · ${escape(e.email)}</p>`;
      if (snapshot)
        body += `<h2>Submitted snapshot</h2><p>${monthLabel(snapshot.month)} · ${coachingDuration(snapshot.minutes)} · ${money(snapshot.rate.cents)} per hour · rate version ${snapshot.rate.version} · subtotal ${money(snapshot.subtotalCents)}</p><p>Recipient: ${escape(snapshot.name)}${snapshot.company ? ` · ${escape(snapshot.company)}` : ""} · ${escape(snapshot.email)} · ${snapshot.sample ? "Sample, not payable" : "Configured offline invoice"}</p><p>Submitted revision ${e!.submittedRevision}. This snapshot stays retained after correction.</p>`;
      if (!admin && (!e || e.state === "draft")) {
        body += `<h2>Save your draft</h2><form method="post" action="${base}/save">${form("save", e?.revision ?? 0)}<label>Whole hours<input name="hours" type="number" min="0" max="744" step="1" value="${Math.floor((e?.minutes ?? 0) / 60)}" required></label><label>Additional minutes<input name="minutes" type="number" min="0" max="59" step="1" value="${(e?.minutes ?? 0) % 60}" required></label><label>Invoice recipient name<input name="name" autocomplete="name" maxlength="200" value="${escape(e?.name ?? recipient.value?.name ?? "")}" required></label><label>Invoice email<input name="email" type="email" autocomplete="email" maxlength="254" value="${escape(e?.email ?? recipient.value?.email ?? "")}" required></label><label>Company name (optional)<input name="company" autocomplete="organization" maxlength="200" value="${escape((e ? e.company : recipient.value?.company) ?? "")}"></label><p>Changes here are saved as your reusable billing recipient for later months. <a href="/account/billing">Edit reusable billing recipient</a>. This email is only the billing recipient; it does not change your sign-in identity.</p><button>Save coaching draft</button></form>`;
        if (e && v.rate && amount !== null)
          body += `<h2>Confirm this saved draft</h2><p>Subtotal before ${hst ? escape(hst.label) : "separately supplied tax"}: <strong>${money(amount)}</strong>. ${amount === 0 ? "A zero-total submission creates no invoice." : hst ? `${escape(hst.label)} at ${taxRate(hst)} is added when the invoice is issued.` : "The administrator supplies tax when reviewing the invoice."}</p><form method="post" action="${base}/submit">${form("submit", e.revision)}${hidden("rateId", v.rate.id)}${hidden("sample", String(v.sample))}<label class="check"><input type="checkbox" name="confirm" value="submit" required><span>I confirm this saved duration, recipient and exact rate version for ${v.month}. ${v.sample ? "This is a sample, not payable." : "I submit for configured offline invoicing; issued financial records may be retained after account deletion."}</span></label><button>Request coaching invoice</button></form>`;
        if (e && v.rate && amount === null)
          body +=
            '<p role="alert">The saved duration at this rate exceeds the invoice amount limit. Correct the draft or ask the administrator to review the rate.</p>';
      }
      if (e?.invoiceId)
        body += `<p><a href="${admin ? "/operator/invoices/" : "/account/purchases/invoices/"}${e.invoiceId}">View issued invoice</a></p><p>To correct an issued month, the administrator must first void its unpaid invoice. Paid or partially paid invoices cannot be corrected here; contact the administrator for financial review.</p>`;
      if (e?.previousInvoiceId)
        body += `<p><a href="${admin ? "/operator/invoices/" : "/account/purchases/invoices/"}${e.previousInvoiceId}">View preserved original invoice</a></p>`;
      if (admin && e && e.state !== "draft") {
        if (
          e.state === "submitted" &&
          snapshot &&
          snapshot.subtotalCents > 0 &&
          snapshot.sample === v.sample
        )
          body += `<h2>Issue the reviewed invoice</h2><form method="post" action="${base}/issue">${form("issue", e.revision)}${hst ? `<p>${escape(hst.label)} at ${taxRate(hst)} (${money(salesTaxCents(snapshot.subtotalCents, hst))}) is added to the subtotal.</p>` : `<label>${v.sample ? "Invented sample tax (CAD)" : "Explicit tax amount (CAD)"}<input name="tax" inputmode="decimal" ${v.sample ? 'value="0.00"' : ""} required></label>`}<label class="check"><input type="checkbox" name="confirm" value="issue" required><span>I reviewed this exact submitted revision and the ${hst ? `computed ${escape(hst.label)}` : "separately supplied tax"}.</span></label><button>Issue coaching invoice</button></form>`;
        else if (e.state === "submitted")
          body += `<p role="status">${snapshot?.sample !== v.sample ? "The submitted billing mode differs from current configuration. Return it and ask the member to explicitly confirm the current mode." : "This zero-total submission is retained. No invoice can be issued."}</p>`;
        body += `<h2>Return for correction</h2><p>An issued month can only be returned after its invoice is void and unpaid, with no delivery in progress or unconfirmed. Other financial corrections require administrator review outside this action.</p><form method="post" action="${base}/return">${form("return", e.revision)}<label>Correction reason<input name="reason" maxlength="500" required></label><button class="secondary">Return month for correction</button></form>`;
      }
      body += `<h2 id="saved-months">Saved months</h2>${savedMonthsTable(v.months, v.rates, base, admin ? "/operator/invoices/" : "/account/purchases/invoices/")}${
        admin
          ? portalActions([
              [adminPath, "Choose another member"],
              ["/operator/invoices", "Courses and invoices"],
            ])
          : '<p class="account-links"><a class="button secondary" href="/account">My account</a> <a class="button secondary" href="/account/purchases">Courses and invoices</a></p>'
      }</section>`;
      res.send(
        page(
          admin ? "Review monthly coaching" : "Monthly coaching hours",
          body,
        ),
      );
    });
  }
  // #316 TERMS316-01..05: a platform administrator saves a new terms version.
  app.post(`${adminPath}/:ownerId/terms`, async (req, res) => {
    if (!valid(req, res, [...TERMS_FIELDS])) return;
    if (!options.coachingTerms) return failure(res, "unavailable", true);
    const values = parseCoachingTerms(req.body);
    if (
      values === null ||
      !/^(0|[1-9]\d{0,8})$/.test(String(req.body.revision))
    )
      return failure(res, "invalid", true);
    const ownerId = (req.params as Record<string, string>).ownerId!;
    const r = await options.coachingTerms.save(token(res), {
      ...values,
      ownerId,
      expectedVersion: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${ownerId}`)
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
      ? res.redirect(303, `${adminPath}/${ownerId}#agreed-changes`)
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
  for (const action of ["save", "submit", "return", "issue"] as const) {
    const admin = action === "return" || action === "issue",
      base = admin ? `${adminPath}/:ownerId` : memberPath;
    app.post(`${base}/${action}`, async (req, res) => {
      const fields = {
        save: ["hours", "minutes", "name", "email", "company"],
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
        return failure(res, r.kind, admin, req.body.operationId);
      return res.redirect(
        303,
        "invoiceId" in r.value
          ? `/operator/invoices/${r.value.invoiceId}`
          : `${admin ? `${adminPath}/${(req.params as Record<string, string>).ownerId!}` : memberPath}?month=${encodeURIComponent(req.body.month)}`,
      );
    });
  }
}
