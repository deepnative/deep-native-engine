import type { Express, Request, Response } from "express";
import type {
  AdministratorConsole,
  AdministratorEntry,
  LatestCoaching,
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
import { page, escape } from "./views.ts";
import { portalActions } from "./backend-portal-presentation.ts";
import {
  adminMenu,
  shortInvoiceNumber,
  type AdminMenuAvailable,
} from "./administration-presentation.ts";
import { coachingStatus } from "./coaching-routes.ts";
import { hours } from "./coaching-dashboard-views.ts";
import { dayLabel, monthLabel, periodLabel } from "./coaching-values.ts";
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
const WORK_QUEUES = [
  "support",
  "feedback",
  "workflow",
  "contributions",
] as const;
const cad = (cents: number) => `CAD ${(cents / 100).toFixed(2)}`;
const named = (name?: string | null) => escape(name ?? "Name needed");

/** ADMINHOME-01: submitted hours first, each opening that student's month. */
function awaitingReview(v: AdministratorConsole) {
  const items = v.awaiting
    .map(
      (m) =>
        `<li><a href="/operator/coaching/${escape(m.id)}?month=${escape(m.month)}">${named(m.displayName)}</a><span>${periodLabel({ key: m.month, start: m.periodStart, end: m.periodEnd })} · ${hours(m.minutes)}</span></li>`,
    )
    .join("");
  return `<section class="admin-section" aria-labelledby="awaiting-review"><h2 id="awaiting-review">Awaiting review</h2>${items ? `<ul class="admin-list">${items}</ul>` : '<p role="status">No hours are waiting for review.</p>'}</section>`;
}

/** ADMINHOME-01: one row per student; the name opens the student's page. */
function studentsTable(v: AdministratorConsole, billing: boolean) {
  const href = (page: number) => {
    const query = new URLSearchParams({ page: String(page) });
    if (v.search) query.set("q", v.search);
    return escape(`/operator?${query}`);
  };
  type Student = AdministratorConsole["members"][number];
  // CONSOLEMONTHS-01: this month's hours and where they stand. #832: a
  // defined period is named by its dates.
  const month = (m: Student) => {
    const saved: LatestCoaching | null | undefined = m.thisMonth;
    if (!saved) return "—";
    const link = `/operator/coaching/${escape(m.id)}?month=${escape(saved.month)}`;
    return saved.month.length === 10
      ? `<a href="${link}">${periodLabel({ key: saved.month, start: saved.periodStart, end: saved.periodEnd })}</a><span>${hours(saved.minutes)} · ${coachingStatus(saved)}</span>`
      : `<a href="${link}">${hours(saved.minutes)}</a><span>${coachingStatus(saved)}</span>`;
  };
  const first = (v.page - 1) * v.pageSize + 1,
    last = first + v.members.length - 1,
    pages = Math.max(Math.ceil(v.total / v.pageSize), 1);
  const count = (n: number) => n.toLocaleString("en-CA");
  const rows = v.members
    .map(
      (m) =>
        `<tr><td data-label="Name"><a href="${billing ? "/operator/coaching/" : "/operator?ownerId="}${escape(m.id)}">${named(m.displayName)}</a></td><td data-label="Hourly rate">${m.rateCents == null ? "Not set" : cad(m.rateCents)}</td><td data-label="This month" class="member-coaching">${month(m)}</td><td data-label="Joined">${dayLabel(m.joined.toISOString().slice(0, 10))}</td></tr>`,
    )
    .join("");
  const list = v.members.length
    ? `<p role="status">Showing ${count(first)}–${count(last)} of ${count(v.total)}</p><div class="table-scroll" tabindex="0" role="region" aria-label="Students"><table class="member-table stack-table"><thead><tr><th scope="col">Name</th><th scope="col">Hourly rate</th><th scope="col">This month<span>${monthLabel(v.months.current)}</span></th><th scope="col">Joined</th></tr></thead><tbody>${rows}</tbody></table></div>${pages > 1 ? `<nav class="member-pager" aria-label="Student pages">${v.page > 1 ? `<a class="button secondary" href="${href(v.page - 1)}">Previous</a>` : ""}<span>Page ${count(v.page)} of ${count(pages)}</span>${v.page < pages ? `<a class="button secondary" href="${href(v.page + 1)}">Next</a>` : ""}</nav>` : ""}`
    : `<p role="status">${v.search ? "No students match this search." : "No students yet."}</p>`;
  return `<section class="admin-section" aria-labelledby="all-students"><h2 id="all-students">All students</h2><form class="portal-search" method="get" action="/operator"><label for="console-search">Search by name</label><div><input id="console-search" type="text" name="q" maxlength="${CONSOLE_SEARCH_MAX}" value="${escape(v.search)}"><button>Search</button></div></form>${v.search ? '<p><a href="/operator">Clear search</a></p>' : ""}${list}</section>`;
}

/**
 * ADMINSTUDENT-01: old "selected learner" links land on a small page for one
 * student: their coaches and any course records. #850 SEAM-01: a site with
 * billing on shows both on the student's one page instead, so this page is
 * only rendered where billing is switched off.
 */
function studentPage(
  chosen: NonNullable<AdministratorConsole["selected"]>,
  coachCard: string,
  menu: string,
) {
  const group = (title: string, items: string[]) =>
    items.length
      ? `<div><h3>${title}</h3><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`
      : "";
  const records =
    group(
      "Enrollments",
      chosen.enrollments.map((e) => `${escape(e.title)} · ${escape(e.id)}`),
    ) +
    group(
      "Course bundles",
      chosen.plans.map((p) => `Course bundle · ${escape(p.state)}`),
    ) +
    group(
      "Invoices",
      chosen.invoices.map(
        (i) =>
          `<a href="/operator/invoices/${escape(i.id)}">${escape(shortInvoiceNumber(i.number))}</a> · ${cad(Number(i.totalCents))} · ${i.delivery === "sent" ? "Sent" : "Not sent"}`,
      ),
    );
  return `<div class="portal-page student-page">${menu}<h1>${named(chosen.member.displayName)}</h1><p class="page-kind">Student</p>${coachCard}<section class="portal-card" aria-labelledby="student-courses"><h2 id="student-courses">Courses</h2>${records ? `<div class="portal-columns">${records}</div>` : "<p>No course enrollment, bundle or course invoice yet.</p>"}<p>Billing is switched off on this site.</p></section><p class="back-link"><a href="/operator">All students</a></p></div>`;
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
  // ADMINNAV-01 / HIDE-01: the menu links only to areas this site has on.
  const available: AdminMenuAvailable = {
    invoices: Boolean(options.simpleInvoices),
    roles: Boolean(options.roleAdmin),
  };
  app.locals.adminMenu = available;
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
      chosen = v.selected,
      billing = Boolean(options.simpleInvoices);
    // #850 SEAM-01: the student's one page has their coaches and courses.
    if (chosen && billing)
      return res.redirect(303, `/operator/coaching/${chosen.member.id}`);
    // COACHLINK-01 / #689: the student's coaches, chosen from coach-role holders.
    const coachCard =
      chosen && options.roleAdmin
        ? coachAssignmentCard(
            await options.roleAdmin.learnerCoaches(
              cookie.value,
              chosen.member.id,
            ),
            chosen.member.id,
            csrf(cookie.value, options.secret),
          )
        : "";
    const menu = adminMenu("students", available);
    if (chosen)
      return res.send(
        page(
          chosen.member.displayName ?? "Student",
          studentPage(chosen, coachCard, menu),
        ),
      );
    // WAITWORK-08: a failed read says so, never shows zero, and keeps the page.
    // HIDE-01: with nothing waiting or assigned anywhere, the card is left out.
    let waiting = "";
    if (workQueues && options.administratorDiagnostics) {
      const work = await options.administratorDiagnostics
        .work(cookie.value)
        .catch(() => undefined);
      waiting =
        work?.kind !== "ready"
          ? workWaitingUnavailable()
          : WORK_QUEUES.some(
                (key) =>
                  workQueues[key] &&
                  (work.value[key].waiting > 0 ||
                    (work.value[key].assigned ?? 0) > 0),
              )
            ? workWaitingCard(work.value, workQueues)
            : "";
    }
    // HIDE-01: published courses are listed only when there are some.
    const courses = v.courses.length
      ? `<section class="admin-section" aria-labelledby="courses"><h2 id="courses">Courses</h2><p>Published lessons that can be put on a course invoice.</p><ul class="admin-list">${v.courses.map((c) => `<li>${escape(c.title)}<span>${escape(c.id)} version ${c.version}</span></li>`).join("")}</ul></section>`
      : "";
    return res.send(
      page(
        "Students",
        `<div class="portal-page administrator-console">${menu}<h1>Students</h1>${awaitingReview(v)}${studentsTable(v, billing)}${waiting}${courses}</div>`,
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
    const anti = `<input type="hidden" name="csrf" value="${csrf(token, options.secret)}">`;
    // This browser holds an administration cookie once entered, until it is
    // ended or expires. It only chooses what the page offers first: ending
    // stays on the page either way, and both routes still decide for
    // themselves.
    const staff = staffCookie(req.headers.cookie),
      entered = staff.kind === "value" && staffCredential(staff.value);
    const end = (label: string) =>
      `<form method="post" action="/admin/end">${anti}<button class="secondary" type="submit">${label}</button></form>`;
    return res.send(
      page(
        "Administration",
        `<div class="portal-page admin-entry">${entered ? adminMenu(undefined, available) : ""}<h1>Administration</h1><p>${entered ? "You are in an administrator session. It lasts up to eight hours and ends when you choose End administration." : "An administrator session lasts up to eight hours and stays separate from your learning account."}</p><div class="portal-actions">${
          entered
            ? `<a href="/operator" class="button">Go to Students</a>${end("End administration")}`
            : `<form method="post" action="/admin/enter">${anti}<button type="submit">Enter administration</button></form>${end("End an earlier session")}`
        }</div></div>`,
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
      // ADMINEXP-01: name the earlier session and offer the button that ends it.
      if (result?.kind === "unended")
        return res
          .status(409)
          .send(
            page(
              "End your earlier administrator session",
              `<section class="reading"><h1>End your earlier administrator session</h1><p>An administrator session lasts up to eight hours. Your earlier one for this sign-in was not ended, so it has to be ended before you enter again. Nothing was changed.</p><form method="post" action="/admin/end"><input type="hidden" name="csrf" value="${csrf(token, options.secret)}"><button type="submit">End administration for this sign-in</button></form><p>Then choose Enter administration on the next page.</p></section>`,
            ),
          );
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
