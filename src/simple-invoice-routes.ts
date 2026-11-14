import type { BillingProfileStore } from "./billing-profile.ts";
import { monthLabel, periodLabel } from "./coaching-values.ts";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { csrf, validCsrf } from "./session.ts";
import { page, escape } from "./views.ts";
import { portalActions } from "./backend-portal-presentation.ts";
import {
  parseInvoiceMoney,
  invoicePaymentStatus,
  invoiceUuid,
  invoiceTotal,
  taxRate,
} from "./simple-invoice-values.ts";
import {
  simpleInvoiceDocument,
  type SimpleInvoiceDocument,
} from "./simple-invoice-views.ts";
import type {
  InvoiceFailure,
  SimpleInvoiceStore,
} from "./simple-invoice-store.ts";
export interface InvoiceSender {
  send(
    address: string,
    document: SimpleInvoiceDocument,
    link: string,
  ): Promise<void>;
}
const memberPath = "/account/purchases",
  adminPath = "/operator/invoices";
const hidden = (key: string, value: string | number) =>
  `<input type="hidden" name="${key}" value="${escape(String(value))}">`;
function error(
  res: Response,
  kind: InvoiceFailure["kind"],
  key?: string,
  admin = false,
) {
  const status = {
    denied: 403,
    invalid: 422,
    conflict: 409,
    unavailable: 503,
    "not-found": 404,
  }[kind];
  return res
    .status(status)
    .send(
      page(
        "Invoice request not confirmed",
        `<h1>Invoice request not confirmed</h1><p role="alert">${kind === "unavailable" ? "The outcome is uncertain. Inspect the original operation before trying another action." : kind === "conflict" ? "The current record differs from this form. Inspect the latest state before another action." : "This invoice request is not available or was not accepted."}</p>${key ? `<p><a href="${admin ? adminPath : memberPath}/operations/${escape(key)}">Inspect original operation</a></p>` : ""}<p><a href="${admin ? adminPath : memberPath}">${admin ? "Courses and invoices" : "Invoices"}</a></p>`,
      ),
    );
}
// FOLD-01 (#846): an invoice is named by what it bills, not by its reference.
const UNPAID = "Awaiting offline payment";
function invoiceLine(i: {
  document: SimpleInvoiceDocument;
  totalCents: number;
  paidCents: number;
  refundedCents?: number;
  voidReason: string | null;
}) {
  const coaching = i.document.coaching;
  const terms = i.document.coachingTerms;
  const what = coaching
    ? `Coaching · ${periodLabel({ key: coaching.month, start: coaching.periodStart, end: coaching.periodEnd })}`
    : terms
      ? `Coaching · ${periodLabel({ key: terms.startsOn, end: terms.endsOn })}`
      : `Courses · ${monthLabel(i.document.issuedOn.slice(0, 7))}`;
  const status = invoicePaymentStatus(i);
  return `${escape(what)}</a> — CAD ${(i.totalCents / 100).toFixed(2)} — ${status === UNPAID ? "Unpaid" : status}`;
}
// Delivery states as administrators read them.
const DELIVERY = {
  not_sent: "Not sent",
  sending: "Sending",
  sent: "Sent",
  unconfirmed: "Unconfirmed: check the recipient's inbox before sending again",
} as const;

export function mountSimpleInvoiceRoutes(
  app: Express,
  store: SimpleInvoiceStore | undefined,
  options: {
    origin: string;
    secret: string;
    invoiceSender?: InvoiceSender;
    billingProfiles?: BillingProfileStore;
  },
) {
  const token = (res: Response) => res.locals.token as string;
  const protect = (res: Response) =>
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  const valid = (
    req: Request,
    res: Response,
    fields: string[] = [],
    queries: string[] = [],
  ) => {
    protect(res);
    const body = req.body;
    if (
      Object.keys(req.query).some((key) => !queries.includes(key)) ||
      (req.method === "POST" &&
        (!body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.entries(body).some(
            ([key, value]) =>
              (typeof value !== "string" &&
                !(
                  key === "courses" &&
                  Array.isArray(value) &&
                  value.every((v) => typeof v === "string")
                )) ||
              (!["csrf", "operationId", "revision", ...fields].includes(key) &&
                !(
                  fields.includes("courses") &&
                  /^amount_[A-Za-z0-9-]+_[1-9][0-9]*$/.test(key)
                )),
          ) ||
          req.get("origin") !== options.origin ||
          !validCsrf(body.csrf, token(res), options.secret)))
    ) {
      res
        .status(403)
        .send(
          page(
            "Request not accepted",
            "<h1>Request not accepted</h1><p>Open the current invoice form and try again.</p>",
          ),
        );
      return false;
    }
    return true;
  };
  // FOLD-02 (#846): billing details are a form on My account. The old page
  // address still works for the coaching page's link and saved bookmarks.
  app.get("/account/billing", (req, res) => {
    if (!valid(req, res)) return;
    return res.redirect(303, "/account#billing");
  });
  app.post("/account/billing", async (req, res) => {
    if (!valid(req, res, ["name", "email", "company"])) return;
    const profiles = options.billingProfiles;
    if (!profiles) return error(res, "unavailable");
    const outcome = (kind: string) =>
      res.redirect(303, `/account?billing=${kind}#billing`);
    let email: unknown = req.body.email;
    if (typeof email !== "string" || !email.trim()) {
      // The invoice email is optional here: a blank one keeps the saved
      // address, else the verified sign-in address.
      const known = await profiles.suggest(token(res));
      if (known.kind !== "ready") return error(res, known.kind);
      email = known.value.email;
      if (!email) return outcome("email");
    }
    const result = await profiles.save(token(res), {
      name: req.body.name,
      email: email as string,
      company: req.body.company,
      revision: Number(req.body.revision),
    });
    if (
      result.kind === "ready" ||
      result.kind === "invalid" ||
      result.kind === "conflict"
    )
      return outcome(result.kind === "ready" ? "saved" : result.kind);
    return error(res, result.kind);
  });
  app.get(memberPath, async (req, res) => {
    if (!valid(req, res)) return;
    if (!store)
      return res.send(
        page(
          "Invoices",
          '<section class="invoice-workspace"><h1>Invoices</h1><p>Invoices are not set up here.</p><p><a href="/account">My account</a></p></section>',
        ),
      );
    const result = await store.overview(token(res));
    if (result.kind !== "ready") return error(res, result.kind);
    const profile = options.billingProfiles
      ? await options.billingProfiles.suggest(token(res))
      : { kind: "ready" as const, value: null };
    if (profile.kind !== "ready") return error(res, profile.kind);
    const anti = csrf(token(res), options.secret);
    const { plans, invoices } = result.value;
    const sample = invoices.some((i) => i.document.sample);
    return res.send(
      page(
        "Invoices",
        `<section class="invoice-workspace"><h1>Invoices</h1>${sample ? '<p class="small">Sample invoices are not payable.</p>' : ""}${invoices.length ? `<ul class="invoice-list">${invoices.map((i) => `<li><a href="${memberPath}/invoices/${i.id}">${invoiceLine(i)}</li>`).join("")}</ul>` : "<p>No invoices yet.</p>"}${plans.length ? `<h2>Course proposals</h2><p>Accepting a proposal creates an invoice; nothing is charged automatically. Cancel a monthly agreement before accepting a replacement.</p>${plans.map((plan) => `<article id="plan-${plan.id}"><h3>Course bundle</h3><p><a href="/courses/proposals/${plan.id}">Reopen this proposal after sign-in</a></p><p>${plan.terms.sample ? "SAMPLE · NOT PAYABLE" : "Prepared course offer"} · ${escape(plan.state)}</p><ul>${plan.terms.courses.map((c) => `<li>${escape(c.description)} · ${escape(c.id)} version ${c.version} · CAD ${(c.amountCents / 100).toFixed(2)}</li>`).join("")}</ul><p>${plan.terms.cadence === "one_time" ? "One-time invoice" : "Monthly invoices until cancelled"} · starts ${escape(plan.terms.startsOn)} · ${plan.terms.tax ? `${escape(plan.terms.tax.label)} ${taxRate(plan.terms.tax)}` : "tax"} CAD ${(plan.terms.taxCents / 100).toFixed(2)}</p><p><strong>${plan.terms.cadence === "monthly" ? "Total each month" : "Total"}: CAD ${(invoiceTotal(plan.terms) / 100).toFixed(2)}</strong></p><p>Invoice issuer: ${escape(plan.terms.issuer)}${plan.terms.tax ? ` · ${escape(plan.terms.tax.label)} registration number ${escape(plan.terms.tax.registration)}` : ""}</p><p class="invoice-instructions">${escape(plan.terms.instructions)}</p>${plan.state === "offered" && plan.terms.startsOn < result.value.today ? `<p role="status">Acceptance closed on ${escape(plan.terms.startsOn)}. A proposal can be accepted only until its start date, so this one can no longer be accepted and will not bill any past month. Ask your administrator for a new proposal if you still want these courses.</p>` : plan.state === "offered" && result.value.unavailable[plan.id] ? `<p role="status">This proposal can no longer be accepted: ${escape(result.value.unavailable[plan.id]!.join(", "))} ${result.value.unavailable[plan.id]!.length === 1 ? "is" : "are"} not currently offered. No invoice was created. Ask your administrator for a new proposal if you still want these courses.</p>` : plan.state === "offered" ? `<form method="post" action="${memberPath}/plans/${plan.id}/accept">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", plan.revision)}<label>Invoice recipient name<input name="name" maxlength="200" value="${escape(profile.value?.name ?? "")}" required></label><label>Invoice email<input type="email" name="email" maxlength="254" value="${escape(profile.value?.email ?? "")}" required></label><label>Company name (optional)<input name="company" maxlength="200" value="${escape(profile.value?.company ?? "")}"></label><label class="check"><input type="checkbox" name="confirm" value="accept" required><span>I accept these exact courses and ${plan.terms.cadence === "monthly" ? "monthly recurring invoices until I cancel" : "one-time billing terms"}. Issued financial invoices can be retained for accounting after learning-account deletion.</span></label><button>Accept courses and create invoice</button></form>` : plan.state === "active" ? `<form method="post" action="${memberPath}/plans/${plan.id}/cancel">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}${hidden("revision", plan.revision)}<label class="check"><input type="checkbox" name="confirm" value="cancel" required><span>Stop future invoices; retain already issued invoices.</span></label><button class="secondary">Cancel future billing</button></form>` : ""}</article>`).join("")}` : ""}<p><a href="/account">My account</a></p></section>`,
      ),
    );
  });
  app.get(adminPath, async (req, res) => {
    if (!valid(req, res, [], ["ownerId", "prepared"])) return;
    const selected = req.query.ownerId,
      prepared = req.query.prepared;
    if (
      (selected !== undefined && !invoiceUuid(selected)) ||
      (prepared !== undefined && (prepared !== "1" || selected === undefined))
    )
      return error(res, "invalid", undefined, true);
    if (!store) return error(res, "unavailable", undefined, true);
    const r = await store.adminOverview(token(res), selected);
    if (r.kind !== "ready") return error(res, r.kind, undefined, true);
    const anti = csrf(token(res), options.secret);
    return res.send(
      page(
        "Course billing administration",
        `<section class="invoice-workspace portal-workspace"><h1>Course billing administration</h1>${prepared ? '<p role="status">Course billing proposal prepared. The learner can now review and accept it in Courses and invoices.</p>' : ""}<p>Prepare courses for a registered student. No invoice is issued until the student accepts the exact terms.</p>${portalActions(
          [
            ["/operator", "Administration console"],
            ["/operator/coaching", "Coaching administration"],
            [
              "/operator/invoice-reconciliation",
              "Invoice and cash reconciliation",
            ],
            ["/operator/course-agreements", "Course agreement outcomes"],
          ],
        )}<section class="portal-card"><h2>Prepare course billing</h2><form method="post" action="${adminPath}/plans">${hidden("csrf", anti)}${hidden("operationId", randomUUID())}<label for="invoice-owner">Learner</label><select id="invoice-owner" name="ownerId" required>${r.value.members.map((m) => `<option value="${m.id}">${escape(m.displayName ?? "Name needed")} · ${escape(m.id)}</option>`).join("")}</select><fieldset><legend>Consolidate courses</legend>${r.value.courses.map((c) => `<label class="check"><input type="checkbox" name="courses" value="${escape(JSON.stringify([c.id, c.version]))}"><span>${escape(c.title)} · ${escape(c.id)} version ${c.version}</span></label><label>Amount for ${escape(c.title)} (CAD)<input name="amount_${escape(c.id)}_${c.version}" inputmode="decimal" value="0.00"></label>`).join("")}</fieldset><label for="invoice-cadence">Billing</label><select id="invoice-cadence" name="cadence"><option value="one_time">One-time</option><option value="monthly">Recurring monthly</option></select><label>Starts on (UTC date)<input type="date" name="startsOn" required></label>${store.tax ? `<p>${escape(store.tax.label)} at ${taxRate(store.tax)} is added to each invoice from its course subtotal.</p>` : '<label>Configured tax amount per invoice (CAD)<input name="tax" inputmode="decimal" value="0.00" required></label>'}<button>Prepare course billing proposal</button></form></section><section class="portal-card"><h2>Recurring invoices</h2><form method="post" action="${adminPath}/due">${hidden("csrf", anti)}<button>Generate due recurring invoices</button></form></section><section class="portal-card"><h2>Issued invoice references</h2><ul class="portal-list">${r.value.invoices.map((i) => `<li><a href="${adminPath}/${i.id}">${i.id}</a> · ${escape(i.delivery)}</li>`).join("")}</ul></section></section>`,
      ),
    );
  });
  for (const admin of [false, true]) {
    const base = admin ? adminPath : memberPath;
    app.get(`${base}/operations/:key`, async (req, res) => {
      if (!valid(req, res)) return;
      if (!store) return error(res, "unavailable", req.params.key, admin);
      const r = await store.inspect(token(res), req.params.key, admin);
      if (r.kind !== "ready") return error(res, r.kind, undefined, admin);
      return res.send(
        page(
          "Original invoice operation",
          `<h1>Original invoice operation</h1><p>This is the retained original result. It does not submit another invoice or payment. A missing receipt does not prove an earlier operation never committed.</p><pre>${escape(JSON.stringify(r.value.result, null, 2))}</pre><p><a href="${base}">Inspect current invoices</a></p>`,
        ),
      );
    });
    const path = admin ? `${base}/:id` : `${base}/invoices/:id`;
    app.get(path, async (req, res) => {
      if (!valid(req, res)) return;
      if (!store) return error(res, "unavailable", undefined, admin);
      const invoiceId = req.params.id;
      if (!invoiceUuid(invoiceId))
        return error(res, "invalid", undefined, admin);
      const r = await store.invoice(token(res), invoiceId, admin);
      if (r.kind !== "ready") return error(res, r.kind, undefined, admin);
      let html = simpleInvoiceDocument(
        r.value.document,
        admin,
        r.value.payments,
        r.value.service,
      );
      if (admin) {
        const i = r.value,
          anti = csrf(token(res), options.secret),
          // WALK-04: offer only what the store would accept.
          due = i.totalCents - i.paidCents;
        html = html.replace(
          "</main>",
          `<section class="invoice-controls"><h2>Send the invoice</h2><p>Email status: ${i.document.sample && i.delivery === "sent" ? "Simulated; no email sent" : DELIVERY[i.delivery]}</p>${options.invoiceSender && !(i.document as { recipientEmail?: string }).recipientEmail ? "<p>This invoice has no email address, so it is not sent by email. The student can open it under Courses and invoices.</p>" : options.invoiceSender ? `<form method="post" action="${adminPath}/${i.id}/email">${hidden("csrf", anti)}${hidden("revision", i.revision)}${hidden("operationId", randomUUID())}<label class="check"><input type="checkbox" name="confirm" value="send" required><span>${i.document.sample ? "Simulate delivery only; no email will be sent." : "Send this individual invoice to its accepted billing recipient."}</span></label><button>${i.document.sample ? "Simulate invoice email" : "Send invoice email"}</button></form>` : "<p>Invoice email is not configured on this service, so nothing can be sent from here. The student can open this invoice under Courses and invoices.</p>"}${i.voidReason !== null ? "" : due <= 0 ? "<h2>Record offline funds received</h2><p>Nothing is left to receive on this invoice.</p>" : `<h2>Record offline funds received</h2><p>Balance still due: CAD ${(due / 100).toFixed(2)}. A receipt can't be more than this.</p><p>This is a manual record of an offline payment. The student can read the reference, so never enter card numbers, CVV or bank credentials.</p><form method="post" action="${adminPath}/${i.id}/payment">${hidden("csrf", anti)}${hidden("revision", i.revision)}${hidden("operationId", randomUUID())}<label>Amount received (CAD)<input name="amount" inputmode="decimal" required></label><label>Received on<input type="date" name="receivedOn" required></label><label>Evidence reference<input name="evidence" maxlength="200" required></label><label class="check"><input type="checkbox" name="confirm" value="received" required><span>I verified these funds were received for this exact invoice.</span></label><button>Record offline payment</button></form>`}${i.paidCents - (i.refundedCents ?? 0) > 0 ? `<h2>Record an offline refund</h2><p>Use this after the money has actually gone back. It moves no money, cancels no agreement and does not reopen the balance.</p><form method="post" action="${adminPath}/${i.id}/refund">${hidden("csrf", anti)}${hidden("revision", i.revision)}${hidden("operationId", randomUUID())}<label>Amount refunded (CAD)<input name="amount" inputmode="decimal" required></label><label>Refunded on<input type="date" name="refundedOn" required></label><label>Evidence reference<input name="evidence" maxlength="200" required></label><label class="check"><input type="checkbox" name="confirm" value="refunded" required><span>I confirm this refund was sent for this exact invoice.</span></label><button>Record offline refund</button></form>` : ""}${i.voidReason !== null || i.paidCents !== 0 ? "" : `<h2>Correct an unpaid invoice</h2><p>${i.document.coaching ? `Void the incorrect invoice, then <a href="/operator/coaching${i.ownerId ? `/${escape(i.ownerId)}?month=${escape(i.document.coaching.month)}` : ""}">return its coaching month for correction</a>. Paid or partially paid corrections are unavailable here and require financial review.` : "Void the incorrect invoice, then prepare a new proposal."} Issued details and recorded funds cannot be edited.</p><form method="post" action="${adminPath}/${i.id}/void">${hidden("csrf", anti)}${hidden("revision", i.revision)}${hidden("operationId", randomUUID())}<label>Reason<input name="reason" maxlength="500" required></label><label class="check"><input type="checkbox" name="confirm" value="void" required><span>Void this unpaid invoice. This does not cancel its course agreement or refund any funds.</span></label><button class="secondary">Void unpaid invoice</button></form>`}</section></main>`,
        );
      }
      return res.send(html);
    });
  }
  app.post(`${memberPath}/plans/:id/accept`, async (req, res) => {
    if (!valid(req, res, ["confirm", "name", "email", "company"])) return;
    if (!store) return error(res, "unavailable");
    if (req.body.confirm !== "accept") return error(res, "invalid");
    const r = await store.accept(token(res), {
      planId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
      name: req.body.name,
      email: req.body.email,
      company: req.body.company,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${memberPath}/invoices/${r.value.invoiceId}`)
      : error(res, r.kind, req.body.operationId);
  });
  app.post(`${memberPath}/plans/:id/cancel`, async (req, res) => {
    if (!valid(req, res, ["confirm"])) return;
    if (!store) return error(res, "unavailable");
    if (req.body.confirm !== "cancel") return error(res, "invalid");
    const r = await store.cancel(token(res), {
      planId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    return r.kind === "ready"
      ? res.redirect(303, memberPath)
      : error(res, r.kind, req.body.operationId);
  });
  app.post(`${adminPath}/plans`, async (req, res) => {
    const fields = ["ownerId", "courses", "cadence", "startsOn"];
    // ISSUER-02: a typed tax is refused when the server computes HST.
    if (!valid(req, res, store?.tax ? fields : [...fields, "tax"])) return;
    if (!store) return error(res, "unavailable", undefined, true);
    try {
      const selected = Array.isArray(req.body.courses)
        ? req.body.courses
        : [req.body.courses];
      const courses = selected.map((v: unknown) => {
        if (typeof v !== "string") throw Error();
        const [id, version] = JSON.parse(v);
        if (typeof id !== "string" || !Number.isSafeInteger(version))
          throw Error();
        const amountCents = parseInvoiceMoney(
          req.body[`amount_${id}_${version}`],
        );
        if (amountCents === null) throw Error();
        return { id, version, amountCents };
      });
      const taxCents = store.tax ? undefined : parseInvoiceMoney(req.body.tax);
      if (taxCents === null) throw Error();
      const r = await store.propose(token(res), {
        ownerId: req.body.ownerId,
        operationId: req.body.operationId,
        courses,
        cadence: req.body.cadence,
        startsOn: req.body.startsOn,
        ...(taxCents === undefined ? {} : { taxCents }),
      });
      return r.kind === "ready"
        ? res.redirect(
            303,
            `${adminPath}?ownerId=${encodeURIComponent(req.body.ownerId)}&prepared=1`,
          )
        : error(res, r.kind, req.body.operationId, true);
    } catch {
      return error(res, "invalid", undefined, true);
    }
  });
  app.post(`${adminPath}/due`, async (req, res) => {
    if (!valid(req, res)) return;
    if (!store) return error(res, "unavailable", undefined, true);
    const r = await store.generateDue(token(res));
    return r.kind === "ready"
      ? res.redirect(303, adminPath)
      : error(res, r.kind, undefined, true);
  });
  app.post(`${adminPath}/:id/payment`, async (req, res) => {
    if (!valid(req, res, ["confirm", "amount", "receivedOn", "evidence"]))
      return;
    if (!store) return error(res, "unavailable", undefined, true);
    const amount = parseInvoiceMoney(req.body.amount);
    if (req.body.confirm !== "received" || amount === null)
      return error(res, "invalid", undefined, true);
    const r = await store.pay(token(res), {
      invoiceId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
      amountCents: amount,
      receivedOn: req.body.receivedOn,
      evidence: String(req.body.evidence ?? "").trim(),
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${req.params.id}`)
      : error(res, r.kind, req.body.operationId, true);
  });
  app.post(`${adminPath}/:id/refund`, async (req, res) => {
    if (!valid(req, res, ["confirm", "amount", "refundedOn", "evidence"]))
      return;
    if (!store) return error(res, "unavailable", undefined, true);
    const amount = parseInvoiceMoney(req.body.amount);
    if (req.body.confirm !== "refunded" || amount === null)
      return error(res, "invalid", undefined, true);
    const r = await store.refund(token(res), {
      invoiceId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
      amountCents: amount,
      refundedOn: req.body.refundedOn,
      evidence: String(req.body.evidence ?? "").trim(),
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${req.params.id}`)
      : error(res, r.kind, req.body.operationId, true);
  });
  app.post(`${adminPath}/:id/void`, async (req, res) => {
    if (!valid(req, res, ["confirm", "reason"])) return;
    if (!store) return error(res, "unavailable", undefined, true);
    if (req.body.confirm !== "void")
      return error(res, "invalid", undefined, true);
    const r = await store.voidInvoice(token(res), {
      invoiceId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
      reason: req.body.reason,
    });
    return r.kind === "ready"
      ? res.redirect(303, `${adminPath}/${req.params.id}`)
      : error(res, r.kind, req.body.operationId, true);
  });
  app.post(`${adminPath}/:id/email`, async (req, res) => {
    if (!valid(req, res, ["confirm"])) return;
    if (!store || !options.invoiceSender)
      return error(res, "unavailable", undefined, true);
    if (req.body.confirm !== "send")
      return error(res, "invalid", undefined, true);
    const r = await store.claimEmail(token(res), {
      invoiceId: req.params.id,
      expectedRevision: Number(req.body.revision),
      operationId: req.body.operationId,
    });
    if (r.kind !== "ready")
      return error(res, r.kind, req.body.operationId, true);
    if (!r.value.send)
      return res.redirect(303, `${adminPath}/${req.params.id}`);
    let sent = false;
    try {
      const document = r.value.invoice.document as SimpleInvoiceDocument & {
        recipientEmail: string;
      };
      await options.invoiceSender.send(
        document.recipientEmail,
        document,
        `${options.origin}${memberPath}/invoices/${r.value.invoice.id}`,
      );
      sent = true;
    } catch {
      /* An uncertain email must not be automatically sent again. */
    }
    const done = await store.finishEmail(
      token(res),
      req.params.id,
      req.body.operationId,
      sent,
    );
    return done.kind === "ready"
      ? res.redirect(303, `${adminPath}/${req.params.id}`)
      : error(res, done.kind, req.body.operationId, true);
  });
}
