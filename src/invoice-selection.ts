import type { Express } from "express";
import type { Store } from "./store.ts";
import { csrf, validCsrf } from "./session.ts";
import { uniqueCookie } from "./staff-entry-selection.ts";
import { invoiceUuid } from "./simple-invoice-values.ts";
import { page } from "./views.ts";
export const INVOICE_SELECTION_COOKIE = "dne_invoice_selection";
const duration = 15 * 60 * 1000;
export function invoiceSelection(id: string, secret: string, now = Date.now()) {
  const payload = `${id}.${now + duration}`;
  return `${payload}.${csrf(payload, secret)}`;
}
export function invoiceResumeTarget(
  raw: string | undefined,
  secret: string,
  now = Date.now(),
) {
  const cookie = uniqueCookie(raw, INVOICE_SELECTION_COOKIE);
  if (cookie.kind !== "value") return null;
  const parts = cookie.value.split(".");
  if (
    parts.length !== 3 ||
    !invoiceUuid(parts[0]) ||
    !/^[0-9]{13}$/.test(parts[1]!) ||
    Number(parts[1]) <= now ||
    Number(parts[1]) > now + duration ||
    !validCsrf(parts[2], `${parts[0]}.${parts[1]}`, secret)
  )
    return null;
  return `/account/purchases#plan-${parts[0]}`;
}
export function mountInvoiceSelection(
  app: Express,
  members: Store,
  options: { origin: string; secret: string },
) {
  app.get("/courses/proposals/:id", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (!invoiceUuid(req.params.id) || Object.keys(req.query).length)
      return res.sendStatus(404);
    const selection = invoiceSelection(req.params.id, options.secret);
    res.cookie(INVOICE_SELECTION_COOKIE, selection, {
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(options.origin).protocol === "https:",
      path: "/",
      maxAge: duration,
    });
    const session = await members
      .session(res.locals.token as string, "account")
      .catch(() => null);
    if (!session)
      return res
        .status(503)
        .send(
          page(
            "Account unavailable",
            "<h1>Account unavailable</h1><p>Your selection is retained for 15 minutes. Check account access before continuing; no purchase was made.</p>",
          ),
        );
    if (session.kind === "active")
      return res.redirect(
        303,
        invoiceResumeTarget(
          `${INVOICE_SELECTION_COOKIE}=${selection}`,
          options.secret,
        )!,
      );
    return res
      .status(401)
      .send(
        page(
          "Return to your course proposal",
          '<section class="reading"><h1>Return to your course proposal</h1><p>Sign in to the account for which this proposal was prepared. Only that account can review or accept it. Registering a different account never transfers a proposal, creates a charge or grants paid access.</p><p><a href="/email/sign-in">Email sign-in</a> · <a href="/">Register or return to learning</a></p><p>This browser remembers the selection for 15 minutes. If it expires or you use another browser, reopen the proposal link after signing in, or inspect Courses and invoices in My account.</p></section>',
        ),
      );
  });
}
