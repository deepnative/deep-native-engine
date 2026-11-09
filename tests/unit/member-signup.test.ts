import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";

// A private database per file, like member-email-access.test.ts.
const root = new URL(
  process.env.DNE_DATABASE_URL ??
    "postgresql://dne:local-preview-only@127.0.0.1:54329/dne_dev",
);
const name = `dne_test_${randomBytes(16).toString("hex")}`;
const admin = new Pool({
  connectionString: root.toString(),
  connectionTimeoutMillis: 3000,
});
const scoped = new URL(root);
scoped.pathname = `/${name}`;
const pool = new Pool({
  connectionString: scoped.toString(),
  connectionTimeoutMillis: 3000,
});
const members = store(pool);
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-signup-secret";
const delivered: { address: string; link: string }[] = [];
let releaseDelivery: (() => void) | undefined;
const email = memberEmailAccess(
  pool,
  {
    async send(address, link) {
      // Delivery can be slow; sign-up must not wait for it.
      if (releaseDelivery === undefined)
        await new Promise<void>((resolve) => (releaseDelivery = resolve));
      delivered.push({ address, link });
    },
  },
  origin,
);
const passwords = memberPasswordAccess(pool);
const application = app(members, {
  origin,
  secret,
  memberEmail: email,
  memberPassword: passwords,
});
const PASSWORD = "synthetic signup phrase 31";
const profile = {
  display_name: "Signup Learner",
  background: "explorer",
  goal: "everyday",
  signup_country: "CA",
};

let server: Server;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
  server = await listenLoopback(application);
});
beforeEach(async () => {
  delivered.length = 0;
  releaseDelivery = undefined;
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("TRUNCATE member_password_failures");
});
afterAll(async () => {
  releaseDelivery?.();
  await closeLoopback(server);
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});

function post(path: string, value: Record<string, string>, token: string) {
  return request(server)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ ...value, csrf: csrf(token, secret) });
}
function get(path: string, token: string) {
  return request(server)
    .get(path)
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${token}`);
}
const visitor = () => randomBytes(32).toString("hex");
function issuedToken(response: request.Response) {
  return [response.headers["set-cookie"] ?? []]
    .flat()
    .join(";")
    .match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
}
const code = (index = -1) =>
  new URL(delivered.at(index)!.link).searchParams.get("code")!;

it("SIGNUP-01/02 opens the account at once, verifies later and signs back in by password", async () => {
  const welcome = await get("/", visitor());
  expect(welcome.text).toContain('name="signup_email"');
  expect(welcome.text).toContain('autocomplete="new-password"');

  const token = visitor();
  const started = await post(
    "/start",
    {
      ...profile,
      signup_email: " New@Example.com ",
      signup_password: PASSWORD,
    },
    token,
  );
  // The response does not wait for the slow email provider.
  expect(started.status).toBe(303);
  expect(started.headers.location).toBe("/learn");
  const session = await members.session(token);
  expect(session.kind).toBe("active");
  expect(await passwords.status(token)).toBe("set");

  const account = await get("/account", token);
  expect(account.text).toContain("Email not yet verified");
  expect(account.text).toContain('href="/email/attach"');

  releaseDelivery!();
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  expect(delivered[0]!.address).toBe("new@example.com");

  // Signing out needs no access-loss acknowledgement: the password returns.
  const out = await post("/account/sign-out", {}, token);
  expect(out.text).toContain("Signed out");
  const back = await post(
    "/password/sign-in",
    { email: "new@example.com", password: PASSWORD },
    visitor(),
  );
  expect(back.status).toBe(303);
  const next = issuedToken(back)!;
  expect(await members.session(next)).toMatchObject({
    kind: "active",
    learner: { id: session.kind === "active" ? session.learner.id : "" },
  });

  // The earlier verification link still verifies the same account.
  expect((await email.consume(code(), next)).kind).toBe("attached");
  expect((await get("/account", next)).text).toContain("Verified email linked");
  expect((await passwords.signIn("new@example.com", PASSWORD)).kind).toBe(
    "signed_in",
  );
});

it("SIGNUP-03/05 refuses a taken email or invalid sign-in fields and creates nothing", async () => {
  releaseDelivery = () => {};
  const first = visitor();
  await post(
    "/start",
    {
      ...profile,
      signup_email: "taken@example.com",
      signup_password: PASSWORD,
    },
    first,
  );
  const count = async () =>
    Number(
      (await pool.query<{ n: string }>("SELECT count(*) AS n FROM principals"))
        .rows[0]!.n,
    );
  expect(await count()).toBe(1);
  for (const [fields, message] of [
    [
      { signup_email: "TAKEN@example.com", signup_password: PASSWORD },
      "already used for sign-in",
    ],
    [
      { signup_email: "not an email", signup_password: PASSWORD },
      "Enter a valid email address",
    ],
    [
      { signup_email: "fresh@example.com", signup_password: "short" },
      "12 to 128 characters",
    ],
    [{ signup_password: PASSWORD }, "Enter a valid email address"],
  ] as const) {
    const refused = await post("/start", { ...profile, ...fields }, visitor());
    expect(refused.status).toBe(422);
    expect(refused.text).toContain(message);
    expect(refused.text).toContain('value="Signup Learner"');
    expect(refused.text).not.toContain(PASSWORD);
    expect(refused.text).not.toContain('value="short"');
  }
  expect(await count()).toBe(1);
});

it("SIGNUP-04 lets the verified owner of an address win over an unverified claim", async () => {
  releaseDelivery = () => {};
  const squatter = visitor();
  await post(
    "/start",
    {
      ...profile,
      signup_email: "owner@example.com",
      signup_password: PASSWORD,
    },
    squatter,
  );
  // Wait for the background verification email before counting new ones.
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  delivered.length = 0;
  // The real owner, on another account, verifies the same address.
  const realToken = visitor();
  await members.create(realToken, { background: "explorer", goal: "work" });
  expect(await email.requestAttach(realToken, "owner@example.com")).toBe(
    "sent",
  );
  expect((await email.consume(code(), realToken)).kind).toBe("attached");
  expect((await passwords.signIn("owner@example.com", PASSWORD)).kind).toBe(
    "refused",
  );
  expect(await passwords.status(squatter)).toBe("email_required");
  delivered.length = 0;

  // An unverified member who forgets the password resets through an email link.
  const forgetful = visitor();
  await post(
    "/start",
    {
      ...profile,
      signup_email: "forgot@example.com",
      signup_password: PASSWORD,
    },
    forgetful,
  );
  // Wait for the background verification email before counting new ones.
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  delivered.length = 0;
  await email.requestSignIn("forgot@example.com");
  expect(delivered).toHaveLength(1);
  const viaLink = await email.consume(code());
  expect(viaLink.kind).toBe("signed_in");
  expect(
    await passwords.setPassword(viaLink.token!, "synthetic reset phrase 44"),
  ).toBe("saved");
  expect((await get("/account", viaLink.token!)).text).toContain(
    "Verified email linked",
  );
});

it("SIGNUP-01 lets an existing browser-only member add an email and password", async () => {
  releaseDelivery = () => {};
  const token = visitor();
  await members.create(token, { background: "explorer", goal: "everyday" });
  const page = await get("/account/password", token);
  expect(page.text).toContain('name="email"');
  const saved = await post(
    "/account/password",
    { email: "later@example.com", password: PASSWORD, confirm: PASSWORD },
    token,
  );
  expect(saved.status).toBe(200);
  expect(saved.text).toContain("Password set");
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  expect((await passwords.signIn("later@example.com", PASSWORD)).kind).toBe(
    "signed_in",
  );
});

it("SIGNUP-03 refuses registration for a taken, invalid or unavailable account", async () => {
  releaseDelivery = () => {};
  const first = visitor();
  await members.create(first, { background: "explorer", goal: "everyday" });
  expect(await passwords.register(first, "one@example.com", PASSWORD)).toBe(
    "saved",
  );
  // An account that already has a sign-in email cannot register another.
  expect(await passwords.register(first, "two@example.com", PASSWORD)).toBe(
    "unavailable",
  );
  const second = visitor();
  await members.create(second, { background: "explorer", goal: "everyday" });
  expect(await passwords.register(second, "ONE@example.com", PASSWORD)).toBe(
    "taken",
  );
  expect(await passwords.register(second, "not an email", PASSWORD)).toBe(
    "invalid",
  );
  expect(await passwords.register(second, "ok@example.com", "short")).toBe(
    "invalid",
  );
  expect(await passwords.emailAvailable("not an email")).toBe(false);
  expect(await passwords.emailAvailable("one@example.com")).toBe(false);
  expect(await passwords.emailAvailable("free@example.com")).toBe(true);
});

it("CREATEACCT-02 names the start form's sign-in fields as creating an account", async () => {
  const welcome = await get("/", visitor());
  expect(welcome.text).toContain(
    '<fieldset class="signup-fields"><legend>Create your account</legend>',
  );
  // SIGNUPCOPY-01: the form never says an email is optional above its email field.
  expect(welcome.text).not.toContain("No email is needed");
  expect(welcome.text).toContain(
    "Your email is your username. You are signed in as soon as you press Start my learning path, and you can sign in with your password from then on. We send a link to verify the email in the background.",
  );
  expect(welcome.text).toContain(
    '<a class="button landing-start" href="#your-path">Start my learning path</a>',
  );
});

// #12 D01/D02: Deep Native Inc., Ontario, Canada; Canada first.
it("MARKET-01 hosted signup asks where the person lives, with no preselected answer, and names the operator", async () => {
  const page = await get("/", visitor());
  expect(page.text).toContain(
    '<label for="signup_country">Country where you live</label>',
  );
  expect(page.text).toMatch(
    /<select id="signup_country" name="signup_country" required[^>]*><option value="" selected>Choose a country<\/option><option value="CA">Canada<\/option><option value="other">Another country<\/option><\/select>/,
  );
  expect(page.text).toContain(
    "Deep Native Engine is operated by Deep Native Inc. in Ontario, Canada, and is offered to people living in Canada for now.",
  );
  // #12 TERMS-04: the demo terms sit beside the operator statement.
  expect(page.text).toContain(
    'for now. <a href="/terms">Terms and privacy for this demo</a> (not legally reviewed).</p>',
  );
});

it("MARKET-02/03 only people living in Canada can open an account, and nothing is saved or looked up otherwise", async () => {
  const lookups = vi.spyOn(passwords, "emailAvailable");
  for (const country of ["other", "", "US", "ca", "CA "]) {
    const refused = await post(
      "/start",
      {
        ...profile,
        signup_country: country,
        signup_email: "elsewhere@example.com",
        signup_password: PASSWORD,
      },
      visitor(),
    );
    expect(refused.status).toBe(422);
    expect(refused.text).toContain(
      "Country where you live: Deep Native Engine is only offered to people living in Canada for now. Nothing was saved.",
    );
    expect(refused.text).toContain('aria-invalid="true"');
    expect(refused.text).not.toContain(PASSWORD);
  }
  const { signup_country: _omitted, ...withoutCountry } = profile;
  void _omitted;
  const missing = await post(
    "/start",
    {
      ...withoutCountry,
      signup_email: "missing@example.com",
      signup_password: PASSWORD,
    },
    visitor(),
  );
  expect(missing.status).toBe(422);
  expect(lookups).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM principals")).rows[0]!.n,
  ).toBe(0);
  lookups.mockRestore();

  // Canada opens the account as before; the answer itself is not stored.
  releaseDelivery = () => {};
  const token = visitor();
  const started = await post(
    "/start",
    {
      ...profile,
      signup_email: "canada@example.com",
      signup_password: PASSWORD,
    },
    token,
  );
  expect(started.status).toBe(303);
  expect((await members.session(token)).kind).toBe("active");
  const kept = await post(
    "/start",
    {
      ...profile,
      signup_country: "other",
      signup_email: "x@example.com",
      signup_password: PASSWORD,
    },
    visitor(),
  );
  expect(kept.text).toContain(
    '<option value="other" selected>Another country</option>',
  );
});
