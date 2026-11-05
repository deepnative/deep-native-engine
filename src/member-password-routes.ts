import type { Express, Request, Response } from "express";
import type { Store } from "./store.ts";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  acceptablePassword,
  type MemberPasswordAccess,
} from "./member-password-access.ts";
import { COOKIE, cookieOptions } from "./session.ts";
import { escape, page } from "./views.ts";

/** The email + password form shown on the shared sign-in page. */
export function passwordSignInForm(csrf: string, error?: string) {
  return `<section class="sign-in-option" aria-labelledby="password-sign-in"><h2 id="password-sign-in">Sign in with your password</h2>${error ? `<p role="alert" class="form-error">${error}</p>` : ""}<form method="post" action="/password/sign-in"><input type="hidden" name="csrf" value="${csrf}"><label for="password-email">Email address</label><input id="password-email" name="email" type="email" autocomplete="username" maxlength="254" required><label for="password-current">Password</label><input id="password-current" name="password" type="password" autocomplete="current-password" maxlength="${PASSWORD_MAX * 4}" required><button type="submit">Sign in</button></form><p class="small">Forgot your password? Use an email link below, then set a new one from My account.</p></section>`;
}

function onlyFields(req: Request, allowed: string[]) {
  return (
    !Object.keys(req.query).length &&
    Object.keys(req.body ?? {}).every((key) => allowed.includes(key))
  );
}

function passwordForm(csrf: string, hasPassword: boolean, error?: string) {
  return `<form method="post" action="/account/password"><input type="hidden" name="csrf" value="${csrf}">${error ? `<p role="alert" class="form-error">${error}</p>` : ""}${hasPassword ? '<label for="password-old">Current password</label><input id="password-old" name="current" type="password" autocomplete="current-password" maxlength="512"><p class="small">Not needed within 30 minutes of signing in with an email link.</p>' : ""}<label for="password-new">New password</label><input id="password-new" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required aria-describedby="password-rule"><p id="password-rule" class="small">${PASSWORD_MIN} to ${PASSWORD_MAX} characters. A short phrase is easiest to remember.</p><label for="password-confirm">Confirm new password</label><input id="password-confirm" name="confirm" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required><button type="submit">${hasPassword ? "Change password" : "Set password"}</button></form>`;
}

/** SIGNUP-01: email and password for an account that has no email yet. */
function registerForm(csrf: string, error?: string, email = "") {
  return `<form method="post" action="/account/password"><input type="hidden" name="csrf" value="${csrf}">${error ? `<p role="alert" class="form-error">${error}</p>` : ""}<label for="register-email">Email address</label><input id="register-email" name="email" type="email" autocomplete="username" maxlength="254" required value="${escape(email)}"><label for="password-new">Password</label><input id="password-new" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required aria-describedby="password-rule"><p id="password-rule" class="small">${PASSWORD_MIN} to ${PASSWORD_MAX} characters. A short phrase is easiest to remember.</p><label for="password-confirm">Confirm password</label><input id="password-confirm" name="confirm" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" maxlength="${PASSWORD_MAX}" required><button type="submit">Save email and password</button></form>`;
}

function passwordPage(body: string) {
  return page(
    "Password sign-in",
    `<div class="account-page"><div class="account-intro"><p class="eyebrow">My account</p><h1>Password sign-in</h1><p>Sign in on any device with your verified email and a password. Email links keep working too.</p></div><section>${body}</section><p class="account-links"><a class="button secondary" href="/account">Back to My account</a></p></div>`,
  );
}

export function mountMemberPasswordRoutes(
  app: Express,
  store: Store,
  access: MemberPasswordAccess,
  origin: string,
  continuation?: (rawCookie: string | undefined) => string | null,
  verify?: (memberToken: string, email: string) => void,
) {
  const token = (res: Response) => res.locals.token as string;
  const csrf = (res: Response) => res.locals.csrf as string;

  async function show(
    res: Response,
    status = 200,
    error?: string,
    email?: string,
    saved?: string,
  ) {
    const state = await access.status(token(res));
    if (state === "unavailable")
      return res
        .status(503)
        .send(
          passwordPage(
            "<h2>Password sign-in is unavailable</h2><p>Try again later. Your saved work and email sign-in are unchanged.</p>",
          ),
        );
    if (state === "email_required")
      return res
        .status(status)
        .send(
          passwordPage(
            `<h2>Add a sign-in email and password</h2><p>Your email is your username. You can sign in with the password straight away; we also send a link to verify the email.</p>${registerForm(csrf(res), error, email)}`,
          ),
        );
    return res
      .status(status)
      .send(
        passwordPage(
          `<h2>${state === "set" ? "Password set" : "Choose a password"}</h2>${saved ? `<p role="status">${saved}</p>` : ""}${state === "set" ? "<p>You can sign in with your verified email and this password. Change it below.</p>" : ""}${passwordForm(csrf(res), state === "set", error)}`,
        ),
      );
  }

  app.get("/account/password", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).length)
      return res.redirect(303, "/account/password");
    const session = await store.session(token(res));
    if (session.kind !== "active") return res.redirect(303, "/email/sign-in");
    return show(res);
  });

  app.post("/account/password", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!onlyFields(req, ["csrf", "email", "current", "password", "confirm"]))
      return res
        .status(400)
        .send(passwordPage("<h2>Open the password form again</h2>"));
    const session = await store.session(token(res));
    if (session.kind !== "active") return res.redirect(303, "/email/sign-in");
    const fields = (req.body ?? {}) as Record<string, unknown>;
    const password = fields.password;
    if (!acceptablePassword(password) || password !== fields.confirm)
      return show(
        res,
        422,
        acceptablePassword(password)
          ? "The two passwords do not match."
          : `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
      );
    if (fields.email !== undefined) {
      const address = String(fields.email);
      const kept = address.length <= 254 ? address : "";
      const registered = await access
        .register(token(res), address, password)
        .catch(() => "unavailable" as const);
      if (registered === "saved") {
        verify?.(token(res), address);
        return show(res);
      }
      if (registered === "taken")
        return show(
          res,
          409,
          "This email is already used for sign-in. Use another email, or sign in to that account.",
          kept,
        );
      if (registered === "invalid")
        return show(res, 422, "Enter a valid email address.", kept);
      return show(res, 503);
    }
    const current =
      typeof fields.current === "string" ? fields.current : undefined;
    const result = await access
      .setPassword(token(res), password, current)
      .catch(() => "unavailable" as const);
    if (result === "saved")
      return show(
        res,
        200,
        undefined,
        undefined,
        "Password saved. Other browsers were signed out.",
      );
    if (result === "email_required")
      return show(res, 409, "Add a sign-in email with your password.");
    if (result === "current_required" || result === "current_incorrect")
      return show(
        res,
        403,
        result === "current_required"
          ? "Enter your current password, or sign in with an email link to reset it."
          : "Your current password is not correct.",
      );
    if (result === "invalid")
      return show(
        res,
        422,
        `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
      );
    return show(res, 503);
  });

  app.post("/password/sign-in", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const retry = (status: number, message: string) =>
      res
        .status(status)
        .send(
          page(
            "Sign in",
            `<section class="sign-in-page"><h1>Sign in</h1>${passwordSignInForm(csrf(res), message)}<p><a href="/email/sign-in">Email me a sign-in link instead</a></p></section>`,
          ),
        );
    if (!onlyFields(req, ["csrf", "email", "password"]))
      return retry(400, "Open the sign-in form again.");
    const result = await access
      .signIn(String(req.body?.email ?? ""), String(req.body?.password ?? ""))
      .catch(() => undefined);
    if (!result)
      return retry(
        503,
        "Sign-in is unavailable right now. Your saved work is unchanged.",
      );
    if (result.kind === "limited")
      return retry(
        429,
        "Too many attempts for this email. Wait 15 minutes, or use an email sign-in link.",
      );
    if (result.kind !== "signed_in")
      return retry(401, "Email or password is incorrect.");
    res.cookie(COOKIE, result.token, cookieOptions(origin));
    return res.redirect(303, continuation?.(req.headers.cookie) ?? "/learn");
  });
}
