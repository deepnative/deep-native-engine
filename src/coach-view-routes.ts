import type { Express, Request, Response } from "express";
import type { CoachView } from "./coach-view.ts";
import { hours } from "./coaching-dashboard-views.ts";
import { monthLabel, monthNav, periodLabel } from "./coaching-values.ts";
import { COOKIE } from "./session.ts";
import { uniqueCookie } from "./staff-entry-selection.ts";
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
    const v = result.value;
    const rows = v.rows
      .map(
        (r) =>
          `<tr><td>${escape(r.name ?? "Name needed")}${r.period ? `<span>${periodLabel(r.period)}</span>` : ""}</td><td>${hours(r.minutes)}</td><td>${escape(r.status)}</td></tr>`,
      )
      .join("");
    const table = rows
      ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Coaching hours"><table class="member-table coach-hours"><caption class="visually-hidden">Coaching hours for ${monthLabel(v.month)}</caption><thead><tr><th scope="col">Name</th><th scope="col">Hours</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : v.assigned
        ? '<p role="status">No coaching hours saved for this month.</p>'
        : '<p role="status">No students are assigned to you yet. Ask an administrator to assign students to you in the Administration console.</p>';
    res.send(
      page(
        "Coaching",
        `<section class="portal-workspace"><h1>Coaching</h1><p>Coaching hours your students have saved. A billing period shorter or longer than a calendar month is listed in the month it ends.</p>${monthNav("/coach", v.month, v.today)}<section class="portal-card"><h2>${monthLabel(v.month)}</h2>${table}</section></section>`,
      ),
    );
  });
}
