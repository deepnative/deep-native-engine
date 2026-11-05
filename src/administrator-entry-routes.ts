import type { Express, Request, Response } from "express";
import type {
  AdministratorConsole,
  AdministratorEntry,
} from "./administrator-entry.ts";
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
import { coachingStatus } from "./coaching-routes.ts";
import { hours } from "./coaching-dashboard-views.ts";
import { monthLabel } from "./coaching-values.ts";
import type { AccountRoleAdmin } from "./account-role-admin.ts";
import { coachAssignmentCard } from "./account-role-admin-routes.ts";
import type { AdministratorDiagnostics } from "./administrator-diagnostics.ts";
import {
  workWaitingCard,
  workWaitingUnavailable,
  type WorkQueueTools,
} from "./administrator-work-waiting-views.ts";
import { hostingText } from "./hosting-presentation.ts";

const CONSOLE_SEARCH_MAX = 120;

function learnersCard(v: AdministratorConsole, ownerId?: string) {
  const href = (page: number, selected = ownerId, anchor = "") => {
    const query = new URLSearchParams();
    if (selected) query.set("ownerId", selected);
    query.set("page", String(page));
    if (v.search) query.set("q", v.search);
    return escape(`/operator?${query}${anchor}`);
  };
  // CONSOLECOACH-01: the latest saved month, its hours and where it stands.
  const coaching = (m: AdministratorConsole["members"][number]) =>
    m.coaching
      ? `<td class="member-coaching"><a href="/operator/coaching/${escape(m.id)}?month=${escape(m.coaching.month)}">${monthLabel(m.coaching.month)}</a><span>${hours(m.coaching.minutes)} · ${coachingStatus(m.coaching)}</span></td>`
      : '<td class="member-coaching">—</td>';
  const first = (v.page - 1) * v.pageSize + 1,
    last = first + v.members.length - 1,
    pages = Math.max(Math.ceil(v.total / v.pageSize), 1);
  const count = (n: number) => n.toLocaleString("en-CA");
  const rows = v.members
    .map(
      (m) =>
        `<tr${m.id === ownerId ? ' aria-current="true"' : ""}><td><a href="${href(v.page, m.id, "#selected-member")}">${escape(m.displayName ?? "Name needed")}</a></td><td>${escape(BACKGROUNDS[m.background as Background] ?? m.background)}</td><td>${escape(GOALS[m.goal as Goal] ?? m.goal)}</td>${coaching(m)}<td>${m.joined.toISOString().slice(0, 10)}</td><td><code>${escape(m.id)}</code></td></tr>`,
    )
    .join("");
  const list = v.members.length
    ? `<p role="status">Showing ${count(first)}–${count(last)} of ${count(v.total)}</p><div class="table-scroll" tabindex="0" role="region" aria-label="Learner accounts"><table class="member-table"><thead><tr><th scope="col">Name</th><th scope="col">Starting point</th><th scope="col">Goal</th><th scope="col">Latest coaching</th><th scope="col">Joined</th><th scope="col">Account reference</th></tr></thead><tbody>${rows}</tbody></table></div><nav class="member-pager" aria-label="Learner pages">${v.page > 1 ? `<a class="button secondary" href="${href(v.page - 1)}">Previous</a>` : ""}<span>Page ${count(v.page)} of ${count(pages)}</span>${v.page < pages ? `<a class="button secondary" href="${href(v.page + 1)}">Next</a>` : ""}</nav>`
    : `<p role="status">${v.search ? "No learner accounts match this search." : "No learner accounts available."}</p>`;
  return `<section class="portal-card" id="learners"><h2>Learners</h2><form class="portal-search" method="get" action="/operator">${ownerId ? `<input type="hidden" name="ownerId" value="${escape(ownerId)}">` : ""}<label for="console-search">Search by name or account reference</label><div><input id="console-search" type="text" name="q" maxlength="${CONSOLE_SEARCH_MAX}" value="${escape(v.search)}"><button>Search</button></div></form>${v.search ? '<p><a href="/operator">Clear search</a></p>' : ""}${list}</section>`;
}

function memberToken(req: Request) {
  const cookie = uniqueCookie(req.headers.cookie, COOKIE);
  return cookie.kind === "value" && /^[a-f0-9]{64}$/.test(cookie.value)
    ? cookie.value
    : "";
}

export function mountAdministratorEntry(
  app: Express,
  store: AdministratorEntry | undefined,
  options: {
    origin: string;
    secret: string;
    localStaffEntry?: boolean;
    mode?: string;
    simpleInvoices?: unknown;
    roleAdmin?: AccountRoleAdmin;
    administratorDiagnostics?: Pick<AdministratorDiagnostics, "work">;
  },
  workQueues?: WorkQueueTools,
) {
  const member = memberToken;
  const fail = (res: Response, status: number) =>
    res.status(status).send(
      page(
        "Administration unavailable",
        `<section class="reading"><h1>Administration unavailable</h1><p>Use your current verified owner account. Administration is restricted to the existing approved owners. ${hostingText("Open Email sign-in with your already verified owner email, return to Administration, then choose Enter administration.", "If this is your owner account, open the verification link we emailed you, or send a new one from My account. If you are signed out, sign in with that email first. Then return to Administration and choose Enter administration.")} A learning profile or billing email does not grant administrator access. No authority was renewed or operation replayed. If a previous entry could not be confirmed, end administration before deliberately entering again.</p>${portalActions(
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
      target = req.query.ownerId,
      pageQuery = req.query.page,
      search = req.query.q;
    if (
      cookie.kind !== "value" ||
      !staffCredential(cookie.value) ||
      Object.keys(req.query).some(
        (key) => !["ownerId", "page", "q"].includes(key),
      ) ||
      (target !== undefined && !invoiceUuid(target)) ||
      (pageQuery !== undefined && typeof pageQuery !== "string") ||
      (search !== undefined &&
        (typeof search !== "string" || search.length > CONSOLE_SEARCH_MAX))
    )
      return fail(res, 403);
    // ADMINTABLE-02: a malformed page falls back to the first; the store clamps.
    const pageNumber = /^[1-9]\d{0,8}$/.test(pageQuery ?? "")
      ? Number(pageQuery)
      : 1;
    let result;
    try {
      result = await store?.console?.(cookie.value, target, {
        page: pageNumber,
        search: search ?? "",
      });
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
    // COACHLINK-01: the selected learner's coach, chosen from coach-role holders.
    const coachCard =
      chosen && options.roleAdmin
        ? coachAssignmentCard(
            await options.roleAdmin.learnerCoach(
              cookie.value,
              chosen.member.id,
            ),
            chosen.member.id,
            csrf(cookie.value, options.secret),
          )
        : "";
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
        }</section>${coachCard}`
      : "";
    // WAITWORK-08: a failed read says so, never shows zero, and keeps the console.
    let waiting = "";
    if (workQueues && options.administratorDiagnostics) {
      const work = await options.administratorDiagnostics
        .work(cookie.value)
        .catch(() => undefined);
      waiting =
        work?.kind === "ready"
          ? workWaitingCard(work.value, workQueues)
          : workWaitingUnavailable();
    }
    return res.send(
      page(
        "Administration console",
        `<div class="portal-page administrator-console"><div class="portal-intro"><h1>Administration console</h1><p>Manage the selected learner’s courses and billing. Registration and a proposal do not create enrollment or a charge; the learner must accept exact billing terms.</p><nav class="portal-actions" aria-label="Administration sections"><a href="#learners" class="button secondary">Learners</a><a href="#courses" class="button secondary">Courses/services</a><a href="#invoices" class="button secondary">Invoices</a></nav></div>${waiting}${learnersCard(v, target)}${summaries}<section class="portal-card" id="courses"><h2>Courses/services</h2><p>Published lesson versions only. Planned services, prices and support capacity are not published offers. These are course candidates; final eligibility is checked for the exact learner.</p><ul>${v.courses.map((c) => `<li>${escape(c.title)} · ${escape(c.id)} version ${c.version}</li>`).join("") || "<li>No published course candidates.</li>"}</ul></section><section class="portal-card" id="invoices"><h2>Invoices</h2>${
          options.simpleInvoices
            ? `<p>Select a learner above to inspect their retained invoices or compose a proposal for that exact account.</p>${portalActions(
                [
                  ["/operator/invoices", "Courses and invoices"],
                  ["/operator/coaching", "Monthly coaching"],
                ],
              )}`
            : "<p>Invoicing is disabled. Learning accounts and saved work remain available.</p>"
        }</section><div class="portal-footer">${portalActions([
          ...(options.roleAdmin
            ? ([["/operator/roles", "Roles"]] as [string, string][])
            : []),
          ["/operator/diagnostics", "Diagnostics"],
          // FRICTION-11: /admin needs a member account, so offer it only then.
          ...(member(req)
            ? ([["/admin", "Administrator session"]] as [string, string][])
            : []),
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
        `<div class="portal-page"><div class="portal-intro"><h1>Administration</h1><p>Enter an administrator session of up to eight hours. Your learning account stays separate, and entering creates no invoice, enrollment or payment. If you already entered, use the tools below; end a session before entering again.</p></div><section class="portal-card" aria-labelledby="admin-session"><h2 id="admin-session">Administrator session</h2><div class="portal-actions"><form method="post" action="/admin/enter"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button type="submit">Enter administration</button></form><form method="post" action="/admin/end"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button class="secondary" type="submit">End administration for this sign-in</button></form></div></section><section class="portal-card" aria-labelledby="admin-tools"><h2 id="admin-tools">Administration tools</h2>${portalActions(
          [
            ["/operator", "Administration console"],
            ["/operator/invoices", "Courses and invoices"],
            ["/operator/coaching", "Monthly coaching"],
            ...(options.roleAdmin
              ? ([["/operator/roles", "Roles"]] as [string, string][])
              : []),
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
