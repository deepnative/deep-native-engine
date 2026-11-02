import type { Express, Request, Response } from "express";
import type { AdministratorEntry } from "./administrator-entry.ts";
import { COOKIE, cookieOptions, csrf, validCsrf } from "./session.ts";
import {
  STAFF_COOKIE,
  SIGNED_OUT,
  uniqueCookie,
  staffCredential,
} from "./staff-entry-selection.ts";
import { page } from "./views.ts";

export function mountAdministratorEntry(
  app: Express,
  store: AdministratorEntry | undefined,
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
          "Administration unavailable",
          '<section class="reading"><h1>Administration unavailable</h1><p>Use your current verified owner account. No authority was renewed or operation replayed. If a previous entry could not be confirmed, end administration before deliberately entering again.</p><p><a href="/admin">Administration</a> · <a href="/email/sign-in">Email sign-in</a> · <a href="/learn">Learning</a></p></section>',
        ),
      );
  async function attempt(action: "status" | "enter" | "end", token: string) {
    try {
      return await store?.[action](token);
    } catch {
      return { kind: "unavailable" as const };
    }
  }
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
        `<section class="reading"><h1>Administration</h1><p>Your verified owner account can deliberately enter a finite administrator session, lasting at most eight hours. Your learning account and saved work remain separate. Entry creates no invoice, enrollment or payment. If you already entered, use the existing tools. End an active or expired session before entering again.</p><form method="post" action="/admin/enter"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button type="submit">Enter administration</button></form><p><a href="/operator/invoices">Courses and invoices</a> · <a href="/operator/coaching">Monthly coaching</a> · <a href="/staff">Staff tools</a></p><form method="post" action="/admin/end"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button class="secondary" type="submit">End administration for this sign-in</button></form><p><a href="/account">My learning account</a></p></section>`,
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
      return res.redirect(
        303,
        action === "enter" ? "/operator/invoices" : "/admin",
      );
    });
}
