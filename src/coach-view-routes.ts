import type { Express, Request, Response } from "express";
import type { CoachView } from "./coach-view.ts";
import { hours } from "./coaching-dashboard-views.ts";
import { monthLabel } from "./coaching-values.ts";
import { COOKIE } from "./session.ts";
import { uniqueCookie } from "./staff-entry-selection.ts";
import { shiftMonth } from "./simple-invoice-store.ts";
import { escape, page } from "./views.ts";

function memberToken(req: Request) {
  const value = uniqueCookie(req.headers.cookie, COOKIE);
  return value.kind === "value" && /^[a-f0-9]{64}$/.test(value.value)
    ? value.value
    : "";
}
const REFUSALS = {
  denied: [
    403,
    "Coaching is for coaches",
    "Sign in with a coach account to see coaching hours. Your saved work is unchanged.",
  ],
  invalid: [400, "Choose a month", "Choose this month or an earlier one."],
  unavailable: [
    503,
    "Coaching is unavailable",
    "Try again shortly. Your saved work is unchanged.",
  ],
} as const;

function refuse(res: Response, kind: keyof typeof REFUSALS) {
  const [status, title, text] = REFUSALS[kind];
  return res
    .status(status)
    .send(
      page(
        title,
        `<section class="reading"><h1>${title}</h1><p>${text}</p><p><a href="/learn">Learning</a> · <a href="/account">My account</a></p></section>`,
      ),
    );
}

/** #673 ROLES-03/04: the coach view's landing page. Read-only; no billing. */
export function mountCoachView(app: Express, store: CoachView | undefined) {
  if (!store) return;
  app.get("/coach", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = memberToken(req),
      month = req.query.month;
    if (
      !token ||
      Object.keys(req.query).some((key) => key !== "month") ||
      (month !== undefined && typeof month !== "string")
    )
      return refuse(res, "denied");
    const result = await store.summary(token, month);
    if (result.kind !== "ready") return refuse(res, result.kind);
    const v = result.value,
      previous = shiftMonth(v.month, -1),
      next = shiftMonth(v.month, 1);
    const rows = v.rows
      .map(
        (r) =>
          `<tr><td>${escape(r.name ?? "Name needed")}</td><td>${hours(r.minutes)}</td><td>${escape(r.status)}</td></tr>`,
      )
      .join("");
    const table = rows
      ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Coaching hours"><table class="member-table coach-hours"><thead><tr><th scope="col">Name</th><th scope="col">Hours</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p role="status">No coaching hours saved for this month.</p>';
    res.send(
      page(
        "Coaching",
        `<section class="portal-workspace"><h1>Coaching</h1><p>Monthly coaching hours people have saved for ${monthLabel(v.month)}. Rates, amounts and invoices stay in Administration.</p><form class="portal-search" method="get" action="/coach"><label for="coach-month">Month</label><div><input id="coach-month" name="month" type="month" value="${v.month}" max="${v.today}"><button type="submit">Show month</button></div></form><p class="portal-actions"><a href="/coach?month=${previous}">Previous month</a>${next <= v.today ? ` <a href="/coach?month=${next}">Next month</a>` : ""}</p><section class="portal-card"><h2>${monthLabel(v.month)}</h2>${table}</section></section>`,
      ),
    );
  });
}
