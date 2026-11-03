import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { Pool } from "pg";
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
const secret = "synthetic-password-sign-in-secret";
const delivered: string[] = [];
const email = memberEmailAccess(
  pool,
  {
    async send(_address, link) {
      delivered.push(link);
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
const PASSWORD = "synthetic correct horse 42";

// #105: bind the owned test server to 127.0.0.1 so another lane cannot answer.
let server: Server;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
  server = await listenLoopback(application);
});
beforeEach(async () => {
  delivered.length = 0;
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("TRUNCATE member_password_failures");
});
afterAll(async () => {
  await closeLoopback(server);
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});

async function member(address?: string) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  if (address) {
    await email.requestAttach(token, address);
    const code = new URL(delivered.at(-1)!).searchParams.get("code")!;
    expect((await email.consume(code, token)).kind).toBe("attached");
  }
  return { token, id: session.learner.id };
}
function post(path: string, value: Record<string, string>, cookie?: string) {
  const token = cookie ?? "f".repeat(64);
  return request(server)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .type("form")
    .send({ ...value, csrf: csrf(token, secret) });
}
function issuedToken(response: request.Response) {
  const cookies = [response.headers["set-cookie"] ?? []].flat();
  return cookies.join(";").match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
}

it("PWD-01 lets only a verified member set a hashed password from My account", async () => {
  const unverified = await member();
  const blocked = await request(server)
    .get("/account/password")
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${unverified.token}`);
  expect(blocked.text).toContain("Link and verify an email first");
  expect(blocked.text).not.toContain('name="password"');
  expect(
    (
      await post(
        "/account/password",
        { password: PASSWORD, confirm: PASSWORD },
        unverified.token,
      )
    ).status,
  ).toBe(409);

  const owner = await member("owner@example.com");
  const form = await request(server)
    .get("/account/password")
    .set("Host", "127.0.0.1:3000")
    .set("Cookie", `${COOKIE}=${owner.token}`);
  expect(form.status).toBe(200);
  expect(form.text).toContain('autocomplete="new-password"');
  for (const [password, confirm] of [
    ["too short", "too short"],
    [PASSWORD, `${PASSWORD}!`],
    ["x".repeat(129), "x".repeat(129)],
  ]) {
    const refused = await post(
      "/account/password",
      { password: password!, confirm: confirm! },
      owner.token,
    );
    expect(refused.status).toBe(422);
    expect(refused.text).not.toContain(password!);
  }
  const saved = await post(
    "/account/password",
    { password: PASSWORD, confirm: PASSWORD },
    owner.token,
  );
  expect(saved.status).toBe(200);
  expect(saved.text).toContain("Password set");
  const { rows } = await pool.query<{ password_hash: string }>(
    "SELECT password_hash FROM member_passwords WHERE principal_id=$1",
    [owner.id],
  );
  expect(rows[0]?.password_hash).toMatch(/^scrypt\$/);
  expect(rows[0]?.password_hash).not.toContain(PASSWORD);
  expect(await passwords.status(owner.token)).toBe("set");
});

it("PWD-02 signs in with email and password, rotating to one new session for the same work", async () => {
  const owner = await member("owner@example.com");
  await members.save(owner.token, {
    revision: 0,
    instruction: "Synthetic password plan",
    verification: "Synthetic evidence",
    complete: false,
  });
  expect(await passwords.setPassword(owner.token, PASSWORD)).toBe("saved");
  const page = await request(server)
    .get("/email/sign-in")
    .set("Host", "127.0.0.1:3000");
  expect(page.text).toContain('action="/password/sign-in"');
  expect(page.text).toContain('autocomplete="current-password"');
  const signedIn = await post("/password/sign-in", {
    email: " OWNER@example.com ",
    password: PASSWORD,
  });
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.location).toBe("/learn");
  const next = issuedToken(signedIn);
  expect(next).toBeDefined();
  expect((await members.session(owner.token)).kind).not.toBe("active");
  expect(await members.session(next!)).toMatchObject({
    kind: "active",
    learner: { id: owner.id },
  });
  expect(await members.progress(owner.id)).toMatchObject({
    instruction: "Synthetic password plan",
  });
});

it("PWD-03 refuses wrong, unknown and unverified sign-ins with one generic answer", async () => {
  const owner = await member("owner@example.com");
  expect(await passwords.setPassword(owner.token, PASSWORD)).toBe("saved");
  const unverified = await member();
  for (const value of [
    { email: "owner@example.com", password: "wrong synthetic password" },
    { email: "nobody@example.com", password: PASSWORD },
    { email: "not an email", password: PASSWORD },
    { email: "owner@example.com", password: "" },
  ]) {
    const refused = await post("/password/sign-in", value);
    expect(refused.status).toBe(401);
    expect(refused.text).toContain("Email or password is incorrect");
    expect(issuedToken(refused)).toBeUndefined();
  }
  expect(await members.session(owner.token)).toMatchObject({
    kind: "active",
  });
  expect(await passwords.status(unverified.token)).toBe("email_required");
  expect(
    (
      await post("/password/sign-in", {
        email: "owner@example.com",
        password: PASSWORD,
        extra: "field",
      })
    ).status,
  ).toBe(400);
});

it("PWD-04 refuses further attempts for an email after five failures in 15 minutes", async () => {
  const owner = await member("owner@example.com");
  expect(await passwords.setPassword(owner.token, PASSWORD)).toBe("saved");
  for (let attempt = 0; attempt < 5; attempt++)
    expect(
      (await passwords.signIn("owner@example.com", "wrong synthetic password"))
        .kind,
    ).toBe("refused");
  const limited = await post("/password/sign-in", {
    email: "owner@example.com",
    password: PASSWORD,
  });
  expect(limited.status).toBe(429);
  expect(limited.text).toContain("Too many attempts");
  expect(issuedToken(limited)).toBeUndefined();
  expect(await members.session(owner.token)).toMatchObject({
    kind: "active",
  });
  await pool.query(
    "UPDATE member_password_failures SET failed_at=failed_at-INTERVAL '16 minutes'",
  );
  expect((await passwords.signIn("owner@example.com", PASSWORD)).kind).toBe(
    "signed_in",
  );
});

it("PWD-05 needs the current password to change it, except just after an email-link sign-in", async () => {
  const owner = await member("owner@example.com");
  expect(await passwords.setPassword(owner.token, PASSWORD)).toBe("saved");
  const replacement = "synthetic replacement phrase 7";
  expect(await passwords.setPassword(owner.token, replacement)).toBe(
    "current_required",
  );
  expect(
    await passwords.setPassword(owner.token, replacement, "wrong current"),
  ).toBe("current_incorrect");
  expect(await passwords.setPassword(owner.token, replacement, PASSWORD)).toBe(
    "saved",
  );
  expect((await passwords.signIn("owner@example.com", PASSWORD)).kind).toBe(
    "refused",
  );

  // Forgot password: an email link signs in, then a new password needs no current one.
  await email.requestSignIn("owner@example.com");
  const code = new URL(delivered.at(-1)!).searchParams.get("code")!;
  const viaEmail = await email.consume(code);
  expect(viaEmail.kind).toBe("signed_in");
  const reset = "synthetic forgotten reset 99";
  expect(await passwords.setPassword(viaEmail.token!, reset)).toBe("saved");
  expect(await passwords.setPassword(viaEmail.token!, PASSWORD)).toBe(
    "current_required",
  );
  const signedIn = await passwords.signIn("owner@example.com", reset);
  expect(signedIn.kind).toBe("signed_in");
  const fresh = signedIn.kind === "signed_in" ? signedIn.token : "";

  // Signing out keeps the password; deleting the account removes it.
  await post("/account/sign-out", {}, fresh);
  expect((await passwords.signIn("owner@example.com", reset)).kind).toBe(
    "signed_in",
  );
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect((await pool.query("SELECT 1 FROM member_passwords")).rowCount).toBe(0);
});
