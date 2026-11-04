import type { Express, Request, Response } from "express";
import type {
  AdministratorDiagnostics,
  EmailDiagnosis,
  SiteDiagnosis,
} from "./administrator-diagnostics.ts";
import { portalActions } from "./backend-portal-presentation.ts";
import { COOKIE, csrf, validCsrf } from "./session.ts";
import {
  staffCookie,
  staffCredential,
  uniqueCookie,
} from "./staff-entry-selection.ts";
import { escape, page } from "./views.ts";

const PATH = "/operator/diagnostics";
const when = (d: Date) =>
  `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const count = (n: number) => n.toLocaleString("en-CA");

function siteTable(s: SiteDiagnosis) {
  const rows: Array<[string, number]> = [
    ["Accounts", s.accounts],
    ["Verified emails", s.verifiedEmails],
    ["Unverified sign-up emails", s.unverifiedEmails],
    ["Accounts with a password", s.passwords],
    ["Email-link requests (Link an email), last 24 hours", s.day.attach],
    ["Sign-in links, last 24 hours", s.day.signIn],
    ["Links used, last 24 hours", s.day.used],
    ["No-account notices, last 24 hours", s.day.notices],
    ["Email lookups here, last 24 hours", s.day.lookups],
    ["Latest database migration", s.latestMigration],
  ];
  return `<table class="diagnostics-table"><tbody>${rows.map(([label, n]) => `<tr><th scope="row">${label}</th><td>${count(n)}</td></tr>`).join("")}</tbody></table>`;
}

function emailResult(d: EmailDiagnosis) {
  const owner = (o: EmailDiagnosis["verified"], none: string) =>
    o
      ? `${escape(o.displayName ?? "Name needed")} · <code>${escape(o.accountId)}</code> · since ${when(o.since)}`
      : none;
  const purpose = { attach: "Link-an-email link", sign_in: "Sign-in link" };
  return `<section class="portal-card" aria-live="polite"><h2>${escape(d.address)}</h2><table class="diagnostics-table"><tbody><tr><th scope="row">Verified email</th><td>${owner(d.verified, "Not verified")}</td></tr><tr><th scope="row">Unverified sign-up email</th><td>${owner(d.unverified, "None")}</td></tr></tbody></table><h3>Latest emailed links</h3><ul>${d.links.map((l) => `<li>${purpose[l.purpose]} · ${when(l.created)} · ${l.state}</li>`).join("") || "<li>No links were created for this address.</li>"}</ul><h3>No-account notices</h3><ul>${d.notices.map((n) => `<li>${when(n)}</li>`).join("") || "<li>None.</li>"}</ul><p class="small">A link listed here was handed to the email service. If it never arrived, check the recipient’s spam or quarantine.</p></section>`;
}

function lookupForm(token: string, secret: string, message = "") {
  return `<section class="portal-card"><h2>Look up an email</h2><p>Shows whether an address belongs to an account, whether it is verified, and the emails sent to it. Nothing is changed or sent.</p>${message ? `<p role="alert" class="form-error">${message}</p>` : ""}<form method="post" action="${PATH}/email"><input type="hidden" name="csrf" value="${csrf(token, secret)}"><label for="diagnostics-email">Email address</label><input id="diagnostics-email" name="email" type="email" maxlength="254" required autocomplete="off"><button type="submit">Look up</button></form></section>`;
}

/** DIAG-01/02/03: read-only checks for a current administrator session. */
export function mountAdministratorDiagnostics(
  app: Express,
  store: AdministratorDiagnostics | undefined,
  options: {
    origin: string;
    secret: string;
    localStaffEntry?: boolean;
    mode?: string;
  },
) {
  const member = (req: Request) => {
    const cookie = uniqueCookie(req.headers.cookie, COOKIE);
    return cookie.kind === "value" && /^[a-f0-9]{64}$/.test(cookie.value)
      ? cookie.value
      : "";
  };
  const fail = (res: Response, status: number) =>
    res
      .status(status)
      .send(
        page(
          "Diagnostics unavailable",
          `<section class="reading"><h1>Diagnostics unavailable</h1><p>Diagnostics need a current administrator session. Return to Administration and choose Enter administration.</p>${portalActions([["/admin", "Administration"]])}</section>`,
        ),
      );
  const render = (
    res: Response,
    token: string,
    site: SiteDiagnosis,
    extra = "",
    message = "",
    status = 200,
  ) =>
    res
      .status(status)
      .send(
        page(
          "Diagnostics",
          `<div class="portal-page"><div class="portal-intro"><h1>Diagnostics</h1><p>Read-only checks of this engine’s data. Counts are live; nothing here changes an account or sends email. Each email lookup is recorded.</p></div>${extra}${lookupForm(token, options.secret, message)}<section class="portal-card"><h2>Site</h2>${siteTable(site)}</section><div class="portal-footer">${portalActions([["/operator", "Administration console"]])}</div></div>`,
        ),
      );
  // Resolves the administrator credential, or answers the request itself.
  function credential(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    if (!options.localStaffEntry || options.mode === "live" || !store) {
      fail(res, 404);
      return null;
    }
    const cookie = staffCookie(req.headers.cookie);
    if (cookie.kind !== "value" || !staffCredential(cookie.value)) {
      fail(res, 403);
      return null;
    }
    return cookie.value;
  }
  app.get(PATH, async (req, res) => {
    const staff = credential(req, res);
    if (!staff) return;
    if (Object.keys(req.query).length) return fail(res, 403);
    const site = await store!.site(staff);
    if (site.kind !== "ready")
      return fail(res, site.kind === "denied" ? 403 : 503);
    return render(res, member(req), site.value);
  });
  app.post(`${PATH}/email`, async (req, res) => {
    const staff = credential(req, res);
    if (!staff) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = member(req);
    if (
      Object.keys(req.query).length ||
      Object.keys(body).some((key) => !["csrf", "email"].includes(key)) ||
      typeof body.email !== "string" ||
      req.get("origin") !== options.origin ||
      !token ||
      !validCsrf(body.csrf, token, options.secret)
    )
      return fail(res, 403);
    // The lookup is recorded first, so the count below includes it.
    const found = await store!.email(staff, body.email);
    const site = await store!.site(staff);
    if (site.kind !== "ready")
      return fail(res, site.kind === "denied" ? 403 : 503);
    if (found.kind === "invalid")
      return render(
        res,
        token,
        site.value,
        "",
        "Enter a full email address.",
        422,
      );
    if (found.kind !== "ready")
      return fail(res, found.kind === "denied" ? 403 : 503);
    return render(res, token, site.value, emailResult(found.value));
  });
}
