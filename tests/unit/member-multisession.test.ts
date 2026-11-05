import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import { app } from "../../src/app.ts";
import { administratorEntry } from "../../src/administrator-entry.ts";
import { emailHash, memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";

// #695 MULTISESSION: each browser keeps its own sign-in. A private database
// per file, like member-signup.test.ts.
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
const secret = "synthetic-multisession-secret";
const delivered: { address: string; link: string }[] = [];
const email = memberEmailAccess(
  pool,
  {
    async send(address, link) {
      delivered.push({ address, link });
    },
  },
  origin,
);
const passwords = memberPasswordAccess(pool);
const entry = administratorEntry(pool);
const staffConsole = async (credential: string) =>
  entry.console ? entry.console(credential) : { kind: "absent" as const };
const application = app(members, {
  origin,
  secret,
  memberEmail: email,
  memberPassword: passwords,
});
const PASSWORD = "synthetic multisession 58";
const ADDRESS = "devices@example.com";

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
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function issuedToken(response: request.Response) {
  const found = [response.headers["set-cookie"] ?? []]
    .flat()
    .join(";")
    .match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
  if (!found) throw Error("No sign-in cookie was issued");
  return found;
}
async function signedIn(token: string) {
  const learn = await get("/learn", token);
  return learn.status === 200;
}
async function signUp() {
  const token = visitor();
  const started = await post(
    "/start",
    {
      display_name: "Device Learner",
      background: "explorer",
      goal: "everyday",
      signup_email: ADDRESS,
      signup_password: PASSWORD,
    },
    token,
  );
  expect(started.status).toBe(303);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  return token;
}
async function passwordSignIn() {
  const response = await post(
    "/password/sign-in",
    { email: ADDRESS, password: PASSWORD },
    visitor(),
  );
  expect(response.status).toBe(303);
  return issuedToken(response);
}
async function emailSignIn() {
  const before = delivered.length;
  const requested = await post("/email/sign-in", { email: ADDRESS }, visitor());
  expect(requested.status).toBe(200);
  await vi.waitFor(() => expect(delivered.length).toBe(before + 1));
  const code = new URL(delivered.at(-1)!.link).searchParams.get("code")!;
  const response = await post("/email/confirm", { code }, visitor());
  expect(response.status).toBe(303);
  return issuedToken(response);
}

it("MULTISESSION-01 a third sign-in keeps the first two browsers signed in", async () => {
  const first = await signUp();
  const second = await passwordSignIn();
  const third = await emailSignIn();
  expect(new Set([first, second, third]).size).toBe(3);
  expect(await signedIn(first)).toBe(true);
  expect(await signedIn(second)).toBe(true);
  expect(await signedIn(third)).toBe(true);
  // All three open the same account.
  const ids = await Promise.all(
    [first, second, third].map(async (token) => {
      const session = await members.session(token);
      return session.kind === "active" ? session.learner.id : session.kind;
    }),
  );
  expect(new Set(ids).size).toBe(1);
  // No cookie is stored; only each browser's own fingerprint.
  const sessions = await pool.query<{ token_hash: string }>(
    "SELECT token_hash FROM member_sessions",
  );
  expect(sessions.rows.map((r) => r.token_hash).sort()).toEqual(
    [first, second, third].map(sha256).sort(),
  );
  const principal = await pool.query<{ token_hash: string }>(
    "SELECT token_hash FROM principals WHERE kind='member'",
  );
  expect([first, second, third].map(sha256)).not.toContain(
    principal.rows[0]!.token_hash,
  );
});

it("MULTISESSION-02 signing out ends only this browser and says so", async () => {
  const first = await signUp();
  const second = await passwordSignIn();
  const page = await get("/account/sign-out", second);
  expect(page.text).toContain(
    "This signs out this browser only, including any copies of its sign-in cookie.",
  );
  expect(page.text).not.toContain("invalidates copies");
  const out = await post("/account/sign-out", {}, second);
  expect(out.status).toBe(200);
  expect(out.text).toContain("You signed out in this browser.");
  expect(out.text).toContain(
    "Other browsers where you signed in stay signed in.",
  );
  expect(await signedIn(second)).toBe(false);
  expect(await signedIn(first)).toBe(true);
  // A copy of the signed-out cookie never comes back.
  expect((await members.session(second)).kind).not.toBe("active");
  const again = await post("/account/sign-out", {}, first);
  expect(again.text).toContain("You signed out in this browser.");
  expect(await signedIn(first)).toBe(false);
  expect((await pool.query("SELECT 1 FROM member_sessions")).rowCount).toBe(0);
  // Signing back in still works after every browser signed out.
  expect(await signedIn(await passwordSignIn())).toBe(true);
});

it("MULTISESSION-03 deleting the account ends every browser", async () => {
  const first = await signUp();
  const second = await passwordSignIn();
  const third = await emailSignIn();
  const deleted = await post("/delete", { confirm: "yes" }, second);
  expect(deleted.status).toBe(303);
  for (const token of [first, second, third])
    expect(await signedIn(token)).toBe(false);
  expect((await pool.query("SELECT 1 FROM member_sessions")).rowCount).toBe(0);
});

it("MULTISESSION-03 a password change signs out the other browsers", async () => {
  const first = await signUp();
  const second = await passwordSignIn();
  const third = await emailSignIn();
  const changed = await post(
    "/account/password",
    {
      current: PASSWORD,
      password: "synthetic replacement 77",
      confirm: "synthetic replacement 77",
    },
    second,
  );
  expect(changed.status).toBe(200);
  expect(changed.text).toContain("Other browsers were signed out.");
  expect(await signedIn(second)).toBe(true);
  expect(await signedIn(first)).toBe(false);
  expect(await signedIn(third)).toBe(false);
});

it("MULTISESSION-04 an email-link password reset stays tied to the browser that used the link", async () => {
  const first = await signUp();
  const linked = await emailSignIn();
  // The other browser cannot use the link's reset window.
  expect(await passwords.setPassword(first, "synthetic replacement 88")).toBe(
    "current_required",
  );
  expect(await passwords.setPassword(linked, "synthetic replacement 88")).toBe(
    "saved",
  );
  expect(await signedIn(linked)).toBe(true);
  expect(await signedIn(first)).toBe(false);
});

it("MULTISESSION-05 administration follows the browser that entered it", async () => {
  const first = await signUp();
  const code = new URL(delivered[0]!.link).searchParams.get("code")!;
  expect((await post("/email/confirm", { code }, first)).status).toBe(200);
  await pool.query(
    "INSERT INTO account_roles(email_hash,role) VALUES($1,'admin')",
    [emailHash(ADDRESS)],
  );
  const entered = await entry.enter(first);
  if (entered.kind !== "ready" || !entered.credential)
    throw Error("Administrator entry unavailable");
  const credential = entered.credential;
  expect((await staffConsole(credential)).kind).toBe("ready");

  // Another browser signing in, entering and leaving keeps this one.
  const second = await passwordSignIn();
  const other = await entry.enter(second);
  expect(other.kind).toBe("ready");
  expect((await staffConsole(credential)).kind).toBe("ready");
  expect((await post("/account/sign-out", {}, second)).status).toBe(200);
  expect((await staffConsole(credential)).kind).toBe("ready");
  if (other.kind === "ready" && other.credential)
    expect((await staffConsole(other.credential)).kind).toBe("denied");

  // Signing out the browser that entered ends its administration too.
  expect((await post("/account/sign-out", {}, first)).status).toBe(200);
  expect((await staffConsole(credential)).kind).toBe("denied");
});

it("MULTISESSION-06 cookies issued before this change keep working after the migration", async () => {
  const first = await signUp();
  const id = (
    await pool.query<{ id: string }>(
      "SELECT id FROM principals WHERE kind='member'",
    )
  ).rows[0]!.id;
  // The shape before migration 099: the member row holds one browser's hash.
  await pool.query("DELETE FROM schema_migrations WHERE version=99");
  await pool.query("DELETE FROM member_sessions");
  await pool.query(
    "UPDATE principals SET token_hash=$2,separate_sessions=false WHERE id=$1",
    [id, sha256(first)],
  );
  await pool.query("UPDATE learners SET token_hash=$2 WHERE id=$1", [
    id,
    sha256(first),
  ]);
  expect(await signedIn(first)).toBe(true);
  await migrate(pool);
  expect(await signedIn(first)).toBe(true);
  const after = await pool.query<{ token_hash: string; separate: boolean }>(
    "SELECT token_hash,separate_sessions AS separate FROM principals WHERE id=$1",
    [id],
  );
  expect(after.rows[0]!.separate).toBe(true);
  expect(after.rows[0]!.token_hash).not.toBe(sha256(first));
  const second = await passwordSignIn();
  expect(await signedIn(first)).toBe(true);
  expect(await signedIn(second)).toBe(true);
  // Running the migration again changes nothing, even for an account that
  // some other path left with one browser's hash.
  const third = visitor();
  await members.create(third, { background: "explorer", goal: "everyday" });
  await pool.query(
    "INSERT INTO member_email_identities(email_hash,principal_id) SELECT $1,id FROM principals WHERE token_hash=$2",
    [emailHash("direct@example.com"), sha256(third)],
  );
  await migrate(pool);
  expect(
    (
      await pool.query(
        "SELECT separate_sessions AS separate FROM principals WHERE token_hash=$1",
        [sha256(third)],
      )
    ).rows[0]?.separate,
  ).toBe(false);
  expect(await signedIn(first)).toBe(true);
  expect(await signedIn(second)).toBe(true);
});

it("MULTISESSION-07 a browser session ends on its own date", async () => {
  const first = await signUp();
  const second = await passwordSignIn();
  await pool.query(
    "UPDATE member_sessions SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE token_hash=$1",
    [sha256(second)],
  );
  expect(await signedIn(second)).toBe(false);
  expect(await signedIn(first)).toBe(true);
});
