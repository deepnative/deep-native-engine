import type { Express, Request, Response } from "express";
import type { AdministratorEntry } from "./administrator-entry.ts";
import { COOKIE, cookieOptions, csrf, validCsrf } from "./session.ts";
import {
  STAFF_COOKIE,
  SIGNED_OUT,
  uniqueCookie,
  staffCredential,
  staffCookie,
} from "./staff-entry-selection.ts";
import { invoiceUuid } from "./simple-invoice-values.ts";
import { BACKGROUNDS, GOALS, type Background, type Goal } from "./content.ts";
import { page, escape } from "./views.ts";
import { portalActions } from "./backend-portal-presentation.ts";

export function mountAdministratorEntry(
  app: Express,
  store: AdministratorEntry | undefined,
  options: {
    origin: string;
    secret: string;
    localStaffEntry?: boolean;
    mode?: string;
    simpleInvoices?: unknown;
  },
) {
  const member = (req: Request) => {
    const cookie = uniqueCookie(req.headers.cookie, COOKIE);
    return cookie.kind === "value" && /^[a-f0-9]{64}$/.test(cookie.value)
      ? cookie.value
      : "";
  };
  const fail = (res: Response, status: number) =>
    res.status(status).send(
      page(
        "Administration unavailable",
        `<section class="reading"><h1>Administration unavailable</h1><p>Use your current verified owner account. Administration is restricted to the existing approved owners. Open Email sign-in with your already verified owner email, return to Administration, then choose Enter administration. A learning profile or billing email does not grant administrator access. No authority was renewed or operation replayed. If a previous entry could not be confirmed, end administration before deliberately entering again.</p>${portalActions(
          [
            ["/admin", "Administration"],
            ["/email/sign-in", "Email sign-in"],
            ["/learn", "Learning"],
          ],
        )}</section>`,
      ),
    );
  async function attempt(action: "status" | "enter" | "end", token: string) {
    try {
      return await store?.[action](token);
    } catch {
      return { kind: "unavailable" as const };
    }
  }
  app.get("/operator", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!options.localStaffEntry || options.mode === "live")
      return fail(res, 404);
    const cookie = staffCookie(req.headers.cookie),
      target = req.query.ownerId;
    if (
      cookie.kind !== "value" ||
      !staffCredential(cookie.value) ||
      Object.keys(req.query).some((key) => key !== "ownerId") ||
      (target !== undefined && !invoiceUuid(target))
    )
      return fail(res, 403);
    let result;
    try {
      result = await store?.console?.(cookie.value, target);
    } catch {
      return fail(res, 503);
    }
    if (!result || result.kind !== "ready")
      return fail(
        res,
        result?.kind === "denied"
          ? 403
          : result?.kind === "not-found"
            ? 404
            : 503,
      );
    const v = result.value,
      chosen = v.selected;
    const summaries = chosen
      ? `<section class="portal-card" aria-labelledby="selected-member"><h2 id="selected-member">Selected learner</h2><p class="portal-summary">${escape(chosen.member.displayName ?? "Name needed")} · ${escape(BACKGROUNDS[chosen.member.background as Background] ?? chosen.member.background)} · ${escape(GOALS[chosen.member.goal as Goal] ?? chosen.member.goal)}</p><p class="portal-reference">Account reference: <code>${escape(chosen.member.id)}</code></p><p>Only enrollment and billing summaries are shown. Private writing and files are not available here.</p><div class="portal-columns"><div><h3>Enrollments</h3><ul>${chosen.enrollments.map((e) => `<li>${escape(e.title)} · ${escape(e.id)}</li>`).join("") || "<li>No recorded enrollment.</li>"}</ul></div><div><h3>Course bundles</h3><ul>${chosen.plans.map((p) => `<li>${escape(p.id)} · ${escape(p.state)}</li>`).join("") || "<li>No course bundles.</li>"}</ul></div><div><h3>Invoices</h3><ul>${chosen.invoices.map((i) => `<li><a href="/operator/invoices/${escape(i.id)}">${escape(i.number)}</a> · CAD ${(Number(i.totalCents) / 100).toFixed(2)} · delivery ${escape(i.delivery)}</li>`).join("") || "<li>No issued invoices.</li>"}</ul></div></div>${
          options.simpleInvoices
            ? portalActions(
                [
                  [
                    `/operator/invoices?ownerId=${escape(chosen.member.id)}`,
                    "Compose courses for this learner",
                  ],
                  [
                    `/operator/coaching/${escape(chosen.member.id)}`,
                    "Monthly coaching and rates",
                  ],
                ],
                true,
              )
            : "<p>Billing is disabled. No proposal, invoice or rate can be created from this console.</p>"
        }</section>`
      : "";
    return res.send(
      page(
        "Administration console",
        `<div class="portal-page administrator-console"><div class="portal-intro"><h1>Administration console</h1><p>Manage the selected learner’s courses and billing. Registration and a proposal do not create enrollment or a charge; the learner must accept exact billing terms.</p><nav class="portal-actions" aria-label="Administration sections"><a href="#learners" class="button secondary">Learners</a><a href="#courses" class="button secondary">Courses/services</a><a href="#invoices" class="button secondary">Invoices</a></nav></div><section class="portal-card" id="learners"><h2>Learners</h2><form class="portal-search" method="get" action="/operator"><label for="console-owner">Exact learner account reference</label><div><input id="console-owner" type="text" name="ownerId" required maxlength="36"><button>Find learner</button></div></form><p>Up to 100 accounts are listed. Use an exact reference to find another account.</p><ul class="member-directory">${v.members.map((m) => `<li><a href="/operator?ownerId=${escape(m.id)}">${escape(m.displayName ?? "Name needed")}</a><p>${escape(BACKGROUNDS[m.background as Background] ?? m.background)} · ${escape(GOALS[m.goal as Goal] ?? m.goal)}</p><details><summary>Account reference · ${escape(m.id.slice(0, 8))}</summary><code>${escape(m.id)}</code></details></li>`).join("") || "<li>No learner accounts available.</li>"}</ul></section>${summaries}<section class="portal-card" id="courses"><h2>Courses/services</h2><p>Published lesson versions only. Planned services, prices and support capacity are not published offers. These are course candidates; final eligibility is checked for the exact learner.</p><ul>${v.courses.map((c) => `<li>${escape(c.title)} · ${escape(c.id)} version ${c.version}</li>`).join("") || "<li>No published course candidates.</li>"}</ul></section><section class="portal-card" id="invoices"><h2>Invoices</h2>${
          options.simpleInvoices
            ? `<p>Select a learner above to inspect their retained invoices or compose a proposal for that exact account.</p>${portalActions(
                [
                  ["/operator/invoices", "Courses and invoices"],
                  ["/operator/coaching", "Monthly coaching"],
                ],
              )}`
            : "<p>Invoicing is disabled. Learning accounts and saved work remain available.</p>"
        }</section><div class="portal-footer">${portalActions([
          ["/admin", "Administrator session"],
          ["/account", "My learning account"],
        ])}</div></div>`,
      ),
    );
  });
  app.get("/admin", async (req, res) => {
    if (!options.localStaffEntry || options.mode === "live")
      return fail(res, 404);
    const token = member(req);
    if (!token || Object.keys(req.query).length) return fail(res, 403);
    const result = await attempt("status", token);
    if (!result || result.kind !== "ready")
      return fail(res, result?.kind === "denied" ? 403 : 503);
    return res.send(
      page(
        "Administration",
        `<div class="portal-page"><div class="portal-intro"><h1>Administration</h1><p>Your verified owner account can deliberately enter a finite administrator session, lasting at most eight hours. Your learning account and saved work remain separate. Entry creates no invoice, enrollment or payment. If you already entered, use the existing tools. End an active or expired session before entering again.</p></div><section class="portal-card" aria-labelledby="admin-session"><h2 id="admin-session">Administrator session</h2><div class="portal-actions"><form method="post" action="/admin/enter"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button type="submit">Enter administration</button></form><form method="post" action="/admin/end"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button class="secondary" type="submit">End administration for this sign-in</button></form></div></section><section class="portal-card" aria-labelledby="admin-tools"><h2 id="admin-tools">Administration tools</h2>${portalActions(
          [
            ["/operator", "Administration console"],
            ["/operator/invoices", "Courses and invoices"],
            ["/operator/coaching", "Monthly coaching"],
            ["/staff", "Staff tools"],
          ],
        )}</section><section class="portal-card" aria-labelledby="admin-learning"><h2 id="admin-learning">Your learning account</h2>${portalActions([["/account", "My learning account"]])}</section></div>`,
      ),
    );
  });
  for (const action of ["enter", "end"] as const)
    app.post(`/admin/${action}`, async (req, res) => {
      if (!options.localStaffEntry || options.mode === "live")
        return fail(res, 404);
      const token = member(req);
      if (
        !token ||
        req.get("origin") !== options.origin ||
        Object.keys(req.query).length ||
        !req.body ||
        Object.keys(req.body).some((key) => key !== "csrf") ||
        !validCsrf(req.body.csrf, token, options.secret)
      )
        return fail(res, 403);
      const result = await attempt(action, token);
      if (!result || result.kind !== "ready")
        return fail(res, result?.kind === "denied" ? 403 : 503);
      if (action === "enter") {
        if (
          !staffCredential(result.credential) ||
          !(result.expires instanceof Date) ||
          !Number.isFinite(+result.expires) ||
          +result.expires <= Date.now()
        )
          return fail(res, 503);
        res.cookie(
          STAFF_COOKIE,
          result.credential,
          cookieOptions(options.origin, result.expires),
        );
      } else
        res.cookie(STAFF_COOKIE, SIGNED_OUT, cookieOptions(options.origin));
      return res.redirect(303, action === "enter" ? "/operator" : "/admin");
    });
}
