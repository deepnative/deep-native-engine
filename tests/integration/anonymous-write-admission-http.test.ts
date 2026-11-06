import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import request from "supertest";
import { closeLoopback, listenLoopback } from "../support/loopback-server.ts";
import {
  ANONYMOUS_WRITE_LIMITS,
  anonymousWriteAdmissionStore,
  anonymousWriteSubject,
  type AnonymousWriteLimits,
} from "../../src/anonymous-write-admission.ts";
import { app } from "../../src/app.ts";
import { memberEmailAccess } from "../../src/member-email-access.ts";
import { memberPasswordAccess } from "../../src/member-password-access.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { migrate, store } from "../../src/store.ts";
import { visitorAddress } from "../../src/visitor-address.ts";

// #728: a private database per file, like member-signup.test.ts, because these
// tests read every account and every counter row.
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
const origin = "http://127.0.0.1:3000";
const secret = "synthetic-anonymous-write-secret";
const PASSWORD = "synthetic signup phrase 31";
// Small allowances keep real scrypt work short; the shipped values are in the
// unit test and the limits document.
const limits: AnonymousWriteLimits = {
  ...ANONYMOUS_WRITE_LIMITS,
  signup: { windowSeconds: 3600, perVisitor: 3, service: 5 },
  password_sign_in: { windowSeconds: 900, perVisitor: 3, service: 5 },
};
const delivered: string[] = [];
const passwords = memberPasswordAccess(pool);
const anonymousWrites = () =>
  anonymousWriteAdmissionStore(pool, { secret, publicOnly: false }, limits);
const application = (writes = anonymousWrites()) =>
  app(store(pool), {
    origin,
    secret,
    memberEmail: memberEmailAccess(
      pool,
      { send: async (address) => void delivered.push(address) },
      origin,
    ),
    memberPassword: passwords,
    anonymousWrites: writes,
  });

let server: Server;
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await migrate(pool);
  server = await listenLoopback(application());
  // Migrating a whole new database takes longer than the default under a full gate.
}, 120_000);
beforeEach(async () => {
  delivered.length = 0;
  vi.restoreAllMocks();
  await pool.query(
    "TRUNCATE principals,member_password_failures,anonymous_write_windows CASCADE",
  );
});
afterAll(async () => {
  await closeLoopback(server);
  await pool.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}, 60_000);

function post(
  path: string,
  form: Record<string, string>,
  forwardedFor: string,
  target = server,
) {
  const token = randomBytes(32).toString("hex");
  return request(target)
    .post(path)
    .set("Host", "127.0.0.1:3000")
    .set("Origin", origin)
    .set("Cookie", `${COOKIE}=${token}`)
    .set("X-Forwarded-For", forwardedFor)
    .type("form")
    .send({ ...form, csrf: csrf(token, secret) });
}
const signup = (email: string, forwardedFor: string, target = server) =>
  post(
    "/start",
    {
      display_name: "Invented Learner",
      background: "explorer",
      goal: "everyday",
      signup_email: email,
      signup_password: PASSWORD,
    },
    forwardedFor,
    target,
  );
const signIn = (email: string, password: string, forwardedFor: string) =>
  post("/password/sign-in", { email, password }, forwardedFor);
const accounts = async () =>
  (
    await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM principals WHERE kind='member'",
    )
  ).rows[0]!.n;
const counted = async (kind: string, address: string) =>
  (
    await pool.query<{ admitted: number }>(
      "SELECT admitted FROM anonymous_write_windows WHERE kind=$1 AND subject=$2",
      [
        kind,
        anonymousWriteSubject(secret, visitorAddress("127.0.0.1", address)),
      ],
    )
  ).rows[0]?.admitted ?? 0;

it("ANON-01 refuses signup past the visitor allowance before any work and keeps what was typed", async () => {
  const lookups = vi.spyOn(passwords, "emailAvailable");
  for (let i = 0; i < 3; i++)
    expect(
      (await signup(`first-${i}@example.invalid`, "203.0.113.10")).status,
    ).toBe(303);
  await vi.waitFor(() => expect(delivered).toHaveLength(3));
  expect(lookups).toHaveBeenCalledTimes(3);

  const refused = await signup("typed-kept@example.invalid", "203.0.113.10");
  expect(refused.status).toBe(429);
  expect(refused.headers["cache-control"]).toBe("no-store");
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.text).toContain(
    "Too many new accounts have been started from this network.",
  );
  expect(refused.text).toContain('value="Invented Learner"');
  expect(refused.text).toContain("typed-kept@example.invalid");
  expect(refused.text).not.toContain(PASSWORD);
  expect(await accounts()).toBe(3);
  expect(lookups).toHaveBeenCalledTimes(3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(delivered).toHaveLength(3);

  // Someone else on another address is unaffected.
  expect(
    (await signup("neighbour@example.invalid", "203.0.113.11")).status,
  ).toBe(303);
});

it("ANON-01 bounds asking whether an address is registered", async () => {
  expect((await signup("taken@example.invalid", "203.0.113.20")).status).toBe(
    303,
  );
  const first = await signup("taken@example.invalid", "203.0.113.20");
  expect(first.status).toBe(422);
  expect(first.text).toContain("this email is already used");
  expect((await signup("taken@example.invalid", "203.0.113.20")).status).toBe(
    422,
  );
  const refused = await signup("taken@example.invalid", "203.0.113.20");
  expect(refused.status).toBe(429);
  expect(refused.text).not.toContain("this email is already used");
});

it("ANON-02 refuses rotated sign-ins before lookup or scrypt, and another visitor still signs in", async () => {
  expect((await signup("owner@example.invalid", "203.0.113.30")).status).toBe(
    303,
  );
  const attempts = vi.spyOn(passwords, "signIn");
  for (let i = 0; i < 3; i++)
    expect(
      (
        await signIn(
          `guess-${i}@example.invalid`,
          "wrong phrase",
          "203.0.113.31",
        )
      ).status,
    ).toBe(401);
  expect(attempts).toHaveBeenCalledTimes(3);

  const refused = await signIn(
    "owner@example.invalid",
    PASSWORD,
    "203.0.113.31",
  );
  expect(refused.status).toBe(429);
  expect(refused.headers["cache-control"]).toBe("no-store");
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  expect(refused.text).toContain("Too many sign-in attempts from this network");
  expect(refused.text).toContain('href="/email/sign-in"');
  expect(refused.headers["set-cookie"] ?? []).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^dne.*[a-f0-9]{64}/)]),
  );
  expect(attempts).toHaveBeenCalledTimes(3);

  const owner = await signIn("owner@example.invalid", PASSWORD, "203.0.113.32");
  expect(owner.status).toBe(303);
});

it("ANON-03 holds the whole-service ceiling without charging the refused visitor", async () => {
  for (let i = 0; i < 5; i++)
    expect(
      (await signup(`many-${i}@example.invalid`, `203.0.113.${40 + i}`)).status,
    ).toBe(303);
  const refused = await signup("late@example.invalid", "203.0.113.50");
  expect(refused.status).toBe(429);
  expect(refused.text).toContain("New accounts are busy right now.");
  expect(await accounts()).toBe(5);
  expect(await counted("signup", "203.0.113.50")).toBe(0);
  expect(await counted("signup", "203.0.113.40")).toBe(1);
  // Sign-ins have their own ceiling; the signup count doesn't use it up.
  expect(
    (await signIn("nobody@example.invalid", "wrong phrase", "203.0.113.50"))
      .status,
  ).toBe(401);
});

it("ANON-04 counts only the address our ingress vouches for, and a /64 as one visitor", async () => {
  for (let i = 0; i < 3; i++)
    expect(
      (
        await signIn(
          `spoof-${i}@example.invalid`,
          "wrong phrase",
          `198.51.100.${i}, 203.0.113.60`,
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await signIn(
        "spoof@example.invalid",
        "wrong phrase",
        "198.51.100.99, 203.0.113.60",
      )
    ).status,
  ).toBe(429);

  // The second part starts with a fresh whole-service count.
  await pool.query("TRUNCATE anonymous_write_windows");
  for (let i = 1; i <= 3; i++)
    expect(
      (
        await signIn(
          `six-${i}@example.invalid`,
          "wrong phrase",
          `2001:db8:1:2::${i}`,
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await signIn(
        "six@example.invalid",
        "wrong phrase",
        "2001:db8:1:2:ffff::9",
      )
    ).status,
  ).toBe(429);
});

it("ANON-05 refuses with 503 and creates nothing when the limiter cannot answer", async () => {
  const unreachable = new Pool({
    connectionString: "postgresql://dne:none@127.0.0.1:1/none",
    connectionTimeoutMillis: 500,
  });
  unreachable.on("error", () => undefined);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const outage = await listenLoopback(
    application(
      anonymousWriteAdmissionStore(
        unreachable,
        { secret, publicOnly: false },
        limits,
      ),
    ),
  );
  try {
    const refused = await signup(
      "outage@example.invalid",
      "203.0.113.70",
      outage,
    );
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.text).toContain("Starting a new account is unavailable");
    expect(await accounts()).toBe(0);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("anonymous_write_unavailable");
    expect(logged).not.toContain("outage@example.invalid");
    expect(logged).not.toContain("203.0.113.70");
  } finally {
    await closeLoopback(outage);
    await unreachable.end();
  }
});

it("ANON-05 fails closed when a held row lock outlasts the limiter's wait", async () => {
  await signup("held@example.invalid", "203.0.113.71");
  const holder = await pool.connect();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM anonymous_write_windows WHERE subject='service' FOR UPDATE",
    );
    const refused = await signup("blocked@example.invalid", "203.0.113.72");
    expect(refused.status).toBe(503);
    expect(await accounts()).toBe(1);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  // The connection handed back after the failure works normally.
  expect((await signup("after@example.invalid", "203.0.113.72")).status).toBe(
    303,
  );
});

it("ANON-06 charges nothing for a malformed form and stores only a keyed hash", async () => {
  const bad = await post(
    "/start",
    {
      display_name: "Invented Learner",
      background: "explorer",
      goal: "everyday",
      signup_email: "not an email",
      signup_password: PASSWORD,
    },
    "203.0.113.80",
  );
  expect(bad.status).toBe(422);
  expect(
    (await pool.query("SELECT 1 FROM anonymous_write_windows")).rowCount,
  ).toBe(0);

  await signup("stored@example.invalid", "203.0.113.80");
  const rows = await pool.query<{ subject: string }>(
    "SELECT subject FROM anonymous_write_windows ORDER BY subject",
  );
  const text = JSON.stringify(rows.rows);
  expect(text).not.toContain("203.0.113.80");
  expect(text).not.toContain("stored@example.invalid");
  expect(rows.rows.map((row) => row.subject)).toEqual(
    expect.arrayContaining([
      "service",
      anonymousWriteSubject(
        secret,
        visitorAddress("127.0.0.1", "203.0.113.80"),
      ),
    ]),
  );
});

it("ANON-06 removes counts older than a day", async () => {
  const stale = "a".repeat(64);
  await pool.query(
    `INSERT INTO anonymous_write_windows(kind,subject,window_start,admitted)
     VALUES('signup',$1,clock_timestamp()-INTERVAL '25 hours',3),
           ('signup','b${"b".repeat(63)}',clock_timestamp()-INTERVAL '23 hours',1)`,
    [stale],
  );
  await signup("sweep@example.invalid", "203.0.113.81");
  const left = await pool.query<{ subject: string }>(
    "SELECT subject FROM anonymous_write_windows",
  );
  expect(left.rows.map((row) => row.subject)).not.toContain(stale);
  expect(left.rows.map((row) => row.subject)).toContain("b".repeat(64));
});

it("ANON-06 a concurrent burst cannot pass the allowance, and a second store shares the count", async () => {
  const writes = anonymousWrites();
  const visitor = visitorAddress("127.0.0.1", "203.0.113.82");
  const results = await Promise.all(
    Array.from({ length: 8 }, () => writes.admit("password_sign_in", visitor)),
  );
  expect(results.filter((r) => r.kind === "admitted")).toHaveLength(3);
  expect(results.filter((r) => r.kind === "refused")).toHaveLength(5);
  expect(await counted("password_sign_in", "203.0.113.82")).toBe(3);
  const second = await anonymousWrites().admit("password_sign_in", visitor);
  expect(second).toMatchObject({ kind: "refused", limit: "visitor" });
});

it("ANON-03 a restart renews visitor allowances but not the whole-service ceiling", async () => {
  // The process secret is random per boot, so a restart can't read old hashes.
  const key = (value: string) =>
    anonymousWriteAdmissionStore(
      pool,
      { secret: value, publicOnly: false },
      limits,
    );
  const visitor = visitorAddress("127.0.0.1", "203.0.113.83");
  for (let i = 0; i < 3; i++) await key("first-boot").admit("signup", visitor);
  expect(await key("first-boot").admit("signup", visitor)).toMatchObject({
    limit: "visitor",
  });
  const afterRestart = key("second-boot");
  for (let i = 0; i < 2; i++)
    expect((await afterRestart.admit("signup", visitor)).kind).toBe("admitted");
  expect(await afterRestart.admit("signup", visitor)).toMatchObject({
    kind: "refused",
    limit: "service",
  });
});

it("ANON-07 lets a refused visitor start normally once the window has passed", async () => {
  for (let i = 0; i < 3; i++)
    await signup(`wait-${i}@example.invalid`, "203.0.113.90");
  expect((await signup("waited@example.invalid", "203.0.113.90")).status).toBe(
    429,
  );
  await pool.query(
    "UPDATE anonymous_write_windows SET window_start=window_start-INTERVAL '1 hour'",
  );
  expect((await signup("waited@example.invalid", "203.0.113.90")).status).toBe(
    303,
  );
  expect(await accounts()).toBe(4);
});

it("ANON-06 a local process leaves non-public addresses uncounted; a hosted one counts them", async () => {
  const local = anonymousWriteAdmissionStore(
    pool,
    { secret, publicOnly: true },
    limits,
  );
  const unidentified = visitorAddress("127.0.0.1", undefined);
  const privateAddress = visitorAddress("127.0.0.1", "10.0.0.8");
  expect(unidentified.scope).toBe("unknown");
  expect(privateAddress.scope).toBe("private");
  for (let i = 0; i < 5; i++) {
    expect(await local.admit("signup", unidentified)).toEqual({
      kind: "admitted",
    });
    expect(await local.admit("signup", privateAddress)).toEqual({
      kind: "admitted",
    });
  }
  expect(
    (await pool.query("SELECT 1 FROM anonymous_write_windows")).rowCount,
  ).toBe(0);
  // A wrong ingress address must not turn the hosted limit off.
  const hosted = anonymousWrites();
  for (const visitor of [unidentified, privateAddress]) {
    for (let i = 0; i < 2; i++)
      expect((await hosted.admit("signup", visitor)).kind).toBe("admitted");
  }
  await hosted.admit("signup", unidentified);
  expect(await hosted.admit("signup", unidentified)).toMatchObject({
    kind: "refused",
    limit: "visitor",
  });
});
