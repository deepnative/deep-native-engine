import { hostingText } from "./hosting-presentation.ts";
import type { Express, Request, Response } from "express";
import type { ApplicationMode } from "./adapters.ts";
import type { StaffRole } from "./authorization.ts";
import type { StaffEntryStore } from "./staff-entry.ts";
import { COOKIE, COOKIE_OPTIONS } from "./session.ts";
import {
  STAFF_COOKIE,
  ENTRY_COOKIE,
  SIGNED_OUT,
  staffCookie,
  uniqueCookie,
  staffCredential,
} from "./staff-entry-selection.ts";
import {
  entryNonce,
  entryCsrf,
  validEntry,
  ENTRY_LIFETIME,
} from "./staff-entry-integrity.ts";
import { CIRCLES } from "./circles.ts";
import { escape, page, hidden } from "./views.ts";
import { portalActions } from "./backend-portal-presentation.ts";
export interface StaffTools {
  library: boolean;
  worklist: boolean;
  support: boolean;
  supportTime: boolean;
  assignments: boolean;
  sampleAssignments: boolean;
  reviewTimeGrants?: boolean;
  supportTimeGrants?: boolean;
  reviewTimeGrantReference?: boolean;
  experts: boolean;
  metrics: boolean;
  ledger: boolean;
  holds: boolean;
  proposals: boolean;
  /** FRICTION-11: the administration console is available here. */
  console?: boolean;
  circles: boolean;
  circleGrants: boolean;
  eventCancellations?: boolean;
  eventAttendance?: boolean;
  studyUnits?: boolean;
  eventRehearsals?: boolean;
  workflowReviews?: boolean;
  invoices?: boolean;
  localAi: boolean;
  receipts: boolean;
}
const labels = (): Record<StaffRole, string> => ({
  editor: "Content editor",
  reviewer: "Sample reviewer",
  operator: hostingText("Local operator", "Operator"),
  moderator: hostingText("Local moderator", "Moderator"),
  platform_admin: "Platform administrator",
  coach: "Coach",
});
function links(role: StaffRole, tools: StaffTools) {
  const choices: [boolean, string, string][] = [];
  if (role === "editor" || role === "reviewer")
    choices.push([tools.library, "/editor/library", "Content workflow"]);
  if (role === "reviewer") {
    choices.push([
      tools.worklist,
      "/review/worklist",
      "Your sample feedback worklist",
    ]);
    choices.push([
      tools.sampleAssignments || tools.reviewTimeGrantReference === true,
      tools.sampleAssignments
        ? "/review/sample-assignment-reference"
        : "/review/review-time-reference",
      "My reviewer reference",
    ]);
  }
  if (role === "platform_admin")
    choices.push([
      tools.console === true,
      "/operator",
      "Administration console",
    ]);
  if (role === "operator" || role === "platform_admin")
    choices.push(
      [tools.support, "/operator/support", "Your granted support requests"],
      [
        tools.supportTime,
        "/operator/support-time",
        "Your granted support test effort",
      ],
      [tools.experts, "/operator/experts", "Synthetic expert registry"],
      [
        tools.metrics,
        "/operator/metrics/report",
        "Learning and participation snapshot",
      ],
      [
        tools.ledger,
        "/operator/ledger-reconciliation",
        hostingText(
          "Synthetic accounting inspection",
          "Test-unit accounting inspection",
        ),
      ],
    );
  if (role === "operator")
    choices.push(
      [
        tools.assignments,
        "/operator/assignment-id",
        hostingText("My local assignment ID", "My assignment ID"),
      ],
      [
        tools.holds,
        "/operator/local-ai-holds",
        hostingText(
          "Your assigned local request holds",
          "Your assigned test request holds",
        ),
      ],
    );
  if (role === "moderator" || role === "platform_admin") {
    choices.push([
      tools.circleGrants,
      "/moderate/circle-reference",
      "My moderation reference",
    ]);
    choices.push([
      tools.proposals,
      "/moderate/proposals",
      "Private proposal moderation",
    ]);
    for (const circle of CIRCLES)
      choices.push([
        tools.circles,
        `/moderate/circles/${encodeURIComponent(circle.id)}/reports`,
        `${circle.title}: granted sample reports`,
      ]);
  }
  if (role === "platform_admin")
    choices.push(
      [
        tools.invoices === true,
        "/operator/invoices",
        "Course billing and invoices",
      ],
      [
        tools.invoices === true,
        "/operator/invoice-reconciliation",
        "Invoice and cash reconciliation",
      ],
      [
        tools.studyUnits === true,
        "/operator/study-test-units",
        hostingText("Issue local study test units", "Issue study test units"),
      ],
      [
        tools.eventAttendance === true,
        "/operator/event-attendance",
        "Private rehearsal attendance",
      ],
      [
        tools.eventRehearsals === true,
        "/operator/event-rehearsals",
        "Schedule a private rehearsal",
      ],
      [
        tools.eventCancellations === true,
        "/operator/event-cancellations",
        "Event cancellation",
      ],
      [
        tools.circleGrants,
        "/operator/circle-grants",
        "Circle moderation grants",
      ],
      [
        tools.reviewTimeGrants === true,
        "/operator/review-time-grants",
        "Private review-minute permissions",
      ],
      [
        tools.supportTimeGrants === true,
        "/operator/support-time-grants",
        "Private support-minute permissions",
      ],
      [
        tools.sampleAssignments,
        "/operator/sample-assignments/pending",
        "Pending feedback requests",
      ],
      [
        tools.sampleAssignments,
        "/operator/sample-assignments",
        "Private sample assignments",
      ],
      [
        tools.assignments,
        "/operator/support-assignment",
        "Support request assignments",
      ],
      [
        tools.localAi,
        "/operator/local-ai",
        hostingText("Local simulation control", "AI simulation control"),
      ],
      [
        tools.receipts,
        "/operator/test-receipts",
        "Synthetic observation register",
      ],
    );
  if (role === "platform_admin")
    choices.push([
      tools.workflowReviews === true,
      "/operator/workflow-reviews",
      "Assign private workflow review",
    ]);
  if (role === "moderator")
    choices.push([
      tools.workflowReviews === true,
      "/moderate/workflow-review-reference",
      "My private workflow review reference",
    ]);
  if (role === "moderator")
    choices.push([
      tools.workflowReviews === true,
      "/moderate/workflow-reviews",
      "My assigned private workflow reviews",
    ]);
  const available = choices.filter(([enabled]) => enabled);
  return available.length
    ? `<ul class="portal-tools">${available.map(([, url, label]) => `<li><a href="${escape(url)}" class="button secondary">${escape(label)}</a></li>`).join("")}</ul>`
    : hostingText(
        "<p>No browser tools are available for your current role in this local preview.</p>",
        "<p>No browser tools are available for your current role on this site.</p>",
      );
}
const signout = (csrf: string) =>
  `<form method="post" action="/staff/sign-out">${hidden(csrf)}<button type="submit">Sign out of staff tools</button></form>`;
function form(csrf: string) {
  const heading = hostingText(
    "Sign in to local staff tools",
    "Sign in to staff tools",
  );
  return page(
    heading,
    `<section class="reading"><p class="eyebrow">${hostingText("PRIVATE LOCAL STAFF", "PRIVATE STAFF")}</p><h1>${heading}</h1><p>Use a current ${hostingText("trusted local staff credential", "trusted staff credential")} from your protected administrator setup. Your learner access stays separate. This does not provision a role or grant private work.</p><form method="post" action="/staff/sign-in" autocomplete="off">${hidden(csrf)}<label for="credential">${hostingText("Trusted local staff credential", "Trusted staff credential")}</label><input id="credential" name="credential" type="password" maxlength="64" required autocomplete="off" spellcheck="false"><button type="submit">Sign in to staff tools</button></form><p>Expired staff access can still be cleared from this browser.</p>${signout(csrf)}<p>Signing out does not revoke the principal, its protected credential, other browsers or existing grants. Existing expiry and revocation still apply.</p><p><a href="/learn">Return to your learning space</a></p></section>`,
  );
}
export function mountStaffEntryRoutes(
  app: Express,
  store: StaffEntryStore | undefined,
  options: {
    origin: string;
    secret: string;
    mode?: ApplicationMode;
    localStaffEntry?: boolean;
  },
  tools: StaffTools,
) {
  const fail = (res: Response, status: number) =>
    res.status(status).send(
      page(
        "Staff access unavailable",
        `<section class="reading"><h1>Staff access unavailable</h1><p>This request could not establish current ${hostingText("local staff", "staff")} access. Open a fresh sign-in form. Nothing was renewed or replayed.</p>${portalActions(
          [
            ["/staff/sign-in", "Open staff sign-in"],
            ["/learn", "Your learning space"],
          ],
        )}</section>`,
      ),
    );
  const cookies = (req: Request) => ({
    staff: staffCookie(req.headers.cookie),
    nonce: uniqueCookie(req.headers.cookie, ENTRY_COOKIE),
  });
  const issueNonce = (res: Response) => {
    const nonce = entryNonce(options.secret);
    res.cookie(ENTRY_COOKIE, nonce, {
      ...COOKIE_OPTIONS,
      secure: new URL(options.origin).protocol === "https:",
      maxAge: ENTRY_LIFETIME,
    });
    return entryCsrf(nonce, options.secret);
  };
  app.use("/staff", (req, res, next) => {
    if (!options.localStaffEntry || options.mode === "live")
      return fail(res, 404);
    const values = cookies(req);
    if (
      Object.keys(req.query).length ||
      values.staff.kind === "invalid" ||
      values.nonce.kind === "invalid"
    )
      return fail(res, 403);
    next();
  });
  app.get("/staff/sign-in", (_req, res) => res.send(form(issueNonce(res))));
  function integrity(req: Request, allowed: string[]) {
    const value = cookies(req).nonce;
    return (
      value.kind === "value" &&
      req.get("origin") === options.origin &&
      req.body &&
      typeof req.body === "object" &&
      Object.entries(req.body).every(
        ([key, item]) => allowed.includes(key) && typeof item === "string",
      ) &&
      validEntry(value.value, req.body.csrf, options.secret)
    );
  }
  app.post("/staff/sign-in", async (req, res) => {
    if (
      !integrity(req, ["csrf", "credential"]) ||
      !staffCredential(req.body.credential)
    )
      return fail(res, 403);
    try {
      const result = await store?.admit(req.body.credential);
      if (!result || result.kind !== "ready")
        return fail(res, result?.kind === "denied" ? 403 : 503);
      if (
        !Number.isFinite(result.deadline) ||
        performance.now() >= result.deadline
      )
        return fail(res, 403);
      res.cookie(STAFF_COOKIE, req.body.credential, {
        ...COOKIE_OPTIONS,
        secure: new URL(options.origin).protocol === "https:",
      });
      res.clearCookie(ENTRY_COOKIE, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: new URL(options.origin).protocol === "https:",
      });
      return res.redirect(303, "/staff");
    } catch {
      return fail(res, 503);
    }
  });
  app.post("/staff/sign-out", (req, res) => {
    if (!integrity(req, ["csrf"])) return fail(res, 403);
    res.cookie(STAFF_COOKIE, SIGNED_OUT, {
      ...COOKIE_OPTIONS,
      secure: new URL(options.origin).protocol === "https:",
    });
    res.clearCookie(ENTRY_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: new URL(options.origin).protocol === "https:",
    });
    return res.redirect(303, "/staff/sign-in");
  });
  app.get("/staff", async (req, res) => {
    const selected = cookies(req).staff;
    const credential =
      selected.kind === "value" ? selected.value : req.cookies[COOKIE];
    if (!staffCredential(credential)) return fail(res, 403);
    try {
      const result = await store?.admit(credential);
      if (!result || result.kind !== "ready")
        return fail(res, result?.kind === "denied" ? 403 : 503);
      const body = page(
        hostingText("Your local staff tools", "Your staff tools"),
        `<div class="portal-page"><div class="portal-intro"><p class="eyebrow">${hostingText("PRIVATE LOCAL STAFF", "PRIVATE STAFF")}</p><h1>${hostingText("Your local staff tools", "Your staff tools")}</h1><p>Current role: ${labels()[result.role]}.</p><p>Each destination checks your current role and exact existing grants. Opening these tools grants no private work, starts no effort and allocates no test minutes. Sample activity is not qualified service.</p></div><section class="portal-card"><h2>Available tools</h2>${links(result.role, tools)}</section><section class="portal-card"><h2>Staff session</h2>${signout(issueNonce(res))}<p>Staff signout affects this browser only. Your learner access and saved progress remain.</p>${portalActions(
          [
            ["/learn", "Your learning space"],
            ["/staff/sign-in", "Use another staff credential"],
          ],
        )}</section></div>`,
      );
      if (
        !Number.isFinite(result.deadline) ||
        performance.now() >= result.deadline
      )
        return fail(res, 403);
      return res.send(body);
    } catch {
      return fail(res, 503);
    }
  });
}
