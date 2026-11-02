import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { csrf, validCsrf } from "./session.ts";
import { page, escape } from "./views.ts";
import { parseInvoiceMoney } from "./simple-invoice-values.ts";
import {
  coachingSubtotal,
  coachingDuration,
  parseCoachingDuration,
} from "./coaching-values.ts";
import type {
  InvoiceFailure,
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
export function mountCoachingRoutes(
  app: Express,
  store: SimpleInvoiceStore | undefined,
  options: { origin: string; secret: string },
) {
  const token = (res: Response) => res.locals.token as string;
  function valid(req: Request, res: Response, fields: string[] = []) {
    res.set("Cache-Control", "no-store");
    if (
      Object.entries(req.query).some(
        ([key, value]) =>
          req.method !== "GET" || key !== "month" || typeof value !== "string",
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
    if (!valid(req, res)) return;
    if (!store) return failure(res, "unavailable", true);
    const result = await store.adminOverview(token(res));
    if (result.kind !== "ready") return failure(res, result.kind, true);
    res.send(
      page(
        "Coaching administration",
        `<section class="invoice-workspace"><h1>Coaching administration</h1><p>Choose a member to set an agreed hourly rate or review a submitted month. Registration and rate assignment create no invoice.</p><h2>Members</h2><ul>${result.value.members.map((m) => `<li><a href="${adminPath}/${m.id}">${m.id}</a></li>`).join("") || "<li>No members available.</li>"}</ul><h2>Pending months</h2><ul>${result.value.coachingPending.map((m) => `<li><a href="${adminPath}/${m.ownerId}?month=${m.month}">${m.ownerId} · ${m.month}</a></li>`).join("") || "<li>No submitted months await review.</li>"}</ul><p><a href="/operator/invoices">Courses and invoices</a> · <a href="/admin">Administration</a></p></section>`,
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
              '<h1>Monthly coaching hours</h1><p>Coaching invoicing is not configured. No rate or payable amount is assumed. Your learning and saved work remain available.</p><p><a href="/account">My account</a></p>',
            ),
          );
      const r = await store.coachingOverview(
        token(res),
        req.query.month as string | undefined,
        admin ? (req.params as Record<string, string>).ownerId! : undefined,
      );
      if (r.kind !== "ready") return failure(res, r.kind, admin);
      const v = r.value,
        e = v.entry,
        base = admin ? `${adminPath}/${v.ownerId}` : memberPath,
        anti = csrf(token(res), options.secret);
      const form = (action: string, revision: number) =>
        `${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", revision)}${hidden("month", v.month)}<input type="hidden" name="action" value="${action}">`;
      const snapshot = e?.snapshot,
        amount = v.rate
          ? coachingSubtotal(e?.minutes ?? 0, v.rate.cents)
          : null;
      let body = `<section class="invoice-workspace"><h1>${admin ? "Review monthly coaching" : "Monthly coaching hours"}</h1><p>${v.sample ? "SAMPLE · NOT PAYABLE. All sample amounts and tax are invented." : "Configured offline invoicing. Submission does not take payment; an administrator reviews it before issuing an invoice."}</p><p>${admin ? `Member: ${escape(v.ownerId)}` : "Coaching is optional; your learning access does not depend on a rate or invoice."}</p><form method="get" action="${base}"><label>Calendar month (UTC)<input type="month" name="month" value="${v.month}" max="${v.today}" required></label><button class="secondary">Open month</button></form><h2>${v.month}</h2><p>Status: ${e ? escape(e.state) : "No saved draft or submission"}${e ? ` · revision ${e.revision}` : ""}</p>${e?.returnReason ? `<p role="status">Returned for correction: ${escape(e.returnReason)}</p>` : ""}<p>${v.rate ? `Applicable rate: ${money(v.rate.cents)} per hour · version ${v.rate.version} · effective ${v.rate.effectiveMonth}` : "No rate is set for this month. Ask the administrator to enter your agreed rate before submitting; you can save a draft now."}</p>`;
      if (admin)
        body += `<h2>Set member rate</h2><form method="post" action="${base}/rate">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", v.rateVersion)}<label>Effective month<input type="month" name="effectiveMonth" value="${v.month}" required></label><label>Hourly rate (CAD)<input name="rate" inputmode="decimal" required></label><button>Save hourly rate</button></form>`;
      if (e)
        body += `<p>Saved duration: ${coachingDuration(e.minutes)}</p><p>Invoice recipient: ${escape(e.name)} · ${escape(e.email)}</p>`;
      if (snapshot)
        body += `<h2>Submitted snapshot</h2><p>${snapshot.month} · ${coachingDuration(snapshot.minutes)} · ${money(snapshot.rate.cents)} per hour · rate version ${snapshot.rate.version} · subtotal ${money(snapshot.subtotalCents)}</p><p>Recipient: ${escape(snapshot.name)} · ${escape(snapshot.email)} · ${snapshot.sample ? "Sample, not payable" : "Configured offline invoice"}</p><p>Submitted revision ${e!.submittedRevision}. This snapshot stays retained after correction.</p>`;
      if (!admin && (!e || e.state === "draft")) {
        body += `<h2>Save your draft</h2><form method="post" action="${base}/save">${form("save", e?.revision ?? 0)}<label>Whole hours<input name="hours" type="number" min="0" max="744" step="1" value="${Math.floor((e?.minutes ?? 0) / 60)}" required></label><label>Additional minutes<input name="minutes" type="number" min="0" max="59" step="1" value="${(e?.minutes ?? 0) % 60}" required></label><label>Invoice recipient name<input name="name" maxlength="200" value="${escape(e?.name ?? "")}" required></label><label>Invoice email<input name="email" type="email" maxlength="254" value="${escape(e?.email ?? "")}" required></label><p>This email is only the billing recipient; it does not change your sign-in identity.</p><button>Save coaching draft</button></form>`;
        if (e && v.rate && amount !== null)
          body += `<h2>Confirm this saved draft</h2><p>Subtotal before separately supplied tax: <strong>${money(amount)}</strong>. ${amount === 0 ? "A zero-total submission creates no invoice." : "The administrator supplies tax when reviewing the invoice."}</p><form method="post" action="${base}/submit">${form("submit", e.revision)}${hidden("rateId", v.rate.id)}${hidden("sample", String(v.sample))}<label class="check"><input type="checkbox" name="confirm" value="submit" required><span>I confirm this saved duration, recipient and exact rate version for ${v.month}. ${v.sample ? "This is a sample, not payable." : "I submit for configured offline invoicing; issued financial records may be retained after account deletion."}</span></label><button>Submit monthly hours</button></form>`;
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
          body += `<h2>Issue the reviewed invoice</h2><form method="post" action="${base}/issue">${form("issue", e.revision)}<label>${v.sample ? "Invented sample tax (CAD)" : "Explicit tax amount (CAD)"}<input name="tax" inputmode="decimal" ${v.sample ? 'value="0.00"' : ""} required></label><label class="check"><input type="checkbox" name="confirm" value="issue" required><span>I reviewed this exact submitted revision and the separately supplied tax.</span></label><button>Issue coaching invoice</button></form>`;
        else if (e.state === "submitted")
          body += `<p role="status">${snapshot?.sample !== v.sample ? "The submitted billing mode differs from current configuration. Return it and ask the member to explicitly confirm the current mode." : "This zero-total submission is retained. No invoice can be issued."}</p>`;
        body += `<h2>Return for correction</h2><p>An issued month can only be returned after its invoice is void and unpaid, with no delivery in progress or unconfirmed. Other financial corrections require administrator review outside this action.</p><form method="post" action="${base}/return">${form("return", e.revision)}<label>Correction reason<input name="reason" maxlength="500" required></label><button class="secondary">Return month for correction</button></form>`;
      }
      body += `<h2>Saved months</h2><ul>${v.months.map((m) => `<li><a href="${base}?month=${m.month}">${m.month}</a> · ${escape(m.state)}</li>`).join("") || "<li>No saved months.</li>"}</ul><p><a href="${admin ? adminPath : "/account"}">${admin ? "Choose another member" : "My account"}</a> · <a href="${admin ? "/operator/invoices" : "/account/purchases"}">Courses and invoices</a></p></section>`;
      res.send(
        page(
          admin ? "Review monthly coaching" : "Monthly coaching hours",
          body,
        ),
      );
    });
  }
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
        save: ["hours", "minutes", "name", "email"],
        submit: ["rateId", "sample", "confirm"],
        return: ["reason"],
        issue: ["tax", "confirm"],
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
        (action === "issue" && taxCents === null) ||
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
                  taxCents: taxCents!,
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
