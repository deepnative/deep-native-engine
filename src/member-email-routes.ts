import type { Express } from "express";
import type { Store } from "./store.ts";
import type { MemberEmailAccess } from "./member-email-access.ts";
import { COOKIE, cookieOptions } from "./session.ts";
import { page } from "./views.ts";

function form(action: string, csrf: string, button: string) {
  return `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required><button type="submit">${button}</button></form>`;
}

function linkedPage() {
  return page(
    "Email already linked",
    '<section class="error-page"><h1>Email already linked</h1><p>An email is already linked to this learning record. No new verification message is needed.</p><p>To return to this same saved work in another browser or on another device, open the email sign-in page there and enter your linked address.</p><p><a href="/email/sign-in">Email sign-in</a></p><p><a href="/learn">Return to learning</a></p></section>',
  );
}

export function mountMemberEmailRoutes(
  app: Express,
  store: Store,
  access: MemberEmailAccess | undefined,
  origin: string,
) {
  app.post("/account/sign-out", async (req, res) => {
    if (
      Object.keys(req.body ?? {}).some((key) => key !== "csrf") ||
      Object.keys(req.query).length
    )
      return res
        .status(400)
        .send(
          page(
            "Sign-out unavailable",
            '<section class="error-page"><h1>Sign-out unavailable</h1><p>Open My account and use its sign-out form.</p></section>',
          ),
        );
    if (!access)
      return res
        .status(503)
        .send(
          page(
            "Email recovery unavailable",
            '<section class="error-page"><h1>Email recovery unavailable</h1><p>Keep this browser’s access. Email recovery cannot be checked right now.</p><p><a href="/account">My account</a></p></section>',
          ),
        );
    let result: Awaited<ReturnType<MemberEmailAccess["signOut"]>>;
    try {
      result = await access.signOut(res.locals.token as string);
    } catch {
      return res
        .status(503)
        .send(
          page(
            "Sign-out could not be confirmed",
            '<section class="error-page"><h1>Sign-out could not be confirmed</h1><p>The result is uncertain. Do not resend this form. Open My account to check access, or deliberately request an email sign-in link to return to your saved work.</p><p><a href="/account">Check My account</a> · <a href="/email/sign-in">Email sign-in</a></p></section>',
          ),
        );
    }
    if (result !== "signed_out")
      return res
        .status(409)
        .send(
          page(
            "Sign-out unavailable",
            `<section class="error-page"><h1>Sign-out unavailable</h1><p>${result === "recovery_required" ? "Link and verify an email before signing out. Your current access is unchanged." : "Current account access could not be verified. Open My account to check access, or use email sign-in."}</p><p><a href="/account">My account</a> · <a href="/email/attach">Link an email</a> · <a href="/email/sign-in">Email sign-in</a></p></section>`,
          ),
        );
    res.clearCookie(COOKIE, cookieOptions(origin));
    return res.send(
      page(
        "Signed out",
        '<section class="error-page"><h1>Signed out</h1><p>Your saved work is still in your account. This access token, including any copied browser cookies, no longer opens it. No email was sent.</p><p><a href="/email/sign-in">Sign back in by email</a></p></section>',
      ),
    );
  });
  let pendingRequests = 0;
  function dispatch(request: () => Promise<unknown>) {
    // Acknowledgement must not wait for an account lookup or mail delivery:
    // either delay would reveal whether an address belongs to a member.
    if (pendingRequests >= 32) return;
    pendingRequests++;
    setImmediate(() => {
      void Promise.resolve()
        .then(request)
        .catch(() => {
          process.stderr.write(
            "Member email request could not be confirmed.\n",
          );
        })
        .finally(() => {
          pendingRequests--;
        });
    });
  }
  app.get("/email/sign-in", (_req, res) => {
    res.cookie(COOKIE, res.locals.token as string, cookieOptions(origin));
    res.send(
      page(
        "Return to your learning",
        `<section class="error-page"><h1>Return to your learning</h1><p>Enter the email you previously linked to this learning record. A private sign-in link expires after 15 minutes.</p>${access ? form("/email/sign-in", res.locals.csrf as string, "Send sign-in link") : "<p>Email sign-in is unavailable on this preview.</p>"}<p><a href="/">Start a new learning path</a></p></section>`,
      ),
    );
  });
  app.post("/email/sign-in", async (req, res) => {
    if (!access)
      return res
        .status(503)
        .send(
          page(
            "Email unavailable",
            '<section class="error-page"><h1>Email unavailable</h1><p>Try again later. Your saved work is unchanged.</p></section>',
          ),
        );
    const address = String(req.body.email ?? "");
    dispatch(() => access.requestSignIn(address));
    return res.send(
      page(
        "Check your email",
        '<section class="error-page"><h1>Check your email</h1><p>If this address is linked to a learning record, a private sign-in link will arrive shortly. Check your inbox and spam folder. Repeating this request will not send another message while a link is pending. Use that link within 15 minutes; if it has not arrived, wait 15 minutes before requesting again.</p></section>',
      ),
    );
  });
  app.get("/email/attach", async (_req, res) => {
    const session = await store.session(res.locals.token as string);
    if (session.kind !== "active") return res.redirect(303, "/email/sign-in");
    const status = access
      ? await access.ownedStatus(res.locals.token as string)
      : "unavailable";
    if (status === "unavailable")
      return res
        .status(503)
        .send(
          page(
            "Email unavailable",
            '<section class="error-page"><h1>Email unavailable</h1><p>Try again later. Your saved work is unchanged.</p></section>',
          ),
        );
    if (status === "linked") return res.send(linkedPage());
    return res.send(
      page(
        "Keep access to your learning",
        `<section class="error-page"><h1>Keep access to your learning</h1><p>Link an email address to this existing learning record. Verify the link we send before this address can be used to sign in on another device.</p>${form("/email/attach", res.locals.csrf as string, "Send verification link")}<p><a href="/learn">Return to learning</a></p></section>`,
      ),
    );
  });
  app.post("/email/attach", async (req, res) => {
    const session = await store.session(res.locals.token as string);
    if (session.kind !== "active")
      return res
        .status(401)
        .send(
          page(
            "Session expired",
            '<section class="error-page"><h1>Session expired</h1><p>Reopen your learning path before linking an email.</p></section>',
          ),
        );
    const status = access
      ? await access.ownedStatus(res.locals.token as string)
      : "unavailable";
    if (status === "unavailable")
      return res
        .status(503)
        .send(
          page(
            "Email unavailable",
            '<section class="error-page"><h1>Email unavailable</h1><p>Try again later. Your saved work is unchanged.</p></section>',
          ),
        );
    if (status === "linked") return res.send(linkedPage());
    const memberToken = res.locals.token as string;
    const address = String(req.body.email ?? "");
    dispatch(() => access!.requestAttach(memberToken, address));
    return res.send(
      page(
        "Check your email",
        '<section class="error-page"><h1>Check your email</h1><p>If this address can be linked, a private verification link will arrive shortly. Check your inbox and spam folder. Repeating this request will not send another message while a link is pending. Use that link within 15 minutes; if it has not arrived, wait 15 minutes before requesting again. Your saved work is unchanged until you confirm the link.</p></section>',
      ),
    );
  });
  app.get("/email/confirm", (req, res) => {
    res.set("Referrer-Policy", "origin");
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!access || !/^[a-f0-9]{64}$/.test(code))
      return res
        .status(404)
        .send(
          page(
            "Link unavailable",
            '<section class="error-page"><h1>Link unavailable</h1><p>Request a fresh email link.</p></section>',
          ),
        );
    return res.send(
      page(
        "Confirm email link",
        `<section class="error-page"><h1>Confirm email link</h1><p>Continue to connect your email or return to your saved learning. This link can be used once.</p><form method="post" action="/email/confirm"><input type="hidden" name="code" value="${code}"><button type="submit">Continue</button></form></section>`,
      ),
    );
  });
  app.post("/email/confirm", async (req, res) => {
    res.set("Referrer-Policy", "origin");
    if (!access)
      return res
        .status(404)
        .send(
          page(
            "Link unavailable",
            '<section class="error-page"><h1>Link unavailable</h1><p>Request a fresh email link.</p></section>',
          ),
        );
    const result = await access.consume(
      String(req.body.code ?? ""),
      res.locals.token as string,
    );
    if (result.kind === "unavailable")
      return res
        .status(409)
        .send(
          page(
            "Link unavailable",
            '<section class="error-page"><h1>Link unavailable</h1><p>This link was used or expired. Request a fresh email link.</p></section>',
          ),
        );
    if (result.kind === "signed_in") {
      res.cookie(COOKIE, result.token!, cookieOptions(origin));
      return res.redirect(303, "/learn");
    }
    return res.send(
      page(
        "Email linked",
        '<section class="error-page"><h1>Email linked</h1><p>You can now request a sign-in link from another device.</p><p><a href="/learn">Return to learning</a></p></section>',
      ),
    );
  });
}
