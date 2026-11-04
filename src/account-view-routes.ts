import express, { type Express, type Request, type Response } from "express";
import type { AdministratorEntry } from "./administrator-entry.ts";
import { withAdministration } from "./administration-presentation.ts";
import {
  accountRole,
  chooseView,
  landingPath,
  VIEW_COOKIE,
  withAccountView,
  type AccountRole,
} from "./account-view.ts";
import { COOKIE, cookieOptions, csrf, validCsrf } from "./session.ts";
import { uniqueCookie } from "./staff-entry-selection.ts";
import { page } from "./views.ts";

const YEAR = 365 * 24 * 3600 * 1000;

function cookie(req: Request, name: string) {
  const value = uniqueCookie(req.headers.cookie, name);
  return value.kind === "value" ? value.value : undefined;
}
function memberToken(req: Request) {
  const value = cookie(req, COOKIE);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : "";
}

/**
 * #673 Reads the signed-in account's roles once per request, so the header
 * shows its current view and the switch. Mount after static assets so
 * signed-out pages and assets cost no query. Views grant no authority:
 * every route still authorizes on its own.
 */
export function mountAccountViews(
  app: Express,
  store: Pick<AdministratorEntry, "accountRoles"> | undefined,
  options: {
    origin: string;
    secret: string;
    localStaffEntry?: boolean;
  },
  mode?: string,
) {
  const lookup = store?.accountRoles?.bind(store);
  if (!options.localStaffEntry || mode === "live" || !lookup) return;
  // One lookup per request, shared by the header and these routes.
  const roles = (res: Response): Promise<AccountRole[]> =>
    (res.locals.accountRoles as Promise<AccountRole[]> | undefined) ??
    Promise.resolve([]);

  app.use((req, res, next) => {
    const token = memberToken(req);
    if (!token) return next();
    const held = Promise.resolve().then(() => lookup(token));
    res.locals.accountRoles = held;
    held
      .catch(() => [] as AccountRole[])
      .then((held) => {
        if (!held.length) return next();
        const view = chooseView(held, cookie(req, VIEW_COOKIE));
        withAdministration(held.includes("admin"), () =>
          withAccountView(
            { roles: held, view, csrf: csrf(token, options.secret) },
            next,
          ),
        );
      })
      .catch(next);
  });

  // ROLES-02: sign-in lands here, then on the page of the account's view.
  app.get("/home", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const held = Object.keys(req.query).length
      ? []
      : await roles(res).catch(() => [] as AccountRole[]);
    res.redirect(
      303,
      held.length
        ? landingPath(chooseView(held, cookie(req, VIEW_COOKIE)))
        : "/learn",
    );
  });

  const refuse = (res: Response, status: number, title: string, text: string) =>
    res
      .status(status)
      .send(
        page(
          title,
          `<section class="reading"><h1>${title}</h1><p>${text}</p><p><a href="/learn">Learning</a> · <a href="/account">My account</a></p></section>`,
        ),
      );

  // ROLES-03/05/07: saves the chosen view; it changes what is shown only.
  app.post(
    "/account/view",
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      const token = memberToken(req);
      const body: unknown = req.body;
      if (
        !token ||
        req.get("origin") !== options.origin ||
        Object.keys(req.query).length ||
        !body ||
        typeof body !== "object" ||
        Object.keys(body).some((key) => key !== "csrf" && key !== "view") ||
        !accountRole((body as { view?: unknown }).view) ||
        !validCsrf((body as { csrf?: unknown }).csrf, token, options.secret)
      )
        return refuse(
          res,
          403,
          "This view is not available",
          "Open the page again and choose a view from the header.",
        );
      const view = (body as { view: AccountRole }).view;
      let held: AccountRole[];
      try {
        held = await roles(res);
      } catch {
        return refuse(
          res,
          503,
          "Views are unavailable",
          "Try again shortly. Your saved work is unchanged.",
        );
      }
      if (!held.includes(view))
        return refuse(
          res,
          403,
          "This view is not available",
          "Your account does not have this role. Your saved work is unchanged.",
        );
      res.cookie(VIEW_COOKIE, view, {
        ...cookieOptions(options.origin),
        maxAge: YEAR,
      });
      res.redirect(303, landingPath(view));
    },
  );
}
