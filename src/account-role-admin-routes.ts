import type { Express, Request, Response } from "express";
import {
  GRANTED_ROLES,
  type AccountRoleAdmin,
  type ChangeResult,
  type LearnerCoachResult,
} from "./account-role-admin.ts";
import { portalActions } from "./backend-portal-presentation.ts";
import { csrf, validCsrf } from "./session.ts";
import { escape, page } from "./views.ts";

const ROLE_LABEL = { coach: "Coach", admin: "Admin" } as const;
const REFUSALS = {
  denied: [
    403,
    "Roles unavailable",
    "Enter administration from an admin account to manage roles. Nothing was changed.",
  ],
  invalid: [
    400,
    "Roles unchanged",
    "Check the email and choose at least one role, or choose a coach who still holds the coach role. Nothing was changed.",
  ],
  "not-found": [
    404,
    "Roles unchanged",
    "That person or role is no longer there. Open the page again to see the current roles.",
  ],
  self: [
    409,
    "Your admin role stays",
    "You cannot remove your own admin role, so the site always keeps an administrator. Ask another administrator to remove it.",
  ],
  unavailable: [
    503,
    "Roles unavailable",
    "Try again shortly. Nothing was changed.",
  ],
} as const;
type Kind = keyof typeof REFUSALS;

function refuse(res: Response, kind: Kind) {
  const [status, title, text] = REFUSALS[kind];
  return res.status(status).send(
    page(
      title,
      `<section class="reading"><h1>${title}</h1><p>${text}</p>${portalActions([
        ["/operator/roles", "Roles"],
        ["/operator", "Administration console"],
      ])}</section>`,
    ),
  );
}

/** COACHLINK-01: the coach control on the selected learner's console card. */
export function coachAssignmentCard(
  result: LearnerCoachResult,
  learnerId: string,
  anti: string,
) {
  if (result.kind !== "ready")
    return '<section class="portal-card" aria-labelledby="learner-coach"><h2 id="learner-coach">Coach</h2><p role="status">Coach assignment is unavailable right now.</p></section>';
  const { coach, coaches } = result.value;
  const options = [
    `<option value=""${coach ? "" : " selected"}>No coach</option>`,
    ...coaches.map(
      (c) =>
        `<option value="${c.emailHash}"${c.emailHash === coach ? " selected" : ""}>${escape(c.label)}</option>`,
    ),
  ].join("");
  return `<section class="portal-card" aria-labelledby="learner-coach"><h2 id="learner-coach">Coach</h2><p>The assigned coach sees this learner's monthly hours on their Coaching page. ${coaches.length ? "" : 'Nobody holds the coach role yet. Grant it on <a href="/operator/roles">Roles</a>.'}</p><form class="portal-search" method="post" action="/operator/coach-assignments"><input type="hidden" name="csrf" value="${anti}"><input type="hidden" name="learnerId" value="${escape(learnerId)}"><label for="learner-coach-choice">Coach for this learner</label><div><select id="learner-coach-choice" name="coach">${options}</select><button type="submit">Save coach</button></div></form></section>`;
}

/**
 * #684 ROLEADMIN-01..05 and COACHLINK-01: administrators manage coach and
 * admin roles and assign coaches. Mounted after the shared staff-session,
 * origin and CSRF checks; the store re-checks the administrator session.
 */
export function mountAccountRoleAdmin(
  app: Express,
  store: AccountRoleAdmin | undefined,
  options: { origin: string; secret: string },
) {
  if (!store) return;
  const token = (res: Response) => res.locals.token as string;
  // Only these fields, each a single string, and the same-origin CSRF token.
  function valid(req: Request, res: Response, fields: string[]) {
    res.set("Cache-Control", "no-store");
    const body: unknown = req.body;
    return (
      !Object.keys(req.query).length &&
      req.get("origin") === options.origin &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.entries(body).every(
        ([key, value]) =>
          typeof value === "string" && ["csrf", ...fields].includes(key),
      ) &&
      validCsrf((body as { csrf?: unknown }).csrf, token(res), options.secret)
    );
  }
  const done = (res: Response, result: ChangeResult, to: string) =>
    result.kind === "ready" ? res.redirect(303, to) : refuse(res, result.kind);

  app.get("/operator/roles", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length) return refuse(res, "denied");
    const result = await store.roles(token(res));
    if (result.kind !== "ready") return refuse(res, result.kind);
    const anti = csrf(token(res), options.secret);
    const hidden = (name: string, value: string) =>
      `<input type="hidden" name="${name}" value="${escape(value)}">`;
    const rows = result.value.holders
      .map((h) => {
        const who = h.people.length
          ? h.people
              .map(
                (p) =>
                  `${escape(p.name ?? "Name needed")} <span class="small">· <code>${escape(p.id)}</code></span>`,
              )
              .join("<br>")
          : '<span class="small">Email not linked to an account yet</span>';
        const roles = h.roles
          .map((role) =>
            h.self && role === "admin"
              ? `<li>${ROLE_LABEL[role]} <span class="small">(you)</span></li>`
              : `<li><form method="post" action="/operator/roles/remove">${hidden("csrf", anti)}${hidden("emailHash", h.emailHash)}${hidden("role", role)}${ROLE_LABEL[role]} <button class="secondary" type="submit" aria-label="Remove ${ROLE_LABEL[role].toLowerCase()} role from ${escape(h.people[0] ? (h.people[0].name ?? "Name needed") : "this email")}">Remove</button></form></li>`,
          )
          .join("");
        return `<tr><td>${who}</td><td><ul class="role-list">${roles}</ul></td></tr>`;
      })
      .join("");
    res.send(
      page(
        "Roles",
        `<section class="portal-workspace role-admin"><h1>Roles</h1><p>Everyone is a student. Coaches see the monthly hours of learners assigned to them. Admins can enter administration. Roles follow a verified email; only its fingerprint is stored, never the address.</p><section class="portal-card" aria-labelledby="grant-role"><h2 id="grant-role">Give a role</h2><form method="post" action="/operator/roles/grant">${hidden("csrf", anti)}<label for="grant-email">Verified email</label><input id="grant-email" name="email" type="email" maxlength="254" autocomplete="off" required><fieldset><legend>Roles</legend>${GRANTED_ROLES.map((role) => `<label class="check"><input type="checkbox" name="${role}" value="yes"><span>${ROLE_LABEL[role]}</span></label>`).join("")}</fieldset><p class="small">The role takes effect when the person signs in with this email. They can sign up later.</p><button type="submit">Give role</button></form></section><section class="portal-card" aria-labelledby="role-holders"><h2 id="role-holders">People with roles</h2>${rows ? `<div class="table-scroll" tabindex="0" role="region" aria-label="People with roles"><table class="member-table role-holders"><thead><tr><th scope="col">Person</th><th scope="col">Roles</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p role="status">Nobody holds a coach or admin role.</p>'}</section>${portalActions(
          [
            ["/operator", "Administration console"],
            ["/admin", "Administration"],
          ],
        )}</section>`,
      ),
    );
  });

  app.post("/operator/roles/grant", async (req, res) => {
    if (!valid(req, res, ["email", ...GRANTED_ROLES]))
      return refuse(res, "denied");
    const body = req.body as Record<string, string>;
    if (
      GRANTED_ROLES.some(
        (role) => body[role] !== undefined && body[role] !== "yes",
      )
    )
      return refuse(res, "invalid");
    const result = await store.grant(token(res), {
      email: body.email ?? "",
      roles: GRANTED_ROLES.filter((role) => body[role] === "yes"),
    });
    return done(res, result, "/operator/roles");
  });

  app.post("/operator/roles/remove", async (req, res) => {
    if (!valid(req, res, ["emailHash", "role"])) return refuse(res, "denied");
    const body = req.body as Record<string, string>;
    const result = await store.remove(token(res), {
      emailHash: body.emailHash ?? "",
      role: body.role as (typeof GRANTED_ROLES)[number],
    });
    return done(res, result, "/operator/roles");
  });

  app.post("/operator/coach-assignments", async (req, res) => {
    if (!valid(req, res, ["learnerId", "coach"])) return refuse(res, "denied");
    const body = req.body as Record<string, string>;
    if (body.coach === undefined) return refuse(res, "invalid");
    const learnerId = body.learnerId ?? "";
    const result = await store.assignCoach(token(res), {
      learnerId,
      coach: body.coach ? body.coach : null,
    });
    return done(
      res,
      result,
      `/operator?ownerId=${encodeURIComponent(learnerId)}#learner-coach`,
    );
  });
}
