# Email and password sign-in

Members can return to their saved work with their **verified email and a password**, alongside the one-use email link ([#627](https://github.com/deepnative/deep-native-engine/issues/627)). The username is the member's email. Since [#637](https://github.com/deepnative/deep-native-engine/issues/637) (owner request, 3 November 2026), new members sign up with email and password and can sign in immediately; the email is verified later. This replaces the first rule that a password needed a verified email.

## Sign up

Where password sign-in is offered (the hosted engine), the start form asks for an email and a password with the profile. The account opens at once and the member lands on Learning. A verification link is sent in the background, so a slow provider never delays sign-up. **My account** shows **Email not yet verified** until the link is opened; the member can still sign in with email and password, sign out without an access-loss warning, and request a new verification link. Features that already need a verified email (such as owner administrator entry) wait for verification. An email already used for sign-in by another account is refused with a prompt to sign in instead.

If someone else signs up with your address, verifying it from your own account wins: your address becomes verified and the other account's unverified claim is removed. An email sign-in link also works for an unverified address, which both resets a forgotten password and verifies the email.

Members who started without an email (earlier browser-only accounts) can add an email and password from **My account → Password sign-in**.

## Member journey (existing accounts)

1. In **My account**, link and verify an email (existing flow).
2. Choose **Password sign-in**, enter a password of 12–128 characters twice and choose **Set password**.
3. On the sign-in page (**Sign in** in the header when signed out), enter the email and password. A correct pair opens the same saved work for 30 days and retires any earlier browser token, exactly like an email link.
4. **Forgot password:** use **Send sign-in link** on the same page. Within 30 minutes of that email sign-in, **Password sign-in** accepts a new password without the forgotten one. Otherwise changing a password needs the current one.

Signing out keeps the password. Deleting the account removes it.

## Protections

- Only a salted scrypt hash (N=32768, r=8, p=1) is stored; the password never appears in logs, pages or exports.
- Wrong password, unknown email, malformed email and unverified accounts all get the same "Email or password is incorrect" answer, and an unknown email still costs one hash check.
- Five failed attempts for one email within 15 minutes refuse further attempts for that email, even with the right password, until the window passes. Failures are keyed by email hash whether or not an account exists, so the limit reveals nothing.
- Password sign-in is offered wherever hosted email sign-in is configured.

## Evidence

Tests: PWD-01–05 in `tests/unit/member-password-access.test.ts`, SIGNUP-01–05 in `tests/unit/member-signup.test.ts`, and route fakes in `tests/unit/member-password-routes.test.ts`. Browser: L285 and L286 (`tests/e2e/member-password.spec.ts`) on desktop and mobile Chromium. Not covered: MFA, breached-password screening, per-IP limits.
