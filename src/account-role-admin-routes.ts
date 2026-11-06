import type { Express, Request, Response } from "express";
import {
  GRANTED_ROLES,
  type AccountRoleAdmin,
  type ChangeResult,
  type LearnerCoachResult,
} from "./account-role-admin.ts";
import { portalActions } from "./backend-portal-presentation.ts";
import { csrf, validCsrf } from "./session.ts";
import { changeHistoryBody } from "./staff-change-history.ts";
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

/** COACHLINK-01 / #689 DEFCOACH-04: the coaches control on the selected learner's console card. */
export function coachAssignmentCard(
  result: LearnerCoachResult,
  learnerId: string,
  anti: string,
) {
  if (result.kind !== "ready")
    return '<section class="portal-card" aria-labelledby="learner-coach"><h2 id="learner-coach">Coaches</h2><p role="status">Coach assignment is unavailable right now.</p></section>';
  const { assigned, coaches } = result.value;
  const choices = coaches
    .map(
      (c) =>
        `<label class="check"><input type="checkbox" name="coach" value="${c.emailHash}"${assigned.includes(c.emailHash) ? " checked" : ""}><span>${escape(c.label)}</span></label>`,
    )
    .join("");
  return `<section class="portal-card" aria-labelledby="learner-coach"><h2 id="learner-coach">Coaches</h2><p>Each coach ticked here sees this learner's monthly hours on their Coaching page. New learners start with the default coaches.</p>${
    coaches.length
      ? `<form class="coach-choices" method="post" action="/operator/coach-assignments"><input type="hidden" name="csrf" value="${anti}"><input type="hidden" name="learnerId" value="${escape(learnerId)}"><fieldset><legend>Coaches for this learner</legend>${choices}</fieldset><button type="submit">Save coaches</button></form>`
      : '<p role="status">Nobody holds the coach role yet. Grant it on <a href="/operator/roles">Roles</a>.</p>'
  }</section>`;
}

/**
 * #684 ROLEADMIN-01..05 and COACHLINK-01: administrators manage coach and
 * admin roles and set each learner's coaches (#689). Mounted after the shared staff-session,
 * origin and CSRF checks; the store re-checks the administrator session.
 */
export function mountAccountRoleAdmin(
  app: Express,
  store: AccountRoleAdmin | undefined,
  options: { origin: string; secret: string },
) {
  if (!store) return;
  const token = (res: Response) => res.locals.token as string;
  // Only these fields, each a single string (or a list for `lists`), and the
  // same-origin CSRF token.
  function valid(
    req: Request,
    res: Response,
    fields: string[],
    lists: string[] = [],
  ) {
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
          (typeof value === "string" ||
            (lists.includes(key) &&
              Array.isArray(value) &&
              value.every((v) => typeof v === "string"))) &&
          ["csrf", ...fields].includes(key),
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
            ["/operator/changes", "Change history"],
            ["/operator", "Administration console"],
            ["/admin", "Administration"],
          ],
        )}</section>`,
      ),
    );
  });

  // CHANGELOG-01/11/12: read-only; the store re-checks the administrator session.
  app.get("/operator/changes", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { before, ...rest } = req.query;
    const result =
      Object.keys(rest).length ||
      (before !== undefined && typeof before !== "string")
        ? ({ kind: "invalid" } as const)
        : await store.changes(token(res), before);
    if (result.kind === "ready")
      return res.send(
        page(
          "Change history",
          changeHistoryBody(result.value, before === undefined),
        ),
      );
    const [status, title, text] = {
      denied: [
        403,
        "Change history unavailable",
        "Enter administration from an admin account to read the change history.",
      ],
      invalid: [
        400,
        "That link doesn't work",
        "Open the change history again from its first page.",
      ],
      unavailable: [
        503,
        "Change history unavailable",
        "It can't be read right now, so this doesn't mean nothing changed. Try again shortly.",
      ],
    }[result.kind] as [number, string, string];
    return res.status(status).send(
      page(
        title,
        `<section class="reading"><h1>${title}</h1><p>${text}</p>${portalActions(
          [
            ["/operator/changes", "Change history"],
            ["/operator", "Administration console"],
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
    if (!valid(req, res, ["learnerId", "coach"], ["coach"]))
      return refuse(res, "denied");
    const body = req.body as Record<string, string | string[]>;
    const learnerId = typeof body.learnerId === "string" ? body.learnerId : "";
    // No ticked box sends no `coach` field: the learner keeps no coach.
    const coaches = body.coach === undefined ? [] : [body.coach].flat();
    const result = await store.setCoaches(token(res), { learnerId, coaches });
    return done(
      res,
      result,
      `/operator?ownerId=${encodeURIComponent(learnerId)}#learner-coach`,
    );
  });
}
