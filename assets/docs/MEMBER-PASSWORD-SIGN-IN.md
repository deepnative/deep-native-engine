# Email and password sign-in

Members can return to their saved work with their **verified email and a password**, alongside the one-use email link ([#627](https://github.com/deepnative/deep-native-engine/issues/627)). Owner decisions (3 November 2026): the username is the verified email, and a password can be set only after that email is verified.

## Member journey

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

Integration: PWD-01–05 in `tests/integration/member-password-access.test.ts`. Browser: L285 (`tests/e2e/member-password.spec.ts`) on desktop and mobile Chromium. Not covered: MFA, breached-password screening, per-IP limits.
