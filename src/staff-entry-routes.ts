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
import { adminMenuFor } from "./administration-presentation.ts";
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
  /** #845: administrator diagnostics are available here. */
  diagnostics?: boolean;
  circles: boolean;
  circleGrants: boolean;
  eventCancellations?: boolean;
  eventAttendance?: boolean;
  studyUnits?: boolean;
  eventRehearsals?: boolean;
  workflowReviews?: boolean;
  invoices?: boolean;
  /** #123 AGREE: the course agreement outcomes report is available here. */
  agreements?: boolean;
  /** #123 CAP: the staff capacity report is available here. */
  capacity?: boolean;
  recordAccess?: boolean;
  /** #27 STAFFCANCEL: staff cancellation of sample holds is available here. */
  sampleHolds?: boolean;
  /** #193 MYTIME: a staff member's own booked time is available here. */
  myTime?: boolean;
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
const RECORDS = "Download a student's records (with their permission)";
/**
 * #845: the administrator's "More" page. Students, Invoices, Roles and
 * History are in the menu, so they are not repeated here. HIDE-01: circle
 * report pages need a per-circle grant this page cannot see, so they are
 * not offered to administrators.
 */
function moreTools(tools: StaffTools) {
  const groups: Array<[string, Array<[boolean, string, string]>]> = [
    [
      "Reports",
      [
        [
          tools.invoices === true,
          "/operator/coaching",
          "Coaching hours by month",
        ],
        [
          tools.invoices === true,
          "/operator/invoice-reconciliation",
          "Invoice and cash reconciliation",
        ],
        [
          tools.agreements === true,
          "/operator/course-agreements",
          "Course agreement outcomes",
        ],
        [tools.capacity === true, "/operator/staff-capacity", "Staff capacity"],
        [tools.capacity === true, "/operator/delivery-cost", "Delivery cost"],
        [
          tools.metrics,
          "/operator/metrics/report",
          "Learning and participation snapshot",
        ],
        [tools.diagnostics === true, "/operator/diagnostics", "Diagnostics"],
      ],
    ],
    [
      "Support and reviews",
      [
        [tools.support, "/operator/support", "Your granted support requests"],
        [
          tools.assignments,
          "/operator/support-assignment",
          "Support request assignments",
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
          tools.workflowReviews === true,
          "/operator/workflow-reviews",
          "Assign private workflow review",
        ],
        [tools.proposals, "/moderate/proposals", "Private proposal moderation"],
        [tools.recordAccess === true, "/operator/member-records", RECORDS],
      ],
    ],
    [
      "Permissions",
      [
        [
          tools.circleGrants,
          "/operator/circle-grants",
          "Circle moderation grants",
        ],
        [
          tools.circleGrants,
          "/moderate/circle-reference",
          "My moderation reference",
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
      ],
    ],
    [
      "Events",
      [
        [
          tools.eventRehearsals === true,
          "/operator/event-rehearsals",
          "Schedule a private rehearsal",
        ],
        [
          tools.eventAttendance === true,
          "/operator/event-attendance",
          "Private rehearsal attendance",
        ],
        [
          tools.eventCancellations === true,
          "/operator/event-cancellations",
          "Event cancellation",
        ],
      ],
    ],
    [
      "Test and simulation tools",
      [
        [
          tools.supportTime,
          "/operator/support-time",
          "Your granted support test effort",
        ],
        [tools.experts, "/operator/experts", "Synthetic expert registry"],
        [
          tools.sampleHolds === true,
          "/operator/sample-holds",
          "Staff sample holds",
        ],
        [
          tools.ledger,
          "/operator/ledger-reconciliation",
          hostingText(
            "Synthetic accounting inspection",
            "Test-unit accounting inspection",
          ),
        ],
        [
          tools.studyUnits === true,
          "/operator/study-test-units",
          hostingText("Issue local study test units", "Issue study test units"),
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
      ],
    ],
  ];
  return (
    groups
      .map(([title, choices]) => {
        const available = choices.filter(([enabled]) => enabled);
        return available.length
          ? `<section class="admin-section"><h2>${title}</h2><ul class="more-tools">${available.map(([, url, label]) => `<li><a href="${escape(url)}">${escape(label)}</a></li>`).join("")}</ul></section>`
          : "";
      })
      .join("") || "<p>No other tools are switched on for this site.</p>"
  );
}
function links(role: StaffRole, tools: StaffTools) {
  const choices: [boolean, string, string][] = [];
  // #193: roster records name a coach or a reviewer, so only they get the link.
  if (role === "coach" || role === "reviewer")
    choices.push([tools.myTime === true, "/review/my-time", "My booked time"]);
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
  if (role === "operator")
    choices.push(
      [tools.support, "/operator/support", "Your granted support requests"],
      [
        tools.supportTime,
        "/operator/support-time",
        "Your granted support test effort",
      ],
      [tools.experts, "/operator/experts", "Synthetic expert registry"],
      [tools.capacity === true, "/operator/staff-capacity", "Staff capacity"],
      [tools.capacity === true, "/operator/delivery-cost", "Delivery cost"],
      [tools.recordAccess === true, "/operator/member-records", RECORDS],
      [
        tools.sampleHolds === true,
        "/operator/sample-holds",
        "Staff sample holds",
      ],
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
  if (role === "moderator") {
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
      const session = `${signout(issueNonce(res))}<p>Staff signout affects this browser only. Your learning account and saved progress remain.</p>${portalActions(
        [
          ["/learn", "Your learning space"],
          ["/staff/sign-in", "Use another staff credential"],
        ],
      )}`;
      const body =
        result.role === "platform_admin"
          ? page(
              "More tools",
              `<div class="portal-page">${adminMenuFor(res, "more")}<h1>More tools</h1>${moreTools(tools)}<section class="admin-section"><h2>Staff session</h2>${session}</section></div>`,
            )
          : page(
              hostingText("Your local staff tools", "Your staff tools"),
              `<div class="portal-page"><div class="portal-intro"><p class="eyebrow">${hostingText("PRIVATE LOCAL STAFF", "PRIVATE STAFF")}</p><h1>${hostingText("Your local staff tools", "Your staff tools")}</h1><p>Current role: ${labels()[result.role]}.</p><p>Each destination checks your current role and exact existing grants. Opening these tools grants no private work, starts no effort and allocates no test minutes. Sample activity is not qualified service.</p></div><section class="portal-card"><h2>Available tools</h2>${links(result.role, tools)}</section><section class="portal-card"><h2>Staff session</h2>${session}</section></div>`,
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
